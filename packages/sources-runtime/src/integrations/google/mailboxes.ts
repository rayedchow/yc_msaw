import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { getTokenMetadata } from "../../vault/tokens.js";

/**
 * Multi-mailbox Google sync roster + per-mailbox cursors.
 *
 * The roster of delegated mailboxes for a tenant is the set of active
 * `connections` rows for provider 'google' (external_account_id = email) —
 * connecting a mailbox IS adding it to the roster. Legacy tenants whose only
 * mailbox predates connection rows fall back to the token metadata email.
 *
 * Cursors (gmail historyId, Drive changes token, poll watermarks) live in
 * google_mailbox_sync_state, one row per (tenant, mailbox), with per-column
 * updates so the gmail and gdocs pollers never clobber each other. The first
 * read for the legacy admin mailbox seeds its row from the old single-mailbox
 * fields on integration_tokens metadata, so existing cursors carry over.
 */

export interface GoogleMailboxState {
  historyId: string | null;
  lastBackfillAt: number | null;
  drivePageToken: string | null;
  lastEditPollAt: string | null;
  lastCommentPollAt: string | null;
  lastDocsBackfillAt: number | null;
}

export type GoogleMailboxStatePatch = Partial<GoogleMailboxState>;

type Executor = Pick<typeof db, "execute">;

export async function listGoogleMailboxes(tenantId: string, executor: Executor = db): Promise<string[]> {
  const rows = rowsFromExecute<{ email: string }>(await executor.execute(sql`
    SELECT lower(external_account_id) AS email
    FROM connections
    WHERE tenant_id = ${tenantId} AND provider = 'google' AND status = 'active'
      AND external_account_id IS NOT NULL AND external_account_id <> ''
    ORDER BY external_account_id
  `));
  const mailboxes = [...new Set(rows.map((row) => row.email))];
  if (mailboxes.length > 0) return mailboxes;
  const legacy = await legacyAdminEmail(tenantId);
  if (!legacy) return [];
  // The legacy fallback is for mailboxes that predate connection rows. A mailbox
  // with an explicit (revoked/error/paused) connection row stays out of the roster.
  const explicit = rowsFromExecute<{ n: number | string }>(await executor.execute(sql`
    SELECT count(*)::int AS n FROM connections
    WHERE tenant_id = ${tenantId} AND provider = 'google' AND lower(COALESCE(external_account_id, '')) = ${legacy}
  `));
  return Number(explicit[0]?.n ?? 0) > 0 ? [] : [legacy];
}

export type GoogleMailboxAuthMode = "domain_wide_delegation" | "oauth_direct" | "composio_proxy";

export interface GoogleMailboxAccount {
  email: string;
  authMode: GoogleMailboxAuthMode;
  status: string;
}

/**
 * Roster with each mailbox's connection mode (all statuses, for coverage and
 * setup status). Mode comes from the OAuth grant when one exists, otherwise the
 * connection is a domain-wide-delegation mailbox. Pollers keep using
 * listGoogleMailboxes (active only).
 */
export async function listGoogleMailboxAccounts(tenantId: string, executor: Executor = db): Promise<GoogleMailboxAccount[]> {
  const rows = rowsFromExecute<{ email: string; status: string; grant_mode: string | null }>(await executor.execute(sql`
    SELECT lower(c.external_account_id) AS email, c.status, g.mode AS grant_mode
    FROM connections c
    LEFT JOIN google_oauth_grants g
      ON g.tenant_id = c.tenant_id AND g.account_email = lower(c.external_account_id)
    WHERE c.tenant_id = ${tenantId} AND c.provider = 'google'
      AND c.external_account_id IS NOT NULL AND c.external_account_id <> ''
    ORDER BY lower(c.external_account_id)
  `));
  return rows.map((row) => ({
    email: row.email,
    status: row.status,
    authMode: row.grant_mode === "oauth_direct" || row.grant_mode === "composio_proxy" ? row.grant_mode : "domain_wide_delegation",
  }));
}

