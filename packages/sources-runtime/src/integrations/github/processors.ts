import {
  materializeGithubIssueSourceWiki,
  materializeGithubPullRequestSourceWiki,
  materializeGithubRepositorySourceWiki,
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
 * The current github-app sync TEMPLATE names its models GithubPullRequest /
 * GithubCommit (GraphQL-shaped, slim: no body, number, or repo full name).
 * Registered as generic-capture aliases so whichever model naming the live
 * environment runs, its records land in the raw ledger; asking for a model
 * that doesn't exist is a safe empty no-op. Mirror rendering for PRs comes
 * from the proxy detail lane (full REST payloads), not these slim records.
 */
const GITHUB_TEMPLATE_ALIAS_MODELS = [
  { model: "GithubPullRequest", eventType: "pull_request" },
  { model: "GithubCommit", eventType: "commit" },
];

export function registerGithubProcessors(): void {
  registerProcessor({
    provider: "github",
    model: "Issue",
    process: processGithubIssueRecord,
  });
  registerProcessor({
    provider: "github",
    model: "PullRequest",
    process: processGithubPullRequestRecord,
  });
  registerProcessor({
    provider: "github",
    model: "Commit",
    process: processGithubCommitRecord,
  });
  registerProcessor({
    provider: "github",
    model: "Repository",
    process: processGithubRepositoryRecord,
  });
  registerGenericNangoModels("github", GITHUB_TEMPLATE_ALIAS_MODELS);
}

export async function processGithubIssueRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = githubRepoFullName(record, false) ?? "unknown-repo";
  const repoKey = githubRepoKey(record, false) ?? repoFullName;
  const number = stringValue(record.number) ?? stringValue(record.issueNumber) ?? stringValue(record.issue_number) ?? "unknown";
  const updated = githubUpdatedAt(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "github",
    model: "Issue",
    record,
    eventType: "issue",
    sourceEventId: `github:issue:${repoKey}:${number}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });

  await materializeCapturedGithubIssueRecord(record, {
    tenantId: ctx.tenantId,
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    repoKey,
    repoFullName,
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

/** Shared issue render path for registered sync records and proxy-captured issues. */
export async function materializeCapturedGithubIssueRecord(
  record: NangoRecord,
  input: {
    tenantId: string;
    eventId: string | null;
    sourceEventId: string;
    repoKey?: string;
    repoFullName?: string;
  },
): Promise<void> {
  const repoFullName = input.repoFullName ?? githubRepoFullName(record, false) ?? "unknown-repo";
  const repoKey = input.repoKey ?? githubRepoKey(record, false) ?? repoFullName;
  const number = stringValue(record.number) ?? stringValue(record.issueNumber) ?? stringValue(record.issue_number) ?? "unknown";
  await materializeGithubIssueSourceWiki(input.tenantId, {
    eventId: input.eventId,
    sourceEventId: input.sourceEventId,
    repoKey,
    repoFullName,
    number,
    rawPayload: record,
  });
}

export async function processGithubPullRequestRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = githubRepoFullName(record, true) ?? "unknown-repo";
  const repoKey = githubRepoKey(record, true) ?? repoFullName;
  const number = stringValue(record.number) ?? stringValue(record.pullRequestNumber) ?? stringValue(record.pull_request_number) ?? "unknown";
  const updated = githubUpdatedAt(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "github",
    model: "PullRequest",
    record,
    eventType: "pull_request",
    sourceEventId: `github:pr:${repoKey}:${number}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });

  await materializeGithubPullRequestSourceWiki(ctx.tenantId, {
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    repoKey,
    repoFullName,
    number,
    rawPayload: record,
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

export async function processGithubCommitRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = githubRepoFullName(record, false) ?? "unknown-repo";
  const repoKey = githubRepoKey(record, false) ?? repoFullName;
  const sha = stringValue(record.sha) ?? stringValue(record.hash) ?? stringValue(record.id) ?? "unknown";
  const identity = githubCommitIdentity(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "github",
    model: "Commit",
    record,
    eventType: "commit",
    sourceEventId: `github:commit:${repoKey}:${sha}`,
    sourceUpdatedAt: identity.date,
    extractedEntities: githubCommitIdentityEntities(identity),
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

export async function processGithubRepositoryRecord(
  executor: NangoExecutor,
  record: NangoRecord,
  ctx: NangoRecordProcessorContext,
): Promise<{ stored: boolean; skipped: boolean }> {
  const repoFullName = githubRepoFullName(record, false) ?? "unknown-repo";
  const repoKey = githubRepoKey(record, false) ?? stringValue(record.id) ?? repoFullName;
  const updated = githubUpdatedAt(record);
  const captured = await processGenericNangoRecord(executor, {
    tenantId: ctx.tenantId,
    provider: "github",
    model: "Repository",
    record,
    eventType: "repository",
    sourceEventId: `github:repo:${repoKey}:${updated ?? nangoRecordVersion(record)}`,
    sourceUpdatedAt: updated,
  });

  await materializeGithubRepositorySourceWiki(ctx.tenantId, {
    eventId: captured.eventId,
    sourceEventId: captured.sourceEventId,
    repoKey,
    repoFullName,
    rawPayload: record,
  });
  return { stored: captured.stored, skipped: !captured.stored };
}

function githubRepoKey(record: NangoRecord, preferBase: boolean): string | null {
  const baseRepo = githubBaseRepo(record);
  const repository = objectValue(record.repository);
  const repo = objectValue(record.repo);
  return stringValue(record.repoId)
    ?? stringValue(record.repo_id)
    ?? stringValue(record.repositoryId)
    ?? stringValue(record.repository_id)
    ?? (preferBase ? stringValue(baseRepo?.id) : null)
    ?? stringValue(repository?.id)
    ?? stringValue(repo?.id)
    ?? (!preferBase ? stringValue(baseRepo?.id) : null);
}

function githubRepoFullName(record: NangoRecord, preferBase: boolean): string | null {
  const baseRepo = githubBaseRepo(record);
  const repository = objectValue(record.repository);
  const repo = objectValue(record.repo);
  return (preferBase ? stringValue(baseRepo?.full_name) ?? stringValue(baseRepo?.fullName) : null)
    ?? stringValue(repository?.full_name)
    ?? stringValue(repository?.fullName)
    ?? stringValue(repo?.full_name)
    ?? stringValue(repo?.fullName)
    ?? stringValue(record.repoFullName)
    ?? stringValue(record.repo_full_name)
    ?? stringValue(record.full_name)
    ?? stringValue(record.fullName)
    ?? (!preferBase ? stringValue(baseRepo?.full_name) ?? stringValue(baseRepo?.fullName) : null);
}

function githubBaseRepo(record: NangoRecord): Record<string, unknown> | null {
  const base = objectValue(record.base);
  return objectValue(base?.repo) ?? objectValue(base?.repository);
}

function githubUpdatedAt(record: NangoRecord): string | null {
  const metadata = objectValue(record._nango_metadata) ?? objectValue(record._nangoMetadata);
  return stringValue(record.updated_at)
    ?? stringValue(record.updatedAt)
    ?? stringValue(metadata?.updated_at)
    ?? stringValue(metadata?.updatedAt);
}

function githubCommitIdentity(record: NangoRecord): {
  name: string | null;
  email: string | null;
  login: string | null;
  date: string | null;
} {
  const commit = objectValue(record.commit);
  const commitAuthor = objectValue(commit?.author);
  const author = objectValue(record.author);
  const committer = objectValue(record.committer);
  const rawAuthor = parseNameEmail(stringValue(record.author) ?? "");
  return {
    name: stringValue(commitAuthor?.name)
      ?? stringValue(author?.name)
      ?? rawAuthor?.name
      ?? null,
    email: stringValue(commitAuthor?.email)
      ?? stringValue(author?.email)
      ?? stringValue(record.authorEmail)
      ?? rawAuthor?.email
      ?? null,
    login: stringValue(author?.login)
      ?? stringValue(committer?.login)
      ?? stringValue(record.authorLogin)
      ?? stringValue(record.author_login)
      ?? null,
    date: stringValue(commitAuthor?.date)
      ?? stringValue(record.date)
      ?? stringValue(record.timestamp)
      ?? null,
  };
}

function githubCommitIdentityEntities(
  identity: { name: string | null; email: string | null; login: string | null },
): Record<string, unknown>[] | null {
  const entities: Record<string, unknown>[] = [];
  const email = identity.email;
  const hasUsableEmail = email && !isGithubNoreplyEmail(email);
  if (hasUsableEmail) {
    entities.push({
      type: "email_contact",
      id: email.toLowerCase(),
      email: email.toLowerCase(),
      ...(identity.name ? { name: identity.name } : {}),
    });
  } else if (identity.login) {
    entities.push({
      type: "github_user",
      id: identity.login,
      login: identity.login,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  return entities.length > 0 ? entities : null;
}

function isGithubNoreplyEmail(email: string): boolean {
  return /@users\.noreply\.github\.com$/iu.test(email.trim());
}

function parseNameEmail(value: string): { name: string | null; email: string | null } | null {
  if (!value) return null;
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
