import { createHash } from "node:crypto";
import type { ObjectStore, StoredObject } from "../store/objects.js";
import { canonicalJson, sha256 } from "../util.js";
import { baseName, parentOf, providerOf, SourceError, storedToWire, wireToStored } from "./paths.js";

/**
 * Server-side sources/ filesystem for one tenant namespace.
 *
 * Layout on the ObjectStore (immutable objects + one CAS ref):
 *   blobs/<sha256>                exact content chunks (<= CHUNK_BYTES each)
 *   sources/v/<versionId>.json    immutable file version (content refs, provenance, freshness, previous)
 *   sources/t/<sha256>.json       immutable directory node or directory page (Merkle tree)
 *   sources/i/<sha256>.json       immutable batch-index node (idempotency, part of the head)
 *   sources/r/<sha256>.json       immutable batch receipt
 *   sources/c/<commitId>.json     commit (parent, root, batch, changes)
 *   ref sources/head              { commitId, root, batches, seq } advanced only by compare-and-swap
 *
 * Every batch (including a no-op one) commits its receipt into the batch index in
 * the same CAS that publishes its tree, so a replay finds the original receipt no
 * matter where a previous attempt crashed, and a different request reusing the
 * batchId is refused. Deleted files stay in the tree as tombstones so their history
 * is reachable; listings hide them. Provider state that is older than the current
 * entry (by provider version, then provider time, then capture time) is `stale` and
 * never applied. All name-keyed dictionaries are null-prototype objects, so provider
 * names such as `__proto__` or `constructor` are ordinary entries.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_INLINE_BYTES = 256 * 1024;
export const MAX_BATCH_CHANGES = 2_000;
/** A directory page holds at most this many entries before it is split (into halves of PAGE_TARGET). */
export const MAX_PAGE_ENTRIES = 2_000;
const PAGE_TARGET = 1_000;
/** Hard cap on entries in one directory (pages x entries); beyond it puts are `rejected` (too_large). */
export const MAX_DIR_ENTRIES = 4_000_000;
export const MAX_PROVENANCE_BYTES = 64 * 1024;
/** Clock skew tolerated on runtime-supplied capture times; later times would block all future updates. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_CAS_ATTEMPTS = 16;
const NODE_CACHE_ENTRIES = 20_000;
/** Default metadata cache budget for one process (all tenants together). */
export const DEFAULT_NODE_CACHE_BYTES = 64 * 1024 * 1024;

export const HEAD_REF = "sources/head";
export const EMPTY_SHA256 = createHash("sha256").digest("hex");

export type SourceKind = "projection" | "raw" | "binary";
export const SOURCE_KINDS: readonly SourceKind[] = ["projection", "raw", "binary"];

type Dict<T> = Record<string, T>;

/** Null-prototype dictionary: every key, including `__proto__`, is an own data property. */
export function dict<T>(src?: Dict<T>): Dict<T> {
  const out = Object.create(null) as Dict<T>;
  if (src) for (const k of Object.keys(src)) out[k] = src[k]!;
  return out;
}

/** JSON.parse that turns every object into a null-prototype dictionary. */
export function parseJsonDict<T>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? dict(value as Dict<unknown>) : value,
  ) as T;
}

export interface ChunkRef {
  sha256: string;
  size: number;
}

export interface SourceVersionRef {
  ref: string;
  ordinal?: number;
}

export interface SourceVersionBody {
  schema: "procmem.source-version/v1";
  path: string;
  entryId: string;
  provider: string;
  kind: SourceKind | "tombstone";
  contentType: string | null;
  size: number;
  sha256: string;
  chunks: ChunkRef[];
  sourceUpdatedAt: string | null;
  sourceVersion: SourceVersionRef | null;
  capturedAt: string;
  provenance: Dict<unknown>;
  previous: string | null;
  deleted?: { at: string; reason: string };
}

export interface SourceVersion extends SourceVersionBody {
  versionId: string;
}

export interface FileEntry {
  t: "f" | "x";
  v: string;
  kind: SourceKind | "tombstone";
  contentType: string | null;
  size: number;
  sha256: string;
  provenanceSha: string;
  sourceUpdatedAt: string | null;
  versionRef: string | null;
  ordinal: number | null;
  capturedAt: string;
}

export interface DirEntry {
  t: "d";
  tree: string;
  /** Direct children (live + tombstoned files + directories). */
  n: number;
  files: number;
  deleted: number;
  capturedAt: string | null;
  sourceUpdatedAt: string | null;
}

export type TreeChild = FileEntry | DirEntry;

export interface LeafNode {
  schema: "procmem.source-tree/v1";
  entries: Dict<TreeChild>;
}

