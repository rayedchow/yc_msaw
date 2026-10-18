/**
 * The production sources runtime, in process, for the Mac client end-to-end tests.
 *
 * - PGlite with the runtime's real migration plan.
 * - `createRuntimeApp` with the production iMessage and coding-sessions modules and their DEFAULT device authority,
 *   which asks yc_msaw over HTTP (`GET <tenant binding publishUrl>/v1/sources/devices/<provider>/verify`).
 * - yc_msaw is represented only by that verify endpoint on loopback. It answers like yc_msaw's
 *   `deviceKeyVerifyRoute`: 200 `{tenantNs, bindingId, provider}` for a key it issued, 401 once revoked, and it
 *   can be taken down (503). yc_msaw's own setup/verify routes are covered by the repo-root device tests.
 * - The core exporter publishes to an in-memory sink, so tests can assert the files that reach `sources/`.
 *
 * The runtime lives in this repository (packages/sources-runtime) and must be installed; nothing here falls back
 * to a sibling checkout.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = path.resolve(here, "../../../sources-runtime");
for (const dep of ["@electric-sql/pglite", "drizzle-orm", "hono", "@hono/node-server"]) {
  if (!existsSync(path.join(RUNTIME_DIR, "node_modules", dep))) {
    throw new Error(`packages/sources-runtime is not installed (missing ${dep}). Run \`npm ci --prefix packages/sources-runtime\` before the Mac client end-to-end tests; they do not skip.`);
  }
}

// Sequential on purpose: the runtime's module graph has import cycles, and concurrent dynamic imports of its
// entry points deadlock under vite-node.
const rt = (p: string) => import(/* @vite-ignore */ path.join(RUNTIME_DIR, p));
const { PGlite } = await rt("node_modules/@electric-sql/pglite/dist/index.js");
const { drizzle } = await rt("node_modules/drizzle-orm/pglite/index.js");
const migrations = await rt("src/source-lane/core/migrations.ts");
const registryMod = await rt("src/source-lane/registry.ts");
const bindingsMod = await rt("src/source-lane/export/bindings.ts");
const codingMod = await rt("src/integrations/coding-sessions/lane.ts");
const imessageAuth = await rt("src/source-lane/providers/imessage/device-auth.ts");
const imessageMod = await rt("src/source-lane/providers/imessage/index.ts");
const imessageCoverageMod = await rt("src/source-lane/providers/imessage/coverage.ts");
const exporterMod = await rt("src/source-lane/export/exporter.ts");
const appMod = await rt("src/source-lane/internal/app.ts");

export const codingSessionsCoverage = codingMod.codingSessionsCoverage as (ctx: { tenantId: string; executor: unknown }) => Promise<Array<Record<string, any>>>;
export const imessageCoverage = imessageCoverageMod.imessageCoverage as (ctx: { tenantId: string; executor: unknown }) => Promise<Array<Record<string, any>>>;

export interface Runtime {
  url: string;
  db: unknown;
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<T[]>;
  internal(method: string, route: string, tenant: string, body?: unknown): Promise<{ status: number; body: any }>;
  /** What the yc_msaw verify endpoint answers. */
  yc: { down: boolean; revoked: Set<string>; calls: number };
  /** A tenant whose source binding points the runtime's authority at the yc_msaw stub. */
  bindTenant(tenant: string): Promise<void>;
  enrollImessage(tenant: string): Promise<{ bindingId: string; key: string }>;
  enrollCodingSessions(tenant: string): Promise<{ bindingId: string; key: string }>;
  /** Run the core exporter until idle and return every change it has published for `tenant`, oldest first. */
  exportAll(tenant: string): Promise<Array<Record<string, any>>>;
  close(): Promise<void>;
}

