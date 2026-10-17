import { z } from "zod";
import { MAX_GREP_PATTERN_CHARS, MAX_LIST_LIMIT, MAX_READ_BYTES, MAX_READ_LINES } from "./tree.js";

/**
 * Customer-facing filesystem tool schemas, ported from the AEye workspace MCP
 * tools (read/grep/find/ls/shell/poll_command/write_command/cancel_command/write/edit)
 * and adapted to procedural memory: $KNOWLEDGE is the published memory wiki
 * (read-only), $WORK/scratch is this workspace's private writable scratch.
 */

export const MAX_SCRATCH_WRITE_BYTES = 256 * 1024;
export const MAX_SCRIPT_CHARS = 32_000;
export const MIN_SHELL_TIMEOUT_MS = 100;
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const MAX_SHELL_TIMEOUT_MS = 15 * 60_000;
export const MIN_YIELD_MS = 250;
export const DEFAULT_SHELL_YIELD_MS = 10_000;
export const MAX_YIELD_MS = 30_000;
export const DEFAULT_POLL_YIELD_MS = 5_000;
export const DEFAULT_WRITE_COMMAND_YIELD_MS = 1_000;

const PathSchema = z.string().min(1).max(2_000);
const CommandIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "commandId must be the id returned by shell");
const LimitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT);

export const ReadSchema = z
  .object({
    path: PathSchema.describe("$KNOWLEDGE/... or $WORK/scratch/... (relative paths resolve below $WORK/scratch)."),
    offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe("One-based line number to start from; defaults to 1."),
    limit: z.number().int().min(1).max(MAX_READ_LINES).optional().describe(`Maximum lines to return; defaults to ${MAX_READ_LINES}.`),
    byteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe("Zero-based byte offset. Do not combine with line offset or limit."),
    byteLimit: z.number().int().min(1).max(MAX_READ_BYTES).optional().describe(`Maximum bytes to return; defaults to ${MAX_READ_BYTES}.`),
  })
  .strict()
  .superRefine((input, ctx) => {
    const lineSlice = input.offset !== undefined || input.limit !== undefined;
    const byteSlice = input.byteOffset !== undefined || input.byteLimit !== undefined;
    if (lineSlice && byteSlice) ctx.addIssue({ code: "custom", message: "read line slicing and byte slicing cannot be combined" });
  });

export const GrepSchema = z
  .object({
    pattern: z.string().min(1).max(MAX_GREP_PATTERN_CHARS).describe("JavaScript regular expression (or exact text with literal: true), matched per line."),
    path: PathSchema.default("$KNOWLEDGE").describe("File or directory to search; defaults to $KNOWLEDGE."),
    glob: z.string().min(1).max(500).optional().describe("Only search files matching this glob (basename unless it contains '/'), e.g. '*.md'."),
    literal: z.boolean().default(false),
    ignoreCase: z.boolean().default(false),
    limit: LimitSchema.default(MAX_LIST_LIMIT).describe("Maximum matching lines."),
  })
  .strict();

export const FindSchema = z
  .object({
    pattern: z.string().min(1).max(500).default("*").describe("Glob matched against basenames (or relative paths when it contains '/'), e.g. '*.md' or '**/deploy*'."),
    path: PathSchema.default("$KNOWLEDGE"),
    limit: LimitSchema.default(MAX_LIST_LIMIT),
  })
  .strict();

export const LsSchema = z
  .object({
    path: PathSchema.default("$KNOWLEDGE"),
    limit: LimitSchema.default(MAX_LIST_LIMIT),
  })
  .strict();

export const ShellSchema = z
  .object({
    script: z.string().min(1).max(MAX_SCRIPT_CHARS).describe("Bash script. cwd is $WORK/scratch; $KNOWLEDGE and $WORK are set; no network."),
    timeout_ms: z
      .number()
      .int()
      .min(MIN_SHELL_TIMEOUT_MS)
      .max(MAX_SHELL_TIMEOUT_MS)
      .optional()
      .describe(`Command wall-time deadline in milliseconds; defaults to ${DEFAULT_SHELL_TIMEOUT_MS}, at most ${MAX_SHELL_TIMEOUT_MS}.`),
    yield_time_ms: z
      .number()
      .int()
      .min(MIN_YIELD_MS)
      .max(MAX_YIELD_MS)
      .optional()
      .describe(`Return a resumable commandId if the command is still running after this many milliseconds. Defaults to ${DEFAULT_SHELL_YIELD_MS}.`),
  })
  .strict();

export const PollCommandSchema = z
  .object({
    commandId: CommandIdSchema,
    yield_time_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_YIELD_MS)
      .optional()
      .describe(`How long to wait for completion (returns early when the command finishes). Defaults to ${DEFAULT_POLL_YIELD_MS}ms.`),
  })
  .strict();

export const WriteCommandSchema = z
  .object({
    commandId: CommandIdSchema,
    text: z.string().max(MAX_SCRIPT_CHARS).default("").describe("Exact text to write to the command's stdin (include \\n for line input)."),
    close: z.boolean().default(false).describe("Close stdin after writing (sends EOF)."),
    yield_time_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_YIELD_MS)
      .optional()
      .describe(`How long to wait for output after writing; defaults to ${DEFAULT_WRITE_COMMAND_YIELD_MS}ms.`),
  })
  .strict();

export const CancelCommandSchema = z.object({ commandId: CommandIdSchema }).strict();

export const WriteSchema = z
  .object({
    path: PathSchema.describe("File below $WORK/scratch (relative paths resolve there)."),
    content: z.string().max(MAX_SCRATCH_WRITE_BYTES),
  })
  .strict();

