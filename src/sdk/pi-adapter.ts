import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { CONVERSATION_ID_RE, TRACE_ID_RE, type TraceUsage } from "../traces/schema.js";
import type { BeginOptions, TraceRecorder, TraceSession } from "./recorder.js";

/**
 * Capture adapter for the Pi coding agent SDK (@earendil-works/pi-coding-agent).
 * Type-only imports: the SDK has no runtime dependency on Pi.
 *
 * Mapping (full payloads, no summarizing):
 *  - every model request (wraps session.agent.streamFunction)
 *                                             -> model_input {kind:"llm_request", model, system, tools, messages, options}:
 *                                                the exact transformed/compacted transcript sent to the provider, including
 *                                                system messages (prompt + sections) and full tool specs/JSON schemas
 *  - every provider wire payload (wraps session.agent.onPayload, after extension before_provider_request transforms)
 *                                             -> model_input {kind:"provider_payload", model, payload}
 *    Credentials are never recorded: apiKey/authorization/cookie/token/secret-like option keys and headers become
 *    "[REDACTED]", env values are dropped (names kept), and non-serializable options (functions, AbortSignal) are listed
 *    by name in `omittedOptions`. Message and tool content is recorded verbatim.
 *  - message_end user/system/custom message  -> model_input {kind:"message", role, message}
 *  - message_end toolResult message          -> model_input {role:"toolResult", message} (the result as fed back to the model)
 *  - message_end assistant message           -> model_output {message} (text, thinking, tool calls, stopReason) + usage;
 *                                               stopReason "error" additionally records an error event
 *  - tool_execution_start                     -> tool_call(name, args, callId)
 *  - tool_execution_end                       -> tool_result(name, callId, result, isError) (+durationMs, parentToolCallId)
 *  - agent_start / agent_end / turn_start, auto-retry, compaction -> note (compaction/retry failures -> error)
 *  - message_update / tool_execution_update (streaming deltas) are skipped unless recordStreamingUpdates,
 *    since the complete message/result is captured at *_end.
 *
 * Correlation (unless manageTurns === false):
 *  - turnId: ONE per user prompt. A new turn starts at each USER message (a prompt, or a steer/follow-up that arrives
 *    mid-run). agent_start never starts a turn: Pi also emits it for automatic retry and context-overflow continuation
 *    (agent.continue()), which belong to the same user turn. Pi's turn_start fires per model round trip in the tool loop
 *    and is only counted (`turn` in payloads). Turn ids are random (never reused after a restart).
 *  - spans: each model request gets spanId `<turnId>.req-<n>` (llm_request, provider_payload, the assistant message);
 *    each tool call gets spanId `tool.<toolCallId>` with parentSpanId = the model request whose assistant message
 *    contained that toolCallId (matched by id, never by tool name), or the parent tool span for nested tool calls.
 *  - conversation: use beginPiTrace()/piTraceCorrelation() to derive conversationId from Pi's native session id.
 */
export interface PiTraceCaptureOptions {
  recordStreamingUpdates?: boolean;
  /** Record each model request's full context (default true; needs session.agent). */
  captureRequests?: boolean;
  /** Record each provider wire payload (default true; needs session.agent). */
  captureProviderPayloads?: boolean;
  /** Stamp turnId/spanId/parentSpanId (default true). Set false if the host manages turns itself via startTurn(). */
  manageTurns?: boolean;
  /** Called if recording an event fails (e.g. payload over 32 MiB); capture continues. */
  onError?: (error: unknown, event: AgentSessionEvent) => void;
}

export function piUsageToTraceUsage(u: Usage | undefined): TraceUsage | undefined {
  if (!u) return undefined;
  const out: TraceUsage = {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    totalTokens: u.totalTokens,
  };
  if (typeof u.reasoning === "number") out.reasoningTokens = u.reasoning;
  if (u.cost && Number.isFinite(u.cost.total) && u.cost.total >= 0) out.costUsd = u.cost.total;
  for (const k of Object.keys(out) as (keyof TraceUsage)[]) {
    const v = out[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) delete out[k];
  }
  return out;
}

function roleOf(message: unknown): string | undefined {
  return message && typeof message === "object" && "role" in message ? String((message as { role: unknown }).role) : undefined;
}

