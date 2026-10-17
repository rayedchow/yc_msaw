import { z } from "zod";
import { errorMessage } from "../util.js";

/**
 * Shared contract for every integration-subsystem tool.
 *
 * Scopes keep the code-authoring surface separate from anything a customer
 * sees. None of these tools belong on the customer memory MCP:
 *  - "builder-research": host-side research (Exa, bounded docs fetch, OpenAPI
 *    inspection, configured upstream MCP inspection). Credentials stay on the
 *    host; results are untrusted source data, never instructions.
 *  - "builder-workspace": file/command/git operations on one integration repo
 *    (mcps/<slug>/) inside an isolated, network-blocked Modal sandbox.
 *  - "host-deploy": host-owned actions (deploy plan / deploy). Not for models
 *    unless the host explicitly wires an approval step.
 */
export type IntegrationToolScope = "builder-research" | "builder-workspace" | "host-deploy";

export type ToolStatus = "succeeded" | "failed" | "partial";

export interface ToolError {
  /** Stable machine code, e.g. "invalid_input", "url_rejected", "tests_failed". */
  code: string;
  message: string;
  details?: unknown;
}

export interface IntegrationToolResult<T = unknown> {
  status: ToolStatus;
  data?: T;
  error?: ToolError;
}

export interface IntegrationCallContext {
  signal?: AbortSignal;
  /** Optional caller-supplied tool call id, echoed in receipts. */
  callId?: string;
}

export interface IntegrationToolDefinition {
  /** Exact registered name (snake_case). Execution happens only through this exact name. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 2020-12) for the input object; additionalProperties is false. */
  readonly inputSchema: Record<string, unknown>;
  readonly scope: IntegrationToolScope;
  /** Plain statement of where the answer comes from (live provider, sandbox repo, host receipt...). */
  readonly authority: string;
  /** True when the tool changes state (repo files, git refs, durable store, deployments). */
  readonly mutates: boolean;
  invoke(input: unknown, ctx?: IntegrationCallContext): Promise<IntegrationToolResult>;
}

/** Error that carries a stable code through to the tool result. */
export class IntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "IntegrationError";
  }
}

/**
 * Define a tool from a zod object schema. Input is validated strictly (unknown
 * keys rejected, no coercion); a validation failure is an explicit
 * "invalid_input" failure, never a guessed fix-up.
 */
export function defineTool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  scope: IntegrationToolScope;
  authority: string;
  mutates: boolean;
  input: S;
  run: (input: z.infer<S>, ctx: IntegrationCallContext) => Promise<IntegrationToolResult>;
}): IntegrationToolDefinition {
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(spec.name)) throw new Error(`Invalid tool name ${spec.name}`);
  const schema = spec.input.strict();
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: json,
    scope: spec.scope,
    authority: spec.authority,
    mutates: spec.mutates,
    async invoke(input: unknown, ctx: IntegrationCallContext = {}) {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) {
        return failed("invalid_input", `Invalid input for ${spec.name}: ${z.prettifyError(parsed.error)}`);
      }
      try {
        return await spec.run(parsed.data as z.infer<S>, ctx);
      } catch (error) {
        if (error instanceof IntegrationError) return failed(error.code, error.message, error.details);
        return failed("tool_error", errorMessage(error));
      }
    },
  };
}

export function succeeded<T>(data: T): IntegrationToolResult<T> {
  return { status: "succeeded", data };
}

export function failed(code: string, message: string, details?: unknown): IntegrationToolResult<never> {
  return { status: "failed", error: details === undefined ? { code, message } : { code, message, details } };
}

export function partial<T>(data: T, code: string, message: string): IntegrationToolResult<T> {
  return { status: "partial", data, error: { code, message } };
}

/** OpenAI-compatible function spec (same shape as src/build/llm.ts ToolSpec). */
export interface OpenAiFunctionSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toOpenAiToolSpecs(tools: readonly IntegrationToolDefinition[]): OpenAiFunctionSpec[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

/**
 * Invoke by exact name with a JSON argument string (as produced by a model
 * tool call). Unknown names and unparsable JSON are explicit failures.
 */
export async function invokeToolByName(
  tools: readonly IntegrationToolDefinition[],
  name: string,
  argumentsJson: string | undefined,
  ctx?: IntegrationCallContext,
): Promise<IntegrationToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return failed("unknown_tool", `No registered integration tool named ${JSON.stringify(name)}`);
  let input: unknown = {};
  if (argumentsJson && argumentsJson.trim()) {
    try {
      input = JSON.parse(argumentsJson);
    } catch (error) {
      return failed("invalid_json", `Arguments for ${name} are not valid JSON: ${errorMessage(error)}`);
    }
  }
  return tool.invoke(input, ctx);
}

/** Render a result for a model tool message: compact JSON, bounded. */
export function renderToolResult(result: IntegrationToolResult, maxChars = 24_000): string {
  const text = JSON.stringify(result);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[result truncated ${text.length - maxChars} chars; request a narrower range]`;
}

/**
 * Exact source record for one research fetch. Hash/size/time are computed by
 * the host from the bytes actually received; excerpts are verbatim slices.
 */
export interface SourceRecord {
  /** "src-" + first 16 hex of sha256(kind|url|sha256). Stable for identical content. */
  id: string;
  kind: "exa_search_result" | "exa_contents" | "exa_code_context" | "http_fetch" | "openapi" | "mcp_tools_list" | "mcp_tool_call";
  provider: "exa" | "http" | "mcp";
  url: string;
  finalUrl?: string;
  title?: string;
  publishedDate?: string;
  retrievedAt: string;
  sha256: string;
  bytes: number;
  contentType?: string;
  providerRequestId?: string;
  excerpt: string;
}