export interface PageRef {
  /** Lowest name in the page ("" for the first page, so every name maps to a page). */
  first: string;
  sha: string;
  n: number;
  files: number;
  deleted: number;
  capturedAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface PagedNode {
  schema: "procmem.source-tree-pages/v1";
  pages: PageRef[];
}

export type DirNode = LeafNode | PagedNode;

export interface HeadValue {
  schema: "procmem.source-head/v2";
  commitId: string | null;
  root: string;
  batches: string;
  seq: number;
  updatedAt: string | null;
}

export interface PutChange {
  op: "put";
  path: string;
  kind: SourceKind;
  contentType: string;
  sha256: string;
  size: number;
  chunks?: string[];
  inline?: string;
  sourceUpdatedAt?: string | null;
  sourceVersion?: SourceVersionRef | null;
  capturedAt: string;
  provenance?: Dict<unknown>;
}

export interface DeleteChange {
  op: "delete";
  path: string;
  deletedAt: string;
  reason: string;
  capturedAt: string;
  provenance?: Dict<unknown>;
}

export type SourceChange = PutChange | DeleteChange;

export interface PublishBatch {
  batchId: string;
  changes: SourceChange[];
}

export type ChangeOutcome = "created" | "updated" | "restored" | "unchanged" | "stale" | "deleted" | "absent" | "rejected";

export interface ChangeResult {
  path: string;
  outcome: ChangeOutcome;
  versionId: string | null;
  /** Set for `rejected`: the change conflicts with the tree shape or limits and was not applied. */
  error?: { code: string; message: string };
}

export interface BatchReceipt {
  schema: "procmem.source-batch-receipt/v1";
  bindingId: string;
  batchId: string;
  requestDigest: string;
  commitId: string;
  seq: number;
  appliedAt: string;
  results: ChangeResult[];
  replayed?: boolean;
}

export interface CommitBody {
  schema: "procmem.source-commit/v1";
  parent: string | null;
  root: string;
  seq: number;
  createdAt: string;
  bindingId: string;
  batchId: string;
  requestDigest: string;
  changes: Array<{ path: string; outcome: ChangeOutcome; versionId: string | null }>;
}

/** Who is writing: a verified binding (tenant comes from the store's ns, never from the batch). */
export interface PublishIdentity {
  bindingId: string;
  /** Provider directories this binding may write; `*` allows any provider. */
  providers: readonly string[];
}

const EMPTY_LEAF: LeafNode = { schema: "procmem.source-tree/v1", entries: dict() };
export const EMPTY_TREE_SHA = sha256(canonicalJson(EMPTY_LEAF));

interface IndexNode {
  schema: "procmem.source-batch-index/v1";
  entries: Dict<{ t: "n"; sha: string } | BatchIndexEntry>;
}

interface BatchIndexEntry {
  t: "b";
  requestDigest: string;
  commitId: string;
  seq: number;
  receipt: string;
}

const EMPTY_INDEX: IndexNode = { schema: "procmem.source-batch-index/v1", entries: dict() };
export const EMPTY_INDEX_SHA = sha256(canonicalJson(EMPTY_INDEX));

const versionKey = (id: string) => `sources/v/${id}.json`;
const treeKey = (sha: string) => `sources/t/${sha}.json`;
const indexKey = (sha: string) => `sources/i/${sha}.json`;
const receiptKey = (sha: string) => `sources/r/${sha}.json`;
const commitKey = (id: string) => `sources/c/${id}.json`;
const VERSION_ID_RE = /^sv-[0-9a-f]{32}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export function entryIdFor(provider: string, stored: string): string {
  return `se-${sha256(`${provider}\n${stored}`).slice(0, 24)}`;
}

export function versionIdFor(body: SourceVersionBody): string {
  return `sv-${sha256(canonicalJson(body)).slice(0, 32)}`;
}

export function isVersionId(value: unknown): value is string {
  return typeof value === "string" && VERSION_ID_RE.test(value);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function parseIso(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 40) throw new SourceError("invalid_input", `${label} must be an ISO-8601 timestamp`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new SourceError("invalid_input", `${label} must be an ISO-8601 timestamp`);
  return new Date(ms).toISOString();
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

export function isTextualContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  return ct.startsWith("text/") || ct === "application/json" || ct.endsWith("+json") || ct === "application/xml" || ct.endsWith("+xml") || ct === "application/x-ndjson";
}

function isLive(entry: TreeChild): boolean {
  return entry.t === "f" || (entry.t === "d" && entry.files > 0);
}

/** Binary search: index of the last page whose `first` <= name (page 0 has first ""). */
function pageIndexFor(pages: readonly { first: string }[], name: string): number {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid]!.first <= name) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Byte-bounded LRU of parsed, digest-verified metadata objects (directory nodes/pages,
 * batch-index nodes). One instance is shared by every tenant store of a process; keys
 * carry the namespace, so tenants never see each other's entries. Content bytes are
 * never cached here. Objects larger than an eighth of the budget are not cached at all.
 */
export class SourceNodeCache {
  readonly #map = new Map<string, { value: unknown; bytes: number }>();
  #bytes = 0;

  constructor(
    readonly maxBytes = DEFAULT_NODE_CACHE_BYTES,
    readonly maxEntries = NODE_CACHE_ENTRIES,
  ) {}

  get size(): number {
    return this.#map.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get<T>(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    this.#map.delete(key);
    this.#map.set(key, hit);
    return hit.value as T;
  }

  set(key: string, value: unknown, bytes: number): void {
    if (bytes > this.maxBytes / 8) return;
    const prior = this.#map.get(key);
    if (prior) {
      this.#bytes -= prior.bytes;
      this.#map.delete(key);
    }
    this.#map.set(key, { value, bytes });
    this.#bytes += bytes;
    while (this.#bytes > this.maxBytes || this.#map.size > this.maxEntries) {
      const oldest = this.#map.keys().next().value!;
      this.#bytes -= this.#map.get(oldest)!.bytes;
      this.#map.delete(oldest);
    }
  }
}

interface PreparedPut {
  op: "put";
  stored: string;
  wire: string;
  provider: string;
  kind: SourceKind;
  contentType: string;
  sha256: string;
  size: number;
  chunks: ChunkRef[];
  sourceUpdatedAt: string | null;
  sourceVersion: SourceVersionRef | null;
  capturedAt: string;
  provenance: Dict<unknown>;
  provenanceSha: string;
}

interface PreparedDelete {
  op: "delete";
  stored: string;
  wire: string;
  provider: string;
  deletedAt: string;
  reason: string;
  capturedAt: string;
  provenance: Dict<unknown>;
  provenanceSha: string;
}

type Prepared = PreparedPut | PreparedDelete;

export interface ListEntry {
  name: string;
  path: string;
  entry: TreeChild;
}

export interface WalkItem {
  path: string;
  entry: TreeChild;
}

export type Resolved = { type: "dir"; sha: string; entry: DirEntry | null } | { type: "file"; entry: FileEntry };

export class SourceStore {
  readonly #cache: SourceNodeCache;
  readonly #now: () => Date;

  constructor(
    readonly store: ObjectStore,
    readonly ns: string,
    opts: { now?: () => Date; cache?: SourceNodeCache } = {},
  ) {
    this.#now = opts.now ?? (() => new Date());
    this.#cache = opts.cache ?? new SourceNodeCache(8 * 1024 * 1024);
  }

  // ---------------------------------------------------------------- reads

  async head(): Promise<{ value: HeadValue; version: number | null }> {
    const ref = await this.store.getRef(this.ns, HEAD_REF);
    if (!ref) {
      return { value: { schema: "procmem.source-head/v2", commitId: null, root: EMPTY_TREE_SHA, batches: EMPTY_INDEX_SHA, seq: 0, updatedAt: null }, version: null };
    }
    return { value: ref.value as HeadValue, version: ref.version };
  }

