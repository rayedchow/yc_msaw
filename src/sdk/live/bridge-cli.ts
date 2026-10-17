#!/usr/bin/env node
/**
 * procmem-live-mcp: stdio MCP bridge exposing ALL of a tenant's procmem tools (memory + every deployed integration
 * MCP), kept up to date at runtime with notifications/tools/list_changed.
 *
 * Configuration comes ONLY from the environment (credentials are never accepted as arguments):
 *   PROCMEM_BASE_URL                 parent URL, e.g. https://wild-zero-kq08i.run.mcp-use.com   (required)
 *   Exactly ONE parent credential source (or set PROCMEM_AUTH=static|token-file|oauth explicitly):
 *   PROCMEM_API_KEY                  static key (non-expiring, headless), or
 *   PROCMEM_TOKEN_FILE               path to a file holding the credential, re-read on every request (external rotation), or
 *   PROCMEM_OAUTH_CONFIG             path to a JSON OAuth refresh config (no secrets inside):
 *                                    {"tokenEndpoint","clientId","tokenStore":"<FileTokenStore path, 0600>",
 *                                     "resource"?: default <PROCMEM_BASE_URL>/mcp, "scope"?,
 *                                     "clientAuth"?: {"method":"client_secret_post"|"client_secret_basic"}}
 *                                    a confidential client's secret comes from PROCMEM_OAUTH_CLIENT_SECRET.
 *                                    The token store holds the grant (seed it once from a login); rotated refresh
 *                                    tokens are persisted atomically by the SDK OAuth provider.
 *   PROCMEM_POLL_MS                  catalog poll interval (default 30000)
 *   PROCMEM_MEMORY=0                 do not expose memory__* tools
 *   PROCMEM_INTEGRATIONS=0           do not expose integration__* tools
 *   PROCMEM_ALLOW_INSECURE_LOCALHOST=1  allow http:// on loopback (local testing only)
 *   PROCMEM_BRIDGE_LOG=quiet         suppress stderr diagnostics
 * stdout carries only MCP protocol messages; diagnostics go to stderr and never include credentials.
 */
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLiveToolsBridge } from "./bridge.js";
import { LiveToolRegistry } from "./registry.js";

// Anything that would write to stdout (including library console.debug) goes to stderr instead.
const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

function fail(message: string): never {
  process.stderr.write(`procmem-live-mcp: ${message}\n`);
  process.exit(2);
}

