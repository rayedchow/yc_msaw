import {
  createIntegrationToolProviders,
  createModalBuildWorkspaceFactory,
  createProfileRegistry,
  DEFAULT_PROFILES,
  fireworksClientFactory,
  localWorkspaceFactory,
  runMemoryBuild,
  type InvestigationBudget,
  type ToolProviderRegistration,
} from "../harness/index.js";
import type { ProcmemConfig } from "../config.js";
import type { MemoryBuilder } from "./service.js";

export interface BuilderOverrides {
  budget?: Partial<InvestigationBudget>;
  /** Replace the default per-build tool providers (tests). */
  toolProviders?: (ctx: { ns: string; buildId: string; store: import("../store/objects.js").ObjectStore }) => Promise<readonly ToolProviderRegistration[]>;
  /** Integration tools: "on" (default when available), "off", or "required" (fail the build if unavailable). */
  integrations?: "on" | "off" | "required";
  /** Let the root agent call host-deploy tools (Manufact publish/rollback). Default: PROCMEM_INTEGRATION_DEPLOY=1. */
  allowIntegrationDeploy?: boolean;
}

function profileIdFor(model: string): string {
  const profile = DEFAULT_PROFILES.find((p) => p.model === model || p.id === model);
  if (!profile) throw new Error(`Model ${model} has no host-approved build profile (approved: ${DEFAULT_PROFILES.map((p) => p.model).join(", ")})`);
  return profile.id;
}

/**
 * The production memory builder: AEye-style recursive multi-agent build over
 * the day's trace cohort, Fireworks models, workspaces in Modal sandboxes
 * (or the trusted-offline local backend only when explicitly configured).
 */
export function createConfiguredBuilder(config: ProcmemConfig, log: (m: string) => void, overrides: BuilderOverrides = {}): MemoryBuilder {
  const rootProfileId = profileIdFor(config.buildModel);
  const childProfileIds = [...new Set([rootProfileId, ...config.childModels.map(profileIdFor)])];
  const profiles = createProfileRegistry({ rootProfileId, childProfileIds, defaultChildProfileId: rootProfileId });
  const workspaceFactory =
    config.sandbox === "modal" ? createModalBuildWorkspaceFactory({ tags: { purpose: "memory-build" } }) : localWorkspaceFactory;

  const integrationsMode = overrides.integrations ?? ((process.env.PROCMEM_INTEGRATIONS as "on" | "off" | "required" | undefined) ?? "on");

  return async ({ repo, ns, buildId, inputs, sources, signal }) => {
    if (!config.fireworksApiKey) {
      return { status: "failed", error: "FIREWORKS_API_KEY is not configured on the build host; no build was attempted" };
    }
    const receipt = await runMemoryBuild({
      repo,
      inputs,
      sources,
      buildId,
      profiles,
      clientFactory: fireworksClientFactory(config.fireworksApiKey),
      workspaceFactory,
      ...(overrides.budget ? { budget: overrides.budget } : {}),
      // Per-build integration runtime bound to the HOST tenant ns + buildId; runMemoryBuild closes
      // providers in its finally (persists repo bundles, terminates the Modal sandbox).
      toolProviders: overrides.toolProviders
        ? await overrides.toolProviders({ ns, buildId, store: repo.store })
        : integrationsMode === "off"
          ? []
          : await createIntegrationToolProviders({
              ns,
              store: repo.store,
              buildId,
              allowHostDeploy: overrides.allowIntegrationDeploy ?? process.env.PROCMEM_INTEGRATION_DEPLOY === "1",
              required: integrationsMode === "required",
              log: (m) => log(`[build ${buildId}] ${m}`),
            }),
      signal,
      log: (event) => log(`[build ${buildId}] ${typeof event === "string" ? event : JSON.stringify(event)}`),
    });
    return {
      ...receipt,
      status: receipt.status,
      revisionId: receipt.revisionId,
      ...(receipt.failure ? { error: `${receipt.failure.code}: ${receipt.failure.message}` } : {}),
    };
  };
}
