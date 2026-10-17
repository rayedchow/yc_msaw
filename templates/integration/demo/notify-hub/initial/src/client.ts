/** Notify Hub HTTP client (initial revision). */
export interface Notification {
  id: string;
  recipient: string;
  message: string;
  created_at: string;
}

export class NotifyHubError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface NotifyHubOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class NotifyHubClient {
  readonly #o: NotifyHubOptions;
  constructor(opts: NotifyHubOptions) {
    this.#o = opts;
  }

  async #request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await (this.#o.fetchImpl ?? fetch)(new URL(path, this.#o.baseUrl), {
      method,
      headers: { authorization: `Bearer ${this.#o.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new NotifyHubError(res.status, json.error ?? "http_error", json.message ?? `HTTP ${res.status}`);
    return { status: res.status, json };
  }

  async listAll(opts: { recipient?: string } = {}): Promise<{ items: Notification[]; pages: number }> {
    const q = new URLSearchParams({ limit: "100" });
    if (opts.recipient) q.set("recipient", opts.recipient);
    const { json } = await this.#request("GET", `/v1/notifications?${q}`);
    return { items: json.data, pages: 1 };
  }

  async send(input: { recipient: string; message: string }): Promise<{ notification: Notification; attempts: number; replayed: boolean }> {
    const { json } = await this.#request("POST", "/v1/notifications", input);
    return { notification: json, attempts: 1, replayed: false };
  }

  async get(id: string): Promise<Notification> {
    return (await this.#request("GET", `/v1/notifications/${encodeURIComponent(id)}`)).json;
  }
}
