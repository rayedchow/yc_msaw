/**
 * A fake Bitbucket Cloud (/2.0) behind a fake Nango proxy, shaped after the documented
 * responses the content lane reads: /user, /repositories/{ws}/{slug} (and the
 * {workspace-uuid}/{repo-uuid} form), /refs/branches/{name}, /src/{commit}/{dir}/ paginated
 * listings with absolute `next` URLs, /src/{commit}/{path} raw bodies (and ?format=meta), and
 * /diffstat/{new}..{old}?topic=false paginated. Failures (429 + Retry-After, 5xx, 403) are
 * injected per request. Synthetic data only.
 */
import { createHash } from "node:crypto";

export const NANGO_BASE = "https://nango.test";
export const NANGO_KEY = "nango-test-secret";
const API = "https://api.bitbucket.org/2.0";

export interface FakeFile {
  bytes: Buffer;
  attributes?: string[];
}

export interface FakeRepo {
  uuid: string;
  workspaceUuid: string;
  fullName: string;
  mainbranch: string | null;
  isPrivate: boolean;
}

export interface RecordedRequest {
  connectionId: string | null;
  providerConfigKey: string | null;
  authorization: string | null;
  path: string;
  params: Record<string, string>;
}

interface Failure {
  match: (path: string, params: Record<string, string>) => boolean;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  times: number;
}

