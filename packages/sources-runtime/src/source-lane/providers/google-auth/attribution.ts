import { sql } from "drizzle-orm";
import type { DbExecutor } from "../../core/types.js";
import { encodeSegment } from "../../export/mapping.js";
import { binaryBase } from "../binary/index.js";
import { googleAccountOwners } from "./index.js";

/**
 * Owner-only attribution of Google data whose $SOURCES path names no mailbox: Docs/Sheets/Slides/Drive file
 * directories (`google-docs/<slug>-doc-<hash>`, `google-docs/_drive/<class>/<slug>-<hash>`), their comment raw
 * ledger (`google-docs/_raw/document:<fileId>`) and Drive PDFs (`binary/drive-pdf/<fileId>`).
 *
 * Answered for one verified yc_msaw principal (forwarded over the service-token internal API, never a publisher's
 * report): the Google addresses that principal owns (newest grant or ownership proof, googleAccountOwners), and
 * every unit one of those mailboxes currently sees in Drive (gdocs_file_visibility, written per mailbox by the
 * changes feed and the full inventory). `revisions` is true when one of them may read the file's revisions
 * (Drive `capabilities.canReadRevisions`): only then do revision history, OT changelog, comments and older byte
 * versions belong to this owner too. Units seen only without that capability are listed with `revisions:false`;
 * a consumer that serves only full units must withhold them and report them as withheld, not complete.
 * Anything not listed (another member's files, legacy files no roster mailbox sees, data of unproven mailboxes)
 * is not this principal's.
 */
export const GOOGLE_ATTRIBUTION_SCHEMA = "procmem.google-attribution/v1";
const DEFAULT_MAX_UNITS = 50_000;

export interface GoogleAttributionUnit {
  /** $SOURCES-relative directory (no leading `sources/`); the unit is this directory and everything below it. */
  path: string;
  /** The caller's mailboxes that see the file. */
  accounts: string[];
  revisions: boolean;
}

export interface GoogleAttribution {
  schema: typeof GOOGLE_ATTRIBUTION_SCHEMA;
  accounts: string[];
  units: GoogleAttributionUnit[];
  /** More units exist than were returned (fail closed: unlisted units stay unreadable). */
  truncated: boolean;
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] } | null)?.rows ?? []));
const rel = (p: string) => p.replace(/^sources\//, "");

export async function googleAttributionFor(
  tenantId: string,
  who: { subject: string; issuer: string },
  executor: DbExecutor,
  opts: { maxUnits?: number } = {},
): Promise<GoogleAttribution> {
  const accounts = (await googleAccountOwners(tenantId, executor))
    .filter((a) => a.subject === who.subject && a.issuer === who.issuer)
    .map((a) => a.account.trim().toLowerCase())
    .sort();
  if (!accounts.length) return { schema: GOOGLE_ATTRIBUTION_SCHEMA, accounts, units: [], truncated: false };
  const max = Math.max(1, opts.maxUnits ?? DEFAULT_MAX_UNITS);
  const list = sql.join(accounts.map((a) => sql`${a}`), sql`, `);
  const rows = rowsOf<{ file_id: string; export_directory: string | null; is_pdf: boolean; accounts: string[] | string; revisions: boolean }>(
    await executor.execute(sql`
      SELECT v.file_id, c.export_directory, (d.id IS NOT NULL) AS is_pdf,
             array_agg(DISTINCT v.mailbox ORDER BY v.mailbox) AS accounts,
             bool_or(COALESCE(v.can_read_revisions, false)) AS revisions
      FROM gdocs_file_visibility v
      LEFT JOIN gdocs_file_checkpoints c ON c.tenant_id = v.tenant_id AND c.file_id = v.file_id
      LEFT JOIN binary_documents d ON d.tenant_id = v.tenant_id AND d.provider = 'drive-pdf' AND d.external_id = v.file_id
      WHERE v.tenant_id = ${tenantId} AND v.visible AND v.mailbox IN (${list})
        AND (c.export_directory IS NOT NULL OR d.id IS NOT NULL)
      GROUP BY v.file_id, c.export_directory, d.id
      ORDER BY v.file_id
      LIMIT ${max + 1}
    `),
  );
  const truncated = rows.length > max;
  const units: GoogleAttributionUnit[] = [];
  for (const r of rows.slice(0, max)) {
    const unitAccounts = typeof r.accounts === "string" ? r.accounts.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : r.accounts;
    const revisions = r.revisions === true;
    if (r.export_directory) units.push({ path: rel(r.export_directory), accounts: unitAccounts, revisions });
    if (r.export_directory) units.push({ path: `google-docs/_raw/${encodeSegment(`document:${r.file_id}`)}`, accounts: unitAccounts, revisions });
    if (r.is_pdf) units.push({ path: rel(binaryBase("drive-pdf", r.file_id)), accounts: unitAccounts, revisions });
  }
  return { schema: GOOGLE_ATTRIBUTION_SCHEMA, accounts, units, truncated };
}
