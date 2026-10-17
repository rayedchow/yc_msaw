import { AsyncLocalStorage } from "node:async_hooks";
import { Client, SdkError, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError, type Transport } from "@modelcontextprotocol/client";
import { originBoundFetch, errorText } from "./security.js";
import type { JsonObject, LiveToolResult } from "./types.js";

/**
 * One MCP client connection to an upstream server (the parent memory MCP or a child integration MCP), using the
 * official MCP TypeScript SDK client and Streamable HTTP transport.
 *
 * Protocol: pinned to the 2025 ("legacy") era (2025-11-25, 2025-06-18, 2025-03-26), where servers push
 * `notifications/tools/list_changed` over the session's GET SSE stream. The 2026 `subscriptions/listen` model is
 * not negotiated.
 *
 * tools/list and tools/call are sent as raw requests so that every page is listed explicitly (cursor loop, bounded,
 * repeated-cursor detection) and results are passed through verbatim: the SDK's client-side output-schema check
 * (which can throw away a valid isError/text result) is not applied; the upstream server owns its contract.
 */

export const PINNED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const MAX_LIST_PAGES = 64;
export const MAX_TOOLS_PER_SOURCE = 512;

export type FailureKind =
  /** HTTP 401/403: credential rejected before execution. */
  | "unauthorized"
  /** The server answered (JSON-RPC error): the request was processed and rejected. */
  | "protocol"
  /** The request was definitely not executed (e.g. HTTP 404 for an expired session, connect failure before send). */
  | "not_sent"
  /** Network failure, timeout or 5xx after the request may have reached the server: outcome unknown. */
  | "ambiguous";

export class ConnectionError extends Error {
  /** Set by the registry when this is the final failure after its single retry. */
  retried = false;
  constructor(readonly kind: FailureKind, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "ConnectionError";
  }
}

const NOT_SENT_SDK_CODES = new Set(["NOT_CONNECTED", "ALREADY_CONNECTED", "NOT_INITIALIZED", "CAPABILITY_NOT_SUPPORTED", "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION"]);
const ANSWERED_SDK_CODES = new Set(["INVALID_RESULT", "UNSUPPORTED_RESULT_TYPE", "LIST_PAGINATION_EXCEEDED", "INPUT_REQUIRED_ROUNDS_EXCEEDED"]);

export function classifyError(error: unknown): ConnectionError {
  if (error instanceof ConnectionError) return error;
  if (error instanceof UnauthorizedError) return new ConnectionError("unauthorized", "upstream rejected the credential (401)", 401);
  if (error instanceof SdkHttpError) {
    const status = error.status;
    if (status === 401 || status === 403) return new ConnectionError("unauthorized", `upstream rejected the credential (${status})`, status);
    if (status === 404) return new ConnectionError("not_sent", "upstream session not found (404)", status);
    if (status === 400 || status === 405 || status === 406 || status === 415) return new ConnectionError("not_sent", `upstream refused the request (${status})`, status);
    return new ConnectionError("ambiguous", `upstream HTTP ${status}`, status);
  }
  const code = (error as { code?: unknown })?.code;
  // ProtocolError: a JSON-RPC error response, i.e. the server processed and answered the request.
  if (typeof code === "number") return new ConnectionError("protocol", errorText(error));
  if (error instanceof SdkError && typeof code === "string") {
    if (NOT_SENT_SDK_CODES.has(code)) return new ConnectionError("not_sent", errorText(error));
    if (ANSWERED_SDK_CODES.has(code)) return new ConnectionError("protocol", errorText(error));
  }
  // Connection could not be opened at all (refused / DNS): nothing was delivered.
  for (let c: unknown = error, depth = 0; c && depth < 5; c = (c as { cause?: unknown }).cause, depth++) {
    const sys = (c as { code?: unknown }).code;
    if (sys === "ECONNREFUSED" || sys === "ENOTFOUND" || sys === "EAI_AGAIN" || sys === "ERR_INVALID_URL") return new ConnectionError("not_sent", errorText(error));
  }
  // REQUEST_TIMEOUT, CONNECTION_CLOSED, SEND_FAILED, fetch/network errors: the request may have been delivered.
  return new ConnectionError("ambiguous", errorText(error));
}

/**
 * The exact credential a 401 response rejected, kept OFF the error object (private WeakMap): it is used only to tell a
 * refreshable credential provider which token was rejected (so a late 401 for an old token never forces a refresh of
 * a newer one), and never appears in messages, logs or serialized errors.
 */
const rejectedCredentials = new WeakMap<object, string>();

export function rejectedCredentialOf(error: unknown): string | undefined {
  return error && typeof error === "object" ? rejectedCredentials.get(error) : undefined;
}

export function attachRejectedCredential<T extends object>(error: T, credential: string | undefined): T {
  if (credential) rejectedCredentials.set(error, credential);
  return error;
}

/** Bearer value an HTTP request actually carried (from the headers originBoundFetch set). */
export function sentBearer(init: RequestInit | undefined): string | undefined {
  const h = new Headers(init?.headers).get("authorization");
  return h && /^bearer /i.test(h) ? h.slice(7) : undefined;
}

interface OpContext {
  rejected?: string;
  bearerError?: { error: unknown };
}

