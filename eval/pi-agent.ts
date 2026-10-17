/**
 * Run ONE real Pi (@earendil-works/pi-coding-agent) agent episode against the notification world.
 *
 * Isolation: a fresh temp dir is used as both `cwd` and `agentDir`, settings and sessions are
 * in-memory, credentials live in an InMemoryCredentialStore (the Fireworks key is injected with
 * ModelRuntime.setRuntimeApiKey, never via auth.json or process.env), no context files / skills /
 * prompt templates / discovered extensions are loaded, and NO built-in coding tools are active:
 * the tool allowlist is exactly the three world tools (+ `mcp__memory__*` in the memory condition).
 *
 * Memory condition: Pi's real MCP extension (createMcpExtension) is loaded with an injected config
 * containing one Streamable-HTTP server named "memory" with `exposure: "direct"`, so its tools are
 * declared to the model as `mcp__memory__<tool>` and every call travels over real MCP.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { evaluateWorld, NotificationWorld, taskPrompt, type OracleResult } from "./world/notifications.js";
import { createWorldTools, WORLD_TOOL_NAMES } from "./world/pi-tools.js";
import { FIREWORKS_BASE_URL, resolveModelId } from "./fireworks.js";

export type Condition = "memory" | "no-memory";
export const MEMORY_SERVER_NAME = "memory";
const MEMORY_TOOL_PREFIX = `mcp__${MEMORY_SERVER_NAME}__`;
/** Resource tools the MCP extension adds when a server offers resources (read-only, MCP-only). */
const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

export interface EpisodeMeta {
  episodeId: string;
  scenario: string;
  model: string;
  condition: Condition;
  objective: string;
}

/** Outcome reported to the trace SDK when the episode ends (the host oracle acts as the customer's checker). */
export interface EpisodeOutcome {
  status: "succeeded" | "failed" | "partial" | "abandoned";
  summary: string;
  evidence?: { source: "client-reported"; details: unknown };
}

/** Per-episode trace capture, typically wrapping TraceRecorder.begin + attachPiTraceCapture. */
export interface EpisodeTrace {
  /** Trace session id (reported in metrics so captured data can be inspected). */
  sessionId?: string;
  /** Attach capture to the live Pi session; return an unsubscribe function. */
  attach(session: AgentSession): (() => void) | void;
  finish(outcome: EpisodeOutcome): Promise<void>;
}
export type TraceSessionFactory = (meta: EpisodeMeta) => Promise<EpisodeTrace> | EpisodeTrace;

export interface McpTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface PiEpisodeOptions {
  apiKey: string;
  /** Alias (kimi|glm|minimax) or full Fireworks model id. */
  model: string;
  scenario: string;
  condition: Condition;
  /** Required for condition "memory". */
  mcp?: McpTarget;
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /**
   * "catalog" (default) uses Pi's bundled Fireworks model definition (kimi/glm: openai-completions on
   * /inference/v1; minimax: Fireworks' anthropic-messages endpoint). "openai" forces the OpenAI-compatible
   * /inference/v1 chat-completions transport for every model.
   */
  transport?: "catalog" | "openai";
  traceSessionFactory?: TraceSessionFactory;
  episodeId?: string;
  /**
   * Offline fixture: use this runtime+model (e.g. Pi's faux provider) instead of Fireworks. The
   * episode is then labeled "scripted-fixture" and `apiKey` is ignored.
   */
  fixtureModel?: { runtime: ModelRuntime; model: Model<Api> };
  /** Optional progress callback (never receives secrets). */
  onEvent?: (line: string) => void;
}

export interface EpisodeMetrics {
  label: "live-model" | "scripted-fixture";
  episodeId: string;
  model: string;
  scenario: string;
  condition: Condition;
  success: boolean;
  duplicates: number;
  missed: number;
  wrong: number;
  failedApiCalls: number;
  totalApiCalls: number;
  memoryToolCalls: number;
  memoryToolNames: string[];
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  latencyMs: number;
  stoppedBy: "completed" | "max-turns" | "max-tool-calls" | "timeout" | "error";
  activeTools: string[];
  oracle: OracleResult;
  finalText?: string;
  traced: boolean;
  traceSessionId?: string;
  error?: string;
}

