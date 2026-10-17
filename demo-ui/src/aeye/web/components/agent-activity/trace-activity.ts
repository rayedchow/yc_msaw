import type { TraceCompaction, TraceModelRetry, TraceThreadEvent } from "../../../src/build/build_trace_threads.js";
import type { RunResumption } from "../../../src/build/run_resumptions.js";
import { HANDOFF_TOOLS, linkOperationProgress, type ActivityEntry, type ActivityPayload, type ActivityTool } from "./activity-model.js";

/**
 * Adapter from a build trace thread (durable per-agent events and
 * compactions) to shared activity entries. Prose messages and compactions
 * pass through as items; tool events of one call merge into one tool.
 */
export type TraceItem =
  | { type: "message"; event: TraceThreadEvent }
  | { type: "compaction"; compaction: TraceCompaction }
  | { type: "model_retry"; retry: TraceModelRetry }
  | { type: "resumption"; resumption: RunResumption };

const STOP_REASONS: Readonly<Record<string, string>> = {
  retries_exhausted: "retries used up",
  partial_output_not_resettable: "its partial output was already shown",
  spending_control: "the spending control allowed no further request",
  local_deadline: "the call's time limit was reached",
};

/**
 * One line for a model call that retried a failed provider attempt, from its
 * durable attempt records only. `now` drives the wait countdown. Usage of a
 * failed attempt is never shown as free unless it is known to be unbilled.
 */
export function modelRetryLine(retry: TraceModelRetry, now: number): { text: string; live: boolean; stopped: boolean } {
  const last = retry.attempts.at(-1);
  if (last === undefined) return { text: "Model call retried", live: false, stopped: false };
  const failed = retry.attempts.length;
  const of = last.maxAttempts === null ? "" : ` of ${last.maxAttempts}`;
  const notes: string[] = [];
  if (retry.attempts.some((attempt) => attempt.partialOutput && attempt.outcome === "retrying")) notes.push("partial output discarded");
  if (retry.attempts.some((attempt) => attempt.unbilled === null)) notes.push("usage of the failed attempt unknown");
  const suffix = notes.length === 0 ? "" : `; ${notes.join("; ")}`;
  if (retry.outcome === "running") {
    if (last.outcome === "retrying") {
      const due = last.retryAt === null ? Number.NaN : Date.parse(last.retryAt) - now;
      const waiting = Number.isFinite(due) && due > 0 ? ` in ${Math.ceil(due / 1_000)} s` : "";
      return { text: `Attempt ${last.attempt}${of} failed: ${last.label}; retrying${waiting} (attempt ${last.attempt + 1}${of})${suffix}`, live: true, stopped: false };
    }
    return { text: `Attempt ${last.attempt}${of} failed: ${last.label}${suffix}`, live: false, stopped: true };
  }
  if (retry.outcome === "succeeded") {
    return { text: `Model call recovered on attempt ${failed + 1}${of} after ${last.label}${suffix}`, live: false, stopped: false };
  }
  if (retry.outcome === "deadline_exceeded") {
    const duringWait = last.outcome === "retrying";
    return {
      text: `Model call reached Shepherd's per-call time limit${duringWait ? " before the next retry" : ""} after ${failed} attempt${failed === 1 ? "" : "s"}. Last failure: ${last.label}${suffix}`,
      live: false,
      stopped: true,
    };
  }
  const reason = last.outcome === "stopped" && last.stopReason !== null ? STOP_REASONS[last.stopReason] : undefined;
  const outcome = retry.outcome === "cancelled" ? "was cancelled" : "failed";
  return {
    text: `Model call ${outcome} after ${failed} attempt${failed === 1 ? "" : "s"}: ${last.label}${reason ? `; ${reason}` : ""}${suffix}`,
    live: false,
    stopped: true,
  };
}

function payload(event: TraceThreadEvent): ActivityPayload {
  return {
    id: event.id,
    text: event.text,
    truncated: event.truncated,
    length: event.length,
    ...(event.stream ? { stream: event.stream } : {}),
  };
}

