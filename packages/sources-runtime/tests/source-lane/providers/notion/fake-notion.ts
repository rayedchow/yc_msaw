/**
 * In-memory Notion API (Notion-Version 2026-03-11 response shapes) for the deep-lane tests:
 * /users/me, /search (newest edit first, opaque cursors), pages, page property items,
 * block children, blocks, data sources (+ query with created_time windows and a simulated
 * per-query result limit), databases, comments (List returns only open comments; GET by
 * id answers resolved ones, 404 for deleted), and a file host serving Notion-hosted file
 * bytes from signed URLs that carry a secret signature. Failures (429 with a
 * rate_limit_reason, 401, expired links, invalid cursors) are injectable. Synthetic data only.
 */
import { createHash } from "node:crypto";

export const TOKEN = "secret_notion_token_DO_NOT_LEAK";
export const SIGNATURE = "SIGNEDURLSECRET0123456789";
export const FILE_HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";
export const BOT_ID = "b0b0b0b0-0000-4000-8000-000000000001";
export const WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-00000000000a";

type J = Record<string, any>;

export function uid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `11111111-2222-4333-8444-${hex}`;
}

export interface Call {
  method: string;
  url: URL;
  auth: string | null;
  body: J | null;
}

interface Injected {
  match: RegExp;
  status: number;
  body: J;
  headers?: Record<string, string>;
  times: number;
}

export class FakeNotion {
  readonly calls: Call[] = [];
  readonly pages = new Map<string, J>();
  readonly dataSources = new Map<string, J>();
  readonly databases = new Map<string, J>();
  /** Ordered children per parent block/page id. */
  readonly children = new Map<string, J[]>();
  readonly blocks = new Map<string, J>();
  /** Open comments per target (page or block) id. */
  readonly comments = new Map<string, J[]>();
  readonly resolvedComments = new Map<string, J>();
  readonly fileBytes = new Map<string, Buffer>();
  /** Paginated property items: `${pageId}/${propId}` -> items. */
  readonly propertyItems = new Map<string, J[]>();
  /** Objects hidden from /search (still reachable by traversal). */
  readonly hiddenFromSearch = new Set<string>();
  readonly injected: Injected[] = [];
  queryLimit = 10_000;
  expireDownloads = 0;
  token = TOKEN;
  botId = BOT_ID;
  workspaceId = WORKSPACE_ID;
  clock = Date.parse("2026-10-01T10:00:00.000Z");
  invalidCursors = new Set<string>();

  tick(minutes = 1): string {
    this.clock += minutes * 60_000;
    return new Date(this.clock).toISOString();
  }

  inject(match: RegExp, status: number, body: J, headers: Record<string, string> = {}, times = 1): void {
    this.injected.push({ match, status, body, headers, times });
  }

  callsTo(re: RegExp): Call[] {
    return this.calls.filter((c) => re.test(`${c.method} ${c.url.pathname}${c.url.search}`));
  }

  // ------------------------------------------------------------------ builders

  addPage(id: string, opts: { title: string; parent: J; properties?: J; cover?: J | null; edited?: string; created?: string; icon?: J | null }): J {
    const t = opts.edited ?? this.tick();
    const page: J = {
      object: "page",
      id,
      created_time: opts.created ?? t,
      last_edited_time: t,
      created_by: { object: "user", id: "user-1" },
      last_edited_by: { object: "user", id: "user-1" },
      cover: opts.cover ?? null,
      icon: opts.icon ?? { type: "emoji", emoji: "📄" },
      parent: opts.parent,
      in_trash: false,
      is_locked: false,
      properties: { ...(opts.properties ?? {}), ...(opts.parent.type === "data_source_id" ? {} : { title: { id: "title", type: "title", title: richText(opts.title) } }) },
      url: `https://www.notion.so/${id.replace(/-/gu, "")}`,
      public_url: null,
    };
    if (opts.parent.type === "data_source_id") page.properties.Name = { id: "title", type: "title", title: richText(opts.title) };
    this.pages.set(id, page);
    this.children.set(id, this.children.get(id) ?? []);
    return page;
  }

