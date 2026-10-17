/**
 * The shared agent-activity timeline model (pure, no React): one row model
 * for the build trace, Chat answers and Edit conversations. Each surface
 * keeps its own data and adapts it into `ActivityEntry` values; this module
 * folds consecutive tool calls and thoughts into one work group, lifts
 * subagent launches and handoffs into standalone cards, and words the group
 * summaries ("Ran 9 commands", "Edited 3 files and searched 1 time").
 */

import { toolLabelForStatus } from "../../../src/build/build_trace_threads.js";

export type ActivityCategory = "read" | "edit" | "command" | "search" | "wait" | "agents" | "handoff" | "other";

/** `unfinished`: no result was recorded and the work is no longer live. */
export type ActivityToolStatus = "running" | "succeeded" | "failed" | "cancelled" | "unfinished";

export interface ActivityPayload {
  /** Stored event id, when the full text can be loaded on demand. */
  id?: number;
  text: string;
  /** `text` is a prefix of a longer stored payload of `length` characters. */
  truncated?: boolean;
  length?: number;
  stream?: "stdout" | "stderr";
}

export interface ActivityTool {
  key: string;
  callId: string | null;
  toolName: string;
  /** One human line describing the call, worded as done; `toolLabel` words it for the call's state. */
  label: string;
  /** The label as the agent wrote it (a command with its mount variables), when it differs. */
  rawLabel?: string;
  category: ActivityCategory;
  /** A short supporting excerpt (for example a handoff summary). */
  note?: string;
  status: ActivityToolStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** A recorded duration; otherwise it is derived from the timestamps. */
  durationMs: number | null;
  input: ActivityPayload | null;
  outputs: ActivityPayload[];
  result: ActivityPayload | null;
  /** Agents a spawn/wait call names. */
  agentIds?: string[];
  /** Titles of the agents a spawn call starts, when its input names them. */
  agentTitles?: string[];
  /** Surface-specific detail rendered under the call (opaque here). */
  extra?: unknown;
  /**
   * A failed call the agent recovered from: a later call, thought or message
   * followed it. It reads as "retried", never as a red failure.
   */
  recovered?: boolean;
  /** A publish call that staged a proposal (set by the surface). */
  proposal?: ActivityProposal;
  /** A benchmark grader's verdict and what it cost. */
  verdict?: { verdict: "pass" | "partial" | "fail" | "not_gradable"; inputTokens: number; outputTokens: number; estimatedUsd: number | null };
  /** The latest recorded progress of the host operation this call started (Docling, Reducto, EDA). */
  progress?: ActivityOperationProgress;
  /** A poll_operation call: the operation it waits for, with its latest progress. */
  waitingOn?: ActivityOperationProgress;
}

/** A running host operation's latest recorded state, as a row shows it. */
export interface ActivityOperationProgress {
  operationId: string;
  /** The tool that started the operation (docling_pdf_to_markdown). */
  toolName: string;
  stage: string | null;
  pagesDone: number | null;
  pageCount: number | null;
  /** When the operation started; the row counts its elapsed time locally from it. */
  startedAt: string | null;
}

const OPERATION_ID_PATTERN = /"operationId"\s*:\s*"([0-9a-fA-F-]{36})"/u;

/** "Docling", "Reducto", or the tool's own words for any other host operation. */
export function operationDisplayName(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.startsWith("docling")) return "Docling";
  if (name.startsWith("reducto")) return "Reducto";
  const words = name.split(/[^a-z0-9]+/u).filter(Boolean);
  if (words.length === 0) return toolName;
  words[0] = `${words[0]!.charAt(0).toUpperCase()}${words[0]!.slice(1)}`;
  return words.join(" ");
}

/** Elapsed time as a clock: 0:42, 12:05, 1:02:09. */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Workspace roots the agent writes as variables, in the words a person reads. */
const WORKSPACE_ROOT_WORDS: Record<string, string> = {
  $WORK: "the workspace",
  $INPUTS: "the inputs",
  $KNOWLEDGE: "the Knowledge",
};

/**
 * A recorded stage line in the words a row shows. The runtime writes some
 * stages for the agent ("docling_pdf_to_markdown started", "writing results
 * into $WORK"); a row never shows a raw tool identifier or a workspace
 * variable, and keeps the line short.
 */