/** OAuth refresh via the SDK provider (src/sdk/oauth-refresh.ts). Config file holds no secrets; argv never does. */
async function loadOAuth(configPath: string, baseUrl: string, insecure: boolean): Promise<{ getToken: () => Promise<string>; forceRefresh: (r: string | undefined) => Promise<unknown>; dispose: () => void }> {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    fail("PROCMEM_OAUTH_CONFIG is not a readable JSON file");
  }
  for (const k of ["accessToken", "refreshToken", "access_token", "refresh_token", "clientSecret", "client_secret"]) {
    if (k in cfg) fail(`PROCMEM_OAUTH_CONFIG must not contain ${k}; tokens live in the token store, a client secret in PROCMEM_OAUTH_CLIENT_SECRET`);
  }
  const str = (k: string) => (typeof cfg[k] === "string" && cfg[k] ? (cfg[k] as string) : undefined);
  const tokenEndpoint = str("tokenEndpoint");
  const clientId = str("clientId");
  const tokenStore = str("tokenStore");
  if (!tokenEndpoint || !clientId || !tokenStore) fail("PROCMEM_OAUTH_CONFIG needs tokenEndpoint, clientId and tokenStore");
  const method = (cfg.clientAuth as { method?: string } | undefined)?.method ?? "none";
  const secret = process.env.PROCMEM_OAUTH_CLIENT_SECRET;
  if (method !== "none" && !secret) fail(`clientAuth ${method} needs PROCMEM_OAUTH_CLIENT_SECRET`);
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") fail("clientAuth.method must be none, client_secret_post or client_secret_basic");
  const { FileTokenStore, OAuthRefreshProvider } = await import("../oauth-refresh.js");
  try {
    const provider = new OAuthRefreshProvider({
      tokenEndpoint,
      clientId,
      clientAuth: method === "none" ? { method: "none" } : { method: method as "client_secret_post" | "client_secret_basic", clientSecret: secret! },
      resource: str("resource") ?? `${baseUrl.replace(/\/+$/, "")}/mcp`,
      ...(str("scope") ? { scope: str("scope") } : {}),
      store: new FileTokenStore(tokenStore),
      allowInsecureLocalhost: insecure,
    });
    return { getToken: provider.getToken, forceRefresh: provider.forceRefresh, dispose: () => provider.dispose() };
  } catch (error) {
    fail(`invalid OAuth configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write("procmem-live-mcp: configure with PROCMEM_BASE_URL and PROCMEM_API_KEY or PROCMEM_TOKEN_FILE (see docs/sdk-live-tools.md)\n");
    return;
  }
  if (argv.length) fail("this command takes no arguments; configure it with environment variables (credentials are never accepted as arguments)");
  const env = process.env;
  const baseUrl = env.PROCMEM_BASE_URL;
  if (!baseUrl) fail("PROCMEM_BASE_URL is required");
  const insecure = env.PROCMEM_ALLOW_INSECURE_LOCALHOST === "1";
  const sources = { static: env.PROCMEM_API_KEY, "token-file": env.PROCMEM_TOKEN_FILE, oauth: env.PROCMEM_OAUTH_CONFIG };
  const configured = (Object.keys(sources) as Array<keyof typeof sources>).filter((k) => sources[k]);
  const mode = env.PROCMEM_AUTH ?? (configured.length === 1 ? configured[0] : undefined);
  if (!mode) fail(configured.length ? `ambiguous auth configuration (${configured.join(", ")} all set); set PROCMEM_AUTH to choose one` : "set one of PROCMEM_API_KEY, PROCMEM_TOKEN_FILE or PROCMEM_OAUTH_CONFIG");
  if (!(mode in sources)) fail("PROCMEM_AUTH must be static, token-file or oauth");
  if (!sources[mode as keyof typeof sources]) fail(`PROCMEM_AUTH=${mode} but its variable is not set`);
  let credential: () => string | Promise<string>;
  let onUnauthorized: ((rejected: string | undefined) => Promise<unknown>) | undefined;
  let disposeAuth: () => void = () => undefined;
  if (mode === "static") {
    const key = sources.static!;
    credential = () => key;
  } else if (mode === "token-file") {
    const file = sources["token-file"]!;
    credential = async () => (await readFile(file, "utf8")).trim();
  } else {
    const oauth = await loadOAuth(sources.oauth!, baseUrl, insecure);
    credential = oauth.getToken;
    onUnauthorized = oauth.forceRefresh;
    disposeAuth = oauth.dispose;
  }
  const quiet = env.PROCMEM_BRIDGE_LOG === "quiet";
  const poll = Number(env.PROCMEM_POLL_MS ?? 30_000);

  let registry: LiveToolRegistry;
  try {
    registry = new LiveToolRegistry({
      parent: { baseUrl, credential, ...(onUnauthorized ? { onUnauthorized } : {}), allowInsecureLocalhost: insecure },
      memory: env.PROCMEM_MEMORY !== "0",
      integrations: env.PROCMEM_INTEGRATIONS !== "0",
      pollIntervalMs: Number.isFinite(poll) && poll >= 1000 ? poll : 30_000,
      clientName: "procmem-live-mcp",
      onLog: quiet ? undefined : (e) => process.stderr.write(`procmem-live-mcp ${e.level}: ${e.message}\n`),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const bridge = createLiveToolsBridge(registry, { name: "procmem-live-tools" });
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await bridge.close().catch(() => undefined);
    await registry.dispose();
    disposeAuth();
    process.exit(0);
  };
  transport.onclose = () => void shutdown();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
  // Serve immediately (tools/list returns whatever has been discovered so far plus the fallback pair); the first
  // refresh completes in the background and announces itself with notifications/tools/list_changed.
  await bridge.connect(transport);
  void registry.start().catch(() => undefined);
}

void main();
