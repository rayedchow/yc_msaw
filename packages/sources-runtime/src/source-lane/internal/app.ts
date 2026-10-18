import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { setConnectionStatus } from "../../db/connections.js";
import { ensureTenant } from "../../db/tenants.js";
import { integrationById, integrations, registerIntegrationHttpRoutes } from "../../integrations/registry.js";
import type { AqueductIntegration } from "../../integrations/types.js";
import { disableTaskSchedules } from "../../queue/sweeper.js";
import { googleWorkspaceDelegationSetup } from "../../vault/google-auth.js";
import { deleteToken } from "../../vault/index.js";
import { DONOR, RUNTIME_VERSION } from "../core/donor.js";
import { COVERAGE_SCOPE_PREFIX, ensurePersonalScope, findPersonalScope, PERSONAL_CONNECT_INTEGRATIONS } from "../core/personal-scope.js";
import type { DbExecutor } from "../core/types.js";
import { deleteTenantBinding, getTenantBinding, setTenantBinding } from "../export/bindings.js";
import type { SourceExporter } from "../export/exporter.js";
import type { SourceProviderRegistry } from "../registry.js";

/**
 * Source-runtime HTTP surfaces.
 *
 * Public: /health, the donor's provider-authenticated OAuth callbacks and
 * webhooks (registerIntegrationHttpRoutes: state/signature verified by the donor
 * handlers), and provider modules' public routes. No tenant API, no API keys.
 *
 * Internal (/internal/v1, yc_msaw only): authenticated by a server-held service
 * token compared by sha256 in constant time. yc_msaw fills the tenant from its
 * verified principal and sends that principal as `x-procmem-principal`; the URL
 * tenant must equal the principal's tenantNs, and nothing reads a tenant or user
 * from the body. Without a configured service token every internal call is 503.
 */

export const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const PRINCIPAL_HEADER = "x-procmem-principal";

export interface ForwardedPrincipal {
  tenantNs: string;
  subject: string;
  issuer: string;
  email?: string;
  organizationId?: string;
  /** Effective scopes of the verified principal (yc_msaw authority); provider routes gate admin actions on them. */
  scopes?: string[];
}

export interface RuntimeAppDeps {
  db: DbExecutor;
  exporter: SourceExporter;
  registry: SourceProviderRegistry;
  /** sha256 hex of the internal service token (SOURCES_RUNTIME_SERVICE_TOKEN_SHA256). */
  serviceTokenSha256?: string;
  integrations?: AqueductIntegration[];
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function parseForwardedPrincipal(raw: string | undefined): ForwardedPrincipal | null {
  if (!raw || raw.length > 4_096) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.tenantNs !== "string" || !TENANT_RE.test(p.tenantNs)) return null;
    if (typeof p.subject !== "string" || !p.subject || p.subject.length > 512) return null;
    if (typeof p.issuer !== "string" || p.issuer.length > 512) return null;
    return {
      tenantNs: p.tenantNs,
      subject: p.subject,
      issuer: p.issuer,
      ...(typeof p.email === "string" ? { email: p.email.slice(0, 320) } : {}),
      ...(typeof p.organizationId === "string" ? { organizationId: p.organizationId.slice(0, 256) } : {}),
      ...(Array.isArray(p.scopes) && p.scopes.length <= 64 && p.scopes.every((s) => typeof s === "string")
        ? { scopes: (p.scopes as string[]).map((s) => s.slice(0, 128)) }
        : {}),
    };
  } catch {
    return null;
  }
}

type InternalEnv = { Variables: { principal: ForwardedPrincipal; tenantId: string } };

/** The verified principal of an internal request (set by the internal middleware). */
export function internalPrincipal(c: Context<InternalEnv>): ForwardedPrincipal {
  return c.get("principal");
}

