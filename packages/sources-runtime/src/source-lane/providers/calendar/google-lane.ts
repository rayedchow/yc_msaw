import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { listGoogleMailboxes } from "../../../integrations/google/mailboxes.js";
import {
  GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES,
  fetchGoogleApi,
  getGoogleApiCredential,
  isDelegationConfigured,
  type GoogleApiCredential,
} from "../../../vault/google-auth.js";
import { GoogleDwdNotApprovedError } from "../../../vault/google-dwd-policy.js";
import { GoogleOAuthError } from "../../../vault/google-oauth.js";
import {
  GoogleRateLimitError,
  googleErrorMessageFromPayload,
  googleErrorReasonFromPayload,
  googleRateLimitErrorFromResponse,
  throwIfGoogleRateLimited,
} from "../../../vault/google-rate-limit.js";
import { getTokenMetadata } from "../../../vault/tokens.js";

/**
 * Shared plumbing of the Google Calendar and Google Contacts source lanes:
 * per-account credentials through the google-auth seam (DWD, direct OAuth or
 * Composio via fetchGoogleApi), rate-limit cooldowns keyed by the upstream quota
 * identity, failure classification, persisted backoff, roster resolution,
 * per-mailbox status rows and cursor leases.
 */

export type Executor = Pick<typeof db, "execute">;

export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && "rows" in result ? (result as { rows: T[] }).rows : [];
}

export async function queryRows<T>(query: SQL, executor: Executor = db): Promise<T[]> {
  return rowsOf<T>(await executor.execute(query));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Raw JSON diff (leaf-level, JSON-pointer paths; arrays compared by index)
// ---------------------------------------------------------------------------

export interface JsonDiffEntry {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

export function jsonDiff(before: unknown, after: unknown, path = ""): JsonDiffEntry[] {
  if (stableJson(before ?? null) === stableJson(after ?? null)) return [];
  const bothObjects = isPlainObject(before) && isPlainObject(after);
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  if (bothObjects) {
    const out: JsonDiffEntry[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const child = `${path}/${pointerToken(key)}`;
      if (!(key in before)) out.push({ path: child, op: "add", after: after[key] });
      else if (!(key in after)) out.push({ path: child, op: "remove", before: before[key] });
      else out.push(...jsonDiff(before[key], after[key], child));
    }
    return out;
  }
  if (bothArrays) {
    const out: JsonDiffEntry[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const child = `${path}/${i}`;
      if (i >= before.length) out.push({ path: child, op: "add", after: after[i] });
      else if (i >= after.length) out.push({ path: child, op: "remove", before: before[i] });
      else out.push(...jsonDiff(before[i], after[i], child));
    }
    return out;
  }
  if (before === undefined) return [{ path: path || "/", op: "add", after }];
  if (after === undefined) return [{ path: path || "/", op: "remove", before }];
  return [{ path: path || "/", op: "replace", before, after }];
}

function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Errors and their classification
// ---------------------------------------------------------------------------

export class LaneGoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = "LaneGoogleApiError";
  }
}

export type LaneFailureKind = "auth_blocked" | "rate_limited" | "transient" | "permanent";

