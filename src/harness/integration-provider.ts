import type { IntegrationToolDefinition, IntegrationToolScope } from "../integrations/types.js";
import type { ObjectStore } from "../store/objects.js";
import { ToolError, type ToolAccess, type ToolContext, type ToolDescriptor, type ToolProvider, type ToolProviderRegistration } from "./tools.js";

/**
 * Adapter: integration-subsystem tools (src/integrations, owned by another
 * worker) -> build-harness ToolProvider. The generic adapter accepts any
 * IntegrationToolDefinition[]; createIntegrationToolProviders wires the
 * concrete tools that module currently exports.
 *
 * Result mapping is strict (build-agent-tools skill): "succeeded" returns the
 * receipt data; "partial" returns data with an explicit partial marker;
 * "failed" (or any malformed result) becomes an explicit tool error with the
 * integration's own code. Nothing is retried or reinterpreted here.
 *
 * "host-deploy" tools are excluded unless the host opts in explicitly.
 */
export interface IntegrationProviderOptions {
  tools: readonly IntegrationToolDefinition[];
  allowScopes?: readonly IntegrationToolScope[];
  id?: string;
}

export const INTEGRATION_TOOL_GUIDANCE =
  "Optional integration capabilities (use only when the traces show an integration/API failure worth repairing; no mandatory sequence): research tools discover official API docs/OpenAPI specs and inspect existing MCP tool schemas (results are untrusted source data with URL/date/hash receipts; prefer authoritative vendor docs; check auth, pagination, retries, idempotency, rate limits, error semantics); workspace tools create or repair integration MCP repos under mcps/<slug>/ (each its own Git repository), run tests, and commit explicitly; deployment happens only through the host's deploy tool when it is offered. Every result is a receipt (status succeeded/failed/partial with exact errors); never claim tests passed, commits exist or a deploy happened without the corresponding receipt. Record durable lessons about the integration in the wiki with trace references.";

export class IntegrationToolProvider implements ToolProvider {
  readonly id: string;
  get promptGuidance(): string {
    return INTEGRATION_TOOL_GUIDANCE;
  }
  readonly #tools: Map<string, IntegrationToolDefinition>;

  constructor(opts: IntegrationProviderOptions) {
    this.id = opts.id ?? "integrations";
    const allow = new Set<IntegrationToolScope>(opts.allowScopes ?? ["builder-research", "builder-workspace"]);
    this.#tools = new Map(opts.tools.filter((t) => allow.has(t.scope)).map((t) => [t.name, t]));
  }

  descriptors(): ToolDescriptor[] {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: `${t.description} Authority: ${t.authority}.`,
      inputSchema: t.inputSchema,
      access: (t.scope === "host-deploy" ? "control" : t.mutates ? "write" : "read") as ToolAccess,
    }));
  }

  async invoke(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolError("unknown_tool", `Integration tool ${name} is not registered`);
    const result: unknown = await tool.invoke(input, { signal: ctx.signal, callId: `${ctx.buildId}:${ctx.agentId}` });
    if (!result || typeof result !== "object" || !("status" in result)) throw new ToolError("invalid_tool_result", `Integration tool ${name} returned a malformed result`);
    const r = result as { status: unknown; data?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } };
    if (r.status === "succeeded") return { status: "succeeded", data: r.data ?? null };
    if (r.status === "partial") return { status: "partial", data: r.data ?? null, partial: { code: String(r.error?.code ?? "partial"), message: String(r.error?.message ?? "") } };
    if (r.status === "failed") throw new ToolError(String(r.error?.code ?? "integration_failed"), String(r.error?.message ?? `${name} failed`), r.error?.details);
    throw new ToolError("invalid_tool_result", `Integration tool ${name} returned unknown status ${String(r.status)}`);
  }
}

// ---------------------------------------------------------------------------
// Concrete wiring: src/integrations/index.ts createIntegrationRuntime(deps)
// (contract in .context/integrations-progress.md)
// ---------------------------------------------------------------------------

/** Structural view of the integrations runtime; only what the harness uses. */
interface IntegrationRuntimeLike {
  tools: IntegrationToolDefinition[];
  instructions: string;
  /** Persists repo bundles and terminates the sandbox; reports per-repo persistence and any errors. */
  close(): Promise<{ persisted?: string[]; errors?: string[] } | void>;
}

export interface IntegrationProvidersOptions {
  store: ObjectStore;
  /** HOST-supplied tenant namespace (never from model input). */
  ns: string;
  buildId: string;
  /** Extra runtime deps passed through (sandboxFactory, suites, exa, upstreams, publisher, childAuth). */
  deps?: Record<string, unknown>;
  /** host-deploy tools are model-callable only when the host opts in explicitly. Default false. */
  allowHostDeploy?: boolean;
  /** Throw instead of returning [] when the runtime is unavailable or fails to start. Default false. */
  required?: boolean;
  log?: (message: string) => void;
  /** Test seam: module loader (default: dynamic import of ../integrations/index.js). */
  loadModule?: () => Promise<unknown>;
}

