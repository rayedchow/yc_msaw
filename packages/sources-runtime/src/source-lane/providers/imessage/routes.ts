import type { Context, Hono } from "hono";
import { sql } from "drizzle-orm";
import { enqueueTask } from "../../../queue/queue.js";
import { upsertTaskSchedule } from "../../../queue/sweeper.js";
import type { ExportContext, InternalRouteDeps } from "../../core/types.js";
import { ackImessageCommand, CommandError, listImessageCommands, nextImessageCommand, requestImessageCommand } from "./commands.js";
import { recordImessageLocalStatus, syncImessageContacts } from "./contacts.js";
import { imessageCoverage } from "./coverage.js";
import type { DeviceAuthority } from "./authority.js";
import { DEVICE_KEY_HEADER, parseDeviceKey } from "./device-auth.js";
import {
  authenticateImessageDevice,
  DeviceEnrollError,
  enrollImessageDevice,
  getImessageDevice,
  listImessageDevices,
  revokeImessageDevice,
  type DeviceContext,
} from "./devices.js";
import { IngestInputError, ingestImessageBatch } from "./ingest.js";
import { drainImessageProjections, markAllImessageProjectionsDirty } from "./projector.js";
import type { ImessageDb } from "./util.js";

/**
 * iMessage runtime routes.
 *
 * Admin (internal: mounted by core under /internal/v1 behind the server-held service token;
 * tenant from core's verified `x-procmem-principal`):
 *   POST   /tenants/:tenantId/devices/imessage                       enroll {bindingId, tokenSha256, label?, handles?}
 *   GET    /tenants/:tenantId/devices/imessage                       devices + coverage
 *   DELETE /tenants/:tenantId/devices/imessage/:bindingId            revoke (forwarded when yc_msaw revokes the binding)
 *   POST   /tenants/:tenantId/devices/imessage/:bindingId/commands   {type, backfillDays? | coverageFrom?, coverageTo?}
 *   GET    /tenants/:tenantId/devices/imessage/:bindingId/commands
 *   POST   /tenants/:tenantId/imessage/reproject
 * Uploader wire (public runtime host; the Mac's `apiUrl` is the runtime's public base URL):
 *   POST /api/imessage/ingest, POST /api/imessage/ingest/sync-contacts, POST /api/imessage/ingest/local-status,
 *   GET  /api/imessage/ingest/command, POST /api/imessage/ingest/command/ack
 * authenticated by the device key in `x-api-key` (device row + yc_msaw authority, device-auth.ts).
 * yc_msaw cannot host the wire itself: its mcp-use HTTP layer rejects the uploader's
 * `GET /command` (Content-Type: application/json, empty body) with 400 "Invalid JSON" before any route.
 * The tenant is never read from a body or query; the donor body `userId` is ignored.
 * Wire errors keep the donor shape `{error: string}` the uploader reads; retryable failures
 * say "503" so the uploader's retry classifier splits/re-sends instead of parking the batch.
 */

export const MAX_INGEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_SMALL_BODY_BYTES = 8 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 64 * 1024;
const SYNC_PROJECTION_BUDGET_MS = 10_000;
const COLLECTION_SCOPES = ["traces:write", "memory:build"];

export interface ImessageRouteDeps {
  db: ImessageDb;
  log?: (msg: string) => void;
}

export interface ImessagePublicRouteDeps extends ImessageRouteDeps {
  /** yc_msaw, asked per request whether the device key is still an active device binding. */
  authority: DeviceAuthority;
}

type Env = { Variables: { imessageDevice: DeviceContext } };

class BodyTooLarge extends Error {}

async function readBody(c: Context, max: number): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLarge();
  const stream = c.req.raw.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function readJson(c: Context, max: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await readBody(c, max);
  } catch (e) {
    if (e instanceof BodyTooLarge) return { ok: false, response: c.json({ error: `Request body exceeds ${max} bytes; send smaller batches` }, 413) };
    throw e;
  }
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: c.json({ error: "Invalid JSON body" }, 400) };
  }
}

