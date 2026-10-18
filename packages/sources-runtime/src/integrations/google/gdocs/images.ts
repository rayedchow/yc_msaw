/**
 * T3: Google Docs embedded-image bytes.
 *
 * The Docs API exposes each embedded object's `imageProperties.contentUri` - a
 * URI with a ~30-minute default lifetime that is **tagged with the requester's
 * account**: anyone holding it accesses the image AS the original requester.
 * Two consequences drive this module's design:
 *
 *   1. SECURITY RULE - the contentUri is NEVER persisted (not in the DB, not
 *      in the mirror, not in logs). It is consumed immediately, in-process,
 *      within the window of the `documents.get` that produced it.
 *   2. Bytes must be fetched at sync time or not at all - a stored URI would
 *      be both dead (30 min) and a leaked requester-scoped token.
 *
 * Bytes land in `google_doc_images` (base64 in Postgres - no object store in
 * the stack yet; revisit at scale). Caps bound cost: per-image byte limit,
 * per-doc image limit, and a refetch window so repeated materializations of an
 * unchanged doc don't re-download.
 *
 * SOURCE-LANE PATCH (provider-repairs, audit L2): the per-doc limit is a
 * per-run FETCH budget, not a truncation. `refsFound` counts every reference;
 * when a run cannot attempt them all, never-captured objects go first (then the
 * least recently fetched), so a re-run continues where this one stopped, and
 * the remainder is reported as `overCapMissing` (no bytes captured yet) /
 * `overCapKeptPrevious` (earlier bytes kept, not re-fetched this run).
 */
import { createHash } from "node:crypto";

export interface DocImageRef {
  objectId: string;
  kind: "image" | "drawing" | "chart";
  altText: string | null;
  /** Ephemeral, requester-tagged - consume immediately, never persist. */
  contentUri: string;
}

// 50MB covers essentially any image that can live in a Doc (Google's own
// insert limit is 50MB); a backstop against pathological payloads, not a
// working limit. Base64 inflates stored size ~1.33x.
const MAX_IMAGE_BYTES = Math.max(1, Math.floor(Number(process.env.GDOCS_IMAGE_MAX_BYTES ?? 50 * 1024 * 1024)));
// Effectively "all images" for real docs (a runaway-doc backstop, not a
// working limit). Worst case per doc is bounded by bytes, not count:
// 1,000 × 50MB ≈ 67GB base64 in Postgres - see the doc note before relying
// on these defaults at scale. Fetch attempts per run; refs beyond it are
// reported and captured by a later run (never silently dropped).
const MAX_IMAGES_PER_DOC = Math.max(1, Math.floor(Number(process.env.GDOCS_IMAGE_MAX_PER_DOC ?? 1000)));
const REFETCH_HOURS = Math.max(1, Math.floor(Number(process.env.GDOCS_IMAGE_REFETCH_HOURS ?? 24)));

type EmbeddedObject = {
  title?: string;
  description?: string;
  imageProperties?: { contentUri?: string };
  embeddedDrawingProperties?: Record<string, unknown>;
  linkedContentReference?: { sheetsChartReference?: unknown };
};

/**
 * Pure: collect fetchable image refs from a raw `documents.get` response -
 * doc-level and per-tab `inlineObjects` + `positionedObjects` maps.
 */
