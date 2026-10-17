import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { attachPiTraceCapture, InProcessTraceTransport, TraceRecorder } from "../src/sdk/index.js";
import { TraceIngestor, type TraceEvent } from "../src/traces/index.js";

const NS = "tenant-pi";
let root: string;
let ingestor: TraceIngestor;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sdk-pi-"));
  ingestor = new TraceIngestor(new DirectoryObjectStore(path.join(root, "store")), { now: () => new Date("2026-10-17T12:00:00Z") });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storedEvents(sessionId: string): Promise<TraceEvent[]> {
  const out: TraceEvent[] = [];
  for (const key of await ingestor.listDay(NS, "2026-10-17")) if (key.includes(`/${sessionId}/`)) out.push(...(await ingestor.readChunk(NS, key)).events);
  return out.sort((a, b) => a.seq - b.seq);
}

describe("Pi adapter against a real Pi AgentSession (faux provider)", () => {
  it("captures the full per-request system prompt, tool schemas and messages, minus credentials", async () => {
    const faux = fauxProvider({ provider: "trace-faux", models: [{ id: "faux-model" }] });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("lookup_order", { orderId: "o-42" }, { id: "call-1" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("order o-42 shipped"))]);

    const lookup = defineTool({
      name: "lookup_order",
      label: "Lookup order",
      description: "Look up an order by id",
      parameters: Type.Object({ orderId: Type.String({ description: "Order id" }) }),
      async execute(_id, params) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ orderId: params.orderId, status: "shipped" }) }], details: undefined };
      },
    });
    const dir = path.join(root, "pi");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "SYSTEM-PROMPT-MARKER: you are an order support agent.",
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      model: faux.getModel(),
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
      customTools: [lookup],
      tools: ["lookup_order"],
    });

    const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, NS), agent: { id: "pi-agent", harness: "pi" }, flushIntervalMs: 0 });
    const ts = recorder.begin({ objective: "where is order o-42", sessionId: "ses-pi-real" });
    const originalStream = session.agent.streamFunction;
    const originalPayload = session.agent.onPayload;
    const detach = attachPiTraceCapture(session, ts);
    expect(session.agent.streamFunction).not.toBe(originalStream);
    try {
      await session.prompt("Where is order o-42?");
      // Provider wire payloads flow through agent.onPayload (faux has no wire format, so drive the hook directly).
      await session.agent.onPayload!({ model: "faux-model", api_key: "sk-secret", messages: [{ role: "user", content: "hi" }] }, faux.getModel());
    } finally {
      detach();
      expect(session.agent.streamFunction).toBe(originalStream);
      expect(session.agent.onPayload).toBe(originalPayload);
      session.dispose();
    }
    await ts.finish({ status: "succeeded", summary: "answered" });

    const events = await storedEvents("ses-pi-real");
    const requests = events.filter((e) => e.type === "model_input" && (e.data as { kind?: string }).kind === "llm_request");
    expect(requests).toHaveLength(2);
    const first = requests[0]!.data as Record<string, any>;
    expect(first.model).toMatchObject({ provider: "trace-faux", id: "faux-model" });
    expect(first.system.text).toContain("SYSTEM-PROMPT-MARKER");
    expect(Object.values(first.system.sections).join("\n")).toContain("SYSTEM-PROMPT-MARKER");
    expect(first.tools.map((t: { name: string }) => t.name)).toContain("lookup_order");
    const tool = first.tools.find((t: { name: string }) => t.name === "lookup_order");
    expect(tool.parameters.properties.orderId).toMatchObject({ type: "string", description: "Order id" });
    expect(first.messages.some((m: { role: string }) => m.role === "system")).toBe(true);
    expect(JSON.stringify(first.messages)).toContain("Where is order o-42?");
    expect(first.options).not.toHaveProperty("signal");
    expect(JSON.stringify(first)).not.toMatch(/sk-secret/);
    // Second request carries the tool call and its result as actually sent to the model.
    const second = requests[1]!.data as Record<string, any>;
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(expect.arrayContaining(["user", "assistant", "toolResult"]));
    expect(JSON.stringify(second.messages)).toContain("shipped");
    expect(requests[0]!.agent.model).toBe("trace-faux/faux-model");

    const payload = events.find((e) => (e.data as { kind?: string }).kind === "provider_payload")!;
    expect((payload.data as Record<string, any>).payload).toEqual({ model: "faux-model", api_key: "[REDACTED]", messages: [{ role: "user", content: "hi" }] });

    expect(events.filter((e) => e.type === "tool_call").map((e) => e.data)).toEqual([{ name: "lookup_order", callId: "call-1", arguments: { orderId: "o-42" } }]);
    expect(events.filter((e) => e.type === "model_output")).toHaveLength(2);
  });
});
