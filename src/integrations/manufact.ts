import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../util.js";
import { IntegrationError } from "./types.js";

/**
 * Host-owned Manufact Cloud control-plane client.
 *
 * Route: the Manufact Cloud REST API (https://cloud.manufact.com/api/v1) with the
 * exact endpoints, headers and multipart fields used by the official
 * @mcp-use/cli@4.4.0 `mcp-use deploy --no-github` / `deployments` / `servers`
 * commands (see dist/commands/deploy.js, deployments.js, servers.js and
 * chunk-ZNWJOBFW.js). The hosted control-plane MCP (mcp.manufact.com/mcp) requires an
 * interactive OAuth JWT and rejects API keys, so it is not used headlessly.
 *
 * Credentials: an API key from MCP_USE_API_KEY (product runtime) or the CLI profile
 * file (workstation, ~/.mcp-use/config.json). The key is sent only to the Manufact API
 * host, is never returned, logged, stored or forwarded into a sandbox/model, and is
 * redacted from every error message.
 */
export interface ManufactCredentials {
  apiKey: string;
  /** Organization (profile) id sent as x-profile-id. Resolved from the slug when omitted. */
  orgId?: string;
  /** Required: deployments are refused unless the authenticated org has this slug. */
  orgSlug: string;
  apiUrl?: string;
  webUrl?: string;
  source: "env" | "cli-profile" | "explicit";
}

export const DEFAULT_MANUFACT_API = "https://cloud.manufact.com/api/v1";
export const DEFAULT_MANUFACT_WEB = "https://manufact.com";

/**
 * Resolve host credentials. Env (product runtime) wins over the CLI profile:
 *   MCP_USE_API_KEY, MANUFACT_ORG_SLUG (required), MANUFACT_ORG_ID (optional),
 *   MCP_USE_CLOUD_API_URL, MCP_USE_CLOUD_WEB_URL.
 * Returns null when no key is configured; callers report that explicitly.
 */
