import { assertNs, type ObjectStore } from "../store/objects.js";
import { gunzipSync } from "node:zlib";
import { canonicalJson, sha256 } from "../util.js";
import { getBatched, listPages, readBlob, type ChunkIndexRecord } from "./ingest.js";
import {
  assertDay,
  chunkIndexKey,
  DEFAULT_COHORT_INPUT_BYTES,
  INLINE_PAYLOAD_LIMIT,
  MAX_CHUNK_BYTES,
  STORE_CALL_BYTES,
  STORE_GET_KEYS,
  isBlobRef,
  parseChunkKey,
  SESSION_ID_RE,
  type TraceEvent,
  type TraceUsage,
} from "./schema.js";

/**
 * Daily cohort pinning.
 *
 * Objects / refs (inside the tenant namespace):
 *   daily/<day>/manifest-<n:04>.json   IMMUTABLE manifest: the exact chunk keys + object sha256s of a cohort
 *   ref daily/<day>                    CAS record {latestManifest, status, attempts, publishedManifests, ...}
 *
 * Catch-up convention (no event lost, none processed twice):
 *  - A chunk is "processed" once it appears in a manifest whose status was set
 *    to `published`. The ref keeps the list of published manifests for the day.
 *  - pinDailyManifest pins manifest n+1 = (all chunks currently under
 *    traces/<day>/) minus (chunks of every published manifest of that day).
 *    Late arrivals for an already published day therefore form a small
 *    catch-up manifest containing only the new chunks.
 *  - If the latest manifest is pinned/failed (not published) and nothing new
 *    arrived, the same manifest is returned so the build retries it. If new
 *    chunks arrived, manifest n+1 supersedes it and includes its chunks too.
 *  - While the latest manifest is `building`, no new manifest is pinned unless
 *    {force: true} (use when the previous builder is known dead). A superseded
 *    builder cannot mark its manifest published: markDailyStatus checks the
 *    manifest key against the ref under CAS.
 *  - Manifest numbers come from listing daily/<day>/ (max + 1), so a crash
 *    between writing a manifest and swinging the ref only leaves an unreferenced
 *    immutable object; the next run uses the next number.
 *
 * Scale: day listings are paginated (listPageSize keys per call) and reads are
 * batched (<= maxGetKeys keys and <= maxGetBytes estimated bytes per call). A
 * cohort larger than maxInputBytes fails with an explicit error instead of
 * dropping chunks; raise the budget to process it.
 */

export interface CohortBatchOptions {
  /** Keys per list call (default 1000). */
  listPageSize?: number;
  /** Keys per get call (default 64). */
  maxGetKeys?: number;
  /** Estimated bytes per get call (default 8 MiB). */
  maxGetBytes?: number;
  /** Total input budget for one cohort (default 128 MiB): stored chunk bytes when pinning, decoded bytes incl. payloads when materializing. */
  maxInputBytes?: number;
}

/** Upper bound for one stored (gzip) chunk object, used when the index lacks its size. */
const MAX_CHUNK_OBJECT_ESTIMATE = MAX_CHUNK_BYTES + 64 * 1024;

export type DailyStatus = "pinned" | "building" | "published" | "failed";

export interface ManifestChunk {
  key: string;
  /** sha256 of the chunk's decoded JSONL content (platform-independent; verified on materialize). */
  sha256: string;
  /** Size of the stored gzip object (estimate if unknown). */
  bytes: number;
  sessionId: string;
  chunkSeq: number;
  events: number;
}

export interface DailyManifest {
  version: 1;
  day: string;
  n: number;
  key: string;
  createdAt: string;
  /** Published manifests of this day whose chunks are excluded (already processed). */
  basePublishedManifests: string[];
  /** Unpublished manifest this one replaces (its chunks are included here), if any. */
  supersedes: string | null;
  chunks: ManifestChunk[];
  sessionIds: string[];
  watermark: { createdAt: string; chunkCount: number; lastChunkKey: string | null; totalChunksForDay: number };
}

