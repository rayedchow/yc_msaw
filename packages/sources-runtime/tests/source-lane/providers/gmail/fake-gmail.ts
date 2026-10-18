/**
 * Synthetic Gmail REST API (users/me) for tests: an in-memory mailbox per address, keyed by the
 * bearer token, with a real history stream (messagesAdded / labelsAdded / labelsRemoved /
 * messagesDeleted, monotonically increasing ids), paging, history expiry (404), rate limits with
 * Retry-After, injected failures, and exact base64url attachment / RFC822 payloads. No real data.
 */

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface FakeAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** Deliver the bytes inline in body.data instead of an attachmentId. */
  inline?: boolean;
  contentId?: string;
}

export interface FakeMessageInput {
  id: string;
  threadId?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: Date;
  text?: string;
  html?: string;
  labels?: string[];
  attachments?: FakeAttachment[];
  extraHeaders?: Array<{ name: string; value: string }>;
}

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: number;
  payload: Record<string, unknown>;
  raw: Buffer;
  snippet: string;
  sizeEstimate: number;
  attachments: Map<string, Buffer>;
}

interface Mailbox {
  address: string;
  messages: Map<string, StoredMessage>;
  history: Array<Record<string, unknown> & { id: string }>;
  historyId: number;
  minHistoryId: number;
}

type Fault = { match: RegExp; status: number; retryAfter?: string; body?: unknown; times: number };

export class FakeGmail {
  readonly mailboxes = new Map<string, Mailbox>();
  /** token -> mailbox address (what the credential really reaches). */
  readonly tokens = new Map<string, string>();
  readonly calls: Array<{ path: string; search: string; mailbox: string; quotaUser: string | null }> = [];
  pageSize = 100;
  historyPageSize = 500;
  faults: Fault[] = [];

  mailbox(address: string, startHistoryId = 1000): Mailbox {
    let mb = this.mailboxes.get(address);
    if (!mb) {
      mb = { address, messages: new Map(), history: [], historyId: startHistoryId, minHistoryId: 0 };
      this.mailboxes.set(address, mb);
    }
    return mb;
  }

  token(token: string, address: string): void {
    this.tokens.set(token, address);
    this.mailbox(address);
  }

  fault(match: RegExp, status: number, opts: { retryAfter?: string; body?: unknown; times?: number } = {}): void {
    this.faults.push({ match, status, times: opts.times ?? 1, ...(opts.retryAfter ? { retryAfter: opts.retryAfter } : {}), ...(opts.body !== undefined ? { body: opts.body } : {}) });
  }

  callsTo(re: RegExp): number {
    return this.calls.filter((c) => re.test(`${c.path}${c.search}`)).length;
  }

