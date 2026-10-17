/*
 * DB-free extract of AEye src/build/build_trace_threads.ts
 * (askshepherd/aeye-shepherd @ a49aae10e219a7b3aa36102099b649340c2d42b0).
 * Types, describeToolCall, toolLabelForStatus and helpers are verbatim; the
 * SQLite readers are omitted and mapEvent's row mapping is kept as
 * `traceThreadEvent` over an adapter-supplied row (see demo-ui/src/adapter.ts).
 */
import type { RunResumption } from "./run_resumptions.js";
import { displayWorkspaceText } from "./workspace_display.js";

/** Adapter: AEye's host runtime progress line (src/jobs/runtime_progress.ts), only the fields the trace shows. */
export interface RuntimeProgress {
  phase: "working" | "model_retrying" | "failed" | string;
  label: string;
  detail: string;
  error?: string | null;
}

export type TraceAgentStatus = "running" | "done" | "failed" | "cancelled" | "stopped" | "waiting" | "paused";

/**
 * What the run as a whole is doing. `review`: its proposal waits for a
 * reviewer (the agent may be hibernated meanwhile); `paused`: parked or
 * hibernated for a reply; `stopped`: it went quiet without a terminal state;
 * `finished`: its window closed. Review and pauses are never failures.
 */
export type TraceRunState = "working" | "review" | "paused" | "stopped" | "finished";

/** The run's staged proposal, when it has one. */
export interface TraceProposal {
  pullRequestId: string | null;
  /** When each of the run's proposals was staged, oldest first. */
  stagedAt: string[];
  /** A merge that failed after approval: its own event, never the proposal's. */
  mergeFailure: { cause: string; at: string } | null;
}

export interface TraceAgent {
  id: string;
  /** Immutable creation cursor within this database, for bounded list paging. */
  sequence?: number;
  parentId: string | null;
  depth: number;
  /** 1-based creation order among subagents (0 for root attempts). */
  ordinal: number;
  /** 1-based attempt number among root agents (0 for subagents). */
  attempt: number;
  title: string;
  objective: string;
  /** Non-selected list rows carry only a bounded task preview. */
  objectiveTruncated?: true;
  status: TraceAgentStatus;
  failure: string | null;
  /** Exact stored error only for selected agents, never multiplied across the forest. */
  failureDetails?: string | null;
  createdAt: string;
  completedAt: string | null;
  lastActivityAt: string | null;
  toolCalls: number;
  messages: number;
  events: number;
}

export interface TraceAgentList {
  runtimeProgress?: RuntimeProgress | null;
  /** The run is live: its window is open, it is working, and it has shown activity recently. */
  active: boolean;
  state: TraceRunState;
  proposal: TraceProposal | null;
  /** The window still says it is running, but nothing has happened for a long time. */
  stale: boolean;
  /** The newest recorded activity of any agent of the run (or the run's start). */
  lastActivityAt: string | null;
  agents: TraceAgent[];
  paging?: TraceAgentPaging;
}

export interface TraceAgentPaging {
  before: number | null;
  after: number | null;
  hasEarlier: boolean;
  hasLater: boolean;
  totalAgents: number;
  totalRoots: number;
  /** Page members only; selected agents and their ancestors are extra anchors. */
  agentIds: string[];
}

export interface TraceAgentListOptions {
  before?: number;
  after?: number;
  limit?: number;
  selectedAgentIds?: readonly string[];
  /** Internal synthetic run-root summaries need roots, never every descendant. */
  rootsOnly?: boolean;
}

export type TraceToolCategory = "read" | "edit" | "command" | "search" | "wait" | "agents" | "handoff" | "other";

