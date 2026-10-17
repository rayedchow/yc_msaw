import { canonicalJson, sha256 } from "../util.js";
import { dirOf, normalizeWikiPath } from "../wiki/paths.js";
import { validateWiki, type ValidationReport } from "../wiki/validate.js";
import type { ObjectStore, StoredObject } from "./objects.js";

export interface RevisionFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RevisionBody {
  schema: "procmem.revision/v1";
  parent: string | null;
  createdAt: string;
  buildId: string;
  summary: string;
  /** Trace cohort this revision was built from (daily manifest ids), for provenance. */
  sources: string[];
  files: RevisionFile[];
  validation: { pages: number; directories: number; bytes: number; warnings: number };
}

export interface RevisionManifest extends RevisionBody {
  revisionId: string;
}

export interface HeadValue {
  revisionId: string;
  manifestSha256: string;
}

export class ConflictError extends Error {
  readonly code = "conflict";
  constructor(readonly expected: string | null, readonly actual: string | null) {
    super(`Publish conflict: draft was built on ${expected ?? "none"} but head is now ${actual ?? "none"}. Rebuild on the new head instead of overwriting.`);
  }
}

export class WikiValidationError extends Error {
  readonly code = "invalid_wiki";
  constructor(readonly report: ValidationReport) {
    super(`Wiki failed validation with ${report.errors.length} error(s)`);
  }
}

export const HEAD_REF = "memory/head";
const REVISION_RE = /^rev-[0-9a-f]{24}$/;

export const BOOTSTRAP_INDEX = `# Procedural memory

This wiki is maintained by the daily procedural-memory build from captured agent traces.
No workflows have been learned yet.
`;

/** Revision id is derived from the canonical manifest body, so any tampering is detectable. */
export function revisionIdFor(body: RevisionBody): string {
  return `rev-${sha256(canonicalJson(body)).slice(0, 24)}`;
}

/**
 * Published procedural memory for one tenant namespace: immutable
 * content-addressed revisions plus a CAS-protected head ref. Readers pin a
 * revision; builders publish complete validated trees against an exact base.
 */
export class MemoryRepo {
  readonly #fileCache = new Map<string, Map<string, string>>();

  constructor(readonly store: ObjectStore, readonly ns: string) {}

  async head(): Promise<{ value: HeadValue; version: number } | null> {
    const ref = await this.store.getRef(this.ns, HEAD_REF);
    return ref ? { value: ref.value as HeadValue, version: ref.version } : null;
  }

  /** Current head revision id, bootstrapping an empty wiki the first time. */
  async ensureHead(): Promise<string> {
    const h = await this.head();
    if (h) return h.value.revisionId;
    try {
      const { revisionId } = await this.#commit(null, null, new Map([["index.md", BOOTSTRAP_INDEX]]), { buildId: "bootstrap", summary: "Empty procedural memory wiki", sources: [] });
      return revisionId;
    } catch (error) {
      if (error instanceof ConflictError) return (await this.head())!.value.revisionId;
      throw error;
    }
  }

  async manifest(revisionId: string): Promise<RevisionManifest> {
    if (!REVISION_RE.test(revisionId)) throw new Error(`Invalid revision id ${JSON.stringify(revisionId)}`);
    const key = `revisions/${revisionId}.json`;
    const bytes = (await this.store.get(this.ns, [key])).get(key);
    if (!bytes) throw new Error(`Unknown revision ${revisionId}`);
    const manifest = JSON.parse(bytes.toString("utf8")) as RevisionManifest;
    const { revisionId: claimed, ...body } = manifest;
    if (claimed !== revisionId || revisionIdFor(body as RevisionBody) !== revisionId) {
      throw new Error(`Revision ${revisionId} manifest failed integrity verification`);
    }
    return manifest;
  }

  /** Complete verified file map of an immutable revision. */
  async files(revisionId: string): Promise<Map<string, string>> {
    const cached = this.#fileCache.get(revisionId);
    if (cached) return cached;
    const m = await this.manifest(revisionId);
    const blobs = await this.store.get(this.ns, m.files.map((f) => `blobs/${f.sha256}`));
    const out = new Map<string, string>();
    for (const f of m.files) {
      const bytes = blobs.get(`blobs/${f.sha256}`);
      if (!bytes || sha256(bytes) !== f.sha256) throw new Error(`Blob for ${f.path} in ${revisionId} is missing or corrupt`);
      out.set(f.path, bytes.toString("utf8"));
    }
    this.#fileCache.set(revisionId, out);
    return out;
  }

