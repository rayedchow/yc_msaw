import * as donorNangoWebhook from "../../../integrations/nango/webhook.js";
import type { SourceProviderModule } from "../../core/types.js";
import { CONTROL_MODULE_ID, type NangoRecordsSource } from "./config.js";
import { controlCoverage, sourceCoverage } from "./coverage.js";
import { mapLaneEvent } from "./export.js";
import { laneFromEnv, type LaneFromEnvOptions, type NangoRecordsLane } from "./lane.js";
import { registerLaneInternalRoutes } from "./routes.js";
import { laneTaskHandlers } from "./sync.js";
import { handleLaneWebhook, isLaneDelivery, registerLaneWebhookRoute } from "./webhook.js";

/**
 * Generic raw-record lane for operator-configured Nango integrations (README.md).
 *
 * Produces one control module (`nango-records`: webhook, setup API, poll/sync tasks, catalog
 * coverage) plus one module per configured source (its own sources/<source>/ directory and
 * activity_events source, export mapping and coverage). Sources colliding with a specialized
 * module or a donor-captured Nango integration are refused in config.ts, so specialized deep
 * integrations stay authoritative and no two modules claim the same path.
 */

function donorWebhook(body: string, signature: string) {
  return donorNangoWebhook.handleNangoWebhook({ body, signature });
}

interface DonorWebhookDelegate {
  claims(payload: Record<string, unknown>): boolean;
  handle(rawBody: string, signature: string): Promise<{ status: number; body?: unknown }>;
}

/**
 * Let the donor /webhooks/nango route hand this lane's deliveries over (shared patch request 2
 * adds registerNangoWebhookDelegate to the donor handler; until it is applied the lookup finds
 * nothing and the lane is reached only through /webhooks/nango-records and polling).
 */
function registerDonorDelegate(lane: NangoRecordsLane): void {
  const register = (donorNangoWebhook as { registerNangoWebhookDelegate?: (id: string, d: DonorWebhookDelegate) => void }).registerNangoWebhookDelegate;
  register?.(CONTROL_MODULE_ID, {
    claims: (payload) => isLaneDelivery(lane, payload),
    handle: (rawBody, signature) => handleLaneWebhook(lane, { rawBody, hmacHeader: signature }),
  });
}

function sourceModule(lane: NangoRecordsLane, source: NangoRecordsSource): SourceProviderModule {
  return {
    id: source.source,
    eventSources: [source.source],
    mirrorRoots: [],
    connectionProviders: [source.providerConfigKey],
    ownerScoped: source.audience === "personal",
    mapEvent: (row, _ctx, journal) => mapLaneEvent(source.source, row, journal),
    coverage: (ctx) => sourceCoverage(lane, source, ctx.tenantId),
  };
}

const laneModules = new WeakSet<SourceProviderModule>();

/** True for modules created by this lane (lets callers separate specialized modules from generic ones). */
export function isNangoRecordsModule(m: SourceProviderModule): boolean {
  return laneModules.has(m);
}

export function createNangoRecordsModules(lane: NangoRecordsLane): SourceProviderModule[] {
  const control: SourceProviderModule = {
    id: CONTROL_MODULE_ID,
    eventSources: [],
    mirrorRoots: [],
    connectionProviders: [],
    coverage: (ctx) => controlCoverage(lane, ctx.tenantId),
    publicRoutes: (app) => {
      registerLaneWebhookRoute(app, () => lane);
      registerDonorDelegate(lane);
    },
    internalRoutes: (app, deps) => registerLaneInternalRoutes(app, deps, () => lane),
    taskHandlers: () => laneTaskHandlers(() => lane),
  };
  const modules = [control, ...lane.catalog.sources.map((s) => sourceModule(lane, s))];
  for (const m of modules) laneModules.add(m);
  return modules;
}

/**
 * The provider list with the generic lane appended: `specialized` decides which names the
 * lane may never take. Used by providers/index.ts.
 */
export function withNangoRecordsProviders(
  specialized: readonly SourceProviderModule[],
  opts: LaneFromEnvOptions & { env?: NodeJS.ProcessEnv } = {},
): readonly SourceProviderModule[] {
  const only = specialized.filter((m) => !isNangoRecordsModule(m));
  const lane = laneFromEnv(opts.env ?? process.env, only, { delegateWebhook: donorWebhook, ...opts });
  return [...only, ...createNangoRecordsModules(lane)];
}

export { laneFromEnv } from "./lane.js";
export type { NangoRecordsLane } from "./lane.js";
