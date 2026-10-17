/**
 * End-to-end procedural-memory eval.
 *
 *   Phase A (train day): agents of the TRAIN model run the train scenarios with trace capture.
 *   Build: the injected daily build turns that day's traces into a published memory revision.
 *   Phase B (held-out): fresh agents of DIFFERENT models run held-out scenarios WITH the memory MCP
 *   vs WITHOUT it (baseline); the host oracle scores every run.
 *
 * Modes: "live" (real Pi agents on Fireworks models) or "scripted-fixture" (Pi faux model driven by
 * scripted policies; no LLM; never to be presented as model results).
 *
 * Programmatic: `runEval(deps, options)`. CLI: see `usage()` below.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TraceTransport } from "../src/sdk/index.js";
import {
  FireworksAuthError,
  loadFireworksKey,
  parseDotEnv,
  resolveModelId,
  sanitize,
  shortModelName,
  validateFireworksKey,
} from "./fireworks.js";
import { startFixtureMemoryServer } from "./fixture-memory-server.js";
import { runPiEpisode, type Condition, type EpisodeMetrics, type McpTarget } from "./pi-agent.js";
import { createScriptedFixtureModel, scriptedNotificationAgent } from "./scripted-driver.js";
import type { ScriptedPolicyName } from "./scripted-policies.js";
import { InspectingTraceTransport, traceFactoryFromTransport, type CaptureInspection } from "./trace-adapter.js";
import { buildScenario, HELDOUT_SCENARIOS, TRAIN_SCENARIOS } from "./world/notifications.js";

export type BuildReceipt = Record<string, unknown>;
export type EvalMode = "live" | "scripted-fixture";

export interface RunEvalDeps {
  /** Customer memory MCP endpoint (Streamable HTTP, e.g. `${url}/mcp`) used in the memory condition. */
  mcpUrl: string;
  /** Headers for the MCP endpoint (e.g. Authorization: Bearer <tenant key>). Redacted from reports. */
  mcpHeaders?: Record<string, string>;
  /** Fresh trace transport for phase-A capture (HttpTraceTransport or InProcessTraceTransport). */
  traceTransportFactory?: () => TraceTransport;
  /** Run the SAME daily build function the product uses for the train day; resolves to its receipt. */
  triggerDailyBuild: () => Promise<BuildReceipt>;
  /** Fireworks key (live mode only). Never logged or written. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface RunEvalOptions {
  mode: EvalMode;
  /** Model of the day-1 (train) agents. Alias kimi|glm|minimax or full id. */
  trainModel: string;
  /** Models of the held-out agents; should differ from trainModel. */
  evalModels: string[];
  trainScenarios?: string[];
  heldoutScenarios?: string[];
  conditions?: Condition[];
  repeats?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  concurrency?: number;
  /** Also trace held-out runs (default false, so they do not feed the next build). */
  traceHeldout?: boolean;
  /** Live mode: fail the trace check unless some captured model_input has the system prompt + tool specs. Default true. */
  requireFullModelInputCapture?: boolean;
  /** Offline mode policies. */
  scriptedTrainPolicy?: ScriptedPolicyName;
  scriptedBasePolicy?: ScriptedPolicyName;
  scriptedMemoryPolicy?: ScriptedPolicyName;
  /** Directory for eval-<timestamp>.json/.md; null disables writing. Default "reports". */
  reportDir?: string | null;
}

export interface RunRecord extends EpisodeMetrics {
  phase: "train" | "heldout";
  repeat: number;
  traceCapture?: CaptureInspection;
}

export interface AggregateRow {
  model: string;
  condition: Condition;
  runs: number;
  successRate: number;
  avgDuplicates: number;
  avgMissed: number;
  avgWrong: number;
  avgFailedApiCalls: number;
  avgTotalApiCalls: number;
  avgMemoryToolCalls: number;
  avgTurns: number;
  avgToolCalls: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  errors: number;
}

