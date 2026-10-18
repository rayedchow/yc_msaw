import type { Context, Hono } from "hono";
import type { InternalRouteDeps } from "../../core/types.js";
import { NangoApiError } from "./api.js";
import { SOURCE_ID_RE } from "./config.js";
import { revokeConnection, sourceOf, tenantConnections } from "./connections.js";
import { controlCoverage, sourceCoverage } from "./coverage.js";
import { safeError, type NangoRecordsLane } from "./lane.js";
import { createSession, reconcileOpenSessions, SessionError, sessionStatus } from "./sessions.js";
import { enqueueSync } from "./sync.js";
import { loadCapabilities, modelsToPoll } from "./verify.js";

/**
 * Operational setup API for the generic Nango lane, mounted by core under /internal/v1 (service
 * token + `x-procmem-principal`; core already checked the URL tenant equals the verified
 * principal's tenantNs). Admin actions need memory:build, status needs memory:read, both read
 * from the forwarded principal's scopes (fail closed when absent). No body or query field can
 * name a tenant or user; the only body field is the configured source id.
 *
 *   GET    /tenants/:t/nango-records                                   configured vs refused sources, capability state,
 *                                                                      connections, coverage
 *   POST   /tenants/:t/nango-records/connect-sessions   {source}      -> {sessionId, token, connectLink, expiresAt}
 *   GET    /tenants/:t/nango-records/connect-sessions/:id              session state (reconciles through the Nango API)
 *   DELETE /tenants/:t/nango-records/connections/:source/:connectionId disconnect (deletes the Nango connection)
 *   POST   /tenants/:t/nango-records/sync               {source?}     enqueue an incremental read now
 */

const BUILD = "memory:build";
const READ = "memory:read";

interface Principal {
  subject: string;
  issuer: string;
  scopes?: readonly string[];
}

function principalFor(c: Context, scope: string): Principal | Response {
  const p = c.get("principal" as never) as Principal | undefined;
  if (!p || typeof p.subject !== "string" || !p.subject || typeof p.issuer !== "string") return c.json({ error: { code: "principal_required", message: "a verified yc_msaw principal is required" } }, 401);
  if (!Array.isArray(p.scopes) || !p.scopes.includes(scope)) return c.json({ error: { code: "insufficient_scope", message: `missing scope ${scope} on the forwarded principal` } }, 403);
  return p;
}

async function strictBody(c: Context, allowed: readonly string[]): Promise<Record<string, unknown> | Response> {
  const text = await c.req.text();
  if (text.length > 4096) return c.json({ error: { code: "invalid_input", message: "body too large" } }, 413);
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: { code: "invalid_input", message: "body must be JSON" } }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: { code: "invalid_input", message: "body must be a JSON object" } }, 400);
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) return c.json({ error: { code: "invalid_input", message: `unexpected field(s): ${extra.join(", ")} (tenant and account come from the verified principal)` } }, 400);
  return body as Record<string, unknown>;
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof SessionError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof NangoApiError) return c.json({ error: { code: "nango_error", message: safeError(error) } }, error.status === 429 ? 429 : 502);
  console.error("nango-records route failed:", safeError(error));
  return c.json({ error: { code: "internal_error", message: "Nango records request failed" } }, 500);
}

export async function laneStatus(lane: NangoRecordsLane, tenantId: string): Promise<Record<string, unknown>> {
  const conns = await tenantConnections(lane, tenantId);
  const sources = [];
  const coverage = [...(await controlCoverage(lane, tenantId))];
  for (const s of lane.catalog.sources) {
    const caps = await loadCapabilities(lane, s);
    const polled = new Set(modelsToPoll(s, caps).map((m) => m.model));
    sources.push({
      source: s.source,
      label: s.label,
      providerConfigKey: s.providerConfigKey,
      discoverModels: s.discoverModels,
      pollSeconds: s.pollSeconds,
      maxConcurrentSyncs: s.maxConcurrentSyncs,
      verification: { checkedAt: caps.checkedAt, integrationFound: caps.integrationFound, error: caps.error },
      models: [...caps.models].map(([model, cap]) => ({
        model,
        eventType: s.models.find((m) => m.model === model)?.eventType ?? model.trim().toLowerCase().replace(/\s+/gu, "_"),
        declared: s.models.some((m) => m.model === model),
        capability: cap.state,
        captured: polled.has(model),
        syncs: cap.syncs,
        trackDeletes: cap.trackDeletes,
        runs: cap.runs,
      })),
      connections: conns.filter((c) => c.source === s.source).map((c) => ({ connectionId: c.connectionId, status: c.status, error: c.lastError, boundVia: c.boundVia, connectedAt: c.createdAt, lastCheckedAt: c.lastReconciledAt })),
    });
    coverage.push(...(await sourceCoverage(lane, s, tenantId)));
  }
  return {
    tenantId,
    nango: { apiConfigured: Boolean(lane.api), webhookSigningConfigured: lane.signingKeys.length > 0 },
    sources,
    refused: lane.catalog.refused,
    configErrors: lane.catalog.errors,
    coverage,
  };
}

