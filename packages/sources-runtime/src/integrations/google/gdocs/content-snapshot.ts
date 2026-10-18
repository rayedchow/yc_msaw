import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { googleDocTabSnapshots } from "../../../db/schema.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import { fetchDocContent, parseDocContent, type DocContent } from "./content.js";
import { storeDocImages, type FetchedDocImage, type StoreDocImagesResult } from "./images.js";

export type DocContentSnapshotResult = {
  docId: string;
  /**
   * captured - new revision rows appended; skipped_fresh - the change's
   * modifiedTime is already covered by a stored snapshot, so the Docs fetch
   * was skipped entirely; deduped_revision - fetched, but every tab row for
   * this revision already exists (version-append no-op).
   */
  status: "captured" | "skipped_fresh" | "deduped_revision";
  revisionId: string | null;
  tabRowsInserted: number;
  /** documents.get title (absent when the fetch was skipped). */
  title?: string;
};

/**
 * Capture-time content persistence for a Google Doc (maximal-capture rule:
 * reshaping later must be a DB operation, never a re-fetch). Fetches the doc
 * through the same `fetchDocContent` renderer the mirror backfill uses and
 * appends one immutable row per tab to `google_doc_tab_snapshots`, keyed
 * (user_id, doc_id, tab_id, revision_id) - a new revision is a NEW row set,
 * never an overwrite.
 *
 * SECURITY: the raw `documents.get` JSON is redacted
 * (`redactProviderPayload("google-docs")` - contentUri + signed-URL rules)
 * and RE-RENDERED before anything is persisted, so nothing written here can
 * derive from an unredacted requester-scoped URL. Image bytes are still
 * captured from the unredacted response via `storeDocImages`, inside the
 * contentUri's ~30-minute window, exactly like the backfill path.
 */
export type DocSnapshotIdentity = {
  /** First Drive owner (absent for shared-drive files - they have no owner). */
  authorEmail?: string | null;
  authorName?: string | null;
  /** Drive lastModifyingUser at the time the change/discovery saw the doc. */
  updatedByEmail?: string | null;
  updatedByName?: string | null;
};

