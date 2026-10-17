import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/server";
import { PINNED_PROTOCOL_VERSIONS } from "./connection.js";
import { errorResult, type JsonObject, type LiveTool, type LiveToolSource } from "./types.js";

/**
 * SDK-owned MCP bridge for clients that configure MCP servers once at startup (Claude Code, Codex, Cursor, ...).
 *
 * One MCP server (official @modelcontextprotocol/server, usually over stdio) exposes:
 *  - every live tool under its stable namespaced name, with the upstream JSON schemas, outputSchema and annotations;
 *  - `notifications/tools/list_changed` whenever the registry snapshot changes, so clients that honour it re-list
 *    and see added/changed/removed tools on the SAME connection (no reinitialize, no restart);
 *  - two fixed fallback tools whose schemas never change, for clients that ignore list_changed:
 *      procmem_list_live_tools  -> the current live tools (names, descriptions, full schemas)
 *      procmem_call_live_tool   -> call any current live tool by name
 *    Such clients cannot gain new *individual* tools automatically, but can reach every current tool through the
 *    fallback pair without a restart.
 *
 * Calls are always resolved against the registry's CURRENT snapshot, so a removed tool is refused even if the client
 * still has it in a stale list. The bridge also remembers which definition (fingerprint) of each tool this client was
 * last shown (by tools/list or procmem_list_live_tools); a call to a tool whose definition changed since then is refused
 * with `tool_changed` (never forwarded with arguments built for the old schema) until the client lists again.
 * Results are passed through (known credentials scrubbed by the registry).
 */
export const FALLBACK_LIST = "procmem_list_live_tools";
export const FALLBACK_CALL = "procmem_call_live_tool";
export const BRIDGE_PAGE_SIZE = 200;

const FALLBACK_TOOLS = [
  {
    name: FALLBACK_LIST,
    title: "List live procmem tools",
    description:
      "List every tool currently available through procmem (memory filesystem tools and the integration MCPs deployed for your organization), with full input schemas. Use this when the tool list you were given at startup may be out of date, then call a tool with procmem_call_live_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive filter on tool name or description." },
        source: { type: "string", description: "Optional source filter: 'memory' or an integration slug." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: FALLBACK_CALL,
    title: "Call a live procmem tool",
    description:
      "Call any tool returned by procmem_list_live_tools by its exact name, passing its arguments object. Use it for tools that are missing from your startup tool list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact live tool name, e.g. integration__notify-hub__deliver." },
        arguments: { type: "object", description: "Arguments matching that tool's inputSchema.", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
] as const;

function toMcpTool(t: LiveTool): JsonObject {
  const upstreamMeta = (t.upstream._meta && typeof t.upstream._meta === "object" ? t.upstream._meta : {}) as JsonObject;
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    ...(t.annotations ? { annotations: t.annotations } : {}),
    ...(t.upstream.icons ? { icons: t.upstream.icons } : {}),
    _meta: { ...upstreamMeta, "procmem/source": t.source, "procmem/upstreamName": t.upstreamName, ...(t.integration ? { "procmem/integration": t.integration } : {}) },
  };
}

function describe(t: LiveTool): JsonObject {
  return { name: t.name, source: t.source, upstreamName: t.upstreamName, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations, integration: t.integration };
}

export interface LiveToolsBridge {
  server: Server;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  /** Number of list_changed notifications sent (diagnostics/tests). */
  readonly notificationsSent: number;
}

