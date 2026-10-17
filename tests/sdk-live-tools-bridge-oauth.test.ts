/**
 * procmem-live-mcp bridge in OAuth mode (PROCMEM_OAUTH_CONFIG + FileTokenStore), spawned over real stdio against a
 * SIMULATED OAuth authorization server + bearer proxy in front of the REAL parent app. Access tokens last 2 s, so the
 * bridge must refresh (and persist rotated refresh tokens) while the client keeps calling. Also: config hygiene and
 * ambiguous auth configuration fail closed; nothing secret on argv/stdout/stderr.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileTokenStore, tokensFromTokenResponse } from "../src/sdk/oauth-refresh.js";
import { echoTool, LoopbackParent, SimulatedOAuthParent, type SimulatedChild } from "../scripts/sdk-live-tools-fixtures.js";

const CLI = ["--import", "tsx", "src/sdk/live/bridge-cli.ts"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parent = new LoopbackParent();
let oauth: SimulatedOAuthParent;
let child: SimulatedChild;
let dir: string;
let storePath: string;
let configPath: string;
let stderr = "";

beforeAll(async () => {
  await parent.start();
  child = await parent.child("kappa", [echoTool("echo")]);
  parent.publish(child);
  oauth = new SimulatedOAuthParent(parent.baseUrl, parent.key.key);
  oauth.accessTtlSeconds = 2;
  await oauth.start();
  dir = await mkdtemp(join(tmpdir(), "procmem-bridge-oauth-"));
  storePath = join(dir, "store", "parent-oauth.json");
  await new FileTokenStore(storePath).save(tokensFromTokenResponse(oauth.issueInitial()));
  configPath = join(dir, "oauth.json");
  await writeFile(configPath, JSON.stringify({ tokenEndpoint: oauth.tokenEndpoint, clientId: "public-cli-client", tokenStore: storePath }), { mode: 0o600 });
}, 60_000);

afterAll(async () => {
  await oauth?.close();
  await child?.close();
  await parent.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("bridge OAuth mode", () => {
  it("refreshes the parent token in the background and persists rotation while one client keeps calling", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: CLI,
      cwd: process.cwd(),
      env: { ...getDefaultEnvironment(), PROCMEM_BASE_URL: oauth.url, PROCMEM_OAUTH_CONFIG: configPath, PROCMEM_ALLOW_INSECURE_LOCALHOST: "1", PROCMEM_POLL_MS: "1000" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    const client = new Client({ name: "bridge-oauth-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const end = Date.now() + 20_000;
      while (!(await client.listTools(undefined, { cacheMode: "bypass" } as never)).tools.some((t) => t.name === "integration__kappa__echo")) {
        if (Date.now() > end) throw new Error("tools not discovered");
        await sleep(200);
      }
      const posts0 = oauth.tokenPosts;
      for (let i = 0; i < 6; i++) {
        const r = (await client.callTool({ name: "integration__kappa__echo", arguments: { message: `m${i}` } })) as { content: Array<{ text?: string }>; isError?: boolean };
        expect(r.isError).toBeFalsy();
        const m = (await client.callTool({ name: "memory__ls", arguments: { path: "$KNOWLEDGE" } })) as { isError?: boolean };
        expect(m.isError).toBeFalsy();
        await sleep(700);
      }
      expect(oauth.tokenPosts - posts0).toBeGreaterThanOrEqual(1); // rotated during the run
      const stored = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
      expect(JSON.stringify(stored)).toContain(oauth.knownTokens.at(-1)!); // latest rotated refresh token persisted
      expect(((await stat(storePath)).mode & 0o077) === 0).toBe(true);
    } finally {
      await client.close();
    }
    for (const t of [...oauth.knownTokens, parent.key.key]) expect(stderr).not.toContain(t);
  }, 60_000);

  it("fails closed on ambiguous auth configuration and on secrets inside the OAuth config", async () => {
    const base = { ...process.env, PROCMEM_BASE_URL: oauth.url, PROCMEM_ALLOW_INSECURE_LOCALHOST: "1" };
    const amb = spawnSync(process.execPath, CLI, { cwd: process.cwd(), env: { ...base, PROCMEM_API_KEY: "pmk_xxxxxxxxxxxx", PROCMEM_OAUTH_CONFIG: configPath }, encoding: "utf8", timeout: 30_000 });
    expect(amb.status).toBe(2);
    expect(amb.stderr).toMatch(/ambiguous auth configuration/);
    expect(amb.stdout).toBe("");
    const bad = join(dir, "bad.json");
    await writeFile(bad, JSON.stringify({ tokenEndpoint: oauth.tokenEndpoint, clientId: "c", tokenStore: storePath, refreshToken: "ort_should_not_be_here" }), { mode: 0o600 });
    const sec = spawnSync(process.execPath, CLI, { cwd: process.cwd(), env: { ...base, PROCMEM_OAUTH_CONFIG: bad }, encoding: "utf8", timeout: 30_000 });
    expect(sec.status).toBe(2);
    expect(sec.stderr).toMatch(/must not contain refreshToken/);
    expect(sec.stderr).not.toContain("ort_should_not_be_here");
    const confidential = join(dir, "conf.json");
    await writeFile(confidential, JSON.stringify({ tokenEndpoint: oauth.tokenEndpoint, clientId: "c", tokenStore: storePath, clientAuth: { method: "client_secret_post" } }), { mode: 0o600 });
    const noSecret = spawnSync(process.execPath, CLI, { cwd: process.cwd(), env: { ...base, PROCMEM_OAUTH_CONFIG: confidential, PROCMEM_OAUTH_CLIENT_SECRET: "" }, encoding: "utf8", timeout: 30_000 });
    expect(noSecret.status).toBe(2);
    expect(noSecret.stderr).toMatch(/PROCMEM_OAUTH_CLIENT_SECRET/);
  });
});
