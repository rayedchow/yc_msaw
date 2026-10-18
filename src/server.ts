import { MCPServer, type CallToolResult } from "mcp-use";
import { z } from "zod";
import {
  authenticateHttp,
  buildMcpOAuth,
  principalFromAuth,
  requireScope,
  SCOPES,
  toolSecuritySchemes,
  type AuthConfig,
  type CtxAuthLike,
  type Principal,
} from "./auth/index.js";
import {
  CUSTOMER_TOOL_DEFINITIONS,
  CUSTOMER_WORKSPACE_ORIENTATION,
  CustomerWorkspaceManager,
  dispatchCustomerTool,
  toolErrorReceipt,
} from "./customer/index.js";
import { SourceFs, SOURCE_ROUTED_TOOLS, SOURCES_ORIENTATION, SourcesHistorySchema, SourcesStatusSchema, type SourceRoutedTool } from "./sources/fs.js";
import {
  connectRoute,
  createBindingRoute,
  deviceKeyVerifyRoute,
  deviceRoute,
  disconnectRoute,
  googleAuthRoute,
  bitbucketRepositoriesRoute,
  codingSessionsDeviceSetupRoute,
  deviceCommandRoute,
  githubRepositoriesRoute,
  imessageDeviceSetupRoute,
  jiraSelectionRoute,
  officeAudioConsentRoute,
  PERSONAL_CONNECT_DIRS,
  officeAudioDeviceSetupRoute,
  listBindingsRoute,
  nangoRecordsRoute,
  provisionRuntimeRoute,
  runtimeStatusRoute,
  publishRoute,
  putBlobRoute,
  revokeBindingRoute,
  statusReportRoute,
  statusRoute,
} from "./sources/http.js";
import { isSourcesPath } from "./sources/paths.js";
import type { SourceRuntimeClient } from "./sources/runtime-client.js";
import type { SourceService } from "./sources/service.js";
import { MemoryRepo } from "./store/memory.js";
import type { ObjectStore } from "./store/objects.js";
import { handleTraceRequest, type TraceIngestor } from "./traces/index.js";
import { errorMessage } from "./util.js";

export const SERVER_VERSION = "0.2.0";
const MAX_CACHED_TENANTS = 64;

/** Daily build control surface (implemented by src/daily/service.ts). */
export interface BuildController {
  start(ns: string, input: { day?: string; force?: boolean; catchup?: boolean }): Promise<Record<string, unknown> & { buildId?: string }>;
  get(ns: string, buildId: string): Promise<Record<string, unknown> | null>;
}

/**
 * Narrow port onto the integrations subsystem's catalog (src/integrations).
 * Expected outcomes are typed results, never inferred from error text:
 * `not_found` (no live deployed integration with that slug for this tenant) and
 * `child_auth_not_configured` (this host cannot mint child tokens; permanent until reconfigured).
 * Anything thrown is treated as a transient/unexpected failure.
 */
export type IntegrationTokenResult =
  | { ok: true; token: { slug: string; mcpUrl: string; token: string; tokenType: string; expiresAt: string; audience: string } }
  | { ok: false; reason: "not_found" | "child_auth_not_configured" };

export interface IntegrationCatalogPort {
  list(ns: string, subject: string): Promise<{ integrations: unknown[]; childAuthConfigured: boolean }>;
  accessToken(ns: string, subject: string, slug: string): Promise<IntegrationTokenResult>;
}

export interface ServerDeps {
  auth: AuthConfig;
  store: ObjectStore;
  ingestor: TraceIngestor;
  workspaces: CustomerWorkspaceManager;
  builds: BuildController;
  /** Optional catalog of published integration MCPs, served over HTTP (separate from the memory filesystem MCP). */
  integrationCatalog?: IntegrationCatalogPort;
  /** Server-side sources/ filesystem ($SOURCES). When unset, $SOURCES paths and source routes are absent. */
  sources?: SourceService;
  /** Internal client for the source collector runtime (SOURCES_RUNTIME_URL); enables connect/provision/device routes. */
  sourceRuntime?: SourceRuntimeClient;
  /** Optional explicit Host allowlist (MCP_ALLOWED_HOSTS). Unset on edge-hosted deployments. */
  allowedHosts?: string[];
  log?: (msg: string) => void;
}