  /** Fetch, digest-verify and parse an immutable metadata object (cached by namespace + key). */
  async #object<T>(key: string, sha: string, what: string): Promise<T> {
    const cacheKey = `${this.ns}\u0000${key}`;
    const cached = this.#cache.get<T>(cacheKey);
    if (cached !== undefined) return cached;
    const bytes = (await this.store.get(this.ns, [key])).get(key);
    if (!bytes) throw new SourceError("integrity", `${what} ${sha} is missing from the object store`);
    if (sha256(bytes) !== sha) throw new SourceError("integrity", `${what} ${sha} failed its digest check`);
    const value = parseJsonDict<T>(bytes.toString("utf8"));
    // Parsed objects cost roughly twice their JSON size in memory.
    this.#cache.set(cacheKey, value, bytes.length * 2);
    return value;
  }

  async node(sha: string): Promise<DirNode> {
    if (sha === EMPTY_TREE_SHA) return EMPTY_LEAF;
    return this.#object<DirNode>(treeKey(sha), sha, "Directory node");
  }

  async #page(sha: string): Promise<LeafNode> {
    const n = await this.node(sha);
    if (n.schema !== "procmem.source-tree/v1") throw new SourceError("integrity", `Directory page ${sha} is not a leaf node`);
    return n;
  }

  /** Child `name` of the directory node `sha` (loads only the page that can hold it). */
  async lookup(sha: string, name: string): Promise<TreeChild | undefined> {
    const node = await this.node(sha);
    if (node.schema === "procmem.source-tree/v1") return node.entries[name];
    if (node.pages.length === 0) return undefined;
    const page = await this.#page(node.pages[pageIndexFor(node.pages, name)]!.sha);
    return page.entries[name];
  }

  /** Name-sorted children of a directory node, optionally starting after `after`. */
  async *children(sha: string, after?: string): AsyncGenerator<[string, TreeChild]> {
    const node = await this.node(sha);
    const pages = node.schema === "procmem.source-tree/v1" ? null : node.pages;
    const leaves: Array<() => Promise<LeafNode>> = pages
      ? pages
          .filter((p, i) => after === undefined || i === pages.length - 1 || pages[i + 1]!.first > after)
          .map((p) => () => this.#page(p.sha))
      : [async () => node as LeafNode];
    for (const load of leaves) {
      const leaf = await load();
      for (const name of Object.keys(leaf.entries).sort()) {
        if (after !== undefined && name <= after) continue;
        yield [name, leaf.entries[name]!];
      }
    }
  }

  /** Resolve a stored path against a root (default: current head). */
  async resolve(stored: string, root?: string): Promise<Resolved | null> {
    let sha = root ?? (await this.head()).value.root;
    if (stored === "") return { type: "dir", sha, entry: null };
    const parts = stored.split("/");
    for (let i = 0; i < parts.length; i++) {
      const child = await this.lookup(sha, parts[i]!);
      if (!child) return null;
      if (child.t === "d") {
        sha = child.tree;
        if (i === parts.length - 1) return { type: "dir", sha, entry: child };
      } else {
        return i === parts.length - 1 ? { type: "file", entry: child } : null;
      }
    }
    return null;
  }

  async list(
    stored: string,
    opts: { limit?: number; after?: string; includeDeleted?: boolean } = {},
    root?: string,
  ): Promise<{ entries: ListEntry[]; nextAfter: string | null }> {
    const r = await this.resolve(stored, root);
    if (!r) throw new SourceError("not_found", `No such source path: ${stored || "(root)"}`);
    if (r.type !== "dir") throw new SourceError("not_a_directory", `${stored} is a file`);
    const limit = Math.max(1, opts.limit ?? 1_000);
    const entries: ListEntry[] = [];
    let nextAfter: string | null = null;
    for await (const [name, entry] of this.children(r.sha, opts.after)) {
      if (!opts.includeDeleted && !isLive(entry)) continue;
      if (entries.length >= limit) {
        nextAfter = entries[entries.length - 1]!.name;
        break;
      }
      entries.push({ name, path: stored ? `${stored}/${name}` : name, entry });
    }
    return { entries, nextAfter };
  }

  /** Depth-first, name-sorted walk below `stored` (excluding itself). */
  /** Depth-first walk. `skip(path)` true omits that entry and, for a directory, everything below it. */
  async *walk(stored: string, opts: { includeDeleted?: boolean; skip?: (path: string) => boolean } = {}, root?: string): AsyncGenerator<WalkItem> {
    const r = await this.resolve(stored, root);
    if (!r) throw new SourceError("not_found", `No such source path: ${stored || "(root)"}`);
    if (r.type !== "dir") {
      yield { path: stored, entry: r.entry };
      return;
    }
    const self = this;
    const visit = async function* (dir: string, sha: string): AsyncGenerator<WalkItem> {
      for await (const [name, entry] of self.children(sha)) {
        if (!opts.includeDeleted && !isLive(entry)) continue;
        const path = dir ? `${dir}/${name}` : name;
        if (opts.skip?.(path)) continue;
        yield { path, entry };
        if (entry.t === "d") yield* visit(path, entry.tree);
      }
    };
    yield* visit(stored, r.sha);
  }

  async version(versionId: string): Promise<SourceVersion> {
    if (!isVersionId(versionId)) throw new SourceError("invalid_input", `Invalid versionId ${JSON.stringify(versionId)}`);
    const bytes = (await this.store.get(this.ns, [versionKey(versionId)])).get(versionKey(versionId));
    if (!bytes) throw new SourceError("not_found", `No source version ${versionId}`);
    const body = parseJsonDict<SourceVersionBody>(bytes.toString("utf8"));
    if (versionIdFor(body) !== versionId) throw new SourceError("integrity", `Source version ${versionId} failed its digest check`);
    return { ...body, versionId };
  }

  /** Exact bytes [start, start+length) of a version; every chunk is digest-verified. */
  async readRange(version: Pick<SourceVersion, "chunks" | "size" | "versionId">, start: number, length: number): Promise<Buffer> {
    if (start < 0 || length < 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(length)) throw new SourceError("invalid_input", "Invalid byte range");
    if (start > version.size) throw new SourceError("invalid_input", `byte offset ${start} is beyond the end (${version.size} bytes)`);
    const end = Math.min(version.size, start + length);
    const parts: Buffer[] = [];
    let offset = 0;
    for (const chunk of version.chunks) {
      const cStart = offset;
      const cEnd = offset + chunk.size;
      offset = cEnd;
      if (cEnd <= start || cStart >= end) continue;
      const key = `blobs/${chunk.sha256}`;
      const bytes = (await this.store.get(this.ns, [key])).get(key);
      if (!bytes) throw new SourceError("integrity", `Content chunk ${chunk.sha256} of ${version.versionId} is missing`);
      if (bytes.length !== chunk.size || sha256(bytes) !== chunk.sha256) throw new SourceError("integrity", `Content chunk ${chunk.sha256} of ${version.versionId} failed its digest check`);
      parts.push(bytes.subarray(Math.max(0, start - cStart), Math.min(chunk.size, end - cStart)));
    }
    return Buffer.concat(parts);
  }

  /** Version chain for a path, newest first, starting at the current entry (or after `before`). */
  async history(stored: string, opts: { limit?: number; before?: string } = {}): Promise<{ versions: SourceVersion[]; nextBefore: string | null }> {
    const r = await this.resolve(stored);
    if (!r) throw new SourceError("not_found", `No such source path: ${stored}`);
    if (r.type !== "file") throw new SourceError("not_a_file", `${stored} is a directory`);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
    let cursor: string | null = r.entry.v;
    if (opts.before !== undefined) {
      const anchor = await this.version(opts.before);
      if (anchor.path !== stored) throw new SourceError("invalid_input", `version ${opts.before} does not belong to ${stored}`);
      cursor = anchor.previous;
    }
    const versions: SourceVersion[] = [];
    while (cursor && versions.length < limit) {
      const v = await this.version(cursor);
      versions.push(v);
      cursor = v.previous;
    }
    return { versions, nextBefore: cursor && versions.length ? versions[versions.length - 1]!.versionId : null };
  }

  // ---------------------------------------------------------------- batch index

  async #indexNode(sha: string): Promise<IndexNode> {
    if (sha === EMPTY_INDEX_SHA) return EMPTY_INDEX;
    return this.#object<IndexNode>(indexKey(sha), sha, "Batch index node");
  }

  /** Two levels of 256-way fan-out by key prefix, then a leaf keyed by the full batch key. */
  async #indexGet(root: string, key: string): Promise<BatchIndexEntry | undefined> {
    const l1 = (await this.#indexNode(root)).entries[key.slice(0, 2)];
    if (!l1 || l1.t !== "n") return undefined;
    const l2 = (await this.#indexNode(l1.sha)).entries[key.slice(2, 4)];
    if (!l2 || l2.t !== "n") return undefined;
    const leaf = (await this.#indexNode(l2.sha)).entries[key];
    return leaf && leaf.t === "b" ? leaf : undefined;
  }

  async #indexPut(root: string, key: string, entry: BatchIndexEntry): Promise<{ root: string; nodes: Array<[string, IndexNode]> }> {
    const n0 = await this.#indexNode(root);
    const c1 = n0.entries[key.slice(0, 2)];
    const n1 = c1 && c1.t === "n" ? await this.#indexNode(c1.sha) : EMPTY_INDEX;
    const c2 = n1.entries[key.slice(2, 4)];
    const n2 = c2 && c2.t === "n" ? await this.#indexNode(c2.sha) : EMPTY_INDEX;
    const nodes: Array<[string, IndexNode]> = [];
    const write = (entries: IndexNode["entries"]): string => {
      const node: IndexNode = { schema: "procmem.source-batch-index/v1", entries };
      const sha = sha256(canonicalJson(node));
      nodes.push([sha, node]);
      return sha;
    };
    const leaf = dict(n2.entries);
    leaf[key] = entry;
    const s2 = write(leaf);
    const mid = dict(n1.entries);
    mid[key.slice(2, 4)] = { t: "n", sha: s2 };
    const s1 = write(mid);
    const top = dict(n0.entries);
    top[key.slice(0, 2)] = { t: "n", sha: s1 };
    return { root: write(top), nodes };
  }

  // ---------------------------------------------------------------- writes

  /** Store one content chunk; the key is its digest so duplicates are free. */
  async putBlob(bytes: Buffer, expectedSha?: string): Promise<{ sha256: string; size: number }> {
    if (bytes.length > CHUNK_BYTES) throw new SourceError("too_large", `Chunk exceeds ${CHUNK_BYTES} bytes; split content into chunks`);
    const digest = sha256(bytes);
    if (expectedSha !== undefined && digest !== expectedSha) throw new SourceError("integrity", `Chunk digest ${digest} does not match ${expectedSha}`);
    await this.store.put(this.ns, [{ key: `blobs/${digest}`, bytes }]);
    return { sha256: digest, size: bytes.length };
  }

  /**
   * Apply one batch atomically. The receipt is committed into the batch index in the
   * same head CAS as the tree, so replays return it verbatim (replayed:true), a
   * different request under the same batchId is refused, and concurrent identical
   * requests resolve to one commit.
   */
  async applyBatch(identity: PublishIdentity, batch: PublishBatch): Promise<BatchReceipt> {
    if (typeof batch.batchId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(batch.batchId)) {
      throw new SourceError("invalid_input", "batchId must be 1-200 chars of [A-Za-z0-9._:-]");
    }
    if (!Array.isArray(batch.changes) || batch.changes.length > MAX_BATCH_CHANGES) {
      throw new SourceError("invalid_input", `changes must be an array of at most ${MAX_BATCH_CHANGES}`);
    }
    const batchKey = sha256(`${identity.bindingId}\n${batch.batchId}`);
    const requestDigest = sha256(canonicalJson({ bindingId: identity.bindingId, batchId: batch.batchId, changes: batch.changes }));
    let prepared: Prepared[] | null = null;

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      const head = await this.head();
      const prior = await this.#indexGet(head.value.batches, batchKey);
      if (prior) {
        if (prior.requestDigest !== requestDigest) {
          throw new SourceError("batch_conflict", `batchId ${batch.batchId} was already applied with a different request`, { commitId: prior.commitId });
        }
        const receipt = await this.#object<BatchReceipt>(receiptKey(prior.receipt), prior.receipt, "Batch receipt");
        return { ...receipt, replayed: true };
      }
      prepared ??= await this.#prepare(identity, batch.changes);

      const overlay = new Overlay(this, head.value.root);
      const results: ChangeResult[] = [];
      const versions: StoredObject[] = [];
      const written: CommitBody["changes"] = [];
      for (const change of prepared) {
        let r: Awaited<ReturnType<Overlay["apply"]>>;
        try {
          r = await overlay.apply(change);
        } catch (error) {
          // Shape/limit conflicts reject only this change; the publisher must not treat it as delivered.
          if (error instanceof SourceError && (error.code === "path_conflict" || error.code === "too_large")) {
            results.push({ path: change.wire, outcome: "rejected", versionId: null, error: { code: error.code, message: error.message } });
            continue;
          }
          throw error;
        }
        results.push({ path: change.wire, outcome: r.outcome, versionId: r.versionId });
        if (r.version) {
          versions.push({ key: versionKey(r.version.versionId), bytes: jsonBytes(stripId(r.version)) });
          written.push({ path: change.wire, outcome: r.outcome, versionId: r.version.versionId });
        }
      }
      const { root, nodes } = await overlay.finish();
      const appliedAt = this.#now().toISOString();
      const commitBody: CommitBody = {
        schema: "procmem.source-commit/v1",
        parent: head.value.commitId,
        root,
        seq: head.value.seq + 1,
        createdAt: appliedAt,
        bindingId: identity.bindingId,
        batchId: batch.batchId,
        requestDigest,
        changes: written,
      };
      const commitId = `sc-${sha256(canonicalJson(commitBody)).slice(0, 32)}`;
      const receipt: BatchReceipt = {
        schema: "procmem.source-batch-receipt/v1",
        bindingId: identity.bindingId,
        batchId: batch.batchId,
        requestDigest,
        commitId,
        seq: commitBody.seq,
        appliedAt,
        results,
      };
      const receiptBytes = jsonBytes(receipt);
      const receiptSha = sha256(receiptBytes);
      const index = await this.#indexPut(head.value.batches, batchKey, { t: "b", requestDigest, commitId, seq: commitBody.seq, receipt: receiptSha });
      // Everything the new head references is written before the head moves.
      await this.store.put(this.ns, [
        ...versions,
        ...nodes.map(([sha, node]) => ({ key: treeKey(sha), bytes: jsonBytes(node) })),
        ...index.nodes.map(([sha, node]) => ({ key: indexKey(sha), bytes: jsonBytes(node) })),
        { key: receiptKey(receiptSha), bytes: receiptBytes },
        { key: commitKey(commitId), bytes: jsonBytes(commitBody) },
      ]);
      const next: HeadValue = { schema: "procmem.source-head/v2", commitId, root, batches: index.root, seq: commitBody.seq, updatedAt: appliedAt };
      const cas = await this.store.casRef(this.ns, HEAD_REF, head.version, next);
      if (cas.ok) return receipt;
      // Lost the race: re-check the index (a concurrent identical request may have won) and rebase.
      await new Promise((r) => setTimeout(r, Math.min(250, 4 * attempt * attempt) * Math.random()));
    }
    throw new SourceError("conflict", "The sources head kept moving; retry the batch", { reason: "head_contention" });
  }

  async #prepare(identity: PublishIdentity, changes: SourceChange[]): Promise<Prepared[]> {
    const seen = new Set<string>();
    const out: Prepared[] = [];
    const nowMs = this.#now().getTime();
    for (const [i, change] of changes.entries()) {
      const label = `changes[${i}]`;
      if (!change || typeof change !== "object") throw new SourceError("invalid_input", `${label} must be an object`);
      const { stored, provider } = wireToStored(change.path);
      if (!identity.providers.includes("*") && !identity.providers.includes(provider)) {
        throw new SourceError("forbidden_provider", `${label}: this binding may not write sources/${provider}/`, { provider });
      }
      if (seen.has(stored)) throw new SourceError("invalid_input", `${label}: duplicate path ${change.path} in one batch`);
      seen.add(stored);
      const capturedAt = parseIso(change.capturedAt, `${label}.capturedAt`);
      if (Date.parse(capturedAt) > nowMs + MAX_FUTURE_SKEW_MS) throw new SourceError("invalid_input", `${label}.capturedAt is in the future`);
      const provenance = change.provenance ?? dict();
      if (typeof provenance !== "object" || provenance === null || Array.isArray(provenance)) throw new SourceError("invalid_input", `${label}.provenance must be an object`);
      // The binding is the only authority for who wrote this; a client-supplied bindingId is overwritten.
      const fullProvenance = dict(provenance as Dict<unknown>);
      fullProvenance.bindingId = identity.bindingId;
      // A provider time beyond the skew window (clock or data error) would make every later put to this path stale
      // forever (final-audit L5). It is kept in provenance only and ordering falls back to capture time.
      let sourceUpdatedAt: string | null = null;
      if (change.op === "put" && change.sourceUpdatedAt !== undefined && change.sourceUpdatedAt !== null) {
        sourceUpdatedAt = parseIso(change.sourceUpdatedAt, `${label}.sourceUpdatedAt`);
        if (Date.parse(sourceUpdatedAt) > nowMs + MAX_FUTURE_SKEW_MS) {
          fullProvenance.futureSourceUpdatedAt = sourceUpdatedAt;
          sourceUpdatedAt = null;
        }
      }
      const provJson = canonicalJson(fullProvenance);
      if (Buffer.byteLength(provJson, "utf8") > MAX_PROVENANCE_BYTES) throw new SourceError("too_large", `${label}.provenance exceeds ${MAX_PROVENANCE_BYTES} bytes`);
      if (change.op === "delete") {
        if (typeof change.reason !== "string" || change.reason.length === 0 || change.reason.length > 200) throw new SourceError("invalid_input", `${label}.reason must be 1-200 chars`);
        out.push({
          op: "delete",
          stored,
          wire: change.path,
          provider,
          deletedAt: parseIso(change.deletedAt, `${label}.deletedAt`),
          reason: change.reason,
          capturedAt,
          provenance: fullProvenance,
          provenanceSha: sha256(provJson),
        });
        continue;
      }
      if (change.op !== "put") throw new SourceError("invalid_input", `${label}.op must be put or delete`);
      if (!SOURCE_KINDS.includes(change.kind)) throw new SourceError("invalid_input", `${label}.kind must be one of ${SOURCE_KINDS.join(", ")}`);
      if (
        typeof change.contentType !== "string" ||
        change.contentType.length > 200 ||
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(;[ -~]{0,150})?$/i.test(change.contentType)
      ) {
        throw new SourceError("invalid_input", `${label}.contentType must be a media type`);
      }
      if (typeof change.sha256 !== "string" || !SHA_RE.test(change.sha256)) throw new SourceError("invalid_input", `${label}.sha256 must be lowercase hex sha256`);
      if (!Number.isSafeInteger(change.size) || change.size < 0) throw new SourceError("invalid_input", `${label}.size must be a non-negative integer`);
      const sourceVersion = normalizeSourceVersion(change.sourceVersion, label);
      const chunks = await this.#content(label, change);
      out.push({
        op: "put",
        stored,
        wire: change.path,
        provider,
        kind: change.kind,
        contentType: change.contentType,
        sha256: change.sha256,
        size: change.size,
        chunks,
        sourceUpdatedAt,
        sourceVersion,
        capturedAt,
        provenance: fullProvenance,
        provenanceSha: sha256(provJson),
      });
    }
    return out;
  }

  /** Materialize inline content or verify referenced chunks; the whole-file digest and size must match exactly. */
  async #content(label: string, change: PutChange): Promise<ChunkRef[]> {
    if (change.inline !== undefined && change.chunks !== undefined) throw new SourceError("invalid_input", `${label}: give inline or chunks, not both`);
    if (change.inline !== undefined) {
      if (typeof change.inline !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(change.inline) || change.inline.length % 4 !== 0) {
        throw new SourceError("invalid_input", `${label}.inline must be padded base64`);
      }
      const bytes = Buffer.from(change.inline, "base64");
      if (bytes.length > MAX_INLINE_BYTES) throw new SourceError("too_large", `${label}.inline exceeds ${MAX_INLINE_BYTES} bytes; upload chunks to /v1/sources/blobs`);
      if (bytes.length !== change.size || sha256(bytes) !== change.sha256) throw new SourceError("integrity", `${label}: inline content does not match sha256/size`);
      if (bytes.length === 0) return [];
      return [await this.putBlob(bytes)];
    }
    const shas = change.chunks ?? [];
    if (!Array.isArray(shas) || shas.length > 100_000 || shas.some((s) => typeof s !== "string" || !SHA_RE.test(s))) {
      throw new SourceError("invalid_input", `${label}.chunks must be a list of sha256 hex digests`);
    }
    const hash = createHash("sha256");
    const refs: ChunkRef[] = [];
    const missing: string[] = [];
    let total = 0;
    for (const sha of shas) {
      const key = `blobs/${sha}`;
      const bytes = (await this.store.get(this.ns, [key])).get(key);
      if (!bytes) {
        missing.push(sha);
        continue;
      }
      if (sha256(bytes) !== sha) throw new SourceError("integrity", `${label}: stored chunk ${sha} failed its digest check`);
      hash.update(bytes);
      total += bytes.length;
      refs.push({ sha256: sha, size: bytes.length });
    }
    if (missing.length) throw new SourceError("missing_blobs", `${label}: ${missing.length} chunk(s) not uploaded`, { missing: [...new Set(missing)] });
    if (total !== change.size || hash.digest("hex") !== change.sha256) throw new SourceError("integrity", `${label}: chunks do not concatenate to sha256/size`);
    return refs;
  }
}

