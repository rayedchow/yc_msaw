import { z } from "zod";
import { IntegrationError } from "../types.js";
import { errorMessage } from "../../util.js";

/**
 * Minimal Exa API client (host-side; the key never leaves this process and is
 * never included in errors or results).
 *
 * Endpoints: POST /search, POST /contents, POST /context (Exa Code context
 * endpoint). Auth: x-api-key header.
 *
 * Declared retry policy: a request that returns HTTP 429, 502, 503 or 504 is
 * retried exactly once with the identical body, after Retry-After (seconds or
 * HTTP date) capped at 5s, or 1s when absent. Nothing else is retried: network
 * errors, timeouts, other statuses and schema mismatches fail explicitly.
 *
 * Responses are validated with zod. Unknown fields pass through; a missing or
 * mistyped required field is an "exa_schema_mismatch" failure, never coerced.
 */

export const EXA_SEARCH_TYPES = ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"] as const;
export type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];

export interface ExaContentsOptions {
  text?: boolean | { maxCharacters?: number };
  highlights?: boolean | Record<string, unknown>;
  /** -1..720; cache freshness bound (0 forces livecrawl, -1 cache only). */
  maxAgeHours?: number;
  livecrawlTimeout?: number;
}

export interface ExaSearchParams {
  query: string;
  type?: ExaSearchType;
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  category?: string;
  contents?: ExaContentsOptions;
}

export interface ExaContentsParams extends ExaContentsOptions {
  urls: string[];
}

export interface ExaContextParams {
  query: string;
  tokensNum?: number;
}

const ResultSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  title: z.string().nullish(),
  publishedDate: z.string().nullish(),
  author: z.string().nullish(),
  text: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  highlightScores: z.array(z.number()).optional(),
});

const SearchResponseSchema = z.looseObject({
  requestId: z.string().optional(),
  results: z.array(ResultSchema),
  costDollars: z.unknown().optional(),
});

const StatusSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["success", "error"]),
  source: z.string().nullish(),
  error: z.looseObject({ tag: z.string().nullish(), httpStatusCode: z.number().nullish() }).nullish(),
});

const ContentsResponseSchema = z.looseObject({
  requestId: z.string().optional(),
  results: z.array(ResultSchema),
  statuses: z.array(StatusSchema),
  costDollars: z.unknown().optional(),
});

const ContextResponseSchema = z.looseObject({
  requestId: z.string().optional(),
  query: z.string().optional(),
  response: z.string(),
  resultsCount: z.number().optional(),
  outputTokens: z.number().optional(),
  costDollars: z.unknown().optional(),
});

const ErrorBodySchema = z.looseObject({ requestId: z.string().optional(), error: z.string().optional(), tag: z.string().optional() });

export type ExaResult = z.infer<typeof ResultSchema>;
export type ExaStatus = z.infer<typeof StatusSchema>;
export type ExaSearchResponse = z.infer<typeof SearchResponseSchema>;
export type ExaContentsResponse = z.infer<typeof ContentsResponseSchema>;
export type ExaContextResponse = z.infer<typeof ContextResponseSchema>;

/** Raw response text is kept so callers can hash exactly what Exa returned. */
export interface ExaReply<T> {
  data: T;
  raw: string;
  status: number;
  attempts: number;
}

export interface ExaClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Injectable for tests (retry delay). */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5_000;

export class ExaClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: ExaClientOptions) {
    if (!opts.apiKey) throw new IntegrationError("exa_not_configured", "ExaClient requires an API key");
    this.#apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.exa.ai").replace(/\/+$/, "");
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  search(params: ExaSearchParams, signal?: AbortSignal): Promise<ExaReply<ExaSearchResponse>> {
    return this.#post("/search", params, SearchResponseSchema, signal);
  }

  contents(params: ExaContentsParams, signal?: AbortSignal): Promise<ExaReply<ExaContentsResponse>> {
    return this.#post("/contents", params, ContentsResponseSchema, signal);
  }

  /** Exa Code context endpoint: code/docs context for a programming query. */
  context(params: ExaContextParams, signal?: AbortSignal): Promise<ExaReply<ExaContextResponse>> {
    return this.#post("/context", params, ContextResponseSchema, signal);
  }

  async #post<S extends z.ZodType>(path: string, body: unknown, schema: S, signal?: AbortSignal): Promise<ExaReply<z.infer<S>>> {
    const endpoint = `${this.baseUrl}${path}`;
    const payload = JSON.stringify(body);
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      let res: Response;
      let raw: string;
      try {
        res = await this.#fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "x-api-key": this.#apiKey },
          body: payload,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        raw = await res.text();
      } catch (error) {
        if (timeout.aborted) throw new IntegrationError("exa_timeout", `Exa ${path} timed out after ${this.timeoutMs}ms`);
        if (signal?.aborted) throw new IntegrationError("aborted", `Exa ${path} aborted by caller`);
        throw new IntegrationError("exa_network_error", this.#redact(`Exa ${path} request failed: ${errorMessage(error)}`));
      }
      if (RETRY_STATUSES.has(res.status) && attempt === 1) {
        await this.#sleep(retryAfterMs(res.headers.get("retry-after")));
        continue;
      }
      if (!res.ok) throw this.#httpError(path, res.status, raw, attempt);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new IntegrationError("exa_schema_mismatch", `Exa ${path} returned non-JSON body (HTTP ${res.status})`, { status: res.status });
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        const requestId = (json as { requestId?: unknown })?.requestId;
        throw new IntegrationError("exa_schema_mismatch", `Exa ${path} response did not match the expected schema: ${z.prettifyError(parsed.error)}`, {
          requestId: typeof requestId === "string" ? requestId : undefined,
        });
      }
      return { data: parsed.data as z.infer<S>, raw, status: res.status, attempts: attempt };
    }
  }

  #httpError(path: string, status: number, raw: string, attempts: number): IntegrationError {
    let info: z.infer<typeof ErrorBodySchema> = {};
    try {
      const parsed = ErrorBodySchema.safeParse(JSON.parse(raw));
      if (parsed.success) info = parsed.data;
    } catch {
      // Non-JSON error body: report status only.
    }
    const parts = [`Exa ${path} failed with HTTP ${status}`];
    if (info.error) parts.push(info.error.slice(0, 500));
    if (info.tag) parts.push(`tag=${info.tag}`);
    if (info.requestId) parts.push(`requestId=${info.requestId}`);
    const code = status === 401 || status === 403 ? "exa_auth_failed" : status === 429 ? "exa_rate_limited" : "exa_http_error";
    return new IntegrationError(code, this.#redact(parts.join(": ")), { status, requestId: info.requestId, tag: info.tag, attempts });
  }

  #redact(text: string): string {
    return text.split(this.#apiKey).join("[redacted]");
  }
}

function retryAfterMs(header: string | null): number {
  if (!header) return 1_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
  return 1_000;
}

/** ExaClient from EXA_API_KEY (optional EXA_BASE_URL), or null when no key is set. */
export function exaClientFromEnv(env: NodeJS.ProcessEnv = process.env): ExaClient | null {
  const apiKey = env.EXA_API_KEY?.trim();
  if (!apiKey) return null;
  return new ExaClient({ apiKey, baseUrl: env.EXA_BASE_URL?.trim() || undefined });
}
