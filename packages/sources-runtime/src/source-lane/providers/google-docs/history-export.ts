/**
 * Export a Google Doc's OT change history (undocumented /revisions/load) as
 * source files: raw changelog pages, parsed ops with exact replay effects,
 * Google revision-tile chunks, 5-minute per-user session diff events,
 * suggestion lifecycle, tab history, and an explicit status file.
 *
 * Fail-closed: derived history (operations, sessions, suggestions, tabs) is
 * only (re)written from a COMPLETE changelog. A partial capture writes the raw
 * pages it did get plus a `partial` status, keeps the last complete
 * checkpoint, and schedules a retry honoring Retry-After. Composio-proxied
 * connections are `blocked` with `ot_requires_bearer` and never attempted.
 *
 * Pages are stored, compared for reuse, and replayed in ONE representation:
 * `redactChangelogResponse` (shared google-docs redaction, length-preserving
 * inside the positional OT data), so a redacted credential never shifts OT
 * indices and stored pages are byte-for-byte what the parser saw.
 */
import { sql } from "drizzle-orm";
import {
  collectSnapshotOps,
  parseChangelogEntries,
  replayWithDiffs,
  type DocChangelog,
} from "../../../polling/_archived-gdocs/gdocs-revisions-load.js";
import { trackSuggestions } from "../../../polling/_archived-gdocs/gdocs-suggestion-tracker.js";
import { extractTabChanges } from "../../../integrations/google/gdocs/tab-changes.js";
import { redactProviderPayload } from "../../../vault/redaction.js";
import { changelogRefusalNote, docsHistoryBlockedNote, docsHistoryCapability, loadGoogleAuthMode, type GoogleAuthMode } from "./auth-mode.js";
import { captureChangelogPages, entriesFromPages, type ChangelogCaptureResult, type RawChangelogPage } from "./changelog-capture.js";
import { CHANGELOG_REDACTION_SCHEME, hasLegacyFixedLengthRedaction, redactChangelogResponse } from "./changelog-redaction.js";
import { getCheckpoint, retryDelaySeconds, setExportDirectory, setHistoryState, type FileCheckpoint } from "./checkpoints.js";
import type { FetchImpl } from "./google-fetch.js";
import { docDirectory, docPaths } from "./paths.js";
import { buildSessionDiffEvents, replayChangelog } from "./sessions.js";
import {
  deleteSourceFile,
  jsonBytes,
  listLiveHeads,
  moveFileExports,
  putSourceFile,
  readBlobBytes,
  resolveDb,
  rowsOf,
  type StoreDeps,
} from "./store.js";

const STATE_BUDGET_BYTES = Math.max(0, Math.floor(Number(process.env.GDOCS_SESSION_STATE_MAX_BYTES ?? 256 * 1024 * 1024)));
const BLOCKED_RETRY_SECONDS = 24 * 60 * 60;

export interface DocHistoryExportInput {
  tenantId: string;
  docId: string;
  title: string;
  mailbox?: string | null;
  authMode?: GoogleAuthMode;
  /** Bearer for a writer+ identity; resolved via getGoogleAccessToken when absent. */
  accessToken?: string;
  fetchImpl?: FetchImpl;
  now?: Date;
  deps?: StoreDeps;
  /** Overrides for the known-total page pool (defaults: GDOCS_CHANGELOG_PAGE_CONCURRENCY / GDOCS_CHANGELOG_MAX_RPS). */
  changelogFetch?: { pageConcurrency?: number; requestsPerSecond?: number };
}

export interface DocHistoryExportResult {
  state: "complete" | "pending" | "partial" | "blocked" | "error";
  reason: string | null;
  totalEntries: number | null;
  fetchedEntries: number;
  sessions: number;
  pendingSessionOps: number;
  retryAt: string | null;
  directory: string;
}