export function collectImageRefs(raw: unknown): DocImageRef[] {
  const refs = new Map<string, DocImageRef>();

  const addMap = (map: Record<string, unknown> | undefined) => {
    for (const [objectId, def] of Object.entries(map ?? {})) {
      const props = def as {
        inlineObjectProperties?: { embeddedObject?: EmbeddedObject };
        positionedObjectProperties?: { embeddedObject?: EmbeddedObject };
      };
      const obj = props.inlineObjectProperties?.embeddedObject ?? props.positionedObjectProperties?.embeddedObject;
      const contentUri = obj?.imageProperties?.contentUri;
      if (!obj || !contentUri) continue;
      const kind: DocImageRef["kind"] = obj.linkedContentReference?.sheetsChartReference
        ? "chart"
        : obj.embeddedDrawingProperties
          ? "drawing"
          : "image";
      const altText = [obj.title, obj.description].filter((s) => s && String(s).trim()).join(" - ").trim() || null;
      refs.set(objectId, { objectId, kind, altText, contentUri });
    }
  };

  const doc = raw as {
    inlineObjects?: Record<string, unknown>;
    positionedObjects?: Record<string, unknown>;
    tabs?: unknown[];
  };
  addMap(doc.inlineObjects);
  addMap(doc.positionedObjects);

  const walkTabs = (tabs: unknown[] | undefined) => {
    for (const tab of tabs ?? []) {
      const t = tab as { documentTab?: { inlineObjects?: Record<string, unknown>; positionedObjects?: Record<string, unknown> }; childTabs?: unknown[] };
      addMap(t.documentTab?.inlineObjects);
      addMap(t.documentTab?.positionedObjects);
      walkTabs(t.childTabs);
    }
  };
  walkTabs(doc.tabs);

  return [...refs.values()];
}

export interface StoreDocImagesResult {
  /** Every fetchable reference in the response (never capped). */
  refsFound: number;
  fetched: number;
  skippedFresh: number;
  skippedTooLarge: number;
  failed: number;
  /** Not attempted this run (per-run budget) and no bytes ever captured: a gap until a later run fetches them. */
  overCapMissing: number;
  /** Not re-fetched this run (per-run budget); bytes from an earlier fetch are kept. */
  overCapKeptPrevious: number;
}

/**
 * Stream the body, aborting as soon as the cap is crossed. `arrayBuffer()`
 * would allocate the whole (attacker-sized) payload before the size check;
 * streaming bounds memory at cap + one chunk. Returns null when over cap.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch and persist image bytes for a doc, from an already-fetched raw
 * `documents.get` response (so the contentUris are still within their window).
 * Fail-soft per image; never throws for a single bad object.
 */
/**
 * Fetched image bytes handed to a capture-time consumer (the source-lane
 * exporter versions them as files). Carries NO contentUri - only identity,
 * metadata and the exact bytes.
 */
