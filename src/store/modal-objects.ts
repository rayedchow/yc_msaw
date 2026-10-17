import { randomBytes } from "node:crypto";
import { ModalClient, type Function_ } from "modal";
import { sha256 } from "../util.js";
import { assertNs, assertObjectKey, assertRefName, checkPutBatch, MAX_LIST, MAX_OBJECT_BYTES, type ObjectStore, type RefRecord, type StoredObject } from "./objects.js";

export interface ModalObjectStoreOptions {
  appName?: string;
  functionName?: string;
  /** Reuse an existing client; otherwise one is created lazily (and closed by close()). */
  client?: ModalClient;
  /** Per remote call; a hung call rejects after this long. */
  timeoutMs?: number;
}

/** Target base64 size per put call; the worker rejects calls above 16 MiB of base64. */
const TARGET_BATCH_B64 = 8 * 1024 * 1024;
/** Objects above this many raw bytes use multipart upload and ranged reads (matches the worker's INLINE_MAX_BYTES). */
const INLINE_MAX_BYTES = 6 * 1024 * 1024;
const PART_BYTES = 6 * 1024 * 1024;
const RANGE_BYTES = 6 * 1024 * 1024;
const PART_CONCURRENCY = 3;
/** Worker caps keys per call at 2000. */
const MAX_KEYS_PER_CALL = 1000;
const PREFIX_RE = /^[a-z0-9._/-]{0,1200}$/;

/** Thrown when the remote ref lock is held by another writer; callers should retry later. */
export class RefLockedError extends Error {
  readonly code = "ref_locked";
  readonly retryable = true;
}

/**
 * ObjectStore backed by a Modal Volume through the deployed `procmem-store`
 * function (modal_worker/store_app.py), which implements DirectoryObjectStore
 * semantics server-side and serializes casRef across containers with a Modal
 * Dict create-only lock. Calls are `fn.remote([op, payload])`; bytes travel as
 * base64. Everything is validated here before any network call, and blob
 * digests are re-verified on read so a corrupted volume cannot feed bad bytes
 * into a cache.
 */
export class ModalObjectStore implements ObjectStore {
  readonly kind = "modal-volume";
  readonly appName: string;
  readonly functionName: string;
  readonly #timeoutMs: number;
  readonly #ownsClient: boolean;
  #client: ModalClient | undefined;
  #fn: Promise<Function_> | undefined;

  constructor(opts: ModalObjectStoreOptions = {}) {
    this.appName = opts.appName ?? "procmem-store";
    this.functionName = opts.functionName ?? "store_op";
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
    this.#client = opts.client;
    this.#ownsClient = !opts.client;
  }

