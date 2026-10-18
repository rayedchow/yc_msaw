/**
 * CRM generalization benchmark orchestrator (real Fireworks customers + real memory builds over synthetic CRM
 * contract fixtures). Phases persist under .context/crm-batches/<batch>/ so each can run in its own invocation:
 *
 *   npx tsx scripts/crm-run.ts --batch <id> --phase init|train|build|freeze|matrix|report [--concurrency 3]
 *
 * Labels: customers/builders are REAL models; every CRM upstream is a SYNTHETIC CONTRACT FIXTURE; adapter children
 * run on loopback through a LOCAL TEST PUBLISHER (not Manufact). See .context/crm-eval-contract.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { validateFireworksKey } from "../eval/fireworks.js";
import { runAdaptation } from "../eval/crm/adapt.js";
import { runBenchBuild } from "../eval/crm/build.js";
import { overlayFingerprintFromDisk, assertNoSecrets, LiveLog, loadEnvFile, makeKeys, REPO, registerSecret, scrub, sha256, stageOverlay, startParent, startSessionWorld, UsageMeter, type Parent, type Scope, type StoredKey } from "../eval/crm/infra.js";
import { scoreTask, type FixtureState, type TaskScore } from "../eval/crm/oracle.js";
import { loadStoredTrace, openCustomerSession, type AttemptLimits, type AttemptResult, type StoredTraceSummary } from "../eval/crm/session.js";
import { closeoutDealName, datasetSpec, EVAL_TARGETS, matrixCells, seededShuffle, taskPrompt, trainingSessions, VENDOR_SLUG, VENDORS, INSTANCE_LABEL, SYSTEM_PROMPT, type MatrixCell, type ModelAlias, type TaskDef, type Vendor } from "../eval/crm/scenarios.js";
import { MemoryRepo } from "../src/store/memory.js";
import { withFileLock } from "../src/util.js";

const { values } = parseArgs({
  options: {
    batch: { type: "string" },
    round: { type: "string", default: "1" },
    only: { type: "string" },
    phase: { type: "string" },
    concurrency: { type: "string", default: "3" },
  },
});
const BATCH = values.batch ?? "";
if (!/^[a-z0-9][a-z0-9-]{2,30}$/.test(BATCH)) throw new Error("--batch <lowercase id> required");
const PHASE = values.phase ?? "";
const BDIR = path.join(REPO, ".context/crm-batches", BATCH);
const DATA_DIR = path.join(BDIR, "data");
const RESULTS = path.join(BDIR, "results");
const DOCS_DIR = path.join(REPO, "eval/crm/docs");
const STAGE_ROOT = path.join(BDIR, "stage");
const DAY_OFFSET = -420;

export const LIMITS = {
  train: { maxTurns: 16, maxToolCalls: 40, timeoutMs: 300_000 } satisfies AttemptLimits,
  matrix: { maxTurns: 18, maxToolCalls: 48, timeoutMs: 240_000 } satisfies AttemptLimits,
  adapt: { maxTurns: 24, maxToolCalls: 70, timeoutMs: 420_000 } satisfies AttemptLimits,
};
export const BUDGETS = { customer: { input: 20_000_000, output: 1_000_000 }, builder: { input: 30_000_000, output: 1_500_000 } }; // DEVIATION (declared 2026-10-18T00:50Z after round-1 builds failed on budget): builder ceiling raised from 20M/1M

await loadEnvFile(path.join(REPO, ".env"));
await loadEnvFile(path.join(REPO, ".context/manufact.env"));
const FIREWORKS = process.env.FIREWORKS_API_KEY ?? "";
for (const k of ["FIREWORKS_API_KEY", "MCP_USE_API_KEY", "EXA_API_KEY", "INTEGRATION_CHILD_SIGNING_JWK", "MODAL_TOKEN_SECRET"]) registerSecret(process.env[k]);
if (!FIREWORKS) throw new Error("FIREWORKS_API_KEY missing from .env");

// ------------------------------------------------------------------ batch state
interface BatchState {
  batchId: string;
  createdAt: string;
  head: string;
  seedBase: string;
  namespaces: Record<string, string>;
  keys: Record<string, StoredKey>;
  frozen?: Record<string, { ns: string; revisionId: string; treeSha256: string; files: number; sourceNs?: string; sourceRevision?: string; unavailable?: string; buildStatus?: string; note?: string }>;
  meters?: Record<string, { input: number; output: number; cacheRead: number; calls: number; costReported: number; callsWithoutCost: number }>;
}
const statePath = path.join(BDIR, "batch.json");
async function loadState(): Promise<BatchState> {
  return JSON.parse(await fs.readFile(statePath, "utf8")) as BatchState;
}
let tmpSeq = 0;
async function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}
/** Serialized (in-process chain + cross-process file lock), atomic unique-temp+rename update of batch.json. */
let stateChain: Promise<unknown> = Promise.resolve();
async function updateState(fn: (s: BatchState) => void): Promise<BatchState> {
  const run = stateChain.then(() =>
    withFileLock(`${statePath}.lock`, async () => {
      const cur = await loadState();
      fn(cur);
      await atomicWrite(statePath, JSON.stringify(cur, null, 1));
      return cur;
    }),
  );
  stateChain = run.catch(() => undefined);
  return run;
}
async function saveState(s: BatchState) {
  await atomicWrite(statePath, JSON.stringify(s, null, 1));
}
function nsFor(b: string) {
  return {
    trainMem: `crmmem-train-${b}`,
    trainH: `crmtr-h-${b}`,
    trainM: `crmtr-m-${b}`,
    memCold: `crmmem-cold-${b}`,
    memH: `crmmem-h-${b}`,
    memM: `crmmem-m-${b}`,
    evalTraces: `crmev-${b}`,
    adaptFar: `crmad-far-${b}`,
    adaptCold: `crmad-cold-${b}`,
  };
}

