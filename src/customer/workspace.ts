import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { AgentFs, WalkResult } from "../sandbox/local.js";
import type { CommandHandle, CommandPoll, SandboxLease } from "../sandbox/types.js";
import { agentFsFor, mapFsError } from "./agent-fs.js";
import {
  CustomerToolError,
  KNOWLEDGE_MOUNT,
  SCRATCH_MOUNT,
  WORK_MOUNT,
  displayPath,
  normalizeScratchFilePath,
  normalizeVirtualPath,
  sandboxPath,
  type VirtualPath,
} from "./paths.js";
import {
  CUSTOMER_TOOL_NAMES,
  CancelCommandSchema,
  DEFAULT_POLL_YIELD_MS,
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_SHELL_YIELD_MS,
  DEFAULT_WRITE_COMMAND_YIELD_MS,
  EditSchema,
  FindSchema,
  GrepSchema,
  LsSchema,
  PollCommandSchema,
  ReadSchema,
  ShellSchema,
  WriteCommandSchema,
  WriteSchema,
  type CancelCommandInput,
  type CustomerToolName,
  type EditInput,
  type FindInput,
  type GrepInput,
  type LsInput,
  type PollCommandInput,
  type ReadInput,
  type ShellInput,
  type WriteCommandInput,
  type WriteInput,
} from "./tools.js";
import {
  MAX_GREP_SCAN_BYTES,
  MAX_READ_BYTES,
  VTree,
  findTree,
  grepTree,
  lsTree,
  readBytesSlice,
  readFromTree,
  readLinesSlice,
  type FindReceipt,
  type GrepReceipt,
  type LsReceipt,
  type ReadReceipt,
} from "./tree.js";

/** Bounds for scratch snapshots pulled from the sandbox for ls/find/grep. */
const SCRATCH_MAX_ENTRIES = 10_000;
const SCRATCH_MAX_FILE_BYTES = 4 * 1024 * 1024;
const SCRATCH_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SCRATCH_READ_MAX_BYTES = 4 * 1024 * 1024;
const SCRATCH_EDIT_MAX_BYTES = 1024 * 1024;
const MAX_RUNNING_COMMANDS = 4;
const SHELL_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ToolReceipt {
  tool: CustomerToolName;
  ok: true;
  durationMs: number;
}

export type CustomerReadReceipt = ToolReceipt & ReadReceipt;
export type CustomerLsReceipt = ToolReceipt & LsReceipt;
export type CustomerFindReceipt = ToolReceipt & FindReceipt;
export type CustomerGrepReceipt = ToolReceipt & GrepReceipt;

export interface CommandReceipt extends ToolReceipt {
  commandId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Wall time since the command started. */
  elapsedMs: number;
}

export interface WriteReceipt extends ToolReceipt {
  path: string;
  bytes: number;
  created: boolean;
}

export interface EditReceipt extends ToolReceipt {
  path: string;
  replacements: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface CustomerWorkspaceOptions {
  ns: string;
  workspaceId: string;
  revisionId: string;
  /** Complete file map of the pinned revision (MemoryRepo.files(revisionId)). */
  files: ReadonlyMap<string, string>;
  leaseFactory?: () => Promise<SandboxLease>;
}

interface TrackedCommand {
  handle: CommandHandle;
  startedAt: number;
}

async function defaultLeaseFactory(): Promise<SandboxLease> {
  const { createModalLease } = await import("../sandbox/modal.js");
  return createModalLease({ tags: { purpose: "customer-workspace" } });
}

/**
 * One customer filesystem session: pinned read-only knowledge + private scratch.
 * Knowledge-only read/ls/find/grep are answered host-side from the pinned
 * revision; scratch access and commands use a lazily created sandbox lease.
 */
export class CustomerWorkspace {
  readonly ns: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();
  readonly #files: ReadonlyMap<string, string>;
  readonly #knowledge: VTree;
  readonly #leaseFactory: () => Promise<SandboxLease>;
  #lease: Promise<SandboxLease> | null = null;
  #agentFs: AgentFs | null = null;
  #commands = new Map<string, TrackedCommand>();
  #closed: Promise<void> | null = null;

  constructor(opts: CustomerWorkspaceOptions) {
    this.ns = opts.ns;
    this.workspaceId = opts.workspaceId;
    this.revisionId = opts.revisionId;
    this.#files = opts.files;
    this.#knowledge = VTree.fromFiles("knowledge", opts.files);
    this.#leaseFactory = opts.leaseFactory ?? defaultLeaseFactory;
  }

