/**
 * Investigation budget for the daily procedural-memory build tree.
 *
 * Defaults are ported from AEye's `defaultWorkspaceRootInvestigationBudget()`
 * (askshepherd/aeye-shepherd, src/agent/workspace_model.ts, ~line 470 in
 * .context/references/aeye-workspace-model.ts): maxDepth 4, maxChildren 32,
 * maxDescendants 32, maxTurns 24, maxToolCalls 64, maxInputBytes 128 MiB,
 * maxOutputBytes 16 MiB. maxConcurrentAgents, wait limits and the wall clock
 * are additions for this harness. Evals may override any field within the
 * hard ceilings below; overrides are recorded in the build receipt.
 *
 * Semantics (enforced by the orchestrator, never by prompt):
 *  - maxDepth: deepest allowed agent depth (root = 0).
 *  - maxChildren: lifetime direct children per agent.
 *  - maxDescendants: lifetime non-root agents in the whole tree.
 *  - maxConcurrentAgents: agents running at once (root included); spawning beyond it fails explicitly.
 *  - maxTurns / maxToolCalls / maxInputBytes / maxOutputBytes: per agent SESSION, as in AEye
 *    (`sessionBoundary()` / `resetSessionUsage()` in aeye-workspace-agent.ts ~38037): a turn is one
 *    model call (parallel tool calls in one reply are one turn but N tool calls). Reaching a limit is
 *    a session boundary: the host checkpoints, resets the conversation to a host-authored state
 *    summary, and the agent continues. Input bytes are serialized request bytes; output bytes are
 *    model reply bytes.
 *  - maxSessions (harness addition; AEye bounds sessions only by wall clock + no-progress): lifetime
 *    sessions per agent. Exceeding it is an explicit budget_exhausted failure. Two consecutive
 *    sessions without workspace/child progress stop the agent as no_progress (AEye no-progress rule).
 */
export interface InvestigationBudget {
  maxDepth: number;
  maxChildren: number;
  maxDescendants: number;
  maxTurns: number;
  maxToolCalls: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxConcurrentAgents: number;
  /** Lifetime sessions per agent (each session is bounded by maxTurns/maxToolCalls/bytes). */
  maxSessions: number;
  /** wait_agents timeout clamp. */
  waitMinMs: number;
  waitMaxMs: number;
  waitDefaultMs: number;
  /** Whole-tree wall clock for one build attempt. */
  maxWallClockMs: number;
}

export const DEFAULT_BUILD_BUDGET: Readonly<InvestigationBudget> = Object.freeze({
  // AEye defaultWorkspaceRootInvestigationBudget():
  maxDepth: 4,
  maxChildren: 32,
  maxDescendants: 32,
  maxTurns: 24,
  maxToolCalls: 64,
  maxInputBytes: 128 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  // Harness additions:
  maxConcurrentAgents: 4,
  maxSessions: 4,
  waitMinMs: 1_000,
  waitMaxMs: 600_000,
  waitDefaultMs: 60_000,
  maxWallClockMs: 2 * 60 * 60 * 1000,
});

const CEILINGS: Readonly<InvestigationBudget> = Object.freeze({
  maxDepth: 8,
  maxChildren: 64,
  maxDescendants: 128,
  maxTurns: 200,
  maxToolCalls: 1_000,
  maxInputBytes: 1024 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxConcurrentAgents: 32,
  maxSessions: 50,
  waitMinMs: 600_000,
  waitMaxMs: 3_600_000,
  waitDefaultMs: 3_600_000,
  maxWallClockMs: 12 * 60 * 60 * 1000,
});

export class BudgetConfigError extends Error {
  readonly code = "invalid_budget";
}

/** Merge per-run (eval) overrides over the AEye defaults; rejects non-integers, negatives and values above hard ceilings. */
export function resolveBudget(overrides: Partial<InvestigationBudget> = {}): InvestigationBudget {
  const out = { ...DEFAULT_BUILD_BUDGET };
  for (const [key, value] of Object.entries(overrides) as Array<[keyof InvestigationBudget, number | undefined]>) {
    if (value === undefined) continue;
    if (!(key in DEFAULT_BUILD_BUDGET)) throw new BudgetConfigError(`Unknown budget field ${key}`);
    if (!Number.isInteger(value) || value < 0) throw new BudgetConfigError(`Budget ${key} must be a non-negative integer (got ${value})`);
    if (value > CEILINGS[key]) throw new BudgetConfigError(`Budget ${key}=${value} exceeds hard ceiling ${CEILINGS[key]}`);
    out[key] = value;
  }
  if (out.maxConcurrentAgents < 1) throw new BudgetConfigError("maxConcurrentAgents must be >= 1 (the root agent counts)");
  if (out.maxSessions < 1) throw new BudgetConfigError("maxSessions must be >= 1");
  if (out.maxTurns < 1 || out.maxToolCalls < 1) throw new BudgetConfigError("maxTurns and maxToolCalls must be >= 1");
  if (out.waitMinMs > out.waitMaxMs) throw new BudgetConfigError("waitMinMs must be <= waitMaxMs");
  out.waitDefaultMs = Math.min(Math.max(out.waitDefaultMs, out.waitMinMs), out.waitMaxMs);
  return out;
}

