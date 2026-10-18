import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/db/client.js", async () => {
  const h = await import("./harness.js");
  return { db: h.db, pgClient: null };
});
vi.mock("../../../../src/vault/tokens.js", async () => (await import("./harness.js")).tokenVault);

import { granolaRows, laneState, query, ready, resetAll, tokens } from "./harness.js";
import { runGranolaSourceBackfill, runGranolaSourcePoll } from "../../../../src/source-lane/providers/granola/lane.js";
import { resetGranolaRateGatesForTests } from "../../../../src/integrations/granola/poller.js";

/**
 * OAuth mode: the donor talks to Granola's MCP server (https://mcp.granola.ai/mcp, JSON-RPC over
 * streamable HTTP) with tokens from https://mcp-auth.granola.ai. This local fake implements the
 * tool shapes the donor selector accepts (list_notes with cursor/updated_after/page_size, get_note
 * with note_id) and the refresh grant. Granola's real MCP tool names/schemas are NOT verified here.
 */

const T = "tenant-granola-oauth";
const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

function idToken(claims: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
}

class FakeGranolaMcp {
  validToken = "at-new";
  refreshes: URLSearchParams[] = [];
  calls: Array<{ method: string; tool?: string; status: number }> = [];
  scripted: Array<(method: string, tool?: string) => Response | null> = [];
  notes: Array<Record<string, unknown>> = [];
  detail = new Map<string, unknown>();

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === "https://mcp-auth.granola.ai/oauth2/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      this.refreshes.push(body);
      if (body.get("grant_type") !== "refresh_token" || body.get("refresh_token") !== "rt-1") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: this.validToken, refresh_token: "rt-2", expires_in: 3600, token_type: "Bearer", id_token: idToken({ sub: "user-123", email: "owner@example.test" }) });
    }
    if (url.href !== "https://mcp.granola.ai/mcp") throw new Error(`unexpected ${url.href}`);
    const rpc = JSON.parse(String(init?.body ?? "{}")) as { id?: string; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    const tool = rpc.params?.name;
    const res = this.handle(rpc, new Headers(init?.headers).get("authorization"));
    this.calls.push({ method: rpc.method, tool, status: res.status });
    return res;
  };

  private handle(rpc: { id?: string; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }, auth: string | null): Response {
    for (let i = 0; i < this.scripted.length; i++) {
      const r = this.scripted[i]!(rpc.method, rpc.params?.name);
      if (r) {
        this.scripted.splice(i, 1);
        return r;
      }
    }
    if (auth !== `Bearer ${this.validToken}`) return new Response("unauthorized", { status: 401 });
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "mcp-session-id": "sess-1" } });
    if (rpc.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: {} });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return ok({
        tools: [
          { name: "list_notes", inputSchema: { properties: { cursor: {}, updated_after: {}, page_size: {} } } },
          { name: "get_note", inputSchema: { properties: { note_id: {} } } },
        ],
      });
    }
    if (rpc.method === "tools/call" && rpc.params?.name === "list_notes") {
      const cursor = rpc.params.arguments?.cursor as string | undefined;
      const offset = cursor ? Number(cursor.slice(1)) : 0;
      const page = this.notes.slice(offset, offset + 2);
      const hasMore = offset + 2 < this.notes.length;
      return ok({ structuredContent: { notes: page, hasMore, cursor: hasMore ? `c${offset + 2}` : null } });
    }
    if (rpc.method === "tools/call" && rpc.params?.name === "get_note") {
      const id = String(rpc.params.arguments?.note_id);
      return ok({ structuredContent: this.detail.get(id) ?? null });
    }
    return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { message: "unknown" } });
  }
}

let mcp: FakeGranolaMcp;

function connectOAuth(): void {
  tokens.set(`${T}:granola`, {
    token: "at-old",
    refreshToken: "rt-1",
    metadata: {
      auth_mode: "oauth_mcp",
      client_id: "client-1",
      token_endpoint_auth_method: "none",
      includeTranscript: true,
      folderId: null,
      lastUpdatedAt: ago(3),
      expires_at: Date.now() + 3600_000,
      account_subject: "user-123",
      account_email: "owner@example.test",
    },
  });
}

