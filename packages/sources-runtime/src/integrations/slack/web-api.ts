import { db } from "../../db/client.js";
import { slackMethodRpm } from "./rate-limit.js";
import { claimQuotaSlot, getQuota, recordQuotaSuccess, recordRateLimited, type SlackDbExecutor } from "./source-store.js";

/**
 * Slack Web API client for the source lane.
 *
 * Every request first claims a slot in the DURABLE per-(app, workspace, method) budget
 * (slack_source_quota), so all workers, the realtime gap-fill and every tenant connected
 * to the same workspace share Slack's real limit. A 429 (or `ratelimited`) response records
 * Retry-After for everyone; the call waits for it only when it fits in the caller's run
 * budget, otherwise it throws SlackDeferredError and the caller keeps its checkpoint for the
 * next run. Nothing ever retries before Retry-After has elapsed.
 */

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(`Slack API ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

/** The request could not start (quota slot or Retry-After) before the run deadline. */
export class SlackDeferredError extends Error {
  constructor(
    readonly method: string,
    readonly until: Date | null,
    readonly rateLimited: boolean,
  ) {
    super(`Slack API ${method} deferred${until ? ` until ${until.toISOString()}` : ""}${rateLimited ? " (rate limited)" : ""}`);
    this.name = "SlackDeferredError";
  }
}

export class SlackTransientError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Slack API ${method} transient failure: ${detail}`);
    this.name = "SlackTransientError";
  }
}

/** Slack error codes that mean the token cannot be used at all (connection-level, not per channel). */
export const SLACK_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "no_permission",
  "team_access_not_granted",
  "ekm_access_denied",
]);

/** Per-conversation access errors: the channel is skipped and labelled, the run continues. */
export const SLACK_CONVERSATION_ACCESS_ERRORS: Readonly<Record<string, "not_in_channel" | "channel_not_found" | "missing_scope" | "access_denied">> = {
  not_in_channel: "not_in_channel",
  channel_not_found: "channel_not_found",
  missing_scope: "missing_scope",
  access_denied: "access_denied",
  restricted_action: "access_denied",
  team_access_not_granted: "access_denied",
};

export const SLACK_API_BASE = "https://slack.com/api/";
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_DEFAULT_BACKOFF_SECONDS = 15 * 60;
const MAX_RATE_LIMIT_RETRIES = 2;
/**
 * Longest in-process wait for a quota slot or Retry-After. Longer waits defer (SlackDeferredError) so the run returns
 * and re-queues at the slot time instead of holding one of the worker's few task loops asleep for its whole budget.
 */
export const SLACK_MAX_INLINE_WAIT_MS = Number(process.env.SLACK_MAX_INLINE_WAIT_MS ?? 5_000);
const MAX_TRANSIENT_RETRIES = 1;

export interface SlackWebClientOptions {
  token: string;
  quotaKey: string;
  /** Requests that cannot start by this time throw SlackDeferredError. */
  deadline: Date;
  executor?: SlackDbExecutor;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the per-minute tier of a method (tests, Marketplace/internal-app regimes use env). */
  rpm?: (method: string) => number;
  /** Longest in-process wait (default SLACK_MAX_INLINE_WAIT_MS); Infinity waits up to the deadline. */
  maxInlineWaitMs?: number;
}

export interface SlackCallStats {
  calls: number;
  rateLimited: number;
  waitedMs: number;
}

export function parseRetryAfterSeconds(value: string | null, streak: number): number {
  if (value !== null && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n >= 0) return Math.max(1, Math.ceil(n));
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  // No header: exponential backoff from a conservative floor, never a tight retry.
  return Math.min(MAX_DEFAULT_BACKOFF_SECONDS, DEFAULT_RETRY_AFTER_SECONDS * 2 ** Math.max(0, Math.min(4, streak)));
}

export class SlackWebClient {
  readonly stats: SlackCallStats = { calls: 0, rateLimited: 0, waitedMs: 0 };
  readonly #token: string;
  readonly #quotaKey: string;
  readonly #deadline: Date;
  readonly #executor: SlackDbExecutor;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #rpm: (method: string) => number;
  readonly #maxInlineWaitMs: number;

