/**
 * Builds what the walter UI renders from real artifacts: mined knowledge, the latest evals run, deployment state
 * and live usage pulled from each hosted MCP. The shapes match what the UI's list, tree and evals views expect.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Knowledge, KnowledgeRule } from "../compile/compile.js";
import type { ReplayCase } from "../evals/replay.js";
import type { WalterState } from "../state.js";
import { domainOf } from "../domains/index.js";
import type { Domain } from "../domains/types.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const md = (f: string) => readFileSync(path.join(HERE, "../integrations", f), "utf8");

const COMMON_TOOLS = [
  { name: "company_rules", sig: "company_rules()", d: "The rules this MCP applies, with evidence", kinds: [] as string[] },
  { name: "report_outcome", sig: "report_outcome(…)", d: "Agents report what went wrong", kinds: [] as string[] },
];
const toolsOf = (d: Domain) => [...d.tools, ...COMMON_TOOLS];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pct = (x: { n: number; ok: number }) => (x.n ? `${Math.round((100 * x.ok) / x.n)}%` : "—");
const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const code = (s: string) => html(s).replace(/`([^`]+)`/g, "<code>$1</code>");

export interface Usage { usage: { tool: string; client: string | null; at: string; ok: boolean; ms?: number }[]; feedback: unknown[] }
export interface Job { id: string; mcp: string; kind: string; status: "running" | "done" | "failed"; steps: { at: string; text: string }[]; startedAt: string; error?: string }

export function uiMcp(id: string, k: Knowledge, st: WalterState, usage: Usage | null, job: Job | null) {
  const cfg = domainOf(id);
  const dep = st.mcps?.[id];
  const open = k.questions.map((q, i) => ({ ...q, i })).filter((q) => !q.answer);
  const live = k.rules.filter((r) => r.status !== "retired");
  const tools = toolsOf(cfg).filter((t) => !t.kinds.length || t.kinds.some((kd) => live.some((r) => r.kind === kd)));
  const status = job?.status === "running" ? "build" : !dep ? (open.length ? "ask" : "build") : "live";
  const now = Date.now();
  // The last 144 calls of the past 24h, one dot each: [tool index, agent call?, ok?, latency ms]
  const names = toolsOf(cfg).map((t) => t.name);
  const calls = (usage?.usage ?? []).filter((u) => now - Date.parse(u.at) < 86_400_000).slice(-144)
    .map((u) => [Math.max(0, names.indexOf(u.tool)), u.client && !u.client.startsWith("walter") ? 1 : 0, u.ok ? 1 : 0, Math.round(u.ms ?? 0)]);
  const volume = Array.from({ length: 24 }, () => 0);
  for (const u of usage?.usage ?? []) {
    const h = Math.floor((now - Date.parse(u.at)) / 3_600_000);
    if (h >= 0 && h < 24) volume[23 - h]!++;
  }
  const q = open[0];
  return {
    id, name: cfg.name, status, version: `v${dep?.version ?? k.version ?? 1}`, progress: job?.status === "running" ? Math.min(95, 10 + job.steps.length * 15) : 100,
    url: dep?.mcpUrl ?? "not deployed yet", webUrl: dep?.webUrl ?? null,
    systems: cfg.systems,
    stats: { agents: new Set((usage?.usage ?? []).map((u) => u.client ?? "unknown").filter((c) => !c.startsWith("walter"))).size, calls: (usage?.usage.length ?? 0).toLocaleString(), success: usage?.usage.length ? `${Math.round((100 * usage.usage.filter((u) => u.ok).length) / usage.usage.length)}%` : "—", rules: live.length },
    volume, calls, toolNames: names,
    integrations: cfg.integrations, md: md(cfg.mdFile),
    tools: tools.map((t) => [t.sig, t.d, t.kinds.length ? live.filter((r) => t.kinds.includes(r.kind)).map((r) => r.id).join(" ") : t.name === "report_outcome" ? "feedback" : ""]),
    rules: live.map((r) => [r.id, code(r.title), r.evidence ?? "", open.some((x) => x.rule_id === r.id) ? "asked" : r.change && r.status !== "confirmed" ? "change" : pct(r.heldOut.n ? r.heldOut : r.train), r.code, r.short ?? ""]),
    question: q ? { text: html(q.question), options: q.options, rule: live.findIndex((r) => r.id === q.rule_id), index: q.i, evidence: q.evidence } : null,
    versions: [...new Map((dep?.history ?? []).map((h) => [h.version, h])).values()].map((h) => [`v${h.version}`, k.changelog?.find((c) => c.version === h.version)?.note.replace(/^(R\d+): ([^:,;.]*).*/, "$1: $2") ?? (h.version === 1 ? "First build from history" : "Rebuilt"), 3]).reverse(),
    job,
  };
}