let uuidSeq = 0;
export function fakeUuid(): string {
  uuidSeq += 1;
  const hex = createHash("sha256").update(`uuid-${uuidSeq}`).digest("hex");
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`;
}

export class FakeBitbucket {
  readonly repos: FakeRepo[] = [];
  readonly commits = new Map<string, Map<string, FakeFile>>();
  readonly branches = new Map<string, string>();
  readonly accounts = new Map<string, string>();
  /** connectionId -> repo uuids it can read; unlisted connections read nothing. */
  readonly access = new Map<string, Set<string>>();
  readonly requests: RecordedRequest[] = [];
  readonly failures: Failure[] = [];
  /** Status for a repository the connection cannot read (Bitbucket hides private repos with 404). */
  noAccessStatus = 404;
  dirPageSize = 2;
  diffPageSize = 2;
  /** Serve diffstat with the commits swapped (to prove orientation is verified, not assumed). */
  reverseDiffstat = false;
  rateHeaders: Record<string, string> = { "x-ratelimit-limit": "1000", "x-ratelimit-resource": "api-repo" };
  #commitSeq = 0;

  addRepo(fullName: string, opts: { mainbranch?: string | null; isPrivate?: boolean; readers?: string[] } = {}): FakeRepo {
    const repo: FakeRepo = { uuid: fakeUuid(), workspaceUuid: fakeUuid(), fullName, mainbranch: opts.mainbranch === undefined ? "main" : opts.mainbranch, isPrivate: opts.isPrivate ?? true };
    this.repos.push(repo);
    for (const c of opts.readers ?? []) this.grant(c, repo);
    return repo;
  }

  grant(connectionId: string, repo: FakeRepo): void {
    const s = this.access.get(connectionId) ?? new Set<string>();
    s.add(repo.uuid);
    this.access.set(connectionId, s);
  }

  revoke(connectionId: string, repo: FakeRepo): void {
    this.access.get(connectionId)?.delete(repo.uuid);
  }

  /** A commit with the given tree; returns its 40-hex hash. */
  commit(files: Record<string, string | Buffer | FakeFile>): string {
    this.#commitSeq += 1;
    const tree = new Map<string, FakeFile>();
    for (const [p, v] of Object.entries(files)) {
      tree.set(p, typeof v === "string" ? { bytes: Buffer.from(v, "utf8") } : Buffer.isBuffer(v) ? { bytes: v } : v);
    }
    const sha = createHash("sha1").update(`commit-${this.#commitSeq}-${JSON.stringify([...tree.keys()])}`).digest("hex");
    this.commits.set(sha, tree);
    return sha;
  }

  setBranch(repo: FakeRepo, branch: string, sha: string | null): void {
    const k = `${repo.uuid}\n${branch}`;
    if (sha === null) this.branches.delete(k);
    else this.branches.set(k, sha);
  }

  failNext(match: (path: string, params: Record<string, string>) => boolean, status: number, opts: { headers?: Record<string, string>; body?: string; times?: number } = {}): void {
    this.failures.push({ match, status, headers: opts.headers, body: opts.body, times: opts.times ?? 1 });
  }

  requestsMatching(re: RegExp): RecordedRequest[] {
    return this.requests.filter((r) => re.test(r.path));
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.origin !== NANGO_BASE || !url.pathname.startsWith("/proxy/")) return json(404, { error: { code: "not_found" } });
    if (init?.redirect !== "manual") throw new Error("the content lane must not follow redirects");
    const path = url.pathname.slice("/proxy".length);
    const params = Object.fromEntries(url.searchParams);
    const rec: RecordedRequest = { connectionId: headers.get("connection-id"), providerConfigKey: headers.get("provider-config-key"), authorization: headers.get("authorization"), path, params };
    this.requests.push(rec);
    if (rec.authorization !== `Bearer ${NANGO_KEY}`) return json(401, { error: { code: "invalid_secret_key" } });
    const conn = rec.connectionId ?? "";
    if (!this.access.has(conn) && !this.accounts.has(conn)) return json(404, { error: { code: "unknown_connection", message: "Connection not found" } });
    const failure = this.failures.find((f) => f.times > 0 && f.match(path, params));
    if (failure) {
      failure.times -= 1;
      return new Response(failure.body ?? JSON.stringify({ type: "error", error: { message: `injected ${failure.status}` } }), { status: failure.status, headers: { "content-type": "application/json", ...this.rateHeaders, ...(failure.headers ?? {}) } });
    }
    const segs = path.split("/").slice(1).map((s) => decodeURIComponent(s));
    if (segs[0] === "user" && segs.length === 1) {
      const uuid = this.accounts.get(conn);
      return uuid ? this.ok({ uuid, type: "user", display_name: "Synthetic User" }) : json(403, { type: "error", error: { message: "no account" } });
    }
    if (segs[0] !== "repositories" || segs.length < 3) return json(404, { type: "error", error: { message: "not found" } });
    const repo = this.repos.find((r) => (r.workspaceUuid === segs[1] && r.uuid === segs[2]) || r.fullName.toLowerCase() === `${segs[1]}/${segs[2]}`.toLowerCase());
    if (!repo) return json(404, { type: "error", error: { message: "Repository not found" } });
    if (!this.access.get(conn)?.has(repo.uuid)) return json(this.noAccessStatus, { type: "error", error: { message: "no access" } });
    const rest = segs.slice(3);
    if (!rest.length) return this.ok(this.repoJson(repo));
    if (rest[0] === "refs" && rest[1] === "branches") {
      const name = rest.slice(2).join("/");
      const sha = this.branches.get(`${repo.uuid}\n${name}`);
      if (!sha) return json(404, { type: "error", error: { message: `branch ${name} not found` } });
      return this.ok({ name, type: "branch", target: { hash: sha, type: "commit", date: "2001-01-01T00:00:00+00:00", author: { raw: "Synthetic Author <author@example.test>" }, message: "synthetic", parents: [] } });
    }
    if (rest[0] === "src") return this.src(repo, rest[1] ?? "", rest.slice(2), url.pathname.endsWith("/"), params);
    if (rest[0] === "diffstat") return this.diffstat(repo, rest[1] ?? "", params);
    return json(404, { type: "error", error: { message: "not found" } });
  };

  repoJson(repo: FakeRepo): Record<string, unknown> {
    const [ws, slug] = repo.fullName.split("/");
    return {
      type: "repository",
      uuid: repo.uuid,
      full_name: repo.fullName,
      name: slug,
      slug,
      is_private: repo.isPrivate,
      mainbranch: repo.mainbranch ? { name: repo.mainbranch, type: "branch" } : null,
      workspace: { uuid: repo.workspaceUuid, slug: ws, type: "workspace" },
      links: { html: { href: `https://bitbucket.org/${repo.fullName}` } },
      updated_on: "2026-10-01T00:00:00.000000+00:00",
    };
  }

  private ok(body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...this.rateHeaders, ...extra } });
  }

  private src(repo: FakeRepo, sha: string, pathSegs: string[], dirRequest: boolean, params: Record<string, string>): Response {
    const tree = this.commits.get(sha);
    if (!tree) return json(404, { type: "error", error: { message: "commit not found" } });
    const p = pathSegs.filter((s) => s.length > 0).join("/");
    const file = tree.get(p);
    if (file && !dirRequest) {
      if (params.format === "meta") return this.ok(this.fileMeta(repo, sha, p, file));
      return new Response(new Uint8Array(file.bytes), { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(file.bytes.length), ...this.rateHeaders } });
    }
    const prefix = p ? `${p}/` : "";
    const children = new Map<string, Record<string, unknown>>();
    for (const [fp, f] of tree) {
      if (!fp.startsWith(prefix)) continue;
      const rest = fp.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) children.set(fp, this.fileMeta(repo, sha, fp, f));
      else {
        const dir = `${prefix}${rest.slice(0, slash)}`;
        if (!children.has(dir)) children.set(dir, { type: "commit_directory", path: dir, commit: { hash: sha }, links: { self: { href: `${API}/repositories/${repo.fullName}/src/${sha}/${dir}/` } } });
      }
    }
    if (!children.size) return json(404, { type: "error", error: { message: "path not found" } });
    if (params.format === "meta") return this.ok({ type: "commit_directory", path: p, commit: { hash: sha } });
    const all = [...children.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)));
    const size = Math.min(Number(params.pagelen ?? 10), this.dirPageSize);
    const page = Number(params.page ?? 1);
    const values = all.slice((page - 1) * size, page * size);
    const more = page * size < all.length;
    const selfDir = p ? `${p.split("/").map(encodeURIComponent).join("/")}/` : "";
    return this.ok({
      pagelen: size,
      page,
      values,
      ...(more ? { next: `${API}/repositories/${repo.fullName}/src/${sha}/${selfDir}?pagelen=${size}&page=${page + 1}` } : {}),
    });
  }

  private fileMeta(repo: FakeRepo, sha: string, path: string, f: FakeFile): Record<string, unknown> {
    const sub = f.attributes?.includes("subrepository");
    return {
      type: sub ? "commit_directory" : "commit_file",
      path,
      ...(sub ? {} : { size: f.bytes.length }),
      attributes: f.attributes ?? [],
      mimetype: null,
      commit: { hash: sha },
      escaped_path: path,
      links: { self: { href: `${API}/repositories/${repo.fullName}/src/${sha}/${path}` } },
    };
  }

  private diffstat(repo: FakeRepo, spec: string, params: Record<string, string>): Response {
    const m = /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/u.exec(spec);
    if (!m) return json(400, { type: "error", error: { message: "bad spec" } });
    if (params.topic !== "false") return json(400, { type: "error", error: { message: "this fake only serves two-dot diffstats" } });
    let [newer, older] = [m[1]!, m[2]!];
    if (this.reverseDiffstat) [newer, older] = [older, newer];
    const a = this.commits.get(older);
    const b = this.commits.get(newer);
    if (!a || !b) return json(404, { type: "error", error: { message: "commit not found" } });
    const side = (sha: string, path: string) => ({ path, type: "commit_file", escaped_path: path, links: { self: { href: `${API}/repositories/${repo.fullName}/src/${sha}/${path}` } } });
    const removed = [...a.keys()].filter((p) => !b.has(p));
    const added = [...b.keys()].filter((p) => !a.has(p));
    const hash = (f: FakeFile) => createHash("sha256").update(f.bytes).digest("hex");
    const values: Record<string, unknown>[] = [];
    const renamedFrom = new Set<string>();
    const renamedTo = new Set<string>();
    for (const r of removed) {
      const h = hash(a.get(r)!);
      const sameRemoved = removed.filter((x) => hash(a.get(x)!) === h);
      const candidates = added.filter((x) => hash(b.get(x)!) === h);
      if (sameRemoved.length === 1 && candidates.length === 1) {
        values.push({ type: "diffstat", status: "renamed", lines_added: 0, lines_removed: 0, old: side(older, r), new: side(newer, candidates[0]!) });
        renamedFrom.add(r);
        renamedTo.add(candidates[0]!);
      }
    }
    for (const r of removed) if (!renamedFrom.has(r)) values.push({ type: "diffstat", status: "removed", old: side(older, r), new: null });
    for (const p of added) if (!renamedTo.has(p)) values.push({ type: "diffstat", status: "added", old: null, new: side(newer, p) });
    for (const [p, f] of b) {
      const before = a.get(p);
      if (before && (!before.bytes.equals(f.bytes) || JSON.stringify(before.attributes ?? []) !== JSON.stringify(f.attributes ?? []))) {
        values.push({ type: "diffstat", status: "modified", old: side(older, p), new: side(newer, p) });
      }
    }
    const size = Math.min(Number(params.pagelen ?? 500), this.diffPageSize);
    const page = Number(params.page ?? 1);
    const more = page * size < values.length;
    return this.ok({
      pagelen: size,
      page,
      size: values.length,
      values: values.slice((page - 1) * size, page * size),
      ...(more ? { next: `${API}/repositories/${repo.fullName}/diffstat/${spec}?pagelen=${size}&topic=false&page=${page + 1}` } : {}),
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A PNG-like binary: signature, NUL bytes and bytes that are not valid UTF-8. */
export function binaryBytes(seed: number, length = 300): Buffer {
  const out = Buffer.alloc(length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out);
  for (let i = 8; i < length; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  out[9] = 0x00;
  out[10] = 0xff;
  out[11] = 0xfe;
  return out;
}