  /** Bootstrap description for clients: where things live and what is writable. */
  describe() {
    return {
      workspaceId: this.workspaceId,
      revisionId: this.revisionId,
      knowledge: { path: "$KNOWLEDGE", sandboxPath: KNOWLEDGE_MOUNT, readOnly: true, files: this.#files.size, entry: "$KNOWLEDGE/index.md" },
      scratch: { path: "$WORK/scratch", sandboxPath: SCRATCH_MOUNT, readOnly: false, private: true, published: false },
      sandboxStarted: this.#lease !== null,
    };
  }

  get hasLease(): boolean {
    return this.#lease !== null;
  }

  get runningCommands(): number {
    return this.#commands.size;
  }

  #touch(): void {
    if (this.#closed) throw new CustomerToolError("workspace_not_found", `Workspace ${this.workspaceId} is closed`);
    this.lastUsedAt = Date.now();
  }

  async #ensureLease(): Promise<SandboxLease> {
    if (!this.#lease) {
      const p = (async () => {
        const lease = await this.#leaseFactory();
        try {
          await lease.writeFiles([...this.#files.entries()].map(([rel, content]) => ({ path: `${KNOWLEDGE_MOUNT}/${rel}`, content })));
          await lease.protectTree(KNOWLEDGE_MOUNT);
          await lease.makeAgentDir(SCRATCH_MOUNT);
        } catch (error) {
          await lease.terminate().catch(() => undefined);
          throw error;
        }
        return lease;
      })();
      this.#lease = p;
      p.catch(() => {
        if (this.#lease === p) this.#lease = null;
      });
    }
    return this.#lease;
  }

  async #fs(): Promise<AgentFs> {
    const lease = await this.#ensureLease();
    this.#agentFs ??= agentFsFor(lease);
    return this.#agentFs;
  }

  /** Bounded snapshot of a scratch subtree as a VTree (same semantics as knowledge). */
  async #scratchTree(vp: VirtualPath, withContent: boolean, maxDepth: number): Promise<VTree> {
    const fs = await this.#fs();
    let walk: WalkResult;
    try {
      walk = await fs.walk(sandboxPath(vp), {
        maxEntries: SCRATCH_MAX_ENTRIES,
        maxDepth,
        withContent,
        maxFileBytes: SCRATCH_MAX_FILE_BYTES,
        maxTotalBytes: Math.min(SCRATCH_MAX_TOTAL_BYTES, MAX_GREP_SCAN_BYTES),
      });
    } catch (error) {
      throw mapFsError(error);
    }
    const tree = new VTree("scratch");
    tree.truncated = walk.truncated;
    if (walk.rootType === null) return tree; // missing path -> not_found from the semantics layer
    if (vp.rel !== "") {
      tree.add(vp.rel, {
        type: walk.rootType,
        size: walk.rootSize,
        ...(walk.rootContent ? { content: walk.rootContent } : {}),
        ...(walk.rootType === "file" && !walk.rootContent && withContent ? { contentOmitted: true } : {}),
      });
    }
    for (const e of walk.entries) {
      const rel = vp.rel ? `${vp.rel}/${e.rel}` : e.rel;
      tree.add(rel, { type: e.type, size: e.size, ...(e.content ? { content: e.content } : {}), ...(e.contentOmitted ? { contentOmitted: true } : {}) });
    }
    return tree;
  }

  // ------------------------------------------------------------ FS tools

  async read(input: ReadInput): Promise<CustomerReadReceipt> {
    const started = Date.now();
    this.#touch();
    const args = ReadSchema.parse(input);
    const vp = normalizeVirtualPath(args.path);
    const opts = {
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.byteOffset !== undefined ? { byteOffset: args.byteOffset } : {}),
      ...(args.byteLimit !== undefined ? { byteLimit: args.byteLimit } : {}),
    };
    let receipt: ReadReceipt;
    if (vp.root === "knowledge") {
      receipt = readFromTree(this.#knowledge, vp, opts);
    } else {
      const fs = await this.#fs();
      const abs = sandboxPath(vp);
      try {
        const st = await fs.stat(abs);
        if (!st) throw new CustomerToolError("not_found", `No such file or directory: ${displayPath(vp)}`);
        if (st.type === "dir") throw new CustomerToolError("not_a_file", `${displayPath(vp)} is a directory; use ls or find`);
        if (st.type !== "file") throw new CustomerToolError("not_a_file", `${displayPath(vp)} is not a readable regular file`);
        const byteMode = args.byteOffset !== undefined || args.byteLimit !== undefined;
        if (byteMode) {
          const offset = args.byteOffset ?? 0;
          const r = await fs.readFile(abs, { byteOffset: offset, maxBytes: Math.min(args.byteLimit ?? MAX_READ_BYTES, MAX_READ_BYTES) });
          receipt = readBytesSlice(displayPath(vp), r.data, r.size, Math.min(offset, r.size), opts);
        } else {
          const r = await fs.readFile(abs, { byteOffset: 0, maxBytes: SCRATCH_READ_MAX_BYTES });
          receipt = readLinesSlice(displayPath(vp), r.data, r.size, opts);
        }
      } catch (error) {
        throw mapFsError(error);
      }
    }
    return { tool: "read", ok: true, durationMs: Date.now() - started, ...receipt };
  }

  /**
   * Load one image from this workspace's $WORK/scratch (e.g. a chart rendered by
   * shell). $KNOWLEDGE is Markdown-only, so it has no images to view. The media
   * type is taken from the file's magic bytes, never from its name.
   */
  async view_file(input: { path: string }): Promise<{ tool: "view_file"; ok: true; path: string; mediaType: string; bytes: number; base64: string; durationMs: number }> {
    const started = Date.now();
    this.#touch();
    const vp = normalizeVirtualPath(String(input?.path ?? ""));
    if (vp.root === "knowledge") throw new CustomerToolError("invalid_input", "$KNOWLEDGE contains only Markdown pages; use read. view_file loads images from $WORK/scratch.");
    const fs = await this.#fs();
    const abs = sandboxPath(vp);
    try {
      const st = await fs.stat(abs);
      if (!st || st.type !== "file") throw new CustomerToolError("not_a_file", `${displayPath(vp)} is not a regular file`);
      if (st.size > VIEW_FILE_MAX_BYTES) throw new CustomerToolError("too_large", `${displayPath(vp)} is ${st.size} bytes (max ${VIEW_FILE_MAX_BYTES})`);
      const { data } = await fs.readFile(abs, { byteOffset: 0, maxBytes: VIEW_FILE_MAX_BYTES });
      const mediaType = sniffImage(data);
      if (!mediaType) throw new CustomerToolError("invalid_input", `${displayPath(vp)} is not a PNG, JPEG, GIF or WebP image`);
      return { tool: "view_file", ok: true, path: displayPath(vp), mediaType, bytes: data.length, base64: Buffer.from(data).toString("base64"), durationMs: Date.now() - started };
    } catch (error) {
      throw mapFsError(error);
    }
  }

  async ls(input: LsInput = {}): Promise<CustomerLsReceipt> {
    const started = Date.now();
    this.#touch();
    const args = LsSchema.parse(input);
    const vp = normalizeVirtualPath(args.path);
    const tree = vp.root === "knowledge" ? this.#knowledge : await this.#scratchTree(vp, false, 1);
    return { tool: "ls", ok: true, durationMs: Date.now() - started, ...lsTree(tree, vp, args.limit) };
  }

  async find(input: FindInput = {}): Promise<CustomerFindReceipt> {
    const started = Date.now();
    this.#touch();
    const args = FindSchema.parse(input);
    const vp = normalizeVirtualPath(args.path);
    const tree = vp.root === "knowledge" ? this.#knowledge : await this.#scratchTree(vp, false, 64);
    return { tool: "find", ok: true, durationMs: Date.now() - started, ...findTree(tree, vp, args.pattern, args.limit) };
  }

  async grep(input: GrepInput): Promise<CustomerGrepReceipt> {
    const started = Date.now();
    this.#touch();
    const args = GrepSchema.parse(input);
    const vp = normalizeVirtualPath(args.path);
    const tree = vp.root === "knowledge" ? this.#knowledge : await this.#scratchTree(vp, true, 64);
    const r = await grepTree(tree, vp, {
      pattern: args.pattern,
      ...(args.glob !== undefined ? { glob: args.glob } : {}),
      literal: args.literal,
      ignoreCase: args.ignoreCase,
      limit: args.limit,
    });
    return { tool: "grep", ok: true, durationMs: Date.now() - started, ...r };
  }

  async write(input: WriteInput): Promise<WriteReceipt> {
    const started = Date.now();
    this.#touch();
    const args = WriteSchema.parse(input);
    const vp = normalizeScratchFilePath(args.path);
    const fs = await this.#fs();
    const abs = sandboxPath(vp);
    const bytes = Buffer.byteLength(args.content, "utf8");
    let created: boolean;
    try {
      const st = await fs.stat(abs);
      if (st && st.type !== "file") throw new CustomerToolError("not_a_file", `${displayPath(vp)} exists and is not a regular file`);
      created = st === null;
      await fs.writeFile(abs, args.content);
    } catch (error) {
      throw mapFsError(error);
    }
    return { tool: "write", ok: true, durationMs: Date.now() - started, path: displayPath(vp), bytes, created };
  }

  async edit(input: EditInput): Promise<EditReceipt> {
    const started = Date.now();
    this.#touch();
    const args = EditSchema.parse(input);
    const vp = normalizeScratchFilePath(args.path);
    const fs = await this.#fs();
    const abs = sandboxPath(vp);
    const shown = displayPath(vp);
    try {
      const st = await fs.stat(abs);
      if (!st) throw new CustomerToolError("not_found", `No such file: ${shown}; use write to create it`);
      if (st.type !== "file") throw new CustomerToolError("not_a_file", `${shown} is not a regular file`);
      if (st.size > SCRATCH_EDIT_MAX_BYTES) throw new CustomerToolError("too_large", `${shown} is larger than ${SCRATCH_EDIT_MAX_BYTES} bytes; edit it with shell instead`);
      const { data } = await fs.readFile(abs, { byteOffset: 0, maxBytes: SCRATCH_EDIT_MAX_BYTES });
      const original = data.toString("utf8");
      const updated = applyEdits(original, args.edits, shown);
      await fs.writeFile(abs, updated);
      return {
        tool: "edit",
        ok: true,
        durationMs: Date.now() - started,
        path: shown,
        replacements: args.edits.length,
        bytesBefore: data.byteLength,
        bytesAfter: Buffer.byteLength(updated, "utf8"),
      };
    } catch (error) {
      throw mapFsError(error);
    }
  }

  // ------------------------------------------------------------ commands

  #receipt(tool: CustomerToolName, started: number, tracked: TrackedCommand, poll: CommandPoll): CommandReceipt {
    return {
      tool,
      ok: true,
      durationMs: Date.now() - started,
      commandId: poll.commandId,
      running: poll.running,
      exitCode: poll.exitCode,
      stdout: poll.stdout,
      stderr: poll.stderr,
      outputTruncated: poll.outputTruncated,
      timedOut: poll.timedOut,
      cancelled: poll.cancelled,
      elapsedMs: Date.now() - tracked.startedAt,
    };
  }