export function uiEvals(id: string, k: Knowledge, ev: { cases: ReplayCase[]; ranAt: string; version: number } | null) {
  const months = [...new Set(k.rules.flatMap((r) => r.months.map((m) => m.month)))].sort();
  if (!months.length) return null;
  const heldOutFrom = Math.max(0, months.findIndex((m) => m >= "2026-07"));
  const lbl = (m: string) => `${MONTH[Number(m.slice(5)) - 1]}${m.slice(2, 4) !== months.at(-1)!.slice(2, 4) ? " " + m.slice(2, 4) : ""}`;
  const open = new Set(k.questions.filter((q) => !q.answer).map((q) => q.rule_id));
  const domain = domainOf(id);
  const toolOf = (kind: string) => domain.tools.find((t) => t.kinds.includes(kind))?.name;
  const replays: unknown[] = [];
  const TASK: Record<string, string> = Object.fromEntries(domain.tools.map((t) => [t.name, t.task ?? t.d]));
  for (const tool of [...new Set((ev?.cases ?? []).map((c) => c.tool))]) {
    for (const split of ["learned", "held-out"] as const) {
      const cs = ev!.cases.filter((c) => c.tool === tool && (c.heldOut ? "held-out" : "learned") === split);
      if (!cs.length) continue;
      const bad = cs.filter((c) => !c.ok);
      const rules = k.rules.filter((r) => r.status !== "retired" && toolOf(r.kind) === tool).map((r) => r.id).join(" ");
      replays.push({ task: TASK[tool] ?? tool, truth: `${cs.length} recorded`, got: `${cs.length - bad.length} of ${cs.length}`, split, ok: !bad.length, via: `${tool} · ${rules}`,
        diff: bad.length ? bad.slice(0, 4).map((c) => `${c.label} (${c.month}): recorded ${fmt(c.expected)}, MCP ${fmt(c.got)}`).join("<br>") : `Every case matches the record, ${cs[0]!.month} to ${cs.at(-1)!.month}.` });
    }
  }
  return {
    window: { months: months.map(lbl), heldOutFrom },
    source: `${domain.systems.join(" and ")} history, ${lbl(months[0]!)} – ${lbl(months.at(-1)!)}. Learned before Jul 26, held out from Jul 26.${ev ? ` Replays ran through the deployed MCP (v${ev.version}).` : ""}`,
    replays,
    rules: k.rules.filter((r) => r.status !== "retired").map((r: KnowledgeRule) => {
      const by = new Map(r.months.map((m) => [m.month, m]));
      const n = r.train.n + r.heldOut.n, ok = r.train.ok + r.heldOut.ok;
      return {
        id: r.id, text: code(r.title), support: [ok, n], unit: domain.kinds[r.kind]?.unit ?? "decisions",
        months: open.has(r.id) && n < 40 ? null : months.map((m) => { const x = by.get(m); return x && x.n ? Math.round((100 * x.ok) / x.n) : null; }),
        asked: open.has(r.id),
        drift: r.change && r.status !== "confirmed" ? `Stopped matching history in ${lbl(r.change.month)} (${Math.round(r.change.agreement * 100)}% agreement).` : null,
        counter: (r.counterexamples ?? []).slice(0, 4).map((c) => `${c.month} · ${c.key}: recorded ${fmt(c.expected)}, rule says ${fmt(c.got)}`),
      };
    }),
  };
}

const fmt = (v: unknown) => (typeof v === "number" && v > 10_000 ? `$${v.toLocaleString()}` : String(v));
