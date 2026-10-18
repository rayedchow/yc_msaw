/**
 * Read-only Unipile client shared by the WhatsApp and Instagram personal lanes (ported from gigabrain 5448774
 * brain/src/integrations/{whatsapp,instagram}-personal/poller.ts `unipileApi`, `normalizeUnipileApiBase`,
 * page helpers). Changes from the donor:
 *  - A 429 is surfaced with its Retry-After for the caller to persist; the donor slept in-process, capped at 60 s.
 *  - Redirects are refused, so the API key never leaves the validated `*.unipile.com` https host.
 *  - Attachment bytes come only from the same validated API base (`/messages/:id/attachments/:id`).
 */
export const DEFAULT_UNIPILE_API_BASE = "https://api.unipile.com/v2";
const UNIPILE_ALLOWED_HOST_SUFFIX = ".unipile.com";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface UnipileActor {
  id?: string;
  provider_id?: string;
  attendee_provider_id?: string;
  username?: string;
  name?: string;
  display_name?: string;
  phone?: string;
  phone_number?: string;
  is_self?: boolean;
}

export interface UnipileChat {
  id: string;
  type?: string | number;
  timestamp?: string | null;
  name?: string | null;
  title?: string | null;
  subject?: string | null;
  is_group?: boolean;
  attendees?: UnipileActor[];
  participants?: UnipileActor[];
  last_message_at?: string | null;
  updated_at?: string | null;
}

export interface UnipileMessage {
  id: string;
  chat_id?: string;
  text?: string | null;
  body?: string | null;
  message?: string | null;
  sender_id?: string | null;
  sender?: UnipileActor | null;
  sender_attendee_id?: string | null;
  sender_attendee_provider_id?: string | null;
  attendee_provider_id?: string | null;
  timestamp?: string | number | null;
  created_at?: string | number | null;
  date?: string | number | null;
  attachments?: Array<Record<string, unknown>>;
  reactions?: unknown[];
  [k: string]: unknown;
}

export interface UnipilePage<T> {
  items?: T[];
  data?: T[];
  messages?: T[];
  chats?: T[];
  cursor?: string | null;
  next_cursor?: string | null;
  paging?: { cursor?: string | null; next_cursor?: string | null };
}

