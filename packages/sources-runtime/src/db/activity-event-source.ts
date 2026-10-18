export type ActivityEventRecordKind = "snapshot" | "activity" | "tombstone";

export interface ActivityEventSourceContract {
  sourceNamespace: string | null;
  sourceObjectId: string | null;
  recordKind: ActivityEventRecordKind;
}

export function deriveActivityEventSourceContract(input: {
  source: string;
  eventType: string;
  rawPayload: Record<string, unknown>;
  defaultRecordKind?: ActivityEventRecordKind;
}): ActivityEventSourceContract {
  const source = input.source.trim().toLowerCase();
  const eventType = input.eventType.trim().toLowerCase();
  const recordKind = tombstoneEvent(eventType)
    ? "tombstone"
    : input.defaultRecordKind ?? activityOrSnapshot(eventType);
  const identity = sourceIdentity(source, eventType, input.rawPayload);
  return {
    sourceNamespace: identity?.namespace ?? null,
    sourceObjectId: identity?.id ?? null,
    recordKind,
  };
}

function sourceIdentity(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
): { namespace: string; id: string } | null {
  if (source === "gmail") {
    const mailbox = text(payload._user_email);
    const id = text(payload.gmailId) ?? text(payload.id);
    return mailbox && id ? { namespace: `mailbox:${mailbox.toLowerCase()}`, id: `message:${id}` } : null;
  }
  if (source === "calendar") {
    const calendar = text(payload._calendar_id) ?? text(payload.calendarId);
    const id = text(payload.id) ?? text(payload.eventId);
    return calendar && id ? { namespace: `calendar:${calendar}`, id: `event:${id}` } : null;
  }
  if (source === "granola") {
    const id = text(payload.granolaId) ?? text(payload.id);
    return id ? { namespace: "tenant", id: `meeting_note:${id}` } : null;
  }
  if (source === "gdocs" || source === "google-docs") {
    const fileId = text(payload.fileId);
    const commentId = text(payload.commentId);
    return fileId && commentId
      ? { namespace: `document:${fileId}`, id: `comment:${commentId}` }
      : null;
  }
  if (source === "slack") {
    const workspace = text(payload._team_id) ?? text(payload.team_id) ?? text(payload.teamId);
    const channel = text(payload._channel) ?? text(payload.channel);
    const timestamp = text(payload._object_ts) ?? text(payload.ts);
    return workspace && channel && timestamp
      ? { namespace: `workspace:${workspace}`, id: `message:${channel}:${timestamp}` }
      : workspace && channel
        ? { namespace: `workspace:${workspace}`, id: `channel:${channel}` }
        : null;
  }
  if (source === "notion") {
    const workspace = text(payload.workspace_id) ?? text(payload.workspaceId);
    const entity = object(payload.entity);
    const id = text(entity?.id) ?? text(payload.id) ?? text(payload.pageId);
    return workspace && id ? { namespace: `workspace:${workspace}`, id: `object:${id}` } : null;
  }
  if (source === "jira") return atlassianIdentity(eventType, payload, JIRA_OBJECT_TYPES);
  if (source === "confluence") return atlassianIdentity(eventType, payload, CONFLUENCE_OBJECT_TYPES);
  if (source === "github") return githubIdentity(eventType, payload);
  if (source === "bitbucket") return bitbucketIdentity(eventType, payload);
  return null;
}

const JIRA_OBJECT_TYPES: Readonly<Record<string, string>> = {
  issue: "issue",
  issue_detail: "issue",
  issue_comment: "comment",
  issuecomment: "comment",
  project: "project",
  user: "user",
  field: "field",
  issue_type: "issue_type",
  project_component: "component",
  project_version: "version",
};

const CONFLUENCE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  page: "page",
  footer_comment: "comment",
  footercomment: "comment",
  inline_comment: "comment",
  inlinecomment: "comment",
  attachment: "attachment",
  blog_post: "blog_post",
  blogpost: "blog_post",
  space: "space",
};

const GITHUB_OBJECT_TYPES: Readonly<Record<string, string>> = {
  issue: "issue",
  pull_request: "pull_request",
  pull_request_detail: "pull_request",
  issue_comment: "comment",
  pr_review_comment: "review_comment",
  commit: "commit",
  repository: "repository",
};

const BITBUCKET_OBJECT_TYPES: Readonly<Record<string, string>> = {
  issue: "issue",
  issue_comment: "comment",
  pull_request: "pull_request",
  pull_request_detail: "pull_request",
  pr_comment: "comment",
  commit: "commit",
  repository: "repository",
};

function atlassianIdentity(
  eventType: string,
  payload: Record<string, unknown>,
  types: Readonly<Record<string, string>>,
): { namespace: string; id: string } | null {
  const cloudId = identifier(payload.cloudId) ?? identifier(payload.cloud_id);
  const type = types[nativeEventType(eventType)];
  const id = type ? atlassianObjectId(payload, type) : null;
  return cloudId && type && id
    ? { namespace: `site:${cloudId}`, id: `${type}:${id}` }
    : null;
}