function forwardedScopes(c: Context): string[] | null {
  try {
    const raw = JSON.parse(c.req.header("x-procmem-principal") ?? "") as Record<string, unknown>;
    return Array.isArray(raw.scopes) && raw.scopes.every((s) => typeof s === "string") ? (raw.scopes as string[]) : null;
  } catch {
    return null;
  }
}

function principalSubject(c: Context): { subject: string; issuer: string } | null {
  const p = c.get("principal" as never) as { subject?: unknown; issuer?: unknown } | undefined;
  return p && typeof p.subject === "string" && typeof p.issuer === "string" ? { subject: p.subject, issuer: p.issuer } : null;
}

/**
 * Device enrolment, commands and revocation are self-service (owner-only sources: a member enrols and commands their own
 * Mac); yc_msaw mints the binding and checks the owner, so this is defence in depth. Every other admin route keeps the
 * collection scopes.
 */
const ENROL_SCOPES = ["traces:write", "memory:build", "memory:read"];
function requireEnrolScope(c: Context): Response | null {
  const scopes = forwardedScopes(c);
  if (!scopes || !ENROL_SCOPES.some((s) => scopes.includes(s))) {
    return c.json({ error: { code: "insufficient_scope", message: `forwarded principal needs one of ${ENROL_SCOPES.join(", ")}` } }, 403);
  }
  return null;
}

/** Admin routes need a forwarded principal holding a collection scope (fail closed when scopes are absent). */
function requireCollectionScope(c: Context): Response | null {
  const scopes = forwardedScopes(c);
  if (!scopes || !COLLECTION_SCOPES.some((s) => scopes.includes(s))) {
    return c.json({ error: { code: "insufficient_scope", message: `forwarded principal needs one of ${COLLECTION_SCOPES.join(", ")}` } }, 403);
  }
  return null;
}

async function scheduleProjection(db: ImessageDb, tenantId: string, delaySeconds = 5): Promise<void> {
  await enqueueTask(
    { queue: "sync", tenantId, kind: "imessage.project", payload: { tenantId }, dedupeKey: `imessage.project:${tenantId}`, runAt: new Date(Date.now() + delaySeconds * 1000) },
    db,
  );
}

