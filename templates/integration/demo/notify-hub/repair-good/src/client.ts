/**
 * Notify Hub HTTP client.
 *
 * Quirks handled (each covered by tests/client.test.ts):
 *  - the server caps page size: follow next_cursor until null (never trust ?limit);
 *  - 429 is not committed: wait Retry-After seconds (capped) and retry;
 *  - 503 can happen AFTER commit (lost ack): every attempt of one logical send carries the
 *    same Idempotency-Key, so a retry replays the original instead of duplicating;
 *  - 422 idempotency_key_reused is a caller error and is never retried.
 */
import { randomUUID } from "node:crypto";

export interface Notification {
  id: string;
  recipient: string;
  message: string;
  created_at: string;
}

export class NotifyHubError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterMs: number | null = null) {
    super(message);
  }
}

export interface NotifyHubOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_PAGES = 1000;

export class NotifyHubClient {
  readonly #o: NotifyHubOptions;
  constructor(opts: NotifyHubOptions) {
    this.#o = opts;
  }

  get #sleep() {
    return this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async #request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
    const res = await (this.#o.fetchImpl ?? fetch)(new URL(path, this.#o.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.#o.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new NotifyHubError(res.status, json.error ?? "http_error", json.message ?? `HTTP ${res.status}`, Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null);
    }
    return { status: res.status, json, headers: res.headers };
  }

  async listAll(opts: { recipient?: string } = {}): Promise<{ items: Notification[]; pages: number }> {
    const items: Notification[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) throw new NotifyHubError(0, "pagination_runaway", `More than ${MAX_PAGES} pages`);
      const q = new URLSearchParams({ limit: "100" });
      if (opts.recipient) q.set("recipient", opts.recipient);
      if (cursor) q.set("cursor", cursor);
      const { json } = await this.#retrying(() => this.#request("GET", `/v1/notifications?${q}`));
      items.push(...json.data);
      cursor = json.has_more ? json.next_cursor : null;
    } while (cursor);
    return { items, pages };
  }

  async #retrying<T>(fn: () => Promise<T>, onAttempt?: (n: number) => void): Promise<T> {
    const max = this.#o.maxAttempts ?? 5;
    for (let attempt = 1; ; attempt++) {
      onAttempt?.(attempt);
      try {
        return await fn();
      } catch (error) {
        const retryable = error instanceof NotifyHubError ? RETRYABLE.has(error.status) : error instanceof TypeError; // TypeError = network failure from fetch
        if (!retryable || attempt >= max) throw error;
        const hinted = error instanceof NotifyHubError ? error.retryAfterMs : null;
        await this.#sleep(Math.min(hinted ?? 100 * 2 ** (attempt - 1), this.#o.maxRetryAfterMs ?? 5000));
      }
    }
  }

  async send(input: { recipient: string; message: string; idempotencyKey?: string }): Promise<{ notification: Notification; attempts: number; replayed: boolean; idempotencyKey: string }> {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    let attempts = 0;
    const r = await this.#retrying(
      () => this.#request("POST", "/v1/notifications", { recipient: input.recipient, message: input.message }, { "idempotency-key": idempotencyKey }),
      (n) => (attempts = n),
    );
    return { notification: r.json, attempts, replayed: r.headers.get("idempotent-replayed") === "true", idempotencyKey };
  }

  async get(id: string): Promise<Notification> {
    return (await this.#retrying(() => this.#request("GET", `/v1/notifications/${encodeURIComponent(id)}`))).json;
  }
}