function normalizeSourceVersion(value: unknown, label: string): SourceVersionRef | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new SourceError("invalid_input", `${label}.sourceVersion must be {ref, ordinal?}`);
  const v = value as { ref?: unknown; ordinal?: unknown };
  if (typeof v.ref !== "string" || v.ref.length === 0 || v.ref.length > 200) throw new SourceError("invalid_input", `${label}.sourceVersion.ref must be 1-200 chars`);
  if (v.ordinal !== undefined && (typeof v.ordinal !== "number" || !Number.isFinite(v.ordinal))) throw new SourceError("invalid_input", `${label}.sourceVersion.ordinal must be a finite number`);
  return v.ordinal === undefined ? { ref: v.ref } : { ref: v.ref, ordinal: v.ordinal };
}

function stripId(v: SourceVersion): SourceVersionBody {
  const { versionId: _id, ...body } = v;
  return body;
}

/**
 * Ordering of provider states for one file: provider version ordinal when both sides
 * have one, else provider modification time when both have one, then capture time.
 * Returns <0 when `incoming` is older than `current`.
 */
export function compareSourceState(
  incoming: { ordinal: number | null; sourceUpdatedAt: string | null; capturedAt: string },
  current: { ordinal: number | null; sourceUpdatedAt: string | null; capturedAt: string },
): number {
  if (incoming.ordinal !== null && current.ordinal !== null && incoming.ordinal !== current.ordinal) return incoming.ordinal < current.ordinal ? -1 : 1;
  if (incoming.sourceUpdatedAt !== null && current.sourceUpdatedAt !== null && incoming.sourceUpdatedAt !== current.sourceUpdatedAt) {
    return incoming.sourceUpdatedAt < current.sourceUpdatedAt ? -1 : 1;
  }
  return incoming.capturedAt < current.capturedAt ? -1 : incoming.capturedAt > current.capturedAt ? 1 : 0;
}

