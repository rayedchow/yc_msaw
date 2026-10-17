import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ToolBoundary } from "./boundary.js";
import type { JsonObject, LiveTool, LiveToolResult, LiveToolSource, ToolsChange } from "./types.js";

/**
 * Pi coding agent (@earendil-works/pi-coding-agent 1.3) adapter: keeps a live registry's tools registered in the
 * SAME Pi session as tools are added, changed and removed. Type-only imports; no runtime dependency on Pi.
 *
 * How it maps onto the Pi extension API (installed 1.3 source):
 *  - add:     pi.registerTool(def)                     new direct tools are activated on registration
 *  - update:  pi.registerTool(def) with the same name  Pi replaces the definition (Map.set) and keeps active state
 *  - remove:  re-register with exposure "hidden"       Pi has no unregisterTool; hidden tools are never declared,
 *             and deactivate via setActiveTools        and execute() refuses because the registry dropped the name
 *  - active set: pi.getActiveTools()/setActiveTools() — unrelated host tools are left exactly as they are, and a live
 *    tool the user disabled stays disabled across schema updates (until the user re-enables it).
 *
 * Changes are applied only at safe points — session_start, before_agent_start, turn_end (before the next turn's tool
 * snapshot), or immediately when the session is idle — never while a model request is in flight. Pi snapshots the
 * tool list per turn, and every registered execute() carries the fingerprint of the definition the model was shown:
 * if the registry changed that tool meanwhile, the call is refused (`tool_changed`) rather than forwarding arguments
 * built for the old schema, and the new definition is registered at the next safe point.
 *
 * Re-binding: if Pi runs the extension factory again (reload, new session in the same process), every live tool is
 * registered again on the new ExtensionAPI at its session_start. Tools the user disabled stay disabled across
 * updates, absences and re-binds until the user re-enables them.
 */
export interface PiLiveToolsOptions {
  /** Apply pending changes as soon as they arrive while the session is idle. Default true. */
  applyWhenIdle?: boolean;
  /** Called after each applied change (names only, for logging/tests). */
  onApplied?: (change: { added: string[]; updated: string[]; removed: string[]; active: string[] }) => void;
  /** Called if applying failed (e.g. Pi rejected a definition); the next safe point retries a full apply. */
  onError?: (error: unknown) => void;
}

export interface PiLiveTools {
  /** Pass to DefaultResourceLoader({ extensionFactories: [...] }) or load as an extension. */
  extension: ExtensionFactory;
  /** Turn-stable view the adapter applies (exposed for tests and custom loops). */
  boundary: ToolBoundary;
  /** Apply pending changes now. Only call when the session is idle. Returns the change, or null. */
  applyNow(): ToolsChange | null;
  dispose(): void;
}

type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** MCP CallToolResult -> Pi AgentToolResult. Every block is kept: text/images to the model, everything in details. */
export function mcpResultToPi(result: LiveToolResult, tool: Pick<LiveTool, "name" | "source" | "upstreamName">) {
  const content: PiContent[] = [];
  const detailBlocks: JsonObject[] = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      detailBlocks.push(block);
    } else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
      // The bytes are already in `content`; keep everything else about the block.
      const { data: _data, ...rest } = block;
      detailBlocks.push({ ...rest, inContent: true, bytesBase64Length: (block.data as string).length });
    } else {
      // audio, embedded resources, resource links: no Pi model block type, so the model gets the JSON verbatim.
      content.push({ type: "text", text: JSON.stringify(block) });
      detailBlocks.push(block);
    }
  }
  if (content.length === 0 && result.structuredContent !== undefined) content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  if (content.length === 0) content.push({ type: "text", text: result.isError ? "(tool error with no content)" : "(no content)" });
  const { content: _c, ...rest } = result;
  return {
    content,
    details: { source: tool.source, upstreamName: tool.upstreamName, liveName: tool.name, mcp: { ...rest, content: detailBlocks } } as unknown as JsonObject,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent as never } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

function liveDefinition(tool: LiveTool, boundary: ToolBoundary): ToolDefinition {
  const def = {
    name: tool.name,
    label: tool.title ?? `${tool.upstreamName} (${tool.integration ? tool.integration.slug : "memory"})`,
    description: tool.description,
    parameters: tool.inputSchema as never,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as never } : {}),
    ...(tool.annotations ? { annotations: tool.annotations as never } : {}),
    exposure: "direct" as const,
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined) {
      const args = params && typeof params === "object" && !Array.isArray(params) ? (params as JsonObject) : {};
      return mcpResultToPi(await boundary.callTool(tool.name, args, { signal, expectedFingerprint: tool.fingerprint }), tool);
    },
  };
  return def as unknown as ToolDefinition;
}