const CREDENTIAL_KEY_RE = /^(api[-_]?key|x-api-key|x-goog-api-key|authorization|proxy-authorization|cookie|set-cookie|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|client[-_]?secret|secret|password|credentials?)$/i;
const REDACTED_VALUE = "[REDACTED]";

type PiAgent = AgentSession["agent"];
type PiStreamFn = PiAgent["streamFunction"];
type PiModel = Parameters<PiStreamFn>[0];
type PiOnPayload = NonNullable<PiAgent["onPayload"]>;

/** Session shape the adapter needs: event subscription, plus the agent for request capture. */
export type PiSessionLike = Pick<AgentSession, "subscribe"> & { agent?: Pick<PiAgent, "streamFunction" | "onPayload">; sessionId?: string };

/**
 * Correlation for a Pi session: conversationId from Pi's native session id ("pi:<sessionId>", source "harness"),
 * unless the host supplies its own conversationId (e.g. its thread id). runId is a fresh execution attempt unless given;
 * pass previousRunId when this run retries an earlier one.
 */
export function piTraceCorrelation(
  piSession: { sessionId?: string },
  overrides: { conversationId?: string; runId?: string; previousRunId?: string } = {},
): Pick<BeginOptions, "conversationId" | "conversationSource" | "runId" | "previousRunId"> {
  const out: Pick<BeginOptions, "conversationId" | "conversationSource" | "runId" | "previousRunId"> = {};
  if (overrides.conversationId) {
    out.conversationId = overrides.conversationId;
    out.conversationSource = "explicit";
  } else if (piSession.sessionId) {
    const candidate = `pi:${piSession.sessionId}`;
    out.conversationId = CONVERSATION_ID_RE.test(candidate) ? candidate : `pi:h-${createHash("sha256").update(piSession.sessionId).digest("hex").slice(0, 40)}`;
    out.conversationSource = "harness";
  }
  if (overrides.runId) out.runId = overrides.runId;
  if (overrides.previousRunId) out.previousRunId = overrides.previousRunId;
  return out;
}

/** Begin a trace session correlated with a Pi session and attach capture. Returns the trace session and a detach fn. */
export function beginPiTrace(
  recorder: TraceRecorder,
  piSession: PiSessionLike,
  options: Omit<BeginOptions, "conversationId" | "conversationSource" | "runId" | "previousRunId"> & { conversationId?: string; runId?: string; previousRunId?: string },
  captureOptions: PiTraceCaptureOptions = {},
): { trace: TraceSession; detach: () => void } {
  const { conversationId, runId, previousRunId, ...rest } = options;
  const trace = recorder.begin({ ...rest, ...piTraceCorrelation(piSession, { conversationId, runId, previousRunId }) });
  return { trace, detach: attachPiTraceCapture(piSession, trace, captureOptions) };
}

/** Span id for a tool call id: the id itself when valid, otherwise a sanitized prefix + digest (collision-free). */
export function toolSpanId(toolCallId: string): string {
  const plain = `tool.${toolCallId}`;
  if (TRACE_ID_RE.test(plain)) return plain;
  return `tool.${toolCallId.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80)}.h${createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)}`;
}

function modelInfo(model: PiModel | undefined): Record<string, unknown> | null {
  if (!model) return null;
  const m = model as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["provider", "id", "name", "api", "baseUrl", "reasoning", "contextWindow", "maxTokens"]) if (m[k] !== undefined) out[k] = m[k];
  return out;
}

function modelLabel(model: PiModel | undefined): string | undefined {
  if (!model) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

function scrubHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return headers;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) out[k] = CREDENTIAL_KEY_RE.test(k) || /auth|token|key|secret|cookie/i.test(k) ? REDACTED_VALUE : v;
  return out;
}

function isPlainJson(value: unknown, depth = 0): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (depth > 32) return false;
  if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((v) => v === undefined || isPlainJson(v, depth + 1));
  }
  return false;
}

