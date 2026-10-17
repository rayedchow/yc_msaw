/**
 * Packaged-artifact check for the live-tools SDK:
 *  1. npm pack ./packages/procmem-sdk (prepack builds dist) into a temp dir;
 *  2. npm install the tarball into a FRESH consumer project (registry deps only; no repo paths);
 *  3. import "@procmem/sdk", "@procmem/sdk/live", "@procmem/sdk/live/pi" from the consumer;
 *  4. run the INSTALLED `procmem-live-mcp` bin over stdio against a loopback parent (real app; SIMULATED child) with the
 *     official MCP client: list tools, receive list_changed after a child is added, call it.
 *   npx tsx scripts/sdk-live-tools-pack-check.ts   -> reports/sdk-live-tools-pack.json
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { echoTool, LoopbackParent } from "./sdk-live-tools-fixtures.js";

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  console.error(`${ok ? "PASS" : "FAIL"} ${name}`);
};

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "procmem-sdk-pack-"));
  const parent = new LoopbackParent();
  try {
    const packDir = join(work, "pack");
    const consumer = join(work, "consumer");
    execFileSync("mkdir", ["-p", packDir, consumer]);
    execFileSync("npm", ["pack", resolve("packages/procmem-sdk"), "--pack-destination", packDir, "--silent"], { stdio: ["ignore", "ignore", "inherit"] });
    const tgz = (await readdir(packDir)).find((f) => f.endsWith(".tgz"))!;
    const files = execFileSync("tar", ["-tzf", join(packDir, tgz)], { encoding: "utf8" }).split("\n").filter(Boolean);
    check("tarball contains live dist + bin", ["package/dist/sdk/live/index.js", "package/dist/sdk/live/pi.js", "package/dist/sdk/live/bridge-cli.js", "package/dist/sdk/live/index.d.ts", "package/dist/sdk/oauth-refresh.js"].every((f) => files.includes(f)), { tgz, fileCount: files.length });
    check("tarball has no source maps, tests or env files", !files.some((f) => /\.env|\.test\.|\/tests\//.test(f)));
    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "fresh-consumer", private: true, type: "module" }));
    execFileSync("npm", ["install", join(packDir, tgz), "--no-audit", "--no-fund", "--silent"], { cwd: consumer, stdio: ["ignore", "ignore", "inherit"] });
    const probe = `
      const root = await import("@procmem/sdk");
      const live = await import("@procmem/sdk/live");
      const pi = await import("@procmem/sdk/live/pi");
      const oauth = await import("@procmem/sdk/oauth");
      console.log(JSON.stringify({ oauth: typeof oauth.OAuthRefreshProvider, helper: typeof live.oauthParentCredential, root: typeof root.TraceRecorder, registry: typeof live.LiveToolRegistry, boundary: typeof live.ToolBoundary, bridge: typeof live.createLiveToolsBridge, pi: typeof pi.createPiLiveTools, name: live.stableToolName("integration:notify-hub", "deliver") }));`;
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: consumer, encoding: "utf8" })) as Record<string, string>;
    check("fresh consumer imports @procmem/sdk, /live, /live/pi, /oauth", out.oauth === "function" && out.helper === "function" && out.root === "function" && out.registry === "function" && out.boundary === "function" && out.bridge === "function" && out.pi === "function" && out.name === "integration__notify-hub__deliver", out);
    const deps = JSON.parse(execFileSync("npm", ["ls", "--json", "--depth=1"], { cwd: consumer, encoding: "utf8" })) as { dependencies?: Record<string, { dependencies?: Record<string, { version: string }> }> };
    const sdkDeps = deps.dependencies?.["@procmem/sdk"]?.dependencies ?? {};
    check("installed MCP deps resolve to 2.3.x", /^2\.3\./.test(sdkDeps["@modelcontextprotocol/client"]?.version ?? "") && /^2\.3\./.test(sdkDeps["@modelcontextprotocol/server"]?.version ?? ""), Object.fromEntries(Object.entries(sdkDeps).map(([k, v]) => [k, v.version])));

    await parent.start();
    const bin = join(consumer, "node_modules", ".bin", "procmem-live-mcp");
    const transport = new StdioClientTransport({ command: bin, args: [], cwd: consumer, env: { ...getDefaultEnvironment(), PROCMEM_BASE_URL: parent.baseUrl, PROCMEM_API_KEY: parent.key.key, PROCMEM_ALLOW_INSECURE_LOCALHOST: "1", PROCMEM_POLL_MS: "1000", PROCMEM_BRIDGE_LOG: "quiet" }, stderr: "pipe" });
    const client = new Client({ name: "pack-check", version: "1.0.0" });
    let changed = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      changed++;
    });
    await client.connect(transport);
    try {
      const list = async () => (await client.listTools(undefined, { cacheMode: "bypass" } as never)).tools.map((t) => t.name);
      const wait = async (cond: (n: string[]) => boolean) => {
        const end = Date.now() + 20_000;
        for (;;) {
          const n = await list();
          if (cond(n)) return n;
          if (Date.now() > end) return n;
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      const first = await wait((n) => n.includes("memory__open_memory"));
      check("installed bin serves memory tools + fallback pair", first.includes("memory__open_memory") && first.includes("procmem_list_live_tools") && first.includes("procmem_call_live_tool"), first.length);
      const child = await parent.child("packed", [echoTool("hello")]);
      parent.publish(child);
      const before = changed;
      const second = await wait((n) => n.includes("integration__packed__hello"));
      check("installed bin announces an added child (list_changed) on the same connection", second.includes("integration__packed__hello") && changed > before, { changed });
      const r = (await client.callTool({ name: "integration__packed__hello", arguments: { message: "from-tarball" } })) as { content: Array<{ text?: string }> };
      check("installed bin calls the child", r.content.map((c) => c.text).join("") === "echo:from-tarball");
      await child.close();
    } finally {
      await client.close();
    }
  } finally {
    await parent.close().catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
  const ok = checks.every((c) => c.ok);
  await writeFile("reports/sdk-live-tools-pack.json", `${JSON.stringify({ kind: "sdk-live-tools-pack", labels: { upstream: "SIMULATED child on loopback; real parent app on loopback" }, at: new Date().toISOString(), ok, checks }, null, 2)}\n`);
  console.error(`report: reports/sdk-live-tools-pack.json ok=${String(ok)}`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`pack check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
