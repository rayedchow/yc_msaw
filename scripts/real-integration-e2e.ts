/**
 * REAL end-to-end proof: a live customer agent fails on a real integration, the daily build agent
 * repairs the integration MCP and updates memory, and the SAME agent session uses the repaired tool.
 *
 *   npx tsx scripts/real-integration-e2e.ts [--slug github-read] [--customer kimi] [--builder kimi-k3]
 *
 * Labels (also written into the report):
 *  - SEEDED DEFECT (host-authored, yesterday's state): templates/integration/demo/github-read/seeded always
 *    sends ?ref=master and has no ref parameter. Validated offline against host suite v1, then really published.
 *  - LIVE UPSTREAM: the deployed child calls the real public api.github.com (no credentials, no writes).
 *  - LIVE CUSTOMER AGENT: ONE Pi 1.3 session (Fireworks model) with tools from the procmem SDK LiveToolRegistry
 *    against the HOSTED parent (wild-zero-kq08i), and traces captured by the SDK and sent to the hosted parent.
 *  - OPERATOR-TRIGGERED DAILY CYCLE (now): the real DailyBuildService -> runMemoryBuild (createConfiguredBuilder's
 *    profiles/workspaces/integration providers + an observing model-I/O wrapper for the live UI) over the SAME
 *    Modal store/namespace as the hosted parent, cohort = the fresh trace only (earlier traces of the day were
 *    already published). The build agents (Fireworks Kimi/GLM) choose every integration and wiki tool call.
 *  - SEALED VALIDATION uses a FAKE-data GitHub fixture offline (network-blocked sandbox). Every proof call to
 *    GitHub goes to the real API.
 * Live UI contract: .context/real-demo-events.jsonl (append-only, sanitized) + .context/real-demo-state.json.
 * Secrets stay in this process (never printed, never in events/reports); reports are scanned before writing.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFireworksRuntime, resolveFireworksModel } from "../eval/pi-agent.js";
import { resolveModelId } from "../eval/fireworks.js";
import { loadConfig } from "../src/config.js";
import { DailyBuildService, type MemoryBuilder } from "../src/daily/service.js";
import {
  createIntegrationToolProviders,
  createModalBuildWorkspaceFactory,
  createProfileRegistry,
  DEFAULT_PROFILES,
  fireworksClientFactory,
  runMemoryBuild,
  validateFireworksKey,
  type AgentReceipt,
  type ChatClientFactory,
  type ToolProviderRegistration,
} from "../src/harness/index.js";
import {
  createIntegrationRuntime,
  IntegrationStore,
  loadChildAuthFromEnv,
  ManufactApi,
  ManufactPublisher,
  resolveManufactCredentials,
  type HostSuite,
  type IntegrationRuntime,
} from "../src/integrations/index.js";
import { overlayFiles, TEMPLATES_ROOT } from "../src/integrations/template.js";
import { HttpTraceTransport, TraceRecorder, type TraceSession } from "../src/sdk/index.js";
import { attachPiTraceCapture } from "../src/sdk/pi-adapter.js";
import { LiveToolRegistry } from "../src/sdk/live/index.js";
import { createPiLiveTools } from "../src/sdk/live/pi.js";
import { MemoryRepo } from "../src/store/memory.js";
import { ModalObjectStore } from "../src/store/modal-objects.js";
import { gunzipSync } from "node:zlib";
import { finalizeAgentRows, harnessStatusToDemo, TERMINAL_STATUSES, type DemoAgentRow, type DemoStatus } from "./real-integration-e2e-render.js";

const { values } = parseArgs({
  options: {
    slug: { type: "string", default: "github-read" },
    customer: { type: "string", default: "kimi" },
    builder: { type: "string", default: "kimi-k3" },
    "max-turns": { type: "string", default: "60" },
    "max-tool-calls": { type: "string", default: "220" },
    "preflight-only": { type: "boolean", default: false },
  },
});
const SLUG = values.slug!;
const OWNER = "mcp-use";
const REPO = "mcp-use";
const FILE = "README.md";
const REF = "v1.5.0";
const FACT = "create-mcp-use-app";
const GH_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "procmem-e2e-host-check" };

// ------------------------------------------------------------------ secrets (process only)
async function loadEnvFile(file: string) {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
await loadEnvFile(".env");
await loadEnvFile(".context/manufact.env");
const client = JSON.parse(await fs.readFile(".context/hosted-demo-client.json", "utf8")) as { tenantNs: string; baseUrl: string; keys: { trace: string; build: string; read: string } };
const NS = client.tenantNs;
const BASE = client.baseUrl.replace(/\/+$/, "");
const FIREWORKS = process.env.FIREWORKS_API_KEY ?? "";
const SECRETS = [FIREWORKS, process.env.MCP_USE_API_KEY, process.env.EXA_API_KEY, process.env.INTEGRATION_CHILD_SIGNING_JWK, client.keys.trace, client.keys.build, client.keys.read].filter((s): s is string => !!s && s.length >= 12);
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
function scrub(s: string): string {
  let out = s;
  for (const sec of SECRETS) out = out.split(sec).join("[REDACTED]");
  return out.replace(JWT_RE, "[REDACTED_JWT]").replace(/"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/g, '"d":"[REDACTED]"');
}
function bounded(v: unknown, max = 6000): unknown {
  if (v === undefined) return undefined;
  const text = scrub(typeof v === "string" ? v : JSON.stringify(v));
  if (typeof v === "string") return text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text;
  if (text.length <= max) return JSON.parse(text);
  return { truncated: true, originalChars: text.length, preview: `${text.slice(0, max)}…` };
}

// ------------------------------------------------------------------ live UI contract
const RUN_ID = `e2e-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;
const EVENTS = ".context/real-demo-events.jsonl";
const STATE = ".context/real-demo-state.json";
const PROGRESS = ".context/real-demo-progress.md";
let evSeq = 0;
// Event / agent status union (see .context/demo-lifecycle-contract.md):
//  running = actively working now; waiting = idle between tasks (session alive); pending = known, not started;
//  succeeded/failed/partial = terminal outcome from real evidence; interrupted = run ended while it was active;
//  unknown = terminal state not established by any receipt/logger.
type Status = DemoStatus;
type AgentRow = DemoAgentRow;
interface DemoEvent { id: string; at: string; agentId: string; parentId?: string | null; kind: string; title: string; status?: Status; text?: string; data?: unknown }
const allEvents: DemoEvent[] = [];
const state: Record<string, unknown> & { agents: AgentRow[]; checks: Record<string, boolean>; files: Array<{ path: string; before?: string | null; after?: string | null; beforeSha256?: string | null; afterSha256?: string | null; truncated?: boolean; kind: "memory" | "source" }> } = {
  runId: RUN_ID,
  status: "running",
  phase: "preflight",
  title: "Real integration E2E: GitHub contents API",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  pid: process.pid,
  agents: [{ id: "host", parentId: null, name: "Host orchestrator (operator script)", role: "operator", status: "running" }],
  checks: {},
  files: [],
};

// All state writes are serialized on one chain; each snapshot goes to a unique temp file and is renamed
// atomically. Failures are recorded (and surfaced in the report), never silently swallowed.
const ioErrors: string[] = [];
let stateChain: Promise<void> = Promise.resolve();
let stateSeq = 0;
function writeState(): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const snapshot = `${scrub(JSON.stringify(state, null, 1))}\n`;
  const tmp = `${STATE}.tmp-${process.pid}-${++stateSeq}`;
  stateChain = stateChain.then(async () => {
    try {
      await fs.writeFile(tmp, snapshot);
      await fs.rename(tmp, STATE);
    } catch (error) {
      ioErrors.push(`state write: ${String((error as Error).message ?? error)}`);
      process.stderr.write(`[e2e] STATE WRITE ERROR ${String((error as Error).message ?? error)}\n`);
    }
  });
  return stateChain;
}
let writeChain: Promise<unknown> = Promise.resolve();
function emit(e: Omit<DemoEvent, "id" | "at"> & { at?: string }): DemoEvent {
  const ev: DemoEvent = { id: `${RUN_ID}-${String(++evSeq).padStart(5, "0")}`, at: e.at ?? new Date().toISOString(), agentId: e.agentId, parentId: e.parentId ?? null, kind: e.kind, title: scrub(e.title).slice(0, 300), ...(e.status ? { status: e.status } : {}), ...(e.text !== undefined ? { text: bounded(e.text, 8000) as string } : {}), ...(e.data !== undefined ? { data: bounded(e.data, 12000) } : {}) };
  allEvents.push(ev);
  const line = `${JSON.stringify(ev)}\n`;
  writeChain = writeChain
    .then(() => fs.appendFile(EVENTS, line))
    .catch((error) => {
      ioErrors.push(`event append: ${String((error as Error).message ?? error)}`);
      process.stderr.write(`[e2e] EVENT APPEND ERROR ${String((error as Error).message ?? error)}\n`);
    });
  process.stderr.write(`[e2e ${ev.at.slice(11, 19)}] ${ev.agentId} ${ev.kind}${ev.status ? `/${ev.status}` : ""}: ${ev.title}\n`);
  return ev;
}
function setAgent(id: string, patch: Partial<Omit<AgentRow, "id">>) {
  const a = state.agents.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
  else state.agents.push({ id, parentId: patch.parentId ?? null, name: patch.name ?? id, role: patch.role ?? "build", status: patch.status ?? "pending", ...(patch.model ? { model: patch.model } : {}), ...(patch.task ? { task: patch.task } : {}) });
  void writeState();
}
const TERMINAL = TERMINAL_STATUSES;
/** Customer task boundaries (distinct from the session lifecycle, which stays alive between tasks). */
function taskStart(attempt: number, prompt: string) {
  const at = new Date().toISOString();
  setAgent("customer", { task: { attempt, status: "running", startedAt: at } });
  emit({ at, agentId: "customer", kind: "task_start", title: `task attempt ${attempt} started`, status: "running", data: { attempt, prompt } });
}
function taskEnd(attempt: number, status: Status, detail: unknown) {
  const a = state.agents.find((x) => x.id === "customer");
  const at = new Date().toISOString();
  if (a?.task) a.task = { ...a.task, status, finishedAt: at };
  if (a && a.status === "running") a.status = "waiting";
  void writeState();
  emit({ at, agentId: "customer", kind: "task_end", title: `task attempt ${attempt} ${status}`, status, data: { attempt, ...(detail as object) } });
}
/**
 * Terminal cleanup: no row is left running/waiting/pending. Known terminal statuses are kept.
 * Normal finish: the customer session closes with its LAST task outcome; anything still active is "unknown"
 * (nothing established its outcome). Abort: active rows become "interrupted"; pending ones "unknown".
 */
