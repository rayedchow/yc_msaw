/**
 * Live Pi smoke (no product server needed):
 *   npx tsx eval/smoke-pi.ts [--model glm] [--scenario train-day1-a] [--max-turns 20]
 * 1. validates the Fireworks key (GET /models, unbilled) and aborts on 401/403;
 * 2. runs ONE live Pi episode, condition no-memory, with only the world tools;
 * 3. runs the offline MCP probe (Pi MCP extension <-> mcp-use MCPServer, faux model);
 * writes the sanitized result to reports/pi-smoke.json.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InProcessTraceTransport } from "../src/sdk/index.js";
import { DirectoryObjectStore } from "../src/store/objects.js";
import { TraceIngestor } from "../src/traces/index.js";
import { InspectingTraceTransport, traceFactoryFromTransport } from "./trace-adapter.js";
import { parseArgs } from "node:util";
import { FireworksAuthError, loadFireworksKey, resolveModelId, sanitize, validateFireworksKey } from "./fireworks.js";
import { runMcpProbe } from "./mcp-probe.js";
import { runPiEpisode } from "./pi-agent.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "glm" },
    scenario: { type: "string", default: "train-day1-a" },
    "max-turns": { type: "string", default: "20" },
    "timeout-ms": { type: "string", default: "600000" },
    env: { type: "string", default: ".env" },
    out: { type: "string", default: "reports/eval-pi-smoke-traced.json" },
  },
});

async function main() {
  const apiKey = await loadFireworksKey(resolve(values.env!));
  let modelIds: string[];
  try {
    ({ modelIds } = await validateFireworksKey(apiKey));
  } catch (e) {
    if (e instanceof FireworksAuthError) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const modelId = resolveModelId(values.model!);
  if (!modelIds.includes(modelId)) console.warn(`warning: ${modelId} not listed by Fireworks GET /models`);
  console.log(`key ok; ${modelIds.length} models listed; running ${modelId} on ${values.scenario}`);

  // In-process trace capture (real SDK + real ingestor into a temp object store), inspected.
  const traceRoot = await mkdtemp(join(tmpdir(), "eval-smoke-traces-"));
  const inspector = new InspectingTraceTransport(
    new InProcessTraceTransport(new TraceIngestor(new DirectoryObjectStore(traceRoot)), "tenant-eval-smoke"),
  );
  const episode = await runPiEpisode({
    traceSessionFactory: traceFactoryFromTransport(inspector),
    apiKey,
    model: modelId,
    scenario: values.scenario!,
    condition: "no-memory",
    maxTurns: Number(values["max-turns"]),
    maxToolCalls: 80,
    timeoutMs: Number(values["timeout-ms"]),
    onEvent: (l) => console.log(l),
  });
  const traceCapture = episode.traceSessionId ? inspector.inspect(episode.traceSessionId) : undefined;
  await rm(traceRoot, { recursive: true, force: true });
  const traceCheck = Boolean(traceCapture?.modelInputHasSystemPrompt && traceCapture.modelInputHasToolSpecs);
  console.log(`trace capture: ${JSON.stringify(traceCapture)}; systemPrompt+toolSpecs captured=${traceCheck}`);
  console.log("episode done; running MCP probe");
  const mcpProbe = await runMcpProbe();

  const report = sanitize(
    {
      kind: "pi-smoke",
      createdAt: new Date().toISOString(),
      liveModelRun: episode,
      traceCapture,
      checks: { traceCapturesPromptAndTools: traceCheck, mcpProbeOk: mcpProbe.ok },
      mcpProbe,
      fireworksModelsListed: modelIds,
    },
    [apiKey],
  );
  await mkdir(resolve("reports"), { recursive: true });
  await writeFile(resolve(values.out!), JSON.stringify(report, null, 2) + "\n");
  const { oracle: _o, finalText: _f, activeTools: _a, ...summary } = episode;
  console.log(JSON.stringify(summary, null, 2));
  console.log(`mcpProbe.ok=${mcpProbe.ok}; wrote ${values.out}`);
  if (!traceCheck) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