function mcpNote(id: string, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Meeting ${id}`,
    owner_name: "Owner One",
    owner_email: "owner@example.test",
    created_at: at,
    updated_at: at,
    summary: `summary ${id}`,
    transcript: [
      { id: `${id}-s1`, speaker: { source: "microphone", name: "Owner One" }, text: "first", start_time: "00:00:01", end_time: "00:00:03", confidence: 0.91 },
      { id: `${id}-s2`, speaker: { source: "speaker", diarization_label: "B" }, text: "second", start_time: "00:00:04" },
    ],
    meeting_platform: "zoom",
    ...extra,
  };
}

beforeAll(async () => {
  await ready;
});

beforeEach(async () => {
  await resetAll();
  resetGranolaRateGatesForTests();
  mcp = new FakeGranolaMcp();
  vi.stubGlobal("fetch", mcp.fetch);
  await query(`INSERT INTO integration_tokens (user_id, provider, access_token) VALUES ($1, 'granola', 'synthetic-ciphertext')`, [T]);
  await query(`INSERT INTO connections (tenant_id, provider, status) VALUES ($1, 'granola', 'active')`, [T]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Granola OAuth/MCP transport through the source lane", () => {
  it("a 401 mid-run refreshes the OAuth token once and re-runs; every transcript segment field survives the MCP normaliser", async () => {
    connectOAuth();
    for (const [i, id] of ["m1", "m2", "m3"].entries()) {
      const n = mcpNote(id, ago(10 - i));
      mcp.notes.push({ id, title: n.title, created_at: n.created_at, updated_at: n.updated_at });
      mcp.detail.set(id, n);
    }

    const result = await runGranolaSourceBackfill(T);

    expect(result).toMatchObject({ listed: 3, stored: 3, failed: 0, inventoryComplete: true });
    expect(mcp.refreshes).toHaveLength(1);
    expect(mcp.calls[0]).toMatchObject({ method: "initialize", status: 401 });
    const stored = tokens.get(`${T}:granola`)!;
    expect(stored).toMatchObject({ token: "at-new", refreshToken: "rt-2" });
    expect(stored.metadata).toMatchObject({ account_subject: "user-123", account_email: "owner@example.test", lastUpdatedAt: expect.any(String) });
    expect(JSON.stringify(stored.metadata)).not.toContain("rt-2");

    const rows = await granolaRows(T);
    const m1 = rows.find((r) => r.source_object_id === "meeting_note:m1")!;
    expect(m1.raw_payload.api.source).toBe("granola_oauth_mcp");
    expect(m1.raw_payload.meeting_platform).toBe("zoom");
    expect(m1.raw_payload.transcript[0]).toMatchObject({ id: "m1-s1", confidence: 0.91, text: "first", start_time: "00:00:01", end_time: "00:00:03", speaker: { source: "microphone", name: "Owner One" } });
    expect(m1.raw_payload.transcript[1]).toMatchObject({ id: "m1-s2", speaker: { source: "speaker", diarization_label: "B" } });
    expect((await laneState(T)).account_label).toBe("owner@example.test");
  });

  it("honours MCP Retry-After: a short wait is retried, a long one is surfaced and becomes a cooldown", async () => {
    connectOAuth();
    mcp.validToken = "at-old";
    const n = mcpNote("m1", ago(10));
    mcp.notes.push({ id: "m1", title: n.title, created_at: n.created_at, updated_at: n.updated_at });
    mcp.detail.set("m1", n);
    mcp.scripted.push((method, tool) => (method === "tools/call" && tool === "get_note" ? new Response("slow", { status: 429, headers: { "retry-after": "1" } }) : null));
    const started = Date.now();
    const pass = await runGranolaSourceBackfill(T);
    expect(pass).toMatchObject({ stored: 1, failed: 0 });
    expect(mcp.calls.filter((c) => c.tool === "get_note").map((c) => c.status)).toEqual([429, 200]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);

    await runGranolaSourcePoll(T); // first poll after the pass: clean
    resetGranolaRateGatesForTests();
    mcp.scripted.push((method, tool) => (method === "tools/call" && tool === "list_notes" ? new Response("slow", { status: 429, headers: { "retry-after": "300" } }) : null));
    const listBefore = mcp.calls.filter((c) => c.tool === "list_notes").length;
    await expect(runGranolaSourcePoll(T)).rejects.toThrow(/\(429\); retry-after=300/);
    expect(mcp.calls.filter((c) => c.tool === "list_notes").length - listBefore).toBe(1);
    const [quota] = await query(`SELECT quota_key, blocked_until FROM granola_source_quota`);
    expect(quota!.quota_key).toMatch(/^granola:oauth:[0-9a-f]{32}$/);
    expect(new Date(quota!.blocked_until).getTime() - Date.now()).toBeGreaterThan(290_000);
  });

  it("a detail payload without timestamps fails the note instead of storing a 1970 shell revision", async () => {
    connectOAuth();
    mcp.validToken = "at-old";
    mcp.notes.push({ id: "m1", title: "x", created_at: ago(10), updated_at: ago(10) });
    mcp.detail.set("m1", { text: "Meeting notes for m1 as free text" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pass = await runGranolaSourceBackfill(T);

    expect(pass.failed).toBe(1);
    expect(pass.inventoryComplete).toBe(false);
    expect(await granolaRows(T)).toHaveLength(0);
    expect(Object.values((await laneState(T)).failed_notes)[0]).toMatchObject({ error: expect.stringContaining("without created_at/updated_at") });
  });
});
