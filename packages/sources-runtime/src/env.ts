import { z } from "zod";

const optionalBooleanFlag = z.string().optional().transform((value) => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
});
const booleanFlagOffByDefault = z.string().optional().transform((value) => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
});
const booleanFlagOnByDefault = z.string().optional().transform((value) => {
  if (value === undefined) return true;
  const normalized = value.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no");
});

/**
 * Runtime environment for Aqueduct. Parsed once at import time; anything a
 * connector or core service reads from the environment must be declared here.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /** AES-256-GCM key material for provider tokens at rest. */
  ENCRYPTION_KEY: z.string().min(16),
  /** Pepper mixed into API key hashes stored in `api_keys`. */
  API_KEY_PEPPER: z.string().min(16),

  // AWS runtime resources. Credentials come from the ECS task role.
  AQUEDUCT_S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().optional(),

  // Nango provider connection broker.
  NANGO_SECRET_KEY: z.string().optional(),
  NANGO_WEBHOOK_SECRET: z.string().optional(),

  // WorkOS application credentials.
  WORKOS_API_KEY: z.string().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),

  /** Brain API origin for dashboard routes aqueduct deliberately passes through. */

  // Google Workspace domain-wide delegation (token vault).
  APP_GIT_SHA: z.string().optional(),
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_CLIENT_EMAIL: z.string().optional(),
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().optional(),
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_KEY_JSON: z.string().optional(),
  GOOGLE_WORKSPACE_USER_EMAIL: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  GOOGLE_CALENDAR_WATCH_TTL_SECONDS: z.string().optional(),

  // Provider OAuth apps.
  NOTION_CLIENT_ID: z.string().optional(),
  NOTION_CLIENT_SECRET: z.string().optional(),
  NOTION_REDIRECT_URI: z.string().optional(),
  NOTION_WEBHOOK_VERIFICATION_TOKEN: z.string().optional(),
  NOTION_STRUCTURED_INGESTION_ENABLED: z.string().optional(),
  GRANOLA_CLIENT_ID: z.string().optional(),
  GRANOLA_CLIENT_SECRET: z.string().optional(),
  GRANOLA_REDIRECT_URI: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),

  // Graph model providers. Optional so entrypoints can boot without graph LLM wiring.
  FIREWORKS_API_KEY: z.string().optional(),
  /** Kimi-family Fireworks output-token budget over a rolling 60-second bucket. */
  FIREWORKS_OUTPUT_TPM_KIMI: z.coerce.number().positive().default(150_000),
  /** GPT-OSS-family Fireworks output-token budget, isolated from Kimi traffic. */
  FIREWORKS_OUTPUT_TPM_GPT_OSS: z.coerce.number().positive().default(150_000),
  /** Optional shared input-token budget; unset leaves input throttling disabled. */
  FIREWORKS_INPUT_TPM: z.coerce.number().positive().optional(),
  /** Maximum simultaneous Fireworks requests across coordinated workers. */
  FIREWORKS_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(24),
  /** Set false only to bypass Fireworks token and concurrency admission. */
  FIREWORKS_GOVERNOR_ENABLED: booleanFlagOnByDefault,
  ANTHROPIC_API_KEY: z.string().optional(),
  GRAPH_LLM_PROVIDER: z.enum(["fireworks", "anthropic"]).default("fireworks"),
  GRAPH_LLM_MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CHAT_AGENT_PROVIDER: z.string().optional(),
  CHAT_AGENT_MODEL: z.string().optional(),
  CHAT_AGENT_REASONING_EFFORT: z.string().optional(),
  /** Programmatic tool calling is fail-closed and globally off by default. */
  AQUEDUCT_PROG_TOOLS: booleanFlagOnByDefault,
  /** Per-agent overrides allow independent staged rollout after Slice 0. */
  AQUEDUCT_CHAT_PROG_TOOLS: optionalBooleanFlag,
  AQUEDUCT_WIKI_PROG_TOOLS: optionalBooleanFlag,
  // Optional: absent credentials select the hermetic local-live wiki sandbox.
  MODAL_TOKEN_ID: z.string().optional(),
  MODAL_TOKEN_SECRET: z.string().optional(),
  GRAPH_INGEST_ENABLED: z.string().optional().transform((value) => {
    const normalized = value?.trim().toLowerCase();
    return normalized !== "false" && normalized !== "0" && normalized !== "off" && normalized !== "no";
  }),
  /** Parallel extraction lanes per KB; all non-extraction graph work remains per-KB serialized. */
  GRAPH_EXTRACTION_SHARDS: z.coerce.number().int().min(1).max(64).default(4),
  /** Parallel document extractions inside one shard task. */
  GRAPH_EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(1),
  /** Concurrent task-consumer loops per worker process. */
  WORKER_TASK_LOOPS: z.coerce.number().int().min(1).max(16).default(2),
  /** Comma-separated subset of sync|backfill|wiki|graph this worker consumes; unset/empty = all lanes. */
  WORKER_QUEUE_LANES: z.string().optional().transform((value, ctx) => {
    const lanes = (value ?? "").split(",").map((lane) => lane.trim()).filter((lane) => lane !== "");
    if (lanes.length === 0) return undefined;
    const known = ["sync", "backfill", "wiki", "graph"];
    for (const lane of lanes) {
      if (!known.includes(lane)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown worker queue lane "${lane}" (expected a comma-separated subset of ${known.join("|")})` });
        return z.NEVER;
      }
    }
    return [...new Set(lanes)];
  }),

  // Slack Socket Mode (app-level token; needs connections:write + authorizations:read).
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SOCKET_MODE_ENABLED: z.string().optional(),
  /** Shared Socket Mode pool size; Slack allows at most 10 concurrent connections per app. */
  SLACK_SOCKET_POOL_SIZE: z.coerce.number().int().min(1).max(10).default(2),
  SLACK_CONVERSATION_CONCURRENCY: z.string().optional(),
  SLACK_THREAD_CONCURRENCY: z.string().optional(),

  /** Public base URL used when registering provider webhooks/watch channels. */
  WEBHOOK_BASE_URL: z.string().optional(),

  PORT: z.coerce.number().default(3100),

  /** Optional Redis coordination ledger for cross-replica Fireworks limits. */
  REDIS_URL: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export type ProgToolsAgent = "chat" | "wiki";

export function progToolsEnabled(agent?: ProgToolsAgent): boolean {
  if (agent === "chat" && env.AQUEDUCT_CHAT_PROG_TOOLS !== undefined) return env.AQUEDUCT_CHAT_PROG_TOOLS;
  if (agent === "wiki" && env.AQUEDUCT_WIKI_PROG_TOOLS !== undefined) return env.AQUEDUCT_WIKI_PROG_TOOLS;
  return env.AQUEDUCT_PROG_TOOLS;
}