  async #pollTracked(tool: CustomerToolName, started: number, tracked: TrackedCommand, waitMs: number): Promise<CommandReceipt> {
    const poll = await tracked.handle.poll(waitMs);
    if (!poll.running) this.#commands.delete(poll.commandId);
    return this.#receipt(tool, started, tracked, poll);
  }

  #tracked(commandId: string): TrackedCommand {
    const t = this.#commands.get(commandId);
    if (!t) throw new CustomerToolError("unknown_command", `No running command ${commandId} in this workspace (it may have finished and already been reported)`);
    return t;
  }

  async shell(input: ShellInput): Promise<CommandReceipt> {
    const started = Date.now();
    this.#touch();
    const args = ShellSchema.parse(input);
    if (this.#commands.size >= MAX_RUNNING_COMMANDS) {
      throw new CustomerToolError("limit", `At most ${MAX_RUNNING_COMMANDS} commands may run at once; poll or cancel one first`);
    }
    const lease = await this.#ensureLease();
    const handle = await lease.start(["/bin/bash", "--noprofile", "--norc", "-c", args.script], {
      user: "agent",
      cwd: SCRATCH_MOUNT,
      timeoutMs: args.timeout_ms ?? DEFAULT_SHELL_TIMEOUT_MS,
      maxOutputBytes: SHELL_MAX_OUTPUT_BYTES,
      env: { KNOWLEDGE: KNOWLEDGE_MOUNT, WORK: WORK_MOUNT, SCRATCH: SCRATCH_MOUNT },
    });
    const tracked: TrackedCommand = { handle, startedAt: started };
    this.#commands.set(handle.commandId, tracked);
    return this.#pollTracked("shell", started, tracked, args.yield_time_ms ?? DEFAULT_SHELL_YIELD_MS);
  }

  async poll_command(input: PollCommandInput): Promise<CommandReceipt> {
    const started = Date.now();
    this.#touch();
    const args = PollCommandSchema.parse(input);
    const tracked = this.#tracked(args.commandId);
    return this.#pollTracked("poll_command", started, tracked, args.yield_time_ms ?? DEFAULT_POLL_YIELD_MS);
  }

  async write_command(input: WriteCommandInput): Promise<CommandReceipt> {
    const started = Date.now();
    this.#touch();
    const args = WriteCommandSchema.parse(input);
    const tracked = this.#tracked(args.commandId);
    if (args.text.length > 0 || args.close) await tracked.handle.writeStdin(args.text, args.close);
    return this.#pollTracked("write_command", started, tracked, args.yield_time_ms ?? DEFAULT_WRITE_COMMAND_YIELD_MS);
  }

  async cancel_command(input: CancelCommandInput): Promise<CommandReceipt> {
    const started = Date.now();
    this.#touch();
    const args = CancelCommandSchema.parse(input);
    const tracked = this.#tracked(args.commandId);
    await tracked.handle.cancel();
    return this.#pollTracked("cancel_command", started, tracked, 2_000);
  }

  /** Cancel running commands and terminate the sandbox. Idempotent. */
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closed = (async () => {
      const leaseP = this.#lease;
      const commands = [...this.#commands.values()];
      this.#commands.clear();
      await Promise.allSettled(commands.map((c) => c.handle.cancel()));
      if (leaseP) {
        const lease = await leaseP.catch(() => null);
        if (lease) await lease.terminate();
      }
    })();
    return this.#closed;
  }
}