function atlassianObjectId(payload: Record<string, unknown>, type: string): string | null {
  if (type === "issue") return firstIdentifier(payload.id, payload.issueId, payload.issue_id);
  if (type === "comment") return firstIdentifier(payload.id, payload.commentId, payload.comment_id);
  if (type === "page") return firstIdentifier(payload.id, payload.pageId, payload.page_id);
  if (type === "user") return firstIdentifier(payload.accountId, payload.account_id, payload.id);
  if (type === "issue_type") return firstIdentifier(payload.id, payload.issueTypeId, payload.issue_type_id);
  if (type === "component") return firstIdentifier(payload.id, payload.componentId, payload.component_id);
  if (type === "version") return firstIdentifier(payload.id, payload.versionId, payload.version_id);
  if (type === "attachment") return firstIdentifier(payload.id, payload.attachmentId, payload.attachment_id);
  if (type === "blog_post") return firstIdentifier(payload.id, payload.blogPostId, payload.blog_post_id);
  if (type === "space") return firstIdentifier(payload.id, payload.spaceId, payload.space_id);
  return identifier(payload.id);
}

function githubIdentity(eventType: string, payload: Record<string, unknown>): { namespace: string; id: string } | null {
  const type = GITHUB_OBJECT_TYPES[nativeEventType(eventType)];
  if (!type) return null;
  const repoKey = githubRepoKey(payload, type === "pull_request")
    ?? (type === "repository" ? identifier(payload.id) : null);
  const id = type === "repository" ? repoKey : gitObjectId(payload, type);
  return repoKey && id
    ? { namespace: `repository:${repoKey}`, id: `${type}:${id}` }
    : null;
}

function githubRepoKey(payload: Record<string, unknown>, preferBase: boolean): string | null {
  const base = object(payload.base);
  const baseRepo = object(base?.repo) ?? object(base?.repository);
  const repository = object(payload.repository);
  const repo = object(payload.repo);
  return firstIdentifier(
    payload.repoId,
    payload.repo_id,
    payload.repositoryId,
    payload.repository_id,
    preferBase ? baseRepo?.id : null,
    repository?.id,
    repo?.id,
    !preferBase ? baseRepo?.id : null,
  );
}

function bitbucketIdentity(eventType: string, payload: Record<string, unknown>): { namespace: string; id: string } | null {
  const type = BITBUCKET_OBJECT_TYPES[nativeEventType(eventType)];
  if (!type) return null;
  const repoUuid = bitbucketRepoUuid(payload, type === "repository");
  const id = type === "repository" ? repoUuid : gitObjectId(payload, type);
  return repoUuid && id
    ? { namespace: `repository:${repoUuid}`, id: `${type}:${id}` }
    : null;
}

function bitbucketRepoUuid(payload: Record<string, unknown>, isRepository: boolean): string | null {
  const destination = object(payload.destination);
  const destinationRepo = object(destination?.repository);
  const repository = object(payload.repository);
  const repo = object(payload.repo);
  const source = object(payload.source);
  const sourceRepo = object(source?.repository);
  return firstIdentifier(
    payload.repoUuid,
    payload.repo_uuid,
    payload.repositoryUuid,
    payload.repository_uuid,
    destinationRepo?.uuid,
    repository?.uuid,
    repo?.uuid,
    sourceRepo?.uuid,
    isRepository ? payload.uuid : null,
  );
}

function gitObjectId(payload: Record<string, unknown>, type: string): string | null {
  if (type === "commit") return firstIdentifier(payload.sha, payload.hash, payload.id);
  if (type === "issue") return firstIdentifier(payload.id, payload.issueId, payload.issue_id, payload.number);
  if (type === "pull_request") {
    return firstIdentifier(payload.id, payload.pullRequestId, payload.pull_request_id, payload.number);
  }
  if (type === "comment" || type === "review_comment") {
    return firstIdentifier(payload.id, payload.commentId, payload.comment_id);
  }
  return null;
}

function nativeEventType(eventType: string): string {
  return eventType
    .trim()
    .toLowerCase()
    .replace(/(?:[._-](?:cancelled|canceled|deleted|removed|trashed|unshared|revoked))$/u, "")
    .replace(/[.-]/gu, "_");
}

function firstIdentifier(...values: unknown[]): string | null {
  for (const value of values) {
    const found = identifier(value);
    if (found) return found;
  }
  return null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null;
}

function tombstoneEvent(eventType: string): boolean {
  return /(^|[._-])(cancelled|canceled|deleted|removed|trashed|unshared|revoked)([._-]|$)/u.test(eventType);
}

function activityOrSnapshot(eventType: string): ActivityEventRecordKind {
  return /(^|[._-])(created|edited|updated|added|changed|reply|reaction|sent|received|webhook)([._-]|$)/u.test(eventType)
    ? "activity"
    : "snapshot";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