export interface TraceThreadEvent {
  id: number;
  kind: "assistant_text" | "assistant_reasoning" | "tool_start" | "tool_output" | "tool_result";
  at: string;
  callId: string | null;
  toolName: string | null;
  status: string | null;
  /** Display text: prose, reasoning, pretty tool payload, or a command output chunk. */
  text: string;
  /** Length of the full stored detail; `truncated` means `text` is a prefix of it. */
  length: number;
  truncated: boolean;
  /** tool_start only: one human line describing the call. */
  label?: string;
  /** tool_start only: the label as the agent wrote it (mount variables unnamed), when it differs. */
  rawLabel?: string;
  category?: TraceToolCategory;
  /** tool_start only: a short supporting excerpt (for example a handoff summary). */
  note?: string;
  /** tool_output only. */
  stream?: "stdout" | "stderr";
  /** tool_output of a running host operation (Docling, Reducto, EDA): its latest recorded state. */
  progress?: TraceOperationProgress;
  /** spawn_agents / wait_agents: the agents the call names. */
  agentIds?: string[];
  /** submit_grade only: a benchmark grader's verdict and what it cost. */
  verdict?: TraceGradeVerdict;
}


/** A running host operation's state as its progress row recorded it. */
export interface TraceOperationProgress {
  operationId: string;
  stage: string | null;
  pagesDone: number | null;
  pageCount: number | null;
  startedAt: string | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The progress a `tool_output` row of stream `progress` recorded, or null for any other row. */
export function traceOperationProgress(parsed: unknown): TraceOperationProgress | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const row = parsed as { stream?: unknown; progress?: unknown };
  if (row.stream !== "progress" || row.progress === null || typeof row.progress !== "object") return null;
  const progress = row.progress as Record<string, unknown>;
  if (typeof progress.operationId !== "string") return null;
  const startedAt = typeof progress.startedAt === "string" && Number.isFinite(Date.parse(progress.startedAt))
    ? progress.startedAt
    : null;
  return {
    operationId: progress.operationId,
    stage: typeof progress.stage === "string" ? clean(progress.stage).slice(0, 300) : null,
    pagesDone: count(progress.pagesDone),
    pageCount: count(progress.pageCount),
    startedAt,
  };
}

/** A benchmark grader's verdict, as its trace shows it. */
export interface TraceGradeVerdict {
  verdict: "pass" | "partial" | "fail" | "not_gradable";
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
}

export interface TraceCompaction {
  id: number;
  at: string;
  summary: string;
  /** Exact summaries expand through the scoped payload API; list pages carry previews. */
  length?: number;
  truncated?: boolean;
  compactedMessages: number;
  retainedMessages: number;
  inputTokens: number | null;
}

/** One failed provider attempt of a model call, from its durable attempt record. */
export interface TraceModelAttempt {
  attempt: number;
  maxAttempts: number | null;
  at: string;
  outcome: "retrying" | "stopped";
  /** What failed, worded from structural facts only. */
  label: string;
  /** The HTTP status the provider answered with, when it answered. */
  httpStatus: number | null;
  /** The attempt had streamed output, which was discarded. */
  partialOutput: boolean;
  /** Known not to have been billed; null when its usage is unknown. */
  unbilled: "connection" | "server_error" | "provider_rejected" | null;
  delayMs: number | null;
  retryAt: string | null;
  stopReason: string | null;
}

/**
 * A model call of this agent that had at least one failed provider attempt,
 * with every attempt and the call's outcome. Calls recorded before attempts
 * were journaled have none and do not appear: their attempts are unknown.
 */
export interface TraceModelRetry {
  callId: string;
  /** When its first attempt failed. */
  at: string;
  attempts: TraceModelAttempt[];
  /** "running": the call is still open (waiting to retry, or retrying). */
  outcome: "running" | "succeeded" | "failed" | "cancelled" | "deadline_exceeded";
  settledAt: string | null;
}

/** The newest retried calls a thread page carries (with all of their attempts). */
export const TRACE_MODEL_RETRY_CALLS = 20;

