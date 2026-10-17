import { createHash } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/client";
import { classifyError, ConnectionError, McpConnection, rejectedCredentialOf, type UpstreamTool } from "./connection.js";
import { assignStableNames, type SourceId } from "./names.js";
import { ChildTokenError, ParentClient, ParentCredentialError, type CatalogEntry, type ParentEndpoint } from "./parent.js";
import { errorText, scrubKnownDeep } from "./security.js";
import {
  diffSnapshots,
  errorResult,
  type CallOptions,
  type CatalogStatus,
  type JsonObject,
  type LiveTool,
  type LiveToolResult,
  type LiveToolSource,
  type SourceStatus,
  type ToolsChange,
  type ToolsSnapshot,
} from "./types.js";

/**
 * LiveToolRegistry: the maintained runtime that exposes ALL of a tenant's MCP tools to a customer harness.
 *
 * Sources
 *  - memory: the parent's filesystem-only memory MCP (`/mcp`), with the parent credential.
 *  - integration:<slug>: every child integration MCP in the parent's authenticated catalog (GET /v1/integrations),
 *    each with its own short-lived bearer from POST /v1/integrations/:slug/token.
 *
 * Lifecycle
 *  - `start()` does a first refresh and then polls (configurable interval, bounded exponential backoff with jitter on
 *    catalog failure, unref'd timers). `dispose()` stops timers and closes every MCP connection.
 *  - Each refresh re-reads the catalog and reconciles: new slug -> connect; slug gone -> close and remove its tools at
 *    once (fail closed); mcpUrl/deploymentId/commit/audience changed -> brand-new handle, token and connection; same
 *    deployment -> tools/list again every `relistIntervalMs` (default each poll) so schema changes behind the same
 *    endpoint are picked up. notifications/tools/list_changed triggers a debounced relist of that source.
 *  - Catalog failures are classified: 401/403 drops all integration tools at once; a transient failure (network, 5xx,
 *    malformed body) keeps the last good set until `maxStaleMs`, then drops it. A successful empty catalog is a real
 *    "no integrations" answer and removes everything. `childAuthConfigured: false` means no child token is ever
 *    requested: integrations are reported `excluded` instead of minting in a loop.
 *  - A source that fails (token refusal, 401 after one retry, unreachable) gets its own bounded exponential backoff
 *    (`sourceRetryMs` doubling up to `maxBackoffMs`); a failure never triggers an immediate full refresh from inside a
 *    refresh. Calls may request ONE rate-limited refresh (`minRefreshIntervalMs`).
 *
 * Calls (`callTool`)
 *  - resolve the stable name against the CURRENT registry state; removed tools are refused, and when the caller passes
 *    `expectedFingerprint` a tool whose definition changed since the caller's snapshot is refused (`tool_changed`);
 *  - the child bearer is obtained BEFORE any MCP traffic (preflight; single-flight mint; refreshed before expiry using
 *    the server-measured lifetime, so clock skew cannot produce an expired bearer);
 *  - at most one retry per call, re-validating the tool and source first: after a 401/403 (rejected before execution,
 *    fresh credential), after a provably-unsent failure (connect refused, 404 session), or after an ambiguous failure
 *    ONLY for tools annotated readOnlyHint: true. Mutating tools are never replayed after an ambiguous failure.
 *  - the MCP CallToolResult is passed through (text, images, audio, resources, structuredContent, isError) with every
 *    KNOWN credential value (recent parent credentials, child tokens) replaced by "[REDACTED]"; binary data untouched.
 */

export interface LiveToolRegistryOptions {
  parent: ParentEndpoint;
  /** Expose the memory MCP tools (memory__*). Default true. */
  memory?: boolean;
  /** Expose integration child tools (integration__<slug>__*). Default true. */
  integrations?: boolean;
  /** Catalog poll interval. Default 30s. */
  pollIntervalMs?: number;
  /** Upper bound for failure backoff (catalog and per source). Default 5 min. */
  maxBackoffMs?: number;
  /** Re-list tools of an unchanged deployment at least this often. Default = pollIntervalMs. */
  relistIntervalMs?: number;
  /** How long a source/catalog may stay unreachable before its last-known tools are dropped. Default 10 min. */
  maxStaleMs?: number;
  /** Refresh a child bearer this long before it expires (capped at half the token lifetime). Default 60s. */
  tokenRefreshSkewMs?: number;
  /** First per-source retry delay after a failure (doubles up to maxBackoffMs). Default 5s. */
  sourceRetryMs?: number;
  /** Minimum spacing of call-triggered refreshes. Default 5s. */
  minRefreshIntervalMs?: number;
  /** Only expose child tools listed in the catalog's attested manifest (`tools`). Default true. */
  attestedToolsOnly?: boolean;
  /** Debounce for notifications/tools/list_changed. Default 250ms. */
  listChangedDebounceMs?: number;
  callTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Upper bound dispose() waits for in-flight refresh/list work before closing connections. Default 10s. */
  disposeTimeoutMs?: number;
  /** unref() timers so the registry never keeps a process alive. Default true. */
  unref?: boolean;
  /** Credential-free diagnostics. */
  onLog?: (entry: { level: "info" | "warn" | "error"; message: string; source?: SourceId }) => void;
  clientName?: string;
  now?: () => number;
  /** Test hook: custom transport per source (e.g. InMemoryTransport). */
  transportFactory?: (source: SourceId, url: string) => Transport | undefined;
}