  /** Close the lazily created client (no-op for an injected client). */
  close(): void {
    if (this.#ownsClient && this.#client) this.#client.close();
    this.#client = undefined;
    this.#fn = undefined;
  }

  #resolve(): Promise<Function_> {
    if (!this.#fn) {
      this.#client ??= new ModalClient();
      const fn = this.#client.functions.fromName(this.appName, this.functionName);
      this.#fn = fn;
      // Do not cache a failed lookup; the next call retries.
      fn.catch(() => {
        if (this.#fn === fn) this.#fn = undefined;
      });
    }
    return this.#fn;
  }

  async #call(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const label = `Modal ${this.appName}.${this.functionName}(${op})`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${this.#timeoutMs}ms`)), this.#timeoutMs);
    });
    let result: unknown;
    try {
      result = await Promise.race([this.#resolve().then((fn) => fn.remote([op, payload])), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`${label}: malformed response`);
    const r = result as Record<string, unknown>;
    if (r.error === "ref_locked") {
      const detail = typeof r.detail === "string" ? ` ${r.detail}` : "";
      throw new RefLockedError(`Ref is locked by another writer (ref_locked); retry later.${detail}`);
    }
    if (typeof r.error === "string") throw new Error(`${label}: ${r.error}`);
    return r;
  }

  async put(ns: string, objects: StoredObject[]): Promise<void> {
    assertNs(ns);
    const batches: { key: string; b64: string }[][] = [];
    const multipart: StoredObject[] = [];
    let batch: { key: string; b64: string }[] = [];
    let size = 0;
    for (const o of checkPutBatch(objects)) {
      if (o.bytes.length > INLINE_MAX_BYTES) {
        multipart.push(o);
        continue;
      }
      const b64 = Buffer.from(o.bytes).toString("base64");
      if (batch.length > 0 && (size + b64.length > TARGET_BATCH_B64 || batch.length >= MAX_KEYS_PER_CALL)) {
        batches.push(batch);
        batch = [];
        size = 0;
      }
      batch.push({ key: o.key, b64 });
      size += b64.length;
    }
    if (batch.length > 0) batches.push(batch);
    // Sequential: each call is committed before the next starts, so a failure leaves a prefix (objects are immutable, retry is idempotent).
    for (const b of batches) await this.#call("put", { ns, objects: b });
    for (const o of multipart) await this.#putMultipart(ns, o);
  }

  /**
   * Upload one large object as parts staged outside objects/ under a random
   * upload id; upload_commit assembles, verifies size + sha256, and creates the
   * object once. Staged parts are removed on commit (success or failure) and
   * aborted best-effort if a part upload fails.
   */
  async #putMultipart(ns: string, o: StoredObject): Promise<void> {
    const uploadId = randomBytes(16).toString("hex");
    const parts = Math.max(1, Math.ceil(o.bytes.length / PART_BYTES));
    try {
      for (let start = 0; start < parts; start += PART_CONCURRENCY) {
        const indices = Array.from({ length: Math.min(PART_CONCURRENCY, parts - start) }, (_, j) => start + j);
        await Promise.all(
          indices.map((index) =>
            this.#call("upload_part", { ns, upload_id: uploadId, index, b64: o.bytes.subarray(index * PART_BYTES, (index + 1) * PART_BYTES).toString("base64") }),
          ),
        );
      }
    } catch (error) {
      await this.#call("upload_abort", { ns, upload_id: uploadId }).catch(() => undefined);
      throw error;
    }
    await this.#call("upload_commit", { ns, upload_id: uploadId, key: o.key, parts, size: o.bytes.length, sha256: sha256(o.bytes) });
  }

  async get(ns: string, keys: string[]): Promise<Map<string, Buffer>> {
    assertNs(ns);
    const wanted = [...new Set(keys)];
    for (const key of wanted) assertObjectKey(key);
    const out = new Map<string, Buffer>();
    for (let i = 0; i < wanted.length; i += MAX_KEYS_PER_CALL) {
      let pending = wanted.slice(i, i + MAX_KEYS_PER_CALL);
      // The worker pages large responses and returns the keys it did not fit.
      while (pending.length > 0) {
        const r = await this.#call("get", { ns, keys: pending });
        const objects = (r.objects ?? {}) as Record<string, unknown>;
        const large = (r.large ?? {}) as Record<string, unknown>;
        if (typeof objects !== "object" || Array.isArray(objects) || typeof large !== "object" || Array.isArray(large)) throw new Error("Modal get: malformed response");
        const asked = new Set(pending);
        for (const [key, b64] of Object.entries(objects)) {
          if (!asked.has(key) || typeof b64 !== "string") throw new Error(`Modal get: unexpected entry ${JSON.stringify(key)}`);
          const bytes = Buffer.from(b64, "base64");
          if (key.startsWith("blobs/") && sha256(bytes) !== key.slice("blobs/".length)) {
            throw new Error(`Blob digest mismatch for ${key} (volume corruption?)`);
          }
          out.set(key, bytes);
        }
        for (const [key, info] of Object.entries(large)) {
          const meta = info as { size?: unknown; sha256?: unknown } | null;
          if (!asked.has(key) || !meta || typeof meta.size !== "number" || typeof meta.sha256 !== "string") throw new Error(`Modal get: unexpected large entry ${JSON.stringify(key)}`);
          const bytes = await this.#getRanged(ns, key, meta.size);
          if (bytes === null) continue;
          const digest = sha256(bytes);
          if (digest !== meta.sha256 || (key.startsWith("blobs/") && digest !== key.slice("blobs/".length))) {
            throw new Error(`Digest mismatch for ranged read of ${key} (volume corruption?)`);
          }
          out.set(key, bytes);
        }
        const remaining = Array.isArray(r.remaining) ? (r.remaining as unknown[]).filter((k): k is string => typeof k === "string" && asked.has(k)) : [];
        if (remaining.length >= pending.length) throw new Error("Modal get made no progress");
        pending = remaining;
      }
    }
    return out;
  }

  /** Read a large object in bounded ranges; returns null if it is absent. */
  async #getRanged(ns: string, key: string, size: number): Promise<Buffer | null> {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES) throw new Error(`Modal get: invalid size for ${key}`);
    const offsets: number[] = [];
    for (let off = 0; off < size; off += RANGE_BYTES) offsets.push(off);
    const chunks: Buffer[] = new Array(offsets.length);
    for (let start = 0; start < offsets.length; start += PART_CONCURRENCY) {
      const batch = offsets.slice(start, start + PART_CONCURRENCY);
      const results = await Promise.all(batch.map((offset) => this.#call("get_range", { ns, key, offset, length: Math.min(RANGE_BYTES, size - offset) })));
      for (const [j, r] of results.entries()) {
        if (r.found === false) return null;
        if (typeof r.b64 !== "string" || r.size !== size || r.offset !== batch[j]) throw new Error(`Modal get_range: malformed response for ${key}`);
        chunks[start + j] = Buffer.from(r.b64, "base64");
      }
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== size) throw new Error(`Modal get_range: ${key} assembled ${bytes.length} bytes, expected ${size}`);
    return bytes;
  }

  async list(ns: string, prefix: string, opts: { after?: string; limit?: number } = {}): Promise<string[]> {
    assertNs(ns);
    assertPrefix(prefix);
    const limit = Math.min(opts.limit ?? MAX_LIST, MAX_LIST);
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid list limit ${opts.limit}`);
    if (opts.after !== undefined && typeof opts.after !== "string") throw new Error("after must be a string");
    const payload: Record<string, unknown> = { ns, prefix, limit };
    if (opts.after !== undefined) payload.after = opts.after;
    const r = await this.#call("list", payload);
    if (!Array.isArray(r.keys) || !r.keys.every((k) => typeof k === "string")) throw new Error("Modal list: malformed response");
    return r.keys as string[];
  }

  async getRef(ns: string, name: string): Promise<RefRecord | null> {
    assertNs(ns);
    assertRefName(name);
    const r = await this.#call("get_ref", { ns, name });
    return parseRef(r.ref);
  }

  async casRef(ns: string, name: string, expectedVersion: number | null, value: unknown): Promise<{ ok: boolean; current: RefRecord | null }> {
    assertNs(ns);
    assertRefName(name);
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new Error(`Invalid expectedVersion ${expectedVersion}`);
    }
    if (value === undefined) throw new Error("casRef value must be JSON");
    // Round-trip through JSON so the remote stores exactly what a JSON reader would see.
    const r = await this.#call("cas_ref", { ns, name, expected_version: expectedVersion, value: JSON.parse(JSON.stringify(value)) as unknown });
    if (typeof r.ok !== "boolean") throw new Error("Modal cas_ref: malformed response");
    return { ok: r.ok, current: parseRef(r.current) };
  }
}

function assertPrefix(prefix: string): void {
  const dirs = prefix.split("/").slice(0, -1);
  if (typeof prefix !== "string" || !PREFIX_RE.test(prefix) || prefix.startsWith("/") || prefix.includes("//") || dirs.some((s) => s === "." || s === "..")) {
    throw new Error(`Invalid list prefix ${JSON.stringify(prefix)}`);
  }
}

function parseRef(value: unknown): RefRecord | null {
  if (value === null || value === undefined) return null;
  const r = value as Record<string, unknown>;
  if (typeof r !== "object" || typeof r.version !== "number" || !Number.isInteger(r.version) || typeof r.updatedAt !== "string" || !("value" in r)) {
    throw new Error("Modal returned a malformed ref record");
  }
  return { version: r.version, value: r.value, updatedAt: r.updatedAt };
}
