/**
 * Package and run the walter MCP (the control plane agents connect to).
 *
 *   npx tsx walter/scripts/deploy-walter.ts --local     install, build and start it locally (no auth), then smoke-test over MCP
 *   npx tsx walter/scripts/deploy-walter.ts --deploy    deploy to Manufact with secrets as env, wait for this build, smoke-test
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { writeWalterProject } from "../control/project.js";
import { deployToManufact, isLinked, run, waitForDeployment } from "../deploy/project.js";
import { connectMcp } from "../mcp-client.js";
import { ORG } from "../pipeline.js";
import { loadState, saveState, STATE_DIR } from "../state.js";
import "../env.js";

const dir = path.join(STATE_DIR, "projects", "walter");
const { mcps, hash } = await writeWalterProject(dir);
console.log(`packaged walter (${mcps} template MCPs, build ${hash}) at ${dir}`);
const st = await loadState();
const env: Record<string, string> = {
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY ?? "", MCP_USE_API_KEY: process.env.MCP_USE_API_KEY ?? "", MANUFACT_ORG_SLUG: ORG(),
  GURTAI_URL: st.system?.url ?? "", GURTAI_TOKEN: st.system?.token ?? "", WALTER_TOKEN: st.walterToken ?? "",
  ...(process.env.MCP_USE_OAUTH_WORKOS_SUBDOMAIN ? { MCP_USE_OAUTH_WORKOS_SUBDOMAIN: process.env.MCP_USE_OAUTH_WORKOS_SUBDOMAIN } : {}),
};

async function smoke(url: string) {
  const mcp = await connectMcp(url, {}, "walter-smoke-test");
  console.log("tools:", mcp.tools.map((t) => t.name).join(", "));
  const t = await mcp.call("list_templates");
  console.log("templates:", (t.data?.templates ?? []).map((x: any) => `${x.template} → ${x.gives}`).join("; "));
  const c = await mcp.call("connect_system", { template: "gurtai-sales" });
  if (c.isError) throw new Error(c.text);
  let b = c.data;
  for (let i = 0; i < 40 && b.status === "running"; i++) { await new Promise((r) => setTimeout(r, 2000)); b = (await mcp.call("build_status", { build_id: b.build_id })).data; }
  console.log("build:", b.status, b.log.length, "log lines; last:", b.log.at(-1));
  console.log("list_mcps:", JSON.stringify((await mcp.call("list_mcps")).data.mcps.map((m: any) => ({ id: m.id, url: m.url, rules: m.rules, evals: m.evals }))));
  console.log("open_questions:", (await mcp.call("open_questions")).data.questions.length);
  console.log("playbook chars:", (await mcp.call("get_playbook", { mcp: "sales" })).text.length);
  console.log("bad input →", (await mcp.call("connect_system", { template: "nope" })).text);
  await mcp.close();
}

if (process.argv.includes("--local")) {
  console.log("npm install…");
  const i = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, timeoutMs: 600_000 });
  if (i.code !== 0) throw new Error(i.err.slice(-2000));
  const b = await run(path.join(dir, "node_modules/.bin/mcp-use"), ["build"], { cwd: dir, timeoutMs: 600_000 });
  if (b.code !== 0) throw new Error(`build failed:\n${(b.out + b.err).slice(-3000)}`);
  const port = 4600;
  const child = spawn(path.join(dir, "node_modules/.bin/mcp-use"), ["start", "--port", String(port)], { cwd: dir, env: { ...process.env, ...env, WALTER_AUTH: "none", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let k = 0; k < 120; k++) { if (await fetch(url + "/walter/health").then((r) => r.ok, () => false)) break; await new Promise((r) => setTimeout(r, 500)); }
  try { await smoke(url + "/mcp"); } catch (e) { console.log("SMOKE FAILED:", (e as Error).message, "\n", log.slice(-3000)); process.exitCode = 1; }
  if (process.argv.includes("--keep")) console.log(`walter running at ${url}/mcp (Ctrl-C to stop)`); else child.kill("SIGTERM");
} else if (process.argv.includes("--deploy")) {
  const t0 = Date.now();
  const r = await deployToManufact(dir, "walter", env, { isNew: !isLinked(dir), org: ORG() });
  if (!r.ok) { console.log(r.log); process.exit(1); }
  const live = await waitForDeployment(String((r.raw as any).serverId), { since: t0, expectHash: hash, timeoutMs: 25 * 60_000 });
  console.log("deployment", live.status, live.mcpUrl, `${Math.round((Date.now() - t0) / 1000)}s`);
  if (live.status !== "running" || !live.mcpUrl) process.exit(1);
  const fresh = await loadState();
  await saveState({ ...fresh, walter: { mcpUrl: live.mcpUrl, serverId: (r.raw as any).serverId, webUrl: (r.raw as any).webUrl, hash, deployedAt: new Date().toISOString() } } as any);
  if (!env.MCP_USE_OAUTH_WORKOS_SUBDOMAIN) await smoke(live.mcpUrl);
  else console.log("OAuth is on: connect from an MCP client to sign in and try it.");
}
