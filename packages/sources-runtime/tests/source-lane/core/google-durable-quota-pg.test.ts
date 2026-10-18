import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Durable Google Retry-After floors for the donor gdocs tasks, on real PostgreSQL, through the production worker.
 *
 * Every worker is a separate child process running the real entrypoint (src/source-lane/entrypoints/worker.ts: the
 * production queue loop and the registered gdocs/gmail handlers). Google is a local HTTP server; each child's fetch
 * to *.googleapis.com / docs.google.com is redirected to it (path, query, headers and body preserved), and the server
 * records every request. DWD tokens are minted per process (a fresh token after every restart), like Google does.
 * Elapsed time is simulated by moving recorded deadlines and queued run_at values back on the database clock, the clock
 * both the queue and the floors use. Synthetic data, own database.
 */
const PG = process.env.SOURCES_TEST_PG_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, "../../..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const TA = "tenant-a";
const TB = "tenant-b";
const ALICE = "alice@corp-a.example";
const BOB = "bob@corp-b.example";
// A second mailbox of tenant A: its own Google account, so its own per-user quota.
const CAROL = "carol@corp-a.example";
const DOC = "doc-plan";
const SHEET = "sheet-budget";
const DAY = 86_400;
const FOURTEEN_DAYS = 14 * DAY;

interface Call { host: string; path: string; query: URLSearchParams; sub: string | null; token: string | null; at: number }
type Rule = (call: Call) => { status: number; headers?: Record<string, string>; body: unknown } | null;

const calls: Call[] = [];
const mints: Array<{ sub: string; token: string }> = [];
const rules: Rule[] = [];
let mintCounter = 0;
let fake: Server;
let fakeUrl: string;
let tmp: string;
let preload: string;
let logDir: string;
let dbName: string;
let adminSql: Any;
let sql: Any;
const mods: Record<string, Any> = {};
const workers: Array<{ name: string; child: ChildProcess; out: string[] }> = [];
const realFetch = globalThis.fetch;

const googleApi = (c: Call) => c.host.endsWith(".googleapis.com") && c.host !== "oauth2.googleapis.com";
const docsFamily = (c: Call) => c.host === "www.googleapis.com" || c.host === "docs.googleapis.com" || c.host === "driveactivity.googleapis.com" || c.host === "people.googleapis.com";
const apiCalls = (sub: string, since: number, pred: (c: Call) => boolean = docsFamily) => calls.filter((c) => c.at >= since && c.sub === sub && pred(c));
const rateLimited = (reason: string, status: number, retryAfter: string, extra: Record<string, string> = {}) => ({
  status,
  headers: { "retry-after": retryAfter, ...extra },
  body: { error: { code: status, message: "Rate Limit Exceeded", errors: [{ domain: "usageLimits", reason, message: "Rate Limit Exceeded" }] } },
});

function docJson() {
  return {
    documentId: DOC, title: "Plan", revisionId: "rev-7",
    tabs: [{ tabProperties: { tabId: "t.0", title: "Main", index: 0 }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "Quarterly plan text\n" } }] } }] } } }],
  };
}