export function registerImessageInternalRoutes(app: Hono, deps: InternalRouteDeps, route: ImessageRouteDeps): void {
  const db = route.db;
  const log = route.log ?? ((m: string) => console.warn(`[imessage] ${m}`));
  const tenantOf = (c: Context) => deps.tenantOf(c as never);

  // ------------------------------------------------------------ admin
  app.post("/tenants/:tenantId/devices/imessage", async (c) => {
    const denied = requireEnrolScope(c);
    if (denied) return denied;
    const who = principalSubject(c);
    if (!who) return c.json({ error: { code: "principal_required", message: "verified principal required" } }, 401);
    const body = await readJson(c, MAX_ADMIN_BODY_BYTES);
    if (!body.ok) return body.response;
    const b = (body.value ?? {}) as Record<string, unknown>;
    const tenantId = tenantOf(c);
    try {
      const enrolled = await enrollImessageDevice(db, { tenantId, bindingId: b.bindingId, tokenSha256: b.tokenSha256, label: b.label, handles: b.handles, createdBy: who });
      // Projections are drained after every batch; this schedule re-arms anything a crash left dirty.
      await upsertTaskSchedule({ tenantId, kind: "imessage.project", frequencySeconds: 300, payload: { tenantId } }, db);
      return c.json(
        {
          device: enrolled.device,
          created: enrolled.created,
          wire: {
            header: DEVICE_KEY_HEADER,
            endpoints: ["POST /api/imessage/ingest", "POST /api/imessage/ingest/sync-contacts", "POST /api/imessage/ingest/local-status", "GET /api/imessage/ingest/command", "POST /api/imessage/ingest/command/ack"],
          },
        },
        enrolled.created ? 201 : 200,
      );
    } catch (e) {
      if (e instanceof DeviceEnrollError) return c.json({ error: { code: e.code, message: e.message } }, e.code === "binding_exists" ? 409 : 400);
      throw e;
    }
  });

  app.get("/tenants/:tenantId/devices/imessage", async (c) => {
    const tenantId = tenantOf(c);
    const ctx: ExportContext = { tenantId, executor: db };
    return c.json({ devices: await listImessageDevices(db, tenantId), coverage: await imessageCoverage(ctx) });
  });

  app.delete("/tenants/:tenantId/devices/imessage/:bindingId", async (c) => {
    const denied = requireEnrolScope(c);
    if (denied) return denied;
    const device = await db.transaction((tx) => revokeImessageDevice(tx, tenantOf(c), c.req.param("bindingId") ?? ""));
    return device ? c.json({ device, revoked: true }) : c.json({ error: { code: "not_found", message: "no iMessage device for this binding" } }, 404);
  });

  app.post("/tenants/:tenantId/devices/imessage/:bindingId/commands", async (c) => {
    const denied = requireEnrolScope(c);
    if (denied) return denied;
    const who = principalSubject(c);
    if (!who) return c.json({ error: { code: "principal_required", message: "verified principal required" } }, 401);
    const body = await readJson(c, MAX_ADMIN_BODY_BYTES);
    if (!body.ok) return body.response;
    try {
      const r = await requestImessageCommand(db, { tenantId: tenantOf(c), bindingId: c.req.param("bindingId") ?? "", body: body.value, requestedBy: `${who.issuer} ${who.subject}` });
      return c.json(r, 201);
    } catch (e) {
      if (e instanceof CommandError) return c.json({ error: { code: e.code, message: e.message } }, e.code === "not_found" ? 404 : e.code === "device_revoked" ? 409 : 400);
      throw e;
    }
  });

  app.get("/tenants/:tenantId/devices/imessage/:bindingId/commands", async (c) => {
    const tenantId = tenantOf(c);
    const bindingId = c.req.param("bindingId") ?? "";
    if (!(await getImessageDevice(db, tenantId, bindingId))) return c.json({ error: { code: "not_found", message: "no iMessage device for this binding" } }, 404);
    return c.json({ commands: await listImessageCommands(db, tenantId, bindingId) });
  });

  app.post("/tenants/:tenantId/imessage/reproject", async (c) => {
    const denied = requireCollectionScope(c);
    if (denied) return denied;
    const tenantId = tenantOf(c);
    const marked = await markAllImessageProjectionsDirty(db, tenantId);
    await scheduleProjection(db, tenantId, 0);
    return c.json({ marked });
  });

}