/** Request options minus credentials and non-serializable values (listed by name, never silently dropped). */
export function sanitizePiRequestOptions(options: unknown): { options: Record<string, unknown>; omittedOptions: string[] } {
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [k, v] of Object.entries((options ?? {}) as Record<string, unknown>)) {
    if (v === undefined || k === "model") continue;
    if (CREDENTIAL_KEY_RE.test(k)) out[k] = REDACTED_VALUE;
    else if (k === "headers") out[k] = scrubHeaders(v);
    else if (k === "env" && v && typeof v === "object") out[k] = Object.fromEntries(Object.keys(v).map((name) => [name, REDACTED_VALUE]));
    else if (isPlainJson(v)) out[k] = v;
    else omitted.push(k);
  }
  return { options: out, omittedOptions: omitted.sort() };
}

/**
 * Replay the transcript's system messages into the effective prompt and tool set:
 * `prompt` = system message contents in order, `sections` = named sections after
 * replacements/removals, `text` = contents followed by sections (Pi renders
 * sections verbatim after the content). The raw system messages stay in `messages`.
 */
export function summarizePiSystem(messages: readonly unknown[]): { prompt: string[]; sections: Record<string, string>; text: string; tools: unknown[] } {
  const prompt: string[] = [];
  const sections: Record<string, string> = {};
  const tools = new Map<string, unknown>();
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
    if (m.role !== "system") continue;
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
    if (text) prompt.push(text);
    for (const [name, value] of Object.entries(m.sections ?? {})) {
      if (value === null) delete sections[name];
      else sections[name] = value;
    }
    for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
  }
  const text = [...prompt, ...Object.values(sections)].filter(Boolean).join("\n\n");
  return { prompt, sections, text, tools: [...tools.values()] };
}

function scrubPayloadTopLevel(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) out[k] = CREDENTIAL_KEY_RE.test(k) ? REDACTED_VALUE : k === "headers" ? scrubHeaders(v) : v;
  return out;
}

