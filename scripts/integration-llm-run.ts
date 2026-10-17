/**
 * LIVE LLM integration repair through the real daily build harness.
 *
 *   npx tsx scripts/integration-llm-run.ts [--no-publish] [--env .context/manufact.env]
 *       [--root kimi-k3] [--max-turns 60] [--max-tool-calls 200]
 *
 * What is scripted vs. model-authored (labels are written into the report):
 *  - SCRIPTED SETUP: the pre-existing faulty "notify-hub" integration (initial revision from
 *    templates/integration/demo/notify-hub/initial), validated against host suite v1, committed,
 *    promoted and (optionally) published — i.e. yesterday's state of the world.
 *  - SYNTHETIC TRACE COHORT: customer-agent sessions that hit the integration's real faults
 *    (pagination truncation, duplicate send after a lost ack, unhandled 429). The third-party
 *    Notify Hub service is SIMULATED. Traces go through the real SDK -> ingest -> daily manifest.
 *  - LLM: the daily build (runMemoryBuild) with a Fireworks root agent and the real integration
 *    tool runtime (Modal repo sandbox, host-held regression + sealed held-out suite v2, real
 *    Manufact publisher pinned to the org). Every edit, test, commit, promote and publish call
 *    after setup is chosen and authored by the model; nothing is forced.
 * Credentials are loaded into this process only (never printed, never sent to models/sandboxes).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  createIntegrationRuntime,
  generateChildAuthKeys,
  IntegrationStore,
  loadChildAuthFromEnv,
  ManufactApi,
  ManufactPublisher,
  resolveManufactCredentials,
  type HostSuite,
  type IntegrationRuntime,
} from "../src/integrations/index.js";
import { overlayFiles, TEMPLATES_ROOT } from "../src/integrations/template.js";
import {
  createIntegrationToolProviders,
  createModalBuildWorkspaceFactory,
  createProfileRegistry,
  fireworksClientFactory,
  runMemoryBuild,
  validateFireworksKey,
  type AgentReceipt,
} from "../src/harness/index.js";
import { MemoryRepo } from "../src/store/memory.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { InProcessTraceTransport, TraceRecorder } from "../src/sdk/index.js";
import { materializeCohort, pinDailyManifest, TraceIngestor } from "../src/traces/index.js";

const { values } = parseArgs({
  options: {
    "no-publish": { type: "boolean", default: false },
    env: { type: "string", default: ".context/manufact.env" },
    root: { type: "string", default: "kimi-k3" },
    "max-turns": { type: "string", default: "60" },
    "max-tool-calls": { type: "string", default: "200" },
  },
});

async function loadEnvFile(file: string) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
await loadEnvFile(".env");
await loadEnvFile(values.env);
const apiKey = process.env.FIREWORKS_API_KEY;
if (!apiKey) throw new Error("FIREWORKS_API_KEY missing");
const secrets = [apiKey, process.env.MCP_USE_API_KEY, process.env.EXA_API_KEY, process.env.INTEGRATION_CHILD_SIGNING_JWK].filter((s): s is string => !!s && s.length >= 12);
const redact = (s: string) => secrets.reduce((acc, sec) => acc.split(sec).join("<redacted>"), s);
const log = (m: string) => console.error(redact(`[int-llm] ${m}`));

const runId = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
const dataDir = path.resolve(".data/integration-llm", runId);
const ns = "llm-int-tenant";
const slug = "notify-hub";
const publish = !values["no-publish"];
const report: Record<string, unknown> = {
  kind: "integration-llm-run",
  runId,
  labels: {
    setup: "SCRIPTED: faulty initial notify-hub revision (template fixture) validated/committed/promoted" + (publish ? "/published" : ""),
    traces: "SYNTHETIC customer-agent sessions against the SIMULATED Notify Hub service, ingested through the real SDK/ingest/daily manifest",
    build: "LLM: real runMemoryBuild with Fireworks models choosing every integration tool call after setup",
  },
};

const key = await validateFireworksKey(apiKey);
if (!key.ok) throw new Error(`Fireworks key rejected (HTTP ${key.status}); no charged calls made`);

await fs.mkdir(dataDir, { recursive: true });
const store = new DirectoryObjectStore(path.join(dataDir, "store"));
const childAuth = loadChildAuthFromEnv() ?? generateChildAuthKeys();
let publisher: ManufactPublisher | null = null;
if (publish) {
  const creds = await resolveManufactCredentials({ orgSlug: process.env.MANUFACT_ORG_SLUG ?? "org-84350150-jpcs9" });
  if (!creds) throw new Error("Manufact credentials not configured");
  const api = new ManufactApi(creds);
  const id = await api.identity();
  report.manufact = { email: id.email, orgSlug: id.orgSlug, orgName: id.orgName, credentialSource: creds.source };
  publisher = new ManufactPublisher({ api, childAuth, serverPrefix: `procmem-llm-${runId.slice(-6)}`, deployEnv: () => ({ NOTIFY_HUB_SIMULATED: "1" }) });
}
const loadSuites = async (file: string) => JSON.parse(await fs.readFile(path.join(TEMPLATES_ROOT, "demo/notify-hub/suites", file), "utf8")) as HostSuite[];

// ---------------------------------------------------------------- scripted setup (yesterday's state)
async function call(rt: IntegrationRuntime, tool: string, input: Record<string, unknown>) {
  const r = await rt.invoke(tool, JSON.stringify(input));
  log(`setup ${tool}: ${r.status}`);
  if (r.status !== "succeeded") throw new Error(`setup ${tool} failed: ${redact(JSON.stringify(r).slice(0, 600))}`);
  return r;
}
const suitesV1 = await loadSuites("v1.json");
const setup = createIntegrationRuntime({ ns, store, buildId: `setup-${runId}`, suites: async () => suitesV1, publisher, childAuth, exa: null });
try {
  await call(setup, "integration_open", { slug, create: { title: "Notify Hub", description: "Send and list notifications through the Notify Hub API (simulated third-party service).", upstreamName: "Notify Hub (simulated)" } });
  for (const [rel, content] of await overlayFiles("demo/notify-hub/initial")) await call(setup, "integration_write", { slug, path: rel, content });
  const v = await call(setup, "integration_validate", { slug });
  await call(setup, "integration_git_commit", { slug, message: "Add Notify Hub list/send/get tools", validationReceiptId: (v.data as { receiptId: string }).receiptId });
  await call(setup, "integration_promote", { slug });
  if (publish) await call(setup, "integration_publish", { slug });
} finally {
  await setup.close();
}
const before = await new IntegrationStore(store, ns).get(slug);
report.setup = { promotedCommit: before?.promoted?.commit, active: before?.manufact?.active ?? null, mcpUrl: before?.manufact?.mcpUrl ?? null };

// ---------------------------------------------------------------- synthetic trace cohort via the real SDK
const ingestor = new TraceIngestor(store);
const recorder = new TraceRecorder({ transport: new InProcessTraceTransport(ingestor, ns), agent: { id: "ops-agent", name: "ops agent", model: "customer-model", harness: "customer-harness" } });
{
  const s = recorder.begin({ objective: "Audit every notification sent to ops@example.test today (expected 23)" });
  s.toolCall("notify-hub.list_notifications", { recipient: "ops@example.test" }, "c1");
  s.toolResult("notify-hub.list_notifications", "c1", { count: 10, pages: 1, note: "integration returned 10 items; upstream response had has_more=true and next_cursor=c_10 which the tool ignored" });
  s.error({ message: "Audit incomplete: integration list_notifications returned 10 of 23 notifications (has_more ignored; no cursor pagination)" });
  await s.finish({ status: "failed", summary: "notify-hub list_notifications truncates at one page; audit missed 13 notifications" });
}
{
  const s = recorder.begin({ objective: "Send the incident summary to ops@example.test exactly once" });
  s.toolCall("notify-hub.send_notification", { recipient: "ops@example.test", message: "Incident 4411 resolved" }, "c1");
  s.toolResult("notify-hub.send_notification", "c1", { error: "HTTP 503 service_unavailable (upstream committed the notification; ack lost)" }, true);
  s.toolCall("notify-hub.send_notification", { recipient: "ops@example.test", message: "Incident 4411 resolved" }, "c2");
  s.toolResult("notify-hub.send_notification", "c2", { id: "ntf_0024", replayed: false });
  s.toolCall("notify-hub.list_notifications", { recipient: "ops@example.test" }, "c3");
  s.toolResult("notify-hub.list_notifications", "c3", { duplicates: ["ntf_0023", "ntf_0024"], note: "same message delivered twice" });
  s.error({ message: "Duplicate delivery: the integration sends without an Idempotency-Key, so retrying after a lost ack (503) created a second notification" });
  s.toolCall("notify-hub.send_notification", { recipient: "ops@example.test", message: "Postmortem link" }, "c4");
  s.toolResult("notify-hub.send_notification", "c4", { error: "HTTP 429 rate_limited, Retry-After: 1 (integration surfaced the error instead of waiting and retrying)" }, true);
  await s.finish({ status: "failed", summary: "duplicate notification after 503 lost-ack retry; 429 not retried" });
}
const day = new Date().toISOString().slice(0, 10);
const pin = await pinDailyManifest(store, ns, day);
if (!pin.manifest) throw new Error(`no manifest pinned (${pin.reason})`);
const inputs = await materializeCohort(store, ns, pin.manifest);
report.cohort = { day, manifest: pin.manifest.key, sessions: pin.manifest.sessionIds, files: inputs.size };

// ---------------------------------------------------------------- LLM daily build with real integration tools
const suitesV2 = await loadSuites("v2.json"); // trace regressions + sealed held-out variants, host-held
const repo = new MemoryRepo(store, ns);
const buildId = `bld-intllm-${runId}`;
const started = Date.now();
const toolProviders = await createIntegrationToolProviders({
  ns,
  store,
  buildId,
  deps: { suites: async () => suitesV2, publisher, childAuth },
  allowHostDeploy: true,
  required: true,
  log,
});
const receipt = await runMemoryBuild({
  repo,
  inputs,
  sources: [pin.manifest.key],
  buildId,
  profiles: createProfileRegistry({ rootProfileId: values.root, childProfileIds: [values.root, "glm-5p3", "minimax-m3"].filter((v, i, a) => a.indexOf(v) === i), defaultChildProfileId: values.root }),
  clientFactory: fireworksClientFactory(apiKey),
  workspaceFactory: createModalBuildWorkspaceFactory({ tags: { purpose: "integration-llm-run" } }),
  toolProviders,
  budget: { maxTurns: Number(values["max-turns"]), maxToolCalls: Number(values["max-tool-calls"]), maxDescendants: 4 },
  log: (e) => log(`build ${JSON.stringify(e)}`),
});

// ---------------------------------------------------------------- evidence
const integrationCalls: Array<{ agent: string; name: string; ok: boolean; code?: string }> = [];
const walk = (a: AgentReceipt) => {
  for (const c of a.toolCalls) if (c.name.startsWith("integration_") || c.name.startsWith("research_")) integrationCalls.push({ agent: a.agentId, name: c.name, ok: c.ok, ...(c.code ? { code: c.code } : {}) });
  for (const child of a.children ?? []) walk(child);
};
for (const att of receipt.attempts) walk(att.tree);
const after = await new IntegrationStore(store, ns).get(slug);
report.build = {
  status: receipt.status,
  revisionId: receipt.revisionId,
  failure: receipt.failure ?? null,
  summary: receipt.summary,
  wallMs: Date.now() - started,
  agents: receipt.attempts.map((a) => a.agents),
};
report.integrationToolCalls = integrationCalls;
report.integrationOutcome = {
  promotedBefore: before?.promoted?.commit ?? null,
  promotedAfter: after?.promoted?.commit ?? null,
  activeDeploymentBefore: before?.manufact?.active ?? null,
  activeDeploymentAfter: after?.manufact?.active ?? null,
  mcpUrl: after?.manufact?.mcpUrl ?? null,
  modelPublished: integrationCalls.some((c) => c.name === "integration_publish" && c.ok),
  modelCommitted: integrationCalls.some((c) => c.name === "integration_git_commit" && c.ok),
};
const wiki = await repo.files(receipt.revisionId);
report.wikiPages = [...wiki.keys()];
await fs.mkdir("reports", { recursive: true });
await fs.writeFile(`reports/integration-llm-run-${runId}.json`, `${redact(JSON.stringify({ ...report, receipt }, null, 2))}\n`);
console.log(redact(JSON.stringify({ runId, build: report.build, integrationOutcome: report.integrationOutcome, integrationToolCalls: integrationCalls.length }, null, 2)));