const live = new LiveLog(path.join(REPO, ".context/crm-live"), BATCH, `CRM generalization benchmark ${BATCH}`);
const log = (m: string) => process.stderr.write(`[crm ${new Date().toISOString().slice(11, 19)}] ${scrub(m)}\n`);
const progressPath = path.join(REPO, ".context/crm-eval-progress.md");
async function progress(line: string) {
  // appendFile (O_APPEND): concurrent phase processes never drop each other's lines.
  await fs.appendFile(progressPath, `- ${new Date().toISOString()} [${BATCH}] ${scrub(line)}\n`);
}

/**
 * Usage is persisted per (phase, meter) in its own file (meters/<phase>-<name>.json, atomic writes) so concurrent
 * phase processes never clobber each other; a phase's meter starts from the SUM of all persisted phase files of the
 * same meter, so ceilings are batch-wide (concurrent processes see each other's usage at their next start).
 */
const METER_DIR = path.join(BDIR, "meters");
const METER_FIELDS = ["input", "output", "cacheRead", "calls", "costReported", "callsWithoutCost"] as const;
type MeterRec = Record<(typeof METER_FIELDS)[number], number>;
const meterBaselines = new Map<UsageMeter, Partial<MeterRec>>();
async function meterFrom(_st: BatchState, name: "customer" | "builder", phaseKey = Number(values.round) > 1 ? `${PHASE}.r${values.round}` : PHASE): Promise<UsageMeter> {
  const m = new UsageMeter(name, BUDGETS[name].input, BUDGETS[name].output);
  const mm = m as unknown as MeterRec;
  await fs.mkdir(METER_DIR, { recursive: true });
  const own = `${phaseKey}-${name}.json`;
  const baseline: Partial<MeterRec> = {};
  for (const f of await fs.readdir(METER_DIR)) {
    if (!f.endsWith(`-${name}.json`) || f.includes(".tmp-")) continue;
    const v = JSON.parse(await fs.readFile(path.join(METER_DIR, f), "utf8")) as Partial<MeterRec>;
    for (const k of METER_FIELDS) mm[k] += v[k] ?? 0;
    if (f !== own) for (const k of METER_FIELDS) baseline[k] = (baseline[k] ?? 0) + (v[k] ?? 0);
  }
  meterBaselines.set(m, baseline);
  (m as unknown as { phaseKey: string }).phaseKey = phaseKey;
  return m;
}
let meterChain: Promise<unknown> = Promise.resolve();
async function saveMeters(_st: BatchState, meters: UsageMeter[]) {
  meterChain = meterChain
    .then(async () => {
      for (const m of meters) {
        const base = meterBaselines.get(m) ?? {};
        const own: Partial<MeterRec> = {};
        for (const k of METER_FIELDS) own[k] = (m as unknown as MeterRec)[k] - (base[k] ?? 0);
        await atomicWrite(path.join(METER_DIR, `${(m as unknown as { phaseKey: string }).phaseKey}-${m.name}.json`), JSON.stringify(own));
      }
    })
    .catch((e) => {
      // Fail closed: no further paid call may start after a failed budget checkpoint.
      meterFailure = `budget checkpoint persistence failed: ${String((e as Error)?.message ?? e)}`;
      log(meterFailure);
    });
  await meterChain;
  if (meterFailure) throw new Error(meterFailure);
}
let meterFailure: string | null = null;
function paidCallBlocked(meters: UsageMeter[]): string | null {
  if (meterFailure) return meterFailure;
  for (const m of meters) if (m.exceeded()) return `${m.name} budget exhausted`;
  return null;
}

/** Provider auth/config failure in EITHER the infra path or the Pi attempt error path => stop the batch. */
function authFailure(rec: { infraError?: string; attempt?: { error?: string } | null }): string | null {
  for (const t of [rec.infraError, rec.attempt?.error]) if (t && /\b(401|403)\b|unauthori[sz]ed|invalid api key|authentication|api key/i.test(t)) return t.slice(0, 300);
  return null;
}

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<unknown>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  }));
}

