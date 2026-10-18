import type { Context, Hono } from "hono";
import { redactProviderPayload } from "../../../vault/redaction.js";
import type { InternalRouteDeps } from "../../core/types.js";
import type { ForwardedPrincipal } from "../../internal/app.js";
import { BitbucketApiError, BitbucketAuthError, BitbucketClient, BitbucketRateLimitedError, isBitbucketUuid, isRecord, parseFullName, repoEndpoint } from "./api.js";
import { bitbucketConnections, markOutOfScope, type BitbucketConnectionRow } from "./content.js";
import { findRepoBySelection, listRefs, listRepos, listSelection, purgeRepoContent, setFilesRetired, setRepoStatus, setSelection, upsertRepo, type BitbucketDb } from "./store.js";

/**
 * Repository selection for the Bitbucket content lane (yc_msaw -> runtime internal API,
 * mounted under /internal/v1 behind the service token).
 *
 * The tenant is the one core's middleware verified against the forwarded principal
 * (deps.tenantOf); nothing in the body or query can name another tenant. A repository can
 * only be enabled when one of THIS tenant's active Bitbucket grants can read it. Reads need
 * memory:read, changes memory:build. Disabling keeps captured history (out of scope) unless
 * `purge: true` asks for removal of this lane's rows and stored bytes.
 */

const SCOPE_READ = "memory:read";
const SCOPE_BUILD = "memory:build";
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

/** Branch names an extra ref may use (a safe subset of git check-ref-format). */
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
  if (typeof b.repo !== "string" || !parseFullName(b.repo)) return "repo must be a workspace/repository Bitbucket full name";
  if (typeof b.syncing !== "boolean") return "syncing must be a boolean";
  if (b.purge !== undefined && typeof b.purge !== "boolean") return "purge must be a boolean";
  if (b.purge === true && b.syncing) return "purge applies only when syncing is false";
  if (b.refs !== undefined) {
    if (!b.syncing) return "refs apply only when syncing is true";
    if (!Array.isArray(b.refs) || b.refs.length > MAX_EXTRA_REFS || !b.refs.every((r) => typeof r === "string" && isValidBranchName(r))) return `refs must be up to ${MAX_EXTRA_REFS} branch names`;
  }
  return { repo: b.repo, syncing: b.syncing, purge: b.purge === true, ...(b.refs ? { refs: [...new Set(b.refs as string[])] } : {}) };
}

export async function selectionView(db: BitbucketDb, tenantId: string): Promise<Record<string, unknown>> {
  const conns = await bitbucketConnections(db, tenantId);
  const selection = await listSelection(db, tenantId);
  const repos = await listRepos(db, tenantId);
  const repositories = [];
  for (const s of selection) {
    const row = repos.find((r) => r.selected_key === s.repo_key) ?? repos.find((r) => r.full_name.toLowerCase() === s.repo_key);
    const refs = row ? await listRefs(db, tenantId, row.repo_uuid) : [];
    repositories.push({
      repo: s.full_name,
      syncing: s.selected,
      extraRefs: s.extra_refs,
      content: row
        ? {
            repoUuid: row.repo_uuid,
            fullName: row.full_name,
            status: row.status,
            statusReason: row.status_reason,
            mainBranch: row.main_branch,
            refs: refs.map((r) => ({ ref: r.ref_name, status: r.status, generation: r.committed_generation, commitSha: r.committed_commit_sha, mode: r.committed_mode, scanning: r.scan_commit_sha })),
          }
        : null,
    });
  }
  return {
    provider: "bitbucket",
    connections: conns.map((c) => ({ connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, status: c.status, quotaKey: c.quotaKey })),
    repositories,
  };
}

/** First active grant of this tenant that can read the repository, with its redacted payload. */
async function readableThrough(client: BitbucketClient, conns: readonly BitbucketConnectionRow[], name: string): Promise<{ conn: BitbucketConnectionRow; raw: Record<string, unknown> } | null> {
  for (const conn of conns) {
    try {
      const r = await client.getJson(conn, repoEndpoint(name), undefined, [403, 404]);
      if (r.status === 200 && isRecord(r.data)) return { conn, raw: redactProviderPayload("bitbucket", r.data) as Record<string, unknown> };
    } catch (error) {
      if (error instanceof BitbucketAuthError) continue;
      throw error;
    }
  }
  return null;
}