/** The five uploader endpoints on the runtime's public host (donor paths and response shapes). */
export function registerImessagePublicRoutes(app: Hono, route: ImessagePublicRouteDeps): void {
  const db = route.db;
  const log = route.log ?? ((m: string) => console.warn(`[imessage] ${m}`));
  const authed = async (c: Context<Env>, next: () => Promise<void>) => {
    const key = c.req.header(DEVICE_KEY_HEADER);
    // Check 1: an active device row whose hash matches (fails closed on a runtime revoke).
    const device = await authenticateImessageDevice(db, key);
    if (!device) return c.json({ error: "Unauthorized" }, 401);
    // Check 2: yc_msaw still holds an active device binding for exactly this key.
    const verdict = await route.authority.verify(key!, parseDeviceKey(key)!);
    if (verdict.state === "unavailable") {
      log(`authority unavailable for ${device.tenantId}/${device.bindingId}: ${verdict.reason}`);
      return c.json({ error: "Device authorization temporarily unavailable (503); retry" }, 503);
    }
    if (verdict.state === "revoked") {
      // Converge: the binding is gone in yc_msaw, so the runtime credential is revoked too.
      await db.transaction((tx) => revokeImessageDevice(tx, device.tenantId, device.bindingId, `revoked in yc_msaw (${verdict.reason})`)).catch((e) => log(`revoke after authority refusal failed: ${String(e)}`));
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("imessageDevice", device);
    await next();
  };
  const wire = app as unknown as Hono<Env>;
  // Hono's "/*" also matches the bare prefix, so this one registration covers all five routes.
  wire.use("/api/imessage/ingest/*", authed);

  const unavailable = (c: Context, what: string, e: unknown) => {
    log(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    return c.json({ error: `iMessage ${what} temporarily unavailable (503); retry` }, 503);
  };

  wire.post("/api/imessage/ingest", async (c) => {
    const device = c.get("imessageDevice");
    const body = await readJson(c, MAX_INGEST_BODY_BYTES);
    if (!body.ok) return body.response;
    let result;
    try {
      result = await ingestImessageBatch(db, device, body.value);
    } catch (e) {
      if (e instanceof IngestInputError) return c.json({ error: e.message }, 400);
      return unavailable(c, "ingest", e);
    }
    // The batch is committed; projections are best effort here and durable via the dirty table.
    let projection: { rendered: number; pending: number; error?: string };
    try {
      const p = await drainImessageProjections(db, device.tenantId, { budgetMs: SYNC_PROJECTION_BUDGET_MS });
      projection = { rendered: p.rendered, pending: p.pending };
    } catch (e) {
      projection = { rendered: 0, pending: -1, error: "projection deferred" };
      log(`projection failed for ${device.tenantId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (projection.pending !== 0) await scheduleProjection(db, device.tenantId).catch((e) => log(`projection schedule failed: ${String(e)}`));
    const { dirtyProjections, ...rest } = result;
    return c.json({ ...rest, projection: { ...projection, touched: dirtyProjections.length } });
  });

  wire.post("/api/imessage/ingest/sync-contacts", async (c) => {
    const device = c.get("imessageDevice");
    const body = await readJson(c, MAX_SMALL_BODY_BYTES);
    if (!body.ok) return body.response;
    try {
      const result = await syncImessageContacts(db, device, body.value);
      await drainImessageProjections(db, device.tenantId, { budgetMs: SYNC_PROJECTION_BUDGET_MS })
        .then((p) => (p.pending ? scheduleProjection(db, device.tenantId) : undefined))
        .catch(() => scheduleProjection(db, device.tenantId).catch(() => undefined));
      return c.json(result);
    } catch (e) {
      if (e instanceof IngestInputError) return c.json({ error: e.message }, 400);
      return unavailable(c, "contact sync", e);
    }
  });

  wire.post("/api/imessage/ingest/local-status", async (c) => {
    const device = c.get("imessageDevice");
    const body = await readJson(c, MAX_SMALL_BODY_BYTES);
    if (!body.ok) return body.response;
    try {
      return c.json({ ok: true, status: await recordImessageLocalStatus(db, device, body.value) });
    } catch (e) {
      return unavailable(c, "local status", e);
    }
  });

  wire.get("/api/imessage/ingest/command", async (c) => {
    try {
      return c.json({ command: await nextImessageCommand(db, c.get("imessageDevice")) });
    } catch (e) {
      return unavailable(c, "command fetch", e);
    }
  });

  wire.post("/api/imessage/ingest/command/ack", async (c) => {
    const body = await readJson(c, MAX_SMALL_BODY_BYTES);
    if (!body.ok) return body.response;
    try {
      return c.json(await ackImessageCommand(db, c.get("imessageDevice"), body.value));
    } catch (e) {
      if (e instanceof CommandError) return c.json({ error: e.message }, 400);
      return unavailable(c, "command ack", e);
    }
  });
}

/** Task: drain the tenant's dirty projections (enqueued after ingest, scheduled every 5 minutes per enrolled tenant). */
export function imessageTaskHandlers(db: ImessageDb) {
  return {
    "imessage.project": async (payload: Record<string, unknown>, ctx: { task: { tenantId: string }; heartbeat: () => Promise<void> }) => {
      const tenantId = typeof payload.tenantId === "string" && payload.tenantId ? payload.tenantId : ctx.task.tenantId;
      const r = await drainImessageProjections(db, tenantId);
      return { rendered: r.rendered, deleted: r.deleted, pending: r.pending };
    },
  };
}

/** Pending-only check used by tests and operators. */
export async function imessageProjectionBacklog(db: ImessageDb, tenantId: string): Promise<number> {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM imessage_projection_dirty WHERE tenant_id = ${tenantId}`)) as unknown as Array<{ n: number }>;
  return Number(r[0]?.n ?? 0);
}
