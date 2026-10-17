import { gunzipSync, gzipSync } from "node:zlib";
import { assertNs, type ObjectStore } from "../store/objects.js";
import { canonicalJson, errorMessage, sha256 } from "../util.js";
import {
  assertDay,
  BLOB_PART_BYTES,
  blobManifestKey,
  chunkIndexKey,
  chunkObjectKey,
  describeZodError,
  isBlobRef,
  MAX_BLOB_BYTES,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_EVENTS,
  parseChunkKey,
  SHA256_RE,
  STORE_CALL_BYTES,
  STORE_GET_KEYS,
  TRACE_BLOB_GZIP_CONTENT_TYPE,
  TRACE_CHUNK_GZIP_CONTENT_TYPE,
  TraceChunkSchema,
  type TraceChunk,
  type TraceEvent,
} from "./schema.js";

/**
 * Tenant-isolated trace ingest.
 *
 * Storage layout (all inside the tenant namespace `ns`, which always comes from
 * the authenticated host context, never from the payload):
 *   blobs/<sha256>                                   content-addressed large payloads (<= 8 MiB each)
 *   blob-manifests/<sha256>.json                     part list for blobs > 8 MiB (parts are blobs/<partSha>)
 *   traces/<YYYY-MM-DD>/<sessionId>/chunk-<seq:06>.jsonl.gz
 *                                                    gzip JSONL, one canonical-JSON event per line
 *   trace-index/<sessionId>/chunk-<seq:06>.json      create-once claim {day, key, sha256, ...}
 *
 * Day partition = server RECEIPT day of the first successful claim, computed as
 * UTC shifted by `dayOffsetMinutes` (default 0 = UTC).
 *
 * Idempotency (works with only put/get/list/CAS): a chunk is identified by
 * (sessionId, chunkSeq). The first ingest writes the create-once index object
 * BEFORE the chunk object. A resend looks up the index: same content digest
 * (sha256 of the canonical JSONL) -> "duplicate" (pointing at the original
 * day/key, even if the resend arrives on a later day); different digest -> 409.
 * If a crash happened between the index write and the chunk write, the resend
 * repairs the chunk at the originally claimed key (gzip of identical JSONL), so
 * a claimed chunk is never lost and never stored under two days. A repaired
 * chunk that shows up "late" in an already-pinned day is picked up by that
 * day's catch-up manifest (see daily.ts).
 */

export class TraceIngestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "TraceIngestError";
  }
}

export interface ChunkIndexRecord {
  sessionId: string;
  chunkSeq: number;
  day: string;
  key: string;
  sha256: string;
  events: number;
  firstSeq: number;
  lastSeq: number;
  final: boolean;
  receivedAt: string;
  /** Size of the stored gzip chunk object (used to size batched reads). */
  objectBytes?: number;
}

export interface BlobManifest {
  sha256: string;
  bytes: number;
  mediaType?: string;
  parts: { sha256: string; bytes: number }[];
}

export interface IngestResult {
  status: "created" | "duplicate";
  sessionId: string;
  chunkSeq: number;
  day: string;
  key: string;
  sha256: string;
  events: number;
}

export interface TraceIngestorOptions {
  now?: () => Date;
  /** Minutes added to UTC before taking the calendar day (e.g. -420 for UTC-7). Default 0 = UTC. */
  dayOffsetMinutes?: number;
}