/** Distinctive fragment of the system prompt, used to verify that traces captured it. */
export const SYSTEM_PROMPT_MARKER = "You are an autonomous operations agent working for a customer.";

const SYSTEM_PROMPT_BASE = [
  "You are an autonomous operations agent working for a customer. You act only through the tools you are given.",
  "There is no human available to answer questions: complete the task end to end, then reply with a brief summary.",
  "Tool results are HTTP-style JSON objects with http_status, headers and body.",
].join("\n");

const SYSTEM_PROMPT_MEMORY = [
  "",
  "You also have read access to your organization's procedural memory: a wiki of workflows learned from previous agents'",
  `work, served by the MCP tools named ${MEMORY_TOOL_PREFIX}*. Before acting, call ${MEMORY_TOOL_PREFIX}open_memory, then use`,
  `${MEMORY_TOOL_PREFIX}read / grep / find / ls on $KNOWLEDGE paths to look up any workflow relevant to the task, and follow it.`,
  "The memory is read-only; do not try to write to it.",
].join("\n");

/** Escape a literal for Pi's config-value resolver (`$NAME`, `${NAME}`, `!command`). */
function literalConfigValue(v: string): string {
  const escaped = v.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export async function createFireworksRuntime(apiKey: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("fireworks", apiKey);
  return runtime;
}

export function resolveFireworksModel(
  runtime: ModelRuntime,
  nameOrId: string,
  transport: "catalog" | "openai" = "catalog",
): Model<Api> {
  const id = resolveModelId(nameOrId);
  const catalog = runtime.getModel("fireworks", id);
  if (!catalog) throw new Error(`Model ${id} is not in Pi's Fireworks catalog.`);
  if (transport === "catalog" || catalog.api === "openai-completions") return catalog;
  return {
    ...catalog,
    api: "openai-completions",
    baseUrl: FIREWORKS_BASE_URL,
    compat: { supportsStore: false, supportsDeveloperRole: false, sendSessionAffinityHeaders: true },
  } as Model<Api>;
}

function memoryExtension(target: McpTarget, logPath: string): ExtensionFactory {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(target.headers ?? {})) headers[k] = literalConfigValue(v);
  return createMcpExtension({
    loadConfig: () => ({
      servers: [
        {
          name: MEMORY_SERVER_NAME,
          scope: "global",
          source: "eval-harness",
          config: {
            type: "http",
            url: target.url,
            headers,
            exposure: "direct",
            timeout: 120,
            description: "Procedural memory wiki (read-only $KNOWLEDGE) and private scratch ($WORK/scratch).",
          },
        },
      ],
      errors: [],
      autoEnableCodemode: false,
    }),
    logPath,
    openUrl: () => {},
    updateConfig: () => {},
    startupWaitMs: 15_000,
  });
}

export interface IsolatedSessionOptions {
  runtime: ModelRuntime;
  model: Model<Api>;
  systemPrompt: string;
  customTools: ToolDefinition[];
  toolAllowlist: string[];
  mcp?: McpTarget;
  thinkingLevel?: PiEpisodeOptions["thinkingLevel"];
}