export interface LaneFailure {
  kind: LaneFailureKind;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

/** Credential-resolution and API failures, mapped to how the lane must react. */
export function classifyLaneFailure(err: unknown): LaneFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof GoogleRateLimitError) {
    return { kind: "rate_limited", code: err.reason ?? `http_${err.status}`, message, retryAfterSeconds: err.retryAfterSeconds };
  }
  if (err instanceof GoogleDwdNotApprovedError) return { kind: "auth_blocked", code: "dwd_not_approved", message };
  if (err instanceof GoogleOAuthError) {
    // insufficient_scope / reauth_required / bearer_unavailable: this account only; never escalated tenant-wide.
    return { kind: err.code === "token_refresh_failed" ? "transient" : "auth_blocked", code: err.code, message };
  }
  if (err instanceof LaneGoogleApiError) {
    if (err.status === 401) return { kind: "auth_blocked", code: "unauthorized", message };
    if (err.status === 403) return { kind: "auth_blocked", code: err.reason ?? "forbidden", message };
    if (err.status === 408 || err.status === 409 || err.status >= 500) return { kind: "transient", code: `http_${err.status}`, message };
    return { kind: "permanent", code: err.reason ?? `http_${err.status}`, message };
  }
  if (/not connected|not configured|missing service account|managed google workspace email|unauthorized_client/i.test(message)) {
    return { kind: "auth_blocked", code: "credential_unavailable", message };
  }
  return { kind: "transient", code: err instanceof Error ? err.name : "error", message };
}

const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_MAX_SECONDS = 3_600;

/** Retry-After is the floor; consecutive failures back off exponentially (1m, 2m, 4m ... 1h). */
export function backoffSeconds(failure: LaneFailure, consecutiveFailures: number): number {
  const exp = Math.min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.min(Math.max(consecutiveFailures - 1, 0), 6));
  if (failure.kind === "auth_blocked") return Math.max(exp, 15 * 60);
  return Math.min(BACKOFF_MAX_SECONDS, Math.max(failure.retryAfterSeconds ?? 0, exp));
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/**
 * One Google account's API client. Cooldowns are keyed by `<service>:<quotaUser>`
 * (the account + upstream credential identity, never the tenant), so a 429 for one
 * mailbox does not stall the others; the donor's service-wide cooldown is honoured too.
 */
export class LaneGoogleClient {
  readonly cooldownKey: string;

  constructor(
    readonly credential: GoogleApiCredential,
    readonly service: string,
  ) {
    this.cooldownKey = `${service}:${credential.quotaUser}`;
  }

  get account(): string {
    return this.credential.account;
  }

  get mode(): GoogleApiCredential["mode"] {
    return this.credential.mode;
  }

  async json<T>(url: URL, init: RequestInit = {}): Promise<T> {
    throwIfGoogleRateLimited(this.service);
    throwIfGoogleRateLimited(this.cooldownKey);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const res = await fetchGoogleApi(this.credential, url.toString(), { ...init, headers });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 500) };
      }
    }
    if (!res.ok) {
      const rateLimit = googleRateLimitErrorFromResponse(this.cooldownKey, res, data);
      if (rateLimit) throw rateLimit;
      const message = googleErrorMessageFromPayload(data) ?? `${res.status} ${res.statusText}`;
      throw new LaneGoogleApiError(`${this.service} request failed (${res.status}): ${message}`, res.status, googleErrorReasonFromPayload(data));
    }
    return (data ?? {}) as T;
  }
}

export async function laneClient(
  tenantId: string,
  account: string,
  scopes: readonly string[],
  service: string,
): Promise<LaneGoogleClient> {
  return new LaneGoogleClient(await getGoogleApiCredential(tenantId, account, scopes), service);
}

// ---------------------------------------------------------------------------
// Roster: connected accounts plus (DWD tenants) the Workspace directory
// ---------------------------------------------------------------------------

const DIRECTORY_API = "https://admin.googleapis.com/admin/directory/v1";
const DIRECTORY_CACHE_TTL_MS = positiveIntegerEnv("GOOGLE_CALENDAR_DIRECTORY_CACHE_TTL_SECONDS", 3_600) * 1000;
export const MAX_ROSTER_MAILBOXES = positiveIntegerEnv("GOOGLE_SOURCE_LANE_MAX_MAILBOXES", 500);
const directoryCache = new Map<string, { users: string[]; truncated: boolean; expiresAt: number }>();

export function clearGoogleLaneDirectoryCacheForTests(): void {
  directoryCache.clear();
}

export type DirectoryState = "listed" | "truncated" | "unavailable" | "error";

