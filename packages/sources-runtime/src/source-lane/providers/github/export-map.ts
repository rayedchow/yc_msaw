import { sql } from "drizzle-orm";
import type { ExportContext, ExtraTableExport, JournalInfo, SourceFileChange, SourcePutFile } from "../../core/types.js";
import { contentFilePath, contentTypeFor, headFilePath, PROVIDER, repoFilePath, snapshotFilePath } from "./paths.js";
import {
  fileCounts,
  getBlob,
  getFileByRowKey,
  getRefByRowKey,
  getRepo,
  getRepoByRowKey,
  getSnapshotByRowKey,
  isoOrNull,
  listFiles,
  loadChunk,
  rowsOf,
} from "./store.js";

/**
 * Exporters for the GitHub content-lane tables (drizzle/9300).
 *
 * Each map reads the CURRENT row (tenant scoped) and returns every file the row
 * owns. Ordering never relies on commit dates (user-controlled) or SHAs: files
 * carry `sourceVersion.ordinal` = the scan generation in which their bytes last
 * changed, HEAD manifests and snapshots the committed generation, and
 * `sourceUpdatedAt` stays null so a real HEAD rollback (A->B->A, new generation)
 * and a later deletion are never refused by the store's time guard.
 */

export const T_REPOS = "github_source_repos";
export const T_REFS = "github_source_refs";
export const T_FILES = "github_source_files";
export const T_SNAPSHOTS = "github_source_snapshots";
const MAX_LISTED_OMISSIONS = 1000;

function jsonFile(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** JSON document whose `raw` member is the stored jsonb text spliced verbatim (no JavaScript re-encoding). */
function docWithRaw(head: Record<string, unknown>, rawText: string | null): Buffer {
  if (rawText === null) return jsonFile({ ...head, raw: null });
  const headJson = JSON.stringify(head, null, 2).slice(0, -2);
  return Buffer.from(`${headJson},\n  "raw": ${rawText}\n}\n`, "utf8");
}

function capturedAt(rowTime: unknown, journal: JournalInfo): string {
  return journal.op === "INSERT" ? (isoOrNull(rowTime) ?? journal.enqueuedAt) : journal.enqueuedAt;
}

function deletes(paths: readonly string[], keep: ReadonlySet<string>, reason: string, at: string, provenance: Record<string, unknown>): SourceFileChange[] {
  return [...new Set(paths)].filter((p) => !keep.has(p)).map((path) => ({ op: "delete" as const, path, deletedAt: at, reason, capturedAt: at, provenance }));
}

/**
 * Deletes for this row's paths, minus paths another exported row now owns (a repository
 * renamed away and a new repository created under the old name share paths).
 */
async function ownDeletes(ctx: ExportContext, table: string, rowKey: string, paths: readonly string[], reason: string, at: string, provenance: Record<string, unknown>): Promise<SourceFileChange[]> {
  const unique = [...new Set(paths)];
  if (!unique.length) return [];
  const owned = new Set(
    rowsOf<{ path: string }>(
      await ctx.executor.execute(sql`
        SELECT DISTINCT path FROM source_lane_exported
        WHERE tenant_id = ${ctx.tenantId} AND path IN (${sql.join(unique.map((p) => sql`${p}`), sql`, `)}) AND NOT (table_name = ${table} AND row_key = ${rowKey})
      `),
    ).map((r) => r.path),
  );
  return deletes(unique, owned, reason, at, provenance);
}

// ------------------------------------------------------------------ repositories

export async function mapRepoRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const repo = await getRepoByRowKey(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_REPOS, rowKey };
  if (!repo) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const at = capturedAt(repo.updated_at, journal);
  const path = repoFilePath(repo.full_name);
  const provenance = { ...prov, repoId: repo.repo_id, repository: repo.full_name };
  // Out of scope: the donor reconcile removes derived files of the repository; raw snapshots stay.
  if (repo.status === "out_of_scope") return ownDeletes(ctx, T_REPOS, rowKey, [...previousPaths, path], "github_repo_out_of_scope", at, provenance);
  return [
    {
      op: "put",
      path,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw(
        {
          schema: "procmem.github-repository/v1",
          repoId: repo.repo_id,
          fullName: repo.full_name,
          selectedAs: repo.selected_name,
          defaultBranch: repo.default_branch,
          extraRefs: repo.extra_refs,
          private: repo.private,
          visibility: repo.visibility,
          archived: repo.archived,
          status: repo.status,
          statusReason: repo.status_reason,
          firstSeenAt: isoOrNull(repo.first_seen_at),
        },
        repo.raw_text,
      ),
      sourceUpdatedAt: null,
      capturedAt: at,
      provenance,
    },
  ];
}