export interface TraceThreadPage {
  /** A synthetic mutable overview replaces its prior cards; journal pages append. */
  replace?: true;
  agentId: string;
  events: TraceThreadEvent[];
  compactions: TraceCompaction[];
  /**
   * The agent's newest model calls that retried a failed provider attempt,
   * oldest first. Present on the newest and live (`after`) pages, which
   * replace it whole; an immutable earlier page never carries it.
   */
  modelRetries?: TraceModelRetry[];
  /**
   * The run's explicit resumes and new attempts (newest bounded, oldest
   * first), on the same pages as `modelRetries` and replaced whole likewise.
   * A thread shows one only between activity recorded on both sides of it.
   */
  resumptions?: RunResumption[];
  /** All retained context summaries, independently reachable through their own id cursor. */
  compactionsTotal?: number;
  /** Older events exist before `events[0]`. */
  hasEarlier: boolean;
  /** Newer events exist after the last event (only for `after` pages). */
  hasLater: boolean;
}

export const DEFAULT_AGENT_PAGE = 200;
export const MAX_AGENT_PAGE = 400;
const PREVIEW_CHARS = 1_600;
const PROSE_CHARS = 24_000;
export const DEFAULT_THREAD_PAGE = 300;
export const MAX_THREAD_PAGE = 600;
export const TRACE_COMPACTION_PAGE = 25;
export const MAX_COMPACTION_PAGE = 50;

export interface TraceCompactionPage {
  agentId: string;
  compactions: TraceCompaction[];
  total: number;
  hasEarlier: boolean;
  hasLater: boolean;
}

function clean(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ");
}