export function registerLaneInternalRoutes(app: Hono, deps: InternalRouteDeps, lane: () => NangoRecordsLane): void {
  const base = "/tenants/:tenantId/nango-records";

  app.get(base, async (c) => {
    const p = principalFor(c, READ);
    if (p instanceof Response) return p;
    try {
      return c.json(await laneStatus(lane(), deps.tenantOf(c)));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post(`${base}/connect-sessions`, async (c) => {
    const p = principalFor(c, BUILD);
    if (p instanceof Response) return p;
    const body = await strictBody(c, ["source"]);
    if (body instanceof Response) return body;
    if (typeof body.source !== "string" || !SOURCE_ID_RE.test(body.source)) return c.json({ error: { code: "invalid_input", message: "source must be a configured source id" } }, 400);
    try {
      const s = await createSession(lane(), { tenantId: deps.tenantOf(c), principal: { subject: p.subject, issuer: p.issuer }, source: body.source });
      return c.json(s, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get(`${base}/connect-sessions/:sessionId`, async (c) => {
    const p = principalFor(c, READ);
    if (p instanceof Response) return p;
    const l = lane();
    const tenantId = deps.tenantOf(c);
    const id = c.req.param("sessionId");
    try {
      let s = await sessionStatus(l, tenantId, id);
      if (!s) return c.json({ error: { code: "not_found", message: "connect session not found" } }, 404);
      if (s.state === "pending") {
        await reconcileOpenSessions(l, tenantId, { sessionId: s.sessionId, limit: 1 });
        s = (await sessionStatus(l, tenantId, id)) ?? s;
      }
      return c.json(s);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.delete(`${base}/connections/:source/:connectionId`, async (c) => {
    const p = principalFor(c, BUILD);
    if (p instanceof Response) return p;
    const source = c.req.param("source");
    const connectionId = c.req.param("connectionId");
    if (!SOURCE_ID_RE.test(source) || !connectionId || connectionId.length > 512) return c.json({ error: { code: "invalid_input", message: "invalid source or connection id" } }, 400);
    try {
      const r = await revokeConnection(lane(), deps.tenantOf(c), source, connectionId);
      if (!r) return c.json({ error: { code: "not_found", message: "no such connection for this tenant" } }, 404);
      return c.json({ source, connectionId, status: "revoked", nangoConnectionDeleted: r.remoteDeleted });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post(`${base}/sync`, async (c) => {
    const p = principalFor(c, BUILD);
    if (p instanceof Response) return p;
    const body = await strictBody(c, ["source"]);
    if (body instanceof Response) return body;
    if (body.source !== undefined && (typeof body.source !== "string" || !SOURCE_ID_RE.test(body.source))) return c.json({ error: { code: "invalid_input", message: "invalid source" } }, 400);
    const l = lane();
    const tenantId = deps.tenantOf(c);
    try {
      let enqueued = 0;
      for (const conn of await tenantConnections(l, tenantId, body.source as string | undefined)) {
        const s = conn.status === "active" ? sourceOf(l, conn) : undefined;
        if (!s) continue;
        for (const m of modelsToPoll(s, await loadCapabilities(l, s))) {
          if (await enqueueSync(l, { tenantId, providerConfigKey: conn.providerConfigKey, connectionId: conn.connectionId, model: m.model })) enqueued += 1;
        }
      }
      return c.json({ enqueued });
    } catch (error) {
      return failure(c, error);
    }
  });
}
