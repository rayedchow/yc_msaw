import type { Context, Hono } from "hono";
import {
  capturedGithubRepos,
  githubRepoSyncSelection,
  listGithubInstallationRepos,
  mergeGithubRepoLists,
  purgeGithubRepoData,
  setGithubRepoSyncing,
  type GithubInstallationRepo,
} from "../../../integrations/github/repo-sync.js";
import type { InternalRouteDeps } from "../../core/types.js";
import type { ForwardedPrincipal } from "../../internal/app.js";
import { GithubApiError, GithubClient, GithubRateLimitedError, isRecord, repoEndpoint } from "./api.js";
import { githubConnections, markOutOfScope, redactGithubPayload, type GithubConnectionRow } from "./content.js";
import { findRepoByName, listRefs, listRepos, purgeRepoContent, quotaBlockedUntil, setFilesRetired, setRepoExtraRefs, upsertRepo, type GithubDb } from "./store.js";

/**
 * Repository selection for the GitHub provider (yc_msaw -> runtime internal API, mounted
 * under /internal/v1 behind the service token).
 *
 * The tenant is the one core's middleware verified against the forwarded principal
 * (deps.tenantOf); nothing in the body or query can name another tenant. A repository can
 * only be enabled when one of THIS tenant's active GitHub grants can read it. Reads need
 * memory:read, changes memory:build. Disabling keeps captured history (scope-out, like the
 * donor's scheduled reconcile) unless `purge: true` asks for the donor's destructive
 * user-unsync purge, which also removes this lane's rows and blobs.
 */

const SCOPE_READ = "memory:read";
const SCOPE_BUILD = "memory:build";
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u;
const MAX_EXTRA_REFS = 20;

type PrincipalEnv = { Variables: { principal?: ForwardedPrincipal } };

function principalOf(c: Context): ForwardedPrincipal | null {
  return (c as unknown as Context<PrincipalEnv>).get("principal") ?? null;
}

function hasScope(p: ForwardedPrincipal | null, scope: string): boolean {
  return Boolean(p?.scopes?.includes(scope));
}

function err(c: Context, status: 400 | 403 | 404 | 503, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return c.json({ error: { code, message, ...extra } }, status);
}

/** Branch names a configured extra ref may use (a safe subset of git check-ref-format). */
export function isValidBranchName(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/u.test(ref) &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.split("/").some((s) => s.startsWith("."))
  );
}

export interface SelectionBody {
  repo: string;
  syncing: boolean;
  purge: boolean;
  refs?: string[];
}

