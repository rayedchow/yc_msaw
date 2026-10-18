/**
 * Phase 2: mine GurtAI's tribal knowledge with a Fireworks agent, against the system hosted on Manufact.
 * Writes .walter/knowledge/sales.json (rules + per-month evidence + questions) and the transcript.
 *
 *   npx tsx walter/scripts/phase2-mine.ts [--local] [--model kimi|glm|minimax] [--steps 60]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { MODELS, usage } from "../llm.js";
import { SystemClient } from "../mine/data.js";
import { mine } from "../mine/miner.js";
import { backtestRule, replayCommit } from "../mine/backtest.js";
import { startSystemServer } from "../system/serve.js";
import { loadState, STATE_DIR } from "../state.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const state = await loadState();
let base = state.system?.url, token = state.system?.token, close: (() => Promise<void>) | undefined;
if (process.argv.includes("--local") || !base || !token) {
  token = "local";
  const s = await startSystemServer(token);
  base = s.url;
  close = s.close;
}
console.log("mining", base, process.argv.includes("--local") ? "(local)" : "(Manufact)");
const model = MODELS[(arg("--model") ?? "kimi") as keyof typeof MODELS];
const started = Date.now();
const r = await mine(new SystemClient(base!, token!), { model, maxSteps: Number(arg("--steps") ?? 60), log: (s) => console.log(s) });

const all = r.rules;
const results = all.map((rule) => ({ rule, result: backtestRule(r.bench, rule, all) }));
let replay: ReturnType<typeof replayCommit> | null = null;
try { replay = replayCommit(r.bench, all); } catch (e) { console.log("replay error", (e as Error).message); }

// Short, stable ids for people and agents (R1…Rn); the miner's own id is kept as the slug.
const ids = new Map(results.map(({ rule }, i) => [rule.id, `R${i + 1}`]));
const out = {
  mcp: "sales", version: 1, system: base, model, minedAt: new Date().toISOString(), steps: r.steps, seconds: Math.round((Date.now() - started) / 1000), usage,
  summary: r.summary,
  rules: results.map(({ rule, result }) => ({ ...rule, id: ids.get(rule.id)!, slug: rule.id, train: result.train, heldOut: result.heldOut, months: result.months, change: result.change ?? null, counterexamples: result.counterexamples.slice(0, 10), error: result.error ?? null })),
  questions: r.questions.map((q) => ({ ...q, rule_id: ids.get(q.rule_id) ?? q.rule_id })),
  replay,
};
const dir = path.join(STATE_DIR, "knowledge");
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, "sales.json"), JSON.stringify(out, null, 2));
await fs.writeFile(path.join(dir, "sales.transcript.json"), JSON.stringify(r.transcript, null, 2));
await close?.();

console.log(`\n${r.steps} steps, ${out.seconds}s, ${usage.calls} calls, ${usage.input} in / ${usage.output} out tokens`);
for (const x of out.rules) console.log(`${x.id.padEnd(6)} ${x.kind.padEnd(24)} ${(x.role ?? "").padEnd(8)} learned ${x.train.ok}/${x.train.n} held-out ${x.heldOut.ok}/${x.heldOut.n}${x.change ? ` CHANGE ${x.change.month}` : ""}  ${x.title}`);
for (const q of out.questions) console.log(`? [${q.rule_id}] ${q.question} (${q.options.join(" | ")})`);
if (replay) console.log("replay:", replay.map((x) => `${x.month}${x.match ? "✓" : "✗"}`).join(" "));
console.log("summary:", r.summary);