function oneLine(value: string, max: number): string {
  const flat = value.replaceAll(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A short human title from an agent's objective. */
export function agentTitle(objective: string): string {
  let text = objective.replaceAll(/[*_`#>]+/gu, "").replaceAll(/\s+/gu, " ").trim();
  const sentence = /^(.{20,}?[.!?])\s/u.exec(text);
  if (sentence) text = sentence[1]!;
  text = text.replace(/^(?:please\s+)?(?:investigate|research|study|review|analy[sz]e|document)\s+(?:the\s+)?/iu, "");
  const cut = text.search(/,?\s+(?:and|then)\s+(?:build|create|write|produce|maintain|update)\b/iu);
  if (cut > 15) text = text.slice(0, cut);
  text = text.replace(/[.!?]+$/u, "");
  if (text.length > 0) text = text[0]!.toUpperCase() + text.slice(1);
  return oneLine(text, 80) || "Agent";
}


function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A string field from parsed JSON, or from a truncated JSON prefix. */
function field(parsed: unknown, raw: string, key: string): string | null {
  if (parsed && typeof parsed === "object" && key in parsed) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "u").exec(raw);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1]!;
  }
}

function shortPath(path: string): string {
  const trimmed = displayWorkspaceText(path);
  if (trimmed.length <= 90) return trimmed;
  const parts = trimmed.split("/");
  const tail = parts.slice(-2).join("/");
  return `…/${tail.length > 86 ? tail.slice(-86) : tail}`;
}

function agentIdsIn(raw: string): string[] {
  const ids = new Set<string>();
  for (const match of raw.matchAll(/"agentId"\s*:\s*"([0-9a-f-]{36})"/gu)) ids.add(match[1]!);
  const list = /"agentIds"\s*:\s*\[([^\]]*)/u.exec(raw);
  if (list) for (const match of list[1]!.matchAll(/"([0-9a-f-]{36})"/gu)) ids.add(match[1]!);
  return [...ids];
}

/** One human line for a tool call, from its stored input. */

export function describeToolCall(toolName: string, raw: string): {
  label: string;
  /** The label as the agent wrote it, when its mount variables were renamed for display. */
  rawLabel?: string;
  category: TraceToolCategory;
  note?: string;
} {
  const parsed = parseJson(raw);
  const path = field(parsed, raw, "path");
  const name = toolName.toLowerCase();
  if (name === "read" || name === "view_file" || name === "expand_result" || name === "read_agent_branch_page") {
    if (name === "expand_result") return { label: `Read more of result ${field(parsed, raw, "handle") ?? ""}`.trim(), category: "read" };
    if (name === "read_agent_branch_page") return { label: `Read a subagent's page ${path ? shortPath(path) : ""}`.trim(), category: "read" };
    const offset = field(parsed, raw, "offset") ?? field(parsed, raw, "byteOffset");
    return {
      label: `${name === "view_file" ? "Viewed" : "Read"} ${path ? shortPath(path) : "a file"}${offset && offset !== "0" ? ` from ${offset}` : ""}`,
      category: "read",
    };
  }
  if (name === "write") return { label: `Wrote ${path ? shortPath(path) : "a file"}`, category: "edit" };
  if (name === "edit") return { label: `Edited ${path ? shortPath(path) : "a file"}`, category: "edit" };
  if (name === "shell") {
    const script = field(parsed, raw, "script") ?? field(parsed, raw, "command") ?? "";
    const line = script.split("\n").map((part) => part.trim()).find((part) => part.length > 0 && !part.startsWith("#")) ?? "a command";
    const command = oneLine(line, 140);
    const label = displayWorkspaceText(command);
    return { label, ...(label === command ? {} : { rawLabel: command }), category: "command" };
  }
  if (name === "poll_command") return { label: "Checked on a running command", category: "command" };
  if (name === "cancel_command") return { label: "Cancelled a running command", category: "command" };
  if (name === "grep" || name === "find" || name === "search_tools" || name === "tool_search" || name === "match_tools") {
    const pattern = field(parsed, raw, "pattern") ?? field(parsed, raw, "query");
    return {
      label: `Searched${pattern ? ` for ${oneLine(pattern, 70)}` : ""}${path ? ` in ${shortPath(path)}` : ""}`,
      category: "search",
    };
  }
  if (name === "ls") return { label: `Listed ${path ? shortPath(path) : "a folder"}`, category: "search" };
  if (name === "spawn_agents") {
    const count = parsed && typeof parsed === "object" && Array.isArray((parsed as { agents?: unknown }).agents)
      ? ((parsed as { agents: unknown[] }).agents).length
      : (raw.match(/"objective"\s*:/gu) ?? []).length;
    return { label: `Started ${count || "new"} subagent${count === 1 ? "" : "s"}`, category: "agents" };
  }
  if (name === "wait_agents") {
    const count = agentIdsIn(raw).length;
    return { label: `Waited for ${count || ""} subagent${count === 1 ? "" : "s"}`.replace("  ", " "), category: "wait" };
  }
  if (name === "send_agent" || name === "message_agents") return { label: "Sent a message to a subagent", category: "agents" };
  if (name === "message_parent") {
    const message = field(parsed, raw, "message") ?? field(parsed, raw, "text");
    return { label: "Sent a message to its parent", category: "agents", ...(message ? { note: oneLine(message, 600) } : {}) };
  }
  if (/^(?:list|read)_agent/u.test(name)) {
    if (name === "read_agent_result") return { label: "Read a subagent's result", category: "agents" };
    return { label: "Checked subagent status", category: "agents" };
  }
  if (name === "resume_agent") return { label: "Resumed a subagent", category: "agents" };
  if (name === "cancel_agent") return { label: "Stopped a subagent", category: "agents" };
  if (name === "decide_agent_results") return { label: "Accepted or rejected subagent work", category: "agents" };
  if (name === "complete_task") {
    const summary = field(parsed, raw, "summary");
    return { label: "Submitted its results", category: "handoff", ...(summary ? { note: clean(summary).slice(0, 4_000) } : {}) };
  }
  if (name === "submit_grade") {
    const verdict = field(parsed, raw, "verdict");
    const reasoning = field(parsed, raw, "reasoning");
    return {
      label: verdict === "pass" ? "Pass" : verdict === "partial" ? "Partial" : verdict === "fail" ? "Fail" : "Not gradable",
      category: "handoff",
      ...(reasoning ? { note: clean(reasoning).slice(0, 4_000) } : {}),
    };
  }
  if (name === "submit_applicability") {
    const decisions = parsed && typeof parsed === "object" && Array.isArray((parsed as { decisions?: unknown }).decisions)
      ? (parsed as { decisions: Array<{ decision?: unknown }> }).decisions
      : [];
    const count = (kind: string) => decisions.filter((entry) => entry.decision === kind).length;
    const parts = [
      count("supported") ? `${count("supported")} supported` : null,
      count("outside_scope") ? `${count("outside_scope")} outside scope` : null,
      count("uncertain") ? `${count("uncertain")} uncertain` : null,
    ].filter(Boolean);
    return {
      label: decisions.length === 0 ? "Finished the applicability check" : `Decided ${decisions.length} question${decisions.length === 1 ? "" : "s"}`,
      category: "handoff",
      ...(parts.length ? { note: parts.join(", ") } : {}),
    };
  }
  if (name === "submit_knowledge_answer") {
    // The answer as the reader sees it: its citation-group markers are for the host.
    const answer = field(parsed, raw, "answer")?.replace(/<!--\s*silicon-citation-group:[a-z][a-z0-9-]{0,63}:(?:start|end)\s*-->/gu, "");
    return { label: "Submitted the answer", category: "handoff", ...(answer ? { note: clean(answer).slice(0, 4_000) } : {}) };
  }
  if (name === "publish_knowledge" || name === "publish_knowledge_manifest" || name === "preflight_knowledge") {
    return { label: name === "preflight_knowledge" ? "Checked the Knowledge proposal" : "Proposed a Knowledge revision", category: "handoff" };
  }
  const pretty = name.replaceAll("_", " ");
  return { label: `${pretty[0]?.toUpperCase() ?? ""}${pretty.slice(1)}${path ? ` ${shortPath(path)}` : ""}`, category: "other" };
}

/** A call's state as its label reflects it. */
export type ToolLabelStatus = "running" | "succeeded" | "failed" | "cancelled" | "unfinished";

/**
 * Past-tense verbs a call's label can start with, each with its plain and
 * -ing forms, so a label claims an outcome only once the call has it.
 */
const LABEL_VERBS: Readonly<Record<string, readonly [string, string]>> = {
  Accepted: ["accept", "Accepting"],
  Analyzed: ["analyze", "Analyzing"],
  Cancelled: ["cancel", "Cancelling"],
  Checked: ["check", "Checking"],
  Decided: ["decide", "Deciding"],
  Edited: ["edit", "Editing"],
  Explored: ["explore", "Exploring"],
  Finished: ["finish", "Finishing"],
  Inspected: ["inspect", "Inspecting"],
  Listed: ["list", "Listing"],
  Loaded: ["load", "Loading"],
  Messaged: ["message", "Messaging"],
  Parsed: ["parse", "Parsing"],
  Proposed: ["propose", "Proposing"],
  Published: ["publish", "Publishing"],
  Ran: ["run", "Running"],
  Read: ["read", "Reading"],
  Resumed: ["resume", "Resuming"],
  Searched: ["search", "Searching"],
  Sent: ["send", "Sending"],
  Started: ["start", "Starting"],
  Stopped: ["stop", "Stopping"],
  Submitted: ["submit", "Submitting"],
  Viewed: ["view", "Viewing"],
  Waited: ["wait", "Waiting"],
  Wrote: ["write", "Writing"],
};

/** Calls whose label is their outcome (a grader's verdict, a count of decisions): what they do, plain and -ing. */
const OUTCOME_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  submit_grade: ["submit the grade", "Grading"],
  submit_applicability: ["submit the applicability check", "Checking applicability"],
};

/**
 * A call's label for its state. Labels are worded as done ("Proposed a
 * Knowledge revision", "Wrote status/plan.md"), which holds only once the
 * call succeeded: a failed call reads "Couldn't propose a Knowledge
 * revision", a cancelled one "Didn't …", a running one "Proposing …", and
 * one with no recorded result "Tried to …". A label not worded as an
 * outcome (a command line, a tool's name) is returned as is.
 */
export function toolLabelForStatus(label: string, toolName: string, status: ToolLabelStatus | null): string {
  if (status === "succeeded" || status === null) return label;
  let action: readonly [string, string] | undefined = OUTCOME_LABELS[toolName];
  if (action === undefined) {
    const match = /^([A-Z][a-z]+)\b(.*)$/su.exec(label);
    const verb = match === null ? undefined : LABEL_VERBS[match[1]!];
    if (match === null || verb === undefined) return label;
    // "Accepted or rejected subagent work": every verb of the phrase changes.
    const rest = match[2]!.replace(/^ or rejected\b/u, (part) => status === "running" ? " or rejecting" : " or reject");
    action = [`${verb[0]}${rest}`, `${verb[1]}${rest}`];
  }
  if (status === "running") return action[1];
  if (status === "failed") return `Couldn't ${action[0]}`;
  if (status === "cancelled") return `Didn't ${action[0]}`;
  return `Tried to ${action[0]}`;
}

function prettyPayload(raw: string): string {
  const parsed = parseJson(raw);
  if (parsed === undefined) return clean(raw);
  if (typeof parsed === "string") return clean(parsed);
  return clean(JSON.stringify(parsed, null, 2));
}

function bounded(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/** Adapter row: the fields AEye's agent_execution_events rows carry. */
export interface EventRow {
  id: number;
  kind: TraceThreadEvent["kind"];
  call_id: string | null;
  tool_name: string | null;
  status: string | null;
  detail: string;
  created_at: string;
}

/** AEye's mapEvent, without the benchmark grade lookup (no database here). */
export function traceThreadEvent(row: EventRow): TraceThreadEvent {
  const raw = String(row.detail ?? "");
  const base = {
    id: Number(row.id),
    kind: row.kind,
    at: row.created_at,
    callId: row.call_id,
    toolName: row.tool_name,
    status: row.status,
    length: raw.length,
  };
  if (row.kind === "assistant_text" || row.kind === "assistant_reasoning") {
    const { text, truncated } = bounded(clean(raw), PROSE_CHARS);
    return { ...base, text, truncated };
  }
  if (row.kind === "tool_output") {
    const parsed = parseJson(raw) as { stream?: unknown; text?: unknown } | undefined;
    const chunk = parsed && typeof parsed.text === "string" ? parsed.text : raw;
    const { text, truncated } = bounded(clean(chunk), PREVIEW_CHARS);
    const progress = traceOperationProgress(parsed);
    if (progress !== null) return { ...base, text, truncated, progress };
    return { ...base, text, truncated, stream: parsed?.stream === "stderr" ? "stderr" : "stdout" };
  }
  const { text, truncated } = bounded(prettyPayload(raw), PREVIEW_CHARS);
  const event: TraceThreadEvent = { ...base, text, truncated: truncated || false };
  if (row.kind === "tool_start") {
    const described = describeToolCall(String(row.tool_name ?? ""), raw);
    event.label = described.label;
    if (described.rawLabel) event.rawLabel = described.rawLabel;
    event.category = described.category;
    if (described.note) event.note = described.note;
  }
  if (row.tool_name === "spawn_agents" || row.tool_name === "wait_agents") {
    const ids = agentIdsIn(raw);
    if (ids.length > 0) event.agentIds = ids;
  }
  return event;
}

/** Full stored text of a row, as AEye's payload API returns it. */
export function traceFullPayload(row: EventRow): string {
  const raw = String(row.detail ?? "");
  if (row.kind === "assistant_text" || row.kind === "assistant_reasoning") return clean(raw);
  if (row.kind === "tool_output") {
    const parsed = parseJson(raw) as { text?: unknown } | undefined;
    return clean(parsed && typeof parsed.text === "string" ? parsed.text : raw);
  }
  return prettyPayload(raw);
}