/** Strict body parser: unknown fields (including any tenant field) are rejected. */
export function parseSelectionBody(body: unknown): SelectionBody | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !["repo", "syncing", "purge", "refs"].includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(", ")}`;
  if (typeof b.repo !== "string" || !REPO_RE.test(b.repo)) return "repo must be an owner/name GitHub repository";
  if (typeof b.syncing !== "boolean") return "syncing must be a boolean";
  if (b.purge !== undefined && typeof b.purge !== "boolean") return "purge must be a boolean";
  if (b.purge === true && b.syncing) return "purge applies only when syncing is false";
  if (b.refs !== undefined) {
    if (!b.syncing) return "refs apply only when syncing is true";
    if (!Array.isArray(b.refs) || b.refs.length > MAX_EXTRA_REFS || !b.refs.every((r) => typeof r === "string" && isValidBranchName(r))) return `refs must be up to ${MAX_EXTRA_REFS} branch names`;
  }
  return { repo: b.repo, syncing: b.syncing, purge: b.purge === true, ...(b.refs ? { refs: [...new Set(b.refs as string[])] } : {}) };
}

export async function selectionView(db: GithubDb, tenantId: string, client: GithubClient | null): Promise<Record<string, unknown>> {
  const conns = (await githubConnections(db, tenantId)).filter((c) => c.status === "active");
  const connections: Array<Record<string, unknown>> = [];
  let installation: GithubInstallationRepo[] | null = null;
  for (const conn of conns) {
    const entry: Record<string, unknown> = { connectionId: conn.connectionId, providerConfigKey: conn.providerConfigKey, quotaKey: conn.quotaKey };
    const blocked = await quotaBlockedUntil(db, conn.quotaKey);
    if (!client) entry.installationRepositories = null;
    else if (blocked) entry.listingDeferredUntil = blocked.until.toISOString();
    else {
      try {
        const listed = await listGithubInstallationRepos(client, conn);
        entry.installationRepositories = listed?.length ?? null;
        if (listed) installation = [...(installation ?? []), ...listed];
      } catch (error) {
        entry.listingError = error instanceof Error ? error.message : String(error);
      }
    }
    connections.push(entry);
  }
  const merged = mergeGithubRepoLists({ installation, captured: await capturedGithubRepos(db, tenantId), selection: await githubRepoSyncSelection(db, tenantId) });
  const content = await listRepos(db, tenantId);
  const repositories = [];
  for (const m of merged) {
    const row = content.find((r) => r.full_name.toLowerCase() === m.fullName.toLowerCase() || r.selected_name.toLowerCase() === m.fullName.toLowerCase());
    const refs = row ? await listRefs(db, tenantId, row.repo_id) : [];
    repositories.push({
      ...m,
      content: row
        ? {
            repoId: row.repo_id,
            status: row.status,
            statusReason: row.status_reason,
            defaultBranch: row.default_branch,
            extraRefs: row.extra_refs,
            refs: refs.map((r) => ({ ref: r.ref_name, status: r.status, generation: r.committed_generation, commitSha: r.committed_commit_sha, scanning: r.scan_commit_sha })),
          }
        : null,
    });
  }
  return { provider: "github", connections, repositories };
}

/** First active grant of this tenant that can read the repository, with its redacted payload. */
async function readableThrough(client: GithubClient, conns: readonly GithubConnectionRow[], name: string): Promise<{ conn: GithubConnectionRow; raw: Record<string, unknown> } | null> {
  for (const conn of conns) {
    const r = await client.get(conn, repoEndpoint(name), undefined, [301, 302, 307, 403, 404]);
    if (r.status === 200 && isRecord(r.data)) return { conn, raw: redactGithubPayload(r.data) };
  }
  return null;
}

export interface GithubRouteDeps {
  db: () => Promise<GithubDb>;
  client: () => GithubClient;
}

export function registerGithubInternalRoutes(app: Hono, deps: InternalRouteDeps, routeDeps: GithubRouteDeps): void {
  const base = "/tenants/:tenantId/github/repositories";

  app.get(base, async (c) => {
    if (!hasScope(principalOf(c), SCOPE_READ)) return err(c, 403, "insufficient_scope", `${SCOPE_READ} is required`);
    let client: GithubClient | null = null;
    try {
      client = routeDeps.client();
    } catch {
      client = null;
    }
    return c.json(await selectionView(await routeDeps.db(), deps.tenantOf(c), client));
  });

  app.put(`${base}/selection`, async (c) => {
    const principal = principalOf(c);
    if (!principal || !hasScope(principal, SCOPE_BUILD)) return err(c, 403, "insufficient_scope", `${SCOPE_BUILD} is required`);
    const tenantId = deps.tenantOf(c);
    const parsed = parseSelectionBody(await c.req.json().catch(() => null));
    if (typeof parsed === "string") return err(c, 400, "invalid_body", parsed);
    const db = await routeDeps.db();
    const conns = (await githubConnections(db, tenantId)).filter((x) => x.status === "active");
    if (!conns.length) return err(c, 404, "no_connection", "this tenant has no active GitHub connection");
    const client = routeDeps.client();

    if (parsed.syncing) {
      let found: Awaited<ReturnType<typeof readableThrough>>;
      try {
        found = await readableThrough(client, conns, parsed.repo);
      } catch (error) {
        if (error instanceof GithubRateLimitedError) return err(c, 503, "rate_limited", error.message, { retryAt: error.retryAt?.toISOString() ?? null });
        if (error instanceof GithubApiError) return err(c, 503, "upstream_error", error.message);
        throw error;
      }
      if (!found) return err(c, 404, "unknown_repository", "no active GitHub connection of this tenant can read that repository");
      const fullName = String(found.raw.full_name);
      const repoId = String(found.raw.id);
      if (!REPO_RE.test(fullName) || !/^\d+$/u.test(repoId)) return err(c, 503, "upstream_error", "GitHub returned a repository without id/full_name");
      const previous = await findRepoByName(db, tenantId, fullName);
      await setGithubRepoSyncing(db, tenantId, fullName, true);
      await upsertRepo(db, {
        tenantId,
        repoId,
        connectionId: found.conn.connectionId,
        providerConfigKey: found.conn.providerConfigKey,
        quotaKey: found.conn.quotaKey,
        fullName,
        selectedName: fullName,
        defaultBranch: typeof found.raw.default_branch === "string" ? found.raw.default_branch : null,
        private: typeof found.raw.private === "boolean" ? found.raw.private : null,
        visibility: typeof found.raw.visibility === "string" ? found.raw.visibility : null,
        archived: typeof found.raw.archived === "boolean" ? found.raw.archived : null,
        raw: found.raw,
      });
      if (previous?.status === "out_of_scope") await setFilesRetired(db, { tenantId, repoId }, null, "github_repo_out_of_scope");
      if (parsed.refs) await setRepoExtraRefs(db, { tenantId, repoId }, parsed.refs);
    } else {
      // Every stored selection spelling of this repository (GitHub names are case-insensitive).
      const selection = await githubRepoSyncSelection(db, tenantId);
      const names = [...selection.keys()].filter((n) => n.toLowerCase() === parsed.repo.toLowerCase());
      for (const n of names.length ? names : [parsed.repo]) await setGithubRepoSyncing(db, tenantId, n, false);
      const row = await findRepoByName(db, tenantId, parsed.repo);
      if (parsed.purge) {
        for (const n of new Set([...names, parsed.repo, ...(row ? [row.full_name] : [])])) await purgeGithubRepoData(db, tenantId, n);
        if (row) await purgeRepoContent(db, { tenantId, repoId: row.repo_id });
      } else if (row) {
        await markOutOfScope(db, { tenantId, repoId: row.repo_id });
      }
    }
    return c.json(await selectionView(db, tenantId, null));
  });
}
