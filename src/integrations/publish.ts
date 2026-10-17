import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { errorMessage, sha256 } from "../util.js";
import { childAudience, childAuthEnv, generateChildAuthKeys, mintChildToken, type ChildAuthKeys } from "./child-auth.js";
import type { ManufactApi } from "./manufact.js";
import { lifecycleState, type DeploymentRecord, type IntegrationRecord, type IntegrationStore } from "./store.js";
import { IntegrationError } from "./types.js";
import type { SuiteCase, ValidationReceiptBody } from "./validate.js";

/**
 * Host-owned publisher: deploys an exact, validated, promoted commit of a child
 * integration MCP to Manufact (managed source upload of the stored
 * `git archive` bytes), then trusts nothing it was told:
 *  - waits on the deployment's own build logs for a terminal status;
 *  - probes the live endpoint over MCP: unauthenticated -> 401, foreign-key and
 *    wrong-audience tokens -> 401, parent-minted token -> initialize, tools/list
 *    equal to the validated manifest, and the fixture-free smoke cases;
 *  - only a passing probe makes a deployment "active". A failed revision leaves the
 *    previous active deployment recorded and, when Manufact already switched
 *    traffic, the publisher redeploys the previous archive (auto_rollback) and
 *    probes that too. Every step lands in an immutable pub- receipt.
 */
export interface PublisherOptions {
  api: ManufactApi;
  childAuth: ChildAuthKeys;
  /** Server name prefix; name = <prefix>-<slug>. */
  serverPrefix?: string;
  /** Host-configured non-model env per integration (e.g. simulated mode, upstream credentials). */
  deployEnv?: (slug: string) => Promise<Record<string, string>> | Record<string, string>;
  waitTimeoutMs?: number;
  /** How long to wait for the upload's own deployment to APPEAR before triggering an explicit redeploy (default 60 s). */
  appearanceGraceMs?: number;
  /** Injectable clock (tests simulate time with `sleep` + `now`). */
  now?: () => number;
  probeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  mcpConnect?: (url: string, token: string | null) => Promise<ProbeClient>;
  fetchImpl?: typeof fetch;
}

export interface ProbeClient {
  serverVersion(): unknown;
  listTools(): Promise<Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface ProbeResult {
  passed: boolean;
  failures: string[];
  unauthenticatedStatus: number | null;
  invalidTokenStatus: Record<string, number | null>;
  serverVersion: unknown;
  tools: string[];
  steps: Array<{ case: string; tool: string; isError: boolean; text: string }>;
  /** Smoke steps not replayed live because the tool is not annotated readOnlyHint (no production writes from probes). */
  skippedWriteSteps: Array<{ case: string; tool: string }>;
  attempts: number;
  durationMs: number;
}

export interface PublishOutcome {
  receiptId: string;
  action: "publish" | "update" | "rollback";
  deploymentId: string;
  status: string;
  probe: ProbeResult | null;
  active: DeploymentRecord | null;
  mcpUrl: string | null;
  dashboardUrl: string | null;
  autoRollback: { deploymentId: string; status: string; probePassed: boolean } | null;
  buildLogTail: string;
}

async function defaultConnect(url: string, token: string | null): Promise<ProbeClient> {
  const client = new Client({ name: "procmem-publisher-probe", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
  return {
    serverVersion: () => client.getServerVersion() ?? null,
    listTools: async () => (await client.listTools()).tools,
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as Record<string, unknown>,
    close: () => client.close(),
  };
}

function select(obj: unknown, path: string): unknown {
  let cur: unknown[] = [obj];
  let fanned = false;
  for (const raw of path.split(".").filter(Boolean)) {
    const star = raw.endsWith("[*]");
    const key = star ? raw.slice(0, -3) : raw;
    cur = cur.map((v) => (v == null ? undefined : key === "" ? v : (v as Record<string, unknown>)[key]));
    if (star) {
      fanned = true;
      cur = cur.flatMap((v) => (Array.isArray(v) ? v : []));
    }
  }
  return fanned ? cur : cur[0];
}

/** Same assertion semantics as templates/integration/harness/case-client.mjs. */
export function evaluateExpect(target: unknown, expect: NonNullable<SuiteCase["steps"][number]["expect"]>): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const e of expect) {
    const v = select(target, e.path);
    let ok = false;
    switch (e.op) {
      case "equals": ok = same(v, e.value); break;
      case "notEquals": ok = !same(v, e.value); break;
      case "gte": ok = typeof v === "number" && v >= (e.value as number); break;
      case "lte": ok = typeof v === "number" && v <= (e.value as number); break;
      case "exists": ok = v !== undefined && v !== null; break;
      case "absent": ok = v === undefined || v === null; break;
      case "contains": ok = typeof v === "string" ? v.includes(String(e.value)) : Array.isArray(v) && v.some((x) => same(x, e.value)); break;
      case "lengthEquals": ok = (Array.isArray(v) || typeof v === "string") && v.length === e.value; break;
      case "unique": ok = Array.isArray(v) && new Set(v.map((x) => JSON.stringify(x))).size === v.length; break;
    }
    if (!ok) out.push(`expected ${e.path} ${e.op}${e.value === undefined ? "" : ` ${JSON.stringify(e.value)}`}; got ${JSON.stringify(v)?.slice(0, 200)}`);
  }
  return out;
}

const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

export class ManufactPublisher {
  readonly api: ManufactApi;
  readonly childAuth: ChildAuthKeys;
  readonly #o: PublisherOptions;