export interface BitbucketRouteDeps {
  db: () => Promise<BitbucketDb>;
  client: () => BitbucketClient;
}

export function registerBitbucketInternalRoutes(app: Hono, deps: InternalRouteDeps, routeDeps: BitbucketRouteDeps): void {
  const base = "/tenants/:tenantId/bitbucket/repositories";

  app.get(base, async (c) => {
    if (!hasScope(principalOf(c), SCOPE_READ)) return err(c, 403, "insufficient_scope", `${SCOPE_READ} is required`);
    return c.json(await selectionView(await routeDeps.db(), deps.tenantOf(c)));
  });

  app.put(`${base}/selection`, async (c) => {
    const principal = principalOf(c);
    if (!principal || !hasScope(principal, SCOPE_BUILD)) return err(c, 403, "insufficient_scope", `${SCOPE_BUILD} is required`);
    const tenantId = deps.tenantOf(c);
    const parsed = parseSelectionBody(await c.req.json().catch(() => null));
    if (typeof parsed === "string") return err(c, 400, "invalid_body", parsed);
    const db = await routeDeps.db();

    if (parsed.syncing) {
      const conns = (await bitbucketConnections(db, tenantId)).filter((x) => x.status === "active");
      if (!conns.length) return err(c, 404, "no_connection", "this tenant has no active Bitbucket connection");
      let client: BitbucketClient;
      try {
        client = routeDeps.client();
      } catch (error) {
        return err(c, 503, "not_configured", error instanceof Error ? error.message : String(error));
      }
      let found: Awaited<ReturnType<typeof readableThrough>>;
      try {
        found = await readableThrough(client, conns, parsed.repo);
      } catch (error) {
        if (error instanceof BitbucketRateLimitedError) return err(c, 503, "rate_limited", error.message, { retryAt: error.retryAt?.toISOString() ?? null });
        if (error instanceof BitbucketApiError) return err(c, 503, "upstream_error", error.message);
        throw error;
      }
      if (!found) return err(c, 404, "unknown_repository", "no active Bitbucket connection of this tenant can read that repository");
      const fullName = typeof found.raw.full_name === "string" ? found.raw.full_name : "";
      const uuid = found.raw.uuid;
      if (!parseFullName(fullName) || !isBitbucketUuid(uuid)) return err(c, 503, "upstream_error", "Bitbucket returned a repository without uuid/full_name");
      const workspace = isRecord(found.raw.workspace) ? found.raw.workspace : null;
      const previous = await findRepoBySelection(db, tenantId, parsed.repo.toLowerCase());
      await setSelection(db, { tenantId, fullName: parsed.repo, selected: true, ...(parsed.refs ? { extraRefs: parsed.refs } : {}), by: principal.subject });
      await upsertRepo(db, {
        tenantId,
        repoUuid: uuid,
        workspaceUuid: workspace && isBitbucketUuid(workspace.uuid) ? String(workspace.uuid) : null,
        connectionId: found.conn.connectionId,
        providerConfigKey: found.conn.providerConfigKey,
        quotaKey: found.conn.quotaKey,
        fullName,
        selectedKey: parsed.repo.toLowerCase(),
        mainBranch: isRecord(found.raw.mainbranch) && typeof found.raw.mainbranch.name === "string" ? found.raw.mainbranch.name : null,
        isPrivate: typeof found.raw.is_private === "boolean" ? found.raw.is_private : null,
        raw: found.raw,
      });
      if (previous && previous.repo_uuid === uuid && previous.status === "out_of_scope") {
        await setRepoStatus(db, { tenantId, repoUuid: uuid }, "active", null);
        await setFilesRetired(db, { tenantId, repoUuid: uuid }, null, "bitbucket_repo_out_of_scope");
      }
    } else {
      await setSelection(db, { tenantId, fullName: parsed.repo, selected: false, by: principal.subject });
      const row = await findRepoBySelection(db, tenantId, parsed.repo.toLowerCase());
      if (row && parsed.purge) await purgeRepoContent(db, { tenantId, repoUuid: row.repo_uuid });
      else if (row) await markOutOfScope(db, { tenantId, repoUuid: row.repo_uuid }, "repository is no longer selected; captured snapshots are kept");
    }
    return c.json(await selectionView(db, tenantId));
  });
}
