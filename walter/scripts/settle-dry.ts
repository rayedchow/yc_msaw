/** Dry-run settling a question (no save, no deploy): npx tsx walter/scripts/settle-dry.ts <questionIndex> <optionIndex> */
import { promises as fs } from "node:fs";
import type { Knowledge } from "../compile/compile.js";
import { makeBench } from "../mine/backtest.js";
import { SystemClient } from "../mine/data.js";
import { settle } from "../mine/settle.js";
import { knowledgePath } from "../pipeline.js";
import { loadState } from "../state.js";

const st = await loadState();
const k = JSON.parse(await fs.readFile(knowledgePath("sales"), "utf8")) as Knowledge;
const [qi, oi] = [Number(process.argv[2] ?? 0), Number(process.argv[3] ?? 0)];
const bench = makeBench(await new SystemClient(st.system!.url!, st.system!.token!).dataset());
const s = await settle(bench, k, qi, k.questions[qi]!.options[oi]!);
console.log(JSON.stringify({ action: s.action, attempts: s.attempts, note: s.note, id: s.rule.id, title: s.rule.title, code: s.rule.code, train: s.rule.train, heldOut: s.rule.heldOut, change: s.rule.change }, null, 2));