export interface DailyRefValue {
  day: string;
  latestManifest: string | null;
  manifestN: number;
  status: DailyStatus;
  buildId?: string;
  revisionId?: string;
  error?: string;
  /** Build attempts of the latest manifest. */
  attempts: number;
  publishedManifests: string[];
  /** Number of chunk keys of this day covered by published manifests. */
  processedChunkKeys: number;
  updatedAt: string;
}

export interface PinResult {
  created: boolean;
  manifest: DailyManifest | null;
  reason: "created" | "unchanged" | "up-to-date" | "build-in-progress";
  ref: DailyRefValue | null;
}

const MANIFEST_KEY_RE = /^daily\/(\d{4}-\d{2}-\d{2})\/manifest-(\d{4,})\.json$/;

export function dailyRefName(day: string): string {
  return `daily/${day}`;
}

export function manifestKey(day: string, n: number): string {
  return `daily/${day}/manifest-${String(n).padStart(4, "0")}.json`;
}

export async function loadManifest(store: ObjectStore, ns: string, key: string): Promise<DailyManifest> {
  const bytes = (await store.get(ns, [key])).get(key);
  if (!bytes) throw new Error(`Daily manifest ${key} not found`);
  const manifest = JSON.parse(bytes.toString("utf8")) as DailyManifest;
  if (manifest.key !== key) throw new Error(`Daily manifest ${key} claims key ${manifest.key}`);
  return manifest;
}

export async function getDailyRef(store: ObjectStore, ns: string, day: string): Promise<{ version: number; value: DailyRefValue } | null> {
  const ref = await store.getRef(ns, dailyRefName(day));
  return ref ? { version: ref.version, value: ref.value as DailyRefValue } : null;
}

async function processedChunkSet(store: ObjectStore, ns: string, published: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const key of published) for (const c of (await loadManifest(store, ns, key)).chunks) out.add(c.key);
  return out;
}

async function listDayChunks(store: ObjectStore, ns: string, day: string, pageSize: number): Promise<string[]> {
  const out: string[] = [];
  for await (const page of listPages(store, ns, `traces/${day}/`, pageSize)) for (const k of page) if (parseChunkKey(k)?.day === day) out.push(k);
  return out;
}

/** Describe chunks for a manifest from their (small) index records, batched; falls back to reading the chunk. */
async function describeChunks(store: ObjectStore, ns: string, keys: string[], batch: Required<CohortBatchOptions>): Promise<ManifestChunk[]> {
  const parsed = keys.map((key) => ({ key, ...parseChunkKey(key)! }));
  const indexKeys = parsed.map((p) => chunkIndexKey(p.sessionId, p.chunkSeq));
  const records = await getBatched(store, ns, indexKeys, { maxKeys: batch.maxGetKeys, maxBytes: batch.maxGetBytes, sizeOf: () => 1024 });
  const out: ManifestChunk[] = [];
  const unindexed: typeof parsed = [];
  for (const p of parsed) {
    const raw = records.get(chunkIndexKey(p.sessionId, p.chunkSeq));
    if (!raw) {
      unindexed.push(p);
      continue;
    }
    const rec = JSON.parse(raw.toString("utf8")) as ChunkIndexRecord;
    if (rec.key !== p.key) throw new Error(`Chunk ${p.key} conflicts with its index record (claimed at ${rec.key})`);
    out.push({ key: p.key, sha256: rec.sha256, bytes: rec.objectBytes ?? MAX_CHUNK_OBJECT_ESTIMATE, sessionId: p.sessionId, chunkSeq: p.chunkSeq, events: rec.events });
  }
  if (unindexed.length) {
    const objects = await getBatched(store, ns, unindexed.map((p) => p.key), { maxKeys: batch.maxGetKeys, maxBytes: batch.maxGetBytes, sizeOf: () => MAX_CHUNK_OBJECT_ESTIMATE });
    for (const p of unindexed) {
      const bytes = objects.get(p.key);
      if (!bytes) throw new Error(`Chunk ${p.key} disappeared while pinning`);
      const jsonl = gunzipSync(bytes);
      out.push({ key: p.key, sha256: sha256(jsonl), bytes: bytes.length, sessionId: p.sessionId, chunkSeq: p.chunkSeq, events: jsonl.toString("utf8").split("\n").filter(Boolean).length });
    }
  }
  const order = new Map(keys.map((k, i) => [k, i]));
  return out.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
}

