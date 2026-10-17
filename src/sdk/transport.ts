import { gzipSync } from "node:zlib";
import { TRACE_BLOB_GZIP_CONTENT_TYPE, TRACE_CHUNK_GZIP_CONTENT_TYPE, type TraceChunk } from "../traces/schema.js";

/** Acknowledgement for a delivered chunk ("duplicate" means an earlier attempt already landed). */
export interface ChunkAck {
  status: "created" | "duplicate";
  sessionId: string;
  chunkSeq: number;
  day?: string;
  key?: string;
}

export interface TraceTransport {
  sendChunk(chunk: TraceChunk): Promise<ChunkAck>;
  putBlob(sha256: string, bytes: Uint8Array, mediaType: string): Promise<void>;
}

/**
 * Transport failure. `retryable` is true for network errors, timeouts, 408,
 * 429 and 5xx; other 4xx responses are permanent and surfaced to the caller.
 */
export class TraceTransportError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean, readonly code?: string) {
    super(message);
    this.name = "TraceTransportError";
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface HttpTraceTransportOptions {
  /** Base URL of the trace ingest service, e.g. https://memory.example.com */
  baseUrl: string;
  /** Bearer token or async provider (called per request, so rotation works). */
  token: string | (() => Promise<string>);
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /**
   * "base64" (default): gzip bytes sent base64-encoded (`; encoding=base64`), which survives hosts that decode
   * request bodies as UTF-8 text (e.g. mcp-use 2.10). "binary": raw gzip bytes (smaller; needs a binary-safe host).
   */
  bodyEncoding?: "base64" | "binary";
}

/**
 * HTTP transport: POST {baseUrl}/v1/traces/chunks and PUT {baseUrl}/v1/traces/blobs/:sha.
 * Bodies are gzip and labelled with vendor content types that do not contain
 * "application/json" (some hosts eagerly JSON-parse such bodies before routing);
 * the content type itself declares gzip, so no Content-Encoding header is sent.
 * By default the gzip bytes are base64-encoded (`; encoding=base64`) because some
 * hosts decode every request body as UTF-8 text, which would corrupt binary.
 */
export class HttpTraceTransport implements TraceTransport {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(private readonly opts: HttpTraceTransportOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async sendChunk(chunk: TraceChunk): Promise<ChunkAck> {
    const res = await this.#request("POST", "/v1/traces/chunks", gzipSync(Buffer.from(JSON.stringify(chunk), "utf8")), TRACE_CHUNK_GZIP_CONTENT_TYPE);
    return (await res.json()) as ChunkAck;
  }

  async putBlob(sha256: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    await this.#request("PUT", `/v1/traces/blobs/${sha256}`, gzipSync(bytes), TRACE_BLOB_GZIP_CONTENT_TYPE, { "x-procmem-media-type": mediaType });
  }

  async #request(method: string, path: string, gz: Buffer, baseType: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const base64 = (this.opts.bodyEncoding ?? "base64") === "base64";
    const body = base64 ? Buffer.from(gz.toString("base64"), "latin1") : gz;
    const contentType = base64 ? `${baseType}; encoding=base64` : baseType;
    const token = typeof this.opts.token === "function" ? await this.opts.token() : this.opts.token;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { ...extraHeaders, authorization: `Bearer ${token}`, "content-type": contentType },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new TraceTransportError(`Trace transport network error on ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, null, true, "network_error");
    }
    if (res.ok) return res;
    let code: string | undefined;
    let message = `${res.status} ${res.statusText}`;
    try {
      const parsed = (await res.json()) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code;
      if (parsed.error?.message) message = `${res.status} ${parsed.error.message}`;
    } catch {
      // non-JSON error body
    }
    throw new TraceTransportError(`Trace ingest rejected ${method} ${path}: ${message}`, res.status, isRetryableStatus(res.status), code);
  }
}

/** Structural view of the server-side TraceIngestor (keeps the SDK free of server code). */
export interface TraceIngestTarget {
  ingestChunk(ns: string, chunk: unknown): Promise<{ status: "created" | "duplicate"; sessionId: string; chunkSeq: number; day?: string; key?: string }>;
  putBlob(ns: string, sha256: string, bytes: Uint8Array): Promise<unknown>;
}

/** Calls a TraceIngestor directly (tests, in-process harnesses). `ns` is the trusted tenant. */
export class InProcessTraceTransport implements TraceTransport {
  constructor(private readonly ingestor: TraceIngestTarget, private readonly ns: string) {}

  async sendChunk(chunk: TraceChunk): Promise<ChunkAck> {
    // Round-trip through JSON so the ingestor sees exactly what would go over the wire.
    const wire = JSON.parse(JSON.stringify(chunk)) as unknown;
    const result = await this.#wrap(() => this.ingestor.ingestChunk(this.ns, wire));
    return { status: result.status, sessionId: result.sessionId, chunkSeq: result.chunkSeq, ...(result.day ? { day: result.day } : {}), ...(result.key ? { key: result.key } : {}) };
  }

  async putBlob(sha256: string, bytes: Uint8Array, _mediaType?: string): Promise<void> {
    await this.#wrap(() => this.ingestor.putBlob(this.ns, sha256, bytes));
  }

  async #wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
      const code = (error as { code?: unknown }).code;
      throw new TraceTransportError(error instanceof Error ? error.message : String(error), status, isRetryableStatus(status), typeof code === "string" ? code : undefined);
    }
  }
}
