/*
 * Port of AEye web/components/build-trace-workbench.tsx
 * (askshepherd/aeye-shepherd @ a49aae10e219a7b3aa36102099b649340c2d42b0).
 *
 * Kept from the source: the split workbench (.build-ide.trace-ide) with its
 * resizable separator, AgentThread (header, task row, MessageRow prose,
 * shared activity rows, subagent cards, wait line, Working…, Jump to latest,
 * scroll following and per-agent scroll memory), the right panel's Files and
 * Subagents tabs with the panel thread ("All agents" / "Open in main view"),
 * and the default main agent rule.
 *
 * Adapted: threads are read from the in-memory event log (no paging API or
 * EventSource; the poll pulses instead); "Attempt N of M" becomes a thread
 * menu because the customer agent and the build root are separate roots;
 * Files shows the run's recorded memory/source files (Whole / Diff) instead
 * of a sandbox snapshot; a Run tab holds the operator's own records (seed,
 * deploy, checks), which AEye's runtime progress line would carry, so they
 * never enter an agent's conversation.
 */
import { ArrowLeft, FolderTree, ListChecks, TriangleAlert, Users } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TraceAgent, TraceThreadEvent } from "./aeye/src/build/build_trace_threads.js";
import { leadingMarkdownTitle, renderMarkdown } from "./aeye/src/web/markdown.js";
import { diffLines } from "./aeye/src/web/text_diff.js";
import { groupActivity, spanMs, type ActivityEntry, type ActivityTool } from "./aeye/web/components/agent-activity/activity-model.js";
import { formatActivityDateTime as formatDateTime, formatActivitySpan as formatSpan, formatActivityTime as formatTime } from "./aeye/web/components/agent-activity/activity-format.js";
import { LineDiffView } from "./aeye/web/components/agent-activity/activity-file-change.js";
import { DraftTreeNodes, workspaceFileHref } from "./aeye/web/components/workspace/draft-tree.js";
import { resolveRecordedLink } from "./file-links.js";
import { TextFileView } from "./aeye/web/components/workspace/text-file-view.js";
import type { HandbookTreeNode } from "./aeye/src/web/repository.js";
import {
  ActivityPayloadBlock,
  ActivityPayloadContext,
  ActivityRenderContext,
  ActivityRowView,
  ActivitySpinner,
  ActivitySubagentWaitLine,
  ActivityTaskRow,
  type ActivityAgentChip,
  type ActivityPayloadLoader,
} from "./aeye/web/components/agent-activity/activity-rows.js";
import { activeSubagentWait, traceActivityEntries, type TraceItem } from "./aeye/web/components/agent-activity/trace-activity.js";
import type { AdaptedRun, AgentThreadModel, DemoAgent, DemoEvent, DemoFile } from "./adapter.js";

/** AEye's agentName, with the customer agent (a second root) named for what it is. */
function agentName(agent: DemoAgent, buildRoots: number): string {
  if (agent.kind === "customer" && agent.depth === 0) return "Customer agent";
  if (agent.depth === 0) return buildRoots > 1 ? `Root agent · attempt ${agent.attempt}` : "Root agent";
  return `Subagent ${agent.ordinal}`;
}

function shortModel(model: string | null): string | null {
  return model ? model.split("/").pop() ?? model : null;
}

/* ------------------------------------------------------------------ */
/* Trace-only rows: prose messages (verbatim) and adapter items.       */
/* ------------------------------------------------------------------ */

type DemoItem =
  | TraceItem
  | { type: "prompt"; at: string | null; text: string }
  | { type: "notice"; at: string | null; text: string; failed: boolean };

const MessageRow = memo(function MessageRow({ event, author, rowKey }: { event: TraceThreadEvent; author: string; rowKey: string }) {
  const html = useMemo(() => renderMarkdown(event.text), [event.text]);
  return (
    <li className="trace-row trace-message" data-row-key={rowKey}>
      <time className="trace-message-time" dateTime={event.at} title={author}>{formatTime(event.at)}</time>
      <div className="trace-prose prose build-agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />
      {event.truncated ? <ActivityPayloadBlock payload={{ id: event.id, text: event.text, truncated: true, length: event.length }} label="Full message" /> : null}
    </li>
  );
});

/** A later prompt to the same agent (the customer's retry): AEye's task row, inline. */
function PromptRow({ text, rowKey }: { text: string; rowKey: string }) {
  return (
    <li className="trace-row" data-row-key={rowKey}>
      <ActivityTaskRow label="Prompt given to this agent" html={() => renderMarkdown(text)} />
    </li>
  );
}

/** A host notice in a thread (a prompt error), worded as the log recorded it. */
function NoticeRow({ text, failed, rowKey }: { text: string; failed: boolean; rowKey: string }) {
  return (
    <li className={`activity-model-retry${failed ? " activity-model-retry--stopped" : ""}`} data-row-key={rowKey}>
      {failed ? <TriangleAlert aria-hidden="true" size={13} /> : null}
      <span>{text}</span>
    </li>
  );
}

