/**
 * Real memory builds for the CRM bench: DailyBuildService -> runMemoryBuild (Fireworks Kimi root, GLM/MiniMax
 * selectable children, Modal build workspaces) over ONE tenant namespace's own traces. The client wrapper only
 * OBSERVES (live UI + builder usage meter); it never alters requests or replies, except that once the declared
 * builder budget is exhausted further model calls throw (an explicit, recorded budget stop).
 */
import { DailyBuildService, type MemoryBuilder } from "../../src/daily/service.js";
import { createModalBuildWorkspaceFactory, createProfileRegistry, fireworksClientFactory, resolveBudget, runMemoryBuild, type AgentReceipt, type ChatClientFactory, type ToolProviderRegistration } from "../../src/harness/index.js";
import type { ObjectStore } from "../../src/store/objects.js";
import { BudgetExceeded, scrub, type LiveLog, type Status, type UsageMeter } from "./infra.js";

/** HISTORICAL: the builder budget declared in the crm1/crm2 manifests (kept as-emitted; never applied retroactively). */
export const BUILDER_BUDGET_ORIGINAL = { maxSessions: 1, maxDescendants: 3, maxDepth: 2, maxConcurrentAgents: 3, maxTurns: 40, maxToolCalls: 160, maxWallClockMs: 900_000 } as const;
/**
 * AMENDMENT high-limits (reports/crm-budget-amendment-high-limits.json): per-session turns/tool calls x100 for builds
 * started after the amendment. Sessions, delegation shape, wall clock and token ceilings are UNCHANGED.
 */
export const BUILDER_BUDGET_HIGH = { ...BUILDER_BUDGET_ORIGINAL, maxTurns: 4_000, maxToolCalls: 16_000 } as const;
export type BuilderBudget = Record<keyof typeof BUILDER_BUDGET_ORIGINAL, number>;
export const BUILDER_BUDGETS = { original: BUILDER_BUDGET_ORIGINAL, high: BUILDER_BUDGET_HIGH } as const;
/** Default for future builds (an explicit `budget` from the caller still wins field by field). */
export const BUILDER_BUDGET = BUILDER_BUDGET_HIGH;

/** Fail closed BEFORE any paid call if the harness would reject this budget (resolveBudget enforces hard ceilings). */
export function assertBuilderBudgetAccepted(budget: Partial<BuilderBudget>): void {
  try {
    resolveBudget(budget);
  } catch (e) {
    throw new Error(`builder budget ${JSON.stringify(budget)} rejected by the harness (${String((e as Error)?.message ?? e)}); refusing to start a paid build`);
  }
}

const harnessStatus = (s: unknown): Status => {
  const v = String(s ?? "");
  if (v === "succeeded" || v === "completed" || v === "done") return "succeeded";
  if (v === "failed" || v === "error" || v === "budget_exhausted" || v === "no_progress") return "failed";
  if (v === "cancelled" || v === "aborted" || v === "interrupted") return "interrupted";
  if (v === "partial") return "partial";
  return "unknown";
};

export interface BenchBuildResult {
  ns: string;
  label: string;
  days: string[];
  receipts: Array<Record<string, unknown>>;
  status: string;
  revisionBefore: string | null;
  revisionAfter: string | null;
  usage: { calls: number; promptTokens: number; completionTokens: number };
  agents: Array<{ agentId: string; parentId: string | null; model: string; depth: number; status: string; turns: number; toolCalls: number; promptTokens: number; completionTokens: number; toolCallLog: Array<{ name: string; ok: boolean; code?: string }> }>;
  traceArchive: unknown[];
  budget: Record<string, number>;
  wallMs: number;
}