interface PageState {
  first: string;
  ref: PageRef | null;
  entries: Dict<TreeChild> | null;
  dirty: boolean;
}

interface DirState {
  pages: PageState[];
  n: number;
}

/**
 * Copy-on-write view of the tree used to apply one batch. Directories (and only the
 * pages that are touched) load lazily; modified pages and their ancestors are
 * re-hashed bottom-up in finish(). Pages split above MAX_PAGE_ENTRIES.
 */
class Overlay {
  readonly #dirs = new Map<string, DirState>();
  readonly #dirty = new Set<string>();

  constructor(
    readonly src: SourceStore,
    readonly root: string,
  ) {}

  async #fromNode(sha: string): Promise<DirState> {
    const node = await this.src.node(sha);
    if (node.schema === "procmem.source-tree/v1") {
      return { pages: [{ first: "", ref: null, entries: dict(node.entries), dirty: false }], n: Object.keys(node.entries).length };
    }
    const pages = node.pages.map((p) => ({ first: p.first, ref: p, entries: null, dirty: false }));
    return { pages: pages.length ? pages : [{ first: "", ref: null, entries: dict(), dirty: false }], n: node.pages.reduce((s, p) => s + p.n, 0) };
  }

  async #pageFor(dir: DirState, name: string): Promise<PageState> {
    const page = dir.pages[pageIndexFor(dir.pages, name)]!;
    if (!page.entries) {
      const leaf = await this.src.node(page.ref!.sha);
      if (leaf.schema !== "procmem.source-tree/v1") throw new SourceError("integrity", `Directory page ${page.ref!.sha} is not a leaf node`);
      page.entries = dict(leaf.entries);
    }
    return page;
  }

  async #get(dir: DirState, name: string): Promise<TreeChild | undefined> {
    return (await this.#pageFor(dir, name)).entries![name];
  }

  async #set(dirPath: string, dir: DirState, name: string, child: TreeChild): Promise<void> {
    const page = await this.#pageFor(dir, name);
    if (page.entries![name] === undefined) {
      if (dir.n >= MAX_DIR_ENTRIES) throw new SourceError("too_large", `sources/${dirPath} already has ${MAX_DIR_ENTRIES} entries`);
      dir.n += 1;
    }
    page.entries![name] = child;
    page.dirty = true;
    this.#markDirty(dirPath);
  }

  /** Load a directory; `create` makes missing directories and fails on a file ancestor. */
  async #load(path: string, create: boolean): Promise<DirState | null> {
    const have = this.#dirs.get(path);
    if (have) return have;
    let state: DirState;
    if (path === "") {
      state = await this.#fromNode(this.root);
    } else {
      const parent = await this.#load(parentOf(path), create);
      if (!parent) return null;
      const child = await this.#get(parent, baseName(path));
      if (!child) {
        if (!create) return null;
        state = { pages: [{ first: "", ref: null, entries: dict(), dirty: false }], n: 0 };
      } else if (child.t === "d") {
        state = await this.#fromNode(child.tree);
      } else {
        if (!create) return null;
        throw new SourceError("path_conflict", `sources/${path} is a file, so it cannot be a directory`);
      }
    }
    this.#dirs.set(path, state);
    return state;
  }

  #markDirty(dir: string): void {
    let d: string | null = dir;
    while (d !== null && !this.#dirty.has(d)) {
      this.#dirty.add(d);
      d = d === "" ? null : parentOf(d);
    }
  }

  async apply(change: Prepared): Promise<{ outcome: ChangeOutcome; versionId: string | null; version?: SourceVersion }> {
    const dirPath = parentOf(change.stored);
    const name = baseName(change.stored);
    if (change.op === "delete") {
      const dir = await this.#load(dirPath, false);
      const existing = dir ? await this.#get(dir, name) : undefined;
      if (!existing) return this.#tombstoneUnseen(change, dirPath, name);
      if (existing.t === "d") throw new SourceError("path_conflict", `${change.wire} is a directory; delete its files individually`);
      if (existing.t === "x") return { outcome: "absent", versionId: existing.v };
      const deletedBeforeLastChange = existing.sourceUpdatedAt !== null && change.deletedAt < existing.sourceUpdatedAt;
      if (deletedBeforeLastChange || change.capturedAt < existing.capturedAt) return { outcome: "stale", versionId: existing.v };
      const body: SourceVersionBody = {
        schema: "procmem.source-version/v1",
        path: change.stored,
        entryId: entryIdFor(change.provider, change.stored),
        provider: change.provider,
        kind: "tombstone",
        contentType: null,
        size: 0,
        sha256: EMPTY_SHA256,
        chunks: [],
        sourceUpdatedAt: existing.sourceUpdatedAt,
        sourceVersion: existing.versionRef === null ? null : { ref: existing.versionRef, ...(existing.ordinal !== null ? { ordinal: existing.ordinal } : {}) },
        capturedAt: change.capturedAt,
        provenance: change.provenance,
        previous: existing.v,
        deleted: { at: change.deletedAt, reason: change.reason },
      };
      const version = { ...body, versionId: versionIdFor(body) };
      await this.#set(dirPath, dir!, name, {
        t: "x",
        v: version.versionId,
        kind: "tombstone",
        contentType: null,
        size: 0,
        sha256: EMPTY_SHA256,
        provenanceSha: change.provenanceSha,
        sourceUpdatedAt: existing.sourceUpdatedAt,
        versionRef: existing.versionRef,
        ordinal: existing.ordinal,
        capturedAt: change.capturedAt,
      });
      return { outcome: "deleted", versionId: version.versionId, version };
    }

    const dir = (await this.#load(dirPath, true))!;
    const existing = await this.#get(dir, name);
    if (existing?.t === "d") throw new SourceError("path_conflict", `${change.wire} is a directory, so it cannot be a file`);
    const ordinal = change.sourceVersion?.ordinal ?? null;
    const versionRef = change.sourceVersion?.ref ?? null;
    if (
      existing?.t === "f" &&
      existing.sha256 === change.sha256 &&
      existing.kind === change.kind &&
      existing.contentType === change.contentType &&
      existing.provenanceSha === change.provenanceSha &&
      existing.sourceUpdatedAt === change.sourceUpdatedAt &&
      existing.versionRef === versionRef &&
      existing.ordinal === ordinal
    ) {
      return { outcome: "unchanged", versionId: existing.v };
    }
    if (existing?.t === "f" && compareSourceState({ ordinal, sourceUpdatedAt: change.sourceUpdatedAt, capturedAt: change.capturedAt }, existing) < 0) {
      return { outcome: "stale", versionId: existing.v };
    }
    // After a deletion only observation order counts: provider restores keep their old modification time.
    if (existing?.t === "x" && change.capturedAt < existing.capturedAt) return { outcome: "stale", versionId: existing.v };
    const body: SourceVersionBody = {
      schema: "procmem.source-version/v1",
      path: change.stored,
      entryId: entryIdFor(change.provider, change.stored),
      provider: change.provider,
      kind: change.kind,
      contentType: change.contentType,
      size: change.size,
      sha256: change.sha256,
      chunks: change.chunks,
      sourceUpdatedAt: change.sourceUpdatedAt,
      sourceVersion: change.sourceVersion,
      capturedAt: change.capturedAt,
      provenance: change.provenance,
      previous: existing?.v ?? null,
    };
    const version = { ...body, versionId: versionIdFor(body) };
    await this.#set(dirPath, dir, name, {
      t: "f",
      v: version.versionId,
      kind: change.kind,
      contentType: change.contentType,
      size: change.size,
      sha256: change.sha256,
      provenanceSha: change.provenanceSha,
      sourceUpdatedAt: change.sourceUpdatedAt,
      versionRef,
      ordinal,
      capturedAt: change.capturedAt,
    });
    return { outcome: existing ? (existing.t === "x" ? "restored" : "updated") : "created", versionId: version.versionId, version };
  }

  /**
   * A delete for a path never published still records a tombstone, so a slower publisher's
   * older put for that path (an exporter that lost its lease mid-publish) is refused as stale
   * instead of resurrecting a moved or deleted file. The outcome stays `absent`.
   */
  async #tombstoneUnseen(change: PreparedDelete, dirPath: string, name: string): Promise<{ outcome: ChangeOutcome; versionId: string | null; version?: SourceVersion }> {
    let dir: DirState | null;
    try {
      dir = await this.#load(dirPath, true);
    } catch (error) {
      if (error instanceof SourceError && error.code === "path_conflict") return { outcome: "absent", versionId: null };
      throw error;
    }
    const body: SourceVersionBody = {
      schema: "procmem.source-version/v1",
      path: change.stored,
      entryId: entryIdFor(change.provider, change.stored),
      provider: change.provider,
      kind: "tombstone",
      contentType: null,
      size: 0,
      sha256: EMPTY_SHA256,
      chunks: [],
      sourceUpdatedAt: null,
      sourceVersion: null,
      capturedAt: change.capturedAt,
      provenance: change.provenance,
      previous: null,
      deleted: { at: change.deletedAt, reason: change.reason },
    };
    const version = { ...body, versionId: versionIdFor(body) };
    await this.#set(dirPath, dir!, name, {
      t: "x",
      v: version.versionId,
      kind: "tombstone",
      contentType: null,
      size: 0,
      sha256: EMPTY_SHA256,
      provenanceSha: change.provenanceSha,
      sourceUpdatedAt: null,
      versionRef: null,
      ordinal: null,
      capturedAt: change.capturedAt,
    });
    return { outcome: "absent", versionId: version.versionId, version };
  }

  /** Re-hash dirty directories deepest-first; returns the new root and every new node/page. */
  async finish(): Promise<{ root: string; nodes: Array<[string, DirNode]> }> {
    const order = [...this.#dirty].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0));
    const nodes: Array<[string, DirNode]> = [];
    let root = this.root;
    const emit = (node: DirNode): string => {
      const sha = sha256(canonicalJson(node));
      nodes.push([sha, node]);
      return sha;
    };
    for (const path of order) {
      const dir = this.#dirs.get(path)!;
      const pages: PageRef[] = [];
      for (const page of dir.pages) {
        if (!page.dirty && page.ref) {
          pages.push(page.ref);
          continue;
        }
        const names = Object.keys(page.entries!).sort();
        if (names.length === 0) continue;
        const groups: string[][] = [];
        if (names.length > MAX_PAGE_ENTRIES) for (let i = 0; i < names.length; i += PAGE_TARGET) groups.push(names.slice(i, i + PAGE_TARGET));
        else groups.push(names);
        for (const group of groups) {
          const entries = dict<TreeChild>();
          let files = 0;
          let deleted = 0;
          let capturedAt: string | null = null;
          let sourceUpdatedAt: string | null = null;
          for (const name of group) {
            const e = page.entries![name]!;
            entries[name] = e;
            if (e.t === "d") {
              files += e.files;
              deleted += e.deleted;
            } else if (e.t === "f") files += 1;
            else deleted += 1;
            capturedAt = maxIso(capturedAt, e.capturedAt);
            sourceUpdatedAt = maxIso(sourceUpdatedAt, e.sourceUpdatedAt);
          }
          const leaf: LeafNode = { schema: "procmem.source-tree/v1", entries };
          pages.push({ first: group[0]!, sha: emit(leaf), n: group.length, files, deleted, capturedAt, sourceUpdatedAt });
        }
      }
      pages.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
      if (pages.length) pages[0] = { ...pages[0]!, first: "" };
      let sha: string;
      if (pages.length === 0) sha = EMPTY_TREE_SHA;
      else if (pages.length === 1) {
        // A single page is stored as a plain leaf directory (the page itself).
        sha = pages[0]!.sha;
      } else {
        sha = emit({ schema: "procmem.source-tree-pages/v1", pages });
      }
      const agg = pages.reduce(
        (a, p) => ({
          n: a.n + p.n,
          files: a.files + p.files,
          deleted: a.deleted + p.deleted,
          capturedAt: maxIso(a.capturedAt, p.capturedAt),
          sourceUpdatedAt: maxIso(a.sourceUpdatedAt, p.sourceUpdatedAt),
        }),
        { n: 0, files: 0, deleted: 0, capturedAt: null as string | null, sourceUpdatedAt: null as string | null },
      );
      if (path === "") root = sha;
      else {
        const parentPath = parentOf(path);
        const parent = this.#dirs.get(parentPath)!;
        const page = await this.#pageFor(parent, baseName(path));
        page.entries![baseName(path)] = { t: "d", tree: sha, ...agg };
        page.dirty = true;
      }
    }
    return { root, nodes };
  }
}

function depth(dir: string): number {
  return dir === "" ? 0 : dir.split("/").length;
}

export { providerOf, storedToWire };
