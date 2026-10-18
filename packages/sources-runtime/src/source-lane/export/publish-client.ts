import { createHash } from "node:crypto";
import type { CoverageReport, SourceChunkedContent } from "../core/types.js";

/**
 * Client for yc_msaw's binding-token publish protocol (yc_msaw src/sources/http.ts):
 *   PUT  /v1/sources/blobs/:sha256    one chunk (base64 vendor type, survives text-decoding hosts)
 *   POST /v1/sources/publish          {batchId, changes}
 *   POST /v1/sources/status-report    {providers, runtime}
 * The binding token alone determines the tenant on the server; nothing here sends one.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Inline content up to this size; larger content is uploaded as chunks first. */
export const INLINE_BYTES = 192 * 1024;
const BLOB_CONTENT_TYPE = "application/vnd.procmem.source-blob; encoding=base64";
const REQUEST_TIMEOUT_MS = 60_000;

export interface WirePut {
  op: "put";
  path: string;
  kind: "projection" | "raw" | "binary";
  contentType: string;
  sha256: string;
  size: number;
  inline?: string;
  chunks?: string[];
  sourceUpdatedAt?: string | null;
  sourceVersion?: { ref: string; ordinal?: number };
  capturedAt: string;
  provenance?: Record<string, unknown>;
}

export interface WireDelete {
  op: "delete";
  path: string;
  deletedAt: string;
  reason: string;
  capturedAt: string;
  provenance?: Record<string, unknown>;
}

export type WireChange = WirePut | WireDelete;

export interface PublishResult {
  path: string;
  outcome: "created" | "updated" | "restored" | "unchanged" | "stale" | "deleted" | "absent" | "rejected";
  versionId: string | null;
  error?: { code: string; message: string };
}

export interface PublishReceipt {
  batchId: string;
  commitId: string;
  seq: number;
  results: PublishResult[];
  replayed?: boolean;
}

/** HTTP-level failure; `retryable` distinguishes transient errors from permanent refusals. */
export class PublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Publish targets: https, or http only on loopback; never embedded credentials, query or fragment. */
export function assertPublishUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash) throw new Error("publish URL must not embed credentials, query or fragment");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) throw new Error("publish URL must use https (http only for loopback)");
  return u;
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function splitChunks(content: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < content.length; i += CHUNK_BYTES) out.push(content.subarray(i, i + CHUNK_BYTES));
  return out;
}

function retryAfter(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : null;
}

export class SourcePublishClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    assertPublishUrl(baseUrl);
  }

  async #request(method: string, route: string, body: string, contentType: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(route, this.baseUrl), {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": contentType },
        body,
        // The binding token must never follow a redirect to another origin.
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new PublishError(0, "network", `publish request failed: ${(error as Error).message}`, true);
    }
    if (res.ok) return res;
    let code = `http_${res.status}`;
    let message = `${method} ${route} -> ${res.status}`;
    let details: Record<string, unknown> = {};
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } & Record<string, unknown> };
      if (j.error?.code) code = j.error.code;
      if (j.error?.message) message = j.error.message;
      details = j.error ?? {};
    } catch {
      // non-JSON error body
    }
    const retryable = res.status === 429 || res.status >= 500 || code === "missing_blobs" || code === "conflict";
    const err = new PublishError(res.status, code, message, retryable, retryAfter(res));
    (err as PublishError & { details?: unknown }).details = details;
    throw err;
  }

  async putChunk(chunk: Buffer): Promise<string> {
    const sha = sha256(chunk);
    await this.#request("PUT", `/v1/sources/blobs/${sha}`, chunk.toString("base64"), BLOB_CONTENT_TYPE);
    return sha;
  }

  /** Wire form of a put: inline when small, otherwise chunks uploaded before the batch references them. */
  async preparePut(change: Omit<WirePut, "sha256" | "size" | "inline" | "chunks">, content: Buffer): Promise<WirePut> {
    const base = { ...change, sha256: sha256(content), size: content.length };
    if (content.length <= INLINE_BYTES) return { ...base, inline: content.toString("base64") };
    const chunks: string[] = [];
    for (const c of splitChunks(content)) chunks.push(await this.putChunk(c));
    return { ...base, chunks };
  }

  /**
   * Wire form of a pre-chunked put: chunks are loaded one at a time, each verified against its own sha and the
   * running whole-file digest, so a large stored file never sits in memory at once. Small files go inline.
   */
  async preparePutChunked(change: Omit<WirePut, "sha256" | "size" | "inline" | "chunks">, content: SourceChunkedContent): Promise<WirePut> {
    const declared = content.chunks.reduce((n, c) => n + c.size, 0);
    if (declared !== content.size) throw new Error(`${change.path}: chunk sizes sum to ${declared}, expected ${content.size}`);
    const whole = createHash("sha256");
    const loaded: Buffer[] = [];
    const shas: string[] = [];
    const inline = content.size <= INLINE_BYTES;
    for (const c of content.chunks) {
      if (c.size > CHUNK_BYTES) throw new Error(`${change.path}: chunk ${c.sha256.slice(0, 12)} exceeds ${CHUNK_BYTES} bytes`);
      const bytes = await content.load(c.sha256);
      if (bytes.length !== c.size || sha256(bytes) !== c.sha256) throw new Error(`${change.path}: stored chunk ${c.sha256.slice(0, 12)} does not match its digest`);
      whole.update(bytes);
      if (inline) loaded.push(bytes);
      else shas.push(await this.putChunk(bytes));
    }
    if (whole.digest("hex") !== content.sha256) throw new Error(`${change.path}: stored chunks do not concatenate to the recorded sha256`);
    const base = { ...change, sha256: content.sha256, size: content.size };
    return inline ? { ...base, inline: Buffer.concat(loaded).toString("base64") } : { ...base, chunks: shas };
  }

  async publish(batchId: string, changes: WireChange[]): Promise<PublishReceipt> {
    const res = await this.#request("POST", "/v1/sources/publish", JSON.stringify({ batchId, changes }), "application/json");
    return (await res.json()) as PublishReceipt;
  }

  async reportStatus(providers: CoverageReport[], runtime: { version: string; donorCommit: string; reportIntervalSeconds: number; host?: string }): Promise<void> {
    await this.#request("POST", "/v1/sources/status-report", JSON.stringify({ providers, runtime }), "application/json");
  }
}
