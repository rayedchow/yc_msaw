/**
 * Integration MCP subsystem: research, per-integration Git workspaces in Modal,
 * sealed validation, promotion, and host-owned Manufact publishing.
 * See docs/integrations.md and .context/integrations-progress.md.
 */
export * from "./types.js";
export { createIntegrationRuntime, INTEGRATION_BUILDER_INSTRUCTIONS, catalogEntry, type IntegrationRuntime, type IntegrationRuntimeDeps } from "./runtime.js";
export { createIntegrationCatalog, createCustomerIntegrationTools, integrationCatalogFingerprint, IntegrationCatalog, type DeployedIntegration } from "./catalog.js";
export { IntegrationStore, lifecycleState, type IntegrationLifecycle, type LifecycleEvent, type IntegrationRecord, type PromotedRevision, type DeploymentRecord, type ManufactServerRecord } from "./store.js";
export { createModalIntegrationSandbox, createHostTestSandbox, integrationImageCommands, integrationImageSpecSha256, PREBAKED_DEPENDENCIES, type IntegrationSandbox } from "./sandbox.js";
export { RepoWorkspace, parsePorcelainV2 } from "./workspace.js";
export { validateWorkspace, ManifestSchema, SuiteCaseSchema, type HostSuite, type SuiteProvider, type ValidationReceiptBody } from "./validate.js";
export { ManufactApi, resolveManufactCredentials, type ManufactCredentials } from "./manufact.js";
export { ManufactPublisher, evaluateExpect, type PublisherOptions, type PublishOutcome, type ProbeResult, type ProbeClient } from "./publish.js";
export { generateChildAuthKeys, loadChildAuthFromEnv, exportChildSigningJwk, mintChildToken, verifyChildToken, childAudience, childAuthEnv, type ChildAuthKeys } from "./child-auth.js";
export * from "./research/index.js";
export { retireIntegration, restoreIntegration, isListed, type LifecycleOutcome } from "./lifecycle.js";
