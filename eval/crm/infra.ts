/**
 * CRM benchmark infrastructure:
 *  - process-only secrets (never printed) + scrubbing
 *  - live UI log (.context/crm-live/real-demo-events.jsonl + real-demo-state.json, GitHub-demo contract)
 *  - two explicit usage meters (customer Pi calls, builder calls) with hard ceilings
 *  - LOCAL TEST PUBLISHER: staged host-authored adapter children on loopback with per-session Ed25519 child auth
 *  - local procmem parent (same app code) whose catalog is bound to the authenticated static-key SUBJECT
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, type App } from "../../src/app.js";
import { generateStaticKey } from "../../src/auth/index.js";
import { childAudience, childAuthEnv, createIntegrationCatalog, generateChildAuthKeys, loadChildAuthFromEnv, mintChildToken, type ChildAuthKeys } from "../../src/integrations/index.js";
import { childTemplateFiles, overlayFiles } from "../../src/integrations/template.js";
import type { IntegrationCatalogPort } from "../../src/server.js";
import type { ObjectStore } from "../../src/store/objects.js";
import { VENDOR_LABEL, VENDOR_SLUG, type Vendor } from "./scenarios.js";

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------------ secrets
export async function loadEnvFile(file: string): Promise<void> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
const secretValues = new Set<string>();
export function registerSecret(v: string | undefined | null) {
  if (v && v.length >= 10) secretValues.add(v);
}
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
export function scrub(s: string): string {
  let out = s;
  for (const sec of secretValues) out = out.split(sec).join("[REDACTED]");
  return out.replace(JWT_RE, "[REDACTED_JWT]").replace(/pmk_[A-Za-z0-9_-]{16,}/g, "pmk_[REDACTED]").replace(/fw_[A-Za-z0-9]{16,}/g, "[REDACTED]").replace(/"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/g, '"d":"[REDACTED]"');
}
export function assertNoSecrets(text: string, what: string) {
  for (const sec of secretValues) if (text.includes(sec)) throw new Error(`${what} still contains a credential; refusing to write`);
  if (JWT_RE.test(text)) throw new Error(`${what} contains a JWT; refusing to write`);
}

// ------------------------------------------------------------------ live UI log
export type Status = "pending" | "running" | "waiting" | "succeeded" | "failed" | "partial" | "interrupted" | "unknown";
export interface AgentRow {
  id: string;
  parentId: string | null;
  name: string;
  role: "customer" | "build" | "operator";
  status: Status;
  model?: string;
  task?: { attempt: number; status: Status; startedAt?: string; finishedAt?: string };
}
export class LiveLog {
  readonly events: string;
  readonly stateFile: string;
  readonly state: Record<string, unknown> & { agents: AgentRow[] };
  #seq = 0;
  #chain: Promise<unknown> = Promise.resolve();
  #stateChain: Promise<unknown> = Promise.resolve();
  #stateSeq = 0;
  readonly ioErrors: string[] = [];
  constructor(readonly dir: string, readonly runId: string, title: string) {
    this.events = path.join(dir, "real-demo-events.jsonl");
    this.stateFile = path.join(dir, "real-demo-state.json");
    this.state = { runId, status: "running", phase: "start", title, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pid: process.pid, agents: [{ id: "host", parentId: null, name: "Host orchestrator (CRM bench operator)", role: "operator", status: "running" }], checks: {}, files: [] };
  }
  /** Same runId (batch) continues the existing log/state across phase invocations; anything else is archived. */
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const prev = existsSync(this.stateFile) ? (JSON.parse(await fs.readFile(this.stateFile, "utf8").catch(() => "{}")) as { runId?: string; agents?: AgentRow[]; startedAt?: string }) : {};
    if (prev.runId === this.runId && existsSync(this.events)) {
      const lines = (await fs.readFile(this.events, "utf8")).split("\n").filter(Boolean);
      this.#seq = lines.length + 1000;
      // Rows of earlier/concurrent phase processes stay on disk and are merged at each write (never re-owned here).
      if (prev.startedAt) this.state.startedAt = prev.startedAt;
    } else {
      if (existsSync(this.events)) await fs.rename(this.events, path.join(this.dir, `real-demo-events.archived-${Date.now()}.jsonl`));
      await fs.writeFile(this.events, "");
    }
    await this.writeState();
  }
  /** Agent ids this process created/updated; rows owned by other concurrent phase processes are merged, never dropped. */
  readonly #own = new Set<string>(["host"]);
  writeState(): Promise<unknown> {
    const tmp = `${this.stateFile}.tmp-${process.pid}-${++this.#stateSeq}`;
    this.#stateChain = this.#stateChain.then(async () => {
      try {
        this.state.updatedAt = new Date().toISOString();
        const onDisk = JSON.parse(await fs.readFile(this.stateFile, "utf8").catch(() => "{}")) as { runId?: string; agents?: AgentRow[] };
        const foreign = onDisk.runId === this.runId ? (onDisk.agents ?? []).filter((a) => !this.#own.has(a.id) && !this.state.agents.some((x) => x.id === a.id)) : [];
        const snap = `${scrub(JSON.stringify({ ...this.state, agents: [...this.state.agents, ...foreign] }, null, 1))}\n`;
        await fs.writeFile(tmp, snap);
        await fs.rename(tmp, this.stateFile);
      } catch (e) {
        this.ioErrors.push(`state: ${String(e)}`);
      }
    });
    return this.#stateChain;
  }
  emit(e: { agentId: string; parentId?: string | null; kind: string; title: string; status?: Status; text?: string; data?: unknown; at?: string }) {
    const bound = (v: unknown, max: number) => {
      const t = scrub(typeof v === "string" ? v : JSON.stringify(v) ?? "");
      if (t.length <= max) return typeof v === "string" ? t : JSON.parse(t);
      return typeof v === "string" ? `${t.slice(0, max)}…[truncated ${t.length - max} chars]` : { truncated: true, originalChars: t.length, preview: `${t.slice(0, max)}…` };
    };
    const ev = { id: `${this.runId}-${String(++this.#seq).padStart(6, "0")}`, at: e.at ?? new Date().toISOString(), agentId: e.agentId, parentId: e.parentId ?? null, kind: e.kind, title: scrub(e.title).slice(0, 300), ...(e.status ? { status: e.status } : {}), ...(e.text !== undefined ? { text: bound(e.text, 8000) } : {}), ...(e.data !== undefined ? { data: bound(e.data, 12000) } : {}) };
    const line = `${JSON.stringify(ev)}\n`;
    this.#chain = this.#chain.then(() => fs.appendFile(this.events, line)).catch((err) => this.ioErrors.push(`event: ${String(err)}`));
    return ev;
  }
  setAgent(id: string, patch: Partial<AgentRow>) {
    this.#own.add(id);
    const a = this.state.agents.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
    else this.state.agents.push({ id, parentId: patch.parentId ?? null, name: patch.name ?? id, role: patch.role ?? "build", status: patch.status ?? "pending", ...(patch.model ? { model: patch.model } : {}), ...(patch.task ? { task: patch.task } : {}) });
    void this.writeState();
  }
  async flush() {
    await this.#chain;
    await this.writeState();
    await this.#stateChain;
  }
}