export function operationStageText(stage: string, toolName: string): string {
  const text = stage.trim();
  if (text === `${toolName} started` || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+ started$/u.test(text)) return "starting";
  if (/^reused a verified earlier parse\b/u.test(text)) return "reused an earlier parse";
  if (/^writing results into \$WORK$/u.test(text)) return "writing results";
  if (/^waiting for this agent's sandbox\b/u.test(text)) return "waiting for the sandbox";
  if (/^queued in the Docling parser service\b/u.test(text)) return "queued";
  if (/^joined an identical parse\b/u.test(text)) return "joined a running parse";
  return text
    // A path under a workspace root reads as its file name.
    .replace(/\$[A-Z][A-Z_]*\/(?:[^\s/]+\/)*([^\s/]+)/gu, "$1")
    .replace(/\$[A-Z][A-Z_]*\b/gu, (variable) => WORKSPACE_ROOT_WORDS[variable] ?? "the workspace")
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu, (identifier) =>
      identifier === toolName || identifier.split("_").length > 2 ? operationDisplayName(identifier) : identifier);
}

/** Pages while they are still converting, else the latest stage ("writing page images"). */
function progressDetail(progress: ActivityOperationProgress): string | null {
  const pages = progress.pagesDone !== null && progress.pageCount !== null
    ? `${progress.pagesDone}/${progress.pageCount} pages`
    : null;
  if (pages !== null && progress.pagesDone! < progress.pageCount!) return pages;
  return progress.stage === null ? pages : operationStageText(progress.stage, progress.toolName);
}

/**
 * The live text of a running call that started or waits for a host
 * operation, or null for any other call: "Waiting for Docling · 9/16 pages ·
 * 0:42", or the call's own "Docling · starting · 0:00". The elapsed time
 * counts from the operation's start at `now`.
 */
export function operationProgressText(tool: ActivityTool, now: number): { text: string; elapsed: string | null } | null {
  if (tool.status !== "running") return null;
  const progress = tool.waitingOn ?? tool.progress;
  if (progress === undefined) return null;
  const name = operationDisplayName(progress.toolName);
  const head = tool.waitingOn !== undefined
    ? `Waiting for ${name}`
    : name === "Docling" || name === "Reducto" ? name : toolLabel(tool);
  const detail = progressDetail(progress);
  const started = progress.startedAt === null ? Number.NaN : Date.parse(progress.startedAt);
  const elapsed = Number.isFinite(started) ? formatClock(now - started) : null;
  return { text: detail === null ? head : `${head} · ${detail}`, elapsed };
}

/**
 * Links each poll_operation call to the operation it waits for: the call
 * that started it (its result names the operation id) and that operation's
 * latest recorded progress. Returns the same entries when nothing links.
 */
export function linkOperationProgress<Item>(entries: readonly ActivityEntry<Item>[]): ActivityEntry<Item>[] {
  const operations = new Map<string, ActivityOperationProgress>();
  for (const entry of entries) {
    if (entry.type !== "tool") continue;
    const { tool } = entry;
    if (tool.progress !== undefined) {
      operations.set(tool.progress.operationId, tool.progress);
      continue;
    }
    if (tool.toolName === "poll_operation" || tool.toolName === "cancel_operation") continue;
    const id = tool.result === null ? undefined : OPERATION_ID_PATTERN.exec(tool.result.text)?.[1];
    if (id !== undefined && !operations.has(id)) {
      operations.set(id, { operationId: id, toolName: tool.toolName, stage: null, pagesDone: null, pageCount: null, startedAt: tool.startedAt });
    }
  }
  if (operations.size === 0) return entries as ActivityEntry<Item>[];
  let changed = false;
  const linked = entries.map((entry) => {
    if (entry.type !== "tool" || entry.tool.toolName !== "poll_operation" || entry.tool.input === null) return entry;
    const id = OPERATION_ID_PATTERN.exec(entry.tool.input.text)?.[1];
    const operation = id === undefined ? undefined : operations.get(id);
    if (operation === undefined) return entry;
    changed = true;
    return { ...entry, tool: { ...entry.tool, waitingOn: operation } };
  });
  return changed ? linked : entries as ActivityEntry<Item>[];
}

/** A staged proposal as its publish card shows it. */
export interface ActivityProposal {
  /** It waits for a reviewer now. */
  waiting: boolean;
  /** The pull request, when the surface can link to it. */
  href: string | null;
  /** Replaces the review wording (a run committing onto its own branch). */
  label?: string;
}

export interface ActivityThought {
  key: string;
  at: string | null;
  text: string;
  /** The model is still writing this thought. */
  streaming?: boolean;
}

export type WorkEntry =
  | { type: "thought"; key: string; thought: ActivityThought }
  | { type: "tool"; key: string; tool: ActivityTool };

/** Anything that is not work (messages, compactions, artifacts) passes through. */
export type ActivityEntry<Item> = WorkEntry | { type: "item"; key: string; item: Item };

