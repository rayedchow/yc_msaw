/**
 * The playbook: an MCP's tribal knowledge as text an agent can read, next to the rules it runs as code.
 *
 * Three kinds of knowledge, always labelled so agents know what is proven:
 *   verified   rules backtested month by month against history (also enforced in the tools)
 *   observed   policies walter's miner saw in history but could not score as a decision
 *   people     the connection's notes and the answers humans gave to walter's questions
 *
 * Shipped in the compiled MCP as a skill (skills/<name>/SKILL.md), the walter://playbook resource, the server
 * instructions (short form) and the company_rules tool.
 */
import type { Domain } from "../domains/types.js";
import type { Knowledge, KnowledgeRule } from "./compile.js";

const pct = (x: { n: number; ok: number }) => (x.n ? `${Math.round((100 * x.ok) / x.n)}%` : "n/a");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

function ruleStatus(r: KnowledgeRule, open: Set<string>): string {
  if (open.has(r.id)) return "waiting on a human answer";
  if (r.change && r.status !== "confirmed") return `stopped matching history in ${month(r.change.month)}`;
  return "confirmed by history";
}

export function playbookMarkdown(k: Knowledge, domain: Domain, opts: { name: string; notes?: string; tools: string[] }): string {
  const live = k.rules.filter((r) => r.status !== "retired");
  const open = new Set(k.questions.filter((q) => !q.answer).map((q) => q.rule_id));
  const toolOf = (kind: string) => domain.tools.find((t) => t.kinds.includes(kind))?.name;
  const lines: string[] = [];
  lines.push(`# ${opts.name}: company playbook`, "");
  lines.push(`How GurtAI actually uses ${domain.systems.join(" and ")}, learned by walter from the system's own history. ` +
    `The tools of this MCP already apply the verified rules; read this to explain answers, handle edge cases and know what is still unsettled.`, "");
  lines.push("## Tools", "");
  for (const t of domain.tools.filter((t) => opts.tools.includes(t.name))) lines.push(`- \`${t.name}\`: ${t.d}`);
  lines.push("- `company_rules`: this playbook and every rule with its evidence", "- `report_outcome`: tell walter when an answer was wrong; it becomes evidence for the next version", "");

  lines.push("## Verified rules", "", "Backtested against every recorded decision, month by month. Learned on history before Jul 2026, held out after.", "");
  for (const r of live) {
    const n = r.train.n + r.heldOut.n;
    lines.push(`- **${r.id} · ${r.title}** (${ruleStatus(r, open)})`);
    lines.push(`  ${r.evidence ? r.evidence + " " : ""}Agrees on ${pct(r.train)} of learned and ${pct(r.heldOut)} of held-out decisions (${n.toLocaleString()} ${domain.kinds[r.kind]?.unit ?? "decisions"}).${toolOf(r.kind) ? ` Applied by \`${toolOf(r.kind)}\`.` : ""}`);
  }
  lines.push("");

  const observed = (k.policies ?? []).filter((p) => p.source === "observed");
  const summary = (k as any).summary as string | undefined;
  if (observed.length || summary) {
    lines.push("## Observed by walter", "", "Seen in history but not scored as a decision. Treat as strong hints, not guarantees.", "");
    for (const p of observed) lines.push(`- ${p.text}${p.evidence ? ` _(${p.evidence})_` : ""}`);
    if (summary) lines.push("", "Miner's notes:", "", ...summary.trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")));
    lines.push("");
  }

  const answered = k.questions.filter((q) => q.answer);
  const fromAgents = (k.policies ?? []).filter((p) => p.source === "agent");
  if (opts.notes?.trim() || answered.length || fromAgents.length) {
    lines.push("## From people", "");
    for (const q of answered) lines.push(`- ${q.answeredAt ? q.answeredAt.slice(0, 10) + ": " : ""}asked "${q.question}" → **${q.answer}**`);
    for (const p of fromAgents) lines.push(`- reported by an agent: ${p.text}`);
    if (opts.notes?.trim()) lines.push("", "Notes from the team that connected this system:", "", ...opts.notes.trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")));
    lines.push("");
  }

  const pending = k.questions.filter((q) => !q.answer);
  if (pending.length) {
    lines.push("## Not settled yet", "", "History could not settle these. Answers that depend on them carry a caveat; do not guess.", "");
    for (const q of pending) lines.push(`- **${q.rule_id}**: ${q.question} Options: ${q.options.map((o) => `"${o}"`).join(", ")}.`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Short form for the server's `instructions`: what the MCP is for, the rules in one line each, what is unsettled. */
export function instructionsText(k: Knowledge, domain: Domain, name: string): string {
  const live = k.rules.filter((r) => r.status !== "retired");
  const pending = k.questions.filter((q) => !q.answer);
  return [
    `${name}: ${domain.description}`,
    `It applies ${live.length} company rules mined from history and checked against it: ${live.map((r) => `${r.id} ${r.title}`).join("; ")}.`,
    pending.length ? `Unsettled: ${pending.map((q) => `${q.rule_id} (${q.question})`).join(" ")} Answers touching these carry caveats.` : "",
    "Read the walter://playbook resource (or call company_rules) for evidence and context. Call report_outcome when an answer is wrong.",
  ].filter(Boolean).join("\n");
}

export function skillMarkdown(k: Knowledge, domain: Domain, opts: { name: string; slug: string; notes?: string; tools: string[] }): string {
  const description = `How GurtAI actually uses ${domain.systems.join(" and ")}: the company's verified rules, observed policies and open questions for the ${opts.name}. Use before answering questions about ${domain.tools.map((t) => t.d.toLowerCase()).join(", ")}.`;
  return `---\nname: ${opts.slug}-playbook\ndescription: ${JSON.stringify(description)}\n---\n\n${playbookMarkdown(k, domain, opts)}`;
}
