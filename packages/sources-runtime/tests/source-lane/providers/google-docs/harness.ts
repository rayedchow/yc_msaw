/**
 * Test harness: an in-process PostgreSQL (PGlite) with the real source-lane
 * migration plan applied (donor source migrations + core 9000/9001 + this
 * provider's 9100), exposed as a drizzle database so the production donor
 * jobs and provider modules run real SQL. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { MIGRATIONS_DIR, planMigrations } from "../../../../src/source-lane/core/migrations.js";
import { rowsOf } from "../../../../src/source-lane/providers/google-docs/store.js";

export const pg = new PGlite();
export const db = drizzle(pg);

export const ready: Promise<void> = (async () => {
  for (const file of planMigrations().apply) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
})();

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

export async function resetTenant(tenantId: string): Promise<void> {
  for (const table of [
    "gdocs_source_file_versions", "gdocs_source_file_heads", "gdocs_source_blobs", "gdocs_source_chunks", "gdocs_file_checkpoints",
  ]) {
    await pg.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
  for (const table of ["activity_events", "mirror_files", "google_doc_tab_snapshots", "google_doc_images", "google_doc_suggestions"]) {
    await pg.query(`DELETE FROM ${table} WHERE user_id = $1`, [tenantId]);
  }
  await pg.query(`DELETE FROM source_lane_journal WHERE tenant_id = $1`, [tenantId]);
  for (const table of ["gdocs_drive_inventory", "gdocs_file_visibility"]) {
    await pg.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
}

export interface HeadRow { path: string; seq: number; op: string; sha256: string | null }

export async function heads(tenantId: string, prefix = ""): Promise<HeadRow[]> {
  return query<HeadRow>(
    `SELECT path, seq, op, sha256 FROM gdocs_source_file_heads WHERE tenant_id = $1 AND path LIKE $2 ORDER BY path`,
    [tenantId, `${prefix}%`],
  );
}

export async function liveFile(tenantId: string, path: string): Promise<{ bytes: Buffer; contentType: string; seq: number; kind: string } | null> {
  const [row] = await query<{ chunks: string[]; content_type: string; seq: number; kind: string; op: string }>(
    `SELECT v.chunks, v.content_type, v.seq, v.kind, v.op FROM gdocs_source_file_heads h
     JOIN gdocs_source_file_versions v ON v.tenant_id = h.tenant_id AND v.path = h.path AND v.seq = h.seq
     WHERE h.tenant_id = $1 AND h.path = $2`,
    [tenantId, path],
  );
  if (!row || row.op !== "put") return null;
  const parts: Buffer[] = [];
  for (const chunk of row.chunks) {
    const [c] = await query<{ bytes: Uint8Array }>(`SELECT bytes FROM gdocs_source_chunks WHERE tenant_id = $1 AND chunk_sha256 = $2`, [tenantId, chunk]);
    parts.push(Buffer.from(c.bytes));
  }
  return { bytes: Buffer.concat(parts), contentType: row.content_type, seq: row.seq, kind: row.kind };
}

export async function liveJson<T = Record<string, unknown>>(tenantId: string, path: string): Promise<T> {
  const file = await liveFile(tenantId, path);
  if (!file) throw new Error(`no live file at ${path}`);
  return JSON.parse(file.bytes.toString("utf8")) as T;
}

export async function versionCount(tenantId: string, path?: string): Promise<number> {
  const rows = rowsOf<{ n: number }>(await db.execute(path
    ? sql`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = ${tenantId} AND path = ${path}`
    : sql`SELECT count(*)::int AS n FROM gdocs_source_file_versions WHERE tenant_id = ${tenantId}`));
  return rows[0]?.n ?? 0;
}

/** Everything ever stored for a tenant, as text (for "never persisted" assertions). */
export async function allStoredText(tenantId: string): Promise<string> {
  const chunks = await query<{ bytes: Uint8Array }>(`SELECT bytes FROM gdocs_source_chunks WHERE tenant_id = $1`, [tenantId]);
  const versions = await query<{ provenance: unknown; path: string }>(`SELECT provenance, path FROM gdocs_source_file_versions WHERE tenant_id = $1`, [tenantId]);
  const checkpoints = await query(`SELECT * FROM gdocs_file_checkpoints WHERE tenant_id = $1`, [tenantId]);
  return [
    ...chunks.map((c) => Buffer.from(c.bytes).toString("latin1")),
    JSON.stringify(versions),
    JSON.stringify(checkpoints),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fake Google HTTP
// ---------------------------------------------------------------------------

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

export function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, headers: new Headers(init?.headers) });
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: { message: `no fake route for ${url.href}` } }), { status: 599 });
  };
  return { impl, calls };
}

export function xssi(body: unknown, status = 200): Response {
  return new Response(`)]}'\n${JSON.stringify(body)}`, { status, headers: { "content-type": "application/json" } });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** One raw 9-element changelog tuple, exactly as /revisions/load returns it. */
export function entry(op: unknown, ms: number, userId: string, revision: number, session = "s-raw"): unknown[] {
  return [op, ms, userId, revision, session, revision, null, null, false];
}