function answer(c: Call, body: string): { status: number; headers?: Record<string, string>; body: unknown } {
  if (c.host === "oauth2.googleapis.com" && c.path === "/token") {
    const form = new URLSearchParams(body);
    const sub = JSON.parse(Buffer.from(form.get("assertion")!.split(".")[1]!, "base64url").toString("utf8")).sub as string;
    const token = `ya29.dwd.${sub}.${++mintCounter}`;
    mints.push({ sub, token });
    return { status: 200, body: { access_token: token, expires_in: 3600 } };
  }
  for (const rule of rules) {
    const r = rule(c);
    if (r) return r;
  }
  if (c.host === "gmail.googleapis.com") {
    if (c.path.endsWith("/profile")) return { status: 200, body: { emailAddress: c.sub, historyId: "10", messagesTotal: 0 } };
    if (c.path.endsWith("/history")) return { status: 200, body: { history: [], historyId: "10" } };
    if (c.path.endsWith("/messages")) return { status: 200, body: { messages: [], resultSizeEstimate: 0 } };
    if (c.path.endsWith("/labels")) return { status: 200, body: { labels: [] } };
    return { status: 404, body: { error: { code: 404, message: "not found" } } };
  }
  if (c.host === "www.googleapis.com") {
    if (c.path === "/drive/v3/changes/startPageToken") return { status: 200, body: { startPageToken: "100" } };
    if (c.path === "/drive/v3/changes") return { status: 200, body: { changes: [], newStartPageToken: c.query.get("pageToken") ?? "100" } };
    if (c.path === "/drive/v3/drives") return { status: 200, body: { drives: [] } };
    if (c.path === "/drive/v3/files") return { status: 200, body: { files: [] } };
    if (c.path === `/drive/v3/files/${DOC}`) return { status: 200, body: { id: DOC, name: "Plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T10:00:00Z", capabilities: { canReadRevisions: true } } };
  }
  if (c.host === "docs.googleapis.com" && c.path === `/v1/documents/${DOC}`) return { status: 200, body: docJson() };
  if (c.host === "driveactivity.googleapis.com") return { status: 200, body: { activities: [] } };
  return { status: 404, body: { error: { code: 404, message: "not found" } } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** Each process (vitest and every worker child) sends Google requests here instead of the internet. */
const PRELOAD = `
const fake = process.env.FAKE_GOOGLE_URL;
const offset = Number(process.env.FAKE_CLOCK_OFFSET_MS || 0);
if (offset) { const now = Date.now.bind(Date); Date.now = () => now() + offset; }
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (!/(^|\\.)googleapis\\.com$|^docs\\.google\\.com$/.test(url.hostname)) return real(input, init);
  return real(fake + "/" + url.hostname + url.pathname + url.search, init);
};
`;

async function startWorker(name: string, extraEnv: Record<string, string> = {}): Promise<{ name: string; child: ChildProcess; out: string[] }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    DATABASE_URL: process.env.DATABASE_URL!, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY!, API_KEY_PEPPER: process.env.API_KEY_PEPPER!,
    WORKOS_API_KEY: process.env.WORKOS_API_KEY!, WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID!,
    GOOGLE_DWD_TENANT_APPROVALS: process.env.GOOGLE_DWD_TENANT_APPROVALS!,
    GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON: process.env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON!,
    WORKER_TASK_LOOPS: "1", FAKE_GOOGLE_URL: fakeUrl, ...extraEnv,
  };
  const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preload).href, "src/source-lane/entrypoints/worker.ts"], { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] });
  const out: string[] = [];
  const log = createWriteStream(path.join(logDir, `${name}.log`));
  for (const s of [child.stdout!, child.stderr!]) s.on("data", (b: Buffer) => { out.push(b.toString("utf8")); log.write(b); });
  const w = { name, child, out };
  workers.push(w);
  await waitFor(() => out.join("").includes("sources-runtime worker:"), 60_000, `${name} ready`);
  return w;
}