  async readPage(pagePath: string, revisionId: string): Promise<{ path: string; content: string }> {
    const files = await this.files(revisionId);
    let p = normalizeWikiPath(pagePath, { allowDirectory: true });
    if (!p.endsWith(".md")) p = p === "" ? "index.md" : `${p}/index.md`;
    const content = files.get(p);
    if (content === undefined) {
      const near = [...files.keys()].filter((k) => k.startsWith(dirOf(p))).slice(0, 10);
      throw new Error(`No page ${p} in ${revisionId}.${near.length ? ` Nearby: ${near.join(", ")}` : ""}`);
    }
    return { path: p, content };
  }

  async history(limit = 20): Promise<RevisionManifest[]> {
    const out: RevisionManifest[] = [];
    let id: string | null = (await this.head())?.value.revisionId ?? null;
    while (id && out.length < limit) {
      const m: RevisionManifest = await this.manifest(id);
      out.push(m);
      id = m.parent;
    }
    return out;
  }

  /**
   * Validate and publish a complete tree as a new immutable revision.
   * The head moves only if it still points at `base` (compare-and-swap).
   */
  async publish(base: string, files: ReadonlyMap<string, string>, meta: { buildId: string; summary: string; sources: string[] }) {
    const report = validateWiki(files);
    if (!report.ok) throw new WikiValidationError(report);
    const head = await this.head();
    if ((head?.value.revisionId ?? null) !== base) throw new ConflictError(base, head?.value.revisionId ?? null);
    const result = await this.#commit(base, head!.version, files, meta, report);
    return { ...result, report };
  }

  async #commit(parent: string | null, expectedVersion: number | null, files: ReadonlyMap<string, string>, meta: { buildId: string; summary: string; sources: string[] }, report = validateWiki(files)) {
    const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const objects: StoredObject[] = [];
    const fileRecords: RevisionFile[] = [];
    for (const [p, content] of entries) {
      const bytes = Buffer.from(content, "utf8");
      const digest = sha256(bytes);
      objects.push({ key: `blobs/${digest}`, bytes });
      fileRecords.push({ path: p, sha256: digest, bytes: bytes.length });
    }
    const body: RevisionBody = {
      schema: "procmem.revision/v1",
      parent,
      createdAt: new Date().toISOString(),
      buildId: meta.buildId,
      summary: meta.summary.slice(0, 4000),
      sources: meta.sources,
      files: fileRecords,
      validation: { ...report.stats, warnings: report.warnings.length },
    };
    const revisionId = revisionIdFor(body);
    const manifestBytes = Buffer.from(canonicalJson({ ...body, revisionId }), "utf8");
    // Objects first, then the head: a crash in between leaves only unreferenced immutable objects.
    await this.store.put(this.ns, [...objects, { key: `revisions/${revisionId}.json`, bytes: manifestBytes }]);
    const value: HeadValue = { revisionId, manifestSha256: sha256(manifestBytes) };
    const cas = await this.store.casRef(this.ns, HEAD_REF, expectedVersion, value);
    if (!cas.ok) throw new ConflictError(parent, (cas.current?.value as HeadValue | undefined)?.revisionId ?? null);
    this.#fileCache.set(revisionId, new Map(entries));
    return { revisionId, manifest: { ...body, revisionId } as RevisionManifest };
  }
}

export function diffTrees(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [p, c] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== c) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

export function describePage(content: string): { title: string; description: string } {
  const lines = content.split("\n").map((l) => l.trim());
  const title = (lines.find((l) => l.startsWith("# ")) ?? "").replace(/^#\s+/, "") || "(untitled)";
  const description = (lines.find((l) => l && !l.startsWith("#") && !l.startsWith("-") && !l.startsWith("|")) ?? "").slice(0, 200);
  return { title, description };
}
