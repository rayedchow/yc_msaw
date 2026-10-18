/**
 * Phase 2: mine a GurtAI system's tribal knowledge with a Fireworks agent, against the systems hosted on Manufact.
 * Writes .walter/knowledge/<mcp>.json (rules + per-month evidence + questions) and the transcript.
 *
 *   npx tsx walter/scripts/phase2-mine.ts --mcp sales|erp|mail [--local] [--model kimi|glm|minimax] [--steps 60]
 */
import { MODELS, usage } from "../llm.js";
import { SystemClient } from "../mine/data.js";
import { domainOf } from "../domains/index.js";
import { mineToKnowledge } from "../pipeline.js";
import { startSystemServer } from "../system/serve.js";
import { loadState } from "../state.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const domain = domainOf(arg("--mcp") ?? "sales");
const state = await loadState();
let base = state.system?.url, token = state.system?.token, close: (() => Promise<void>) | undefined;
if (process.argv.includes("--local") || !base || !token) {
  token = "local";
  const s = await startSystemServer(token);
  base = s.url;
  close = s.close;
}
console.log(`mining ${domain.id} at`, base, process.argv.includes("--local") ? "(local)" : "(Manufact)");
const { knowledge: k, steps } = await mineToKnowledge(domain, domain.id, {
  client: new SystemClient(base!, token!), model: MODELS[(arg("--model") ?? "kimi") as keyof typeof MODELS], maxSteps: Number(arg("--steps") ?? 60), log: (s) => console.log(s),
});
await close?.();

console.log(`\n${steps} steps, ${usage.calls} calls, ${usage.input} in / ${usage.output} out tokens`);
for (const x of k.rules) console.log(`${x.id.padEnd(4)} ${x.kind.padEnd(24)} ${(x.role ?? "").padEnd(8)} learned ${x.train.ok}/${x.train.n} held-out ${x.heldOut.ok}/${x.heldOut.n}${x.change ? ` CHANGE ${x.change.month}` : ""}  ${x.title}`);
for (const q of k.questions) console.log(`? [${q.rule_id}] ${q.question} (${q.options.join(" | ")})`);
const replay = (k as any).replay;
if (Array.isArray(replay)) console.log("replay:", `${replay.filter((x: string) => x.endsWith("exact")).length}/${replay.length} exact`);
console.log("summary:", (k as any).summary);