async function writeJson(file: string, value: unknown) {
  const text = scrub(JSON.stringify(value, null, 1));
  assertNoSecrets(text, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${text}\n`);
}

// ------------------------------------------------------------------ one customer session over one task
interface SessionRecord {
  kind: "train" | "matrix";
  id: string;
  model: ModelAlias;
  condition: string;
  target: string;
  task: { id: string; family: string; targets: Vendor[]; visible: Vendor[]; org: string; prompt: string };
  memoryNs: string;
  traceNs: string;
  memoryRevision: { before: string | null; after: string | null; treeSha256Before: string | null };
  adapterFingerprints: Record<string, string>;
  toolSchemas: Array<{ name: string; fingerprint: string }>;
  activeTools: string[];
  piSessionId: string;
  conversationId: string;
  attempt: AttemptResult | null;
  score: TaskScore | null;
  storedTrace: StoredTraceSummary | null;
  fixtureStates: Record<string, { initial: FixtureState; final: FixtureState }>;
  infraError?: string;
  /** Set when a frozen control failed; an invalid record never contributes to transfer rates. */
  invalid?: string;
  unavailableArm?: string;
  normalizedToolSchemaSha256?: string;
  startedAt: string;
  finishedAt: string;
}

async function hashTree(rel: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of (await fs.readdir(path.join(REPO, d), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(d, e.name);
      if (e.isDirectory()) await walk(r);
      else out[r] = sha256(await fs.readFile(path.join(REPO, r)));
    }
  };
  await walk(rel);
  return out;
}
const FROZEN_OVERLAYS = ["hubspot", "pipedrive", "zoho", "attio", "docs", "attio-deficient", "generic-http"] as const;
/** Gate: frozen adapters (staged source fingerprints), fixtures, docs and contract spec must equal the init manifest. */
async function verifySourcesAgainstManifest(): Promise<{ ok: boolean; problems: string[] }> {
  const m = JSON.parse(await fs.readFile(path.join(REPO, `reports/crm-matrix-manifest-${BATCH}.json`), "utf8")) as { sources: { adapterFingerprints: Record<string, string>; fixtures: Record<string, string>; docs: Record<string, string>; contracts: string } };
  const problems: string[] = [];
  for (const o of FROZEN_OVERLAYS) {
    const fp = await overlayFingerprintFromDisk(o);
    if (fp !== m.sources.adapterFingerprints[o]) problems.push(`adapter ${o} fingerprint ${fp.slice(0, 12)} != manifest ${String(m.sources.adapterFingerprints[o]).slice(0, 12)}`);
  }
  const cmp = (label: string, a: Record<string, string>, b: Record<string, string>) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) problems.push(`${label} ${k} changed since init`);
  };
  cmp("fixture", await hashTree("templates/integration/harness/fixtures"), m.sources.fixtures);
  cmp("docs", await hashTree("eval/crm/docs"), m.sources.docs);
  if (sha256(await fs.readFile(path.join(REPO, "eval/crm/CONTRACTS.md"))) !== m.sources.contracts) problems.push("CONTRACTS.md changed since init");
  return { ok: problems.length === 0, problems };
}

function expectToolsFor(t: TaskDef): string[] {
  return ["memory__open_memory", ...t.visible.map((v) => `integration__${VENDOR_SLUG[v]}__${v}_request`), "integration__crm-docs__docs_search"];
}

async function treeSha(ns: string, parent: Parent, rev: string | null) {
  if (!rev) return null;
  const files = await new MemoryRepo(parent.store, ns).files(rev);
  return sha256([...files].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\0${sha256(v)}`).join("\n"));
}