export type ActivityRow<Item> =
  | { type: "work"; key: string; entries: WorkEntry[] }
  | { type: "subagents"; key: string; tool: ActivityTool }
  | { type: "handoff"; key: string; tool: ActivityTool }
  | { type: "item"; key: string; item: Item };

export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["spawn_agents"]);
export const HANDOFF_TOOLS: ReadonlySet<string> = new Set(["complete_task", "publish_knowledge", "publish_knowledge_manifest", "submit_applicability", "submit_grade", "submit_knowledge_answer"]);

/**
 * Consecutive thoughts and tool calls fold into one work row; a subagent
 * launch or a handoff stands alone as a card; every other entry breaks the
 * run. Group keys come from their first entry, so a group that grows while
 * events stream in keeps its identity (and its open state).
 */
export function groupActivity<Item>(input: readonly ActivityEntry<Item>[]): ActivityRow<Item>[] {
  const entries = markRecoveredFailures(input);
  const rows: ActivityRow<Item>[] = [];
  let work: WorkEntry[] = [];
  const flush = () => {
    if (work.length > 0) rows.push({ type: "work", key: `w${work[0]!.key}`, entries: work });
    work = [];
  };
  for (const entry of entries) {
    if (entry.type === "thought") {
      work.push(entry);
      continue;
    }
    if (entry.type === "tool") {
      if (SUBAGENT_TOOLS.has(entry.tool.toolName)) {
        flush();
        rows.push({ type: "subagents", key: entry.key, tool: entry.tool });
      } else if (HANDOFF_TOOLS.has(entry.tool.toolName)) {
        flush();
        rows.push({ type: "handoff", key: entry.key, tool: entry.tool });
      } else {
        work.push(entry);
      }
      continue;
    }
    flush();
    rows.push(entry);
  }
  flush();
  return rows;
}

const CATEGORY_PHRASES: Record<Exclude<ActivityCategory, "handoff">, (count: number) => string> = {
  command: (n) => `ran ${n} command${n === 1 ? "" : "s"}`,
  edit: (n) => `edited ${n} file${n === 1 ? "" : "s"}`,
  read: (n) => `read ${n} file${n === 1 ? "" : "s"}`,
  search: (n) => `searched ${n} time${n === 1 ? "" : "s"}`,
  wait: (n) => `waited for subagents${n === 1 ? "" : ` ${n} times`}`,
  agents: (n) => `checked on subagents${n === 1 ? "" : ` ${n} times`}`,
  other: (n) => `${n} other action${n === 1 ? "" : "s"}`,
};

/**
 * A failed call followed by any later work (a call that did not fail, a
 * thought, a message) was recovered from: the agent retried or moved on.
 * Only a failure nothing recovered from stays a failure. Returns the same
 * entries (and tools) when nothing changes.
 */
export function markRecoveredFailures<Item>(entries: readonly ActivityEntry<Item>[]): ActivityEntry<Item>[] {
  let continued = false;
  let changed = false;
  const out = [...entries];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const entry = out[index]!;
    if (entry.type !== "tool") {
      continued = true;
      continue;
    }
    if (entry.tool.status !== "failed") {
      continued = true;
      continue;
    }
    if (continued && !entry.tool.recovered) {
      out[index] = { ...entry, tool: { ...entry.tool, recovered: true } };
      changed = true;
    }
  }
  return changed ? out : entries as ActivityEntry<Item>[];
}

/**
 * The call's label for its state: "Couldn't propose a Knowledge revision"
 * for a failed call (retried or not), "Proposing …" while it runs, the
 * recorded label once it succeeded.
 */
export function toolLabel(tool: ActivityTool): string {
  return toolLabelForStatus(tool.label, tool.toolName, tool.status);
}

/** A failure nothing recovered from: shown in red. */
export function toolFailed(tool: ActivityTool): boolean {
  return tool.status === "failed" && !tool.recovered && !tool.proposal;
}

/** A failed call the agent retried or moved past: shown neutrally. */
export function toolRetried(tool: ActivityTool): boolean {
  return tool.status === "failed" && tool.recovered === true && !tool.proposal;
}

export interface WorkSummary {
  text: string;
  failures: number;
  /** Failed calls that were retried or moved past. */
  retried: number;
  /**
   * The retried calls in words that name them, so the badge never reads as
   * the header's own call retrying: "1 command retried", "2 calls retried".
   */
  retriedText: string;
  thoughts: number;
  tools: number;
}