export interface GoogleRoster {
  mailboxes: string[];
  directory: DirectoryState;
  directoryError?: string;
  /** Directory admin used for the listing (DWD tenants only). */
  adminEmail?: string;
}

/**
 * Mailboxes the lane should sync for a tenant: every active Google connection
 * (OAuth and DWD mailboxes, mailboxes.ts) plus, for a tenant connected through
 * domain-wide delegation, every active Workspace directory user (each still has
 * to pass the DWD allowlist when its credential is resolved). OAuth-only tenants
 * have no directory; the roster is then exactly their connected accounts and the
 * tenant-wide scope is reported blocked, never complete.
 */
export async function resolveGoogleRoster(
  tenantId: string,
  opts: { explicit?: string[] | null; forceRefresh?: boolean } = {},
): Promise<GoogleRoster> {
  const explicit = normalizeEmails(opts.explicit);
  if (explicit.length > 0) return { mailboxes: explicit, directory: "unavailable" };

  const connected = await listGoogleMailboxes(tenantId);
  const metadata = (await getTokenMetadata(tenantId, "google")) ?? {};
  const usesDelegation = metadata.delegation === true || metadata.authMode === "domain_wide_delegation";
  const adminEmail = typeof metadata.email === "string" && metadata.email.trim() ? metadata.email.trim().toLowerCase() : null;
  if (!usesDelegation || !adminEmail || !isDelegationConfigured()) {
    return { mailboxes: capRoster(connected), directory: "unavailable" };
  }
  try {
    const listing = await listDirectoryUsers(tenantId, adminEmail, opts.forceRefresh === true);
    const union = normalizeEmails([...connected, ...listing.users]);
    return {
      mailboxes: capRoster(union),
      directory: listing.truncated || union.length > MAX_ROSTER_MAILBOXES ? "truncated" : "listed",
      adminEmail,
    };
  } catch (err) {
    return { mailboxes: capRoster(connected), directory: "error", directoryError: errorText(err), adminEmail };
  }
}