function childAgentsFor(tool: ActivityTool, ownerId: string, agents: readonly TraceAgent[]): TraceAgent[] {
  const ids = new Set(tool.agentIds ?? []);
  const byId = agents.filter((agent) => ids.has(agent.id));
  if (byId.length > 0) return byId;
  if (tool.status === "failed") return [];
  const from = Date.parse(tool.startedAt ?? "");
  const to = tool.endedAt ? Date.parse(tool.endedAt) + 120_000 : Number.POSITIVE_INFINITY;
  return agents.filter((agent) => {
    if (agent.parentId !== ownerId) return false;
    const created = Date.parse(agent.createdAt);
    return created >= from - 1_000 && created <= to;
  });
}

function HandoffNote({ note }: { note: string }) {
  const html = useMemo(() => renderMarkdown(note), [note]);
  return <div className="activity-card-body prose build-agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Entries of one thread: AEye's traceActivityEntries per stretch of events, with prompts and notices between. */
function threadEntries(thread: AgentThreadModel, live: boolean): ActivityEntry<DemoItem>[] {
  const entries: ActivityEntry<DemoItem>[] = [];
  thread.parts.forEach((part, index) => {
    if (part.type === "prompt") { entries.push({ type: "item", key: `p${part.key}`, item: { type: "prompt", at: part.at, text: part.text } }); return; }
    if (part.type === "notice") { entries.push({ type: "item", key: `n${part.key}`, item: { type: "notice", at: part.at, text: part.text, failed: part.failed } }); return; }
    const last = index === thread.parts.length - 1;
    for (const entry of traceActivityEntries(part.events, [], live && last)) {
      // Keys stay unique across stretches (providers reuse call ids across turns).
      const prefix = `s${index}:`;
      if (entry.type === "tool") entries.push({ ...entry, key: prefix + entry.key, tool: { ...entry.tool, key: prefix + entry.tool.key } });
      else entries.push({ ...entry, key: prefix + entry.key } as ActivityEntry<DemoItem>);
    }
  });
  return entries;
}

/**
 * The calm closing line of a thread (AEye's TraceRunLine), worded from what
 * the log and the trace server actually know about this agent and the run.
 */
function runLine(agent: DemoAgent, run: AdaptedRun): React.ReactNode {
  if (run.mode === "disconnected") {
    return <p className="trace-live trace-live--stopped" role="status">Lost contact with the trace server. Showing what was read; current status unknown.</p>;
  }
  if (run.mode === "orphaned") {
    return <p className="trace-live trace-live--stopped" role="status">
      The demo process{run.producerPid ? ` (pid ${run.producerPid})` : ""} is no longer running and recorded no end.
      {run.lastActivityAt ? ` Last activity ${formatDateTime(run.lastActivityAt)}.` : ""} Outcome unknown.
    </p>;
  }
  if (agent.status === "waiting") {
    return <p className="trace-live trace-live--calm" role="status">
      {agent.statusLabel === "pending" ? "Pending · not started yet" : agent.kind === "customer" ? "Idle · waiting for its next prompt" : "Waiting"}
    </p>;
  }
  if (agent.statusLabel === "partial") {
    return <p className="trace-live trace-live--stopped">Ended with a partial result (its budget ran out before it finished).</p>;
  }
  if (agent.statusLabel === "interrupted") {
    return <p className="trace-live trace-live--stopped">Interrupted: the run was cancelled or aborted while this agent was active.</p>;
  }
  if (agent.statusLabel === "unknown") {
    if (run.ended && run.endedBy) {
      return <p className="trace-live trace-live--stopped">
        The run ended{run.endedBy.status ? ` (${run.endedBy.status})` : ""}{run.endedBy.at ? ` at ${formatDateTime(run.endedBy.at)}` : ""}: {run.endedBy.title}. No outcome was recorded for this agent.
      </p>;
    }
    return <p className="trace-live trace-live--stopped">This agent's work ended without a recorded outcome.</p>;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* One agent's thread.                                                 */
/* ------------------------------------------------------------------ */

const scrollMemory = new Map<string, number | null>();

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function AgentThread({
  agent,
  agents,
  thread,
  buildRoots,
  live,
  run,
  onOpenAgent,
  activeChildId,
  toolbar,
  compact = false,
}: {
  agent: DemoAgent;
  agents: readonly DemoAgent[];
  thread: AgentThreadModel;
  buildRoots: number;
  live: boolean;
  run: AdaptedRun;
  onOpenAgent(id: string): void;
  activeChildId: string | null;
  toolbar?: React.ReactNode;
  compact?: boolean;
}) {
  const memoryKey = `${compact ? "panel" : "main"}|${agent.id}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(scrollMemory.get(memoryKey) == null);
  const followingMutationRef = useRef(false);
  const [atEnd, setAtEnd] = useState(true);
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());

  const tailWorking = live;
  const entries = useMemo(() => threadEntries(thread, tailWorking), [thread, tailWorking]);
  const rows = useMemo(() => groupActivity(entries), [entries]);
  const wait = tailWorking ? activeSubagentWait(entries, agents, agent.id) : null;
  const activeNow = live && !agent.completedAt;
  const now = useNow(wait !== null || activeNow);

  // Restore this agent's place, else start at the end.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const saved = scrollMemory.get(memoryKey);
    node.scrollTop = saved == null ? node.scrollHeight : saved;
  }, [memoryKey]);
  // Follow new activity while at the end.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !followRef.current) return;
    followingMutationRef.current = true;
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => { followingMutationRef.current = false; });
  }, [rows, wait !== null]);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (distance <= 2) followRef.current = true;
      else if (!followingMutationRef.current) followRef.current = false;
      setAtEnd(distance <= 2);
      scrollMemory.set(memoryKey, distance <= 2 ? null : node.scrollTop);
    };
    const userScroll = () => { followingMutationRef.current = false; followRef.current = false; };
    const userKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) userScroll();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", userScroll, { passive: true });
    node.addEventListener("touchmove", userScroll, { passive: true });
    node.addEventListener("pointerdown", userScroll, { passive: true });
    node.addEventListener("keydown", userKey);
    return () => {
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", userScroll);
      node.removeEventListener("touchmove", userScroll);
      node.removeEventListener("pointerdown", userScroll);
      node.removeEventListener("keydown", userKey);
    };
  }, [memoryKey]);

  // "Show all N characters": the full stored text is already in memory.
  const payloads = useMemo<ActivityPayloadLoader>(() => {
    const full = new Map<number, string>();
    for (const id of loaded) { const text = thread.full.get(id); if (text !== undefined) full.set(id, text); }
    return { full, load: (id: number) => setLoaded((current) => new Set(current).add(id)), loading: new Set() };
  }, [loaded, thread]);
  const render = useMemo(() => ({
    renderToolExtra: (tool: ActivityTool) => {
      const receipts = tool.callId ? thread.receipts.get(tool.callId) : undefined;
      if (!receipts?.length) return null;
      return receipts.map((receipt, index) => (
        <ActivityPayloadBlock key={index} payload={{ text: receipt.text, truncated: false, length: receipt.text.length }} label={receipt.label} failed={receipt.failed} />
      ));
    },
  }), [thread]);

  const subagentCard = useCallback((tool: ActivityTool) => ({
    agents: childAgentsFor(tool, agent.id, agents).map((child): ActivityAgentChip => ({
      id: child.id, name: agentName(child as DemoAgent, buildRoots), title: child.title, current: activeChildId === child.id,
    })),
    ...(tool.status === "failed" ? {} : { emptyNote: tool.status === "running" ? "Starting…" : "The started agents are not recorded in this run." }),
    onOpen: onOpenAgent,
  }), [agent.id, agents, buildRoots, activeChildId, onOpenAgent]);
  const handoffBody = useCallback((tool: ActivityTool) => tool.note ? <HandoffNote note={tool.note} /> : null, []);
  const objectiveHtml = useCallback(() => renderMarkdown(agent.objective || "No task was recorded for this agent."), [agent.objective]);

  const name = agentName(agent, buildRoots);
  const lastAt = agent.completedAt ?? agent.lastActivityAt;
  const duration = activeNow
    ? spanMs(agent.createdAt, new Date(Math.max(now, Date.parse(lastAt ?? agent.createdAt) || 0)).toISOString())
    : spanMs(agent.createdAt, lastAt);
  const parent = agent.parentId ? agents.find((candidate) => candidate.id === agent.parentId) ?? null : null;
  const closing = runLine(agent, run);
  const hasEvents = thread.eventCount > 0 || rows.length > 0;

  return (
    <ActivityPayloadContext.Provider value={payloads}>
      <ActivityRenderContext.Provider value={render}>
        <div className={`trace-thread activity-scope${compact ? " trace-thread--compact" : ""}`}>
          <header className="trace-thread-header">
            <div className="trace-thread-heading">
              {agent.depth > 0 || compact ? <p className="trace-thread-subtitle"><span className="trace-agent-name">{name}</span><span className="trace-agent-title">{agent.title}</span></p> : null}
              <p className="trace-thread-meta">
                <span>Started {formatDateTime(agent.createdAt)}</span>
                {duration !== null ? <span>{agent.completedAt ? "Ran" : live ? "Active" : "Ran"} {formatSpan(duration)}</span> : null}
                {agent.model ? <span title={agent.model}>{shortModel(agent.model)}</span> : null}
                {!live && agent.status !== "done" && agent.status !== "failed" && lastAt ? <span>Last activity {formatDateTime(lastAt)}</span> : null}
                {parent ? <button type="button" className="trace-link-button" onClick={() => onOpenAgent(parent.id)}>Parent: {agentName(parent, buildRoots)}</button> : null}
              </p>
            </div>
            {toolbar ? <div className="trace-thread-toolbar">{toolbar}</div> : null}
          </header>
          <div className="trace-scroll" ref={scrollRef} tabIndex={-1}>
            <div className="trace-column">
              <ActivityTaskRow html={objectiveHtml} />
              {agent.failure ? <div className="trace-failure"><TriangleAlert aria-hidden="true" size={14} /><div><p>{agent.failure}</p></div></div> : null}
              {hasEvents ? <p className="trace-start">Start of this agent's activity</p> : null}
              {!hasEvents ? <p className="trace-muted trace-empty">{live ? "Waiting for this agent's first step…" : "No activity was recorded for this agent."}</p> : null}
              <ol className="activity-rows trace-rows">
                {rows.map((row, index) => {
                  if (row.type === "item") {
                    const item = row.item;
                    if (item.type === "message") return <MessageRow key={row.key} rowKey={row.key} event={item.event} author={name} />;
                    if (item.type === "prompt") return <PromptRow key={row.key} rowKey={row.key} text={item.text} />;
                    if (item.type === "notice") return <NoticeRow key={row.key} rowKey={row.key} text={item.text} failed={item.failed} />;
                    return null;
                  }
                  return (
                    <ActivityRowView
                      key={row.key}
                      row={row}
                      rowKey={row.key}
                      trailing={tailWorking && index === rows.length - 1}
                      working={tailWorking && index === rows.length - 1}
                      subagents={subagentCard}
                      handoffBody={handoffBody}
                    />
                  );
                })}
              </ol>
              {wait ? (
                <ActivitySubagentWaitLine
                  running={wait.running.map((child) => ({ id: child.id, name: agentName(child as DemoAgent, buildRoots) }))}
                  total={wait.waitedOn.length}
                  elapsedMs={spanMs(wait.startedAt, new Date(now).toISOString())}
                  onOpen={onOpenAgent}
                />
              ) : tailWorking ? <p className="trace-live"><ActivitySpinner size={13} /> Working…</p> : null}
              {closing}
            </div>
          </div>
          {!atEnd ? (
            <button type="button" className="trace-jump" onClick={() => {
              const node = scrollRef.current;
              followRef.current = true;
              if (node) node.scrollTop = node.scrollHeight;
            }}>Jump to latest</button>
          ) : null}
        </div>
      </ActivityRenderContext.Provider>
    </ActivityPayloadContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Right panel: agent list, files, operator records.                   */
/* ------------------------------------------------------------------ */

function AgentList({ agents, buildRoots, mainId, onOpen }: { agents: readonly DemoAgent[]; buildRoots: number; mainId: string | null; onOpen(id: string): void }) {
  const ordered = useMemo(() => {
    const children = new Map<string | null, DemoAgent[]>();
    for (const agent of agents) {
      const key = agent.parentId && agents.some((candidate) => candidate.id === agent.parentId) ? agent.parentId : null;
      children.set(key, [...(children.get(key) ?? []), agent]);
    }
    const out: Array<{ agent: DemoAgent; level: number }> = [];
    const walk = (parent: string | null, level: number) => {
      for (const agent of children.get(parent) ?? []) { out.push({ agent, level }); walk(agent.id, level + 1); }
    };
    walk(null, 0);
    return out;
  }, [agents]);
  if (ordered.length === 0) return <div className="trace-placeholder">No subagents in this run yet.</div>;
  return (
    <div className="trace-agent-list">
      <ul>
        {ordered.map(({ agent, level }) => (
          <li key={agent.id}>
            <button
              type="button"
              className="trace-agent-item"
              style={{ "--trace-level": level } as React.CSSProperties}
              onClick={() => onOpen(agent.id)}
              aria-current={agent.id === mainId ? "true" : undefined}
            >
              {agent.depth === 0 ? <span className="trace-agent-item-title">{agentName(agent, buildRoots)}</span> : (
                <>
                  <span className="trace-agent-name">{agentName(agent, buildRoots)}</span>
                  <span className="trace-agent-item-title">{agent.title}</span>
                </>
              )}
              {agent.id === mainId ? <small>Main view</small> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type FilesView = "whole" | "diff";

/** The run's recorded files as AEye's tree nodes: folders first, then files, each by name. */
export function recordedFileTree(files: readonly DemoFile[]): HandbookTreeNode[] {
  const root: HandbookTreeNode = { kind: "directory", title: "", path: "", children: [] };
  const folders = new Map<string, HandbookTreeNode>([["", root]]);
  const folder = (path: string): HandbookTreeNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const at = path.lastIndexOf("/");
    const node: HandbookTreeNode = { kind: "directory", title: path.slice(at + 1), path, children: [] };
    folder(at < 0 ? "" : path.slice(0, at)).children.push(node);
    folders.set(path, node);
    return node;
  };
  for (const file of files) {
    const clean = file.path.replace(/^\/+|\/+$/gu, "");
    if (!clean) continue;
    const at = clean.lastIndexOf("/");
    folder(at < 0 ? "" : clean.slice(0, at)).children.push({ kind: "file", title: clean.slice(at + 1), path: file.path, children: [] });
  }
  const sort = (nodes: HandbookTreeNode[]): HandbookTreeNode[] => nodes
    .sort((left, right) => left.kind === right.kind ? left.title.localeCompare(right.title) : left.kind === "directory" ? -1 : 1)
    .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root.children);
}

/** What the Files tab last showed, kept while other tabs are open (the tree's folders are kept by DraftTreeNodes). */
const filesMemory: { selected: string | null; view: FilesView } = { selected: null, view: "whole" };

function initialFile(): string | null {
  try { return new URL(window.location.href).searchParams.get("file") ?? filesMemory.selected; } catch { return filesMemory.selected; }
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/iu.test(path);
}

/** Path as AEye's file heading reads it: folders muted, the name strong; the whole path wraps and is the title. */
function FileHeading({ file, stat }: { file: DemoFile; stat?: { added: number; removed: number } | null }) {
  const at = file.path.lastIndexOf("/");
  return (
    <div className="build-file-heading">
      <h3 className="trace-file-path" title={file.path}>
        {at >= 0 ? <span className="trace-file-dir">{file.path.slice(0, at + 1)}</span> : null}{file.path.slice(at + 1)}
      </h3>
      {stat ? <span className="agent-feed-diffstat"><ins>+{stat.added}</ins> <del>−{stat.removed}</del></span> : null}
      {file.kind ? <span className="trace-file-kind">{file.kind}</span> : null}
    </div>
  );
}

/** AEye's DraftFileBody for a recorded file: Markdown rendered as a page, other text as TextFileView. */
/** File selection in the address, as AEye's tree writes it (`?file=`); agent, panel and other params stay. */
function selectFileInAddress(path: string): string {
  const href = workspaceFileHref(window.location.href, path);
  window.history.replaceState(window.history.state, "", href);
  return href;
}

/**
 * AEye's DraftFileBody for a recorded file: Markdown rendered as a page (or its source), other text as
 * TextFileView. Links in the page follow resolveRecordedLink: a recorded target opens here, a missing
 * one says it was not recorded, an external one stays a normal link.
 */
function FileBody({ file, recorded, onOpen }: { file: DemoFile; recorded: ReadonlySet<string>; onOpen(path: string): void }) {
  const content = file.after ?? file.before;
  const deleted = file.after === null && file.before !== null;
  const markdown = isMarkdown(file.path);
  const [source, setSource] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (content !== null && markdown ? renderMarkdown(content) : null), [content, markdown]);
  useEffect(() => setMissing(null), [file.path]);
  // Point each in-viewer link at what it opens, so hover, copy and middle-click are honest too.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    for (const anchor of page.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const original = anchor.dataset.recordedHref ?? anchor.getAttribute("href") ?? "";
      anchor.dataset.recordedHref = original;
      const link = resolveRecordedLink(file.path, original, recorded);
      if (link.kind === "file") {
        anchor.setAttribute("href", workspaceFileHref(window.location.href, link.path));
        anchor.title = link.path;
        anchor.removeAttribute("aria-disabled");
      } else if (link.kind === "missing") {
        anchor.setAttribute("href", original);
        anchor.title = `${link.path} was not recorded in this run`;
        anchor.setAttribute("aria-disabled", "true");
      }
    }
  }, [html, source, file.path, recorded]);
  if (content === null) {
    return <div className="build-preview-state"><h4>No contents recorded</h4><p>The run recorded this path without its contents.</p></div>;
  }
  const notes = (
    <>
      {deleted ? <div className="build-preview-state"><h4>Deleted in this run</h4><p>Its last recorded contents follow.</p></div> : null}
      {file.truncated ? <p className="muted">Shown as recorded: the demo cut this file's contents.</p> : null}
    </>
  );
  if (content.length === 0) return <>{notes}<div className="build-preview-state"><h4>Empty file</h4><p>This file has no contents.</p></div></>;
  if (html === null) return <>{notes}<TextFileView content={content} /></>;
  const toggle = (
    <div className="live-toggle trace-file-mode" role="radiogroup" aria-label="Markdown view">
      <button type="button" role="radio" aria-checked={!source} onClick={() => setSource(false)}>Rendered</button>
      <button type="button" role="radio" aria-checked={source} onClick={() => setSource(true)}>Source</button>
    </div>
  );
  if (source) return <>{notes}{toggle}<TextFileView content={content} /></>;
  const hasTitle = leadingMarkdownTitle(content) !== null;
  return (
    <>
      {notes}
      {toggle}
      {missing ? <p className="muted trace-link-missing" role="status">{missing} was not recorded in this run, so it cannot be shown.</p> : null}
      <div
        ref={pageRef}
        className="prose build-preview-markdown"
        onClick={(event) => {
          const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
          if (!(anchor instanceof HTMLAnchorElement) || !pageRef.current?.contains(anchor)) return;
          const link = resolveRecordedLink(file.path, anchor.dataset.recordedHref ?? anchor.getAttribute("href") ?? "", recorded);
          if (link.kind === "external" || link.kind === "anchor") return;
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            if (link.kind === "missing") event.preventDefault();
            return;
          }
          event.preventDefault();
          if (link.kind === "missing") { setMissing(link.path); return; }
          setMissing(null);
          selectFileInAddress(link.path);
          onOpen(link.path);
        }}
      >
        {hasTitle ? null : <h1>{file.path.split("/").at(-1)?.replace(/\.md$/u, "")}</h1>}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </>
  );
}

/** The selected file's change: AEye's numbered line diff, with honest added / deleted / unchanged states. */
function FileDiff({ file }: { file: DemoFile }) {
  const diff = useMemo(() => diffLines(file.before ?? "", file.after ?? ""), [file.before, file.after]);
  const note = file.before === null && file.after === null ? "No contents were recorded for this path."
    : file.before === null ? "Added in this run."
    : file.after === null ? "Deleted in this run."
    : diff.addedLines === 0 && diff.removedLines === 0 ? "No change in contents." : null;
  return (
    <>
      <FileHeading file={file} stat={file.before === null && file.after === null ? null : { added: diff.addedLines, removed: diff.removedLines }} />
      {note ? <p className="muted">{note}</p> : null}
      {file.truncated ? <p className="muted">The demo cut this file's contents; the diff covers what was recorded.</p> : null}
      {diff.rows.length > 0 ? <LineDiffView diff={diff} label={`Changes to ${file.path}`} numbered /> : null}
    </>
  );
}

function FilesPanel({ files, diffs, runKey }: { files: readonly DemoFile[]; diffs: AdaptedRun["diffs"]; runKey: string }) {
  const [view, setViewState] = useState<FilesView>(filesMemory.view);
  const [selected, setSelectedState] = useState<string | null>(initialFile);
  const setView = (next: FilesView) => { filesMemory.view = next; setViewState(next); };
  const setSelected = useCallback((path: string) => { filesMemory.selected = path; setSelectedState(path); }, []);
  // A selection that is not (or no longer) a recorded file falls back to the first one, and is never invented.
  const file = files.find((candidate) => candidate.path === selected) ?? files[0] ?? null;
  // The tree changes only when the set of recorded paths does, not on every live event or content edit.
  const pathKey = files.map((entry) => entry.path).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = useMemo(() => recordedFileTree(files), [pathKey]);
  const recorded = useMemo(() => new Set(files.map((entry) => entry.path)), [files]);
  const modes = (
    <div className="workspace-panel-modes" role="tablist" aria-label="Files view">
      {(["whole", "diff"] as const).map((mode) => (
        <button key={mode} type="button" role="tab" aria-selected={view === mode} onClick={() => setView(mode)}>{mode === "whole" ? "Whole" : "Diff"}</button>
      ))}
    </div>
  );
  if (files.length === 0) {
    return (
      <div className="trace-files">
        <div className="live-files-bar">{modes}<span className="live-status">No files recorded yet</span></div>
        {view === "diff" && diffs.length > 0 ? (
          <div className="trace-diff-list">{diffs.map((diff, index) => (
            <section key={index} className="activity-payload"><header><span>{diff.title}</span></header><pre>{diff.text}</pre></section>
          ))}</div>
        ) : <p className="trace-panel-note">Memory and source files appear here once the run records them.</p>}
      </div>
    );
  }
  return (
    <div className="trace-files">
      <div className="live-files-bar">{modes}<span className="live-status">{view === "diff" ? "Changes in this run" : `${files.length} file${files.length === 1 ? "" : "s"} recorded`}</span></div>
      <div className="build-ide-files-body">
        <nav className="build-ide-tree" aria-label="Recorded files">
          <DraftTreeNodes nodes={tree} selected={file?.path ?? null} onSelect={setSelected} persistKey={`demo-files:${runKey}`} />
        </nav>
        <section className="build-ide-preview" aria-label={view === "diff" ? "File diff" : "File preview"}>
          {file === null ? <p className="trace-muted">Choose a file.</p>
            : view === "diff" ? <FileDiff file={file} />
            : <><FileHeading file={file} /><FileBody key={file.path} file={file} recorded={recorded} onOpen={setSelected} /></>}
        </section>
      </div>
    </div>
  );
}

/** The operator's own records (seed, deploy, checks, phases), quietly, oldest first. */
function RunPanel({ events }: { events: readonly DemoEvent[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (events.length === 0) return <div className="trace-placeholder">No operator records yet.</div>;
  return (
    <div className="trace-agent-list">
      <ol className="activity-rows trace-run-log">
        {events.map((event) => {
          const failed = event.status === "failed";
          const detail = [event.text, event.data === undefined ? "" : JSON.stringify(event.data, null, 2)].filter(Boolean).join("\n\n");
          return (
            <li key={event.id} className={`activity-line${failed ? " activity-line--failed" : ""}`}>
              <button type="button" className="activity-toggle" aria-expanded={open === event.id} onClick={() => setOpen(open === event.id ? null : event.id)}>
                <span className="activity-label" title={event.title}><strong>{event.kind.replaceAll("_", " ")}</strong> {event.title}</span>
                <span className="activity-trailing">
                  {failed ? <span className="activity-badge activity-badge--failed">Failed</span> : null}
                  {event.at ? <time dateTime={event.at}>{formatTime(event.at)}</time> : null}
                </span>
              </button>
              {open === event.id && detail ? <div className="activity-details"><section className="activity-payload"><header><span>Recorded</span></header><pre>{detail}</pre></section></div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workbench.                                                          */
/* ------------------------------------------------------------------ */

const PANE_KEY = "silicon-trace-right-pane-percent";
const DEFAULT_PANE = 40;
const MIN_PANE = 24;
const MAX_PANE = 70;

type PanelMode = "files" | "agents" | "run";

function readParams(): { agent: string | null; panel: PanelMode | null; panelAgent: string | null } {
  try {
    const params = new URL(window.location.href).searchParams;
    const panel = params.get("panel");
    return { agent: params.get("agent"), panel: panel === "files" || panel === "agents" || panel === "run" ? panel : null, panelAgent: params.get("subagent") };
  } catch {
    return { agent: null, panel: null, panelAgent: null };
  }
}

function writeParams(values: { agent: string | null; panel: PanelMode; panelAgent: string | null }) {
  try {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) => { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); };
    set("agent", values.agent);
    set("panel", values.panel === "files" ? null : values.panel);
    set("subagent", values.panelAgent);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  } catch { /* optional */ }
}

/** The build's root agent once it exists, else the customer agent: whichever root has activity, newest. */
function defaultMainAgent(agents: readonly DemoAgent[]): DemoAgent | null {
  const roots = agents.filter((agent) => agent.depth === 0);
  const build = roots.filter((agent) => agent.kind === "build");
  const withActivity = build.filter((agent) => agent.events > 0);
  return withActivity.at(-1) ?? build.at(-1) ?? roots.find((agent) => agent.kind === "customer") ?? roots.at(-1) ?? agents[0] ?? null;
}

export function TraceWorkbench({ run, ready, error }: { run: AdaptedRun; ready: boolean; error: string | null }) {
  const { agents, threads } = run;
  const [mainId, setMainId] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelMode>("files");
  const [panelAgentId, setPanelAgentId] = useState<string | null>(null);
  const [pane, setPane] = useState(DEFAULT_PANE);
  const layoutRef = useRef<HTMLDivElement>(null);
  const paramsRef = useRef<ReturnType<typeof readParams> | null>(null);
  const pinnedMainRef = useRef(false);

  useLayoutEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(PANE_KEY));
      if (Number.isFinite(stored) && stored >= MIN_PANE && stored <= MAX_PANE) setPane(stored);
    } catch { /* optional */ }
  }, []);
  useEffect(() => {
    paramsRef.current = readParams();
    if (paramsRef.current.panel) setPanel(paramsRef.current.panel);
    if (paramsRef.current.panelAgent) { setPanel("agents"); setPanelAgentId(paramsRef.current.panelAgent); }
  }, []);

  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const roots = useMemo(() => agents.filter((agent) => agent.depth === 0), [agents]);
  const buildRoots = roots.filter((agent) => agent.kind === "build").length;

  const chooseMain = useCallback((id: string | null) => { pinnedMainRef.current = true; setMainId(id); }, []);
  useEffect(() => {
    if (agents.length === 0) return;
    const requested = paramsRef.current?.agent;
    if (!pinnedMainRef.current && requested && byId.has(requested)) { pinnedMainRef.current = true; setMainId(requested); return; }
    if (mainId === null || !byId.has(mainId)) { setMainId(defaultMainAgent(agents)?.id ?? null); return; }
    if (!pinnedMainRef.current) {
      const next = defaultMainAgent(agents)?.id ?? null;
      if (next && next !== mainId) setMainId(next);
    }
  }, [agents, byId, mainId]);
  useEffect(() => {
    if (mainId === null && panelAgentId === null && panel === "files") return;
    writeParams({ agent: pinnedMainRef.current ? mainId : null, panel, panelAgent: panel === "agents" ? panelAgentId : null });
  }, [mainId, panel, panelAgentId]);

  const openAgent = useCallback((id: string) => { setPanel("agents"); setPanelAgentId(id); }, []);
  const main = mainId ? byId.get(mainId) ?? null : null;
  const attemptAgents = useMemo(() => {
    if (!main) return agents;
    const rootOf = (agent: DemoAgent): string => {
      let current = agent;
      for (let guard = 0; current.parentId && guard < 64; guard += 1) {
        const parent = byId.get(current.parentId);
        if (!parent) break;
        current = parent;
      }
      return current.id;
    };
    const root = rootOf(main);
    return agents.filter((agent) => rootOf(agent) === root);
  }, [agents, byId, main]);
  const subagentCount = attemptAgents.filter((agent) => agent.depth > 0).length;
  const panelAgent = panelAgentId ? byId.get(panelAgentId) ?? null : null;
  const isLive = (agent: DemoAgent) => run.active && agent.status === "running";

  const commitPane = (value: number) => {
    const bounded = Math.max(MIN_PANE, Math.min(MAX_PANE, value));
    setPane(bounded);
    try { window.localStorage.setItem(PANE_KEY, String(bounded)); } catch { /* optional */ }
  };

  const mainToolbar = (
    <>
      {roots.length > 1 && main?.depth === 0 ? (
        <label className="trace-attempt">
          <span className="visually-hidden">Thread</span>
          <select value={main.id} onChange={(event) => chooseMain(event.target.value)} aria-label="Thread">
            {roots.map((root) => (
              <option key={root.id} value={root.id}>{agentName(root, buildRoots)}{root.events === 0 ? " · no activity" : ""}</option>
            ))}
          </select>
        </label>
      ) : null}
      {main && main.depth > 0 ? (
        <button type="button" className="trace-tool-button" onClick={() => chooseMain(defaultMainAgent(agents)?.id ?? null)}>
          <ArrowLeft aria-hidden="true" size={14} /> Back to root agent
        </button>
      ) : null}
    </>
  );

  const emptyThread = { parts: [], full: new Map(), receipts: new Map(), eventCount: 0 } satisfies AgentThreadModel;

  return (
    <div className="workspace-page build-trace-page">
      <div className="build-ide trace-ide" ref={layoutRef} style={{ "--build-ide-right": `${pane}%` } as React.CSSProperties}>
        <div className="trace-main">
          {main ? (
            <AgentThread
              key={main.id}
              agent={main}
              agents={agents}
              thread={threads.get(main.id) ?? emptyThread}
              buildRoots={buildRoots}
              live={isLive(main)}
              run={run}
              onOpenAgent={openAgent}
              activeChildId={panel === "agents" ? panelAgentId : null}
              toolbar={mainToolbar}
            />
          ) : (
            <div className="trace-placeholder" role="status">
              {error ?? (!ready ? "Loading…"
                : run.mode === "live" ? <span className="trace-placeholder-line"><ActivitySpinner size={13} /> Waiting for the first agent to start…</span>
                : run.mode === "ended" ? "No agent ran in this run."
                : run.mode === "orphaned" ? "The demo process stopped before any agent started."
                : "Waiting for the demo run to start…")}
            </div>
          )}
        </div>
        <div
          className="build-ide-separator"
          role="separator"
          aria-label="Resize panes"
          aria-orientation="vertical"
          aria-valuemin={MIN_PANE}
          aria-valuemax={MAX_PANE}
          aria-valuenow={Math.round(pane)}
          tabIndex={0}
          onDoubleClick={() => commitPane(DEFAULT_PANE)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") commitPane(pane + 2);
            else if (event.key === "ArrowRight") commitPane(pane - 2);
            else return;
            event.preventDefault();
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !layoutRef.current) return;
            event.preventDefault();
            const handle = event.currentTarget;
            const layout = layoutRef.current;
            handle.setPointerCapture(event.pointerId);
            handle.dataset.dragging = "true";
            document.documentElement.setAttribute("data-workspace-resizing", "");
            const rect = layout.getBoundingClientRect();
            let pointerX = event.clientX;
            let latest = pane;
            let frame = 0;
            const paint = () => {
              frame = 0;
              latest = Math.max(MIN_PANE, Math.min(MAX_PANE, ((rect.right - pointerX) / rect.width) * 100));
              layout.style.setProperty("--build-ide-right", `${latest}%`);
            };
            const move = (moveEvent: PointerEvent) => { pointerX = moveEvent.clientX; if (frame === 0) frame = requestAnimationFrame(paint); };
            const end = () => {
              handle.removeEventListener("pointermove", move);
              handle.removeEventListener("pointerup", end);
              handle.removeEventListener("pointercancel", end);
              handle.removeEventListener("lostpointercapture", end);
              if (frame !== 0) { cancelAnimationFrame(frame); paint(); }
              handle.dataset.dragging = "false";
              document.documentElement.removeAttribute("data-workspace-resizing");
              commitPane(latest);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
            handle.addEventListener("lostpointercapture", end);
          }}
        />
        <aside className="trace-panel" aria-label="Files and subagents">
          <div className="trace-panel-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={panel === "files"} onClick={() => setPanel("files")}>
              <FolderTree aria-hidden="true" size={14} /> Files{run.files.length > 0 ? <small>{run.files.length}</small> : null}
            </button>
            <button type="button" role="tab" aria-selected={panel === "agents"} onClick={() => { setPanel("agents"); if (panel === "agents") setPanelAgentId(null); }}>
              <Users aria-hidden="true" size={14} /> Subagents{subagentCount > 0 ? <small>{subagentCount}</small> : null}
            </button>
            <button type="button" role="tab" aria-selected={panel === "run"} onClick={() => setPanel("run")}>
              <ListChecks aria-hidden="true" size={14} /> Run
            </button>
          </div>
          <div className="trace-panel-body">
            {panel === "files" ? <FilesPanel files={run.files} diffs={run.diffs} runKey={run.runId ?? "run"} />
              : panel === "run" ? <RunPanel events={run.operator} />
              : panelAgent ? (
                <AgentThread
                  key={panelAgent.id}
                  agent={panelAgent}
                  agents={agents}
                  thread={threads.get(panelAgent.id) ?? emptyThread}
                  buildRoots={buildRoots}
                  live={isLive(panelAgent)}
                  run={run}
                  onOpenAgent={openAgent}
                  activeChildId={null}
                  compact
                  toolbar={(
                    <>
                      <button type="button" className="trace-tool-button" onClick={() => setPanelAgentId(null)}>
                        <ArrowLeft aria-hidden="true" size={14} /> All agents
                      </button>
                      {panelAgent.id !== mainId ? (
                        <button type="button" className="trace-tool-button" onClick={() => { chooseMain(panelAgent.id); setPanelAgentId(null); }}>
                          Open in main view
                        </button>
                      ) : null}
                    </>
                  )}
                />
              ) : <AgentList agents={main ? attemptAgents : agents} buildRoots={buildRoots} mainId={mainId} onOpen={openAgent} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

export { formatTime, formatDateTime };