interface Building {
  tool: ActivityTool;
  hasStart: boolean;
}

/** The run's staged proposals, as the trace's publish cards show them. */
export interface TraceProposalContext {
  /** When each proposal was staged. */
  stagedAt: readonly string[];
  /** The newest proposal waits for review now. */
  waiting: boolean;
  /** The pull request, when known. */
  href: string | null;
}

function ms(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * A publish call that staged a proposal (one was staged between its start
 * and its result) reads as proposed: waiting for review when it staged the
 * newest proposal and the run waits for review. Whatever its call later
 * recorded (a hibernated call never returns; a failed merge ends the run), it
 * is never shown as running, failed or rejected.
 */
export function markStagedProposals<Item>(
  entries: readonly ActivityEntry<Item>[],
  context: TraceProposalContext | null,
): ActivityEntry<Item>[] {
  if (context === null || context.stagedAt.length === 0) return entries as ActivityEntry<Item>[];
  const staged = context.stagedAt.map(ms).filter(Number.isFinite);
  const newest = Math.max(...staged);
  return entries.map((entry) => {
    if (entry.type !== "tool" || !HANDOFF_TOOLS.has(entry.tool.toolName) || entry.tool.toolName === "complete_task") return entry;
    const from = ms(entry.tool.startedAt);
    const to = entry.tool.endedAt ? ms(entry.tool.endedAt) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(from)) return entry;
    const own = staged.filter((at) => at >= from - 1_000 && at <= to + 1_000);
    if (own.length === 0) return entry;
    const waiting = context.waiting && own.includes(newest);
    return { ...entry, tool: { ...entry.tool, proposal: { waiting, href: context.href } } };
  });
}

/** An agent as a subagent wait needs it. */
export interface WaitAgent {
  id: string;
  parentId: string | null;
  status: string;
}

export interface SubagentWait<A extends WaitAgent> {
  startedAt: string | null;
  /** Every subagent the wait names (its own children when it names none). */
  waitedOn: A[];
  /** Those still running. */
  running: A[];
}

/**
 * The live wait at the end of an agent's thread: its last entry is a wait
 * call that is still running. Null otherwise.
 */
export function activeSubagentWait<Item, A extends WaitAgent>(
  entries: readonly ActivityEntry<Item>[],
  agents: readonly A[],
  ownerId: string,
): SubagentWait<A> | null {
  const last = entries.at(-1);
  if (last?.type !== "tool") return null;
  const tool = last.tool;
  if (tool.status !== "running" || (tool.category !== "wait" && tool.toolName !== "wait_agents")) return null;
  const named = new Set(tool.agentIds ?? []);
  const waitedOn = named.size > 0
    ? agents.filter((agent) => named.has(agent.id))
    : agents.filter((agent) => agent.parentId === ownerId);
  if (waitedOn.length === 0) return null;
  const running = waitedOn.filter((agent) => agent.status === "running" || agent.status === "waiting");
  return { startedAt: tool.startedAt, waitedOn, running };
}

/**
 * `live`: the agent is still running, so a call without a result is running.
 * `resumptions`: those this window shows (see `shownResumptions`).
 */
