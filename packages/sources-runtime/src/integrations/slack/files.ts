import { db } from "../../db/client.js";
import { getTokenMetadata } from "../../vault/tokens.js";
import { redactProviderPayload } from "../../vault/redaction.js";
import { slackThrottle } from "./rate-limit.js";
import {
  getFile,
  markFileDeleted,
  putBlob,
  setFileStatus,
  setFileStored,
  upsertFileMetadata,
  type SlackDbExecutor,
} from "./source-store.js";
import { parseRetryAfterSeconds } from "./web-api.js";

// Slack message file attachments: metadata always lands (redacted) in the raw
// activity_events payload; this module additionally captures the exact BYTES into
// the Slack source lane (slack_source_files + per-tenant chunks, drizzle/9400),
// exported as binary versions under sources/slack/_files/. Downloads send the
// stored user token ONLY to an allow-listed Slack file host over https and never
// follow redirects, so a crafted or external `url_private` cannot receive the token.
// Credentialed URLs never persist: the file metadata row is the post-redaction
// object, and retries re-resolve the URL through files.info.
export const SLACK_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** Exact hostnames that may receive the Slack token for file downloads (SLACK_FILE_ALLOWED_HOSTS overrides). */
export const DEFAULT_SLACK_FILE_HOSTS: readonly string[] = ["files.slack.com", "files.slack-gov.com"];

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 24 * 60 * 60_000;

export interface SlackFileCaptureResult {
  stored: number;
  skips: Record<string, number>;
}

export interface SlackFileCaptureInput {
  userId: string;
  token: string;
  channelId: string;
  files: unknown;
  /** Workspace the token was validated against; resolved from the stored token metadata when omitted. */
  teamId?: string | null;
  messageTs?: string | null;
  executor?: SlackDbExecutor;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxBytes?: number;
}

export function slackFileAllowedHosts(): string[] {
  const raw = process.env.SLACK_FILE_ALLOWED_HOSTS?.trim();
  if (!raw) return [...DEFAULT_SLACK_FILE_HOSTS];
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+$/u.test(h));
}

export function slackFileMaxBytes(): number {
  const raw = Number.parseInt(process.env.SLACK_SOURCE_FILE_MAX_BYTES ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : SLACK_FILE_MAX_BYTES;
}

/** The URL may carry the token only if it is https on an exact allow-listed host with no credentials or custom port. */
export function isAllowedSlackFileUrl(value: string, hosts: readonly string[] = slackFileAllowedHosts()): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && (url.port === "" || url.port === "443")
    && hosts.includes(url.hostname.toLowerCase());
}

export type SlackFileDownload =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: "failed" | "skipped_oversize" | "disallowed_host"; reason: string; retryAfterSeconds?: number };

/** Download exact bytes with the user token (allow-listed host, no redirects, size-capped while streaming). */
export async function downloadSlackFile(input: {
  url: string;
  token: string;
  expectedMimetype?: string | null;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<SlackFileDownload> {
  if (!isAllowedSlackFileUrl(input.url)) {
    return { ok: false, status: "disallowed_host", reason: "download URL is not an allow-listed Slack file host; token not sent" };
  }
  await slackThrottle(input.token, "files.download");
  const doFetch = input.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  let res: Response;
  try {
    res = await doFetch(input.url, { headers: { Authorization: `Bearer ${input.token}` }, redirect: "manual" });
  } catch (err) {
    return { ok: false, status: "failed", reason: `network: ${err instanceof Error ? err.name : "error"}` };
  }
  if (res.status >= 300 && res.status < 400) {
    // Slack answers an unauthorized download with a redirect to its sign-in page; never follow it.
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: "failed", reason: `redirect refused (HTTP ${res.status})` };
  }
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: "failed", reason: "rate limited (HTTP 429)", retryAfterSeconds: parseRetryAfterSeconds(res.headers.get("retry-after"), 0) };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: "failed", reason: `HTTP ${res.status}` };
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const expected = (input.expectedMimetype ?? "").toLowerCase();
  if (contentType.startsWith("text/html") && !expected.startsWith("text/html")) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: "failed", reason: "HTML response instead of file bytes (sign-in page; token lacks access)" };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > input.maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: "skipped_oversize", reason: `content-length ${declared} exceeds ${input.maxBytes} bytes` };
  }
  const parts: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > input.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: "skipped_oversize", reason: `file exceeds ${input.maxBytes} bytes` };
      }
      parts.push(Buffer.from(value));
    }
  }
  return { ok: true, bytes: Buffer.concat(parts, total) };
}