function finalizeAgents(aborted: boolean, runOk: boolean) {
  finalizeAgentRows(state.agents, aborted, runOk);
}
const progressLines: string[] = [];
async function progress(line: string) {
  progressLines.push(`- ${new Date().toISOString()} ${scrub(line)}`);
  await fs.writeFile(PROGRESS, `# Real integration E2E progress (owner: integrations Opus 5.5)\n\nRun ${RUN_ID}, pid ${process.pid}. Live events: ${EVENTS}; state: ${STATE}.\n\n${progressLines.join("\n")}\n`);
}
async function phase(name: string, title: string) {
  state.phase = name;
  emit({ agentId: "host", kind: "phase", title, status: "running", data: { phase: name } });
  await writeState();
  await progress(`PHASE ${name}: ${title}`);
}
function check(name: string, ok: boolean, detail?: unknown) {
  state.checks[name] = ok;
  emit({ agentId: "host", kind: "check", title: `${ok ? "PASS" : "FAIL"} ${name}`, status: ok ? "succeeded" : "failed", ...(detail !== undefined ? { data: detail } : {}) });
  void writeState();
  return ok;
}

// reset event file (archive any previous run, never deleting history)
if (existsSync(EVENTS)) {
  let prev = "previous";
  try {
    prev = (JSON.parse((await fs.readFile(EVENTS, "utf8")).split("\n")[0] || "{}").id ?? "previous").split("-").slice(0, 3).join("-");
  } catch {
    /* keep default */
  }
  renameSync(EVENTS, `.context/real-demo-events.${prev}-archived-${Date.now()}.jsonl`);
}
await fs.writeFile(EVENTS, "");
await writeState();

const report: Record<string, unknown> = {
  kind: "real-integration-e2e",
  runId: RUN_ID,
  labels: {
    seededDefect: "HOST-SEEDED DEFECT (yesterday's state): github-read always sends ?ref=master and exposes no ref parameter (templates/integration/demo/github-read/seeded). Not model-authored.",
    upstream: "LIVE: real public api.github.com REST contents API (unauthenticated, read-only) called by the Manufact-hosted child MCP",
    customer: "LIVE: one Pi 1.3 session (Fireworks) with procmem SDK LiveToolRegistry tools against the hosted parent; SDK trace capture to the hosted parent",
    dailyCycle: "OPERATOR-TRIGGERED NOW: real DailyBuildService -> runMemoryBuild (createConfiguredBuilder inputs + observing model-I/O wrapper, requests/responses unaltered) on the same Modal store/namespace as the hosted parent; cohort = this run's fresh customer trace",
    repair: "MODEL-AUTHORED: every integration/wiki tool call in the build is chosen by the Fireworks build agents; the host gives no repaired source",
    validation: "Sealed validation runs offline with a FAKE-data GitHub fixture; all proof calls to GitHub are real",
    lifecycle: "Agent rows/events follow .context/demo-lifecycle-contract.md: customer running only during real Pi agent runs (waiting between attempts, task_start/task_end carry per-attempt outcome); build agents from the live logger then authoritative receipts (harnessStatusToDemo for state AND events); operator rows (host, builder wrapper) separate; finalizeAgentRows leaves no running/waiting/pending row",
  },
  config: { ns: NS, parent: BASE, slug: SLUG, owner: OWNER, repo: REPO, file: FILE, ref: REF, customerModel: resolveModelId(values.customer!), builderRoot: values.builder },
  phases: {} as Record<string, unknown>,
};
const phases = report.phases as Record<string, unknown>;
const store = new ModalObjectStore();
const integrations = new IntegrationStore(store, NS);
const repo = new MemoryRepo(store, NS);

