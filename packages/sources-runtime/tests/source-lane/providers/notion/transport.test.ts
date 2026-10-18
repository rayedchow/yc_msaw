import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});

import { fileUrlAllowed, NotionSourceClient, retryAfterMs, DEFAULT_FILE_HOSTS } from "../../../../src/source-lane/providers/notion/api.js";
import { notionCoverage } from "../../../../src/source-lane/providers/notion/coverage.js";
import { runNotionSweep } from "../../../../src/source-lane/providers/notion/sweep.js";
import { BOT_ID, FakeNotion, FILE_HOST, richText, SIGNATURE, TOKEN, uid, WORKSPACE_ID } from "./fake-notion.js";
import { credentialFor, drain, DS1_DIR, dir, ID, makeExporter, P1_DIR, PNG, ROOT, seedWorkspace, sweepOptions, sweepUntilQuiet } from "./fixtures.js";
import { db, query, ready, resetAll } from "./harness.js";

const T = "tenant-n2";
let fake: FakeNotion;

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  fake = new FakeNotion();
  seedWorkspace(fake);
});

const rateLimited = (reason: string) => ({ object: "error", status: 429, code: "rate_limited", message: "Rate limited", additional_data: { rate_limit_reason: reason, retry_after: "42" } });

describe("notion transport: rate limits and resumption", () => {
  it("a 429 persists Retry-After on the connection budget; the next run makes no request until it passes, then resumes from the stored cursor", async () => {
    // First search page succeeds, the second (cursor) page is rate limited.
    fake.inject(/^POST \/v1\/search$/u, 200, {}, {}, 0);
    let searchCalls = 0;
    let limited = false;
    const base = fake.fetch;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/v1/search")) {
        searchCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.filter?.value === "page" && body.start_cursor && !limited) {
          limited = true;
          return Response.json(rateLimited("public_api_request_rate_limit"), { status: 429, headers: { "retry-after": "42" } });
        }
      }
      return base(input, init);
    };
    const r1 = await runNotionSweep(db as never, T, sweepOptions(fake, { clientOptions: { fetchImpl } }));
    expect(r1.outcome).toBe("deferred");
    const quota = await query(`SELECT quota_key, last_status, last_retry_after_ms, rate_limit_streak, blocked_until > now() + interval '30 seconds' AS long FROM notion_source_quota WHERE blocked_until IS NOT NULL`);
    expect(quota).toEqual([{ quota_key: `notion:bot:${BOT_ID}`, last_status: 429, last_retry_after_ms: 42000, rate_limit_streak: 1, long: true }]);
    const checkpoint = (await query<{ payload: any }>(`SELECT payload FROM notion_source_work WHERE item_key = 'search:page'`))[0]!.payload;
    expect(checkpoint.cursor).toBeTruthy();

    const callsBefore = fake.calls.length + searchCalls;
    const r2 = await runNotionSweep(db as never, T, sweepOptions(fake, { clientOptions: { fetchImpl } }));
    expect(r2).toMatchObject({ outcome: "deferred", requests: 0 });
    expect(fake.calls.length + searchCalls).toBe(callsBefore);

    await query(`UPDATE notion_source_quota SET blocked_until = now() - interval '1 second'`);
    const resumeFrom = fake.calls.length;
    await sweepUntilQuiet(T, fake, { clientOptions: { fetchImpl } });
    const nextSearch = fake.calls.slice(resumeFrom).find((c) => c.url.pathname === "/v1/search" && c.body?.filter?.value === "page")!;
    expect(nextSearch.body!.start_cursor).toBe(checkpoint.cursor);
    expect((await query(`SELECT rate_limit_streak FROM notion_source_quota WHERE quota_key = $1`, [`notion:bot:${BOT_ID}`]))[0]).toEqual({ rate_limit_streak: 0 });
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect(await yc.text(`${P1_DIR}/page.md`)).toContain("End of handbook");
  });

  it("workspace-wide limits defer every connection of that workspace; endpoint limits defer by endpoint; no Retry-After backs off exponentially", async () => {
    fake.inject(/^GET \/v1\/users\/me$/u, 429, rateLimited("public_api_space_request_rate_limit"), { "retry-after": "120" });
    const r = await runNotionSweep(db as never, T, sweepOptions(fake));
    expect(r.outcome).toBe("deferred");
    expect((await query(`SELECT quota_key FROM notion_source_quota WHERE blocked_until > now() + interval '100 seconds'`)).map((x) => x.quota_key)).toEqual([`notion:workspace:${WORKSPACE_ID}`]);
    // Another tenant connected to the same workspace through another bot waits too, without a request.
    const callsBefore = fake.calls.length;
    const other = await runNotionSweep(db as never, "tenant-other", sweepOptions(fake, { clientOptions: { credential: credentialFor(TOKEN, { botId: "b0b0b0b0-0000-4000-8000-0000000000ff", workspaceId: WORKSPACE_ID }) } }));
    expect(other).toMatchObject({ outcome: "deferred", requests: 0 });
    expect(fake.calls.length).toBe(callsBefore);

    // No Retry-After: exponential backoff on the connection budget.
    await query(`UPDATE notion_source_quota SET blocked_until = NULL`);
    fake.inject(/^POST \/v1\/search$/u, 429, { object: "error", status: 429, code: "rate_limited", message: "slow down" }, {}, 2);
    expect((await runNotionSweep(db as never, T, sweepOptions(fake))).outcome).toBe("deferred");
    const first = (await query<{ s: number }>(`SELECT extract(epoch FROM blocked_until - now())::int AS s FROM notion_source_quota WHERE quota_key = $1`, [`notion:bot:${BOT_ID}`]))[0]!.s;
    await query(`UPDATE notion_source_quota SET blocked_until = NULL`);
    expect((await runNotionSweep(db as never, T, sweepOptions(fake))).outcome).toBe("deferred");
    const second = (await query<{ s: number; streak: number }>(`SELECT extract(epoch FROM blocked_until - now())::int AS s, rate_limit_streak AS streak FROM notion_source_quota WHERE quota_key = $1`, [`notion:bot:${BOT_ID}`]))[0]!;
    expect(first).toBeGreaterThanOrEqual(25);
    expect(second.s).toBeGreaterThan(first);
    expect(second.streak).toBe(2);

    // Per-endpoint limit: recorded on the endpoint family of this connection.
    await query(`UPDATE notion_source_quota SET blocked_until = NULL`);
    fake.inject(/^POST \/v1\/search$/u, 429, rateLimited("public_api_endpoint_rate_limit"), { "retry-after": "7" });
    expect((await runNotionSweep(db as never, T, sweepOptions(fake))).outcome).toBe("deferred");
    expect((await query(`SELECT quota_key FROM notion_source_quota WHERE blocked_until > now()`)).map((x) => x.quota_key)).toEqual([`notion:bot:${BOT_ID}:endpoint:POST /search`]);
    expect((await runNotionSweep(db as never, T, sweepOptions(fake))).outcome).toBe("deferred");
  });

  it("parses Retry-After from the header or additional_data and never sleeps on 429/529", async () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }), null)).toBe(3000);
    expect(retryAfterMs(new Headers(), { additional_data: { retry_after: "9" } })).toBe(9000);
    expect(retryAfterMs(new Headers(), {})).toBeNull();
    fake.inject(/^GET \/v1\/users\/me$/u, 529, { object: "error", status: 529, code: "service_overload", message: "overloaded" }, { "retry-after": "5" });
    const client = new NotionSourceClient(T, { fetchImpl: fake.fetch, credential: credentialFor() });
    const started = Date.now();
    await expect(client.get("/users/me")).rejects.toMatchObject({ name: "NotionRateLimitedError", status: 529, retryAfterMs: 5000, scope: "connection" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("blocked API access and failed auth block the connection (coverage blocked); a 401 refreshes the OAuth token once", async () => {
    fake.inject(/^GET \/v1\/users\/me$/u, 429, rateLimited("public_api_request_blocked"));
    const r = await runNotionSweep(db as never, T, sweepOptions(fake));
    expect(r.outcome).toBe("blocked");

    // Expired access token, refresh succeeds and the request is retried with the new token.
    fake.token = "secret_new_token";
    const refresh = vi.fn(async () => "secret_new_token");
    const ok = await runNotionSweep(db as never, T, sweepOptions(fake, { clientOptions: { credential: async () => ({ token: TOKEN, refreshToken: "refresh-1", metadata: { botId: BOT_ID, workspaceId: WORKSPACE_ID } }), refresh } }));
    expect(ok.outcome).toBe("ran");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fake.calls.some((c) => c.auth === "Bearer secret_new_token")).toBe(true);

    await sweepUntilQuiet(T, fake, { clientOptions: { credential: credentialFor("secret_new_token") } });
    // Revoked: 401 with no refresh token blocks (as soon as a request is due).
    fake.token = "secret_revoked_everywhere";
    await query(`UPDATE notion_source_work SET not_before = NULL`);
    await query(`UPDATE notion_source_sync_state SET delta_checked_at = NULL`);
    const blocked = await runNotionSweep(db as never, T, sweepOptions(fake, { clientOptions: { credential: credentialFor("secret_new_token") } }));
    expect(blocked.outcome).toBe("blocked");
    const cov = await notionCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === `workspace:${WORKSPACE_ID}/${BOT_ID}`)).toMatchObject({ state: "blocked" });

    // No token stored at all.
    const none = await runNotionSweep(db as never, "tenant-none", sweepOptions(fake, { clientOptions: { credential: async () => null } }));
    expect(none.outcome).toBe("no_connection");
  });

  it("an expired listing cursor restarts only that listing; a budget end resumes exactly where it stopped", async () => {
    // Budget of 3 requests per run: many runs, each resuming from durable checkpoints.
    const reports = await sweepUntilQuiet(T, fake, { maxRequestsPerRun: 3, deltaIntervalMs: 3600_000 }, 400);
    expect(reports.length).toBeGreaterThan(10);
    expect(reports.every((r) => r.requests <= 3)).toBe(true);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const md = await yc.text(`${P1_DIR}/page.md`);
    for (let i = 1; i <= 5; i++) expect(md).toContain(`- Bullet ${i}`);
    expect((await yc.text(`${DS1_DIR}/_table.csv`)).trim().split("\r\n")).toHaveLength(6);
    const cov = await notionCoverage({ tenantId: T, executor: db as never });
    expect(cov.find((c) => c.scope === `workspace:${WORKSPACE_ID}/${BOT_ID}`)!.state).toBe("complete");

    // Expired cursor on a block listing: the listing restarts from the top, nothing is lost.
    const t = fake.tick(2);
    fake.pages.get(ID.P1)!.last_edited_time = t;
    const realFetch = fake.fetch;
    let poisoned = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (!poisoned && url.pathname === `/v1/blocks/${ID.P1}/children` && url.searchParams.get("start_cursor")) {
        poisoned = true;
        fake.invalidCursors.add(url.searchParams.get("start_cursor")!);
      }
      return realFetch(input, init);
    };
    await sweepUntilQuiet(T, fake, { clientOptions: { fetchImpl } });
    await drain(exporter);
    expect(poisoned).toBe(true);
    const blocks = await yc.json(`${P1_DIR}/blocks.json`);
    expect(blocks.blockCount).toBe(15);
    expect(blocks.walkStatus).toBe("complete");
  });

  it("queries past the per-query result limit with created_time windows", async () => {
    fake.queryLimit = 2;
    await sweepUntilQuiet(T, fake);
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    expect((await yc.text(`${DS1_DIR}/_table.csv`)).trim().split("\r\n")).toHaveLength(6);
    const windows = fake.calls.filter((c) => c.url.pathname === `/v1/data_sources/${ID.DS1}/query` && c.body?.filter?.created_time?.on_or_after);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(await yc.text(`${DS1_DIR}/_data_source.md`)).toContain('rows_query: "complete"');
  });
});

