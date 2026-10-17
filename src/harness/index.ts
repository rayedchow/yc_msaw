/** Stable public API of the daily procedural-memory build harness. */
export { runMemoryBuild, type MemoryBuildOptions, type BuildReceipt, type BuildAttemptReceipt, type BuildStatus } from "./daily.js";
export {
  BuildOrchestrator,
  runBuildTree,
  type AgentReceipt,
  type AgentStatus,
  type BuildLogger,
  type BuildOutcome,
  type DecisionRecord,
  type OrchestratorOptions,
  type OrchestratorResult,
  type PublishCallback,
  type PublishRequest,
  type PublishResult,
} from "./orchestrator.js";
export { DEFAULT_BUILD_BUDGET, resolveBudget, BudgetExhaustedError, BudgetConfigError, type InvestigationBudget, type AgentUsage } from "./budget.js";
export {
  APPROVED_FIREWORKS_MODELS,
  DEFAULT_PROFILES,
  createProfileRegistry,
  fireworksClientFactory,
  ProfileError,
  type ModelProfile,
  type ProfileRegistry,
  type ChatClientFactory,
  type ClientContext,
} from "./profiles.js";
export {
  LocalBuildWorkspace,
  ModalBuildWorkspace,
  localWorkspaceFactory,
  modalWorkspaceFactory,
  WorkspaceError,
  type BuildWorkspace,
  type BuildWorkspaceFactory,
  type WorkspaceSpec,
} from "./workspace.js";
export { ToolError, type ToolProvider, type ToolProviderRegistration, type ToolDescriptor, type ToolContext, type ToolAccess } from "./tools.js";
export { createModalBuildWorkspaceFactory } from "./modal.js";
export { IntegrationToolProvider, IntegrationRuntimeProvider, createIntegrationToolProviders, type IntegrationProviderOptions, type IntegrationProvidersOptions } from "./integration-provider.js";
export type { ChatClient, ChatMessage, ChatResult, ToolSpec } from "./llm.js";
export { OpenAICompatibleClient, validateFireworksKey } from "./llm.js";
