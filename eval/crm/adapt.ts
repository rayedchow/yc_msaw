/**
 * The two same-session adaptation demonstrations (each: ONE Pi session object, attempt 1 -> real builder -> SDK
 * catalog hot swap -> attempt 2 in the same session):
 *   far:  frozen M memory clone + HOST-SEEDED DEFICIENT Attio child (really published on Manufact) -> builder repairs
 *         the Attio MCP + memory; A/B adapters re-validated with host regression suites afterwards.
 *   cold: empty memory + generic connection-scoped HTTP tool + docs only -> builder creates Zoho/Attio MCPs + memory.
 * Upstreams are SYNTHETIC CONTRACT FIXTURES; the ones Manufact children call run in Modal sandboxes behind encrypted
 * tunnels. The builder sees only this tenant's own traces (attempt 1 of this session) + official docs/Exa.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIntegrationToolProviders } from "../../src/harness/index.js";
import { createIntegrationRuntime, generateChildAuthKeys, IntegrationStore, loadChildAuthFromEnv, ManufactApi, ManufactPublisher, resolveManufactCredentials, childAudience, type HostSuite, type IntegrationRuntime } from "../../src/integrations/index.js";
import { overlayFiles } from "../../src/integrations/template.js";
import { MemoryRepo } from "../../src/store/memory.js";
import { runBenchBuild, type BenchBuildResult } from "./build.js";
import { REPO, scrub, sha256, startChild, startFixture, VENDOR_ENV, type LiveLog, type Parent, type RunningChild, type RunningFixture, type StoredKey, type UsageMeter } from "./infra.js";
import { startModalFixture } from "./modal-fixture.js";
import { scoreTask, type FixtureState, type TaskScore } from "./oracle.js";
import { datasetSpec, INSTANCE_LABEL, makeTask, ORGS, SYSTEM_PROMPT, taskPrompt, VENDOR_LABEL, VENDOR_SLUG, type TaskDef, type Vendor } from "./scenarios.js";
import { loadStoredTrace, openCustomerSession, type AttemptLimits, type AttemptResult, type CustomerSession, type StoredTraceSummary } from "./session.js";

export const ORG_SLUG = "org-84350150-jpcs9";

export interface AdaptContext {
  batch: string;
  seedBase: string;
  parent: Parent;
  key: StoredKey;
  apiKey: string;
  customerMeter: UsageMeter;
  builderMeter: UsageMeter;
  live: LiveLog;
  limits: AttemptLimits;
  stageRoot: string;
  docsDir: string;
  frozenM?: { ns: string; revisionId: string; treeSha256: string; unavailable?: string };
  log: (m: string) => void;
  progress: (m: string) => Promise<void>;
  checkpoint: (partial: Record<string, unknown>) => Promise<void>;
}

const RETRY_PROMPT = (task: string) =>
  [
    "Retry the same task now. Since your last attempt the organization's memory and integrations may have been updated: call memory__open_memory again to pin the newest memory revision, read what it says about these CRMs, then use the integration tools as they are now.",
    "Check the current state of each deal before writing (your previous attempt may already have changed some of them).",
    `Task (unchanged):\n${task}`,
  ].join("\n");

const BUILD_NOTE = (vendors: Vendor[]) =>
  [
    "Operator note (CRM benchmark tenant): integration MCP children of this tenant are published to Manufact with integration_publish.",
    `The host deploy environment provides these variables to every child (declare the ones a child needs, names only, in integration.json env): ${vendors.map((v) => `${VENDOR_ENV[v]}_BASE_URL, ${VENDOR_ENV[v]}_TOKEN (secret credential; header scheme per ${VENDOR_LABEL[v]} docs), ${VENDOR_ENV[v]}_INSTANCE_LABEL`).join("; ")}.`,
    'The upstream CRM APIs are synthetic contract fixtures that follow the vendors\' public API docs. For integration.json smoke cases the sealed validator offers host fixture "crm-fixture" with config {"vendor":"<hubspot|pipedrive|zoho|attio>","seed":"<any string>","spec":{"instanceLabel":"Smoke","target":{"name":"Smoke Co","domain":"smoke.example"},"duplicateDomain":"smoke-holdings.example","fillerNames":["A","B","C"],"family":"exec-review"}} and env placeholders {{fixture.url}} / {{fixture.token}}.',
  ].join("\n");

interface Seeded {
  slug: string;
  receipts: Record<string, unknown>;
}

async function seedIntegration(rt: IntegrationRuntime, slug: string, overlay: string, publish: boolean, emit: (title: string, data?: unknown) => void): Promise<Seeded> {
  const receipts: Record<string, unknown> = {};
  const call = async (tool: string, input: Record<string, unknown>) => {
    const r = await rt.invoke(tool, JSON.stringify(input));
    emit(`seed ${slug} ${tool}: ${r.status}`, tool === "integration_write" ? { path: input.path } : { result: r });
    if (r.status !== "succeeded") throw new Error(`seed ${slug} ${tool} failed: ${scrub(JSON.stringify(r.error ?? r)).slice(0, 800)}`);
    receipts[tool] = r.data;
    return r;
  };
  const files = await overlayFiles(`demo/crm/${overlay}`);
  const manifest = JSON.parse(files.get("integration.json")!) as { title: string; description: string; upstream: { name: string } };
  await call("integration_open", { slug, create: { title: manifest.title, description: manifest.description.replace(/[{}"`<>\\]/g, "").slice(0, 200), upstreamName: manifest.upstream.name.replace(/[{}"`<>\\]/g, "").slice(0, 200) } });
  for (const [rel, content] of files) await call("integration_write", { slug, path: rel, content });
  const v = await call("integration_validate", { slug });
  await call("integration_git_commit", { slug, message: `Seed ${slug} (host-authored ${overlay} revision for the CRM benchmark)`, validationReceiptId: (v.data as { receiptId: string }).receiptId });
  await call("integration_promote", { slug });
  if (publish) await call("integration_publish", { slug });
  return { slug, receipts };
}

async function extractArchive(integrations: IntegrationStore, key: string, dir: string): Promise<Map<string, string>> {
  const bytes = await integrations.getBlob(key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}.tgz`, bytes);
  execFileSync("tar", ["-xzf", `${dir}.tgz`, "-C", dir, "--strip-components=1"]);
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
function gitDiff(a: string, b: string, max = 80_000): string {
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "--", a, b], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return "";
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? "");
    return (out.length > max ? `${out.slice(0, max)}\n…[diff truncated]` : out).replaceAll(a, "a").replaceAll(b, "b");
  }
}
async function writeTree(dir: string, files: ReadonlyMap<string, string>) {
  for (const [rel, c] of files) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), c);
  }
}

export interface AdaptResult {
  kind: "far" | "cold";
  labels: Record<string, string>;
  ns: string;
  task: { prompt: string; targets: Vendor[]; org: string };
  memory: { before: string | null; afterAttempt1: string | null; afterBuild: string | null; frozenSource?: unknown; changedFiles: string[]; diff: string };
  seeded: Seeded[];
  sessionProof: { piSessionId: string; conversationId: string; sameObject: boolean; pid: number; prefixAfterAttempt1: { count: number; sha256: string }; samePrefixAfterAttempt2: { count: number; sha256: string }; historyAfterAttempt2: number; schemasBefore: unknown; schemasAfter: unknown; toolsChanged: unknown[]; detectedBy: string; activeToolsBefore: string[]; activeToolsAfter: string[] };
  attempts: Array<{ result: AttemptResult; scoreCumulative: TaskScore; scoreDelta?: TaskScore; storedTrace: StoredTraceSummary | null }>;
  build: BenchBuildResult | null;
  integrations: { before: Record<string, unknown>; after: Record<string, unknown>; sourceDiffs: Record<string, { changed: string[]; diff: string }> };
  regressions: Record<string, unknown>;
  fixtures: Record<string, { where: string; sandboxId?: string }>;
  freshness: { priorTraceKeys: number; clonedTreeSha256?: string | null; frozenTreeSha256?: string | null; cloneMatches?: boolean };
  readiness: { detectedBy: string; readySlugs: string[]; detail: unknown };
  proofGates?: Record<string, { ok: boolean; detail?: unknown }>;
  mechanismSuccess?: boolean;
  taskSuccessAttempt2?: boolean;
  error?: string;
}

const treeOf = (files: ReadonlyMap<string, string>) => sha256([...files].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}\0${sha256(v)}`).join("\n"));

export async function runAdaptation(kind: "far" | "cold", ctx: AdaptContext): Promise<AdaptResult> {
  const ns = ctx.key.ns;
  const store = ctx.parent.store;
  const integrations = new IntegrationStore(store, ns);
  const repo = new MemoryRepo(store, ns);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `crm-adapt-${kind}-`));
  const org = kind === "far" ? ORGS.adFar! : ORGS.adCold!;
  const targets: Vendor[] = kind === "far" ? ["attio"] : ["zoho", "attio"];
  const visible: Vendor[] = kind === "far" ? ["hubspot", "pipedrive", "attio"] : ["zoho", "attio"];
  const task: TaskDef = makeTask(`ad-${kind}`, "exec-review", org, targets, visible, ["hubspot", "pipedrive", "zoho", "attio"], ctx.seedBase);
  const prompt = taskPrompt(task);
  const agentId = `cust-adapt-${kind}`;
  const emit = (title: string, data?: unknown) => ctx.live.emit({ agentId: "host", kind: "message", title: `[adapt-${kind}] ${title}`.slice(0, 280), ...(data !== undefined ? { data } : {}) });
  const res: AdaptResult = {
    kind,
    labels: {
      customer: "REAL: one Pi session object (Fireworks model) for both attempts; tools only via procmem SDK LiveToolRegistry against the local procmem parent",
      upstream: "SYNTHETIC CONTRACT FIXTURES; Manufact-hosted children reach them through Modal encrypted tunnels",
      children: kind === "far" ? "crm-attio: HOST-SEEDED DEFICIENT revision really published on Manufact; crm-hubspot/crm-pipedrive/crm-docs: host-authored, local test publisher (loopback)" : "generic-http + crm-docs: host-authored, local test publisher (loopback); every CRM-specific child is builder-authored and Manufact-published",
      builder: "REAL runMemoryBuild (Kimi root, GLM/MiniMax children, Modal workspaces) + real integration runtime (Modal sandbox, sealed validation, Exa research, Manufact publish); host gives no repaired source",
      joint: "memory AND tools change jointly; not an isolated memory effect (the 36-cell matrix is the memory control)",
    },
    ns,
    task: { prompt, targets, org: org.name },
    memory: { before: null, afterAttempt1: null, afterBuild: null, changedFiles: [], diff: "" },
    seeded: [],
    sessionProof: null as unknown as AdaptResult["sessionProof"],
    attempts: [],
    build: null,
    integrations: { before: {}, after: {}, sourceDiffs: {} },
    regressions: {},
    fixtures: {},
    freshness: { priorTraceKeys: -1 },
    readiness: { detectedBy: "not detected", readySlugs: [], detail: null },
  };
  const fixtures = new Map<Vendor, RunningFixture>();
  const children: RunningChild[] = [];
  let cs: CustomerSession | null = null;
  const storeChildAuth = loadChildAuthFromEnv();
  try {
    if (!storeChildAuth) throw new Error("INTEGRATION_CHILD_SIGNING_JWK missing (persistent child key from .context/manufact.env)");
    const creds = await resolveManufactCredentials({ orgSlug: ORG_SLUG });
    if (!creds) throw new Error("Manufact credentials not configured");
    const api = new ManufactApi(creds);
    const identity = await api.identity();
    if (identity.orgSlug !== ORG_SLUG) throw new Error(`wrong Manufact org ${identity.orgSlug}`);
    emit(`Manufact org ${identity.orgSlug} (${identity.email})`);

    // ---- memory
    const base = await repo.ensureHead();
    if (kind === "far") {
      if (!ctx.frozenM || ctx.frozenM.unavailable) throw new Error(`frozen M memory unavailable: ${ctx.frozenM?.unavailable ?? "missing"}`);
      const src = new MemoryRepo(store, ctx.frozenM.ns);
      const files = await src.files(ctx.frozenM.revisionId);
      const cur = await repo.files(base);
      if ([...files].sort().join() !== [...cur].sort().join()) await repo.publish(base, files, { buildId: `adapt-far-clone-${ctx.batch}`, summary: `Clone of frozen M ${ctx.frozenM.ns}@${ctx.frozenM.revisionId}`, sources: [] });
      res.memory.frozenSource = ctx.frozenM;
    }
    res.memory.before = (await repo.head())?.value.revisionId ?? null;
    // Freshness: the adaptation tenant must hold NO traces before attempt 1 (its builder archive = attempt 1 only).
    res.freshness.priorTraceKeys = (await store.list(ns, "traces/", { limit: 10 })).length;
    if (res.freshness.priorTraceKeys !== 0) throw new Error(`adaptation namespace ${ns} already holds traces; refusing to reuse it (start a new batch)`);
    if (kind === "far") {
      res.freshness.clonedTreeSha256 = treeOf(await repo.files(res.memory.before!));
      res.freshness.frozenTreeSha256 = ctx.frozenM!.treeSha256;
      res.freshness.cloneMatches = res.freshness.clonedTreeSha256 === ctx.frozenM!.treeSha256;
      if (!res.freshness.cloneMatches) throw new Error("cloned M memory tree differs from the frozen M tree");
    }

    // ---- fixtures (Manufact-reachable ones in Modal)
    for (const v of visible) {
      const spec = datasetSpec(org, v, "exec-review");
      const remote = kind === "cold" || v === "attio";
      const fx = remote ? await startModalFixture(v, task.seeds[v]!, spec, `crm-${ctx.batch}-${kind}`) : await startFixture(v, task.seeds[v]!, spec);
      fixtures.set(v, fx);
      res.fixtures[v] = remote ? { where: "modal-tunnel", sandboxId: (fx as { sandboxId?: string }).sandboxId! } : { where: "local" };
    }
    const initial = new Map<Vendor, FixtureState>();
    for (const [v, fx] of fixtures) initial.set(v, (await fx.state()) as FixtureState);

    // ---- publisher + suites (deploy env = fixture endpoints, host-held)
    const deployEnv = (_slug: string) => {
      const env: Record<string, string> = {};
      for (const v of targets) {
        const fx = fixtures.get(v)!;
        env[`${VENDOR_ENV[v]}_BASE_URL`] = fx.url;
        env[`${VENDOR_ENV[v]}_TOKEN`] = fx.token;
        env[`${VENDOR_ENV[v]}_INSTANCE_LABEL`] = INSTANCE_LABEL[v](org);
      }
      return env;
    };
    const publisher = new ManufactPublisher({ api, childAuth: storeChildAuth, serverPrefix: `crmb-${ctx.batch}-${kind}`.slice(0, 40), deployEnv });
    const smoke = (vendor: Vendor, tool: string, args: Record<string, unknown>): HostSuite => ({
      id: `crm-${vendor}-regression`,
      version: "v1",
      kind: "regression",
      description: `Host regression for the ${VENDOR_LABEL[vendor]} adapter (fixture-backed, synthetic contract).`,
      cases: [{ name: `${vendor} metadata call returns 200`, fixture: { name: "crm-fixture", config: { vendor, seed: `reg-${vendor}`, spec: datasetSpec(ORGS.org1!, vendor, "exec-review") } }, env: { [`${VENDOR_ENV[vendor]}_BASE_URL`]: "{{fixture.url}}", [`${VENDOR_ENV[vendor]}_TOKEN`]: "{{fixture.token}}" }, steps: [{ tool, arguments: args, expect: [{ path: "structuredContent.http_status", op: "equals", value: 200 }] }] }],
    });
    const suites = async (slug: string): Promise<HostSuite[]> =>
      slug === "crm-hubspot" ? [smoke("hubspot", "hubspot_request", { method: "GET", path: "/crm/v3/pipelines/deals" })] : slug === "crm-pipedrive" ? [smoke("pipedrive", "pipedrive_request", { method: "GET", path: "/api/v2/pipelines" })] : [];

    // ---- seed (far only)
    if (kind === "far") {
      const setup = createIntegrationRuntime({ ns, store, buildId: `seed-${ctx.batch}-far`.slice(0, 60), suites, publisher, childAuth: storeChildAuth, exa: null });
      try {
        res.seeded.push(await seedIntegration(setup, "crm-attio", "attio-deficient", true, emit));
        res.seeded.push(await seedIntegration(setup, "crm-hubspot", "hubspot", false, emit));
        res.seeded.push(await seedIntegration(setup, "crm-pipedrive", "pipedrive", false, emit));
      } finally {
        await setup.close();
      }
    }
    for (const slug of await integrations.list()) {
      const r = await integrations.get(slug);
      res.integrations.before[slug] = { promoted: r?.promoted?.commit ?? null, archiveKey: r?.promoted?.archiveKey ?? null, active: r?.manufact?.active ?? null, mcpUrl: r?.manufact?.mcpUrl ?? null };
    }
    await ctx.checkpoint({ stage: "seeded", res });

    // ---- local children (subject-bound binding, merged with the store catalog)
    const keys = generateChildAuthKeys(`crm-bench-adapt-${randomBytes(3).toString("hex")}`);
    const auth = { keys, ns };
    if (kind === "far") {
      for (const v of ["hubspot", "pipedrive"] as Vendor[]) {
        const fx = fixtures.get(v)!;
        children.push(await startChild({ overlay: v, slug: VENDOR_SLUG[v], env: { [`${VENDOR_ENV[v]}_BASE_URL`]: fx.url, [`${VENDOR_ENV[v]}_TOKEN`]: fx.token, [`${VENDOR_ENV[v]}_INSTANCE_LABEL`]: INSTANCE_LABEL[v](org) }, auth, stageRoot: ctx.stageRoot }));
      }
    } else {
      const conns = targets.map((v) => ({ name: v, vendor: VENDOR_LABEL[v], label: INSTANCE_LABEL[v](org), baseUrlEnv: `${VENDOR_ENV[v]}_BASE_URL`, tokenEnv: `${VENDOR_ENV[v]}_TOKEN`, authScheme: v === "zoho" ? "zoho-oauthtoken" : "bearer", docs: [] }));
      children.push(await startChild({ overlay: "generic-http", slug: "generic-http", env: { CONNECTIONS_JSON: JSON.stringify(conns), ...deployEnv("generic-http") }, auth, stageRoot: ctx.stageRoot }));
    }
    children.push(await startChild({ overlay: "docs", slug: "crm-docs", env: { DOCS_DIR: ctx.docsDir, DOCS_VENDORS: "hubspot,pipedrive,zoho,attio" }, auth, stageRoot: ctx.stageRoot }));
    ctx.parent.catalog.bindings.set(ctx.key.subject, {
      ns,
      keys,
      mergeStore: true,
      entries: children.map((c) => ({ slug: c.slug, title: c.slug, description: c.slug === "crm-docs" ? "Pinned official CRM API documentation snapshot (read-only search)." : c.slug === "generic-http" ? "Generic connection-scoped HTTP API tool for the organization's API connections." : `This organization's ${INSTANCE_LABEL[(Object.entries(VENDOR_SLUG).find(([, s]) => s === c.slug)![0]) as Vendor](org)}.`, mcpUrl: c.url, tools: c.tools, commit: c.fingerprint.slice(0, 40), deploymentId: `local-test-${c.fingerprint.slice(0, 12)}`, deployedAt: new Date().toISOString(), audience: childAudience(ns, c.slug) })),
    });

    // ---- customer session (ONE Pi object for both attempts)
    const toolsChanged: unknown[] = [];
    const expectTools = ["memory__open_memory", "integration__crm-docs__docs_search", ...(kind === "far" ? ["integration__crm-attio__search_records", "integration__crm-hubspot__hubspot_request", "integration__crm-pipedrive__pipedrive_request"] : ["integration__generic-http__http_request"])];
    cs = await openCustomerSession({
      apiKey: ctx.apiKey,
      model: "kimi",
      parentBaseUrl: ctx.parent.baseUrl,
      credential: ctx.key.key,
      traceBaseUrl: ctx.parent.baseUrl,
      traceToken: ctx.key.key,
      agentId,
      displayName: kind === "far" ? "Adaptation FAR · kimi · M memory + deficient Attio → repair" : "Adaptation COLD · kimi · no CRM MCPs → builder creates Zoho+Attio",
      conversationId: `crmbench:${ctx.batch}:adapt-${kind}`,
      runIdBase: `${ctx.batch}.adapt-${kind}`,
      metadata: { bench: "crm-generalization", batch: ctx.batch, kind: `adapt-${kind}`, targets, label: "real model; synthetic CRM contract fixtures" },
      expectTools,
      pollIntervalMs: 15_000,
      live: ctx.live,
      meter: ctx.customerMeter,
      onToolsChanged: (c) => {
        toolsChanged.push({ at: new Date().toISOString(), ...c });
        ctx.live.emit({ agentId, kind: "sdk_update", title: `SDK tools v${c.version}: +${c.added.length} ~${c.updated.length} -${c.removed.length}`, data: c });
      },
    });
    const sessionRef = cs.session;
    const schemasBefore = cs.toolSchemas();
    const activeBefore = cs.activeTools();
    const score = (finals: Map<Vendor, FixtureState>, initials: Map<Vendor, FixtureState>, text: string) => scoreTask({ family: "exec-review", targets, targetDomain: org.domain, instances: visible.map((v) => ({ vendor: v, initial: initials.get(v)!, final: finals.get(v)! })), finalText: text });
    const readStates = async () => {
      const m = new Map<Vendor, FixtureState>();
      for (const [v, fx] of fixtures) m.set(v, (await fx.state()) as FixtureState);
      return m;
    };

    // attempt 1
    let after1 = new Map<Vendor, FixtureState>();
    const r1 = await cs.attempt(1, prompt, ctx.limits, async (r) => {
      after1 = await readStates();
      const s = score(after1, initial, r.finalText);
      res.attempts.push({ result: r as AttemptResult, scoreCumulative: s, storedTrace: null });
      return { status: s.success ? "succeeded" : s.correct > 0 ? "partial" : "failed", summary: `Host checker: ${s.success ? "task completed exactly" : "task NOT completed"} (eligible=${s.eligible}, correct=${s.correct}, missed=${s.missed}, tag_loss=${s.tagLoss}, unintended_writes=${s.unintendedWrites}, stopped_by=${r.stoppedBy}).`, details: { checker: "host-fixture-oracle", success: s.success, eligible: s.eligible, correct: s.correct, missed: s.missed, tagLoss: s.tagLoss, unintendedWrites: s.unintendedWrites } };
    });
    res.attempts[0]!.result = r1;
    const prefix1 = cs.messagesPrefixHash();
    res.memory.afterAttempt1 = (await repo.head())?.value.revisionId ?? null;
    await new Promise((r) => setTimeout(r, 3000));
    res.attempts[0]!.storedTrace = await loadStoredTrace(store, ns, r1.traceSessionId, { conversationId: `crmbench:${ctx.batch}:adapt-${kind}`, runId: r1.runId, systemPromptMarker: SYSTEM_PROMPT.split("\n")[0]!.slice(0, 80), toolNames: expectTools }).catch((e) => {
      emit(`stored trace read failed: ${String(e)}`);
      return null;
    });
    await ctx.progress(`adapt-${kind} attempt 1: success=${res.attempts[0]!.scoreCumulative.success} correct=${res.attempts[0]!.scoreCumulative.correct}/${res.attempts[0]!.scoreCumulative.eligible} unintended=${res.attempts[0]!.scoreCumulative.unintendedWrites} stopped=${r1.stoppedBy}`);
    await ctx.checkpoint({ stage: "attempt1", res });

    // ---- real builder (this tenant only: its archive holds only this session's attempt-1 trace)
    const memFilesBefore = await repo.files(res.memory.afterAttempt1!);
    res.build = await runBenchBuild({
      store,
      ns,
      label: `adapt-${kind}`,
      apiKey: ctx.apiKey,
      meter: ctx.builderMeter,
      live: ctx.live,
      instructions: BUILD_NOTE(targets),
      toolProviders: async ({ ns: n, buildId }) => createIntegrationToolProviders({ ns: n, store: store as never, buildId, deps: { suites, publisher, childAuth: storeChildAuth }, allowHostDeploy: true, required: true, log: (m) => emit(m.slice(0, 260)) }),
      log: ctx.log,
    });
    res.memory.afterBuild = (await repo.head())?.value.revisionId ?? null;
    const memFilesAfter = res.memory.afterBuild ? await repo.files(res.memory.afterBuild) : new Map<string, string>();
    res.memory.changedFiles = [...new Set([...memFilesBefore.keys(), ...memFilesAfter.keys()])].filter((p) => memFilesBefore.get(p) !== memFilesAfter.get(p)).sort();
    await writeTree(path.join(tmp, "mem-before"), memFilesBefore);
    await writeTree(path.join(tmp, "mem-after"), memFilesAfter);
    res.memory.diff = gitDiff(path.join(tmp, "mem-before"), path.join(tmp, "mem-after"));
    for (const slug of await integrations.list()) {
      const r = await integrations.get(slug);
      res.integrations.after[slug] = { promoted: r?.promoted?.commit ?? null, archiveKey: r?.promoted?.archiveKey ?? null, active: r?.manufact?.active ?? null, mcpUrl: r?.manufact?.mcpUrl ?? null, dashboardUrl: r?.manufact?.dashboardUrl ?? null };
      const before = res.integrations.before[slug] as { archiveKey?: string | null } | undefined;
      const afterKey = r?.promoted?.archiveKey;
      if (afterKey && before?.archiveKey !== afterKey) {
        const a = before?.archiveKey ? await extractArchive(integrations, before.archiveKey, path.join(tmp, `src-${slug}-before`)) : new Map<string, string>();
        const b = await extractArchive(integrations, afterKey, path.join(tmp, `src-${slug}-after`));
        if (!before?.archiveKey) await fs.mkdir(path.join(tmp, `src-${slug}-before`), { recursive: true });
        res.integrations.sourceDiffs[slug] = { changed: [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort(), diff: gitDiff(path.join(tmp, `src-${slug}-before`), path.join(tmp, `src-${slug}-after`)) };
      }
    }
    await ctx.progress(`adapt-${kind} build: ${res.build.status}; memory ${res.memory.afterAttempt1} -> ${res.memory.afterBuild} (${res.memory.changedFiles.length} files); integrations changed: ${Object.keys(res.integrations.sourceDiffs).join(",") || "none"}`);
    await ctx.checkpoint({ stage: "built", res });

    // ---- SDK hot swap in the same session: automatic poll first, forced refresh only as labelled fallback
    // Positive readiness: a target source must be listed by the parent catalog with a live promoted deployment
    // (active, running, probe passed, commit == promoted), be READY in the SDK registry with tools, and (far) carry a
    // NEW deployment id. A removed/errored source is never counted as an update.
    const initialAttioDeployment = (res.integrations.before["crm-attio"] as { active?: { deploymentId?: string } | null } | undefined)?.active?.deploymentId ?? null;
    const readyNow = async () => {
      const snap = cs!.registry.getSnapshot();
      const ready: string[] = [];
      const detail: Record<string, unknown> = {};
      for (const slug of await integrations.list()) {
        if (slug === "crm-hubspot" || slug === "crm-pipedrive") continue;
        const r = await integrations.get(slug);
        const a = r?.manufact?.active;
        const live = !!a && a.status === "running" && a.probe === "passed" && a.commit === r?.promoted?.commit;
        const src = snap.sources.find((x) => x.source === `integration:${slug}`);
        const tools = snap.tools.filter((t) => t.source === `integration:${slug}`).map((t) => t.name);
        const isNew = kind === "far" ? a?.deploymentId !== initialAttioDeployment : true;
        detail[slug] = { live, deploymentId: a?.deploymentId ?? null, sourceState: src?.state ?? null, sourceDeployment: src?.deploymentId ?? null, tools, isNew };
        if (live && isNew && src?.state === "ready" && src.deploymentId === a!.deploymentId && tools.length > 0) ready.push(slug);
      }
      const text = (slug: string) => `${slug} ${JSON.stringify(detail[slug])}`.toLowerCase();
      const ok = kind === "far" ? ready.includes("crm-attio") : ready.some((x) => text(x).includes("zoho")) && ready.some((x) => text(x).includes("attio"));
      return { ok, ready, detail };
    };
    let detectedBy = "not detected";
    let last: Awaited<ReturnType<typeof readyNow>> | null = null;
    for (let i = 0; i < 48 && detectedBy === "not detected"; i++) {
      last = await readyNow();
      if (last.ok) detectedBy = "automatic SDK catalog poll (15s interval)";
      else await new Promise((r) => setTimeout(r, 5000));
    }
    for (let i = 0; i < 12 && detectedBy === "not detected"; i++) {
      await cs.registry.refresh({ force: true });
      last = await readyNow();
      if (last.ok) detectedBy = "FALLBACK: operator-forced registry refresh (automatic poll did not observe readiness within 4 min)";
      else await new Promise((r) => setTimeout(r, 10_000));
    }
    res.readiness = { detectedBy, readySlugs: last?.ready ?? [], detail: last?.detail ?? null };
    cs.applyNow();

    // attempt 2 (same session object)
    const r2 = await cs.attempt(2, RETRY_PROMPT(prompt), ctx.limits, async (r) => {
      const after2 = await readStates();
      const cumulative = score(after2, initial, r.finalText);
      const delta = score(after2, after1, r.finalText);
      res.attempts.push({ result: r as AttemptResult, scoreCumulative: cumulative, scoreDelta: delta, storedTrace: null });
      return { status: cumulative.success ? "succeeded" : cumulative.correct > 0 ? "partial" : "failed", summary: `Host checker (cumulative vs original state): ${cumulative.success ? "task completed exactly" : "task NOT completed"} (eligible=${cumulative.eligible}, correct=${cumulative.correct}, missed=${cumulative.missed}, tag_loss=${cumulative.tagLoss}, unintended_writes=${cumulative.unintendedWrites}, stopped_by=${r.stoppedBy}).` };
    });
    res.attempts[1]!.result = r2;
    await new Promise((r) => setTimeout(r, 3000));
    res.attempts[1]!.storedTrace = await loadStoredTrace(store, ns, r2.traceSessionId, { conversationId: `crmbench:${ctx.batch}:adapt-${kind}`, runId: r2.runId, previousRunId: r1.runId, systemPromptMarker: SYSTEM_PROMPT.split("\n")[0]!.slice(0, 80), toolNames: cs.registry.getTools().filter((t) => res.readiness.readySlugs.some((sl) => t.source === `integration:${sl}`)).map((t) => t.name) }).catch((e) => {
      emit(`stored trace read failed: ${String(e)}`);
      return null;
    });
    res.sessionProof = {
      piSessionId: cs.piSessionId,
      conversationId: cs.conversationId,
      sameObject: sessionRef === cs.session && cs.session.sessionId === cs.piSessionId,
      pid: process.pid,
      prefixAfterAttempt1: prefix1,
      samePrefixAfterAttempt2: cs.messagesPrefixHash(prefix1.count),
      historyAfterAttempt2: cs.messagesPrefixHash().count,
      schemasBefore,
      schemasAfter: cs.toolSchemas(),
      toolsChanged,
      detectedBy,
      activeToolsBefore: activeBefore,
      activeToolsAfter: cs.activeTools(),
    };
    await ctx.progress(`adapt-${kind} attempt 2: cumulative success=${res.attempts[1]!.scoreCumulative.success} correct=${res.attempts[1]!.scoreCumulative.correct}/${res.attempts[1]!.scoreCumulative.eligible} unintended=${res.attempts[1]!.scoreCumulative.unintendedWrites}; delta success=${res.attempts[1]!.scoreDelta?.success}; detectedBy=${detectedBy}`);

    // ---- A/B regressions after the far repair (sealed host suites on the tenant's promoted trees)
    if (kind === "far") {
      const rt = createIntegrationRuntime({ ns, store, buildId: `regress-${ctx.batch}-far`.slice(0, 60), suites, publisher, childAuth: storeChildAuth, exa: null });
      try {
        for (const slug of ["crm-hubspot", "crm-pipedrive"]) {
          await rt.invoke("integration_open", JSON.stringify({ slug }));
          const v = await rt.invoke("integration_validate", JSON.stringify({ slug }));
          const before = res.integrations.before[slug] as { promoted?: string | null } | undefined;
          const after = res.integrations.after[slug] as { promoted?: string | null } | undefined;
          res.regressions[slug] = { promotedUnchanged: before?.promoted === after?.promoted, validation: v };
        }
      } finally {
        await rt.close();
      }
    }
    res.proofGates = computeGates(kind, res);
    res.mechanismSuccess = Object.values(res.proofGates).every((g) => g.ok);
    res.taskSuccessAttempt2 = res.attempts[1]?.scoreCumulative.success === true;
    await ctx.progress(`adapt-${kind} gates: mechanism=${res.mechanismSuccess} task(attempt2,cumulative)=${res.taskSuccessAttempt2}; failed gates: ${Object.entries(res.proofGates).filter(([, g]) => !g.ok).map(([k]) => k).join(",") || "none"}`);
  } catch (e) {
    res.error = scrub(String((e as Error)?.stack ?? e)).slice(0, 4000);
    await ctx.progress(`adapt-${kind} ERROR: ${res.error.slice(0, 300)}`);
  } finally {
    await cs?.dispose().catch(() => undefined);
    ctx.parent.catalog.bindings.delete(ctx.key.subject);
    await Promise.all(children.map((c) => c.stop()));
    await Promise.all([...fixtures.values()].map((f) => f.close()));
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
  return res;
}

export const _internal = { sha256, existsSync, REPO };

/** Explicit, separately reported mechanism gates (task success is reported separately and never implied by them). */
export function computeGates(kind: "far" | "cold", res: AdaptResult): Record<string, { ok: boolean; detail?: unknown }> {
  const g: Record<string, { ok: boolean; detail?: unknown }> = {};
  const a1 = res.attempts[0];
  const a2 = res.attempts[1];
  const traceOk = (t: StoredTraceSummary | null | undefined, r: AttemptResult | undefined) => !!t && !!r && t.correlationCheck.ok && t.sequenceComplete && r.traceDelivery.errors === 0 && t.modelInputHasSystemPrompt;
  g.freshTenantAndClone = { ok: res.freshness.priorTraceKeys === 0 && (kind === "cold" || res.freshness.cloneMatches === true), detail: res.freshness };
  g.attempt1StoredTraceComplete = { ok: traceOk(a1?.storedTrace, a1?.result), detail: a1?.storedTrace?.correlationCheck };
  g.attempt2StoredTraceComplete = { ok: traceOk(a2?.storedTrace, a2?.result), detail: a2?.storedTrace?.correlationCheck };
  g.attempt2TraceSeesNewToolSchemas = { ok: a2?.storedTrace?.modelInputHasToolSchemas === true };
  const sp = res.sessionProof;
  g.sameSessionObjectAndHistoryPrefix = { ok: !!sp && sp.sameObject && sp.samePrefixAfterAttempt2.sha256 === sp.prefixAfterAttempt1.sha256 && sp.historyAfterAttempt2 > sp.prefixAfterAttempt1.count && sp.pid === process.pid };
  const calls = (res.build?.agents ?? []).flatMap((x) => x.toolCallLog);
  const did = (n: string) => calls.some((c) => c.name === n && c.ok);
  g.builderAuthoredValidatedPublished = { ok: ["integration_write", "integration_validate", "integration_git_commit", "integration_promote", "integration_publish"].every(did), detail: ["integration_write", "integration_validate", "integration_git_commit", "integration_promote", "integration_publish"].map((n) => `${n}:${did(n)}`) };
  g.memoryRevisionChanged = { ok: !!res.memory.afterBuild && res.memory.afterBuild !== res.memory.afterAttempt1 && res.memory.changedFiles.length > 0, detail: { from: res.memory.afterAttempt1, to: res.memory.afterBuild, files: res.memory.changedFiles } };
  const changedSlugs = Object.keys(res.integrations.sourceDiffs).filter((sl) => sl !== "crm-hubspot" && sl !== "crm-pipedrive");
  g.deployedPromotedCommitLive = {
    ok: res.readiness.readySlugs.length > 0 && res.readiness.readySlugs.every((sl) => {
      const af = res.integrations.after[sl] as { promoted?: string | null; active?: { commit?: string; probe?: string; status?: string } | null } | undefined;
      return !!af?.active && af.active.commit === af.promoted && af.active.probe === "passed" && af.active.status === "running" && changedSlugs.includes(sl);
    }),
    detail: { ready: res.readiness.readySlugs, changedSlugs },
  };
  g.targetsReadyInSdk = { ok: res.readiness.detectedBy !== "not detected", detail: res.readiness.detectedBy };
  g.readinessByAutomaticPoll = { ok: res.readiness.detectedBy.startsWith("automatic"), detail: res.readiness.detectedBy };
  const a2calls = a2?.storedTrace?.toolCalls ?? [];
  const usedSlugs = res.readiness.readySlugs.filter((sl) => a2calls.some((c) => c.name.startsWith(`integration__${sl}__`) && c.name !== `integration__${sl}__integration_info`));
  g.attempt2CalledNewOrRepairedTargetTools = { ok: res.readiness.readySlugs.length > 0 && usedSlugs.length === res.readiness.readySlugs.length, detail: { used: usedSlugs, genericCalls: a2calls.filter((c) => c.name.startsWith("integration__generic-http__")).length } };
  const newRev = res.memory.afterBuild ?? "";
  g.attempt2ReopenedAndReadNewMemory = { ok: !!newRev && (a2?.storedTrace?.memoryOpenResults ?? []).some((t) => t.includes(newRev)) && (a2?.storedTrace?.memoryPagesRead.length ?? 0) > 0, detail: { newRev, pagesRead: a2?.storedTrace?.memoryPagesRead } };
  if (kind === "far") {
    g.abMetadataSmokeAndUnchangedSource = {
      ok: ["crm-hubspot", "crm-pipedrive"].every((sl) => {
        const r = res.regressions[sl] as { promotedUnchanged?: boolean; validation?: { status?: string; data?: { passed?: boolean } } } | undefined;
        return !!r?.promotedUnchanged && r.validation?.status === "succeeded" && r.validation?.data?.passed === true;
      }),
      detail: "METADATA SMOKE ONLY (GET pipelines -> 200 on fixture) + unchanged promoted A/B source commits; NOT a business-workflow regression suite",
    };
  }
  return g;
}