export function slackFileVersion(file: Record<string, unknown>): { ref: string; ordinal: number | null } {
  const id = String(file.id);
  const base = numberField(file.timestamp) ?? numberField(file.created);
  const updated = Math.max(numberField(file.updated) ?? 0, numberField(file.edit_timestamp) ?? 0, numberField(file.date_updated) ?? 0);
  const ordinal = base == null && updated === 0 ? null : Math.max(base ?? 0, updated);
  return { ref: `${id}:${ordinal ?? 0}`, ordinal };
}

async function resolveTeamId(userId: string, teamId: string | null | undefined): Promise<string | null> {
  if (typeof teamId === "string" && teamId.trim()) return teamId.trim();
  const metadata = await getTokenMetadata(userId, "slack");
  const stored = metadata?.slackTeamId;
  return typeof stored === "string" && stored.trim() ? stored.trim() : null;
}

/**
 * Record one observed Slack file object and capture its bytes when possible.
 * Returns the skip reason (null when bytes are stored or already current).
 */
export async function captureSlackFileObject(input: {
  executor: SlackDbExecutor;
  tenantId: string;
  teamId: string;
  token: string;
  file: Record<string, unknown>;
  channelId: string | null;
  messageTs: string | null;
  fetchImpl?: typeof fetch;
  now: Date;
  maxBytes: number;
}): Promise<string | null> {
  const { executor, tenantId, teamId, file, now } = input;
  const fileId = stringField(file.id)!;
  const mode = stringField(file.mode);
  if (mode === "tombstone") {
    await markFileDeleted(executor, tenantId, teamId, fileId, "file_tombstoned", now);
    return "file_tombstoned";
  }
  const version = slackFileVersion(file);
  const metadata = redactProviderPayload("slack", file) as Record<string, unknown>;
  await upsertFileMetadata(executor, tenantId, teamId, fileId, {
    name: stringField(file.name),
    title: stringField(file.title),
    mimetype: stringField(file.mimetype),
    filetype: stringField(file.filetype),
    declaredSize: numberField(file.size),
    versionRef: version.ref,
    versionOrdinal: version.ordinal,
    channelId: input.channelId,
    messageRef: input.channelId && input.messageTs ? `${input.channelId}:${input.messageTs}` : null,
    metadataJson: JSON.stringify(metadata),
  });
  const existing = await getFile(executor, tenantId, teamId, fileId);
  if (existing?.deleted_at) return "file_deleted";
  const currentRef = existing?.version_ref ?? version.ref;
  if (existing?.status === "stored" && existing.stored_version_ref === currentRef) return null;
  if (currentRef !== version.ref) return null; // an older observation of a file whose newer version is known
  if (existing?.status === "failed" && existing.next_attempt_at && new Date(String(existing.next_attempt_at instanceof Date ? existing.next_attempt_at.toISOString() : existing.next_attempt_at)) > now) {
    return "file_retry_pending";
  }

  if (mode === "hidden_by_limit") {
    await setFileStatus(executor, tenantId, teamId, fileId, { status: "unavailable", reason: "hidden_by_limit: workspace plan hides this file" });
    return "file_hidden_by_limit";
  }
  if (file.is_external === true || mode === "external") {
    await setFileStatus(executor, tenantId, teamId, fileId, { status: "external", reason: `external file (${stringField(file.external_type) ?? "link"}); Slack does not host its bytes` });
    return "file_external";
  }
  const size = numberField(file.size);
  if (size != null && size > input.maxBytes) {
    await setFileStatus(executor, tenantId, teamId, fileId, { status: "skipped_oversize", reason: `declared size ${size} exceeds ${input.maxBytes} bytes` });
    return input.maxBytes === SLACK_FILE_MAX_BYTES ? "file_bytes_over_25mb" : "file_bytes_over_limit";
  }
  const downloadUrl = stringField(file.url_private_download) ?? stringField(file.url_private);
  if (!downloadUrl) {
    // External/tombstoned/access-denied files expose no private download URL.
    await setFileStatus(executor, tenantId, teamId, fileId, { status: "no_download_url", reason: "file object has no url_private / url_private_download" });
    return "file_no_download_url";
  }
  const result = await downloadSlackFile({
    url: downloadUrl,
    token: input.token,
    expectedMimetype: stringField(file.mimetype),
    maxBytes: input.maxBytes,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!result.ok) {
    if (result.status === "failed") {
      const attempts = (existing?.attempts ?? 0) + 1;
      const backoff = result.retryAfterSeconds != null
        ? result.retryAfterSeconds * 1000
        : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(8, attempts - 1));
      await setFileStatus(executor, tenantId, teamId, fileId, {
        status: "failed",
        error: result.reason,
        nextAttemptAt: new Date(now.getTime() + backoff),
        countAttempt: true,
      });
      return "file_failed_fetch";
    }
    await setFileStatus(executor, tenantId, teamId, fileId, { status: result.status, reason: result.reason });
    return result.status === "disallowed_host" ? "file_download_host_not_allowed" : "file_bytes_over_limit";
  }
  const blob = await putBlob(executor, tenantId, result.bytes);
  await setFileStored(executor, tenantId, teamId, fileId, { sha256: blob.sha256, size: blob.size, versionRef: version.ref });
  return null;
}

