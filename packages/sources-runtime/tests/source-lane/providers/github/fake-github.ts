/**
 * Fake GitHub REST API behind a fake Nango proxy (`<base>/proxy/<github path>`), driven by
 * the production GithubClient's real HTTP requests. Git objects are content-addressed:
 * blob ids are REAL git SHA-1s of the bytes (so the lane's verification runs for real),
 * trees and commits get deterministic ids. Supports recursive listings that report
 * `truncated`, non-recursive listings, base64 blobs wrapped at 60 columns, renamed
 * repositories (old name -> 301), empty repositories (409), per-connection visibility,
 * paged installation listings, GitHub rate-limit headers and injected faults.
 * Synthetic data only.
 */
import { createHash } from "node:crypto";

export const NANGO_BASE = "http://nango.test";
export const NANGO_KEY = "nango-secret-test-key";

export function gitBlobId(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function objId(kind: string, body: unknown): string {
  return createHash("sha1").update(`${kind}\n${JSON.stringify(body)}`).digest("hex");
}

export type FileSpec = string | Buffer | { symlink: string } | { submodule: string };

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  date: string;
}

interface Repo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  branches: Map<string, string>;
  empty: boolean;
  oldNames: string[];
}

export interface Fault {
  /** Substring or predicate over the GitHub path (with query). */
  match: string | ((path: string) => boolean);
  times: number;
  respond: () => Response;
}

export class FakeGithub {
  readonly repos = new Map<number, Repo>();
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, Commit>();
  /** connectionId -> visible repository ids. */
  readonly visibility = new Map<string, Set<number>>();
  /** Recursive listings with more entries than this report `truncated: true` (GitHub's limit is 100k / 7 MB). */
  recursiveLimit = Number.POSITIVE_INFINITY;
  /** Non-recursive listings of these trees report `truncated: true` and only the first `nonRecursiveKeep` entries. */
  readonly truncatedTrees = new Set<string>();
  nonRecursiveKeep = 1;
  readonly faults: Fault[] = [];
  readonly log: string[] = [];
  rateLimit = 5000;
  rateRemaining = 5000;
  rateReset = Math.floor(Date.now() / 1000) + 3600;
  /** When false, responses carry no x-ratelimit-* headers. */
  rateHeaders = true;
  installationPageSize = 100;

  repo(id: number, fullName: string, opts: { defaultBranch?: string; private?: boolean; connections?: string[] } = {}): void {
    this.repos.set(id, { id, fullName, defaultBranch: opts.defaultBranch ?? "main", private: opts.private ?? true, branches: new Map(), empty: false, oldNames: [] });
    for (const c of opts.connections ?? ["conn-1"]) {
      const set = this.visibility.get(c) ?? new Set<number>();
      set.add(id);
      this.visibility.set(c, set);
    }
  }

  rename(id: number, newFullName: string): void {
    const r = this.repos.get(id)!;
    r.oldNames.push(r.fullName);
    r.fullName = newFullName;
  }

  setEmpty(id: number): void {
    const r = this.repos.get(id)!;
    r.empty = true;
    r.branches.clear();
  }

  /** Build trees for `files` and make `branch` point at a new commit (or an existing one with the same content+date). */
  commit(id: number, branch: string, files: Record<string, FileSpec>, opts: { date?: string; message?: string; parents?: string[] } = {}): string {
    const tree = this.#buildTree(files);
    const repo = this.repos.get(id)!;
    const parents = opts.parents ?? (repo.branches.get(branch) ? [repo.branches.get(branch)!] : []);
    const body = { tree, parents, message: opts.message ?? "change", date: opts.date ?? "2026-07-01T00:00:00Z" };
    const sha = objId("commit", body);
    this.commits.set(sha, { sha, ...body });
    repo.empty = false;
    repo.branches.set(branch, sha);
    return sha;
  }

  /** Point a branch at an existing commit (force-push / rollback). */
  setBranch(id: number, branch: string, sha: string | null): void {
    const repo = this.repos.get(id)!;
    if (sha === null) repo.branches.delete(branch);
    else repo.branches.set(branch, sha);
  }

  treeOf(commitSha: string): string {
    return this.commits.get(commitSha)!.tree;
  }

  /** Tree id of a directory inside a commit. */
  subtreeId(commitSha: string, dir: string): string {
    let sha = this.treeOf(commitSha);
    for (const seg of dir.split("/").filter(Boolean)) sha = this.trees.get(sha)!.find((e) => e.path === seg && e.type === "tree")!.sha;
    return sha;
  }

