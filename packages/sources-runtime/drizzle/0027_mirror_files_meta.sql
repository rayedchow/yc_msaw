-- Staged-document envelope (docs/source-pipeline-plan.md §3): one additive
-- jsonb column on mirror_files carrying { provider, externalId, kind, title,
-- versionRef, sourceUpdatedAt, sourceAcl, authorEmail, authorName,
-- updatedByEmail, aliases, sourceRefs }. Nullable on purpose — existing rows
-- regenerate their envelope over time as renderers re-materialize them.

ALTER TABLE "mirror_files" ADD COLUMN "meta" jsonb;