async function listDirectoryUsers(tenantId: string, adminEmail: string, forceRefresh: boolean): Promise<{ users: string[]; truncated: boolean }> {
  const cached = directoryCache.get(tenantId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached;
  const client = await laneClient(tenantId, adminEmail, GOOGLE_WORKSPACE_DIRECTORY_DELEGATION_SCOPES, "google-directory");
  const users = new Set<string>();
  let truncated = false;
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DIRECTORY_API}/users`);
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("projection", "basic");
    url.searchParams.set("orderBy", "email");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await client.json<{ users?: Array<{ primaryEmail?: string; suspended?: boolean; archived?: boolean }>; nextPageToken?: string }>(url);
    for (const user of data.users ?? []) {
      const email = user.primaryEmail?.trim().toLowerCase();
      if (!email || user.suspended || user.archived) continue;
      if (users.size >= MAX_ROSTER_MAILBOXES) {
        truncated = true;
        break;
      }
      users.add(email);
    }
    pageToken = truncated ? undefined : data.nextPageToken;
  } while (pageToken);
  if (users.size === 0) throw new Error("Google Workspace Directory returned zero active users.");
  const entry = { users: [...users].sort(), truncated, expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS };
  directoryCache.set(tenantId, entry);
  return entry;
}

function capRoster(mailboxes: string[]): string[] {
  return normalizeEmails(mailboxes).slice(0, MAX_ROSTER_MAILBOXES);
}

export function normalizeEmails(value: readonly string[] | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// Per-mailbox status rows (mailbox '*' = tenant roster)
// ---------------------------------------------------------------------------

export type LaneName = "calendar" | "contacts";
export type MailboxState = "pending" | "ok" | "partial" | "blocked" | "rate_limited" | "error";

export interface MailboxStatusRow {
  tenant_id: string;
  lane: LaneName;
  mailbox: string;
  auth_mode: string | null;
  state: MailboxState;
  reason: string | null;
  last_error: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  last_success_at: string | null;
  last_attempt_at: string | null;
  consecutive_failures: number;
  next_attempt_at: string | null;
  counts: Record<string, number> | null;
}

export async function loadMailboxStatus(tenantId: string, lane: LaneName, mailbox: string, executor: Executor = db): Promise<MailboxStatusRow | null> {
  const [row] = await queryRows<MailboxStatusRow>(sql`
    SELECT * FROM google_source_mailbox_status WHERE tenant_id = ${tenantId} AND lane = ${lane} AND mailbox = ${mailbox}
  `, executor);
  return row ?? null;
}

export async function listMailboxStatus(tenantId: string, lane: LaneName, executor: Executor = db): Promise<MailboxStatusRow[]> {
  return queryRows<MailboxStatusRow>(sql`
    SELECT * FROM google_source_mailbox_status WHERE tenant_id = ${tenantId} AND lane = ${lane} ORDER BY mailbox
  `, executor);
}

export async function recordMailboxSuccess(
  tenantId: string,
  lane: LaneName,
  mailbox: string,
  input: { state: "ok" | "partial"; reason?: string | null; authMode?: string | null; counts?: Record<string, number> },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO google_source_mailbox_status (tenant_id, lane, mailbox, auth_mode, state, reason, last_success_at, last_attempt_at, consecutive_failures, next_attempt_at, counts, updated_at)
    VALUES (${tenantId}, ${lane}, ${mailbox}, ${input.authMode ?? null}, ${input.state}, ${input.reason ?? null}, now(), now(), 0, NULL, ${JSON.stringify(input.counts ?? {})}::jsonb, now())
    ON CONFLICT (tenant_id, lane, mailbox) DO UPDATE SET
      auth_mode = COALESCE(EXCLUDED.auth_mode, google_source_mailbox_status.auth_mode),
      state = EXCLUDED.state, reason = EXCLUDED.reason, last_success_at = now(), last_attempt_at = now(),
      consecutive_failures = 0, next_attempt_at = NULL, counts = EXCLUDED.counts, updated_at = now()
  `);
}

/** Records a failure and returns the persisted next attempt time. */
export async function recordMailboxFailure(
  tenantId: string,
  lane: LaneName,
  mailbox: string,
  failure: LaneFailure,
  input: { authMode?: string | null } = {},
): Promise<Date> {
  const previous = await loadMailboxStatus(tenantId, lane, mailbox);
  const failures = (previous?.consecutive_failures ?? 0) + 1;
  const nextAttempt = new Date(Date.now() + backoffSeconds(failure, failures) * 1000);
  const state: MailboxState = failure.kind === "auth_blocked" ? "blocked" : failure.kind === "rate_limited" ? "rate_limited" : "error";
  await db.execute(sql`
    INSERT INTO google_source_mailbox_status (tenant_id, lane, mailbox, auth_mode, state, reason, last_error, last_error_code, last_error_at, last_attempt_at, consecutive_failures, next_attempt_at, updated_at)
    VALUES (${tenantId}, ${lane}, ${mailbox}, ${input.authMode ?? null}, ${state}, ${failure.code}, ${truncate(failure.message)}, ${failure.code}, now(), now(), ${failures}, ${nextAttempt.toISOString()}, now())
    ON CONFLICT (tenant_id, lane, mailbox) DO UPDATE SET
      auth_mode = COALESCE(EXCLUDED.auth_mode, google_source_mailbox_status.auth_mode),
      state = EXCLUDED.state, reason = EXCLUDED.reason, last_error = EXCLUDED.last_error, last_error_code = EXCLUDED.last_error_code,
      last_error_at = now(), last_attempt_at = now(), consecutive_failures = EXCLUDED.consecutive_failures,
      next_attempt_at = EXCLUDED.next_attempt_at, updated_at = now()
  `);
  return nextAttempt;
}