async function runTaskSession(p: { parent: Parent; kind: "train" | "matrix"; id: string; model: ModelAlias; condition: string; target: string; task: TaskDef; memKey: StoredKey; traceKey: StoredKey; meter: UsageMeter; limits: AttemptLimits; expectedMemory?: { revisionId: string; treeSha256: string } }): Promise<SessionRecord> {
  const startedAt = new Date().toISOString();
  const prompt = taskPrompt(p.task);
  const rec: SessionRecord = {
    kind: p.kind,
    id: p.id,
    model: p.model,
    condition: p.condition,
    target: p.target,
    task: { id: p.task.id, family: p.task.family, targets: p.task.targets, visible: p.task.visible, org: p.task.org.name, prompt },
    memoryNs: p.memKey.ns,
    traceNs: p.traceKey.ns,
    memoryRevision: { before: null, after: null, treeSha256Before: null },
    adapterFingerprints: {},
    toolSchemas: [],
    activeTools: [],
    piSessionId: "",
    conversationId: `crmbench:${BATCH}:${p.id}`,
    attempt: null,
    score: null,
    storedTrace: null,
    fixtureStates: {},
    startedAt,
    finishedAt: "",
  };
  const repo = new MemoryRepo(p.parent.store, p.memKey.ns);
  rec.memoryRevision.before = (await repo.head())?.value.revisionId ?? null;
  rec.memoryRevision.treeSha256Before = await treeSha(p.memKey.ns, p.parent, rec.memoryRevision.before);
  if (p.expectedMemory && (rec.memoryRevision.before !== p.expectedMemory.revisionId || rec.memoryRevision.treeSha256Before !== p.expectedMemory.treeSha256)) {
    rec.invalid = `frozen memory mismatch BEFORE the paid call: ${rec.memoryRevision.before} tree ${String(rec.memoryRevision.treeSha256Before).slice(0, 12)} != ${p.expectedMemory.revisionId} tree ${p.expectedMemory.treeSha256.slice(0, 12)}`;
    rec.finishedAt = new Date().toISOString();
    return rec;
  }
  let world: Awaited<ReturnType<typeof startSessionWorld>> | null = null;
  let cs: Awaited<ReturnType<typeof openCustomerSession>> | null = null;
  const agentId = `cust-${p.id}`;
  try {
    world = await startSessionWorld({
      parent: p.parent,
      subject: p.memKey.subject,
      ns: p.memKey.ns,
      visible: p.task.visible,
      seeds: p.task.seeds,
      specFor: (v) => datasetSpec(p.task.org, v, p.task.family),
      instanceLabel: (v) => INSTANCE_LABEL[v](p.task.org),
      docsVendors: p.task.docsVendors,
      docsDir: DOCS_DIR,
      stageRoot: STAGE_ROOT,
    });
    rec.adapterFingerprints = world.fingerprints;
    const expectTools = expectToolsFor(p.task);
    cs = await openCustomerSession({
      apiKey: FIREWORKS,
      model: p.model,
      parentBaseUrl: p.parent.baseUrl,
      credential: p.memKey.key,
      traceBaseUrl: p.parent.baseUrl,
      traceToken: p.traceKey.key,
      agentId,
      displayName: p.kind === "train" ? `Train ${p.id} · ${p.model} · ${p.task.family} on ${p.task.targets.join("+")}` : `Cell ${p.target} · ${p.model} · memory ${p.condition} (${p.id})`,
      conversationId: rec.conversationId,
      runIdBase: `${BATCH}.${p.id}`,
      metadata: { bench: "crm-generalization", batch: BATCH, kind: p.kind, cell: p.id, model: p.model, condition: p.condition, target: p.target, targets: p.task.targets, family: p.task.family, label: "real model; synthetic CRM contract fixtures; local test publisher" },
      expectTools,
      pollIntervalMs: 30_000,
      live,
      meter: p.meter,
    });
    rec.piSessionId = cs.piSessionId;
    rec.toolSchemas = cs.toolSchemas();
    rec.normalizedToolSchemaSha256 = cs.normalizedToolSchemaSha256();
    rec.activeTools = cs.activeTools();
    const w = world;
    rec.attempt = await cs.attempt(1, prompt, p.limits, async (r) => {
      for (const v of p.task.visible) rec.fixtureStates[v] = { initial: w.initial.get(v) as FixtureState, final: (await w.fixtures.get(v)!.state()) as FixtureState };
      rec.score = scoreTask({ family: p.task.family, targets: p.task.targets, ...(p.task.family === "won-closeout" ? { closeoutDealName: closeoutDealName(p.task.org) } : {}), targetDomain: p.task.org.domain, instances: p.task.visible.map((v) => ({ vendor: v, ...rec.fixtureStates[v]! })), finalText: r.finalText });
      const s = rec.score;
      return {
        status: s.success ? "succeeded" : s.correct > 0 ? "partial" : "failed",
        summary: `Host checker: ${s.success ? "task completed exactly" : "task NOT completed"} (eligible=${s.eligible}, correct=${s.correct}, missed=${s.missed}, tag_loss=${s.tagLoss}, unintended_writes=${s.unintendedWrites}, stopped_by=${r.stoppedBy}).`,
        details: { checker: "host-fixture-oracle", success: s.success, eligible: s.eligible, correct: s.correct, missed: s.missed, tagLoss: s.tagLoss, unintendedWrites: s.unintendedWrites },
      };
    });
  } catch (e) {
    rec.infraError = scrub(String((e as Error)?.stack ?? e)).slice(0, 2000);
    live.emit({ agentId: agentId, kind: "message", title: `infra error: ${rec.infraError.slice(0, 200)}`, status: "failed" });
    live.setAgent(agentId, { name: `${p.id} (infra error)`, role: "customer", status: "failed" });
  } finally {
    await cs?.dispose().catch(() => undefined);
    await world?.close().catch(() => undefined);
  }
  rec.memoryRevision.after = (await repo.head())?.value.revisionId ?? null;
  if (p.expectedMemory && rec.memoryRevision.after !== p.expectedMemory.revisionId) rec.invalid = `frozen memory head moved during the cell: ${rec.memoryRevision.after} != ${p.expectedMemory.revisionId}`;
  if (rec.attempt) {
    try {
      rec.storedTrace = await loadStoredTrace(p.parent.store, p.traceKey.ns, rec.attempt.traceSessionId, { conversationId: rec.conversationId, runId: rec.attempt.runId, systemPromptMarker: SYSTEM_PROMPT.split("\n")[0]!.slice(0, 80), toolNames: expectToolsFor(p.task) });
    } catch (e) {
      rec.infraError = `${rec.infraError ?? ""} stored trace: ${String((e as Error).message)}`.trim();
    }
  }
  live.setAgent(agentId, { status: rec.infraError && !rec.attempt ? "failed" : rec.score?.success ? "succeeded" : rec.score && rec.score.correct > 0 ? "partial" : "failed" });
  rec.finishedAt = new Date().toISOString();
  return rec;
}

