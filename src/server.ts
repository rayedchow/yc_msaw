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
import { describePage, MemoryRepo } from "./store/memory.js";
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
  /** Optional explicit Host allowlist (MCP_ALLOWED_HOSTS). Unset on edge-hosted deployments. */
  allowedHosts?: string[];
  log?: (msg: string) => void;
}

export const SERVER_INSTRUCTIONS = [
  "Procedural memory for agents. This server exposes a read-only filesystem of procedural knowledge learned from previous agent runs (APIs/systems behavior, workflows that worked, failure modes and fixes), plus a private writable scratch area.",
  "Call open_memory once at the start of a task: it pins the latest published memory revision, returns the root index, and gives you a workspaceId. Then navigate with read/ls/find/grep under $KNOWLEDGE (start at $KNOWLEDGE/index.md and follow index links) before acting on unfamiliar systems.",
  "$KNOWLEDGE is immutable. Use $WORK/scratch for notes or scripts; shell runs in an isolated, network-blocked sandbox. Memory is rebuilt daily from captured traces; you do not need to write memory yourself.",
].join("\n");

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
    instructions: SERVER_INSTRUCTIONS,
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
        "Start here. Pins the latest published procedural-memory revision into a new workspace and returns its workspaceId, the root $KNOWLEDGE/index.md, and an outline of the wiki. " +
        CUSTOMER_WORKSPACE_ORIENTATION,
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
      ...securityFor(SCOPES.memoryRead),
    },
    async (_input, ctx) => {
      try {
        const p = principalOf(ctx, SCOPES.memoryRead);
        const { workspaceId, revisionId, files, manifest } = await openWorkspace(p);
        const outline = [...files.entries()]
          .filter(([path]) => path.split("/").length <= 3)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, 80)
          .map(([path, content]) => ({ path: `$KNOWLEDGE/${path}`, ...describePage(content) }));
        return json({
          workspaceId,
          revision: { id: revisionId, publishedAt: manifest.createdAt, pages: manifest.files.length, summary: manifest.summary },
          rootIndex: files.get("index.md") ?? "",
          outline,
          orientation: CUSTOMER_WORKSPACE_ORIENTATION,
        });
      } catch (error) {
        return json(toolErrorReceipt("open_memory", error), true);
      }
    },
  );

  for (const def of CUSTOMER_TOOL_DEFINITIONS) {
    server.tool(
      {
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema.extend({ workspaceId: WorkspaceIdField }),
        annotations: { readOnlyHint: def.readOnly, destructiveHint: false, openWorldHint: false },
        ...securityFor(SCOPES.memoryRead),
      },
      async (input: Record<string, unknown>, ctx) => {
        try {
          const p = principalOf(ctx, SCOPES.memoryRead);
          const { workspaceId, ...toolInput } = input;
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

  return server;
}
