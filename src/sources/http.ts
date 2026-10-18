import { z } from "zod";
import { bearerChallenge } from "../auth/http.js";
import type { Principal } from "../auth/mcp.js";
import { SCOPES } from "../auth/scopes.js";
import { parseContentType, readBoundedBody, TraceIngestError } from "../traces/ingest.js";
import { errorMessage } from "../util.js";
import { createHash } from "node:crypto";
import { DEVICE_KEY_PREFIXES, DEVICE_PROVIDERS, deviceKeyForBindingToken, looksLikeBindingToken, type BindingKind, type VerifiedBinding } from "./bindings.js";
import { isPersonalProvider } from "./access.js";
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
  owner_conflict: 409,
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
            /** How often this scope promises a successful check; an older lastSuccessAt makes the collector stale. */
            expectedIntervalSeconds: z.number().int().min(10).max(30 * 86_400).optional(),
          })
          .strict(),
      )
      .max(500),
    googleAccounts: z
      .array(
        z
          .object({
            account: z.string().min(3).max(320),
            subject: z.string().min(1).max(500).nullable(),
            issuer: z.string().min(1).max(500).nullable(),
          })
          .strict(),
      )
      .max(1_000)
      .optional(),
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
    // Device data (iMessage, coding sessions, office audio) only enters through the runtime receiver, which enforces
    // device revocation and the office-audio consent gate. A generic device binding could publish around both, so
    // devices are enrolled only through POST /v1/sources/devices/<provider>/setup.
    if (input.kind === "device") {
      return error(400, "use_device_setup", `Device bindings are minted by POST /v1/sources/devices/<provider>/setup (${DEVICE_PROVIDERS.join(", ")})`);
    }
    // Connector runtimes are administrative collection (memory:build).
    const need = SCOPES.memoryBuild;
    if (!principal.scopes.includes(need) && !principal.scopes.includes(SCOPES.memoryBuild)) {
      return bearerChallenge({ status: 403, error: "insufficient_scope", description: `Missing required scope: ${need}`, scope: need });
    }
    // A hand-minted binding whose token the admin keeps must not write (or vouch for) personal sources: '*' and the
    // personal provider directories are only for the provisioned collector (POST /v1/sources/runtime/provision).
    const personal = input.providers.filter((p) => p === "*" || isPersonalProvider(p) || p === "binary");
    if (personal.length) {
      return error(400, "use_runtime_provision", `Bindings for ${personal.join(", ")} are minted only by POST /v1/sources/runtime/provision (personal sources are owner-only)`);
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
    // Admins manage every binding (ids, providers, enroller, revocation), but another member's device label (e.g.
    // "Ada's MacBook") is personal and is redacted.
    const bindings = (await service.bindings.list(principal.tenantNs)).map((b) =>
      b.kind === "device" && (b.createdBy.subject !== principal.subject || b.createdBy.issuer !== principal.issuer) ? { ...b, label: null } : b,
    );
    return json(200, { bindings });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

export async function revokeBindingRoute(principal: Principal, service: SourceService, bindingId: string, runtime?: SourceRuntimeClient): Promise<Response> {
  try {
    if (!principal.scopes.includes(SCOPES.memoryBuild)) {
      // Members stop their own devices; every other binding is administrative.
      const own = (await service.bindings.list(principal.tenantNs)).find((x) => x.bindingId === bindingId);
      if (!own || own.kind !== "device" || own.createdBy.subject !== principal.subject || own.createdBy.issuer !== principal.issuer) {
        return error(403, "forbidden", "Members may revoke only a device they enrolled");
      }
    }
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
    // Admins are members too: other owners' personal sources are filtered exactly as on the MCP.
    return json(200, await service.status(principal.tenantNs, await service.viewer(principal.tenantNs, { subject: principal.subject, issuer: principal.issuer })));
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
  // Device uploaders whose raw data goes to the runtime receiver never publish files themselves (including any
  // device binding minted before device publishing was removed).
  if (verified.binding.transport === "runtime-ingest" || verified.binding.kind === "device") {
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

const RUNTIME_BINDING_LABEL = "sources-runtime";

/** Mint a runtime binding for the caller's tenant and hand it to the runtime; the token never leaves the servers. */
export async function provisionRuntimeRoute(principal: Principal, service: SourceService, runtime: SourceRuntimeClient): Promise<Response> {
  try {
    const { binding, token } = await service.bindings.create(principal.tenantNs, { kind: "runtime", providers: ["*"], label: RUNTIME_BINDING_LABEL, origin: "runtime-provision" }, { subject: principal.subject, issuer: principal.issuer });
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
    // The runtime now holds the new token; earlier runtime bindings must not stay usable if one leaked.
    const replaced: string[] = [];
    for (const b of await service.bindings.list(principal.tenantNs)) {
      if (b.bindingId === binding.bindingId || b.revokedAt || b.kind !== "runtime" || b.label !== RUNTIME_BINDING_LABEL || b.providers.join() !== "*") continue;
      await service.bindings.revoke(principal.tenantNs, b.bindingId);
      replaced.push(b.bindingId);
    }
    return json(201, { binding, runtime: r.body, revokedPrevious: replaced });
  } catch (e) {
    return sourceErrorResponse(e);
  }
}

const who = (p: Principal) => ({ subject: p.subject, issuer: p.issuer });

/** Runtime status, filtered like sources_status: other owners' coverage and personal connections are withheld. */
export async function runtimeStatusRoute(principal: Principal, runtime: SourceRuntimeClient, service?: SourceService): Promise<Response> {
  let r: RuntimeResponse;
  try {
    r = await runtime.status(principal);
  } catch (e) {
    return error(502, "runtime_unreachable", errorMessage(e));
  }
  if (!service) return relay(r);
  // A non-200 body could still carry data: callers get a fixed error, never the runtime's body.
  if (r.status !== 200 || !r.body || typeof r.body !== "object") return error(502, "runtime_status_unavailable", `Source runtime status answered ${r.status}`);
  const viewer = await service.viewer(principal.tenantNs, who(principal));
  const body = r.body as {
    coverage?: Array<{ provider?: unknown; scope?: unknown; reason?: unknown }>;
    connections?: Array<{ provider?: unknown; external_account_id?: unknown }>;
    personal?: { segment?: unknown } | null;
  };
  const owned = new Set(viewer.googleAccounts);
  const filtered = {
    ...body,
    ...(Array.isArray(body.coverage)
      ? { coverage: body.coverage.filter((c) => typeof c.provider === "string" && viewer.coverageVisible(c.provider, { scope: String(c.scope ?? ""), ...(typeof c.reason === "string" ? { reason: c.reason } : {}) })) }
      : {}),
    ...(Array.isArray(body.connections)
      ? {
          connections: body.connections.filter((c) => {
            if (c.provider === "google") return typeof c.external_account_id === "string" && owned.has(c.external_account_id.toLowerCase());
            if (typeof c.provider !== "string") return false;
            // Organization-level connections of personal integrations predate owner scopes: their data is sealed.
            const dir = PERSONAL_CONNECT_DIRS[c.provider] ?? c.provider.replace(/_/g, "-");
            return viewer.access(dir) === "allow";
          }),
        }
      : {}),
    // The runtime lists only the forwarded principal's own accounts; anything else is dropped.
    personal: body.personal && typeof body.personal === "object" && body.personal.segment === viewer.personalSegment ? body.personal : null,
  };
  return json(200, filtered);
}

/** Runtime integration id -> the personal $SOURCES directory its connection fills (owner-only, access.ts). */
export const PERSONAL_CONNECT_DIRS: Readonly<Record<string, string>> = {
  granola: "granola",
  zoom: "zoom",
  cursor_background_agents: "cursor-agents",
  whatsapp_personal: "whatsapp-personal",
  instagram_personal: "instagram-personal",
};

/**
 * True when sources/<provider>/ holds any history: live files or tombstones. A purge publishes ordinary deletes, and
 * every earlier version stays readable through sources_history, so purged legacy data must block a first device claim.
 */
async function providerHasData(service: SourceService, ns: string, provider: string): Promise<boolean> {
  const r = await service.storeFor(ns).resolve(provider);
  return r !== null && r.type === "dir" && (r.entry === null || r.entry.files + r.entry.deleted > 0);
}

/**
 * `POST /v1/sources/connect/:provider`. A personal account (PERSONAL_CONNECT_DIRS) is connected into the caller's own
 * runtime owner scope, so every member may connect theirs and nobody claims the provider for the tenant: its files
 * appear under `$SOURCES/<dir>/<caller's segment>/` (access.ts personalSegment), readable by the caller only. Data
 * captured before owner scopes (unsegmented paths) stays sealed whoever connects.
 */
export async function connectRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, provider: string): Promise<Response> {
  try {
    const body = await readOptionalJson(request);
    return relay(await runtime.connect(principal, provider, body));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

/**
 * `DELETE /v1/sources/connections/:provider`. For a personal integration the runtime disconnects the caller's own
 * account (its owner scope); captured files and their history stay, readable by the caller. An admin stops an
 * organization-level legacy connection of a personal integration with `?legacy=organization` (its data stays sealed).
 */
export async function disconnectRoute(principal: Principal, runtime: SourceRuntimeClient, provider: string, opts: { legacy?: boolean } = {}): Promise<Response> {
  try {
    if (opts.legacy && !principal.scopes.includes(SCOPES.memoryBuild)) return error(403, "forbidden", "Only an admin stops an organization-level legacy connection");
    return relay(await runtime.disconnect(principal, provider, opts));
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
  return runtimeDeviceSetup(request, principal, service, runtime, {
    provider: "imessage",
    schema: ImessageDeviceSetupSchema,
    defaultLabel: "Mac iMessage uploader",
    enrolExtra: (input) => (input.handles ? { handles: input.handles } : {}),
    config: (input) => ({
      ...(input.backfillDays !== undefined ? { backfillDays: input.backfillDays } : {}),
      ...(input.allowedChatIds ? { allowedChatIds: input.allowedChatIds } : {}),
    }),
    configKey: "messagesConfig",
    note: "agentToken is shown once. Pipe messagesConfig (with allowedChatIds chosen on the Mac) to `shepherd-onboard write-messages-config` on stdin; revoke with DELETE /v1/sources/bindings/<bindingId>.",
  });
}

export const CodingSessionsDeviceSetupSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    /** Echoed into the agent config: poll/upload interval. */
    intervalSeconds: z.number().int().min(30).max(86_400).optional(),
  })
  .strict();

/**
 * Enrol a Mac coding-sessions agent (Codex / Claude Code transcripts). Same model as iMessage: a server-minted
 * kind=device, transport=runtime-ingest binding, a `gcs_` key derived from it, only sha256(key) at the runtime,
 * and the agent config `{apiUrl, userId, agentToken, intervalSeconds?}` returned once.
 */
export async function codingSessionsDeviceSetupRoute(request: Request, principal: Principal, service: SourceService, runtime: SourceRuntimeClient): Promise<Response> {
  return runtimeDeviceSetup(request, principal, service, runtime, {
    provider: "coding-sessions",
    schema: CodingSessionsDeviceSetupSchema,
    defaultLabel: "Mac coding-sessions agent",
    enrolExtra: () => ({}),
    config: (input) => (input.intervalSeconds !== undefined ? { intervalSeconds: input.intervalSeconds } : {}),
    configKey: "codingSessionsConfig",
    note: "agentToken is shown once. Pipe codingSessionsConfig to `shepherd-onboard write-coding-sessions-config` on stdin; revoke with DELETE /v1/sources/bindings/<bindingId>.",
  });
}

export const OfficeAudioDeviceSetupSchema = z.object({ label: z.string().min(1).max(200).optional() }).strict();

/**
 * Enrol a Mac office-audio collector (room transcripts). Same server-minted device binding model; recording
 * consent for each participant is granted separately by an admin (runtime /office-audio/consents), never by
 * the device.
 */
export async function officeAudioDeviceSetupRoute(request: Request, principal: Principal, service: SourceService, runtime: SourceRuntimeClient): Promise<Response> {
  return runtimeDeviceSetup(request, principal, service, runtime, {
    provider: "office-audio",
    schema: OfficeAudioDeviceSetupSchema,
    defaultLabel: "Mac office-audio collector",
    enrolExtra: () => ({}),
    config: () => ({}),
    configKey: "officeAudioConfig",
    note: "agentToken is shown once. Pipe officeAudioConfig to `shepherd-onboard write-office-audio-config` on stdin. Sessions are stored only for participants an admin granted consent to (POST /v1/sources/office-audio/consents).",
  });
}

/** Shared device setup: mint the binding, enrol sha256(device key) at the runtime, roll back on any runtime failure. */
async function runtimeDeviceSetup<S extends z.ZodTypeAny>(
  request: Request,
  principal: Principal,
  service: SourceService,
  runtime: SourceRuntimeClient,
  spec: {
    provider: string;
    schema: S;
    defaultLabel: string;
    enrolExtra(input: z.infer<S>): Record<string, unknown>;
    config(input: z.infer<S>): Record<string, unknown>;
    configKey: string;
    note: string;
  },
): Promise<Response> {
  // Self-service: any member (memory:read) may enrol their own device and becomes its owner; collection and admin
  // keys may too.
  if (![SCOPES.memoryRead, SCOPES.tracesWrite, SCOPES.memoryBuild].some((s) => principal.scopes.includes(s))) {
    return bearerChallenge({ status: 403, error: "insufficient_scope", description: `Missing required scope: ${SCOPES.memoryRead}`, scope: SCOPES.memoryRead });
  }
  try {
    const input = spec.schema.parse(await readJson(request, MAX_ADMIN_BODY_BYTES)) as z.infer<S> & { label?: string };
    const apiUrl = runtime.config.deviceApiUrl;
    if (!apiUrl) return error(503, "device_ingest_not_configured", "SOURCES_DEVICE_API_URL (the source runtime's public device host) is not configured");
    const label = input.label ?? spec.defaultLabel;
    // The runtime enrols the device into the enrolling principal's owner scope: its data appears only under
    // $SOURCES/<provider>/<their segment>/ (access.ts), so every member enrols their own devices and nothing captured
    // before owner scopes (the provider directory itself) is handed to anyone.
    const { binding, token } = await service.bindings.create(
      principal.tenantNs,
      { kind: "device", providers: [spec.provider], label, transport: "runtime-ingest", layout: "owner-segment" },
      { subject: principal.subject, issuer: principal.issuer },
    );
    const agentToken = deviceKeyForBindingToken(spec.provider, token);
    let r: RuntimeResponse;
    try {
      r = await runtime.device(principal, spec.provider, {
        bindingId: binding.bindingId,
        tokenSha256: createHash("sha256").update(agentToken, "utf8").digest("hex"),
        label,
        // The runtime enrols the device into this principal's owner scope (it reads the owner from the principal only).
        layout: "owner-segment",
        ...spec.enrolExtra(input),
      });
    } catch (e) {
      // The device key was never returned, so no device can hold this binding: it confers no ownership.
      await service.bindings.revoke(principal.tenantNs, binding.bindingId, { enrolmentFailed: true });
      return error(502, "runtime_unreachable", `Source runtime did not enrol the device: ${errorMessage(e)}`);
    }
    if (r.status !== 201) {
      await service.bindings.revoke(principal.tenantNs, binding.bindingId, { enrolmentFailed: true });
      return json(502, { error: { code: "runtime_rejected", message: "Source runtime did not enrol the device", runtime: r.body } });
    }
    return json(201, {
      binding,
      [spec.configKey]: { apiUrl, userId: principal.tenantNs, agentToken, ...spec.config(input) },
      device: (r.body as { device?: unknown } | null)?.device ?? null,
      note: spec.note,
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

const IsoTimestamp = z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO timestamp");
/** Commands each device lane's uploader understands (runtime providers/imessage/commands.ts, coding-sessions/lane.ts). */
const DeviceCommandSchemas: Record<string, z.ZodTypeAny> = {
  imessage: z.discriminatedUnion("type", [
    z.object({ type: z.literal("messages_source_sync"), coverageFrom: z.union([IsoTimestamp, z.null()]).optional(), coverageTo: IsoTimestamp.optional() }).strict(),
    z.object({ type: z.literal("messages_backfill_reset"), backfillDays: z.union([z.number().int().min(1).max(36_500), z.null()]).optional() }).strict(),
  ]),
  "coding-sessions": z.discriminatedUnion("type", [
    z.object({ type: z.literal("source_sync"), coverageFrom: z.union([IsoTimestamp, z.null()]).optional(), coverageTo: IsoTimestamp.optional() }).strict(),
    z.object({ type: z.enum(["force_rescan", "backfill_recent"]), maxFiles: z.number().int().min(1).max(100_000).optional() }).strict(),
    z.object({ type: z.enum(["repair_status", "upload_diagnostics"]) }).strict(),
  ]),
};

/**
 * `POST /v1/sources/devices/:provider/:bindingId/commands`: the device's owner asks their own Mac uploader for a
 * source sync (the receipt that lets coverage become complete), a backfill reset or a rescan. Only the member who
 * enrolled the device may do this (personal sources are owner-only, access.ts); the binding must be an active
 * runtime-ingest device binding of this tenant for that provider.
 */
export async function deviceCommandRoute(request: Request, principal: Principal, service: SourceService, runtime: SourceRuntimeClient, provider: string, bindingId: string): Promise<Response> {
  // Self-service like enrolment: the device's owner (any member) commands it; the owner check below is what matters.
  if (![SCOPES.memoryRead, SCOPES.tracesWrite, SCOPES.memoryBuild].some((s) => principal.scopes.includes(s))) {
    return bearerChallenge({ status: 403, error: "insufficient_scope", description: `Missing required scope: ${SCOPES.memoryRead}`, scope: SCOPES.memoryRead });
  }
  try {
    const schema = DeviceCommandSchemas[provider];
    if (!schema) return error(404, "not_found", `No device commands for ${provider}`);
    const binding = (await service.bindings.list(principal.tenantNs)).find((b) => b.bindingId === bindingId);
    if (!binding || binding.revokedAt || binding.kind !== "device" || binding.transport !== "runtime-ingest" || !binding.providers.includes(provider)) {
      return error(404, "not_found", `No active ${provider} device ${bindingId}`);
    }
    if (binding.createdBy.subject !== principal.subject || binding.createdBy.issuer !== principal.issuer) {
      return error(403, "forbidden", "Only the member who enrolled this device can send it commands");
    }
    const body = schema.parse(await readJson(request, MAX_ADMIN_BODY_BYTES));
    const r = await runtime.deviceCommand(principal, provider, bindingId, body);
    return json(r.status, r.body);
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
const GoogleOwnershipStartSchema = z.object({ account: z.union([z.literal("self"), z.object({ email: z.string().email().max(320) }).strict()]).optional() }).strict();

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

const JiraProjectRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const JiraSelectionSchema = z
  .object({
    connectionId: z.string().min(1).max(256).optional(),
    cloudId: z.string().min(1).max(128).optional(),
    mode: z.enum(["all", "projects"]),
    projects: z.array(JiraProjectRef).max(500).optional(),
  })
  .strict();

/**
 * Jira deep-lane project selection forwarded to runtime providers/jira. Strict body: which of the
 * tenant's own Jira connection/site and which projects; tenant and user come from the verified
 * principal, and the runtime checks the connection belongs to that tenant.
 */
export async function jiraSelectionRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, action: "get" | "put"): Promise<Response> {
  try {
    const body = action === "put" ? JiraSelectionSchema.parse(await readOptionalJson(request)) : undefined;
    return relay(await runtime.jiraSelection(principal, action, body));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

const GithubBranch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((r) => !r.startsWith("/") && !r.endsWith("/") && !r.endsWith(".lock") && !r.includes("..") && !r.includes("//") && !r.split("/").some((s) => s.startsWith(".")));
const GithubSelectionSchema = z
  .object({
    repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/),
    syncing: z.boolean(),
    purge: z.boolean().optional(),
    refs: z.array(GithubBranch).max(20).optional(),
  })
  .strict();

/**
 * GitHub repository selection forwarded to runtime providers/github. Strict body (repository, on/off,
 * explicit destructive purge, extra branches); tenant and user come from the verified principal, and the
 * runtime only enables repositories one of that tenant's own grants can read.
 */
export async function githubRepositoriesRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, action: "get" | "put"): Promise<Response> {
  try {
    const body = action === "put" ? GithubSelectionSchema.parse(await readOptionalJson(request)) : undefined;
    return relay(await runtime.githubRepositories(principal, action, body));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

const BitbucketSlug = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/);
const BitbucketSelectionSchema = z
  .object({
    repo: z.string().refine((r) => {
      const parts = r.split("/");
      return parts.length === 2 && parts.every((s) => BitbucketSlug.safeParse(s).success);
    }),
    syncing: z.boolean(),
    purge: z.boolean().optional(),
    refs: z.array(GithubBranch).max(20).optional(),
  })
  .strict();

/**
 * Bitbucket repository selection forwarded to runtime providers/bitbucket. Strict body (workspace/repository,
 * on/off, explicit destructive purge, extra branches); tenant and user come from the verified principal, and the
 * runtime only enables repositories one of that tenant's own Bitbucket grants can read.
 */
export async function bitbucketRepositoriesRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, action: "get" | "put"): Promise<Response> {
  try {
    const body = action === "put" ? BitbucketSelectionSchema.parse(await readOptionalJson(request)) : undefined;
    return relay(await runtime.bitbucketRepositories(principal, action, body));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

const OfficeAudioConsentSchema = z
  .object({ participantKey: z.string().min(3).max(320), displayName: z.string().max(200).optional(), evidence: z.record(z.string(), z.unknown()).optional() })
  .strict();

/** Office-audio recording consent: an admin of the verified tenant grants or revokes it for one participant. */
export async function officeAudioConsentRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, action: "list" | "grant" | "revoke", participantKey?: string, service?: SourceService): Promise<Response> {
  try {
    if (action === "grant") return relay(await runtime.officeAudioConsent(principal, "grant", { body: OfficeAudioConsentSchema.parse(await readOptionalJson(request)) }));
    if (action === "revoke") return relay(await runtime.officeAudioConsent(principal, "revoke", { participantKey: participantKey ?? "", deleteCaptured: new URL(request.url).searchParams.get("deleteCaptured") === "true" }));
    // Consent records name meeting participants: the office-audio owner and admins only.
    if (service && !principal.scopes.includes(SCOPES.memoryBuild) && (await service.viewer(principal.tenantNs, who(principal))).access("office-audio") !== "allow") {
      return error(403, "forbidden", "Office-audio consents are visible to the office-audio owner and admins only");
    }
    return relay(await runtime.officeAudioConsent(principal, "list"));
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}

/** Google provider-grant setup forwarded to runtime providers/google-auth; strict bodies (no tenant/user fields). */
export async function googleAuthRoute(request: Request, principal: Principal, runtime: SourceRuntimeClient, action: GoogleAuthAction, email?: string, service?: SourceService): Promise<Response> {
  try {
    const body =
      action === "oauth.start" ? GoogleAuthStartSchema.parse(await readOptionalJson(request))
      : action === "ownership.start" ? GoogleOwnershipStartSchema.parse(await readOptionalJson(request))
      : action === "dwd.add" ? GoogleDwdMailboxSchema.parse(await readOptionalJson(request))
      : undefined;
    // Attribution is read by SourceService for the viewer itself, never relayed to a caller.
    if (action === "attribution") return error(404, "not_found", "Not found");
    const r = await runtime.googleAuth(principal, action, { ...(body !== undefined ? { body } : {}), ...(email !== undefined ? { email } : {}) });
    // Members see only their own Google accounts. Admins manage grants and DWD mailboxes, so they see every
    // account's auth metadata (never its data).
    // Owner-scoped: everyone, admins included, sees their own Google accounts. Admins also see accounts nobody owns
    // yet (the DWD mailboxes they add and manage), never another member's account. Pending authorizations are not
    // listed (they name addresses before any proof).
    if (action === "status" && service && r.status === 200 && r.body && typeof r.body === "object") {
      const viewer = await service.viewer(principal.tenantNs, who(principal));
      const admin = principal.scopes.includes(SCOPES.memoryBuild);
      const visible = new Set([...viewer.googleAccounts, ...(admin ? viewer.unownedGoogleAccounts : [])]);
      const b = r.body as { accounts?: Array<{ email?: unknown }>; modes?: { domain_wide_delegation?: Record<string, unknown> } };
      const dwd = b.modes?.domain_wide_delegation;
      return json(200, {
        ...b,
        accounts: (b.accounts ?? []).filter((a) => typeof a.email === "string" && visible.has(a.email.toLowerCase())),
        pendingAuthorizations: [],
        ...(dwd && !admin ? { modes: { ...b.modes, domain_wide_delegation: { ...dwd, approved: null, directoryAdmin: null } } } : {}),
      });
    }
    return relay(r);
  } catch (e) {
    return e instanceof SourceError || e instanceof TraceIngestError || e instanceof z.ZodError ? sourceErrorResponse(e) : error(502, "runtime_unreachable", errorMessage(e));
  }
}