// ------------------------------------------------------------------ refs (HEAD manifests)

export async function mapRefRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const ref = await getRefByRowKey(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_REFS, rowKey };
  if (!ref) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const repo = await getRepo(ctx.executor, ctx.tenantId, ref.repo_id);
  if (!repo) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const at = capturedAt(ref.updated_at, journal);
  const path = headFilePath(repo.full_name, ref.ref_name);
  const provenance = { ...prov, repoId: ref.repo_id, repository: repo.full_name, ref: ref.ref_name, generation: ref.committed_generation, commitSha: ref.committed_commit_sha };
  if (ref.status === "retired") return ownDeletes(ctx, T_REFS, rowKey, [...previousPaths, path], "github_ref_retired", at, provenance);
  if (ref.committed_generation === null) return ownDeletes(ctx, T_REFS, rowKey, previousPaths, "github_ref_not_scanned", at, provenance);
  const scope = { tenantId: ctx.tenantId, repoId: ref.repo_id, ref: ref.ref_name };
  const omitted = (await listFiles(ctx.executor, scope, { state: "live", omitted: true, limit: MAX_LISTED_OMISSIONS + 1 })).map((f) => ({
    path: f.path,
    reason: f.omit_reason,
    mode: f.mode,
    ...(f.entry_type === "commit" ? { submoduleCommit: f.blob_sha } : { blobSha: f.blob_sha, size: f.size }),
  }));
  const counts = await fileCounts(ctx.executor, scope);
  const committed = ref.committed_counts ?? {};
  return [
    {
      op: "put",
      path,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw(
        {
          schema: "procmem.github-ref-head/v1",
          repoId: ref.repo_id,
          repository: repo.full_name,
          ref: ref.ref_name,
          status: ref.status,
          statusReason: ref.status_reason,
          generation: ref.committed_generation,
          commitSha: ref.committed_commit_sha,
          treeSha: ref.committed_tree_sha,
          committedAt: isoOrNull(ref.committed_at),
          complete: committed.complete === 1,
          files: counts,
          lastScan: committed,
          omitted: omitted.slice(0, MAX_LISTED_OMISSIONS),
          omittedListTruncated: omitted.length > MAX_LISTED_OMISSIONS,
          note: "files/ holds the exact bytes of every blob at this commit except the omitted paths; snapshot records are under _snapshots/. Commit dates in raw are author-controlled and are not used for ordering.",
        },
        ref.committed_commit_raw_text,
      ),
      sourceUpdatedAt: null,
      capturedAt: at,
      sourceVersion: { ref: ref.committed_commit_sha ?? ref.status, ordinal: ref.committed_generation },
      provenance,
    },
  ];
}

// ------------------------------------------------------------------ files (exact bytes)

