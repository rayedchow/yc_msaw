import { sha256 } from "../util.js";
import { formatReport, validateWiki } from "../wiki/validate.js";
import { runAgentLoop, type LoopStop } from "./agent.js";
import { addUsage, AgentMeter, BudgetExhaustedError, emptyUsage, type AgentUsage, type InvestigationBudget } from "./budget.js";
import { childSystemPrompt, childTaskPrompt, rootSystemPrompt, rootTaskPrompt, type PromptContext } from "./contract.js";
import { computePatch, findConflicts, lineDiff, manifestSha256, PatchScopeError, type KnowledgePatch, type PatchConflict } from "./patch.js";
import type { ChatClientFactory, ModelProfile, ProfileRegistry } from "./profiles.js";
import { describeEntry, describeScope, parseScope, scopeAllows, scopesOverlap, scopeWithin, ScopeError, type WriteScope } from "./scope.js";
import {
  AgentToolbox,
  providerGuidance,
  resolveProviderTools,
  ToolError,
  type ControlPlane,
  type ToolArgs,
  type ToolCallRecord,
  type ToolProviderRegistration,
} from "./tools.js";
import { parseAgentPath, type BuildWorkspace, type BuildWorkspaceFactory } from "./workspace.js";

/**
 * Recursive build-agent tree (AEye workspace-agent semantics, adapted):
 *  - the root and every child are independent multi-turn LLM agents with their own model profile;
 *  - children run concurrently with their parent in isolated workspaces and may spawn grandchildren
 *    within budget and within their own write scope;
 *  - a child's work is a proposal (exact patch against its spawn base), invisible to the parent until
 *    the parent accepts it; acceptance is an exact-base merge that fails with a conflict receipt
 *    rather than overwriting;
 *  - only the root publishes, and only after every completed child handoff is decided.
 * Every number in the receipt tree is host-measured; nothing is taken from model prose.
 */

export type AgentStatus = "running" | "completed" | "failed" | "budget_exhausted" | "cancelled" | "aborted";

export interface PublishRequest {
  agentId: string;
  files: Map<string, string>;
  summary: string;
}
export type PublishResult = { status: "published"; revisionId: string } | { status: "no_change"; revisionId: string };
/** Performs the actual CAS publish. Throw an error with code "conflict" (ConflictError) when the base moved. */
export type PublishCallback = (request: PublishRequest) => Promise<PublishResult>;

export type BuildLogger = (event: { at: string; agentId: string; event: string; detail?: Record<string, unknown> }) => void;

export interface OrchestratorOptions {
  buildId: string;
  baseRevision: string;
  sources: readonly string[];
  inputs: ReadonlyMap<string, string>;
  published: ReadonlyMap<string, string>;
  profiles: ProfileRegistry;
  clientFactory: ChatClientFactory;
  budget: InvestigationBudget;
  workspaceFactory: BuildWorkspaceFactory;
  toolProviders?: readonly ToolProviderRegistration[];
  publish: PublishCallback;
  /** Operator/eval instructions appended to the root task prompt. */
  instructions?: string;
  signal?: AbortSignal;
  log?: BuildLogger;
}

export interface FailureInfo {
  code: string;
  message: string;
  dimension?: string;
  limit?: number;
  used?: number;
}

export interface DecisionRecord {
  decision: "accepted" | "rejected" | "discarded";
  reason: string;
  decidedBy: string;
  at: string;
  applied?: string[];
}

export interface AgentReceipt {
  agentId: string;
  parentId: string | null;
  depth: number;
  profileId: string;
  model: string;
  objective: string;
  paths: string[];
  scope: string[] | "all";
  includeParentDraft: boolean;
  status: AgentStatus;
  failure?: FailureInfo;
  usage: AgentUsage;
  /** Sum over all descendants (not including this agent). */
  descendants: AgentUsage & { agents: number };
  startedAt: string;
  finishedAt: string | null;
  latencyMs: number | null;
  workspace: { kind: string; id: string } | null;
  baseManifestSha256: string | null;
  result?: {
    summary: string;
    handoff: { path: string; sha256: string; bytes: number } | null;
    patch: { sha256: string; baseManifestSha256: string; changes: Array<{ path: string; op: string; baseSha256: string | null; newSha256: string | null }>; moves: Array<{ from: string; to: string }> };
  };
  decision?: DecisionRecord;
  failedAccepts?: Array<{ at: string; reason: string; conflicts: PatchConflict[] }>;
  publish?: { status: "published" | "no_change"; revisionId: string; summary: string; treeSha256: string };
  toolCalls: Array<ToolCallRecord & { turn: number; session: number }>;
  children: AgentReceipt[];
}

export type BuildOutcome =
  | { kind: "published"; revisionId: string; summary: string }
  | { kind: "no_change"; revisionId: string; summary: string }
  | { kind: "publish_conflict"; message: string }
  | { kind: "failed"; code: string; message: string };

export interface OrchestratorResult {
  outcome: BuildOutcome;
  tree: AgentReceipt;
  agents: number;
  startedAt: string;
  finishedAt: string;
}

interface ChildResult {
  summary: string;
  handoff: { path: string; sha256: string; bytes: number; content: string } | null;
  patch: KnowledgePatch;
}