/** Create a fully isolated Pi session (temp cwd/agentDir, in-memory everything). Caller disposes + cleans dir. */
export async function createIsolatedPiSession(
  opts: IsolatedSessionOptions,
): Promise<{ session: AgentSession; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-eval-"));
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      cacheWarming: "off",
    });
    const extensionFactories: ExtensionFactory[] = [];
    if (opts.mcp) extensionFactories.push(memoryExtension(opts.mcp, join(dir, "mcp.log")));
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: opts.systemPrompt,
      extensionFactories,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel ?? "low",
      modelRuntime: opts.runtime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
      customTools: opts.customTools,
      tools: opts.toolAllowlist,
    });
    // Emits session_start, which makes the MCP extension connect its servers.
    await session.bindExtensions({});
    return { session, dir, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

export async function waitForTools(
  session: AgentSession,
  prefix: string,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const names = session.getActiveToolNames().filter((n) => n.startsWith(prefix));
    if (names.length > 0 || Date.now() > deadline) return names;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function assertNoHostTools(active: string[], allowedExact: string[], allowedPrefix?: string): void {
  const bad = active.filter(
    (n) => !allowedExact.includes(n) && !(allowedPrefix && n.startsWith(allowedPrefix)) && !MCP_RESOURCE_TOOLS.includes(n),
  );
  if (bad.length > 0) throw new Error(`Refusing to run: unexpected active tools ${bad.join(", ")}`);
}

export async function runPiEpisode(opts: PiEpisodeOptions): Promise<EpisodeMetrics> {
  const maxTurns = opts.maxTurns ?? 30;
  const maxToolCalls = opts.maxToolCalls ?? 80;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const modelId = resolveModelId(opts.model);
  const episodeId =
    opts.episodeId ?? `ep-${opts.scenario}-${modelId.split("/").pop()}-${opts.condition}-${Date.now().toString(36)}`;
  const world = NotificationWorld.fromSeed(opts.scenario);
  const objective = taskPrompt(world.spec);
  const started = Date.now();

  let turns = 0;
  let toolCalls = 0;
  let memoryToolCalls = 0;
  const memoryToolNames = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  let stoppedBy: EpisodeMetrics["stoppedBy"] = "completed";
  let error: string | undefined;
  let activeTools: string[] = [];
  let finalText: string | undefined;
  let trace: EpisodeTrace | undefined;
  let session: AgentSession | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let unsubscribeTrace: (() => void) | void = undefined;
  let timer: NodeJS.Timeout | undefined;

  if (opts.condition === "memory" && !opts.mcp) throw new Error("condition=memory requires an MCP target");

  try {
    const runtime = opts.fixtureModel?.runtime ?? (await createFireworksRuntime(opts.apiKey));
    const model = opts.fixtureModel?.model ?? resolveFireworksModel(runtime, modelId, opts.transport);
    const worldTools = createWorldTools(world, {
      beforeCall: () => (toolCalls > maxToolCalls ? "Tool-call budget exhausted; stop and summarize." : undefined),
    });
    const allow = [...WORLD_TOOL_NAMES, ...(opts.condition === "memory" ? [`${MEMORY_TOOL_PREFIX}*`] : [])];
    const created = await createIsolatedPiSession({
      runtime,
      model,
      systemPrompt: SYSTEM_PROMPT_BASE + (opts.condition === "memory" ? SYSTEM_PROMPT_MEMORY : ""),
      customTools: worldTools,
      toolAllowlist: allow,
      ...(opts.condition === "memory" && opts.mcp ? { mcp: opts.mcp } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });
    session = created.session;
    cleanup = created.cleanup;
    if (opts.condition === "memory") {
      const memTools = await waitForTools(session, MEMORY_TOOL_PREFIX, 20_000);
      if (memTools.length === 0) throw new Error("memory MCP server did not expose any tools within 20s");
    }
    activeTools = session.getActiveToolNames().slice().sort();
    assertNoHostTools(activeTools, [...WORLD_TOOL_NAMES], opts.condition === "memory" ? MEMORY_TOOL_PREFIX : undefined);
    opts.onEvent?.(`[${episodeId}] tools: ${activeTools.join(", ")}`);

    if (opts.traceSessionFactory) {
      trace = await opts.traceSessionFactory({
        episodeId,
        scenario: opts.scenario,
        model: modelId,
        condition: opts.condition,
        objective,
      });
      unsubscribeTrace = trace.attach(session);
    }

    const s = session;
    const stop = (why: EpisodeMetrics["stoppedBy"]) => {
      if (stoppedBy === "completed") stoppedBy = why;
      void s.abort().catch(() => {});
    };
    s.subscribe((event) => {
      if (event.type === "turn_end") {
        turns += 1;
        if (turns >= maxTurns) stop("max-turns");
      } else if (event.type === "tool_execution_start") {
        toolCalls += 1;
        if (event.toolName.startsWith(MEMORY_TOOL_PREFIX) || MCP_RESOURCE_TOOLS.includes(event.toolName)) {
          memoryToolCalls += 1;
          memoryToolNames.add(event.toolName);
        }
        opts.onEvent?.(`[${episodeId}] tool ${event.toolName}`);
        if (toolCalls > maxToolCalls) stop("max-tool-calls");
      } else if (event.type === "message_end") {
        const m = event.message as { role?: string; usage?: Record<string, unknown>; stopReason?: string; errorMessage?: string };
        if (m.role === "assistant" && m.usage) {
          const u = m.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
          inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          cacheReadTokens += u.cacheRead ?? 0;
          outputTokens += u.output ?? 0;
          costUsd += u.cost?.total ?? 0;
          if (m.stopReason === "error" && m.errorMessage) error = m.errorMessage.slice(0, 500);
        }
      }
    });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    await s.prompt(objective);
    await s.waitForIdle().catch(() => {});
    finalText = s.getLastAssistantText()?.slice(0, 4000);
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
    if (stoppedBy === "completed") stoppedBy = "error";
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (error && stoppedBy === "completed") stoppedBy = "error";

  const oracle = evaluateWorld(world);
  if (trace) {
    try {
      await trace.finish({
        status: oracle.success ? "succeeded" : oracle.delivered > 0 ? "partial" : "failed",
        summary:
          `Re-deliver failed ${world.spec.channel} notifications: ${oracle.success ? "succeeded" : "did not fully succeed"} ` +
          `(eligible=${oracle.eligible}, delivered=${oracle.delivered}, duplicates=${oracle.duplicates}, missed=${oracle.missed}, ` +
          `wrong=${oracle.wrong}, failed_api_calls=${oracle.failedCalls}/${oracle.totalCalls}; stopped_by=${stoppedBy}).`,
        evidence: {
          source: "client-reported",
          details: {
            checker: "host-oracle",
            success: oracle.success,
            duplicates: oracle.duplicates,
            duplicateIds: oracle.duplicateIds,
            missed: oracle.missed,
            missedIds: oracle.missedIds,
            wrong: oracle.wrong,
            wrongIds: oracle.wrongIds,
            apiCallStatuses: world.log.map((l) => `${l.op}:${l.status}`),
          },
        },
      });
    } catch (e) {
      error = (error ? error + "; " : "") + `trace finish failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    }
  }
  try {
    if (typeof unsubscribeTrace === "function") unsubscribeTrace();
  } catch {
    // ignore
  }
  session?.dispose();
  await cleanup?.();

  return {
    label: opts.fixtureModel ? "scripted-fixture" : "live-model",
    episodeId,
    model: modelId,
    scenario: opts.scenario,
    condition: opts.condition,
    success: oracle.success,
    duplicates: oracle.duplicates,
    missed: oracle.missed,
    wrong: oracle.wrong,
    failedApiCalls: oracle.failedCalls,
    totalApiCalls: oracle.totalCalls,
    memoryToolCalls,
    memoryToolNames: [...memoryToolNames].sort(),
    turns,
    toolCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    latencyMs: Date.now() - started,
    stoppedBy,
    activeTools,
    oracle,
    ...(finalText !== undefined ? { finalText } : {}),
    traced: Boolean(trace),
    ...(trace?.sessionId ? { traceSessionId: trace.sessionId } : {}),
    ...(error ? { error } : {}),
  };
}