describe("notion transport: file bytes", () => {
  it("only allowlisted https hosts; Notion's shared S3 endpoint only for Notion's bucket", () => {
    expect(fileUrlAllowed(`https://${FILE_HOST}/x/y.png?X-Amz-Signature=1`, DEFAULT_FILE_HOSTS)).toBe(true);
    expect(fileUrlAllowed("https://s3.us-west-2.amazonaws.com/secure.notion-static.com/a/b.png", DEFAULT_FILE_HOSTS)).toBe(true);
    expect(fileUrlAllowed("https://s3.us-west-2.amazonaws.com/attacker-bucket/b.png", DEFAULT_FILE_HOSTS)).toBe(false);
    expect(fileUrlAllowed(`http://${FILE_HOST}/x`, DEFAULT_FILE_HOSTS)).toBe(false);
    expect(fileUrlAllowed("https://169.254.169.254/latest/meta-data", DEFAULT_FILE_HOSTS)).toBe(false);
    expect(fileUrlAllowed(`https://user:pw@${FILE_HOST}/x`, DEFAULT_FILE_HOSTS)).toBe(false);
    expect(fileUrlAllowed("https://evilnotion-static.com/x", DEFAULT_FILE_HOSTS)).toBe(false);
    expect(fileUrlAllowed("https://a.notion-static.com/x", DEFAULT_FILE_HOSTS)).toBe(true);
  });

  it("refuses non-allowlisted hosts and redirects, re-fetches the owner for a fresh URL after expiry, and caps size", async () => {
    // A Notion-hosted file object pointing at an unexpected host, and one whose host redirects off-list.
    const evil = uid(0x4e1);
    const redirecting = uid(0x4e2);
    fake.appendChildren(ID.P2, [
      fake.block(evil, "file", { caption: [], name: "evil.bin", type: "file", file: { url: `https://internal.example/evil.bin?X-Amz-Signature=${SIGNATURE}`, expiry_time: "2026-10-01T11:00:00.000Z" } }),
      fake.block(redirecting, "file", { caption: [], name: "hop.bin", ...fake.hostedFile("hop-1", "hop.bin", Buffer.from("hop")) }),
    ], "page_id");
    const big = uid(0x4e3);
    fake.appendChildren(ID.P2, [fake.block(big, "file", { caption: [], name: "big.bin", ...fake.hostedFile("big-1", "big.bin", Buffer.alloc(4096, 7)) })], "page_id");
    const realFetch = fake.fetch;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.includes("/hop-1/")) return new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } });
      return realFetch(input, init);
    };
    // The diagram link has expired once: the lane re-reads the block for a fresh signed URL.
    fake.expireDownloads = 1;
    await sweepUntilQuiet(T, fake, { clientOptions: { fetchImpl }, maxFileBytes: 1024 });
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);

    expect(fake.calls.some((c) => c.url.hostname === "internal.example" || c.url.hostname === "attacker.example")).toBe(false);
    const files = await query<{ owner_id: string; status: string; error: string | null }>(`SELECT owner_id, status, error FROM notion_source_files WHERE tenant_id = $1`, [T]);
    expect(files.find((f) => f.owner_id === evil)).toMatchObject({ status: "host_refused" });
    expect(files.find((f) => f.owner_id === redirecting)).toMatchObject({ status: "host_refused" });
    expect(files.find((f) => f.owner_id === big)).toMatchObject({ status: "too_large" });
    // Expired link: first download failed, the download item re-read the owner and stored the exact bytes.
    expect(files.filter((f) => f.status === "stored").length).toBe(4);
    const downloads = await query<{ state: string; outcome: any }>(`SELECT state, outcome FROM notion_source_work WHERE tenant_id = $1 AND kind = 'download'`, [T]);
    expect(downloads).toEqual([{ state: "done", outcome: { status: 200 } }]);
    const p2 = await yc.text(`${ROOT}/${dir("Team Notes", ID.P2)}/page.md`);
    expect(p2).toContain("bytes not archived (host_refused");
    expect(p2).toContain("bytes not archived (too_large");
    const cov = await notionCoverage({ tenantId: T, executor: db as never });
    const ws = cov.find((c) => c.scope === `workspace:${WORKSPACE_ID}/${BOT_ID}`)!;
    expect(ws.state).toBe("partial");
    expect(ws.reason).toContain("over the byte limit");
    expect(ws.reason).toContain("non-allowlisted hosts");
    const imgPath = await yc.find("/diagram.png", P1_DIR);
    expect((await yc.file(imgPath))!.bytes.equals(PNG)).toBe(true);
    expect(await yc.allText()).not.toContain(SIGNATURE);
  });
});