export const SERVER_INSTRUCTIONS = [
  "Procedural memory for agents. This server exposes a read-only filesystem of procedural knowledge learned from previous agent runs (APIs/systems behavior, workflows that worked, failure modes and fixes), plus a private writable scratch area.",
  "Call open_memory once at the start of a task: it only pins the latest published memory revision into a workspace and returns a small receipt with the workspaceId (no file contents). Then read $KNOWLEDGE/index.md and follow its links with read/ls/find/grep before acting on unfamiliar systems.",
  "$KNOWLEDGE is immutable. Use $WORK/scratch for notes or scripts; shell runs in an isolated, network-blocked sandbox. Memory is rebuilt daily from captured traces; you do not need to write memory yourself.",
].join("\n");

/** Added to the instructions when the server hosts the sources/ filesystem. */
export const SOURCES_INSTRUCTIONS = SOURCES_ORIENTATION;

const SourceLsAfterField = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe("$SOURCES only: continue a truncated directory listing after this entry name (nextAfter).");

const WorkspaceIdField = z
  .string()
  .uuid()
  .optional()
  .describe(
    "workspaceId returned by your open_memory call. Pass it on every call. If omitted, your only open workspace is used (one is opened if you have none); with several open workspaces the call is refused as ambiguous.",
  );

/** Strip bearer tokens, JWT-looking strings and static keys before logging upstream error text. */
export function redactForLog(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/pmk_[A-Za-z0-9_-]+/g, "pmk_[redacted]")
    .slice(0, 1000);
}