function batchDefaults(o: CohortBatchOptions): Required<CohortBatchOptions> {
  return {
    listPageSize: o.listPageSize ?? 1000,
    maxGetKeys: Math.min(o.maxGetKeys ?? STORE_GET_KEYS, STORE_GET_KEYS),
    maxGetBytes: Math.min(o.maxGetBytes ?? STORE_CALL_BYTES, STORE_CALL_BYTES),
    maxInputBytes: o.maxInputBytes ?? DEFAULT_COHORT_INPUT_BYTES,
  };
}

export async function pinDailyManifest(
  store: ObjectStore,
  ns: string,
  day: string,
  opts: { force?: boolean; now?: () => Date } & CohortBatchOptions = {},
): Promise<PinResult> {
  assertNs(ns);
  assertDay(day);
  const now = opts.now ?? (() => new Date());
  const batch = batchDefaults(opts);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = await getDailyRef(store, ns, day);
    const v = ref?.value ?? null;
    const latest = v?.latestManifest ? await loadManifest(store, ns, v.latestManifest) : null;
    if (v?.status === "building" && !opts.force) return { created: false, manifest: latest, reason: "build-in-progress", ref: v };

    const published = v?.publishedManifests ?? [];
    const processed = await processedChunkSet(store, ns, published);
    const all = await listDayChunks(store, ns, day, batch.listPageSize);
    const candidates = all.filter((k) => !processed.has(k));
    const latestUnpublished = latest && v && v.status !== "published" ? latest : null;
    if (latestUnpublished && sameKeys(latestUnpublished.chunks.map((c) => c.key), candidates) && !(opts.force && v?.status === "building")) {
      return { created: false, manifest: latestUnpublished, reason: "unchanged", ref: v };
    }
    if (candidates.length === 0) return { created: false, manifest: null, reason: "up-to-date", ref: v };

    let n = Math.max(0, v?.manifestN ?? 0);
    for await (const page of listPages(store, ns, `daily/${day}/`, batch.listPageSize)) for (const k of page) n = Math.max(n, Number(MANIFEST_KEY_RE.exec(k)?.[2] ?? 0));
    n += 1;
    const key = manifestKey(day, n);
    const chunks = await describeChunks(store, ns, candidates, batch);
    const totalBytes = chunks.reduce((sum, c) => sum + c.bytes, 0);
    if (totalBytes > batch.maxInputBytes) {
      throw new Error(`Daily cohort ${day} has ${chunks.length} unprocessed chunks totalling ${totalBytes} stored bytes, over the input budget of ${batch.maxInputBytes} bytes; raise maxInputBytes to process it (no chunks are dropped)`);
    }
    const createdAt = now().toISOString();
    const manifest: DailyManifest = {
      version: 1,
      day,
      n,
      key,
      createdAt,
      basePublishedManifests: published,
      supersedes: latestUnpublished?.key ?? null,
      chunks,
      sessionIds: [...new Set(chunks.map((c) => c.sessionId))].sort(),
      watermark: { createdAt, chunkCount: chunks.length, lastChunkKey: candidates[candidates.length - 1] ?? null, totalChunksForDay: all.length },
    };
    try {
      await store.put(ns, [{ key, bytes: Buffer.from(canonicalJson(manifest), "utf8") }]);
    } catch {
      continue; // a concurrent pinner took this number; re-read and retry
    }
    const value: DailyRefValue = {
      day,
      latestManifest: key,
      manifestN: n,
      status: "pinned",
      attempts: 0,
      publishedManifests: published,
      processedChunkKeys: processed.size,
      updatedAt: createdAt,
    };
    const cas = await store.casRef(ns, dailyRefName(day), ref?.version ?? null, value);
    if (cas.ok) return { created: true, manifest, reason: "created", ref: value };
  }
  throw new Error(`Could not pin daily manifest for ${day}: too much concurrent contention`);
}

