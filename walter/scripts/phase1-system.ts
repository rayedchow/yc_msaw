/**
 * Phase 1: build the GurtAI system project, verify it locally through mcp-use (build + start + HTTP checks),
 * then (with --deploy) deploy it to Manufact and run the same checks against the hosted URL.
 *
 *   npx tsx walter/scripts/phase1-system.ts [--deploy]
 * Writes .walter/state.json with the system URL and token (token never printed).
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeSystemProject } from "../deploy/system-project.js";
import { deployToManufact, isLinked, runLocal, waitForDeployment } from "../deploy/project.js";
import { loadState, saveState } from "../state.js";

const deploy = process.argv.includes("--deploy");
const dir = path.resolve(".walter/projects/gurtai-crm");
const state = await loadState();
const token = state.system?.token ?? randomBytes(18).toString("base64url");

async function check(base: string): Promise<Record<string, unknown>> {
  const h = { authorization: `Bearer ${token}` };
  const unauth = (await fetch(base + "/crm/v3/owners")).status;
  const owners = await (await fetch(base + "/crm/v3/owners", { headers: h })).json();
  const deals = await (await fetch(base + "/crm/v3/objects/deals?limit=5", { headers: h })).json();
  const snaps = await (await fetch(base + "/warehouse/forecast_snapshots", { headers: h })).json();
  const fh = await (await fetch(base + "/warehouse/field_history?property=booked&limit=3", { headers: h })).json();
  const bills = await (await fetch(base + "/erp/services/rest/record/v1/vendorBill?limit=5", { headers: h })).json();
  const runs = await (await fetch(base + "/erp/payment_runs?limit=200", { headers: h })).json();
  const threads = await (await fetch(base + "/mail/gmail/v1/users/me/threads?maxResults=5", { headers: h })).json();
  const events = await (await fetch(base + "/mail/export/events?limit=1", { headers: h })).json();
  const out = { unauthStatus: unauth, owners: owners.results?.length, deals: deals.results?.length, snapshots: snaps.results?.length, bookedChanges: fh.total,
    bills: bills.totalResults, paymentRuns: runs.total, threads: threads.resultSizeEstimate, mailEvents: events.total };
  const orders = await (await fetch(base + "/mail/gmail/v1/users/orders@gurtai.example/threads?q=-label:logged", { headers: h })).json();
  (out as any).pendingOrders = orders.resultSizeEstimate;
  const ok = orders.resultSizeEstimate === 4 && unauth === 401 && owners.results?.length === 5 && deals.results?.length === 5 && snaps.results?.length === 22 && fh.total > 300
    && bills.totalResults > 1000 && runs.total > 90 && threads.resultSizeEstimate > 1000 && events.total > 3000;
  if (!ok) throw new Error(`system checks failed at ${base}: ${JSON.stringify(out)}`);
  return out;
}

const hash = await writeSystemProject(dir);
console.log("project written:", dir);
const local = await runLocal(dir, { GURTAI_TOKEN: token }, 4411);
try {
  console.log("local mcp-use server:", local.url, JSON.stringify(await check(local.url)));
} finally {
  local.stop();
}

if (deploy) {
  const t0 = Date.now();
  const r = await deployToManufact(dir, "gurtai-crm", { GURTAI_TOKEN: token }, { isNew: !isLinked(dir), org: process.env.MANUFACT_ORG_SLUG ?? "org-ec5ae13b-z5isn" });
  console.log("deploy:", r.ok ? "ok" : "FAILED", r.url ?? "", "\n", r.log.slice(-1500));
  const live = r.ok ? await waitForDeployment(String((r.raw as any)?.serverId), { since: t0, expectHash: hash }) : null;
  console.log("deployment:", live?.status, live?.mcpUrl);
  if (!live || live.status !== "running" || !live.url) process.exit(1);
  const base = live.url;
  console.log("hosted checks:", JSON.stringify(await check(base)));
  await saveState({ ...state, system: { url: base, token, mcpUrl: live.mcpUrl, serverId: (r.raw as any)?.serverId, deployedAt: new Date().toISOString() } });
} else {
  await saveState({ ...state, system: { ...(state.system ?? {}), token } });
}