/** "Ran 9 commands", "Edited 3 files and searched 1 time", "Thought 2 times". */
export function summarizeWork(entries: readonly WorkEntry[]): WorkSummary {
  const counts = new Map<ActivityCategory, number>();
  let thoughts = 0;
  let failures = 0;
  let retried = 0;
  const retriedCategories = new Set<ActivityCategory>();
  let tools = 0;
  for (const entry of entries) {
    if (entry.type === "thought") { thoughts += 1; continue; }
    tools += 1;
    if (toolFailed(entry.tool)) failures += 1;
    if (toolRetried(entry.tool)) {
      retried += 1;
      retriedCategories.add(entry.tool.category);
    }
    counts.set(entry.tool.category, (counts.get(entry.tool.category) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([category]) => category !== "other" && category !== "handoff")
    .sort((a, b) => b[1] - a[1]);
  const named = ranked.slice(0, 3);
  const rest = ranked.slice(3).reduce((sum, [, n]) => sum + n, 0) + (counts.get("other") ?? 0) + (counts.get("handoff") ?? 0);
  const parts = named.map(([category, n]) => CATEGORY_PHRASES[category as Exclude<ActivityCategory, "handoff">](n));
  if (rest > 0) parts.push(CATEGORY_PHRASES.other(rest));
  let text = parts.length === 0
    ? `Thought ${thoughts === 1 ? "once" : `${thoughts} times`}`
    : parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  text = text[0]!.toUpperCase() + text.slice(1);
  const [only] = retriedCategories;
  const noun = retriedCategories.size === 1 ? RETRIED_NOUNS[only!] : RETRIED_NOUNS.other;
  const retriedText = `${retried} ${retried === 1 ? noun[0] : noun[1]} retried`;
  return { text, failures, retried, retriedText, thoughts, tools };
}

/** What a retried call is called in a group's badge, singular and plural. */
const RETRIED_NOUNS: Record<ActivityCategory, readonly [string, string]> = {
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  read: ["read", "reads"],
  search: ["search", "searches"],
  wait: ["call", "calls"],
  agents: ["call", "calls"],
  handoff: ["handoff", "handoffs"],
  other: ["call", "calls"],
};

export function spanMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function toolDurationMs(tool: ActivityTool): number | null {
  return tool.durationMs ?? spanMs(tool.startedAt, tool.endedAt);
}

function entryStart(entry: WorkEntry): string | null {
  return entry.type === "thought" ? entry.thought.at : entry.tool.startedAt;
}

function entryEnd(entry: WorkEntry): string | null {
  if (entry.type === "thought") return entry.thought.at;
  if (entry.tool.endedAt) return entry.tool.endedAt;
  const start = entry.tool.startedAt ? Date.parse(entry.tool.startedAt) : Number.NaN;
  if (entry.tool.durationMs !== null && Number.isFinite(start)) {
    return new Date(start + entry.tool.durationMs).toISOString();
  }
  return entry.tool.startedAt;
}

export interface WorkGroupView {
  summary: WorkSummary;
  /** The group is the live tail and its last call or thought is still running. */
  working: boolean;
  /** Header text: "Working · <current step>", the single call's label, or the summary. */
  label: string;
  firstAt: string | null;
  durationMs: number | null;
  /** The working tail's running call, when it starts or waits for a host operation with recorded progress. */
  operationTool: ActivityTool | null;
}

/**
 * How a work group's header reads. Only the trailing group of a live
 * timeline can be working; it stops the moment its last call has a result.
 */
export function describeWorkGroup(entries: readonly WorkEntry[], options: { trailing: boolean }): WorkGroupView {
  const summary = summarizeWork(entries);
  const firstAt = entries.map(entryStart).find((value): value is string => value !== null) ?? null;
  const lastAt = [...entries].reverse().map(entryEnd).find((value): value is string => value !== null) ?? null;
  const last = entries.at(-1);
  const lastTool = [...entries].reverse().find((entry): entry is Extract<WorkEntry, { type: "tool" }> => entry.type === "tool");
  const working = options.trailing && last !== undefined && (
    (last.type === "tool" && last.tool.status === "running") ||
    (last.type === "thought" && last.thought.streaming === true)
  );
  const current = last?.type === "thought" ? "Thinking" : lastTool ? toolLabel(lastTool.tool) : "";
  const label = working
    ? current
    : summary.tools === 1 && lastTool
      ? toolLabel(lastTool.tool)
      : summary.text;
  const operationTool = working && last?.type === "tool" && (last.tool.waitingOn !== undefined || last.tool.progress !== undefined)
    ? last.tool
    : null;
  return { summary, working, label, firstAt, durationMs: spanMs(firstAt, lastAt), operationTool };
}
