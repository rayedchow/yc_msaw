/**
 * Synthetic Google for the calendar/contacts lane tests: credentials (replacing
 * getGoogleApiCredential; fetchGoogleApi stays real), a stateful fake of Calendar v3,
 * People v1 and the Directory API keyed by bearer = tenant:mailbox, and a stub of the
 * yc_msaw publish protocol for the exporter. No network, synthetic data only.
 */
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Synthetic credentials (replaces getGoogleApiCredential; fetchGoogleApi stays real)
// ---------------------------------------------------------------------------

export const auth = {
  delegationConfigured: false,
  /** `${tenant}:${mailbox}` -> error thrown when resolving the credential. */
  failures: new Map<string, Error>(),
  /** Scope-aware failure (e.g. an OAuth grant holding contacts.readonly but not contacts.other.readonly). */
  failureFor: null as null | ((tenant: string, account: string, scopes: readonly string[]) => Error | undefined),
  scopesSeen: [] as Array<{ tenant: string; account: string; scopes: string[] }>,
};

export function bearerFor(tenant: string, account: string): string {
  return `tok:${tenant}:${account}`;
}

export function syntheticCredential(tenant: string, account: string | undefined, scopes: readonly string[]) {
  const email = (account ?? "").trim().toLowerCase();
  auth.scopesSeen.push({ tenant, account: email, scopes: [...scopes] });
  const failure = auth.failures.get(`${tenant}:${email}`) ?? auth.failureFor?.(tenant, email, scopes);
  if (failure) throw failure;
  return {
    kind: "access_token" as const,
    accessToken: bearerFor(tenant, email),
    mode: "oauth_direct" as const,
    account: email,
    quotaUser: `q${createHash("sha256").update(`oauth:test\n${email}`).digest("hex").slice(0, 39)}`,
  };
}

// ---------------------------------------------------------------------------
// Fake Google (Calendar v3, People v1, Directory) keyed by bearer = tenant:mailbox
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

interface FakeEvent { event: Json; seq: number }
interface FakeCalendar { entry: Json; seq: number; events: Map<string, FakeEvent>; minSyncSeq: number }
interface FakeAccount {
  calendars: Map<string, FakeCalendar>;
  listMinSyncSeq: number;
  people: Record<"connections" | "otherContacts", Map<string, { person: Json; seq: number }>>;
  peopleMinSyncSeq: Record<"connections" | "otherContacts", number>;
}

export type Hook = (req: { url: URL; account: string; method: string; body: Json | null }) => Response | undefined;

export class FakeGoogle {
  seq = 1;
  pageSize = 2;
  accounts = new Map<string, FakeAccount>();
  hooks: Hook[] = [];
  invalidPageTokens = false;
  directory = new Map<string, Json[]>();
  calls: Array<{ method: string; url: URL; account: string; headers: Headers; body: Json | null }> = [];
  watchSeq = 0;
  stopped: Json[] = [];

  account(tenant: string, mailbox: string): FakeAccount {
    const key = `${tenant}:${mailbox}`;
    let a = this.accounts.get(key);
    if (!a) {
      a = {
        calendars: new Map(),
        listMinSyncSeq: 0,
        people: { connections: new Map(), otherContacts: new Map() },
        peopleMinSyncSeq: { connections: 0, otherContacts: 0 },
      };
      this.accounts.set(key, a);
    }
    return a;
  }

  putCalendar(tenant: string, mailbox: string, entry: Json): void {
    const a = this.account(tenant, mailbox);
    const existing = a.calendars.get(entry.id);
    a.calendars.set(entry.id, { entry, seq: ++this.seq, events: existing?.events ?? new Map(), minSyncSeq: existing?.minSyncSeq ?? 0 });
  }

  putEvent(tenant: string, mailbox: string, calendarId: string, event: Json): void {
    const cal = this.account(tenant, mailbox).calendars.get(calendarId)!;
    cal.events.set(event.id, { event, seq: ++this.seq });
  }