export async function snapshotDocContent(
  userId: string,
  docId: string,
  options: {
    modifiedTime?: string | null;
    /**
     * Re-stage the mirror even when this revision's rows already exist
     * (source lane: a restored doc whose mirror files were tombstoned).
     */
    forceMaterialize?: boolean;
  } & DocSnapshotIdentity = {},
): Promise<DocContentSnapshotResult> {
  const modifiedTime = parseDateOrNull(options.modifiedTime);
  const identity = compactIdentity(options);

  // Dedupe before the fetch: if a snapshot at (or after) the change's
  // modifiedTime is already stored, the revision behind this change is
  // captured and the Docs API call is skipped entirely.
  if (modifiedTime) {
    const [fresh] = await db
      .select({ revisionId: googleDocTabSnapshots.revisionId })
      .from(googleDocTabSnapshots)
      .where(
        and(
          eq(googleDocTabSnapshots.userId, userId),
          eq(googleDocTabSnapshots.docId, docId),
          gte(googleDocTabSnapshots.sourceUpdatedAt, modifiedTime),
        ),
      )
      .limit(1);
    if (fresh) {
      return { docId, status: "skipped_fresh", revisionId: fresh.revisionId, tabRowsInserted: 0 };
    }
  }

  const doc = await fetchDocContent(userId, docId);
  const revisionId = docRevisionId(doc);

  // Image bytes must be fetched now, while the response's contentUris are
  // inside their ~30-min window. Fail-soft; capped per doc (see images.ts).
  // Source lane: bytes are also handed to the versioned source export, and
  // the refetch window is skipped (this path only runs for a new Drive
  // version or an explicit retry, and bytes can change under one object id).
  let images: FetchedDocImage[] | null = [];
  let imageSummary: StoreDocImagesResult | null = null;
  try {
    imageSummary = await storeDocImages(userId, docId, doc.raw, undefined, {
      refetchFresh: true,
      onImage: (image) => {
        images!.push(image);
      },
    });
  } catch (err) {
    images = null;
    console.warn(`[gdocs] image byte fetch failed for ${docId}:`, err instanceof Error ? err.message : err);
  }

  // Redact FIRST, then render: the persisted representation is derived only
  // from the redacted JSON.
  const redactedRaw = redactProviderPayload("google-docs", doc.raw);
  const rendered = parseDocContent(redactedRaw, doc.suggestionsAccessible);

  const capturedAt = new Date();
  let inserted = 0;
  // Source lane: one revision's tab rows commit together, so the mirror backfill (latest revision only) never
  // renders a half-written revision with tabs missing.
  const writeTabs = async (tx: Pick<typeof db, "insert">) => {
  for (const tab of rendered.tabs) {
    const rows = await tx
      .insert(googleDocTabSnapshots)
      .values({
        userId,
        docId,
        tabId: tab.tabId,
        revisionId,
        title: tab.tabName,
        content: {
          content: tab.content,
          suggestions: tab.suggestions,
          suggestionsAccessible: rendered.suggestionsAccessible,
          parentTabId: tab.parentTabId,
          // Author/updater identity as Drive exposed it when this revision was
          // captured - read back by the mirror backfill so snapshot-backed
          // renders carry envelope authorship without a provider re-fetch.
          ...identity,
        },
        contentSha: tab.contentHash,
        sourceUpdatedAt: modifiedTime,
        capturedAt,
      })
      .onConflictDoNothing()
      .returning({ tabId: googleDocTabSnapshots.tabId });
    inserted += rows.length;
  }
  };
  if (typeof (db as Partial<typeof db>).transaction === "function") await db.transaction(writeTabs);
  else await writeTabs(db);

  // Stage the mirror docs from the content just persisted (same renderer the
  // backfill uses; versionRef = this revision). Fail-soft: the mirror is
  // regenerable from the snapshot rows, and a staging hiccup must not retry
  // the capture task into a deduped no-op that never re-renders.
  if (inserted > 0 || options.forceMaterialize) {
    try {
      const { materializeGoogleDocSourceWiki } = await import("../../../mirror/materializer.js");
      await materializeGoogleDocSourceWiki({
        userId,
        docId,
        title: rendered.title,
        overview: "",
        tabSummaries: null,
        tabContents: rendered.tabs.map((tab) => ({
          tabId: tab.tabId,
          tabName: tab.tabName,
          revisionId,
          content: tab.content,
          suggestions: tab.suggestions,
          suggestionsAccessible: rendered.suggestionsAccessible,
        })),
        rawJson: redactedRaw,
        revisionId,
        lastUpdated: modifiedTime,
        authorEmail: identity.authorEmail ?? null,
        authorName: identity.authorName ?? null,
        updatedByEmail: identity.updatedByEmail ?? null,
      });
    } catch (err) {
      console.warn(`[gdocs] mirror materialization failed for ${docId}:`, err instanceof Error ? err.message : err);
    }
  }

  // Source lane: native JSON, per-tab JSON, image bytes, Drive permissions
  // and the revision-to-revision snapshot diff as versioned source files.
  // Fail-soft like the mirror: a failure is recorded on the file checkpoint
  // (coverage shows it) and the source sweep retries with a fresh fetch.
  try {
    const { exportDocSnapshotToSources } = await import("../../../source-lane/providers/google-docs/sweep.js");
    await exportDocSnapshotToSources({
      userId,
      docId,
      title: rendered.title,
      redactedRaw,
      revisionId,
      modifiedTime: modifiedTime ? modifiedTime.toISOString() : null,
      suggestionsAccessible: rendered.suggestionsAccessible,
      images,
      imageSummary,
      identity,
    });
  } catch (err) {
    console.warn(`[gdocs] source export failed for ${docId}:`, err instanceof Error ? err.message : err);
    try {
      const { recordDocExportFailure } = await import("../../../source-lane/providers/google-docs/sweep.js");
      await recordDocExportFailure(userId, docId, err);
    } catch {
      // recording is best-effort; the checkpoint stays `pending`, so the sweep retries
    }
  }

  return {
    docId,
    status: inserted > 0 ? "captured" : "deduped_revision",
    revisionId,
    tabRowsInserted: inserted,
    title: rendered.title,
  };
}

/**
 * Docs API responses carry a doc-level `revisionId`; fall back to a content
 * digest so the version-append key still works if it's ever absent.
 */
function docRevisionId(doc: DocContent): string {
  const raw = doc.raw as { revisionId?: unknown } | null | undefined;
  if (raw && typeof raw.revisionId === "string" && raw.revisionId) return raw.revisionId;
  const digest = createHash("sha256")
    .update(doc.tabs.map((tab) => `${tab.tabId} ${tab.contentHash}`).join(""))
    .digest("hex")
    .slice(0, 16);
  return `content:${digest}`;
}

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Only identity fields that are actually present - absent, never guessed. */
function compactIdentity(identity: DocSnapshotIdentity): DocSnapshotIdentity {
  const out: DocSnapshotIdentity = {};
  if (identity.authorEmail) out.authorEmail = identity.authorEmail;
  if (identity.authorName) out.authorName = identity.authorName;
  if (identity.updatedByEmail) out.updatedByEmail = identity.updatedByEmail;
  if (identity.updatedByName) out.updatedByName = identity.updatedByName;
  return out;
}
