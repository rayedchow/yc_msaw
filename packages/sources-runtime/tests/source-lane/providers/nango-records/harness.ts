import { createHash, createHmac, randomBytes } from "node:crypto";
import { dequeueTask, failTask, succeedTask, type TaskHandler } from "../../../../src/queue/queue.js";
import { createRuntimeApp } from "../../../../src/source-lane/internal/app.js";
import { SourceExporter } from "../../../../src/source-lane/export/exporter.js";
import type { DbExecutor, SourceProviderModule } from "../../../../src/source-lane/core/types.js";
import { SourceProviderRegistry } from "../../../../src/source-lane/registry.js";
import { NangoHttpApi } from "../../../../src/source-lane/providers/nango-records/api.js";
import { createNangoRecordsModules } from "../../../../src/source-lane/providers/nango-records/index.js";
import { laneFromEnv, type NangoRecordsLane } from "../../../../src/source-lane/providers/nango-records/lane.js";
import { laneTaskHandlers } from "../../../../src/source-lane/providers/nango-records/sync.js";
import { FakeNango } from "./fake-nango.js";
import { db as pgDb, pg, ready } from "./pg.js";

/**
 * Harness for the generic Nango lane: real migrations on PGlite, the production lane modules
 * mounted in the real runtime app (service token + forwarded-principal middleware), the
 * production NangoHttpApi talking to FakeNango, and the real task queue SQL.
 */

export { FakeNango, pg, ready };
export const db = pgDb as unknown as DbExecutor;
export const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;
export const SIGNING_KEY = "nango-webhook-signing-key-for-tests";
export const PREVIOUS_SIGNING_KEY = "nango-webhook-signing-key-before-rotation";

/** Specialized modules standing in for the real registry (ids/event sources/connection providers they own). */
export const SPECIALIZED: SourceProviderModule[] = [
  { id: "github", eventSources: ["github"], mirrorRoots: ["sources/github/"] },
  { id: "gmail", eventSources: ["gmail"], mirrorRoots: [] },
  { id: "google-docs", eventSources: ["gdocs"], mirrorRoots: [], connectionProviders: ["google"] },
];

export const DEFAULT_CONFIG = {
  version: 1,
  sources: [
    { source: "outlook", providerConfigKey: "acme-outlook", label: "Outlook mail", models: ["OutlookMessage", { model: "OutlookEvent", eventType: "outlook_calendar_event" }], pollSeconds: 300, maxConcurrentSyncs: 2 },
    { source: "hubspot", providerConfigKey: "acme-hubspot", models: [], discoverModels: true },
  ],
};

export interface Setup {
  lane: NangoRecordsLane;
  nango: FakeNango;
  modules: SourceProviderModule[];
  registry: SourceProviderRegistry;
  app: ReturnType<typeof createRuntimeApp>;
  handlers: Record<string, TaskHandler>;
  delegated: Array<{ body: string; signature: string }>;
  clock: { offsetMs: number };
}

export function setup(opts: { config?: unknown; env?: Record<string, string>; noApi?: boolean } = {}): Setup {
  const nango = new FakeNango();
  const delegated: Setup["delegated"] = [];
  const clock = { offsetMs: 0 };
  const env = {
    NANGO_RECORDS_CONFIG: JSON.stringify(opts.config ?? DEFAULT_CONFIG),
    NANGO_WEBHOOK_SIGNING_KEY: SIGNING_KEY,
    NANGO_RECORDS_MIN_REQUEST_INTERVAL_MS: "1",
    ...(opts.env ?? {}),
  };
  const lane = laneFromEnv(env, SPECIALIZED, {
    db,
    api: opts.noApi ? null : new NangoHttpApi({ secretKey: nango.secretKey, baseUrl: "https://api.nango.test", fetchImpl: nango.fetch }),
    now: () => new Date(Date.now() + clock.offsetMs),
    log: () => {},
    delegateWebhook: async (body, signature) => {
      delegated.push({ body, signature });
      return { status: 204 };
    },
  });
  const modules = createNangoRecordsModules(lane);
  const registry = new SourceProviderRegistry([...SPECIALIZED, ...modules]);
  const app = createRuntimeApp({
    db: db as never,
    registry,
    exporter: new SourceExporter({ db: db as never, registry, log: () => {} }),
    serviceTokenSha256: createHash("sha256").update(SERVICE_TOKEN).digest("hex"),
    integrations: [],
    mountInternal: true,
  });
  return { lane, nango, modules, registry, app, handlers: laneTaskHandlers(() => lane), delegated, clock };
}