  constructor(opts: SlackWebClientOptions) {
    this.#token = opts.token;
    this.#quotaKey = opts.quotaKey;
    this.#deadline = opts.deadline;
    this.#executor = opts.executor ?? db;
    this.#fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? Date.now;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#rpm = opts.rpm ?? slackMethodRpm;
    this.#maxInlineWaitMs = opts.maxInlineWaitMs ?? SLACK_MAX_INLINE_WAIT_MS;
  }

  get deadline(): Date {
    return this.#deadline;
  }

  get quotaKey(): string {
    return this.#quotaKey;
  }

  /** Remaining run budget in ms (never negative). */
  remainingMs(): number {
    return Math.max(0, this.#deadline.getTime() - this.#now());
  }

  /** Latest start this run waits for in-process: the run deadline, capped at maxInlineWaitMs from now. */
  #waitLimit(): Date {
    return new Date(Math.min(this.#deadline.getTime(), this.#now() + this.#maxInlineWaitMs));
  }

  async #waitForSlot(method: string): Promise<void> {
    const intervalMs = Math.ceil(60_000 / Math.max(1, this.#rpm(method)));
    const now = new Date(this.#now());
    const slot = await claimQuotaSlot(this.#executor, this.#quotaKey, method, intervalMs, now, this.#waitLimit());
    if (!slot) {
      const quota = await getQuota(this.#executor, this.#quotaKey, method);
      const blocked = quota?.blocked_until ? new Date(String(quota.blocked_until instanceof Date ? quota.blocked_until.toISOString() : quota.blocked_until)) : null;
      const next = quota?.next_slot_at ? new Date(String(quota.next_slot_at instanceof Date ? quota.next_slot_at.toISOString() : quota.next_slot_at)) : null;
      const until = blocked && (!next || blocked > next) ? blocked : next;
      throw new SlackDeferredError(method, until, Boolean(blocked && blocked.getTime() > now.getTime()));
    }
    const wait = slot.getTime() - this.#now();
    if (wait > 0) {
      this.stats.waitedMs += wait;
      await this.#sleep(wait);
    }
  }

  /** GET a Web API method. Returns the parsed body (ok:true) or throws a typed error. */
  async call(method: string, params: Record<string, string> = {}): Promise<any> {
    let rateRetries = 0;
    let transientRetries = 0;
    for (;;) {
      await this.#waitForSlot(method);
      const url = new URL(method, SLACK_API_BASE);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      this.stats.calls += 1;

      let res: Response;
      try {
        res = await this.#fetch(url.toString(), { headers: { Authorization: `Bearer ${this.#token}` }, redirect: "error" });
      } catch (err) {
        if (transientRetries < MAX_TRANSIENT_RETRIES && this.remainingMs() > 5_000) {
          transientRetries += 1;
          await this.#sleep(2_000 * transientRetries);
          continue;
        }
        throw new SlackTransientError(method, null, err instanceof Error ? err.name : "network_error");
      }

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const rateLimited = res.status === 429 || data?.error === "ratelimited" || data?.error === "rate_limited";
      if (rateLimited) {
        this.stats.rateLimited += 1;
        const streak = (await getQuota(this.#executor, this.#quotaKey, method))?.rate_limit_streak ?? 0;
        const retryAfter = parseRetryAfterSeconds(res.headers.get("retry-after"), streak);
        const now = new Date(this.#now());
        const until = await recordRateLimited(this.#executor, this.#quotaKey, method, retryAfter, now);
        // Wait out Retry-After only when the run can still use the slot afterwards.
        if (rateRetries < MAX_RATE_LIMIT_RETRIES && until.getTime() < this.#waitLimit().getTime()) {
          rateRetries += 1;
          continue; // the next slot claim starts no earlier than blocked_until
        }
        throw new SlackDeferredError(method, until, true);
      }

      if (res.status >= 500 || (data === null && !res.ok)) {
        if (transientRetries < MAX_TRANSIENT_RETRIES && this.remainingMs() > 5_000) {
          transientRetries += 1;
          await this.#sleep(2_000 * transientRetries);
          continue;
        }
        throw new SlackTransientError(method, res.status, `HTTP ${res.status}`);
      }
      if (!data || data.ok !== true) {
        throw new SlackApiError(method, String(data?.error ?? `http_${res.status}`), res.status);
      }
      await recordQuotaSuccess(this.#executor, this.#quotaKey, method);
      return data;
    }
  }
}