  block(id: string, type: string, value: J, opts: { hasChildren?: boolean; parent?: J } = {}): J {
    const t = this.tick(0);
    const b: J = {
      object: "block",
      id,
      parent: opts.parent ?? { type: "page_id", page_id: "unset" },
      created_time: t,
      last_edited_time: t,
      created_by: { object: "user", id: "user-1" },
      last_edited_by: { object: "user", id: "user-1" },
      has_children: opts.hasChildren ?? false,
      in_trash: false,
      type,
      [type]: value,
    };
    this.blocks.set(id, b);
    return b;
  }

  appendChildren(parentId: string, blocks: J[], parentType: "page_id" | "block_id" = "block_id"): void {
    const list = this.children.get(parentId) ?? [];
    for (const b of blocks) {
      b.parent = parentType === "page_id" ? { type: "page_id", page_id: parentId } : { type: "block_id", block_id: parentId };
      list.push(b);
      this.children.set(b.id, this.children.get(b.id) ?? []);
    }
    this.children.set(parentId, list);
    const parent = this.blocks.get(parentId);
    if (parent) parent.has_children = list.length > 0;
  }

  /** Notion-hosted file object with a fresh signed URL; the bytes are served by the file host. */
  hostedFile(fileId: string, name: string, bytes: Buffer): J {
    this.fileBytes.set(fileId, bytes);
    return { type: "file", file: { url: this.signedUrl(fileId, name), expiry_time: new Date(this.clock + 3600_000).toISOString() } };
  }

  signedUrl(fileId: string, name: string, host = FILE_HOST): string {
    return `https://${host}/${WORKSPACE_ID}/${fileId}/${encodeURIComponent(name)}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=${SIGNATURE}`;
  }

  addDataSource(id: string, opts: { title: string; databaseId: string; properties: J; databaseParent?: J }): J {
    const t = this.tick(0);
    const ds: J = {
      object: "data_source",
      id,
      created_time: t,
      last_edited_time: t,
      title: richText(opts.title),
      description: [],
      properties: opts.properties,
      parent: { type: "database_id", database_id: opts.databaseId },
      database_parent: opts.databaseParent ?? { type: "page_id", page_id: "unset" },
      in_trash: false,
      url: `https://www.notion.so/${id.replace(/-/gu, "")}`,
    };
    this.dataSources.set(id, ds);
    return ds;
  }

  addDatabase(id: string, opts: { title: string; parent: J; dataSources: Array<{ id: string; name: string }> }): J {
    const t = this.tick(0);
    const db: J = {
      object: "database",
      id,
      created_time: t,
      last_edited_time: t,
      title: richText(opts.title),
      parent: opts.parent,
      is_inline: true,
      in_trash: false,
      is_locked: false,
      data_sources: opts.dataSources,
      url: `https://www.notion.so/${id.replace(/-/gu, "")}`,
    };
    this.databases.set(id, db);
    return db;
  }

  comment(id: string, targetId: string, text: string, opts: { pageId: string; discussion?: string; blockLevel?: boolean; attachments?: J[] }): J {
    const c: J = {
      object: "comment",
      id,
      parent: opts.blockLevel ? { type: "block_id", block_id: targetId } : { type: "page_id", page_id: opts.pageId },
      discussion_id: opts.discussion ?? `disc-${id}`,
      created_time: this.tick(0),
      last_edited_time: this.tick(0),
      created_by: { object: "user", id: "user-2" },
      rich_text: richText(text),
      display_name: { type: "user", resolved_name: "Reviewer" },
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    };
    this.comments.set(targetId, [...(this.comments.get(targetId) ?? []), c]);
    return c;
  }

