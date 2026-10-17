/**
 * LIVE MODEL, SIMULATED UPSTREAM: real Fireworks models (Kimi K3 / GLM 5p3 / MiniMax M3) in ONE Pi 1.3 session each,
 * with tools supplied by the live-tools SDK (createPiLiveTools) AND trace capture (attachPiTraceCapture) attached.
 *
 *   npx tsx scripts/sdk-live-tools-pi-live.ts [kimi|glm|minimax ...]     # default: all three
 *
 * Parent: the real procmem app on loopback (real /mcp memory + /v1/integrations auth/routes; catalog contents scripted).
 * Children: SIMULATED integration MCPs (official MCP server SDK on 127.0.0.1) with real EdDSA child tokens.
 * Per model, in the same session without restart:
 *   1. call a child tool present at start          (orders.lookup_order)
 *   2. a NEW child is published -> model calls it     (billing.get_invoice)
 *   3. a child tool's schema CHANGES (adds required region) -> model calls it with the new argument
 *   4. a child is REMOVED -> tool leaves Pi's active set; the child receives no further calls
 * Pass/fail is decided by host-side checks (child call counters, arguments received, Pi active set), not by the model.
 * Report: reports/sdk-live-tools-pi-live.json (no credentials).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createFireworksRuntime, resolveFireworksModel } from "../eval/pi-agent.js";
import { loadFireworksKey, resolveModelId } from "../eval/fireworks.js";
import { InProcessTraceTransport, TraceRecorder } from "../src/sdk/index.js";
import { attachPiTraceCapture } from "../src/sdk/pi-adapter.js";
import { LiveToolRegistry } from "../src/sdk/live/index.js";
import { createPiLiveTools } from "../src/sdk/live/pi.js";
import { LoopbackParent, type SimTool, type SimulatedChild } from "./sdk-live-tools-fixtures.js";

const SYSTEM = [
  "You are a customer operations agent. Use the tools you are given to answer; never invent data.",
  "Integration tools are named integration__<integration>__<tool>. The set of tools can change between requests; always use the tools available now.",
  "Answer briefly.",
].join("\n");

const lookupV1: SimTool = {
  tool: { name: "lookup_order", description: "Look up an order by id. Returns its shipping status.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Order id, e.g. o-1" } }, required: ["id"] }, annotations: { readOnlyHint: true } },
  handler: (a) => ({ content: [{ type: "text", text: `order ${String(a.id)}: status=shipped` }] }),
};
const lookupV2: SimTool = {
  tool: {
    name: "lookup_order",
    description: "Look up an order by id in a region (REQUIRED since v2). Returns its delivery status.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, region: { type: "string", enum: ["eu", "us"], description: "Fulfilment region" } }, required: ["id", "region"] },
    annotations: { readOnlyHint: true },
  },
  handler: (a) => ({ content: [{ type: "text", text: a.region ? `order ${String(a.id)} (${String(a.region)}): status=delivered` : "error: region is required" }], ...(a.region ? {} : { isError: true }) }),
};
const invoice: SimTool = {
  tool: { name: "get_invoice", description: "Get the invoice number for an order id.", inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] }, annotations: { readOnlyHint: true } },
  handler: (a) => ({ content: [{ type: "text", text: `invoice for ${String(a.order_id)}: INV-7781` }] }),
};

interface StepResult {
  step: string;
  ok: boolean;
  checks: Record<string, boolean>;
  activeLiveTools: string[];
  answerPreview: string;
  durationMs: number;
}

function lastAssistantText(session: AgentSession): string {
  const msgs = session.agent.state.messages as Array<{ role: string; content?: Array<{ type: string; text?: string }> }>;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant") return (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
  }
  return "";
}

async function runModel(alias: string, apiKey: string): Promise<Record<string, unknown>> {
  const parent = new LoopbackParent();
  await parent.start();
  const orders: SimulatedChild = await parent.child("orders", [lookupV1]);
  parent.publish(orders);
  let billing: SimulatedChild | null = null;
  const received: Array<{ tool: string; args: unknown }> = [];
  const wrap = (t: SimTool): SimTool => ({ ...t, handler: (a, c) => (received.push({ tool: t.tool.name, args: a }), t.handler(a, c)) });
  orders.setTools([wrap(lookupV1)]);

  const registry = new LiveToolRegistry({ parent: { baseUrl: parent.baseUrl, credential: () => parent.key.key, allowInsecureLocalhost: true }, pollIntervalMs: 60_000, listChangedDebounceMs: 50 });
  await registry.start();
  const applied: unknown[] = [];
  const live = createPiLiveTools(registry, { onApplied: (c) => applied.push({ added: c.added, updated: c.updated, removed: c.removed }) });
  const dir = await mkdtemp(join(tmpdir(), "procmem-live-pi-fw-"));
  const runtime = await createFireworksRuntime(apiKey);
  const model = resolveFireworksModel(runtime, alias, "openai");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: SYSTEM, extensionFactories: [live.extension] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, thinkingLevel: "low", modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(dir), settingsManager, noTools: "builtin" });
  await session.bindExtensions({});
  // Trace capture alongside live tools (in-process transport into the same parent's real ingestor).
  const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(parent.app.ingestor, parent.tenant), agent: { id: "sdk-live-tools-pi-live", model: resolveModelId(alias), harness: "pi" }, flushIntervalMs: 0 });
  const trace = recorder.begin({ objective: "live tools dynamic protocol cohort" });
  const detachTrace = attachPiTraceCapture(session, trace);

  const steps: StepResult[] = [];
  let traceSummary: { events: number; chunks: number; errors: number } | null = null;
  const liveActive = () => session.getActiveToolNames().filter((n) => n.startsWith("integration__"));
  const run = async (step: string, prompt: string, verify: () => Record<string, boolean>) => {
    const t0 = Date.now();
    let error: string | null = null;
    try {
      await session.prompt(prompt);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const checks = { promptCompleted: error === null, ...verify() };
    const r: StepResult = { step, ok: Object.values(checks).every(Boolean), checks, activeLiveTools: liveActive(), answerPreview: lastAssistantText(session).slice(0, 300), durationMs: Date.now() - t0 };
    steps.push(r);
    console.error(`[${alias}] ${r.ok ? "PASS" : "FAIL"} ${step} ${JSON.stringify(checks)}`);
  };

  try {
    const lookups = () => received.filter((x) => x.tool === "lookup_order").length;
    const invoices = () => received.filter((x) => x.tool === "get_invoice").length;

    let before = lookups();
    await run("1-initial-tool", "What is the shipping status of order o-1?", () => ({
      toolActiveAtStart: liveActive().includes("integration__orders__lookup_order"),
      childCalled: lookups() > before,
      answerMentionsShipped: /shipped/i.test(lastAssistantText(session)),
    }));

    billing = await parent.child("billing", [wrap(invoice)]);
    parent.publish(billing);
    await registry.refresh(); // idle session: the adapter applies immediately, no restart
    before = invoices();
    await run("2-added-tool", "What is the invoice number for order o-1?", () => ({
      newToolActive: session.getActiveToolNames().includes("integration__billing__get_invoice"),
      newChildCalled: invoices() > before,
      answerMentionsInvoice: /INV-7781/.test(lastAssistantText(session)),
    }));

    orders.setTools([wrap(lookupV2)]);
    parent.publish(orders, { deploymentId: "d2", commit: "c2" }); // a redeploy with a changed schema
    await registry.refresh();
    const schema = registry.getTools().find((t) => t.name === "integration__orders__lookup_order")?.inputSchema as { required?: string[] } | undefined;
    before = received.length;
    await run("3-changed-schema", "Check order o-1 again; it was fulfilled from the eu region. What is its status now?", () => {
      const newCalls = received.slice(before).filter((x) => x.tool === "lookup_order");
      return {
        registryHasNewSchema: schema?.required?.includes("region") === true,
        calledWithNewArgument: newCalls.some((x) => (x.args as { region?: string }).region === "eu"),
        answerMentionsDelivered: /delivered/i.test(lastAssistantText(session)),
      };
    });

    parent.unpublish("billing");
    await registry.refresh();
    before = invoices();
    await run("4-removed-tool", "Get the invoice number for order o-1 again. If you no longer have a tool for invoices, reply exactly: UNAVAILABLE.", () => ({
      removedFromActiveSet: !session.getActiveToolNames().includes("integration__billing__get_invoice"),
      removedChildNotCalled: invoices() === before,
      noInvoiceInvented: !/INV-7781/.test(lastAssistantText(session)) || /UNAVAILABLE/.test(lastAssistantText(session)),
    }));
  } finally {
    detachTrace();
    const fin = await trace.finish({ status: steps.every((s) => s.ok) ? "succeeded" : "failed", summary: "live tools cohort" }).catch(() => null);
    if (fin) traceSummary = { events: fin.events, chunks: fin.chunks, errors: fin.errors.length };
    live.dispose();
    session.dispose();
    await registry.dispose();
    await orders.close();
    await billing?.close();
    await parent.close();
    await rm(dir, { recursive: true, force: true });
    steps.length && console.error(`[${alias}] trace finished: ${fin ? "yes" : "no"}`);
  }
  return {
    model: resolveModelId(alias),
    ok: steps.length === 4 && steps.every((s) => s.ok),
    steps,
    adapterApplied: applied,
    childArgumentsReceived: received,
    traceCapture: traceSummary,
    recorderErrors: recorder.errors.length,
  };
}

async function main(): Promise<void> {
  const aliases = process.argv.slice(2).length ? process.argv.slice(2) : ["kimi", "glm", "minimax"];
  const apiKey = await loadFireworksKey(".env");
  const results: Record<string, unknown>[] = [];
  for (const a of aliases) {
    try {
      results.push(await runModel(a, apiKey));
    } catch (error) {
      results.push({ model: resolveModelId(a), ok: false, error: (error instanceof Error ? error.message : String(error)).replace(apiKey, "[REDACTED]") });
    }
  }
  const report = {
    kind: "sdk-live-tools-pi-live",
    labels: {
      model: "LIVE: real Fireworks models via Pi 1.3 (openai-completions transport)",
      parent: "REAL procmem app on loopback (memory /mcp, /v1/integrations routes, static-key auth); catalog contents scripted by the host",
      upstream: "SIMULATED child integration MCPs (official MCP server SDK on 127.0.0.1) with real EdDSA child tokens",
      oracle: "host-side checks (child call counters/arguments, Pi active set); model text only as a secondary check",
    },
    at: new Date().toISOString(),
    ok: results.every((r) => r.ok === true),
    results,
  };
  const out = JSON.stringify(report, null, 2);
  if (out.includes(apiKey) || /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(out)) throw new Error("report contains a credential; refusing to write it");
  await writeFile("reports/sdk-live-tools-pi-live.json", `${out}\n`);
  console.error(`report: reports/sdk-live-tools-pi-live.json ok=${String(report.ok)}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`sdk-live-tools-pi-live failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