interface AgentNode {
  id: string;
  parentId: string | null;
  depth: number;
  profile: ModelProfile;
  objective: string;
  context?: string;
  paths: string[];
  scope: WriteScope;
  includeParentDraft: boolean;
  status: AgentStatus;
  failure?: FailureInfo;
  workspace: BuildWorkspace | null;
  workspaceInfo: { kind: string; id: string } | null;
  base: Map<string, string>;
  baseManifestSha256: string;
  declaredMoves: Array<{ from: string; to: string }>;
  result?: ChildResult;
  decision?: DecisionRecord;
  failedAccepts: Array<{ at: string; reason: string; conflicts: PatchConflict[] }>;
  publish?: { status: "published" | "no_change"; revisionId: string; summary: string; treeSha256: string };
  children: AgentNode[];
  nextChildIndex: number;
  meter: AgentMeter;
  controller: AbortController;
  signal: AbortSignal;
  cancelReason?: string;
  done: Promise<void>;
  startedAt: number;
  finishedAt: number | null;
  toolCalls: Array<ToolCallRecord & { turn: number; session: number }>;
}

const MAX_TOOL_LOG = 1000;
const MAX_HANDOFF_BYTES = 256 * 1024;
const HANDOFF_PREVIEW_BYTES = 6 * 1024;
const CANCEL_GRACE_MS = 30_000;

function isConflict(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "conflict";
}

export class BuildOrchestrator implements ControlPlane {
  readonly #o: OrchestratorOptions;
  readonly #nodes = new Map<string, AgentNode>();
  #root: AgentNode | null = null;
  #conflict: string | null = null;
  readonly #rootProviders;
  readonly #childProviders;

  constructor(opts: OrchestratorOptions) {
    this.#o = opts;
    this.#rootProviders = resolveProviderTools(opts.toolProviders ?? [], false);
    this.#childProviders = resolveProviderTools(opts.toolProviders ?? [], true);
  }