function hiddenDefinition(name: string): ToolDefinition {
  return {
    name,
    label: `${name} (removed)`,
    description: "This live tool was removed and is no longer available.",
    parameters: { type: "object", properties: {} } as never,
    exposure: "hidden",
    async execute() {
      return { content: [{ type: "text", text: `procmem: tool ${name} was removed and is not available` }], details: undefined, isError: true };
    },
  } as unknown as ToolDefinition;
}

export function createPiLiveTools(source: LiveToolSource, options: PiLiveToolsOptions = {}): PiLiveTools {
  const boundary = new ToolBoundary(source);
  /** name -> fingerprint registered on the CURRENT ExtensionAPI, or "hidden" for a removed tool. */
  let registered = new Map<string, string>();
  /** Live tools we left active after the last apply (to detect a user disabling one). */
  let leftActive = new Set<string>();
  /** Live tools the user disabled. Kept while a tool is absent; cleared only when the user re-activates it. */
  const userDisabled = new Set<string>();
  let pi: ExtensionAPI | null = null;
  let ctx: ExtensionContext | null = null;
  let bound = false;
  let applying = false;
  let disposed = false;
  /** Set when an apply did not complete; the next safe point does a full apply. */
  let needsFull = true;
  const unsubs: Array<() => void> = [];
  let sessionUnsubs: Array<() => void> = [];

  const apply = (force: boolean): ToolsChange | null => {
    if (!pi || !bound || disposed || applying) return null;
    applying = true;
    try {
      const change = boundary.sync();
      if (!change && !force && !needsFull) return null;
      needsFull = true;
      const tools = boundary.getTools();
      const names = new Set(tools.map((t) => t.name));
      const activeBefore = new Set(pi.getActiveTools());
      for (const n of leftActive) if (!activeBefore.has(n)) userDisabled.add(n);
      for (const n of [...userDisabled]) if (activeBefore.has(n)) userDisabled.delete(n);

      const added: string[] = [];
      const updated: string[] = [];
      const removed: string[] = [];
      for (const t of tools) {
        const prev = registered.get(t.name);
        if (prev === t.fingerprint) continue;
        pi.registerTool(liveDefinition(t, boundary));
        (prev === undefined || prev === "hidden" ? added : updated).push(t.name);
        registered.set(t.name, t.fingerprint);
      }
      for (const [name, fp] of registered) {
        if (names.has(name) || fp === "hidden") continue;
        pi.registerTool(hiddenDefinition(name));
        registered.set(name, "hidden");
        removed.push(name);
      }
      const ours = (n: string) => registered.has(n);
      const current = pi.getActiveTools();
      const desired = current.filter((n) => !ours(n) || (names.has(n) && !userDisabled.has(n)));
      for (const n of names) if (!userDisabled.has(n) && !desired.includes(n)) desired.push(n);
      // Only touch the loadout when it must change: a deactivating setActiveTools also clears Pi's pending restored names.
      const same = desired.length === current.length && desired.every((n) => current.includes(n));
      if (!same) pi.setActiveTools(desired);
      const active = pi.getActiveTools();
      leftActive = new Set(active.filter((n) => names.has(n)));
      needsFull = false;
      options.onApplied?.({ added, updated, removed, active });
      return change;
    } catch (error) {
      needsFull = true;
      options.onError?.(error);
      return null;
    } finally {
      applying = false;
    }
  };

  const extension: ExtensionFactory = (api) => {
    // (Re)bind: a new ExtensionAPI has none of our tools yet; register everything at its session_start.
    for (const u of sessionUnsubs.splice(0)) u();
    pi = api;
    bound = false;
    ctx = null;
    registered = new Map();
    leftActive = new Set();
    needsFull = true;
    const unsubs = sessionUnsubs;
    unsubs.push(
      api.on("session_start", (_e, c) => {
        ctx = c;
        bound = true;
        apply(true);
      }),
    );
    unsubs.push(
      api.on("before_agent_start", (_e, c) => {
        ctx = c;
        apply(false);
      }),
    );
    unsubs.push(
      api.on("turn_end", (_e, c) => {
        ctx = c;
        apply(false);
      }),
    );
    unsubs.push(
      api.on("session_shutdown", () => {
        bound = false;
      }),
    );
  };

  unsubs.push(
    boundary.onPending(() => {
      if (options.applyWhenIdle === false || !ctx) return;
      try {
        if (ctx.isIdle()) apply(false);
      } catch {
        // stale context (session disposed): ignore; the next session event applies
      }
    }),
  );

  return {
    extension,
    boundary,
    applyNow: () => apply(false),
    dispose() {
      disposed = true;
      for (const u of sessionUnsubs.splice(0)) u();
      for (const u of unsubs.splice(0)) u();
      boundary.dispose();
    },
  };
}