function pageFileBody(docId: string, page: RawChangelogPage): Record<string, unknown> {
  const response = page.response ?? {
    changelog: page.changelog,
    ...(page.chunkedSnapshot !== undefined ? { chunkedSnapshot: page.chunkedSnapshot } : {}),
  };
  return {
    schema: "procmem.gdocs.changelog-page/v1",
    docId,
    start: page.start,
    end: page.end,
    entryCount: page.changelog.length,
    endpoint: "docs.google.com/document/d/<id>/revisions/load (undocumented; anti-XSSI prefix stripped)",
    // Credentialed strings in changelog/chunkedSnapshot are replaced by
    // placeholders of the same UTF-16 length, so OT positions stay exact.
    redaction: CHANGELOG_REDACTION_SCHEME,
    // Idempotent: pages from the capture are already in this representation.
    response: redactChangelogResponse(response),
  };
}

type StoredPage = RawChangelogPage & { legacyFixedLengthRedaction: boolean };
type PageRange = { start: number; end: number };

async function readHeadJson<T>(tenantId: string, head: { path: string; seq: number }, deps?: StoreDeps): Promise<T | null> {
  const db = await resolveDb(deps);
  const [row] = rowsOf<{ chunks: string[] | string }>(await db.execute(sql`
    SELECT chunks FROM gdocs_source_file_versions
    WHERE tenant_id = ${tenantId} AND path = ${head.path} AND seq = ${head.seq}
  `));
  if (!row) return null;
  const chunks = typeof row.chunks === "string" ? JSON.parse(row.chunks) as string[] : row.chunks;
  return JSON.parse((await readBlobBytes(tenantId, chunks, deps)).toString("utf8")) as T;
}

/** Legacy pages named by the previous status: derived history stays legacy-derived until a complete capture. */
async function priorLegacyPages(tenantId: string, docId: string, statusPath: string, deps?: StoreDeps): Promise<PageRange[]> {
  const head = (await listLiveHeads(tenantId, docId, deps)).find((h) => h.path === statusPath);
  if (!head) return [];
  const status = await readHeadJson<{ legacyRedaction?: { pages?: PageRange[] } }>(tenantId, head, deps).catch(() => null);
  return Array.isArray(status?.legacyRedaction?.pages) ? status.legacyRedaction.pages : [];
}

async function loadStoredPages(tenantId: string, docId: string, dir: string, deps?: StoreDeps): Promise<StoredPage[]> {
  const prefix = `${docPaths(dir).changelogPagesDir}/`;
  const heads = (await listLiveHeads(tenantId, docId, deps)).filter((h) => h.path.startsWith(prefix));
  const pages: StoredPage[] = [];
  for (const head of heads) {
    const body = await readHeadJson<{
      start: number; end: number; redaction?: string; response: Record<string, unknown>;
    }>(tenantId, head, deps);
    if (!body) continue;
    const changelog = Array.isArray(body.response?.changelog) ? body.response.changelog as unknown[][] : [];
    pages.push({
      start: body.start,
      end: body.end,
      changelog,
      ...(body.start === 1 ? { chunkedSnapshot: body.response.chunkedSnapshot ?? null } : {}),
      response: body.response,
      fetchedAt: "stored",
      legacyFixedLengthRedaction: hasLegacyFixedLengthRedaction(body),
    });
  }
  return pages.sort((a, b) => a.start - b.start);
}

function userMapFrom(raw: Record<string, Record<string, unknown>>): DocChangelog["userMap"] {
  const map: DocChangelog["userMap"] = new Map();
  for (const [id, info] of Object.entries(raw)) {
    map.set(id, {
      name: (info?.name as string) ?? "",
      photo: info?.photo as string | undefined,
      anonymous: (info?.anonymous as boolean) ?? false,
    });
  }
  return map;
}

