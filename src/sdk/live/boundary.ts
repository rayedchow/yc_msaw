import { diffSnapshots, errorResult, type CallOptions, type JsonObject, type LiveTool, type LiveToolResult, type LiveToolSource, type ToolsChange, type ToolsSnapshot } from "./types.js";

/**
 * Generic harness adapter: a turn-stable view over a live registry.
 *
 * The registry changes whenever the catalog or an upstream server changes. A harness must not swap a model's tool
 * list in the middle of a model request, so this view holds an APPLIED snapshot and only adopts the registry's latest
 * snapshot when the harness calls `sync()` at a safe point (before a model request is built, between turns, or while
 * idle). `pending` tells the harness a newer snapshot is waiting.
 *
 *   const view = new ToolBoundary(registry);
 *   loop: { view.sync(); const tools = view.getTools(); const reply = await model({ tools }); ...
 *           for (const call of reply.toolCalls) results.push(await view.callTool(call.name, call.args)); }
 *
 * Calls are fail-closed in every direction: a name outside the applied snapshot is refused; a name the registry has
 * since removed is refused even if it is still in the applied snapshot; and a tool whose definition changed since the
 * applied snapshot is refused (`tool_changed`) until the next sync() publishes the new definition.
 */
export class ToolBoundary {
  #applied: ToolsSnapshot;
  #listeners = new Set<(change: ToolsChange) => void>();
  #pendingListeners = new Set<() => void>();
  #unsubscribe: (() => void) | null;

  constructor(private readonly source: LiveToolSource) {
    this.#applied = source.getSnapshot();
    this.#unsubscribe = source.onToolsChanged(() => {
      for (const l of this.#pendingListeners) l();
    });
  }

  /** True when the registry has a newer snapshot than the one applied. */
  get pending(): boolean {
    return this.source.getSnapshot().version !== this.#applied.version;
  }

  get snapshot(): ToolsSnapshot {
    return this.#applied;
  }

  getTools(): readonly LiveTool[] {
    return this.#applied.tools;
  }

  /** Adopt the registry's latest snapshot. Call ONLY at a safe boundary. Returns the change, or null if none. */
  sync(): ToolsChange | null {
    const next = this.source.getSnapshot();
    if (next.version === this.#applied.version) return null;
    const change = diffSnapshots(this.#applied, next);
    this.#applied = next;
    for (const l of this.#listeners) l(change);
    return change;
  }

  /** Fires after `sync()` applied a change (tools added/updated/removed in the harness-visible set). */
  onToolsChanged(listener: (change: ToolsChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Fires when a newer registry snapshot becomes pending (e.g. to wake an idle harness). */
  onPending(listener: () => void): () => void {
    this.#pendingListeners.add(listener);
    return () => this.#pendingListeners.delete(listener);
  }

  /**
   * Call a tool from the APPLIED snapshot. The applied definition's fingerprint is sent as `expectedFingerprint`, so if
   * the registry changed that tool since this turn's list was built (schema, description, deployment), the call is
   * refused with `tool_changed` instead of forwarding arguments built for the old definition.
   */
  async callTool(name: string, args: JsonObject | undefined, options?: CallOptions): Promise<LiveToolResult> {
    const applied = this.#applied.tools.find((t) => t.name === name);
    if (!applied) return errorResult("tool_not_available", `tool ${name} is not available in this turn`);
    return this.source.callTool(name, args, { ...options, expectedFingerprint: options?.expectedFingerprint ?? applied.fingerprint });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listeners.clear();
    this.#pendingListeners.clear();
  }
}