// ------------------------------------------------------------------ usage meters (two explicit budgets)
export class BudgetExceeded extends Error {}
export class UsageMeter {
  input = 0;
  output = 0;
  cacheRead = 0;
  calls = 0;
  costReported = 0;
  callsWithoutCost = 0;
  constructor(readonly name: string, readonly maxInput: number, readonly maxOutput: number) {}
  add(u: { input?: number; output?: number; cacheRead?: number; cost?: number | null }) {
    this.calls += 1;
    this.input += (u.input ?? 0) + (u.cacheRead ?? 0);
    this.cacheRead += u.cacheRead ?? 0;
    this.output += u.output ?? 0;
    if (typeof u.cost === "number" && u.cost > 0) this.costReported += u.cost;
    else this.callsWithoutCost += 1;
  }
  exceeded(): boolean {
    return this.input >= this.maxInput || this.output >= this.maxOutput;
  }
  check() {
    if (this.exceeded()) throw new BudgetExceeded(`${this.name} budget exhausted: input ${this.input}/${this.maxInput}, output ${this.output}/${this.maxOutput}`);
  }
  snapshot() {
    return { name: this.name, ceiling: { input: this.maxInput, output: this.maxOutput }, input: this.input, cacheRead: this.cacheRead, output: this.output, calls: this.calls, providerReportedCostUsd: Math.round(this.costReported * 1e6) / 1e6, callsWithoutProviderCost: this.callsWithoutCost, costNote: "Pi cost fields are Pi catalog price estimates (input/output x listed price), not Fireworks invoices; builder calls carry token usage only (no cost field) — absent cost is UNAVAILABLE, not $0." };
  }
}