  // ------------------------------------------------------------------ server

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? {});
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as J : null;
    const method = init?.method ?? "GET";
    this.calls.push({ method, url, auth: headers.get("authorization"), body });
    if (url.hostname !== "api.notion.com") return this.serveFile(url);
    if (headers.get("notion-version") !== "2026-03-11") return err(400, "missing_version", "Notion-Version header is required");
    const key = `${method} ${url.pathname}${url.search}`;
    const inj = this.injected.find((i) => i.times > 0 && i.match.test(key));
    if (inj) {
      inj.times -= 1;
      return Response.json(inj.body, { status: inj.status, headers: inj.headers });
    }
    if (headers.get("authorization") !== `Bearer ${this.token}`) return err(401, "unauthorized", "API token is invalid.");
    const p = url.pathname.replace(/^\/v1/u, "");
    const cursor = url.searchParams.get("start_cursor") ?? (body?.start_cursor as string | undefined) ?? null;
    if (cursor && this.invalidCursors.delete(cursor)) return err(400, "validation_error", "start_cursor is invalid or expired");
    const pageSize = Number(url.searchParams.get("page_size") ?? body?.page_size ?? 100);
    let m: RegExpExecArray | null;
    if (p === "/users/me") {
      return Response.json({ object: "user", id: this.botId, type: "bot", name: "Shepherd", bot: { owner: { type: "workspace", workspace: true }, workspace_id: this.workspaceId, workspace_name: "Acme" } });
    }
    if (p === "/search" && method === "POST") {
      const value = body?.filter?.value;
      const pool = value === "data_source" ? [...this.dataSources.values()] : [...this.pages.values()];
      const listed = pool.filter((o) => !o.in_trash && !this.hiddenFromSearch.has(o.id)).sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time) || a.id.localeCompare(b.id));
      return Response.json(paginate(listed.map(withFreshUrls(this)), cursor, pageSize));
    }
    if ((m = /^\/pages\/([^/]+)\/properties\/([^/]+)$/u.exec(p))) {
      const propId = decodeURIComponent(m[2]!);
      let items = this.propertyItems.get(`${m[1]}/${propId}`);
      if (!items) {
        // Default: the property's embedded value as property items (what Notion returns when nothing is truncated).
        const prop = Object.values(this.pages.get(m[1]!)?.properties ?? {}).find((x: any) => x?.id === propId) as J | undefined;
        if (!prop) return err(404, "object_not_found", "property not found");
        const value = prop[prop.type];
        if (!Array.isArray(value)) return Response.json({ object: "property_item", id: propId, type: prop.type, [prop.type]: value });
        items = value.map((v: unknown) => ({ object: "property_item", id: propId, type: prop.type, [prop.type]: v }));
      }
      return Response.json({ ...paginate(items, cursor, pageSize), type: "property_item", property_item: { id: decodeURIComponent(m[2]!), type: items[0]?.type ?? "relation", next_url: null } });
    }
    if ((m = /^\/pages\/([^/]+)$/u.exec(p))) {
      const page = this.pages.get(m[1]!);
      return page ? Response.json(withFreshUrls(this)(page)) : err(404, "object_not_found", `Could not find page with ID: ${m[1]}.`);
    }
    if ((m = /^\/blocks\/([^/]+)\/children$/u.exec(p))) {
      const id = m[1]!;
      if (!this.children.has(id) || (this.pages.has(id) && this.pages.get(id)!.in_trash && false)) return err(404, "object_not_found", "block not found");
      return Response.json({ ...paginate((this.children.get(id) ?? []).map(withFreshUrls(this)), cursor, pageSize), type: "block", block: {} });
    }
    if ((m = /^\/blocks\/([^/]+)$/u.exec(p))) {
      const b = this.blocks.get(m[1]!);
      return b ? Response.json(withFreshUrls(this)(b)) : err(404, "object_not_found", "block not found");
    }
    if ((m = /^\/data_sources\/([^/]+)\/query$/u.exec(p)) && method === "POST") {
      const ds = this.dataSources.get(m[1]!);
      if (!ds) return err(404, "object_not_found", "data source not found");
      const from = body?.filter?.created_time?.on_or_after as string | undefined;
      const rows = [...this.pages.values()]
        .filter((pg) => pg.parent?.type === "data_source_id" && pg.parent.data_source_id === ds.id && !pg.in_trash)
        .filter((pg) => !from || pg.created_time >= from)
        .sort((a, b) => a.created_time.localeCompare(b.created_time) || a.id.localeCompare(b.id));
      const capped = rows.slice(0, this.queryLimit);
      const res = paginate(capped.map(withFreshUrls(this)), cursor, pageSize);
      if (rows.length > this.queryLimit) (res as J).request_status = { type: "incomplete", incomplete_reason: "query_result_limit_reached" };
      return Response.json(res);
    }
    if ((m = /^\/data_sources\/([^/]+)$/u.exec(p))) {
      const ds = this.dataSources.get(m[1]!);
      return ds ? Response.json(ds) : err(404, "object_not_found", "data source not found");
    }
    if ((m = /^\/databases\/([^/]+)$/u.exec(p))) {
      const d = this.databases.get(m[1]!);
      return d ? Response.json(d) : err(404, "object_not_found", "database not found");
    }
    if (p === "/comments" && method === "GET") {
      const target = url.searchParams.get("block_id")!;
      return Response.json(paginate((this.comments.get(target) ?? []).map(withFreshUrls(this)), cursor, pageSize));
    }
    if ((m = /^\/comments\/([^/]+)$/u.exec(p))) {
      const open = [...this.comments.values()].flat().find((c) => c.id === m![1]);
      const resolved = this.resolvedComments.get(m[1]!);
      return open || resolved ? Response.json(open ?? resolved) : err(404, "object_not_found", "comment not found");
    }
    return err(404, "invalid_request_url", `no route ${method} ${p}`);
  };

  private serveFile(url: URL): Response {
    if (url.searchParams.get("X-Amz-Signature") !== SIGNATURE) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    if (this.expireDownloads > 0) {
      this.expireDownloads -= 1;
      return new Response("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>", { status: 403 });
    }
    const fileId = url.pathname.split("/")[2] ?? "";
    const bytes = this.fileBytes.get(fileId);
    if (!bytes) return new Response("missing", { status: 404 });
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const type = name.endsWith(".png") ? "image/png" : name.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type, "content-length": String(bytes.length) } });
  }
}