/** Apply exact-match edits against the original text; each oldText must be unique and edits must not overlap. */
export function applyEdits(original: string, edits: ReadonlyArray<{ oldText: string; newText: string }>, shown = "file"): string {
  const spans: Array<{ start: number; end: number; newText: string; index: number }> = [];
  edits.forEach((e, index) => {
    const first = original.indexOf(e.oldText);
    if (first < 0) throw new CustomerToolError("edit_mismatch", `edits[${index}].oldText was not found in ${shown}`);
    if (original.indexOf(e.oldText, first + 1) >= 0) {
      throw new CustomerToolError("edit_mismatch", `edits[${index}].oldText occurs more than once in ${shown}; include more surrounding context`);
    }
    spans.push({ start: first, end: first + e.oldText.length, newText: e.newText, index });
  });
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) {
      throw new CustomerToolError("edit_mismatch", `edits[${spans[i - 1]!.index}] and edits[${spans[i]!.index}] overlap; merge them into one edit`);
    }
  }
  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += original.slice(pos, s.start) + s.newText;
    pos = s.end;
  }
  return out + original.slice(pos);
}

/** Dispatch a raw tool call (validated by the tool's schema) to a workspace. */
export async function runCustomerTool(ws: CustomerWorkspace, name: CustomerToolName, input: unknown): Promise<unknown> {
  switch (name) {
    case "read":
      return ws.read(input as ReadInput);
    case "grep":
      return ws.grep(input as GrepInput);
    case "find":
      return ws.find((input ?? {}) as FindInput);
    case "ls":
      return ws.ls((input ?? {}) as LsInput);
    case "shell":
      return ws.shell(input as ShellInput);
    case "poll_command":
      return ws.poll_command(input as PollCommandInput);
    case "write_command":
      return ws.write_command(input as WriteCommandInput);
    case "cancel_command":
      return ws.cancel_command(input as CancelCommandInput);
    case "write":
      return ws.write(input as WriteInput);
    case "edit":
      return ws.edit(input as EditInput);
    default:
      throw new CustomerToolError("invalid_input", `Unknown customer tool ${String(name)}`);
  }
}