export async function resolveManufactCredentials(
  opts: { env?: NodeJS.ProcessEnv; orgSlug?: string; profilePath?: string } = {},
): Promise<ManufactCredentials | null> {
  const env = opts.env ?? process.env;
  const orgSlug = opts.orgSlug ?? env.MANUFACT_ORG_SLUG;
  const common = {
    ...(env.MCP_USE_CLOUD_API_URL ? { apiUrl: env.MCP_USE_CLOUD_API_URL } : {}),
    ...(env.MCP_USE_CLOUD_WEB_URL ? { webUrl: env.MCP_USE_CLOUD_WEB_URL } : {}),
  };
  if (env.MCP_USE_API_KEY) {
    if (!orgSlug) throw new IntegrationError("manufact_org_required", "MANUFACT_ORG_SLUG must be set with MCP_USE_API_KEY");
    return { apiKey: env.MCP_USE_API_KEY, orgSlug, ...(env.MANUFACT_ORG_ID ? { orgId: env.MANUFACT_ORG_ID } : {}), source: "env", ...common };
  }
  const file = opts.profilePath ?? path.join(os.homedir(), ".mcp-use", "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const cfg = JSON.parse(raw) as { apiKey?: string; orgId?: string; orgSlug?: string };
  if (!cfg.apiKey) return null;
  const slug = orgSlug ?? cfg.orgSlug;
  if (!slug) throw new IntegrationError("manufact_org_required", "Set MANUFACT_ORG_SLUG (or run `mcp-use org use <slug>`)");
  return { apiKey: cfg.apiKey, orgSlug: slug, ...(cfg.orgId && cfg.orgSlug === slug ? { orgId: cfg.orgId } : {}), source: "cli-profile", ...common };
}

export interface ManufactIdentity {
  email: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
}

export interface ManufactDeployment {
  id: string;
  serverId: string | null;
  status: string;
  error?: string | null;
  gitBranch?: string | null;
  gitCommitSha?: string | null;
  gitCommitMessage?: string | null;
  deploymentTrigger?: string | null;
  createdAt?: string;
  [k: string]: unknown;
}

export interface ManufactServer {
  id: string;
  slug?: string | null;
  name?: string;
  status?: string;
  mcpUrl?: string | null;
  activeDeploymentId?: string | null;
  [k: string]: unknown;
}

export const TERMINAL_DEPLOYMENT_STATUSES = new Set(["running", "failed", "stopped"]);

export class ManufactApi {
  readonly #key: string;
  readonly #base: string;
  readonly #web: string;
  #orgId: string | undefined;
  readonly orgSlug: string;
  readonly #fetch: typeof fetch;
  #redactions = new Set<string>();

  constructor(creds: ManufactCredentials, opts: { fetchImpl?: typeof fetch } = {}) {
    if (!creds.apiKey) throw new IntegrationError("manufact_not_configured", "Manufact API key missing");
    this.#key = creds.apiKey;
    this.#redactions.add(creds.apiKey);
    this.#base = (creds.apiUrl ?? DEFAULT_MANUFACT_API).replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
    this.#web = (creds.webUrl ?? DEFAULT_MANUFACT_WEB).replace(/\/+$/, "");
    this.#orgId = creds.orgId;
    this.orgSlug = creds.orgSlug;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  /** Values (e.g. env secrets) that must never appear in errors. */
  addRedaction(value: string) {
    if (value) this.#redactions.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.#redactions) if (v.length >= 4) out = out.split(v).join("[REDACTED]");
    return out;
  }

  dashboardUrl(serverId: string): string {
    return `${this.#web}/cloud/${encodeURIComponent(this.orgSlug)}/servers/${encodeURIComponent(serverId)}/overview`;
  }

  async #request<T>(route: string, init: { method?: string; json?: unknown; form?: FormData; timeoutMs?: number; org?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "x-api-key": this.#key };
    if (init.org !== false && this.#orgId) headers["x-profile-id"] = this.#orgId;
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) body = init.form;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${route}`, { method: init.method ?? "GET", headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
    } catch (error) {
      throw new IntegrationError("manufact_network_error", this.redact(`Manufact ${init.method ?? "GET"} ${route.split("?")[0]} failed: ${errorMessage(error)}`));
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const msg = typeof parsed === "object" && parsed !== null ? String((parsed as Record<string, unknown>).message ?? (parsed as Record<string, unknown>).error ?? (parsed as Record<string, unknown>).detail ?? "") : String(parsed ?? "");
      const code = res.status === 401 ? "manufact_not_authenticated" : res.status === 403 ? "manufact_forbidden" : res.status === 404 ? "manufact_not_found" : res.status === 400 || res.status === 422 ? "manufact_validation_error" : "manufact_api_error";
      throw new IntegrationError(code, this.redact(`Manufact ${init.method ?? "GET"} ${route.split("?")[0]} -> HTTP ${res.status}: ${msg.slice(0, 1000)}`), { status: res.status });
    }
    return parsed as T;
  }

  /** GET /test-auth; verifies the configured org slug is one of the caller's orgs and pins its id. */
  async identity(): Promise<ManufactIdentity> {
    const r = await this.#request<{ email: string; profiles: Array<{ id: string; profile_name: string; slug: string }> }>("/test-auth", { org: false });
    const org = r.profiles.find((p) => p.slug === this.orgSlug);
    if (!org) throw new IntegrationError("manufact_wrong_org", `Authenticated account is not a member of organization ${this.orgSlug}; refusing to deploy elsewhere`);
    if (this.#orgId && this.#orgId !== org.id) throw new IntegrationError("manufact_wrong_org", `Configured org id does not match organization ${this.orgSlug}`);
    this.#orgId = org.id;
    return { email: r.email, orgId: org.id, orgSlug: org.slug, orgName: org.profile_name };
  }

  /** POST /servers (multipart, managed source upload) — creates the server and its first deployment. */
  async createManagedServer(p: { name: string; archive: Buffer; branch: string; commitMessage: string; env: Record<string, string> }): Promise<{ server: ManufactServer; deploymentId: string }> {
    const id = await this.identity();
    const form = new FormData();
    form.set("sourceFile", new Blob([new Uint8Array(p.archive)], { type: "application/gzip" }), "source.tar.gz");
    form.set("organizationId", id.orgId);
    form.set("managed", "true");
    form.set("name", p.name);
    form.set("repoName", p.name);
    form.set("private", "true");
    form.set("branch", p.branch);
    form.set("commitMessage", p.commitMessage);
    if (Object.keys(p.env).length) {
      for (const v of Object.values(p.env)) this.addRedaction(v);
      form.set("env", JSON.stringify(p.env));
    }
    const r = await this.#request<{ server: ManufactServer; deploymentId: string | null }>("/servers", { method: "POST", form, timeoutMs: 180_000 });
    if (!r.deploymentId) throw new IntegrationError("manufact_no_deployment", `Server ${r.server?.id} was created but no deployment was started`);
    return { server: r.server, deploymentId: r.deploymentId };
  }

  /**
   * POST /servers/:id/source — pushes a new commit to the managed repository, which
   * starts a webhook build deployment by itself (resolve it with findDeploymentByCommitMessage).
   */
  async uploadSource(p: { serverId: string; archive: Buffer; branch: string; commitMessage: string }): Promise<{ response: unknown }> {
    await this.identity();
    const form = new FormData();
    form.set("sourceFile", new Blob([new Uint8Array(p.archive)], { type: "application/gzip" }), "source.tar.gz");
    form.set("branch", p.branch);
    form.set("commitMessage", p.commitMessage);
    const response = await this.#request<unknown>(`/servers/${encodeURIComponent(p.serverId)}/source`, { method: "POST", form, timeoutMs: 180_000 });
    // Kept (redacted, bounded) for receipts; its shape is undocumented, so it never drives control flow.
    return { response: boundedJson(JSON.parse(this.redact(JSON.stringify(response ?? null)))) };
  }

  /** POST /deployments {trigger:"redeploy"} (what `mcp-use deploy` does after an upload). */
  async triggerRedeploy(serverId: string, branch: string): Promise<{ deploymentId: string }> {
    const d = await this.#request<{ id: string }>("/deployments", { method: "POST", json: { serverId, branch, trigger: "redeploy" } });
    return { deploymentId: d.id };
  }

  /**
   * The deployment that actually builds an uploaded revision is the one whose
   * gitCommitMessage equals the upload's commit message (observed live: the id returned
   * by POST /servers is a placeholder "manual" deployment that is stopped immediately).
   */
  async findDeploymentByCommitMessage(serverId: string, commitMessage: string, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<ManufactDeployment | null> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      const list = await this.listDeployments(serverId, 20);
      const hit = list.items.find((d) => d.gitCommitMessage === commitMessage);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await sleep(opts.pollMs ?? 3000);
    }
  }

  /** POST /deployments/:id/stop (same call as `mcp-use deployments stop`). Does not delete anything. */
  async stopDeployment(deploymentId: string): Promise<void> {
    await this.identity();
    await this.#request(`/deployments/${encodeURIComponent(deploymentId)}/stop`, { method: "POST" });
  }

  getServer(serverId: string) {
    return this.#request<ManufactServer>(`/servers/${encodeURIComponent(serverId)}`);
  }

  getDeployment(deploymentId: string) {
    return this.#request<ManufactDeployment>(`/deployments/${encodeURIComponent(deploymentId)}`);
  }

  listDeployments(serverId: string, limit = 20) {
    return this.#request<{ items: ManufactDeployment[]; total: number }>(`/deployments?${new URLSearchParams({ limit: String(limit), skip: "0", serverId })}`);
  }

  async buildLogs(deploymentId: string, offset = 0): Promise<{ logs: string; offset: number; status: string }> {
    const r = await this.#request<{ logs: string; offset: number; status: string }>(`/deployments/${encodeURIComponent(deploymentId)}/build-logs?offset=${offset}`);
    return { ...r, logs: this.redact(r.logs ?? "") };
  }

  async runtimeLogs(deploymentId: string): Promise<{ logs: string }> {
    const r = await this.#request<{ logs: string }>(`/deployments/${encodeURIComponent(deploymentId)}/logs?lines=500`);
    return { logs: this.redact(r.logs ?? "") };
  }

  async listEnv(serverId: string): Promise<Array<{ id: string; key: string; environments?: string[]; sensitive?: boolean }>> {
    const r = await this.#request<unknown>(`/servers/${encodeURIComponent(serverId)}/env-variables`);
    const items = Array.isArray(r) ? r : ((r as { items?: unknown[] })?.items ?? []);
    return (items as Array<Record<string, unknown>>).map((e) => ({ id: String(e.id), key: String(e.key), ...(Array.isArray(e.environments) ? { environments: e.environments as string[] } : {}), ...(typeof e.sensitive === "boolean" ? { sensitive: e.sensitive } : {}) }));
  }

  /** Create or update a production env var (same body as `mcp-use servers env set`). */
  async setEnv(serverId: string, key: string, value: string, sensitive: boolean): Promise<void> {
    this.addRedaction(value);
    const existing = (await this.listEnv(serverId)).find((e) => e.key === key && (e.environments ?? ["production"]).includes("production"));
    const body = { key, value, branch: null, environments: ["production"], sensitive };
    if (existing) await this.#request(`/servers/${encodeURIComponent(serverId)}/env-variables/${encodeURIComponent(existing.id)}`, { method: "PATCH", json: body });
    else await this.#request(`/servers/${encodeURIComponent(serverId)}/env-variables`, { method: "POST", json: body });
  }

  /**
   * Wait for the build of one upload. Live behaviour (Oct 2026): a managed upload can yield
   * TWO deployments carrying the same commit message (webhook + manual), and Manufact stops
   * whichever is superseded. So track the whole group: the first member that reaches
   * running/failed is the build; "stopped" members are superseded duplicates. Returns the
   * chosen deployment, its complete build log, and every member seen (for receipts).
   */
  async awaitUploadBuild(
    serverId: string,
    commitMessage: string,
    opts: { timeoutMs?: number; appearanceGraceMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ): Promise<{ deployment: ManufactDeployment | null; status: string; buildLog: string; timedOut: boolean; appeared: boolean; waitedMs: number; members: Array<{ id: string; status: string; trigger: string | null }> }> {
    const now = opts.now ?? Date.now;
    const started = now();
    const deadline = started + (opts.timeoutMs ?? 15 * 60_000);
    // A managed upload of a tree identical to the repo's current commit (e.g. re-publishing the same
    // source with only env changed) creates no commit and therefore no webhook deployment. If no
    // deployment carrying this upload's message appears within the grace, report appeared=false so
    // the caller triggers an explicit redeploy instead of burning the whole build budget. Once any
    // member appears (even a stopped placeholder next to a building webhook) the FULL budget applies.
    const grace = Math.min(opts.appearanceGraceMs ?? 60_000, opts.timeoutMs ?? 15 * 60_000);
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      const items = (await this.listDeployments(serverId, 30)).items.filter((d) => d.gitCommitMessage === commitMessage);
      const members = items.map((d) => ({ id: d.id, status: d.status, trigger: d.deploymentTrigger ?? null }));
      if (items.length === 0 && now() - started >= grace) {
        return { deployment: null, status: "missing", buildLog: "", timedOut: false, appeared: false, waitedMs: now() - started, members };
      }
      const live = items.filter((d) => d.status !== "stopped");
      const chosen = live.find((d) => d.status === "running") ?? (live.length > 0 && live.every((d) => d.status === "failed") ? live[0] : undefined);
      const allStopped = items.length > 0 && live.length === 0 && now() - started > 90_000;
      if (chosen || allStopped || now() > deadline) {
        const dep = chosen ?? items[0] ?? null;
        let buildLog = "";
        if (dep) {
          let offset = 0;
          for (let i = 0; i < 50; i++) {
            const r = await this.buildLogs(dep.id, offset);
            if (!r.logs) break;
            buildLog += r.logs;
            if (r.offset === offset) break;
            offset = r.offset;
          }
        }
        return { deployment: dep, status: chosen?.status ?? (allStopped ? "stopped" : (dep?.status ?? "missing")), buildLog, timedOut: !chosen && !allStopped, appeared: items.length > 0, waitedMs: now() - started, members };
      }
      await sleep(opts.pollMs ?? 5000);
    }
  }

  /** Poll build logs until a terminal status (running | failed | stopped) or timeout. */
  async waitForDeployment(deploymentId: string, opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<{ status: string; buildLog: string; timedOut: boolean }> {
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.timeoutMs ?? 15 * 60_000);
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let offset = 0;
    let log = "";
    let status = "pending";
    for (;;) {
      const r = await this.buildLogs(deploymentId, offset);
      if (r.logs) log += r.logs;
      offset = r.offset ?? offset;
      status = r.status ?? status;
      if (TERMINAL_DEPLOYMENT_STATUSES.has(status)) return { status, buildLog: log, timedOut: false };
      if (now() > deadline) return { status, buildLog: log, timedOut: true };
      await sleep(opts.pollMs ?? 3000);
    }
  }
}

/** Bounded, JSON-safe copy of an API response for receipts. */
function boundedJson(v: unknown): unknown {
  try {
    const text = JSON.stringify(v ?? null);
    return text.length <= 2000 ? JSON.parse(text) : { truncated: true, preview: text.slice(0, 2000) };
  } catch {
    return { unserializable: true };
  }
}
