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
  };
  if (isPublicBinding(cfg) && (cfg.sandbox !== "modal" || cfg.store !== "modal")) {
    throw new Error(
      "Refusing to start: a publicly reachable server must use PROCMEM_SANDBOX=modal and PROCMEM_STORE=modal " +
        "(local sandboxes are not isolation boundaries and local storage does not survive container restarts).",
    );
  }
  return cfg;
}

/** True when the listener is reachable beyond this machine. */
export function isPublicBinding(cfg: Pick<ProcmemConfig, "host" | "publicUrl">): boolean {
  const loopbackHost = ["127.0.0.1", "localhost", "::1"].includes(cfg.host);
  const url = new URL(cfg.publicUrl);
  const loopbackUrl = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return !(loopbackHost && loopbackUrl);
}
