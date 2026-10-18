/**
 * Phase 3: compile .walter/knowledge/sales.json into an mcp-use project, run it locally against the hosted GurtAI
 * system, and verify over MCP: tools are listed, get_commit matches the recorded commit for a past month exactly,
 * route_contact and find_account answer with the company's rules.
 *
 *   npx tsx walter/scripts/phase3-compile.ts
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compile, type Knowledge } from "../compile/compile.js";
import { runLocal } from "../deploy/project.js";
import { connectMcp } from "../mcp-client.js";
import { generate } from "../system/gurtai.js";
import { loadState, saveState, STATE_DIR } from "../state.js";

const state = await loadState();
if (!state.system?.url || !state.system.token) throw new Error("run phase 1 --deploy first");
const k = JSON.parse(await fs.readFile(process.argv[2] ?? path.join(STATE_DIR, "knowledge/sales.json"), "utf8")) as Knowledge;
const dir = path.join(STATE_DIR, "projects/gurtai-sales");
const { hash, tools } = await compile(k, dir, "gurtai-sales");
console.log("compiled", dir, hash, tools.join(", "));

const admin = state.walterToken ?? randomBytes(18).toString("base64url");
await saveState({ ...state, walterToken: admin });
const env = { GURTAI_URL: state.system.url, GURTAI_TOKEN: state.system.token, WALTER_TOKEN: admin };
const local = await runLocal(dir, env, 4421);
try {
  const mcp = await connectMcp(local.url + "/mcp");
  console.log("tools:", mcp.tools.map((t) => t.name).join(", "));
  const w = generate();
  const checks: Record<string, unknown> = {};
  // A past month-end: the tool must reproduce RevOps' recorded commit exactly.
  for (const month of ["2026-03", "2026-09"]) {
    const snap = w.snapshots.find((s) => s.as_of.startsWith(month))!;
    const r = await mcp.call("get_commit", { as_of: snap.as_of });
    checks[`commit ${month}`] = { recorded: snap.reported_commit_usd, mcp: r.data?.commit_usd, match: r.data?.commit_usd === snap.reported_commit_usd, caveats: r.data?.caveats?.length ?? 0 };
  }
  const now = await mcp.call("get_commit", {});
  checks["commit now"] = { quarter: now.data?.quarter, commit: now.data?.commit_usd, deals: now.data?.deal_count, caveats: now.data?.caveats };
  if (tools.includes("route_contact")) {
    checks["route new (Germany)"] = (await mcp.call("route_contact", { email: "new.person@example.de", country: "Germany" })).data;
    const back = w.history.find((h) => h.object === "contact" && h.property === "last_event" && h.changed_at >= "2026")!;
    const c = w.contacts.find((x) => x.id === back.id)!;
    checks["route returning"] = (await mcp.call("route_contact", { email: c.properties.email! })).data;
  }
  if (tools.includes("find_account")) {
    const merged = w.companies.find((c) => c.properties.merged_into)!;
    const r = await mcp.call("find_account", { query: merged.properties.domain! });
    checks["find_account dup"] = { query: merged.properties.domain, expected: merged.properties.merged_into, got: r.data?.accounts?.map((a: any) => a.id) };
  }
  checks["report_outcome"] = (await mcp.call("report_outcome", { tool: "get_commit", correct: true })).data;
  const usage = await (await fetch(local.url + "/walter/usage", { headers: { authorization: `Bearer ${admin}` } })).json();
  checks["usage logged"] = usage.usage?.length;
  console.log(JSON.stringify(checks, null, 2));
  await mcp.close();
} finally {
  local.stop();
}
