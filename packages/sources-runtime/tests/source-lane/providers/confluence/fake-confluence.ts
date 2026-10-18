/**
 * Fake Confluence Cloud behind the Nango proxy (synthetic data only). It
 * implements the REST shapes the deep lane calls - v2 spaces/pages/blogposts/
 * comments/attachments/versions/permissions with cursor `_links.next`, v1
 * restrictions, v1 CQL content search and v1 attachment download (direct bytes
 * or a redirect to a signed media URL) - and records every request so tests can
 * assert credentials, pagination and rate-limit behaviour.
 */

export const NANGO_BASE = "https://nango.test";
export const NANGO_KEY = "nango-secret-key-for-tests";
export const MEDIA_TOKEN = "signed-media-token-SHOULD-NOT-PERSIST";

export interface FakeVersion {
  number: number;
  createdAt: string;
  message?: string;
  authorId?: string;
  title?: string;
  body: string;
}

export interface FakeContainer {
  id: string;
  type: "page" | "blogpost";
  cloudId: string;
  spaceId: string;
  status: string;
  parentId?: string | null;
  versions: FakeVersion[];
  adf?: Record<string, unknown>;
}

export interface FakeComment {
  id: string;
  kind: "footer" | "inline";
  cloudId: string;
  containerType: "page" | "blogpost";
  containerId: string;
  parentCommentId?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  authorId: string;
  body: string;
  resolutionStatus?: string;
  selection?: string;
}

export interface FakeAttachment {
  id: string;
  cloudId: string;
  containerType: "page" | "blogpost";
  containerId: string;
  title: string;
  mediaType: string;
  version: number;
  updatedAt: string;
  bytes: Buffer;
  status?: string;
  /** Reported fileSize (defaults to bytes.length). */
  fileSize?: number;
}

export interface RecordedCall {
  url: URL;
  method: string;
  auth: string | null;
  connectionId: string | null;
  providerConfigKey: string | null;
}

type Rule = { match: (u: URL) => boolean; respond: (u: URL) => Response | null; times: number };

export class FakeConfluence {
  readonly sites = new Map<string, Array<{ id: string; url: string; name: string; scopes: string[] }>>();
  readonly spaces: Array<{ id: string; cloudId: string; key: string; name: string; status: string; type: string }> = [];
  readonly containers: FakeContainer[] = [];
  readonly comments: FakeComment[] = [];
  readonly attachments: FakeAttachment[] = [];
  readonly permissions = new Map<string, Array<Record<string, unknown>>>();
  readonly restrictions = new Map<string, Array<Record<string, unknown>>>();
  readonly calls: RecordedCall[] = [];
  readonly rules: Rule[] = [];
  pageSize = 2;
  downloadMode: "direct" | "media-redirect" | "evil-redirect" | "wiki-redirect" = "media-redirect";
  /** "now" used by CQL now("-Nm") evaluation. */
  now = () => Date.now();

  constructor(readonly nangoKey = NANGO_KEY) {}

