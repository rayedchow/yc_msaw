import type { SourceId } from "./names.js";

export type JsonObject = Record<string, unknown>;

/** One tool exposed by the live registry under a stable namespaced name. */
export interface LiveTool {
  /** Stable namespaced name, e.g. memory__open_memory or integration__notify-hub__deliver. */
  name: string;
  source: SourceId;
  /** Name of the tool on the upstream MCP server. */
  upstreamName: string;
  title?: string;
  /** Description for the model: a short source tag followed by the upstream description verbatim. */
  description: string;
  /** Full upstream JSON Schema (never rewritten). */
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
  /** Upstream Tool `_meta` and other extra fields, kept verbatim. */
  upstream: JsonObject;
  /** Present for integration tools (no credentials). */
  integration?: { slug: string; title: string; commit: string; deploymentId: string; mcpUrl: string };
  /** sha256 over the canonical upstream definition plus source identity; changes iff the tool changed. */
  fingerprint: string;
}

export type SourceState = "connecting" | "ready" | "error" | "auth_failed" | "excluded";

export interface SourceStatus {
  source: SourceId;
  state: SourceState;
  toolCount: number;
  /** Credential-free error text. */
  error?: string;
  deploymentId?: string;
  commit?: string;
  lastListedAt?: string;
  /** Upstream tools that were not exposed, with the reason (e.g. not attested by the catalog manifest). */
  skippedTools?: Array<{ name: string; reason: string }>;
}

export interface CatalogStatus {
  state: "never" | "ok" | "unauthorized" | "transient_error" | "stale_dropped";
  configured?: boolean;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  consecutiveFailures: number;
  error?: string;
  rejected?: Array<{ slug: string | null; reason: string }>;
}

export interface ToolsSnapshot {
  /** Increments only when the set of tools or any tool definition changes. */
  version: number;
  tools: readonly LiveTool[];
  sources: readonly SourceStatus[];
  catalog: CatalogStatus;
  at: string;
}

export interface ToolsChange {
  previous: ToolsSnapshot;
  next: ToolsSnapshot;
  added: LiveTool[];
  updated: LiveTool[];
  removed: LiveTool[];
}

/** MCP CallToolResult, passed through verbatim (text, image, audio, resource content, structuredContent, _meta). */
export interface LiveToolResult {
  content: Array<JsonObject & { type: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
  [key: string]: unknown;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Per-call timeout in ms (default: registry callTimeoutMs). */
  timeoutMs?: number;
  /**
   * Fingerprint of the tool definition the caller's arguments were built for (from the snapshot the model saw).
   * If the registry's current definition differs, the call is refused with `tool_changed` and never forwarded.
   */
  expectedFingerprint?: string;
}

/** The surface every harness adapter uses. */
export interface LiveToolSource {
  getSnapshot(): ToolsSnapshot;
  getTools(): readonly LiveTool[];
  callTool(name: string, args: JsonObject | undefined, options?: CallOptions): Promise<LiveToolResult>;
  onToolsChanged(listener: (change: ToolsChange) => void): () => void;
}

export function diffSnapshots(previous: ToolsSnapshot, next: ToolsSnapshot): ToolsChange {
  const before = new Map(previous.tools.map((t) => [t.name, t]));
  const after = new Map(next.tools.map((t) => [t.name, t]));
  const added: LiveTool[] = [];
  const updated: LiveTool[] = [];
  const removed: LiveTool[] = [];
  for (const [name, t] of after) {
    const old = before.get(name);
    if (!old) added.push(t);
    else if (old.fingerprint !== t.fingerprint) updated.push(t);
  }
  for (const [name, t] of before) if (!after.has(name)) removed.push(t);
  return { previous, next, added, updated, removed };
}

/** Error result in MCP shape. `code` is machine-readable under _meta["procmem/error"]. */
export function errorResult(code: string, message: string, extra: JsonObject = {}): LiveToolResult {
  return { content: [{ type: "text", text: `procmem: ${message}` }], isError: true, _meta: { "procmem/error": { code, ...extra } } };
}
