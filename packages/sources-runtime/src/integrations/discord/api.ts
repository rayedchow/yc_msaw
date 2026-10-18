/**
 * Read-only Discord REST client for a bot token (`Authorization: Bot <token>`, API v10).
 *
 * Rate limits (Discord "Rate Limits" docs): a 429 carries `retry_after` (seconds, may be fractional) in the
 * JSON body plus `Retry-After`/`X-RateLimit-*` headers, and `global: true` for the global limit. The full
 * delay is honoured. The donor clipped it to 60 s and retried in-process, which could hammer a still-limited
 * bucket; here the caller persists it as a retry time and stops. An exhausted bucket
 * (`X-RateLimit-Remaining: 0`) reports its `X-RateLimit-Reset-After` so the next request waits for it.
 */
export const DISCORD_API_BASE = "https://discord.com/api/v10";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
    readonly retryAfterSeconds: number | null,
    readonly global: boolean,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
  get rateLimited(): boolean {
    return this.status === 429;
  }
  /** 50001 Missing Access, 50013 Missing Permissions, 10003 Unknown Channel, or a plain 403/404. */
  get accessDenied(): boolean {
    return this.status === 403 || this.status === 404 || this.code === 50001 || this.code === 50013 || this.code === 10003;
  }
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string | null;
  last_message_id?: string | null;
  parent_id?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content?: string;
  timestamp: string;
  edited_timestamp?: string | null;
  type: number;
  attachments?: unknown[];
  embeds?: unknown[];
  reactions?: unknown[];
  [k: string]: unknown;
}

export interface BucketState {
  remaining: number | null;
  resetAfterSeconds: number | null;
}

/** Text-like guild channels whose messages can be listed: text, announcement, threads, voice-text. */
export const MESSAGE_CHANNEL_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);

function num(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class DiscordClient {
  lastBucket: BucketState = { remaining: null, resetAfterSeconds: null };

  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: FetchImpl = fetch,
    private readonly base = DISCORD_API_BASE,
  ) {}

  async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bot ${this.botToken}`, "User-Agent": "DiscordBot (procmem-sources, 1.0)" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new DiscordApiError(0, null, `Discord request failed: ${err instanceof Error ? err.message : String(err)}`, 30, false);
    }
    this.lastBucket = { remaining: num(res.headers.get("x-ratelimit-remaining")), resetAfterSeconds: num(res.headers.get("x-ratelimit-reset-after")) };
    if (res.ok) return (await res.json()) as T;
    let body: { message?: string; code?: number; retry_after?: number; global?: boolean } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON error body
    }
    if (res.status === 429) {
      const retry = Math.max(body.retry_after ?? 0, num(res.headers.get("retry-after")) ?? 0, this.lastBucket.resetAfterSeconds ?? 0) || 1;
      const global = body.global === true || res.headers.get("x-ratelimit-global") === "true" || res.headers.get("x-ratelimit-scope") === "global";
      throw new DiscordApiError(429, body.code ?? null, body.message ?? "You are being rate limited.", retry, global);
    }
    throw new DiscordApiError(res.status, body.code ?? null, body.message ?? `Discord GET ${url.pathname} -> ${res.status}`, res.status >= 500 ? 30 : null, false);
  }

  me(): Promise<DiscordUser> {
    return this.get("/users/@me");
  }

  application(): Promise<{ id: string; flags?: number; name?: string }> {
    return this.get("/applications/@me");
  }

  guilds(): Promise<Array<{ id: string; name?: string }>> {
    return this.get("/users/@me/guilds", { limit: "200" });
  }

  guildChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.get(`/guilds/${guildId}/channels`);
  }

  channel(channelId: string): Promise<DiscordChannel> {
    return this.get(`/channels/${channelId}`);
  }

  /** Up to 100 messages; Discord returns them newest first for `before`, and the page right after `after`. */
  messages(channelId: string, params: { before?: string; after?: string; limit?: number }): Promise<DiscordMessage[]> {
    return this.get(`/channels/${channelId}/messages`, {
      limit: String(params.limit ?? 100),
      ...(params.before ? { before: params.before } : {}),
      ...(params.after ? { after: params.after } : {}),
    });
  }
}

/** Application flags for the privileged Message Content intent (Discord "Application" resource). */
export const GATEWAY_MESSAGE_CONTENT = 1 << 19;
export const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 18;

export function messageContentIntent(flags: number | undefined): "enabled" | "limited" | "disabled" | "unknown" {
  if (typeof flags !== "number") return "unknown";
  if (flags & GATEWAY_MESSAGE_CONTENT) return "enabled";
  if (flags & GATEWAY_MESSAGE_CONTENT_LIMITED) return "limited";
  return "disabled";
}

export function snowflakeGreater(a: string, b: string | null | undefined): boolean {
  if (!b) return true;
  return BigInt(a) > BigInt(b);
}