export function createInternalApp(deps: RuntimeAppDeps): Hono<InternalEnv> {
  const app = new Hono<InternalEnv>();
  const expected = deps.serviceTokenSha256 && /^[0-9a-f]{64}$/.test(deps.serviceTokenSha256) ? Buffer.from(deps.serviceTokenSha256, "hex") : null;
  const list = deps.integrations ?? integrations;
  const byId = (id: string) => list.find((i) => i.id === id) ?? integrationById(id);

  app.use("*", async (c, next) => {
    if (!expected) return c.json({ error: { code: "internal_api_disabled", message: "SOURCES_RUNTIME_SERVICE_TOKEN_SHA256 is not configured" } }, 503);
    const token = /^Bearer[ ]+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token || !timingSafeEqual(sha256(token), expected)) return c.json({ error: { code: "unauthorized", message: "invalid service token" } }, 401);
    await next();
  });

  // Every tenant route: URL tenant must be a namespace and equal the forwarded principal's.
  app.use("/tenants/:tenantId/*", async (c, next) => {
    const tenantId = c.req.param("tenantId");
    const principal = parseForwardedPrincipal(c.req.header(PRINCIPAL_HEADER));
    if (!tenantId || !TENANT_RE.test(tenantId)) return c.json({ error: { code: "invalid_tenant", message: "invalid tenant namespace" } }, 400);
    if (!principal || principal.tenantNs !== tenantId) {
      return c.json({ error: { code: "principal_mismatch", message: `${PRINCIPAL_HEADER} must carry the verified principal of this tenant` } }, 403);
    }
    c.set("principal", principal);
    c.set("tenantId", tenantId);
    await next();
  });

  app.put("/tenants/:tenantId/binding", async (c) => {
    const tenantId = c.get("tenantId");
    const body = (await c.req.json().catch(() => null)) as { bindingId?: unknown; token?: unknown; publishUrl?: unknown; providers?: unknown } | null;
    if (!body || typeof body.bindingId !== "string" || typeof body.token !== "string" || typeof body.publishUrl !== "string") {
      return c.json({ error: { code: "invalid_input", message: "bindingId, token and publishUrl are required" } }, 400);
    }
    const providers = Array.isArray(body.providers) && body.providers.every((p) => typeof p === "string") ? (body.providers as string[]) : ["*"];
    try {
      await ensureTenant({ id: tenantId, name: tenantId, metadata: { source: "yc_msaw", subject: internalPrincipal(c).subject } }, deps.db);
      await setTenantBinding(deps.db, { tenantId, bindingId: body.bindingId, token: body.token, publishUrl: body.publishUrl, providers });
    } catch (error) {
      return c.json({ error: { code: "invalid_binding", message: (error as Error).message } }, 400);
    }
    const backfill = await deps.exporter.enqueueTenantBackfill(tenantId);
    return c.json({ tenantId, bindingId: body.bindingId, backfill });
  });

  app.delete("/tenants/:tenantId/binding", async (c) => c.json({ tenantId: c.get("tenantId"), removed: await deleteTenantBinding(deps.db, c.get("tenantId")) }));

  app.post("/tenants/:tenantId/backfill", async (c) => c.json({ tenantId: c.get("tenantId"), backfill: await deps.exporter.enqueueTenantBackfill(c.get("tenantId")) }));

  app.get("/tenants/:tenantId/status", async (c) => {
    const tenantId = c.get("tenantId");
    const connections = (await deps.db.execute(sql`
      SELECT provider, status, external_account_id, created_at, updated_at FROM connections WHERE tenant_id = ${tenantId} ORDER BY provider
    `)) as unknown as Array<Record<string, unknown>>;
    const binding = await getTenantBinding(deps.db, tenantId);
    // The caller's own personal accounts (its owner scope); other members' scopes are never listed here.
    const scope = await findPersonalScope(deps.db, internalPrincipal(c));
    const personal = scope
      ? (await deps.db.execute(sql`
          SELECT provider, status, external_account_id, created_at, updated_at FROM connections WHERE tenant_id = ${scope.scopeTenantId} ORDER BY provider
        `)) as unknown as Array<Record<string, unknown>>
      : [];
    return c.json({
      tenantId,
      runtime: { version: RUNTIME_VERSION, donor: DONOR },
      binding: binding ? { bindingId: binding.bindingId, publishUrl: binding.publishUrl, providers: binding.providers } : null,
      connections,
      personal: scope ? { segment: scope.segment, connections: personal } : null,
      // Owner-scoped coverage of other members is not the caller's business.
      coverage: (await deps.exporter.coverage(tenantId)).filter((r) => !r.scope.startsWith(COVERAGE_SCOPE_PREFIX) || (scope !== null && r.scope.startsWith(`${COVERAGE_SCOPE_PREFIX}${scope.segment}/`))),
    });
  });

  app.get("/tenants/:tenantId/connect/google/setup", (c) => c.json(googleWorkspaceDelegationSetup()));

  // Donor connect handlers (Nango connect sessions, OAuth start URLs, DWD activation, API-key connectors).
  app.post("/tenants/:tenantId/connect/:provider", async (c) => {
    const integration = byId(c.req.param("provider"));
    if (!integration?.connect) return c.json({ error: { code: "provider_not_found", message: "provider not found" } }, 404);
    const body = await c.req.json().catch(() => null);
    // A personal account is connected into the caller's own owner scope (core/personal-scope.ts): its credential,
    // lane state and rows never mix with another member's, and yc_msaw serves them to this principal only.
    const tenantId = PERSONAL_CONNECT_INTEGRATIONS[c.req.param("provider")] ? (await ensurePersonalScope(deps.db, internalPrincipal(c))).scopeTenantId : c.get("tenantId");
    const result = await integration.connect({ tenantId, body });
    return c.json(result.body, result.status as ContentfulStatusCode);
  });

  // Donor disconnect sequence (aqueduct src/api/app.ts DELETE /v1/connections/:provider).
  app.delete("/tenants/:tenantId/connections/:provider", async (c) => {
    const provider = c.req.param("provider");
    const integration = byId(provider);
    if (!integration) return c.json({ error: { code: "provider_not_found", message: "provider not found" } }, 404);
    let tenantId = c.get("tenantId");
    if (PERSONAL_CONNECT_INTEGRATIONS[provider]) {
      // Each member disconnects their own account. An organization-level connection of a personal integration
      // (connected before owner scopes existed; its data stays sealed) is stopped only by an admin, explicitly.
      const legacy = c.req.query("legacy") === "organization";
      if (legacy && !internalPrincipal(c).scopes?.includes("memory:build")) {
        return c.json({ error: { code: "forbidden", message: "Only an admin stops an organization-level legacy connection" } }, 403);
      }
      if (!legacy) {
        const scope = await findPersonalScope(deps.db, internalPrincipal(c));
        if (!scope) return c.json({ error: { code: "not_connected", message: `No ${provider} account of yours is connected` } }, 404);
        tenantId = scope.scopeTenantId;
      }
    }
    await integration.disconnect?.({ tenantId });
    await deleteToken(tenantId, provider);
    await Promise.all((integration.taskKinds?.() ?? []).map((kind) => disableTaskSchedules(tenantId, kind)));
    await setConnectionStatus(tenantId, provider, "revoked");
    return c.json({ provider, status: "revoked" });
  });

  const providerApp = new Hono<InternalEnv>();
  for (const m of deps.registry.modules) m.internalRoutes?.(providerApp as unknown as Hono, { tenantOf: (ctx) => (ctx as unknown as Context<InternalEnv>).get("tenantId") });
  app.route("/", providerApp);
  return app;
}

/** Public runtime app: health, donor provider callbacks/webhooks, provider public routes, optional internal mount. */
export function createRuntimeApp(deps: RuntimeAppDeps & { mountInternal?: boolean }): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, runtime: RUNTIME_VERSION, donorCommit: DONOR.commit, lane: "source-only" }));
  registerIntegrationHttpRoutes(app, deps.integrations ?? integrations);
  for (const m of deps.registry.modules) m.publicRoutes?.(app);
  if (deps.mountInternal) app.route("/internal/v1", createInternalApp(deps) as unknown as Hono);
  return app;
}