export async function markDailyStatus(
  store: ObjectStore,
  ns: string,
  day: string,
  update: { manifestKey: string; status: DailyStatus; buildId?: string; revisionId?: string; error?: string; now?: () => Date },
): Promise<DailyRefValue> {
  assertNs(ns);
  assertDay(day);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = await getDailyRef(store, ns, day);
    if (!ref) throw new Error(`No daily ref for ${day}; pin a manifest first`);
    const v = ref.value;
    if (v.latestManifest !== update.manifestKey) {
      throw new Error(`Manifest ${update.manifestKey} is not the latest for ${day} (latest ${v.latestManifest}); it was superseded`);
    }
    if (v.status === "published") {
      if (update.status === "published" && (update.revisionId ?? null) === (v.revisionId ?? null)) return v;
      throw new Error(`Manifest ${update.manifestKey} is already published; status cannot change to ${update.status}`);
    }
    const next: DailyRefValue = { ...v, status: update.status, updatedAt: (update.now ?? (() => new Date()))().toISOString() };
    if (update.buildId !== undefined) next.buildId = update.buildId;
    if (update.revisionId !== undefined) next.revisionId = update.revisionId;
    if (update.status === "building") {
      next.attempts = v.attempts + 1;
      delete next.error;
    }
    if (update.status === "failed") next.error = update.error ?? "build failed";
    if (update.status === "published") {
      const manifest = await loadManifest(store, ns, update.manifestKey);
      next.publishedManifests = [...v.publishedManifests, update.manifestKey];
      next.processedChunkKeys = v.processedChunkKeys + manifest.chunks.length;
      delete next.error;
    }
    const cas = await store.casRef(ns, dailyRefName(day), ref.version, next);
    if (cas.ok) return next;
  }
  throw new Error(`Could not update daily status for ${day}: too much concurrent contention`);
}

/**
 * Days (<= upToDay, sorted) that still need a build: never pinned, latest
 * manifest not published, or late chunks arrived after the last publish.
 */
