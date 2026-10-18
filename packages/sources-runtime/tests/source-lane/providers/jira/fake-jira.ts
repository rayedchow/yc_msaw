/**
 * Fake Jira Cloud behind the Nango proxy (synthetic data only). It implements
 * the REST v3 shapes the deep lane calls - accessible-resources, project/search
 * (offset paged, status filter), enhanced search/jql (nextPageToken, project and
 * relative `updated >= "-Nm"` filters, fields=*all with a truncated comment
 * container and an embedded changelog subset), issue / comment / attachment by
 * id, paged changelog and comments, mypermissions and attachment content (direct
 * bytes or a redirect to a signed media URL) - and records every request so tests
 * can assert credentials, pagination and rate-limit behaviour.
 */

export const NANGO_BASE = "https://nango.test";
export const NANGO_KEY = "nango-secret-key-for-jira-tests";
export const MEDIA_TOKEN = "signed-media-token-SHOULD-NOT-PERSIST";

export interface FakeHistory {
  id: string;
  created: string;
  authorId: string;
  items: Array<{ field: string; fromString: string | null; toString: string | null }>;
}

export interface FakeComment {
  id: string;
  created: string;
  updated: string;
  authorId: string;
  text: string;
  visibility?: { type: string; value: string };
  /** Not visible to the connecting user (restricted visibility): omitted from listings, 404 by id. */
  hidden?: boolean;
  deleted?: boolean;
}

export interface FakeAttachment {
  id: string;
  filename: string;
  mimeType: string;
  created: string;
  bytes: Buffer;
  deleted?: boolean;
}

export interface FakeIssue {
  id: string;
  key: string;
  projectId: string;
  summary: string;
  description: string;
  status: string;
  created: string;
  updated: string;
  security?: { id: string; name: string } | null;
  comments: FakeComment[];
  histories: FakeHistory[];
  attachments: FakeAttachment[];
  deleted?: boolean;
  /** Not visible to the connecting user (security level / permission): 404 everywhere. */
  hidden?: boolean;
}

export interface FakeProject {
  id: string;
  key: string;
  name: string;
  archived?: boolean;
  /** In the Jira trash. */
  trashed?: boolean;
  /** The grant lost BROWSE_PROJECTS (project vanishes from listings and searches). */
  noBrowse?: boolean;
}

export interface RecordedCall {
  url: URL;
  auth: string | null;
  connectionId: string | null;
  providerConfigKey: string | null;
}

type Rule = { match: (u: URL) => boolean; respond: (u: URL) => Response | null; times: number };

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const user = (id: string) => ({ accountId: id, displayName: `User ${id}`, emailAddress: `${id}@example.test`, avatarUrls: { "48x48": `https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/${id}/48.png` } });

export class FakeJira {
  readonly sites = new Map<string, Array<{ id: string; url: string; name: string; scopes: string[] }>>();
  readonly projects: FakeProject[] = [];
  readonly issues: FakeIssue[] = [];
  readonly calls: RecordedCall[] = [];
  readonly rules: Rule[] = [];
  /** Max issues per search page (also capped by maxResults). */
  searchPageSize = 2;
  /** Comments the search payload embeds (Jira truncates busy issues). */
  inlineComments = 2;
  /** Changelog histories the search / GET payload embeds. */
  embeddedHistories = 3;
  downloadMode: "direct" | "media-redirect" | "evil-redirect" = "media-redirect";
  now = () => Date.now();

  constructor(readonly nangoKey = NANGO_KEY) {}