  #record(mb: Mailbox, rec: Record<string, unknown>): number {
    mb.historyId += 1;
    mb.history.push({ id: String(mb.historyId), ...rec });
    return mb.historyId;
  }

  addMessage(address: string, input: FakeMessageInput, opts: { recordHistory?: boolean } = {}): void {
    const mb = this.mailbox(address);
    const threadId = input.threadId ?? `t-${input.id}`;
    const labels = input.labels ?? ["INBOX", "UNREAD"];
    const date = input.date ?? new Date("2026-09-01T10:00:00Z");
    const headers = [
      { name: "From", value: input.from ?? "Sender Example <sender@example.test>" },
      { name: "To", value: input.to ?? address },
      ...(input.cc ? [{ name: "Cc", value: input.cc }] : []),
      { name: "Subject", value: input.subject ?? `Subject ${input.id}` },
      { name: "Date", value: date.toUTCString() },
      { name: "Message-ID", value: `<${input.id}@mail.example.test>` },
      ...(input.extraHeaders ?? []),
    ];
    const text = input.text ?? `Body of ${input.id}`;
    const parts: Array<Record<string, unknown>> = [
      { partId: "0", mimeType: "text/plain", filename: "", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { size: Buffer.byteLength(text), data: b64url(text) } },
    ];
    if (input.html) parts.push({ partId: "1", mimeType: "text/html", filename: "", headers: [], body: { size: Buffer.byteLength(input.html), data: b64url(input.html) } });
    const attachments = new Map<string, Buffer>();
    (input.attachments ?? []).forEach((a, i) => {
      const partId = String(parts.length);
      const attId = `att-${input.id}-${i}`;
      attachments.set(attId, a.bytes);
      parts.push({
        partId,
        mimeType: a.mimeType,
        filename: a.filename,
        headers: [
          { name: "Content-Disposition", value: `${a.inline ? "inline" : "attachment"}; filename="${a.filename}"` },
          ...(a.contentId ? [{ name: "Content-ID", value: a.contentId }] : []),
        ],
        body: a.inline ? { size: a.bytes.length, data: b64url(a.bytes) } : { size: a.bytes.length, attachmentId: attId },
      });
    });
    const raw = Buffer.concat([
      Buffer.from(`${headers.map((h) => `${h.name}: ${h.value}`).join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${text}\r\n`),
      ...(input.attachments ?? []).flatMap((a) => [Buffer.from(`--b\r\nContent-Type: ${a.mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`), Buffer.from(a.bytes.toString("base64")), Buffer.from("\r\n")]),
      Buffer.from("--b--\r\n"),
    ]);
    const historyId = opts.recordHistory === false ? (mb.historyId += 1) : this.#record(mb, { messagesAdded: [{ message: { id: input.id, threadId, labelIds: labels } }] });
    mb.messages.set(input.id, {
      id: input.id,
      threadId,
      labelIds: [...labels],
      internalDate: date.getTime(),
      historyId,
      payload: { partId: "", mimeType: "multipart/mixed", filename: "", headers, body: { size: 0 }, parts },
      raw,
      snippet: text.slice(0, 100),
      sizeEstimate: raw.length,
      attachments,
    });
  }

  addLabels(address: string, id: string, labels: string[]): number {
    const mb = this.mailbox(address);
    const m = mb.messages.get(id)!;
    m.labelIds = [...new Set([...m.labelIds, ...labels])];
    const h = this.#record(mb, { labelsAdded: [{ message: { id, threadId: m.threadId, labelIds: m.labelIds }, labelIds: labels }] });
    m.historyId = h;
    return h;
  }

  removeLabels(address: string, id: string, labels: string[]): number {
    const mb = this.mailbox(address);
    const m = mb.messages.get(id)!;
    m.labelIds = m.labelIds.filter((l) => !labels.includes(l));
    const h = this.#record(mb, { labelsRemoved: [{ message: { id, threadId: m.threadId, labelIds: m.labelIds }, labelIds: labels }] });
    m.historyId = h;
    return h;
  }

  deleteMessage(address: string, id: string): number {
    const mb = this.mailbox(address);
    const m = mb.messages.get(id)!;
    mb.messages.delete(id);
    return this.#record(mb, { messagesDeleted: [{ message: { id, threadId: m.threadId } }] });
  }

  /** Append an arbitrary history record with an explicit id (out-of-order injection). */
  injectHistory(address: string, record: Record<string, unknown> & { id: string }): void {
    const mb = this.mailbox(address);
    mb.history.push(record);
  }

  /** History before the current id is gone: older startHistoryIds answer 404. */
  expireHistory(address: string): void {
    const mb = this.mailbox(address);
    mb.minHistoryId = mb.historyId;
    mb.history = [];
  }

  #json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "gmail.googleapis.com") throw new Error(`unexpected host ${url.hostname}`);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "")?.[1] ?? "";
    const address = this.tokens.get(token);
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    this.calls.push({ path, search: url.search, mailbox: address ?? "?", quotaUser: headers.get("x-goog-quota-user") });
    if (!address) return this.#json(401, { error: { code: 401, message: "invalid credentials", status: "UNAUTHENTICATED" } });
    const fault = this.faults.find((f) => f.times > 0 && f.match.test(`${path}${url.search}`));
    if (fault) {
      fault.times -= 1;
      return this.#json(fault.status, fault.body ?? { error: { code: fault.status, message: "injected", errors: [{ reason: fault.status === 429 ? "rateLimitExceeded" : "backendError" }] } }, fault.retryAfter ? { "retry-after": fault.retryAfter } : {});
    }
    const mb = this.mailbox(address);
    if (path === "/profile") return this.#json(200, { emailAddress: address, historyId: String(mb.historyId), messagesTotal: mb.messages.size });
    if (path === "/messages") {
      const includeSpamTrash = url.searchParams.get("includeSpamTrash") === "true";
      const all = [...mb.messages.values()]
        .filter((m) => includeSpamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH"))
        .sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? -1 : 1));
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const size = Math.min(this.pageSize, Number(url.searchParams.get("maxResults") ?? 100));
      const slice = all.slice(start, start + size);
      return this.#json(200, {
        messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}),
        resultSizeEstimate: all.length,
      });
    }
    const att = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (att) {
      const m = mb.messages.get(decodeURIComponent(att[1]!));
      const bytes = m?.attachments.get(decodeURIComponent(att[2]!));
      if (!bytes) return this.#json(404, { error: { code: 404, message: "Not Found" } });
      return this.#json(200, { size: bytes.length, data: b64url(bytes) });
    }
    const msg = /^\/messages\/([^/]+)$/.exec(path);
    if (msg) {
      const m = mb.messages.get(decodeURIComponent(msg[1]!));
      if (!m) return this.#json(404, { error: { code: 404, message: "Requested entity was not found." } });
      const format = url.searchParams.get("format") ?? "full";
      const base = { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], snippet: m.snippet, historyId: String(m.historyId), internalDate: String(m.internalDate), sizeEstimate: m.sizeEstimate };
      if (format === "minimal") return this.#json(200, { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], historyId: String(m.historyId), internalDate: String(m.internalDate), sizeEstimate: m.sizeEstimate });
      if (format === "raw") return this.#json(200, { ...base, raw: b64url(m.raw) });
      return this.#json(200, { ...base, payload: structuredClone(m.payload) });
    }
    if (path === "/history") {
      const start = Number(url.searchParams.get("startHistoryId"));
      if (!Number.isFinite(start) || start < mb.minHistoryId) return this.#json(404, { error: { code: 404, message: "Requested entity was not found." } });
      const after = mb.history.filter((r) => Number(r.id) > start).sort((a, b) => Number(a.id) - Number(b.id));
      const size = Math.min(this.historyPageSize, Number(url.searchParams.get("maxResults") ?? 500));
      const page = after.slice(0, size);
      return this.#json(200, {
        ...(page.length ? { history: structuredClone(page) } : {}),
        historyId: String(mb.historyId),
        ...(after.length > size ? { nextPageToken: `p${page[page.length - 1]!.id}` } : {}),
      });
    }
    return this.#json(404, { error: { code: 404, message: `no route ${path}` } });
  };
}
