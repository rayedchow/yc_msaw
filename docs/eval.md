# Eval: procedural memory, live Pi agents vs no-memory baseline

Code lives in `eval/`. Tests are `tests/eval-*.test.ts`.

## Task world (`eval/world/notifications.ts`)
This is a deterministic simulated notification-delivery API that only the host can see. Agents reach it through three Pi custom tools: `list_notifications`, `get_deliveries` and `deliver`. The world has these traps:

- **Pagination:** cursor pagination with at most 3 results per page.
- **Rate limits:** a `429` with Retry-After on some list calls.
- **Transient deliver failures:** `503` on deliver for configured ids. Some of these are "commit-then-503": the delivery is already recorded, so a blind retry duplicates it.
- **Stale records:** some "failed" records were already delivered.
- **Idempotency-Key dedupe:** the API dedupes repeated deliveries per notification by Idempotency-Key.
- **Permanent failures:** `failed_permanent` records return `409`.
- **Malformed records:** a missing recipient or an invalid channel returns `422`.
- **Channel filter:** only the channel named in the task should be delivered.

Seeds: `train-day1-a` and `train-day1-b` for the train day, and `heldout-x` and `heldout-y` for held-out runs. All seeds share the same API behavior; only the data and the fault schedule differ.

The host oracle is `evaluateWorld`. A run succeeds only if every eligible notification has exactly one delivery, there are no duplicates anywhere, and nothing ineligible was delivered. It also reports duplicates, missed, wrong, failedCalls and totalCalls.

## One Pi episode (`eval/pi-agent.ts` `runPiEpisode`)
Each episode runs in isolation:

- A temp dir serves as both `cwd` and `agentDir`.
- Settings use `SettingsManager.inMemory` and sessions use `SessionManager.inMemory`.
- `DefaultResourceLoader` runs with no extensions, skills, prompts, themes or context files, and uses its own system prompt.
- `ModelRuntime.create` gets an `InMemoryCredentialStore`, an `InMemoryModelsStore` and `modelsPath: null`, with no network refresh.
- The Fireworks key is passed in with `setRuntimeApiKey("fireworks", key)`. There is no auth.json and no `process.env` entry.
- The model comes from Pi's bundled Fireworks catalog: `runtime.getModel("fireworks", id)`.
- The tool allowlist is the 3 world tools, plus `mcp__memory__*` in the memory condition. The harness refuses to run if any other tool is active.

In the memory condition, Pi's real MCP extension loads with an injected server config: `createMcpExtension({ loadConfig })`, server `memory`, `type: "http"`, `exposure: "direct"`, plus headers. The extension never reads `mcp.json`.

Limits: `maxTurns`, `maxToolCalls` and `timeoutMs`. Hitting any of them calls `session.abort()`. Token usage is summed from the assistant `message_end` usage.

Trace capture uses `eval/trace-adapter.ts`, which wires the real `TraceRecorder` and `attachPiTraceCapture`. The episode outcome, as judged by the host oracle, is sent with `finish()`. `InspectingTraceTransport` checks that a captured `model_input` contains the actual system prompt and the tool specs, including the JSON parameter schemas.

## Full eval (`eval/run.ts`)
```ts
runEval(deps: RunEvalDeps, options: RunEvalOptions): Promise<EvalReport>
deps = { mcpUrl, mcpHeaders?, traceTransportFactory?: () => TraceTransport,
         triggerDailyBuild: () => Promise<receipt>, apiKey?, fetchImpl?, log? }
options = { mode: "live" | "scripted-fixture", trainModel, evalModels, trainScenarios?, heldoutScenarios?,
            conditions?, repeats?, maxTurns?, maxToolCalls?, timeoutMs?, concurrency?, traceHeldout?, reportDir? }
```
The run has three steps:

1. **Validate the key.** In live mode, the harness first sends `GET /models` to Fireworks (not billed). On a 401 or 403 it throws `FireworksAuthError` before making any other call.
2. **Phase A (train).** Agents on the train model run the train scenarios with tracing on. Then the harness calls `triggerDailyBuild()`.
3. **Phase B (held-out).** Agents on each eval model run each held-out scenario in both conditions, memory and no-memory.

Reports are written to `reports/eval-<ts>.json` and `reports/eval-<ts>.md`. Offline runs are written to `reports/eval-scripted-fixture-<ts>.*` and are labeled accordingly.

Wiring with the app (in-process):
```ts
const app = await createApp({...}); const { mcpUrl } = await app.listen(0);
await runEval({ apiKey, mcpUrl, mcpHeaders: { Authorization: `Bearer ${tenantKey}` },
  traceTransportFactory: () => new InProcessTraceTransport(app.ingestor, ns),
  triggerDailyBuild: () => /* the daily build for ns + today's day */ }, { mode: "live", trainModel: "kimi", evalModels: ["glm", "minimax"] });
```

CLI:
```
npx tsx eval/run.ts --models kimi,glm,minimax --max-turns 30 --mcp-url <url>/mcp --mcp-bearer-env TENANT_KEY \
  --trace-url <url> --trace-token-env TENANT_KEY --build-cmd "<prints receipt JSON>" [--repeats N --concurrency 2]
npx tsx eval/run.ts --offline        # scripted-fixture: Pi faux model + fixture memory MCP, no LLM
npx tsx eval/smoke-pi.ts --model glm # one live traced no-memory episode + MCP probe
npx tsx eval/mcp-probe.ts            # Pi MCP extension <-> mcp-use MCPServer, no model
```

## Labels
- `live` / `live-model`: real Pi agents calling Fireworks models.
- `scripted-fixture`: a Pi faux provider driven by scripted TypeScript policies (`eval/scripted-driver.ts`). These runs exercise the real Pi session, tools, MCP extension and trace SDK. They are not model results.