const SERVICE_TOKEN = `svc_${randomBytes(24).toString("hex")}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newBindingId = () => `sb-${randomBytes(8).toString("hex")}`;

export async function startRuntime(): Promise<Runtime> {
  const pg = new PGlite();
  const db = drizzle(pg);
  for (const file of migrations.planMigrations().apply) await pg.exec(readFileSync(path.join(migrations.MIGRATIONS_DIR, file), "utf8"));

  // yc_msaw's device verify endpoint (deviceKeyVerifyRoute semantics), keyed by the keys it issued.
  const issued = new Map<string, { tenantNs: string; bindingId: string; provider: string }>();
  const yc = { down: false, revoked: new Set<string>(), calls: 0 };
  const verifyServer: Server = createServer((req, res) => {
    yc.calls++;
    const m = /^\/v1\/sources\/devices\/([a-z-]+)\/verify$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method !== "GET" || !m) return send(404, { error: "not found" });
    if (yc.down) return send(503, { error: "unavailable" });
    const key = String(req.headers["x-api-key"] ?? "");
    const who = issued.get(key);
    if (!who || who.provider !== m[1] || yc.revoked.has(who.bindingId)) return send(401, { error: "Unauthorized" });
    return send(200, who);
  });
  await new Promise<void>((r) => verifyServer.listen(0, "127.0.0.1", () => r()));
  const ycUrl = `http://127.0.0.1:${(verifyServer.address() as { port: number }).port}`;

  // Production provider modules with their default (HTTP yc_msaw) authorities.
  const registry = new registryMod.SourceProviderRegistry([
    imessageMod.createImessageProvider({ db }),
    codingMod.createCodingSessionsProvider({ db }),
  ]);
  const published: Array<Record<string, any>> = [];
  const publishSink = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "PUT" && url.pathname.startsWith("/v1/sources/blobs/")) return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/status-report") return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/publish") {
      const body = JSON.parse(String(init?.body)) as { batchId: string; changes: Array<Record<string, any>> };
      // The binding token (psb_<tenant>.<binding>.<secret>) names the tenant the batch was published for.
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const tenant = /^Bearer psb_([a-z0-9-]+)\./.exec(auth)?.[1] ?? "?";
      published.push(...body.changes.map((c) => ({ ...c, tenant })));
      return Response.json({
        batchId: body.batchId, commitId: `c-${published.length}`, seq: published.length,
        results: body.changes.map((c) => ({ path: c.path, outcome: c.op === "put" ? "created" : "deleted", versionId: c.op === "put" ? `v-${String(c.sha256).slice(0, 8)}` : null })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const exporter = new exporterMod.SourceExporter({ db, registry, fetchImpl: publishSink, log: () => {} });
  const app = appMod.createRuntimeApp({ db, registry, exporter, serviceTokenSha256: sha256(SERVICE_TOKEN), integrations: [], mountInternal: true });

  const { serve } = await import(/* @vite-ignore */ path.join(RUNTIME_DIR, "node_modules/@hono/node-server/dist/index.mjs"));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", overrideGlobalObjects: false });
  await new Promise((r) => setTimeout(r, 50));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const internal = async (method: string, route: string, tenant: string, body?: unknown) => {
    const res = await app.request(`/internal/v1${route}`, {
      method,
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/json",
        "x-procmem-principal": JSON.stringify({ tenantNs: tenant, subject: `user_${tenant}`, issuer: "https://auth.example.test", scopes: ["memory:build", "memory:read", "traces:write"] }),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: parsed as any };
  };

  return {
    url,
    db,
    yc,
    query: async (text, params = []) => (await pg.query(text, params)).rows,
    internal,
    async bindTenant(tenant) {
      const bindingId = newBindingId();
      await bindingsMod.setTenantBinding(db, { tenantId: tenant, bindingId, token: `psb_${tenant}.${bindingId}.${randomBytes(32).toString("base64url")}`, publishUrl: ycUrl, providers: ["*"] });
    },
    async enrollImessage(tenant) {
      const bindingId = newBindingId();
      const key = imessageAuth.deviceKeyForBindingToken(`psb_${tenant}.${bindingId}.${randomBytes(32).toString("base64url")}`) as string;
      const r = await internal("POST", `/tenants/${tenant}/devices/imessage`, tenant, { bindingId, tokenSha256: sha256(key), label: "Synthetic Mac" });
      if (r.status !== 201) throw new Error(`imessage enroll ${r.status}: ${JSON.stringify(r.body)}`);
      issued.set(key, { tenantNs: tenant, bindingId, provider: "imessage" });
      return { bindingId, key };
    },
    async enrollCodingSessions(tenant) {
      const bindingId = newBindingId();
      const key = `gcs_${tenant}.${bindingId}.${randomBytes(32).toString("base64url")}`;
      const r = await internal("POST", `/tenants/${tenant}/devices/coding-sessions`, tenant, { bindingId, tokenSha256: sha256(key), label: "Synthetic Mac" });
      if (r.status !== 201) throw new Error(`coding-sessions enroll ${r.status}: ${JSON.stringify(r.body)}`);
      issued.set(key, { tenantNs: tenant, bindingId, provider: "coding-sessions" });
      return { bindingId, key };
    },
    async exportAll(tenant) {
      for (let i = 0; i < 200; i++) {
        const r = await exporter.runOnce();
        if (r.deadLettered) throw new Error(`exporter dead-lettered ${r.deadLettered} change(s)`);
        if (r.claimed === 0) return published.filter((c) => c.tenant === tenant);
      }
      throw new Error("exporter did not drain");
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => verifyServer.close(() => r()));
      await pg.close();
    },
  };
}
