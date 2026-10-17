import { z } from "zod";
import { sha256 } from "../util.js";
import { validateWiki } from "../wiki/validate.js";
import type { ToolSpec } from "./llm.js";
import { describeScope, scopeAllows, type WriteScope } from "./scope.js";
import {
  agentPath,
  MAX_KNOWLEDGE_WRITE_BYTES,
  MAX_WORK_WRITE_BYTES,
  parseAgentPath,
  WorkspaceError,
  type BuildArea,
  type BuildWorkspace,
  type WritableArea,
} from "./workspace.js";

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

export type ToolAccess = "read" | "write" | "control";

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  access: ToolAccess;
}

export interface ToolContext {
  agentId: string;
  depth: number;
  buildId: string;
  signal: AbortSignal;
}

/**
 * Extension point for external deterministic tool workers (e.g. research /
 * repo / test tools). The provider validates its own inputs against its
 * declared schema and returns a structured receipt or throws (a thrown
 * ToolError-like {code,message} keeps its code). Results are bounded and
 * marked when truncated; they are untrusted data for the agent.
 */
export interface ToolProvider {
  readonly id: string;
  /** Optional orientation added to the system prompt of agents that receive these tools (capabilities, not steps). */
  readonly promptGuidance?: string;
  descriptors(): ToolDescriptor[];
  invoke(name: string, input: unknown, ctx: ToolContext): Promise<unknown>;
  /** Release provider resources (sandboxes, bundles). runMemoryBuild calls it once in finally. */
  /** Release external resources. May return a JSON-able detail (recorded in the build receipt); throws on failure. */
  close?(): Promise<unknown>;
}

