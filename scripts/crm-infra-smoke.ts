/**
 * UNPAID infrastructure smoke (host QA, no model calls): local parent + subject-bound catalog + per-session fixtures
 * and adapter children + SDK LiveToolRegistry listing/calling tools; also checks that a second subject cannot see
 * the first subject's children.
 */
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { LiveToolRegistry } from "../src/sdk/live/index.js";
import { loadEnvFile, makeKeys, REPO, scrub, startParent, startSessionWorld } from "../eval/crm/infra.js";
import { datasetSpec, INSTANCE_LABEL, ORGS, VENDORS } from "../eval/crm/scenarios.js";

await loadEnvFile(path.join(REPO, ".env"));
await loadEnvFile(path.join(REPO, ".context/manufact.env"));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crm-smoke-"));
const keys = makeKeys({ a: { ns: "crmsmoke-mem", scopes: ["memory:read", "integrations:read"] }, b: { ns: "crmsmoke-mem", scopes: ["memory:read", "integrations:read"] } });
const parent = await startParent({ dataDir: path.join(dir, "data"), keys, dayOffsetMinutes: -420, log: () => {} });
const org = ORGS.evA!;
const world = await startSessionWorld({ parent, subject: keys.a!.subject, ns: keys.a!.ns, visible: [...VENDORS], seeds: Object.fromEntries(VENDORS.map((v) => [v, `smoke:${v}`])), specFor: (v) => datasetSpec(org, v, "exec-review"), instanceLabel: (v) => INSTANCE_LABEL[v](org), docsVendors: [...VENDORS], docsDir: path.join(REPO, "eval/crm/docs"), stageRoot: path.join(dir, "stage") });
const out: Record<string, unknown> = { fingerprints: world.fingerprints };
const reg = (k: string) => new LiveToolRegistry({ parent: { baseUrl: parent.baseUrl, credential: () => k, allowInsecureLocalhost: true }, pollIntervalMs: 60_000, memory: false });
const ra = reg(keys.a!.key);
await ra.start();
for (let i = 0; i < 20 && ra.getTools().length < 10; i++) {
  await new Promise((r) => setTimeout(r, 500));
  await ra.refresh({ force: true });
}
out.toolsA = ra.getTools().map((t) => t.name);
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await ra.callTool(name, args);
  return scrub(JSON.stringify(r).slice(0, 300));
};
out.hubspot = await call("integration__crm-hubspot__hubspot_request", { method: "GET", path: "/crm/v3/pipelines/deals" });
out.pipedrive = await call("integration__crm-pipedrive__pipedrive_request", { method: "GET", path: "/api/v2/pipelines" });
out.zoho = await call("integration__crm-zoho__zoho_request", { method: "GET", path: "/crm/v8/settings/modules" });
out.attio = await call("integration__crm-attio__attio_request", { method: "POST", path: "/v2/objects/companies/records/query", body: { filter: { domains: { domain: { $eq: org.domain } } } } });
out.docs = await call("integration__crm-docs__docs_search", { query: "multiselect append", vendor: "attio" });
const rb = reg(keys.b!.key);
await rb.start();
await rb.refresh({ force: true });
out.toolsB_otherSubject = rb.getTools().map((t) => t.name);
const st = (await world.fixtures.get("attio")!.state()) as { requests: unknown[] };
out.attioRequestsLogged = st.requests.length;
await ra.dispose();
await rb.dispose();
await world.close();
await parent.close();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