export type BudgetDimension = "turns" | "tool_calls" | "input_bytes" | "output_bytes" | "depth" | "children" | "descendants" | "concurrent_agents" | "wall_clock" | "sessions";

/** Explicit budget failure. Never converted into a partial success. */
export class BudgetExhaustedError extends Error {
  readonly code = "budget_exhausted";
  constructor(
    readonly dimension: BudgetDimension,
    readonly limit: number,
    readonly used: number,
    detail = "",
  ) {
    super(`Budget exhausted: ${dimension} limit ${limit} (used/requested ${used})${detail ? `. ${detail}` : ""}`);
  }
}

/** Usage counters for one agent. */
export interface AgentUsage {
  sessions: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputBytes: number;
  outputBytes: number;
  promptTokens: number;
  completionTokens: number;
  modelLatencyMs: number;
}

export function emptyUsage(): AgentUsage {
  return { sessions: 0, turns: 0, toolCalls: 0, toolErrors: 0, inputBytes: 0, outputBytes: 0, promptTokens: 0, completionTokens: 0, modelLatencyMs: 0 };
}

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    sessions: a.sessions + b.sessions,
    turns: a.turns + b.turns,
    toolCalls: a.toolCalls + b.toolCalls,
    toolErrors: a.toolErrors + b.toolErrors,
    inputBytes: a.inputBytes + b.inputBytes,
    outputBytes: a.outputBytes + b.outputBytes,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    modelLatencyMs: a.modelLatencyMs + b.modelLatencyMs,
  };
}

export type SessionBoundary = "turns" | "tool_calls" | "input_bytes" | "output_bytes";

/**
 * Per-agent meter. Lifetime usage is cumulative; session counters reset at each
 * AEye-style session boundary.
 */
export class AgentMeter {
  readonly usage = emptyUsage();
  readonly session = { turns: 0, toolCalls: 0, inputBytes: 0, outputBytes: 0 };
  constructor(readonly budget: InvestigationBudget) {
    this.usage.sessions = 1;
  }

  /** Which session limit has been reached (checked before each model call), or null. */
  boundary(nextRequestBytes: number): SessionBoundary | null {
    const b = this.budget;
    if (this.session.turns >= b.maxTurns) return "turns";
    if (this.session.toolCalls >= b.maxToolCalls) return "tool_calls";
    if (this.session.outputBytes >= b.maxOutputBytes) return "output_bytes";
    if (this.session.turns > 0 && this.session.inputBytes + nextRequestBytes > b.maxInputBytes) return "input_bytes";
    return null;
  }

  /** Start the next session; explicit failure when the lifetime session budget is spent. */
  startNewSession(reason: SessionBoundary): void {
    const limits: Record<SessionBoundary, number> = { turns: this.budget.maxTurns, tool_calls: this.budget.maxToolCalls, input_bytes: this.budget.maxInputBytes, output_bytes: this.budget.maxOutputBytes };
    const used: Record<SessionBoundary, number> = { turns: this.session.turns, tool_calls: this.session.toolCalls, input_bytes: this.session.inputBytes, output_bytes: this.session.outputBytes };
    if (this.usage.sessions >= this.budget.maxSessions) {
      throw new BudgetExhaustedError(reason, limits[reason], used[reason], `Session limit reached in the last of ${this.budget.maxSessions} allowed session(s)`);
    }
    this.usage.sessions += 1;
    this.session.turns = 0;
    this.session.toolCalls = 0;
    this.session.inputBytes = 0;
    this.session.outputBytes = 0;
  }

  beginTurn(requestBytes: number): void {
    if (requestBytes > this.budget.maxInputBytes) throw new BudgetExhaustedError("input_bytes", this.budget.maxInputBytes, requestBytes, "A single request exceeds the input budget");
    this.usage.turns += 1;
    this.session.turns += 1;
    this.usage.inputBytes += requestBytes;
    this.session.inputBytes += requestBytes;
  }

  recordReply(replyBytes: number, promptTokens: number, completionTokens: number, latencyMs: number): void {
    this.usage.outputBytes += replyBytes;
    this.session.outputBytes += replyBytes;
    this.usage.promptTokens += promptTokens;
    this.usage.completionTokens += completionTokens;
    this.usage.modelLatencyMs += latencyMs;
  }

  recordToolCall(): void {
    this.usage.toolCalls += 1;
    this.session.toolCalls += 1;
  }

  remaining(): { turns: number; toolCalls: number; sessions: number } {
    return { turns: this.budget.maxTurns - this.session.turns, toolCalls: this.budget.maxToolCalls - this.session.toolCalls, sessions: this.budget.maxSessions - this.usage.sessions };
  }
}
