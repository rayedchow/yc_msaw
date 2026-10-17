/*
 * Adapter: the demo's sanitized event log (.context/real-demo-events.jsonl,
 * read through /api/poll) to AEye's trace read model (TraceAgent and
 * TraceThreadEvent, src/build/build_trace_threads.ts). Nothing is invented:
 * every row comes from one recorded event, and an event that cannot be joined
 * to a call is shown on its own.
 *
 * Mapping (one agent = one agentId):
 *   message, assistant           -> assistant_text (the model's own words)
 *   message, user / task         -> the agent's task (first) or a later prompt row
 *   message, failed (e.g. prompt error) -> a notice row
 *   tool_call (model's call)     -> tool_start  (callId, tool name, exact args)
 *   tool_result (same callId)    -> tool_result (exact text, else exact data)
 *   host-side records of a call  -> receipts under that call (integration
 *     provider call/result, build logger outcome, Pi result details)
 * The service ids "host" and "builder" are operators, not model agents: their
 * events go to the Run panel, never into an agent's conversation.
 */
import {
  agentTitle,
  describeToolCall,
  traceFullPayload,
  traceThreadEvent,
  type EventRow,
  type TraceAgent,
  type TraceAgentStatus,
  type TraceThreadEvent,
} from "./aeye/src/build/build_trace_threads.js";

export interface DemoEvent {
  id: string;
  seq: number;
  at: string | null;
  agentId: string;
  parentId: string | null;
  kind: string;
  title: string;
  status?: string;
  text?: string;
  textTruncated?: number;
  data?: unknown;
  dataTruncated?: number;
}

export interface DemoFile {
  path: string;
  kind: string | null;
  before: string | null;
  after: string | null;
  truncated: boolean;
}

export interface DemoState {
  runId?: string;
  status?: string;
  phase?: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  sessionId?: string;
  agents?: Array<{ id: string; parentId?: string | null; name?: string; model?: string; status?: string; role?: string }>;
  files?: Array<Record<string, unknown>>;
  checks?: Record<string, unknown>;
}

/** A host-side record of one call, shown under the call's input and result. */
export interface Receipt {
  label: string;
  text: string;
  failed: boolean;
  at: string | null;
}

export type ThreadPart =
  | { type: "events"; events: TraceThreadEvent[] }
  | { type: "prompt"; key: string; at: string | null; text: string; title: string }
  | { type: "notice"; key: string; at: string | null; text: string; failed: boolean };

export interface AgentThreadModel {
  parts: ThreadPart[];
  /** Full stored text of every row, by event id (shown on "Show all"). */
  full: Map<number, string>;
  receipts: Map<string, Receipt[]>;
  eventCount: number;
}

export interface DemoAgent extends TraceAgent {
  name: string;
  /** The recorded status word (contract: pending, running, waiting, succeeded, failed, partial, interrupted, unknown). */
  statusLabel: string;
  model: string | null;
  kind: "customer" | "build";
}

/**
 * What the page can honestly say about the run as a whole.
 *   live         the run is in progress and its producer is alive
 *   ended        a terminal record (host run_end, or a terminal state status)
 *   orphaned     the state still says running but its producer process is gone
 *   disconnected this page lost the trace server; nothing current is known
 *   waiting      nothing has been recorded yet
 */
export type RunMode = "live" | "ended" | "orphaned" | "disconnected" | "waiting";

export interface RunContext {
  /** From the trace server: whether state.pid is still a running process (null: unknown). */
  producer?: { pid: number; alive: boolean } | null;
  /** The page's last read of the trace server failed. */
  disconnected?: boolean;
}

export interface AdaptedRun {
  agents: DemoAgent[];
  threads: Map<string, AgentThreadModel>;
  /** Operator records (host, builder service), oldest first. */
  operator: DemoEvent[];
  files: DemoFile[];
  /** Unified diffs the run recorded (memory_diff / source_diff text). */
  diffs: Array<{ title: string; text: string; at: string | null }>;
  active: boolean;
  ended: boolean;
  mode: RunMode;
  /** The terminal record that ended the run, when one did. */
  endedBy: { title: string; status: string | null; at: string | null } | null;
  producerPid: number | null;
  lastActivityAt: string | null;
}