// ------------------------------------------------------------------ phases
async function phaseInit() {
  if (existsSync(statePath)) throw new Error(`batch ${BATCH} already initialized`);
  await fs.mkdir(BDIR, { recursive: true, mode: 0o700 });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  const ns = nsFor(BATCH);
  const seedBase = `crm-${BATCH}`;
  const specs: Record<string, { ns: string; scopes: Scope[] }> = {
    traceH: { ns: ns.trainH, scopes: ["traces:write"] },
    traceM: { ns: ns.trainM, scopes: ["traces:write"] },
    traceEval: { ns: ns.evalTraces, scopes: ["traces:write"] },
  };
  for (const t of trainingSessions(seedBase)) specs[`mem-${t.task.id}`] = { ns: ns.trainMem, scopes: ["memory:read", "integrations:read"] };
  for (const c of matrixCells(seedBase)) specs[`mem-${c.cellId}`] = { ns: c.condition === "cold" ? ns.memCold : c.condition === "H" ? ns.memH : ns.memM, scopes: ["memory:read", "integrations:read"] };
  specs.adaptFar = { ns: ns.adaptFar, scopes: ["memory:read", "integrations:read", "traces:write"] };
  specs.adaptCold = { ns: ns.adaptCold, scopes: ["memory:read", "integrations:read", "traces:write"] };
  const st: BatchState = { batchId: BATCH, createdAt: new Date().toISOString(), head, seedBase, namespaces: ns, keys: makeKeys(specs) };
  await saveState(st);
  // Preflight: Fireworks key + the three customer models listed (GET /models, unbilled)
  const fk = await validateFireworksKey(FIREWORKS);
  const want = ["accounts/fireworks/models/kimi-k3", "accounts/fireworks/models/glm-5p3", "accounts/fireworks/models/minimax-m3"];
  const missing = want.filter((m) => !fk.modelIds.includes(m));
  // Stage all overlays to fingerprint the frozen adapters before any paid call.
  const fingerprints: Record<string, string> = {};
  for (const o of ["hubspot", "pipedrive", "zoho", "attio", "docs", "attio-deficient", "generic-http"] as const) fingerprints[o] = await overlayFingerprintFromDisk(o);
  const cells = matrixCells(seedBase);
  const manifest = {
    kind: "crm-matrix-manifest",
    batch: BATCH,
    createdAt: st.createdAt,
    head,
    labels: {
      customers: "REAL Fireworks models via Pi 1.3 (catalog transport; MiniMax via Fireworks anthropic-messages endpoint)",
      upstreams: "SYNTHETIC CONTRACT FIXTURES of HubSpot/Pipedrive/Zoho CRM v8/Attio v2 subsets (not vendor accounts)",
      transport: "real MCP protocol; adapters on loopback via LOCAL TEST PUBLISHER (not Manufact)",
      builds: "real runMemoryBuild (Kimi root, GLM/MiniMax children, Modal workspaces), integrations OFF for H/M",
    },
    fireworks: { listed: want.map((m) => ({ model: m, listed: fk.modelIds.includes(m) })) },
    namespaces: ns,
    limits: LIMITS,
    budgets: { ...BUDGETS, note: "two explicit ceilings: customer Pi usage and builder usage are metered separately; exceeding stops new cells/build calls" },
    builderBudget: (await import("../eval/crm/build.js")).BUILDER_BUDGET,
    concurrency: Number(values.concurrency),
    executionOrderSeed: 20261017,
    training: trainingSessions(seedBase).map((t) => ({ id: t.task.id, curriculum: t.curriculum, model: t.model, family: t.task.family, targets: t.task.targets, org: t.task.org.name })),
    matrix: seededShuffle(cells, 20261017).map((c) => ({ cellId: c.cellId, model: c.model, condition: c.condition, target: c.target, role: EVAL_TARGETS[c.target].role, org: c.task.org.name })),
    adaptation: [
      { id: "adapt-far", memory: "frozen M (cloned)", adapter: "HOST-SEEDED DEFICIENT crm-attio", task: "exec-review on Attio", attempts: 2 },
      { id: "adapt-cold", memory: "empty", adapter: "generic-http + docs only", task: "exec-review on Zoho+Attio", attempts: 2 },
    ],
    sources: { adapterFingerprints: fingerprints, fixtures: await hashTree("templates/integration/harness/fixtures"), docs: await hashTree("eval/crm/docs"), runner: await hashTree("eval/crm"), contracts: sha256(await fs.readFile(path.join(REPO, "eval/crm/CONTRACTS.md"))) },
  };
  await writeJson(path.join(REPO, `reports/crm-matrix-manifest-${BATCH}.json`), manifest);
  await progress(`init: head ${head}; manifest reports/crm-matrix-manifest-${BATCH}.json; fireworks missing=[${missing.join(",")}]`);
  if (missing.length) throw new Error(`Fireworks does not list ${missing.join(", ")}; stopping (config failure)`);
}