// ------------------------------------------------------------------ staged children (local test publisher)
export type OverlayName = Vendor | "docs" | "attio-deficient" | "generic-http";
const staged = new Map<string, Promise<{ dir: string; fingerprint: string; tools: string[] }>>();

/**
 * Stage child template + host-authored overlay once per (root, overlay) and share it read-only between processes.
 * Concurrency-safe: concurrent callers share ONE in-flight promise; the node_modules symlink is created idempotently
 * (EEXIST pointing at the same target is accepted). Fingerprint = sha256 of the staged file tree.
 */
export function stageOverlay(name: OverlayName, root: string): Promise<{ dir: string; fingerprint: string; tools: string[] }> {
  const cacheKey = `${root}\0${name}`;
  let p = staged.get(cacheKey);
  if (!p) {
    p = (async () => {
      const overlay = await overlayFiles(`demo/crm/${name}`);
      const manifest = JSON.parse(overlay.get("integration.json")!) as { slug: string; title: string; description: string; tools: string[] };
      const files = await childTemplateFiles({ slug: manifest.slug, title: manifest.title, description: manifest.description.replace(/[{}"`<>\\]/g, "").slice(0, 200), upstreamName: manifest.title });
      for (const [k, v] of overlay) files.set(k, v);
      const dir = path.join(root, `child-${name}`);
      await fs.mkdir(dir, { recursive: true });
      for (const [k, v] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        await fs.mkdir(path.dirname(path.join(dir, k)), { recursive: true });
        await fs.writeFile(path.join(dir, k), v);
      }
      const link = path.join(dir, "node_modules");
      const target = path.join(REPO, "node_modules");
      try {
        await fs.symlink(target, link);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || (await fs.readlink(link).catch(() => "")) !== target) throw e;
      }
      const fingerprint = sha256([...files].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\0${sha256(v)}`).join("\n"));
      return { dir, fingerprint, tools: manifest.tools };
    })();
    staged.set(cacheKey, p);
    p.catch(() => staged.delete(cacheKey));
  }
  return p;
}

/** Fingerprint of an overlay computed fresh from the templates on disk (NO cache) — used by integrity gates. */
export async function overlayFingerprintFromDisk(name: OverlayName): Promise<string> {
  const overlay = await overlayFiles(`demo/crm/${name}`);
  const manifest = JSON.parse(overlay.get("integration.json")!) as { slug: string; title: string; description: string };
  const files = await childTemplateFiles({ slug: manifest.slug, title: manifest.title, description: manifest.description.replace(/[{}"`<>\\]/g, "").slice(0, 200), upstreamName: manifest.title });
  for (const [k, v] of overlay) files.set(k, v);
  return sha256([...files].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\0${sha256(v)}`).join("\n"));
}

export interface RunningChild {
  slug: string;
  overlay: OverlayName;
  url: string;
  proc: ChildProcess;
  fingerprint: string;
  tools: string[];
  logs: { out: string; err: string };
  stop(): Promise<void>;
}

/** Start one adapter child process on loopback. `env` carries the fixture URL/token (host-only). */
export async function startChild(p: { overlay: OverlayName; slug: string; env: Record<string, string>; auth: { keys: ChildAuthKeys; ns: string }; stageRoot: string }): Promise<RunningChild> {
  const st = await stageOverlay(p.overlay, p.stageRoot);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: os.tmpdir(),
    PORT: "0",
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    ...childAuthEnv(p.auth.keys, p.auth.ns, p.slug),
    ...p.env,
  };
  const proc = spawn(path.join(REPO, "node_modules/.bin/tsx"), [path.join(REPO, "eval/crm/child-main.ts"), st.dir], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = { out: "", err: "" };
  proc.stdout!.on("data", (d) => logs.out.length < 20_000 && (logs.out += d.toString()));
  proc.stderr!.on("data", (d) => logs.err.length < 20_000 && (logs.err += d.toString()));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child ${p.slug} did not listen in 30s: ${scrub(logs.err.slice(-800))}`)), 30_000);
    const onData = () => {
      const m = /CHILD_LISTENING (\{.*\})/.exec(logs.out);
      if (m) {
        clearTimeout(timer);
        const b = JSON.parse(m[1]!) as { port?: number; url?: string };
        resolve(Number(b.port ?? new URL(b.url!).port));
      }
    };
    proc.stdout!.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child ${p.slug} exited ${code}: ${scrub(logs.err.slice(-800))}`));
    });
  });
  return {
    slug: p.slug,
    overlay: p.overlay,
    url: `http://127.0.0.1:${port}/mcp`,
    proc,
    fingerprint: st.fingerprint,
    tools: st.tools,
    logs,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
  };
}