export function traceActivityEntries(
  events: readonly TraceThreadEvent[],
  compactions: readonly TraceCompaction[],
  live: boolean,
  modelRetries: readonly TraceModelRetry[] = [],
  resumptions: readonly RunResumption[] = [],
): ActivityEntry<TraceItem>[] {
  const entries: ActivityEntry<TraceItem>[] = [];
  const calls = new Map<string, Building>();
  // Context summaries, retried model calls and resumptions sit between events by time.
  const pending: Array<{ at: string; entry: ActivityEntry<TraceItem> }> = [
    ...compactions.map((compaction) => ({ at: compaction.at, entry: { type: "item" as const, key: `c${compaction.id}`, item: { type: "compaction" as const, compaction } } })),
    ...modelRetries.map((retry) => ({ at: retry.at, entry: { type: "item" as const, key: `r${retry.callId}`, item: { type: "model_retry" as const, retry } } })),
    ...resumptions.map((resumption) => ({ at: resumption.at, entry: { type: "item" as const, key: `s${resumption.key}`, item: { type: "resumption" as const, resumption } } })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let next = 0;
  for (const event of events) {
    while (next < pending.length && pending[next]!.at <= event.at) {
      entries.push(pending[next++]!.entry);
    }
    if (event.kind === "assistant_text") {
      if (event.text.trim()) entries.push({ type: "item", key: `e${event.id}`, item: { type: "message", event } });
      continue;
    }
    if (event.kind === "assistant_reasoning") {
      if (event.text.trim()) {
        entries.push({ type: "thought", key: `e${event.id}`, thought: { key: `e${event.id}`, at: event.at, text: event.text } });
      }
      continue;
    }
    const callKey = event.callId ? `t${event.callId}` : `e${event.id}`;
    let building = calls.get(callKey);
    // Providers reuse call ids across turns: a second start for the same id
    // is a new call, never a continuation of the earlier one.
    if (building && event.kind === "tool_start" && building.hasStart) building = undefined;
    if (!building) {
      const key = calls.has(callKey) ? `${callKey}#${event.id}` : callKey;
      const toolName = event.toolName ?? "tool";
      building = {
        hasStart: false,
        tool: {
          key,
          callId: event.callId,
          toolName,
          label: toolName.replaceAll("_", " "),
          category: "other",
          status: live ? "running" : "unfinished",
          startedAt: null,
          endedAt: null,
          durationMs: null,
          input: null,
          outputs: [],
          result: null,
        },
      };
      calls.set(callKey, building);
      entries.push({ type: "tool", key, tool: building.tool });
    }
    const tool = building.tool;
    if (event.kind === "tool_start") {
      building.hasStart = true;
      tool.startedAt = event.at;
      tool.input = payload(event);
      if (event.label) tool.label = event.label;
      if (event.rawLabel) tool.rawLabel = event.rawLabel;
      if (event.category) tool.category = event.category;
      if (event.note) tool.note = event.note;
      if (event.verdict) tool.verdict = event.verdict;
    } else if (event.kind === "tool_output" && event.progress) {
      // A running host operation's state: the latest one is shown on the
      // call (and on a poll that waits for it); its stage lines are output.
      tool.progress = { ...event.progress, toolName: tool.toolName };
      if (event.text.trim()) tool.outputs.push({ ...payload(event), text: `${event.text}\n` });
    } else if (event.kind === "tool_output") {
      tool.outputs.push(payload(event));
    } else {
      tool.result = payload(event);
      // Typed benchmark terminals arrive live as a successful result; the
      // bounded start preview need not be replayed or parsed as authority.
      if (event.verdict) {
        tool.verdict = event.verdict;
        if (event.label) tool.label = event.label;
        if (event.note) tool.note = event.note;
      }
      tool.endedAt = event.at;
      tool.status = event.status === "failed" ? "failed" : event.status === "cancelled" ? "cancelled" : "succeeded";
    }
    if (event.agentIds?.length) tool.agentIds = [...new Set([...(tool.agentIds ?? []), ...event.agentIds])];
  }
  while (next < pending.length) entries.push(pending[next++]!.entry);
  return linkOperationProgress(entries);
}

/**
 * Merge a newer page into what is shown, by id, oldest first. Returns the
 * same array when nothing is new so memoized rows do not rebuild.
 */
export function mergeById<T extends { id: number }>(existing: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return existing as T[];
  const byId = new Map(existing.map((item) => [item.id, item]));
  let changed = false;
  for (const item of incoming) {
    const prior = byId.get(item.id);
    if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(item)) {
      byId.set(item.id, item);
      changed = true;
    }
  }
  if (!changed) return existing as T[];
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