async function withParent<T>(fn: (parent: Parent, st: BatchState) => Promise<T>): Promise<T> {
  const st = await loadState();
  for (const k of Object.values(st.keys)) registerSecret(k.key);
  await live.init();
  const parent = await startParent({ dataDir: DATA_DIR, keys: st.keys, dayOffsetMinutes: DAY_OFFSET, log });
  try {
    return await fn(parent, st);
  } finally {
    await parent.close().catch(() => undefined);
    live.setAgent("host", { status: "waiting" });
    await live.flush();
  }
}

async function phaseTrain() {
  await withParent(async (parent, st) => {
    const meter = await meterFrom(st, "customer");
    const sessions = trainingSessions(st.seedBase);
    const integrity = await verifySourcesAgainstManifest();
    await writeJson(path.join(RESULTS, `integrity-train-${Date.now()}.json`), integrity);
    if (!integrity.ok) throw new Error(`frozen sources differ from the init manifest; refusing paid training: ${integrity.problems.slice(0, 5).join("; ")}`);
    live.state.phase = "train";
    await progress(`train: ${sessions.length} sessions starting`);
    let stop: string | null = null;
    await pool(sessions, Number(values.concurrency), async (t) => {
      const out = path.join(RESULTS, `train-${t.task.id}.json`);
      if (existsSync(out)) return log(`skip existing ${t.task.id}`);
      if (stop) return log(`batch stopped (${stop}); not starting ${t.task.id}`);
      const blocked = paidCallBlocked([meter]);
      if (blocked) {
        stop = blocked;
        return log(`${blocked}; not starting ${t.task.id}`);
      }
      const rec = await runTaskSession({ parent, kind: "train", id: t.task.id, model: t.model, condition: `train-${t.curriculum}`, target: t.task.targets.join("+"), task: t.task, memKey: st.keys[`mem-${t.task.id}`]!, traceKey: st.keys[t.curriculum === "H" ? "traceH" : "traceM"]!, meter, limits: LIMITS.train });
      await writeJson(out, rec);
      await saveMeters(st, [meter]);
      const af = authFailure(rec);
      if (af) stop = `auth/config failure: ${af}`;
      await progress(`train ${t.task.id} (${t.model}): success=${rec.score?.success} correct=${rec.score?.correct}/${rec.score?.eligible} unintended=${rec.score?.unintendedWrites} stopped=${rec.attempt?.stoppedBy}${rec.infraError ? ` INFRA ${rec.infraError.slice(0, 160)}` : ""}`);
    });
    if (stop) {
      await progress(`train STOPPED: ${stop}`);
      throw new Error(stop);
    }
  });
}

async function phaseBuild() {
  await withParent(async (parent, st) => {
    const meter = await meterFrom(st, "builder");
    live.state.phase = "build";
    const results = await Promise.all(
      (["H", "M"] as const).filter((l) => !values.only || values.only === l).map(async (label) => {
        const ns = label === "H" ? st.namespaces.trainH! : st.namespaces.trainM!;
        const round = Number(values.round);
        const out = path.join(RESULTS, round === 1 ? `build-${label}.json` : `build-${label}.r${round}.json`);
        if (existsSync(out)) return JSON.parse(await fs.readFile(out, "utf8"));
        await progress(`build ${label} starting over ${ns}`);
        // Round 2 = DECLARED DEVIATION: round-1 builds failed under maxSessions 1 / 15 min; round 2 allows 2 sessions per
        // agent and 30 min wall clock (per-session turns/tool calls unchanged), same tenant-only trace cohort.
        const r = await runBenchBuild({ store: parent.store, ns, label: round === 1 ? label : `${label}-r${round}`, apiKey: FIREWORKS, meter, live, log, ...(round >= 2 ? { budget: { maxSessions: 2, maxWallClockMs: 1_800_000 } } : {}) });
        await writeJson(out, r);
        await progress(`build ${label}: ${r.status} ${r.revisionBefore} -> ${r.revisionAfter}; agents=${r.agents.length}; tokens in/out ${r.usage.promptTokens}/${r.usage.completionTokens}; ${Math.round(r.wallMs / 1000)}s`);
        return r;
      }),
    );
    await saveMeters(st, [meter]);
    return results;
  });
}

