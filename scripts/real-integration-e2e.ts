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
  restoreIntegration,
  retireIntegration,
  ManufactApi,
  ManufactPublisher,
  resolveManufactCredentials,
  type HostSuite,
  type IntegrationRuntime,
} from "../src/integrations/index.js";
import { overlayFiles, TEMPLATES_ROOT } from "../src/integrations/template.js";
import { HttpTraceTransport, TraceRecorder, type TraceSession } from "../src/sdk/index.js";
import { beginPiTrace } from "../src/sdk/pi-adapter.js";
import { FileTraceOutbox } from "../src/sdk/outbox-file.js";
import { classifyAttempt, classifyBuildCycle, finalVerdict, mechanismProof, nextStep, upsertFile, type AttemptClassification, type CycleProof, type RecordedFile } from "./real-integration-e2e-controller.js";
import { LiveToolRegistry } from "../src/sdk/live/index.js";
import { createPiLiveTools } from "../src/sdk/live/pi.js";
import { MemoryRepo } from "../src/store/memory.js";
import { ModalObjectStore } from "../src/store/modal-objects.js";
import { gunzipSync } from "node:zlib";
import { boundEventData, extractGithubFileEvidence, finalizeAgentRows, githubProofOk, harnessStatusToDemo, TERMINAL_STATUSES, type DemoAgentRow, type DemoStatus, type GithubFileEvidence } from "./real-integration-e2e-render.js";