export interface RefreshOptions {
  /** Ignore per-source backoff and relist intervals (operator/test use). */
  force?: boolean;
}

interface Handle {
  id: SourceId;
  url: string;
  entry?: CatalogEntry;
  identity: string;
  conn: McpConnection | null;
  connecting: Promise<McpConnection> | null;
  tools: UpstreamTool[];
  listedAt: number;
  lastOkAt: number;
  dirty: boolean;
  state: SourceStatus["state"];
  error?: string;
  token?: ChildTokenManager;
  op: Promise<void>;
  debounce?: ReturnType<typeof setTimeout>;
  retired: boolean;
  failures: number;
  retryAt: number;
}

class RefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const RECENT_SECRETS = 64;

class ChildTokenManager {
  #current: { token: string; localExpiresAt: number; lifetimeMs: number } | null = null;
  #inflight: Promise<string> | null = null;
  mints = 0;

  constructor(
    private readonly parent: ParentClient,
    private readonly entry: CatalogEntry,
    private readonly skewMs: number,
    private readonly now: () => number,
    private readonly remember: (token: string) => void,
  ) {}

  /** A bearer that is valid for at least the refresh skew; never an expired one. Concurrent callers share one mint. */
  async get(): Promise<string> {
    const c = this.#current;
    if (c && this.now() < c.localExpiresAt - Math.min(this.skewMs, c.lifetimeMs / 2)) return c.token;
    return this.refresh();
  }