  /** Delete and purge (Google no longer returns it at all, even with showDeleted). */
  purgeEvent(tenant: string, mailbox: string, calendarId: string, eventId: string): void {
    this.account(tenant, mailbox).calendars.get(calendarId)!.events.delete(eventId);
  }

  expireEventSyncTokens(tenant: string, mailbox: string, calendarId: string): void {
    this.account(tenant, mailbox).calendars.get(calendarId)!.minSyncSeq = ++this.seq;
  }

  putPerson(tenant: string, mailbox: string, endpoint: "connections" | "otherContacts", person: Json): void {
    this.account(tenant, mailbox).people[endpoint].set(person.resourceName, { person, seq: ++this.seq });
  }

  expirePeopleSyncTokens(tenant: string, mailbox: string, endpoint: "connections" | "otherContacts"): void {
    this.account(tenant, mailbox).peopleMinSyncSeq[endpoint] = ++this.seq;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const account = bearer.startsWith("tok:") ? bearer.slice(4) : "";
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Json) : null;
    this.calls.push({ method, url, account, headers, body });
    for (const hook of this.hooks) {
      const res = hook({ url, account, method, body });
      if (res) return res;
    }
    if (!account) return json({ error: { code: 401, message: "missing bearer" } }, 401);
    const [tenant, mailbox] = splitAccount(account);
    const a = this.account(tenant, mailbox);
    const path = url.pathname;
    if (url.host === "www.googleapis.com" && path === "/calendar/v3/users/me/calendarList") return this.#calendarList(a, url);
    if (url.host === "www.googleapis.com" && /\/calendar\/v3\/(users\/me\/calendarList|calendars\/[^/]+\/events)\/watch$/.test(path)) {
      const n = ++this.watchSeq;
      return json({ kind: "api#channel", id: body?.id, resourceId: `res-${n}`, resourceUri: `${url.origin}${path}`, expiration: String(Date.now() + 7 * 86_400_000) });
    }
    if (url.host === "www.googleapis.com" && path === "/calendar/v3/channels/stop") {
      this.stopped.push(body ?? {});
      return new Response(null, { status: 204 });
    }
    const events = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path);
    if (url.host === "www.googleapis.com" && events) return this.#events(a, decodeURIComponent(events[1]!), url);
    if (url.host === "people.googleapis.com" && path === "/v1/people/me/connections") return this.#people(a, "connections", url);
    if (url.host === "people.googleapis.com" && path === "/v1/otherContacts") return this.#people(a, "otherContacts", url);
    if (url.host === "admin.googleapis.com" && path === "/admin/directory/v1/users") return json({ users: this.directory.get(tenant) ?? [] });
    return json({ error: { code: 404, message: `fake google has no route for ${method} ${url.href}` } }, 404);
  };

  /** Offset pagination; null = invalid page token. */
  #page<T>(items: T[], url: URL, prefix: string): { slice: T[]; last: boolean; next?: string } | null {
    const token = url.searchParams.get("pageToken");
    let offset = 0;
    if (token) {
      const m = new RegExp(`^${prefix}:(\\d+)$`).exec(token);
      if (!m || this.invalidPageTokens) return null;
      offset = Number(m[1]);
    }
    const slice = items.slice(offset, offset + this.pageSize);
    const last = offset + this.pageSize >= items.length;
    return { slice, last, ...(last ? {} : { next: `${prefix}:${offset + this.pageSize}` }) };
  }

  #calendarList(a: FakeAccount, url: URL): Response {
    const sync = url.searchParams.get("syncToken");
    let since = -1;
    if (sync) {
      since = Number(sync.replace(/^cl:/, ""));
      if (since < a.listMinSyncSeq) return json({ error: { code: 410, message: "Sync token is no longer valid, a full sync is required.", errors: [{ reason: "fullSyncRequired" }] } }, 410);
    }
    const items = [...a.calendars.values()].filter((c) => c.seq > since).sort((x, y) => x.entry.id.localeCompare(y.entry.id)).map((c) => c.entry);
    const page = this.#page(items, url, `clp${sync ?? ""}`);
    if (!page) return invalidPageToken();
    return json({ items: page.slice, ...(page.next ? { nextPageToken: page.next } : { nextSyncToken: `cl:${this.seq}` }) });
  }

  #events(a: FakeAccount, calendarId: string, url: URL): Response {
    const cal = a.calendars.get(calendarId);
    if (!cal) return json({ error: { code: 404, message: "Not Found" } }, 404);
    const sync = url.searchParams.get("syncToken");
    let since = -1;
    if (sync) {
      since = Number(sync.replace(/^ev:/, ""));
      if (since < cal.minSyncSeq) return json({ error: { code: 410, message: "Sync token is no longer valid, a full sync is required.", errors: [{ reason: "fullSyncRequired" }] } }, 410);
    }
    const items = [...cal.events.values()].filter((e) => e.seq > since).sort((x, y) => x.event.id.localeCompare(y.event.id)).map((e) => e.event);
    const page = this.#page(items, url, `evp${sync ?? ""}`);
    if (!page) return invalidPageToken();
    return json({ items: page.slice, ...(page.next ? { nextPageToken: page.next } : { nextSyncToken: `ev:${this.seq}` }) });
  }

  #people(a: FakeAccount, endpoint: "connections" | "otherContacts", url: URL): Response {
    const sync = url.searchParams.get("syncToken");
    let since = -1;
    if (sync) {
      since = Number(sync.replace(/^pp:/, ""));
      if (since < a.peopleMinSyncSeq[endpoint]) {
        return json({ error: { code: 400, status: "FAILED_PRECONDITION", message: "Sync token is expired. Clear local cache and retry call without the sync token.", details: [{ reason: "EXPIRED_SYNC_TOKEN" }], errors: [{ reason: "EXPIRED_SYNC_TOKEN" }] } }, 400);
      }
    }
    const people = [...a.people[endpoint].values()]
      .filter((p) => (sync ? p.seq > since : p.person.metadata?.deleted !== true))
      .sort((x, y) => String(x.person.resourceName).localeCompare(String(y.person.resourceName)))
      .map((p) => p.person);
    const wantsToken = url.searchParams.get("requestSyncToken") === "true";
    const page = this.#page(people, url, `ppp${sync ?? ""}`);
    if (!page) return invalidPageToken();
    return json({ [endpoint]: page.slice, ...(page.next ? { nextPageToken: page.next } : wantsToken ? { nextSyncToken: `pp:${this.seq}` } : {}) });
  }
}