  #buildTree(files: Record<string, FileSpec>): string {
    const root: Record<string, unknown> = {};
    for (const [path, spec] of Object.entries(files)) {
      const segs = path.split("/");
      let node = root;
      for (const s of segs.slice(0, -1)) node = (node[s] ??= {}) as Record<string, unknown>;
      node[segs.at(-1)!] = { __file: spec };
    }
    const write = (node: Record<string, unknown>): string => {
      const entries: TreeEntry[] = [];
      for (const name of Object.keys(node).sort()) {
        const v = node[name] as Record<string, unknown>;
        if ("__file" in v) {
          const spec = v.__file as FileSpec;
          if (typeof spec === "object" && !Buffer.isBuffer(spec) && "submodule" in spec) {
            entries.push({ path: name, mode: "160000", type: "commit", sha: spec.submodule });
            continue;
          }
          const isLink = typeof spec === "object" && !Buffer.isBuffer(spec) && "symlink" in spec;
          const bytes = isLink ? Buffer.from((spec as { symlink: string }).symlink, "utf8") : Buffer.isBuffer(spec) ? spec : Buffer.from(spec as string, "utf8");
          const sha = gitBlobId(bytes);
          this.blobs.set(sha, bytes);
          entries.push({ path: name, mode: isLink ? "120000" : "100644", type: "blob", sha, size: bytes.length });
        } else {
          entries.push({ path: name, mode: "040000", type: "tree", sha: write(v) });
        }
      }
      const sha = objId("tree", entries);
      this.trees.set(sha, entries);
      return sha;
    };
    return write(root);
  }

  #flatten(treeSha: string, prefix = ""): TreeEntry[] {
    const out: TreeEntry[] = [];
    for (const e of this.trees.get(treeSha) ?? []) {
      out.push({ ...e, path: `${prefix}${e.path}` });
      if (e.type === "tree") out.push(...this.#flatten(e.sha, `${prefix}${e.path}/`));
    }
    return out;
  }

  count(substring: string): number {
    return this.log.filter((l) => l.includes(substring)).length;
  }

  fail(match: Fault["match"], respond: () => Response, times = 1): void {
    this.faults.push({ match, respond, times });
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (init?.redirect !== "manual") return new Response("client must not follow redirects", { status: 500 });
    if (headers.get("authorization") !== `Bearer ${NANGO_KEY}`) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    const conn = headers.get("connection-id") ?? "";
    if (!headers.get("provider-config-key")) return Response.json({ error: { code: "missing_provider_config_key" } }, { status: 400 });
    if (!this.visibility.has(conn)) return Response.json({ error: { code: "unknown_connection" } }, { status: 404 });
    if (!url.pathname.startsWith("/proxy/")) return new Response("not found", { status: 404 });
    const ghPath = url.pathname.slice("/proxy".length);
    const full = `${ghPath}${url.search}`;
    this.log.push(full);
    for (const f of this.faults) {
      if (f.times > 0 && (typeof f.match === "string" ? full.includes(f.match) : f.match(full))) {
        f.times -= 1;
        return f.respond();
      }
    }
    this.rateRemaining = Math.max(0, this.rateRemaining - 1);
    return this.#route(conn, ghPath, url.searchParams);
  };

  #json(data: unknown, status = 200): Response {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.rateHeaders) {
      h["x-ratelimit-limit"] = String(this.rateLimit);
      h["x-ratelimit-remaining"] = String(this.rateRemaining);
      h["x-ratelimit-reset"] = String(this.rateReset);
      h["x-ratelimit-resource"] = "core";
    }
    return new Response(JSON.stringify(data), { status, headers: h });
  }

  #repoPayload(r: Repo): Record<string, unknown> {
    const [owner] = r.fullName.split("/");
    return {
      id: r.id,
      node_id: `R_${r.id}`,
      name: r.fullName.split("/")[1],
      full_name: r.fullName,
      private: r.private,
      visibility: r.private ? "private" : "public",
      archived: false,
      default_branch: r.defaultBranch,
      owner: { login: owner, id: 9000 + r.id, type: "Organization" },
      html_url: `https://github.com/${r.fullName}`,
      url: `https://api.github.com/repos/${r.fullName}`,
      permissions: { admin: false, push: false, pull: true },
      ...(r.private ? { temp_clone_token: "ABCDEFTEMPCLONETOKEN0123456789" } : {}),
    };
  }

  #route(conn: string, path: string, q: URLSearchParams): Response {
    const visible = this.visibility.get(conn)!;
    if (path === "/installation/repositories") {
      const all = [...visible].sort((a, b) => a - b).map((id) => this.repos.get(id)!).map((r) => this.#repoPayload(r));
      const per = Math.min(Number(q.get("per_page") ?? 30), this.installationPageSize);
      const page = Number(q.get("page") ?? 1);
      return this.#json({ total_count: all.length, repositories: all.slice((page - 1) * per, page * per) });
    }
    let m = /^\/repositories\/(\d+)$/u.exec(path);
    if (m) {
      const r = this.repos.get(Number(m[1]));
      return r && visible.has(r.id) ? this.#json(this.#repoPayload(r)) : this.#json({ message: "Not Found" }, 404);
    }
    m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/u.exec(path);
    if (!m) return this.#json({ message: "Not Found" }, 404);
    const name = m[1]!.toLowerCase();
    const rest = m[2] ?? "";
    let repo = [...this.repos.values()].find((r) => r.fullName.toLowerCase() === name);
    if (!repo) {
      const moved = [...this.repos.values()].find((r) => r.oldNames.some((o) => o.toLowerCase() === name));
      if (moved && visible.has(moved.id)) return new Response(null, { status: 301, headers: { location: `https://api.github.com/repositories/${moved.id}${rest}` } });
      return this.#json({ message: "Not Found" }, 404);
    }
    if (!visible.has(repo.id)) return this.#json({ message: "Not Found" }, 404);
    if (rest === "") return this.#json(this.#repoPayload(repo));
    m = /^\/git\/ref\/heads\/(.+)$/u.exec(rest);
    if (m) {
      if (repo.empty) return this.#json({ message: "Git Repository is empty." }, 409);
      const branch = m[1]!.split("/").map(decodeURIComponent).join("/");
      const sha = repo.branches.get(branch);
      return sha ? this.#json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } }) : this.#json({ message: "Not Found" }, 404);
    }
    m = /^\/git\/commits\/([0-9a-f]{40})$/u.exec(rest);
    if (m) {
      const c = this.commits.get(m[1]!);
      if (!c) return this.#json({ message: "Not Found" }, 404);
      return this.#json({
        sha: c.sha,
        tree: { sha: c.tree, url: `https://api.github.com/repos/${repo.fullName}/git/trees/${c.tree}` },
        parents: c.parents.map((p) => ({ sha: p })),
        message: c.message,
        author: { name: "Dev", email: "dev@example.test", date: c.date },
        committer: { name: "Dev", email: "dev@example.test", date: c.date },
        verification: { verified: false, reason: "unsigned", signature: null, payload: null },
      });
    }
    m = /^\/git\/trees\/([0-9a-f]{40})$/u.exec(rest);
    if (m) {
      const sha = m[1]!;
      if (!this.trees.has(sha)) return this.#json({ message: "Not Found" }, 404);
      if (q.get("recursive")) {
        const flat = this.#flatten(sha);
        if (flat.length > this.recursiveLimit) return this.#json({ sha, tree: flat.slice(0, this.recursiveLimit), truncated: true });
        return this.#json({ sha, tree: flat, truncated: false });
      }
      const entries = this.trees.get(sha)!;
      if (this.truncatedTrees.has(sha)) return this.#json({ sha, tree: entries.slice(0, this.nonRecursiveKeep), truncated: true });
      return this.#json({ sha, tree: entries, truncated: false });
    }
    m = /^\/git\/blobs\/([0-9a-f]{40})$/u.exec(rest);
    if (m) {
      const bytes = this.blobs.get(m[1]!);
      if (!bytes) return this.#json({ message: "Not Found" }, 404);
      const b64 = bytes.toString("base64").replace(/(.{60})/gu, "$1\n");
      return this.#json({ sha: m[1], node_id: "B_x", size: bytes.length, url: "https://api.github.com/x", content: `${b64}\n`, encoding: "base64" });
    }
    return this.#json({ message: "Not Found" }, 404);
  }
}

/** 429 secondary limit with Retry-After. */
export function secondaryLimit(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), { status: 429, headers: { "retry-after": String(retryAfterSeconds), "content-type": "application/json" } });
}

/** 403 primary limit exhausted (remaining 0, reset at epoch seconds). */
export function primaryLimit(resetEpochSeconds: number): Response {
  return new Response(JSON.stringify({ message: "API rate limit exceeded for installation ID 1." }), {
    status: 403,
    headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSeconds), "content-type": "application/json" },
  });
}

export function serverError(): Response {
  return new Response(JSON.stringify({ message: "Server Error" }), { status: 502, headers: { "content-type": "application/json" } });
}