const OPERATORS = new Set(["host", "builder", "unknown"]);
const THREAD_KINDS = new Set(["message", "tool_call", "tool_result", "agent_start", "agent_end", "turn_start", "turn_end", "task_start", "task_end"]);
const USER_TITLES = new Set(["user prompt", "task given to the agent", "user/harness message", "user"]);
/** Pi's tool names described the way AEye describes its own equivalents (labels only; the name stays). */
const DESCRIBE_AS: Readonly<Record<string, string>> = { bash: "shell" };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}
function sourceOf(event: DemoEvent): string {
  return isObject(event.data) && typeof event.data.source === "string" ? event.data.source : "";
}
function callIdOf(event: DemoEvent): string | null {
  const id = isObject(event.data) ? event.data.callId ?? event.data.toolCallId : undefined;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}
function sameTool(a: string, b: string): boolean {
  return a === b || a.endsWith(`__${b}`) || b.endsWith(`__${a}`);
}
function omit(data: unknown, keys: readonly string[]): unknown {
  if (!isObject(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) if (!keys.includes(key)) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

export function isOperator(agentId: string): boolean {
  return OPERATORS.has(agentId);
}

/** A status as AEye's renderer shows it, and the word the run recorded. */
export interface Lifecycle { status: TraceAgentStatus; label: string }

/**
 * Terminal words of .context/demo-lifecycle-contract.md, onto AEye's agent
 * statuses. partial, interrupted and unknown keep their own label: none of
 * them is ever shown as success.
 */
const TERMINAL: Readonly<Record<string, Lifecycle>> = {
  succeeded: { status: "done", label: "succeeded" },
  done: { status: "done", label: "succeeded" },
  completed: { status: "done", label: "succeeded" },
  failed: { status: "failed", label: "failed" },
  partial: { status: "stopped", label: "partial" },
  budget_exhausted: { status: "stopped", label: "partial" },
  interrupted: { status: "cancelled", label: "interrupted" },
  cancelled: { status: "cancelled", label: "interrupted" },
  canceled: { status: "cancelled", label: "interrupted" },
  aborted: { status: "cancelled", label: "interrupted" },
  unknown: { status: "stopped", label: "unknown" },
};
const UNKNOWN: Lifecycle = { status: "stopped", label: "unknown" };
const RUNNING: Lifecycle = { status: "running", label: "running" };
const WAITING: Lifecycle = { status: "waiting", label: "waiting" };

function terminal(word: string | undefined): Lifecycle | null {
  return word ? TERMINAL[word] ?? null : null;
}

interface PrimaryCall { callId: string; toolName: string; provider: boolean; logger: boolean }

function buildThread(events: readonly DemoEvent[]): { thread: AgentThreadModel; objective: string | null } {
  const parts: ThreadPart[] = [];
  const full = new Map<number, string>();
  const receipts = new Map<string, Receipt[]>();
  const calls: PrimaryCall[] = [];
  const providerCalls = new Map<string, string>();
  const loggerOutcome = new Map<string, boolean>();
  let objective: string | null = null;
  let current: TraceThreadEvent[] | null = null;
  let count = 0;
  const push = (row: EventRow) => {
    if (current === null) { current = []; parts.push({ type: "events", events: current }); }
    const event = traceThreadEvent(row);
    if (DESCRIBE_AS[String(row.tool_name)] && row.kind === "tool_start") {
      const described = describeToolCall(DESCRIBE_AS[String(row.tool_name)]!, row.detail);
      event.label = described.label;
      event.category = described.category;
      if (described.rawLabel) event.rawLabel = described.rawLabel;
    }
    current.push(event);
    full.set(event.id, traceFullPayload(row));
    count++;
  };
  const receipt = (callId: string, value: Receipt) => {
    const list = receipts.get(callId) ?? [];
    list.push(value);
    receipts.set(callId, list);
  };
  const latestCall = (tool: string, free: (call: PrimaryCall) => boolean) => {
    for (let index = calls.length - 1; index >= 0; index--) {
      const call = calls[index]!;
      if (sameTool(call.toolName, tool) && free(call)) return call;
    }
    return null;
  };
  const taskPrompts = new Set<string>();
  for (const event of events) {
    const data = isObject(event.data) ? event.data : {};
    const source = sourceOf(event);
    const at = event.at ?? new Date(0).toISOString();
    if (event.kind === "turn_start" || event.kind === "turn_end" || event.kind === "agent_start" || event.kind === "agent_end") continue;
    if (event.kind === "task_start") {
      // The attempt's prompt, once: a matching user message after it is the same prompt.
      const prompt = typeof data.prompt === "string" ? data.prompt : "";
      if (!prompt) continue;
      taskPrompts.add(prompt.trim());
      if (objective === null && count === 0 && parts.length === 0) objective = prompt;
      else { parts.push({ type: "prompt", key: event.id, at: event.at, text: prompt, title: event.title }); current = null; }
      continue;
    }
    if (event.kind === "task_end") {
      parts.push({ type: "notice", key: event.id, at: event.at, text: event.title || `Task ${event.status ?? "ended"}`, failed: event.status === "failed" });
      current = null;
      continue;
    }
    if (event.kind === "message") {
      const role = typeof data.role === "string" ? data.role : null;
      const text = event.text ?? "";
      if (event.status === "failed" || event.title === "prompt error") {
        parts.push({ type: "notice", key: event.id, at: event.at, text: text || event.title, failed: true });
        current = null;
      } else if (role === "user" || USER_TITLES.has(event.title)) {
        if (taskPrompts.has(text.trim())) { taskPrompts.delete(text.trim()); continue; }
        if (objective === null && count === 0 && parts.length === 0) objective = text;
        else { parts.push({ type: "prompt", key: event.id, at: event.at, text, title: event.title }); current = null; }
      } else if (text.trim()) {
        push({ id: event.seq, kind: "assistant_text", call_id: null, tool_name: null, status: null, detail: text, created_at: at });
      } else if (event.title) {
        parts.push({ type: "notice", key: event.id, at: event.at, text: event.title, failed: false });
        current = null;
      }
      continue;
    }
    if (event.kind === "tool_call") {
      const callId = callIdOf(event);
      const toolName = typeof data.tool === "string" ? data.tool : event.title;
      if (source.startsWith("integration provider")) {
        const owner = latestCall(toolName, (call) => !call.provider);
        if (owner && callId) {
          owner.provider = true;
          providerCalls.set(callId, owner.callId);
          receipt(owner.callId, { label: `Integration provider call · ${toolName}`, text: pretty(data.args ?? data.input ?? {}), failed: false, at: event.at });
          continue;
        }
      }
      const args = data.args ?? data.input ?? data.arguments ?? omit(event.data, ["callId", "toolCallId", "tool", "source"]) ?? {};
      push({ id: event.seq, kind: "tool_start", call_id: callId, tool_name: toolName, status: null, detail: json(args), created_at: at });
      if (callId) calls.push({ callId, toolName, provider: false, logger: false });
      continue;
    }
    if (event.kind === "tool_result") {
      const callId = callIdOf(event);
      const failed = event.status === "failed" || data.isError === true;
      if (callId && providerCalls.has(callId)) {
        receipt(providerCalls.get(callId)!, { label: `Integration provider result · ${event.title}`, text: pretty(data.result ?? data.error ?? omit(event.data, ["callId", "source"]) ?? event.text ?? ""), failed, at: event.at });
        continue;
      }
      if (!callId && source.startsWith("build logger")) {
        const tool = typeof data.tool === "string" ? data.tool : event.title.split(" ")[0] ?? "";
        const owner = latestCall(tool, (call) => !call.logger);
        if (owner) {
          owner.logger = true;
          if (typeof data.ok === "boolean") loggerOutcome.set(owner.callId, data.ok);
          receipt(owner.callId, { label: `Build logger · ${event.title}`, text: pretty(omit(event.data, ["source"]) ?? {}), failed: data.ok === false, at: event.at });
          continue;
        }
      }
      const details = data.details ?? data.result ?? data.error;
      const body = event.text && event.text.length > 0 ? event.text : pretty(details ?? omit(event.data, ["callId", "toolCallId", "source"]) ?? "");
      const toolName = typeof data.tool === "string" ? data.tool : event.title.replace(/ \(error\)$/u, "");
      push({ id: event.seq, kind: "tool_result", call_id: callId, tool_name: toolName, status: event.status === "failed" || failed ? "failed" : event.status === "succeeded" ? "succeeded" : null, detail: body, created_at: at });
      if (callId && event.text && details !== undefined && details !== null) {
        receipt(callId, { label: "Result details", text: pretty(details), failed: false, at: event.at });
      }
      continue;
    }
  }
  // A result the model saw carries no status; the build logger's outcome for that call does.
  for (const part of parts) {
    if (part.type !== "events") continue;
    for (const event of part.events) {
      if (event.kind === "tool_result" && event.status === null && event.callId && loggerOutcome.has(event.callId)) {
        event.status = loggerOutcome.get(event.callId) ? "succeeded" : "failed";
      }
    }
  }
  return { thread: { parts, full, receipts, eventCount: count }, objective };
}

const CONVERSATION = new Set(["message", "tool_call", "tool_result"]);

const BOUNDARY = new Set(["turn_start", "turn_end"]);

/**
 * One agent's status from what was recorded, strongest evidence first:
 *  1. its own terminal receipt (agent_end with no activity after it);
 *  2. a terminal status its state row gives it (finalized rows);
 *  3. the run's end (operator run_end or terminal state), or for a build
 *     agent the build cycle's end, with no receipt of its own: unknown;
 *  4. the run is not live (producer gone, page disconnected): unknown;
 *  5. explicit turn boundaries (turn_start running, turn_end waiting);
 *  6. legacy logs without boundaries, the customer: a phase that began after
 *     its last turn activity means its turn is over (idle); otherwise an open
 *     call, an unanswered result or a fresh prompt is a running turn, and a
 *     final answer is idle. Phase titles are never read.
 *  7. otherwise running. Silence alone never stops an agent.
 */
function lifecycle({ customer, list, listed, end, active, ended, buildEnd, phases }: {
  customer: boolean;
  list: readonly DemoEvent[];
  listed: string | undefined;
  end: DemoEvent | undefined;
  active: boolean;
  ended: boolean;
  buildEnd: DemoEvent | null;
  phases: readonly DemoEvent[];
}): Lifecycle {
  const lastWork = [...list].reverse().find((event) => CONVERSATION.has(event.kind) || event.kind === "agent_start" || event.kind === "turn_start" || event.kind === "task_start");
  if (end && (!lastWork || end.seq > lastWork.seq)) {
    const harness = isObject(end.data) && typeof end.data.harnessStatus === "string" ? end.data.harnessStatus : undefined;
    return terminal(end.status) ?? terminal(harness) ?? UNKNOWN;
  }
  const fromState = terminal(listed);
  if (fromState) return fromState;
  if (ended) return UNKNOWN;
  if (!customer && buildEnd && (!lastWork || buildEnd.seq > lastWork.seq)) return UNKNOWN;
  if (!active) return UNKNOWN;
  const boundary = [...list].reverse().find((event) => BOUNDARY.has(event.kind));
  if (boundary) return boundary.kind === "turn_start" ? RUNNING : WAITING;
  if (customer) {
    const convo = list.filter((event) => CONVERSATION.has(event.kind));
    const last = convo.at(-1);
    if (!last) return listed === "pending" ? { status: "waiting", label: "pending" } : WAITING;
    if (phases.some((phase) => phase.seq > last.seq)) return WAITING;
    const open = new Set<string>();
    for (const event of convo) {
      const callId = callIdOf(event);
      if (!callId) continue;
      if (event.kind === "tool_call") open.add(callId);
      else if (event.kind === "tool_result") open.delete(callId);
    }
    if (open.size > 0) return RUNNING;
    if (last.kind === "tool_result") return RUNNING;
    if (last.kind === "message" && (USER_TITLES.has(last.title) || (isObject(last.data) && last.data.role === "user"))) return RUNNING;
    return WAITING;
  }
  if (listed === "pending" && !lastWork) return { status: "waiting", label: "pending" };
  return RUNNING;
}

function filesFrom(state: DemoState | null): DemoFile[] {
  const out: DemoFile[] = [];
  for (const raw of state?.files ?? []) {
    if (!isObject(raw) || typeof raw.path !== "string") continue;
    out.push({
      path: raw.path,
      kind: typeof raw.kind === "string" ? raw.kind : null,
      before: typeof raw.before === "string" ? raw.before : null,
      after: typeof raw.after === "string" ? raw.after : null,
      truncated: raw.truncated === true,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const TERMINAL_STATE = new Set(["succeeded", "failed", "partial", "interrupted", "unknown", "aborted", "cancelled", "canceled", "done", "completed"]);

export function adaptRun(events: readonly DemoEvent[], state: DemoState | null, context: RunContext = {}): AdaptedRun {
  // Only the operator's run_end ends the run; the build service's run_end ends the build cycle.
  const runEnd = [...events].reverse().find((event) => event.kind === "run_end" && event.agentId !== "builder") ?? null;
  const buildEnd = [...events].reverse().find((event) => event.kind === "run_end" && event.agentId === "builder") ?? null;
  const stateTerminal = typeof state?.status === "string" && TERMINAL_STATE.has(state.status);
  const ended = runEnd !== null || stateTerminal;
  const orphaned = !ended && context.producer?.alive === false;
  const mode: RunMode = context.disconnected ? "disconnected"
    : ended ? "ended"
    : orphaned ? "orphaned"
    : events.length === 0 && state === null ? "waiting"
    : "live";
  const active = mode === "live";
  const endedBy = runEnd ? { title: runEnd.title, status: runEnd.status ?? null, at: runEnd.at }
    : stateTerminal ? { title: state?.title ?? "Run", status: state?.status ?? null, at: state?.updatedAt ?? null }
    : null;
  const operator: DemoEvent[] = [];
  const diffs: AdaptedRun["diffs"] = [];
  const byAgent = new Map<string, DemoEvent[]>();
  const order: string[] = [];
  const stateAgents = new Map((state?.agents ?? []).filter((agent) => isObject(agent) && typeof agent.id === "string").map((agent) => [agent.id, agent]));
  // Operators by id, or by the role the state gives them (contract: role "operator").
  const operatorIds = new Set([...OPERATORS, ...[...stateAgents.values()].filter((agent) => agent.role === "operator").map((agent) => agent.id)]);
  const operatorAgent = (id: string) => operatorIds.has(id);
  const phases = events.filter((event) => event.kind === "phase" && operatorAgent(event.agentId));
  for (const event of events) {
    if ((event.kind === "memory_diff" || event.kind === "source_diff") && event.text) diffs.push({ title: event.title, text: event.text, at: event.at });
    if (operatorAgent(event.agentId) || !THREAD_KINDS.has(event.kind)) { operator.push(event); continue; }
    if (!byAgent.has(event.agentId)) { byAgent.set(event.agentId, []); order.push(event.agentId); }
    byAgent.get(event.agentId)!.push(event);
  }
  for (const id of stateAgents.keys()) {
    if (!operatorAgent(id) && !byAgent.has(id)) { byAgent.set(id, []); order.push(id); }
  }
  const threads = new Map<string, AgentThreadModel>();
  const draft: DemoAgent[] = [];
  for (const id of order) {
    const list = byAgent.get(id)!;
    const listed = stateAgents.get(id);
    const { thread, objective } = buildThread(list);
    threads.set(id, thread);
    const start = list.find((event) => event.kind === "agent_start");
    const end = [...list].reverse().find((event) => event.kind === "agent_end");
    const startData = isObject(start?.data) ? start.data : {};
    const modelFromMessage = list.map((event) => (isObject(event.data) && typeof event.data.model === "string" ? event.data.model : null)).find(Boolean) ?? null;
    const parentId = listed?.parentId ?? start?.parentId ?? list.find((event) => event.parentId && event.parentId !== id)?.parentId ?? null;
    const customer = listed?.role ? listed.role === "customer" : id === "customer";
    const { status, label: statusLabel } = lifecycle({ customer, list, listed: listed?.status, end, active, ended, buildEnd, phases });
    const endData = isObject(end?.data) ? end.data : {};
    const ats = list.map((event) => event.at).filter((at): at is string => typeof at === "string");
    const task = objective ?? (typeof endData.objective === "string" ? endData.objective : null) ?? start?.text ?? null;
    draft.push({
      id,
      parentId: parentId && parentId !== id ? parentId : null,
      depth: 0,
      ordinal: 0,
      attempt: 0,
      title: task ? agentTitle(task) : listed?.name ?? id,
      objective: task ?? "",
      status,
      statusLabel,
      failure: status === "failed"
        ? (typeof endData.summary === "string" && endData.summary) || end?.text || "This agent failed."
        : null,
      createdAt: start?.at ?? ats[0] ?? state?.startedAt ?? new Date(0).toISOString(),
      completedAt: status === "running" || status === "waiting" ? null : end?.at ?? null,
      lastActivityAt: ats.at(-1) ?? null,
      toolCalls: list.filter((event) => event.kind === "tool_call").length,
      messages: list.filter((event) => event.kind === "message").length,
      events: thread.eventCount,
      name: listed?.name ?? id,
      model: listed?.model ?? (typeof startData.profile === "string" ? startData.profile : null) ?? (typeof startData.model === "string" ? startData.model : null) ?? modelFromMessage,
      kind: customer ? "customer" : "build",
    });
  }
  const byId = new Map(draft.map((agent) => [agent.id, agent]));
  let subagents = 0;
  let roots = 0;
  for (const agent of draft) {
    let depth = 0;
    const seen = new Set([agent.id]);
    let parent = agent.parentId ? byId.get(agent.parentId) : undefined;
    while (parent && !seen.has(parent.id)) { depth++; seen.add(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
    if (agent.parentId && !byId.has(agent.parentId)) agent.parentId = null;
    agent.depth = agent.parentId ? Math.max(1, depth) : 0;
    if (agent.depth === 0) { if (agent.kind === "build") agent.attempt = ++roots; }
    else agent.ordinal = ++subagents;
  }
  const lastActivityAt = events.map((event) => event.at).filter((at): at is string => typeof at === "string").at(-1) ?? null;
  return { agents: draft, threads, operator, files: filesFrom(state), diffs, active, ended, mode, endedBy, producerPid: context.producer?.pid ?? null, lastActivityAt };
}