function json(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Builds the parent MCP server. The customer-facing MCP surface is
 * filesystem-only (no traces, inputs or builder tools); trace ingest and
 * build control are separate authenticated HTTP routes.
 */
export function createProcmemServer(deps: ServerDeps): MCPServer<never> {
  const { auth } = deps;
  const oauth = buildMcpOAuth(auth);
  // Principals for static-key MCP requests (no OAuth provider), keyed by the raw Request.
  const staticPrincipals = new WeakMap<Request, Principal>();

  const server = new MCPServer({
    name: "procmem",
    title: "Procedural Memory",
    version: SERVER_VERSION,
    description: "Daily-built procedural memory wiki for agents, served as a read-only filesystem with private scratch.",
    instructions: deps.sources ? `${SERVER_INSTRUCTIONS}\n${SOURCES_INSTRUCTIONS}` : SERVER_INSTRUCTIONS,
    basePath: auth.basePath,
    ...(oauth ? { oauth } : {}),
    // Host validation: mcp-use keeps its localhost DNS-rebinding protection on loopback binds by
    // default. Behind a platform edge (Manufact/Fly) probes arrive with per-deployment or internal
    // Host headers, so we do not pin the public hostname; OAuth audience/resource binding still
    // uses the canonical MCP_PUBLIC_URL. MCP_ALLOWED_HOSTS is an explicit opt-in allowlist.
    ...(deps.allowedHosts?.length ? { allowedHosts: deps.allowedHosts } : {}),
  } as never) as MCPServer<never>;

  const securityFor = (scope: string) => {
    const schemes = toolSecuritySchemes(auth, scope);
    return schemes ? { securitySchemes: schemes } : {};
  };

  // Static mode: protect the MCP endpoint with scoped static keys (headless agents / CI).
  if (auth.mode === "static") {
    server.use(auth.basePath as `/${string}`, async (c, next) => {
      const result = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
      if (result instanceof Response) return result;
      staticPrincipals.set(c.req.raw, result);
      await next();
    });
  }

  /** Verified caller with a required scope (enforced for every tool, in every auth mode). */
  const principalOf = (ctx: unknown, scope: string): Principal => {
    const c = ctx as { auth?: CtxAuthLike; req?: { raw?: Request }; request?: { raw?: Request } };
    const raw = c.req?.raw ?? c.request?.raw;
    const p = (raw ? staticPrincipals.get(raw) : undefined) ?? principalFromAuth(c.auth, auth);
    requireScope(p, scope);
    return p;
  };

  // Immutable revision caches per tenant; bounded so idle tenants do not accumulate.
  const repos = new Map<string, MemoryRepo>();
  const repoFor = (ns: string) => {
    let repo = repos.get(ns);
    if (repo) {
      repos.delete(ns);
      repos.set(ns, repo);
      return repo;
    }
    repo = new MemoryRepo(deps.store, ns);
    repos.set(ns, repo);
    while (repos.size > MAX_CACHED_TENANTS) repos.delete(repos.keys().next().value!);
    return repo;
  };

  // Workspace ownership: scratch is private to the principal that opened it.
  // Entries are pruned as soon as the manager has evicted/closed the workspace.
  const owners = new Map<string, { ownerKey: string; ns: string }>();
  const ownerKey = (p: Principal) => `${p.tenantNs}\u0000${p.issuer}\u0000${p.subject}`;
  const ownedWorkspaces = (p: Principal): string[] => {
    const key = ownerKey(p);
    const out: string[] = [];
    for (const [id, o] of owners) {
      if (!deps.workspaces.has(o.ns, id)) owners.delete(id);
      else if (o.ownerKey === key) out.push(id);
    }
    return out;
  };

  async function openWorkspace(p: Principal) {
    const repo = repoFor(p.tenantNs);
    const revisionId = await repo.ensureHead();
    const files = await repo.files(revisionId);
    const workspaceId = deps.workspaces.open(p.tenantNs, revisionId, files);
    owners.set(workspaceId, { ownerKey: ownerKey(p), ns: p.tenantNs });
    return { workspaceId, revisionId, files, manifest: await repo.manifest(revisionId) };
  }

  /**
   * Explicit workspaceId must be owned by the caller. Without one, the call is
   * only unambiguous if the caller has exactly one open workspace (or none, in
   * which case one is opened); concurrent clients of the same principal must
   * pass the workspaceId returned by their own open_memory.
   */
  async function resolveWorkspace(p: Principal, requested?: string): Promise<string> {
    const owned = ownedWorkspaces(p);
    if (requested) {
      if (!owned.includes(requested)) {
        throw Object.assign(new Error(`Workspace ${requested} is not open for this caller; call open_memory`), { code: "workspace_not_found" });
      }
      return requested;
    }
    if (owned.length === 1) return owned[0]!;
    if (owned.length > 1) {
      throw Object.assign(new Error(`You have ${owned.length} open workspaces; pass the workspaceId returned by your open_memory call`), {
        code: "workspace_ambiguous",
      });
    }
    return (await openWorkspace(p)).workspaceId;
  }

  server.tool(
    {
      name: "open_memory",
      title: "Open procedural memory",
      description:
        "Start here. Pins the latest published procedural-memory revision into a new workspace and returns a small receipt (workspaceId, revision id/publishedAt/page count, entrypoint). It returns no file contents: next, read $KNOWLEDGE/index.md and follow its links. " +
        CUSTOMER_WORKSPACE_ORIENTATION,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...securityFor(SCOPES.memoryRead),
    },
    async (_input, ctx) => {
      try {
        const p = principalOf(ctx, SCOPES.memoryRead);
        const { workspaceId, revisionId, manifest } = await openWorkspace(p);
        // Bounded receipt only: no page contents, outlines or summaries. Content is read explicitly.
        return json({
          status: "opened",
          workspaceId,
          revision: { id: revisionId, publishedAt: manifest.createdAt, pages: manifest.files.length },
          entrypoint: "$KNOWLEDGE/index.md",
          knowledge: { path: "$KNOWLEDGE", readOnly: true },
          scratch: { path: "$WORK/scratch", readOnly: false },
          next: "read $KNOWLEDGE/index.md, then follow its links (read/ls/find/grep). Pass this workspaceId on every call.",
        });
      } catch (error) {
        return json(toolErrorReceipt("open_memory", error), true);
      }
    },
  );

  const sourceFs = deps.sources ? new SourceFs(deps.sources) : null;
  const routedToSources = (name: string, input: Record<string, unknown>): name is SourceRoutedTool =>
    sourceFs !== null && (SOURCE_ROUTED_TOOLS as readonly string[]).includes(name) && isSourcesPath(input.path);

  for (const def of CUSTOMER_TOOL_DEFINITIONS) {
    const sourcesNote = sourceFs && (SOURCE_ROUTED_TOOLS as readonly string[]).includes(def.name)
      ? " Paths below $SOURCES read the server-side sources/ mirror directly (no workspace needed)."
      : "";
    server.tool(
      {
        name: def.name,
        title: def.title,
        description: def.description + sourcesNote,
        inputSchema: def.inputSchema.extend({
          workspaceId: WorkspaceIdField,
          ...(sourceFs && def.name === "ls" ? { after: SourceLsAfterField } : {}),
        }),
        annotations: { readOnlyHint: def.readOnly, destructiveHint: false, openWorldHint: false },
        ...securityFor(SCOPES.memoryRead),
      },
      async (input: Record<string, unknown>, ctx) => {
        try {
          const p = principalOf(ctx, SCOPES.memoryRead);
          const { workspaceId, after, ...toolInput } = input;
          // $SOURCES reads are host-side over the tenant's source store; they never open a sandbox.
          if (routedToSources(def.name, toolInput)) {
            const viewer = await deps.sources!.viewer(p.tenantNs, { subject: p.subject, issuer: p.issuer });
            return json(await sourceFs!.run(p.tenantNs, viewer, def.name, { ...toolInput, ...(after !== undefined ? { after } : {}) }));
          }
          if (after !== undefined) {
            return json(toolErrorReceipt(def.name, Object.assign(new Error("after is only supported for $SOURCES directories"), { code: "invalid_input" })), true);
          }
          const id = await resolveWorkspace(p, workspaceId as string | undefined);
          const receipt = await dispatchCustomerTool(deps.workspaces, p.tenantNs, id, def.name, toolInput);
          return json({ workspaceId: id, ...receipt }, receipt.ok === false);
        } catch (error) {
          return json(toolErrorReceipt(def.name, error), true);
        }
      },
    );
  }

  server.tool(
    {
      name: "view_file",
      title: "View a scratch image",
      description:
        "Load one PNG/JPEG/GIF/WebP image (max 5 MiB) from this workspace's private $WORK/scratch, for example a chart you rendered with shell. Returns image content. $KNOWLEDGE is Markdown-only; use read for it.",
      inputSchema: z.object({ path: z.string().min(1).max(2000), workspaceId: WorkspaceIdField }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...securityFor(SCOPES.memoryRead),
    },
    async (input, ctx) => {
      try {
        const p = principalOf(ctx, SCOPES.memoryRead);
        const id = await resolveWorkspace(p, input.workspaceId);
        const r = await deps.workspaces.get(p.tenantNs, id).view_file({ path: input.path });
        return {
          content: [
            { type: "image", data: r.base64, mimeType: r.mediaType },
            { type: "text", text: JSON.stringify({ workspaceId: id, tool: "view_file", ok: true, path: r.path, mediaType: r.mediaType, bytes: r.bytes }) },
          ],
        };
      } catch (error) {
        return json(toolErrorReceipt("view_file", error), true);
      }
    },
  );

  if (sourceFs) {
    server.tool(
      {
        name: "sources_status",
        title: "Source freshness and coverage",
        description:
          "Per-provider freshness and coverage of the server-side $SOURCES mirror: file counts, newest capture time, age, and each collector's reported state (complete/partial/blocked/pending) with reasons. Check this before trusting that $SOURCES is complete.",
        inputSchema: SourcesStatusSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        ...securityFor(SCOPES.memoryRead),
      },
      async (input, ctx) => {
        try {
          const p = principalOf(ctx, SCOPES.memoryRead);
          const viewer = await deps.sources!.viewer(p.tenantNs, { subject: p.subject, issuer: p.issuer });
          return json(await sourceFs.status(p.tenantNs, viewer, SourcesStatusSchema.parse(input ?? {})));
        } catch (error) {
          return json(toolErrorReceipt("sources_status", error), true);
        }
      },
    );
    server.tool(
      {
        name: "sources_history",
        title: "Source file history",
        description:
          "List the immutable versions of one $SOURCES file (newest first, including deletion tombstones), or read an exact prior version by versionId with byteOffset/byteLimit.",
        inputSchema: SourcesHistorySchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        ...securityFor(SCOPES.memoryRead),
      },
      async (input, ctx) => {
        try {
          const p = principalOf(ctx, SCOPES.memoryRead);
          const viewer = await deps.sources!.viewer(p.tenantNs, { subject: p.subject, issuer: p.issuer });
          return json(await sourceFs.history(p.tenantNs, viewer, SourcesHistorySchema.parse(input)));
        } catch (error) {
          return json(toolErrorReceipt("sources_history", error), true);
        }
      },
    );
  }

  // ------------------------------------------------------------ HTTP routes
  // Public liveness probes: Manufact's platform health check uses /health; /healthz is kept for other probes.
  const health = { ok: true, version: SERVER_VERSION, auth: auth.mode };
  server.get("/health", (c) => c.json(health));
  server.get("/healthz", (c) => c.json(health));

  const traceRoute = async (request: Request) => {
    const principal = await authenticateHttp(request, auth, SCOPES.tracesWrite);
    if (principal instanceof Response) return principal;
    return handleTraceRequest(request, principal.tenantNs, deps.ingestor);
  };
  server.post("/v1/traces/chunks", (c) => traceRoute(c.req.raw));

  // Integration MCP catalog: a separate authenticated HTTP surface (the MCP endpoint stays filesystem-only).
  // Lists child integration MCPs the daily build published for this tenant; clients connect to them directly.
  server.get("/v1/integrations", async (c) => {
    const principal = await authenticateHttp(c.req.raw, auth, SCOPES.integrationsRead);
    if (principal instanceof Response) return principal;
    // No catalog on this host: an empty list is accurate, but say explicitly that tokens cannot be minted.
    if (!deps.integrationCatalog) return c.json({ integrations: [], childAuthConfigured: false, catalogConfigured: false });
    try {
      return c.json({ ...(await deps.integrationCatalog.list(principal.tenantNs, principal.subject)), catalogConfigured: true });
    } catch (error) {
      deps.log?.(`integration catalog list failed for ${principal.tenantNs}: ${redactForLog(errorMessage(error))}`);
      return c.json({ error: { code: "catalog_failed", message: "The integration catalog is temporarily unavailable; retry later", retryable: true } }, 502);
    }
  });
  server.post("/v1/integrations/:slug/token", async (c) => {
    const principal = await authenticateHttp(c.req.raw, auth, SCOPES.integrationsRead);
    if (principal instanceof Response) return principal;
    const slug = c.req.param("slug");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return c.json({ error: { code: "invalid_slug", message: "Invalid integration slug", retryable: false } }, 400);
    if (!deps.integrationCatalog) {
      return c.json({ error: { code: "child_auth_not_configured", message: "This server cannot issue integration tokens", retryable: false } }, 503);
    }
    let result: IntegrationTokenResult;
    try {
      // Tenant namespace and subject come only from the verified caller.
      result = await deps.integrationCatalog.accessToken(principal.tenantNs, principal.subject, slug);
    } catch (error) {
      deps.log?.(`integration token for ${principal.tenantNs}/${slug} failed: ${redactForLog(errorMessage(error))}`);
      return c.json({ error: { code: "token_failed", message: "Could not issue an integration token; retry later", retryable: true } }, 502);
    }
    if (result.ok) return c.json(result.token);
    if (result.reason === "child_auth_not_configured") {
      return c.json({ error: { code: "child_auth_not_configured", message: "This server cannot issue integration tokens", retryable: false } }, 503);
    }
    return c.json({ error: { code: "integration_not_found", message: `No live integration ${slug} for this tenant`, retryable: false } }, 404);
  });
  server.put("/v1/traces/blobs/:sha", (c) => traceRoute(c.req.raw));

  server.post("/v1/builds/daily", async (c) => {
    const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
    if (principal instanceof Response) return principal;
    let body: { day?: unknown; force?: unknown; catchup?: unknown } = {};
    try {
      const text = await c.req.text();
      if (text.length > 4096) return c.json({ error: { code: "too_large", message: "Body too large" } }, 413);
      body = text ? (JSON.parse(text) as typeof body) : {};
    } catch {
      return c.json({ error: { code: "invalid_json", message: "Body must be JSON" } }, 400);
    }
    if (body.day !== undefined && (typeof body.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.day))) {
      return c.json({ error: { code: "invalid_day", message: "day must be YYYY-MM-DD" } }, 400);
    }
    try {
      const started = await deps.builds.start(principal.tenantNs, {
        ...(typeof body.day === "string" ? { day: body.day } : {}),
        force: body.force === true,
        catchup: body.catchup === true,
      });
      return c.json(started, started.buildId ? 202 : 200);
    } catch (error) {
      deps.log?.(`daily build trigger failed: ${errorMessage(error)}`);
      return c.json({ error: { code: "build_trigger_failed", message: errorMessage(error) } }, 409);
    }
  });

  server.get("/v1/builds/:id", async (c) => {
    const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
    if (principal instanceof Response) return principal;
    const id = c.req.param("id");
    if (!/^bld-[a-z0-9-]{1,60}$/.test(id)) return c.json({ error: { code: "invalid_build_id", message: "Invalid build id" } }, 400);
    const receipt = await deps.builds.get(principal.tenantNs, id);
    return receipt ? c.json(receipt) : c.json({ error: { code: "not_found", message: `No build ${id}` } }, 404);
  });

  if (deps.sources) {
    const sources = deps.sources;
    // Admin surface: the existing authenticateHttp authority; namespace = principal.tenantNs.
    server.post("/v1/sources/bindings", async (c) => {
      // Scope depends on the binding kind (runtime: memory:build, device: traces:write); checked in the route.
      const principal = await authenticateHttp(c.req.raw, auth, undefined);
      if (principal instanceof Response) return principal;
      return createBindingRoute(c.req.raw, principal, sources);
    });
    server.get("/v1/sources/bindings", async (c) => {
      const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
      if (principal instanceof Response) return principal;
      return listBindingsRoute(principal, sources);
    });
    server.delete("/v1/sources/bindings/:id", async (c) => {
      const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
      if (principal instanceof Response) return principal;
      return revokeBindingRoute(principal, sources, c.req.param("id"), deps.sourceRuntime);
    });
    server.get("/v1/sources/status", async (c) => {
      const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
      if (principal instanceof Response) return principal;
      return statusRoute(principal, sources);
    });
    // Publish surface: binding tokens only (never OAuth/static keys); namespace comes from the binding record.
    server.put("/v1/sources/blobs/:sha", (c) => putBlobRoute(c.req.raw, sources, c.req.param("sha")));
    server.post("/v1/sources/publish", (c) => publishRoute(c.req.raw, sources));
    server.post("/v1/sources/status-report", (c) => statusReportRoute(c.req.raw, sources));
    // Device-key authority the source runtime asks on every uploader request (key only, no body).
    server.get("/v1/sources/devices/:provider/verify", (c) => deviceKeyVerifyRoute(c.req.raw, sources, c.req.param("provider")));

    // Collector runtime control: forwarded with the verified principal; the tenant is never caller-chosen.
    const runtime = deps.sourceRuntime;
    if (runtime) {
      server.post("/v1/sources/runtime/provision", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return provisionRuntimeRoute(principal, sources, runtime);
      });
      server.get("/v1/sources/runtime/status", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return runtimeStatusRoute(principal, runtime, sources);
      });
      server.post("/v1/sources/connect/:provider", async (c) => {
        // A member connects their own personal account (they become its owner); shared workspace tools need an admin.
        const personal = Object.prototype.hasOwnProperty.call(PERSONAL_CONNECT_DIRS, c.req.param("provider"));
        const principal = await authenticateHttp(c.req.raw, auth, personal ? SCOPES.memoryRead : SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return connectRoute(c.req.raw, principal, runtime, c.req.param("provider"), sources);
      });
      server.delete("/v1/sources/connections/:provider", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return disconnectRoute(principal, runtime, c.req.param("provider"));
      });
      // Google provider grants (OAuth / Composio / DWD allowlist) live in the runtime's google-auth module.
      server.get("/v1/sources/google/auth", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return googleAuthRoute(c.req.raw, principal, runtime, "status", undefined, sources);
      });
      server.post("/v1/sources/google/auth/oauth/start", async (c) => {
        // Self-service: any member may grant their own Google account (Google's account check at the callback proves
        // control of the address; the member becomes its owner).
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return googleAuthRoute(c.req.raw, principal, runtime, "oauth.start");
      });
      server.post("/v1/sources/google/auth/ownership/start", async (c) => {
        // Self-service: a member proves they control a Google address (e.g. a domain-wide-delegation mailbox) with an
        // identity-only Google sign-in and becomes its owner; the address keeps its collection mode.
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return googleAuthRoute(c.req.raw, principal, runtime, "ownership.start");
      });
      server.post("/v1/sources/google/auth/dwd/mailboxes", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return googleAuthRoute(c.req.raw, principal, runtime, "dwd.add");
      });
      server.delete("/v1/sources/google/auth/accounts/:email", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return googleAuthRoute(c.req.raw, principal, runtime, "account.delete", c.req.param("email"));
      });
      // Mac iMessage uploader: one-time setup with a server-minted device binding.
      server.post("/v1/sources/devices/imessage/setup", async (c) => {
        // Collection scope (traces:write) or admin; checked in the route.
        const principal = await authenticateHttp(c.req.raw, auth, undefined);
        if (principal instanceof Response) return principal;
        return imessageDeviceSetupRoute(c.req.raw, principal, sources, runtime);
      });
      // Mac office-audio collector + admin-granted participant consent.
      server.post("/v1/sources/devices/office-audio/setup", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, undefined);
        if (principal instanceof Response) return principal;
        return officeAudioDeviceSetupRoute(c.req.raw, principal, sources, runtime);
      });
      server.get("/v1/sources/office-audio/consents", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return officeAudioConsentRoute(c.req.raw, principal, runtime, "list", undefined, sources);
      });
      server.post("/v1/sources/office-audio/consents", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return officeAudioConsentRoute(c.req.raw, principal, runtime, "grant");
      });
      server.delete("/v1/sources/office-audio/consents/:participantKey", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return officeAudioConsentRoute(c.req.raw, principal, runtime, "revoke", c.req.param("participantKey"));
      });
      // The device owner's commands to their own Mac uploader (source sync receipts make coverage complete).
      server.post("/v1/sources/devices/:provider/:bindingId/commands", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, undefined);
        if (principal instanceof Response) return principal;
        return deviceCommandRoute(c.req.raw, principal, sources, runtime, c.req.param("provider"), c.req.param("bindingId"));
      });
      // Mac coding-sessions agent: same server-minted device binding model.
      server.post("/v1/sources/devices/coding-sessions/setup", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, undefined);
        if (principal instanceof Response) return principal;
        return codingSessionsDeviceSetupRoute(c.req.raw, principal, sources, runtime);
      });
      // Generic Nango records lane (operator-configured Nango integrations; runtime providers/nango-records).
      server.get("/v1/sources/nango-records", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return nangoRecordsRoute(c.req.raw, principal, runtime, "status");
      });
      server.post("/v1/sources/nango-records/connect-sessions", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return nangoRecordsRoute(c.req.raw, principal, runtime, "session.create");
      });
      server.get("/v1/sources/nango-records/connect-sessions/:sessionId", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return nangoRecordsRoute(c.req.raw, principal, runtime, "session.get", { sessionId: c.req.param("sessionId") });
      });
      server.delete("/v1/sources/nango-records/connections/:source/:connectionId", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return nangoRecordsRoute(c.req.raw, principal, runtime, "connection.delete", { source: c.req.param("source"), connectionId: c.req.param("connectionId") });
      });
      server.post("/v1/sources/nango-records/sync", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return nangoRecordsRoute(c.req.raw, principal, runtime, "sync");
      });
      // Jira deep-lane project selection (runtime providers/jira; jira patch request 6).
      server.get("/v1/sources/jira/selection", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return jiraSelectionRoute(c.req.raw, principal, runtime, "get");
      });
      server.put("/v1/sources/jira/selection", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return jiraSelectionRoute(c.req.raw, principal, runtime, "put");
      });
      // GitHub repository selection (runtime providers/github; github patch request 3).
      server.get("/v1/sources/github/repositories", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return githubRepositoriesRoute(c.req.raw, principal, runtime, "get");
      });
      server.put("/v1/sources/github/repositories/selection", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return githubRepositoriesRoute(c.req.raw, principal, runtime, "put");
      });
      // Bitbucket repository selection (runtime providers/bitbucket; bitbucket patch request 3).
      server.get("/v1/sources/bitbucket/repositories", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryRead);
        if (principal instanceof Response) return principal;
        return bitbucketRepositoriesRoute(c.req.raw, principal, runtime, "get");
      });
      server.put("/v1/sources/bitbucket/repositories/selection", async (c) => {
        const principal = await authenticateHttp(c.req.raw, auth, SCOPES.memoryBuild);
        if (principal instanceof Response) return principal;
        return bitbucketRepositoriesRoute(c.req.raw, principal, runtime, "put");
      });
      server.post("/v1/sources/devices/:provider", async (c) => {
        // Collection scope (traces:write) or admin; checked in the route.
        const principal = await authenticateHttp(c.req.raw, auth, undefined);
        if (principal instanceof Response) return principal;
        return deviceRoute(c.req.raw, principal, runtime, c.req.param("provider"));
      });
    }
  }

  return server;
}
