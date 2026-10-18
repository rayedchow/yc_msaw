import { z } from "zod";
import { bearerChallenge } from "../auth/http.js";
import type { Principal } from "../auth/mcp.js";
import { SCOPES } from "../auth/scopes.js";
import { parseContentType, readBoundedBody, TraceIngestError } from "../traces/ingest.js";
import { errorMessage } from "../util.js";
import { createHash } from "node:crypto";
import { DEVICE_KEY_PREFIXES, deviceKeyForBindingToken, looksLikeBindingToken, type BindingKind, type VerifiedBinding } from "./bindings.js";
import { SourceError } from "./paths.js";
import type { GoogleAuthAction, NangoRecordsAction, RuntimeResponse, SourceRuntimeClient } from "./runtime-client.js";
import { COVERAGE_STATES, type SourceService, type StatusReport } from "./service.js";
import { CHUNK_BYTES, MAX_BATCH_CHANGES, MAX_INLINE_BYTES, parseJsonDict, SOURCE_KINDS, type PublishBatch } from "./store.js";

/**
 * HTTP surface of the sources/ subsystem.
 *
 * Admin routes take a principal already verified by `authenticateHttp` (the
 * existing WorkOS/OIDC/static-key authority); the namespace is always
 * `principal.tenantNs`. Publish routes accept ONLY binding tokens (`psb_…`),
 * resolved server-side to the namespace recorded when an admin created the
 * binding. No route reads a tenant from the URL, query or body.
 */

export const SOURCE_BLOB_CONTENT_TYPE = "application/vnd.procmem.source-blob";
export const MAX_PUBLISH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const MAX_STATUS_BODY_BYTES = 256 * 1024;
const SHA_RE = /^[0-9a-f]{64}$/;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, message, ...extra } });
}

const SOURCE_ERROR_STATUS: Record<string, number> = {
  invalid_path: 400,
  invalid_input: 400,
  not_found: 404,
  not_a_file: 400,
  not_a_directory: 400,
  path_conflict: 409,
  forbidden_provider: 403,
  missing_blobs: 409,
  integrity: 422,
  conflict: 409,
  batch_conflict: 409,
  too_large: 413,
};