// ------------------------------------------------------------------ helpers
async function gh(route: string): Promise<{ status: number; requestId: string | null; rateRemaining: string | null; body: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${route}`, { headers: GH_HEADERS });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, requestId: res.headers.get("x-github-request-id"), rateRemaining: res.headers.get("x-ratelimit-remaining"), body };
}
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
async function catalog(): Promise<{ status: number; integrations: Array<Record<string, unknown>> }> {
  const res = await fetch(`${BASE}/v1/integrations`, { headers: { authorization: `Bearer ${client.keys.read}` } });
  const j = (await res.json().catch(() => ({}))) as { integrations?: Array<Record<string, unknown>> };
  return { status: res.status, integrations: j.integrations ?? [] };
}
function gitDiff(a: string, b: string, max = 60_000): string {
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "--", a, b], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return "";
  } catch (error) {
    const out = String((error as { stdout?: string }).stdout ?? "");
    return (out.length > max ? `${out.slice(0, max)}\n…[diff truncated]` : out).replaceAll(a, "a").replaceAll(b, "b");
  }
}
async function writeTree(dir: string, files: ReadonlyMap<string, string>) {
  for (const [rel, content] of files) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
}
async function extractArchive(key: string, dir: string): Promise<Map<string, string>> {
  const bytes = await integrations.getBlob(key);
  await fs.mkdir(dir, { recursive: true });
  const tgz = `${dir}.tgz`;
  await fs.writeFile(tgz, bytes);
  execFileSync("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]); // data only; nothing in it is executed
  const out = new Map<string, string>();
  const walk = async (d: string, rel: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (e.isFile()) out.set(r, await fs.readFile(path.join(d, e.name), "utf8"));
    }
  };
  await walk(dir, "");
  return out;
}

class PreflightDone extends Error {}

// ------------------------------------------------------------------ main flow
const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "real-e2e-"));
let registry: LiveToolRegistry | null = null;
let disposeSession: (() => void) | null = null;
let ok = false;
let aborted = false;
const transcript: Array<Record<string, unknown>> = [];

try {
  // ---------------------------------------------------------------- preflight
  await phase("preflight", "Preflight: credentials, org pin, store, parent health");
  if (!FIREWORKS) throw new Error("FIREWORKS_API_KEY missing");
  const fk = await validateFireworksKey(FIREWORKS);
  if (!fk.ok) throw new Error(`Fireworks key rejected (HTTP ${fk.status})`);
  const creds = await resolveManufactCredentials({ orgSlug: process.env.MANUFACT_ORG_SLUG ?? "org-84350150-jpcs9" });
  if (!creds) throw new Error("Manufact credentials not configured");
  const api = new ManufactApi(creds);
  const identity = await api.identity();
  const childAuth = loadChildAuthFromEnv();
  if (!childAuth) throw new Error("INTEGRATION_CHILD_SIGNING_JWK (persistent parent child-auth key) missing from .context/manufact.env");
  const health = await fetch(`${BASE}/healthz`);
  const cat0 = await catalog();
  const existing = await integrations.get(SLUG);
  phases.preflight = { manufact: { email: identity.email, orgSlug: identity.orgSlug, orgName: identity.orgName, credentialSource: creds.source }, childAuthKid: childAuth.kid, parentHealth: health.status, catalogBefore: cat0.integrations.map((i) => ({ slug: i.slug, deploymentId: i.deploymentId })), memoryHead: (await repo.head())?.value ?? null };
  emit({ agentId: "host", kind: "message", title: `Manufact org ${identity.orgSlug} as ${identity.email}; parent /healthz ${health.status}; catalog ${cat0.status} [${cat0.integrations.map((i) => i.slug).join(", ")}]`, data: phases.preflight });
  if (!check("preflight.orgPinned", identity.orgSlug === "org-84350150-jpcs9")) throw new Error("wrong Manufact org");
  if (existing) throw new Error(`Integration ${SLUG} already exists in ${NS}; refusing to overwrite (pass --slug to use a new name)`);
  if (values["preflight-only"]) throw new PreflightDone();

  // ---------------------------------------------------------------- independent GitHub check
  await phase("github-check", "Independent GitHub REST checks (host, unauthenticated)");
  const ghRepo = await gh(`/repos/${OWNER}/${REPO}`);
  const ghMaster = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=master`);
  const ghRef = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${REF}`);
  const refText = typeof ghRef.body.content === "string" ? Buffer.from(ghRef.body.content, "base64").toString("utf8") : "";
  const truth = { defaultBranch: ghRepo.body.default_branch, masterStatus: ghMaster.status, masterMessage: ghMaster.body.message, masterRequestId: ghMaster.requestId, refStatus: ghRef.status, refRequestId: ghRef.requestId, sha: ghRef.body.sha, size: ghRef.body.size, textSha256: sha256(refText), containsFact: refText.includes(FACT), rateLimitRemaining: ghRef.rateRemaining, docs: "https://docs.github.com/en/rest/repos/contents" };
  phases.githubTruth = truth;
  emit({ agentId: "host", kind: "tool_result", title: `GitHub: default branch ${String(truth.defaultBranch)}; ?ref=master -> ${ghMaster.status} "${String(ghMaster.body.message)}"; ?ref=${REF} -> ${ghRef.status} sha ${String(truth.sha)}`, status: "succeeded", data: truth });
  const pre404 = check("github.masterIs404", ghMaster.status === 404 && /No commit found for the ref master/.test(String(ghMaster.body.message)), { requestId: ghMaster.requestId });
  const pre200 = check("github.refIs200WithFact", ghRef.status === 200 && truth.containsFact, { sha: truth.sha, requestId: ghRef.requestId });
  if (!pre404 || !pre200) throw new Error("GitHub preflight does not match the expected live behaviour; aborting before any deploy/build");

  // ---------------------------------------------------------------- seed (host-authored defect, really published)
  await phase("seed", "Seed yesterday's state: host-authored defective github-read child, validated (fixture) and published");
  const publisher = new ManufactPublisher({ api, childAuth, serverPrefix: "procmem-gh", deployEnv: () => ({}) });
  const loadSuites = async (f: string) => JSON.parse(await fs.readFile(path.join(TEMPLATES_ROOT, "demo/github-read/suites", f), "utf8")) as HostSuite[];
  const suitesV1 = await loadSuites("v1.json");
  const suitesV2 = await loadSuites("v2.json");
  const setup: IntegrationRuntime = createIntegrationRuntime({ ns: NS, store, buildId: `seed-${RUN_ID.toLowerCase()}`.slice(0, 60), suites: async () => suitesV1, publisher, childAuth, exa: null });
  const seedCall = async (tool: string, input: Record<string, unknown>) => {
    emit({ agentId: "host", kind: "tool_call", title: `seed ${tool}`, status: "running", data: { tool, input: tool === "integration_write" ? { ...input, content: `[${String(input.content).length} chars, SEEDED DEFECT fixture]` } : input } });
    const r = await setup.invoke(tool, JSON.stringify(input));
    emit({ agentId: "host", kind: "tool_result", title: `seed ${tool}: ${r.status}`, status: r.status === "succeeded" ? "succeeded" : "failed", data: { tool, result: r } });
    if (r.status !== "succeeded") throw new Error(`seed ${tool} failed: ${scrub(JSON.stringify(r.error ?? r)).slice(0, 800)}`);
    return r;
  };
  try {
    await seedCall("integration_open", { slug: SLUG, create: { title: "GitHub Read", description: "Read files from public GitHub repositories through the GitHub REST contents API (read-only, no credentials).", upstreamName: "GitHub REST API" } });
    // The seeded manifest names slug "github-read"; for --slug runs only the manifest slug is rewritten so the archive matches.
    for (const [rel, content] of await overlayFiles("demo/github-read/seeded")) await seedCall("integration_write", { slug: SLUG, path: rel, content: rel === "integration.json" ? content.replaceAll('"github-read"', JSON.stringify(SLUG)) : content });
    const v = await seedCall("integration_validate", { slug: SLUG });
    await seedCall("integration_git_commit", { slug: SLUG, message: "Add read_file over the GitHub contents API (seeded state)", validationReceiptId: (v.data as { receiptId: string }).receiptId });
    await seedCall("integration_promote", { slug: SLUG });
    await seedCall("integration_publish", { slug: SLUG });
  } finally {
    await setup.close();
  }
  const seeded = (await integrations.get(SLUG))!;
  phases.seed = { promoted: seeded.promoted, manufact: { serverId: seeded.manufact?.serverId, mcpUrl: seeded.manufact?.mcpUrl, dashboardUrl: seeded.manufact?.dashboardUrl, active: seeded.manufact?.active } };
  check("seed.publishedAndProbed", seeded.manufact?.active?.probe === "passed" && seeded.manufact.active.status === "running", phases.seed);

  // ---------------------------------------------------------------- customer session (ONE Pi session for the whole run)
  await phase("customer-session", "Start ONE customer Pi session with SDK live tools (hosted parent) + SDK trace capture");
  const toolEvents: Array<Record<string, unknown>> = [];
  registry = new LiveToolRegistry({ parent: { baseUrl: BASE, credential: () => client.keys.read }, pollIntervalMs: 15_000, onLog: (e) => toolEvents.push({ at: new Date().toISOString(), ...e }) });
  registry.onToolsChanged((c) => {
    const ev = { at: new Date().toISOString(), version: c.next.version, added: c.added.map((t) => t.name), updated: c.updated.map((t) => t.name), removed: c.removed.map((t) => t.name) };
    toolEvents.push(ev);
    emit({ agentId: "customer", kind: "sdk_update", title: `SDK tools v${c.next.version}: +${ev.added.length} ~${ev.updated.length} -${ev.removed.length}`, data: { ...ev, readFileSchema: c.next.tools.find((t) => t.name === `integration__${SLUG}__read_file`)?.inputSchema ?? null } });
  });
  await registry.start();
  const toolName = `integration__${SLUG}__read_file`;
  for (let i = 0; i < 30 && !registry.getTools().some((t) => t.name === toolName); i++) {
    await new Promise((r) => setTimeout(r, 6000));
    await registry.refresh({ force: true });
  }
  const initialSchema = registry.getTools().find((t) => t.name === toolName)?.inputSchema ?? null;
  if (!check("sdk.seededToolVisible", !!initialSchema, { tools: registry.getTools().map((t) => t.name) })) throw new Error("seeded tool never appeared through the hosted catalog");
  const applied: unknown[] = [];
  const live = createPiLiveTools(registry, { onApplied: (c) => applied.push({ at: new Date().toISOString(), ...c }) });
  const SYSTEM = [
    "You are a developer-assistant agent for one customer organization.",
    "Tools: memory__* is the organization's procedural memory (call memory__open_memory to pin the latest revision, then read/grep files in it); integration__<integration>__<tool> are live integration MCP servers.",
    "The set of tools and their schemas can change between requests; always use the tools available now.",
    "Only report what tools actually returned. If a tool fails, report the exact error (HTTP status, message, request id) and stop; never guess file contents.",
  ].join("\n");
  const dir = await fs.mkdtemp(path.join(tmpRoot, "pi-"));
  const runtime = await createFireworksRuntime(FIREWORKS);
  const model = resolveFireworksModel(runtime, values.customer!, "openai");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off" });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: SYSTEM, extensionFactories: [live.extension] });
  await resourceLoader.reload();
  let constructions = 0;
  constructions++;
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, thinkingLevel: "low", modelRuntime: runtime, resourceLoader, sessionManager: SessionManager.inMemory(dir), settingsManager, noTools: "builtin" });
  await session.bindExtensions({});
  disposeSession = () => {
    live.dispose();
    session.dispose();
  };
  const piSessionId = session.sessionId;
  const sessionRef = session;
  const messages = () => session.agent.state.messages as unknown[];
  const prefixHash = (n: number) => sha256(JSON.stringify(messages().slice(0, n)));
  state.sessionId = piSessionId;
  setAgent("customer", { name: `Customer agent (Pi session ${piSessionId})`, model: resolveModelId(values.customer!), role: "customer", status: "waiting" });
  // Live capture of real Pi events for the UI/report (the SDK trace capture below is the stored record).
  session.subscribe((event) => {
    const at = new Date().toISOString();
    const e = event as unknown as Record<string, unknown> & { type: string };
    if (e.type === "agent_start") {
      setAgent("customer", { status: "running" });
      emit({ at, agentId: "customer", kind: "turn_start", title: "Pi agent run started", status: "running" });
    } else if (e.type === "agent_end") {
      setAgent("customer", { status: "waiting" });
      emit({ at, agentId: "customer", kind: "turn_end", title: "Pi agent run ended (session idle)", status: "waiting" });
    } else if (e.type === "message_end") {
      const m = e.message as { role: string; content?: Array<Record<string, unknown>> };
      if (m.role === "assistant") {
        const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("").trim();
        const calls = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
        transcript.push({ at, type: "assistant", text, toolCalls: calls });
        if (text) emit({ at, agentId: "customer", kind: "message", title: "assistant", text });
      } else if (m.role === "user") {
        const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
        transcript.push({ at, type: "user", text });
        emit({ at, agentId: "customer", kind: "message", title: "user prompt", text });
      }
    } else if (e.type === "tool_execution_start") {
      transcript.push({ at, type: "tool_call", callId: e.toolCallId, name: e.toolName, args: e.args });
      emit({ at, agentId: "customer", kind: "tool_call", title: String(e.toolName), status: "running", data: { callId: e.toolCallId, args: e.args } });
    } else if (e.type === "tool_execution_end") {
      const result = e.result as { content?: Array<{ type: string; text?: string }>; details?: unknown } | undefined;
      const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      transcript.push({ at, type: "tool_result", callId: e.toolCallId, name: e.toolName, isError: e.isError === true, text: bounded(text, 30_000), details: bounded(result?.details, 30_000) });
      emit({ at, agentId: "customer", kind: "tool_result", title: `${String(e.toolName)}${e.isError ? " (error)" : ""}`, status: e.isError ? "failed" : "succeeded", text, data: { callId: e.toolCallId, details: result?.details } });
    }
  });
  const recorder = new TraceRecorder({ transport: new HttpTraceTransport({ baseUrl: BASE, token: client.keys.trace }), agent: { id: "customer-pi-agent", name: "customer Pi agent", model: resolveModelId(values.customer!), harness: "pi" }, flushIntervalMs: 0 });
  const lastAssistant = () => [...transcript].reverse().find((t) => t.type === "assistant" && String(t.text ?? "").length > 0)?.text as string | undefined;
  const readFileResults = (from: number) => transcript.slice(from).filter((t) => t.type === "tool_result" && t.name === toolName);
  const readFileCalls = (from: number) => transcript.slice(from).filter((t) => t.type === "tool_call" && t.name === toolName);
  phases.customerSession = { piSessionId, pid: process.pid, model: resolveModelId(values.customer!), initialReadFileSchema: initialSchema, activeTools: session.getActiveToolNames().filter((n) => n.startsWith("memory__") || n.startsWith("integration__")) };

  // ---------------------------------------------------------------- attempt 1 (expected to fail on the real 404)
  await phase("attempt-1", "Customer attempt 1 with the seeded integration (expected real GitHub 404)");
  const task = `Task: using the GitHub integration, read ${FILE} from the GitHub repository ${OWNER}/${REPO} at the release tag ${REF}, and tell me the exact shell command that README gives for creating a new TypeScript MCP server. Check memory first for any relevant procedure.`;
  const t1Start = transcript.length;
  taskStart(1, task);
  const trace1: TraceSession = recorder.begin({ objective: task, metadata: { piSessionId, attempt: 1, runId: RUN_ID } });
  let detach = attachPiTraceCapture(session, trace1);
  await session.prompt(task).catch((e) => emit({ agentId: "customer", kind: "message", title: "prompt error", status: "failed", text: String(e) }));
  detach();
  const historyAfter1 = messages().length;
  const prefixAfter1 = prefixHash(historyAfter1);
  const r1 = readFileResults(t1Start);
  const answer1 = lastAssistant() ?? "";
  const got404 = r1.some((t) => t.isError === true && /404/.test(String(t.text)) && /No commit found for the ref master/.test(String(t.text)));
  const fin1 = await trace1.finish({ status: "failed", summary: `customer agent reply: ${answer1}`.slice(0, 2000) });
  phases.attempt1 = { readFileCalls: readFileCalls(t1Start), readFileResults: r1, answer: answer1, trace: { sessionId: fin1.sessionId, events: fin1.events, chunks: fin1.chunks, deliveryErrors: fin1.errors.length } };
  taskEnd(1, got404 && !answer1.includes(FACT) ? "failed" : "unknown", { reason: got404 ? "seeded integration returned the real GitHub 404" : "expected 404 not observed", answer: answer1 });
  check("attempt1.realGithub404ReachedAgent", got404, { results: r1.map((t) => ({ isError: t.isError, text: String(t.text).slice(0, 400) })) });
  check("attempt1.noInventedAnswer", !answer1.includes(FACT));
  check("attempt1.traceDelivered", fin1.errors.length === 0 && fin1.chunks > 0, { sessionId: fin1.sessionId, chunks: fin1.chunks });
  if (!got404) throw new Error("attempt 1 did not hit the seeded 404; refusing to continue");

  // ---------------------------------------------------------------- trace stored in the hosted tenant
  await phase("trace", "Verify the SDK trace landed in the hosted tenant store");
  let traceDay = "";
  for (let i = 0; i < 20 && !traceDay; i++) {
    for (const d of [new Date().toISOString().slice(0, 10), new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]) {
      const keys = await store.list(NS, `traces/${d}/`, { limit: 5000 });
      if (keys.some((k) => k.includes(fin1.sessionId))) traceDay = d;
    }
    if (!traceDay) await new Promise((r) => setTimeout(r, 3000));
  }
  const traceKeys = traceDay ? (await store.list(NS, `traces/${traceDay}/`, { limit: 5000 })).filter((k) => k.includes(fin1.sessionId)) : [];
  const storedEvents: unknown[] = [];
  for (const [, bytes] of await store.get(NS, traceKeys)) for (const line of gunzipSync(bytes).toString("utf8").split("\n")) if (line) storedEvents.push(JSON.parse(line));
  phases.trace = { day: traceDay, chunkKeys: traceKeys, storedEvents: storedEvents.length, events: bounded(storedEvents, 60_000) };
  emit({ agentId: "host", kind: "files", title: `Stored SDK trace ${fin1.sessionId}: ${storedEvents.length} events in ${traceKeys.length} chunk(s) (day ${traceDay})`, status: traceKeys.length ? "succeeded" : "failed", data: { keys: traceKeys } });
  if (!check("trace.storedInHostedTenant", traceKeys.length > 0 && storedEvents.length > 0)) throw new Error("trace not found in the tenant store");

  // ---------------------------------------------------------------- operator-triggered daily cycle (real build agents)
  await phase("daily-build", "Operator-triggered daily cycle NOW: real DailyBuildService + recursive build agents");
  const memBefore = (await repo.head())?.value.revisionId ?? null;
  const intBefore = (await integrations.get(SLUG))!;
  const config = loadConfig({ ...process.env, PROCMEM_STORE: "modal", PROCMEM_SANDBOX: "modal", HOST: "127.0.0.1", PROCMEM_BUILD_MODEL: values.builder! });
  const agentParents = new Map<string, string | null>();
  // Harness AgentStatus -> demo status. Never invents success: anything unrecognized is "unknown".
  const statusOf = harnessStatusToDemo;
  const builderLog = (raw: unknown) => {
    if (typeof raw === "string" || !raw || typeof raw !== "object") {
      emit({ agentId: "builder", kind: "message", title: scrub(String(raw)).slice(0, 280) });
      return;
    }
    const e = raw as { at: string; agentId: string; event: string; detail?: Record<string, unknown> };
    const parentId = agentParents.get(e.agentId) ?? null;
    if (e.event === "spawned") for (const c of (e.detail?.children as string[]) ?? []) agentParents.set(c, e.agentId);
    if (e.event === "agent_started") setAgent(e.agentId, { parentId, name: `${parentId ? "child" : "root"} build agent ${e.agentId} (depth ${String(e.detail?.depth ?? "?")})`, model: String(e.detail?.profile ?? ""), role: "build", status: "running" });
    if (e.event === "agent_finished") setAgent(e.agentId, { status: statusOf(e.detail?.status) });
    emit({
      at: e.at,
      agentId: e.agentId,
      parentId,
      kind: e.event === "agent_started" ? "agent_start" : e.event === "agent_finished" ? "agent_end" : e.event === "tool_call" ? "tool_result" : e.event,
      title: e.event === "tool_call" ? `${String(e.detail?.tool)} ${e.detail?.ok ? "ok" : `failed${e.detail?.code ? ` (${String(e.detail.code)})` : ""}`}` : e.event,
      ...(e.event === "tool_call" ? { status: e.detail?.ok ? "succeeded" : "failed" } : e.event === "agent_finished" ? { status: statusOf(e.detail?.status) } : {}),
      data: { ...(e.detail ?? {}), source: "build logger (live)" },
    });
  };
  let integrationCallSeq = 0;
  const toolProviders = async (ctx: { ns: string; buildId: string; store: typeof store }): Promise<readonly ToolProviderRegistration[]> => {
    const regs = await createIntegrationToolProviders({ ns: ctx.ns, store: ctx.store as never, buildId: ctx.buildId, deps: { suites: async () => suitesV2, publisher, childAuth }, allowHostDeploy: true, required: true, log: (m) => emit({ agentId: "builder", kind: "message", title: m.slice(0, 280) }) });
    for (const r of regs) {
      const p = r.provider as unknown as { invoke: (name: string, input: unknown, c: { agentId: string }) => Promise<unknown> };
      const orig = p.invoke.bind(p);
      p.invoke = async (name, input, c) => {
        const callId = `int-${++integrationCallSeq}`;
        emit({ agentId: c.agentId, kind: "tool_call", title: name, status: "running", data: { callId, args: input, source: "integration provider (live)" } });
        try {
          const out = await orig(name, input, c);
          emit({ agentId: c.agentId, kind: "tool_result", title: `${name}: ${String((out as { status?: string }).status ?? "ok")}`, status: "succeeded", data: { callId, result: out } });
          return out;
        } catch (error) {
          emit({ agentId: c.agentId, kind: "tool_result", title: `${name}: failed (${String((error as { code?: string }).code ?? "error")})`, status: "failed", data: { callId, error: { code: (error as { code?: string }).code, message: String((error as Error).message) } } });
          throw error;
        }
      };
    }
    return regs;
  };
  // Demo-only builder: identical inputs to createConfiguredBuilder (approved profiles, Modal workspaces,
  // per-build integration runtime) plus an OBSERVING client wrapper that streams each build agent's real
  // model replies and tool results to the live UI. It never alters requests or responses.
  const profileIdFor = (m: string) => {
    const p = DEFAULT_PROFILES.find((x) => x.model === m || x.id === m);
    if (!p) throw new Error(`no approved build profile for ${m}`);
    return p.id;
  };
  const rootProfileId = profileIdFor(config.buildModel);
  const childProfileIds = [...new Set([rootProfileId, ...config.childModels.map(profileIdFor)])];
  const profiles = createProfileRegistry({ rootProfileId, childProfileIds, defaultChildProfileId: rootProfileId });
  const baseFactory = fireworksClientFactory(FIREWORKS);
  const observingFactory: ChatClientFactory = (profile, ctx) => {
    const inner = baseFactory(profile, ctx);
    let seen = 0;
    return {
      model: inner.model,
      async chat(msgs, tools, opts) {
        for (const m of msgs.slice(seen)) {
          if (m.role === "tool") emit({ agentId: ctx.agentId, parentId: ctx.parentId ?? null, kind: "tool_result", title: "tool result (as seen by the model)", text: String(m.content ?? ""), data: { callId: m.tool_call_id, source: "build agent model input (live)" } });
          else if (m.role === "user") emit({ agentId: ctx.agentId, parentId: ctx.parentId ?? null, kind: "message", title: seen === 0 ? "task given to the agent" : "user/harness message", text: String(m.content ?? ""), data: { source: "build agent model input (live)" } });
        }
        const res = await inner.chat(msgs, tools, opts);
        seen = msgs.length + 1;
        const text = typeof res.message.content === "string" ? res.message.content : "";
        if (text.trim()) emit({ agentId: ctx.agentId, parentId: ctx.parentId ?? null, kind: "message", title: "assistant", text, data: { source: "build agent model output (live)", model: inner.model, usage: res.usage } });
        for (const tc of res.message.tool_calls ?? []) emit({ agentId: ctx.agentId, parentId: ctx.parentId ?? null, kind: "tool_call", title: tc.function.name, status: "running", data: { callId: tc.id, args: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch { return tc.function.arguments; } })(), source: "build agent model output (live)" } });
        return res;
      },
    };
  };
  const budget = { maxTurns: Number(values["max-turns"]), maxToolCalls: Number(values["max-tool-calls"]), maxDescendants: 4 };
  const builder: MemoryBuilder = async ({ repo: r, ns, buildId, inputs, sources, signal }) => {
    const receipt = await runMemoryBuild({
      repo: r,
      inputs,
      sources,
      buildId,
      profiles,
      clientFactory: observingFactory,
      workspaceFactory: createModalBuildWorkspaceFactory({ tags: { purpose: "memory-build" } }),
      budget,
      toolProviders: await toolProviders({ ns, buildId, store: r.store as typeof store }),
      signal,
      log: builderLog,
    });
    return { ...receipt, status: receipt.status, revisionId: receipt.revisionId, ...(receipt.failure ? { error: `${receipt.failure.code}: ${receipt.failure.message}` } : {}) };
  };
  report.builderConfig = { buildModel: config.buildModel, rootProfileId, childProfileIds, budget, path: "DailyBuildService -> runMemoryBuild (same profiles/workspace/integration providers as createConfiguredBuilder) + observing client wrapper" };
  const service = new DailyBuildService({ store, builder, buildTimeoutMs: 40 * 60_000, log: (m) => emit({ agentId: "host", kind: "message", title: m.slice(0, 280) }) });
  setAgent("builder", { name: `Daily build service (operator wrapper, ${values.builder})`, role: "operator", status: "running" });
  const buildStarted = Date.now();
  const buildReceipt = (await service.runAndWait(NS, { day: traceDay })) as Record<string, unknown> | null;
  const buildMs = Date.now() - buildStarted;
  setAgent("builder", { status: buildReceipt?.status === "published" ? "succeeded" : buildReceipt?.status === "failed" ? "failed" : "unknown" });
  // Retained per-agent detail (receipts are produced after the run; marked as such).
  const walk = (a: AgentReceipt) => {
    // Receipts are authoritative for the final per-agent status.
    setAgent(a.agentId, { parentId: a.parentId, model: a.model, role: "build", status: statusOf(a.status) });
    emit({ agentId: a.agentId, parentId: a.parentId, kind: "agent_end", title: `[retained receipt] ${a.agentId} ${a.status}`, status: statusOf(a.status), data: { source: "agent receipt (retained after run)", harnessStatus: a.status, model: a.model, depth: a.depth, objective: a.objective, usage: a.usage, toolCalls: a.toolCalls.map((t) => ({ name: t.name, ok: t.ok, code: t.code, turn: t.turn })), summary: a.result?.summary ?? null, patch: a.result?.patch?.changes ?? null } });
    for (const c of a.children ?? []) walk(c);
  };
  for (const att of ((buildReceipt?.attempts as Array<{ tree: AgentReceipt }> | undefined) ?? [])) walk(att.tree);
  phases.dailyBuild = { day: traceDay, buildMs, receipt: bounded({ ...(buildReceipt ?? {}), attempts: undefined }, 20_000), status: buildReceipt?.status, revisionId: buildReceipt?.revisionId };
  emit({ agentId: "builder", kind: "run_end", title: `daily build ${String(buildReceipt?.status)} ${String(buildReceipt?.revisionId ?? "")}`, status: buildReceipt?.status === "published" ? "succeeded" : "failed", data: phases.dailyBuild });

  // ---------------------------------------------------------------- what the build changed (from durable state)
  await phase("diffs", "Memory revision diff and integration source diff (durable state)");
  const memAfter = (await repo.head())?.value.revisionId ?? null;
  const intAfter = (await integrations.get(SLUG))!;
  const memFilesBefore = memBefore ? await repo.files(memBefore) : new Map<string, string>();
  const memFilesAfter = memAfter ? await repo.files(memAfter) : new Map<string, string>();
  await writeTree(path.join(tmpRoot, "mem-before"), memFilesBefore);
  await writeTree(path.join(tmpRoot, "mem-after"), memFilesAfter);
  const memDiff = gitDiff(path.join(tmpRoot, "mem-before"), path.join(tmpRoot, "mem-after"));
  const memChanged = [...new Set([...memFilesBefore.keys(), ...memFilesAfter.keys()])].filter((p) => memFilesBefore.get(p) !== memFilesAfter.get(p)).sort();
  const FILE_MAX = 60_000;
  const fileEntry = (p: string, kind: "memory" | "source", a?: string, b?: string) => ({
    path: p,
    kind,
    before: a === undefined ? null : a.slice(0, FILE_MAX),
    after: b === undefined ? null : b.slice(0, FILE_MAX),
    beforeSha256: a === undefined ? null : sha256(a),
    afterSha256: b === undefined ? null : sha256(b),
    truncated: (a?.length ?? 0) > FILE_MAX || (b?.length ?? 0) > FILE_MAX,
  });
  for (const p of memChanged) state.files.push(fileEntry(`memory/${p}`, "memory", memFilesBefore.get(p), memFilesAfter.get(p)));
  emit({ agentId: "host", kind: "memory_diff", title: `Memory ${memBefore} -> ${memAfter}: ${memChanged.length} file(s) changed`, status: memAfter !== memBefore ? "succeeded" : "failed", text: memDiff, data: { before: memBefore, after: memAfter, changed: memChanged } });
  let srcDiff = "";
  let srcChanged: string[] = [];
  if (intBefore.promoted && intAfter.promoted && intAfter.promoted.commit !== intBefore.promoted.commit) {
    const a = await extractArchive(intBefore.promoted.archiveKey, path.join(tmpRoot, "src-before"));
    const b = await extractArchive(intAfter.promoted.archiveKey, path.join(tmpRoot, "src-after"));
    srcDiff = gitDiff(path.join(tmpRoot, "src-before"), path.join(tmpRoot, "src-after"));
    srcChanged = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
    for (const p of srcChanged) state.files.push(fileEntry(`mcps/${SLUG}/${p}`, "source", a.get(p), b.get(p)));
  }
  emit({ agentId: "host", kind: "source_diff", title: `Integration ${SLUG}: ${intBefore.promoted?.commit?.slice(0, 12)} -> ${intAfter.promoted?.commit?.slice(0, 12)} (${srcChanged.length} file(s))`, status: srcChanged.length ? "succeeded" : "failed", text: srcDiff, data: { before: intBefore.promoted?.commit, after: intAfter.promoted?.commit, changed: srcChanged } });
  await writeState();
  phases.diffs = {
    memory: { before: memBefore, after: memAfter, changed: memChanged, diff: memDiff, pagesAfter: Object.fromEntries([...memFilesAfter].filter(([p]) => memChanged.includes(p)).map(([p, c]) => [p, c.slice(0, 20_000)])) },
    source: { beforeCommit: intBefore.promoted?.commit, afterCommit: intAfter.promoted?.commit, afterValidation: intAfter.promoted?.validationReceiptId, changed: srcChanged, diff: srcDiff },
    deployment: { before: intBefore.manufact?.active, after: intAfter.manufact?.active, serverId: intAfter.manufact?.serverId, mcpUrl: intAfter.manufact?.mcpUrl, dashboardUrl: intAfter.manufact?.dashboardUrl },
  };
  check("build.memoryRevisionPublished", buildReceipt?.status === "published" && !!memAfter && memAfter !== memBefore, { memBefore, memAfter });
  check("build.integrationCommitPromoted", srcChanged.length > 0);
  check("build.newDeploymentActive", !!intAfter.manufact?.active && intAfter.manufact.active.deploymentId !== intBefore.manufact?.active?.deploymentId && intAfter.manufact.active.status === "running" && intAfter.manufact.active.probe === "passed", phases.diffs);

  // ---------------------------------------------------------------- SDK sees the new deployment/schema (no restart)
  await phase("sdk-update", "SDK detects the repaired child (new deployment and schema) in the running session");
  let newSchema: Record<string, unknown> | null = null;
  let forcedRefreshUsed = false;
  const currentSchema = () => registry!.getTools().find((x) => x.name === toolName)?.inputSchema ?? null;
  // 1) automatic SDK polling only (pollIntervalMs 15s) for up to 3 minutes
  for (let i = 0; i < 36 && !newSchema; i++) {
    const t = currentSchema();
    if (t && JSON.stringify(t) !== JSON.stringify(initialSchema)) newSchema = t as Record<string, unknown>;
    else await new Promise((r) => setTimeout(r, 5000));
  }
  // 2) explicit operator-forced refresh only if automatic polling did not see it (labelled)
  for (let i = 0; i < 20 && !newSchema; i++) {
    forcedRefreshUsed = true;
    await registry.refresh({ force: true });
    const t = currentSchema();
    if (t && JSON.stringify(t) !== JSON.stringify(initialSchema)) newSchema = t as Record<string, unknown>;
    else await new Promise((r) => setTimeout(r, 10_000));
  }
  live.applyNow();
  const firstSchemaChange = toolEvents.find((e) => Array.isArray((e as { updated?: string[] }).updated) && ((e as { updated: string[] }).updated.includes(toolName) || ((e as { added?: string[] }).added ?? []).includes(toolName)));
  const cat1 = await catalog();
  phases.sdkUpdate = { initialSchema, newSchema, detectedBy: forcedRefreshUsed ? "operator-forced refresh (automatic poll did not observe it within 3 min)" : "automatic SDK catalog poll", firstToolsChangedEventForReadFile: firstSchemaChange ?? null, catalogAfter: cat1.integrations.map((i) => ({ slug: i.slug, deploymentId: i.deploymentId, commit: i.commit, tools: i.tools, mcpUrl: i.mcpUrl })), toolEvents, piApplied: applied, activeTools: session.getActiveToolNames().filter((n) => n.startsWith("integration__") || n.startsWith("memory__")) };
  emit({ agentId: "customer", kind: "sdk_update", title: `read_file schema ${newSchema ? "changed" : "unchanged"} in the live session`, status: newSchema ? "succeeded" : "failed", data: { before: initialSchema, after: newSchema } });
  check("sdk.schemaUpdatedWithoutRestart", !!newSchema && session.sessionId === piSessionId && (newSchema as { properties?: Record<string, unknown> }).properties?.ref !== undefined, { forcedRefreshUsed });

  // ---------------------------------------------------------------- attempt 2 in the SAME session
  await phase("attempt-2", "Same Pi session: reopen memory, use the repaired tool against real GitHub");
  const retry = "Retry the same task now. Since your last attempt the organization's memory and integrations may have been updated: call memory__open_memory again to pin the newest memory revision, read what it says about the GitHub integration, then use the integration tools as they are now.";
  const t2Start = transcript.length;
  taskStart(2, retry);
  const trace2 = recorder.begin({ objective: retry, metadata: { piSessionId, attempt: 2, runId: RUN_ID } });
  detach = attachPiTraceCapture(session, trace2);
  await session.prompt(retry).catch((e) => emit({ agentId: "customer", kind: "message", title: "prompt error", status: "failed", text: String(e) }));
  detach();
  const r2 = readFileResults(t2Start);
  const c2 = readFileCalls(t2Start);
  const answer2 = lastAssistant() ?? "";
  // Find the structured GitHub metadata the repaired child returned (Pi details carry the MCP result).
  const findMeta = (v: unknown): Record<string, unknown> | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.sha === "string" && o.github && typeof o.github === "object") return o;
    for (const x of Object.values(o)) {
      const hit = findMeta(x);
      if (hit) return hit;
    }
    return null;
  };
  const okResult = r2.find((t) => {
    const meta = findMeta(t.details);
    const g = meta?.github as { status?: number; requestId?: string } | undefined;
    return t.isError !== true && meta?.sha === truth.sha && meta?.ref === REF && g?.status === 200 && typeof g.requestId === "string" && g.requestId.length > 0;
  });
  const okMeta = okResult ? findMeta(okResult.details) : null;
  const okCall = okResult ? c2.find((c) => c.callId === okResult.callId) : undefined;
  const reopened = transcript.slice(t2Start).filter((t) => t.type === "tool_result" && t.name === "memory__open_memory");
  const seq2 = transcript.slice(t2Start).filter((t) => t.type === "tool_call").map((t) => String(t.name));
  const iOpen = seq2.indexOf("memory__open_memory");
  const iFirstRead = seq2.indexOf(toolName);
  const memoryReadBetween = iOpen >= 0 && iFirstRead > iOpen && seq2.slice(iOpen + 1, iFirstRead).some((n) => ["memory__read", "memory__grep", "memory__find", "memory__ls", "memory__view_file"].includes(n));
  const historyAfter2 = messages().length;
  const fin2 = await trace2.finish({ status: okResult && answer2.includes(FACT) ? "succeeded" : "failed", summary: `customer agent reply: ${answer2}`.slice(0, 2000) });
  phases.attempt2 = { readFileCalls: c2, readFileResults: r2, memoryReopen: reopened, answer: answer2, trace: { sessionId: fin2.sessionId, events: fin2.events, chunks: fin2.chunks, deliveryErrors: fin2.errors.length } };
  taskEnd(2, okResult && answer2.includes(FACT) ? "succeeded" : "failed", { answer: answer2, githubOk: !!okResult });
  phases.sameSession = { constructions, piSessionId, sessionIdNow: session.sessionId, sameObject: sessionRef === session, pid: process.pid, historyAfterAttempt1: historyAfter1, historyAfterAttempt2: historyAfter2, prefixSha256AfterAttempt1: prefixAfter1, prefixSha256OfSameRangeAfterAttempt2: prefixHash(historyAfter1), toolSequenceAttempt2: seq2 };
  check("attempt2.sameSessionAndProcess", constructions === 1 && sessionRef === session && session.sessionId === piSessionId && process.pid === state.pid);
  check("attempt2.messageHistoryGrewWithExactPrefix", historyAfter2 > historyAfter1 && prefixHash(historyAfter1) === prefixAfter1, phases.sameSession);
  check("attempt2.memoryReopenedNewRevision", reopened.some((t) => String(t.text).includes(String(memAfter)) || JSON.stringify(t.details ?? "").includes(String(memAfter))), { memAfter });
  check("attempt2.readMemoryAfterReopenBeforeTool", memoryReadBetween, { sequence: seq2 });
  check("attempt2.calledRepairedToolWithRef", (okCall?.args as { ref?: string } | undefined)?.ref === REF, { call: okCall ?? c2 });
  check("attempt2.realGithub200SameShaAsHostCheck", !!okResult, { expectedSha: truth.sha, returned: okMeta });
  check("attempt2.answerHasFact", answer2.includes(FACT), { answer: answer2.slice(0, 600) });
  const ghAfter = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${REF}`);
  phases.githubAfter = { status: ghAfter.status, requestId: ghAfter.requestId, sha: ghAfter.body.sha, rateLimitRemaining: ghAfter.rateRemaining };
  check("github.independentAfterSameSha", ghAfter.status === 200 && ghAfter.body.sha === truth.sha);

  ok = Object.values(state.checks).every(Boolean);
  report.messageHistoryLength = (session.agent.state.messages as unknown[]).length;
} catch (error) {
  if (error instanceof PreflightDone) {
    emit({ agentId: "host", kind: "run_end", title: "preflight-only run finished (no GitHub, deploy or model calls)", status: "succeeded" });
    state.status = "succeeded";
    state.phase = "done";
    finalizeAgents(false, true);
    await writeState();
    await writeChain;
    await stateChain;
    console.log(JSON.stringify({ preflightOnly: true, checks: state.checks, preflight: scrub(JSON.stringify(phases.preflight)) }, null, 1));
    process.exit(0);
  }
  emit({ agentId: "host", kind: "run_end", title: `ABORTED: ${scrub(String((error as Error).message ?? error)).slice(0, 250)}`, status: "failed", data: { stack: scrub(String((error as Error).stack ?? "")).slice(0, 4000) } });
  report.error = scrub(String((error as Error).stack ?? error));
  aborted = true;
} finally {
  disposeSession?.();
  await registry?.dispose().catch(() => undefined);
  store.close();
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
}

