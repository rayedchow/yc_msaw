/**
 * Re-backtest a knowledge file's rules with the current code (after backtest or simulator changes) and report how
 * the rules decide together. Updates evidence in place; never changes rule code.
 *
 *   npx tsx walter/scripts/rescore.ts --mcp sales|erp|mail
 */
import { promises as fs } from "node:fs";
import type { Knowledge } from "../compile/compile.js";
import { backtestRule, makeBench } from "../mine/backtest.js";
import { SystemClient } from "../mine/data.js";
import { aggregateReplay, coverage } from "../mine/miner.js";
import { domainOf } from "../domains/index.js";
import { knowledgePath } from "../pipeline.js";
import { loadState } from "../state.js";

const i = process.argv.indexOf("--mcp");
const mcp = i > 0 ? process.argv[i + 1]! : "sales";
const domain = domainOf(mcp);
const st = await loadState();
const k = JSON.parse(await fs.readFile(knowledgePath(mcp), "utf8")) as Knowledge;
const bench = makeBench(domain, await domain.fetchData(new SystemClient(st.system!.url!, st.system!.token!)));
const live = k.rules.filter((r) => r.status !== "retired");
k.rules = k.rules.map((r) => {
  const res = backtestRule(bench, r, live);
  return { ...r, train: res.train, heldOut: res.heldOut, months: res.months, change: r.status === "confirmed" ? null : res.change ?? null, counterexamples: res.counterexamples.slice(0, 10), error: res.error ?? null,
    applies: res.applies, fallback: domain.kinds[r.kind]?.combine !== "set" && res.applies.n === res.applies.of };
});
await fs.writeFile(knowledgePath(mcp), JSON.stringify(k, null, 2));
for (const r of k.rules as any[]) console.log(`${r.id.padEnd(4)} ${r.kind.padEnd(22)} applies ${r.applies.n}/${r.applies.of}${r.fallback ? " (fallback)" : ""}  learned ${r.train.ok}/${r.train.n}  held-out ${r.heldOut.ok}/${r.heldOut.n}${r.change ? ` CHANGE ${r.change.month}` : ""}  ${r.title}`);
console.log(coverage(bench, k.rules));
const replay = aggregateReplay(bench, k.rules);
if (Array.isArray(replay)) console.log("aggregate:", `${replay.filter((x) => x.endsWith("exact")).length}/${replay.length} exact`);
