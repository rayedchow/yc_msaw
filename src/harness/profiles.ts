import { OpenAICompatibleClient, type ChatClient } from "./llm.js";

/**
 * Host-approved construction-model profiles (AEye "modelProfileId" routing):
 * the root runs on one profile; children may select only ids the host
 * advertises. Arbitrary provider/model strings from a model are rejected.
 */
export interface ModelProfile {
  id: string;
  provider: "fireworks";
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  description?: string;
}

/** Exact Fireworks model ids verified live for this project (.context/fireworks-models.json). */
export const APPROVED_FIREWORKS_MODELS: ReadonlySet<string> = new Set([
  "accounts/fireworks/models/kimi-k3",
  "accounts/fireworks/models/glm-5p3",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/glm-5p3-flash",
  "accounts/fireworks/routers/kimi-k3-fast",
  "accounts/fireworks/routers/glm-5p3-fast",
]);

export const DEFAULT_PROFILES: readonly ModelProfile[] = [
  { id: "kimi-k3", provider: "fireworks", model: "accounts/fireworks/models/kimi-k3", maxTokens: 8192, temperature: 0.2, timeoutMs: 240_000, description: "Kimi K3: strong long-context synthesis (default root)" },
  { id: "glm-5p3", provider: "fireworks", model: "accounts/fireworks/models/glm-5p3", maxTokens: 8192, temperature: 0.2, timeoutMs: 240_000, description: "GLM 5.3: general construction child" },
  { id: "minimax-m3", provider: "fireworks", model: "accounts/fireworks/models/minimax-m3", maxTokens: 8192, temperature: 0.2, timeoutMs: 240_000, description: "MiniMax M3: alternative construction child" },
];

export class ProfileError extends Error {
  readonly code = "invalid_model_profile";
}

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ProfileRegistry {
  readonly root: ModelProfile;
  /** Profiles a parent may select for a child (advertised to the model by id). */
  readonly selectable: readonly ModelProfile[];
  readonly defaultChild: ModelProfile;
  /** Resolve a model-supplied profile id; undefined selects the default child profile. */
  childProfile(id: string | undefined): ModelProfile;
}

export function createProfileRegistry(opts: {
  profiles?: readonly ModelProfile[];
  rootProfileId?: string;
  childProfileIds?: readonly string[];
  defaultChildProfileId?: string;
  /** Extra exact model ids the host approves (e.g. for evals). Never taken from model output. */
  extraApprovedModels?: readonly string[];
} = {}): ProfileRegistry {
  const profiles = opts.profiles ?? DEFAULT_PROFILES;
  const approved = new Set([...APPROVED_FIREWORKS_MODELS, ...(opts.extraApprovedModels ?? [])]);
  const byId = new Map<string, ModelProfile>();
  for (const p of profiles) {
    if (!PROFILE_ID_RE.test(p.id)) throw new ProfileError(`Invalid profile id ${JSON.stringify(p.id)}`);
    if (byId.has(p.id)) throw new ProfileError(`Duplicate profile id ${p.id}`);
    if (p.provider !== "fireworks") throw new ProfileError(`Profile ${p.id}: unsupported provider ${String(p.provider)}`);
    if (!approved.has(p.model)) throw new ProfileError(`Profile ${p.id}: model ${p.model} is not host-approved`);
    if (!Number.isInteger(p.maxTokens) || p.maxTokens < 256 || p.maxTokens > 65_536) throw new ProfileError(`Profile ${p.id}: maxTokens out of range`);
    if (!(p.temperature >= 0 && p.temperature <= 2)) throw new ProfileError(`Profile ${p.id}: temperature out of range`);
    if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1_000 || p.timeoutMs > 1_800_000) throw new ProfileError(`Profile ${p.id}: timeoutMs out of range`);
    byId.set(p.id, Object.freeze({ ...p }));
  }
  const get = (id: string, what: string) => {
    const p = byId.get(id);
    if (!p) throw new ProfileError(`${what} profile ${JSON.stringify(id)} is not configured`);
    return p;
  };
  const first = profiles[0];
  if (!first) throw new ProfileError("At least one model profile is required");
  const root = get(opts.rootProfileId ?? first.id, "Root");
  const selectable = (opts.childProfileIds ?? [...byId.keys()]).map((id) => get(id, "Child"));
  if (selectable.length === 0) throw new ProfileError("At least one selectable child profile is required");
  const defaultChild = get(opts.defaultChildProfileId ?? root.id, "Default child");
  if (!selectable.includes(defaultChild)) throw new ProfileError(`Default child profile ${defaultChild.id} must be selectable`);
  return {
    root,
    selectable,
    defaultChild,
    childProfile(id) {
      if (id === undefined) return defaultChild;
      const p = selectable.find((s) => s.id === id);
      if (!p) throw new ProfileError(`Unknown or unavailable child model profile ${JSON.stringify(id)}. Available: ${selectable.map((s) => s.id).join(", ")}`);
      return p;
    },
  };
}

/** Context passed to the client factory so hosts (and test fixtures) can attribute calls per agent. */
export interface ClientContext {
  buildId: string;
  agentId: string;
  parentId: string | null;
  depth: number;
  objective: string;
}

export type ChatClientFactory = (profile: ModelProfile, ctx: ClientContext) => ChatClient;

/** Production factory: one OpenAI-compatible Fireworks client per agent with the profile's limits. */
export function fireworksClientFactory(apiKey: string, opts: { baseUrl?: string; maxRetries?: number } = {}): ChatClientFactory {
  if (!apiKey) throw new ProfileError("Missing Fireworks API key");
  return (profile) =>
    new OpenAICompatibleClient(profile.model, {
      apiKey,
      baseUrl: opts.baseUrl,
      maxRetries: opts.maxRetries,
      timeoutMs: profile.timeoutMs,
      maxTokens: profile.maxTokens,
      temperature: profile.temperature,
    });
}
