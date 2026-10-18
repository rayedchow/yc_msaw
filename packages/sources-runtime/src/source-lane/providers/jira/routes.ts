import type { Context, Hono } from "hono";
import type { DbExecutor, InternalRouteDeps } from "../../core/types.js";
import type { ForwardedPrincipal } from "../../internal/app.js";
import { getSelection, listObjects, listSites, putSelection, rejournalDonorJiraRows, syncSiteSelection } from "./store.js";
import { jiraConnections } from "./sweep.js";

/**
 * Project selection for the Jira deep lane (yc_msaw -> runtime internal API,
 * mounted under /internal/v1 behind the service token).
 *
 * The tenant is the one core's middleware verified against the forwarded
 * principal (deps.tenantOf); the connection must be that tenant's own Jira
 * connection and the site one it reaches. Nothing in the body or query can name
 * another tenant, and there is no global project key: an absent selection means
 * every project the tenant's own grant can browse. Reads need memory:read,
 * changes memory:build (scopes forwarded with the verified principal; a request
 * without them is refused).
 */

const SCOPE_READ = "memory:read";
const SCOPE_BUILD = "memory:build";
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const MAX_PROJECTS = 500;

type PrincipalEnv = { Variables: { principal?: ForwardedPrincipal } };

function principalOf(c: Context): ForwardedPrincipal | null {
  return (c as unknown as Context<PrincipalEnv>).get("principal") ?? null;
}

function hasScope(p: ForwardedPrincipal | null, scope: string): boolean {
  return Boolean(p?.scopes?.includes(scope));
}

function err(c: Context, status: 400 | 403 | 404, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status);
}

export interface SelectionBody {
  connectionId?: string;
  cloudId?: string;
  mode: "all" | "projects";
  projects: string[];
}

/** Strict body parser: unknown fields (including any tenant field) are rejected. */
export function parseSelectionBody(body: unknown): SelectionBody | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["connectionId", "cloudId", "mode", "projects"].includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(", ")}`;
  if (b.mode !== "all" && b.mode !== "projects") return 'mode must be "all" or "projects"';
  if (b.connectionId !== undefined && (typeof b.connectionId !== "string" || !b.connectionId || b.connectionId.length > 256)) return "connectionId must be a non-empty string";
  if (b.cloudId !== undefined && (typeof b.cloudId !== "string" || !b.cloudId || b.cloudId.length > 128)) return "cloudId must be a non-empty string";
  const projects = b.projects ?? [];
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS || !projects.every((p) => typeof p === "string" && PROJECT_RE.test(p))) {
    return `projects must be up to ${MAX_PROJECTS} project keys or ids`;
  }
  if (b.mode === "projects" && projects.length === 0) return 'mode "projects" needs at least one project';
  if (b.mode === "all" && projects.length > 0) return 'mode "all" takes no projects';
  return { connectionId: b.connectionId as string | undefined, cloudId: b.cloudId as string | undefined, mode: b.mode, projects: projects as string[] };
}

export async function selectionView(db: DbExecutor, tenantId: string): Promise<Record<string, unknown>> {
  const conns = await jiraConnections(db, tenantId);
  const out = [];
  for (const conn of conns) {
    const sites = [];
    for (const s of await listSites(db, tenantId, conn.connectionId)) {
      const scope = { tenantId, connectionId: conn.connectionId, cloudId: s.cloud_id };
      const sel = await getSelection(db, scope);
      const projects = (await listObjects(db, scope, { types: ["project"] })).map((p) => ({ id: p.content_id, key: p.project_key, name: p.title, live: !p.tombstoned_at, reason: p.tombstone_reason ?? p.inaccessible_reason ?? null }));
      sites.push({ cloudId: s.cloud_id, siteUrl: s.site_url, siteName: s.site_name, status: s.status, selection: { mode: sel.mode, projects: sel.projects, source: sel.source, updatedAt: sel.updatedAt }, projects });
    }
    out.push({ connectionId: conn.connectionId, status: conn.status, sites });
  }
  return { provider: "jira", connections: out };
}

export function registerJiraInternalRoutes(app: Hono, deps: InternalRouteDeps, dbOf: () => Promise<DbExecutor>): void {
  const base = "/tenants/:tenantId/jira/selection";

  app.get(base, async (c) => {
    if (!hasScope(principalOf(c), SCOPE_READ)) return err(c, 403, "insufficient_scope", `${SCOPE_READ} is required`);
    return c.json(await selectionView(await dbOf(), deps.tenantOf(c)));
  });

  app.put(base, async (c) => {
    const principal = principalOf(c);
    if (!principal || !hasScope(principal, SCOPE_BUILD)) return err(c, 403, "insufficient_scope", `${SCOPE_BUILD} is required`);
    const tenantId = deps.tenantOf(c);
    const parsed = parseSelectionBody(await c.req.json().catch(() => null));
    if (typeof parsed === "string") return err(c, 400, "invalid_body", parsed);
    const db = await dbOf();
    const conns = await jiraConnections(db, tenantId);
    const conn = parsed.connectionId ? conns.find((x) => x.connectionId === parsed.connectionId) : conns.length === 1 ? conns[0] : undefined;
    if (!conn) return err(c, 404, "unknown_connection", parsed.connectionId ? "no such Jira connection for this tenant" : "this tenant has no single Jira connection; pass connectionId");
    const cloudId = parsed.cloudId ?? "*";
    if (cloudId !== "*" && !(await listSites(db, tenantId, conn.connectionId)).some((s) => s.cloud_id === cloudId)) return err(c, 404, "unknown_site", "this Jira connection does not reach that site");
    await putSelection(db, tenantId, conn.connectionId, cloudId, parsed.mode, parsed.projects, `${principal.issuer}#${principal.subject}`);
    await syncSiteSelection(db, tenantId, conn.connectionId);
    // Donor rows (Nango record sync + detail sweep) are filtered by the selection at export: re-export them now.
    await rejournalDonorJiraRows(db, tenantId);
    // The next sweep sees the changed selection hash and starts a new full pass (new projects captured, removed ones leave the mirror).
    return c.json(await selectionView(db, tenantId));
  });
}