describe("notion transport: tenant and connection scoping", () => {
  it("keeps two tenants' captures, work and exports apart", async () => {
    const fake2 = new FakeNotion();
    const otherBot = "b0b0b0b0-0000-4000-8000-000000000002";
    const otherWs = "aaaaaaaa-0000-4000-8000-00000000000b";
    fake2.botId = otherBot;
    fake2.workspaceId = otherWs;
    fake2.addPage(uid(0xb01), { title: "Other tenant secret plan", parent: { type: "workspace", workspace: true } });
    fake2.appendChildren(uid(0xb01), [fake2.block(uid(0xb02), "paragraph", { rich_text: richText("tenant B only"), color: "default" })], "page_id");
    await sweepUntilQuiet(T, fake);
    await sweepUntilQuiet("tenant-b", fake2, { clientOptions: { credential: credentialFor(TOKEN, { botId: otherBot, workspaceId: otherWs }) } });
    const { exporter, yc } = await makeExporter(T);
    await drain(exporter);
    const all = await yc.paths("sources");
    expect(all.every((p) => p.startsWith(`${ROOT}/`))).toBe(true);
    expect(await yc.allText()).not.toContain("tenant B only");
    const rows = await query<{ tenant_id: string; connection_id: string }>(`SELECT DISTINCT tenant_id, connection_id FROM notion_source_nodes ORDER BY tenant_id`);
    expect(rows).toEqual([{ tenant_id: "tenant-b", connection_id: otherBot }, { tenant_id: T, connection_id: BOT_ID }]);
    const covB = await notionCoverage({ tenantId: "tenant-b", executor: db as never });
    expect(covB.map((c) => c.scope)).toEqual([`workspace:${otherWs}/${otherBot}`, `workspace:${otherWs}/${otherBot}:history`]);
  });
});