  refresh(): Promise<string> {
    this.#inflight ??= (async () => {
      try {
        const startedAt = this.now();
        const t = await this.parent.childToken(this.entry);
        this.mints++;
        this.remember(t.token);
        // Anchor the server-measured lifetime to OUR clock at request start (conservative, skew-proof).
        this.#current = { token: t.token, localExpiresAt: startedAt + t.lifetimeMs, lifetimeMs: t.lifetimeMs };
        return t.token;
      } finally {
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }

  invalidate(): void {
    this.#current = null;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isObject(v: unknown): v is JsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export class LiveToolRegistry implements LiveToolSource {
  readonly parent: ParentClient;
  readonly #o: Required<
    Pick<
      LiveToolRegistryOptions,
      "pollIntervalMs" | "maxBackoffMs" | "relistIntervalMs" | "maxStaleMs" | "tokenRefreshSkewMs" | "sourceRetryMs" | "minRefreshIntervalMs" | "listChangedDebounceMs" | "callTimeoutMs" | "requestTimeoutMs" | "disposeTimeoutMs"
    >
  > &
    LiveToolRegistryOptions;
  readonly #now: () => number;
  readonly #handles = new Map<SourceId, Handle>();
  readonly #listeners = new Set<(change: ToolsChange) => void>();
  readonly #secrets: string[] = [];
  #snapshot: ToolsSnapshot;
  #toolIndex = new Map<string, LiveTool>();
  #catalog: CatalogStatus = { state: "never", consecutiveFailures: 0 };
  #childAuth = true;
  #refreshing: Promise<boolean> | null = null;
  #rerun: RefreshOptions | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #soon: ReturnType<typeof setTimeout> | null = null;
  #lastRefreshAt = 0;
  #started = false;
  #disposed = false;
  #disposing: Promise<void> | null = null;
  #failures = 0;

  constructor(opts: LiveToolRegistryOptions) {
    const poll = opts.pollIntervalMs ?? 30_000;
    this.#o = {
      ...opts,
      pollIntervalMs: poll,
      maxBackoffMs: opts.maxBackoffMs ?? 300_000,
      relistIntervalMs: opts.relistIntervalMs ?? poll,
      maxStaleMs: opts.maxStaleMs ?? 600_000,
      tokenRefreshSkewMs: opts.tokenRefreshSkewMs ?? 60_000,
      sourceRetryMs: opts.sourceRetryMs ?? 5_000,
      minRefreshIntervalMs: opts.minRefreshIntervalMs ?? 5_000,
      listChangedDebounceMs: opts.listChangedDebounceMs ?? 250,
      callTimeoutMs: opts.callTimeoutMs ?? 120_000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      disposeTimeoutMs: opts.disposeTimeoutMs ?? 10_000,
    };
    this.#now = opts.now ?? Date.now;
    this.parent = new ParentClient(opts.parent);
    this.#snapshot = { version: 0, tools: [], sources: [], catalog: { ...this.#catalog }, at: new Date(this.#now()).toISOString() };
    if (opts.memory !== false) this.#handles.set("memory", this.#newHandle("memory", this.parent.memoryMcpUrl, "memory"));
  }

  // ---------------------------------------------------------------- public surface

  /** First refresh, then background polling. Resolves after the first refresh (even if it failed). */
  async start(): Promise<ToolsSnapshot> {
    if (this.#disposed) throw new Error("LiveToolRegistry is disposed");
    if (!this.#started) {
      this.#started = true;
      await this.refresh();
      this.#schedule();
    }
    return this.#snapshot;
  }

  getSnapshot(): ToolsSnapshot {
    return this.#snapshot;
  }

  getTools(): readonly LiveTool[] {
    return this.#snapshot.tools;
  }

  onToolsChanged(listener: (change: ToolsChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Re-read the catalog and every source now. Concurrent calls share one run plus at most one follow-up run.
   * Returns whether the catalog (and memory source) refreshed successfully.
   */
  refresh(options: RefreshOptions = {}): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    if (this.#refreshing) {
      this.#rerun = { force: (this.#rerun?.force ?? false) || options.force === true };
      return this.#refreshing;
    }
    const run = (async () => {
      let ok = false;
      let opts: RefreshOptions | null = options;
      try {
        while (opts && !this.#disposed) {
          this.#rerun = null;
          ok = await this.#refreshOnce(opts);
          opts = this.#rerun;
        }
      } finally {
        this.#refreshing = null;
      }
      return ok;
    })();
    this.#refreshing = run;
    return run;
  }

  /** Number of child tokens minted per slug (diagnostics/tests; no token values). */
  tokenMints(slug: string): number {
    return this.#handles.get(`integration:${slug}`)?.token?.mints ?? 0;
  }

  async callTool(name: string, args: JsonObject | undefined, options: CallOptions = {}): Promise<LiveToolResult> {
    if (this.#disposed) return errorResult("disposed", "the live tool registry has been disposed");
    const tool = this.#toolIndex.get(name);
    if (!tool) return errorResult("tool_not_found", `tool ${name} is not available (it may have been removed)`);
    if (options.expectedFingerprint !== undefined && options.expectedFingerprint !== tool.fingerprint) return this.#changed(name);
    const h = this.#handles.get(tool.source);
    if (!h || h.retired || h.state !== "ready") return errorResult("source_unavailable", `${tool.source} is unavailable${h?.error ? `: ${h.error}` : ""}`);
    const fingerprint = tool.fingerprint;
    const stillValid = (): RefusedError | null => {
      if (this.#disposed) return new RefusedError("disposed", "the live tool registry has been disposed");
      const cur = this.#toolIndex.get(name);
      if (!cur) return new RefusedError("tool_not_found", `tool ${name} was removed`);
      if (cur.fingerprint !== fingerprint) return new RefusedError("tool_changed", `tool ${name} changed; not forwarding arguments built for the previous definition`);
      if (h.retired || h.state !== "ready") return new RefusedError("source_unavailable", `${tool.source} is unavailable${h.error ? `: ${h.error}` : ""}`);
      return null;
    };
    // Own property only: an inherited readOnlyHint (e.g. from untrusted JSON "__proto__" data) never enables a retry.
    const readOnly = !!tool.annotations && Object.hasOwn(tool.annotations, "readOnlyHint") && tool.annotations.readOnlyHint === true;
    try {
      const result = await this.#attempt(h, (conn) => conn.callTool(tool.upstreamName, args, { signal: options.signal, timeoutMs: options.timeoutMs ?? this.#o.callTimeoutMs }), readOnly, options.signal, stillValid);
      return scrubKnownDeep(result, this.#knownSecrets());
    } catch (error) {
      if (error instanceof RefusedError) return errorResult(error.code, error.message);
      if (error instanceof ChildTokenError) return this.#tokenFailure(h, error, true);
      if (error instanceof ParentCredentialError) {
        if (error.reauth) {
          this.#failClosed(h, "auth_failed", error.message);
          return errorResult("reauth_required", `${tool.source}: the parent credential needs re-authentication`, { mayHaveExecuted: false });
        }
        return errorResult("credential_unavailable", `${tool.source}: ${error.message}`, { mayHaveExecuted: false });
      }
      const e = error instanceof ConnectionError ? error : classifyError(error);
      const msg = this.#scrub(e.message);
      if (e.kind === "unauthorized") {
        this.#failClosed(h, "auth_failed", `credential rejected (${e.status ?? 401}) after a fresh-credential retry`);
        this.#refreshSoon();
        return errorResult("unauthorized", `${tool.source} rejected the credential; its tools are disabled until a later refresh succeeds`, { mayHaveExecuted: false });
      }
      if (e.kind === "protocol") return errorResult("upstream_error", msg);
      if (e.kind === "ambiguous") {
        return errorResult(
          "ambiguous_failure",
          readOnly
            ? `call to ${name} failed${e.retried ? " after one retry" : ""}: ${msg}`
            : `call to ${name} failed in transit (${msg}); it may or may not have executed upstream and was NOT retried because the tool is not marked read-only`,
          { retried: e.retried, mayHaveExecuted: true },
        );
      }
      return errorResult("transport_error", `call to ${name} was not delivered: ${msg}`, { retried: e.retried, mayHaveExecuted: false });
    }
  }

  /**
   * Stop all owned work and close every connection. Order matters:
   *  1. mark disposed and clear every timer (poll, call-triggered refresh, list_changed debounces): no NEW work starts,
   *     and in-flight work dispatches nothing further (each tools/list page and each attempt re-checks `disposed`);
   *  2. wait (bounded by `disposeTimeoutMs`) for in-flight owned refresh/list work, including debounced relists
   *     queued on each source's op chain, so every request dispatched before dispose() has settled when it resolves;
   *  3. close connections (aborting anything still running after the bound, e.g. a hung upstream).
   * Tool calls the caller started are not awaited; they are aborted by step 3 if still running.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return this.#disposing ?? undefined;
    this.#disposed = true;
    this.#disposing = (async () => {
      for (const t of [this.#timer, this.#soon]) if (t) clearTimeout(t);
      this.#timer = this.#soon = null;
      this.#listeners.clear();
      const handles = [...this.#handles.values()];
      for (const h of handles) if (h.debounce) clearTimeout(h.debounce);
      const owned = [this.#refreshing?.catch(() => undefined), ...handles.map((h) => h.op)];
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(owned), new Promise<void>((r) => (bound = setTimeout(r, this.#o.disposeTimeoutMs)))]);
      if (bound) clearTimeout(bound);
      const closing: Promise<unknown>[] = [];
      for (const h of handles) {
        h.retired = true;
        if (h.connecting) closing.push(h.connecting.catch(() => undefined)); // closes itself when it sees `retired`
        if (h.conn) closing.push(h.conn.close());
        h.conn = null;
      }
      await Promise.allSettled(closing);
    })();
    return this.#disposing;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  // ---------------------------------------------------------------- refresh

  async #refreshOnce(options: RefreshOptions): Promise<boolean> {
    this.#lastRefreshAt = this.#now();
    let ok = true;
    if (this.#o.integrations !== false) ok = await this.#reconcileCatalog();
    if (this.#disposed) return false;
    this.#rebuild(); // removals take effect before the (slower) per-source syncs
    const handles = [...this.#handles.values()].filter((h) => !h.retired);
    const results = await this.#bounded(handles, 4, (h) => this.#sync(h, options.force === true));
    const memoryIndex = handles.findIndex((h) => h.id === "memory");
    if (memoryIndex >= 0 && results[memoryIndex] === false) ok = false;
    this.#rebuild();
    return ok;
  }

  async #reconcileCatalog(): Promise<boolean> {
    const at = new Date(this.#now()).toISOString();
    let res;
    try {
      res = await this.parent.listIntegrations();
    } catch (error) {
      res = { kind: "transient" as const, status: null, message: this.#scrub(errorText(error)) };
    }
    if (res.kind === "ok") {
      this.#catalog = { state: "ok", configured: res.configured, lastSuccessAt: at, lastAttemptAt: at, consecutiveFailures: 0, rejected: res.rejected };
      this.#childAuth = res.childAuth;
      const wanted = new Map(res.integrations.map((e) => [`integration:${e.slug}` as SourceId, e]));
      for (const [id, h] of [...this.#handles]) {
        if (id === "memory") continue;
        const e = wanted.get(id);
        if (!e || this.#identity(e) !== h.identity) await this.#retire(h, e ? "deployment changed" : "removed from catalog");
      }
      for (const [id, e] of wanted) {
        const existing = this.#handles.get(id);
        if (existing) {
          existing.entry = e; // same identity; title/description/tools manifest may still change
          continue;
        }
        this.#handles.set(id, this.#newHandle(id, e.mcpUrl, this.#identity(e), e));
        this.#log("info", `integration ${e.slug} discovered (deployment ${e.deploymentId || "?"})`, id);
      }
      if (!res.childAuth && wanted.size) this.#log("warn", "parent reports childAuthConfigured:false; integrations are listed but not connected (no tokens requested)");
      return true;
    }
    const failures = this.#catalog.consecutiveFailures + 1;
    const lastSuccessAt = this.#catalog.lastSuccessAt;
    if (res.kind === "unauthorized") {
      this.#catalog = { state: "unauthorized", lastSuccessAt, lastAttemptAt: at, consecutiveFailures: failures, error: res.message };
      await this.#retireIntegrations("parent credential rejected by the catalog");
      this.#log("error", `integration catalog rejected the parent credential: ${res.message}`);
      return false;
    }
    // Never succeeded: nothing to keep or drop (still "transient"). Succeeded before: keep the last good set until stale.
    const stale = !!lastSuccessAt && this.#now() - Date.parse(lastSuccessAt) > this.#o.maxStaleMs;
    this.#catalog = { state: stale ? "stale_dropped" : "transient_error", lastSuccessAt, lastAttemptAt: at, consecutiveFailures: failures, error: res.message };
    if (stale) await this.#retireIntegrations("catalog unreachable beyond maxStaleMs");
    this.#log("warn", `integration catalog fetch failed (${failures}x, keeping last good set: ${!stale}): ${res.message}`);
    return false;
  }

  /** Connect if needed and relist when due. Serialized per source. Resolves false on failure (never throws). */
  #sync(h: Handle, force = false): Promise<boolean> {
    let ok = true;
    const next = h.op.then(async () => {
      if (h.retired || this.#disposed) return;
      if (h.entry && !this.#childAuth) {
        if (h.state !== "excluded" || h.tools.length) this.#failClosed(h, "excluded", "parent cannot mint child tokens (childAuthConfigured:false)", false);
        return;
      }
      if (!force && h.state !== "ready" && h.state !== "connecting" && this.#now() < h.retryAt) return; // per-source backoff
      const due = force || h.dirty || h.state !== "ready" || !h.conn?.connected || this.#now() - h.listedAt >= this.#o.relistIntervalMs;
      if (!due) return;
      h.dirty = false;
      try {
        const tools = await this.#attempt(h, (conn) => conn.listTools(undefined, () => this.#disposed || h.retired), true);
        if (h.retired) return;
        h.tools = tools;
        h.listedAt = h.lastOkAt = this.#now();
        h.state = "ready";
        h.error = undefined;
        h.failures = 0;
        h.retryAt = 0;
      } catch (error) {
        ok = false;
        if (h.retired) return;
        if (error instanceof ChildTokenError) {
          this.#tokenFailure(h, error, false);
          return;
        }
        if (error instanceof ParentCredentialError) {
          if (error.reauth) this.#failClosed(h, "auth_failed", error.message);
          else this.#sourceError(h, error.message);
          return;
        }
        const e = error instanceof ConnectionError ? error : classifyError(error);
        if (e.kind === "unauthorized") {
          this.#failClosed(h, "auth_failed", `credential rejected (${e.status ?? 401}) after a fresh-credential retry`);
          return;
        }
        this.#sourceError(h, this.#scrub(e.message));
      }
    });
    h.op = next.catch(() => undefined);
    return next.then(
      () => ok,
      () => false,
    );
  }

  /**
   * Run `op` on the source's connection with at most ONE retry, re-validating before each attempt.
   * Retry only when it cannot duplicate side effects: 401/403 (rejected before execution; fresh credential), provably
   * unsent failures, or ambiguous failures of read-only operations.
   */
  async #attempt<T>(h: Handle, op: (conn: McpConnection) => Promise<T>, readOnly: boolean, signal?: AbortSignal, stillValid?: () => RefusedError | null): Promise<T> {
    let retried = false;
    for (;;) {
      const refused = stillValid?.();
      if (refused) throw refused;
      if (h.retired || this.#disposed) throw new RefusedError("source_unavailable", `${h.id} was removed`);
      try {
        if (h.token) await h.token.get(); // preflight: credential errors surface typed, before any MCP traffic
        const conn = await this.#ensureConnected(h);
        if (h.retired || this.#disposed) throw new RefusedError("source_unavailable", `${h.id} was removed`); // no dispatch after dispose
        return await op(conn);
      } catch (error) {
        if (error instanceof ChildTokenError || error instanceof RefusedError || error instanceof ParentCredentialError) throw error;
        const e = error instanceof ConnectionError ? error : classifyError(error);
        if (e.kind === "unauthorized" && !retried) {
          if (h.token) h.token.invalidate();
          // Parent credential (memory MCP): let a refreshable credential (OAuth) rotate once; reauth => fail closed.
          else if (!(await this.parent.recoverFromUnauthorized(rejectedCredentialOf(e)))) {
            e.retried = false;
            throw e;
          }
        }
        if (e.kind === "not_sent" || !h.conn?.connected) await this.#dropConnection(h);
        const retryable = e.kind === "unauthorized" || e.kind === "not_sent" || (e.kind === "ambiguous" && readOnly && !signal?.aborted);
        if (retried || !retryable) {
          e.retried = retried;
          throw e;
        }
        retried = true;
      }
    }
  }

  /** One connection per source; concurrent callers share a single in-flight connect. */
  async #ensureConnected(h: Handle): Promise<McpConnection> {
    if (h.conn?.connected) return h.conn;
    if (h.connecting) return h.connecting;
    if (h.retired || this.#disposed) throw new RefusedError("source_unavailable", `${h.id} was removed`);
    const p = (async () => {
      await this.#dropConnection(h);
      const custom = this.#o.transportFactory?.(h.id, h.url);
      const conn = new McpConnection({
        url: h.url,
        bearer: () => (h.token ? h.token.get() : this.parent.credential()),
        onListChanged: () => this.#listChanged(h),
        onClosed: () => {
          if (h.conn === conn) h.conn = null;
        },
        fetch: this.#o.parent.fetch,
        clientName: this.#o.clientName,
        requestTimeoutMs: this.#o.requestTimeoutMs,
        transportFactory: custom ? () => custom : undefined,
      });
      try {
        await conn.connect();
      } catch (error) {
        await conn.close();
        throw error;
      }
      if (h.retired || this.#disposed) {
        await conn.close();
        throw new RefusedError("source_unavailable", `${h.id} was removed`);
      }
      h.conn = conn;
      return conn;
    })();
    h.connecting = p;
    try {
      return await p;
    } finally {
      if (h.connecting === p) h.connecting = null;
    }
  }

  #listChanged(h: Handle): void {
    if (h.retired || this.#disposed) return;
    h.dirty = true;
    if (h.debounce) clearTimeout(h.debounce);
    h.debounce = setTimeout(() => {
      h.debounce = undefined;
      void this.#sync(h, true).then(() => this.#rebuild());
    }, this.#o.listChangedDebounceMs);
    if (this.#o.unref !== false) h.debounce.unref?.();
  }

  // ---------------------------------------------------------------- failure handling

  #tokenFailure(h: Handle, e: ChildTokenError, fromCall: boolean): LiveToolResult {
    const msg = this.#scrub(e.message);
    if (e.kind === "transient") {
      this.#sourceError(h, msg);
      return errorResult("token_unavailable", `could not obtain a credential for ${h.id}: ${msg}`, { mayHaveExecuted: false });
    }
    this.#failClosed(h, e.kind === "unauthorized" ? "auth_failed" : "excluded", msg);
    // Only a CALL may ask for a catalog refresh (rate-limited); never from inside a refresh (no hot loop).
    if (fromCall && e.kind === "not_found") this.#refreshSoon();
    const code = { unauthorized: "unauthorized", not_found: "integration_removed", unconfigured: "child_auth_unavailable", mismatch: "namespace_mismatch" }[e.kind];
    return errorResult(code, `${h.id}: ${msg}`, { mayHaveExecuted: false });
  }

  /** Transient source failure: keep last-known tools within maxStaleMs, back off, reconnect later. */
  #sourceError(h: Handle, message: string): void {
    const keep = h.state === "ready" && h.lastOkAt > 0 && this.#now() - h.lastOkAt <= this.#o.maxStaleMs;
    h.error = message;
    this.#backoff(h);
    if (!keep) {
      h.state = "error";
      h.tools = [];
    }
    this.#log("warn", `${h.id} unavailable (retry in ${Math.max(0, h.retryAt - this.#now())}ms, keeping tools: ${keep}): ${message}`, h.id);
  }

  #failClosed(h: Handle, state: "auth_failed" | "excluded", message: string, backoff = true): void {
    h.state = state;
    h.error = message;
    h.tools = [];
    h.listedAt = 0;
    h.token?.invalidate();
    if (backoff) this.#backoff(h);
    void this.#dropConnection(h);
    this.#rebuild();
    this.#log("error", `${h.id} disabled: ${message}`, h.id);
  }

  #backoff(h: Handle): void {
    h.failures++;
    h.retryAt = this.#now() + Math.min(this.#o.maxBackoffMs, this.#o.sourceRetryMs * 2 ** Math.min(h.failures - 1, 16));
  }

  /** At most one call-triggered refresh per minRefreshIntervalMs. */
  #refreshSoon(): void {
    if (this.#soon || this.#disposed) return;
    const delay = Math.max(0, this.#lastRefreshAt + this.#o.minRefreshIntervalMs - this.#now());
    this.#soon = setTimeout(() => {
      this.#soon = null;
      void this.refresh();
    }, delay);
    if (this.#o.unref !== false) this.#soon.unref?.();
  }

  async #dropConnection(h: Handle): Promise<void> {
    const c = h.conn;
    h.conn = null;
    if (c) await c.close();
  }

  async #retire(h: Handle, why: string): Promise<void> {
    h.retired = true;
    h.tools = [];
    if (h.debounce) clearTimeout(h.debounce);
    this.#handles.delete(h.id);
    this.#log("info", `${h.id} retired: ${why}`, h.id);
    await this.#dropConnection(h);
  }

  async #retireIntegrations(why: string): Promise<void> {
    for (const h of [...this.#handles.values()]) if (h.id !== "memory") await this.#retire(h, why);
  }

  #changed(name: string): LiveToolResult {
    return errorResult("tool_changed", `tool ${name} changed since this turn's tool list was built; the call was not forwarded. The updated definition is available on the next turn.`, { mayHaveExecuted: false });
  }

  // ---------------------------------------------------------------- snapshot

  #rebuild(): void {
    if (this.#disposed) return;
    const known = this.#knownSecrets();
    const entries: Array<{ source: SourceId; upstream: string; tool: UpstreamTool; h: Handle }> = [];
    const skipped = new Map<SourceId, Array<{ name: string; reason: string }>>();
    const skip = (id: SourceId, name: string, reason: string) => skipped.set(id, [...(skipped.get(id) ?? []), { name, reason }]);
    const ordered = [...this.#handles.values()].filter((h) => !h.retired && h.state === "ready").sort((a, b) => (a.id === "memory" ? -1 : b.id === "memory" ? 1 : a.id < b.id ? -1 : 1));
    for (const h of ordered) {
      const attested = h.entry && this.#o.attestedToolsOnly !== false ? new Set(h.entry.tools) : null;
      const counts = new Map<string, number>();
      for (const t of h.tools) if (isObject(t) && typeof t.name === "string") counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
      for (const t of h.tools) {
        if (!isObject(t) || typeof t.name !== "string" || !t.name) {
          skip(h.id, String((t as { name?: unknown })?.name ?? "?"), "malformed tool definition");
          continue;
        }
        if (counts.get(t.name)! > 1) {
          skip(h.id, t.name, "duplicate upstream tool name"); // ambiguous: expose neither copy
          continue;
        }
        if (!isObject(t.inputSchema) || (t.inputSchema.type !== undefined && t.inputSchema.type !== "object")) {
          skip(h.id, t.name, "inputSchema is not an object schema");
          continue;
        }
        if (attested && !attested.has(t.name)) {
          skip(h.id, t.name, "not in the catalog's attested tool manifest");
          continue;
        }
        entries.push({ source: h.id, upstream: t.name, tool: t, h });
      }
    }
    const names = assignStableNames(entries);
    const tools: LiveTool[] = [];
    entries.forEach((e, i) => {
      const name = names[i];
      if (!name) skip(e.source, e.upstream, "stable name collision");
      else tools.push(this.#liveTool(name, e.source, e.tool, e.h, known));
    });
    const sources: SourceStatus[] = [...this.#handles.values()]
      .filter((h) => !h.retired)
      .map((h) => ({
        source: h.id,
        state: h.state,
        toolCount: tools.filter((t) => t.source === h.id).length,
        ...(h.error ? { error: h.error } : {}),
        ...(h.entry ? { deploymentId: h.entry.deploymentId, commit: h.entry.commit } : {}),
        ...(h.listedAt ? { lastListedAt: new Date(h.listedAt).toISOString() } : {}),
        ...(skipped.get(h.id)?.length ? { skippedTools: skipped.get(h.id) } : {}),
      }));
    const key = (list: readonly LiveTool[]) => list.map((t) => `${t.name}=${t.fingerprint}`).join("\n");
    const changed = key(tools) !== key(this.#snapshot.tools);
    const next: ToolsSnapshot = {
      version: this.#snapshot.version + (changed ? 1 : 0),
      tools: Object.freeze(tools),
      sources: Object.freeze(scrubKnownDeep(sources, known)),
      catalog: scrubKnownDeep({ ...this.#catalog }, known),
      at: new Date(this.#now()).toISOString(),
    };
    const previous = this.#snapshot;
    this.#snapshot = next;
    this.#toolIndex = new Map(tools.map((t) => [t.name, t]));
    if (changed) {
      const change = diffSnapshots(previous, next);
      for (const l of [...this.#listeners]) {
        try {
          l(change);
        } catch (error) {
          this.#log("warn", `onToolsChanged listener threw: ${errorText(error)}`);
        }
      }
    }
  }

  /**
   * Model-facing descriptor. Known credential values are removed from every field; the fingerprint hashes the whole
   * published descriptor (including catalog identity: title, commit, deploymentId, mcpUrl), so ANY change that a
   * harness would publish differently bumps the snapshot version and is refused mid-turn via expectedFingerprint.
   */
  #liveTool(name: string, source: SourceId, raw: UpstreamTool, h: Handle, known: readonly string[]): LiveTool {
    const t = scrubKnownDeep(raw, known);
    const upstreamDescription = typeof t.description === "string" ? t.description : "";
    const tag = h.entry ? scrubKnownDeep(`[integration ${h.entry.slug}${h.entry.title ? `: ${h.entry.title}` : ""}]`, known) : "[procmem memory]";
    const tool: Omit<LiveTool, "fingerprint"> & { fingerprint?: string } = {
      name,
      source,
      upstreamName: raw.name,
      description: upstreamDescription ? `${tag} ${upstreamDescription}` : tag,
      inputSchema: t.inputSchema,
      upstream: t,
    };
    if (typeof t.title === "string") tool.title = t.title;
    if (isObject(t.outputSchema)) tool.outputSchema = t.outputSchema;
    if (isObject(t.annotations)) tool.annotations = t.annotations;
    if (h.entry) tool.integration = scrubKnownDeep({ slug: h.entry.slug, title: h.entry.title, commit: h.entry.commit, deploymentId: h.entry.deploymentId, mcpUrl: h.entry.mcpUrl }, known);
    tool.fingerprint = createHash("sha256").update(canonical(tool)).digest("hex");
    return tool as LiveTool;
  }

  // ---------------------------------------------------------------- helpers

  #newHandle(id: SourceId, url: string, identity: string, entry?: CatalogEntry): Handle {
    return {
      id,
      url,
      entry,
      identity,
      conn: null,
      connecting: null,
      tools: [],
      listedAt: 0,
      lastOkAt: 0,
      dirty: false,
      state: "connecting",
      op: Promise.resolve(),
      retired: false,
      failures: 0,
      retryAt: 0,
      ...(entry ? { token: new ChildTokenManager(this.parent, entry, this.#o.tokenRefreshSkewMs, this.#now, (t) => this.#remember(t)) } : {}),
    };
  }

  #identity(e: CatalogEntry): string {
    return `${e.mcpUrl}|${e.deploymentId}|${e.commit}|${e.audience}`;
  }

  #remember(secret: string): void {
    this.#secrets.push(secret);
    if (this.#secrets.length > RECENT_SECRETS) this.#secrets.shift();
  }

  #knownSecrets(): string[] {
    return [...this.parent.recentCredentials(), ...this.#secrets];
  }

  #scrub(text: string): string {
    return this.parent.scrub(text, this.#secrets);
  }

  #log(level: "info" | "warn" | "error", message: string, source?: SourceId): void {
    try {
      this.#o.onLog?.({ level, message: this.#scrub(message), ...(source ? { source } : {}) });
    } catch {
      // logging must never break the registry
    }
  }

  #schedule(): void {
    if (this.#disposed) return;
    const base = this.#o.pollIntervalMs;
    const delay = this.#failures === 0 ? base : Math.min(this.#o.maxBackoffMs, base * 2 ** Math.min(this.#failures, 16)) * (0.85 + Math.random() * 0.3);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.refresh().then(
        (ok) => {
          this.#failures = ok ? 0 : this.#failures + 1;
          this.#schedule();
        },
        () => {
          this.#failures++;
          this.#schedule();
        },
      );
    }, Math.max(10, Math.round(delay)));
    if (this.#o.unref !== false) this.#timer.unref?.();
  }

  async #bounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i]!);
        }
      }),
    );
    return out;
  }
}

/** Create and start a registry. */
export async function startLiveTools(opts: LiveToolRegistryOptions): Promise<LiveToolRegistry> {
  const r = new LiveToolRegistry(opts);
  await r.start();
  return r;
}