export interface EvalReport {
  kind: "procedural-memory-eval";
  label: EvalMode;
  labelNote: string;
  createdAt: string;
  config: Omit<RunEvalOptions, "reportDir"> & { mcpUrl: string; trainModelId: string; evalModelIds: string[] };
  fireworks?: { modelsListed: string[] };
  phaseA: RunRecord[];
  build: { receipt: BuildReceipt | null; publishedRevision: string | null; error?: string; durationMs: number };
  phaseB: RunRecord[];
  checks: {
    trainRunsTraced: boolean;
    traceCapturesPromptAndTools: boolean | null;
    evalModelsDifferFromTrain: boolean;
  };
  aggregates: AggregateRow[];
  files?: { json: string; markdown: string };
}

// ---------------------------------------------------------------------------------------------

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Find the published revision id in an arbitrary build receipt. */
export function findRevision(receipt: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== "object" || depth > 4 || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const k of ["publishedRevision", "publishedRevisionId", "revisionId", "revision", "rev"]) {
      const x = o[k];
      if (typeof x === "string" && x) return x;
      if (x && typeof x === "object") {
        const id = (x as Record<string, unknown>).id ?? (x as Record<string, unknown>).revisionId;
        if (typeof id === "string") return id;
      }
    }
    for (const x of Object.values(o)) {
      const r = walk(x, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(receipt, 0);
}

function avg(xs: number[]): number {
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0;
}

export function aggregate(runs: RunRecord[]): AggregateRow[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = `${r.model}\u0000${r.condition}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => ({
    model: rs[0]!.model,
    condition: rs[0]!.condition,
    runs: rs.length,
    successRate: avg(rs.map((r) => (r.success ? 1 : 0))),
    avgDuplicates: avg(rs.map((r) => r.duplicates)),
    avgMissed: avg(rs.map((r) => r.missed)),
    avgWrong: avg(rs.map((r) => r.wrong)),
    avgFailedApiCalls: avg(rs.map((r) => r.failedApiCalls)),
    avgTotalApiCalls: avg(rs.map((r) => r.totalApiCalls)),
    avgMemoryToolCalls: avg(rs.map((r) => r.memoryToolCalls)),
    avgTurns: avg(rs.map((r) => r.turns)),
    avgToolCalls: avg(rs.map((r) => r.toolCalls)),
    avgInputTokens: avg(rs.map((r) => r.inputTokens)),
    avgOutputTokens: avg(rs.map((r) => r.outputTokens)),
    avgLatencyMs: avg(rs.map((r) => r.latencyMs)),
    totalCostUsd: Math.round(rs.reduce((a, r) => a + r.costUsd, 0) * 1e4) / 1e4,
    errors: rs.filter((r) => r.error).length,
  }));
}

export function renderMarkdown(rep: EvalReport): string {
  const L: string[] = [];
  const banner =
    rep.label === "live"
      ? "**LIVE MODEL RUNS** (real Pi agents on Fireworks models; host oracle scoring)"
      : "**SCRIPTED FIXTURE** (Pi faux model driven by scripted policies; NOT model results)";
  L.push(`# Procedural memory eval — ${rep.createdAt}`, "", banner, "");
  L.push(`- Train model: \`${rep.config.trainModelId}\` on ${(rep.config.trainScenarios ?? []).join(", ")}`);
  L.push(`- Held-out models: ${rep.config.evalModelIds.map((m) => `\`${m}\``).join(", ")} on ${(rep.config.heldoutScenarios ?? []).join(", ")}`);
  L.push(`- Published revision: \`${rep.build.publishedRevision ?? "unknown"}\`${rep.build.error ? ` (build error: ${rep.build.error})` : ""}`);
  L.push(
    `- Checks: trainRunsTraced=${rep.checks.trainRunsTraced}, traceCapturesPromptAndTools=${rep.checks.traceCapturesPromptAndTools}, evalModelsDifferFromTrain=${rep.checks.evalModelsDifferFromTrain}`,
  );
  L.push("", "## Phase A (train day, traced)", "");
  L.push("| scenario | model | success | dup | missed | wrong | failed/total API | turns | tokens in/out | trace (events, sysprompt, tools) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rep.phaseA) {
    const t = r.traceCapture;
    L.push(
      `| ${r.scenario} | ${shortModelName(r.model)} | ${r.success ? "yes" : "no"} | ${r.duplicates} | ${r.missed} | ${r.wrong} | ${r.failedApiCalls}/${r.totalApiCalls} | ${r.turns} | ${r.inputTokens}/${r.outputTokens} | ${t ? `${t.events}, ${t.modelInputHasSystemPrompt}, ${t.modelInputHasToolSpecs}` : "-"} |`,
    );
  }
  L.push("", "## Phase B (held-out): memory vs no-memory", "");
  L.push("| model | condition | runs | success | avg dup | avg missed | avg wrong | avg failed API | avg API calls | avg memory calls | avg turns | avg tokens in/out | avg latency s | cost $ | errors |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of rep.aggregates) {
    L.push(
      `| ${shortModelName(a.model)} | ${a.condition} | ${a.runs} | ${Math.round(a.successRate * 100)}% | ${a.avgDuplicates} | ${a.avgMissed} | ${a.avgWrong} | ${a.avgFailedApiCalls} | ${a.avgTotalApiCalls} | ${a.avgMemoryToolCalls} | ${a.avgTurns} | ${a.avgInputTokens}/${a.avgOutputTokens} | ${Math.round(a.avgLatencyMs / 100) / 10} | ${a.totalCostUsd} | ${a.errors} |`,
    );
  }
  L.push("", "## Phase B runs", "");
  L.push("| scenario | model | condition | rep | success | dup | missed | wrong | failed/total API | memory calls | turns | stopped by | error |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rep.phaseB) {
    L.push(
      `| ${r.scenario} | ${shortModelName(r.model)} | ${r.condition} | ${r.repeat} | ${r.success ? "yes" : "no"} | ${r.duplicates} | ${r.missed} | ${r.wrong} | ${r.failedApiCalls}/${r.totalApiCalls} | ${r.memoryToolCalls} | ${r.turns} | ${r.stoppedBy} | ${(r.error ?? "").replace(/\|/g, "/").slice(0, 80)} |`,
    );
  }
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------------