/** JSON-able error receipt for a failed tool call (typed customer errors keep their code). */
export interface ToolErrorReceipt {
  tool: string;
  ok: false;
  code: string;
  error: string;
}

/**
 * Server entry point: resolve (ns, workspaceId), validate input against the tool's
 * schema, run it, and return a JSON-able receipt. Errors become `{ ok: false }`
 * receipts instead of throwing (zod issues are reported as invalid_input).
 */
export async function dispatchCustomerTool(
  manager: CustomerWorkspaceManager,
  ns: string,
  workspaceId: string,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  try {
    if (!(CUSTOMER_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new CustomerToolError("invalid_input", `Unknown customer tool ${name}`);
    }
    const ws = manager.get(ns, workspaceId);
    return (await runCustomerTool(ws, name as CustomerToolName, input)) as Record<string, unknown>;
  } catch (error) {
    return toolErrorReceipt(name, error) as unknown as Record<string, unknown>;
  }
}

export function toolErrorReceipt(tool: string, error: unknown): ToolErrorReceipt {
  if (error instanceof CustomerToolError) return { tool, ok: false, code: error.code, error: error.message };
  if (error instanceof ZodError) {
    return { tool, ok: false, code: "invalid_input", error: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  const code = (error as { code?: unknown })?.code;
  return { tool, ok: false, code: typeof code === "string" ? code : "error", error: error instanceof Error ? error.message : String(error) };
}

export interface CustomerWorkspaceManagerOptions {
  maxWorkspacesPerNs?: number;
  /** Close workspaces unused for this long (terminating their sandboxes). */
  idleMs?: number;
  /** Background sweep interval; 0 disables the timer (call sweep() yourself). */
  sweepIntervalMs?: number;
  leaseFactory?: () => Promise<SandboxLease>;
}

/** Customer workspaces keyed by (ns, workspaceId) with per-namespace caps and idle eviction. */
export class CustomerWorkspaceManager {
  readonly maxWorkspacesPerNs: number;
  readonly idleMs: number;
  readonly #leaseFactory: (() => Promise<SandboxLease>) | undefined;
  #byNs = new Map<string, Map<string, CustomerWorkspace>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(opts: CustomerWorkspaceManagerOptions = {}) {
    this.maxWorkspacesPerNs = opts.maxWorkspacesPerNs ?? 8;
    this.idleMs = opts.idleMs ?? 15 * 60_000;
    this.#leaseFactory = opts.leaseFactory;
    const interval = opts.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      this.#timer = setInterval(() => void this.sweep(), interval);
      this.#timer.unref?.();
    }
  }

  /** Open a workspace pinned to revisionId. Evicts the least recently used workspace in ns when at capacity. */
  open(ns: string, revisionId: string, files: ReadonlyMap<string, string>): string {
    if (!ns) throw new CustomerToolError("invalid_input", "ns is required");
    let spaces = this.#byNs.get(ns);
    if (!spaces) this.#byNs.set(ns, (spaces = new Map()));
    while (spaces.size >= this.maxWorkspacesPerNs) {
      const lru = [...spaces.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!lru) break;
      spaces.delete(lru.workspaceId);
      void lru.close().catch(() => undefined);
    }
    const workspaceId = randomUUID();
    spaces.set(
      workspaceId,
      new CustomerWorkspace({ ns, workspaceId, revisionId, files, ...(this.#leaseFactory ? { leaseFactory: this.#leaseFactory } : {}) }),
    );
    return workspaceId;
  }

  get(ns: string, workspaceId: string): CustomerWorkspace {
    const ws = this.#byNs.get(ns)?.get(workspaceId);
    if (!ws) throw new CustomerToolError("workspace_not_found", `No open workspace ${workspaceId} in this namespace; open a new one`);
    ws.lastUsedAt = Date.now();
    return ws;
  }

  has(ns: string, workspaceId: string): boolean {
    return this.#byNs.get(ns)?.has(workspaceId) ?? false;
  }

  list(ns: string): string[] {
    return [...(this.#byNs.get(ns)?.keys() ?? [])];
  }

  async close(ns: string, workspaceId: string): Promise<boolean> {
    const spaces = this.#byNs.get(ns);
    const ws = spaces?.get(workspaceId);
    if (!spaces || !ws) return false;
    spaces.delete(workspaceId);
    if (spaces.size === 0) this.#byNs.delete(ns);
    await ws.close();
    return true;
  }

  /** Close workspaces idle longer than idleMs. Returns the number evicted. */
  async sweep(now = Date.now()): Promise<number> {
    const victims: CustomerWorkspace[] = [];
    for (const [ns, spaces] of this.#byNs) {
      for (const [id, ws] of spaces) {
        if (now - ws.lastUsedAt >= this.idleMs) {
          spaces.delete(id);
          victims.push(ws);
        }
      }
      if (spaces.size === 0) this.#byNs.delete(ns);
    }
    await Promise.allSettled(victims.map((w) => w.close()));
    return victims.length;
  }

  async closeAll(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    const all = [...this.#byNs.values()].flatMap((m) => [...m.values()]);
    this.#byNs.clear();
    await Promise.allSettled(all.map((w) => w.close()));
  }
}

export const VIEW_FILE_MAX_BYTES = 5 * 1024 * 1024;

export function sniffImage(data: Uint8Array): string | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
