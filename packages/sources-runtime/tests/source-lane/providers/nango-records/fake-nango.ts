/**
 * Local stand-in for the Nango HTTP API, implementing the documented wire format the lane
 * uses (checked against nango.dev/docs, Oct 2026): GET /records (Connection-Id and
 * Provider-Config-Key headers, model/cursor/modified_after/limit, records ordered by
 * modification with _nango_metadata, next_cursor), GET /connections (tags[k]=v,
 * connectionId, limit/page), DELETE /connections/{id}, POST /connect/sessions,
 * GET /integrations/{key}/functions. Latest-state-only like the real records cache.
 * Synthetic data only.
 */

export interface FakeRecordState {
  id: string;
  payload: Record<string, unknown>;
  firstSeenAt: string;
  lastModifiedAt: string;
  deletedAt: string | null;
  lastAction: "ADDED" | "UPDATED" | "DELETED";
  prunedAt: string | null;
  seq: number;
}

export interface FakeConnection {
  connection_id: string;
  provider_config_key: string;
  provider: string;
  created: string;
  tags: Record<string, string>;
  errors: Array<{ type: string; log_id: string }>;
}

export interface FakeFunction {
  name: string;
  type: "sync" | "action";
  returns: string[];
  enabled: boolean;
  track_deletes: boolean;
  runs: string | null;
  id: number | null;
  last_deployed: string | null;
  source: string;
}

type Injected = { status: number; headers?: Record<string, string>; body?: unknown };

export class FakeNango {
  readonly secretKey = "nango-env-api-key-for-tests";
  seq = 0;
  clock = Date.parse("2026-10-01T00:00:00.000Z");
  readonly records = new Map<string, FakeRecordState[]>();
  connections: FakeConnection[] = [];
  functions = new Map<string, FakeFunction[]>();
  sessions: Array<Record<string, unknown>> = [];
  deleted: Array<{ connectionId: string; providerConfigKey: string }> = [];
  requests: Array<{ method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body?: unknown }> = [];
  /** Responses returned (in order) before normal handling, per path prefix. */
  inject = new Map<string, Injected[]>();
  rejectCursors = new Set<string>();
  rate = { limit: 1000, remaining: 999 };

