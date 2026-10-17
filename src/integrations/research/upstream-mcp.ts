import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { IntegrationError } from "../types.js";
import { errorMessage } from "../../util.js";

/**
 * Host-configured upstream MCP servers the builder may inspect (live from that
 * server). Headers (credentials) are held by the host and never returned.
 * Calls are permitted only when the host config says allowCalls: "read_only"
 * AND the server's own tools/list declares annotations.readOnlyHint === true.
 * The hint is the server's claim, not a guarantee; the host opts in per server.
 */

export interface UpstreamMcpConfig {
  /** Slug the agent uses to select this server. */
  name: string;
  url: string;
  /** Host-held request headers (e.g. Authorization). Never returned in results. */
  headers?: Record<string, string>;
  allowCalls: "none" | "read_only";
}

export interface UpstreamToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface UpstreamCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

/** The subset of the MCP SDK Client we use; injectable for tests. */
export interface UpstreamMcpClient {
  listTools(): Promise<{ tools: UpstreamToolInfo[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type McpClientFactory = (cfg: UpstreamMcpConfig, opts: { timeoutMs: number }) => Promise<UpstreamMcpClient>;

export interface UpstreamOptions {
  timeoutMs?: number;
  clientFactory?: McpClientFactory;
}

export const UPSTREAM_DEFAULT_TIMEOUT_MS = 20_000;
const UPSTREAM_MAX_TIMEOUT_MS = 60_000;

export const defaultMcpClientFactory: McpClientFactory = async (cfg, { timeoutMs }) => {
  const client = new Client({ name: "procmem-integration-research", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: { ...(cfg.headers ?? {}) } } }));
  return {
    listTools: async () => (await client.listTools(undefined, { timeout: timeoutMs })) as { tools: UpstreamToolInfo[] },
    callTool: (params) => client.callTool(params, { timeout: timeoutMs }),
    close: () => client.close(),
  };
};

export function validateUpstreamConfig(cfg: UpstreamMcpConfig): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(cfg.name)) throw new Error(`Upstream MCP name must be a slug: ${JSON.stringify(cfg.name)}`);
  let url: URL;
  try {
    url = new URL(cfg.url);
  } catch {
    throw new Error(`Upstream MCP ${cfg.name} has an invalid url`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Upstream MCP ${cfg.name} url must be http(s)`);
  if (cfg.allowCalls !== "none" && cfg.allowCalls !== "read_only") throw new Error(`Upstream MCP ${cfg.name} allowCalls must be "none" or "read_only"`);
}

export async function listUpstreamTools(cfg: UpstreamMcpConfig, opts: UpstreamOptions = {}): Promise<UpstreamToolInfo[]> {
  return withClient(cfg, opts, "tools/list", async (client) => normalizeTools(await client.listTools(), cfg));
}

/** List, check permission against the listed annotations, then call (one session). */
export async function callUpstreamTool(
  cfg: UpstreamMcpConfig,
  tool: string,
  args: Record<string, unknown>,
  opts: UpstreamOptions = {},
): Promise<{ tool: UpstreamToolInfo; result: UpstreamCallResult }> {
  if (cfg.allowCalls !== "read_only") {
    throw new IntegrationError("call_not_permitted", `Host config for upstream ${cfg.name} does not permit tool calls (allowCalls: "${cfg.allowCalls}")`);
  }
  return withClient(cfg, opts, `tools/call ${tool}`, async (client) => {
    const tools = normalizeTools(await client.listTools(), cfg);
    const info = tools.find((t) => t.name === tool);
    if (!info) throw new IntegrationError("unknown_upstream_tool", `Upstream ${cfg.name} does not list a tool named ${JSON.stringify(tool)}`, { available: tools.map((t) => t.name) });
    if (info.annotations?.readOnlyHint !== true) {
      throw new IntegrationError("call_not_permitted", `Upstream tool ${cfg.name}/${tool} does not declare annotations.readOnlyHint: true; only read-only tools may be called`);
    }
    const raw = await client.callTool({ name: tool, arguments: args });
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { content?: unknown }).content)) {
      throw new IntegrationError("upstream_schema_mismatch", `Upstream ${cfg.name}/${tool} returned a result without a content array`);
    }
    const r = raw as { content: unknown[]; structuredContent?: unknown; isError?: unknown };
    const result: UpstreamCallResult = { content: r.content, isError: r.isError === true };
    if (r.structuredContent !== undefined) result.structuredContent = r.structuredContent;
    return { tool: info, result };
  });
}

function normalizeTools(listed: unknown, cfg: UpstreamMcpConfig): UpstreamToolInfo[] {
  const tools = (listed as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) throw new IntegrationError("upstream_schema_mismatch", `Upstream ${cfg.name} tools/list returned no tools array`);
  return tools.map((t, i) => {
    if (typeof t !== "object" || t === null || typeof (t as { name?: unknown }).name !== "string") {
      throw new IntegrationError("upstream_schema_mismatch", `Upstream ${cfg.name} tools/list entry ${i} has no name`);
    }
    const o = t as Record<string, unknown>;
    const out: UpstreamToolInfo = { name: o.name as string };
    if (typeof o.title === "string") out.title = o.title;
    if (typeof o.description === "string") out.description = o.description;
    if (o.inputSchema !== undefined) out.inputSchema = o.inputSchema;
    if (o.outputSchema !== undefined) out.outputSchema = o.outputSchema;
    if (typeof o.annotations === "object" && o.annotations !== null) out.annotations = o.annotations as Record<string, unknown>;
    return out;
  });
}

async function withClient<T>(cfg: UpstreamMcpConfig, opts: UpstreamOptions, label: string, fn: (c: UpstreamMcpClient) => Promise<T>): Promise<T> {
  const timeoutMs = Math.min(UPSTREAM_MAX_TIMEOUT_MS, Math.max(1, opts.timeoutMs ?? UPSTREAM_DEFAULT_TIMEOUT_MS));
  const factory = opts.clientFactory ?? defaultMcpClientFactory;
  let client: UpstreamMcpClient | null = null;
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const work = (async () => {
    let c: UpstreamMcpClient;
    try {
      c = await factory(cfg, { timeoutMs });
    } catch (error) {
      throw new IntegrationError("upstream_connect_failed", redact(`Could not connect to upstream ${cfg.name}: ${errorMessage(error)}`, cfg));
    }
    // Connected after the deadline: close immediately instead of leaking the session.
    if (finished) {
      await c.close().catch(() => undefined);
      throw new IntegrationError("upstream_timeout", `Upstream ${cfg.name} ${label} exceeded ${timeoutMs}ms`);
    }
    client = c;
    return fn(c);
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new IntegrationError("upstream_timeout", `Upstream ${cfg.name} ${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (error instanceof IntegrationError) throw new IntegrationError(error.code, redact(error.message, cfg), error.details);
    throw new IntegrationError("upstream_error", redact(`Upstream ${cfg.name} ${label} failed: ${errorMessage(error)}`, cfg));
  } finally {
    finished = true;
    clearTimeout(timer);
    work.catch(() => undefined);
    const c = client as UpstreamMcpClient | null;
    if (c) await c.close().catch(() => undefined);
  }
}

/** Strip any host-held header value from a message. */
function redact(text: string, cfg: UpstreamMcpConfig): string {
  let out = text;
  for (const v of Object.values(cfg.headers ?? {})) if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  return out;
}