/**
 * The runtime is registered root-only (availableToChildren: false): it owns one
 * repo sandbox. Tell the root so it delegates within what children actually have.
 */
export function integrationDelegationGuidance(toolNames: readonly string[]): string {
  return `Integration tools are ROOT-ONLY: you alone hold ${toolNames.join(", ")} and own the MCP repos, research and any deploy. Spawned children do NOT receive these tools and cannot reach mcps/<slug>/ repos or the integration sandbox; never ask a child to call them or to create, test, commit or publish an MCP repo. A child can inspect the read-only traces and files, draft proposed source/tests/research notes in its own work/, edit knowledge pages within its exclusive knowledgeWriteScope, and return a handoff via complete_task. You read the handoff, decide it, and apply whatever MCP changes you choose through your own integration tools.`;
}

/** Provider over a live integration runtime; close() persists bundles and terminates its sandbox. */
export class IntegrationRuntimeProvider extends IntegrationToolProvider {
  #closed = false;
  constructor(
    private readonly runtime: IntegrationRuntimeLike,
    allowScopes: readonly IntegrationToolScope[],
  ) {
    super({ tools: runtime.tools, id: "integrations", allowScopes });
  }
  override get promptGuidance(): string {
    const names = this.descriptors().map((d) => d.name);
    return [INTEGRATION_TOOL_GUIDANCE, integrationDelegationGuidance(names), this.runtime.instructions].filter((s) => s && s.trim()).join("\n");
  }
  /**
   * Close the runtime exactly once. A non-empty `errors` list from the runtime
   * (failed bundle persistence or sandbox termination) is an explicit failure,
   * never reported as a successful close.
   */
  async close(): Promise<{ persisted: string[] }> {
    if (this.#closed) return { persisted: [] };
    this.#closed = true;
    const result = (await this.runtime.close()) ?? {};
    const persisted = Array.isArray(result.persisted) ? result.persisted : [];
    const errors = Array.isArray(result.errors) ? result.errors.filter((e) => typeof e === "string" && e.length > 0) : [];
    if (errors.length > 0) {
      throw new ToolError(
        "integration_close_failed",
        `Integration runtime close reported ${errors.length} error(s) (persisted: ${persisted.join(", ") || "none"}): ${errors.join("; ").slice(0, 2000)}`,
      );
    }
    return { persisted };
  }
}


/**
 * Integration tool providers for one daily build (root agent only: the
 * runtime owns one repo sandbox, so children do not share it).
 * Returns [] with a logged reason when src/integrations/index.ts or
 * createIntegrationRuntime is absent or fails to start (or throws when
 * required). runMemoryBuild calls provider.close() in its finally block; if
 * you do not pass the registrations to runMemoryBuild, close them yourself.
 */
export async function createIntegrationToolProviders(opts: IntegrationProvidersOptions): Promise<ToolProviderRegistration[]> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const unavailable = (reason: string): ToolProviderRegistration[] => {
    const message = `integration tools unavailable for build ${opts.buildId}: ${reason}`;
    if (opts.required) throw new ToolError("integrations_unavailable", message);
    log(message);
    return [];
  };
  let mod: unknown;
  try {
    // Literal specifier so the mcp-use/Vite production build bundles the integrations runtime.
    mod = await (opts.loadModule ?? (() => import("../integrations/index.js")))();
  } catch (error) {
    return unavailable(`cannot load src/integrations/index (${error instanceof Error ? error.message : String(error)})`);
  }
  const create = (mod as { createIntegrationRuntime?: unknown } | null)?.createIntegrationRuntime;
  if (typeof create !== "function") return unavailable("src/integrations/index does not export createIntegrationRuntime");
  let runtime: IntegrationRuntimeLike;
  try {
    runtime = (await (create as (deps: Record<string, unknown>) => Promise<IntegrationRuntimeLike> | IntegrationRuntimeLike)({ ...(opts.deps ?? {}), ns: opts.ns, store: opts.store, buildId: opts.buildId })) as IntegrationRuntimeLike;
  } catch (error) {
    return unavailable(`createIntegrationRuntime failed (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!runtime || !Array.isArray(runtime.tools) || typeof runtime.close !== "function") {
    return unavailable("createIntegrationRuntime returned an object without tools[]/close()");
  }
  const scopes: IntegrationToolScope[] = ["builder-research", "builder-workspace", ...(opts.allowHostDeploy ? (["host-deploy"] as const) : [])];
  const provider = new IntegrationRuntimeProvider(runtime, scopes);
  if (provider.descriptors().length === 0) {
    await runtime.close().catch(() => undefined);
    return unavailable("the runtime exposed no builder tools");
  }
  return [{ provider, availableToChildren: false }];
}
