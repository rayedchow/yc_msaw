/** Dry-run settling a question (no save, no deploy): npx tsx walter/scripts/settle-dry.ts <mcp> <questionIndex> <optionIndex> */
import { promises as fs } from "node:fs";
import type { Knowledge } from "../compile/compile.js";
import { makeBench } from "../mine/backtest.js";
import { SystemClient } from "../mine/data.js";
import { settle } from "../mine/settle.js";
import { domainOf } from "../domains/index.js";
import { knowledgePath } from "../pipeline.js";
import { loadState } from "../state.js";

const [mcp = "sales", qs = "0", os = "0"] = process.argv.slice(2);
const st = await loadState();
const domain = domainOf(mcp);
const k = JSON.parse(await fs.readFile(knowledgePath(mcp), "utf8")) as Knowledge;
const [qi, oi] = [Number(qs), Number(os)];
const bench = makeBench(domain, await domain.fetchData(new SystemClient(st.system!.url!, st.system!.token!)));
const s = await settle(bench, k, qi, k.questions[qi]!.options[oi]!);
console.log(JSON.stringify({ action: s.action, attempts: s.attempts, note: s.note, id: s.rule.id, title: s.rule.title, code: s.rule.code, train: s.rule.train, heldOut: s.rule.heldOut, change: s.rule.change }, null, 2));