// ------------------------------------------------------------------ fixtures (host process, same code as validation harness)
export interface RunningFixture {
  vendor: Vendor;
  url: string;
  token: string;
  adminToken: string;
  state(): Promise<unknown>;
  close(): Promise<void>;
}
type FixtureModule = { createCrmFixture(o: { vendor: string; seed: string; spec: unknown; token: string; adminToken: string }): { listen(port: number, host?: string): Promise<{ port: number; close(): Promise<void> | void }>; state(): unknown } };
let fixtureMod: FixtureModule | null = null;
export async function startFixture(vendor: Vendor, seed: string, spec: unknown): Promise<RunningFixture> {
  fixtureMod ??= (await import(path.join(REPO, "templates/integration/harness/fixtures/crm/server.mjs"))) as FixtureModule;
  const token = `fx_${randomBytes(18).toString("hex")}`;
  const adminToken = randomBytes(18).toString("hex");
  registerSecret(token);
  registerSecret(adminToken);
  const fx = fixtureMod.createCrmFixture({ vendor, seed, spec, token, adminToken });
  const l = await fx.listen(0, "127.0.0.1");
  return {
    vendor,
    url: `http://127.0.0.1:${l.port}`,
    token,
    adminToken,
    state: async () => JSON.parse(JSON.stringify(fx.state())),
    close: async () => {
      await l.close();
    },
  };
}

export const VENDOR_ENV: Record<Vendor, string> = { hubspot: "HUBSPOT", pipedrive: "PIPEDRIVE", zoho: "ZOHO", attio: "ATTIO" };

// ------------------------------------------------------------------ subject-bound catalog + local parent
export interface CatalogBinding {
  ns: string;
  keys: ChildAuthKeys;
  /** Also list the tenant's durable store catalog (real Manufact children); binding entries win on slug clash. */
  mergeStore?: boolean;
  entries: Array<{ slug: string; title: string; description: string; mcpUrl: string; tools: string[]; commit: string; deploymentId: string; deployedAt: string; audience: string }>;
}

/**
 * Catalog port: lookups are keyed by the VERIFIED static-key subject (host-created per session) AND namespace;
 * a model can never select another cell's catalog. Subjects without a binding fall back to the durable
 * store-backed catalog (real Manufact children of the adaptation tenants).
 */
export class SubjectCatalog implements IntegrationCatalogPort {
  readonly bindings = new Map<string, CatalogBinding>();
  constructor(private readonly store: () => ObjectStore, private readonly storeChildAuth: ChildAuthKeys | null) {}
  async list(ns: string, subject: string) {
    const b = this.bindings.get(subject);
    if (b) {
      if (b.ns !== ns) throw new Error("catalog binding namespace mismatch");
      if (!b.mergeStore) return { integrations: b.entries, childAuthConfigured: true };
      const fromStore = await createIntegrationCatalog({ ns, store: this.store(), childAuth: this.storeChildAuth }).listDeployed();
      return { integrations: [...b.entries, ...fromStore.filter((x) => !b.entries.some((e) => e.slug === x.slug))], childAuthConfigured: true };
    }
    return { integrations: await createIntegrationCatalog({ ns, store: this.store(), childAuth: this.storeChildAuth }).listDeployed(), childAuthConfigured: this.storeChildAuth !== null };
  }
  async accessToken(ns: string, subject: string, slug: string) {
    const b = this.bindings.get(subject);
    if (b) {
      if (b.ns !== ns) throw new Error("catalog binding namespace mismatch");
      const e = b.entries.find((x) => x.slug === slug);
      if (!e && b.mergeStore && this.storeChildAuth) {
        const token = await createIntegrationCatalog({ ns, store: this.store(), childAuth: this.storeChildAuth }).accessToken(slug, { subject });
        return token ? { ok: true as const, token } : { ok: false as const, reason: "not_found" as const };
      }
      if (!e) return { ok: false as const, reason: "not_found" as const };
      const t = mintChildToken(b.keys, { ns, slug, subject, ttlSeconds: 900 });
      return { ok: true as const, token: { slug, mcpUrl: e.mcpUrl, token: t.token, tokenType: "Bearer", expiresAt: t.expiresAt, audience: t.audience } };
    }
    if (!this.storeChildAuth) return { ok: false as const, reason: "child_auth_not_configured" as const };
    const token = await createIntegrationCatalog({ ns, store: this.store(), childAuth: this.storeChildAuth }).accessToken(slug, { subject });
    return token ? { ok: true as const, token } : { ok: false as const, reason: "not_found" as const };
  }
}

