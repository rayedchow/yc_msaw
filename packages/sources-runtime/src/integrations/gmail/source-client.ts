import { fetchGoogleApi, type GoogleApiCredential } from "../../vault/google-auth.js";
import {
  googleErrorMessageFromPayload,
  googleErrorReasonFromPayload,
  googleRateLimitErrorFromResponse,
  throwIfGoogleRateLimited,
} from "../../vault/google-rate-limit.js";
import { gmailCooldownService } from "./source-quota.js";
import type { GmailMessage, HistoryRecord } from "./poller.js";

/**
 * Minimal Gmail REST client for the source lane. Every call goes through
 * fetchGoogleApi (DWD / OAuth bearer, or the Composio proxy), so the account's
 * own credential and opaque X-Goog-Quota-User are used. Rate-limit responses
 * (429, or 403 with a quota reason) raise GoogleRateLimitError carrying the
 * provider's Retry-After and set the in-process cooldown under the mailbox's
 * opaque quota key; the caller persists it (source-quota.ts).
 */

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Quota units per method (https://developers.google.com/workspace/gmail/api/reference/quota). */
export const GMAIL_QUOTA_UNITS = {
  profile: 1,
  "messages.list": 5,
  "messages.get": 5,
  "messages.attachments.get": 5,
  "history.list": 2,
} as const;

export class GmailHttpError extends Error {
  constructor(
    readonly method: keyof typeof GMAIL_QUOTA_UNITS,
    readonly status: number,
    readonly reason: string | null,
    message: string,
  ) {
    super(message);
    this.name = "GmailHttpError";
  }

  /** 5xx and network-ish statuses are worth retrying later; 4xx (other than quota) are not transient. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status >= 500;
  }
}

/** history.list answered 404: the start historyId is too old; a full re-sync is required. */
export class GmailHistoryExpiredError extends Error {
  constructor(readonly startHistoryId: string) {
    super("Gmail history cursor expired (history.list 404); a full mailbox re-sync is required");
    this.name = "GmailHistoryExpiredError";
  }
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export interface GmailListPage {
  messages: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryPage {
  history?: HistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
}

export interface GmailRawMessage {
  id: string;
  threadId?: string;
  historyId?: string;
  sizeEstimate?: number;
  raw?: string;
}

export interface GmailMinimalMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
}

export interface GmailClientStats {
  calls: number;
  units: number;
}

export class GmailSourceClient {
  readonly stats: GmailClientStats = { calls: 0, units: 0 };
  readonly #service: string;

  constructor(
    readonly credential: GoogleApiCredential,
    readonly quotaKey: string,
  ) {
    this.#service = gmailCooldownService(quotaKey);
  }

  async #get<T>(method: keyof typeof GMAIL_QUOTA_UNITS, url: URL, allow404 = false): Promise<T | null> {
    throwIfGoogleRateLimited(this.#service);
    this.stats.calls += 1;
    this.stats.units += GMAIL_QUOTA_UNITS[method];
    let res: Response;
    try {
      res = await fetchGoogleApi(this.credential, url.toString());
    } catch (error) {
      throw new GmailHttpError(method, 0, null, `Gmail ${method} request failed: ${(error as Error).message}`);
    }
    if (res.ok) return (await res.json()) as T;
    let data: unknown = null;
    try {
      data = await res.clone().json();
    } catch {
      data = null;
    }
    const rateLimit = googleRateLimitErrorFromResponse(this.#service, res, data);
    if (rateLimit) throw rateLimit;
    if (res.status === 404 && allow404) return null;
    const reason = googleErrorReasonFromPayload(data);
    const detail = googleErrorMessageFromPayload(data);
    throw new GmailHttpError(method, res.status, reason, `Gmail ${method} failed (${res.status})${reason ? ` ${reason}` : ""}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  async profile(): Promise<GmailProfile> {
    const p = await this.#get<GmailProfile>("profile", new URL(`${GMAIL_API}/profile`));
    if (!p?.historyId || !p.emailAddress) throw new GmailHttpError("profile", 502, null, "Gmail profile returned no historyId/emailAddress");
    return p;
  }

  async listMessages(input: { pageToken?: string | null; includeSpamTrash: boolean; maxResults?: number }): Promise<GmailListPage> {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set("maxResults", String(input.maxResults ?? 100));
    if (input.includeSpamTrash) url.searchParams.set("includeSpamTrash", "true");
    if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
    const page = await this.#get<GmailListPage>("messages.list", url);
    return { messages: page?.messages ?? [], ...(page?.nextPageToken ? { nextPageToken: page.nextPageToken } : {}), ...(page?.resultSizeEstimate !== undefined ? { resultSizeEstimate: page.resultSizeEstimate } : {}) };
  }

  /** format=full message, or null when the message no longer exists (404). */
  async getMessageFull(id: string): Promise<GmailMessage | null> {
    const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "full");
    return this.#get<GmailMessage>("messages.get", url, true);
  }

  async getMessageMinimal(id: string): Promise<GmailMinimalMessage | null> {
    const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "minimal");
    return this.#get<GmailMinimalMessage>("messages.get", url, true);
  }

  async getMessageRaw(id: string): Promise<GmailRawMessage | null> {
    const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "raw");
    return this.#get<GmailRawMessage>("messages.get", url, true);
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<{ data?: string; size?: number } | null> {
    const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return this.#get<{ data?: string; size?: number }>("messages.attachments.get", url, true);
  }

  /** One history page from `startHistoryId` (all history types). Throws GmailHistoryExpiredError on 404. */
  async listHistory(startHistoryId: string, maxResults = 500): Promise<GmailHistoryPage> {
    const url = new URL(`${GMAIL_API}/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("maxResults", String(maxResults));
    const page = await this.#get<GmailHistoryPage>("history.list", url, true);
    if (page === null) throw new GmailHistoryExpiredError(startHistoryId);
    return page;
  }
}