export async function runEval(deps: RunEvalDeps, options: RunEvalOptions): Promise<EvalReport> {
  const log = deps.log ?? (() => {});
  const mode = options.mode;
  const trainScenarios = options.trainScenarios ?? [...TRAIN_SCENARIOS];
  const heldoutScenarios = options.heldoutScenarios ?? [...HELDOUT_SCENARIOS];
  const conditions = options.conditions ?? ["memory", "no-memory"];
  const repeats = options.repeats ?? 1;
  const maxTurns = options.maxTurns ?? 30;
  const maxToolCalls = options.maxToolCalls ?? 80;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const concurrency = options.concurrency ?? 2;
  const trainModelId = mode === "live" ? resolveModelId(options.trainModel) : `scripted-fixture/${options.scriptedTrainPolicy ?? "reference"}`;
  const evalModelIds = mode === "live" ? options.evalModels.map(resolveModelId) : options.evalModels.map((m) => `scripted-fixture/${m}`);
  const mcp: McpTarget = { url: deps.mcpUrl, ...(deps.mcpHeaders ? { headers: deps.mcpHeaders } : {}) };
  const secrets = [deps.apiKey ?? "", ...Object.values(deps.mcpHeaders ?? {}).map((v) => v.replace(/^Bearer\s+/i, ""))];

  let fireworks: EvalReport["fireworks"];
  if (mode === "live") {
    if (!deps.apiKey) throw new Error("live mode requires deps.apiKey");
    // One unbilled request first; FireworksAuthError (401/403) aborts before any charged call.
    const { modelIds } = await validateFireworksKey(deps.apiKey, deps.fetchImpl);
    fireworks = { modelsListed: modelIds };
    const missing = [trainModelId, ...evalModelIds].filter((m) => !modelIds.includes(m));
    if (missing.length) throw new Error(`Fireworks does not list: ${missing.join(", ")}`);
  }

  const episode = async (args: {
    phase: "train" | "heldout";
    model: string;
    scenario: string;
    condition: Condition;
    repeat: number;
    inspector?: InspectingTraceTransport;
  }): Promise<RunRecord> => {
    const channel = buildScenario(args.scenario).channel;
    const fixtureModel =
      mode === "scripted-fixture"
        ? await createScriptedFixtureModel(
            scriptedNotificationAgent(
              args.phase === "train"
                ? { channel, basePolicy: options.scriptedTrainPolicy ?? "reference" }
                : args.condition === "memory"
                  ? { channel, basePolicy: options.scriptedBasePolicy ?? "no-dedupe", memoryPolicy: options.scriptedMemoryPolicy ?? "reference" }
                  : { channel, basePolicy: options.scriptedBasePolicy ?? "no-dedupe" },
            ),
          )
        : undefined;
    const episodeId = `${args.phase}-${args.scenario}-${shortModelName(args.model)}-${args.condition}-r${args.repeat}-${Date.now().toString(36)}`;
    log(`start ${episodeId}`);
    const m = await runPiEpisode({
      apiKey: deps.apiKey ?? "",
      model: args.model,
      scenario: args.scenario,
      condition: args.condition,
      ...(args.condition === "memory" ? { mcp } : {}),
      maxTurns,
      maxToolCalls,
      timeoutMs,
      episodeId,
      ...(fixtureModel ? { fixtureModel } : {}),
      ...(args.inspector ? { traceSessionFactory: traceFactoryFromTransport(args.inspector) } : {}),
    });
    const traceCapture = args.inspector && m.traceSessionId ? args.inspector.inspect(m.traceSessionId) : undefined;
    log(
      `done ${episodeId}: success=${m.success} dup=${m.duplicates} missed=${m.missed} wrong=${m.wrong} ` +
        `failedApi=${m.failedApiCalls}/${m.totalApiCalls} mem=${m.memoryToolCalls} turns=${m.turns}${m.error ? ` error=${m.error.slice(0, 120)}` : ""}`,
    );
    return { ...m, model: mode === "live" ? m.model : args.model, phase: args.phase, repeat: args.repeat, ...(traceCapture ? { traceCapture } : {}) };
  };

  // Phase A: train day, traced.
  const trainJobs = trainScenarios.map((scenario) => ({
    phase: "train" as const,
    model: trainModelId,
    scenario,
    condition: "no-memory" as Condition,
    repeat: 1,
    ...(deps.traceTransportFactory ? { inspector: new InspectingTraceTransport(deps.traceTransportFactory()) } : {}),
  }));
  const phaseA = await pool(trainJobs, concurrency, episode);

  // Build: same daily-build function as production, triggered manually.
  const buildStart = Date.now();
  let receipt: BuildReceipt | null = null;
  let buildError: string | undefined;
  try {
    receipt = await deps.triggerDailyBuild();
  } catch (e) {
    buildError = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
  }
  const build = {
    receipt: receipt ? sanitize(receipt, secrets) : null,
    publishedRevision: findRevision(receipt),
    ...(buildError ? { error: buildError } : {}),
    durationMs: Date.now() - buildStart,
  };
  log(`build: revision=${build.publishedRevision ?? "?"}${buildError ? ` error=${buildError}` : ""}`);

  // Phase B: held-out, memory vs no-memory, different models.
  const heldJobs: Parameters<typeof episode>[0][] = [];
  for (let repeat = 1; repeat <= repeats; repeat++)
    for (const model of evalModelIds)
      for (const scenario of heldoutScenarios)
        for (const condition of conditions) {
          heldJobs.push({
            phase: "heldout",
            model,
            scenario,
            condition,
            repeat,
            ...(options.traceHeldout && deps.traceTransportFactory
              ? { inspector: new InspectingTraceTransport(deps.traceTransportFactory()) }
              : {}),
          });
        }
  const phaseB = buildError && conditions.includes("memory") ? [] : await pool(heldJobs, concurrency, episode);

  const captures = [...phaseA, ...phaseB].map((r) => r.traceCapture).filter((c): c is CaptureInspection => Boolean(c));
  const report: EvalReport = {
    kind: "procedural-memory-eval",
    label: mode,
    labelNote:
      mode === "live"
        ? "Live model runs: real Pi agents calling Fireworks models; outcomes scored by the host oracle."
        : "Scripted fixture: Pi faux model driven by scripted TypeScript policies. Exercises wiring only; NOT model results.",
    createdAt: new Date().toISOString(),
    config: {
      mode,
      trainModel: options.trainModel,
      evalModels: options.evalModels,
      trainScenarios,
      heldoutScenarios,
      conditions,
      repeats,
      maxTurns,
      maxToolCalls,
      timeoutMs,
      concurrency,
      traceHeldout: Boolean(options.traceHeldout),
      requireFullModelInputCapture: options.requireFullModelInputCapture ?? mode === "live",
      mcpUrl: deps.mcpUrl,
      trainModelId,
      evalModelIds,
    },
    ...(fireworks ? { fireworks } : {}),
    phaseA,
    build,
    phaseB,
    checks: {
      trainRunsTraced: Boolean(deps.traceTransportFactory) && phaseA.every((r) => r.traceCapture && r.traceCapture.finalChunkSeen),
      traceCapturesPromptAndTools: captures.length
        ? captures.some((c) => c.modelInputHasSystemPrompt && c.modelInputHasToolSpecs)
        : null,
      evalModelsDifferFromTrain: !evalModelIds.includes(trainModelId),
    },
    aggregates: aggregate(phaseB),
  };
  const clean = sanitize(report, secrets);

  const dir = options.reportDir === undefined ? "reports" : options.reportDir;
  if (dir !== null) {
    await mkdir(resolve(dir), { recursive: true });
    const stamp = clean.createdAt.replace(/[:.]/g, "-");
    const base = mode === "live" ? `eval-${stamp}` : `eval-scripted-fixture-${stamp}`;
    const files = { json: resolve(dir, `${base}.json`), markdown: resolve(dir, `${base}.md`) };
    clean.files = files;
    await writeFile(files.json, JSON.stringify(clean, null, 2) + "\n");
    await writeFile(files.markdown, renderMarkdown(clean));
  }
  return clean;
}

