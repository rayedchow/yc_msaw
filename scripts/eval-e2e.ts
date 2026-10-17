/**
 * Full product evaluation (LIVE models):
 *   Pi agents (Fireworks) work day-1 tasks with the trace SDK attached
 *   -> the real daily build (recursive multi-agent harness) publishes memory
 *   -> fresh Pi agents of other models solve held-out tasks with the memory MCP vs without.
 * Everything runs through the real product app: HTTP MCP server, trace ingest,
 * object store, daily build service. Task success is judged by the host oracle.
 *
 *   npx tsx scripts/eval-e2e.ts [--store directory|modal] [--sandbox modal|local]
 *       [--train kimi] [--eval glm,minimax] [--repeats 1] [--max-turns 30]
 *       [--build-max-descendants 4] [--build-max-turns 24]
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { runEval } from "../eval/run.js";
import { createApp } from "../src/app.js";
import { generateStaticKey } from "../src/auth/index.js";
import { createConfiguredBuilder } from "../src/daily/builder.js";
import { InProcessTraceTransport } from "../src/sdk/index.js";
import { loadConfig } from "../src/config.js";

const { values } = parseArgs({
  options: {
    store: { type: "string", default: "directory" },
    sandbox: { type: "string", default: "modal" },
    train: { type: "string", default: "kimi" },
    eval: { type: "string", default: "glm,minimax" },
    repeats: { type: "string", default: "1" },
    "max-turns": { type: "string", default: "30" },
    "build-max-descendants": { type: "string", default: "4" },
    "build-max-turns": { type: "string", default: "24" },
    "build-model": { type: "string" },
    // Integration tools for the build agents: on (default when available) | off | required
    integrations: { type: "string", default: "on" },
    // Optional host env file with integration credentials (MCP_USE_API_KEY, child signing key...). Never printed.
    "integration-env": { type: "string" },
    // Let the root build agent publish integration MCPs to Manufact (host-deploy tools). Off by default.
    "allow-deploy": { type: "boolean", default: false },
  },
});

async function loadDotEnv(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const text = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const dotenv = await loadDotEnv(path.resolve(".env"));
const apiKey = process.env.FIREWORKS_API_KEY ?? dotenv.FIREWORKS_API_KEY;
if (!apiKey) throw new Error("FIREWORKS_API_KEY missing (.env)");

const ns = `eval-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
const key = generateStaticKey(ns, ["memory:read", "traces:write", "memory:build"]);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-eval-"));
const env: NodeJS.ProcessEnv = {
  PORT: "0",
  HOST: "127.0.0.1",
  AUTH_MODE: "static",
  PROCMEM_STATIC_KEYS: key.entry,
  PROCMEM_STORE: values.store,
  PROCMEM_SANDBOX: values.sandbox,
  PROCMEM_DATA_DIR: dataDir,
  FIREWORKS_API_KEY: apiKey,
  ...(values["build-model"] ? { PROCMEM_BUILD_MODEL: values["build-model"] } : {}),
};
// Host-side integration credentials go into this process only (the integrations runtime reads
// process.env); they are never forwarded to sandboxes, prompts or reports.
const INTEGRATION_KEYS = ["EXA_API_KEY", "MCP_USE_API_KEY", "MANUFACT_ORG_SLUG", "MANUFACT_ORG_ID", "INTEGRATION_CHILD_SIGNING_JWK", "INTEGRATION_CHILD_ISSUER"];
const integrationEnv = { ...dotenv, ...(values["integration-env"] ? await loadDotEnv(path.resolve(values["integration-env"])) : {}) };
const secrets = [apiKey];
for (const k of INTEGRATION_KEYS) {
  const v = integrationEnv[k];
  if (v && !process.env[k]) process.env[k] = v;
  if (v && v.length >= 12 && !k.startsWith("MANUFACT_ORG")) secrets.push(v);
}
const log = (m: string) => console.error(`[eval-e2e] ${secrets.reduce((acc, sec) => acc.split(sec).join("<redacted>"), m)}`);
const builder = createConfiguredBuilder(loadConfig(env), log, {
  budget: { maxDescendants: Number(values["build-max-descendants"]), maxTurns: Number(values["build-max-turns"]) },
  integrations: values.integrations as "on" | "off" | "required",
  allowIntegrationDeploy: values["allow-deploy"],
});
const app = await createApp({ env, builder, log });
const { mcpUrl } = await app.listen(0);
log(`app up: ${mcpUrl} ns=${ns} store=${values.store} sandbox=${values.sandbox}`);

try {
  const report = await runEval(
    {
      mcpUrl,
      mcpHeaders: { Authorization: `Bearer ${key.key}` },
      traceTransportFactory: () => new InProcessTraceTransport(app.ingestor, ns),
      triggerDailyBuild: async () => {
        const day = new Date().toISOString().slice(0, 10); // traces were received today (UTC)
        const receipt = (await app.builds.runAndWait(ns, { day })) as Record<string, unknown>;
        log(`daily build ${String(receipt.buildId)} -> ${String(receipt.status)} ${String(receipt.revisionId ?? "")} ${String(receipt.error ?? "")}`);
        return receipt;
      },
      apiKey,
      log,
    },
    {
      mode: "live",
      trainModel: values.train,
      evalModels: values.eval.split(","),
      repeats: Number(values.repeats),
      maxTurns: Number(values["max-turns"]),
      reportDir: "reports",
    },
  );
  // Persist the published wiki alongside the report for inspection.
  const head = (await app.store.getRef(ns, "memory/head"))?.value as { revisionId?: string } | undefined;
  if (head?.revisionId) {
    const { MemoryRepo } = await import("../src/store/memory.js");
    const files = await new MemoryRepo(app.store, ns).files(head.revisionId);
    const outDir = path.join("reports", `memory-${ns}`);
    for (const [p, content] of files) {
      await fs.mkdir(path.dirname(path.join(outDir, p)), { recursive: true });
      await fs.writeFile(path.join(outDir, p), content);
    }
    log(`published wiki (${files.size} pages) copied to ${outDir}`);
  }
  console.log(JSON.stringify({ ns, files: report.files, build: { revision: report.build.publishedRevision, error: report.build.error }, checks: report.checks, aggregates: report.aggregates }, null, 2));
} finally {
  await app.close();
}
