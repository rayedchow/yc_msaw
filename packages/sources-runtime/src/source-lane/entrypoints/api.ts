import { serve } from "@hono/node-server";
import { db } from "../../db/client.js";
import { env } from "../../env.js";
import { assertSourceLaneMigrationsApplied, sourceLaneConfig } from "../core/boot.js";
import { SourceExporter } from "../export/exporter.js";
import { createInternalApp, createRuntimeApp } from "../internal/app.js";
import { defaultRegistry } from "../registry.js";

/**
 * Public listener (provider callbacks/webhooks/device routes) and the internal
 * yc_msaw API. With SOURCES_RUNTIME_INTERNAL_PORT the internal API gets its own
 * listener (bound to SOURCES_RUNTIME_INTERNAL_HOST, default 127.0.0.1) and is not
 * reachable on the public port.
 */
await assertSourceLaneMigrationsApplied();
const cfg = sourceLaneConfig();
const registry = defaultRegistry();
const deps = { db, registry, exporter: new SourceExporter({ db, registry }), ...(cfg.serviceTokenSha256 ? { serviceTokenSha256: cfg.serviceTokenSha256 } : {}) };
const publicApp = createRuntimeApp({ ...deps, mountInternal: cfg.internalPort === undefined });
serve({ fetch: publicApp.fetch, port: env.PORT }, (info) => console.log(`sources-runtime api on :${info.port}`));
if (cfg.internalPort !== undefined) {
  serve({ fetch: createInternalApp(deps).fetch, port: cfg.internalPort, hostname: cfg.internalHost }, (info) => console.log(`sources-runtime internal api on ${cfg.internalHost}:${info.port}`));
}