export function sourceErrorResponse(e: unknown): Response {
  if (e instanceof SourceError) return error(SOURCE_ERROR_STATUS[e.code] ?? 400, e.code, e.message, e.details ?? {});
  if (e instanceof TraceIngestError) return error(e.status, e.code, e.message);
  if (e instanceof z.ZodError) return error(400, "invalid_input", e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return error(500, "internal_error", `Sources request failed: ${errorMessage(e)}`);
}

async function readJson(request: Request, max: number): Promise<unknown> {
  const body = await readBoundedBody(request, max, max);
  if (body.length === 0) return {};
  try {
    // Null-prototype objects: provider names such as "__proto__" stay ordinary keys.
    return parseJsonDict(body.toString("utf8"));
  } catch {
    throw new SourceError("invalid_input", "Body must be JSON");
  }
}

// ------------------------------------------------------------ schemas

const ProviderId = z.string().regex(/^(\*|[a-z0-9][a-z0-9-]{0,62})$/);

export const CreateBindingSchema = z
  .object({
    kind: z.enum(["runtime", "device"]).default("runtime"),
    providers: z.array(ProviderId).min(1).max(32),
    label: z.string().max(200).optional(),
  })
  .strict();

const IsoTime = z.string().max(40);
// Validated in place (z.record would rebuild the object and drop keys such as "__proto__").
const Provenance = z.custom<Record<string, unknown>>((v) => v !== null && typeof v === "object" && !Array.isArray(v), "provenance must be an object");
const SourceVersionSchema = z
  .object({ ref: z.string().min(1).max(200), ordinal: z.number().finite().optional() })
  .strict();

const PutChangeSchema = z
  .object({
    op: z.literal("put"),
    path: z.string().min(1).max(4_200),
    kind: z.enum(SOURCE_KINDS as [string, ...string[]]),
    contentType: z.string().min(3).max(200),
    sha256: z.string().regex(SHA_RE),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    chunks: z.array(z.string().regex(SHA_RE)).max(100_000).optional(),
    inline: z.string().max(Math.ceil(MAX_INLINE_BYTES / 3) * 4 + 4).optional(),
    sourceUpdatedAt: IsoTime.nullable().optional(),
    sourceVersion: SourceVersionSchema.nullable().optional(),
    capturedAt: IsoTime,
    provenance: Provenance.optional(),
  })
  .strict();

const DeleteChangeSchema = z
  .object({
    op: z.literal("delete"),
    path: z.string().min(1).max(4_200),
    deletedAt: IsoTime,
    reason: z.string().min(1).max(200),
    capturedAt: IsoTime,
    provenance: Provenance.optional(),
  })
  .strict();

export const PublishSchema = z
  .object({
    batchId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    changes: z.array(z.discriminatedUnion("op", [PutChangeSchema, DeleteChangeSchema])).max(MAX_BATCH_CHANGES),
  })
  .strict();

export const StatusReportSchema = z
  .object({
    providers: z
      .array(
        z
          .object({
            provider: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
            scope: z.string().min(1).max(300),
            state: z.enum(COVERAGE_STATES as [string, ...string[]]),
            reason: z.string().max(2_000).optional(),
            cursor: z.string().max(500).optional(),
            lastSuccessAt: IsoTime.optional(),
            lastErrorAt: IsoTime.optional(),
            lastError: z.string().max(2_000).optional(),
            counts: z.record(z.string().max(100), z.number().int().nonnegative()).optional(),
          })
          .strict(),
      )
      .max(500),
    runtime: z
      .object({
        version: z.string().max(100).optional(),
        donorCommit: z.string().max(64).optional(),
        host: z.string().max(200).optional(),
        reportIntervalSeconds: z.number().int().min(10).max(86_400).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ------------------------------------------------------------ admin routes (verified principal)

export async function createBindingRoute(request: Request, principal: Principal, service: SourceService): Promise<Response> {
  try {
    const input = CreateBindingSchema.parse(await readJson(request, MAX_ADMIN_BODY_BYTES));
    // Connector runtimes are administrative collection (memory:build). Device uploaders
    // (a user's own Mac) need the collection scope traces:write and are limited to device providers.
    const need = input.kind === "runtime" ? SCOPES.memoryBuild : SCOPES.tracesWrite;
    if (!principal.scopes.includes(need) && !principal.scopes.includes(SCOPES.memoryBuild)) {
      return bearerChallenge({ status: 403, error: "insufficient_scope", description: `Missing required scope: ${need}`, scope: need });
    }
    const created = await service.bindings.create(
      principal.tenantNs,
      { kind: input.kind as BindingKind, providers: input.providers, ...(input.label !== undefined ? { label: input.label } : {}) },
      { subject: principal.subject, issuer: principal.issuer },
    );
    return json(201, { ...created, note: "The token is shown once. It can only publish to the listed provider directories of this tenant." });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function listBindingsRoute(principal: Principal, service: SourceService): Promise<Response> {
  try {
    return json(200, { bindings: await service.bindings.list(principal.tenantNs) });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function revokeBindingRoute(principal: Principal, service: SourceService, bindingId: string, runtime?: SourceRuntimeClient): Promise<Response> {
  try {
    const b = await service.bindings.revoke(principal.tenantNs, bindingId);
    if (!b) return error(404, "not_found", `No binding ${bindingId}`);
    // Revocation here is authoritative and immediate: the runtime asks deviceKeyVerifyRoute on every
    // uploader request. The runtime's own credential is revoked too so both agree; a failure is reported.
    if (b.kind !== "device" || b.transport !== "runtime-ingest") return json(200, { binding: b });
    const runtimeDevices: Record<string, unknown> = {};
    for (const provider of b.providers.filter((p) => DEVICE_KEY_PREFIXES[p])) {
      if (!runtime) {
        runtimeDevices[provider] = { revoked: false, reason: "source runtime not configured" };
        continue;
      }
      try {
        const r = await runtime.deviceRevoke(principal, provider, b.bindingId);
        runtimeDevices[provider] = r.status === 200 || r.status === 404 ? { revoked: true, status: r.status } : { revoked: false, status: r.status, runtime: r.body };
      } catch (e) {
        runtimeDevices[provider] = { revoked: false, reason: `runtime unreachable: ${errorMessage(e)}` };
      }
    }
    return json(200, { binding: b, runtimeDevices });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function statusRoute(principal: Principal, service: SourceService): Promise<Response> {
  try {
    return json(200, await service.status(principal.tenantNs));
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

// ------------------------------------------------------------ publish routes (binding token)

/** Resolve the binding token on a publish request, or a ready 401. */
export async function authenticateBinding(request: Request, service: SourceService): Promise<VerifiedBinding | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer[ ]+([^\s]+)\s*$/i.exec(header)?.[1];
  if (!token || !looksLikeBindingToken(token)) {
    return bearerChallenge({ status: 401, error: "invalid_token", description: "Publishing requires a source binding token (psb_...)" });
  }
  const verified = await service.bindings.verify(token);
  if (!verified) return bearerChallenge({ status: 401, error: "invalid_token", description: "Unknown or revoked source binding" });
  // Device uploaders whose raw data goes to the runtime receiver never publish files themselves.
  if (verified.binding.transport === "runtime-ingest") {
    return bearerChallenge({ status: 403, error: "insufficient_scope", description: "This device binding uploads to the source runtime and cannot publish" });
  }
  return verified;
}

export async function putBlobRoute(request: Request, service: SourceService, sha: string): Promise<Response> {
  try {
    const auth = await authenticateBinding(request, service);
    if (auth instanceof Response) return auth;
    if (!SHA_RE.test(sha)) return error(400, "invalid_blob_id", "Blob id must be a lowercase sha256 hex digest");
    const ct = parseContentType(request.headers.get("content-type"));
    // Some hosts decode request bodies as UTF-8 text; base64 keeps binary intact end to end.
    const base64 = ct.type === SOURCE_BLOB_CONTENT_TYPE && ct.params.encoding === "base64";
    const body = await readBoundedBody(request, base64 ? Math.ceil(CHUNK_BYTES / 3) * 4 + 1024 : CHUNK_BYTES, CHUNK_BYTES, { base64 });
    const stored = await service.storeFor(auth.tenantNs).putBlob(body, sha);
    return json(201, { ...stored, stored: true });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function publishRoute(request: Request, service: SourceService): Promise<Response> {
  try {
    const auth = await authenticateBinding(request, service);
    if (auth instanceof Response) return auth;
    const batch = PublishSchema.parse(await readJson(request, MAX_PUBLISH_BODY_BYTES)) as PublishBatch;
    const receipt = await service
      .storeFor(auth.tenantNs)
      .applyBatch({ bindingId: auth.binding.bindingId, providers: auth.binding.providers }, batch);
    return json(200, receipt);
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function statusReportRoute(request: Request, service: SourceService): Promise<Response> {
  try {
    const auth = await authenticateBinding(request, service);
    if (auth instanceof Response) return auth;
    const report = StatusReportSchema.parse(await readJson(request, MAX_STATUS_BODY_BYTES)) as StatusReport;
    const stored = await service.reportStatus(auth.tenantNs, auth.binding, report);
    return json(200, { bindingId: stored.bindingId, receivedAt: stored.receivedAt, providers: report.providers.length });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

// ------------------------------------------------------------ runtime forwarding (verified principal -> runtime internal API)

function relay(r: RuntimeResponse): Response {
  return json(r.status, r.body ?? {});
}

async function readOptionalJson(request: Request): Promise<unknown> {
  return readJson(request, MAX_ADMIN_BODY_BYTES);
}

/** Mint a runtime binding for the caller's tenant and hand it to the runtime; the token never leaves the servers. */
export async function provisionRuntimeRoute(principal: Principal, service: SourceService, runtime: SourceRuntimeClient): Promise<Response> {
  try {
    const { binding, token } = await service.bindings.create(principal.tenantNs, { kind: "runtime", providers: ["*"], label: "sources-runtime" }, { subject: principal.subject, issuer: principal.issuer });
    let r: RuntimeResponse;
    try {
      r = await runtime.provisionBinding(principal, { bindingId: binding.bindingId, token, providers: ["*"] });
    } catch (e) {
      await service.bindings.revoke(principal.tenantNs, binding.bindingId);
      return error(502, "runtime_unreachable", `Source runtime did not accept the binding: ${errorMessage(e)}`);
    }
    if (r.status >= 300) {
      await service.bindings.revoke(principal.tenantNs, binding.bindingId);
      return json(502, { error: { code: "runtime_rejected", message: "Source runtime rejected the binding", runtime: r.body } });
    }
    return json(201, { binding, runtime: r.body });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function runtimeStatusRoute(principal: Principal, runtime: SourceRuntimeClient): Promise<Response> {
  try {
    return relay(await runtime.status(principal));
  } catch (e) {
    return error(502, "runtime_unreachable", errorMessage(e));
  }
}

export async function connectRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, provider: string): Promise<Response> {
  try {
    return relay(await runtime.connect(principal, provider, await readOptionalJson(request)));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

export async function disconnectRoute(principal: Principal, runtime: SourceRuntimeClient, provider: string): Promise<Response> {
  try {
    return relay(await runtime.disconnect(principal, provider));
  } catch (e) {
    return e instanceof SourceError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

/** Device enrolment (e.g. iMessage uploader): collection scope; the runtime binds the device to this principal. */
export async function deviceRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, provider: string): Promise<Response> {
  if (!principal.scopes.includes(SCOPES.tracesWrite) && !principal.scopes.includes(SCOPES.memoryBuild)) {
    return bearerChallenge({ status: 403, error: "insufficient_scope", description: `Missing required scope: ${SCOPES.tracesWrite}`, scope: SCOPES.tracesWrite });
  }
  // Devices with a binding-backed setup route are enrolled only through it (the server mints the credential).
  if (DEVICE_KEY_PREFIXES[provider]) return error(400, "use_device_setup", `Enrol ${provider} devices with POST /v1/sources/devices/${provider}/setup`);
  try {
    return relay(await runtime.device(principal, provider, await readOptionalJson(request)));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

// ------------------------------------------------------------ iMessage device setup + device-key authority

export const ImessageDeviceSetupSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    /** The user's own iMessage handles (phone / Apple ID email) on this Mac. */
    handles: z.array(z.string().min(1).max(320)).max(50).optional(),
    /** Echoed into the uploader config: days of history to backfill (null = all history). */
    backfillDays: z.union([z.number().int().min(1).max(36_500), z.null()]).optional(),
    /** Echoed into the uploader config: chat ids chosen on the Mac (or ["all"]). */
    allowedChatIds: z.array(z.string().min(1).max(500)).max(5_000).optional(),
  })
  .strict();

/**
 * Enrol a Mac iMessage uploader for the caller's tenant. The server mints a kind=device,
 * transport=runtime-ingest binding (providers ["imessage"]), derives the uploader key
 * `gimsg_<tenantNs>.<bindingId>.<secret>` from it, registers only sha256(key) with the runtime,
 * and returns the uploader config exactly once (`userId` is the verified tenant namespace,
 * `apiUrl` the runtime's device host). Nothing is installed or started here: the user feeds
 * `messagesConfig` (plus the chats chosen on the Mac) to `shepherd-onboard write-messages-config`
 * on stdin, then installs the agent.
 */
export async function imessageDeviceSetupRoute(request: Request, principal: Principal, service: SourceService, runtime: SourceRuntimeClient): Promise<Response> {
  if (!principal.scopes.includes(SCOPES.tracesWrite) && !principal.scopes.includes(SCOPES.memoryBuild)) {
    return bearerChallenge({ status: 403, error: "insufficient_scope", description: `Missing required scope: ${SCOPES.tracesWrite}`, scope: SCOPES.tracesWrite });
  }
  try {
    const input = ImessageDeviceSetupSchema.parse(await readJson(request, MAX_ADMIN_BODY_BYTES));
    const apiUrl = runtime.config.deviceApiUrl;
    if (!apiUrl) return error(503, "device_ingest_not_configured", "SOURCES_DEVICE_API_URL (the source runtime's public device host) is not configured");
    const label = input.label ?? "Mac iMessage uploader";
    const { binding, token } = await service.bindings.create(
      principal.tenantNs,
      { kind: "device", providers: ["imessage"], label, transport: "runtime-ingest" },
      { subject: principal.subject, issuer: principal.issuer },
    );
    const agentToken = deviceKeyForBindingToken("imessage", token);
    let r: RuntimeResponse;
    try {
      r = await runtime.device(principal, "imessage", {
        bindingId: binding.bindingId,
        tokenSha256: createHash("sha256").update(agentToken, "utf8").digest("hex"),
        label,
        ...(input.handles ? { handles: input.handles } : {}),
      });
    } catch (e) {
      await service.bindings.revoke(principal.tenantNs, binding.bindingId);
      return error(502, "runtime_unreachable", `Source runtime did not enrol the device: ${errorMessage(e)}`);
    }
    if (r.status !== 201) {
      await service.bindings.revoke(principal.tenantNs, binding.bindingId);
      return json(502, { error: { code: "runtime_rejected", message: "Source runtime did not enrol the device", runtime: r.body } });
    }
    return json(201, {
      binding,
      messagesConfig: {
        apiUrl,
        userId: principal.tenantNs,
        agentToken,
        ...(input.backfillDays !== undefined ? { backfillDays: input.backfillDays } : {}),
        ...(input.allowedChatIds ? { allowedChatIds: input.allowedChatIds } : {}),
      },
      device: (r.body as { device?: unknown } | null)?.device ?? null,
      note: "agentToken is shown once. Pipe messagesConfig (with allowedChatIds chosen on the Mac) to `shepherd-onboard write-messages-config` on stdin; revoke with DELETE /v1/sources/bindings/<bindingId>.",
    });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

/**
 * Device-key authority for the source runtime: `GET /v1/sources/devices/:provider/verify` with
 * the device key in `x-api-key` (no body). 200 {tenantNs, bindingId, provider} only for an active
 * kind=device, transport=runtime-ingest binding of that provider; anything else is 401. It reveals
 * nothing beyond the key's own validity and authorizes nothing by itself.
 */
export async function deviceKeyVerifyRoute(request: Request, service: SourceService, provider: string): Promise<Response> {
  try {
    if (!DEVICE_KEY_PREFIXES[provider]) return json(404, { error: "Not found" });
    const verified = await service.bindings.verifyDeviceKey(provider, request.headers.get("x-api-key"));
    if (!verified) return json(401, { error: "Unauthorized" });
    return json(200, { tenantNs: verified.tenantNs, bindingId: verified.binding.bindingId, provider });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

const GoogleAuthStartSchema = z
  .object({
    broker: z.enum(["google", "composio"]).optional(),
    capabilities: z.array(z.enum(["gmail", "calendar", "docs", "contacts", "directory_admin"])).min(1).max(5).optional(),
    account: z.union([z.literal("self"), z.object({ email: z.string().email().max(320) }).strict()]).optional(),
  })
  .strict();
const GoogleDwdMailboxSchema = z.object({ email: z.string().email().max(320) }).strict();

const NangoSourceId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const NangoSessionSchema = z.object({ source: NangoSourceId }).strict();
const NangoSyncSchema = z.object({ source: NangoSourceId.optional() }).strict();

/**
 * Generic Nango records lane setup forwarded to runtime providers/nango-records: status,
 * tenant-bound connect sessions, disconnect and sync-now. Strict bodies: the only field is a
 * configured source id; tenant and user come from the verified principal.
 */
export async function nangoRecordsRoute(
  request: Request,
  principal: Principal,
  runtime: SourceRuntimeClient,
  action: NangoRecordsAction,
  params: { sessionId?: string; source?: string; connectionId?: string } = {},
): Promise<Response> {
  try {
    const body =
      action === "session.create" ? NangoSessionSchema.parse(await readOptionalJson(request))
      : action === "sync" ? NangoSyncSchema.parse((await readOptionalJson(request)) ?? {})
      : undefined;
    return relay(await runtime.nangoRecords(principal, action, { ...(body !== undefined ? { body } : {}), ...params }));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

/** Google provider-grant setup forwarded to runtime providers/google-auth; strict bodies (no tenant/user fields). */
export async function googleAuthRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, action: GoogleAuthAction, email?: string): Promise<Response> {
  try {
    const body =
      action === "oauth.start" ? GoogleAuthStartSchema.parse(await readOptionalJson(request))
      : action === "dwd.add" ? GoogleDwdMailboxSchema.parse(await readOptionalJson(request))
      : undefined;
    return relay(await runtime.googleAuth(principal, action, { ...(body !== undefined ? { body } : {}), ...(email !== undefined ? { email } : {}) }));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}
