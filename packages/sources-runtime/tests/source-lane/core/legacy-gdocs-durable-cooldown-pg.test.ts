import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Legacy donor Google Docs tasks (gdocs.poll, discovery, comment-sweep/refresh, actor-repair, suggestion-sync,
 * content-snapshot) call Google through gFetch / fetchDocContent. A Retry-After floor one process receives must hold
 * a restarted process and a second worker too (migration 10550). Each "worker" here is a separate Node process with
 * fresh memory running the real gFetch / fetchDocContent against a throwaway database on the fixture PostgreSQL
 * (SOURCES_TEST_PG_URL); Google is a local fake that counts every request it receives. Synthetic tokens only.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
const run = promisify(execFile);
const WORKER = fileURLToPath(new URL("../providers/google-docs/fixtures/legacy-gdocs-worker.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const DRIVE = "https://www.googleapis.com/drive/v3/changes?pageToken=1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let adminSql: Any;
let sql: Any;
let dbName: string;
let dbUrl: string;
let server: Server;
let origin: string;
let requests: Array<{ path: string; token: string }>;
let respond: (path: string, token: string) => { status: number; headers?: Record<string, string>; body: unknown };

type Result = { ok: boolean; status?: number; title?: string; name?: string; service?: string; reason?: string; retryAfterSeconds?: number; message?: string };

async function worker(calls: unknown[]): Promise<Result[]> {
  const { stdout } = await run(TSX, [WORKER, JSON.stringify(calls)], {
    env: { ...process.env, DATABASE_URL: dbUrl, GOOGLE_FAKE_ORIGIN: origin },
    timeout: 60_000,
  });
  return JSON.parse(stdout.trim().split("\n").pop()!) as Result[];
}

const sent = (token: string) => requests.filter((r) => r.token === token).length;
const limit = (status: number, reason: string, retryAfter: string) => ({
  status,
  headers: { "retry-after": retryAfter },
  body: { error: { code: status, message: "Rate Limit Exceeded", errors: [{ reason }] } },
});
const ok = { status: 200, body: { changes: [], newStartPageToken: "2", documentId: "doc-1", title: "Plan", tabs: [] } };

describe.skipIf(!PG)("legacy Google Docs tasks keep Google's Retry-After floor across processes (real PostgreSQL)", () => {
  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    dbName = `gdocs_cooldown_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    dbUrl = url.href;
    sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
    const { applySourceLaneMigrations } = await import("../../../src/source-lane/core/migrations.js");
    await applySourceLaneMigrations(sql);
    server = createServer((req, res) => {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const path = new URL(req.url!, "http://x").pathname;
      requests.push({ path, token });
      const r = respond(path, token);
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(JSON.stringify(r.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await sql?.end({ timeout: 5 });
    if (adminSql && dbName) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    requests = [];
    respond = () => ok;
    await sql`DELETE FROM google_rate_limit_cooldowns`;
  });

  it("a project-wide 429 (2 h) in one process holds a restarted process and a second worker for every credential", async () => {
    respond = (_p, token) => (token === "tok-a" ? limit(429, "rateLimitExceeded", "7200") : ok);
    const [first] = await worker([{ kind: "gfetch", url: DRIVE, token: "tok-a" }]);
    expect(first).toMatchObject({ ok: false, name: "GoogleRateLimitError", service: "google-workspace", retryAfterSeconds: 7200 });
    const [row] = await sql`SELECT service_key, extract(epoch FROM blocked_until - now()) AS s FROM google_rate_limit_cooldowns`;
    expect(row.service_key).toBe("google-workspace");
    expect(Number(row.s)).toBeGreaterThan(7100);

    // Restart (fresh memory) and a concurrent second worker: neither sends a request inside the floor.
    respond = () => ok;
    const [restarted, second] = await Promise.all([
      worker([{ kind: "gfetch", url: DRIVE, token: "tok-a" }, { kind: "gfetch", url: DRIVE, token: "tok-b" }]),
      worker([{ kind: "gfetch", url: DRIVE, token: "tok-b" }]),
    ]);
    for (const r of [...restarted, ...second]) expect(r).toMatchObject({ ok: false, reason: "cooldown", service: "google-workspace" });
    expect(restarted[0]!.retryAfterSeconds).toBeGreaterThan(7100);
    expect(requests).toHaveLength(1);
  });

  it("a per-user 403 holds only that credential in other processes; the floor releases at Retry-After, not before", async () => {
    respond = (_p, token) => (token === "tok-c" ? limit(403, "userRateLimitExceeded", "3") : ok);
    const [first] = await worker([{ kind: "gfetch", url: DRIVE, token: "tok-c" }]);
    expect(first).toMatchObject({ ok: false, name: "GoogleRateLimitError", retryAfterSeconds: 3 });
    expect(first!.service).toMatch(/^google-workspace:cred:[0-9a-f]{16}$/);
    const limitedAt = Date.now();

    respond = () => ok;
    const [held, other] = await worker([{ kind: "gfetch", url: DRIVE, token: "tok-c" }, { kind: "gfetch", url: DRIVE, token: "tok-d" }]);
    expect(held).toMatchObject({ ok: false, reason: "cooldown", service: first!.service });
    expect(other).toMatchObject({ ok: true, status: 200 });
    expect(sent("tok-c")).toBe(1);
    expect(sent("tok-d")).toBe(1);

    await new Promise((r) => setTimeout(r, Math.max(0, limitedAt + 3_300 - Date.now())));
    const [released] = await worker([{ kind: "gfetch", url: DRIVE, token: "tok-c" }]);
    expect(released).toMatchObject({ ok: true, status: 200 });
    expect(sent("tok-c")).toBe(2);
  }, 60_000);

  it("documents.get (content-snapshot) keeps its floor across processes and sends no preview request inside a 403 rate limit", async () => {
    respond = () => limit(403, "rateLimitExceeded", "600");
    const [first] = await worker([{ kind: "content", docId: "doc-1", token: "tok-e" }]);
    expect(first).toMatchObject({ ok: false, name: "GoogleRateLimitError", service: "google-docs-api", retryAfterSeconds: 600 });
    expect(sent("tok-e")).toBe(1);

    respond = () => ok;
    const [held] = await worker([{ kind: "content", docId: "doc-1", token: "tok-f" }]);
    expect(held).toMatchObject({ ok: false, reason: "cooldown", service: "google-docs-api" });
    expect(sent("tok-f")).toBe(0);
  });

  it("a shorter later Retry-After never moves a recorded floor earlier", async () => {
    const { recordGoogleCooldownDurable } = await import("../../../src/source-lane/providers/google-docs/durable-cooldown.js");
    const { GoogleRateLimitError } = await import("../../../src/vault/google-rate-limit.js");
    const exec = { execute: (q: Any) => sql.unsafe(...toUnsafe(q)) };
    await recordGoogleCooldownDurable(new GoogleRateLimitError("google-workspace", 429, 3600), exec);
    await recordGoogleCooldownDurable(new GoogleRateLimitError("google-workspace", 429, 30), exec);
    const [row] = await sql`SELECT extract(epoch FROM blocked_until - now()) AS s, last_retry_after_seconds FROM google_rate_limit_cooldowns`;
    expect(Number(row.s)).toBeGreaterThan(3500);
    expect(Number(row.last_retry_after_seconds)).toBe(30);
  });
});

/** drizzle SQL -> [text, params] for postgres.js unsafe(). */
function toUnsafe(q: Any): [string, unknown[]] {
  const { sql: text, params } = new PgDialect().sqlToQuery(q);
  return [text, params];
}