// ------------------------------------------------------------------ reports
report.checks = state.checks;
report.ok = ok;
report.transcript = transcript;
report.finishedAt = new Date().toISOString();
state.status = ok ? "succeeded" : "failed";
state.phase = "done";
finalizeAgents(aborted, ok);
report.agents = state.agents;
const suffix = ok ? "" : `-failed-${RUN_ID}`;
state.reportPath = `reports/real-integration-e2e${suffix}.json`;
emit({ agentId: "host", kind: "run_end", title: ok ? "ALL CHECKS PASSED" : "CHECKS FAILED", status: ok ? "succeeded" : "failed", data: { checks: state.checks, report: `reports/real-integration-e2e${suffix}.json`, markdown: `reports/real-integration-e2e${suffix}.md`, html: `reports/real-integration-e2e${suffix}.html`, mcpUrl: (report.phases as Record<string, { deployment?: { mcpUrl?: string } }>).diffs?.deployment?.mcpUrl ?? null } });
report.events = allEvents;
await writeChain;
await writeState();
await stateChain;
report.ioErrors = ioErrors;
const out = scrub(JSON.stringify(report, null, 2));
if (SECRETS.some((s) => out.includes(s)) || /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(out)) throw new Error("report still contains a credential; refusing to write");
await fs.mkdir("reports", { recursive: true });
await fs.writeFile(`reports/real-integration-e2e${suffix}.json`, `${out}\n`);
const { renderMarkdown, renderHtml } = await import("./real-integration-e2e-render.js");
await fs.writeFile(`reports/real-integration-e2e${suffix}.md`, scrub(renderMarkdown(JSON.parse(out))));
await fs.writeFile(`reports/real-integration-e2e${suffix}.html`, scrub(renderHtml(JSON.parse(out))));
await progress(`DONE ok=${ok} report reports/real-integration-e2e${suffix}.json`);
if (ok) await fs.writeFile(".context/real-demo-ready", `Real integration E2E PASSED ${new Date().toISOString()} run ${RUN_ID}\nreports/real-integration-e2e.json .md .html\nchecks: ${Object.keys(state.checks).length} all passed\n`);
process.exitCode = ok ? 0 : 1;
