/**
 * Full Drive inventory for the Docs/Drive source lane.
 *
 * The donor lane only tracks files that appear in the Drive changes feed after connect, plus discovery runs
 * limited to Docs/Sheets/Slides. A file nobody touched since connect was therefore never captured. This sweep
 * lists everything each mailbox can see, page by page and resumably:
 *
 *  - phase `user`: `files.list corpora=user` (My Drive + files shared with the mailbox);
 *  - phase `drive:<id>` for every shared drive the mailbox can see (`corpora=drive`). Separate per-drive
 *    phases avoid `corpora=allDrives`, which Google may answer with `incompleteSearch`.
 *
 * Every listed file goes through the same donor/lane code as a live change from the changes feed:
 *  - `recordSourceLaneLiveChanges` writes the checkpoint (pending when the version is new) and the restore
 *    events;
 *  - Docs get a deduped `gdocs.content-snapshot` task;
 *  - PDFs go to the donor drive-pdf binary lane (`processDrivePdfChanges`).
 * The bounded source sweep then exports the pending checkpoints at its own rate. The page token is persisted
 * after each page, so a crash or a Retry-After resumes at the next unprocessed page; re-processing a page is
 * idempotent because checkpoints and snapshot tasks dedupe.
 *
 * A run is `complete` only when every phase was listed with no gaps. Later changes then arrive through the
 * changes feed. A completed inventory is re-run every GDOCS_DRIVE_INVENTORY_REFRESH_SECONDS (default 7 days)
 * as a reconciliation. Files that disappear between runs are not tombstoned from the listing: removal
 * stays the changes feed's job, because lifecycle is tracked per tenant, not per mailbox.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { GoogleRateLimitError } from "../../../vault/google-rate-limit.js";
import { googleErrorReason, googleFetch, type FetchImpl } from "./google-fetch.js";
import { GOOGLE_DOC_MIME, GOOGLE_FOLDER_MIME, PDF_MIME } from "./drive-export.js";
import { resolveDb, rowsOf, type StoreDeps } from "./store.js";
import type { DriveChange } from "../../../polling/_archived-gdocs/gdocs-api.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,md5Checksum,headRevisionId,parents,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),capabilities(canReadRevisions)";

function intEnv(name: string, fallback: number, min: number): number {
  const n = Math.floor(Number(process.env[name] ?? fallback));
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

export const INVENTORY_PAGE_SIZE = Math.min(1000, intEnv("GDOCS_DRIVE_INVENTORY_PAGE_SIZE", 500, 1));
export const INVENTORY_POLL_MAX_PAGES = intEnv("GDOCS_DRIVE_INVENTORY_POLL_MAX_PAGES", 3, 0);
export const INVENTORY_POLL_BUDGET_MS = intEnv("GDOCS_DRIVE_INVENTORY_POLL_BUDGET_MS", 15_000, 1_000);
export const INVENTORY_REFRESH_SECONDS = intEnv("GDOCS_DRIVE_INVENTORY_REFRESH_SECONDS", 7 * 24 * 3600, 3600);

export type InventoryState = "pending" | "running" | "complete" | "partial" | "blocked" | "error";

export interface InventoryRow {
  tenantId: string;
  mailbox: string;
  runId: string;
  state: InventoryState;
  reason: string | null;
  phases: string[] | null;
  phaseIndex: number;
  pageToken: string | null;
  pages: number;
  filesListed: number;
  filesRecorded: number;
  pdfsListed: number;
  gaps: Array<{ phase: string; reason: string }>;
  startedAt: string | null;
  lastPageAt: string | null;
  completedAt: string | null;
  lastCompleteAt: string | null;
  lastCompleteFiles: number | null;
  retryAt: string | null;
  attempts: number;
}

export interface InventoryDeps extends StoreDeps {
  fetchImpl?: FetchImpl;
  /** Roster override (tests); defaults to the donor `listGoogleMailboxes`. */
  mailboxes?: string[];
  /** Bearer for a mailbox (tests); defaults to `getGoogleAccessToken(tenant, mailbox, GOOGLE_DOCS_DELEGATION_SCOPES)`. */
  accessToken?: (mailbox: string) => Promise<string>;
  /** Donor hooks (tests); default to the archived gdocs poller functions. */
  hooks?: Partial<InventoryHooks>;
}