export class UnipileApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds: number | null) {
    super(message);
    this.name = "UnipileApiError";
  }
  get rateLimited(): boolean {
    return this.status === 429;
  }
  get authFailed(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Donor `normalizeUnipileApiBase`: https only, `*.unipile.com` only, no credentials/query/fragment. */
export function normalizeUnipileApiBase(value: string | undefined = DEFAULT_UNIPILE_API_BASE): string {
  const raw = value.trim();
  const urlValue = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("apiBase must be a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("apiBase must use https");
  if (url.username || url.password) throw new Error("apiBase must not include credentials");
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(UNIPILE_ALLOWED_HOST_SUFFIX) || host === UNIPILE_ALLOWED_HOST_SUFFIX.slice(1)) throw new Error("apiBase host is not allowed");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function pageItems<T>(page: UnipilePage<T>): T[] {
  return page.items ?? page.data ?? page.messages ?? page.chats ?? [];
}

export function nextCursor<T>(page: UnipilePage<T>): string | undefined {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return s(page.cursor) ?? s(page.next_cursor) ?? s(page.paging?.cursor) ?? s(page.paging?.next_cursor);
}

/** Donor `messageTimestamp`: seconds or milliseconds or ISO string. Null when absent, never "now". */
export function messageTimestamp(message: UnipileMessage): Date | null {
  const raw = message.timestamp ?? message.created_at ?? message.date;
  if (typeof raw === "number") return new Date(raw > 10_000_000_000 ? raw : raw * 1000);
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export class UnipileClient {
  readonly base: string;
  constructor(private readonly apiKey: string, apiBase: string, private readonly fetchImpl: FetchImpl = fetch) {
    this.base = normalizeUnipileApiBase(apiBase);
  }

  async #request(path: string, post?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: post === undefined ? "GET" : "POST",
        headers: { "X-API-KEY": this.apiKey, Accept: "application/json", ...(post === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(post === undefined ? {} : { body: JSON.stringify(post) }),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new UnipileApiError(0, `Unipile request failed: ${err instanceof Error ? err.message : String(err)}`, 30);
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => {});
    const ra = res.headers.get("retry-after");
    const retry = ra == null ? null : Number.isFinite(Number(ra)) ? Math.max(0, Math.ceil(Number(ra))) : Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000)) || null;
    // Path only (never the key) in messages; Unipile bodies may echo request data, so they are not included.
    throw new UnipileApiError(res.status, `Unipile ${path.split("?")[0]} failed (${res.status})`, res.status === 429 ? retry ?? 30 : res.status >= 500 ? 30 : null);
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.#request(path)).json()) as T;
  }

  /**
   * Unipile hosted auth: a one-time link where the user signs in to their own account. Unipile POSTs
   * `{status, account_id, name}` to `notifyUrl` when the account is created; `name` is echoed back as given.
   */
  async hostedLink(input: { provider: string; expiresOn: Date; notifyUrl: string; name: string }): Promise<string> {
    const res = await this.#request("/hosted/accounts/link", {
      type: "create", providers: [input.provider], api_url: new URL(this.base).origin,
      expiresOn: input.expiresOn.toISOString(), notify_url: input.notifyUrl, name: input.name,
    });
    const url = ((await res.json()) as { url?: unknown }).url;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) throw new UnipileApiError(502, "Unipile /hosted/accounts/link returned no link", 30);
    return url;
  }

  account(accountId: string): Promise<Record<string, unknown>> {
    return this.get(`/accounts/${encodeURIComponent(accountId)}`);
  }

  chats(accountId: string, accountType: string, cursor?: string, limit = 100): Promise<UnipilePage<UnipileChat>> {
    const q = new URLSearchParams({ limit: String(limit), account_id: accountId, account_type: accountType });
    if (cursor) q.set("cursor", cursor);
    return this.get(`/chats?${q.toString()}`);
  }

  messages(chatId: string, params: { cursor?: string; after?: string; limit?: number }): Promise<UnipilePage<UnipileMessage>> {
    const q = new URLSearchParams({ limit: String(params.limit ?? 100) });
    if (params.cursor) q.set("cursor", params.cursor);
    if (params.after) q.set("after", params.after);
    return this.get(`/chats/${encodeURIComponent(chatId)}/messages?${q.toString()}`);
  }

  /** Exact attachment bytes, bounded; null when larger than `maxBytes` (nothing partial is kept). */
  async attachment(messageId: string, attachmentId: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string | null } | null> {
    const res = await this.#request(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { bytes: Buffer.concat(chunks), contentType: res.headers.get("content-type") };
  }
}

// ---------------------------------------------------------------- donor account-status helpers (verbatim semantics)

function rawRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function sourceStatusFromAccount(account: Record<string, unknown>): string {
  const sources = Array.isArray(account.sources) ? account.sources : [];
  const statuses = sources.map((s) => String(rawRecord(s).status ?? "").toUpperCase()).filter(Boolean);
  if (statuses.length > 0) return statuses.every((s) => s === "OK") ? "OK" : (statuses.find((s) => s !== "OK") ?? "UNKNOWN");
  const status = str(account.status) ?? str(account.state);
  return status ? status.toUpperCase() : "UNKNOWN";
}

export function accountInitialSyncStatus(account: Record<string, unknown>): string | null {
  const raw = account.initial_sync ?? account.initialSync ?? rawRecord(account.sync).initial_sync;
  if (typeof raw === "string" && raw.trim()) return raw.trim().toLowerCase();
  const status = str(rawRecord(raw).status ?? rawRecord(raw).state);
  return status ? status.toLowerCase() : null;
}

export function readinessReason(sourceStatus: string, initialSyncStatus: string | null): string | null {
  if (sourceStatus !== "OK") return sourceStatus === "CONNECTING" ? "connecting" : "account_not_ready";
  if (initialSyncStatus === "pending" || initialSyncStatus === "running") return "initial_sync";
  if (initialSyncStatus === "failed") return "initial_sync_failed";
  return null;
}

export function accountUserIdOf(profile: Record<string, unknown>): string | undefined {
  for (const key of ["account_user_id", "user_id", "provider_id", "attendee_provider_id", "id"]) {
    const v = profile[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const account = profile.account;
  return account && typeof account === "object" && !Array.isArray(account) ? accountUserIdOf(account as Record<string, unknown>) : undefined;
}

export function accountDisplayName(profile: Record<string, unknown>): string | undefined {
  for (const key of ["display_name", "name", "username", "phone_number", "phone"]) {
    const v = profile[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}
