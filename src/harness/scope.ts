import { normalizeWikiPath } from "../wiki/paths.js";

/**
 * Knowledge write scopes (AEye knowledgeWriteScope): a child may create, edit,
 * move or delete Markdown only inside its scope. Entries are exact pages
 * ("a/b.md") or directory subtrees ("a/b", every page below a/b/). [] makes
 * the branch read-only. The root owns the whole tree ("all").
 */
export type ScopeEntry = { kind: "page"; path: string } | { kind: "subtree"; path: string };
export type WriteScope = "all" | readonly ScopeEntry[];

export class ScopeError extends Error {
  readonly code = "invalid_scope";
}

/** Parse model-supplied scope strings. "a/b.md" = page, "a/b" or "a/b/" = subtree. Duplicates/nesting rejected. */
export function parseScope(raw: unknown): ScopeEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ScopeError("knowledgeWriteScope must be an array of page paths or directory prefixes");
  if (raw.length > 256) throw new ScopeError("knowledgeWriteScope has more than 256 entries");
  const out: ScopeEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new ScopeError("knowledgeWriteScope entries must be strings");
    let p = item.trim().replace(/^\/+/, "");
    if (p.startsWith("knowledge/")) p = p.slice("knowledge/".length);
    if (p === "knowledge") p = "";
    const isPage = p.endsWith(".md");
    let canonical: string;
    try {
      canonical = normalizeWikiPath(p.replace(/\/+$/, ""), { allowDirectory: !isPage });
      // A subtree must be a legal wiki directory (e.g. never status/): check it as a directory path.
      if (!isPage && canonical !== "") normalizeWikiPath(`${canonical}/index.md`);
    } catch (error) {
      throw new ScopeError(`Invalid knowledgeWriteScope entry ${JSON.stringify(item)}: ${(error as Error).message}`);
    }
    out.push(isPage ? { kind: "page", path: canonical } : { kind: "subtree", path: canonical });
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (entriesOverlap(out[i]!, out[j]!)) throw new ScopeError(`knowledgeWriteScope entries overlap: ${describeEntry(out[i]!)} and ${describeEntry(out[j]!)}`);
    }
  }
  return out;
}

export function describeEntry(e: ScopeEntry): string {
  return e.kind === "page" ? e.path : `${e.path === "" ? "" : e.path + "/"}**`;
}

export function describeScope(scope: WriteScope): string[] | "all" {
  return scope === "all" ? "all" : scope.map(describeEntry);
}

function underDir(p: string, dir: string): boolean {
  return dir === "" || p === dir || p.startsWith(`${dir}/`);
}

export function scopeAllows(scope: WriteScope, page: string): boolean {
  if (scope === "all") return true;
  return scope.some((e) => (e.kind === "page" ? e.path === page : underDir(page, e.path) && page !== e.path));
}

export function entriesOverlap(a: ScopeEntry, b: ScopeEntry): boolean {
  if (a.kind === "page" && b.kind === "page") return a.path === b.path;
  if (a.kind === "subtree" && b.kind === "subtree") return underDir(a.path, b.path) || underDir(b.path, a.path);
  const page = a.kind === "page" ? a : b;
  const tree = a.kind === "subtree" ? a : b;
  return underDir(page.path, tree.path) && page.path !== tree.path;
}

export function scopesOverlap(a: WriteScope, b: WriteScope): boolean {
  if (a === "all") return b === "all" || b.length > 0;
  if (b === "all") return a.length > 0;
  return a.some((x) => b.some((y) => entriesOverlap(x, y)));
}

/** True when every entry of `inner` is contained in `outer`. */
export function scopeWithin(inner: WriteScope, outer: WriteScope): boolean {
  if (outer === "all") return true;
  if (inner === "all") return false;
  return inner.every((e) =>
    e.kind === "page" ? scopeAllows(outer, e.path) : outer.some((o) => o.kind === "subtree" && underDir(e.path, o.path)),
  );
}