function splitAccount(account: string): [string, string] {
  const i = account.indexOf(":");
  return [account.slice(0, i), account.slice(i + 1)];
}

function invalidPageToken(): Response {
  return json({ error: { code: 400, message: "Invalid page token", errors: [{ reason: "invalid" }] } }, 400);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// ---------------------------------------------------------------------------
// Exporter publish stub (yc_msaw publish protocol)
// ---------------------------------------------------------------------------

export function mintBindingToken(tenantId: string): { bindingId: string; token: string } {
  const bindingId = `sb-${randomBytes(8).toString("hex")}`;
  return { bindingId, token: `psb_${tenantId}.${bindingId}.${randomBytes(32).toString("base64url")}` };
}

export function fakePublish(published: Array<Record<string, any>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "PUT" && url.pathname.startsWith("/v1/sources/blobs/")) return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/status-report") return new Response("{}", { status: 200 });
    if (url.pathname === "/v1/sources/publish") {
      const body = JSON.parse(String(init?.body)) as { batchId: string; changes: Array<Record<string, any>> };
      published.push(...body.changes);
      return Response.json({
        batchId: body.batchId,
        commitId: `c-${published.length}`,
        seq: published.length,
        results: body.changes.map((c) => ({ path: c.path, outcome: c.op === "put" ? "created" : "deleted", versionId: c.op === "put" ? `v-${String(c.sha256).slice(0, 8)}` : null })),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export function inlineText(change: Record<string, any>): string {
  return Buffer.from(String(change.inline), "base64").toString("utf8");
}
