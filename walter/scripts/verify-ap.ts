/**
 * Check an AP payment run against GurtAI's real AP habits (the simulator's rules, including the September CFO
 * policy): which bills a run should pay, and which due bills need CFO sign-off. Compares with what the Finance MCP
 * says, and with any proposal / approval requests an agent wrote. Read-only.
 *
 *   npx tsx walter/scripts/verify-ap.ts [run_date]
 */
import { SystemClient } from "../mine/data.js";
import { erp } from "../domains/erp/index.js";
import { openAt } from "../domains/erp/runtime.js";
import { connectMcp } from "../mcp-client.js";
import { loadState } from "../state.js";

const st = await loadState();
const c = new SystemClient(st.system!.url!, st.system!.token!);
const d = await erp.fetchData(c);
const ctx = erp.makeCtx(d);
const lastRun = Math.max(...d.runs.map((r) => Date.parse(r.run_date)));
const runAt = process.argv[2] ? Date.parse(process.argv[2] + "T12:00:00Z") : lastRun + 7 * 86_400_000;
const pay: string[] = [], needCfo: string[] = [];
for (const b of openAt(d, ctx, runAt)) {
  const s = ctx.stateAt("vendorbill", b.id, runAt);
  if (b.subsidiary === "3" || s.custbody_14 !== "T" || s.custbody_hold === "T" || Date.parse(b.duedate) > runAt + 7 * 86_400_000) continue;
  if (Number(b.amount) > 25_000 && s.custbody_22 !== "T") needCfo.push(b.id); else pay.push(b.id);
}
const total = pay.reduce((t, id) => t + Number(ctx.stateAt("vendorbill", id, runAt).amountremaining), 0);
console.log(`truth for ${new Date(runAt).toISOString().slice(0, 10)}: pay ${pay.length} bills $${total.toLocaleString()}, ${needCfo.length} due bills need CFO sign-off`);

const mcp = await connectMcp(st.mcps!.erp!.mcpUrl!, {}, "walter-verify");
const r = (await mcp.call("payment_run", { run_date: new Date(runAt).toISOString().slice(0, 10) })).data;
await mcp.close();
const mcpPay = r.pays.bills.map((b: any) => b.id).sort(), mcpCov = r.due_but_not_covered.bills.map((b: any) => b.id).sort();
console.log(`Finance MCP: pay ${mcpPay.length} $${r.total_usd.toLocaleString()} (${JSON.stringify(mcpPay) === JSON.stringify([...pay].sort()) && r.total_usd === total ? "matches" : "DIFFERS"}), not covered ${mcpCov.length} (${JSON.stringify(mcpCov) === JSON.stringify([...needCfo].sort()) ? "exactly the bills that need CFO sign-off" : "DIFFERS"}), all of them: ${JSON.stringify(r.due_but_not_covered.all_of_them)}`);

const props = (await c.get("/erp/payment_runs/proposals")).body.results, reqs = (await c.get("/erp/approval_requests")).body.results;
for (const p of props) console.log(`proposal ${p.id} for ${p.run_date.slice(0, 10)}: ${p.bill_ids.length} bills $${p.total_usd.toLocaleString()} → ${JSON.stringify([...p.bill_ids].sort()) === JSON.stringify([...pay].sort()) && p.total_usd === total ? "correct" : "WRONG"}`);
const asked = new Set(reqs.map((x: any) => x.bill_id));
console.log(`CFO approval requests: ${reqs.length} (needed ${needCfo.length}; missing ${needCfo.filter((id) => !asked.has(id)).length}, not needed ${[...asked].filter((id) => !needCfo.includes(id as string)).length})`);