export function dayFor(date: Date, offsetMinutes = 0): string {
  return new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** List every key under a prefix, page by page (never one unbounded call). */
export async function listAll(store: ObjectStore, ns: string, prefix: string, pageSize = 1000): Promise<string[]> {
  const out: string[] = [];
  for await (const page of listPages(store, ns, prefix, pageSize)) out.push(...page);
  return out;
}

export async function* listPages(store: ObjectStore, ns: string, prefix: string, pageSize = 1000): AsyncGenerator<string[]> {
  let after: string | undefined;
  for (;;) {
    const page = await store.list(ns, prefix, after === undefined ? { limit: pageSize } : { after, limit: pageSize });
    if (page.length) yield page;
    if (page.length < pageSize) return;
    after = page[page.length - 1];
  }
}

/**
 * Batched get: at most `maxKeys` keys and (by the caller's size estimate) at most
 * `maxBytes` per store call. Missing keys are simply absent from the result.
 */
export async function getBatched(
  store: ObjectStore,
  ns: string,
  keys: string[],
  opts: { maxKeys?: number; maxBytes?: number; sizeOf?: (key: string) => number } = {},
): Promise<Map<string, Buffer>> {
  const maxKeys = opts.maxKeys ?? STORE_GET_KEYS;
  const maxBytes = opts.maxBytes ?? STORE_CALL_BYTES;
  const out = new Map<string, Buffer>();
  let batch: string[] = [];
  let bytes = 0;
  const run = async () => {
    if (!batch.length) return;
    for (const [k, v] of await store.get(ns, batch)) out.set(k, v);
    batch = [];
    bytes = 0;
  };
  for (const key of keys) {
    const size = opts.sizeOf?.(key) ?? 0;
    if (batch.length && (batch.length >= maxKeys || bytes + size > maxBytes)) await run();
    batch.push(key);
    bytes += size;
  }
  await run();
  return out;
}

/** True if a blob is stored either whole or as parts. */
export async function blobExists(store: ObjectStore, ns: string, sha: string): Promise<boolean> {
  return (await exists(store, ns, `blobs/${sha}`)) || (await exists(store, ns, blobManifestKey(sha)));
}

/** Read a blob in full (reassembling parts one store call at a time) and verify its digest. */
export async function readBlob(store: ObjectStore, ns: string, sha: string): Promise<Buffer | null> {
  const manifestBytes = (await store.get(ns, [blobManifestKey(sha)])).get(blobManifestKey(sha));
  let bytes: Buffer | undefined;
  if (manifestBytes) {
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as BlobManifest;
    const parts: Buffer[] = [];
    for (const part of manifest.parts) {
      const b = (await store.get(ns, [`blobs/${part.sha256}`])).get(`blobs/${part.sha256}`);
      if (!b) throw new Error(`Blob ${sha} is missing part ${part.sha256}`);
      parts.push(b);
    }
    bytes = Buffer.concat(parts);
  } else {
    bytes = (await store.get(ns, [`blobs/${sha}`])).get(`blobs/${sha}`);
  }
  if (!bytes) return null;
  if (sha256(bytes) !== sha) throw new Error(`Blob ${sha} failed digest verification`);
  return bytes;
}

async function exists(store: ObjectStore, ns: string, key: string): Promise<boolean> {
  const found = await store.list(ns, key, { limit: 1 });
  return found[0] === key;
}

export function encodeEventsJsonl(events: TraceEvent[]): string {
  return events.map((e) => canonicalJson(e)).join("\n") + "\n";
}

export function decodeChunkObject(bytes: Buffer): TraceEvent[] {
  const text = gunzipSync(bytes).toString("utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TraceEvent);
}

export class TraceIngestor {
  readonly #now: () => Date;
  readonly #offset: number;

  constructor(readonly store: ObjectStore, opts: TraceIngestorOptions = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#offset = opts.dayOffsetMinutes ?? 0;
    if (!Number.isInteger(this.#offset) || Math.abs(this.#offset) > 14 * 60) throw new Error("dayOffsetMinutes must be an integer within ±840");
  }

  /** The receipt day new chunks are partitioned under right now. */
  currentDay(): string {
    return dayFor(this.#now(), this.#offset);
  }

  async putBlob(ns: string, sha: string, bytes: Uint8Array): Promise<{ status: "created" | "exists"; sha256: string; bytes: number }> {
    this.#ns(ns);
    if (!SHA256_RE.test(sha)) throw new TraceIngestError(400, "invalid_blob_id", "Blob id must be a lowercase sha256 hex digest");
    if (bytes.length > MAX_BLOB_BYTES) throw new TraceIngestError(413, "blob_too_large", `Blob is ${bytes.length} bytes; the limit is ${MAX_BLOB_BYTES} bytes (no truncation is performed)`);
    const actual = sha256(bytes);
    if (actual !== sha) throw new TraceIngestError(400, "blob_digest_mismatch", `Blob bytes hash to ${actual}, not ${sha}`);
    if (await blobExists(this.store, ns, sha)) return { status: "exists", sha256: sha, bytes: bytes.length };
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length <= BLOB_PART_BYTES) {
      await this.store.put(ns, [{ key: `blobs/${sha}`, bytes: buf }]);
      return { status: "created", sha256: sha, bytes: buf.length };
    }
    // Large blob: content-addressed parts (one store call each), then the part list as the commit marker.
    const parts: BlobManifest["parts"] = [];
    for (let off = 0; off < buf.length; off += BLOB_PART_BYTES) {
      const part = buf.subarray(off, Math.min(off + BLOB_PART_BYTES, buf.length));
      const partSha = sha256(part);
      if (!(await exists(this.store, ns, `blobs/${partSha}`))) await this.store.put(ns, [{ key: `blobs/${partSha}`, bytes: Buffer.from(part) }]);
      parts.push({ sha256: partSha, bytes: part.length });
    }
    const manifest: BlobManifest = { sha256: sha, bytes: buf.length, parts };
    await this.store.put(ns, [{ key: blobManifestKey(sha), bytes: Buffer.from(canonicalJson(manifest), "utf8") }]);
    return { status: "created", sha256: sha, bytes: buf.length };
  }

  async ingestChunk(ns: string, input: unknown): Promise<IngestResult> {
    this.#ns(ns);
    const encoded = JSON.stringify(input) ?? "";
    const size = Buffer.byteLength(encoded);
    if (size > MAX_CHUNK_BYTES) {
      throw new TraceIngestError(413, "chunk_too_large", `Chunk is ${size} bytes decoded; the limit is ${MAX_CHUNK_BYTES} bytes. Split it into more chunks or move large payloads to blobs (no truncation is performed)`);
    }
    const rawEvents = (input as { events?: unknown } | null)?.events;
    if (Array.isArray(rawEvents) && rawEvents.length > MAX_CHUNK_EVENTS) {
      throw new TraceIngestError(413, "chunk_too_many_events", `Chunk has ${rawEvents.length} events; the limit is ${MAX_CHUNK_EVENTS}`);
    }
    const parsed = TraceChunkSchema.safeParse(input);
    if (!parsed.success) throw new TraceIngestError(400, "invalid_chunk", `Invalid trace chunk: ${describeZodError(parsed.error)}`);
    const chunk: TraceChunk = parsed.data;
    const jsonl = encodeEventsJsonl(chunk.events);
    const digest = sha256(jsonl);
    const gz = gzipSync(Buffer.from(jsonl, "utf8"));
    const idxKey = chunkIndexKey(chunk.sessionId, chunk.chunkSeq);

    const prior = await this.#readIndex(ns, idxKey);
    if (prior) return this.#resolveExisting(ns, prior, digest, gz);

    await this.#checkBlobs(ns, chunk.events);
    await this.#checkNeighbours(ns, chunk);

    const day = this.currentDay();
    const key = chunkObjectKey(day, chunk.sessionId, chunk.chunkSeq);
    const record: ChunkIndexRecord = {
      sessionId: chunk.sessionId,
      chunkSeq: chunk.chunkSeq,
      day,
      key,
      sha256: digest,
      events: chunk.events.length,
      firstSeq: chunk.events[0]!.seq,
      lastSeq: chunk.events[chunk.events.length - 1]!.seq,
      final: chunk.final ?? false,
      receivedAt: this.#now().toISOString(),
      objectBytes: gz.length,
    };
    try {
      await this.store.put(ns, [{ key: idxKey, bytes: Buffer.from(canonicalJson(record), "utf8") }]);
    } catch (error) {
      // Lost a race with a concurrent identical/conflicting claim: resolve against the winner.
      const winner = await this.#readIndex(ns, idxKey);
      if (winner) return this.#resolveExisting(ns, winner, digest, gz);
      throw error;
    }
    await this.store.put(ns, [{ key, bytes: gz }]);
    return { status: "created", sessionId: chunk.sessionId, chunkSeq: chunk.chunkSeq, day, key, sha256: digest, events: chunk.events.length };
  }

  /** Chunk object keys received on `day` (sorted). */
  async listDay(ns: string, day: string): Promise<string[]> {
    this.#ns(ns);
    assertDay(day);
    return (await listAll(this.store, ns, `traces/${day}/`)).filter((k) => parseChunkKey(k) !== null);
  }

  async readChunk(ns: string, key: string): Promise<{ events: TraceEvent[]; sha256: string; objectSha256: string }> {
    this.#ns(ns);
    const bytes = (await this.store.get(ns, [key])).get(key);
    if (!bytes) throw new TraceIngestError(404, "chunk_not_found", `Chunk ${key} not found`);
    const events = decodeChunkObject(bytes);
    return { events, sha256: sha256(encodeEventsJsonl(events)), objectSha256: sha256(bytes) };
  }

  async getChunkIndex(ns: string, sessionId: string, chunkSeq: number): Promise<ChunkIndexRecord | null> {
    this.#ns(ns);
    return this.#readIndex(ns, chunkIndexKey(sessionId, chunkSeq));
  }

  #ns(ns: string) {
    try {
      assertNs(ns);
    } catch (error) {
      throw new TraceIngestError(500, "invalid_namespace", errorMessage(error));
    }
  }

  async #readIndex(ns: string, key: string): Promise<ChunkIndexRecord | null> {
    const bytes = (await this.store.get(ns, [key])).get(key);
    return bytes ? (JSON.parse(bytes.toString("utf8")) as ChunkIndexRecord) : null;
  }

  async #resolveExisting(ns: string, prior: ChunkIndexRecord, digest: string, gz: Buffer): Promise<IngestResult> {
    if (prior.sha256 !== digest) {
      throw new TraceIngestError(409, "chunk_conflict", `Chunk ${prior.chunkSeq} of session ${prior.sessionId} was already received (day ${prior.day}) with different content; chunkSeq values must not be reused for different events`);
    }
    if (!(await exists(this.store, ns, prior.key))) await this.store.put(ns, [{ key: prior.key, bytes: gz }]);
    return { status: "duplicate", sessionId: prior.sessionId, chunkSeq: prior.chunkSeq, day: prior.day, key: prior.key, sha256: prior.sha256, events: prior.events };
  }

  async #checkBlobs(ns: string, events: TraceEvent[]) {
    const missing: string[] = [];
    for (const e of events) {
      if (!isBlobRef(e.data)) continue;
      if (!(await blobExists(this.store, ns, e.data.$blob))) missing.push(`seq ${e.seq} -> ${e.data.$blob}`);
    }
    if (missing.length) {
      throw new TraceIngestError(422, "blob_missing", `Chunk references blobs that were not uploaded (PUT /v1/traces/blobs/:sha first): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ""}`);
    }
  }

  /** Event seqs must keep increasing across adjacent chunks of the same session. */
  async #checkNeighbours(ns: string, chunk: TraceChunk) {
    const first = chunk.events[0]!.seq;
    const last = chunk.events[chunk.events.length - 1]!.seq;
    if (chunk.chunkSeq > 1) {
      const prev = await this.#readIndex(ns, chunkIndexKey(chunk.sessionId, chunk.chunkSeq - 1));
      if (prev && prev.lastSeq >= first) {
        throw new TraceIngestError(409, "seq_conflict", `Chunk ${chunk.chunkSeq} starts at event seq ${first} but chunk ${chunk.chunkSeq - 1} already ended at seq ${prev.lastSeq}`);
      }
      if (prev?.final) throw new TraceIngestError(409, "session_finished", `Session ${chunk.sessionId} was finalized by chunk ${prev.chunkSeq}`);
    }
    const next = await this.#readIndex(ns, chunkIndexKey(chunk.sessionId, chunk.chunkSeq + 1));
    if (next && next.firstSeq <= last) {
      throw new TraceIngestError(409, "seq_conflict", `Chunk ${chunk.chunkSeq} ends at event seq ${last} but chunk ${chunk.chunkSeq + 1} already starts at seq ${next.firstSeq}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Framework-agnostic HTTP handler. The caller authenticates the request and
// supplies the tenant namespace; this handler never reads a tenant from the body.
// ---------------------------------------------------------------------------

const BODY_SLACK = 64 * 1024;

/** Max wire bytes for a body whose decoded size is bounded by `decoded` (gzip worst case + base64 expansion). */
function wireLimit(decoded: number, base64: boolean): number {
  const gz = decoded + BODY_SLACK;
  return base64 ? Math.ceil(gz / 3) * 4 + 1024 : gz;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

/** Parse "type/subtype; a=b" into a lowercase type and params. */
export function parseContentType(header: string | null): { type: string; params: Record<string, string> } {
  const [type = "", ...rest] = (header ?? "").split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"|"$/g, "").toLowerCase();
  }
  return { type: type.trim().toLowerCase(), params };
}

/** Read a request body, enforcing limits on both wire and decoded size. */
export async function readBoundedBody(request: Request, maxEncoded: number, maxDecoded: number, opts: { gzipBody?: boolean; base64?: boolean } = {}): Promise<Buffer> {
  const declaredEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const encoding = opts.gzipBody ? "gzip" : declaredEncoding;
  if (declaredEncoding !== "identity" && declaredEncoding !== "gzip") throw new TraceIngestError(415, "unsupported_encoding", `Content-Encoding ${encoding} is not supported (use gzip or identity)`);
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxEncoded) {
    throw new TraceIngestError(413, "body_too_large", `Request body is ${declared} bytes; the limit is ${maxEncoded} bytes`);
  }
  const parts: Buffer[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxEncoded) {
        await reader.cancel().catch(() => undefined);
        throw new TraceIngestError(413, "body_too_large", `Request body exceeds ${maxEncoded} bytes`);
      }
      parts.push(Buffer.from(value));
    }
  }
  let raw = Buffer.concat(parts);
  if (opts.base64) {
    const text = raw.toString("latin1").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new TraceIngestError(400, "invalid_base64", "Body is declared encoding=base64 but is not valid base64");
    raw = Buffer.from(text, "base64");
  }
  if (encoding !== "gzip") {
    if (raw.length > maxDecoded) throw new TraceIngestError(413, "body_too_large", `Request body is ${raw.length} bytes; the limit is ${maxDecoded} bytes`);
    return raw;
  }
  try {
    return gunzipSync(raw, { maxOutputLength: maxDecoded });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) {
      throw new TraceIngestError(413, "body_too_large", `Decompressed body exceeds ${maxDecoded} bytes (no truncation is performed)`);
    }
    throw new TraceIngestError(400, "invalid_gzip", `Body is not valid gzip: ${errorMessage(error)}`);
  }
}

/**
 * Routes:
 *   POST /v1/traces/chunks        TraceChunk as application/json (optionally Content-Encoding: gzip)
 *                                 or gzip JSON as application/vnd.procmem.trace-chunk+gzip -> 201 created | 200 duplicate
 *   PUT  /v1/traces/blobs/:sha    raw bytes (any type, optionally Content-Encoding: gzip)
 *                                 or gzip bytes as application/vnd.procmem.trace-blob+gzip  -> 201 created | 200 exists
 * The vendor types accept a `; encoding=base64` parameter (base64 of the gzip
 * bytes). The SDK uses it by default because some Node hosts (mcp-use 2.10's
 * node bridge) decode every request body as UTF-8 text, which corrupts binary.
 * Gzip is always decompressed with a bound on the decoded size.
 * Errors are JSON {error: {code, message}} with 400/404/405/409/413/415/422/500.
 */
export async function handleTraceRequest(request: Request, ns: string, ingestor: TraceIngestor): Promise<Response> {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname.replace(/\/+$/, "");
    if (/\/v1\/traces\/chunks$/.test(pathname)) {
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST for /v1/traces/chunks");
      const ct = parseContentType(request.headers.get("content-type"));
      const gzipType = ct.type === TRACE_CHUNK_GZIP_CONTENT_TYPE;
      if (ct.type && !gzipType && ct.type !== "application/json") {
        return errorResponse(415, "unsupported_media_type", `Chunks must be application/json or ${TRACE_CHUNK_GZIP_CONTENT_TYPE}[; encoding=base64]`);
      }
      const base64 = gzipType && ct.params.encoding === "base64";
      const body = await readBoundedBody(request, wireLimit(MAX_CHUNK_BYTES, base64), MAX_CHUNK_BYTES, { gzipBody: gzipType, base64 });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (error) {
        return errorResponse(400, "invalid_json", `Body is not valid JSON: ${errorMessage(error)}`);
      }
      const result = await ingestor.ingestChunk(ns, parsed);
      return json(result.status === "created" ? 201 : 200, result);
    }
    const blob = /\/v1\/traces\/blobs\/([^/]+)$/.exec(pathname);
    if (blob) {
      if (request.method !== "PUT") return errorResponse(405, "method_not_allowed", "Use PUT for /v1/traces/blobs/:sha");
      const sha = decodeURIComponent(blob[1]!);
      if (!SHA256_RE.test(sha)) return errorResponse(400, "invalid_blob_id", "Blob id must be a lowercase sha256 hex digest");
      const ct = parseContentType(request.headers.get("content-type"));
      const gzipType = ct.type === TRACE_BLOB_GZIP_CONTENT_TYPE;
      const base64 = gzipType && ct.params.encoding === "base64";
      const body = await readBoundedBody(request, wireLimit(MAX_BLOB_BYTES, base64), MAX_BLOB_BYTES, { gzipBody: gzipType, base64 });
      const result = await ingestor.putBlob(ns, sha, body);
      return json(result.status === "created" ? 201 : 200, result);
    }
    return errorResponse(404, "not_found", `No trace route for ${request.method} ${pathname}`);
  } catch (error) {
    if (error instanceof TraceIngestError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "internal_error", `Trace ingest failed: ${errorMessage(error)}`);
  }
}

