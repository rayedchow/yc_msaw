/**
 * Fake Slack Web API + file host for source-lane tests (synthetic data only).
 *
 * conversations.history follows Slack's documented semantics: messages strictly between
 * `oldest` and `latest` (inclusive when `inclusive=true`), newest first, `limit` per page,
 * `has_more` + `response_metadata.next_cursor` continuing the SAME query. conversations.replies
 * returns the parent then replies oldest first. Rate limits answer HTTP 429 with Retry-After.
 * Every request is logged with whether it carried the token, so tests can prove the token
 * never reaches a non-Slack host.
 */

export interface FakeMessage {
  type?: string;
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { user: string; ts: string };
  reactions?: Array<{ name: string; users: string[]; count: number }>;
  files?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

interface Channel {
  info: Record<string, unknown>;
  messages: Map<string, FakeMessage>;
  replies: Map<string, FakeMessage[]>;
  error?: string;
}

export interface LoggedRequest {
  url: URL;
  method: string;
  authorized: boolean;
  status: number;
}

function cmpTs(a: string, b: string): number {
  return Number(a) - Number(b) || a.localeCompare(b);
}

export class FakeSlack {
  readonly channels = new Map<string, Channel>();
  readonly users: Array<Record<string, unknown>> = [];
  readonly files = new Map<string, { file: Record<string, unknown>; bytes: Buffer; contentType?: string; status?: number; location?: string }>();
  readonly requests: LoggedRequest[] = [];
  readonly tokens = new Map<string, { teamId: string; userId: string; team: string }>();
  #rateLimits = new Map<string, Array<{ retryAfter: string | null }>>();
  #invalidCursors = false;
  #listPageSize = 200;

  token(token: string, teamId: string, userId = "UME", team = "Acme"): void {
    this.tokens.set(token, { teamId, userId, team });
  }

  channel(id: string, info: Record<string, unknown> = {}): Channel {
    const existing = this.channels.get(id);
    if (existing) {
      Object.assign(existing.info, info);
      return existing;
    }
    const ch: Channel = { info: { id, name: id.toLowerCase(), is_channel: true, is_member: true, ...info }, messages: new Map(), replies: new Map() };
    this.channels.set(id, ch);
    return ch;
  }

  post(channelId: string, msg: FakeMessage): FakeMessage {
    const full = { type: "message", ...msg };
    this.channel(channelId).messages.set(msg.ts, full);
    return full;
  }

  reply(channelId: string, threadTs: string, msg: FakeMessage): FakeMessage {
    const ch = this.channel(channelId);
    const full = { type: "message", thread_ts: threadTs, ...msg };
    const list = ch.replies.get(threadTs) ?? [];
    list.push(full);
    list.sort((a, b) => cmpTs(a.ts, b.ts));
    ch.replies.set(threadTs, list);
    const parent = ch.messages.get(threadTs);
    if (parent) {
      parent.thread_ts = threadTs;
      parent.reply_count = list.length;
      parent.latest_reply = list[list.length - 1]!.ts;
    }
    return full;
  }

  edit(channelId: string, msgTs: string, text: string, editTs: string): void {
    const m = this.channel(channelId).messages.get(msgTs);
    if (!m) throw new Error(`no message ${msgTs}`);
    m.text = text;
    m.edited = { user: m.user ?? "U1", ts: editTs };
  }

  remove(channelId: string, msgTs: string): void {
    this.channel(channelId).messages.delete(msgTs);
  }

  setError(channelId: string, code: string | undefined): void {
    this.channel(channelId).error = code;
  }

  unlist(channelId: string): void {
    this.channels.delete(channelId);
  }

  /** The next `count` calls of `method` answer 429 with this Retry-After (null = no header). */
  rateLimit(method: string, count: number, retryAfter: string | null): void {
    const list = this.#rateLimits.get(method) ?? [];
    for (let i = 0; i < count; i++) list.push({ retryAfter });
    this.#rateLimits.set(method, list);
  }

  invalidateCursors(on = true): void {
    this.#invalidCursors = on;
  }

  listPageSize(n: number): void {
    this.#listPageSize = n;
  }

  hostFile(file: Record<string, unknown>, bytes: Buffer, opts: { contentType?: string; status?: number; location?: string } = {}): void {
    this.files.set(String(file.id), { file, bytes, ...opts });
  }