export async function listUnprocessedDays(store: ObjectStore, ns: string, upToDay: string, opts: Pick<CohortBatchOptions, "listPageSize"> = {}): Promise<string[]> {
  assertNs(ns);
  assertDay(upToDay);
  const counts = new Map<string, number>();
  for await (const page of listPages(store, ns, "traces/", opts.listPageSize ?? 1000)) {
    for (const key of page) {
      const parsed = parseChunkKey(key);
      if (parsed && parsed.day <= upToDay) counts.set(parsed.day, (counts.get(parsed.day) ?? 0) + 1);
    }
  }
  const out: string[] = [];
  for (const [day, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ref = await getDailyRef(store, ns, day);
    if (!ref || ref.value.status !== "published" || count > ref.value.processedChunkKeys) out.push(day);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Materialization: the file layout contract with the build harness.
//   manifest.json
//   sessions/<sessionId>/session.json
//   sessions/<sessionId>/events.jsonl        every event in seq order
//   sessions/<sessionId>/payloads/<sha>.json|.txt   payloads > 64 KiB (sha256 of the original bytes)
// Evidence references: "<sessionId>#<seq>".
// ---------------------------------------------------------------------------

export interface MaterializedSession {
  sessionId: string;
  agent: TraceEvent["agent"] | null;
  model: string | null;
  objective: string | null;
  metadata: unknown;
  outcome: TraceEvent["outcome"] | null;
  eventCount: number;
  firstSeq: number;
  lastSeq: number;
  firstTs: string;
  lastTs: string;
  hasSessionStart: boolean;
  hasSessionEnd: boolean;
  /** True when seqs in this cohort are contiguous from 1 through session_end. */
  complete: boolean;
  chunkSeqs: number[];
  eventTypes: Record<string, number>;
  usage: TraceUsage;
}

function sessionPath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`Unsafe sessionId ${JSON.stringify(sessionId)}`);
  return `sessions/${sessionId}`;
}

function isTextMedia(mediaType: string): boolean {
  const m = mediaType.toLowerCase();
  return m.startsWith("text/") || m.includes("json") || m.includes("xml") || m.includes("yaml") || m.includes("javascript");
}

export async function materializeCohort(
  store: ObjectStore,
  ns: string,
  manifest: DailyManifest | string,
  opts: CohortBatchOptions = {},
): Promise<Map<string, string>> {
  assertNs(ns);
  const batch = batchDefaults(opts);
  const m = typeof manifest === "string" ? await loadManifest(store, ns, manifest) : manifest;
  const files = new Map<string, string>();
  const bySession = new Map<string, { events: Map<number, TraceEvent>; chunkSeqs: number[] }>();
  let inputBytes = 0;
  const charge = (n: number, what: string) => {
    inputBytes += n;
    if (inputBytes > batch.maxInputBytes) {
      throw new Error(`Cohort ${m.key} exceeds the input budget of ${batch.maxInputBytes} decoded bytes while reading ${what}; raise maxInputBytes to materialize it (nothing is dropped or truncated)`);
    }
  };
  // Read chunks in bounded batches (<= maxGetKeys keys / <= maxGetBytes per call).
  for (let i = 0; i < m.chunks.length; ) {
    const group: ManifestChunk[] = [];
    let bytes = 0;
    while (i < m.chunks.length && group.length < batch.maxGetKeys && (group.length === 0 || bytes + m.chunks[i]!.bytes <= batch.maxGetBytes)) {
      bytes += m.chunks[i]!.bytes;
      group.push(m.chunks[i++]!);
    }
    const objects = await store.get(ns, group.map((c) => c.key));
    for (const c of group) {
      const raw = objects.get(c.key);
      if (!raw) throw new Error(`Manifest ${m.key} pins ${c.key}, which is missing from the store`);
      const jsonl = gunzipSync(raw);
      if (sha256(jsonl) !== c.sha256) throw new Error(`Chunk ${c.key} does not match the sha256 pinned by ${m.key}`);
      charge(jsonl.length, c.key);
      const entry = bySession.get(c.sessionId) ?? { events: new Map<number, TraceEvent>(), chunkSeqs: [] };
      bySession.set(c.sessionId, entry);
      entry.chunkSeqs.push(c.chunkSeq);
      for (const line of jsonl.toString("utf8").split("\n")) {
        if (!line) continue;
        const e = JSON.parse(line) as TraceEvent;
        const prior = entry.events.get(e.seq);
        if (prior && canonicalJson(prior) !== canonicalJson(e)) throw new Error(`Session ${c.sessionId} has two different events with seq ${e.seq}`);
        entry.events.set(e.seq, e);
      }
    }
  }

  const loadBlob = async (sha: string): Promise<Buffer> => {
    const bytes = await readBlob(store, ns, sha);
    if (!bytes) throw new Error(`Blob ${sha} referenced by the cohort is missing`);
    charge(bytes.length, `blob ${sha}`);
    return bytes;
  };

  let payloadFiles = 0;
  let totalEvents = 0;
  const summaries: MaterializedSession[] = [];
  for (const sessionId of [...bySession.keys()].sort()) {
    const entry = bySession.get(sessionId)!;
    const dir = sessionPath(sessionId);
    const events = [...entry.events.values()].sort((a, b) => a.seq - b.seq);
    const lines: string[] = [];
    for (const e of events) {
      let data: unknown = e.data;
      if (isBlobRef(e.data)) {
        const bytes = await loadBlob(e.data.$blob);
        const text = isTextMedia(e.data.mediaType);
        const rel = `payloads/${e.data.$blob}.${e.data.mediaType.toLowerCase().includes("json") ? "json" : "txt"}`;
        if (!files.has(`${dir}/${rel}`)) payloadFiles++;
        files.set(`${dir}/${rel}`, text ? bytes.toString("utf8") : bytes.toString("base64"));
        data = { $payload: rel, bytes: bytes.length, mediaType: e.data.mediaType, ...(text ? {} : { encoding: "base64" }) };
      } else {
        const serialized = typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2);
        if (Buffer.byteLength(serialized) > INLINE_PAYLOAD_LIMIT) {
          const sha = sha256(serialized);
          const isText = typeof e.data === "string";
          const rel = `payloads/${sha}.${isText ? "txt" : "json"}`;
          if (!files.has(`${dir}/${rel}`)) payloadFiles++;
          files.set(`${dir}/${rel}`, serialized);
          data = { $payload: rel, bytes: Buffer.byteLength(serialized), mediaType: isText ? "text/plain; charset=utf-8" : "application/json" };
        }
      }
      lines.push(JSON.stringify({ ...e, data, ref: `${sessionId}#${e.seq}` }));
    }
    files.set(`${dir}/events.jsonl`, lines.join("\n") + "\n");
    const summary = summarizeSession(sessionId, events, entry.chunkSeqs);
    summaries.push(summary);
    totalEvents += events.length;
    files.set(`${dir}/session.json`, JSON.stringify(summary, null, 2) + "\n");
  }

  files.set(
    "manifest.json",
    JSON.stringify(
      {
        day: m.day,
        manifestKey: m.key,
        manifestN: m.n,
        pinnedAt: m.createdAt,
        catchUp: m.basePublishedManifests.length > 0,
        evidenceRefFormat: "<sessionId>#<seq>",
        counts: { sessions: summaries.length, chunks: m.chunks.length, events: totalEvents, payloadFiles },
        sessions: summaries.map((s) => ({
          sessionId: s.sessionId,
          path: `${sessionPath(s.sessionId)}/`,
          agentId: s.agent?.id ?? null,
          model: s.model,
          objective: s.objective,
          outcome: s.outcome?.status ?? null,
          events: s.eventCount,
          complete: s.complete,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  return files;
}

function summarizeSession(sessionId: string, events: TraceEvent[], chunkSeqs: number[]): MaterializedSession {
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const start = events.find((e) => e.type === "session_start");
  const end = [...events].reverse().find((e) => e.type === "session_end");
  const startData = (start?.data && typeof start.data === "object" ? start.data : {}) as Record<string, unknown>;
  const eventTypes: Record<string, number> = {};
  const usage: Record<string, number> = {};
  let model: string | null = null;
  for (const e of events) {
    eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
    if (e.agent.model) model = e.agent.model;
    for (const [k, val] of Object.entries(e.usage ?? {})) if (typeof val === "number") usage[k] = (usage[k] ?? 0) + val;
  }
  const contiguous = events.every((e, i) => e.seq === i + 1);
  return {
    sessionId,
    agent: start?.agent ?? first.agent,
    model,
    objective: typeof startData.objective === "string" ? startData.objective : null,
    metadata: startData.metadata ?? null,
    outcome: end?.outcome ?? null,
    eventCount: events.length,
    firstSeq: first.seq,
    lastSeq: last.seq,
    firstTs: first.ts,
    lastTs: last.ts,
    hasSessionStart: !!start,
    hasSessionEnd: !!end,
    complete: !!start && !!end && contiguous && last.type === "session_end",
    chunkSeqs: [...chunkSeqs].sort((a, b) => a - b),
    eventTypes,
    usage: usage as TraceUsage,
  };
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((k) => s.has(k));
}