export const EditSchema = z
  .object({
    path: PathSchema.describe("Existing file below $WORK/scratch."),
    edits: z
      .array(
        z
          .object({
            oldText: z.string().min(1).max(MAX_SCRATCH_WRITE_BYTES).describe("Exact text that must occur exactly once in the original file."),
            newText: z.string().max(MAX_SCRATCH_WRITE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .describe("Replacements matched against the original file; each oldText must be unique and edits must not overlap."),
  })
  .strict();

export type ReadInput = z.input<typeof ReadSchema>;
export type GrepInput = z.input<typeof GrepSchema>;
export type FindInput = z.input<typeof FindSchema>;
export type LsInput = z.input<typeof LsSchema>;
export type ShellInput = z.input<typeof ShellSchema>;
export type PollCommandInput = z.input<typeof PollCommandSchema>;
export type WriteCommandInput = z.input<typeof WriteCommandSchema>;
export type CancelCommandInput = z.input<typeof CancelCommandSchema>;
export type WriteInput = z.input<typeof WriteSchema>;
export type EditInput = z.input<typeof EditSchema>;

export type CustomerToolName = "read" | "grep" | "find" | "ls" | "shell" | "poll_command" | "write_command" | "cancel_command" | "write" | "edit";

/** How a customer agent should orient itself in a workspace (also embedded in read/ls/find descriptions). */
export const CUSTOMER_WORKSPACE_ORIENTATION =
  "How to orient: start by reading $KNOWLEDGE/index.md, then follow the index links to subject and workflow pages; use grep/find on $KNOWLEDGE to locate specific procedures. $KNOWLEDGE is the published procedural memory (read-only); $WORK/scratch is your private writable scratch (never published).";

export interface CustomerToolDefinition {
  name: CustomerToolName;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** True if the tool can change $WORK/scratch or a running command (never published memory). */
  mutates: boolean;
  /** MCP annotation: !mutates. */
  readOnly: boolean;
}

const TOOL_DEFINITIONS: ReadonlyArray<Omit<CustomerToolDefinition, "readOnly">> = [
  {
    name: "read",
    title: "Read a workspace file",
    description:
      "Read a bounded UTF-8 slice from the pinned, read-only procedural memory wiki under $KNOWLEDGE, or from this workspace's private $WORK/scratch. Use line offset/limit or byteOffset/byteLimit (not both). " + CUSTOMER_WORKSPACE_ORIENTATION,
    inputSchema: ReadSchema,
    mutates: false,
  },
  {
    name: "grep",
    title: "Search workspace text",
    description:
      "Search bounded line matches below the read-only procedural memory wiki ($KNOWLEDGE, the default) or this workspace's $WORK/scratch. Regex by default; literal: true for exact text.",
    inputSchema: GrepSchema,
    mutates: false,
  },
  {
    name: "find",
    title: "Find workspace paths",
    description: "Find paths by bounded glob below the read-only procedural memory wiki ($KNOWLEDGE, the default) or this workspace's $WORK/scratch. " + CUSTOMER_WORKSPACE_ORIENTATION,
    inputSchema: FindSchema,
    mutates: false,
  },
  {
    name: "ls",
    title: "List a workspace path",
    description: "List one directory below the read-only procedural memory wiki ($KNOWLEDGE, the default; start at $KNOWLEDGE/index.md) or this workspace's $WORK/scratch. " + CUSTOMER_WORKSPACE_ORIENTATION,
    inputSchema: LsSchema,
    mutates: false,
  },
  {
    name: "shell",
    title: "Run a sandboxed workspace command",
    description:
      "Run a bash script in this workspace's isolated, network-blocked sandbox as an unprivileged user. cwd is $WORK/scratch; procedural memory at $KNOWLEDGE is OS-enforced read-only and only $WORK/scratch is writable. Returns the final receipt, or a resumable commandId if still running after yield_time_ms.",
    inputSchema: ShellSchema,
    mutates: true,
  },
  {
    name: "poll_command",
    title: "Poll a resumable command",
    description: "Poll this workspace's resumable shell command for new output and its final receipt.",
    inputSchema: PollCommandSchema,
    mutates: false,
  },
  {
    name: "write_command",
    title: "Write command input",
    description: "Write exact text to this workspace's running command stdin, optionally closing stdin, then return new output.",
    inputSchema: WriteCommandSchema,
    mutates: true,
  },
  {
    name: "cancel_command",
    title: "Cancel a resumable command",
    description: "Cancel this workspace's running command, killing its whole process group, and return its final receipt.",
    inputSchema: CancelCommandSchema,
    mutates: true,
  },
  {
    name: "write",
    title: "Write a scratch file",
    description: "Create or replace one UTF-8 file below this workspace's private $WORK/scratch. Procedural memory under $KNOWLEDGE is immutable and scratch is never published.",
    inputSchema: WriteSchema,
    mutates: true,
  },
  {
    name: "edit",
    title: "Edit a scratch file",
    description:
      "Apply exact-match replacements to one existing UTF-8 file below this workspace's private $WORK/scratch. Each oldText must occur exactly once in the original file. Procedural memory under $KNOWLEDGE is immutable.",
    inputSchema: EditSchema,
    mutates: true,
  },
];

export const CUSTOMER_TOOL_DEFINITIONS: readonly CustomerToolDefinition[] = TOOL_DEFINITIONS.map((d) => ({ ...d, readOnly: !d.mutates }));

export const CUSTOMER_TOOL_NAMES: readonly CustomerToolName[] = CUSTOMER_TOOL_DEFINITIONS.map((d) => d.name);