async function writeStatus(
  input: DocHistoryExportInput,
  dir: string,
  status: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await putSourceFile({
    tenantId: input.tenantId,
    fileId: input.docId,
    path: docPaths(dir).changelogStatus,
    kind: "projection",
    contentType: "application/json",
    bytes: jsonBytes({ schema: "procmem.gdocs.changelog-status/v1", docId: input.docId, ...status }),
    sourceOrder: now.getTime(),
    capturedAt: now,
  }, input.deps);
}

function lastCompleteOf(cp: FileCheckpoint | null): Record<string, unknown> | null {
  if (!cp || !cp.historyCompleteAt) return null;
  return { entries: cp.historyCompleteEntries, at: cp.historyCompleteAt };
}

export async function exportDocHistory(input: DocHistoryExportInput): Promise<DocHistoryExportResult> {
  const now = input.now ?? new Date();
  const deps = input.deps;
  const dir = docDirectory(input.docId, input.title);
  const paths = docPaths(dir);
  const checkpoint = await getCheckpoint(input.tenantId, input.docId, deps);
  if (checkpoint?.exportDirectory && checkpoint.exportDirectory !== dir) {
    await moveFileExports({ tenantId: input.tenantId, fileId: input.docId, fromDirectory: checkpoint.exportDirectory, toDirectory: dir, capturedAt: now }, deps);
  }
  await setExportDirectory(input.tenantId, input.docId, dir, deps, { mimeType: "application/vnd.google-apps.document", name: input.title });

  const mode = input.authMode ?? await loadGoogleAuthMode(input.tenantId, input.mailbox).catch(() => "unknown" as const);
  const capability = docsHistoryCapability(mode);
  const base = {
    endpoint: "undocumented docs.google.com /revisions/tiles + /revisions/load; writer+ role required; no SLA",
    authMode: mode,
    attemptedAt: now.toISOString(),
    lastComplete: lastCompleteOf(checkpoint),
  };

  const result = (state: DocHistoryExportResult["state"], extra: Partial<DocHistoryExportResult>): DocHistoryExportResult => ({
    state,
    reason: null,
    totalEntries: null,
    fetchedEntries: 0,
    sessions: 0,
    pendingSessionOps: 0,
    retryAt: null,
    directory: dir,
    ...extra,
  });

  if (!capability.changelog) {
    await writeStatus(input, dir, { ...base, state: "blocked", reason: capability.reason,
      ...(capability.content ? {} : { contentReason: capability.contentReason }),
      note: docsHistoryBlockedNote(capability) }, now);
    await setHistoryState(input.tenantId, input.docId, { state: "blocked", reason: capability.reason }, deps);
    return result("blocked", { reason: capability.reason });
  }

  let accessToken = input.accessToken;
  if (!accessToken) {
    try {
      const { getGoogleAccessToken, GOOGLE_DOCS_DELEGATION_SCOPES } = await import("../../../vault/google-auth.js");
      accessToken = await getGoogleAccessToken(input.tenantId, input.mailbox ?? undefined, GOOGLE_DOCS_DELEGATION_SCOPES);
    } catch (err) {
      const reason = `token_unavailable: ${err instanceof Error ? err.message : String(err)}`;
      const retryAt = new Date(now.getTime() + retryDelaySeconds(checkpoint?.historyAttempts ?? 0) * 1000);
      await writeStatus(input, dir, { ...base, state: "error", reason }, now);
      await setHistoryState(input.tenantId, input.docId, { state: "error", reason, retryAt }, deps);
      return result("error", { reason, retryAt: retryAt.toISOString() });
    }
  }

  const storedPages = checkpoint && checkpoint.historyCompleteEntries > 0
    ? await loadStoredPages(input.tenantId, input.docId, dir, deps)
    : [];
  // A page stored with the old fixed-length placeholder cannot be replayed
  // faithfully (the original length is gone): offer only the clean prefix
  // before it, so that page and everything after it are fetched again.
  const firstLegacy = storedPages.findIndex((p) => p.legacyFixedLengthRedaction);
  const reusablePages = firstLegacy < 0 ? storedPages : storedPages.slice(0, firstLegacy);
  const legacyPages: PageRange[] = [];
  for (const p of [
    ...(storedPages.length > 0 ? await priorLegacyPages(input.tenantId, input.docId, paths.changelogStatus, deps) : []),
    ...storedPages.filter((sp) => sp.legacyFixedLengthRedaction),
  ]) {
    if (!legacyPages.some((l) => l.start === p.start)) legacyPages.push({ start: p.start, end: p.end });
  }
  legacyPages.sort((a, b) => a.start - b.start);
  const capture = await captureChangelogPages(
    { tenantId: input.tenantId, mailbox: input.mailbox ?? null, accessToken, fetchImpl: input.fetchImpl },
    input.docId,
    {
      reusablePages,
      now: () => now,
      normalizeResponse: redactChangelogResponse,
      authMode: mode,
      pageConcurrency: input.changelogFetch?.pageConcurrency,
      requestsPerSecond: input.changelogFetch?.requestsPerSecond,
    },
  );

  // Raw pages are real data in every outcome: store what was fetched.
  const capturedPagePaths = new Set<string>();
  for (const page of capture.pages) capturedPagePaths.add(paths.changelogPage(page.start, page.end));
  for (const page of capture.fetchedPages) {
    await putSourceFile({
      tenantId: input.tenantId,
      fileId: input.docId,
      path: paths.changelogPage(page.start, page.end),
      kind: "raw",
      contentType: "application/json",
      bytes: jsonBytes(pageFileBody(input.docId, page)),
      sourceOrder: now.getTime(),
      capturedAt: now,
      provenance: { fetchedAt: page.fetchedAt, captureState: capture.state },
    }, deps);
  }
  if (capture.tiles.length > 0 || Object.keys(capture.userMap).length > 0) {
    await putSourceFile({
      tenantId: input.tenantId,
      fileId: input.docId,
      path: paths.changelogTiles,
      kind: "raw",
      contentType: "application/json",
      bytes: jsonBytes(redactProviderPayload("google-docs", { tileInfo: capture.tiles, userMap: capture.userMap })),
      sourceOrder: now.getTime(),
      capturedAt: now,
    }, deps);
  }

  const fetchStats = { ...capture.stats, reusedPages: capture.reusedPages, fetchedPages: capture.fetchedPages.length };
  if (capture.state !== "complete") {
    // The previous complete history was derived from legacy fixed-length
    // redacted pages: positions after a redacted insertion may be shifted, and
    // that stays true until a complete recapture replaces those pages.
    const legacy = legacyPages.length > 0
      ? { legacyRedaction: { pages: legacyPages, note: "lastComplete derived history (operations, sessions, revision chunks, suggestions) was replayed from pages stored with a fixed-length credential placeholder; text positions after that insertion may be shifted until a complete recapture succeeds. Original lengths are not recoverable from the stored pages." } }
      : {};
    return recordIncomplete(input, dir, capture, checkpoint, { ...base, ...legacy, fetchStats }, now, result);
  }

  // Parse the stored representation (length-preserving redaction, applied by
  // the capture) so derived files are exactly reproducible from the published
  // raw pages, and positions match the unredacted history.
  const entries = entriesFromPages(capture.pages);
  const firstPage = capture.pages.find((p) => p.start === 1);
  const userMap = userMapFrom(redactProviderPayload("google-docs", capture.userMap) as Record<string, Record<string, unknown>>);
  const changelog = parseChangelogEntries(input.docId, entries, collectSnapshotOps(firstPage?.chunkedSnapshot), userMap);
  const totalEntries = entries.length;
  // Runs are serialized per tenant (tenant:gdocs group); an older run that
  // finishes late must not overwrite a newer one.
  const order = now.getTime();
  const derived = async (path: string, value: unknown, contentType = "application/json", raw?: Buffer) =>
    putSourceFile({
      tenantId: input.tenantId,
      fileId: input.docId,
      path,
      kind: "projection",
      contentType,
      bytes: raw ?? jsonBytes(value),
      sourceVersion: `entries:${totalEntries}`,
      sourceOrder: order,
      capturedAt: now,
      provenance: { derivedFrom: "complete changelog", entries: totalEntries },
    }, deps);

  const replayed = replayChangelog(changelog);
  await derived(paths.operations, null, "application/x-ndjson",
    Buffer.from(replayed.map((op) => JSON.stringify(op)).join("\n") + (replayed.length ? "\n" : ""), "utf8"));

  if (capture.tiles.length > 0) {
    const chunks = replayWithDiffs(changelog.operations, capture.tiles, changelog.userMap);
    await derived(paths.revisionChunks, {
      schema: "procmem.gdocs.revision-chunks/v1",
      docId: input.docId,
      note: "Donor replayWithDiffs over Google's own revision tiles (authors per tile from tiles userMap).",
      chunks,
    });
  }

  const tabChanges = extractTabChanges(changelog);
  await derived(paths.tabs, {
    schema: "procmem.gdocs.tabs/v1",
    docId: input.docId,
    tabs: tabChanges.state,
    events: tabChanges.events,
    limitations: [
      "Tab deletion is inferred from a repeat `dc` op (donor buildTabState); the parser never emits tab_deleted.",
      "oldName is not recoverable from the changelog (mkch renames by position).",
    ],
  });

  const suggestions = trackSuggestions(changelog);
  await derived(paths.suggestions, {
    schema: "procmem.gdocs.suggestions/v1",
    docId: input.docId,
    ...suggestions,
    limitations: ["Acceptance falls back to same-position/later-timestamp matching when the accepting op lacks sugId (donor tracker rule 2b)."],
  });

  const cards = await loadSuggestionCards(input.tenantId, input.docId, deps).catch(() => null);
  // Donor cards are built from the unredacted in-memory changelog and content: apply the provider policy before export.
  if (cards) await derived(paths.suggestionCards, { schema: "procmem.gdocs.suggestion-cards/v1", docId: input.docId, cards: redactProviderPayload("google-docs", cards) });

  // Sessions + referenced text states (within an explicit byte budget).
  const sessionResult = buildSessionDiffEvents(changelog, now);
  const writtenStates = new Set<string>();
  let stateBytes = 0;
  const liveSessionPaths = new Set<string>();
  for (const session of sessionResult.sessions) {
    for (const tab of session.tabs) {
      for (const ref of [tab.before, tab.after] as Array<{ sha256: string; length: number; omitted?: string }>) {
        if (writtenStates.has(ref.sha256)) continue;
        const text = sessionResult.states.get(ref.sha256) ?? "";
        const bytes = Buffer.from(text, "utf8");
        if (stateBytes + bytes.byteLength > STATE_BUDGET_BYTES) {
          ref.omitted = "state_budget_exceeded";
          continue;
        }
        stateBytes += bytes.byteLength;
        writtenStates.add(ref.sha256);
        await derived(paths.state(ref.sha256), null, "text/plain; charset=utf-8", bytes);
      }
    }
    const path = paths.session(session.sessionKey);
    liveSessionPaths.add(path);
    await derived(path, session);
  }

  // Retire session/page files that are not part of the current complete
  // history (only happens when Google's changelog no longer matches ours).
  for (const head of await listLiveHeads(input.tenantId, input.docId, deps)) {
    const stalePage = head.path.startsWith(`${paths.changelogPagesDir}/`) && !capturedPagePaths.has(head.path);
    const staleSession = head.path.startsWith(`${paths.sessionsDir}/`) && !liveSessionPaths.has(head.path);
    if (stalePage || staleSession) {
      await deleteSourceFile({ tenantId: input.tenantId, path: head.path, fileId: input.docId, reason: "superseded_by_complete_changelog", capturedAt: now }, deps);
    }
  }

  const pending = sessionResult.pendingOps > 0;
  const retryAt = pending && sessionResult.pendingCompleteAt ? new Date(sessionResult.pendingCompleteAt) : null;
  await writeStatus(input, dir, {
    ...base,
    state: "complete",
    reason: capture.reason,
    totalEntries,
    tilesTotal: capture.tilesTotal,
    pages: capture.pages.length,
    reusedPages: capture.reusedPages,
    fetchedPages: capture.fetchedPages.length,
    fetchStats,
    ...(legacyPages.length > 0 ? { legacyRedactionRepaired: { pages: legacyPages } } : {}),
    sessions: sessionResult.sessions.length,
    pendingSessionOps: sessionResult.pendingOps,
    pendingSessionsCompleteAt: sessionResult.pendingCompleteAt,
    stateBudgetBytes: STATE_BUDGET_BYTES,
    stateBytesWritten: stateBytes,
    completeAt: now.toISOString(),
    lastComplete: { entries: totalEntries, at: now.toISOString() },
  }, now);
  await setHistoryState(input.tenantId, input.docId, {
    state: pending ? "pending" : "complete",
    reason: pending ? "sessions_pending" : capture.reason,
    completeEntries: totalEntries,
    fetchedEntries: capture.fetchedEntries,
    retryAt,
  }, deps);
  return result(pending ? "pending" : "complete", {
    reason: pending ? "sessions_pending" : capture.reason,
    totalEntries,
    fetchedEntries: capture.fetchedEntries,
    sessions: sessionResult.sessions.length,
    pendingSessionOps: sessionResult.pendingOps,
    retryAt: retryAt?.toISOString() ?? null,
  });
}

