import { sha256 } from "../util.js";
import { AgentMeter, BudgetExhaustedError, type SessionBoundary } from "./budget.js";
import type { ChatClient, ChatMessage } from "./llm.js";
import { renderOutcome, type AgentToolbox, type ToolCallRecord } from "./tools.js";

/**
 * Multi-turn tool loop for one build agent (root or child). The model chooses
 * every tool call; the loop only enforces budgets, bounds tool output, and
 * stops when the runtime marks the agent terminal (publish / complete_task /
 * cancellation). There is no scripted step sequence here.
 *
 * Session semantics follow AEye: a turn is one model call (parallel tool calls
 * in one reply are one turn and N tool calls). When a session limit is reached
 * the conversation is reset to the system prompt, the task, and a host-authored
 * state summary (onSessionBoundary), and the agent continues. Two consecutive
 * sessions without progress stop the agent (no_progress).
 */
export type LoopStop =
  | { kind: "terminal" }
  | { kind: "budget_exhausted"; error: BudgetExhaustedError }
  | { kind: "no_progress"; message: string }
  | { kind: "stopped_without_finishing"; message: string }
  | { kind: "aborted"; reason: string }
  | { kind: "model_error"; message: string };

export interface SessionResume {
  /** Host-authored, factual state summary that starts the next session. */
  prompt: string;
  /** Fingerprint of durable progress (draft, scratch, children); equal fingerprints across a session = no progress. */
  progressFingerprint: string;
}

export interface AgentLoopOptions {
  client: ChatClient;
  systemPrompt: string;
  taskPrompt: string;
  toolbox: AgentToolbox;
  meter: AgentMeter;
  signal: AbortSignal;
  /** True once the runtime has made the agent terminal (e.g. complete_task/publish succeeded). */
  isTerminal(): boolean;
  /** Name of the finishing tool for nudges ("publish" or "complete_task"). */
  finishTool: string;
  /** Called at session start (session 1) and at each boundary to build the resume state. */
  sessionState(reason: SessionBoundary | null, session: number): Promise<SessionResume>;
  onToolCall?(record: ToolCallRecord & { turn: number; session: number }): void;
  onSession?(event: { session: number; reason: SessionBoundary }): void;
  maxNudges?: number;
}

const BUDGET_NOTICE_TURNS = 3;
const BUDGET_NOTICE_CALLS = 5;
/** Parallel tool calls executed from one reply; the rest fail explicitly. */
export const MAX_CALLS_PER_REPLY = 16;