export async function runBenchBuild(p: {
  store: ObjectStore;
  ns: string;
  label: string;
  apiKey: string;
  meter: UsageMeter;
  live: LiveLog;
  toolProviders?: (ctx: { ns: string; buildId: string; emitAgent: (agentId: string) => string }) => Promise<readonly ToolProviderRegistration[]>;
  instructions?: string;
  /** Declared override of BUILDER_BUDGET (recorded in the result). */
  budget?: Partial<BuilderBudget>;
  log: (m: string) => void;
}): Promise<BenchBuildResult> {
  const budget = { ...BUILDER_BUDGET, ...(p.budget ?? {}) };
  assertBuilderBudgetAccepted(budget);
  const { MemoryRepo } = await import("../../src/store/memory.js");
  const repo = new MemoryRepo(p.store, p.ns);
  const revisionBefore = (await repo.head())?.value.revisionId ?? null;
  const prefix = `build-${p.label}`;
  const uiId = (agentId: string) => `${prefix}:${agentId}`;
  const parents = new Map<string, string | null>();
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  const base = fireworksClientFactory(p.apiKey);
  const factory: ChatClientFactory = (profile, ctx) => {
    const inner = base(profile, ctx);
    let seen = 0;
    const id = uiId(ctx.agentId);
    const parent = ctx.parentId ? uiId(ctx.parentId) : `${prefix}:service`;
    return {
      model: inner.model,
      async chat(msgs, tools, opts) {
        if (p.meter.exceeded()) throw new BudgetExceeded(`builder budget exhausted before a model call (${JSON.stringify(p.meter.snapshot())})`);
        for (const m of msgs.slice(seen)) {
          if (m.role === "tool") p.live.emit({ agentId: id, parentId: parent, kind: "tool_result", title: "tool result (as seen by the model)", text: String(m.content ?? ""), data: { callId: m.tool_call_id } });
          else if (m.role === "user") p.live.emit({ agentId: id, parentId: parent, kind: "message", title: seen === 0 ? "task given to the agent" : "user/harness message", text: String(m.content ?? "") });
        }
        const res = await inner.chat(msgs, tools, opts);
        seen = msgs.length + 1;
        usage.calls += 1;
        usage.promptTokens += res.usage?.prompt_tokens ?? 0;
        usage.completionTokens += res.usage?.completion_tokens ?? 0;
        p.meter.add({ input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0, cost: null });
        const text = typeof res.message.content === "string" ? res.message.content : "";
        if (text.trim()) p.live.emit({ agentId: id, parentId: parent, kind: "message", title: "assistant", text, data: { model: inner.model, usage: res.usage } });
        for (const tc of res.message.tool_calls ?? []) {
          let args: unknown = tc.function.arguments;
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* keep raw */
          }
          p.live.emit({ agentId: id, parentId: parent, kind: "tool_call", title: tc.function.name, status: "running", data: { callId: tc.id, args } });
        }
        return res;
      },
    };
  };
  const profiles = createProfileRegistry({ rootProfileId: "kimi-k3", childProfileIds: ["kimi-k3", "glm-5p3", "minimax-m3"], defaultChildProfileId: "glm-5p3" });
  p.live.setAgent(`${prefix}:service`, { name: `Memory build ${p.label} (operator wrapper)`, role: "operator", status: "running" });
  const builderLog = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return p.log(scrub(String(raw)));
    const e = raw as { at: string; agentId: string; event: string; detail?: Record<string, unknown> };
    if (e.event === "spawned") for (const c of (e.detail?.children as string[]) ?? []) parents.set(c, e.agentId);
    const parentId = parents.get(e.agentId) ?? null;
    if (e.event === "agent_started") p.live.setAgent(uiId(e.agentId), { parentId: parentId ? uiId(parentId) : `${prefix}:service`, name: `${p.label} ${parentId ? "child" : "root"} build agent (depth ${String(e.detail?.depth ?? "?")}, ${String(e.detail?.profile ?? "")})`, model: String(e.detail?.profile ?? ""), role: "build", status: "running" });
    if (e.event === "agent_finished") p.live.setAgent(uiId(e.agentId), { status: harnessStatus(e.detail?.status) });
    if (e.event === "tool_call") p.live.emit({ at: e.at, agentId: uiId(e.agentId), parentId: parentId ? uiId(parentId) : null, kind: "tool_result", title: `${String(e.detail?.tool)} ${e.detail?.ok ? "ok" : "failed"}`, status: e.detail?.ok ? "succeeded" : "failed", data: e.detail });
  };
  const builder: MemoryBuilder = async ({ repo: r, inputs, sources, buildId, signal }) => {
    const receipt = await runMemoryBuild({
      repo: r,
      inputs,
      sources,
      buildId,
      profiles,
      clientFactory: factory,
      workspaceFactory: createModalBuildWorkspaceFactory({ tags: { purpose: "crm-bench-build", tenant: p.ns } }),
      budget: { ...budget },
      ...(p.toolProviders ? { toolProviders: await p.toolProviders({ ns: p.ns, buildId, emitAgent: uiId }) } : {}),
      ...(p.instructions ? { instructions: p.instructions } : {}),
      signal,
      log: builderLog,
    });
    return { ...receipt, status: receipt.status, revisionId: receipt.revisionId, ...(receipt.failure ? { error: `${receipt.failure.code}: ${receipt.failure.message}` } : {}) };
  };
  const service = new DailyBuildService({ store: p.store, builder, buildTimeoutMs: budget.maxWallClockMs + 5 * 60_000, dayOffsetMinutes: -420, log: (m) => p.log(scrub(m)) });
  const days = [...new Set((await p.store.list(p.ns, "traces/", { limit: 10_000 })).map((k) => k.split("/")[1]!).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const started = Date.now();
  const receipts: Array<Record<string, unknown>> = [];
  for (const day of days) receipts.push((await service.runAndWait(p.ns, { day, force: true })) as Record<string, unknown>);
  const revisionAfter = (await repo.head())?.value.revisionId ?? null;
  const agents: BenchBuildResult["agents"] = [];
  const walk = (a: AgentReceipt) => {
    agents.push({ agentId: a.agentId, parentId: a.parentId, model: a.model, depth: a.depth, status: a.status, turns: a.usage.turns, toolCalls: a.usage.toolCalls, promptTokens: a.usage.promptTokens, completionTokens: a.usage.completionTokens, toolCallLog: (a.toolCalls ?? []).map((t) => ({ name: t.name, ok: t.ok, ...(t.code ? { code: String(t.code) } : {}) })) });
    p.live.setAgent(uiId(a.agentId), { status: harnessStatus(a.status) });
    for (const c of a.children ?? []) walk(c);
  };
  for (const r of receipts) for (const att of (r.attempts as Array<{ tree: AgentReceipt }> | undefined) ?? []) walk(att.tree);
  const status = receipts.map((r) => String(r.status)).join(",") || "nothing_to_build";
  p.live.setAgent(`${prefix}:service`, { status: receipts.some((r) => r.status === "published") ? "succeeded" : "failed" });
  p.live.emit({ agentId: `${prefix}:service`, kind: "run_end", title: `memory build ${p.label}: ${status} ${revisionBefore} -> ${revisionAfter}`, status: receipts.some((r) => r.status === "published") ? "succeeded" : "failed" });
  const traceArchive = receipts.map((r) => (r as { traceArchive?: unknown }).traceArchive ?? null);
  return { ns: p.ns, label: p.label, budget, days, receipts, traceArchive, status, revisionBefore, revisionAfter, usage, agents, wallMs: Date.now() - started };
}
