/**
 * Read-only Stripe REST client for the source lane. Only GET requests exist here: the lane never creates,
 * updates or deletes Stripe objects (no financial mutations, no webhook endpoint installation).
 *
 * Rate limits: Stripe answers 429 (and sometimes `Stripe-Should-Retry: true` on 409/5xx). A `Retry-After`
 * header is honoured when present; otherwise callers apply exponential backoff and persist the retry time on
 * the cursor, so a restart cannot hot-loop.
 */
export const STRIPE_API_BASE = "https://api.stripe.com";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly type: string | null,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  url?: string;
}

export interface StripeEvent {
  id: string;
  object: "event";
  type: string;
  created: number;
  livemode: boolean;
  account?: string;
  api_version?: string | null;
  data: { object: Record<string, unknown> & { id?: string; object?: string }; previous_attributes?: Record<string, unknown> };
  [k: string]: unknown;
}

function retryAfter(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}

export class StripeClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl = fetch,
    private readonly base = STRIPE_API_BASE,
  ) {}

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new StripeApiError(0, "network", null, `Stripe request failed: ${err instanceof Error ? err.message : String(err)}`, true, null);
    }
    if (res.ok) return (await res.json()) as T;
    let code: string | null = null;
    let type: string | null = null;
    let message = `Stripe GET ${url.pathname} -> ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; type?: string; message?: string } };
      code = body.error?.code ?? null;
      type = body.error?.type ?? null;
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON body
    }
    const shouldRetry = res.headers.get("stripe-should-retry");
    const retryable = res.status === 429 || res.status >= 500 || shouldRetry === "true" || (res.status === 409 && shouldRetry !== "false");
    throw new StripeApiError(res.status, code, type, message, retryable, retryAfter(res));
  }

  /** `GET /v1/account` (the key's own account). Restricted keys may lack the permission (403/401 permission_error). */
  account(): Promise<{ id: string; object: "account"; [k: string]: unknown }> {
    return this.get("/v1/account");
  }

  listEvents(params: { createdGte?: number; startingAfter?: string; limit?: number }): Promise<StripeList<StripeEvent>> {
    return this.get("/v1/events", {
      limit: params.limit ?? 100,
      ...(params.createdGte !== undefined ? { "created[gte]": params.createdGte } : {}),
      ...(params.startingAfter ? { starting_after: params.startingAfter } : {}),
    });
  }

  list(resource: string, params: { startingAfter?: string; limit?: number; extra?: Record<string, string> } = {}): Promise<StripeList<Record<string, unknown> & { id: string }>> {
    return this.get(`/v1/${resource}`, {
      limit: params.limit ?? 100,
      ...(params.startingAfter ? { starting_after: params.startingAfter } : {}),
      ...(params.extra ?? {}),
    });
  }
}