// ---------------------------------------------------------------------------------------------
// CLI

function usage(): string {
  return `Usage: npx tsx eval/run.ts [options]
  --models kimi,glm,minimax   first = train model (unless --train-model), rest = held-out models
  --train-model <m>           day-1 model (alias or full Fireworks id)
  --eval-models <m,...>       held-out models (default: --models minus train model)
  --mcp-url <url>             customer memory MCP endpoint (required unless --offline)
  --mcp-header "K: V"         MCP request header (repeatable)
  --mcp-bearer-env <NAME>     Authorization: Bearer from env var or .env NAME
  --trace-url <url>           trace ingest base URL (HttpTraceTransport) for phase-A capture
  --trace-token-env <NAME>    trace ingest bearer token from env var or .env NAME
  --build-cmd "<cmd>"         shell command that runs the daily build; last stdout JSON line = receipt
  --max-turns 30 --max-tool-calls 80 --timeout-ms 600000 --repeats 1 --concurrency 2
  --train-scenarios a,b --heldout-scenarios x,y --conditions memory,no-memory --trace-heldout
  --offline                   scripted-fixture mode: faux Pi model + local fixture memory server, no LLM
  --env .env --report-dir reports`;
}

function runBuildCmd(cmd: string): Promise<BuildReceipt> {
  return new Promise((res, rej) => {
    execFile("sh", ["-c", cmd], { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60_000 }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`build command failed: ${err.message}; stderr tail: ${String(stderr).slice(-400)}`));
      const lines = String(stdout).trim().split(/\r?\n/).reverse();
      for (const l of lines) {
        try {
          const v = JSON.parse(l) as unknown;
          if (v && typeof v === "object") return res(v as BuildReceipt);
        } catch {
          // not JSON
        }
      }
      res({ stdoutTail: String(stdout).slice(-2000) });
    });
  });
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      models: { type: "string", default: "kimi,glm,minimax" },
      "train-model": { type: "string" },
      "eval-models": { type: "string" },
      "mcp-url": { type: "string" },
      "mcp-header": { type: "string", multiple: true },
      "mcp-bearer-env": { type: "string" },
      "trace-url": { type: "string" },
      "trace-token-env": { type: "string" },
      "build-cmd": { type: "string" },
      "max-turns": { type: "string", default: "30" },
      "max-tool-calls": { type: "string", default: "80" },
      "timeout-ms": { type: "string", default: "600000" },
      repeats: { type: "string", default: "1" },
      concurrency: { type: "string", default: "2" },
      "train-scenarios": { type: "string" },
      "heldout-scenarios": { type: "string" },
      conditions: { type: "string" },
      "trace-heldout": { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      env: { type: "string", default: ".env" },
      "report-dir": { type: "string", default: "reports" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
  const models = list(values.models) ?? [];
  const trainModel = values["train-model"] ?? models[0] ?? "kimi";
  const evalModels = list(values["eval-models"]) ?? models.filter((m) => resolveModelId(m) !== resolveModelId(trainModel));
  const common = {
    maxTurns: Number(values["max-turns"]),
    maxToolCalls: Number(values["max-tool-calls"]),
    timeoutMs: Number(values["timeout-ms"]),
    repeats: Number(values.repeats),
    concurrency: Number(values.concurrency),
    traceHeldout: values["trace-heldout"],
    reportDir: values["report-dir"]!,
    ...(list(values["train-scenarios"]) ? { trainScenarios: list(values["train-scenarios"])! } : {}),
    ...(list(values["heldout-scenarios"]) ? { heldoutScenarios: list(values["heldout-scenarios"])! } : {}),
    ...(list(values.conditions) ? { conditions: list(values.conditions) as Condition[] } : {}),
  };
  const log = (l: string) => console.log(l);

  let report: EvalReport;
  if (values.offline) {
    const fixture = await startFixtureMemoryServer();
    try {
      report = await runEval(
        {
          mcpUrl: fixture.url,
          mcpHeaders: fixture.headers,
          triggerDailyBuild: async () => fixture.publish(),
          traceTransportFactory: () => ({
            sendChunk: async (c) => ({ status: "created", sessionId: c.sessionId, chunkSeq: c.chunkSeq }),
            putBlob: async () => {},
          }),
          log,
        },
        { mode: "scripted-fixture", trainModel: "reference", evalModels: ["no-dedupe-or-memory"], ...common },
      );
    } finally {
      await fixture.close();
    }
  } else {
    if (!values["mcp-url"]) throw new Error("--mcp-url is required (or use --offline). " + usage());
    if (!values["build-cmd"]) throw new Error("--build-cmd is required for the CLI (programmatic callers inject triggerDailyBuild).");
    const envPath = resolve(values.env!);
    let dotenv: Record<string, string> = {};
    try {
      dotenv = parseDotEnv(await (await import("node:fs/promises")).readFile(envPath, "utf8"));
    } catch {
      // no .env
    }
    const secret = (name: string) => process.env[name] ?? dotenv[name];
    const apiKey = await loadFireworksKey(envPath);
    const headers: Record<string, string> = {};
    for (const h of values["mcp-header"] ?? []) {
      const i = h.indexOf(":");
      if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    if (values["mcp-bearer-env"]) {
      const t = secret(values["mcp-bearer-env"]);
      if (!t) throw new Error(`${values["mcp-bearer-env"]} not set`);
      headers.Authorization = `Bearer ${t}`;
    }
    let traceTransportFactory: (() => TraceTransport) | undefined;
    if (values["trace-url"]) {
      const token = values["trace-token-env"] ? secret(values["trace-token-env"]) : undefined;
      if (!token) throw new Error("--trace-url requires --trace-token-env pointing at a set variable");
      const { HttpTraceTransport } = await import("../src/sdk/index.js");
      const baseUrl = values["trace-url"];
      traceTransportFactory = () => new HttpTraceTransport({ baseUrl, token });
    }
    const buildCmd = values["build-cmd"];
    report = await runEval(
      {
        apiKey,
        mcpUrl: values["mcp-url"],
        mcpHeaders: headers,
        triggerDailyBuild: () => runBuildCmd(buildCmd),
        ...(traceTransportFactory ? { traceTransportFactory } : {}),
        log,
      },
      { mode: "live", trainModel, evalModels, ...common },
    );
  }
  console.log(renderMarkdown(report));
  if (report.files) console.log(`wrote ${report.files.json} and ${report.files.markdown}`);
  if (report.label === "live" && report.checks.traceCapturesPromptAndTools === false && report.config.requireFullModelInputCapture !== false) {
    console.error("CHECK FAILED: no captured model_input contained the system prompt and tool specs.");
    process.exitCode = 3;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((e) => {
    if (e instanceof FireworksAuthError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
