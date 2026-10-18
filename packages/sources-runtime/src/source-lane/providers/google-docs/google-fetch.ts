/**
 * Quota-attributed Google fetch for the Docs/Drive source lane.
 *
 * - `X-Goog-Quota-User` is sent on googleapis.com calls, keyed per
 *   (tenant, mailbox) so Drive/Docs/Sheets/Slides per-user quota is attributed
 *   to the actual delegated identity, not the service account as a whole.
 *   The private docs.google.com changelog endpoint is not a googleapis quota
 *   surface, so the header is not sent there.
 * - Cooldowns are keyed by the same identity (`google-workspace:<quotaUser>`),
 *   and the donor's process-wide `google-workspace` cooldown is still honoured,
 *   so a 429 for one tenant/mailbox backs that identity off without stalling
 *   every other tenant, while a donor-observed global cooldown still applies.
 * - 429 / 403 rate-limit reasons throw `GoogleRateLimitError` carrying the
 *   server's Retry-After (seconds or HTTP-date); callers persist it as a
 *   retry time instead of hot-looping.
 * - Both cooldowns are also recorded in and read from google_rate_limit_cooldowns
 *   (durable-cooldown.ts): this fetch runs inside the donor gdocs tasks (poll
 *   sweep/inventory, suggestion-sync) and the account snapshot, so a floor any
 *   process received holds here in every worker and across restarts, and this
 *   identity's own 429 holds its other files, not only the file that met it.
 */
import { createHash } from "node:crypto";
import { googleRateLimitErrorFromResponse, throwIfGoogleRateLimited } from "../../../vault/google-rate-limit.js";
import { recordGoogleCooldownDurable, throwIfGoogleCooldownDurable } from "./durable-cooldown.js";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleCallContext {
  tenantId: string;
  /** Delegated mailbox / OAuth account whose visibility this call uses. */
  mailbox: string | null;
  accessToken: string;
  fetchImpl?: FetchImpl;
}

export function quotaUserFor(tenantId: string, mailbox: string | null): string {
  // quotaUser must be <= 40 chars; hash so no email/tenant leaks into Google logs.
  return `gd-${createHash("sha256").update(`${tenantId}\n${mailbox ?? "_"}`).digest("hex").slice(0, 32)}`;
}

export function cooldownKeyFor(ctx: Pick<GoogleCallContext, "tenantId" | "mailbox">): string {
  return `google-workspace:${quotaUserFor(ctx.tenantId, ctx.mailbox)}`;
}

function isGoogleApisHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".googleapis.com");
  } catch {
    return false;
  }
}

export async function googleFetch(ctx: GoogleCallContext, url: string, init: RequestInit = {}): Promise<Response> {
  const key = cooldownKeyFor(ctx);
  throwIfGoogleRateLimited("google-workspace");
  throwIfGoogleRateLimited(key);
  await throwIfGoogleCooldownDurable(["google-workspace", key]);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${ctx.accessToken}`);
  if (isGoogleApisHost(url)) headers.set("X-Goog-Quota-User", quotaUserFor(ctx.tenantId, ctx.mailbox));
  const res = await (ctx.fetchImpl ?? fetch)(url, { ...init, headers });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.clone().json();
    } catch {
      data = null;
    }
    const rateLimit = googleRateLimitErrorFromResponse(key, res, data, 30);
    if (rateLimit) {
      await res.body?.cancel().catch(() => {});
      await recordGoogleCooldownDurable(rateLimit);
      throw rateLimit;
    }
  }
  return res;
}

/** Google JSON error reason (`exportSizeLimitExceeded`, `cannotDownloadFile`, ...). */
export async function googleErrorReason(res: Response): Promise<string | null> {
  try {
    const data = await res.clone().json() as { error?: { errors?: Array<{ reason?: string }>; status?: string; message?: string } };
    return data?.error?.errors?.find((e) => e?.reason)?.reason ?? data?.error?.status ?? null;
  } catch {
    return null;
  }
}