export interface SessionKey {
  key: string;
  subject: string;
  ns: string;
}
export interface Parent {
  app: App;
  baseUrl: string;
  catalog: SubjectCatalog;
  store: ObjectStore;
  /** Pre-registered key for (purpose) — keys must exist before the app starts. */
  key(name: string): SessionKey;
  close(): Promise<void>;
}

/**
 * Local procmem parent (same app code as production; directory store under dataDir; Modal customer sandboxes for
 * memory workspaces). keySpecs: name -> {ns, scopes}. Each key has its own subject (static:<hash prefix>).
 */
export type Scope = "memory:read" | "integrations:read" | "traces:write" | "memory:build";
export interface StoredKey extends SessionKey {
  entry: string;
}
/** Generate static keys once per batch (persisted 0600 in the batch dir so later phases reuse the same tenants). */
export function makeKeys(specs: Record<string, { ns: string; scopes: Scope[] }>): Record<string, StoredKey> {
  const out: Record<string, StoredKey> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const k = generateStaticKey(spec.ns, spec.scopes);
    out[name] = { key: k.key, subject: `static:${k.hash.slice(0, 12)}`, ns: spec.ns, entry: k.entry };
  }
  return out;
}

export async function startParent(p: { dataDir: string; keys: Record<string, StoredKey>; dayOffsetMinutes: number; log: (m: string) => void }): Promise<Parent> {
  const keys = new Map<string, SessionKey>();
  const entries: string[] = [];
  for (const [name, k] of Object.entries(p.keys)) {
    registerSecret(k.key);
    keys.set(name, { key: k.key, subject: k.subject, ns: k.ns });
    entries.push(k.entry);
  }
  let storeRef: ObjectStore | null = null;
  const storeChildAuth = loadChildAuthFromEnv();
  const catalog = new SubjectCatalog(() => storeRef!, storeChildAuth);
  const app = await createApp({
    env: {
      PORT: "0",
      HOST: "127.0.0.1",
      AUTH_MODE: "static",
      PROCMEM_STATIC_KEYS: entries.join(","),
      PROCMEM_STORE: "directory",
      PROCMEM_SANDBOX: "modal",
      PROCMEM_DATA_DIR: p.dataDir,
      PROCMEM_DAY_OFFSET_MINUTES: String(p.dayOffsetMinutes),
      MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID,
      MODAL_TOKEN_SECRET: process.env.MODAL_TOKEN_SECRET,
    } as NodeJS.ProcessEnv,
    builder: async () => ({ status: "failed", error: "builds are run by the CRM bench orchestrator, not the HTTP route" }),
    integrationCatalog: catalog,
    log: (m) => p.log(scrub(m)),
  });
  storeRef = app.store;
  const bound = await app.listen(0);
  return {
    app,
    baseUrl: bound.url.replace("localhost", "127.0.0.1"),
    catalog,
    store: app.store,
    key: (name) => {
      const k = keys.get(name);
      if (!k) throw new Error(`no pre-registered key ${name}`);
      return k;
    },
    close: () => app.close(),
  };
}

