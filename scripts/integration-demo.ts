/**
 * Live integration-subsystem demo (real Modal sandboxes, real Manufact deploys).
 *
 *   npx tsx scripts/integration-demo.ts [--no-publish] [--rollback] [--keep-going]
 *
 * Every step goes through the SAME model-callable tool API the daily build agents get
 * (runtime.invoke(<tool name>, <JSON args>)). The code revisions written here are
 * SCRIPTED FIXTURES from templates/integration/demo/notify-hub (labelled as such in the
 * report) — they validate the infrastructure; the build harness's LLM agents author
 * their own revisions with these tools.
 *
 * Flow:
 *  build A  create notify-hub from the template, write the (faulty) initial revision,
 *           validate against host suite v1, commit, promote, publish to Manufact,
 *           call the deployed child over MCP with a parent-minted customer token.
 *  build B  NEW sandbox, cold-restore the repo from the durable git bundle; host suites
 *           now include trace-derived regressions + sealed held-out variants. The current
 *           revision fails; a wrong repair fails (not committable; deployment unchanged);
 *           the correct repair passes, is committed, promoted and deployed as an update.
 *  build C  NEW sandbox again: history restored intact. Optional --rollback redeploys the
 *           previous passing archive and then republishes the promoted revision.
 * Credentials: Modal profile/env; Manufact via MCP_USE_API_KEY+MANUFACT_ORG_SLUG or the
 * CLI profile, pinned to org-84350150-jpcs9. Nothing secret is printed or stored.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DirectoryObjectStore } from "../src/store/objects.js";
import {
  createIntegrationCatalog,
  createIntegrationRuntime,
  generateChildAuthKeys,
  loadChildAuthFromEnv,
  ManufactApi,
  ManufactPublisher,
  resolveManufactCredentials,
  type HostSuite,
  type IntegrationRuntime,
  type IntegrationToolResult,
} from "../src/integrations/index.js";
import { overlayFiles, TEMPLATES_ROOT } from "../src/integrations/template.js";

const ORG_SLUG = process.env.MANUFACT_ORG_SLUG ?? "org-84350150-jpcs9";
const args = new Set(process.argv.slice(2));
const publish = !args.has("--no-publish");
const runId = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
const dataDir = path.resolve(".data/integration-demo", runId);
const ns = "demo-tenant";
const slug = "notify-hub";

interface Step {
  build: string;
  tool: string;
  label: string;
  status: string;
  ms: number;
  data?: unknown;
  error?: unknown;
}
const report: { runId: string; startedAt: string; scripted: string; org: string | null; childAuth: string; steps: Step[]; live: Record<string, unknown>; finishedAt?: string; ok?: boolean; problems: string[] } = {
  runId,
  startedAt: new Date().toISOString(),
  scripted: "Code revisions are scripted demo fixtures (templates/integration/demo/notify-hub), not LLM output.",
  org: publish ? ORG_SLUG : null,
  childAuth: "",
  steps: [],
  live: {},
  problems: [],
};

function brief(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 600 ? `${v.slice(0, 600)}…` : v;
  if (Array.isArray(v)) return depth > 3 ? `[${v.length} items]` : v.slice(0, 25).map((x) => brief(x, depth + 1));
  if (v && typeof v === "object") return depth > 4 ? "{…}" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, brief(x, depth + 1)]));
  return v;
}

async function call(rt: IntegrationRuntime, build: string, tool: string, input: Record<string, unknown>, label: string, expect: "succeeded" | "failed" | "any" = "succeeded"): Promise<IntegrationToolResult> {
  const t0 = Date.now();
  const r = await rt.invoke(tool, JSON.stringify(input));
  const step: Step = { build, tool, label, status: r.status, ms: Date.now() - t0, ...(r.data !== undefined ? { data: brief(r.data) } : {}), ...(r.error ? { error: r.error } : {}) };
  report.steps.push(step);
  const mark = expect === "any" || r.status === expect ? "ok " : "!! ";
  console.log(`${mark}[${build}] ${tool} — ${label}: ${r.status}${r.error ? ` (${r.error.code}: ${r.error.message.slice(0, 220)})` : ""} [${step.ms}ms]`);
  if (expect !== "any" && r.status !== expect) {
    report.problems.push(`${build} ${tool} (${label}) expected ${expect}, got ${r.status}: ${r.error?.message ?? ""}`);
    if (!args.has("--keep-going")) throw new Error(`Unexpected outcome for ${tool}: ${JSON.stringify(r.error ?? r.status)}`);
  }
  return r;
}

async function writeOverlay(rt: IntegrationRuntime, build: string, dir: string) {
  const files = await overlayFiles(`demo/notify-hub/${dir}`);
  for (const [rel, content] of files) await call(rt, build, "integration_write", { slug, path: rel, content }, `scripted fixture ${dir}/${rel}`);
}

async function loadSuites(file: string): Promise<HostSuite[]> {
  return JSON.parse(await fs.readFile(path.join(TEMPLATES_ROOT, "demo/notify-hub/suites", file), "utf8")) as HostSuite[];
}

/** Customer-side use of a deployed child: catalog -> parent-minted token -> MCP calls. */
async function customerCall(catalog: ReturnType<typeof createIntegrationCatalog>, label: string, calls: Array<{ tool: string; arguments: Record<string, unknown> }>) {
  const tok = await catalog.accessToken(slug, { subject: "demo-customer-agent" }, 600);
  if (!tok) throw new Error("integration not in catalog");
  const client = new Client({ name: "demo-customer-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(tok.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${tok.token}` } } }));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    const results = [];
    for (const c of calls) {
      const r = await client.callTool({ name: c.tool, arguments: c.arguments });
      results.push({ tool: c.tool, isError: r.isError === true, structuredContent: brief(r.structuredContent) });
    }
    const out = { mcpUrl: tok.mcpUrl, audience: tok.audience, serverVersion: client.getServerVersion(), tools, results };
    report.live[label] = out;
    console.log(`ok [live] ${label}: ${JSON.stringify(results.map((r) => ({ tool: r.tool, isError: r.isError, count: (r.structuredContent as { count?: number } | null)?.count, id: (r.structuredContent as { id?: string } | null)?.id })))}`);
    return out;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  const store = new DirectoryObjectStore(path.join(dataDir, "store"));
  const envKeys = loadChildAuthFromEnv();
  const childAuth = envKeys ?? generateChildAuthKeys();
  report.childAuth = envKeys ? "INTEGRATION_CHILD_SIGNING_JWK (host env)" : "ephemeral Ed25519 key generated for this demo process (not persisted)";
  let publisher: ManufactPublisher | null = null;
  if (publish) {
    const creds = await resolveManufactCredentials({ orgSlug: ORG_SLUG });
    if (!creds) throw new Error("Manufact credentials not configured (MCP_USE_API_KEY+MANUFACT_ORG_SLUG or `mcp-use login`)");
    const api = new ManufactApi(creds);
    const id = await api.identity();
    report.live.manufactIdentity = { email: id.email, orgSlug: id.orgSlug, orgName: id.orgName, credentialSource: creds.source };
    console.log(`Manufact org ${id.orgName} (${id.orgSlug}) as ${id.email} via ${creds.source}`);
    publisher = new ManufactPublisher({ api, childAuth, serverPrefix: `procmem-demo-${runId.slice(-6)}`, deployEnv: () => ({ NOTIFY_HUB_SIMULATED: "1" }) });
  }
  const catalog = createIntegrationCatalog({ ns, store, childAuth });
  let suites = await loadSuites("v1.json");
  const mk = (buildId: string) => createIntegrationRuntime({ ns, store, buildId, suites: async () => suites, publisher, childAuth, exa: null });

  // ---------------- build A
  const A = `demo-${runId}-a`;
  const rtA = mk(A);
  try {
    await call(rtA, "A", "integration_open", { slug, create: { title: "Notify Hub", description: "Send and list notifications through the Notify Hub API (simulated third-party demo service).", upstreamName: "Notify Hub (simulated)" } }, "create from mcp-use child template");
    await writeOverlay(rtA, "A", "initial");
    await call(rtA, "A", "integration_exec", { slug, command: "npm test 2>&1 | tail -n 15" }, "agent-side npm test");
    await call(rtA, "A", "integration_git_status", { slug }, "dirty state before validation");
    const vA = await call(rtA, "A", "integration_validate", { slug }, "sealed gate vs host suite v1");
    const cA = await call(rtA, "A", "integration_git_commit", { slug, message: "Add Notify Hub list/send/get tools", validationReceiptId: (vA.data as { receiptId: string }).receiptId }, "commit validated tree");
    report.live.commitA = (cA.data as { commit: string }).commit;
    await call(rtA, "A", "integration_promote", { slug }, "promote + store exact deploy archive");
    if (publish) {
      await call(rtA, "A", "integration_publish", { slug }, "first publish (create Manufact server)");
      await customerCall(catalog, "deployedA", [{ tool: "list_notifications", arguments: {} }, { tool: "send_notification", arguments: { recipient: "ops@example.test", message: "demo A" } }]);
    }
  } finally {
    const closed = await rtA.close();
    report.steps.push({ build: "A", tool: "(close)", label: "persist bundle + terminate sandbox", status: closed.errors.length ? "failed" : "succeeded", ms: 0, data: closed });
  }

  // ---------------- build B
  suites = await loadSuites("v2.json");
  const B = `demo-${runId}-b`;
  const rtB = mk(B);
  try {
    await call(rtB, "B", "integration_open", { slug }, "cold restore from durable bundle in a new sandbox");
    await call(rtB, "B", "integration_git_log", { slug, ref: "main" }, "history restored");
    await call(rtB, "B", "integration_validate", { slug }, "current revision vs trace regressions + held-out", "failed");
    await writeOverlay(rtB, "B", "repair-bad");
    const vBad = await call(rtB, "B", "integration_validate", { slug }, "wrong repair (retries without idempotency key)", "failed");
    await call(rtB, "B", "integration_git_commit", { slug, message: "Retry sends", validationReceiptId: (vBad.data as { receiptId: string }).receiptId }, "commit refused for failing receipt", "failed");
    if (publish) await call(rtB, "B", "integration_deployment_status", { slug }, "deployment A still active after failed repair");
    await writeOverlay(rtB, "B", "repair-good");
    await call(rtB, "B", "integration_git_diff", { slug, stat: true }, "diff of the repair");
    await call(rtB, "B", "integration_exec", { slug, command: "npm test 2>&1 | tail -n 20" }, "agent-side npm test");
    const vGood = await call(rtB, "B", "integration_validate", { slug }, "correct repair vs regressions + held-out");
    const cB = await call(rtB, "B", "integration_git_commit", { slug, message: "Paginate with cursors; retry safely with a stable Idempotency-Key; honor Retry-After", validationReceiptId: (vGood.data as { receiptId: string }).receiptId }, "commit repair");
    report.live.commitB = (cB.data as { commit: string }).commit;
    await call(rtB, "B", "integration_promote", { slug }, "promote repair");
    if (publish) {
      await call(rtB, "B", "integration_publish", { slug }, "update deployed child to the repaired revision");
      await customerCall(catalog, "deployedB", [{ tool: "list_notifications", arguments: {} }, { tool: "send_notification", arguments: { recipient: "ops@example.test", message: "demo B" } }, { tool: "list_notifications", arguments: {} }]);
      await call(rtB, "B", "integration_deployment_logs", { slug, kind: "build" }, "build logs of the update");
    }
    await call(rtB, "B", "integration_git_branches", { slug }, "branches (main = promoted)");
  } finally {
    const closed = await rtB.close();
    report.steps.push({ build: "B", tool: "(close)", label: "persist bundle + terminate sandbox", status: closed.errors.length ? "failed" : "succeeded", ms: 0, data: closed });
  }

  // ---------------- build C
  const C = `demo-${runId}-c`;
  const rtC = mk(C);
  try {
    await call(rtC, "C", "integration_open", { slug }, "cold restore again");
    const log = await call(rtC, "C", "integration_git_log", { slug, ref: "main" }, "promoted history intact");
    const commits = ((log.data as { commits: Array<{ commit: string }> }).commits ?? []).map((c) => c.commit);
    if (!commits.includes(report.live.commitA as string) || commits[0] !== report.live.commitB) report.problems.push("restored main history does not contain commits A and B in order");
    await call(rtC, "C", "integration_list", {}, "catalog");
    if (publish && args.has("--rollback")) {
      await call(rtC, "C", "integration_rollback", { slug }, "redeploy previous passing archive (A)");
      await customerCall(catalog, "afterRollback", [{ tool: "list_notifications", arguments: {} }]);
      await call(rtC, "C", "integration_publish", { slug, force: true }, "republish promoted revision (B)");
      await customerCall(catalog, "afterRepublish", [{ tool: "list_notifications", arguments: {} }]);
    }
    if (publish) await call(rtC, "C", "integration_probe", { slug }, "live probe of active deployment");
  } finally {
    await rtC.close();
  }

  // Expectations on live behaviour (simulated upstream: 23 seeded items, page cap 10, first send loses its ack).
  if (publish) {
    const a = report.live.deployedA as { results: Array<{ structuredContent: { count?: number } | null; isError: boolean }> } | undefined;
    const b = report.live.deployedB as { results: Array<{ structuredContent: { count?: number } | null; isError: boolean }> } | undefined;
    if (a?.results[0]?.structuredContent?.count !== 10) report.problems.push(`deployed A list count ${a?.results[0]?.structuredContent?.count} (expected truncated 10)`);
    if (a?.results[1]?.isError !== true) report.problems.push("deployed A send should fail on the lost-ack 503 (no retry)");
    if (b?.results[0]?.structuredContent?.count !== 23) report.problems.push(`deployed B list count ${b?.results[0]?.structuredContent?.count} (expected 23)`);
    if (b?.results[1]?.isError !== false) report.problems.push("deployed B send should succeed through the lost-ack 503");
    if (b?.results[2]?.structuredContent?.count !== 24) report.problems.push(`deployed B list after send ${b?.results[2]?.structuredContent?.count} (expected 24, no duplicate)`);
  }
}

main()
  .catch((error) => {
    report.problems.push(`fatal: ${(error as Error).stack ?? String(error)}`);
    console.error(error);
  })
  .finally(async () => {
    report.finishedAt = new Date().toISOString();
    report.ok = report.problems.length === 0;
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "report.json"), JSON.stringify(report, null, 1));
    console.log(`\n${report.ok ? "DEMO OK" : "DEMO PROBLEMS"} — report ${path.relative(process.cwd(), path.join(dataDir, "report.json"))}`);
    for (const p of report.problems) console.log(` - ${p.slice(0, 400)}`);
    process.exitCode = report.ok ? 0 : 1;
  });