export async function reset(): Promise<void> {
  await ready;
  await pg.exec(`
    TRUNCATE nango_records_connect_sessions, nango_records_connections, nango_records_checkpoints, nango_records_quota, nango_records_slots,
      nango_records_webhook_deliveries, nango_records_verification, nango_records_capabilities, nango_records_unconfigured_models,
      nango_records_tenant_state, activity_events, task_queue, task_schedules, connections, outbox_events, source_lane_journal CASCADE;
  `);
}

export function principal(tenantNs: string, scopes: string[] = ["memory:read", "memory:build"]) {
  return JSON.stringify({ tenantNs, subject: `user-${tenantNs}`, issuer: "https://auth.example.test", scopes });
}

export function internal(s: Setup, method: string, route: string, body?: unknown, opts: { tenant?: string; urlTenant?: string; scopes?: string[] } = {}) {
  const tenant = opts.tenant ?? "acme";
  return s.app.request(`/internal/v1/tenants/${opts.urlTenant ?? tenant}${route}`, {
    method,
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, "x-procmem-principal": principal(tenant, opts.scopes), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

export function hmac(body: string, key = SIGNING_KEY): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

export function webhook(s: Setup, payload: unknown, opts: { key?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const body = opts.raw ?? JSON.stringify(payload);
  return s.app.request("/webhooks/nango-records", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.headers ?? { "X-Nango-Hmac-Sha256": hmac(body, opts.key) }) },
    body,
  });
}

/** Run due queued tasks through the real dequeue/succeed/fail SQL. */
export async function runTasks(s: Setup, opts: { max?: number } = {}): Promise<Array<{ kind: string; output: unknown; error?: string }>> {
  const out: Array<{ kind: string; output: unknown; error?: string }> = [];
  for (let i = 0; i < (opts.max ?? 50); i++) {
    const task = await dequeueTask(["sync"], db);
    if (!task) break;
    const handler = s.handlers[task.kind];
    if (!handler) {
      await failTask(task.id, `no handler ${task.kind}`, db);
      out.push({ kind: task.kind, output: null, error: "no handler" });
      continue;
    }
    try {
      const output = await handler(task.payload, { task, heartbeat: async () => {} });
      await succeedTask(task.id, (output ?? undefined) as Record<string, unknown> | undefined, db);
      out.push({ kind: task.kind, output });
    } catch (error) {
      await failTask(task.id, String(error), db);
      out.push({ kind: task.kind, output: null, error: String(error) });
    }
  }
  return out;
}

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}

/** Bind a connection to a tenant the way production does: a server-created session consumed by a signed auth webhook. */
export async function connect(s: Setup, tenant: string, source: string, connectionId: string): Promise<void> {
  const res = await internal(s, "POST", "/nango-records/connect-sessions", { source }, { tenant });
  if (res.status !== 201) throw new Error(`connect session failed: ${res.status} ${await res.text()}`);
  const session = s.nango.sessions[s.nango.sessions.length - 1]!;
  const tags = session.tags as Record<string, string>;
  const pck = (session.allowed_integrations as string[])[0]!;
  s.nango.addConnection({ connection_id: connectionId, provider_config_key: pck, tags });
  const hook = await webhook(s, { type: "auth", operation: "creation", connectionId, providerConfigKey: pck, provider: "microsoft", authMode: "OAUTH2", environment: "DEV", success: true, tags });
  if (hook.status !== 204) throw new Error(`auth webhook failed: ${hook.status}`);
}