  site(connectionId: string, cloudId: string, url: string, scopes = ["read:confluence-content.all", "read:page:confluence", "read:space:confluence", "read:attachment:confluence"]): void {
    const list = this.sites.get(connectionId) ?? [];
    list.push({ id: cloudId, url, name: url.replace(/^https:\/\//u, ""), scopes });
    this.sites.set(connectionId, list);
  }

  space(cloudId: string, id: string, key: string, name = key, status = "current"): void {
    this.spaces.push({ id, cloudId, key, name, status, type: "global" });
  }

  page(c: Omit<FakeContainer, "type" | "status" | "versions"> & { status?: string; versions: FakeVersion[]; type?: "page" | "blogpost" }): FakeContainer {
    const full: FakeContainer = { type: "page", status: "current", ...c };
    this.containers.push(full);
    return full;
  }

  find(id: string, cloudId?: string): FakeContainer {
    const c = this.containers.find((x) => x.id === id && (!cloudId || x.cloudId === cloudId));
    if (!c) throw new Error(`no fake container ${id}`);
    return c;
  }

  /** Intercept the next `times` requests matching `match`. */
  intercept(match: (u: URL) => boolean, respond: (u: URL) => Response | null, times = 1): void {
    this.rules.push({ match, respond, times });
  }

  rateLimitNext(match: (u: URL) => boolean, retryAfter: string | null, times = 1): void {
    this.intercept(match, () => new Response("rate limited", { status: 429, headers: retryAfter !== null ? { "Retry-After": retryAfter } : {} }), times);
  }

  callsTo(re: RegExp): RecordedCall[] {
    return this.calls.filter((c) => re.test(c.url.pathname + c.url.search));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const call: RecordedCall = { url, method: init?.method ?? "GET", auth: headers.get("authorization"), connectionId: headers.get("connection-id"), providerConfigKey: headers.get("provider-config-key") };
    this.calls.push(call);
    if (url.hostname === "api.media.atlassian.com") return this.#media(url, call);
    if (url.origin !== NANGO_BASE) throw new Error(`fake confluence: unexpected host ${url.origin}`);
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
    if (!url.pathname.startsWith("/proxy/")) return Response.json({ error: "not_found" }, { status: 404 });
    const path = url.pathname.slice("/proxy".length);
    if (path === "/oauth/token/accessible-resources") {
      const sites = this.sites.get(call.connectionId ?? "");
      if (!sites) return Response.json({ error: { code: "unknown_connection" } }, { status: 404 });
      return Response.json(sites.map((s) => ({ ...s, avatarUrl: "https://site-admin.atlassian.com/avatar.png" })));
    }
    const m = /^\/ex\/confluence\/([^/]+)(\/wiki\/.*)$/u.exec(path);
    if (!m) return Response.json({ message: "unknown proxy route" }, { status: 404 });
    const cloudId = decodeURIComponent(m[1]!);
    if (!(this.sites.get(call.connectionId ?? "") ?? []).some((s) => s.id === cloudId)) return Response.json({ message: "site not in grant" }, { status: 401 });
    return this.#wiki(cloudId, m[2]!, url);
  };

  // ---------------------------------------------------------------- routing

  #wiki(cloudId: string, path: string, url: URL): Response {
    const q = url.searchParams;
    let m: RegExpExecArray | null;
    if (path === "/wiki/api/v2/spaces") return this.#list(url, this.spaces.filter((s) => s.cloudId === cloudId).map((s) => this.#spaceJson(s)));
    if ((m = /^\/wiki\/api\/v2\/spaces\/([^/]+)$/u.exec(path))) {
      const s = this.spaces.find((x) => x.cloudId === cloudId && x.id === m![1]);
      return s ? Response.json(this.#spaceJson(s)) : notFound();
    }
    if ((m = /^\/wiki\/api\/v2\/spaces\/([^/]+)\/(pages|blogposts)$/u.exec(path))) {
      const type = m[2] === "pages" ? "page" : "blogpost";
      if (!this.spaces.some((x) => x.cloudId === cloudId && x.id === m![1])) return notFound();
      const statuses = q.getAll("status").length ? q.getAll("status") : ["current"];
      const items = this.containers.filter((c) => c.cloudId === cloudId && c.spaceId === m![1] && c.type === type && statuses.includes(c.status));
      return this.#list(url, items.map((c) => this.#containerJson(c, c.versions.at(-1)!, q.get("body-format"))));
    }
    if ((m = /^\/wiki\/api\/v2\/spaces\/([^/]+)\/permissions$/u.exec(path))) {
      return this.#list(url, this.permissions.get(m[1]!) ?? []);
    }
    if ((m = /^\/wiki\/api\/v2\/(pages|blogposts)\/([^/]+)$/u.exec(path))) {
      const c = this.containers.find((x) => x.cloudId === cloudId && x.id === m![2] && x.type === (m![1] === "pages" ? "page" : "blogpost"));
      if (!c || c.status === "purged") return notFound();
      const n = q.get("version");
      const v = n ? c.versions.find((x) => x.number === Number(n)) : c.versions.at(-1);
      if (!v) return notFound();
      return Response.json(this.#containerJson(c, v, q.get("body-format")));
    }
    if ((m = /^\/wiki\/api\/v2\/(pages|blogposts)\/([^/]+)\/versions$/u.exec(path))) {
      const c = this.containers.find((x) => x.cloudId === cloudId && x.id === m![2]);
      if (!c || c.status === "purged") return notFound();
      return this.#list(url, [...c.versions].reverse().map((v) => ({ number: v.number, createdAt: v.createdAt, message: v.message ?? "", minorEdit: false, authorId: v.authorId ?? "acct-author" })));
    }
    if ((m = /^\/wiki\/api\/v2\/(pages|blogposts)\/([^/]+)\/(footer|inline)-comments$/u.exec(path))) {
      const ctype = m[1] === "pages" ? "page" : "blogpost";
      const items = this.comments.filter((c) => c.cloudId === cloudId && c.containerType === ctype && c.containerId === m![2] && c.kind === m![3] && !c.parentCommentId);
      return this.#list(url, items.map((c) => this.#commentJson(c)));
    }
    if ((m = /^\/wiki\/api\/v2\/(footer|inline)-comments\/([^/]+)\/children$/u.exec(path))) {
      const items = this.comments.filter((c) => c.cloudId === cloudId && c.kind === m![1] && c.parentCommentId === m![2]);
      return this.#list(url, items.map((c) => this.#commentJson(c)));
    }
    if ((m = /^\/wiki\/api\/v2\/(footer|inline)-comments\/([^/]+)$/u.exec(path))) {
      const c = this.comments.find((x) => x.cloudId === cloudId && x.kind === m![1] && x.id === m![2]);
      return c ? Response.json(this.#commentJson(c)) : notFound();
    }
    if ((m = /^\/wiki\/api\/v2\/(pages|blogposts)\/([^/]+)\/attachments$/u.exec(path))) {
      const ctype = m[1] === "pages" ? "page" : "blogpost";
      const items = this.attachments.filter((a) => a.cloudId === cloudId && a.containerType === ctype && a.containerId === m![2] && (a.status ?? "current") === "current");
      return this.#list(url, items.map((a) => this.#attachmentJson(a)));
    }
    if ((m = /^\/wiki\/api\/v2\/attachments\/([^/]+)$/u.exec(path))) {
      const a = this.attachments.find((x) => x.cloudId === cloudId && x.id === m![1]);
      return a ? Response.json(this.#attachmentJson(a)) : notFound();
    }
    if ((m = /^\/wiki\/rest\/api\/content\/([^/]+)\/restriction$/u.exec(path))) {
      return Response.json({ results: this.restrictions.get(m[1]!) ?? [], start: 0, limit: 100, size: 0, _links: {} });
    }
    if ((m = /^\/wiki\/rest\/api\/content\/([^/]+)\/child\/attachment\/([^/]+)\/download$/u.exec(path))) {
      const a = this.attachments.find((x) => x.cloudId === cloudId && x.id === m![2] && x.containerId === m![1]);
      if (!a) return notFound();
      if (q.get("version") && Number(q.get("version")) !== a.version) return notFound();
      if (this.downloadMode === "direct") return new Response(new Uint8Array(a.bytes), { status: 200, headers: { "content-type": a.mediaType, "content-length": String(a.bytes.length) } });
      if (this.downloadMode === "evil-redirect") return new Response(null, { status: 302, headers: { location: `https://evil.example/steal?id=${a.id}` } });
      if (this.downloadMode === "wiki-redirect") return new Response(null, { status: 302, headers: { location: `/wiki/download/attachments/${a.containerId}/${encodeURIComponent(a.title)}?version=${a.version}&api=v2` } });
      return new Response(null, { status: 302, headers: { location: `https://api.media.atlassian.com/file/${a.id}/binary?token=${MEDIA_TOKEN}&client=x` } });
    }
    if ((m = /^\/wiki\/download\/attachments\/([^/]+)\/([^/]+)$/u.exec(path))) {
      const a = this.attachments.find((x) => x.cloudId === cloudId && x.containerId === m![1] && x.title === decodeURIComponent(m![2]!));
      return a ? new Response(new Uint8Array(a.bytes), { status: 200, headers: { "content-type": a.mediaType } }) : notFound();
    }
    if (path === "/wiki/rest/api/content/search") return this.#search(cloudId, url);
    return Response.json({ message: `fake: no route ${path}` }, { status: 404 });
  }

  #media(url: URL, call: RecordedCall): Response {
    if (call.auth) return new Response("credential sent to media host", { status: 400 });
    if (url.searchParams.get("token") !== MEDIA_TOKEN) return new Response("bad token", { status: 403 });
    const id = /^\/file\/([^/]+)\/binary$/u.exec(url.pathname)?.[1];
    const a = this.attachments.find((x) => x.id === id);
    return a ? new Response(new Uint8Array(a.bytes), { status: 200, headers: { "content-type": a.mediaType, "content-length": String(a.bytes.length) } }) : notFound();
  }

  /** Offset cursor pagination with `_links.next` repeating the query (v2) or the v1 base-relative form. */
  #list(url: URL, items: unknown[], v1 = false): Response {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 25), this.pageSize);
    const offset = Number(url.searchParams.get("cursor") ? Buffer.from(url.searchParams.get("cursor")!, "base64url").toString() : "0");
    const page = items.slice(offset, offset + limit);
    const links: Record<string, string> = {};
    if (offset + limit < items.length) {
      const next = new URLSearchParams(url.search);
      next.set("cursor", Buffer.from(String(offset + limit)).toString("base64url"));
      const wikiPath = url.pathname.replace(/^\/proxy\/ex\/confluence\/[^/]+/u, "");
      links.next = v1 ? `${wikiPath.replace(/^\/wiki/u, "")}?${next.toString()}` : `${wikiPath}?${next.toString()}`;
    }
    return Response.json({ results: page, _links: { ...links, base: "https://acme.atlassian.net/wiki" } });
  }

  #search(cloudId: string, url: URL): Response {
    const cql = url.searchParams.get("cql") ?? "";
    const m = /lastmodified >= now\("-(\d+)m"\)/u.exec(cql);
    if (!m) return Response.json({ message: "bad cql" }, { status: 400 });
    const since = this.now() - Number(m[1]) * 60_000;
    const out: Array<{ at: string; v: Record<string, unknown> }> = [];
    for (const c of this.containers.filter((x) => x.cloudId === cloudId && x.status !== "purged")) {
      const v = c.versions.at(-1)!;
      if (Date.parse(v.createdAt) >= since) out.push({ at: v.createdAt, v: { id: c.id, type: c.type, status: c.status, title: v.title ?? "", version: { number: v.number }, space: { id: c.spaceId } } });
    }
    for (const c of this.comments.filter((x) => x.cloudId === cloudId)) {
      if (Date.parse(c.updatedAt) >= since) out.push({ at: c.updatedAt, v: { id: c.id, type: "comment", status: "current", version: { number: c.version }, container: { id: c.containerId, type: c.containerType }, extensions: { location: c.kind } } });
    }
    for (const a of this.attachments.filter((x) => x.cloudId === cloudId)) {
      if (Date.parse(a.updatedAt) >= since) out.push({ at: a.updatedAt, v: { id: a.id, type: "attachment", status: a.status ?? "current", version: { number: a.version }, container: { id: a.containerId, type: a.containerType } } });
    }
    out.sort((x, y) => x.at.localeCompare(y.at));
    return this.#list(url, out.map((x) => x.v), true);
  }

  // ---------------------------------------------------------------- payloads

  #spaceJson(s: { id: string; key: string; name: string; status: string; type: string }): Record<string, unknown> {
    return { id: s.id, key: s.key, name: s.name, type: s.type, status: s.status, authorId: "acct-admin", createdAt: "2026-01-01T00:00:00.000Z", homepageId: null, description: { plain: { value: `${s.name} space`, representation: "plain" } }, icon: { path: "/images/logo/default-space-logo.svg" }, _links: { webui: `/spaces/${s.key}` } };
  }

  #containerJson(c: FakeContainer, v: FakeVersion, bodyFormat: string | null): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (bodyFormat === "storage") body.storage = { representation: "storage", value: v.body };
    if (bodyFormat === "atlas_doc_format") body.atlas_doc_format = { representation: "atlas_doc_format", value: JSON.stringify(c.adf ?? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `ADF of v${v.number}` }] }] }) };
    return {
      id: c.id,
      status: c.status,
      title: v.title ?? `Title ${c.id}`,
      spaceId: c.spaceId,
      ...(c.type === "page" ? { parentId: c.parentId ?? null, parentType: c.parentId ? "page" : null, position: 1 } : {}),
      authorId: "acct-author",
      ownerId: "acct-owner",
      createdAt: c.versions[0]!.createdAt,
      version: { number: v.number, message: v.message ?? "", minorEdit: false, authorId: v.authorId ?? "acct-author", createdAt: v.createdAt },
      body,
      _links: { webui: `/spaces/X/${c.type === "page" ? "pages" : "blog"}/${c.id}`, editui: `/pages/resumedraft.action?draftId=${c.id}` },
    };
  }

  #commentJson(c: FakeComment): Record<string, unknown> {
    return {
      id: c.id,
      status: "current",
      title: `Re: ${c.containerId}`,
      ...(c.containerType === "page" ? { pageId: c.containerId } : { blogPostId: c.containerId }),
      ...(c.parentCommentId ? { parentCommentId: c.parentCommentId } : {}),
      createdAt: c.createdAt,
      version: { number: c.version, createdAt: c.updatedAt, authorId: c.authorId, message: "", minorEdit: false },
      body: { storage: { representation: "storage", value: c.body } },
      ...(c.kind === "inline" ? { resolutionStatus: c.resolutionStatus ?? "open", properties: { inlineOriginalSelection: c.selection ?? "", inlineMarkerRef: "mark-1" } } : {}),
      _links: { webui: `/pages/viewpage.action?pageId=${c.containerId}&focusedCommentId=${c.id}` },
    };
  }

  #attachmentJson(a: FakeAttachment): Record<string, unknown> {
    return {
      id: a.id,
      status: a.status ?? "current",
      title: a.title,
      createdAt: "2026-01-02T00:00:00.000Z",
      ...(a.containerType === "page" ? { pageId: a.containerId } : { blogPostId: a.containerId }),
      mediaType: a.mediaType,
      mediaTypeDescription: "file",
      comment: "",
      fileId: `file-${a.id}`,
      fileSize: a.fileSize ?? a.bytes.length,
      webuiLink: `/pages/viewpageattachments.action?pageId=${a.containerId}`,
      downloadLink: `/download/attachments/${a.containerId}/${encodeURIComponent(a.title)}?version=${a.version}&api=v2`,
      version: { number: a.version, createdAt: a.updatedAt, authorId: "acct-author", message: "", minorEdit: false },
      _links: { download: `/download/attachments/${a.containerId}/${encodeURIComponent(a.title)}?version=${a.version}`, thumbnail: `https://api.media.atlassian.com/file/${a.id}/image?token=${MEDIA_TOKEN}` },
    };
  }
}

function notFound(): Response {
  return Response.json({ errors: [{ status: 404, code: "NOT_FOUND", title: "Not Found" }] }, { status: 404 });
}
