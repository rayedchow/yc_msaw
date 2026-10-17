/**
 * OPERATOR IMPORT of an LLM-authored demo integration into the hosted staging demo tenant.
 *
 *   npx tsx scripts/install-demo-integration.ts \
 *       --source-store .data/integration-llm/<runId>/store --source-ns llm-int-tenant --slug notify-hub \
 *       --client-file .context/hosted-demo-client.json --env .context/manufact.env [--resume] [--dry-run]
 *
 * What this is (labels are written into the store marker and the report):
 *  - The integration was authored, validated, committed, promoted and published by the LLM daily
 *    build in scripts/integration-llm-run.ts against a LOCAL DirectoryObjectStore. It did NOT go
 *    through the hosted parent's HTTP API. This script is a trusted operator step (CLI only, never
 *    reachable from model tools or the customer MCP) that copies that exact record, its immutable
 *    receipts and the content-addressed blobs (git bundles + deploy archives) into the hosted
 *    parent's ModalObjectStore under the demo tenant from the client file.
 *  - The record is installed create-once (CAS null) with manufact.active = null, so the catalog
 *    hides it. Activation happens only through the normal ManufactPublisher.publish(): an
 *    authenticated update of the SAME child server rebound to the target tenant audience, with
 *    the host's child signing key (child receives the public JWK only), the normal archive gate
 *    and the normal live probe (unauthenticated + foreign/wrong-audience tokens -> 401).
 *  - The third-party service is SIMULATED (NOTIFY_HUB_SIMULATED=1); no vendor credentials.
 *  - Then the real parent: GET /v1/integrations must list this exact commit, POST
 *    /v1/integrations/:slug/token must mint a token that a fresh MCP client uses for a read-only
 *    list_notifications call. Tokens are never printed or written.
 * Not copied: daily manifests, traces, memory refs or any other ref (they would collide with the
 * tenant's real hosted state). Nothing existing is overwritten; --resume only continues an import
 * this script itself labeled for the identical source commit.
 * Credentials are read from the given FILES only; argv carries paths, never secrets.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  childAudience,
  IntegrationStore,
  loadChildAuthFromEnv,
  ManufactApi,
  ManufactPublisher,
  resolveManufactCredentials,
  verifyChildToken,
  type IntegrationRecord,
  type PublishOutcome,
  type ValidationReceiptBody,
} from "../src/integrations/index.js";
import { assertSlug } from "../src/integrations/paths.js";
import { assertNs, DirectoryObjectStore, MAX_OBJECT_BYTES, type StoredObject } from "../src/store/objects.js";
import { ModalObjectStore } from "../src/store/modal-objects.js";
import { canonicalJson, errorMessage, sha256 } from "../src/util.js";
import { parseHostedClient, Redactor } from "./hosted-e2e-smoke.js";

const PINNED_ORG = "org-84350150-jpcs9";
const DEMO_SLUG = "notify-hub";
const MARKER_KIND = "procmem.operator-import/integration/v1";
/** Env the child server may carry for this fixture (anything else means real vendor config: refuse). */
const ALLOWED_CHILD_ENV = new Set(["CHILD_AUTH_PUBLIC_JWK", "CHILD_AUTH_ISSUER", "CHILD_AUTH_AUDIENCE", "NODE_ENV", "NOTIFY_HUB_SIMULATED"]);
/** Only these keys are taken from the env file (file values win over ambient env). */
const ENV_WHITELIST = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MCP_USE_API_KEY", "MANUFACT_ORG_SLUG", "MANUFACT_ORG_ID", "MCP_USE_CLOUD_API_URL", "MCP_USE_CLOUD_WEB_URL", "INTEGRATION_CHILD_SIGNING_JWK", "INTEGRATION_CHILD_ISSUER"];
const SEED_COUNT = 23;
const BATCH_OBJECTS = 64;
const BATCH_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;
const MCP_TIMEOUT_MS = 60_000;
const CATALOG_WAIT_MS = 90_000;

