import path from "node:path";

/**
 * Runtime configuration from environment variables. Secrets (model keys,
 * Modal tokens) are read here on the host and never forwarded into sandboxes.
 */
export interface ProcmemConfig {
  host: string;
  port: number;
  /** Canonical public URL of this server (OAuth resource identity). */
  publicUrl: string;
  dataDir: string;
  /** "modal" = Modal Volume authority with a local read-through cache (hosted); "directory" = local only. */
  store: "modal" | "directory";
  /** Where customer shell commands and build workspaces run. */
  sandbox: "modal" | "local";
  fireworksApiKey?: string;
  buildModel: string;
  childModels: string[];
  timezoneOffsetMinutes: number;
  /** Host the server-side sources/ filesystem ($SOURCES tools + /v1/sources routes). PROCMEM_SOURCES=0 disables it. */
  sources: boolean;
  /**
   * Extra $SOURCES provider directories every member of a tenant may read (SOURCES_SHARED_PROVIDERS, comma separated),
   * e.g. operator-declared Nango records sources of org-wide tools. Every other unknown provider is owner-less: denied.
   */
  sourcesSharedProviders: string[];
  /** $SOURCES metadata (node/version) cache budget for this process, all tenants together (SOURCES_NODE_CACHE_MB). */
  sourcesNodeCacheBytes?: number;
}

export const DEFAULT_BUILD_MODEL = "accounts/fireworks/models/kimi-k3";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProcmemConfig {
  const port = Number(env.PORT ?? 3000);
  const host = env.HOST ?? "127.0.0.1";
  const store = (env.PROCMEM_STORE ?? "directory") as ProcmemConfig["store"];
  if (store !== "modal" && store !== "directory") throw new Error(`PROCMEM_STORE must be "modal" or "directory"`);
  // Modal is the default: the local backend is not an isolation boundary and
  // only exists for trusted offline fixtures (it cannot execute commands).
  const sandbox = (env.PROCMEM_SANDBOX ?? "modal") as ProcmemConfig["sandbox"];
  if (sandbox !== "modal" && sandbox !== "local") throw new Error(`PROCMEM_SANDBOX must be "modal" or "local"`);
  const cfg: ProcmemConfig = {
    host,
    port,
    publicUrl: (env.MCP_PUBLIC_URL ?? env.MCP_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    dataDir: path.resolve(env.PROCMEM_DATA_DIR ?? ".data"),
    store,
    sandbox,
    fireworksApiKey: env.FIREWORKS_API_KEY || undefined,
    buildModel: env.PROCMEM_BUILD_MODEL ?? DEFAULT_BUILD_MODEL,
    childModels: (env.PROCMEM_CHILD_MODELS ?? "accounts/fireworks/models/glm-5p3,accounts/fireworks/models/minimax-m3")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timezoneOffsetMinutes: Number(env.PROCMEM_DAY_OFFSET_MINUTES ?? 0),
    sources: !/^(0|false|no|off)$/i.test(env.PROCMEM_SOURCES?.trim() ?? ""),
    sourcesSharedProviders: (env.SOURCES_SHARED_PROVIDERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(s)),
    ...(env.SOURCES_NODE_CACHE_MB?.trim() ? { sourcesNodeCacheBytes: nodeCacheBytes(env.SOURCES_NODE_CACHE_MB) } : {}),
  };
  if (isPublicBinding(cfg) && (cfg.sandbox !== "modal" || cfg.store !== "modal")) {
    throw new Error(
      "Refusing to start: a publicly reachable server must use PROCMEM_SANDBOX=modal and PROCMEM_STORE=modal " +
        "(local sandboxes are not isolation boundaries and local storage does not survive container restarts).",
    );
  }
  return cfg;
}

function nodeCacheBytes(raw: string): number {
  const mb = Number(raw.trim());
  if (!Number.isInteger(mb) || mb < 16 || mb > 16_384) throw new Error("SOURCES_NODE_CACHE_MB must be an integer between 16 and 16384");
  return mb * 1024 * 1024;
}

/** True when the listener is reachable beyond this machine. */
export function isPublicBinding(cfg: Pick<ProcmemConfig, "host" | "publicUrl">): boolean {
  const loopbackHost = ["127.0.0.1", "localhost", "::1"].includes(cfg.host);
  const url = new URL(cfg.publicUrl);
  const loopbackUrl = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return !(loopbackHost && loopbackUrl);
}