export interface FetchedDocImage {
  objectId: string;
  kind: DocImageRef["kind"];
  altText: string | null;
  mimeType: string | null;
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface StoreDocImagesOptions {
  /** Called once per image whose bytes were fetched and stored. */
  onImage?: (image: FetchedDocImage) => void | Promise<void>;
  /**
   * Ignore the refetch window. The content-snapshot path sets this: it only
   * runs for a new Drive version (or an explicit retry), and image bytes can
   * change without the object id changing, so a 24h window would miss them.
   */
  refetchFresh?: boolean;
}

export async function storeDocImages(
  userId: string,
  docId: string,
  raw: unknown,
  fetcher: (url: string) => Promise<Response> = fetch,
  options: StoreDocImagesOptions = {},
): Promise<StoreDocImagesResult> {
  const { db } = await import("../../../db/client.js");
  const { googleDocImages } = await import("../../../db/schema.js");
  const { sql } = await import("drizzle-orm");

  const result: StoreDocImagesResult = { refsFound: 0, fetched: 0, skippedFresh: 0, skippedTooLarge: 0, failed: 0, overCapMissing: 0, overCapKeptPrevious: 0 };
  const allRefs = collectImageRefs(raw);
  result.refsFound = allRefs.length;
  if (allRefs.length === 0) return result;

  // Skip objects fetched recently - repeated materializations of an unchanged
  // doc shouldn't re-download bytes.
  const freshCutoffIso = new Date(Date.now() - REFETCH_HOURS * 60 * 60 * 1000).toISOString();
  const freshRows = options.refetchFresh ? [] : (await db.execute(sql`
    SELECT object_id FROM google_doc_images
    WHERE user_id = ${userId} AND doc_id = ${docId} AND fetched_at >= ${freshCutoffIso}::timestamptz
  `)) as unknown;
  const rowsOf = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as T[];
  const fresh = new Set(rowsOf<{ object_id: string }>(freshRows).map((r) => r.object_id));

  // More refs than one run may fetch: never-captured objects first, then the
  // least recently fetched (document order within ties), so runs make progress.
  let refs = allRefs;
  const stored = new Map<string, number>();
  if (allRefs.filter((r) => !fresh.has(r.objectId)).length > MAX_IMAGES_PER_DOC) {
    for (const row of rowsOf<{ object_id: string; fetched_at: unknown }>(await db.execute(sql`
      SELECT object_id, fetched_at FROM google_doc_images WHERE user_id = ${userId} AND doc_id = ${docId}
    `))) stored.set(row.object_id, Date.parse(String(row.fetched_at instanceof Date ? row.fetched_at.toISOString() : row.fetched_at)) || 0);
    const rank = (r: DocImageRef) => (stored.has(r.objectId) ? stored.get(r.objectId)! : -Infinity);
    refs = allRefs.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
  }

  let attempted = 0;
  for (const ref of refs) {
    if (fresh.has(ref.objectId)) {
      result.skippedFresh++;
      continue;
    }
    if (attempted >= MAX_IMAGES_PER_DOC) {
      if (stored.has(ref.objectId)) result.overCapKeptPrevious++;
      else result.overCapMissing++;
      continue;
    }
    attempted++;
    try {
      const res = await fetcher(ref.contentUri);
      if (!res.ok) {
        result.failed++;
        continue;
      }
      const declaredBytes = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) {
        console.warn(
          `[gdocs] image ${ref.objectId} in doc ${docId} declares ${declaredBytes} bytes (> GDOCS_IMAGE_MAX_BYTES ${MAX_IMAGE_BYTES}) - not fetched.`,
        );
        res.body?.cancel?.().catch(() => {});
        result.skippedTooLarge++;
        continue;
      }
      const buf = await readBodyCapped(res, MAX_IMAGE_BYTES);
      if (buf === null) {
        console.warn(
          `[gdocs] image ${ref.objectId} in doc ${docId} exceeded GDOCS_IMAGE_MAX_BYTES ${MAX_IMAGE_BYTES} mid-stream - not stored.`,
        );
        result.skippedTooLarge++;
        continue;
      }
      const values = {
        userId,
        docId,
        objectId: ref.objectId,
        kind: ref.kind,
        altText: ref.altText,
        mimeType: res.headers.get("content-type"),
        sha256: createHash("sha256").update(buf).digest("hex"),
        sizeBytes: buf.byteLength,
        dataBase64: buf.toString("base64"),
        fetchedAt: new Date(),
      };
      await db.insert(googleDocImages).values(values).onConflictDoUpdate({
        target: [googleDocImages.userId, googleDocImages.docId, googleDocImages.objectId],
        set: {
          kind: values.kind,
          altText: values.altText,
          mimeType: values.mimeType,
          sha256: values.sha256,
          sizeBytes: values.sizeBytes,
          dataBase64: values.dataBase64,
          fetchedAt: values.fetchedAt,
        },
      });
      result.fetched++;
      if (options.onImage) {
        await options.onImage({
          objectId: ref.objectId,
          kind: ref.kind,
          altText: ref.altText,
          mimeType: values.mimeType,
          sha256: values.sha256,
          sizeBytes: values.sizeBytes,
          bytes: buf,
        });
      }
    } catch {
      result.failed++;
    }
  }

  if (result.overCapMissing + result.overCapKeptPrevious > 0) {
    console.warn(
      `[gdocs] doc ${docId} has ${allRefs.length} embedded images; fetched at most ${MAX_IMAGES_PER_DOC} this run (GDOCS_IMAGE_MAX_PER_DOC) - ${result.overCapMissing} not yet captured, ${result.overCapKeptPrevious} keep earlier bytes; reported for a continuation run.`,
    );
  }
  return result;
}