async function recordIncomplete(
  input: DocHistoryExportInput,
  dir: string,
  capture: ChangelogCaptureResult,
  checkpoint: FileCheckpoint | null,
  base: Record<string, unknown>,
  now: Date,
  result: (state: DocHistoryExportResult["state"], extra: Partial<DocHistoryExportResult>) => DocHistoryExportResult,
): Promise<DocHistoryExportResult> {
  const state = capture.state as "partial" | "blocked" | "error";
  const delay = state === "blocked"
    ? Math.max(BLOCKED_RETRY_SECONDS, capture.retryAfterSeconds ?? 0)
    : retryDelaySeconds(checkpoint?.historyAttempts ?? 0, capture.retryAfterSeconds);
  const retryAt = new Date(now.getTime() + delay * 1000);
  await writeStatus(input, dir, {
    ...base,
    state,
    reason: capture.reason,
    httpStatus: capture.httpStatus,
    retryAfterSeconds: capture.retryAfterSeconds,
    retryAt: retryAt.toISOString(),
    tilesTotal: capture.tilesTotal,
    fetchedEntries: capture.fetchedEntries,
    failedRange: capture.failedRange,
    note: state === "partial"
      ? "Changelog capture stopped before the end. Raw pages fetched so far are stored, but operations, sessions, suggestions and tab history still reflect lastComplete (if any) and must not be read as full history."
      : state === "blocked"
        ? changelogRefusalNote(capture.reason)
        : "Changelog capture failed before any page.",
  }, now);
  await setHistoryState(input.tenantId, input.docId, {
    state,
    reason: capture.reason,
    fetchedEntries: capture.fetchedEntries,
    retryAt,
  }, input.deps);
  return result(state, {
    reason: capture.reason,
    totalEntries: capture.tilesTotal,
    fetchedEntries: capture.fetchedEntries,
    retryAt: retryAt.toISOString(),
  });
}

async function loadSuggestionCards(tenantId: string, docId: string, deps?: StoreDeps): Promise<unknown[]> {
  const db = await resolveDb(deps);
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM google_doc_suggestions WHERE user_id = ${tenantId} AND doc_id = ${docId} ORDER BY suggestion_id
  `));
}