export interface ToolProviderRegistration {
  provider: ToolProvider;
  /** Root always gets provider tools; children only when true. */
  availableToChildren?: boolean;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type ToolOutcome = { ok: true; value: unknown } | { ok: false; code: string; message: string; details?: unknown };

export const MAX_TOOL_RESULT_BYTES = 16 * 1024;
const MAX_READ_RETURN_BYTES = 12 * 1024;

/** Serialize a tool outcome for the model, bounded with an explicit truncation marker. */
export function renderOutcome(outcome: ToolOutcome, maxBytes = MAX_TOOL_RESULT_BYTES): { text: string; truncated: boolean; bytes: number } {
  const full = outcome.ok
    ? JSON.stringify({ ok: true, ...(isPlainObject(outcome.value) ? outcome.value : { result: outcome.value }) })
    : JSON.stringify({ ok: false, error: { code: outcome.code, message: outcome.message, ...(outcome.details === undefined ? {} : { details: outcome.details }) } });
  const bytes = Buffer.byteLength(full, "utf8");
  if (bytes <= maxBytes) return { text: full, truncated: false, bytes };
  const head = Buffer.from(full, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
  return { text: `${head}\n…[tool output truncated by host: showed ${Buffer.byteLength(head)} of ${bytes} bytes; request a narrower slice]`, truncated: true, bytes };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Schemas (zod is the validator; JSON schema is derived from it for the model)
// ---------------------------------------------------------------------------

const PathArg = z.string().min(1).max(1000);
const AgentId = z.string().min(1).max(200);

export const TOOL_SCHEMAS = {
  ls: z
    .object({
      path: PathArg.default("knowledge/").describe("Directory to list, starting with an area: inputs/, published/, knowledge/, parent-draft/ or work/."),
      recursive: z.boolean().default(false).describe("List every file below the directory instead of immediate children."),
      maxEntries: z.number().int().min(1).max(2000).default(200),
    })
    .strict(),
  read: z
    .object({
      path: PathArg.describe("File path, e.g. inputs/sessions/<sessionId>/events.jsonl or knowledge/index.md."),
      offset: z.number().int().min(1).optional().describe("Line mode: 1-based first line (default 1)."),
      limit: z.number().int().min(1).max(4000).optional().describe("Line mode: number of lines (default 400)."),
      byteOffset: z.number().int().min(0).optional().describe("Byte mode: start byte. Use for very long lines (e.g. large JSON events)."),
      byteLimit: z.number().int().min(1).max(MAX_READ_RETURN_BYTES).optional().describe(`Byte mode: bytes to return (max ${MAX_READ_RETURN_BYTES}).`),
    })
    .strict(),
  grep: z
    .object({
      pattern: z.string().min(1).max(500),
      path: PathArg.default("inputs/").describe("Directory (or area root) to search recursively."),
      match: z.enum(["literal", "regex"]).default("literal").describe("literal (default) or regex; the receipt names the regex engine that ran."),
      ignoreCase: z.boolean().default(true),
      maxMatches: z.number().int().min(1).max(500).default(50),
    })
    .strict(),
  find: z
    .object({
      path: PathArg.default("inputs/").describe("Directory to search below."),
      name: z.string().min(1).max(200).describe("Glob: * matches within a path segment, ** across segments, ? one character. Without '/', matches the file name; with '/', the path relative to the search directory."),
      maxResults: z.number().int().min(1).max(2000).default(200),
    })
    .strict(),
  write: z
    .object({
      path: PathArg.describe("knowledge/<page>.md (within your write scope) or work/<file>."),
      content: z.string().max(MAX_WORK_WRITE_BYTES),
    })
    .strict(),
  edit: z
    .object({
      path: PathArg,
      old_text: z.string().min(1).describe("Exact text that must occur exactly once in the file."),
      new_text: z.string(),
    })
    .strict(),
  move: z.object({ from: PathArg, to: PathArg.describe("Destination; must not already exist (no silent overwrite).") }).strict(),
  delete: z.object({ path: PathArg }).strict(),
  validate: z.object({}).strict(),
  spawn_agents: z
    .object({
      agents: z
        .array(
          z
            .object({
              objective: z.string().trim().min(1).max(4000).describe("A scoped investigation question, not a prefilled answer. Label hypotheses as hypotheses."),
              paths: z.array(z.string().min(1).max(1000)).max(64).default([]).describe("Advisory focus paths (e.g. inputs/sessions/<id>/). Not a file allowlist."),
              knowledgeWriteScope: z
                .array(z.string().min(1).max(300))
                .max(256)
                .default([])
                .describe("Exclusive knowledge paths the child may change: exact pages (a/b.md) or directory subtrees (a/b). [] = read-only. Must lie within your own scope; active sibling scopes cannot overlap."),
              context: z.string().trim().max(8000).optional().describe("Orientation for the child (not evidence)."),
              includeParentDraft: z.boolean().default(false).describe("Root only: mount a read-only snapshot of the current root draft at parent-draft/ (for reviewers)."),
              modelProfileId: z.string().trim().min(1).max(64).optional().describe("Host-approved child profile id; arbitrary model strings are rejected."),
            })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
  wait_agents: z
    .object({
      agentIds: z.array(AgentId).max(32).optional().describe("Direct children to wait for (default: all your running children)."),
      timeoutMs: z.number().int().min(0).max(3_600_000).optional().describe("Clamped to the host's configured min/max. Returns as soon as one selected child finishes."),
    })
    .strict(),
  read_agent_result: z
    .object({
      agentId: AgentId,
      path: z.string().min(1).max(300).optional().describe("Optional knowledge/<page>.md in the child's patch: return the proposed full content instead of the summary."),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(4000).optional(),
    })
    .strict(),
  decide_agent_results: z
    .object({
      decisions: z
        .array(z.object({ agentId: AgentId, decision: z.enum(["accept", "reject"]), reason: z.string().trim().min(1).max(2000) }).strict())
        .min(1)
        .max(32),
    })
    .strict()
    .refine((v) => new Set(v.decisions.map((d) => d.agentId)).size === v.decisions.length, "decisions must name each agentId at most once"),
  cancel_agents: z.object({ agentIds: z.array(AgentId).min(1).max(32), reason: z.string().trim().min(1).max(2000) }).strict(),
  complete_task: z
    .object({
      summary: z.string().trim().min(1).max(4000).describe("Concise status delta for the parent: what you learned, Knowledge impact, uncertainty, next useful work."),
      handoffFile: z.string().min(1).max(300).optional().describe("Optional work/<file> with the complete handoff narrative; the host exports its exact bytes."),
    })
    .strict(),
  publish: z.object({ summary: z.string().trim().min(1).max(4000).describe("What changed in the wiki and why (recorded in the revision).") }).strict(),
} as const;

export type BuiltinToolName = keyof typeof TOOL_SCHEMAS;
export type ToolArgs<N extends BuiltinToolName> = z.output<(typeof TOOL_SCHEMAS)[N]>;

const DESCRIPTIONS: Record<BuiltinToolName, { access: ToolAccess; description: string }> = {
  ls: { access: "read", description: "List a directory in any area with byte sizes (immediate children by default, or recursive). Truncation is explicit." },
  read: { access: "read", description: "Read a file slice by lines (offset/limit) or bytes (byteOffset/byteLimit). Returns sha256, total size and nextOffset; never silently truncates." },
  grep: { access: "read", description: "Search files under a directory for a literal string (default) or regex. Returns area-prefixed path:line matches; truncation is explicit." },
  find: { access: "read", description: "Find files by glob name under a directory." },
  write: { access: "write", description: "Create or replace a whole file in knowledge/ (only inside your knowledgeWriteScope) or work/. Other areas are read-only." },
  edit: { access: "write", description: "Replace exact old_text (must occur exactly once) with new_text in a knowledge/ or work/ file." },
  move: { access: "write", description: "Move/rename a file within knowledge/ (both paths inside your scope) or within work/, e.g. promote knowledge/foo.md to knowledge/foo/index.md. Fails if the destination exists. Fix links afterwards (validate lists broken ones)." },
  delete: { access: "write", description: "Delete a file in knowledge/ (inside your scope) or work/. Update indexes and links afterwards." },
  validate: { access: "read", description: "Run the host structural validator (indexes, links, orphans, page size, path rules) on your current knowledge/ draft." },
  spawn_agents: {
    access: "control",
    description:
      'Start isolated child build agents for separable semantic objectives - the normal way to cover a multi-area cohort. Use it early and in parallel for substantial independent subject areas (distinct systems, integrations or workflow families) while you continue synthesis; children may recursively fan out their own sub-branches. Returns immediately with child ids; their work stays invisible until you accept it with decide_agent_results. Example: {"agents":[{"objective":"From the billing sessions, document how the billing API\'s refunds, pagination and webhooks actually behave, including failures","paths":["inputs/sessions/ses-billing-refunds-1/"],"knowledgeWriteScope":["billing"]},{"objective":"...deploy...","knowledgeWriteScope":["deploy"]}]}',
  },
  wait_agents: { access: "control", description: "Wait (bounded by timeoutMs) until one of the selected running children finishes; returns the compact state of the selected children, which are still running, and which completed handoffs await your decision." },
  read_agent_result: { access: "control", description: "Read a direct child's result: status, summary, handoff file, and patch summary with per-file base hashes and line diffs; or the proposed content of one patched page." },
  decide_agent_results: { access: "control", description: "Accept or reject completed direct-child handoffs. accept applies the child's patch to your draft only if every touched page still equals the child's base bytes (exact-base merge); otherwise it fails with a conflict receipt and nothing is applied. reject discards the patch." },
  cancel_agents: { access: "control", description: "Cancel running direct children (their work is discarded)." },
  complete_task: { access: "control", description: "Child only: finish with a summary and optional work/ handoff file. The host computes your patch (exact diff of your scope against your base)." },
  publish: { access: "control", description: "Root only: validate the draft and atomically publish it as the next memory revision against the pinned base. Requires no running children and every completed child handoff decided." },
};

// Delegation tools are listed right after orientation tools: they are the primary way to cover a multi-area cohort.
const COMMON_TOOLS: BuiltinToolName[] = ["ls", "read", "grep", "find", "spawn_agents", "wait_agents", "read_agent_result", "decide_agent_results", "cancel_agents", "write", "edit", "move", "delete", "validate"];
export const ROOT_TOOLS: readonly BuiltinToolName[] = [...COMMON_TOOLS, "publish"];
export const CHILD_TOOLS: readonly BuiltinToolName[] = [...COMMON_TOOLS, "complete_task"];

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

export function builtinDescriptors(names: readonly BuiltinToolName[]): ToolDescriptor[] {
  return names.map((name) => ({ name, description: DESCRIPTIONS[name].description, access: DESCRIPTIONS[name].access, inputSchema: jsonSchemaOf(TOOL_SCHEMAS[name]) }));
}

// ---------------------------------------------------------------------------
// Per-agent toolbox
// ---------------------------------------------------------------------------

export interface FileToolState {
  agentId: string;
  depth: number;
  buildId: string;
  isRoot: boolean;
  workspace: BuildWorkspace;
  scope: WriteScope;
  /** Knowledge renames declared through move (recorded in the child's patch). */
  declaredMoves: Array<{ from: string; to: string }>;
  signal: AbortSignal;
}

/** Control-plane operations implemented by the orchestrator (all receipts are host-computed). */
export interface ControlPlane {
  spawnAgents(agentId: string, args: ToolArgs<"spawn_agents">): Promise<unknown>;
  waitAgents(agentId: string, args: ToolArgs<"wait_agents">): Promise<unknown>;
  readAgentResult(agentId: string, args: ToolArgs<"read_agent_result">): Promise<unknown>;
  decideAgentResults(agentId: string, args: ToolArgs<"decide_agent_results">): Promise<unknown>;
  cancelAgents(agentId: string, args: ToolArgs<"cancel_agents">): Promise<unknown>;
  completeTask(agentId: string, args: ToolArgs<"complete_task">): Promise<unknown>;
  publish(agentId: string, args: ToolArgs<"publish">): Promise<unknown>;
}

const PROVIDER_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ALL_BUILTINS = new Set<string>(Object.keys(TOOL_SCHEMAS));

interface ProviderTool {
  provider: ToolProvider;
  descriptor: ToolDescriptor;
}

/** Validate provider registrations (unique, well-formed names that do not shadow built-ins). */
export function providerGuidance(registrations: readonly ToolProviderRegistration[], forChild: boolean): string[] {
  return registrations.filter((r) => (!forChild || r.availableToChildren) && r.provider.promptGuidance && r.provider.descriptors().length > 0).map((r) => r.provider.promptGuidance!);
}

export function resolveProviderTools(registrations: readonly ToolProviderRegistration[], forChild: boolean): Map<string, ProviderTool> {
  const out = new Map<string, ProviderTool>();
  for (const reg of registrations) {
    for (const d of reg.provider.descriptors()) {
      if (!PROVIDER_TOOL_NAME_RE.test(d.name)) throw new ToolError("invalid_provider", `Provider ${reg.provider.id}: invalid tool name ${JSON.stringify(d.name)}`);
      if (ALL_BUILTINS.has(d.name)) throw new ToolError("invalid_provider", `Provider ${reg.provider.id}: tool ${d.name} shadows a built-in tool`);
      if (out.has(d.name)) throw new ToolError("invalid_provider", `Duplicate provider tool ${d.name}`);
      if (!forChild || reg.availableToChildren) out.set(d.name, { provider: reg.provider, descriptor: d });
    }
  }
  return out;
}

export interface ToolCallRecord {
  name: string;
  ok: boolean;
  code?: string;
  durationMs: number;
  argsSha256: string;
  resultBytes: number;
  truncated: boolean;
}

export class AgentToolbox {
  readonly builtins: readonly BuiltinToolName[];
  readonly #providers: Map<string, ProviderTool>;

  constructor(
    readonly state: FileToolState,
    private readonly control: ControlPlane,
    providers: Map<string, ProviderTool>,
  ) {
    this.builtins = state.isRoot ? ROOT_TOOLS : CHILD_TOOLS;
    this.#providers = providers;
  }

  descriptors(): ToolDescriptor[] {
    return [...builtinDescriptors(this.builtins), ...[...this.#providers.values()].map((p) => p.descriptor)];
  }

  names(): string[] {
    return this.descriptors().map((d) => d.name);
  }

  specs(): ToolSpec[] {
    return this.descriptors().map((d) => ({ type: "function", function: { name: d.name, description: `[${d.access}] ${d.description}`, parameters: d.inputSchema } }));
  }

  /** Execute one tool call. Never throws: failures are explicit outcomes. */
  async invoke(name: string, rawArgs: string): Promise<ToolOutcome> {
    try {
      let args: unknown;
      try {
        args = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        throw new ToolError("invalid_arguments", "Arguments are not valid JSON");
      }
      const provider = this.#providers.get(name);
      if (provider) {
        const ctx: ToolContext = { agentId: this.state.agentId, depth: this.state.depth, buildId: this.state.buildId, signal: this.state.signal };
        return { ok: true, value: await provider.provider.invoke(name, args, ctx) };
      }
      if (!(name in TOOL_SCHEMAS)) throw new ToolError("unknown_tool", `Unknown tool ${name}. Available: ${this.names().join(", ")}`);
      const builtin = name as BuiltinToolName;
      if (!this.builtins.includes(builtin)) {
        throw new ToolError(
          "not_available",
          builtin === "publish" ? "publish is root-only: children hand back a proposal with complete_task and the parent decides it" : "complete_task is only for child agents; the root finishes with publish",
        );
      }
      const parsed = TOOL_SCHEMAS[builtin].safeParse(args);
      if (!parsed.success) throw new ToolError("invalid_arguments", z.prettifyError(parsed.error));
      return { ok: true, value: await this.#dispatch(builtin, parsed.data) };
    } catch (error) {
      return toOutcome(error);
    }
  }

  async #dispatch(name: BuiltinToolName, args: unknown): Promise<unknown> {
    const c = this.control;
    const id = this.state.agentId;
    switch (name) {
      case "ls":
        return this.#ls(args as ToolArgs<"ls">);
      case "read":
        return this.#read(args as ToolArgs<"read">);
      case "grep":
        return this.#grep(args as ToolArgs<"grep">);
      case "find":
        return this.#find(args as ToolArgs<"find">);
      case "write":
        return this.#write(args as ToolArgs<"write">);
      case "edit":
        return this.#edit(args as ToolArgs<"edit">);
      case "move":
        return this.#move(args as ToolArgs<"move">);
      case "delete":
        return this.#delete(args as ToolArgs<"delete">);
      case "validate":
        return this.#validate();
      case "spawn_agents":
        return c.spawnAgents(id, args as ToolArgs<"spawn_agents">);
      case "wait_agents":
        return c.waitAgents(id, args as ToolArgs<"wait_agents">);
      case "read_agent_result":
        return c.readAgentResult(id, args as ToolArgs<"read_agent_result">);
      case "decide_agent_results":
        return c.decideAgentResults(id, args as ToolArgs<"decide_agent_results">);
      case "cancel_agents":
        return c.cancelAgents(id, args as ToolArgs<"cancel_agents">);
      case "complete_task":
        return c.completeTask(id, args as ToolArgs<"complete_task">);
      case "publish":
        return c.publish(id, args as ToolArgs<"publish">);
    }
  }

  get #ws(): BuildWorkspace {
    return this.state.workspace;
  }

  #mountedOrThrow(area: BuildArea) {
    if (!this.#ws.mounted(area)) throw new ToolError("not_mounted", `${area}/ is not mounted for this agent`);
  }

  /** Writable-area + scope policy, enforced before any backend call. */
  #writable(p: string): { area: WritableArea; rel: string } {
    const { area, rel } = parseAgentPath(p);
    if (area !== "knowledge" && area !== "work") throw new ToolError("read_only", `${area}/ is read-only; write to knowledge/ (inside your scope) or work/`);
    if (area === "knowledge" && !scopeAllows(this.state.scope, rel)) {
      const scope = describeScope(this.state.scope);
      throw new ToolError(
        "scope_violation",
        `knowledge/${rel} is outside your knowledgeWriteScope (${scope === "all" ? "all" : scope.length ? scope.join(", ") : "[] read-only"})`,
      );
    }
    return { area, rel };
  }

  async #ls(args: ToolArgs<"ls">) {
    const { area, rel } = parseAgentPath(args.path, { allowDirectory: true });
    this.#mountedOrThrow(area);
    const files = await this.#ws.list(area, rel);
    const prefix = rel ? `${rel}/` : "";
    if (args.recursive) {
      const shown = files.slice(0, args.maxEntries);
      return { path: agentPath(area, rel), totalFiles: files.length, truncated: files.length > shown.length, entries: shown.map((f) => ({ path: agentPath(area, f.path), bytes: f.bytes })) };
    }
    const dirs = new Map<string, { files: number; bytes: number }>();
    const direct: Array<{ path: string; bytes: number }> = [];
    for (const f of files) {
      const sub = f.path.slice(prefix.length);
      const slash = sub.indexOf("/");
      if (slash < 0) direct.push({ path: agentPath(area, f.path), bytes: f.bytes });
      else {
        const d = `${prefix}${sub.slice(0, slash)}`;
        const cur = dirs.get(d) ?? { files: 0, bytes: 0 };
        cur.files += 1;
        cur.bytes += f.bytes;
        dirs.set(d, cur);
      }
    }
    const entries = [
      ...[...dirs.entries()].map(([d, v]) => ({ path: `${agentPath(area, d)}/`, type: "dir" as const, files: v.files, bytes: v.bytes })),
      ...direct.map((f) => ({ ...f, type: "file" as const })),
    ];
    const shown = entries.slice(0, args.maxEntries);
    return { path: agentPath(area, rel), totalFiles: files.length, truncated: entries.length > shown.length, entries: shown };
  }

  async #read(args: ToolArgs<"read">) {
    const { area, rel } = parseAgentPath(args.path);
    this.#mountedOrThrow(area);
    const bytes = await this.#ws.readFile(area, rel);
    const base = { path: agentPath(area, rel), sha256: sha256(bytes), totalBytes: bytes.length };
    if (args.byteOffset !== undefined || args.byteLimit !== undefined) {
      if (args.offset !== undefined || args.limit !== undefined) throw new ToolError("invalid_arguments", "Use either line mode (offset/limit) or byte mode (byteOffset/byteLimit), not both");
      const start = args.byteOffset ?? 0;
      if (start > bytes.length) throw new ToolError("out_of_range", `byteOffset ${start} is beyond end of file (${bytes.length} bytes)`);
      const end = Math.min(bytes.length, start + (args.byteLimit ?? MAX_READ_RETURN_BYTES));
      return { ...base, mode: "bytes", byteOffset: start, byteEnd: end, nextByteOffset: end < bytes.length ? end : null, truncated: end < bytes.length, content: bytes.subarray(start, end).toString("utf8") };
    }
    const lines = bytes.toString("utf8").split("\n");
    const startLine = args.offset ?? 1;
    if (startLine > lines.length) throw new ToolError("out_of_range", `offset ${startLine} is beyond end of file (${lines.length} lines)`);
    const wanted = args.limit ?? 400;
    const out: string[] = [];
    let used = 0;
    let lineTruncated = false;
    for (let i = startLine - 1; i < lines.length && out.length < wanted; i++) {
      const line = lines[i]!;
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (used + size > MAX_READ_RETURN_BYTES) {
        if (out.length === 0) {
          out.push(Buffer.from(line, "utf8").subarray(0, MAX_READ_RETURN_BYTES).toString("utf8"));
          lineTruncated = true;
        }
        break;
      }
      out.push(line);
      used += size;
    }
    const endLine = startLine + out.length - 1;
    const more = endLine < lines.length;
    return {
      ...base,
      mode: "lines",
      totalLines: lines.length,
      startLine,
      endLine,
      nextOffset: more ? endLine + 1 : null,
      truncated: more || lineTruncated,
      ...(lineTruncated ? { note: `Line ${startLine} is longer than ${MAX_READ_RETURN_BYTES} bytes and was cut; read it with byteOffset/byteLimit.` } : {}),
      content: out.join("\n"),
    };
  }

  async #grep(args: ToolArgs<"grep">) {
    const { area, rel } = parseAgentPath(args.path, { allowDirectory: true });
    this.#mountedOrThrow(area);
    const r = await this.#ws.grep(area, rel, { pattern: args.pattern, match: args.match, ignoreCase: args.ignoreCase, maxMatches: args.maxMatches });
    return { path: agentPath(area, rel), engine: r.engine, truncated: r.truncated, matchCount: r.matches.length, matches: r.matches.map((m) => `${agentPath(area, m.path)}:${m.line}: ${m.text}`) };
  }

  async #find(args: ToolArgs<"find">) {
    const { area, rel } = parseAgentPath(args.path, { allowDirectory: true });
    this.#mountedOrThrow(area);
    const re = globToRegExp(args.name);
    const prefix = rel ? `${rel}/` : "";
    const hits: string[] = [];
    let total = 0;
    for (const f of await this.#ws.list(area, rel)) {
      const sub = f.path.slice(prefix.length);
      const subject = args.name.includes("/") ? sub : sub.slice(sub.lastIndexOf("/") + 1);
      if (!re.test(subject)) continue;
      total += 1;
      if (hits.length < args.maxResults) hits.push(agentPath(area, f.path));
    }
    return { path: agentPath(area, rel), name: args.name, total, truncated: total > hits.length, paths: hits };
  }

  async #currentOrNull(area: WritableArea, rel: string): Promise<Buffer | null> {
    if (!(await this.#ws.exists(area, rel))) return null;
    return this.#ws.readFile(area, rel);
  }

  #checkSize(area: WritableArea, content: string) {
    const max = area === "knowledge" ? MAX_KNOWLEDGE_WRITE_BYTES : MAX_WORK_WRITE_BYTES;
    const size = Buffer.byteLength(content, "utf8");
    if (size > max) throw new ToolError("too_large", `Content is ${size} bytes; ${area}/ files are limited to ${max} bytes${area === "knowledge" ? " (split the page by subject)" : ""}`);
  }

  async #write(args: ToolArgs<"write">) {
    const { area, rel } = this.#writable(args.path);
    this.#checkSize(area, args.content);
    const prev = await this.#currentOrNull(area, rel);
    await this.#ws.writeFile(area, rel, args.content);
    return { path: agentPath(area, rel), created: prev === null, previousSha256: prev ? sha256(prev) : null, sha256: sha256(args.content), bytes: Buffer.byteLength(args.content) };
  }

  async #edit(args: ToolArgs<"edit">) {
    const { area, rel } = this.#writable(args.path);
    const current = (await this.#ws.readFile(area, rel)).toString("utf8");
    const count = current.split(args.old_text).length - 1;
    if (count !== 1) throw new ToolError("edit_mismatch", `old_text must occur exactly once in ${agentPath(area, rel)} (found ${count})`);
    const next = current.replace(args.old_text, () => args.new_text);
    this.#checkSize(area, next);
    await this.#ws.writeFile(area, rel, next);
    return { path: agentPath(area, rel), previousSha256: sha256(current), sha256: sha256(next), bytes: Buffer.byteLength(next) };
  }

  async #move(args: ToolArgs<"move">) {
    const from = this.#writable(args.from);
    const to = this.#writable(args.to);
    if (from.area !== to.area) throw new ToolError("invalid_arguments", "move must stay within one area (knowledge/ or work/)");
    if (from.rel === to.rel) throw new ToolError("invalid_arguments", "from and to are the same path");
    const content = await this.#ws.readFile(from.area, from.rel);
    if (await this.#ws.exists(to.area, to.rel)) throw new ToolError("already_exists", `${agentPath(to.area, to.rel)} already exists; move never overwrites`);
    await this.#ws.writeFile(to.area, to.rel, content.toString("utf8"));
    await this.#ws.removeFile(from.area, from.rel);
    if (from.area === "knowledge") this.state.declaredMoves.push({ from: from.rel, to: to.rel });
    return { from: agentPath(from.area, from.rel), to: agentPath(to.area, to.rel), sha256: sha256(content), note: "Links that pointed at the old path, and relative links inside the moved page, are not rewritten; run validate to find broken links." };
  }

  async #delete(args: ToolArgs<"delete">) {
    const { area, rel } = this.#writable(args.path);
    const prev = await this.#ws.readFile(area, rel);
    await this.#ws.removeFile(area, rel);
    return { path: agentPath(area, rel), deletedSha256: sha256(prev) };
  }

  async #validate() {
    const report = validateWiki(await this.#ws.snapshot("knowledge"));
    return {
      valid: report.ok,
      stats: report.stats,
      errorCount: report.errors.length,
      warningCount: report.warnings.length,
      errors: report.errors.slice(0, 50).map((e) => `${e.code} knowledge/${e.path}: ${e.message}`),
      warnings: report.warnings.slice(0, 30).map((w) => `${w.code} knowledge/${w.path}: ${w.message}`),
      truncated: report.errors.length > 50 || report.warnings.length > 30,
    };
  }
}

export function toOutcome(error: unknown): ToolOutcome {
  if (error instanceof ToolError) return { ok: false, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  if (error instanceof WorkspaceError) return { ok: false, code: error.code, message: error.message };
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    const e = error as { code: string; message?: string; details?: unknown };
    return { ok: false, code: e.code, message: e.message ?? String(error), ...(e.details === undefined ? {} : { details: e.details }) };
  }
  return { ok: false, code: "tool_failed", message: error instanceof Error ? error.message : String(error) };
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