  constructor(opts: PublisherOptions) {
    this.api = opts.api;
    this.childAuth = opts.childAuth;
    this.#o = opts;
  }

  get #sleep() {
    return this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  serverName(slug: string): string {
    return `${this.#o.serverPrefix ?? "procmem-int"}-${slug}`.slice(0, 60);
  }

  async #validation(store: IntegrationStore, slug: string, receiptId: string): Promise<ValidationReceiptBody> {
    const r = (await store.getReceipt(slug, receiptId)) as unknown as ValidationReceiptBody | null;
    if (!r || r.kind !== "integration_validation" || !r.passed) throw new IntegrationError("not_validated", `Validation receipt ${receiptId} is missing or not passing`);
    return r;
  }

  async #deployEnv(ns: string, slug: string, validation: ValidationReceiptBody): Promise<Record<string, string>> {
    const host = (await this.#o.deployEnv?.(slug)) ?? {};
    for (const k of Object.keys(host)) if (k.startsWith("CHILD_AUTH_")) throw new IntegrationError("invalid_deploy_env", `${k} is host-reserved`);
    const env = { ...host, ...childAuthEnv(this.childAuth, ns, slug), NODE_ENV: "production" };
    const missing = (validation.manifest?.env ?? []).filter((e) => e.required && !(e.name in env)).map((e) => e.name);
    if (missing.length) throw new IntegrationError("missing_deploy_env", `Host deploy env is missing required variables: ${missing.join(", ")}`);
    for (const [k, v] of Object.entries(host)) if ((validation.manifest?.env ?? []).find((e) => e.name === k)?.secret) this.api.addRedaction(v);
    return env;
  }

