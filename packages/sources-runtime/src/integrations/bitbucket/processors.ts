import {
  materializeBitbucketPullRequestSourceWiki,
  materializeBitbucketRepositorySourceWiki,
} from "../../mirror/materializer.js";
import { nangoRecordVersion, processGenericNangoRecord } from "../nango/capture.js";
import {
  registerGenericNangoModels,
  registerProcessor,
  type NangoExecutor,
  type NangoRecord,
  type NangoRecordProcessorContext,
} from "../nango/types.js";

/**
 * Sync models the live Nango bitbucket integration emits beyond the three
 * rendered ones (live-verified against the configured environment's sync
 * status). Generic lossless capture only - no renderer yet.
 */
const BITBUCKET_GENERIC_MODELS = [
  { model: "Branch", eventType: "branch" },
  { model: "Pipeline", eventType: "pipeline" },
  { model: "Tag", eventType: "tag" },
  { model: "Workspace", eventType: "workspace" },
  { model: "WorkspaceMember", eventType: "workspace_member" },
];

export function registerBitbucketProcessors(): void {
  registerProcessor({
    provider: "bitbucket",
    model: "PullRequest",
    process: processBitbucketPullRequestRecord,
  });
  registerProcessor({
    provider: "bitbucket",
    model: "Commit",
    process: processBitbucketCommitRecord,
  });
  registerProcessor({
    provider: "bitbucket",
    model: "Repository",
    process: processBitbucketRepositoryRecord,
  });
  registerGenericNangoModels("bitbucket", BITBUCKET_GENERIC_MODELS);
}

export async function processBitbucketPullRequestRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = bitbucketRepoFullName(record) ?? "unknown-repo";
  const pullRequestId = stringValue(record.id) ?? stringValue(record.pullRequestId) ?? stringValue(record.pull_request_id) ?? "unknown";
  const updated = bitbucketUpdatedAt(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "bitbucket",
    model: "PullRequest",
    record,
    eventType: "pull_request",
    sourceEventId: `bitbucket:pr:${repoFullName}:${pullRequestId}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });

  await materializeBitbucketPullRequestSourceWiki(ctx.tenantId, {
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    repoFullName,
    pullRequestId,
    rawPayload: record,
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

export async function processBitbucketCommitRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = bitbucketRepoFullName(record) ?? "unknown-repo";
  const hash = stringValue(record.hash) ?? stringValue(record.sha) ?? stringValue(record.id) ?? "unknown";
  const author = bitbucketCommitAuthor(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "bitbucket",
    model: "Commit",
    record,
    eventType: "commit",
    sourceEventId: `bitbucket:commit:${repoFullName}:${hash}`,
    sourceUpdatedAt: stringValue(record.date) ?? stringValue(record.created_on) ?? stringValue(record.createdAt),
    extractedEntities: emailEntity(author.email, author.name),
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

export async function processBitbucketRepositoryRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = bitbucketRepoFullName(record) ?? stringValue(record.full_name) ?? "unknown-repo";
  const repoKey = stringValue(record.uuid) ?? stringValue(record.id) ?? repoFullName;
  const updated = bitbucketUpdatedAt(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "bitbucket",
    model: "Repository",
    record,
    eventType: "repository",
    sourceEventId: `bitbucket:repo:${repoKey}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });

  await materializeBitbucketRepositorySourceWiki(ctx.tenantId, {
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    repoFullName,
    rawPayload: record,
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

function bitbucketRepoFullName(record: NangoRecord): string | null {
  const destination = objectValue(record.destination);
  const destinationRepo = objectValue(destination?.repository);
  const repository = objectValue(record.repository);
  const repo = objectValue(record.repo);
  return stringValue(destinationRepo?.full_name)
    ?? stringValue(destinationRepo?.fullName)
    ?? stringValue(repository?.full_name)
    ?? stringValue(repository?.fullName)
    ?? stringValue(repo?.full_name)
    ?? stringValue(repo?.fullName)
    ?? stringValue(record.repoFullName)
    ?? stringValue(record.repo_full_name)
    ?? stringValue(record.full_name)
    ?? stringValue(record.fullName);
}

function bitbucketUpdatedAt(record: NangoRecord): string | null {
  const metadata = objectValue(record._nango_metadata) ?? objectValue(record._nangoMetadata);
  return stringValue(record.updated_on)
    ?? stringValue(record.updatedAt)
    ?? stringValue(record.updated_at)
    ?? stringValue(metadata?.updated_at)
    ?? stringValue(metadata?.updatedAt);
}

function bitbucketCommitAuthor(record: NangoRecord): { name: string | null; email: string | null } {
  const author = objectValue(record.author);
  const raw = stringValue(author?.raw) ?? stringValue(record.authorRaw) ?? stringValue(record.author);
  const rawParts = raw ? parseNameEmail(raw) : null;
  return {
    name: stringValue(author?.name)
      ?? stringValue(author?.display_name)
      ?? stringValue(author?.displayName)
      ?? rawParts?.name
      ?? null,
    email: stringValue(author?.email)
      ?? stringValue(record.authorEmail)
      ?? rawParts?.email
      ?? null,
  };
}

function emailEntity(email: string | null, name: string | null): Record<string, unknown>[] | null {
  if (!email) return null;
  return [{
    type: "email_contact",
    id: email.toLowerCase(),
    email: email.toLowerCase(),
    ...(name ? { name } : {}),
  }];
}

function parseNameEmail(value: string): { name: string | null; email: string | null } | null {
  const match = value.match(/^(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>$/u);
  if (!match) return { name: null, email: value.includes("@") ? value.trim() : null };
  return {
    name: match[1]?.trim() || null,
    email: match[2]?.trim() || null,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