  #log(agentId: string, event: string, detail?: Record<string, unknown>) {
    try {
      this.#o.log?.({ at: new Date().toISOString(), agentId, event, ...(detail ? { detail } : {}) });
    } catch {
      /* logging never affects the build */
    }
  }

  #newNode(init: Omit<AgentNode, "status" | "workspace" | "workspaceInfo" | "declaredMoves" | "failedAccepts" | "children" | "nextChildIndex" | "meter" | "controller" | "signal" | "done" | "startedAt" | "finishedAt" | "toolCalls" | "baseManifestSha256">, parentSignal: AbortSignal): AgentNode {
    const controller = new AbortController();
    return {
      ...init,
      status: "running",
      workspace: null,
      workspaceInfo: null,
      baseManifestSha256: manifestSha256(init.base),
      declaredMoves: [],
      failedAccepts: [],
      children: [],
      nextChildIndex: 1,
      meter: new AgentMeter(this.#o.budget),
      controller,
      signal: AbortSignal.any([parentSignal, controller.signal]),
      done: Promise.resolve(),
      startedAt: Date.now(),
      finishedAt: null,
      toolCalls: [],
    };
  }

  async run(): Promise<OrchestratorResult> {
    const startedAt = new Date().toISOString();
    const signals = [AbortSignal.timeout(this.#o.budget.maxWallClockMs)];
    if (this.#o.signal) signals.push(this.#o.signal);
    const runSignal = AbortSignal.any(signals);
    const root = this.#newNode(
      { id: "root", parentId: null, depth: 0, profile: this.#o.profiles.root, objective: "Daily procedural-memory build", paths: [], scope: "all", includeParentDraft: false, base: new Map(this.#o.published) },
      runSignal,
    );
    this.#root = root;
    this.#nodes.set(root.id, root);
    try {
      const ws = this.#o.workspaceFactory({ buildId: this.#o.buildId, agentId: root.id, depth: 0 });
      root.workspace = ws;
      root.workspaceInfo = { kind: ws.kind, id: ws.id };
      try {
        await ws.init({ inputs: this.#o.inputs, published: this.#o.published, knowledge: this.#o.published, parentDraft: null });
      } catch (error) {
        root.status = "failed";
        root.failure = { code: "workspace_init_failed", message: errorText(error) };
      }
      if (root.status === "running") {
        root.done = this.#runAgent(root);
        await root.done;
      } else {
        await this.#finalize(root);
      }
    } finally {
      // Safety net: nothing may outlive the build (leases, loops).
      for (const n of this.#nodes.values()) if (n.status === "running") n.controller.abort(new Error("build ended"));
      await Promise.allSettled([...this.#nodes.values()].map((n) => n.done));
      await Promise.allSettled([...this.#nodes.values()].map((n) => this.#dispose(n)));
    }
    return { outcome: this.#outcome(root), tree: this.#receipt(root), agents: this.#nodes.size, startedAt, finishedAt: new Date().toISOString() };
  }

  #outcome(root: AgentNode): BuildOutcome {
    if (root.publish) return { kind: root.publish.status, revisionId: root.publish.revisionId, summary: root.publish.summary };
    if (this.#conflict) return { kind: "publish_conflict", message: this.#conflict };
    return { kind: "failed", code: root.failure?.code ?? "not_published", message: root.failure?.message ?? "Root agent ended without publishing" };
  }

  // -------------------------------------------------------------------------
  // Agent lifecycle
  // -------------------------------------------------------------------------

  async #runAgent(node: AgentNode): Promise<void> {
    try {
      const isRoot = node.parentId === null;
      const toolbox = new AgentToolbox(
        { agentId: node.id, depth: node.depth, buildId: this.#o.buildId, isRoot, workspace: node.workspace!, scope: node.scope, declaredMoves: node.declaredMoves, signal: node.signal },
        this,
        isRoot ? this.#rootProviders : this.#childProviders,
      );
      const promptCtx: PromptContext = {
        buildId: this.#o.buildId,
        budget: this.#o.budget,
        toolNames: toolbox.names(),
        selectableProfiles: this.#o.profiles.selectable,
        defaultChildProfileId: this.#o.profiles.defaultChild.id,
        providerGuidance: providerGuidance(this.#o.toolProviders ?? [], !isRoot),
      };
      const scopeList = node.scope === "all" ? [] : node.scope.map(describeEntry);
      const systemPrompt = isRoot ? rootSystemPrompt(promptCtx) : childSystemPrompt({ ...promptCtx, depth: node.depth, scope: scopeList, hasParentDraft: node.includeParentDraft });
      const taskPrompt = isRoot
        ? rootTaskPrompt({
            buildId: this.#o.buildId,
            baseRevision: this.#o.baseRevision,
            sources: this.#o.sources,
            inputFiles: this.#o.inputs.size,
            sessions: new Set([...this.#o.inputs.keys()].filter((k) => k.startsWith("sessions/")).map((k) => k.split("/")[1])).size,
            publishedPages: this.#o.published.size,
            cohortOverview: cohortOverview(this.#o.inputs),
            cohortBytes: [...this.#o.inputs.values()].reduce((n, c) => n + Buffer.byteLength(c, "utf8"), 0),
            instructions: this.#o.instructions,
          })
        : childTaskPrompt({ objective: node.objective, context: node.context, paths: node.paths, scope: scopeList, parentId: node.parentId! });
      const client = this.#o.clientFactory(node.profile, { buildId: this.#o.buildId, agentId: node.id, parentId: node.parentId, depth: node.depth, objective: node.objective });
      this.#log(node.id, "agent_started", { profile: node.profile.id, depth: node.depth, scope: describeScope(node.scope) });
      const stop = await runAgentLoop({
        client,
        systemPrompt,
        taskPrompt,
        toolbox,
        meter: node.meter,
        signal: node.signal,
        isTerminal: () => node.status !== "running",
        finishTool: isRoot ? "publish" : "complete_task",
        onToolCall: (r) => {
          if (node.toolCalls.length < MAX_TOOL_LOG) node.toolCalls.push(r);
          this.#log(node.id, "tool_call", { tool: r.name, ok: r.ok, code: r.code, turn: r.turn, session: r.session });
        },
        onSession: (e) => this.#log(node.id, "session_boundary", e),
        sessionState: (reason, session) => this.#sessionState(node, reason, session),
      });
      this.#applyStop(node, stop);
    } catch (error) {
      if (node.status === "running") {
        node.status = "failed";
        node.failure = { code: "internal_error", message: errorText(error) };
      }
    } finally {
      await this.#finalize(node);
    }
  }

  #applyStop(node: AgentNode, stop: LoopStop) {
    if (node.status !== "running") return;
    switch (stop.kind) {
      case "terminal":
        return;
      case "budget_exhausted":
        node.status = "budget_exhausted";
        node.failure = { code: "budget_exhausted", message: stop.error.message, dimension: stop.error.dimension, limit: stop.error.limit, used: stop.error.used };
        return;
      case "aborted":
        node.status = node.cancelReason ? "cancelled" : "aborted";
        node.failure = { code: node.cancelReason ? "cancelled" : "aborted", message: node.cancelReason ?? stop.reason };
        return;
      case "model_error":
        node.status = "failed";
        node.failure = { code: "model_error", message: stop.message };
        return;
      case "no_progress":
        node.status = "failed";
        node.failure = { code: "no_progress", message: stop.message };
        return;
      case "stopped_without_finishing":
        node.status = "failed";
        node.failure = { code: "stopped_without_finishing", message: stop.message };
        return;
    }
  }

  /** Host-authored, factual resume state for a new session (AEye checkpoint/reset), plus a progress fingerprint. */
  async #sessionState(node: AgentNode, reason: string | null, session: number): Promise<{ prompt: string; progressFingerprint: string }> {
    const ws = this.#activeWorkspace(node);
    const knowledge = await ws.snapshot("knowledge");
    const work = await ws.snapshot("work");
    const children = node.children.map((c) => ({ id: c.id, status: c.status, decision: c.decision?.decision ?? null }));
    const progressFingerprint = sha256(JSON.stringify({ k: manifestSha256(knowledge), w: manifestSha256(work), children }));
    if (reason === null) return { prompt: "", progressFingerprint };
    const changed = [...new Set([...knowledge.keys(), ...node.base.keys()])].filter((p) => knowledge.get(p) !== node.base.get(p)).sort();
    const lines = [
      `[host] Session ${session} started: the previous session reached its ${reason} limit, so the conversation was reset (AEye session boundary). Workspace state is intact. This summary is host-computed:`,
      `- knowledge/ draft: ${knowledge.size} page(s); changed vs your base: ${changed.length ? changed.slice(0, 80).map((p) => `knowledge/${p}${knowledge.has(p) ? "" : " (deleted)"}`).join(", ") : "(none)"}`,
      `- work/ files (your notes): ${work.size ? [...work.entries()].slice(0, 40).map(([p, c]) => `work/${p} (${Buffer.byteLength(c)} B)`).join(", ") : "(none)"}`,
      `- children: ${node.children.length ? node.children.map((c) => `${c.id} ${c.status}${c.decision ? ` ${c.decision.decision}` : c.status === "completed" ? " (decision pending)" : ""} scope=${JSON.stringify(describeScope(c.scope))}`).join("; ") : "(none)"}`,
      "Read your work/ notes and the draft to continue where you left off.",
    ];
    return { prompt: lines.join("\n"), progressFingerprint };
  }

  async #finalize(node: AgentNode): Promise<void> {
    // Children never outlive their parent; undecided handoffs are discarded explicitly.
    for (const c of node.children) {
      if (c.status === "running") {
        c.cancelReason = `parent ${node.id} ended (${node.status})`;
        c.controller.abort(new Error(c.cancelReason));
      }
    }
    await Promise.allSettled(node.children.map((c) => c.done));
    for (const c of node.children) {
      if (c.status === "completed" && !c.decision) c.decision = { decision: "discarded", reason: `parent ${node.id} ended without deciding`, decidedBy: "host", at: new Date().toISOString() };
    }
    node.finishedAt = Date.now();
    await this.#dispose(node);
    this.#log(node.id, "agent_finished", { status: node.status, failure: node.failure?.code });
  }

  async #dispose(node: AgentNode) {
    const ws = node.workspace;
    node.workspace = null;
    if (ws) {
      try {
        await ws.dispose();
      } catch (error) {
        this.#log(node.id, "workspace_dispose_failed", { message: errorText(error) });
      }
    }
  }

  #node(id: string): AgentNode {
    const n = this.#nodes.get(id);
    if (!n) throw new ToolError("internal_error", `Unknown agent ${id}`);
    return n;
  }

  #directChild(parent: AgentNode, childId: string): AgentNode {
    const c = parent.children.find((x) => x.id === childId);
    if (!c) throw new ToolError("not_your_child", `${childId} is not a direct child of ${parent.id}. Your children: ${parent.children.map((x) => x.id).join(", ") || "(none)"}`);
    return c;
  }

  #activeWorkspace(node: AgentNode): BuildWorkspace {
    if (!node.workspace) throw new ToolError("internal_error", `Workspace of ${node.id} is gone`);
    return node.workspace;
  }

  #compact(c: AgentNode) {
    return {
      agentId: c.id,
      status: c.status,
      depth: c.depth,
      profileId: c.profile.id,
      scope: describeScope(c.scope),
      objective: c.objective.slice(0, 200),
      turns: c.meter.usage.turns,
      toolCalls: c.meter.usage.toolCalls,
      ...(c.failure ? { failure: c.failure } : {}),
      ...(c.result ? { summary: c.result.summary.slice(0, 500), patchChanges: c.result.patch.changes.length } : {}),
      ...(c.decision ? { decision: c.decision.decision } : c.status === "completed" ? { decision: "pending" } : {}),
    };
  }

  #undecided(node: AgentNode): AgentNode[] {
    return node.children.filter((c) => c.status === "completed" && !c.decision);
  }

  #requireSettledChildren(node: AgentNode, action: string) {
    const running = node.children.filter((c) => c.status === "running").map((c) => c.id);
    if (running.length) throw new ToolError("children_running", `Cannot ${action} while children are running: ${running.join(", ")}. Wait for them (wait_agents) or cancel them (cancel_agents).`);
    const pending = this.#undecided(node).map((c) => c.id);
    if (pending.length) throw new ToolError("undecided_handoffs", `Cannot ${action}: completed child handoffs must be decided first (decide_agent_results): ${pending.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Control plane (tool implementations)
  // -------------------------------------------------------------------------

  async spawnAgents(agentId: string, args: ToolArgs<"spawn_agents">): Promise<unknown> {
    const parent = this.#node(agentId);
    const b = this.#o.budget;
    const isRoot = parent.parentId === null;
    // Validate every requested child before reserving anything (all-or-nothing).
    const specs = args.agents.map((a, i) => {
      let scope: WriteScope;
      try {
        scope = parseScope(a.knowledgeWriteScope);
      } catch (error) {
        if (error instanceof ScopeError) throw new ToolError("invalid_scope", `agents[${i}]: ${error.message}`);
        throw error;
      }
      if (!scopeWithin(scope, parent.scope)) {
        throw new ToolError("scope_escape", `agents[${i}]: knowledgeWriteScope ${JSON.stringify(describeScope(scope))} is not within your own scope ${JSON.stringify(describeScope(parent.scope))}`);
      }
      if (a.includeParentDraft && !isRoot) throw new ToolError("not_available", `agents[${i}]: only the root agent can spawn a child with includeParentDraft`);
      let profile: ModelProfile;
      try {
        profile = this.#o.profiles.childProfile(a.modelProfileId);
      } catch (error) {
        throw new ToolError("invalid_model_profile", `agents[${i}]: ${errorText(error)}`);
      }
      const paths = a.paths.map((p) => {
        try {
          const { area, rel } = parseAgentPath(p, { allowDirectory: true });
          return rel ? `${area}/${rel}` : `${area}/`;
        } catch (error) {
          throw new ToolError("invalid_path", `agents[${i}].paths: ${errorText(error)}`);
        }
      });
      return { a, scope, profile, paths };
    });
    for (let i = 0; i < specs.length; i++) {
      for (let j = i + 1; j < specs.length; j++) {
        if (scopesOverlap(specs[i]!.scope, specs[j]!.scope)) throw new ToolError("scope_overlap", `agents[${i}] and agents[${j}] have overlapping knowledgeWriteScopes`);
      }
      const active = parent.children.filter((c) => c.status === "running" || (c.status === "completed" && !c.decision));
      for (const s of active) {
        if (scopesOverlap(specs[i]!.scope, s.scope)) {
          throw new ToolError("scope_overlap", `agents[${i}] knowledgeWriteScope overlaps active sibling ${s.id} (${JSON.stringify(describeScope(s.scope))}); wait for and decide it first`);
        }
      }
    }
    // Snapshot the parent's draft once; every child in this batch branches from the same exact base.
    const base = await this.#activeWorkspace(parent).snapshot("knowledge");
    // Budget checks and reservation happen synchronously (no await) so concurrent spawns cannot race past limits.
    if (parent.depth + 1 > b.maxDepth) throw new BudgetExhaustedError("depth", b.maxDepth, parent.depth + 1, "Do this work yourself");
    if (parent.children.length + specs.length > b.maxChildren) throw new BudgetExhaustedError("children", b.maxChildren, parent.children.length + specs.length);
    const descendants = this.#nodes.size - 1;
    if (descendants + specs.length > b.maxDescendants) throw new BudgetExhaustedError("descendants", b.maxDescendants, descendants + specs.length);
    const running = [...this.#nodes.values()].filter((n) => n.status === "running").length;
    if (running + specs.length > b.maxConcurrentAgents) throw new BudgetExhaustedError("concurrent_agents", b.maxConcurrentAgents, running + specs.length, "Wait for running agents to finish, then spawn");
    if (parent.status !== "running" || parent.signal.aborted) throw new ToolError("agent_finished", "Parent is no longer running");
    const children = specs.map(({ a, scope, profile, paths }) => {
      const child = this.#newNode(
        { id: `${parent.id}.${parent.nextChildIndex++}`, parentId: parent.id, depth: parent.depth + 1, profile, objective: a.objective, context: a.context, paths, scope, includeParentDraft: a.includeParentDraft, base: new Map(base) },
        parent.signal,
      );
      this.#nodes.set(child.id, child);
      parent.children.push(child);
      return child;
    });
    // Materialize isolated workspaces; any failure rolls back the whole batch explicitly.
    const inits = await Promise.allSettled(
      children.map(async (c) => {
        const ws = this.#o.workspaceFactory({ buildId: this.#o.buildId, agentId: c.id, depth: c.depth });
        c.workspace = ws;
        c.workspaceInfo = { kind: ws.kind, id: ws.id };
        await ws.init({ inputs: this.#o.inputs, published: this.#o.published, knowledge: c.base, parentDraft: c.includeParentDraft ? base : null });
      }),
    );
    const failedInit = inits.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failedInit) {
      await Promise.allSettled(children.map((c) => this.#dispose(c)));
      for (const c of children) {
        this.#nodes.delete(c.id);
        parent.children.splice(parent.children.indexOf(c), 1);
      }
      parent.nextChildIndex -= children.length;
      throw new ToolError("workspace_init_failed", `Child workspace initialization failed; no children were started: ${errorText(failedInit.reason)}`);
    }
    for (const c of children) {
      c.startedAt = Date.now();
      c.done = this.#runAgent(c);
    }
    this.#log(parent.id, "spawned", { children: children.map((c) => c.id) });
    return {
      spawned: children.map((c) => ({ agentId: c.id, depth: c.depth, profileId: c.profile.id, scope: describeScope(c.scope), includeParentDraft: c.includeParentDraft, baseManifestSha256: c.baseManifestSha256 })),
      note: "Children run concurrently; continue your own work and use wait_agents / read_agent_result / decide_agent_results.",
    };
  }

  async waitAgents(agentId: string, args: ToolArgs<"wait_agents">): Promise<unknown> {
    const parent = this.#node(agentId);
    const selected = args.agentIds ? args.agentIds.map((id) => this.#directChild(parent, id)) : parent.children;
    const b = this.#o.budget;
    const timeoutMs = Math.min(Math.max(args.timeoutMs ?? b.waitDefaultMs, b.waitMinMs), b.waitMaxMs);
    const running = selected.filter((c) => c.status === "running");
    const started = Date.now();
    let timedOut = false;
    if (running.length) {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      await Promise.race([
        ...running.map((c) => c.done),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
        new Promise<void>((resolve) => {
          onAbort = resolve;
          parent.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      clearTimeout(timer);
      if (onAbort) parent.signal.removeEventListener("abort", onAbort);
    }
    return {
      timedOut,
      timeoutMs,
      waitedMs: Date.now() - started,
      agents: selected.map((c) => this.#compact(c)),
      running: parent.children.filter((c) => c.status === "running").map((c) => c.id),
      pendingDecisions: this.#undecided(parent).map((c) => c.id),
    };
  }

  async readAgentResult(agentId: string, args: ToolArgs<"read_agent_result">): Promise<unknown> {
    const parent = this.#node(agentId);
    const child = this.#directChild(parent, args.agentId);
    if (!child.result) return { ...this.#compact(child), note: child.status === "running" ? "Still running; no result yet." : "No result: the child did not complete." };
    const r = child.result;
    if (args.path !== undefined) {
      if (r.handoff && (args.path === r.handoff.path || args.path === `work/${r.handoff.path}`)) {
        return { agentId: child.id, path: r.handoff.path, sha256: r.handoff.sha256, ...sliceLines(r.handoff.content, args.offset, args.limit) };
      }
      let rel: string;
      try {
        const parsed = parseAgentPath(args.path.startsWith("knowledge/") ? args.path : `knowledge/${args.path}`);
        rel = parsed.rel;
      } catch (error) {
        throw new ToolError("invalid_path", errorText(error));
      }
      const change = r.patch.changes.find((c) => c.path === rel);
      if (!change) throw new ToolError("not_in_patch", `knowledge/${rel} is not changed by ${child.id}'s patch. Changed: ${r.patch.changes.map((c) => c.path).join(", ") || "(none)"}`);
      if (change.content === null) return { agentId: child.id, path: `knowledge/${rel}`, op: change.op, baseSha256: change.baseSha256, note: "Deleted by the patch" };
      return { agentId: child.id, path: `knowledge/${rel}`, op: change.op, baseSha256: change.baseSha256, newSha256: change.newSha256, ...sliceLines(change.content, args.offset, args.limit) };
    }
    const perFileLines = Math.max(15, Math.floor(300 / Math.max(1, r.patch.changes.length)));
    const handoffPreview = r.handoff ? Buffer.from(r.handoff.content, "utf8").subarray(0, HANDOFF_PREVIEW_BYTES).toString("utf8") : null;
    return {
      ...this.#compact(child),
      summary: r.summary,
      handoff: r.handoff
        ? { path: r.handoff.path, sha256: r.handoff.sha256, bytes: r.handoff.bytes, truncated: r.handoff.bytes > HANDOFF_PREVIEW_BYTES, content: handoffPreview, ...(r.handoff.bytes > HANDOFF_PREVIEW_BYTES ? { more: `read_agent_result with path=${r.handoff.path} and offset for the rest` } : {}) }
        : null,
      patch: {
        sha256: r.patch.sha256,
        baseManifestSha256: r.patch.baseManifestSha256,
        moves: r.patch.moves,
        changes: r.patch.changes.map((c) => {
          const d = lineDiff(c.op === "add" ? undefined : child.base.get(c.path), c.content ?? undefined, perFileLines);
          return { path: `knowledge/${c.path}`, op: c.op, baseSha256: c.baseSha256, newSha256: c.newSha256, bytes: c.content === null ? 0 : Buffer.byteLength(c.content), diff: d.diff, diffTruncated: d.truncated };
        }),
      },
    };
  }

  async decideAgentResults(agentId: string, args: ToolArgs<"decide_agent_results">): Promise<unknown> {
    const parent = this.#node(agentId);
    // Validate every target before deciding any.
    const targets = args.decisions.map((d) => {
      const child = this.#directChild(parent, d.agentId);
      if (child.decision) throw new ToolError("already_decided", `${child.id} was already ${child.decision.decision}`);
      if (child.status !== "completed" || !child.result) throw new ToolError("not_completed", `${child.id} is ${child.status}; only completed handoffs can be decided`);
      return { d, child };
    });
    const results: unknown[] = [];
    let allOk = true;
    for (const { d, child } of targets) {
      const at = new Date().toISOString();
      if (d.decision === "reject") {
        child.decision = { decision: "rejected", reason: d.reason, decidedBy: parent.id, at };
        results.push({ agentId: child.id, decision: "rejected", ok: true, applied: [] });
        continue;
      }
      const ws = this.#activeWorkspace(parent);
      const current = await ws.snapshot("knowledge");
      const patch = child.result!.patch;
      const outOfParentScope = patch.changes.filter((c) => !scopeAllows(parent.scope, c.path)).map((c) => c.path);
      if (outOfParentScope.length) throw new ToolError("scope_violation", `Patch touches paths outside ${parent.id}'s scope: ${outOfParentScope.join(", ")}`);
      const conflicts = findConflicts(current, patch);
      if (conflicts.length) {
        allOk = false;
        child.failedAccepts.push({ at, reason: d.reason, conflicts });
        results.push({
          agentId: child.id,
          decision: "accept",
          ok: false,
          code: "patch_conflict",
          message: "Exact-base merge refused: these pages changed in your draft since the child branched. Nothing was applied. Preserve your current tree, reject this handoff, and redo still-useful work yourself from the traces.",
          conflicts: conflicts.map((c) => ({ path: `knowledge/${c.path}`, expectedBaseSha256: c.expectedBaseSha256, actualSha256: c.actualSha256 })),
        });
        continue;
      }
      const applied: string[] = [];
      try {
        for (const c of patch.changes) {
          if (c.content === null) await ws.removeFile("knowledge", c.path);
          else await ws.writeFile("knowledge", c.path, c.content);
          applied.push(c.path);
        }
      } catch (error) {
        // Restore the exact pre-merge bytes of every path already touched.
        const rollbackErrors: string[] = [];
        for (const p of applied) {
          try {
            const before = current.get(p);
            if (before === undefined) await ws.removeFile("knowledge", p);
            else await ws.writeFile("knowledge", p, before);
          } catch (e) {
            rollbackErrors.push(`${p}: ${errorText(e)}`);
          }
        }
        allOk = false;
        results.push({ agentId: child.id, decision: "accept", ok: false, code: "apply_failed", message: `Applying the patch failed (${errorText(error)}); ${rollbackErrors.length ? `ROLLBACK INCOMPLETE: ${rollbackErrors.join("; ")}` : "rolled back to the exact pre-merge bytes"}` });
        continue;
      }
      parent.declaredMoves.push(...patch.moves);
      child.decision = { decision: "accepted", reason: d.reason, decidedBy: parent.id, at, applied };
      results.push({ agentId: child.id, decision: "accepted", ok: true, patchSha256: patch.sha256, applied: applied.map((p) => `knowledge/${p}`) });
    }
    this.#log(parent.id, "decided", { results: results.length, allOk });
    if (!allOk) throw new ToolError("decision_failed", "One or more decisions failed; see details. Failed accepts left the child undecided and your draft unchanged.", { results });
    return { results, pendingDecisions: this.#undecided(parent).map((c) => c.id) };
  }

  async cancelAgents(agentId: string, args: ToolArgs<"cancel_agents">): Promise<unknown> {
    const parent = this.#node(agentId);
    const targets = args.agentIds.map((id) => this.#directChild(parent, id));
    const notRunning = targets.filter((c) => c.status !== "running").map((c) => `${c.id} (${c.status})`);
    if (notRunning.length) throw new ToolError("not_running", `Only running children can be cancelled: ${notRunning.join(", ")}`);
    for (const c of targets) {
      c.cancelReason = `cancelled by ${parent.id}: ${args.reason}`;
      c.controller.abort(new Error(c.cancelReason));
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(targets.map((c) => c.done)), new Promise((r) => (timer = setTimeout(r, CANCEL_GRACE_MS)))]);
    clearTimeout(timer);
    return { cancelled: targets.map((c) => ({ agentId: c.id, status: c.status })) };
  }

  async completeTask(agentId: string, args: ToolArgs<"complete_task">): Promise<unknown> {
    const node = this.#node(agentId);
    if (node.parentId === null) throw new ToolError("not_available", "complete_task is only for child agents");
    this.#requireSettledChildren(node, "complete_task");
    const ws = this.#activeWorkspace(node);
    let handoff: ChildResult["handoff"] = null;
    if (args.handoffFile !== undefined) {
      const raw = args.handoffFile.startsWith("work/") ? args.handoffFile : `work/${args.handoffFile}`;
      const { area, rel } = parseAgentPath(raw);
      if (area !== "work") throw new ToolError("invalid_path", "handoffFile must be under work/");
      const bytes = await ws.readFile("work", rel);
      if (bytes.length > MAX_HANDOFF_BYTES) throw new ToolError("too_large", `handoffFile is ${bytes.length} bytes (max ${MAX_HANDOFF_BYTES})`);
      handoff = { path: `work/${rel}`, sha256: sha256(bytes), bytes: bytes.length, content: bytes.toString("utf8") };
    }
    let patch: KnowledgePatch;
    try {
      patch = computePatch(node.base, await ws.snapshot("knowledge"), node.scope, node.declaredMoves);
    } catch (error) {
      if (error instanceof PatchScopeError) throw new ToolError("scope_violation", error.message);
      throw error;
    }
    node.result = { summary: args.summary, handoff, patch };
    node.status = "completed";
    return { status: "completed", patchSha256: patch.sha256, changes: patch.changes.map((c) => ({ path: `knowledge/${c.path}`, op: c.op })), moves: patch.moves, handoff: handoff ? { path: handoff.path, sha256: handoff.sha256, bytes: handoff.bytes } : null };
  }

  async publish(agentId: string, args: ToolArgs<"publish">): Promise<unknown> {
    const node = this.#node(agentId);
    if (node.parentId !== null) throw new ToolError("not_available", "publish is root-only");
    this.#requireSettledChildren(node, "publish");
    const files = await this.#activeWorkspace(node).snapshot("knowledge");
    const report = validateWiki(files);
    if (!report.ok) throw new ToolError("invalid_wiki", `The draft fails validation; nothing was published. Fix these and publish again.\n${formatReport(report, 40)}`);
    const treeSha256 = manifestSha256(files);
    let result: PublishResult;
    try {
      result = await this.#o.publish({ agentId, files, summary: args.summary });
    } catch (error) {
      if (isConflict(error)) {
        this.#conflict = errorText(error);
        node.status = "failed";
        node.failure = { code: "publish_conflict", message: this.#conflict };
        throw new ToolError("publish_conflict", `${this.#conflict} The host will rebuild on the new head; this attempt ends.`);
      }
      throw new ToolError("publish_failed", errorText(error));
    }
    node.publish = { ...result, summary: args.summary, treeSha256 };
    node.status = "completed";
    return { status: result.status, revisionId: result.revisionId, treeSha256, pages: report.stats.pages, warnings: report.warnings.length };
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  #receipt(node: AgentNode): AgentReceipt {
    const children = node.children.map((c) => this.#receipt(c));
    let desc: AgentUsage & { agents: number } = { ...emptyUsage(), agents: 0 };
    for (const c of children) {
      const sum = addUsage(addUsage(desc, c.usage), c.descendants);
      desc = { ...sum, agents: desc.agents + 1 + c.descendants.agents };
    }
    const r = node.result;
    return {
      agentId: node.id,
      parentId: node.parentId,
      depth: node.depth,
      profileId: node.profile.id,
      model: node.profile.model,
      objective: node.objective.slice(0, 1000),
      paths: node.paths,
      scope: describeScope(node.scope),
      includeParentDraft: node.includeParentDraft,
      status: node.status,
      ...(node.failure ? { failure: node.failure } : {}),
      usage: { ...node.meter.usage },
      descendants: desc,
      startedAt: new Date(node.startedAt).toISOString(),
      finishedAt: node.finishedAt ? new Date(node.finishedAt).toISOString() : null,
      latencyMs: node.finishedAt ? node.finishedAt - node.startedAt : null,
      workspace: node.workspaceInfo,
      baseManifestSha256: node.baseManifestSha256,
      ...(r
        ? {
            result: {
              summary: r.summary,
              handoff: r.handoff ? { path: r.handoff.path, sha256: r.handoff.sha256, bytes: r.handoff.bytes } : null,
              patch: { sha256: r.patch.sha256, baseManifestSha256: r.patch.baseManifestSha256, changes: r.patch.changes.map(({ path, op, baseSha256, newSha256 }) => ({ path, op, baseSha256, newSha256 })), moves: r.patch.moves },
            },
          }
        : {}),
      ...(node.decision ? { decision: node.decision } : {}),
      ...(node.failedAccepts.length ? { failedAccepts: node.failedAccepts } : {}),
      ...(node.publish ? { publish: node.publish } : {}),
      toolCalls: node.toolCalls,
      children,
    };
  }
}

function sliceLines(content: string, offset = 1, limit = 400) {
  const lines = content.split("\n");
  if (offset > lines.length) throw new ToolError("out_of_range", `offset ${offset} is beyond end (${lines.length} lines)`);
  const out: string[] = [];
  let used = 0;
  for (let i = offset - 1; i < lines.length && out.length < limit; i++) {
    const size = Buffer.byteLength(lines[i]!, "utf8") + 1;
    if (used + size > 12 * 1024 && out.length > 0) break;
    out.push(lines[i]!.slice(0, 12 * 1024));
    used += size;
  }
  const endLine = offset + out.length - 1;
  return { totalLines: lines.length, startLine: offset, endLine, nextOffset: endLine < lines.length ? endLine + 1 : null, truncated: endLine < lines.length, content: out.join("\n") };
}

/** Host-computed cohort listing for the root task prompt (session ids, objective field, event lines). Bounded. */
export function cohortOverview(inputs: ReadonlyMap<string, string>, max = 60): string[] {
  const sessions = new Map<string, { objective?: string; events: number; payloads: number; bytes: number }>();
  for (const [p, content] of inputs) {
    const m = /^sessions\/([^/]+)\/(.+)$/.exec(p);
    if (!m) continue;
    const s = sessions.get(m[1]!) ?? { events: 0, payloads: 0, bytes: 0 };
    s.bytes += Buffer.byteLength(content, "utf8");
    if (m[2] === "events.jsonl") s.events = content.split("\n").filter((l) => l.trim()).length;
    else if (m[2] === "session.json") {
      try {
        const o = JSON.parse(content) as Record<string, unknown>;
        const obj = o.objective ?? o.task ?? o.title;
        if (typeof obj === "string") s.objective = obj.replace(/\s+/g, " ").slice(0, 160);
      } catch {
        s.objective = "(session.json is not valid JSON)";
      }
    } else if (m[2]!.startsWith("payloads/")) s.payloads += 1;
    sessions.set(m[1]!, s);
  }
  const out = [...sessions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, max).map(([id, s]) => `${id}: ${s.events} event(s)${s.payloads ? `, ${s.payloads} payload(s)` : ""}, ${Math.ceil(s.bytes / 1024)} KiB${s.objective ? ` - objective (untrusted, as captured): ${JSON.stringify(s.objective)}` : ""}`);
  if (sessions.size > max) out.push(`... and ${sessions.size - max} more session(s); see inputs/manifest.json and ls inputs/sessions/`);
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBuildTree(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  return new BuildOrchestrator(opts).run();
}