  site(connectionId: string, cloudId: string, url: string, scopes = ["read:jira-work", "read:jira-user", "offline_access"]): void {
    const list = this.sites.get(connectionId) ?? [];
    list.push({ id: cloudId, url, name: url.replace(/^https:\/\//u, ""), scopes });
    this.sites.set(connectionId, list);
  }

  issue(id: string): FakeIssue {
    const i = this.issues.find((x) => x.id === id);
    if (!i) throw new Error(`no fake issue ${id}`);
    return i;
  }

  project(id: string): FakeProject {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new Error(`no fake project ${id}`);
    return p;
  }

  intercept(match: (u: URL) => boolean, respond: (u: URL) => Response | null, times = 1): void {
    this.rules.push({ match, respond, times });
  }

  rateLimitNext(match: (u: URL) => boolean, headers: Record<string, string>, times = 1, status = 429): void {
    this.intercept(match, () => new Response("rate limited", { status, headers }), times);
  }

  callsTo(re: RegExp): RecordedCall[] {
    return this.calls.filter((c) => re.test(`${c.url.pathname}${c.url.search}`));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const call: RecordedCall = { url, auth: headers.get("authorization"), connectionId: headers.get("connection-id"), providerConfigKey: headers.get("provider-config-key") };
    this.calls.push(call);
    if (url.hostname === "api.media.atlassian.com") return this.#media(url, call);
    if (call.auth !== `Bearer ${this.nangoKey}`) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    for (const rule of this.rules) {
      if (rule.times > 0 && rule.match(url)) {
        const r = rule.respond(url);
        if (r) {
          rule.times -= 1;
          return r;
        }
      }
    }
    const path = url.pathname.replace(/^\/proxy/u, "");
    if (path === "/oauth/token/accessible-resources") return Response.json(this.sites.get(call.connectionId ?? "") ?? []);
    const m = /^\/ex\/jira\/([^/]+)(\/rest\/api\/3\/.*)$/u.exec(path);
    if (!m) return notFound();
    return this.#api(m[2]!, url);
  };

  #visibleProject(p: FakeProject | undefined): p is FakeProject {
    return Boolean(p && !p.noBrowse);
  }

  #visibleIssue(i: FakeIssue | undefined): i is FakeIssue {
    return Boolean(i && !i.deleted && !i.hidden && this.#visibleProject(this.projects.find((p) => p.id === i.projectId && !p.trashed)));
  }

  #api(api: string, url: URL): Response {
    const q = url.searchParams;
    if (api === "/rest/api/3/project/search") {
      const statuses = q.getAll("status");
      const list = this.projects.filter((p) => !p.noBrowse && (statuses.includes("deleted") ? p.trashed : !p.trashed && (statuses.length === 0 || statuses.includes(p.archived ? "archived" : "live"))));
      return this.#offset(q, list.map((p) => this.projectJson(p)), "values");
    }
    let mm = /^\/rest\/api\/3\/project\/([^/]+)$/u.exec(api);
    if (mm) {
      const p = this.projects.find((x) => x.id === mm![1] || x.key === mm![1]);
      return this.#visibleProject(p) && !p.trashed ? Response.json(this.projectJson(p)) : notFound();
    }
    if (api === "/rest/api/3/mypermissions") {
      const p = this.projects.find((x) => x.id === q.get("projectId"));
      if (!p || p.trashed) return notFound();
      return Response.json({ permissions: { BROWSE_PROJECTS: { id: "10", key: "BROWSE_PROJECTS", havePermission: !p.noBrowse } } });
    }
    if (api === "/rest/api/3/search/jql") return this.#search(q);
    mm = /^\/rest\/api\/3\/issue\/([^/]+)\/changelog$/u.exec(api);
    if (mm) {
      const i = this.issues.find((x) => x.id === mm![1]);
      if (!this.#visibleIssue(i)) return notFound();
      return this.#offset(q, i.histories.map((h) => this.historyJson(h)), "values", true);
    }
    mm = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/u.exec(api);
    if (mm) {
      const i = this.issues.find((x) => x.id === mm![1]);
      if (!this.#visibleIssue(i)) return notFound();
      return this.#offset(q, this.#comments(i).map((c) => this.commentJson(i, c)), "comments");
    }
    mm = /^\/rest\/api\/3\/issue\/([^/]+)\/comment\/([^/]+)$/u.exec(api);
    if (mm) {
      const i = this.issues.find((x) => x.id === mm![1]);
      const c = i?.comments.find((x) => x.id === mm![2]);
      return this.#visibleIssue(i) && c && !c.deleted && !c.hidden ? Response.json(this.commentJson(i, c)) : notFound();
    }
    mm = /^\/rest\/api\/3\/issue\/([^/]+)$/u.exec(api);
    if (mm) {
      const i = this.issues.find((x) => x.id === mm![1] || x.key === mm![1]);
      return this.#visibleIssue(i) ? Response.json(this.issueJson(i)) : notFound();
    }
    mm = /^\/rest\/api\/3\/attachment\/content\/([^/]+)$/u.exec(api);
    if (mm) {
      const a = this.#attachment(mm[1]!);
      if (!a) return notFound();
      if (this.downloadMode === "direct") return bytes(a);
      if (this.downloadMode === "evil-redirect") return new Response(null, { status: 303, headers: { location: `https://evil.example/steal?id=${a.id}` } });
      return new Response(null, { status: 303, headers: { location: `https://api.media.atlassian.com/file/${a.id}/binary?token=${MEDIA_TOKEN}&client=x` } });
    }
    mm = /^\/rest\/api\/3\/attachment\/([^/]+)$/u.exec(api);
    if (mm) {
      const a = this.#attachment(mm[1]!);
      return a ? Response.json({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.bytes.length, created: a.created }) : notFound();
    }
    return notFound();
  }

  #attachment(id: string): FakeAttachment | null {
    for (const i of this.issues) {
      if (!this.#visibleIssue(i)) continue;
      const a = i.attachments.find((x) => x.id === id && !x.deleted);
      if (a) return a;
    }
    return null;
  }

  #media(url: URL, call: RecordedCall): Response {
    if (call.auth) return new Response("credential sent to media host", { status: 400 });
    if (url.searchParams.get("token") !== MEDIA_TOKEN) return new Response("bad token", { status: 403 });
    const id = /^\/file\/([^/]+)\/binary$/u.exec(url.pathname)?.[1];
    const a = id ? this.#attachment(id) : null;
    return a ? bytes(a) : notFound();
  }

  #comments(i: FakeIssue): FakeComment[] {
    return i.comments.filter((c) => !c.deleted && !c.hidden).sort((a, b) => a.created.localeCompare(b.created));
  }

  #search(q: URLSearchParams): Response {
    const jql = q.get("jql") ?? "";
    let list = this.issues.filter((i) => this.#visibleIssue(i));
    const proj = /^project = (\d+) /u.exec(jql);
    if (proj) {
      if (!this.#visibleProject(this.projects.find((p) => p.id === proj[1]))) return Response.json({ errorMessages: [`The value '${proj[1]}' does not exist for the field 'project'.`] }, { status: 400 });
      list = list.filter((i) => i.projectId === proj[1]);
    } else if (!/updated >= /u.test(jql)) {
      return Response.json({ errorMessages: ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."] }, { status: 400 });
    }
    const pin = /project in \(([\d, ]+)\)/u.exec(jql);
    if (pin) {
      const ids = new Set(pin[1]!.split(",").map((s) => s.trim()));
      list = list.filter((i) => ids.has(i.projectId));
    }
    const rel = /updated >= "-(\d+)m"/u.exec(jql);
    if (rel) {
      const from = this.now() - Number(rel[1]) * 60_000;
      list = list.filter((i) => Date.parse(i.updated) >= from).sort((a, b) => a.updated.localeCompare(b.updated));
    } else {
      list.sort((a, b) => a.created.localeCompare(b.created));
    }
    const offset = Number(q.get("nextPageToken") ? Buffer.from(q.get("nextPageToken")!, "base64url").toString("utf8").replace(/^tok-/u, "") : "0");
    const size = Math.min(Number(q.get("maxResults") ?? 50), this.searchPageSize);
    const page = list.slice(offset, offset + size);
    const more = offset + size < list.length;
    return Response.json({ issues: page.map((i) => this.issueJson(i)), ...(more ? { nextPageToken: Buffer.from(`tok-${offset + size}`).toString("base64url") } : {}), isLast: !more });
  }

  #offset(q: URLSearchParams, all: unknown[], field: "values" | "comments", withIsLast = false): Response {
    const startAt = Number(q.get("startAt") ?? 0);
    const max = Math.min(Number(q.get("maxResults") ?? 50), field === "values" && !withIsLast ? 2 : 100);
    const page = all.slice(startAt, startAt + max);
    return Response.json({ startAt, maxResults: max, total: all.length, [field]: page, ...(field === "values" ? { isLast: startAt + page.length >= all.length } : {}) });
  }

  projectJson(p: FakeProject): Record<string, unknown> {
    return { self: `https://acme.atlassian.net/rest/api/3/project/${p.id}`, id: p.id, key: p.key, name: p.name, projectTypeKey: "software", style: "next-gen", archived: Boolean(p.archived), description: `${p.name} project`, lead: user("acct-lead"), issueTypes: [{ id: "1", name: "Task" }, { id: "2", name: "Bug" }], avatarUrls: { "48x48": "https://acme.atlassian.net/rest/api/3/universal_avatar/view/type/project/avatar/1?size=large" } };
  }

  historyJson(h: FakeHistory): Record<string, unknown> {
    return { id: h.id, author: user(h.authorId), created: h.created, items: h.items.map((it) => ({ field: it.field, fieldtype: "jira", from: null, fromString: it.fromString, to: null, toString: it.toString })) };
  }

  commentJson(i: FakeIssue, c: FakeComment): Record<string, unknown> {
    return {
      self: `https://acme.atlassian.net/rest/api/3/issue/${i.id}/comment/${c.id}`,
      id: c.id,
      author: user(c.authorId),
      updateAuthor: user(c.authorId),
      body: adf(c.text),
      created: c.created,
      updated: c.updated,
      jsdPublic: true,
      ...(c.visibility ? { visibility: c.visibility } : {}),
    };
  }

  issueJson(i: FakeIssue): Record<string, unknown> {
    const p = this.project(i.projectId);
    const comments = this.#comments(i);
    return {
      expand: "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
      id: i.id,
      self: `https://acme.atlassian.net/rest/api/3/issue/${i.id}`,
      key: i.key,
      changelog: { startAt: 0, maxResults: this.embeddedHistories, total: i.histories.length, histories: i.histories.slice(-this.embeddedHistories).map((h) => this.historyJson(h)) },
      fields: {
        summary: i.summary,
        description: adf(i.description),
        status: { name: i.status, id: "3" },
        issuetype: { name: "Task", id: "1" },
        priority: { name: "Medium", id: "3" },
        project: { id: p.id, key: p.key, name: p.name, avatarUrls: { "48x48": "https://acme.atlassian.net/rest/api/3/universal_avatar/view/type/project/avatar/1" } },
        assignee: user("acct-assignee"),
        reporter: user("acct-reporter"),
        creator: user("acct-reporter"),
        labels: ["backend"],
        created: i.created,
        updated: i.updated,
        security: i.security ?? null,
        comment: { comments: comments.slice(0, this.inlineComments).map((c) => this.commentJson(i, c)), maxResults: this.inlineComments, total: comments.length, startAt: 0 },
        attachment: i.attachments.filter((a) => !a.deleted).map((a) => ({
          self: `https://acme.atlassian.net/rest/api/3/attachment/${a.id}`,
          id: a.id,
          filename: a.filename,
          author: user("acct-reporter"),
          created: a.created,
          size: a.bytes.length,
          mimeType: a.mimeType,
          content: `https://acme.atlassian.net/rest/api/3/attachment/content/${a.id}`,
          thumbnail: `https://acme.atlassian.net/rest/api/3/attachment/thumbnail/${a.id}`,
        })),
      },
    };
  }
}

function bytes(a: FakeAttachment): Response {
  return new Response(new Uint8Array(a.bytes), { status: 200, headers: { "content-type": a.mimeType, "content-length": String(a.bytes.length) } });
}

function notFound(): Response {
  return Response.json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, { status: 404 });
}
