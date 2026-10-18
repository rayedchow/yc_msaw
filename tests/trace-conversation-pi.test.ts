/**
 * Pi trace correlation on the REAL installed Pi 1.3 agent loop, driven by Pi's FAUX provider (scripted model):
 * one turnId per user prompt (kept across automatic retry and context-overflow continuation, which re-emit
 * agent_start without a new user message), model-request spans, and tool spans matched by toolCallId.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { attachPiTraceCapture, beginPiTrace, TraceRecorder, type TraceTransport } from "../src/sdk/index.js";
import type { TraceChunk, TraceEvent } from "../src/traces/schema.js";

const faux = fauxProvider({ models: [{ id: "scripted-faux", contextWindow: 200_000 }] });
let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

class Capture implements TraceTransport {
  chunks: TraceChunk[] = [];
  async sendChunk(chunk: TraceChunk) {
    this.chunks.push(JSON.parse(JSON.stringify(chunk)) as TraceChunk);
    return { status: "created" as const, sessionId: chunk.sessionId, chunkSeq: chunk.chunkSeq };
  }
  async putBlob() {}
  get events(): TraceEvent[] {
    return this.chunks.flatMap((c) => c.events);
  }
}

async function piSession(): Promise<AgentSession> {
  dir = await mkdtemp(join(tmpdir(), "procmem-pi-turns-"));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.provider.id, "faux-not-a-secret").catch(() => undefined);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Scripted test agent." });
  await resourceLoader.reload();
  const lookup = defineTool({
    name: "lookup",
    label: "Lookup",
    description: "Look something up.",
    parameters: Type.Object({ q: Type.String() }),
    execute: async (_id, params) => ({ content: [{ type: "text" as const, text: `found ${params.q}` }], details: undefined }),
  });
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: faux.getModel() as never, modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(dir), settingsManager, customTools: [lookup], noTools: "builtin" });
  await session.bindExtensions({});
  return session;
}

const call = (calls: Array<[string, string]>) => fauxAssistantMessage(calls.map(([q, id]) => fauxToolCall("lookup", { q }, { id })), { stopReason: "toolUse" });
const done = (t = "done") => fauxAssistantMessage([fauxText(t)]);
const failed = (errorMessage: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage });

describe("Pi turns and spans on the real agent loop", () => {
  it("one turnId per user prompt across the tool loop; parallel same-name tool calls get distinct spans parented by id", async () => {
    const session = await piSession();
    const cap = new Capture();
    const { trace, detach } = beginPiTrace(new TraceRecorder({ transport: cap, agent: { id: "pi" }, flushIntervalMs: 0 }), session, { objective: "turns" });
    expect(trace.correlation).toMatchObject({ conversationId: `pi:${session.sessionId}`, conversationSource: "harness" });
    faux.setResponses([call([["a", "call_A"], ["a", "call_B"]]), done()]);
    await session.prompt("look up a twice");
    faux.setResponses([done("second")]);
    await session.prompt("again");
    detach();
    await trace.finish({ status: "succeeded", summary: "ok" });
    const events = cap.events;
    const users = events.filter((e) => e.type === "model_input" && (e.data as { role?: string } | null)?.role === "user");
    expect(users).toHaveLength(2);
    const [t1, t2] = users.map((u) => u.turnId!);
    expect(t1).toBeTruthy();
    expect(t1).not.toBe(t2);
    const requests = events.filter((e) => (e.data as { kind?: string } | null)?.kind === "llm_request");
    expect(requests.map((r) => r.turnId)).toEqual([t1, t1, t2]); // two model round trips, ONE user turn
    expect(new Set(requests.map((r) => r.spanId)).size).toBe(3);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.map((t) => t.spanId)).toEqual(["tool.call_A", "tool.call_B"]);
    expect(toolCalls.every((t) => t.parentSpanId === requests[0]!.spanId && t.turnId === t1)).toBe(true);
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((r) => [r.spanId, r.parentSpanId])).toEqual([["tool.call_A", requests[0]!.spanId], ["tool.call_B", requests[0]!.spanId]]);
    session.dispose();
  });

  it("a queued follow-up user message is a new user turn even inside the same agent run", async () => {
    const session = await piSession();
    const cap = new Capture();
    const trace = new TraceRecorder({ transport: cap, agent: { id: "pi" }, flushIntervalMs: 0 }).begin({ objective: "followup" });
    const detach = attachPiTraceCapture(session, trace);
    faux.setResponses([
      async () => {
        await session.followUp("and also check b");
        return done("first answer");
      },
      done("follow-up answer"),
    ]);
    await session.prompt("check a");
    detach();
    await trace.finish({ status: "succeeded", summary: "ok" });
    const events = cap.events;
    const users = events.filter((e) => e.type === "model_input" && (e.data as { role?: string } | null)?.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0]!.turnId).not.toBe(users[1]!.turnId);
    const requests = events.filter((e) => (e.data as { kind?: string } | null)?.kind === "llm_request");
    expect(requests.map((r) => r.turnId)).toEqual([users[0]!.turnId, users[1]!.turnId]);
    session.dispose();
  });

  it("automatic retry (agent_start without a new user message) stays in the same user turn", async () => {
    const session = await piSession();
    const cap = new Capture();
    const trace = new TraceRecorder({ transport: cap, agent: { id: "pi" }, flushIntervalMs: 0 }).begin({ objective: "retry" });
    const detach = attachPiTraceCapture(session, trace);
    faux.setResponses([failed("503 overloaded, please retry"), done("recovered")]);
    await session.prompt("do it");
    detach();
    await trace.finish({ status: "succeeded", summary: "ok" });
    const events = cap.events;
    const notes = events.filter((e) => e.type === "note").map((e) => (e.data as { pi?: string } | null)?.pi);
    expect(notes).toContain("auto_retry_start");
    expect(notes.filter((n) => n === "agent_start").length).toBeGreaterThanOrEqual(2); // the real loop re-entered
    const users = events.filter((e) => e.type === "model_input" && (e.data as { role?: string } | null)?.role === "user");
    expect(users).toHaveLength(1);
    const requests = events.filter((e) => (e.data as { kind?: string } | null)?.kind === "llm_request");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(requests.map((r) => r.turnId))).toEqual(new Set([users[0]!.turnId]));
    session.dispose();
  });

  it("context-overflow continuation (compaction + agent.continue) stays in the same user turn", async () => {
    const session = await piSession();
    const cap = new Capture();
    const trace = new TraceRecorder({ transport: cap, agent: { id: "pi" }, flushIntervalMs: 0 }).begin({ objective: "overflow" });
    const detach = attachPiTraceCapture(session, trace);
    faux.setResponses([done("warm up")]);
    await session.prompt("first prompt with some context");
    faux.setResponses([failed("prompt is too long: 250000 tokens > 200000 maximum"), done("summary of the conversation so far"), done("continued after compaction"), done("spare")]);
    await session.prompt("second prompt");
    detach();
    await trace.finish({ status: "succeeded", summary: "ok" });
    const events = cap.events;
    const notes = events.filter((e) => e.type === "note").map((e) => (e.data as { pi?: string } | null)?.pi);
    if (process.env.DEBUG_PI) console.log(JSON.stringify(events.map((e) => [e.type, (e.data as any)?.pi ?? (e.data as any)?.kind ?? (e.data as any)?.role, (e.data as any)?.message?.stopReason, (e.data as any)?.message?.errorMessage, e.turnId])));
    expect(notes).toContain("compaction_start");
    const users = events.filter((e) => e.type === "model_input" && (e.data as { role?: string } | null)?.role === "user");
    const t2 = users.at(-1)!.turnId!;
    const afterSecond = events.slice(events.indexOf(users.at(-1)!));
    const requests = afterSecond.filter((e) => (e.data as { kind?: string } | null)?.kind === "llm_request");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every((r) => r.turnId === t2)).toBe(true);
    expect(users[0]!.turnId).not.toBe(t2);
    session.dispose();
  });
});