export async function captureSlackMessageFiles(input: SlackFileCaptureInput): Promise<SlackFileCaptureResult> {
  const skips: Record<string, number> = {};
  let stored = 0;
  if (!Array.isArray(input.files)) return { stored, skips };
  const executor = input.executor ?? db;
  const now = new Date((input.now ?? Date.now)());
  const maxBytes = input.maxBytes ?? slackFileMaxBytes();
  let teamId: string | null | undefined;

  for (const raw of input.files) {
    const file = isRecord(raw) ? raw : {};
    const fileId = stringField(file.id);
    if (!fileId) {
      bump(skips, "file_missing_id");
      continue;
    }
    if (teamId === undefined) teamId = await resolveTeamId(input.userId, input.teamId);
    if (!teamId) {
      // Without the validated workspace the file cannot be keyed safely; counted, never guessed.
      bump(skips, "file_no_workspace");
      continue;
    }
    const skip = await captureSlackFileObject({
      executor,
      tenantId: input.userId,
      teamId,
      token: input.token,
      file,
      channelId: input.channelId,
      messageTs: input.messageTs ?? null,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      now,
      maxBytes,
    });
    if (skip === null) stored++;
    else bump(skips, skip);
  }

  return { stored, skips };
}

/** Realtime `file_deleted` (or files.info file_not_found): tombstone the exported bytes. */
export async function markSlackFileDeleted(input: {
  userId: string;
  teamId: string;
  fileId: string;
  reason?: "file_deleted" | "file_not_found";
  at?: Date;
  executor?: SlackDbExecutor;
}): Promise<boolean> {
  return markFileDeleted(input.executor ?? db, input.userId, input.teamId, input.fileId, input.reason ?? "file_deleted", input.at ?? new Date());
}

function bump(record: Record<string, number>, reason: string): void {
  record[reason] = (record[reason] ?? 0) + 1;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