export function richText(text: string): J[] {
  return [{ type: "text", text: { content: text, link: null }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" }, plain_text: text, href: null }];
}

function err(status: number, code: string, message: string): Response {
  return Response.json({ object: "error", status, code, message }, { status });
}

function paginate<T>(items: T[], cursor: string | null, pageSize: number): J {
  const start = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8").split(":")[1]) : 0;
  const slice = items.slice(start, start + pageSize);
  const next = start + pageSize < items.length ? Buffer.from(`c:${start + pageSize}:${createHash("sha1").update(String(start)).digest("hex").slice(0, 6)}`).toString("base64url") : null;
  return { object: "list", results: slice, has_more: next !== null, next_cursor: next };
}

/** Re-sign every Notion-hosted file URL on each response (Notion returns a fresh one-hour URL per fetch). */
function withFreshUrls(fake: FakeNotion) {
  const visit = (v: any): any => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      const out: J = {};
      for (const [k, x] of Object.entries(v)) out[k] = visit(x);
      if (out.type === "file" && out.file && typeof out.file.url === "string" && out.file.url.includes(FILE_HOST) && !out.file.url.includes("X-Amz-Signature")) {
        out.file = { ...out.file, url: `${out.file.url}?X-Amz-Signature=${SIGNATURE}` };
      }
      return out;
    }
    return v;
  };
  return (o: J) => visit(structuredClone(o));
}