  private key(pck: string, conn: string, model: string) {
    return `${pck}\n${conn}\n${model}`;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  static cursorOf(seq: number): string {
    return Buffer.from(`seq:${seq}`).toString("base64");
  }

  static seqOf(cursor: string): number | null {
    const m = /^seq:(\d+)$/.exec(Buffer.from(cursor, "base64").toString("utf8"));
    return m ? Number(m[1]) : null;
  }

  upsert(pck: string, conn: string, model: string, payload: Record<string, unknown>): FakeRecordState {
    const list = this.records.get(this.key(pck, conn, model)) ?? [];
    this.records.set(this.key(pck, conn, model), list);
    const id = String(payload.id);
    const at = this.tick();
    const existing = list.find((r) => r.id === id);
    if (existing) {
      Object.assign(existing, { payload, lastModifiedAt: at, deletedAt: null, lastAction: "UPDATED", prunedAt: null, seq: ++this.seq });
      return existing;
    }
    const r: FakeRecordState = { id, payload, firstSeenAt: at, lastModifiedAt: at, deletedAt: null, lastAction: "ADDED", prunedAt: null, seq: ++this.seq };
    list.push(r);
    return r;
  }

  remove(pck: string, conn: string, model: string, id: string): void {
    const r = this.records.get(this.key(pck, conn, model))?.find((x) => x.id === id);
    if (!r) throw new Error("no such record");
    const at = this.tick();
    Object.assign(r, { lastModifiedAt: at, deletedAt: at, lastAction: "DELETED", seq: ++this.seq });
  }

  prune(pck: string, conn: string, model: string, id: string): void {
    const r = this.records.get(this.key(pck, conn, model))?.find((x) => x.id === id);
    if (!r) throw new Error("no such record");
    r.prunedAt = this.tick();
  }

  addConnection(c: Partial<FakeConnection> & { connection_id: string; provider_config_key: string }): FakeConnection {
    // Sessions and connections use wall-clock time (the lane validates them against its clock);
    // `clock` only drives record modification timestamps.
    const full: FakeConnection = { provider: c.provider_config_key, created: new Date().toISOString(), tags: {}, errors: [], ...c };
    this.connections.push(full);
    return full;
  }

  deploy(pck: string, fns: Array<Partial<FakeFunction> & { name: string; returns: string[] }>): void {
    this.functions.set(pck, fns.map((f, i) => ({ type: "sync", enabled: true, track_deletes: true, runs: "every 5m", id: 100 + i, last_deployed: "2026-09-30T00:00:00.000Z", source: "repo", ...f })));
  }

  injectOnce(prefix: string, r: Injected): void {
    const list = this.inject.get(prefix) ?? [];
    list.push(r);
    this.inject.set(prefix, list);
  }

  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  private render(r: FakeRecordState): Record<string, unknown> {
    const meta = { deleted_at: r.deletedAt, last_action: r.lastAction, first_seen_at: r.firstSeenAt, last_modified_at: r.lastModifiedAt, cursor: FakeNango.cursorOf(r.seq), pruned_at: r.prunedAt };
    return r.prunedAt ? { id: r.id, _nango_metadata: meta } : { ...r.payload, _nango_metadata: meta };
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    const reset = String(Math.floor(this.clock / 1000) + 60);
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-ratelimit-limit": String(this.rate.limit), "x-ratelimit-remaining": String(this.rate.remaining), "x-ratelimit-reset": reset, ...headers },
    });
  }

  readonly fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, query, headers, ...(body !== undefined ? { body } : {}) });
    if (headers.authorization !== `Bearer ${this.secretKey}`) return this.json(401, { error: { code: "unauthorized" } });
    for (const [prefix, list] of this.inject) {
      if (url.pathname.startsWith(prefix) && list.length) {
        const r = list.shift()!;
        return this.json(r.status, r.body ?? { error: { code: r.status === 429 ? "too_many_requests" : "error", message: `injected ${r.status}` } }, r.headers);
      }
    }

    if (method === "GET" && url.pathname === "/records") {
      const pck = headers["provider-config-key"];
      const conn = headers["connection-id"];
      if (!pck || !conn || query["provider_config_key"] || query["connection_id"]) return this.json(400, { error: { code: "invalid_request", message: "unrecognized_keys" } });
      if (!query.model) return this.json(400, { error: { code: "invalid_request", message: "model is required" } });
      if (query.cursor && this.rejectCursors.has(query.cursor)) return this.json(400, { error: { code: "invalid_cursor", message: "Invalid cursor" } });
      const after = query.cursor ? FakeNango.seqOf(query.cursor) : null;
      if (query.cursor && after === null) return this.json(400, { error: { code: "invalid_cursor", message: "Invalid cursor" } });
      const modifiedAfter = query.modified_after ? Date.parse(query.modified_after) : null;
      const limit = Number(query.limit ?? 100);
      const all = [...(this.records.get(this.key(pck, conn, query.model)) ?? [])]
        .filter((r) => (after === null || r.seq > after) && (modifiedAfter === null || Date.parse(r.lastModifiedAt) > modifiedAfter))
        .sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      const next = all.length > limit ? FakeNango.cursorOf(page[page.length - 1]!.seq) : null;
      return this.json(200, { records: page.map((r) => this.render(r)), next_cursor: next });
    }
    if (method === "GET" && url.pathname === "/connections") {
      const tagFilters = Object.entries(query).filter(([k]) => k.startsWith("tags[")).map(([k, v]) => [k.slice(5, -1).toLowerCase(), v] as const);
      const list = this.connections.filter((c) => (!query.connectionId || c.connection_id === query.connectionId) && tagFilters.every(([k, v]) => c.tags[k] === v));
      const limit = Number(query.limit ?? 1000);
      const page = Number(query.page ?? 0);
      return this.json(200, { connections: list.slice(page * limit, page * limit + limit).map((c, i) => ({ id: i + 1, metadata: null, ...c })) });
    }
    const del = /^\/connections\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && del) {
      const id = decodeURIComponent(del[1]!);
      const idx = this.connections.findIndex((c) => c.connection_id === id && c.provider_config_key === query.provider_config_key);
      if (idx < 0) return this.json(404, { error: { code: "not_found" } });
      this.connections.splice(idx, 1);
      this.deleted.push({ connectionId: id, providerConfigKey: query.provider_config_key! });
      return this.json(200, { success: true });
    }
    if (method === "POST" && url.pathname === "/connect/sessions") {
      this.sessions.push(body as Record<string, unknown>);
      return this.json(201, { data: { token: `nango_connect_session_${this.sessions.length}`, connect_link: `https://connect.nango.dev/?session_token=${this.sessions.length}`, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() } });
    }
    const fn = /^\/integrations\/([^/]+)\/functions$/.exec(url.pathname);
    if (method === "GET" && fn) {
      const fns = this.functions.get(decodeURIComponent(fn[1]!));
      if (!fns) return this.json(404, { error: { code: "not_found", message: "Integration does not exist" } });
      const filtered = fns.filter((f) => !query.type || f.type === query.type);
      const limit = Number(query.limit ?? 20);
      const page = Number(query.page ?? 0);
      return this.json(200, { data: filtered.slice(page * limit, page * limit + limit), pagination: { total: filtered.length, page, limit } });
    }
    return this.json(404, { error: { code: "not_found" } });
  }) as typeof fetch;
}