  calls(method: string): LoggedRequest[] {
    return this.requests.filter((r) => r.url.hostname === "slack.com" && r.url.pathname === `/api/${method}`);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const log = (status: number) => this.requests.push({ url, method: url.pathname.replace(/^\/api\//, ""), authorized: Boolean(auth), status });
    if (url.hostname !== "slack.com") return this.#fileHost(url, auth, log);
    const method = url.pathname.replace(/^\/api\//, "");
    const limited = this.#rateLimits.get(method);
    if (limited?.length) {
      const { retryAfter } = limited.shift()!;
      log(429);
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "content-type": "application/json", ...(retryAfter !== null ? { "retry-after": retryAfter } : {}) },
      });
    }
    const who = auth ? this.tokens.get(auth.replace(/^Bearer /, "")) : undefined;
    const ok = (body: Record<string, unknown>) => {
      log(200);
      return Response.json({ ok: true, ...body });
    };
    const fail = (error: string) => {
      log(200);
      return Response.json({ ok: false, error });
    };
    if (!who) return fail("invalid_auth");
    const p = url.searchParams;
    switch (method) {
      case "auth.test":
        return ok({ team_id: who.teamId, user_id: who.userId, team: who.team });
      case "users.list":
        return ok({ members: this.users, response_metadata: { next_cursor: "" } });
      case "conversations.list": {
        const all = [...this.channels.values()].map((c) => c.info);
        const start = p.get("cursor") ? Number(p.get("cursor")!.slice(4)) : 0;
        const page = all.slice(start, start + Math.min(Number(p.get("limit") ?? 100), this.#listPageSize));
        const next = start + page.length < all.length ? `off:${start + page.length}` : "";
        return ok({ channels: page, response_metadata: { next_cursor: next } });
      }
      case "conversations.history": {
        const ch = this.channels.get(p.get("channel") ?? "");
        if (!ch) return fail("channel_not_found");
        if (ch.error) return fail(ch.error);
        const cursor = p.get("cursor");
        if (cursor && this.#invalidCursors) return fail("invalid_cursor");
        const inclusive = p.get("inclusive") === "true";
        const oldest = p.get("oldest");
        const latest = p.get("latest");
        const below = cursor ? cursor.slice(2) : null;
        const matching = [...ch.messages.values()]
          .filter((m) => !oldest || (inclusive ? cmpTs(m.ts, oldest) >= 0 : cmpTs(m.ts, oldest) > 0))
          .filter((m) => !latest || (inclusive ? cmpTs(m.ts, latest) <= 0 : cmpTs(m.ts, latest) < 0))
          .filter((m) => !below || cmpTs(m.ts, below) < 0)
          .sort((a, b) => cmpTs(b.ts, a.ts));
        const limit = Number(p.get("limit") ?? 100);
        const page = matching.slice(0, limit);
        const more = matching.length > page.length;
        return ok({
          messages: page.map((m) => structuredClone(m)),
          has_more: more,
          response_metadata: { next_cursor: more ? `c:${page[page.length - 1]!.ts}` : "" },
        });
      }
      case "conversations.replies": {
        const ch = this.channels.get(p.get("channel") ?? "");
        if (!ch) return fail("channel_not_found");
        if (ch.error) return fail(ch.error);
        const threadTs = p.get("ts") ?? "";
        const parent = ch.messages.get(threadTs);
        const replies = ch.replies.get(threadTs);
        if (!parent && !replies) return fail("thread_not_found");
        const oldest = p.get("oldest");
        const cursor = p.get("cursor");
        const after = cursor ? cursor.slice(2) : null;
        const matching = (replies ?? [])
          .filter((m) => !oldest || cmpTs(m.ts, oldest) > 0)
          .filter((m) => !after || cmpTs(m.ts, after) > 0);
        const limit = Number(p.get("limit") ?? 100);
        const page = matching.slice(0, limit);
        const more = matching.length > page.length;
        return ok({
          messages: [...(parent && !after ? [structuredClone(parent)] : []), ...page.map((m) => structuredClone(m))],
          has_more: more,
          response_metadata: { next_cursor: more ? `r:${page[page.length - 1]!.ts}` : "" },
        });
      }
      case "files.info": {
        const f = this.files.get(p.get("file") ?? "");
        if (!f) return fail("file_not_found");
        return ok({ file: structuredClone(f.file) });
      }
      default:
        return fail("unknown_method");
    }
  };

  async #fileHost(url: URL, auth: string | null, log: (status: number) => void): Promise<Response> {
    const hosted = [...this.files.values()].find((f) => f.file.url_private_download === url.toString() || f.file.url_private === url.toString());
    if (!hosted) {
      log(404);
      return new Response("not found", { status: 404 });
    }
    if (hosted.status && hosted.status >= 300 && hosted.status < 400) {
      log(hosted.status);
      return new Response(null, { status: hosted.status, headers: { location: hosted.location ?? "https://acme.slack.com/signin" } });
    }
    if (!auth || !this.tokens.has(auth.replace(/^Bearer /, ""))) {
      log(200);
      return new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    log(hosted.status ?? 200);
    return new Response(new Uint8Array(hosted.bytes), { status: hosted.status ?? 200, headers: { "content-type": hosted.contentType ?? String(hosted.file.mimetype ?? "application/octet-stream") } });
  }
}