const { values } = parseArgs({
  options: {
    // Fresh seeded slug per execution (the older repaired github-read is hidden from discovery during the run).
    slug: { type: "string", default: `github-read-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "")}` },
    // Live UI/state files live here; NEVER the original .context/real-demo-{events,state} evidence paths.
    "data-dir": { type: "string", default: ".context/real-demo-fresh" },
    "max-cycles": { type: "string", default: "3" },
    // Other integrations whose read_file could answer the same task; retired (reversible) during the run, restored after.
    isolate: { type: "string", default: "github-read" },
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
const DATA_DIR = path.resolve(values["data-dir"]!);
const PROTECTED = [".context/real-demo-events.jsonl", ".context/real-demo-state.json"].map((f) => path.resolve(f));
if (DATA_DIR === path.resolve(".context")) throw new Error("--data-dir must not be .context (the original run's evidence files live there)");
await fs.mkdir(DATA_DIR, { recursive: true });
const EVENTS = path.join(DATA_DIR, "real-demo-events.jsonl");
const STATE = path.join(DATA_DIR, "real-demo-state.json");
const PROGRESS = path.join(DATA_DIR, "progress.md");
const PROGRESS_MIRROR = `${DATA_DIR}-progress.md`;
const READY = `${DATA_DIR}-ready`;
if ([EVENTS, STATE].some((f) => PROTECTED.includes(f))) throw new Error("refusing to write the original evidence paths");
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
  const ev: DemoEvent = { id: `${RUN_ID}-${String(++evSeq).padStart(5, "0")}`, at: e.at ?? new Date().toISOString(), agentId: e.agentId, parentId: e.parentId ?? null, kind: e.kind, title: scrub(e.title).slice(0, 300), ...(e.status ? { status: e.status } : {}), ...(e.text !== undefined ? { text: bounded(e.text, 8000) as string } : {}), ...(e.data !== undefined ? { data: boundEventData(e.data, 12000, scrub) } : {}) };
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
  const body = `# Real integration E2E progress (owner: integrations Opus 5.5)\n\nRun ${RUN_ID}, pid ${process.pid}. Live events: ${path.relative(process.cwd(), EVENTS)}; state: ${path.relative(process.cwd(), STATE)}.\n\n${progressLines.join("\n")}\n`;
  await fs.writeFile(PROGRESS, body);
  await fs.writeFile(PROGRESS_MIRROR, body);
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
  // Archive inside the data dir (with the matching state snapshot); originals elsewhere are never touched.
  const stamp = Date.now();
  renameSync(EVENTS, path.join(DATA_DIR, `real-demo-events.${prev}-archived-${stamp}.jsonl`));
  if (existsSync(STATE)) renameSync(STATE, path.join(DATA_DIR, `real-demo-state.${prev}-archived-${stamp}.json`));
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
// Host GitHub checks: primary = the user-authorized `gh` CLI (authenticated; gh handles the token, which this
// process never reads or prints); fallback = unauthenticated REST. Every result records which path ran, and a
// 403/rate-limit result is kept as recorded (never retried into a different semantic path).
let ghCliAuthenticated: boolean | null = null;
function ghCliAvailable(): boolean {
  if (ghCliAuthenticated === null) {
    try {
      execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 15_000 });
      ghCliAuthenticated = true;
    } catch {
      ghCliAuthenticated = false;
    }
  }
  return ghCliAuthenticated;
}
async function gh(route: string): Promise<{ status: number; requestId: string | null; rateRemaining: string | null; body: Record<string, unknown>; via: "gh-cli-authenticated" | "rest-unauthenticated" }> {
  if (ghCliAvailable()) {
    let out = "";
    try {
      out = execFileSync("gh", ["api", "--include", route.replace(/^\//, ""), "-H", `Accept: ${GH_HEADERS.accept}`, "-H", "X-GitHub-Api-Version: 2022-11-28"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    } catch (error) {
      out = String((error as { stdout?: string }).stdout ?? ""); // gh exits non-zero on 4xx but still prints headers/body
    }
    const split = out.indexOf("\r\n\r\n") >= 0 ? out.indexOf("\r\n\r\n") : out.indexOf("\n\n");
    const head = split >= 0 ? out.slice(0, split) : out;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(split >= 0 ? out.slice(split).trim() : "{}");
    } catch {
      /* non-JSON body: keep {} */
    }
    return { status: Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0), requestId: /x-github-request-id:\s*(\S+)/i.exec(head)?.[1] ?? null, rateRemaining: /x-ratelimit-remaining:\s*(\S+)/i.exec(head)?.[1] ?? null, body, via: "gh-cli-authenticated" };
  }
  const res = await fetch(`https://api.github.com${route}`, { headers: GH_HEADERS });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, requestId: res.headers.get("x-github-request-id"), rateRemaining: res.headers.get("x-ratelimit-remaining"), body, via: "rest-unauthenticated" };
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
const isolated: string[] = [];
let aborted = false;
const transcript: Array<Record<string, unknown>> = [];
const rawToolResults = new Map<string, { isError: boolean; result: unknown }>();

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
  const truth = { via: { repo: ghRepo.via, master: ghMaster.via, ref: ghRef.via }, defaultBranch: ghRepo.body.default_branch, masterStatus: ghMaster.status, masterMessage: ghMaster.body.message, masterRequestId: ghMaster.requestId, refStatus: ghRef.status, refRequestId: ghRef.requestId, sha: ghRef.body.sha, size: ghRef.body.size, textSha256: sha256(refText), containsFact: refText.includes(FACT), rateLimitRemaining: ghRef.rateRemaining, docs: "https://docs.github.com/en/rest/repos/contents" };
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
  // Isolation: an older (already repaired) GitHub child would answer the task without any repair. Hide it from
  // discovery for the run (reversible tombstone; its repo, history, receipts and deployment are untouched).
  for (const other of String(values.isolate ?? "").split(",").map((x) => x.trim()).filter((x) => x && x !== SLUG)) {
    const rec = await integrations.get(other);
    if (!rec || (rec.lifecycle?.state ?? "active") === "retired") continue;
    const out = await retireIntegration({ store: integrations, slug: other, buildId: `iso-${RUN_ID.toLowerCase()}`.slice(0, 60), reason: `hidden from discovery during fresh E2E run ${RUN_ID}; restored at the end` });
    isolated.push(other);
    emit({ agentId: "host", kind: "message", title: `isolation: retired ${other} from discovery for this run (restored at end)`, data: { slug: other, receiptId: out.receiptId } });
  }

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
      emit({ at, agentId: "customer", kind: "tool_call", title: String(e.toolName), status: "running", data: { callId: e.toolCallId, tool: e.toolName, source: "Pi tool_execution_start (live)", args: e.args } });
    } else if (e.type === "tool_execution_end") {
      const result = e.result as { content?: Array<{ type: string; text?: string }>; details?: unknown } | undefined;
      const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      // Evidence is extracted from the RAW result before anything is bounded for display; the raw result itself
      // is kept in memory (rawToolResults) for verification only and never written to reports.
      rawToolResults.set(String(e.toolCallId), { isError: e.isError === true, result });
      const evidenceMeta = extractGithubFileEvidence(result?.details ?? result, (x) => sha256(x));
      transcript.push({ at, type: "tool_result", callId: e.toolCallId, name: e.toolName, isError: e.isError === true, evidence: evidenceMeta, text: bounded(text, 30_000), details: bounded(result?.details, 30_000) });
      emit({ at, agentId: "customer", kind: "tool_result", title: `${String(e.toolName)}${e.isError ? " (error)" : ""}`, status: e.isError ? "failed" : "succeeded", text, data: { callId: e.toolCallId, tool: e.toolName, source: "Pi tool_execution_end (live)", evidence: evidenceMeta, details: result?.details } });
    }
  });
  // Durable outbox: events become crash-safe once flushed; delivery to the hosted parent resumes from it.
  const recorder = new TraceRecorder({ transport: new HttpTraceTransport({ baseUrl: BASE, token: client.keys.trace }), agent: { id: "customer-pi-agent", name: "customer Pi agent", model: resolveModelId(values.customer!), harness: "pi" }, flushIntervalMs: 0, outbox: new FileTraceOutbox(path.join(DATA_DIR, "outbox")) });
  const lastAssistant = () => [...transcript].reverse().find((t) => t.type === "assistant" && String(t.text ?? "").length > 0)?.text as string | undefined;
  const readFileResults = (from: number) => transcript.slice(from).filter((t) => t.type === "tool_result" && t.name === toolName);
  const readFileCalls = (from: number) => transcript.slice(from).filter((t) => t.type === "tool_call" && t.name === toolName);
  phases.customerSession = { piSessionId, pid: process.pid, model: resolveModelId(values.customer!), initialReadFileSchema: initialSchema, activeTools: session.getActiveToolNames().filter((n) => n.startsWith("memory__") || n.startsWith("integration__")) };

  // ---------------------------------------------------------------- feedback loop: attempt -> (real build cycle -> SDK update -> same-session retry)*
  const task = `Task: using the GitHub integration, read ${FILE} from the GitHub repository ${OWNER}/${REPO} at the release tag ${REF}, and tell me the exact shell command that README gives for creating a new TypeScript MCP server. Check memory first for any relevant procedure.`;
  const retry = "Retry the same task now. Since your last attempt the organization's memory and integrations may have been updated: call memory__open_memory again to pin the newest memory revision, read what it says about the GitHub integration, then use the integration tools as they are now.";
  const MAX_CYCLES = Math.max(0, Math.min(3, Number(values["max-cycles"])));
  const config = loadConfig({ ...process.env, PROCMEM_STORE: "modal", PROCMEM_SANDBOX: "modal", HOST: "127.0.0.1", PROCMEM_BUILD_MODEL: values.builder! });
  const statusOf = harnessStatusToDemo;
  const profileIdFor = (m: string) => {
    const p = DEFAULT_PROFILES.find((x) => x.model === m || x.id === m);
    if (!p) throw new Error(`no approved build profile for ${m}`);
    return p.id;
  };
  const rootProfileId = profileIdFor(config.buildModel);
  const childProfileIds = [...new Set([rootProfileId, ...config.childModels.map(profileIdFor)])];
  const profiles = createProfileRegistry({ rootProfileId, childProfileIds, defaultChildProfileId: rootProfileId });
  const baseFactory = fireworksClientFactory(FIREWORKS);
  const budget = { maxTurns: Number(values["max-turns"]), maxToolCalls: Number(values["max-tool-calls"]), maxDescendants: 4 };
  report.builderConfig = { buildModel: config.buildModel, rootProfileId, childProfileIds, budget, maxCycles: MAX_CYCLES, path: "DailyBuildService -> runMemoryBuild (same profiles/workspace/integration providers as createConfiguredBuilder) + observing client wrapper; one service run per build cycle" };
  let integrationCallSeq = 0;
  // Build agent ids restart per build ("root", children...): scope every UI id by cycle so builds never merge.
  let cyclePrefix = "c0";
  const sid = (id: string | null | undefined) => (id ? `${cyclePrefix}/${id}` : null);
  const agentParents = new Map<string, string | null>();
  const builderLog = (raw: unknown) => {
    if (typeof raw === "string" || !raw || typeof raw !== "object") {
      emit({ agentId: `${cyclePrefix}/builder`, kind: "message", title: scrub(String(raw)).slice(0, 280) });
      return;
    }
    const e = raw as { at: string; agentId: string; event: string; detail?: Record<string, unknown> };
    const id = sid(e.agentId)!;
    const parentId = agentParents.get(id) ?? null;
    if (e.event === "spawned") for (const c of (e.detail?.children as string[]) ?? []) agentParents.set(sid(c)!, id);
    if (e.event === "agent_started") setAgent(id, { parentId, name: `${cyclePrefix} ${parentId ? "child" : "root"} build agent ${e.agentId} (depth ${String(e.detail?.depth ?? "?")})`, model: String(e.detail?.profile ?? ""), role: "build", status: "running" });
    if (e.event === "agent_finished") setAgent(id, { status: statusOf(e.detail?.status) });
    emit({
      at: e.at,
      agentId: id,
      parentId,
      kind: e.event === "agent_started" ? "agent_start" : e.event === "agent_finished" ? "agent_end" : e.event === "tool_call" ? "tool_result" : e.event,
      title: e.event === "tool_call" ? `${String(e.detail?.tool)} ${e.detail?.ok ? "ok" : `failed${e.detail?.code ? ` (${String(e.detail.code)})` : ""}`}` : e.event,
      ...(e.event === "tool_call" ? { status: e.detail?.ok ? "succeeded" : "failed" } : e.event === "agent_finished" ? { status: statusOf(e.detail?.status) } : {}),
      data: { ...(e.detail ?? {}), ...(e.event === "tool_call" ? { tool: e.detail?.tool } : {}), source: "build logger (live)" },
    });
  };
  const toolProviders = async (ctx: { ns: string; buildId: string; store: typeof store }): Promise<readonly ToolProviderRegistration[]> => {
    const regs = await createIntegrationToolProviders({ ns: ctx.ns, store: ctx.store as never, buildId: ctx.buildId, deps: { suites: async () => suitesV2, publisher, childAuth }, allowHostDeploy: true, required: true, log: (m) => emit({ agentId: `${cyclePrefix}/builder`, kind: "message", title: m.slice(0, 280) }) });
    for (const r of regs) {
      const p = r.provider as unknown as { invoke: (name: string, input: unknown, c: { agentId: string }) => Promise<unknown> };
      const orig = p.invoke.bind(p);
      p.invoke = async (name, input, c) => {
        const callId = `${cyclePrefix}-int-${++integrationCallSeq}`;
        emit({ agentId: sid(c.agentId)!, kind: "tool_call", title: name, status: "running", data: { callId, tool: name, source: "integration provider (live)", args: input } });
        try {
          const out = await orig(name, input, c);
          emit({ agentId: sid(c.agentId)!, kind: "tool_result", title: `${name}: ${String((out as { status?: string }).status ?? "ok")}`, status: "succeeded", data: { callId, tool: name, source: "integration provider (live)", result: out } });
          return out;
        } catch (error) {
          emit({ agentId: sid(c.agentId)!, kind: "tool_result", title: `${name}: failed (${String((error as { code?: string }).code ?? "error")})`, status: "failed", data: { callId, tool: name, source: "integration provider (live)", error: { code: (error as { code?: string }).code, message: String((error as Error).message) } } });
          throw error;
        }
      };
    }
    return regs;
  };
  const observingFactory: ChatClientFactory = (profile, ctx) => {
    const inner = baseFactory(profile, ctx);
    let seen = 0;
    const aid = sid(ctx.agentId)!;
    const pid = sid(ctx.parentId);
    return {
      model: inner.model,
      async chat(msgs, tools, opts) {
        for (const m of msgs.slice(seen)) {
          if (m.role === "tool") emit({ agentId: aid, parentId: pid, kind: "tool_result", title: "tool result (as seen by the model)", text: String(m.content ?? ""), data: { callId: m.tool_call_id, source: "build agent model input (live)" } });
          else if (m.role === "user") emit({ agentId: aid, parentId: pid, kind: "message", title: seen === 0 ? "task given to the agent" : "user/harness message", text: String(m.content ?? ""), data: { source: "build agent model input (live)" } });
        }
        const res = await inner.chat(msgs, tools, opts);
        seen = msgs.length + 1;
        const text = typeof res.message.content === "string" ? res.message.content : "";
        if (text.trim()) emit({ agentId: aid, parentId: pid, kind: "message", title: "assistant", text, data: { source: "build agent model output (live)", model: inner.model, usage: res.usage } });
        for (const tc of res.message.tool_calls ?? []) emit({ agentId: aid, parentId: pid, kind: "tool_call", title: tc.function.name, status: "running", data: { callId: tc.id, tool: tc.function.name, source: "build agent model output (live)", args: (() => { try { return JSON.parse(tc.function.arguments || "{}"); } catch { return tc.function.arguments; } })() } });
        return res;
      },
    };
  };
  const builder: MemoryBuilder = async ({ repo: r, ns, buildId, inputs, sources, signal }) => {
    const receipt = await runMemoryBuild({ repo: r, inputs, sources, buildId, profiles, clientFactory: observingFactory, workspaceFactory: createModalBuildWorkspaceFactory({ tags: { purpose: "memory-build" } }), budget, toolProviders: await toolProviders({ ns, buildId, store: r.store as typeof store }), signal, log: builderLog });
    return { ...receipt, status: receipt.status, revisionId: receipt.revisionId, ...(receipt.failure ? { error: `${receipt.failure.code}: ${receipt.failure.message}` } : {}) };
  };
  const service = new DailyBuildService({ store, builder, buildTimeoutMs: 40 * 60_000, log: (m) => emit({ agentId: `${cyclePrefix}/builder`, kind: "message", title: m.slice(0, 280) }) });

  const FILE_MAX = 60_000;
  const fileEntry = (p: string, kind: "memory" | "source", a?: string, b?: string) => ({ path: p, kind, before: a === undefined ? null : a.slice(0, FILE_MAX), after: b === undefined ? null : b.slice(0, FILE_MAX), beforeSha256: a === undefined ? null : sha256(a), afterSha256: b === undefined ? null : sha256(b), truncated: (a?.length ?? 0) > FILE_MAX || (b?.length ?? 0) > FILE_MAX });
  const findTraceDay = async (sessionId: string) => {
    for (let i = 0; i < 20; i++) {
      for (const d of [new Date().toISOString().slice(0, 10), new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]) {
        const keys = (await store.list(NS, `traces/${d}/`, { limit: 5000 })).filter((k) => k.includes(sessionId));
        if (keys.length) return { day: d, keys };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { day: "", keys: [] as string[] };
  };

  const attempts: Array<Record<string, any>> = [];
  const cycleProofs: CycleProof[] = [];
  const cycles: Array<Record<string, any>> = [];
  const historyMarks: Array<{ attempt: number; length: number; prefixSha256: string }> = [];
  let previousRunId: string | undefined;
  let knownSchema: unknown = initialSchema;
  let knownDeploymentId = (await integrations.get(SLUG))?.manufact?.active?.deploymentId ?? null;
  let lastBuild: ReturnType<typeof classifyBuildCycle> | null = null;
  let finalClass: AttemptClassification | null = null;
  let finalAttemptChecks: Record<string, boolean> = {};

  for (let n = 1; ; n++) {
    await phase(`attempt-${n}`, n === 1 ? "Customer attempt 1 with the seeded integration" : `Same Pi session: attempt ${n} after build cycle ${n - 1}`);
    const prompt = n === 1 ? task : retry;
    const tStart = transcript.length;
    const runId = `${RUN_ID.toLowerCase()}-a${n}`;
    const toolAvailable = session.getActiveToolNames().includes(toolName);
    taskStart(n, prompt);
    const { trace, detach } = beginPiTrace(recorder, session, { objective: prompt, metadata: { piSessionId, attempt: n, demoRunId: RUN_ID }, runId, ...(previousRunId ? { previousRunId } : {}) });
    let promptError: string | null = null;
    await session.prompt(prompt).catch((e) => {
      promptError = scrub(String((e as Error)?.message ?? e)).slice(0, 500);
      emit({ agentId: "customer", kind: "message", title: "prompt error", status: "failed", text: promptError });
    });
    detach();
    const mark = { attempt: n, length: messages().length, prefixSha256: prefixHash(messages().length) };
    historyMarks.push(mark);
    const results = readFileResults(tStart);
    const calls = readFileCalls(tStart);
    const answer = lastAssistant() ?? "";
    // Verification uses the RAW tool results by callId (never the bounded transcript copy).
    const proofs = results.map((t) => {
      const raw = rawToolResults.get(String(t.callId));
      const call = calls.find((c) => c.callId === t.callId);
      const ev = raw ? extractGithubFileEvidence((raw.result as { details?: unknown } | undefined)?.details ?? raw.result, (x) => sha256(x)) : null;
      return { callId: t.callId, args: call?.args ?? null, isError: raw?.isError ?? null, evidence: ev, ok: !!raw && raw.isError !== true && githubProofOk(ev, { ref: REF, sha: String(truth.sha) }, call?.args) };
    });
    const integrationToolErrors = results.filter((t) => t.isError === true).map((t) => ({ status: Number(/GitHub error (\d{3})/.exec(String(t.text))?.[1] ?? /\b(\d{3})\b/.exec(String(t.text))?.[1] ?? NaN) || null, message: String(t.text).slice(0, 300) }));
    const proofOk = proofs.some((p) => p.ok);
    const fin = await trace.finish({ status: proofOk && answer.includes(FACT) ? "succeeded" : "failed", summary: `customer agent reply: ${answer}`.slice(0, 2000) });
    const traceDelivered = fin.errors.length === 0 && fin.chunks > 0;
    const cls = classifyAttempt({ promptError, traceDelivered, toolAvailable, integrationToolErrors, proofOk, answerHasFact: answer.includes(FACT), verifierError: null });
    previousRunId = runId;
    // Attempt-specific checks (retries must reopen memory at the newest revision and read it before the tool).
    const seq = transcript.slice(tStart).filter((t) => t.type === "tool_call").map((t) => String(t.name));
    const memHead = (await repo.head())?.value.revisionId ?? null;
    const reopened = transcript.slice(tStart).filter((t) => t.type === "tool_result" && t.name === "memory__open_memory");
    const iOpen = seq.lastIndexOf("memory__open_memory");
    const firstToolAfterOpen = seq.findIndex((x, i) => i > iOpen && x === toolName);
    const memoryReadBetween = iOpen >= 0 && firstToolAfterOpen > iOpen && seq.slice(iOpen + 1, firstToolAfterOpen).some((x) => ["memory__read", "memory__grep", "memory__find", "memory__ls", "memory__view_file"].includes(x));
    const attemptChecks: Record<string, boolean> = n === 1 ? {} : {
      memoryReopenedNewestRevision: reopened.some((t) => String(t.text).includes(String(memHead)) || JSON.stringify(t.details ?? "").includes(String(memHead))),
      readMemoryAfterReopenBeforeTool: memoryReadBetween,
    };
    const rec = { attempt: n, runId, previousRunId: n === 1 ? null : `${RUN_ID.toLowerCase()}-a${n - 1}`, conversationId: (trace as unknown as { conversationId?: string }).conversationId ?? null, prompt, toolAvailable, promptError, calls, proofs, integrationToolErrors, answer, classification: cls, attemptChecks, memHeadAtEnd: memHead, toolSequence: seq, history: mark, trace: { sessionId: fin.sessionId, events: fin.events, chunks: fin.chunks, deliveryErrors: fin.errors.length } };
    attempts.push(rec);
    taskEnd(n, cls.outcome === "succeeded" ? "succeeded" : "failed", { classification: cls, proofOk, traceSessionId: fin.sessionId });
    emit({ agentId: "host", kind: "check", title: `attempt ${n}: ${cls.outcome}${cls.failureClass ? ` (${cls.failureClass})` : ""}: ${cls.reason}`.slice(0, 290), status: cls.outcome === "succeeded" ? "succeeded" : "failed", data: { attempt: n, classification: cls, proofs: proofs.map((p) => ({ callId: p.callId, ok: p.ok, evidence: p.evidence })) } });
    await progress(`attempt ${n}: ${cls.outcome} ${cls.failureClass ?? ""} ${cls.reason}`);
    finalClass = cls;
    finalAttemptChecks = attemptChecks;
    const step = nextStep(cls, cycles.length, MAX_CYCLES, lastBuild);
    if (step.action === "stop") {
      report.loopStop = step;
      break;
    }

    // ---------------------------------------------------------------- real build cycle over the new catch-up cohort
    const cycle = step.cycle;
    cyclePrefix = `c${cycle}`;
    await phase(`build-cycle-${cycle}`, `Build cycle ${cycle}: operator-triggered daily cycle over attempt ${n}'s trace (real recursive build agents)`);
    const { day: traceDay, keys: traceKeys } = await findTraceDay(fin.sessionId);
    if (!traceDay) {
      report.loopStop = { action: "stop", verdict: "failed", reason: `trace ${fin.sessionId} not found in the tenant store`, blockedBy: "infra" };
      break;
    }
    const memBefore = (await repo.head())?.value.revisionId ?? null;
    const intBefore = (await integrations.get(SLUG))!;
    const appliedBaseline = applied.length;
    const toolEventsBaseline = toolEvents.length;
    setAgent(`${cyclePrefix}/builder`, { name: `Daily build service cycle ${cycle} (operator wrapper, ${values.builder})`, role: "operator", status: "running" });
    const buildStarted = Date.now();
    let buildReceipt: Record<string, unknown> | null = null;
    let buildError: string | null = null;
    try {
      buildReceipt = (await service.runAndWait(NS, { day: traceDay })) as Record<string, unknown> | null;
    } catch (error) {
      buildError = scrub(String((error as Error)?.message ?? error));
    }
    const buildMs = Date.now() - buildStarted;
    const bStatus = (buildReceipt?.status as string | undefined) ?? null;
    setAgent(`${cyclePrefix}/builder`, { status: bStatus === "published" ? "succeeded" : bStatus === "failed" || buildError ? "failed" : "unknown" });
    const walk = (a: AgentReceipt) => {
      setAgent(sid(a.agentId)!, { parentId: sid(a.parentId), model: a.model, role: "build", status: statusOf(a.status) });
      emit({ agentId: sid(a.agentId)!, parentId: sid(a.parentId), kind: "agent_end", title: `[retained receipt] ${a.agentId} ${a.status}`, status: statusOf(a.status), data: { source: "agent receipt (retained after run)", harnessStatus: a.status, model: a.model, depth: a.depth, objective: a.objective, usage: a.usage, toolCalls: a.toolCalls.map((t) => ({ name: t.name, ok: t.ok, code: t.code, turn: t.turn })), summary: a.result?.summary ?? null, patch: a.result?.patch?.changes ?? null } });
      for (const c of a.children ?? []) walk(c);
    };
    for (const att of ((buildReceipt?.attempts as Array<{ tree: AgentReceipt }> | undefined) ?? [])) walk(att.tree);
    const memAfter = (await repo.head())?.value.revisionId ?? null;
    const intAfter = (await integrations.get(SLUG))!;
    // Diffs from durable state (memory revision + promoted integration source).
    const memFilesBefore = memBefore ? await repo.files(memBefore) : new Map<string, string>();
    const memFilesAfter = memAfter ? await repo.files(memAfter) : new Map<string, string>();
    const md = path.join(tmpRoot, `c${cycle}`);
    await writeTree(path.join(md, "mem-before"), memFilesBefore);
    await writeTree(path.join(md, "mem-after"), memFilesAfter);
    const memDiff = gitDiff(path.join(md, "mem-before"), path.join(md, "mem-after"));
    const memChanged = [...new Set([...memFilesBefore.keys(), ...memFilesAfter.keys()])].filter((p) => memFilesBefore.get(p) !== memFilesAfter.get(p)).sort();
    for (const p of memChanged) upsertFile(state.files as RecordedFile[], fileEntry(`memory/${p}`, "memory", memFilesBefore.get(p), memFilesAfter.get(p)), cycle);
    emit({ agentId: "host", kind: "memory_diff", title: `cycle ${cycle}: memory ${memBefore} -> ${memAfter}: ${memChanged.length} file(s)`, status: memAfter !== memBefore ? "succeeded" : "partial", text: memDiff, data: { cycle, before: memBefore, after: memAfter, changed: memChanged } });
    let srcDiff = "";
    let srcChanged: string[] = [];
    if (intBefore.promoted && intAfter.promoted && intAfter.promoted.commit !== intBefore.promoted.commit) {
      const a = await extractArchive(intBefore.promoted.archiveKey, path.join(md, "src-before"));
      const b = await extractArchive(intAfter.promoted.archiveKey, path.join(md, "src-after"));
      srcDiff = gitDiff(path.join(md, "src-before"), path.join(md, "src-after"));
      srcChanged = [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
      for (const p of srcChanged) upsertFile(state.files as RecordedFile[], fileEntry(`mcps/${SLUG}/${p}`, "source", a.get(p), b.get(p)), cycle);
    }
    emit({ agentId: "host", kind: "source_diff", title: `cycle ${cycle}: ${SLUG} ${intBefore.promoted?.commit?.slice(0, 12)} -> ${intAfter.promoted?.commit?.slice(0, 12)} (${srcChanged.length} file(s))`, status: srcChanged.length ? "succeeded" : "partial", text: srcDiff, data: { cycle, before: intBefore.promoted?.commit, after: intAfter.promoted?.commit, changed: srcChanged } });
    const newDeployment = !!intAfter.manufact?.active && intAfter.manufact.active.deploymentId !== intBefore.manufact?.active?.deploymentId && intAfter.manufact.active.status === "running" && intAfter.manufact.active.probe === "passed";
    lastBuild = classifyBuildCycle({ status: bStatus, error: buildError ?? ((buildReceipt?.error as string | undefined) ?? null), newDeployment, newMemoryRevision: !!memAfter && memAfter !== memBefore });

    // ---------------------------------------------------------------- SDK/Pi observe the change automatically
    // Integration change: wait (no forced refresh, no manual apply) for the registry's own poll to list the new
    // deployment and, if the schema changed, for Pi's adapter to apply that exact tool at an idle safe point.
    // Memory-only change: nothing to wait for here; the customer must explicitly reopen + read the new revision.
    const expectedDeployment = newDeployment ? intAfter.manufact!.active!.deploymentId : null;
    const sourceState = () => registry!.getSnapshot().sources.find((x) => String(x.source).includes(SLUG));
    const schemaNow = () => registry!.getTools().find((x) => x.name === toolName)?.inputSchema ?? null;
    let sdkAutomatic = false;
    let piAutomatic: boolean | null = null;
    let forcedRefreshUsed = false;
    let manualApplyUsed = false;
    let sdkObservedAt: string | null = null;
    let piAppliedEvent: unknown = null;
    const schemaChanged = () => JSON.stringify(schemaNow()) !== JSON.stringify(knownSchema);
    const piSawTool = () => applied.slice(appliedBaseline).find((a) => [...((a as { updated?: string[] }).updated ?? []), ...((a as { added?: string[] }).added ?? [])].includes(toolName));
    if (expectedDeployment) {
      for (let i = 0; i < 48 && (!sdkAutomatic || (schemaChanged() && !piSawTool())); i++) {
        const st = sourceState();
        if (!sdkAutomatic && st?.deploymentId === expectedDeployment && st.state === "ready") {
          sdkAutomatic = true;
          sdkObservedAt = new Date().toISOString();
        }
        if (!sdkAutomatic || (schemaChanged() && !piSawTool())) await new Promise((r) => setTimeout(r, 5000));
      }
      const autoPi = piSawTool();
      piAutomatic = schemaChanged() || autoPi ? !!autoPi : null; // null = definition identical, nothing for Pi to apply
      piAppliedEvent = autoPi ?? null;
      if (!sdkAutomatic) {
        // Labelled fallback only; never counted as automatic.
        for (let i = 0; i < 12 && sourceState()?.deploymentId !== expectedDeployment; i++) {
          forcedRefreshUsed = true;
          await registry.refresh({ force: true });
          if (sourceState()?.deploymentId !== expectedDeployment) await new Promise((r) => setTimeout(r, 10_000));
        }
      }
      if (piAutomatic === false) {
        manualApplyUsed = true;
        live.applyNow();
      }
    }
    const newSchema = schemaNow();
    const sdk = {
      kind: expectedDeployment ? "integration" : lastBuild.changed ? "memory-only" : "none",
      expectedDeployment,
      sdkAutomatic,
      sdkObservedAt,
      piAutomatic,
      piAppliedEvent,
      forcedRefreshUsed,
      manualApplyUsed,
      registrySource: sourceState() ?? null,
      schemaBefore: knownSchema,
      schemaAfter: newSchema,
      toolsChangedThisCycle: toolEvents.slice(toolEventsBaseline),
      piAppliedThisCycle: applied.slice(appliedBaseline),
    };
    const observed = expectedDeployment ? sdkAutomatic : lastBuild.changed;
    emit({ agentId: "customer", kind: "sdk_update", title: `cycle ${cycle}: ${sdk.kind === "integration" ? `SDK ${sdkAutomatic ? "auto-observed" : forcedRefreshUsed ? "saw (FORCED refresh)" : "did NOT observe"} deployment ${String(expectedDeployment).slice(0, 8)}; Pi ${piAutomatic === null ? "no schema change" : piAutomatic ? "auto-applied" : "MANUAL apply"}` : sdk.kind === "memory-only" ? "memory-only change (customer must reopen memory)" : "no change"}`, status: observed ? "succeeded" : "partial", data: { cycle, ...sdk } });
    knownSchema = newSchema;
    if (expectedDeployment) knownDeploymentId = expectedDeployment;
    cycleProofs.push({ cycle, buildOk: lastBuild.ok, memoryChanged: !!memAfter && memAfter !== memBefore, sourceChanged: srcChanged.length > 0, newDeployment, sdkAutomatic, piAutomatic });
    cycles.push({ cycle, afterAttempt: n, day: traceDay, traceKeys, buildMs, status: bStatus, error: buildError ?? buildReceipt?.error ?? null, revisionId: buildReceipt?.revisionId ?? null, receipt: bounded({ ...(buildReceipt ?? {}), attempts: undefined }, 20_000), classification: lastBuild, memory: { before: memBefore, after: memAfter, changed: memChanged, diff: memDiff, pagesAfter: Object.fromEntries([...memFilesAfter].filter(([p]) => memChanged.includes(p)).map(([p, c]) => [p, c.slice(0, 20_000)])) }, source: { beforeCommit: intBefore.promoted?.commit, afterCommit: intAfter.promoted?.commit, afterValidation: intAfter.promoted?.validationReceiptId, changed: srcChanged, diff: srcDiff }, deployment: { before: intBefore.manufact?.active, after: intAfter.manufact?.active, newDeployment, serverId: intAfter.manufact?.serverId, mcpUrl: intAfter.manufact?.mcpUrl, dashboardUrl: intAfter.manufact?.dashboardUrl }, sdk });
    emit({ agentId: `${cyclePrefix}/builder`, kind: "run_end", title: `build cycle ${cycle}: ${bStatus ?? "error"} ${String(buildReceipt?.revisionId ?? "")} (${lastBuild.reason})`.slice(0, 290), status: lastBuild.ok ? "succeeded" : "failed", data: { cycle, status: bStatus, revisionId: buildReceipt?.revisionId ?? null, newDeployment, memoryChanged: memChanged.length, sourceChanged: srcChanged.length } });
    await progress(`build cycle ${cycle}: ${lastBuild.reason}; SDK ${sdk.kind} automatic=${sdk.sdkAutomatic} pi=${String(sdk.piAutomatic)}`);
    if (!lastBuild.ok || !lastBuild.changed) {
      report.loopStop = nextStep(cls, cycles.length, MAX_CYCLES, lastBuild);
      break;
    }
  }
  phases.attempts = attempts;
  phases.buildCycles = cycles;
  void knownDeploymentId;

  // ---------------------------------------------------------------- final gates: final validated outcome + run-wide invariants
  const ghAfter = await gh(`/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${REF}`);
  phases.githubAfter = { via: ghAfter.via, status: ghAfter.status, requestId: ghAfter.requestId, sha: ghAfter.body.sha, rateLimitRemaining: ghAfter.rateRemaining };
  const prefixesOk = historyMarks.every((m, i) => i === 0 || (m.length > historyMarks[i - 1]!.length && prefixHash(historyMarks[i - 1]!.length) === historyMarks[i - 1]!.prefixSha256));
  const invariants: Record<string, boolean> = {
    sameSessionAndProcess: constructions === 1 && sessionRef === session && session.sessionId === piSessionId && process.pid === state.pid,
    messageHistoryGrewWithExactPrefixes: prefixesOk,
    everyAttemptTraceDelivered: attempts.every((a) => a.trace.deliveryErrors === 0 && a.trace.chunks > 0),
    buildCycleBudgetRespected: cycles.length <= MAX_CYCLES,
    everyBuildCycleRecorded: cycles.every((c) => c.status !== undefined),
    independentGithubCheck: ghAfter.status === 200 && ghAfter.body.sha === truth.sha,
  };
  const finalChecks: Record<string, boolean> = { ...finalAttemptChecks, finalAttemptRanAfterARealBuild: attempts.length > 1, finalAnswerHasFact: String(attempts[attempts.length - 1]?.answer ?? "").includes(FACT) };
  for (const [k, v] of Object.entries(invariants)) check(`invariant.${k}`, v);
  for (const [k, v] of Object.entries(finalChecks)) check(`final.${k}`, v);
  const taskVerdict = finalVerdict({ finalAttempt: finalClass, invariants, finalChecks });
  const firstAttempt = attempts[0] ?? null;
  const expectedInitialFailure = !!firstAttempt && (firstAttempt.integrationToolErrors as Array<{ message: string }>).some((e) => /404/.test(e.message) && /No commit found for the ref master/.test(e.message));
  const prerequisites = Object.fromEntries(["preflight.orgPinned", "github.masterIs404", "github.refIs200WithFact", "seed.publishedAndProbed", "sdk.seededToolVisible"].map((k) => [k, state.checks[k] === true]));
  const mechanism = mechanismProof({ prerequisites, firstAttempt: firstAttempt ? firstAttempt.classification : null, expectedInitialFailure, cycles: cycleProofs });
  check("final.taskSucceeded", taskVerdict.ok, taskVerdict);
  check("final.requestedMechanismProven", mechanism.ok, mechanism);
  const verdict = { ok: taskVerdict.ok && mechanism.ok, task: taskVerdict, mechanism, expectedInitialFailure, cycleProofs };
  phases.sameSession = { constructions, piSessionId, sessionIdNow: session.sessionId, sameObject: sessionRef === session, pid: process.pid, historyMarks };
  report.verdict = verdict;
  ok = verdict.ok;
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
  for (const other of isolated) {
    try {
      const out = await restoreIntegration({ store: integrations, slug: other, buildId: `iso-${RUN_ID.toLowerCase()}`.slice(0, 60), reason: `restored after fresh E2E run ${RUN_ID}` });
      emit({ agentId: "host", kind: "message", title: `isolation: restored ${other} (${out.state}, listed=${out.listed})`, data: { slug: other, receiptId: out.receiptId } });
      (report.isolation as Array<unknown> | undefined)?.push({ slug: other, restored: out.state === "active", listed: out.listed }) ?? (report.isolation = [{ slug: other, restored: out.state === "active", listed: out.listed }]);
    } catch (error) {
      ioErrors.push(`restore ${other}: ${String((error as Error).message)}`);
      emit({ agentId: "host", kind: "message", title: `isolation: FAILED to restore ${other}: ${scrub(String((error as Error).message)).slice(0, 200)}`, status: "failed" });
    }
  }
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
// Unique per-run reports + a "latest" canonical alias. The previous canonical alias (the post-run verification
// correction of run e2e-20261017T232926-fe8d) is archived byte-exact first; nothing else is overwritten.
const runBase = `reports/real-integration-e2e-${RUN_ID}`;
state.reportPath = `${runBase}.json`;
const lastCycle = (phases.buildCycles as Array<Record<string, any>> | undefined)?.at(-1);
emit({ agentId: "host", kind: "run_end", title: (ok ? "ALL FINAL GATES PASSED (task + requested mechanism)" : `FINAL GATES FAILED: ${[...(((report.verdict as any)?.task?.failing as string[] | undefined) ?? []), ...(((report.verdict as any)?.mechanism?.failing as string[] | undefined) ?? [])].join(", ") || String((report.loopStop as any)?.reason ?? report.error ?? "aborted")}`).slice(0, 290), status: ok ? "succeeded" : "failed", data: { verdict: report.verdict ?? null, loopStop: report.loopStop ?? null, attempts: (phases.attempts as unknown[] | undefined)?.length ?? 0, buildCycles: (phases.buildCycles as unknown[] | undefined)?.length ?? 0, report: `${runBase}.json`, markdown: `${runBase}.md`, html: `${runBase}.html`, mcpUrl: lastCycle?.deployment?.mcpUrl ?? (phases.seed as { manufact?: { mcpUrl?: string } } | undefined)?.manufact?.mcpUrl ?? null } });
report.events = allEvents;
await writeChain;
await writeState();
await stateChain;
report.ioErrors = ioErrors;
const out = scrub(JSON.stringify(report, null, 2));
if (SECRETS.some((s) => out.includes(s)) || /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(out)) throw new Error("report still contains a credential; refusing to write");
await fs.mkdir("reports", { recursive: true });
const { renderMarkdown, renderHtml } = await import("./real-integration-e2e-render.js");
const md = scrub(renderMarkdown(JSON.parse(out)));
const html = scrub(renderHtml(JSON.parse(out)));
await fs.writeFile(`${runBase}.json`, `${out}\n`);
await fs.writeFile(`${runBase}.md`, md);
await fs.writeFile(`${runBase}.html`, html);
const CANON = "reports/real-integration-e2e";
const OLD_CORRECTION = "reports/real-integration-e2e-corrected-oldrun-e2e-20261017T232926-fe8d";
if (existsSync(`${CANON}.json`)) {
  const cur = JSON.parse(await fs.readFile(`${CANON}.json`, "utf8")) as { kind?: string; correction?: unknown };
  if (cur.correction && !existsSync(`${OLD_CORRECTION}.json`)) {
    for (const ext of ["json", "md", "html"]) {
      if (!existsSync(`${CANON}.${ext}`)) continue;
      const bytes = await fs.readFile(`${CANON}.${ext}`);
      await fs.writeFile(`${OLD_CORRECTION}.${ext}`, bytes);
      if (sha256(await fs.readFile(`${OLD_CORRECTION}.${ext}`)) !== sha256(bytes)) throw new Error(`archive of ${CANON}.${ext} is not byte-exact`);
    }
  } else if (cur.correction && existsSync(`${OLD_CORRECTION}.json`) && sha256(await fs.readFile(`${OLD_CORRECTION}.json`)) !== sha256(await fs.readFile(`${CANON}.json`))) {
    throw new Error("canonical alias is an unarchived correction that differs from the archived one; refusing to overwrite");
  }
}
await fs.writeFile(`${CANON}.json`, `${out}\n`);
await fs.writeFile(`${CANON}.md`, md);
await fs.writeFile(`${CANON}.html`, html);
await progress(`DONE ok=${ok} report ${runBase}.json (latest alias ${CANON}.json)`);
if (ok) await fs.writeFile(READY, `Real integration E2E (fresh, feedback loop) PASSED ${new Date().toISOString()} run ${RUN_ID}\n${runBase}.{json,md,html} (latest alias ${CANON}.*)\nattempts: ${(phases.attempts as unknown[]).length}, build cycles: ${(phases.buildCycles as unknown[]).length}\ntask + requested-mechanism gates passed (${Object.keys(state.checks).filter((k) => k.startsWith("final.") || k.startsWith("invariant.")).length} final/invariant checks)\n`);
process.exitCode = ok ? 0 : 1;