export function attachPiTraceCapture(session: PiSessionLike, traceSession: TraceSession, opts: PiTraceCaptureOptions = {}): () => void {
  let turn = 0;
  let requests = 0;
  const manage = opts.manageTurns !== false;
  /** Current model request span, and toolCallId -> span of the model request that issued it. */
  let requestSpan: string | undefined;
  const toolParents = new Map<string, string>();
  const newTurn = () => {
    if (!manage) return;
    traceSession.startTurn();
    requestSpan = undefined;
  };
  const span = (spanId: string | undefined, parentSpanId?: string) => (manage && spanId ? { spanId, ...(parentSpanId ? { parentSpanId } : {}) } : {});
  const safely = (what: string, fn: () => void) => {
    if (traceSession.finished) return;
    try {
      fn();
    } catch (error) {
      opts.onError?.(error, { type: what } as unknown as AgentSessionEvent);
      try {
        traceSession.error(error, { capturing: what });
      } catch {
        // recording the capture failure itself failed; onError already notified the caller
      }
    }
  };

  const restorers: (() => void)[] = [];
  const agent = session.agent;
  if (agent && opts.captureRequests !== false) {
    const original = agent.streamFunction;
    const wrapped: PiStreamFn = (model, context, options) => {
      safely("llm_request", () => {
        const messages = (context as unknown as { messages: readonly unknown[] }).messages;
        const system = summarizePiSystem(messages);
        const label = modelLabel(model);
        requests += 1;
        requestSpan = `${traceSession.turnId ?? "t0"}.req-${requests}`;
        traceSession.modelInput(
          { kind: "llm_request", turn, request: requests, model: modelInfo(model), system: { text: system.text, prompt: system.prompt, sections: system.sections }, tools: system.tools, messages, ...sanitizePiRequestOptions(options) },
          { ...(label ? { agent: { model: label } } : {}), ...span(requestSpan) },
        );
      });
      return original(model, context, options);
    };
    agent.streamFunction = wrapped;
    restorers.push(() => {
      if (agent.streamFunction === wrapped) agent.streamFunction = original;
    });
  }
  if (agent && opts.captureProviderPayloads !== false) {
    const original = agent.onPayload;
    const wrapped: PiOnPayload = async (payload, model) => {
      const replaced = original ? await original(payload, model) : undefined;
      safely("provider_payload", () => {
        const label = modelLabel(model as PiModel);
        traceSession.modelInput(
          { kind: "provider_payload", turn, request: requests, model: modelInfo(model as PiModel), payload: scrubPayloadTopLevel(replaced === undefined ? payload : replaced) },
          { ...(label ? { agent: { model: label } } : {}), ...span(requestSpan) },
        );
      });
      return replaced;
    };
    agent.onPayload = wrapped;
    restorers.push(() => {
      if (agent.onPayload === wrapped) agent.onPayload = original;
    });
  }

  const handle = (event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        const role = roleOf(message);
        if (role === "assistant") {
          const m = message as AssistantMessage;
          const model = m.provider ? `${m.provider}/${m.model}` : m.model;
          const usage = piUsageToTraceUsage(m.usage);
          if (requestSpan) for (const c of Array.isArray(m.content) ? m.content : []) if ((c as { type?: string }).type === "toolCall" && typeof (c as { id?: unknown }).id === "string") toolParents.set((c as { id: string }).id, requestSpan);
          traceSession.modelOutput({ turn, message: m }, { ...(usage ? { usage } : {}), ...(model ? { agent: { model } } : {}), ...span(requestSpan) });
          if (m.stopReason === "error" || m.errorMessage) {
            traceSession.error({ name: "ModelError", message: m.errorMessage ?? "assistant message ended with stopReason=error" }, { turn, stopReason: m.stopReason, model });
          }
        } else {
          // Every user message (prompt, steer, follow-up) opens a new user turn.
          if (role === "user") newTurn();
          traceSession.modelInput({ kind: "message", turn, role: role ?? "custom", message });
        }
        return;
      }
      case "tool_execution_start": {
        const parent = event.parentToolCallId ? toolSpanId(event.parentToolCallId) : (toolParents.get(event.toolCallId) ?? requestSpan);
        traceSession.toolCall(event.toolName, event.args, event.toolCallId, span(toolSpanId(event.toolCallId), parent));
        return;
      }
      case "tool_execution_end": {
        const parent = event.parentToolCallId ? toolSpanId(event.parentToolCallId) : (toolParents.get(event.toolCallId) ?? requestSpan);
        toolParents.delete(event.toolCallId);
        traceSession.record("tool_result", {
          name: event.toolName,
          callId: event.toolCallId,
          isError: event.isError,
          result: event.result,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
        }, span(toolSpanId(event.toolCallId), parent));
        return;
      }
      case "message_update":
        if (opts.recordStreamingUpdates) traceSession.note({ pi: "message_update", turn, update: event.assistantMessageEvent });
        return;
      case "tool_execution_update":
        if (opts.recordStreamingUpdates) traceSession.note({ pi: "tool_execution_update", callId: event.toolCallId, name: event.toolName, partialResult: event.partialResult });
        return;
      case "turn_start":
        turn += 1;
        return;
      case "agent_start":
        // Not a turn boundary: retries and overflow continuation emit agent_start inside the same user turn.
        traceSession.note({ pi: "agent_start" });
        return;
      case "agent_end":
        traceSession.note({ pi: "agent_end", messageCount: event.messages.length, willRetry: event.willRetry, turns: turn });
        return;
      case "auto_retry_start":
        traceSession.note({ pi: "auto_retry_start", attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage });
        return;
      case "auto_retry_end":
        if (event.success) traceSession.note({ pi: "auto_retry_end", success: true, attempt: event.attempt });
        else traceSession.error({ name: "AutoRetryFailed", message: event.finalError ?? "auto retry failed" }, { attempt: event.attempt });
        return;
      case "compaction_start":
        traceSession.note({ pi: "compaction_start", reason: event.reason });
        return;
      case "compaction_end":
        if (event.errorMessage) traceSession.error({ name: "CompactionError", message: event.errorMessage }, { reason: event.reason, aborted: event.aborted });
        else traceSession.note({ pi: "compaction_end", reason: event.reason, aborted: event.aborted, result: event.result ?? null });
        return;
      default:
        return;
    }
  };
  const unsubscribe = session.subscribe((event) => {
    if (traceSession.finished) return;
    try {
      handle(event);
    } catch (error) {
      opts.onError?.(error, event);
      try {
        traceSession.error(error, { capturing: event.type });
      } catch {
        // recording the capture failure itself failed; onError already notified the caller
      }
    }
  });
  return () => {
    unsubscribe();
    for (const restore of restorers) restore();
  };
}
