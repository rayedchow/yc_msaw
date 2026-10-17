import { describe, expect, it } from "vitest";
import { generateStaticKey } from "../src/auth/static-keys.js";
import { InProcessTraceTransport, TraceRecorder } from "../src/sdk/client.js";
import { TraceChunkSchema, type TraceChunk } from "../src/traces/schema.js";
import { FIXTURE_ID, parseHostedClient, parseProbeLines, recordSyntheticFixture, Redactor } from "../scripts/hosted-e2e-smoke.js";

const trace = generateStaticKey("tenant-smoke", ["traces:write"]).key;
const build = generateStaticKey("tenant-smoke", ["memory:build"]).key;
const read = generateStaticKey("tenant-smoke", ["memory:read", "integrations:read"]).key;

describe("hosted e2e smoke helpers", () => {
  it("parses the client file and derives HTTP + MCP URLs", () => {
    const c = parseHostedClient({ baseUrl: "https://example.run.mcp-use.com/mcp/", tenantNs: "tenant-smoke", keys: { trace, build, read } });
    expect(c.baseUrl).toBe("https://example.run.mcp-use.com");
    expect(c.mcpUrl).toBe("https://example.run.mcp-use.com/mcp");
  });

  it("rejects bad client files without echoing secret values", () => {
    const bad = [
      { baseUrl: "http://example.com", tenantNs: "tenant-smoke", keys: { trace, build, read } },
      { baseUrl: "https://example.com", tenantNs: "Tenant!", keys: { trace, build, read } },
      { baseUrl: "https://example.com", tenantNs: "tenant-smoke", keys: { trace, build, read: trace } },
      { baseUrl: "https://example.com", tenantNs: "tenant-smoke", keys: { trace, build, read: `${read}!` } },
    ];
    for (const raw of bad) {
      let message = "";
      try {
        parseHostedClient(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      for (const k of [trace, build, read]) expect(message).not.toContain(k);
    }
  });

  it("redacts registered values and bearer/pmk/JWT-shaped strings", () => {
    const r = new Redactor();
    r.add(read, "read-key");
    r.add("tenant-smoke", "tenant");
    const text = r.text(
      `key=${read} other=${trace} Authorization: Bearer abc.def-123 ns=tenant-smoke jwt=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eXp4eXoifQ.c2lnbmF0dXJl ` +
        'WWW-Authenticate: Bearer error="insufficient_scope"',
    );
    for (const secret of [read, trace, "abc.def-123", "tenant-smoke", "eyJhbGciOiJSUzI1NiJ9"]) expect(text).not.toContain(secret);
    expect(text).toContain('Bearer error="insufficient_scope"');
    expect(r.contains(`x${read}x`)).toBe(true);
    expect(r.json({ nested: [read] })).toEqual({ nested: ["[redacted:read-key]"] });
  });

  it("parses sandbox probe output", () => {
    expect(parseProbeLines("UID=1000\nnoise\nNET_TCP_IP=blocked\nENV_NAMES=HOME,PATH,\n")).toEqual({ UID: "1000", NET_TCP_IP: "blocked", ENV_NAMES: "HOME,PATH," });
  });

  it("records a schema-valid, clearly labeled synthetic fixture session", async () => {
    const chunks: TraceChunk[] = [];
    const ingestor = {
      async ingestChunk(_ns: string, chunk: unknown) {
        const parsed = TraceChunkSchema.parse(chunk);
        chunks.push(parsed);
        return { status: "created" as const, sessionId: parsed.sessionId, chunkSeq: parsed.chunkSeq, day: "2026-10-17" };
      },
      async putBlob() {
        return {};
      },
    };
    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, "tenant-smoke"), agent: { id: "procmem-hosted-e2e-smoke" }, flushIntervalMs: 0 });
    const session = recorder.begin({ objective: "[SYNTHETIC SMOKE FIXTURE] test", sessionId: "smoke-e2e-test", metadata: { synthetic: true, fixture: FIXTURE_ID } });
    recordSyntheticFixture(session, "test", "[SYNTHETIC SMOKE FIXTURE] test");
    const result = await session.finish({ status: "succeeded", summary: "[SYNTHETIC] done" });
    expect(result.errors).toEqual([]);
    const events = chunks.flatMap((c) => c.events);
    const types = new Set(events.map((e) => e.type));
    for (const t of ["session_start", "model_input", "model_output", "tool_call", "tool_result", "error", "note", "session_end"]) expect(types.has(t as never)).toBe(true);
    const payments = events.filter((e) => e.type === "tool_call" && (e.data as { name: string }).name === "post_payment");
    expect(new Set(payments.map((e) => JSON.stringify((e.data as { arguments: unknown }).arguments))).size).toBe(1); // same idempotency key on every retry
    expect(chunks.at(-1)?.final).toBe(true);
  });
});