/** One session's private world: one fixture per visible vendor + one adapter child each + docs child, bound to a subject. */
export interface SessionWorld {
  fixtures: Map<Vendor, RunningFixture>;
  children: RunningChild[];
  keys: ChildAuthKeys;
  initial: Map<Vendor, unknown>;
  fingerprints: Record<string, string>;
  close(): Promise<void>;
}

export async function startSessionWorld(p: {
  parent: Parent;
  subject: string;
  ns: string;
  visible: Vendor[];
  seeds: Record<string, string>;
  specFor: (v: Vendor) => unknown;
  instanceLabel: (v: Vendor) => string;
  docsVendors: Vendor[];
  docsDir: string;
  stageRoot: string;
  adapterOverride?: Partial<Record<Vendor, OverlayName | null>>;
  extraChildren?: Array<{ overlay: OverlayName; slug: string; env: (fx: Map<Vendor, RunningFixture>) => Record<string, string> }>;
  noVendorAdapters?: boolean;
}): Promise<SessionWorld> {
  const keys = generateChildAuthKeys(`crm-bench-${randomBytes(4).toString("hex")}`);
  const fixtures = new Map<Vendor, RunningFixture>();
  const children: RunningChild[] = [];
  const initial = new Map<Vendor, unknown>();
  const close = async () => {
    await Promise.all(children.map((c) => c.stop()));
    await Promise.all([...fixtures.values()].map((f) => f.close()));
    p.parent.catalog.bindings.delete(p.subject);
  };
  try {
    for (const v of p.visible) {
      const fx = await startFixture(v, p.seeds[v]!, p.specFor(v));
      fixtures.set(v, fx);
      initial.set(v, await fx.state());
    }
    const auth = { keys, ns: p.ns };
    const starts: Array<Promise<RunningChild>> = [];
    if (!p.noVendorAdapters)
      for (const v of p.visible) {
        const ov = p.adapterOverride?.[v] === undefined ? v : p.adapterOverride[v];
        if (ov === null) continue;
        const fx = fixtures.get(v)!;
        const E = VENDOR_ENV[v];
        starts.push(startChild({ overlay: ov!, slug: VENDOR_SLUG[v], env: { [`${E}_BASE_URL`]: fx.url, [`${E}_TOKEN`]: fx.token, [`${E}_INSTANCE_LABEL`]: p.instanceLabel(v) }, auth, stageRoot: p.stageRoot }));
      }
    starts.push(startChild({ overlay: "docs", slug: "crm-docs", env: { DOCS_DIR: p.docsDir, DOCS_VENDORS: p.docsVendors.join(",") }, auth, stageRoot: p.stageRoot }));
    for (const x of p.extraChildren ?? []) starts.push(startChild({ overlay: x.overlay, slug: x.slug, env: x.env(fixtures), auth, stageRoot: p.stageRoot }));
    const settled = await Promise.allSettled(starts);
    for (const r of settled) if (r.status === "fulfilled") children.push(r.value);
    const failed = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw new Error(`infra: child launch failed: ${String((failed.reason as Error)?.message ?? failed.reason)}`);
    const fingerprints: Record<string, string> = {};
    for (const c of children) fingerprints[c.slug] = c.fingerprint;
    p.parent.catalog.bindings.set(p.subject, {
      ns: p.ns,
      keys,
      entries: children.map((c) => ({
        slug: c.slug,
        title: c.slug === "crm-docs" ? "CRM API docs" : c.slug === "generic-http" ? "Generic HTTP connections" : VENDOR_LABEL[(Object.entries(VENDOR_SLUG).find(([, s]) => s === c.slug)?.[0] ?? "hubspot") as Vendor],
        description: c.slug === "crm-docs" ? "Pinned official CRM API documentation snapshot (read-only search)." : c.slug === "generic-http" ? "Generic connection-scoped HTTP API tool." : `This organization's ${p.instanceLabel((Object.entries(VENDOR_SLUG).find(([, s]) => s === c.slug)?.[0] ?? "hubspot") as Vendor)}.`,
        mcpUrl: c.url,
        tools: c.tools,
        commit: c.fingerprint.slice(0, 40),
        deploymentId: `local-test-${c.fingerprint.slice(0, 12)}`,
        deployedAt: new Date().toISOString(),
        audience: childAudience(p.ns, c.slug),
      })),
    });
    return { fixtures, children, keys, initial, fingerprints, close };
  } catch (e) {
    await close();
    throw e;
  }
}