export async function getGoogleMailboxState(
  tenantId: string,
  email: string,
  executor: Executor = db,
): Promise<GoogleMailboxState> {
  const mailbox = email.trim().toLowerCase();
  const rows = rowsFromExecute<Record<string, unknown>>(await executor.execute(sql`
    SELECT history_id, last_backfill_at, drive_page_token, last_edit_poll_at, last_comment_poll_at, last_docs_backfill_at
    FROM google_mailbox_sync_state
    WHERE tenant_id = ${tenantId} AND email = ${mailbox}
  `));
  if (rows[0]) return stateFromRow(rows[0]);

  // First touch for the legacy admin mailbox: carry the single-mailbox
  // cursors over from integration_tokens metadata so history is not re-read.
  const legacy = await legacyAdminEmail(tenantId);
  if (legacy === mailbox) {
    const metadata = (await getTokenMetadata(tenantId, "google")) ?? {};
    const seeded: GoogleMailboxStatePatch = {
      historyId: stringOrNull(metadata.historyId),
      lastBackfillAt: numberOrNull(metadata.lastBackfillAt),
      drivePageToken: stringOrNull(metadata.drivePageToken),
      lastEditPollAt: stringOrNull(metadata.lastEditPollAt),
      lastCommentPollAt: stringOrNull(metadata.lastCommentPollAt),
      lastDocsBackfillAt: numberOrNull(metadata.lastDocsBackfillAt),
    };
    await updateGoogleMailboxState(tenantId, mailbox, seeded, executor);
    return { ...EMPTY_STATE, ...seeded } as GoogleMailboxState;
  }
  return { ...EMPTY_STATE };
}

export async function updateGoogleMailboxState(
  tenantId: string,
  email: string,
  patch: GoogleMailboxStatePatch,
  executor: Executor = db,
): Promise<void> {
  const mailbox = email.trim().toLowerCase();
  const assignments = [];
  if ("historyId" in patch) assignments.push(sql`history_id = ${patch.historyId ?? null}`);
  if ("lastBackfillAt" in patch) assignments.push(sql`last_backfill_at = ${patch.lastBackfillAt ?? null}`);
  if ("drivePageToken" in patch) assignments.push(sql`drive_page_token = ${patch.drivePageToken ?? null}`);
  if ("lastEditPollAt" in patch) assignments.push(sql`last_edit_poll_at = ${patch.lastEditPollAt ?? null}`);
  if ("lastCommentPollAt" in patch) assignments.push(sql`last_comment_poll_at = ${patch.lastCommentPollAt ?? null}`);
  if ("lastDocsBackfillAt" in patch) assignments.push(sql`last_docs_backfill_at = ${patch.lastDocsBackfillAt ?? null}`);
  if (assignments.length === 0) return;
  await executor.execute(sql`
    INSERT INTO google_mailbox_sync_state (tenant_id, email, history_id, last_backfill_at, drive_page_token, last_edit_poll_at, last_comment_poll_at, last_docs_backfill_at)
    VALUES (${tenantId}, ${mailbox}, ${patch.historyId ?? null}, ${patch.lastBackfillAt ?? null}, ${patch.drivePageToken ?? null}, ${patch.lastEditPollAt ?? null}, ${patch.lastCommentPollAt ?? null}, ${patch.lastDocsBackfillAt ?? null})
    ON CONFLICT (tenant_id, email) DO UPDATE SET ${sql.join(assignments, sql`, `)}, updated_at = now()
  `);
}

async function legacyAdminEmail(tenantId: string): Promise<string | null> {
  const metadata = (await getTokenMetadata(tenantId, "google")) ?? {};
  const email = stringOrNull(metadata.email);
  return email ? email.trim().toLowerCase() : null;
}

const EMPTY_STATE: GoogleMailboxState = {
  historyId: null,
  lastBackfillAt: null,
  drivePageToken: null,
  lastEditPollAt: null,
  lastCommentPollAt: null,
  lastDocsBackfillAt: null,
};

function stateFromRow(row: Record<string, unknown>): GoogleMailboxState {
  return {
    historyId: stringOrNull(row.history_id),
    lastBackfillAt: numberOrNull(row.last_backfill_at),
    drivePageToken: stringOrNull(row.drive_page_token),
    lastEditPollAt: stringOrNull(row.last_edit_poll_at),
    lastCommentPollAt: stringOrNull(row.last_comment_poll_at),
    lastDocsBackfillAt: numberOrNull(row.last_docs_backfill_at),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return result && typeof result === "object" && "rows" in result
    ? (result as { rows: T[] }).rows
    : [];
}