async function phaseFreeze() {
  await withParent(async (parent, st) => {
    const frozen: NonNullable<BatchState["frozen"]> = {};
    const clone = async (label: string, src: string | null, dst: string) => {
      const dstRepo = new MemoryRepo(parent.store, dst);
      const base = await dstRepo.ensureHead();
      let files: Map<string, string>;
      let srcRev: string | undefined;
      if (src) {
        const srcRepo = new MemoryRepo(parent.store, src);
        srcRev = (await srcRepo.head())?.value.revisionId;
        if (!srcRev) throw new Error(`${label}: source ${src} has no memory head`);
        files = new Map(await srcRepo.files(srcRev));
        const existing = await dstRepo.files(base);
        if ([...files].sort().join() !== [...existing].sort().join()) await dstRepo.publish(base, files, { buildId: `freeze-${label}-${BATCH}`, summary: `Frozen copy of ${src}@${srcRev} for the CRM matrix`, sources: [] });
      }
      const rev = (await dstRepo.head())!.value.revisionId;
      const out = await dstRepo.files(rev);
      frozen[label] = { ns: dst, revisionId: rev, treeSha256: (await treeSha(dst, parent, rev))!, files: out.size, ...(src ? { sourceNs: src, sourceRevision: srcRev! } : {}) };
      if (src) {
        const srcTree = await treeSha(src, parent, srcRev!);
        if (srcTree !== frozen[label]!.treeSha256) throw new Error(`${label}: frozen tree differs from source`);
      }
    };
    await clone("cold", null, st.namespaces.memCold!);
    for (const label of ["H", "M"] as const) {
      // Arm gate: only a completed build whose every receipt is published/no_change becomes a trained arm. A failed
      // or missing build makes the arm UNAVAILABLE (its cells are recorded as unavailable, never run on bootstrap).
      // Latest round wins (all rounds are preserved and reported).
      const bf = [path.join(RESULTS, `build-${label}.r3.json`), path.join(RESULTS, `build-${label}.r2.json`), path.join(RESULTS, `build-${label}.json`)].find((f) => existsSync(f))!;
      const b = existsSync(bf) ? (JSON.parse(await fs.readFile(bf, "utf8")) as { receipts: Array<{ status?: string; sessions?: string[] }>; revisionAfter: string | null; revisionBefore: string | null }) : null;
      const statuses = (b?.receipts ?? []).map((r) => String(r.status));
      const sessions = (b?.receipts ?? []).reduce((a, r) => a + (r.sessions?.length ?? 0), 0);
      const ok = !!b && statuses.length > 0 && statuses.every((x) => x === "published" || x === "no_change") && sessions > 0;
      if (!ok) {
        frozen[label] = { ns: label === "H" ? st.namespaces.memH! : st.namespaces.memM!, revisionId: "", treeSha256: "", files: 0, unavailable: `build ${label} not successful: statuses=[${statuses.join(",")}] sessions=${sessions}` };
        continue;
      }
      await clone(label, label === "H" ? st.namespaces.trainH! : st.namespaces.trainM!, label === "H" ? st.namespaces.memH! : st.namespaces.memM!);
      frozen[label]!.buildStatus = statuses.join(",");
      if (!statuses.includes("published")) frozen[label]!.note = "no_change build: memory tree identical to bootstrap (not learned memory)";
    }
    await updateState((cur) => {
      cur.frozen = frozen;
    });
    await writeJson(path.join(RESULTS, "frozen.json"), frozen);
    await progress(`freeze: ${JSON.stringify(Object.fromEntries(Object.entries(frozen).map(([k, v]) => [k, `${v.revisionId} files=${v.files} tree=${v.treeSha256.slice(0, 12)}`])))}`);
  });
}

async function phaseMatrix() {
  await withParent(async (parent, st) => {
    if (!st.frozen) throw new Error("run --phase freeze first");
    const integrity = await verifySourcesAgainstManifest();
    await writeJson(path.join(RESULTS, `integrity-matrix-${Date.now()}.json`), integrity);
    if (!integrity.ok) throw new Error(`frozen sources differ from the init manifest; refusing paid matrix: ${integrity.problems.slice(0, 5).join("; ")}`);
    const meter = await meterFrom(st, "customer");
    live.state.phase = "matrix";
    const cells = seededShuffle(matrixCells(st.seedBase), 20261017);
    await progress(`matrix: ${cells.length} cells, concurrency ${values.concurrency}`);
    let stop: string | null = null;
    await pool(cells, Number(values.concurrency), async (c: MatrixCell) => {
      const out = path.join(RESULTS, `cell-${c.cellId}.json`);
      if (existsSync(out)) return log(`skip existing ${c.cellId}`);
      if (stop) return;
      const blocked = paidCallBlocked([meter]);
      if (blocked) {
        stop = blocked;
        return;
      }
      const frozen = st.frozen![c.condition]!;
      if (frozen.unavailable) {
        await writeJson(out, { kind: "matrix", id: c.cellId, model: c.model, condition: c.condition, target: c.target, unavailableArm: frozen.unavailable, note: "no paid call: memory arm unavailable" });
        return;
      }
      const rec = await runTaskSession({ parent, kind: "matrix", id: c.cellId, model: c.model, condition: c.condition, target: c.target, task: c.task, memKey: st.keys[`mem-${c.cellId}`]!, traceKey: st.keys.traceEval!, meter, limits: LIMITS.matrix, expectedMemory: { revisionId: frozen.revisionId, treeSha256: frozen.treeSha256 } });
      (rec as SessionRecord & { frozenCheck?: unknown }).frozenCheck = { expectedRevision: frozen.revisionId, before: rec.memoryRevision.before, after: rec.memoryRevision.after, treeMatches: rec.memoryRevision.treeSha256Before === frozen.treeSha256, adapterFingerprints: rec.adapterFingerprints, valid: !rec.invalid };
      await writeJson(out, rec);
      await saveMeters(st, [meter]);
      const af = authFailure(rec);
      if (af) stop = `auth/config failure: ${af}`;
      await progress(`cell ${c.cellId}: success=${rec.score?.success} correct=${rec.score?.correct}/${rec.score?.eligible} unintended=${rec.score?.unintendedWrites} stopped=${rec.attempt?.stoppedBy} tools=${rec.attempt?.toolCalls}${rec.infraError ? ` INFRA ${rec.infraError.slice(0, 160)}` : ""}`);
    });
    if (stop) await progress(`matrix STOPPED: ${stop}`);
    const post = await verifySourcesAgainstManifest();
    await writeJson(path.join(RESULTS, `integrity-matrix-post-${Date.now()}.json`), post);
    if (!post.ok) await progress(`matrix POST integrity FAILED (cells since last check invalid): ${post.problems.slice(0, 5).join("; ")}`);
  });
}