  /** Real MCP probe of a deployed child; transient transport errors are retried with identical semantics until probeTimeoutMs. */
  async probe(mcpUrl: string, ns: string, slug: string, tools: string[], cases: SuiteCase[]): Promise<ProbeResult> {
    const started = Date.now();
    const deadline = started + (this.#o.probeTimeoutMs ?? 180_000);
    const connect = this.#o.mcpConnect ?? defaultConnect;
    const fetchImpl = this.#o.fetchImpl ?? fetch;
    let attempts = 0;
    let last: ProbeResult | null = null;
    const initBody = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "procmem-probe-unauth", version: "1" } } });
    const statusWith = async (token: string | null) => {
      const r = await fetchImpl(mcpUrl, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: initBody, signal: AbortSignal.timeout(20_000) });
      await r.body?.cancel().catch(() => undefined);
      return r.status;
    };
    for (;;) {
      attempts++;
      const res: ProbeResult = { passed: false, failures: [], unauthenticatedStatus: null, invalidTokenStatus: {}, serverVersion: null, tools: [], steps: [], skippedWriteSteps: [], attempts, durationMs: 0 };
      let transient = false;
      let client: ProbeClient | null = null;
      try {
        res.unauthenticatedStatus = await statusWith(null);
        if (res.unauthenticatedStatus >= 500 || res.unauthenticatedStatus === 404) {
          transient = true;
          throw new Error(`endpoint not serving yet (HTTP ${res.unauthenticatedStatus})`);
        }
        if (res.unauthenticatedStatus !== 401) res.failures.push(`unauthenticated initialize returned HTTP ${res.unauthenticatedStatus}, expected 401`);
        const foreign = generateChildAuthKeys(this.childAuth.issuer);
        const bad = {
          foreign_key: mintChildToken(foreign, { ns, slug, subject: "probe", ttlSeconds: 120 }).token,
          wrong_audience: mintChildToken(this.childAuth, { ns, slug: slug === "probe-other" ? "probe-else" : "probe-other", subject: "probe", ttlSeconds: 120 }).token,
        };
        for (const [label, tok] of Object.entries(bad)) {
          const st = await statusWith(tok);
          res.invalidTokenStatus[label] = st;
          if (st !== 401) res.failures.push(`${label} token returned HTTP ${st}, expected 401`);
        }
        const { token } = mintChildToken(this.childAuth, { ns, slug, subject: "procmem-publisher-probe", ttlSeconds: 300 });
        client = await connect(mcpUrl, token);
        res.serverVersion = client.serverVersion();
        const listed = await client.listTools();
        const readOnly = new Set(listed.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
        res.tools = listed.map((t) => t.name).sort();
        if (JSON.stringify(res.tools) !== JSON.stringify([...tools].sort())) res.failures.push(`tools/list ${JSON.stringify(res.tools)} != validated manifest ${JSON.stringify([...tools].sort())}`);
        for (const c of cases) {
          if (c.steps.some((st) => !readOnly.has(st.tool))) {
            for (const st of c.steps) res.skippedWriteSteps.push({ case: c.name, tool: st.tool });
            continue;
          }
          for (const step of c.steps) {
            const r = await client.callTool(step.tool, (step.arguments ?? {}) as Record<string, unknown>);
            const text = ((r.content as Array<{ type: string; text?: string }>) ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n").slice(0, 1000);
            res.steps.push({ case: c.name, tool: step.tool, isError: r.isError === true, text });
            const expectsError = (step.expect ?? []).some((e) => e.path === "isError");
            if (!expectsError && r.isError) res.failures.push(`${c.name}: ${step.tool} returned isError: ${text.slice(0, 200)}`);
            res.failures.push(...evaluateExpect(r, step.expect ?? []).map((f) => `${c.name}: ${step.tool}: ${f}`));
          }
        }
        res.passed = res.failures.length === 0;
      } catch (error) {
        const msg = errorMessage(error);
        if (!transient && /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|socket|5\d\d|timed out|aborted/i.test(msg)) transient = true;
        res.failures.push(`probe error: ${msg.slice(0, 500)}`);
      } finally {
        await client?.close().catch(() => undefined);
      }
      res.durationMs = Date.now() - started;
      last = res;
      if (res.passed || !transient || Date.now() > deadline) return last;
      await this.#sleep(5_000);
    }
  }

  async #deployArchive(p: {
    store: IntegrationStore;
    ns: string;
    slug: string;
    rec: IntegrationRecord;
    commit: string;
    archiveKey: string;
    archiveSha256: string;
    validation: ValidationReceiptBody;
    validationReceiptId: string;
    buildId: string;
  }): Promise<{ deploymentId: string; status: string; buildLog: string; timedOut: boolean; serverId: string; mcpUrl: string | null; created: boolean; supersededBy: string | null; trigger: string; managedCommitSha: string | null; serverActiveDeploymentId: string | null; members: Array<{ id: string; status: string; trigger: string | null }>; uploadResponse: unknown; appearance: { appeared: boolean; waitedMs: number; graceMs: number } }> {
    const archive = await p.store.getBlob(p.archiveKey);
    if (sha256(archive) !== p.archiveSha256) throw new IntegrationError("archive_mismatch", "Stored archive digest mismatch");
    const env = await this.#deployEnv(p.ns, p.slug, p.validation);
    // Unique per upload so the build deployment can be identified exactly.
    const commitMessage = `procmem integration ${p.slug} commit ${p.commit} validation ${p.validationReceiptId} build ${p.buildId} upload ${randomUUID()}`;
    let serverId: string;
    let created = false;
    let uploadResponse: unknown = null;
    if (!p.rec.manufact) {
      const r = await this.api.createManagedServer({ name: this.serverName(p.slug), archive, branch: "main", commitMessage, env });
      serverId = r.server.id;
      created = true;
      await p.store.update(p.slug, (cur) => ({
        ...cur,
        manufact: { orgSlug: this.api.orgSlug, serverId, serverSlug: (r.server.slug as string | undefined) ?? null, name: this.serverName(p.slug), mcpUrl: (r.server.mcpUrl as string | undefined) ?? null, dashboardUrl: this.api.dashboardUrl(serverId), active: null, history: [], envNames: Object.keys(env).sort() },
      }));
    } else {
      if (p.rec.manufact.orgSlug !== this.api.orgSlug) throw new IntegrationError("manufact_wrong_org", `Integration is deployed in ${p.rec.manufact.orgSlug}, publisher is configured for ${this.api.orgSlug}`);
      serverId = p.rec.manufact.serverId;
      for (const [k, v] of Object.entries(env)) await this.api.setEnv(serverId, k, v, k !== "NODE_ENV" && !k.startsWith("CHILD_AUTH_"));
      uploadResponse = (await this.api.uploadSource({ serverId, archive, branch: "main", commitMessage })).response;
    }
    const sleepOpt = { ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}), ...(this.#o.now ? { now: this.#o.now } : {}) };
    const budget = this.#o.waitTimeoutMs ?? 15 * 60_000;
    const graceMs = this.#o.appearanceGraceMs ?? 60_000;
    let trigger = "upload";
    let group = await this.api.awaitUploadBuild(serverId, commitMessage, { timeoutMs: budget, appearanceGraceMs: graceMs, ...sleepOpt });
    const appearance = { appeared: group.appeared, waitedMs: group.waitedMs, graceMs };
    if (!group.deployment) {
      // Nothing carried this upload within the grace (observed live: re-uploading an identical tree,
      // e.g. same commit with only env changed, produces no managed commit and no webhook build).
      // Trigger the build explicitly (same call as the CLI) and give IT the full build budget.
      const t = await this.api.triggerRedeploy(serverId, "main");
      const w = await this.api.waitForDeployment(t.deploymentId, { timeoutMs: budget, ...sleepOpt });
      group = { deployment: await this.api.getDeployment(t.deploymentId), status: w.status, buildLog: w.buildLog, timedOut: w.timedOut, appeared: false, waitedMs: group.waitedMs, members: group.members };
      trigger = "explicit_redeploy_after_no_upload_deployment";
    }
    const deploymentId = group.deployment!.id;
    const waited = { status: group.status, buildLog: group.buildLog, timedOut: group.timedOut };
    const final = await this.api.getDeployment(deploymentId);
    const server = await this.api.getServer(serverId);
    // Never trust "running" alone: a later deployment on the same server (e.g. a CLI-created
    // manual one) can claim running without building our source. Record what is newest.
    let supersededBy: string | null = null;
    try {
      const list = await this.api.listDeployments(serverId, 10);
      const newest = [...list.items].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
      if (newest && newest.id !== deploymentId && newest.gitCommitMessage !== commitMessage) supersededBy = newest.id;
    } catch {
      /* listing is advisory evidence only */
    }
    return {
      deploymentId,
      status: waited.status,
      buildLog: waited.buildLog,
      timedOut: waited.timedOut,
      serverId,
      mcpUrl: (server.mcpUrl as string | undefined) ?? null,
      created,
      supersededBy,
      trigger: `${trigger}:${final.deploymentTrigger ?? "?"}`,
      members: group.members,
      uploadResponse,
      appearance,
      managedCommitSha: final.gitCommitSha ?? null,
      serverActiveDeploymentId: (server.activeDeploymentId as string | null | undefined) ?? null,
    };
  }

  /** Deploy the promoted revision (create server on first publish, managed-source update afterwards). */
  async publish(p: { store: IntegrationStore; ns: string; slug: string; buildId: string; force?: boolean }): Promise<PublishOutcome> {
    const startedAt = new Date().toISOString();
    const rec = await p.store.get(p.slug);
    if (!rec) throw new IntegrationError("unknown_integration", `Integration ${p.slug} does not exist`);
    if (lifecycleState(rec) === "retired") throw new IntegrationError("integration_retired", `Integration ${p.slug} is retired; restore it explicitly (integration_restore) before publishing`);
    const promoted = rec.promoted;
    if (!promoted) throw new IntegrationError("not_promoted", "No promoted revision; validate, commit and integration_promote first");
    const validation = await this.#validation(p.store, p.slug, promoted.validationReceiptId);
    if (validation.tree !== promoted.tree || validation.sourceSha256 !== promoted.sourceSha256) throw new IntegrationError("not_validated", "Promoted revision does not match its validation receipt");
    if (!p.force && rec.manufact?.active?.commit === promoted.commit && rec.manufact.active.probe === "passed") {
      throw new IntegrationError("already_deployed", `Commit ${promoted.commit.slice(0, 12)} is already the active deployment ${rec.manufact.active.deploymentId}; pass force to redeploy`);
    }
    await this.api.identity();
    const action: PublishOutcome["action"] = rec.manufact ? "update" : "publish";
    const previousActive = rec.manufact?.active ?? null;
    const d = await this.#deployArchive({ store: p.store, ns: p.ns, slug: p.slug, rec, commit: promoted.commit, archiveKey: promoted.archiveKey, archiveSha256: promoted.archiveSha256, validation, validationReceiptId: promoted.validationReceiptId, buildId: p.buildId });
    const fresh = (await p.store.get(p.slug))!;
    const mcpUrl = d.mcpUrl ?? fresh.manufact?.mcpUrl ?? null;
    let probe: ProbeResult | null = null;
    if (d.status === "running" && mcpUrl) probe = await this.probe(mcpUrl, p.ns, p.slug, validation.manifest?.tools ?? [], validation.manifest?.deployProbe ?? []);
    const routed = d.serverActiveDeploymentId === null || d.serverActiveDeploymentId === d.deploymentId;
    const passed = probe?.passed === true && !d.timedOut && routed;
    let autoRollback: PublishOutcome["autoRollback"] = null;
    let rollbackRecord: DeploymentRecord | null = null;
    // Manufact switches traffic once a build succeeds; if our probe then fails, restore the previous good archive.
    if (!passed && d.status === "running" && previousActive) {
      const prevValidation = await this.#validation(p.store, p.slug, previousActive.validationReceiptId);
      const prevPromoted = fresh.promotedHistory.find((x) => x.commit === previousActive.commit) ?? (fresh.promoted?.commit === previousActive.commit ? fresh.promoted : null);
      if (prevPromoted) {
        const rb = await this.#deployArchive({ store: p.store, ns: p.ns, slug: p.slug, rec: fresh, commit: previousActive.commit, archiveKey: prevPromoted.archiveKey, archiveSha256: prevPromoted.archiveSha256, validation: prevValidation, validationReceiptId: previousActive.validationReceiptId, buildId: p.buildId });
        const rbProbe = rb.status === "running" && rb.mcpUrl ? await this.probe(rb.mcpUrl, p.ns, p.slug, prevValidation.manifest?.tools ?? [], prevValidation.manifest?.deployProbe ?? []) : null;
        autoRollback = { deploymentId: rb.deploymentId, status: rb.status, probePassed: rbProbe?.passed === true };
        rollbackRecord = { deploymentId: rb.deploymentId, commit: previousActive.commit, archiveSha256: prevPromoted.archiveSha256, validationReceiptId: previousActive.validationReceiptId, status: rb.status, probe: rbProbe?.passed ? "passed" : "failed", receiptId: "", at: new Date().toISOString(), action: "auto_rollback" };
      }
    }
    const body = {
      kind: "integration_publish",
      action,
      slug: p.slug,
      ns: p.ns,
      buildId: p.buildId,
      orgSlug: this.api.orgSlug,
      serverId: d.serverId,
      serverCreated: d.created,
      deploymentId: d.deploymentId,
      status: d.status,
      waitTimedOut: d.timedOut,
      supersededBy: d.supersededBy,
      deploymentTrigger: d.trigger,
      uploadDeployments: d.members,
      uploadAppearance: d.appearance,
      uploadResponse: d.uploadResponse,
      managedRepoCommitSha: d.managedCommitSha,
      serverActiveDeploymentId: d.serverActiveDeploymentId,
      commit: promoted.commit,
      tree: promoted.tree,
      sourceSha256: promoted.sourceSha256,
      archiveSha256: promoted.archiveSha256,
      validationReceiptId: promoted.validationReceiptId,
      mcpUrl,
      dashboardUrl: this.api.dashboardUrl(d.serverId),
      envNames: Object.keys(await this.#deployEnv(p.ns, p.slug, validation)).sort(),
      buildLogBytes: d.buildLog.length,
      buildLogSha256: sha256(d.buildLog),
      buildLogTail: tail(d.buildLog, 6000),
      probe,
      autoRollback,
      previousActive,
      audience: childAudience(p.ns, p.slug),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    const { receiptId } = await p.store.putReceipt(p.slug, "pub", body);
    const record: DeploymentRecord = { deploymentId: d.deploymentId, commit: promoted.commit, archiveSha256: promoted.archiveSha256, validationReceiptId: promoted.validationReceiptId, status: d.status, probe: probe ? (probe.passed ? "passed" : "failed") : "skipped", receiptId, at: body.finishedAt, action };
    const updated = await p.store.update(p.slug, (cur) => {
      const m = cur.manufact!;
      const history = [...m.history, record, ...(rollbackRecord ? [{ ...rollbackRecord, receiptId }] : [])];
      const active = passed ? record : rollbackRecord?.probe === "passed" ? { ...rollbackRecord, receiptId } : m.active;
      return { ...cur, manufact: { ...m, mcpUrl: mcpUrl ?? m.mcpUrl, history, active, envNames: body.envNames } };
    });
    return { receiptId, action, deploymentId: d.deploymentId, status: d.status, probe, active: updated.manufact?.active ?? null, mcpUrl, dashboardUrl: body.dashboardUrl, autoRollback, buildLogTail: tail(d.buildLog, 3000) };
  }

  /** Redeploy the exact archive of a previously passing deployment (by deployment id or commit). */
  async rollback(p: { store: IntegrationStore; ns: string; slug: string; buildId: string; deploymentId?: string; commit?: string }): Promise<PublishOutcome> {
    const startedAt = new Date().toISOString();
    const rec = await p.store.get(p.slug);
    if (!rec?.manufact) throw new IntegrationError("not_deployed", `Integration ${p.slug} has no Manufact server`);
    if (lifecycleState(rec) === "retired") throw new IntegrationError("integration_retired", `Integration ${p.slug} is retired; restore it explicitly (integration_restore) before rolling back`);
    const target = [...rec.manufact.history].reverse().find((h) => h.probe === "passed" && (p.deploymentId ? h.deploymentId === p.deploymentId : p.commit ? h.commit === p.commit : h.deploymentId !== rec.manufact!.active?.deploymentId));
    if (!target) throw new IntegrationError("no_rollback_target", "No previously passing deployment matches; see integration_deployment_status history");
    const validation = await this.#validation(p.store, p.slug, target.validationReceiptId);
    const archiveKey = `blobs/${target.archiveSha256}`;
    await this.api.identity();
    const d = await this.#deployArchive({ store: p.store, ns: p.ns, slug: p.slug, rec, commit: target.commit, archiveKey, archiveSha256: target.archiveSha256, validation, validationReceiptId: target.validationReceiptId, buildId: p.buildId });
    const mcpUrl = d.mcpUrl ?? rec.manufact.mcpUrl;
    const probe = d.status === "running" && mcpUrl ? await this.probe(mcpUrl, p.ns, p.slug, validation.manifest?.tools ?? [], validation.manifest?.deployProbe ?? []) : null;
    const body = { kind: "integration_publish", action: "rollback", slug: p.slug, ns: p.ns, buildId: p.buildId, orgSlug: this.api.orgSlug, serverId: d.serverId, deploymentId: d.deploymentId, status: d.status, waitTimedOut: d.timedOut, supersededBy: d.supersededBy, commit: target.commit, archiveSha256: target.archiveSha256, validationReceiptId: target.validationReceiptId, rollbackOf: target.deploymentId, uploadAppearance: d.appearance, uploadDeployments: d.members, mcpUrl, buildLogBytes: d.buildLog.length, buildLogSha256: sha256(d.buildLog), buildLogTail: tail(d.buildLog, 6000), probe, startedAt, finishedAt: new Date().toISOString() };
    const { receiptId } = await p.store.putReceipt(p.slug, "pub", body);
    const record: DeploymentRecord = { deploymentId: d.deploymentId, commit: target.commit, archiveSha256: target.archiveSha256, validationReceiptId: target.validationReceiptId, status: d.status, probe: probe ? (probe.passed ? "passed" : "failed") : "skipped", receiptId, at: body.finishedAt, action: "rollback" };
    const updated = await p.store.update(p.slug, (cur) => ({ ...cur, manufact: { ...cur.manufact!, history: [...cur.manufact!.history, record], active: probe?.passed ? record : cur.manufact!.active } }));
    return { receiptId, action: "rollback", deploymentId: d.deploymentId, status: d.status, probe, active: updated.manufact?.active ?? null, mcpUrl, dashboardUrl: this.api.dashboardUrl(d.serverId), autoRollback: null, buildLogTail: tail(d.buildLog, 3000) };
  }
}
