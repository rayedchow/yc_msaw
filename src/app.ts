import path from "node:path";
import { assertSafeStartup, loadAuthConfig, type AuthConfig } from "./auth/index.js";
import { loadConfig, type ProcmemConfig } from "./config.js";
import { CustomerWorkspaceManager } from "./customer/index.js";
import { DailyBuildService, type MemoryBuilder } from "./daily/service.js";
import { createProcmemServer, type IntegrationCatalogPort, type ServerDeps } from "./server.js";
import type { SandboxLease } from "./sandbox/types.js";
import { loadSourceRuntimeConfig, SourceRuntimeClient } from "./sources/runtime-client.js";
import { SourceService } from "./sources/service.js";
import { CachedObjectStore, DirectoryObjectStore, type ObjectStore } from "./store/objects.js";
import { TraceIngestor } from "./traces/index.js";

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the object store (tests inject a DirectoryObjectStore). */
  store?: ObjectStore;
  /** Override the memory builder (tests inject a scripted fixture builder). */
  builder?: MemoryBuilder;
  /** Override customer sandbox leases (tests inject LocalLease). */
  leaseFactory?: () => Promise<SandboxLease>;
  /** Override the integration catalog port; `null` disables it (no catalog on this host). */
  integrationCatalog?: ServerDeps["integrationCatalog"] | null;
  log?: (msg: string) => void;
}

export interface App {
  config: ProcmemConfig;
  auth: AuthConfig;
  store: ObjectStore;
  ingestor: TraceIngestor;
  builds: DailyBuildService;
  workspaces: CustomerWorkspaceManager;
  /** Server-side sources/ filesystem, unless disabled with PROCMEM_SOURCES=0. */
  sources: SourceService | null;
  server: ReturnType<typeof createProcmemServer>;
  listen(port?: number): Promise<{ url: string; mcpUrl: string; port: number }>;
  close(): Promise<void>;
}

export async function createStore(config: ProcmemConfig): Promise<ObjectStore> {
  if (config.store === "directory") return new DirectoryObjectStore(path.join(config.dataDir, "objects"));
  const { ModalObjectStore } = await import("./store/modal-objects.js");
  // Modal Volume is the authority; the local directory is only a read-through cache of immutable objects.
  return new CachedObjectStore(new ModalObjectStore(), new DirectoryObjectStore(path.join(config.dataDir, "cache")));
}

async function defaultLeaseFactory(config: ProcmemConfig): Promise<() => Promise<SandboxLease>> {
  if (config.sandbox === "modal") {
    const { createModalLease } = await import("./sandbox/modal.js");
    return () => createModalLease({ tags: { purpose: "customer-workspace" } });
  }
  // Local leases never execute commands (shell returns an explicit error); trusted offline use only.
  const { LocalLease } = await import("./sandbox/local.js");
  return () => LocalLease.create();
}

/** HTTP catalog port over the integrations subsystem (tenant ns + subject come from the verified caller). */
async function defaultIntegrationCatalog(store: ObjectStore, env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<IntegrationCatalogPort | undefined> {
  try {
    const mod = await import("./integrations/index.js");
    const childAuth = mod.loadChildAuthFromEnv(env);
    const catalogFor = (ns: string) => mod.createIntegrationCatalog({ ns, store, childAuth });
    return {
      list: async (ns) => ({ integrations: await catalogFor(ns).listDeployed(), childAuthConfigured: childAuth !== null }),
      accessToken: async (ns, subject, slug) => {
        // Decide expected outcomes structurally; only unexpected failures throw.
        if (childAuth === null) return { ok: false, reason: "child_auth_not_configured" };
        const token = await catalogFor(ns).accessToken(slug, { subject });
        return token ? { ok: true, token } : { ok: false, reason: "not_found" };
      },
    };
  } catch (error) {
    log(`integration catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function defaultBuilder(config: ProcmemConfig, log: (m: string) => void): Promise<MemoryBuilder> {
  const { createConfiguredBuilder } = await import("./daily/builder.js");
  return createConfiguredBuilder(config, log);
}

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m: string) => console.error(`[procmem] ${m}`));
  const config = loadConfig(env);
  const auth = await loadAuthConfig(env, { host: config.host });
  assertSafeStartup(auth, config.host);

  const store = opts.store ?? (await createStore(config));
  const ingestor = new TraceIngestor(store, { dayOffsetMinutes: config.timezoneOffsetMinutes });
  const workspaces = new CustomerWorkspaceManager({ leaseFactory: opts.leaseFactory ?? (await defaultLeaseFactory(config)) });
  const builds = new DailyBuildService({
    store,
    builder: opts.builder ?? (await defaultBuilder(config, log)),
    dayOffsetMinutes: config.timezoneOffsetMinutes,
    log,
  });
  const sources = config.sources ? new SourceService(store) : null;
  const runtimeConfig = sources ? loadSourceRuntimeConfig(env, config.publicUrl) : null;
  const server = createProcmemServer({
    auth,
    store,
    ingestor,
    workspaces,
    builds,
    ...(sources ? { sources } : {}),
    ...(runtimeConfig ? { sourceRuntime: new SourceRuntimeClient(runtimeConfig) } : {}),
    ...(await (async () => {
      const catalog = opts.integrationCatalog === null ? undefined : (opts.integrationCatalog ?? (await defaultIntegrationCatalog(store, env, log)));
      return catalog ? { integrationCatalog: catalog } : {};
    })()),
    ...(env.MCP_ALLOWED_HOSTS ? { allowedHosts: env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean) } : {}),
    log,
  });

  return {
    config,
    auth,
    store,
    ingestor,
    builds,
    workspaces,
    sources,
    server,
    async listen(port = config.port) {
      const bound = await server.listen(port, { host: config.host });
      const url = new URL(bound.url);
      return { url: `${url.protocol}//${url.host}`, mcpUrl: bound.url, port: bound.port };
    },
    async close() {
      await workspaces.closeAll();
      await server.close();
    },
  };
}