export async function runAgentLoop(opts: AgentLoopOptions): Promise<LoopStop> {
  const tools = opts.toolbox.specs();
  const toolBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  const fresh = (): ChatMessage[] => [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.taskPrompt },
  ];
  let messages = fresh();
  let nudges = 0;
  const maxNudges = opts.maxNudges ?? 2;
  let sessionStartFingerprint = (await opts.sessionState(null, 1)).progressFingerprint;
  let noProgressSessions = 0;
  for (;;) {
    if (opts.signal.aborted) return { kind: "aborted", reason: abortReason(opts.signal) };
    if (opts.isTerminal()) return { kind: "terminal" };
    let requestBytes = Buffer.byteLength(JSON.stringify(messages), "utf8") + toolBytes;
    const boundary = opts.meter.boundary(requestBytes);
    if (boundary) {
      try {
        opts.meter.startNewSession(boundary);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) return { kind: "budget_exhausted", error };
        throw error;
      }
      const session = opts.meter.usage.sessions;
      const resume = await opts.sessionState(boundary, session);
      noProgressSessions = resume.progressFingerprint === sessionStartFingerprint ? noProgressSessions + 1 : 0;
      if (noProgressSessions >= 2) return { kind: "no_progress", message: `Two consecutive sessions ended (${boundary}) without any change to the draft, scratch notes, or children` };
      sessionStartFingerprint = resume.progressFingerprint;
      opts.onSession?.({ session, reason: boundary });
      messages = [...fresh(), { role: "user", content: resume.prompt }];
      nudges = 0;
      requestBytes = Buffer.byteLength(JSON.stringify(messages), "utf8") + toolBytes;
    }
    try {
      opts.meter.beginTurn(requestBytes);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) return { kind: "budget_exhausted", error };
      throw error;
    }
    let reply;
    try {
      reply = await opts.client.chat(messages, tools, { signal: opts.signal });
    } catch (error) {
      if (opts.signal.aborted) return { kind: "aborted", reason: abortReason(opts.signal) };
      return { kind: "model_error", message: error instanceof Error ? error.message : String(error) };
    }
    opts.meter.recordReply(Buffer.byteLength(JSON.stringify(reply.message), "utf8"), reply.usage.prompt_tokens, reply.usage.completion_tokens, reply.latencyMs);
    messages.push(sanitizeAssistantMessage(reply.message));
    // Tools receive the model's RAW arguments so invalid JSON is reported explicitly (invalid_arguments).
    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      if (nudges >= maxNudges) return { kind: "stopped_without_finishing", message: `Model stopped calling tools without ${opts.finishTool} (after ${nudges} host reminder(s))` };
      nudges += 1;
      messages.push({ role: "user", content: `[host] No tool was called. Continue with tools; this agent ends only through ${opts.finishTool}.` });
      continue;
    }
    for (const [i, call] of calls.entries()) {
      const skip = opts.isTerminal() ? "Not executed: the agent already finished" : i >= MAX_CALLS_PER_REPLY ? `Not executed: at most ${MAX_CALLS_PER_REPLY} parallel tool calls per reply` : null;
      if (skip) {
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, error: { code: "not_executed", message: skip } }) });
        continue;
      }
      if (opts.signal.aborted) return { kind: "aborted", reason: abortReason(opts.signal) };
      opts.meter.recordToolCall();
      const started = Date.now();
      const outcome = await opts.toolbox.invoke(call.function.name, call.function.arguments ?? "");
      const rendered = renderOutcome(outcome);
      if (!outcome.ok) opts.meter.usage.toolErrors += 1;
      opts.onToolCall?.({
        turn: opts.meter.usage.turns,
        session: opts.meter.usage.sessions,
        name: call.function.name,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { code: outcome.code }),
        durationMs: Date.now() - started,
        argsSha256: sha256(call.function.arguments ?? ""),
        resultBytes: rendered.bytes,
        truncated: rendered.truncated,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: rendered.text });
    }
    if (opts.isTerminal()) return { kind: "terminal" };
    const left = opts.meter.remaining();
    if (left.turns <= BUDGET_NOTICE_TURNS || left.toolCalls <= BUDGET_NOTICE_CALLS) {
      messages.push({
        role: "user",
        content:
          left.sessions > 0
            ? `[host] Session notice: ${Math.max(0, left.turns)} turn(s) / ${Math.max(0, left.toolCalls)} tool call(s) remain in this session; then the conversation resets to a host state summary (${left.sessions} more session(s) allowed). Keep durable notes in work/ so you can resume.`
            : `[host] Budget notice: ${Math.max(0, left.turns)} turn(s) / ${Math.max(0, left.toolCalls)} tool call(s) remain in your LAST session. Finish with ${opts.finishTool} before then or this agent fails.`,
      });
    }
  }
}

/**
 * Providers reject a whole request when a replayed assistant tool_call carries
 * arguments that are not a JSON object string. History keeps a valid stand-in
 * ({"_invalid_arguments": "<raw prefix>"}); the tool result for that call still
 * reports the invalid_arguments error so the model can retry correctly.
 */
export function sanitizeAssistantMessage(message: ChatMessage): ChatMessage {
  if (!message.tool_calls?.length) return message;
  let changed = false;
  const tool_calls = message.tool_calls.map((call) => {
    const raw = call.function.arguments ?? "";
    if (raw.trim() === "") {
      changed = true;
      return { ...call, function: { ...call.function, arguments: "{}" } };
    }
    let ok = false;
    try {
      const v: unknown = JSON.parse(raw);
      ok = typeof v === "object" && v !== null && !Array.isArray(v);
    } catch {
      ok = false;
    }
    if (ok) return call;
    changed = true;
    return { ...call, function: { ...call.function, arguments: JSON.stringify({ _invalid_arguments: raw.slice(0, 2000) }) } };
  });
  return changed ? { ...message, tool_calls } : message;
}

function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r.message;
  return typeof r === "string" ? r : "aborted";
}