export interface InventoryHooks {
  recordLive(tenantId: string, mailbox: string, changes: DriveChange[]): Promise<number>;
  enqueueDocSnapshots(tenantId: string, files: NonNullable<DriveChange["file"] & { id: string }>[]): Promise<number>;
  processPdfs(tenantId: string, changes: DriveChange[], accessToken: string, mailbox: string): Promise<unknown>;
}

export interface InventoryRunOptions {
  maxPages: number;
  budgetMs: number;
  now?: Date;
  deps?: InventoryDeps;
}

export interface InventoryMailboxResult {
  mailbox: string;
  state: InventoryState | "skipped";
  reason: string | null;
  pages: number;
  files: number;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function json<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

function normalize(r: Record<string, unknown>): InventoryRow {
  return {
    tenantId: String(r.tenant_id),
    mailbox: String(r.mailbox),
    runId: String(r.run_id),
    state: r.state as InventoryState,
    reason: (r.reason as string | null) ?? null,
    phases: json<string[] | null>(r.phases, null),
    phaseIndex: Number(r.phase_index ?? 0),
    pageToken: (r.page_token as string | null) ?? null,
    pages: Number(r.pages ?? 0),
    filesListed: Number(r.files_listed ?? 0),
    filesRecorded: Number(r.files_recorded ?? 0),
    pdfsListed: Number(r.pdfs_listed ?? 0),
    gaps: json(r.gaps, []),
    startedAt: iso(r.started_at),
    lastPageAt: iso(r.last_page_at),
    completedAt: iso(r.completed_at),
    lastCompleteAt: iso(r.last_complete_at),
    lastCompleteFiles: r.last_complete_files == null ? null : Number(r.last_complete_files),
    retryAt: iso(r.retry_at),
    attempts: Number(r.attempts ?? 0),
  };
}

export async function listInventory(tenantId: string, deps?: StoreDeps): Promise<InventoryRow[]> {
  const db = await resolveDb(deps);
  return rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT * FROM gdocs_drive_inventory WHERE tenant_id = ${tenantId} ORDER BY mailbox
  `)).map(normalize);
}

async function save(row: InventoryRow, deps?: StoreDeps): Promise<void> {
  const db = await resolveDb(deps);
  await db.execute(sql`
    INSERT INTO gdocs_drive_inventory (
      tenant_id, mailbox, run_id, state, reason, phases, phase_index, page_token, pages, files_listed, files_recorded,
      pdfs_listed, gaps, started_at, last_page_at, completed_at, last_complete_at, last_complete_files, retry_at, attempts, updated_at
    ) VALUES (
      ${row.tenantId}, ${row.mailbox}, ${row.runId}, ${row.state}, ${row.reason},
      ${row.phases ? JSON.stringify(row.phases) : null}::jsonb, ${row.phaseIndex}, ${row.pageToken}, ${row.pages},
      ${row.filesListed}, ${row.filesRecorded}, ${row.pdfsListed}, ${JSON.stringify(row.gaps)}::jsonb,
      ${row.startedAt}::timestamptz, ${row.lastPageAt}::timestamptz, ${row.completedAt}::timestamptz,
      ${row.lastCompleteAt}::timestamptz, ${row.lastCompleteFiles}, ${row.retryAt}::timestamptz, ${row.attempts}, now()
    )
    ON CONFLICT (tenant_id, mailbox) DO UPDATE SET
      run_id = EXCLUDED.run_id, state = EXCLUDED.state, reason = EXCLUDED.reason, phases = EXCLUDED.phases,
      phase_index = EXCLUDED.phase_index, page_token = EXCLUDED.page_token, pages = EXCLUDED.pages,
      files_listed = EXCLUDED.files_listed, files_recorded = EXCLUDED.files_recorded, pdfs_listed = EXCLUDED.pdfs_listed,
      gaps = EXCLUDED.gaps, started_at = EXCLUDED.started_at, last_page_at = EXCLUDED.last_page_at,
      completed_at = EXCLUDED.completed_at, last_complete_at = EXCLUDED.last_complete_at,
      last_complete_files = EXCLUDED.last_complete_files, retry_at = EXCLUDED.retry_at, attempts = EXCLUDED.attempts,
      updated_at = now()
  `);
}

function freshRun(tenantId: string, mailbox: string, prior: InventoryRow | null, now: Date): InventoryRow {
  return {
    tenantId, mailbox, runId: randomUUID(), state: "running", reason: null, phases: null, phaseIndex: 0, pageToken: null,
    pages: 0, filesListed: 0, filesRecorded: 0, pdfsListed: 0, gaps: [], startedAt: now.toISOString(), lastPageAt: null,
    completedAt: null, lastCompleteAt: prior?.lastCompleteAt ?? null, lastCompleteFiles: prior?.lastCompleteFiles ?? null,
    retryAt: null, attempts: 0,
  };
}

/** Exponential backoff (60 s doubling, capped at 6 h) with Retry-After as the floor. */
function backoffSeconds(attempts: number, retryAfter: number | null): number {
  const exp = Math.min(6 * 3600, 60 * 2 ** Math.min(attempts, 10));
  return Math.max(exp, retryAfter ?? 0);
}

async function defaultHooks(): Promise<InventoryHooks> {
  const donor = await import("../../../polling/_archived-gdocs/gdocs.js");
  return {
    recordLive: (tenantId, mailbox, changes) => donor.recordSourceLaneLiveChanges(tenantId, mailbox, changes),
    enqueueDocSnapshots: (tenantId, files) => donor.enqueueContentSnapshotsForDocs(tenantId, files.map((f) => {
      const owner = f.owners?.[0];
      return {
        docId: f.id,
        modifiedTime: f.modifiedTime ?? null,
        authorEmail: owner?.emailAddress ?? null,
        authorName: owner?.displayName ?? null,
        updatedByEmail: f.lastModifyingUser?.emailAddress ?? null,
        updatedByName: f.lastModifyingUser?.displayName ?? null,
      };
    })),
    processPdfs: (tenantId, changes, accessToken, mailbox) => donor.processDrivePdfChanges(tenantId, changes, accessToken, mailbox),
  };
}

function credentialFailure(err: unknown): { state: "blocked" | "error"; reason: string } {
  const code = (err as { code?: unknown } | null)?.code;
  const name = (err as { name?: unknown } | null)?.name;
  if (typeof code === "string" && (code === "insufficient_scope" || code === "reauth_required" || code === "dwd_not_approved" || code === "bearer_unavailable")) {
    return { state: "blocked", reason: code === "bearer_unavailable" ? "composio_proxy_has_no_bearer" : code };
  }
  if (name === "GoogleDwdNotApprovedError") return { state: "blocked", reason: "dwd_not_approved" };
  return { state: "error", reason: `credential_failed:${err instanceof Error ? err.message : String(err)}`.slice(0, 500) };
}

async function listSharedDriveIds(ctx: { tenantId: string; mailbox: string; accessToken: string; fetchImpl?: FetchImpl }): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DRIVE_API}/drives`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,drives(id)");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await googleFetch(ctx, url.toString());
    if (!res.ok) throw new Error(`drives.list_http_${res.status}${(await googleErrorReason(res)) ? `:${await googleErrorReason(res)}` : ""}`);
    const data = (await res.json()) as { drives?: Array<{ id?: string }>; nextPageToken?: string };
    for (const d of data.drives ?? []) if (d.id) ids.push(d.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return [...new Set(ids)].sort();
}

function filesUrl(phase: string, pageToken: string | null): string {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", "trashed=false");
  url.searchParams.set("pageSize", String(INVENTORY_PAGE_SIZE));
  url.searchParams.set("fields", `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("spaces", "drive");
  if (phase === "user") url.searchParams.set("corpora", "user");
  else {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", phase.slice("drive:".length));
  }
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

type ListedFile = NonNullable<DriveChange["file"]> & { id: string };

/**
 * Advance the inventory for every mailbox of the tenant by at most `maxPages` pages within `budgetMs`.
 * Never throws for provider failures: they are recorded on the inventory row (and therefore in coverage).
 */
export async function runDriveInventory(tenantId: string, options: InventoryRunOptions): Promise<{ mailboxes: InventoryMailboxResult[]; stoppedFor: "budget" | "pages" | null }> {
  const started = Date.now();
  const deps = options.deps;
  const out: { mailboxes: InventoryMailboxResult[]; stoppedFor: "budget" | "pages" | null } = { mailboxes: [], stoppedFor: null };
  if (options.maxPages <= 0) return out;
  const mailboxes = deps?.mailboxes ?? await (await import("../../../integrations/google/mailboxes.js")).listGoogleMailboxes(tenantId);
  const existing = new Map((await listInventory(tenantId, deps)).map((r) => [r.mailbox, r]));
  const hooks = { ...(await defaultHooksLazy(deps)), ...(deps?.hooks ?? {}) } as InventoryHooks;
  let pagesLeft = options.maxPages;

  for (const mailbox of mailboxes) {
    const now = options.now ?? new Date();
    if (pagesLeft <= 0 || Date.now() - started > options.budgetMs) {
      out.stoppedFor = pagesLeft <= 0 ? "pages" : "budget";
      break;
    }
    const prior = existing.get(mailbox) ?? null;
    let row: InventoryRow;
    if (!prior) row = freshRun(tenantId, mailbox, null, now);
    else if (prior.retryAt && Date.parse(prior.retryAt) > now.getTime()) {
      out.mailboxes.push({ mailbox, state: "skipped", reason: `retry_at ${prior.retryAt}`, pages: 0, files: 0 });
      continue;
    } else if (prior.state === "complete" || prior.state === "partial" || prior.state === "blocked") {
      const since = Date.parse(prior.completedAt ?? prior.lastPageAt ?? prior.startedAt ?? "") || 0;
      // Blocked mailboxes retry hourly, runs with gaps every 6 h; complete runs refresh on the reconciliation interval.
      const due = prior.state === "blocked" ? 3600 : prior.state === "partial" ? 6 * 3600 : INVENTORY_REFRESH_SECONDS;
      if (now.getTime() - since < due * 1000) {
        out.mailboxes.push({ mailbox, state: "skipped", reason: `${prior.state}; next run due`, pages: 0, files: 0 });
        continue;
      }
      row = freshRun(tenantId, mailbox, prior, now);
    } else row = { ...prior, state: "running" };

    let accessToken: string;
    try {
      accessToken = deps?.accessToken
        ? await deps.accessToken(mailbox)
        : await (async () => {
          const auth = await import("../../../vault/google-auth.js");
          return auth.getGoogleAccessToken(tenantId, mailbox, auth.GOOGLE_DOCS_DELEGATION_SCOPES);
        })();
    } catch (err) {
      const f = credentialFailure(err);
      row.state = f.state;
      row.reason = f.reason;
      row.attempts += 1;
      row.retryAt = f.state === "error" ? new Date(now.getTime() + backoffSeconds(row.attempts, null) * 1000).toISOString() : null;
      if (f.state === "blocked") row.completedAt = now.toISOString();
      await save(row, deps);
      out.mailboxes.push({ mailbox, state: row.state, reason: row.reason, pages: 0, files: 0 });
      continue;
    }
    const ctx = { tenantId, mailbox, accessToken, fetchImpl: deps?.fetchImpl };
    let pages = 0;
    let files = 0;
    try {
      if (!row.phases) {
        let drives: string[] = [];
        try {
          drives = await listSharedDriveIds(ctx);
        } catch (err) {
          if (err instanceof GoogleRateLimitError) throw err;
          row.gaps.push({ phase: "drives", reason: err instanceof Error ? err.message : String(err) });
        }
        row.phases = ["user", ...drives.map((d) => `drive:${d}`)];
        row.phaseIndex = 0;
        row.pageToken = null;
        await save(row, deps);
      }
      while (row.phaseIndex < row.phases.length) {
        if (pagesLeft <= 0 || Date.now() - started > options.budgetMs) {
          out.stoppedFor = pagesLeft <= 0 ? "pages" : "budget";
          break;
        }
        const phase = row.phases[row.phaseIndex]!;
        const res = await googleFetch(ctx, filesUrl(phase, row.pageToken));
        pagesLeft -= 1;
        pages += 1;
        if (!res.ok) {
          const reason = `files.list_http_${res.status}${(await googleErrorReason(res)) ? `:${await googleErrorReason(res)}` : ""}`;
          if (phase !== "user" && (res.status === 404 || res.status === 403)) {
            // Shared drive removed / no longer visible: a gap in this run, not a stuck run.
            row.gaps.push({ phase, reason });
            row.phaseIndex += 1;
            row.pageToken = null;
            await save(row, deps);
            continue;
          }
          if (res.status === 400 && row.pageToken) {
            // Expired / invalid page token: restart this phase (re-listing is idempotent).
            row.pageToken = null;
            await save(row, deps);
            continue;
          }
          throw Object.assign(new Error(reason), { inventoryReason: reason });
        }
        const data = (await res.json()) as { files?: ListedFile[]; nextPageToken?: string; incompleteSearch?: boolean };
        const listed = (data.files ?? []).filter((f) => f && typeof f.id === "string" && !f.trashed);
        const changes: DriveChange[] = listed
          .filter((f) => f.mimeType !== GOOGLE_FOLDER_MIME)
          .map((f) => ({ fileId: f.id, removed: false, file: { ...f, trashed: false } }));
        const pdfs = changes.filter((c) => c.file?.mimeType === PDF_MIME);
        const laneChanges = changes.filter((c) => c.file?.mimeType !== PDF_MIME);
        await hooks.recordLive(tenantId, mailbox, laneChanges);
        const docs = listed.filter((f) => f.mimeType === GOOGLE_DOC_MIME);
        const docsNeedingContent = await docsWithoutCompleteContent(tenantId, docs.map((d) => d.id), deps);
        if (docsNeedingContent.size) await hooks.enqueueDocSnapshots(tenantId, docs.filter((d) => docsNeedingContent.has(d.id)));
        if (pdfs.length) await hooks.processPdfs(tenantId, pdfs, accessToken, mailbox);
        if (data.incompleteSearch) row.gaps.push({ phase, reason: "incompleteSearch" });
        row.pages += 1;
        row.filesListed += listed.length;
        row.filesRecorded += laneChanges.length;
        row.pdfsListed += pdfs.length;
        files += listed.length;
        row.lastPageAt = new Date().toISOString();
        row.attempts = 0;
        row.retryAt = null;
        row.reason = null;
        if (data.nextPageToken) row.pageToken = data.nextPageToken;
        else {
          row.phaseIndex += 1;
          row.pageToken = null;
        }
        await save(row, deps);
      }
      if (row.phases && row.phaseIndex >= row.phases.length) {
        const at = new Date().toISOString();
        row.completedAt = at;
        if (row.gaps.length) {
          row.state = "partial";
          row.reason = row.gaps.map((g) => `${g.phase}: ${g.reason}`).slice(0, 10).join("; ");
        } else {
          row.state = "complete";
          row.reason = null;
          row.lastCompleteAt = at;
          row.lastCompleteFiles = row.filesListed;
        }
        await save(row, deps);
      }
    } catch (err) {
      const rateLimited = err instanceof GoogleRateLimitError;
      row.attempts += 1;
      row.state = "running";
      row.reason = rateLimited ? "rate_limited" : ((err as { inventoryReason?: string }).inventoryReason ?? `error:${err instanceof Error ? err.message : String(err)}`).slice(0, 500);
      if (!rateLimited) row.state = "error";
      row.retryAt = new Date(Date.now() + backoffSeconds(row.attempts, rateLimited ? (err as GoogleRateLimitError).retryAfterSeconds ?? null : null) * 1000).toISOString();
      await save(row, deps);
    }
    out.mailboxes.push({ mailbox, state: row.state, reason: row.reason, pages, files });
  }
  return out;
}

async function defaultHooksLazy(deps?: InventoryDeps): Promise<Partial<InventoryHooks>> {
  // Tests that inject every hook never load the donor poller module.
  if (deps?.hooks?.recordLive && deps.hooks.enqueueDocSnapshots && deps.hooks.processPdfs) return {};
  return defaultHooks();
}

async function docsWithoutCompleteContent(tenantId: string, ids: string[], deps?: StoreDeps): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const db = await resolveDb(deps);
  const complete = new Set(rowsOf<{ file_id: string }>(await db.execute(sql`
    SELECT file_id FROM gdocs_file_checkpoints
    WHERE tenant_id = ${tenantId} AND content_state = 'complete'
      AND file_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
  `)).map((r) => r.file_id));
  return new Set(ids.filter((id) => !complete.has(id)));
}

/** Coverage for the `drive-inventory` scope (see coverage.ts). */
export function inventoryCoverage(rows: InventoryRow[], roster: string[] | null): {
  state: "complete" | "partial" | "blocked" | "pending";
  reason: string;
  lastSuccessAt?: string;
  counts: Record<string, number>;
} {
  const byMailbox = new Map(rows.map((r) => [r.mailbox, r]));
  const mailboxes = roster ?? rows.map((r) => r.mailbox);
  const missing = mailboxes.filter((m) => !byMailbox.has(m));
  const considered = mailboxes.map((m) => byMailbox.get(m)).filter((r): r is InventoryRow => Boolean(r));
  const tally: Record<string, number> = {};
  for (const r of considered) tally[r.state] = (tally[r.state] ?? 0) + 1;
  const covered = considered.filter((r) => r.lastCompleteAt);
  const lastPage = considered.map((r) => r.lastPageAt).filter((x): x is string => Boolean(x)).sort().pop();
  const counts = {
    mailboxes: mailboxes.length,
    mailboxesListedCompletely: covered.length,
    mailboxesNotStarted: missing.length,
    filesListed: considered.reduce((n, r) => n + (r.lastCompleteFiles ?? r.filesListed), 0),
    ...Object.fromEntries(Object.entries(tally).map(([k, v]) => [`state_${k}`, v])),
  };
  if (mailboxes.length === 0) return { state: "pending", reason: "no Google mailbox in the roster yet", counts };
  if (considered.length && considered.every((r) => r.state === "blocked")) {
    return { state: "blocked", reason: [...new Set(considered.map((r) => r.reason ?? "blocked"))].join("; "), counts, ...(lastPage ? { lastSuccessAt: lastPage } : {}) };
  }
  if (!missing.length && covered.length === mailboxes.length) {
    const oldest = covered.map((r) => r.lastCompleteAt!).sort()[0]!;
    return {
      state: "complete",
      reason: `full Drive listing (My Drive + shared-with-me + every visible shared drive) completed for all ${mailboxes.length} mailbox(es), oldest at ${oldest}; later changes arrive through the Drive changes feed`,
      counts,
      lastSuccessAt: lastPage ?? oldest,
    };
  }
  const gaps = considered.filter((r) => !r.lastCompleteAt).map((r) => `${r.mailbox}: ${r.state}${r.reason ? ` (${r.reason})` : ""}`);
  return {
    state: considered.some((r) => r.pages > 0 || r.lastCompleteAt) ? "partial" : "pending",
    reason: [
      missing.length ? `${missing.length} mailbox(es) not listed yet` : null,
      gaps.length ? `in progress / incomplete: ${gaps.slice(0, 5).join("; ")}` : null,
      "files untouched since connect are captured only once their mailbox's full listing completes",
    ].filter(Boolean).join("; "),
    counts,
    ...(lastPage ? { lastSuccessAt: lastPage } : {}),
  };
}