async function phaseAdapt(kind: "far" | "cold") {
  const round = Number(values.round);
  const variant = round > 1 ? `r${round}` : undefined;
  const keyName = kind === "far" ? (variant ? `adaptFar${variant}` : "adaptFar") : variant ? `adaptCold${variant}` : "adaptCold";
  if (variant) {
    // Declared re-run in a FRESH tenant namespace (originals preserved); key registered before the parent starts.
    await updateState((cur) => {
      if (!cur.keys[keyName]) Object.assign(cur.keys, makeKeys({ [keyName]: { ns: `crmad-${kind}-${variant}-${BATCH}`, scopes: ["memory:read", "integrations:read", "traces:write"] } }));
    });
  }
  // DECLARED DEVIATION (see contract): adaptation builds use the round-2 builder budget except the original cold run.
  const buildBudget = kind === "far" || variant ? { maxSessions: 2, maxWallClockMs: 1_800_000 } : undefined;
  await withParent(async (parent, st) => {
    const out = path.join(RESULTS, variant ? `adapt-${kind}.${variant}.json` : `adapt-${kind}.json`);
    if (existsSync(out)) throw new Error(`${out} exists; adaptation demos are never re-run inside a batch`);
    const integrity = await verifySourcesAgainstManifest();
    if (!integrity.ok) throw new Error(`frozen sources differ from the init manifest: ${integrity.problems.slice(0, 5).join("; ")}`);
    if (kind === "far" && (!st.frozen?.M || st.frozen.M.unavailable)) {
      await writeJson(out, { kind, unavailable: `frozen M arm unavailable: ${st.frozen?.M?.unavailable ?? "freeze not run"}` });
      return;
    }
    const customerMeter = await meterFrom(st, "customer");
    const builderMeter = await meterFrom(st, "builder");
    live.state.phase = `adapt-${kind}`;
    await progress(`adapt-${kind} starting`);
    const res = await runAdaptation(kind, {
      batch: BATCH,
      seedBase: st.seedBase,
      parent,
      key: st.keys[keyName]!,
      ...(variant ? { variant } : {}),
      ...(buildBudget ? { buildBudget } : {}),
      apiKey: FIREWORKS,
      customerMeter,
      builderMeter,
      live,
      limits: LIMITS.adapt,
      stageRoot: STAGE_ROOT,
      docsDir: DOCS_DIR,
      ...(st.frozen?.M ? { frozenM: st.frozen.M } : {}),
      log,
      progress,
      checkpoint: async (partial) => {
        await writeJson(path.join(RESULTS, `adapt-${kind}${variant ? `.${variant}` : ""}.partial.json`), partial);
        await saveMeters(st, [customerMeter, builderMeter]);
      },
    });
    await writeJson(out, res);
    await saveMeters(st, [customerMeter, builderMeter]);
    await progress(`adapt-${kind} done${res.error ? ` with ERROR ${res.error.slice(0, 200)}` : ""}`);
  });
}

switch (PHASE) {
  case "adapt-far":
    await phaseAdapt("far");
    break;
  case "adapt-cold":
    await phaseAdapt("cold");
    break;
  case "init":
    await phaseInit();
    break;
  case "train":
    await phaseTrain();
    break;
  case "build":
    await phaseBuild();
    break;
  case "freeze":
    await phaseFreeze();
    break;
  case "matrix":
    await phaseMatrix();
    break;
  default:
    throw new Error(`unknown --phase ${PHASE}`);
}
log(`phase ${PHASE} done`);
process.exit(0);