const { values } = parseArgs({
  options: {
    "source-store": { type: "string" },
    "source-ns": { type: "string" },
    slug: { type: "string" },
    "client-file": { type: "string" },
    env: { type: "string", default: ".context/manufact.env" },
    report: { type: "string", default: "reports/hosted-integration-import.json" },
    resume: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

class ImportFailure extends Error {
  override name = "ImportFailure";
}

const redactor = new Redactor();
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const log = (m: string) => console.error(redactor.text(`[import] ${m}`));
function must(name: string, ok: boolean, detail?: unknown): void {
  const safe = redactor.json(detail);
  checks.push({ name, ok, ...(safe !== undefined ? { detail: safe } : {}) });
  log(`${ok ? "PASS" : "FAIL"} ${name}${safe !== undefined ? ` ${JSON.stringify(safe)}` : ""}`);
  if (!ok) throw new ImportFailure(`${name} failed`);
}
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readEnvFile(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && ENV_WHITELIST.includes(m[1]!)) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

async function httpJson(url: string, method: string, token?: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text.slice(0, 300) };
  }
}

const BLOB_REF_RE = /blobs\/[0-9a-f]{64}/g;
const startedAt = new Date();
const importId = `imp-${startedAt.toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;
const report: Record<string, unknown> = {
  kind: "hosted-integration-import",
  ok: false,
  importId,
  dryRun: values["dry-run"],
  resume: values.resume,
  labels: {
    operation: "OPERATOR IMPORT: trusted operator CLI copied an existing integration into the hosted staging demo tenant; not performed by the model and not via the customer API",
    provenance: "LLM-AUTHORED: code, commits, validation, promotion and the original publish come from the integration-llm-run daily build (local DirectoryObjectStore); preserved unmodified",
    thirdParty: "SIMULATED: Notify Hub runs in-process in the child (NOTIFY_HUB_SIMULATED=1); no vendor credentials",
    activation: "record installed with manufact.active=null; active only via the normal ManufactPublisher.publish + live probe",
  },
  startedAt: startedAt.toISOString(),
  checks,
};
const reportPath = path.resolve(values.report);
let target: ModalObjectStore | null = null;

async function main(): Promise<void> {
  // ------------------------------------------------------------ inputs
  for (const k of ["source-store", "source-ns", "slug", "client-file"] as const) if (!values[k]) throw new ImportFailure(`--${k} is required`);
  const sourceNs = values["source-ns"]!;
  const slug = assertSlug(values.slug!);
  assertNs(sourceNs);
  must("slug is the known simulated demo fixture", slug === DEMO_SLUG, { slug });
  const sourceRoot = path.resolve(values["source-store"]!);
  must("source store directory exists", (await fs.stat(path.join(sourceRoot, sourceNs)).catch(() => null))?.isDirectory() === true, { sourceStore: path.relative(process.cwd(), sourceRoot), sourceNs });

  const client = parseHostedClient(JSON.parse(await fs.readFile(values["client-file"]!, "utf8")));
  for (const [k, v] of Object.entries(client.keys)) redactor.add(v, `${k}-key`);
  redactor.add(client.tenantNs, "tenant");
  const env = await readEnvFile(values.env);
  for (const [k, v] of Object.entries(env)) if (/KEY|TOKEN|SECRET|JWK/.test(k)) redactor.add(v, k.toLowerCase());
  if (env.INTEGRATION_CHILD_SIGNING_JWK) {
    const d = (JSON.parse(env.INTEGRATION_CHILD_SIGNING_JWK) as { d?: string }).d;
    if (d) redactor.add(d, "jwk-d");
  }
  must("env file pins the demo Manufact org", (env.MANUFACT_ORG_SLUG ?? PINNED_ORG) === PINNED_ORG, { orgSlug: env.MANUFACT_ORG_SLUG ?? null, pinned: PINNED_ORG });
  const targetNs = client.tenantNs;
  must("source and target namespaces differ", targetNs !== sourceNs);

  // ------------------------------------------------------------ source: exact LLM record, receipts, blobs
  const source = new DirectoryObjectStore(sourceRoot);
  const srcInt = new IntegrationStore(source, sourceNs);
  const ref = await source.getRef(sourceNs, `integrations/${slug}`);
  const rec = (ref?.value ?? null) as IntegrationRecord | null;
  must("source integration record exists", !!rec);
  const promoted = rec!.promoted;
  const m = rec!.manufact;
  const active = m?.active ?? null;
  must("source record is promoted", !!promoted);
  must("source record is on the pinned Manufact org", m?.orgSlug === PINNED_ORG, { orgSlug: m?.orgSlug ?? null });
  must("source active deployment passed its live probe", active?.probe === "passed", { active });
  must("source promoted commit is the active commit", active!.commit === promoted!.commit && active!.archiveSha256 === promoted!.archiveSha256 && active!.validationReceiptId === promoted!.validationReceiptId, { promoted: promoted!.commit, active: active!.commit });
  must("source child env is fixture-only", m!.envNames.every((n) => ALLOWED_CHILD_ENV.has(n)), { envNames: m!.envNames });
  const validation = (await srcInt.getReceipt(slug, promoted!.validationReceiptId)) as unknown as ValidationReceiptBody | null;
  must("source validation receipt passed and matches promotion", validation?.kind === "integration_validation" && validation.passed && validation.tree === promoted!.tree && validation.sourceSha256 === promoted!.sourceSha256, { validationReceiptId: promoted!.validationReceiptId });
  const manifestTools = [...(validation!.manifest?.tools ?? [])].sort();
  must("validated manifest exposes list_notifications", manifestTools.includes("list_notifications"), { tools: manifestTools });
  const recordSha256 = sha256(canonicalJson(rec));

  const prefix = `integrations/${slug}/`;
  const intKeys: string[] = [];
  for (let after: string | undefined; ; ) {
    const page = await source.list(sourceNs, prefix, after === undefined ? {} : { after });
    intKeys.push(...page);
    if (page.length < 10_000) break;
    after = page.at(-1);
  }
  const intObjects = await source.get(sourceNs, intKeys);
  must("source integration objects readable", intObjects.size === intKeys.length && intObjects.has(`${prefix}created.json`), { objects: intKeys.length });
  for (const h of m!.history) must(`source publish receipt ${h.receiptId} present`, !h.receiptId || intObjects.has(`${prefix}receipts/${h.receiptId}.json`));

  const required = new Set<string>([promoted!.archiveKey, ...rec!.promotedHistory.map((p) => p.archiveKey), ...m!.history.map((h) => `blobs/${h.archiveSha256}`), ...(rec!.bundle ? [rec!.bundle.key] : [])]);
  const referenced = new Set<string>([...required, ...(JSON.stringify(rec).match(BLOB_REF_RE) ?? [])]);
  for (const b of intObjects.values()) for (const k of b.toString("utf8").match(BLOB_REF_RE) ?? []) referenced.add(k);
  const blobs = await source.get(sourceNs, [...referenced].sort());
  const absent = [...referenced].filter((k) => !blobs.has(k));
  must("all required bundles/archives present in source", [...required].every((k) => blobs.has(k)), { required: required.size, absentRequired: [...required].filter((k) => !blobs.has(k)) });
  for (const [k, b] of blobs) if (sha256(b) !== k.slice(6)) must(`source blob digest ${k}`, false);
  const archive = blobs.get(promoted!.archiveKey)!;
  must("promoted archive matches its record", sha256(archive) === promoted!.archiveSha256 && archive.length === promoted!.archiveBytes, { archiveSha256: promoted!.archiveSha256, bytes: archive.length });
  if (rec!.bundle) must("latest git bundle matches its record", sha256(blobs.get(rec!.bundle.key)!) === rec!.bundle.sha256, { bundle: rec!.bundle.key });

  const marker = {
    kind: MARKER_KIND,
    label: "OPERATOR IMPORT into the hosted staging demo tenant of an LLM-authored integration; SIMULATED third-party service",
    importId,
    slug,
    sourceNs,
    sourceStore: path.relative(process.cwd(), sourceRoot),
    sourceRefVersion: ref!.version,
    sourceRecordSha256: recordSha256,
    sourceCommit: promoted!.commit,
    sourceValidationReceiptId: promoted!.validationReceiptId,
    sourceActiveDeploymentId: active!.deploymentId,
    sourceManufactServerId: m!.serverId,
    createdByBuild: rec!.createdByBuild,
    importedAt: startedAt.toISOString(),
    tool: "scripts/install-demo-integration.ts",
  };
  const markerKey = `${prefix}operator-import.json`;
  const copy: StoredObject[] = [...[...blobs].map(([key, bytes]) => ({ key, bytes })), ...[...intObjects].map(([key, bytes]) => ({ key, bytes }))];
  const totalBytes = copy.reduce((n, o) => n + o.bytes.length, 0);
  must("copy set is bounded", totalBytes <= MAX_TOTAL_BYTES && copy.every((o) => o.bytes.length <= MAX_OBJECT_BYTES), { objects: copy.length, totalBytes });
  report.source = {
    store: marker.sourceStore,
    ns: sourceNs,
    slug,
    refVersion: ref!.version,
    recordSha256,
    createdByBuild: rec!.createdByBuild,
    commit: promoted!.commit,
    tree: promoted!.tree,
    promotedBuildId: promoted!.buildId,
    validationReceiptId: promoted!.validationReceiptId,
    archiveSha256: promoted!.archiveSha256,
    activeDeployment: { deploymentId: active!.deploymentId, receiptId: active!.receiptId, at: active!.at },
    manufactServer: { serverId: m!.serverId, name: m!.name, mcpUrl: m!.mcpUrl, envNames: m!.envNames },
    history: { promoted: rec!.promotedHistory.length, validations: rec!.validations.length, deployments: m!.history.length },
  };
  report.objects = {
    integrationObjects: intObjects.size,
    blobs: blobs.size,
    totalBytes,
    referencedButAbsentInSource: absent,
    items: copy.map((o) => ({ key: o.key, bytes: o.bytes.length, sha256: sha256(o.bytes) })),
    notCopied: "daily manifests, traces, memory objects and every ref other than integrations/<slug>",
  };
  if (values["dry-run"]) {
    report.ok = true;
    report.note = "dry run: source verified, nothing written, no network calls";
    return;
  }

  // ------------------------------------------------------------ host credentials (files only, never argv/output)
  for (const k of ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MCP_USE_API_KEY", "INTEGRATION_CHILD_SIGNING_JWK"]) must(`env file provides ${k}`, !!env[k]);
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const childAuth = loadChildAuthFromEnv(process.env)!;
  const creds = await resolveManufactCredentials({ env: process.env, orgSlug: PINNED_ORG });
  must("Manufact credentials resolved from env file", creds?.source === "env");
  const api = new ManufactApi(creds!);
  const id = await api.identity();
  must("Manufact identity is the pinned org", id.orgSlug === PINNED_ORG, { orgSlug: id.orgSlug, orgName: id.orgName });
  const serverEnv = await api.listEnv(m!.serverId);
  must("existing child server env is fixture-only", serverEnv.every((e) => ALLOWED_CHILD_ENV.has(e.key)), { keys: serverEnv.map((e) => e.key).sort() });

  // ------------------------------------------------------------ target preflight (no overwrite)
  target = new ModalObjectStore({ timeoutMs: 120_000 });
  const tgtInt = new IntegrationStore(target, targetNs);
  const existingRef = await target.getRef(targetNs, `integrations/${slug}`);
  const existingKeys = await target.list(targetNs, prefix, { limit: 10_000 });
  const existingMarkerBytes = (await target.get(targetNs, [markerKey])).get(markerKey);
  let resumed = false;
  let markerBytes: Buffer = Buffer.from(canonicalJson(marker));
  if (existingRef || existingKeys.length) {
    must("target integration absent (or --resume)", values.resume, { refExists: !!existingRef, objects: existingKeys.length });
    const prior = existingMarkerBytes ? (JSON.parse(existingMarkerBytes.toString("utf8")) as typeof marker) : null;
    must("resume: target labeled by this importer for the identical source", prior?.kind === MARKER_KIND && prior.sourceNs === sourceNs && prior.sourceCommit === promoted!.commit && prior.sourceRecordSha256 === recordSha256, { priorImportId: prior?.importId ?? null });
    const cur = existingRef?.value as IntegrationRecord | undefined;
    if (cur) must("resume: target record is this import", cur.promoted?.commit === promoted!.commit && cur.createdByBuild === rec!.createdByBuild && cur.manufact?.serverId === m!.serverId && (cur.manufact.active === null || cur.manufact.active.commit === promoted!.commit));
    markerBytes = existingMarkerBytes!;
    report.resumedFromImportId = prior!.importId;
    resumed = true;
  }

  // ------------------------------------------------------------ copy immutable objects (bounded batches), then verify roundtrip
  const ordered = [...copy, { key: markerKey, bytes: markerBytes }];
  for (let i = 0; i < ordered.length; ) {
    const batch: StoredObject[] = [];
    let bytes = 0;
    while (i < ordered.length && batch.length < BATCH_OBJECTS && (batch.length === 0 || bytes + ordered[i]!.bytes.length <= BATCH_BYTES)) {
      bytes += ordered[i]!.bytes.length;
      batch.push(ordered[i++]!);
    }
    await target.put(targetNs, batch);
    log(`copied ${i}/${ordered.length} objects`);
  }
  const back = await target.get(targetNs, ordered.map((o) => o.key));
  const mismatched = ordered.filter((o) => !back.get(o.key)?.equals(o.bytes)).map((o) => o.key);
  must("target bytes equal source bytes (digests roundtrip)", mismatched.length === 0, { objects: ordered.length, mismatched });

  // ------------------------------------------------------------ install exact record, inactive, create-once
  let installedVersion = existingRef?.version ?? null;
  if (!existingRef) {
    const inactive: IntegrationRecord = { ...structuredClone(rec!), manufact: { ...structuredClone(m!), active: null } };
    const res = await target.casRef(targetNs, `integrations/${slug}`, null, inactive);
    must("record installed create-once with manufact.active=null", res.ok, { version: res.current?.version ?? null });
    installedVersion = res.current!.version;
  }
  report.target = { parentUrl: client.baseUrl, ns: targetNs, store: target.kind, markerKey, installedRefVersion: installedVersion, resumed };

  // ------------------------------------------------------------ normal authenticated publish of the same child server
  const before = (await tgtInt.get(slug))!;
  let outcome: PublishOutcome | null = null;
  if (before.manufact?.active?.commit === promoted!.commit && before.manufact.active.probe === "passed") {
    log("resume: import already active for this commit; skipping publish");
    report.publish = { skipped: "already active from a prior attempt of this import", active: before.manufact.active };
  } else {
    const publisher = new ManufactPublisher({
      api,
      childAuth,
      deployEnv: (s) => {
        if (s !== DEMO_SLUG) throw new Error(`no deploy env for ${s}`);
        return { NOTIFY_HUB_SIMULATED: "1" };
      },
      waitTimeoutMs: 15 * 60_000,
      probeTimeoutMs: 180_000,
    });
    outcome = await publisher.publish({ store: tgtInt, ns: targetNs, slug, buildId: `operator-${importId}`, force: true });
    const p = outcome.probe;
    report.publish = {
      receiptId: outcome.receiptId,
      action: outcome.action,
      deploymentId: outcome.deploymentId,
      status: outcome.status,
      mcpUrl: outcome.mcpUrl,
      dashboardUrl: outcome.dashboardUrl,
      active: outcome.active,
      probe: p && { passed: p.passed, failures: p.failures, unauthenticatedStatus: p.unauthenticatedStatus, invalidTokenStatus: p.invalidTokenStatus, tools: p.tools, steps: p.steps.map(({ case: c, tool, isError }) => ({ case: c, tool, isError })), skippedWriteSteps: p.skippedWriteSteps, attempts: p.attempts },
      buildLogTail: outcome.buildLogTail.slice(-1500),
      sourceServerNote: "the source child server now verifies tokens for the target tenant audience; the local LLM-run record is left unmodified",
    };
    must("publish deployed the imported commit and the live probe passed", outcome.status === "running" && p?.passed === true && outcome.active?.deploymentId === outcome.deploymentId && outcome.active.commit === promoted!.commit, { status: outcome.status, failures: p?.failures ?? null });
    must("probe: unauthenticated and foreign/wrong-audience tokens rejected with 401", p!.unauthenticatedStatus === 401 && Object.values(p!.invalidTokenStatus).every((s) => s === 401), { unauthenticated: p!.unauthenticatedStatus, invalid: p!.invalidTokenStatus });
  }
  const live = (await tgtInt.get(slug))!.manufact!;
  const childUrl = live.mcpUrl!;
  const audience = childAudience(targetNs, slug);

  // ------------------------------------------------------------ real hosted parent: catalog + token exchange
  const catalogUrl = `${client.baseUrl}/v1/integrations`;
  const unauthCatalog = await httpJson(catalogUrl, "GET");
  must("parent catalog without key is 401", unauthCatalog.status === 401, { status: unauthCatalog.status });
  let entry: Record<string, unknown> | undefined;
  let listing: { status: number; body: unknown } = { status: 0, body: null };
  for (const deadline = Date.now() + CATALOG_WAIT_MS; ; ) {
    listing = await httpJson(catalogUrl, "GET", client.keys.read);
    const items = ((listing.body as { integrations?: unknown[] } | null)?.integrations ?? []) as Array<Record<string, unknown>>;
    entry = items.find((x) => x.slug === slug);
    if ((entry?.commit === promoted!.commit && entry.deploymentId === live.active!.deploymentId) || Date.now() > deadline) break;
    await sleep(5_000);
  }
  must("parent catalog lists the exact imported deployment", listing.status === 200 && (listing.body as { childAuthConfigured?: unknown }).childAuthConfigured === true && entry?.commit === promoted!.commit && entry.deploymentId === live.active!.deploymentId && entry.mcpUrl === childUrl && entry.audience === audience && JSON.stringify([...((entry.tools as string[]) ?? [])].sort()) === JSON.stringify(manifestTools), { status: listing.status, entry });

  const tok = await httpJson(`${client.baseUrl}/v1/integrations/${slug}/token`, "POST", client.keys.read);
  const t = (tok.body ?? {}) as { token?: unknown; tokenType?: unknown; mcpUrl?: unknown; audience?: unknown; expiresAt?: unknown };
  const token = typeof t.token === "string" ? t.token : "";
  if (token) redactor.add(token, "child-token");
  const expiresInS = typeof t.expiresAt === "string" ? Math.round((Date.parse(t.expiresAt) - Date.now()) / 1000) : null;
  const verified = token ? verifyChildToken(childAuth.publicJwk, token, { issuer: childAuth.issuer, audience }) : { ok: false as const, reason: "missing" };
  must("parent token exchange returns a short-lived token for this child", tok.status === 200 && t.tokenType === "Bearer" && t.mcpUrl === childUrl && t.audience === audience && expiresInS !== null && expiresInS > 0 && expiresInS <= 3600, { status: tok.status, tokenType: t.tokenType, expiresInS });
  must("parent-minted token verifies against the deployed public key", verified.ok, verified.ok ? undefined : { reason: verified.reason });
  report.parent = { catalogUnauthenticatedStatus: unauthCatalog.status, catalogStatus: listing.status, entry, tokenStatus: tok.status, token: { tokenType: t.tokenType, audience, expiresInS, verifiedAgainstHostPublicKey: verified.ok } };

  // ------------------------------------------------------------ fresh MCP client against the deployed child with that token
  const unauthChild = await fetch(childUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "procmem-import-unauth", version: "1" } } }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  await unauthChild.body?.cancel().catch(() => undefined);
  must("child without token is 401", unauthChild.status === 401, { status: unauthChild.status });
  const mcp = new Client({ name: "procmem-operator-import-check", version: "1" });
  try {
    await withTimeout(mcp.connect(new StreamableHTTPClientTransport(new URL(childUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } })), MCP_TIMEOUT_MS, "child initialize");
    const tools = (await withTimeout(mcp.listTools(), MCP_TIMEOUT_MS, "child tools/list")).tools.map((x) => x.name).sort();
    must("child tools/list equals the validated manifest", JSON.stringify(tools) === JSON.stringify(manifestTools), { tools });
    const r = (await withTimeout(mcp.callTool({ name: "list_notifications", arguments: {} }), MCP_TIMEOUT_MS, "list_notifications")) as { isError?: boolean; structuredContent?: { count?: unknown; pages?: unknown; items?: unknown } };
    const sc = r.structuredContent ?? {};
    const ids = Array.isArray(sc.items) ? (sc.items as Array<{ id?: unknown }>).map((x) => x.id) : [];
    const seedIds = Array.from({ length: SEED_COUNT }, (_, i) => `ntf_${String(i + 1).padStart(4, "0")}`);
    const result = { isError: r.isError === true, count: sc.count, pages: sc.pages ?? null, items: ids.length, uniqueIds: new Set(ids).size === ids.length, seedIdsPresent: seedIds.every((s) => ids.includes(s)) };
    report.child = { mcpUrl: childUrl, commit: live.active!.commit, deploymentId: live.active!.deploymentId, unauthenticatedStatus: unauthChild.status, serverVersion: mcp.getServerVersion() ?? null, tools, listNotifications: result };
    must("list_notifications returns every simulated record (read-only call)", !result.isError && typeof sc.count === "number" && sc.count >= SEED_COUNT && result.items === sc.count && result.uniqueIds && result.seedIdsPresent, result);
  } finally {
    await mcp.close().catch(() => undefined);
  }
  report.ok = true;
}

try {
  await main();
} catch (error) {
  report.ok = false;
  report.error = redactor.text(error instanceof ImportFailure ? error.message : `${(error as Error)?.name ?? "Error"}: ${errorMessage(error)}`).slice(0, 2000);
  process.exitCode = 1;
} finally {
  (target as ModalObjectStore | null)?.close();
  report.finishedAt = new Date().toISOString();
  const serialized = `${redactor.text(JSON.stringify(report, null, 2))}\n`;
  if (!values["dry-run"]) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, serialized);
    const attempt = path.join(path.dirname(reportPath), "hosted-integration-import-attempts", `${importId}.json`);
    await fs.mkdir(path.dirname(attempt), { recursive: true });
    await fs.writeFile(attempt, serialized);
  }
  const { objects: _objects, ...summary } = report;
  console.log(redactor.text(JSON.stringify({ ...summary, objects: report.objects && { ...(report.objects as Record<string, unknown>), items: undefined } }, null, 2)));
  log(`${report.ok ? "OK" : "FAILED"}${values["dry-run"] ? " (dry run)" : ` -> ${path.relative(process.cwd(), reportPath)}`}`);
}