export interface ConnectionOptions {
  url: string;
  /** Bearer for every HTTP request on this connection (called per request; may refresh). */
  bearer: () => Promise<string>;
  /** Called when the server sends notifications/tools/list_changed. */
  onListChanged?: () => void;
  /** Called when the transport closes unexpectedly. */
  onClosed?: () => void;
  fetch?: typeof fetch;
  clientName?: string;
  /** Test hook: provide a transport instead of Streamable HTTP. */
  transportFactory?: () => Transport;
  requestTimeoutMs?: number;
}

export interface UpstreamTool extends JsonObject {
  name: string;
  description?: string;
  inputSchema: JsonObject;
}

export class McpConnection {
  readonly #client: Client;
  #connected = false;
  #closed = false;
  /**
   * Per-operation context (one per connect/tools/list page/tools/call): the credential a 401 rejected for THIS
   * operation's HTTP requests, and a credential error THIS operation's bearer() raised (nothing was sent). Concurrent
   * operations never see each other's failures.
   */
  readonly #ctx = new AsyncLocalStorage<OpContext>();

  constructor(private readonly opts: ConnectionOptions) {
    this.#client = new Client(
      { name: opts.clientName ?? "procmem-live-tools", version: "0.2.0" },
      { capabilities: {}, supportedProtocolVersions: PINNED_PROTOCOL_VERSIONS },
    );
    this.#client.setNotificationHandler("notifications/tools/list_changed", () => {
      opts.onListChanged?.();
    });
    this.#client.onclose = () => {
      const wasOpen = this.#connected && !this.#closed;
      this.#connected = false;
      if (wasOpen) opts.onClosed?.();
    };
    this.#client.onerror = () => {
      // Background SSE errors are surfaced through request failures and the next relist; never logged with headers.
    };
  }

  get connected(): boolean {
    return this.#connected && !this.#closed;
  }

  async #bearer(): Promise<string> {
    try {
      return await this.opts.bearer();
    } catch (error) {
      const store = this.#ctx.getStore();
      if (store && !store.bearerError) store.bearerError = { error };
      throw error;
    }
  }

  /** Rethrow a credential error THIS operation's bearer() raised as itself (typed, not-sent), else classify. */
  #fail(error: unknown, store: OpContext): never {
    if (store.bearerError) throw store.bearerError.error;
    const e = classifyError(error);
    throw attachRejectedCredential(e, e.kind === "unauthorized" ? store.rejected : undefined);
  }

  /** Base fetch that notes which bearer a 401 rejected, in the calling operation's context. */
  #observe(): typeof fetch {
    const base = this.opts.fetch ?? globalThis.fetch.bind(globalThis);
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await base(input, init);
      if (res.status === 401) {
        const store = this.#ctx.getStore();
        const sent = sentBearer(init);
        if (store && sent) store.rejected = sent;
      }
      return res;
    }) as typeof fetch;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new ConnectionError("not_sent", "connection closed");
    const url = new URL(this.opts.url);
    const transport =
      this.opts.transportFactory?.() ??
      new StreamableHTTPClientTransport(url, { fetch: originBoundFetch(url.origin, () => this.#bearer(), this.#observe()) });
    const store: OpContext = {};
    try {
      await this.#ctx.run(store, () => this.#client.connect(transport, { signal, timeout: this.opts.requestTimeoutMs ?? 30_000 }));
    } catch (error) {
      if (store.bearerError) throw store.bearerError.error;
      const e = classifyError(error);
      // initialize carries no tool side effects, so a failed connect is never an ambiguous tool call.
      throw attachRejectedCredential(new ConnectionError(e.kind === "unauthorized" ? "unauthorized" : e.kind === "protocol" ? "protocol" : "not_sent", `connect failed: ${e.message}`, e.status), e.kind === "unauthorized" ? store.rejected : undefined);
    }
    this.#connected = true;
  }

  /** Full tools/list across all pages (bounded). */
  async listTools(signal?: AbortSignal): Promise<UpstreamTool[]> {
    const tools: UpstreamTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      let result: { tools: unknown[]; nextCursor?: string };
      const store: OpContext = {};
      try {
        result = (await this.#ctx.run(store, () => this.#client.request({ method: "tools/list", params: cursor ? { cursor } : {} }, { signal, timeout: this.opts.requestTimeoutMs ?? 30_000 }))) as typeof result;
      } catch (error) {
        this.#fail(error, store);
      }
      for (const t of result.tools) tools.push(t as UpstreamTool);
      if (tools.length > MAX_TOOLS_PER_SOURCE) throw new ConnectionError("protocol", `upstream listed more than ${MAX_TOOLS_PER_SOURCE} tools`);
      const next = result.nextCursor;
      if (!next) return tools;
      if (seen.has(next)) throw new ConnectionError("protocol", "upstream tools/list pagination repeated a cursor");
      seen.add(next);
      cursor = next;
    }
    throw new ConnectionError("protocol", `upstream tools/list exceeded ${MAX_LIST_PAGES} pages`);
  }

  /** tools/call, result passed through verbatim. Throws ConnectionError (classified) on failure. */
  async callTool(name: string, args: JsonObject | undefined, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LiveToolResult> {
    const store: OpContext = {};
    try {
      const result = await this.#ctx.run(store, () =>
        this.#client.request({ method: "tools/call", params: { name, arguments: args ?? {} } }, { signal: options.signal, timeout: options.timeoutMs ?? this.opts.requestTimeoutMs ?? 120_000 }),
      );
      return result as unknown as LiveToolResult;
    } catch (error) {
      this.#fail(error, store);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    try {
      await this.#client.close();
    } catch {
      // already closed
    }
  }
}
