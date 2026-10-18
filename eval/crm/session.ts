/**
 * One REAL customer Pi session (Fireworks model, Pi catalog transport) whose tools come ONLY from the procmem SDK
 * LiveToolRegistry against the local parent (memory MCP + subject-bound integration catalog). Every attempt is
 * captured with the SDK (beginPiTrace: explicit stable conversationId, one runId per attempt, previousRunId on
 * retries) and delivered over HTTP to the parent's trace route in the given trace namespace.
 * Scoring never uses this module's live previews: the runner reads back the STORED trace (full blobs) and the
 * fixture state.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createFireworksRuntime, resolveFireworksModel } from "../pi-agent.js";
import { resolveModelId } from "../fireworks.js";
import { beginPiTrace, HttpTraceTransport, TraceRecorder } from "../../src/sdk/index.js";
import { LiveToolRegistry } from "../../src/sdk/live/index.js";
import { createPiLiveTools } from "../../src/sdk/live/pi.js";
import { readBlob } from "../../src/traces/ingest.js";
import type { ObjectStore } from "../../src/store/objects.js";
import { sha256, scrub, UsageMeter, type LiveLog, type Status } from "./infra.js";
import { SYSTEM_PROMPT, type ModelAlias } from "./scenarios.js";

export interface AttemptLimits {
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface AttemptResult {
  attempt: number;
  runId: string;
  traceSessionId: string;
  stoppedBy: "completed" | "max-turns" | "max-tool-calls" | "timeout" | "error" | "budget";
  error?: string;
  turns: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  usage: { input: number; output: number; cacheRead: number; piCostEstimateUsd: number; requests: number };
  latencyMs: number;
  /** FULL final assistant text (graded in full; reports render a bounded preview). */
  finalText: string;
  finalTextSha256: string;
  traceDelivery: { events: number; chunks: number; errors: number };
}

export interface CustomerSession {
  piSessionId: string;
  conversationId: string;
  agentId: string;
  activeTools(): string[];
  toolSchemas(): Array<{ name: string; fingerprint: string }>;
  /** sha256 of the model-visible tool surface normalized across ports: name/description/inputSchema/annotations (no mcpUrl/deployment). */
  normalizedToolSchemaSha256(): string;
  messagesPrefixHash(n?: number): { count: number; sha256: string };
  attempt(n: number, prompt: string, limits: AttemptLimits, outcome: (r: Omit<AttemptResult, "traceDelivery">) => Promise<{ status: "succeeded" | "failed" | "partial"; summary: string; details?: unknown }>): Promise<AttemptResult>;
  registry: LiveToolRegistry;
  applyNow(): void;
  dispose(): Promise<void>;
  session: AgentSession;
}