async function stopWorker(w: { child: ChildProcess }): Promise<void> {
  if (w.child.exitCode !== null || w.child.signalCode !== null) return;
  const exited = new Promise((r) => w.child.once("exit", r));
  w.child.kill("SIGCONT");
  w.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
  if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill("SIGKILL");
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function taskRow(id: string): Promise<Any> {
  return (await sql`SELECT id, kind, state, attempt, run_at, error_message, output, payload FROM task_queue WHERE id = ${id}`)[0];
}

/** Wait until the task finished, or a failed attempt put it back in the queue (attempt >= minAttempt). */
async function settle(id: string, minAttempt = 1): Promise<Any> {
  await waitFor(async () => {
    const r = await taskRow(id);
    return r && r.state !== "running" && (r.state !== "queued" || r.attempt >= minAttempt);
  }, 60_000, `task ${id}`);
  return taskRow(id);
}

async function enqueue(tenantId: string, kind: string, payload: Record<string, unknown> = {}, queue = "sync"): Promise<string> {
  const id = await mods.queue.enqueueTask({ queue, tenantId, kind, groupKey: `${tenantId}:${kind.split(".")[0]}`, payload: { userId: tenantId, ...payload } });
  return id!;
}

/** Make already queued tasks (failed-attempt retries, deferred copies) due now, as if their run_at had arrived. */
async function makeDue(tenantId: string): Promise<string[]> {
  const rows = await sql`UPDATE task_queue SET run_at = now() WHERE tenant_id = ${tenantId} AND state = 'queued' RETURNING id, attempt`;
  return rows.map((r: Any) => r.id);
}

async function hasCooldownTable(): Promise<boolean> {
  return (await sql`SELECT to_regclass('google_rate_limit_cooldowns') AS t`)[0].t !== null;
}

/** Simulate elapsed time on the database clock: deadlines and queued run_at move back by `seconds`. */
async function elapse(seconds: number): Promise<void> {
  if (await hasCooldownTable()) await sql`UPDATE google_rate_limit_cooldowns SET blocked_until = blocked_until - make_interval(secs => ${seconds})`;
  await sql`UPDATE task_queue SET run_at = run_at - make_interval(secs => ${seconds}) WHERE state = 'queued'`;
}

async function stopAll(): Promise<void> {
  await Promise.all(workers.map((w) => stopWorker(w)));
}

describe.skipIf(!PG)("durable Google floors: donor gdocs tasks across restarts and a second worker (real PG, worker entrypoint)", () => {
  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `gdq-${process.pid}-${randomBytes(3).toString("hex")}`);
    mkdirSync(tmp, { recursive: true });
    preload = path.join(tmp, "google-redirect.mjs");
    writeFileSync(preload, PRELOAD);
    logDir = process.env.GDQ_LOG_DIR ?? tmp;
    mkdirSync(logDir, { recursive: true });

    fake = createServer(async (req, res) => {
      const body = await readBody(req);
      const u = new URL(req.url!, "http://fake");
      const [, host, ...rest] = u.pathname.split("/");
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "") || null;
      const sub = token?.startsWith("ya29.dwd.") ? token.slice("ya29.dwd.".length).replace(/\.\d+$/, "") : null;
      const call: Call = { host: host!, path: `/${rest.join("/")}`, query: u.searchParams, sub, token, at: Date.now() };
      if (call.host !== "oauth2.googleapis.com") calls.push(call);
      const r = answer(call, body);
      res.writeHead(r.status, { "content-type": "application/json", date: new Date().toUTCString(), ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
    process.env.FAKE_GOOGLE_URL = fakeUrl;
    await import(pathToFileURL(preload).href);

    const postgres = (await import("postgres")).default;
    dbName = `gdq_${process.pid}_${randomBytes(3).toString("hex")}`;
    adminSql = postgres(PG!, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    Object.assign(process.env, {
      DATABASE_URL: url.href,
      GOOGLE_DWD_TENANT_APPROVALS: JSON.stringify({ [TA]: ["corp-a.example"], [TB]: ["corp-b.example"] }),
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON: JSON.stringify({
        client_email: "gdq@example-project.iam.gserviceaccount.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    });
    sql = postgres(url.href, { max: 2, onnotice: () => {} });
    mods.migrations = await import("../../../src/source-lane/core/migrations.js");
    await mods.migrations.applySourceLaneMigrations(sql);
    mods.db = await import("../../../src/db/client.js");
    mods.queue = await import("../../../src/queue/queue.js");
    mods.sweeper = await import("../../../src/queue/sweeper.js");
    mods.connections = await import("../../../src/db/connections.js");
    mods.auth = await import("../../../src/vault/google-auth.js");
    mods.gdocsApi = await import("../../../src/polling/_archived-gdocs/gdocs-api.js");
    mods.rate = await import("../../../src/vault/google-rate-limit.js");
    mods.lifecycle = await import("../../../src/source-lane/providers/google-docs/lifecycle.js");
    mods.mailboxes = await import("../../../src/integrations/google/mailboxes.js");
    for (const [tenantId, email] of [[TA, ALICE], [TA, CAROL], [TB, BOB]] as const) {
      await mods.auth.connectGoogleWorkspaceDelegation(tenantId, email);
      await mods.connections.upsertConnection({ tenantId, provider: "google", externalAccountId: email, status: "active", metadata: { authMode: "domain_wide_delegation" } });
      // Each scenario can run alone: the mailbox already has a Drive changes cursor.
      await mods.mailboxes.updateGoogleMailboxState(tenantId, email, { drivePageToken: "100" });
      for (const kind of email === CAROL ? [] : ["gdocs.poll", "gmail.poll"]) {
        // Far-future due_at: the rows only show whether a failure disabled them (no sweeper runs here).
        await mods.sweeper.upsertTaskSchedule({ tenantId, kind, frequencySeconds: 60, groupKey: `${tenantId}:${kind.split(".")[0]}` });
      }
    }
    await sql`UPDATE task_schedules SET due_at = now() + interval '30 days'`;
  }, 120_000);

  // Each scenario starts clean: no worker, no floor, nothing queued, both mailboxes connected and scheduled.
  beforeEach(async () => {
    await stopAll();
    rules.length = 0;
    if (await hasCooldownTable()) await sql`DELETE FROM google_rate_limit_cooldowns`;
    await sql`UPDATE task_queue SET state = 'cancelled' WHERE state IN ('queued', 'running')`;
    await sql`UPDATE connections SET status = 'active' WHERE provider = 'google'`;
    await sql`UPDATE task_schedules SET enabled = true`;
    mods.rate.resetGoogleRateLimitCooldownsForTests();
  });

  afterAll(async () => {
    await stopAll();
    globalThis.fetch = realFetch;
    await new Promise((r) => (fake ? fake.close(r) : r(undefined)));
    await mods.db?.pgClient?.end({ timeout: 5 });
    await sql?.end({ timeout: 5 });
    if (adminSql) {
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adminSql.end({ timeout: 5 });
    }
  });

  it("per-user 403 userRateLimitExceeded (Retry-After 14 days): no request from a second worker, after a restart at +2 h, or with a skewed clock; the other credentials (same tenant, other tenant) continue; resumes after the floor from the same cursor", async () => {
    const w1 = await startWorker("a-w1");
    // Seed: both mailboxes' changes cursors (startPageToken), then one clean poll each.
    for (const t of [TA, TB]) expect((await settle(await enqueue(t, "gdocs.poll"))).state).toBe("succeeded");
    for (const t of [TA, TB]) expect((await settle(await enqueue(t, "gdocs.poll"))).state).toBe("succeeded");
    expect(apiCalls(ALICE, 0).some((c) => c.path === "/drive/v3/changes" && c.query.get("pageToken") === "100")).toBe(true);

    const limit: Rule = (c) => (c.sub === ALICE && docsFamily(c) ? rateLimited("userRateLimitExceeded", 403, String(FOURTEEN_DAYS)) : null);
    rules.push(limit);
    let t0 = Date.now();
    const first = await settle(await enqueue(TA, "gdocs.poll"));
    expect(first.error_message).toMatch(/GoogleRateLimitError/);
    expect(apiCalls(ALICE, t0).map((c) => c.path)).toEqual(["/drive/v3/changes"]);
    // A quota 403 is a provider floor, not a revoked grant: the connection and every Google schedule stay on.
    expect.soft((await sql`SELECT status FROM connections WHERE tenant_id = ${TA} AND provider = 'google'`)[0].status, "quota 403 errored the connection").toBe("active");
    expect.soft((await sql`SELECT bool_and(enabled) AS on FROM task_schedules WHERE tenant_id = ${TA}`)[0].on, "quota 403 disabled the tenant's Google schedules").toBe(true);

    // Second worker while the first is alive (paused, so the fresh process is the one that claims): the retry the
    // queue scheduled, a new scheduled poll, and the other tenant's poll.
    w1.child.kill("SIGSTOP");
    t0 = Date.now();
    const mintsBefore = mints.length;
    const w2 = await startWorker("a-w2");
    const due = await makeDue(TA);
    const fresh = await enqueue(TA, "gdocs.poll");
    const other = await enqueue(TB, "gdocs.poll");
    for (const id of due) await settle(id, 2);
    await settle(fresh);
    expect((await settle(other)).state).toBe("succeeded");
    expect.soft(mints.slice(mintsBefore).some((m) => m.sub === ALICE), "the second worker minted its own token for alice").toBe(true);
    expect.soft(apiCalls(ALICE, t0).map((c) => c.path), "second worker sent a request inside alice's floor").toEqual([]);
    expect(apiCalls(BOB, t0).length, "the other tenant's credential is not held").toBeGreaterThan(0);
    expect.soft(apiCalls(CAROL, t0).length, "the tenant's other mailbox (its own per-user quota) is not held").toBeGreaterThan(0);

    // Restart 2 h later: every process is new (no in-process cooldown, new tokens); one runs 3 days fast.
    await stopAll();
    await elapse(2 * 3600);
    // From before the restart: the queue's retries are due at once and the new workers claim them while starting.
    t0 = Date.now();
    await startWorker("a-w3");
    await startWorker("a-w4-skewed", { FAKE_CLOCK_OFFSET_MS: String(3 * DAY * 1000) });
    const afterRestart = [...(await makeDue(TA)), await enqueue(TA, "gdocs.poll"), await enqueue(TA, "gdocs.poll")];
    for (const id of afterRestart) await settle(id, 1);
    expect.soft(apiCalls(ALICE, t0).map((c) => c.path), "a restarted worker sent a request inside alice's floor (+2 h of 14 days)").toEqual([]);
    expect.soft(apiCalls(CAROL, t0).length, "after the restart the tenant's other mailbox still polls").toBeGreaterThan(0);

    // After the floor: requests resume, from the cursor stored before the 403.
    await stopAll();
    await elapse(FOURTEEN_DAYS);
    rules.splice(rules.indexOf(limit), 1);
    await sql`UPDATE task_queue SET state = 'cancelled' WHERE tenant_id = ${TA} AND state = 'queued'`;
    t0 = Date.now();
    await startWorker("a-w5");
    expect.soft((await settle(await enqueue(TA, "gdocs.poll"))).state, "poll after the floor").toBe("succeeded");
    expect.soft(apiCalls(ALICE, t0).find((c) => c.path === "/drive/v3/changes")?.query.get("pageToken"), "resumed from the stored cursor").toBe("100");
    await stopAll();
  }, 300_000);

  it("project-wide 429 (Retry-After HTTP-date 14 days ahead): a content snapshot is deferred to the floor, not dropped; no Docs/Drive request after a restart; Gmail continues; the snapshot is captured after the floor", async () => {
    const project: Rule = (c) => (docsFamily(c) ? rateLimited("rateLimitExceeded", 429, new Date(Date.now() + FOURTEEN_DAYS * 1000).toUTCString()) : null);
    rules.push(project);
    await startWorker("b-w1");
    let t0 = Date.now();
    const snap = await settle(await enqueue(TA, "gdocs.content-snapshot", { docId: DOC, modifiedTime: "2026-10-01T10:00:00Z" }));
    // Drive is limited separately from the Docs API (own key): the poll meets it on changes.list.
    expect((await settle(await enqueue(TA, "gdocs.poll"))).error_message).toMatch(/GoogleRateLimitError/);
    expect(calls.filter((c) => c.at >= t0 && docsFamily(c)).map((c) => `${c.host}${c.path}`)).toEqual([`docs.googleapis.com/v1/documents/${DOC}`, "www.googleapis.com/drive/v3/changes"]);
    // The capture is kept: one queued copy of the same work, due at the floor (not the queue's 30 s retry).
    const copies = await sql`SELECT id, payload, run_at, state FROM task_queue WHERE tenant_id = ${TA} AND kind = 'gdocs.content-snapshot' AND state = 'queued'`;
    expect(copies.length, `snapshot task ended ${snap.state}/${snap.error_message}`).toBe(1);
    expect(copies[0].payload.docId).toBe(DOC);
    expect.soft(new Date(copies[0].run_at).getTime(), "the snapshot is re-queued at the floor, not the queue's 30 s retry").toBeGreaterThan(Date.now() + (FOURTEEN_DAYS - 3600) * 1000);

    await stopAll();
    await elapse(2 * 3600);
    t0 = Date.now();
    await startWorker("b-w2");
    await startWorker("b-w3");
    const work = [...(await makeDue(TA)), await enqueue(TB, "gdocs.poll"), await enqueue(TA, "gdocs.poll")];
    for (const id of work) await settle(id, 1);
    expect.soft(calls.filter((c) => c.at >= t0 && docsFamily(c)).map((c) => `${c.host}${c.path}`), "a restarted worker sent a Docs/Drive request inside the project floor (+2 h of 14 days)").toEqual([]);
    // Other source of the same tenant, another API and quota: Gmail polls normally.
    const mail = await settle(await enqueue(TA, "gmail.poll"));
    expect(mail.state, mail.error_message).toBe("succeeded");
    expect(apiCalls(ALICE, t0, (c) => c.host === "gmail.googleapis.com").length).toBeGreaterThan(0);
    // The same donor tasks also run the source-lane sweep through googleFetch (the poll's sweep and inventory, the
    // hourly gdocs.suggestion-sync): a due Drive export of the tenant must not be sent inside the floor either.
    await mods.lifecycle.recordLiveChange(TA, { fileId: SHEET, file: { name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-10-01T11:00:00Z", trashed: false, capabilities: { canReadRevisions: true } } }, ALICE);
    t0 = Date.now();
    const sweep = await settle(await enqueue(TA, "gdocs.suggestion-sync"));
    expect(sweep.state, sweep.error_message).toBe("succeeded");
    const sheet = (await sql`SELECT content_state, content_reason, content_retry_at FROM gdocs_file_checkpoints WHERE tenant_id = ${TA} AND file_id = ${SHEET}`)[0];
    expect.soft(calls.filter((c) => c.at >= t0 && docsFamily(c)).map((c) => `${c.host}${c.path}`), `the source-lane sweep (googleFetch) sent a Drive request inside the project floor (sheet ${JSON.stringify(sheet)})`).toEqual([]);

    await stopAll();
    await elapse(FOURTEEN_DAYS);
    rules.splice(rules.indexOf(project), 1);
    t0 = Date.now();
    await startWorker("b-w4");
    const retried = await makeDue(TA);
    for (const id of retried) await settle(id, 1);
    expect(calls.filter((c) => c.at >= t0 && c.host === "docs.googleapis.com").length).toBeGreaterThan(0);
    expect((await sql`SELECT count(*)::int AS n FROM google_doc_tab_snapshots WHERE user_id = ${TA} AND doc_id = ${DOC}`)[0].n).toBeGreaterThan(0);
    await stopAll();
  }, 300_000);

  it("permission and auth failures are unchanged: a reader 403 still falls back to the preview view, a Drive 401 still errors the connection; neither is a floor", async () => {
    const perm: Rule = (c) => (c.host === "docs.googleapis.com" && c.query.get("suggestionsViewMode") === "SUGGESTIONS_INLINE"
      ? { status: 403, body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } } : null);
    const auth: Rule = (c) => (c.sub === BOB && c.host === "www.googleapis.com" ? { status: 401, body: { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } } } : null);
    rules.push(perm, auth);
    await sql`DELETE FROM google_doc_tab_snapshots WHERE user_id = ${TA}`;
    await startWorker("c-w1");
    let t0 = Date.now();
    expect((await settle(await enqueue(TA, "gdocs.content-snapshot", { docId: DOC }))).state).toBe("succeeded");
    expect(calls.filter((c) => c.at >= t0 && c.host === "docs.googleapis.com").map((c) => c.query.get("suggestionsViewMode"))).toEqual(["SUGGESTIONS_INLINE", "PREVIEW_WITHOUT_SUGGESTIONS"]);
    t0 = Date.now();
    const bob = await settle(await enqueue(TB, "gdocs.poll"));
    expect(bob.error_message).toMatch(/401/);
    expect((await sql`SELECT status FROM connections WHERE tenant_id = ${TB} AND provider = 'google'`)[0].status).toBe("error");
    expect((await sql`SELECT bool_or(enabled) AS on FROM task_schedules WHERE tenant_id = ${TB}`)[0].on).toBe(false);
    if (await hasCooldownTable()) {
      expect((await sql`SELECT service_key FROM google_rate_limit_cooldowns WHERE blocked_until > now()`).length).toBe(0);
    }
    rules.splice(rules.indexOf(perm), 1);
    rules.splice(rules.indexOf(auth), 1);
    await stopAll();
  }, 120_000);

  it("stored floors follow the strict parser on the database clock: malformed -> gFetch fallback, overflow -> 2^31-1 s, HTTP-date vs a lagging server Date, later-only and atomic across connections", async () => {
    // Imported here, not in beforeAll, so the old-code control (no durable store) still runs the scenarios above.
    const identity = await import("../../../src/vault/google-quota-identity.js");
    const persist = (await import("../../../src/source-lane/providers/google-docs/durable-cooldown.js")).recordGoogleCooldownDurable;
    const remaining = async (key: string) => Number((await sql`SELECT extract(epoch FROM blocked_until - now()) AS s FROM google_rate_limit_cooldowns WHERE service_key = ${key}`)[0]?.s ?? -1);
    await sql`DELETE FROM google_rate_limit_cooldowns`;
    const cases: Array<[string, Record<string, string>, number]> = [
      ["soon", {}, 30],
      ["-5", {}, 30],
      ["99999999999999999999999", {}, 2_147_483_647],
      // Server clock 1 h behind ours: its own 2 h deadline is honoured, not the 1 h our clock would give.
      [new Date(Date.now() + 3600_000).toUTCString(), { date: new Date(Date.now() - 3600_000).toUTCString() }, 7200],
    ];
    for (const [i, [value, extra, expected]] of cases.entries()) {
      const token = `tok-parse-${i}`;
      identity.noteGoogleTokenQuotaUser(token, `qparse${i}`);
      const rule: Rule = (c) => (c.token === token ? rateLimited("userRateLimitExceeded", 403, value, extra) : null);
      rules.push(rule);
      await expect(mods.gdocsApi.gFetch("https://www.googleapis.com/drive/v3/changes?pageToken=1", token)).rejects.toMatchObject({ name: "GoogleRateLimitError" });
      rules.splice(rules.indexOf(rule), 1);
      expect(Math.abs((await remaining(mods.gdocsApi.credentialCooldownKey(token))) - expected), `Retry-After ${value}`).toBeLessThan(5);
    }
    // Later only: a shorter floor afterwards does not shorten it; concurrent writers from two connections keep the max.
    const { GoogleRateLimitError } = mods.rate;
    await persist(new GoogleRateLimitError("google-workspace:quota:qmono", 429, FOURTEEN_DAYS, "rateLimitExceeded"));
    await persist(new GoogleRateLimitError("google-workspace:quota:qmono", 429, 60, "rateLimitExceeded"));
    expect(Math.abs((await remaining("google-workspace:quota:qmono")) - FOURTEEN_DAYS)).toBeLessThan(5);
    const postgres = (await import("postgres")).default;
    const other = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
    const upsert = (ex: Any, s: number) => ex`INSERT INTO google_rate_limit_cooldowns (service_key, blocked_until) VALUES ('race', now() + make_interval(secs => ${s}))
      ON CONFLICT (service_key) DO UPDATE SET blocked_until = GREATEST(google_rate_limit_cooldowns.blocked_until, EXCLUDED.blocked_until)`;
    await Promise.all([...[10, 50, 30, 999].map((s) => upsert(other, s)), ...[20, 40].map((s) => upsert(sql, s))]);
    expect(Math.round(await remaining("race"))).toBeGreaterThan(990);
    await other.end({ timeout: 5 });
  }, 60_000);
});