export async function mapFileRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const f = await getFileByRowKey(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_FILES, rowKey };
  if (!f) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const repo = await getRepo(ctx.executor, ctx.tenantId, f.repo_id);
  if (!repo) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const at = capturedAt(f.updated_at, journal);
  const path = contentFilePath(repo.full_name, f.ref_name, f.path);
  const provenance: Record<string, unknown> = {
    ...prov,
    repoId: f.repo_id,
    repository: repo.full_name,
    ref: f.ref_name,
    gitPath: f.path,
    mode: f.mode,
    blobSha: f.blob_sha,
    generation: f.content_generation,
    commitSha: f.content_commit_sha,
    firstGeneration: f.first_generation,
    ...(f.renamed_from ? { renamedFrom: f.renamed_from } : {}),
    ...(f.mode === "120000" ? { symlink: true } : {}),
  };
  if (f.state === "deleted") {
    return ownDeletes(ctx, T_FILES, rowKey, [...previousPaths, path], f.delete_reason ?? "github_deleted", at, {
      ...provenance,
      deletedGeneration: f.deleted_generation,
      deletedCommitSha: f.deleted_commit_sha,
      ...(f.renamed_to ? { renamedTo: f.renamed_to } : {}),
    });
  }
  if (f.retired_reason) return ownDeletes(ctx, T_FILES, rowKey, [...previousPaths, path], f.retired_reason, at, provenance);
  // No placeholder bytes: an omitted file (too large, fetch failed, submodule) is listed in _head.json only.
  if (f.omit_reason) return ownDeletes(ctx, T_FILES, rowKey, [...previousPaths, path], `github_${f.omit_reason}`, at, provenance);
  const blob = await getBlob(ctx.executor, ctx.tenantId, f.blob_sha);
  if (!blob) throw new Error(`github blob ${f.blob_sha} for ${repo.full_name}@${f.ref_name}:${f.path} is not stored`);
  const put: SourcePutFile = {
    op: "put",
    path,
    kind: blob.is_text ? "raw" : "binary",
    contentType: contentTypeFor(f.path, blob.is_text),
    content: Buffer.alloc(0),
    chunked: { sha256: blob.sha256, size: blob.size, chunks: blob.chunks, load: (sha) => loadChunk(ctx.executor, ctx.tenantId, sha) },
    sourceUpdatedAt: null,
    capturedAt: at,
    sourceVersion: { ref: `${f.content_commit_sha}:${f.blob_sha}`, ordinal: f.content_generation },
    provenance,
  };
  // A moved path (repository renamed) is deleted by the exporter unless another row owns it.
  return [put];
}

// ------------------------------------------------------------------ snapshots (append-only)

export async function mapSnapshotRow(ctx: ExportContext, rowKey: string, journal: JournalInfo, previousPaths: readonly string[]): Promise<SourceFileChange[]> {
  const s = await getSnapshotByRowKey(ctx.executor, ctx.tenantId, rowKey);
  const prov = { provider: PROVIDER, table: T_SNAPSHOTS, rowKey };
  if (!s) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const repo = await getRepo(ctx.executor, ctx.tenantId, s.repo_id);
  if (!repo) return ownDeletes(ctx, prov.table, rowKey, previousPaths, "github_repo_purged", journal.enqueuedAt, prov);
  const path = snapshotFilePath(repo.full_name, s.ref_name, s.generation);
  const at = capturedAt(s.committed_at, journal);
  const provenance = { ...prov, repoId: s.repo_id, repository: repo.full_name, ref: s.ref_name, generation: s.generation, commitSha: s.commit_sha };
  return [
    {
      op: "put",
      path,
      kind: "raw",
      contentType: "application/json",
      content: docWithRaw(
        {
          schema: "procmem.github-snapshot/v1",
          repoId: s.repo_id,
          repository: repo.full_name,
          ref: s.ref_name,
          generation: s.generation,
          previousGeneration: s.previous_generation,
          commitSha: s.commit_sha,
          treeSha: s.tree_sha,
          committedAt: isoOrNull(s.committed_at),
          complete: s.complete,
          incompleteReasons: s.incomplete_reasons,
          counts: s.counts,
          changes: s.changes,
          changesTruncated: s.changes_truncated,
        },
        s.commit_raw_text,
      ),
      sourceUpdatedAt: null,
      capturedAt: at,
      sourceVersion: { ref: s.commit_sha ?? `g${s.generation}`, ordinal: s.generation },
      provenance,
    },
  ];
}

export const GITHUB_EXTRA_TABLES: readonly ExtraTableExport[] = [
  { table: T_REPOS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapRepoRow },
  { table: T_REFS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapRefRow },
  { table: T_FILES, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapFileRow },
  { table: T_SNAPSHOTS, tenantColumn: "tenant_id", keyColumn: "row_key", map: mapSnapshotRow },
];