export function createLiveToolsBridge(source: LiveToolSource, info: { name?: string; version?: string } = {}): LiveToolsBridge {
  const server = new Server(
    { name: info.name ?? "procmem-live-tools", version: info.version ?? "0.2.0" },
    {
      capabilities: { tools: { listChanged: true } },
      supportedProtocolVersions: PINNED_PROTOCOL_VERSIONS,
      instructions:
        "procmem live tools: memory__* are the read-only procedural-memory filesystem tools (call memory__open_memory first); integration__<slug>__* are your organization's deployed integration MCPs. The tool list changes over time; if a tool you expect is missing, call procmem_list_live_tools and use procmem_call_live_tool.",
    },
  );
  let initialized = false;
  let sent = 0;
  /** name -> fingerprint of the definition this client was last shown. */
  const shown = new Map<string, string>();
  const callLive = async (name: string, args: JsonObject, signal: AbortSignal | undefined) => {
    const expected = shown.get(name);
    if (expected === undefined) {
      const exists = source.getTools().some((t) => t.name === name);
      return exists
        ? errorResult("tool_not_listed", `tool ${name} was added after your tool list was fetched; list tools again (tools/list or ${FALLBACK_LIST}) before calling it`)
        : errorResult("tool_not_found", `tool ${name} is not available (it may have been removed); call ${FALLBACK_LIST} for the current tools`);
    }
    const r = await source.callTool(name, args, { signal, expectedFingerprint: expected });
    const code = (r._meta?.["procmem/error"] as { code?: string } | undefined)?.code;
    if (code === "tool_changed") return errorResult("tool_changed", `tool ${name} changed since your tool list was fetched; list tools again (tools/list or ${FALLBACK_LIST}) and retry with the new schema`, { mayHaveExecuted: false });
    return r;
  };
  server.oninitialized = () => {
    initialized = true;
  };

  server.setRequestHandler("tools/list", async (req) => {
    const snapshot = source.getSnapshot();
    const all = [...FALLBACK_TOOLS.map((t) => ({ ...t }) as unknown as JsonObject), ...snapshot.tools.map(toMcpTool)];
    const cursor = req.params?.cursor;
    let offset = 0;
    if (cursor) {
      const m = /^v(\d+):(\d+)$/.exec(cursor);
      if (!m || Number(m[1]) !== snapshot.version) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid or stale cursor: the tool list changed, list again from the start");
      offset = Number(m[2]);
    }
    const page = all.slice(offset, offset + BRIDGE_PAGE_SIZE);
    for (const t of snapshot.tools.slice(Math.max(0, offset - FALLBACK_TOOLS.length), offset + BRIDGE_PAGE_SIZE - FALLBACK_TOOLS.length)) shown.set(t.name, t.fingerprint);
    const next = offset + BRIDGE_PAGE_SIZE < all.length ? `v${snapshot.version}:${offset + BRIDGE_PAGE_SIZE}` : undefined;
    return { tools: page, ...(next ? { nextCursor: next } : {}) } as never;
  });

  server.setRequestHandler("tools/call", async (req, ctx) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as JsonObject;
    const signal = (ctx as { mcpReq?: { signal?: AbortSignal } })?.mcpReq?.signal;
    if (name === FALLBACK_LIST) {
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const src = typeof args.source === "string" ? args.source : "";
      const snapshot = source.getSnapshot();
      const tools = snapshot.tools
        .filter((t) => !src || (src === "memory" ? t.source === "memory" : t.integration?.slug === src))
        .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
      for (const t of tools) shown.set(t.name, t.fingerprint);
      const sources = snapshot.sources.map((s) => ({ source: s.source, state: s.state, toolCount: s.toolCount, ...(s.error ? { error: s.error } : {}) }));
      const structured = { version: snapshot.version, tools: tools.map(describe), sources };
      return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured } as never;
    }
    if (name === FALLBACK_CALL) {
      const target = typeof args.name === "string" ? args.name : "";
      if (!target || target === FALLBACK_CALL || target === FALLBACK_LIST) return errorResult("invalid_arguments", "name must be a live tool name from procmem_list_live_tools") as never;
      const inner = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? (args.arguments as JsonObject) : {};
      return (await callLive(target, inner, signal)) as never;
    }
    return (await callLive(name, args, signal)) as never;
  });

  const unsubscribe = source.onToolsChanged(() => {
    if (!initialized) return;
    server.sendToolListChanged().then(
      () => {
        sent++;
      },
      () => undefined,
    );
  });

  return {
    server,
    connect: (transport) => server.connect(transport),
    async close() {
      unsubscribe();
      await server.close();
    },
    get notificationsSent() {
      return sent;
    },
  };
}