export async function recordRosterStatus(tenantId: string, lane: LaneName, roster: GoogleRoster): Promise<void> {
  const state: MailboxState = roster.directory === "listed" ? "ok" : roster.directory === "error" ? "error" : roster.directory === "truncated" ? "partial" : "blocked";
  const reason = roster.directory === "unavailable"
    ? "no Workspace directory access (OAuth-only or no DWD admin); roster = connected Google accounts"
    : roster.directory === "truncated" ? `roster capped at ${MAX_ROSTER_MAILBOXES} mailboxes` : roster.directory === "error" ? "directory listing failed; roster = connected Google accounts" : null;
  await db.execute(sql`
    INSERT INTO google_source_mailbox_status (tenant_id, lane, mailbox, state, reason, last_error, last_error_at, last_success_at, last_attempt_at, counts, updated_at)
    VALUES (${tenantId}, ${lane}, '*', ${state}, ${reason}, ${roster.directoryError ? truncate(roster.directoryError) : null},
            ${roster.directoryError ? new Date().toISOString() : null}, ${roster.directory === "error" ? null : new Date().toISOString()}, now(),
            ${JSON.stringify({ mailboxes: roster.mailboxes.length })}::jsonb, now())
    ON CONFLICT (tenant_id, lane, mailbox) DO UPDATE SET
      state = EXCLUDED.state, reason = EXCLUDED.reason,
      last_error = COALESCE(EXCLUDED.last_error, google_source_mailbox_status.last_error),
      last_error_at = COALESCE(EXCLUDED.last_error_at, google_source_mailbox_status.last_error_at),
      last_success_at = COALESCE(EXCLUDED.last_success_at, google_source_mailbox_status.last_success_at),
      last_attempt_at = now(), counts = EXCLUDED.counts, updated_at = now()
  `);
}

// ---------------------------------------------------------------------------
// Cursor leases (one runner per cursor; webhook-triggered polls carry no group key)
// ---------------------------------------------------------------------------

const LEASE_SECONDS = 15 * 60;

export function newLeaseOwner(): string {
  return `lane-${randomUUID()}`;
}

/** Conditional claim; true when this owner now holds the cursor row's lease. */
export async function claimLease(table: "google_calendar_lane_cursors" | "google_contact_lane_cursors", id: string, owner: string): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(sql`
    UPDATE ${sql.identifier(table)}
    SET lease_owner = ${owner}, lease_until = now() + ${`${LEASE_SECONDS} seconds`}::interval
    WHERE id = ${id} AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until < now() OR lease_owner = ${owner})
    RETURNING id
  `);
  return rows.length === 1;
}

export async function releaseLease(table: "google_calendar_lane_cursors" | "google_contact_lane_cursors", id: string, owner: string): Promise<void> {
  await db.execute(sql`
    UPDATE ${sql.identifier(table)} SET lease_owner = NULL, lease_until = NULL WHERE id = ${id} AND lease_owner = ${owner}
  `);
}

// ---------------------------------------------------------------------------

export function errorText(err: unknown): string {
  return truncate(err instanceof Error ? err.message : String(err));
}

function truncate(value: string, max = 1_000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Full-listing membership (resumable multi-run passes; no clock comparisons)
// ---------------------------------------------------------------------------

export async function markListed(cursorId: string, keys: readonly string[], executor: Executor = db): Promise<void> {
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    await executor.execute(sql`
      INSERT INTO google_lane_full_listing_seen (cursor_id, item_key)
      VALUES ${sql.join(chunk.map((k) => sql`(${cursorId}::uuid, ${k})`), sql`, `)}
      ON CONFLICT DO NOTHING
    `);
  }
}

export async function clearListed(cursorId: string, executor: Executor = db): Promise<void> {
  await executor.execute(sql`DELETE FROM google_lane_full_listing_seen WHERE cursor_id = ${cursorId}::uuid`);
}