export async function openCustomerSession(p: {
  apiKey: string;
  model: ModelAlias;
  parentBaseUrl: string;
  credential: string;
  traceBaseUrl: string;
  traceToken: string;
  agentId: string;
  displayName: string;
  conversationId: string;
  runIdBase: string;
  metadata: Record<string, unknown>;
  expectTools: string[];
  pollIntervalMs: number;
  live: LiveLog;
  meter: UsageMeter;
  onToolsChanged?: (c: { version: number; added: string[]; updated: string[]; removed: string[] }) => void;
}): Promise<CustomerSession> {
  const toolEvents: unknown[] = [];
  const registry = new LiveToolRegistry({
    parent: { baseUrl: p.parentBaseUrl, credential: () => p.credential, allowInsecureLocalhost: true },
    pollIntervalMs: p.pollIntervalMs,
    callTimeoutMs: 60_000,
    onLog: (e) => toolEvents.push(e),
    clientName: `crm-bench-${p.agentId}`.slice(0, 60),
  });
  registry.onToolsChanged((c) => {
    const ev = { version: c.next.version, added: c.added.map((t) => t.name), updated: c.updated.map((t) => t.name), removed: c.removed.map((t) => t.name) };
    p.onToolsChanged?.(ev);
  });
  await registry.start();
  const deadline = Date.now() + 90_000;
  while (!p.expectTools.every((n) => registry.getTools().some((t) => t.name === n))) {
    if (Date.now() > deadline) {
      const have = registry.getTools().map((t) => t.name);
      await registry.dispose();
      throw new Error(`SDK registry did not expose expected tools within 90s; missing ${p.expectTools.filter((n) => !have.includes(n)).join(", ")}; log ${scrub(JSON.stringify(toolEvents.slice(-5)))}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    await registry.refresh({ force: true });
  }
  const live = createPiLiveTools(registry);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crm-pi-"));
  const runtime = await createFireworksRuntime(p.apiKey);
  const model = resolveFireworksModel(runtime, p.model, "catalog");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: SYSTEM_PROMPT, extensionFactories: [live.extension] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, thinkingLevel: "low", modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(dir), settingsManager, noTools: "builtin" });
  await session.bindExtensions({});
  const piSessionId = session.sessionId;
  const recorder = new TraceRecorder({ transport: new HttpTraceTransport({ baseUrl: p.traceBaseUrl, token: p.traceToken }), agent: { id: p.agentId, name: p.displayName.slice(0, 120), model: resolveModelId(p.model), harness: "pi@1.3" }, flushIntervalMs: 2000 });
  p.live.setAgent(p.agentId, { name: p.displayName, role: "customer", status: "waiting", model: resolveModelId(p.model) });

  // per-attempt mutable counters (reset in attempt())
  let cur: { turns: number; toolCalls: number; byName: Record<string, number>; usage: AttemptResult["usage"]; stop: (why: AttemptResult["stoppedBy"]) => void; limits: AttemptLimits; error?: string } | null = null;
  session.subscribe((event) => {
    const e = event as unknown as Record<string, unknown> & { type: string };
    const at = new Date().toISOString();
    if (e.type === "agent_start") {
      p.live.setAgent(p.agentId, { status: "running" });
      p.live.emit({ at, agentId: p.agentId, kind: "turn_start", title: "Pi agent run started", status: "running" });
    } else if (e.type === "agent_end") {
      p.live.setAgent(p.agentId, { status: "waiting" });
      p.live.emit({ at, agentId: p.agentId, kind: "turn_end", title: "Pi agent run ended (session idle)", status: "waiting" });
    } else if (e.type === "turn_end" && cur) {
      cur.turns += 1;
      if (cur.turns >= cur.limits.maxTurns) cur.stop("max-turns");
    } else if (e.type === "message_end") {
      const m = e.message as { role: string; content?: Array<Record<string, unknown>> | string; usage?: Record<string, unknown>; stopReason?: string; errorMessage?: string };
      const content = Array.isArray(m.content) ? m.content : [];
      if (m.role === "assistant") {
        const u = (m.usage ?? {}) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
        p.meter.add({ input: (u.input ?? 0) + (u.cacheWrite ?? 0), output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cost: u.cost?.total ?? null });
        if (cur) {
          cur.usage.input += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          cur.usage.cacheRead += u.cacheRead ?? 0;
          cur.usage.output += u.output ?? 0;
          cur.usage.piCostEstimateUsd += u.cost?.total ?? 0;
          cur.usage.requests += 1;
          if (m.stopReason === "error" && m.errorMessage) cur.error = scrub(m.errorMessage).slice(0, 500);
          if (p.meter.exceeded()) cur.stop("budget");
        }
        const text = content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("").trim();
        if (text) p.live.emit({ at, agentId: p.agentId, kind: "message", title: "assistant", text });
      } else if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content : content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
        p.live.emit({ at, agentId: p.agentId, kind: "message", title: "user prompt", text });
      }
    } else if (e.type === "tool_execution_start") {
      if (cur) {
        cur.toolCalls += 1;
        cur.byName[String(e.toolName)] = (cur.byName[String(e.toolName)] ?? 0) + 1;
        if (cur.toolCalls > cur.limits.maxToolCalls) cur.stop("max-tool-calls");
      }
      p.live.emit({ at, agentId: p.agentId, kind: "tool_call", title: String(e.toolName), status: "running", data: { callId: e.toolCallId, tool: e.toolName, args: e.args } });
    } else if (e.type === "tool_execution_end") {
      const result = e.result as { content?: Array<{ type: string; text?: string }> } | undefined;
      const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      p.live.emit({ at, agentId: p.agentId, kind: "tool_result", title: `${String(e.toolName)}${e.isError ? " (error)" : ""}`, status: e.isError ? "failed" : "succeeded", text, data: { callId: e.toolCallId, tool: e.toolName } });
    }
  });

  const messages = () => session.agent.state.messages as unknown[];
  let prevRunId: string | undefined;
  return {
    piSessionId,
    conversationId: p.conversationId,
    agentId: p.agentId,
    registry,
    session,
    applyNow: () => void live.applyNow(),
    activeTools: () => session.getActiveToolNames().slice().sort(),
    normalizedToolSchemaSha256: () => sha256(JSON.stringify(registry.getTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations ?? null })).sort((a, b) => a.name.localeCompare(b.name)))),
    toolSchemas: () => registry.getTools().map((t) => ({ name: t.name, fingerprint: t.fingerprint })).sort((a, b) => a.name.localeCompare(b.name)),
    messagesPrefixHash: (n?: number) => {
      const all = messages();
      const k = n ?? all.length;
      return { count: k, sha256: sha256(JSON.stringify(all.slice(0, k))) };
    },
    async attempt(n, prompt, limits, outcome) {
      const runId = `${p.runIdBase}.a${n}`;
      const started = Date.now();
      let stoppedBy: AttemptResult["stoppedBy"] = "completed";
      const s = session;
      cur = {
        turns: 0,
        toolCalls: 0,
        byName: {},
        usage: { input: 0, output: 0, cacheRead: 0, piCostEstimateUsd: 0, requests: 0 },
        limits,
        stop: (why) => {
          if (stoppedBy === "completed") stoppedBy = why;
          void s.abort().catch(() => {});
        },
      };
      const c = cur;
      p.live.setAgent(p.agentId, { task: { attempt: n, status: "running", startedAt: new Date().toISOString() } });
      p.live.emit({ agentId: p.agentId, kind: "task_start", title: `task attempt ${n} started`, status: "running", data: { attempt: n, runId, conversationId: p.conversationId } });
      const traceSessionId = `${p.runIdBase}-a${n}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 96);
      const { trace, detach } = beginPiTrace(recorder, session, { objective: prompt, sessionId: traceSessionId, metadata: { ...p.metadata, attempt: n, piSessionId }, conversationId: p.conversationId, runId, ...(prevRunId ? { previousRunId: prevRunId } : {}) });
      prevRunId = runId;
      const timer = setTimeout(() => c.stop("timeout"), limits.timeoutMs);
      try {
        p.meter.check();
        await session.prompt(prompt);
        await session.waitForIdle().catch(() => {});
      } catch (err) {
        c.error = scrub(String((err as Error)?.message ?? err)).slice(0, 500);
        if (stoppedBy === "completed") stoppedBy = err instanceof Error && err.name === "BudgetExceeded" ? "budget" : "error";
      } finally {
        clearTimeout(timer);
      }
      if (c.error && stoppedBy === "completed") stoppedBy = "error";
      detach();
      const finalText = session.getLastAssistantText() ?? "";
      const partial: Omit<AttemptResult, "traceDelivery"> = { attempt: n, runId, traceSessionId, stoppedBy, ...(c.error ? { error: c.error } : {}), turns: c.turns, toolCalls: c.toolCalls, toolCallsByName: c.byName, usage: c.usage, latencyMs: Date.now() - started, finalText, finalTextSha256: sha256(finalText) };
      const o = await outcome(partial);
      const fin = await trace.finish({ status: o.status, summary: o.summary.slice(0, 2000), ...(o.details !== undefined ? { evidence: { source: "client-reported" as const, details: o.details } } : {}) });
      const status: Status = o.status === "succeeded" ? "succeeded" : o.status === "partial" ? "partial" : "failed";
      p.live.setAgent(p.agentId, { task: { attempt: n, status, finishedAt: new Date().toISOString() } });
      p.live.emit({ agentId: p.agentId, kind: "task_end", title: `task attempt ${n} ${status}`, status, data: { attempt: n, stoppedBy, summary: o.summary } });
      cur = null;
      return { ...partial, traceDelivery: { events: fin.events, chunks: fin.chunks, errors: fin.errors.length } };
    },
    async dispose() {
      live.dispose();
      session.dispose();
      await registry.dispose().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// ------------------------------------------------------------------ stored-trace readback (scoring input)
export interface StoredTraceSummary {
  sessionId: string;
  chunks: number;
  events: number;
  eventTypes: Record<string, number>;
  /** Stored create-once session binding (trace-sessions/<sid>.json), verified against the expected correlation. */
  binding: { correlation: unknown; legacy: boolean; day: string } | null;
  correlationCheck: { ok: boolean; problems: string[] };
  /** seq 1..N contiguous, session_start first, session_end last */
  sequenceComplete: boolean;
  turnIds: string[];
  /** every $blob reference across ALL event types, resolved + digest-verified */
  blobs: Array<{ sha256: string; bytes: number; eventType: string }>;
  blobsResolved: number;
  modelInputHasSystemPrompt: boolean;
  modelInputHasToolSchemas: boolean;
  toolCalls: Array<{ callId: string; name: string; args: unknown; isError: boolean | null; resultSha256: string | null; httpStatus: number | null; requestId: string | null; spanId: string | null }>;
  memoryPagesRead: string[];
  memoryReadBytes: number;
  /** first 600 chars of every memory__open_memory result (carries the pinned revision id) */
  memoryOpenResults: string[];
  modelRequests: number;
  usage: { input: number; output: number; cacheRead: number };
  /** sha256 over the stored chunk object digests (content address of the scored trace) */
  contentSha256: string;
}

/**
 * Read a session's stored chunks + its stored correlation binding from the parent store; resolve and digest-verify
 * EVERY blob of every event type (model_input/model_output included). Throws if nothing is stored.
 */
export async function loadStoredTrace(store: ObjectStore, ns: string, sessionId: string, expect: { conversationId: string; runId: string; previousRunId?: string; systemPromptMarker: string; toolNames: string[] }): Promise<StoredTraceSummary> {
  const keys = (await store.list(ns, "traces/", { limit: 10_000 })).filter((k) => k.includes(`/${sessionId}/`) && k.endsWith(".jsonl.gz")).sort();
  if (keys.length === 0) throw new Error(`no stored trace chunks for ${sessionId} in ${ns}`);
  const got = await store.get(ns, keys);
  const events: Array<Record<string, unknown>> = [];
  for (const k of keys) for (const line of gunzipSync(got.get(k)!).toString("utf8").split("\n")) if (line) events.push(JSON.parse(line));
  events.sort((a, b) => Number(a.seq) - Number(b.seq));
  const bindingKey = `trace-sessions/${sessionId}.json`;
  const bRaw = (await store.get(ns, [bindingKey])).get(bindingKey);
  const binding = bRaw ? (JSON.parse(bRaw.toString("utf8")) as { correlation: { conversationId?: string; runId?: string; previousRunId?: string; conversationSource?: string } | null; legacy: boolean; day: string }) : null;
  const problems: string[] = [];
  if (!binding) problems.push("no stored session binding");
  else if (!binding.correlation) problems.push("binding has no correlation (legacy)");
  else {
    if (binding.correlation.conversationId !== expect.conversationId) problems.push(`conversationId ${binding.correlation.conversationId} != ${expect.conversationId}`);
    if (binding.correlation.runId !== expect.runId) problems.push(`runId ${binding.correlation.runId} != ${expect.runId}`);
    if ((binding.correlation.previousRunId ?? undefined) !== expect.previousRunId) problems.push(`previousRunId ${binding.correlation.previousRunId} != ${expect.previousRunId}`);
  }
  const blobs: StoredTraceSummary["blobs"] = [];
  const resolve = async (data: unknown, eventType: string): Promise<unknown> => {
    if (data && typeof data === "object" && "$blob" in (data as object)) {
      const ref = data as { $blob: string; mediaType?: string };
      const bytes = await readBlob(store, ns, ref.$blob);
      if (!bytes) throw new Error(`blob ${ref.$blob} missing for ${sessionId}`);
      blobs.push({ sha256: ref.$blob, bytes: bytes.length, eventType });
      const text = /gzip/.test(ref.mediaType ?? "") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return data;
  };
  const calls = new Map<string, StoredTraceSummary["toolCalls"][number]>();
  const turnIds = new Set<string>();
  const s: StoredTraceSummary = { sessionId, chunks: keys.length, events: events.length, eventTypes: {}, binding: binding ? { correlation: binding.correlation, legacy: binding.legacy, day: binding.day } : null, correlationCheck: { ok: false, problems }, sequenceComplete: false, turnIds: [], blobs, blobsResolved: 0, modelInputHasSystemPrompt: false, modelInputHasToolSchemas: false, toolCalls: [], memoryPagesRead: [], memoryReadBytes: 0, memoryOpenResults: [], modelRequests: 0, usage: { input: 0, output: 0, cacheRead: 0 }, contentSha256: "" };
  s.sequenceComplete = events.every((e, i) => Number(e.seq) === i + 1) && events[0]?.type === "session_start" && events[events.length - 1]?.type === "session_end";
  for (const e of events) {
    const type = String(e.type);
    s.eventTypes[type] = (s.eventTypes[type] ?? 0) + 1;
    if (typeof e.turnId === "string") turnIds.add(e.turnId);
    const u = e.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined;
    if (u) {
      s.usage.input += u.inputTokens ?? 0;
      s.usage.output += u.outputTokens ?? 0;
      s.usage.cacheRead += u.cacheReadTokens ?? 0;
    }
    const data = await resolve(e.data, type);
    if (type === "model_output") s.modelRequests += 1;
    if (type === "model_input") {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      if (text.includes(expect.systemPromptMarker)) s.modelInputHasSystemPrompt = true;
      if (expect.toolNames.length && expect.toolNames.every((n) => text.includes(n))) s.modelInputHasToolSchemas = true;
    } else if (type === "tool_call") {
      const d = data as { name?: string; arguments?: unknown; callId?: string };
      const callId = String(d.callId ?? "");
      calls.set(callId, { callId, name: String(d.name ?? ""), args: d.arguments ?? null, isError: null, resultSha256: null, httpStatus: null, requestId: null, spanId: typeof e.spanId === "string" ? e.spanId : null });
    } else if (type === "tool_result") {
      const d = data as { name?: string; callId?: string; isError?: boolean; result?: { content?: Array<{ type: string; text?: string }>; details?: unknown } };
      const callId = String(d.callId ?? "");
      const c = calls.get(callId) ?? { callId, name: String(d.name ?? ""), args: null, isError: null, resultSha256: null, httpStatus: null, requestId: null, spanId: null };
      c.isError = d.isError === true;
      const text = (d.result?.content ?? []).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n");
      c.resultSha256 = sha256(JSON.stringify(d.result ?? null));
      const m = /"http_status":\s*(\d{3})/.exec(text);
      if (m) c.httpStatus = Number(m[1]);
      const rid = /"request_id":\s*"([^"]+)"/.exec(text);
      if (rid) c.requestId = rid[1]!;
      if (c.name === "memory__open_memory") s.memoryOpenResults.push(text.slice(0, 600));
      if (c.name === "memory__read" || c.name === "memory__view_file") {
        const args = c.args as { path?: string } | null;
        if (args?.path) s.memoryPagesRead.push(args.path);
        s.memoryReadBytes += text.length;
      }
      calls.set(callId, c);
    }
  }
  s.blobsResolved = blobs.length;
  s.turnIds = [...turnIds];
  s.toolCalls = [...calls.values()];
  s.correlationCheck.ok = problems.length === 0;
  s.contentSha256 = sha256(keys.map((k) => sha256(got.get(k)!)).join(","));
  return s;
}
