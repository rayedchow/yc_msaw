/**
 * Verifies the COMPILED production artifact (.mcp-use/build, produced by
 * `npm run build`) can create the real integration runtime the daily build
 * registers: the builder chunk's dynamic import resolves to an emitted chunk,
 * and that chunk's createIntegrationRuntime yields research, workspace and
 * host-deploy tools with the host credentials configured.
 *
 *   npm run build && npx tsx scripts/check-built-integrations.ts [--env .context/manufact.env]
 *
 * Credentials are loaded into this process only and never printed.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DirectoryObjectStore } from "../src/store/objects.js";

const buildDir = path.resolve(".mcp-use/build");
const envFile = process.argv.includes("--env") ? process.argv[process.argv.indexOf("--env") + 1] : ".context/manufact.env";

const assets = await fs.readdir(path.join(buildDir, "assets"));
const builderChunk = assets.find((f) => f.startsWith("builder-") && f.endsWith(".js"));
const integrationsChunk = assets.find((f) => f.startsWith("integrations-") && f.endsWith(".js"));
if (!builderChunk || !integrationsChunk) throw new Error(`build is missing builder/integrations chunks: ${assets.join(", ")}`);

// The builder chunk must import the emitted integrations chunk by a path that exists.
const builderSource = await fs.readFile(path.join(buildDir, "assets", builderChunk), "utf8");
const imports = [...builderSource.matchAll(/import\("(\.[^"]+)"\)/g)].map((m) => m[1]!);
const integrationImport = imports.find((p) => p.includes("integrations"));
if (!integrationImport) throw new Error("builder chunk does not import the integrations chunk");
await fs.access(path.resolve(buildDir, "assets", integrationImport));

if (envFile) {
  const text = await fs.readFile(envFile, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

const mod = (await import(pathToFileURL(path.join(buildDir, "assets", integrationsChunk)).href)) as {
  createIntegrationRuntime: (deps: Record<string, unknown>) => Promise<{ tools: Array<{ name: string; scope: string }>; instructions: string; close(): Promise<unknown> }>;
};
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "procmem-built-int-"));
const runtime = await mod.createIntegrationRuntime({ ns: "check-built", store: new DirectoryObjectStore(dir), buildId: "bld-check-built-1" });
try {
  const byScope: Record<string, string[]> = {};
  for (const t of runtime.tools) (byScope[t.scope] ??= []).push(t.name);
  // Tool names the root build agent needs to research, author, validate, commit, promote and publish.
  const required = ["research_exa_search", "integration_open", "integration_write", "integration_exec", "integration_validate", "integration_git_commit", "integration_promote", "integration_publish", "integration_probe"];
  const names = new Set(runtime.tools.map((t) => t.name));
  const missing = required.filter((n) => !names.has(n));
  const report = {
    builtChunks: { builder: builderChunk, integrations: integrationsChunk, builderImport: integrationImport },
    toolsByScope: byScope,
    instructionsChars: runtime.instructions.length,
    credentialsPresent: { exa: Boolean(process.env.EXA_API_KEY), manufact: Boolean(process.env.MCP_USE_API_KEY), childSigning: Boolean(process.env.INTEGRATION_CHILD_SIGNING_JWK) },
    missing,
  };
  console.log(JSON.stringify(report, null, 2));
  await fs.writeFile("reports/built-integrations-check.json", `${JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2)}\n`);
  if (missing.length) process.exitCode = 1;
} finally {
  await runtime.close();
  await fs.rm(dir, { recursive: true, force: true });
}
