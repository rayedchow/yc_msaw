import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, readIfExists, sha256, withFileLock, writeImmutable } from "../util.js";

/**
 * Durable object store shared by the trace store, the memory repository and
 * build receipts. Semantics every implementation must provide:
 *  - put: immutable create-once objects. Re-putting identical bytes is a no-op;
 *    different bytes for an existing key (or for a duplicate key in one batch)
 *    is an error. Keys under "blobs/" must equal the sha256 of their bytes.
 *  - list: sorted keys under a prefix, so a cold cache can rediscover objects
 *    (sessions, trace chunks, receipts) without a local index.
 *  - refs: small mutable JSON records updated only by compare-and-swap on a
 *    monotonically increasing version. This is the only mutable state.
 * The local DirectoryObjectStore is the reference implementation and the
 * offline backend; ModalObjectStore (Modal Volume + Dict lock) is the hosted one.
 */
export interface ObjectStore {
  readonly kind: string;
  put(ns: string, objects: StoredObject[]): Promise<void>;
  get(ns: string, keys: string[]): Promise<Map<string, Buffer>>;
  list(ns: string, prefix: string, opts?: { after?: string; limit?: number }): Promise<string[]>;
  getRef(ns: string, name: string): Promise<RefRecord | null>;
  /** expectedVersion null means "ref must not exist yet". */
  casRef(ns: string, name: string, expectedVersion: number | null, value: unknown): Promise<{ ok: boolean; current: RefRecord | null }>;
}

export interface StoredObject {
  key: string;
  bytes: Buffer;
}

export interface RefRecord {
  version: number;
  value: unknown;
  updatedAt: string;
}

export const NS_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}(?:\/[a-z0-9][a-z0-9._-]{0,127}){0,7}$/;
export const REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,3}$/;
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_LIST = 10_000;

export function assertNs(ns: string): void {
  if (!NS_RE.test(ns)) throw new Error(`Invalid namespace ${JSON.stringify(ns)}`);
}

export function assertObjectKey(key: string): void {
  if (key.length > 400 || !KEY_RE.test(key) || key.split("/").some((s) => s === "." || s === ".." || s.endsWith(".tmp"))) {
    throw new Error(`Invalid object key ${JSON.stringify(key)}`);
  }
}

export function assertRefName(name: string): void {
  if (!REF_RE.test(name) || name.split("/").some((s) => s === "." || s === "..")) throw new Error(`Invalid ref name ${JSON.stringify(name)}`);
}

/** Validate a put batch: keys, sizes, blob digests, and no conflicting duplicates. Returns the deduplicated batch. */
export function checkPutBatch(objects: StoredObject[]): StoredObject[] {
  const byKey = new Map<string, StoredObject>();
  for (const o of objects) {
    assertObjectKey(o.key);
    if (o.bytes.length > MAX_OBJECT_BYTES) throw new Error(`Object ${o.key} exceeds ${MAX_OBJECT_BYTES} bytes`);
    if (o.key.startsWith("blobs/") && sha256(o.bytes) !== o.key.slice("blobs/".length)) throw new Error(`Blob digest mismatch for ${o.key}`);
    const prior = byKey.get(o.key);
    if (prior && !prior.bytes.equals(o.bytes)) throw new Error(`Conflicting duplicate key ${o.key} in one batch`);
    byKey.set(o.key, o);
  }
  return [...byKey.values()];
}

export class DirectoryObjectStore implements ObjectStore {
  readonly kind = "directory";
  constructor(readonly root: string) {}

  #objPath(ns: string, key: string) {
    return path.join(this.root, ns, "objects", ...key.split("/"));
  }
  #refPath(ns: string, name: string) {
    return path.join(this.root, ns, "refs", ...name.split("/")) + ".json";
  }

  async put(ns: string, objects: StoredObject[]): Promise<void> {
    assertNs(ns);
    for (const o of checkPutBatch(objects)) await writeImmutable(this.#objPath(ns, o.key), o.bytes);
  }

  async get(ns: string, keys: string[]): Promise<Map<string, Buffer>> {
    assertNs(ns);
    const out = new Map<string, Buffer>();
    for (const key of keys) {
      assertObjectKey(key);
      const bytes = await readIfExists(this.#objPath(ns, key));
      if (bytes) out.set(key, bytes);
    }
    return out;
  }

  async list(ns: string, prefix: string, opts: { after?: string; limit?: number } = {}): Promise<string[]> {
    assertNs(ns);
    if (typeof prefix !== "string" || prefix.startsWith("/") || path.isAbsolute(prefix) || prefix.includes("\\") || prefix.includes("\0") || prefix.split("/").includes("..")) {
      throw new Error(`Invalid list prefix ${JSON.stringify(prefix)}`);
    }
    const limit = Math.min(opts.limit ?? MAX_LIST, MAX_LIST);
    const base = path.join(this.root, ns, "objects");
    const prefixDir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), key);
        else if (e.isFile() && !e.name.includes(".tmp-") && key.startsWith(prefix)) out.push(key);
      }
    };
    await walk(prefixDir ? path.join(base, ...prefixDir.split("/")) : base, prefixDir);
    return out
      .sort()
      .filter((k) => opts.after === undefined || k > opts.after)
      .slice(0, limit);
  }

  async getRef(ns: string, name: string): Promise<RefRecord | null> {
    assertNs(ns);
    assertRefName(name);
    const bytes = await readIfExists(this.#refPath(ns, name));
    return bytes ? (JSON.parse(bytes.toString("utf8")) as RefRecord) : null;
  }

  async casRef(ns: string, name: string, expectedVersion: number | null, value: unknown) {
    assertNs(ns);
    assertRefName(name);
    const file = this.#refPath(ns, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // The lock covers only this local read-compare-write (no network), so a short stale window is safe.
    return withFileLock(`${file}.lock`, async () => {
      const current = await this.getRef(ns, name);
      if ((current?.version ?? null) !== expectedVersion) return { ok: false, current };
      const next: RefRecord = { version: (current?.version ?? 0) + 1, value, updatedAt: new Date().toISOString() };
      await atomicWrite(file, JSON.stringify(next));
      return { ok: true, current: next };
    }, { staleMs: 10_000 });
  }
}

/** Read-through cache: serves immutable objects locally, always asks the authority for refs and listings. */
export class CachedObjectStore implements ObjectStore {
  readonly kind: string;
  constructor(private readonly authority: ObjectStore, private readonly cache: DirectoryObjectStore) {
    this.kind = `${authority.kind}+cache`;
  }
  async put(ns: string, objects: StoredObject[]) {
    const batch = checkPutBatch(objects);
    await this.authority.put(ns, batch);
    await this.cache.put(ns, batch);
  }
  async get(ns: string, keys: string[]) {
    const local = await this.cache.get(ns, keys);
    const missing = keys.filter((k) => !local.has(k));
    if (missing.length) {
      const remote = await this.authority.get(ns, missing);
      const verified = [...remote.entries()].map(([key, bytes]) => ({ key, bytes }));
      await this.cache.put(ns, verified);
      for (const { key, bytes } of verified) local.set(key, bytes);
    }
    return local;
  }
  list(ns: string, prefix: string, opts?: { after?: string; limit?: number }) {
    return this.authority.list(ns, prefix, opts);
  }
  getRef(ns: string, name: string) {
    return this.authority.getRef(ns, name);
  }
  casRef(ns: string, name: string, expectedVersion: number | null, value: unknown) {
    return this.authority.casRef(ns, name, expectedVersion, value);
  }
}
