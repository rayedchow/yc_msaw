"use client";

import {
  Brain,
  Check,
  ChevronRight,
  ClipboardList,
  Eye,
  FilePen,
  GitMerge,
  Hourglass,
  Layers,
  LoaderCircle,
  Search,
  Send,
  Terminal,
  TriangleAlert,
  Users,
  Wrench,
} from "lucide-react";
import React, { memo, useEffect, useState } from "react";
import {
  describeWorkGroup,
  formatClock,
  operationProgressText,
  toolDurationMs,
  toolFailed,
  toolLabel,
  toolRetried,
  type ActivityCategory,
  type ActivityPayload,
  type ActivityProposal,
  type ActivityRow,
  type ActivityThought,
  type ActivityTool,
  type WorkEntry,
} from "./activity-model.js";
import { errorSummary, formatActivitySpan, formatActivityTime } from "./activity-format.js";
import { ActivityFileChange } from "./activity-file-change.js";
import { isFileChangeTool, parseFileChangeCall } from "./edit-call.js";
import { toolLabelForStatus } from "../../../src/build/build_trace_threads.js";
import type { RunResumption } from "../../../src/build/run_resumptions.js";
import { resumptionLabel } from "./resumption.js";

/*
 * Shared agent-activity rows (styles in agent-activity.css): the same
 * grouping, carets, durations, details and motion in the build trace, Chat
 * answers and Edit conversations. Surfaces render their own prose; these
 * render work groups, calls, thoughts, compactions, tasks and cards.
 */

/* ------------------------------------------------------------------ */
/* Context: full payloads on demand and surface-specific call detail.  */
/* ------------------------------------------------------------------ */

export interface ActivityPayloadLoader {
  full: ReadonlyMap<number, string>;
  load(id: number): void;
  loading: ReadonlySet<number>;
}

export const ActivityPayloadContext = React.createContext<ActivityPayloadLoader>({
  full: new Map(),
  load: () => undefined,
  loading: new Set(),
});

export interface ActivityRenderOptions {
  /** Extra detail under a call's input and result (for example Chat's cited files). */
  renderToolExtra?: (tool: ActivityTool) => React.ReactNode;
}

export const ActivityRenderContext = React.createContext<ActivityRenderOptions>({});

/* ------------------------------------------------------------------ */
/* Primitives.                                                         */
/* ------------------------------------------------------------------ */

/** Expand/collapse with a height animation; the content unmounts when closed. */
export function ActivityCollapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(true)));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(false);
    const timer = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(timer);
  }, [open]);
  if (!mounted) return null;
  return (
    <div className="activity-collapse" data-expanded={expanded || undefined}>
      <div className="activity-collapse-inner">{children}</div>
    </div>
  );
}

export function ActivityChevron({ size = 13 }: { size?: number }) {
  return <ChevronRight aria-hidden="true" size={size} className="activity-chevron" />;
}

export function ActivityCategoryIcon({ category, failed }: { category: ActivityCategory | "thought"; failed?: boolean }) {
  const props = { "aria-hidden": true, size: 14, strokeWidth: 1.8 } as const;
  if (failed) return <TriangleAlert {...props} className="activity-icon activity-icon--failed" />;
  if (category === "thought") return <Brain {...props} className="activity-icon" />;
  if (category === "read") return <Eye {...props} className="activity-icon" />;
  if (category === "edit") return <FilePen {...props} className="activity-icon" />;
  if (category === "command") return <Terminal {...props} className="activity-icon" />;
  if (category === "search") return <Search {...props} className="activity-icon" />;
  if (category === "agents") return <Users {...props} className="activity-icon" />;
  if (category === "wait") return <Hourglass {...props} className="activity-icon" />;
  if (category === "handoff") return <Send {...props} className="activity-icon" />;
  return <Wrench {...props} className="activity-icon" />;
}

export function ActivitySpinner({ size = 14 }: { size?: number }) {
  return <LoaderCircle aria-hidden="true" size={size} className="activity-icon activity-spin" />;
}

/**
 * Trailing meta next to the caret: a duration, else the start time (on
 * hover). With `elapsed`, a live group's running time instead, counted on a
 * local clock in fixed-width digits.
 */
function Trailing({ durationMs, at, elapsed, children }: { durationMs: number | null; at: string | null; elapsed?: string | null; children?: React.ReactNode }) {
  return (
    <span className="activity-trailing">
      {children}
      {elapsed !== undefined && elapsed !== null
        ? <span className="activity-duration activity-elapsed" title={at ? `Started ${formatActivityTime(at)}` : undefined}>{elapsed}</span>
        : durationMs !== null && durationMs > 0
        ? <span className="activity-duration" title={at ? `Started ${formatActivityTime(at)}` : undefined}>{formatActivitySpan(durationMs)}</span>
        : durationMs === 0
          ? <span className="activity-duration">{formatActivitySpan(0)}</span>
          : at ? <time dateTime={at}>{formatActivityTime(at)}</time> : null}
      <ActivityChevron />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Call details.                                                       */
/* ------------------------------------------------------------------ */

export function ActivityPayloadBlock({ payload, label, failed }: { payload: ActivityPayload; label: string; failed?: boolean }) {
  const payloads = React.useContext(ActivityPayloadContext);
  const full = payload.id === undefined ? undefined : payloads.full.get(payload.id);
  const text = full ?? payload.text;
  const id = payload.id;
  return (
    <section className={`activity-payload${failed ? " activity-payload--failed" : ""}`}>
      <header>
        <span>{label}</span>
        {payload.truncated && id !== undefined && full === undefined ? (
          <button type="button" onClick={() => payloads.load(id)} disabled={payloads.loading.has(id)}>
            {payloads.loading.has(id) ? "Loading…" : `Show all ${(payload.length ?? 0).toLocaleString()} characters`}
          </button>
        ) : null}
      </header>
      <pre>{text || "(empty)"}</pre>
    </section>
  );
}

function OutputBlock({ outputs }: { outputs: readonly ActivityPayload[] }) {
  const payloads = React.useContext(ActivityPayloadContext);
  const truncated = outputs.filter((output) => output.truncated && output.id !== undefined && !payloads.full.has(output.id));
  const text = outputs.map((output) => (output.id === undefined ? undefined : payloads.full.get(output.id)) ?? output.text).join("");
  const stderr = outputs.some((output) => output.stream === "stderr");
  return (
    <section className="activity-payload activity-payload--output">
      <header>
        <span>Output{stderr ? " (includes stderr)" : ""}</span>
        {truncated.length > 0 ? (
          <button type="button" onClick={() => truncated.forEach((output) => payloads.load(output.id!))}>
            Show full output
          </button>
        ) : null}
      </header>
      <pre>{text || "(no output)"}</pre>
    </section>
  );
}

export function ActivityToolDetails({ tool }: { tool: ActivityTool }) {
  const { renderToolExtra } = React.useContext(ActivityRenderContext);
  const payloads = React.useContext(ActivityPayloadContext);
  const failed = toolFailed(tool);
  const exact = (
    <>
      {tool.input ? <ActivityPayloadBlock payload={tool.input} label={`Input · ${tool.toolName}`} /> : null}
      {tool.outputs.length > 0 ? <OutputBlock outputs={tool.outputs} /> : null}
      {tool.result
        ? <ActivityPayloadBlock payload={tool.result} label={tool.status === "failed" ? "Error" : "Result"} failed={failed} />
        : <p className="activity-muted">{tool.status === "running" ? "Waiting for the result…" : "No result was recorded for this call."}</p>}
    </>
  );
  // An edit or write reads as its change; the exact call stays one click away.
  if (isFileChangeTool(tool.toolName) && parseFileChangeCall(tool.toolName, tool.input?.text) !== null) {
    return (
      <div className="activity-details">
        <ActivityFileChange tool={tool} payloads={payloads} />
        <details className="activity-exact">
          <summary>Exact input and result</summary>
          <div className="activity-exact-body">{exact}</div>
        </details>
        {renderToolExtra?.(tool)}
      </div>
    );
  }
  return (
    <div className="activity-details">
      {exact}
      {renderToolExtra?.(tool)}
    </div>
  );
}

/**
 * The time a clock shows: the wall clock whenever it ticks, so its first
 * frame (a work group forming from a row mounted long before) is never the
 * time its row mounted; the last tick once it stops.
 */
export function clockReading(ticking: boolean, lastTick: number, wall: number): number {
  return ticking ? wall : lastTick;
}

/** The current time, ticking each second while `ticking` (a local clock: nothing is fetched). */
function useClock(ticking: boolean): number {
  const [tick, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return clockReading(ticking, tick, Date.now());
}

/**
 * A running call's live label while it starts or waits for a host
 * operation: "Waiting for Docling · 9/16 pages · 0:42". The elapsed time
 * ticks locally; the stage and pages change as progress is recorded. One
 * line, so the row keeps its height while the text changes.
 */
export function ActivityOperationLabel({ tool }: { tool: ActivityTool }) {
  const now = useClock(tool.status === "running");
  const live = operationProgressText(tool, now);
  if (live === null) return <>{tool.label}</>;
  return (
    <>
      {live.text}
      {live.elapsed !== null ? <> · <span className="activity-elapsed">{live.elapsed}</span></> : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Lines and groups.                                                   */
/* ------------------------------------------------------------------ */

export function ActivityThoughtLine({ thought }: { thought: ActivityThought }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="activity-line" data-open={open || undefined}>
      <button type="button" className="activity-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {thought.streaming ? <ActivitySpinner /> : <ActivityCategoryIcon category="thought" />}
        <span className="activity-label">{thought.streaming ? "Thinking…" : "Thought"}</span>
        <Trailing durationMs={null} at={thought.at} />
      </button>
      <ActivityCollapse open={open}>
        <div className="activity-details"><div className="activity-thought-text">{thought.text || "…"}</div></div>
      </ActivityCollapse>
    </li>
  );
}

function StatusBadges({ tool }: { tool: ActivityTool }) {
  if (toolRetried(tool)) return <span className="activity-badge">Retried</span>;
  if (tool.status === "failed") return <span className="activity-badge activity-badge--failed">Failed</span>;
  if (tool.status === "cancelled") return <span className="activity-badge">Cancelled</span>;
  if (tool.status === "running") return <span className="activity-badge activity-badge--running">Running…</span>;
  if (tool.status === "unfinished") return <span className="activity-badge">No result</span>;
  return null;
}

export function ActivityToolLine({ tool }: { tool: ActivityTool }) {
  const [open, setOpen] = useState(false);
  const failed = toolFailed(tool);
  const label = toolLabel(tool);
  return (
    <li className={`activity-line${failed ? " activity-line--failed" : ""}`} data-open={open || undefined} data-tool-call-id={tool.callId ?? undefined}>
      <button type="button" className="activity-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {tool.status === "running" ? <ActivitySpinner /> : <ActivityCategoryIcon category={tool.category} failed={failed} />}
        <span className="activity-label" title={tool.rawLabel ?? label}>
          {tool.status === "running" && (tool.waitingOn !== undefined || tool.progress !== undefined)
            ? <ActivityOperationLabel tool={tool} />
            : label}
        </span>
        <Trailing durationMs={tool.status === "running" ? null : toolDurationMs(tool)} at={tool.startedAt}>
          <StatusBadges tool={tool} />
        </Trailing>
      </button>
      <ActivityCollapse open={open}><ActivityToolDetails tool={tool} /></ActivityCollapse>
    </li>
  );
}

/**
 * The running time a live group shows, from its first step to now ("2:06"),
 * whether a call is running or the agent is between calls, so the trailing
 * text never switches between a duration and a start time. Null once the
 * group is no longer the live tail: it then shows its recorded duration.
 */
export function workGroupElapsed(view: { firstAt: string | null }, trailing: boolean, now: number): string | null {
  if (!trailing || view.firstAt === null) return null;
  const started = Date.parse(view.firstAt);
  return Number.isFinite(started) ? formatClock(now - started) : null;
}

export function ActivityWorkLine({ entry }: { entry: WorkEntry }) {
  return entry.type === "thought" ? <ActivityThoughtLine thought={entry.thought} /> : <ActivityToolLine tool={entry.tool} />;
}

/**
 * Consecutive work as one summary row that opens to its calls and thoughts.
 * A single entry renders as its own line. The live tail reads "Working ·
 * <current step>" with a spinner until its last call settles.
 */
export const ActivityWorkGroup = memo(function ActivityWorkGroup({
  entries,
  trailing,
  working = trailing,
  rowKey,
}: {
  entries: WorkEntry[];
  rowKey?: string | undefined;
  /** The group is the last row of a live timeline. */
  trailing: boolean;
  /** Current activity permits Working decoration; the live clock remains independent. */
  working?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The live tail counts its running time locally; it settles to its duration when the group ends.
  const now = useClock(trailing && entries.length > 1);
  if (entries.length === 1) {
    return <li className="activity-row activity-work" data-row-key={rowKey}><ul className="activity-lines"><ActivityWorkLine entry={entries[0]!} /></ul></li>;
  }
  const view = describeWorkGroup(entries, { trailing: trailing && working });
  return (
    <li className="activity-row activity-work" data-row-key={rowKey} data-open={open || undefined} data-working={view.working || undefined}>
      <button type="button" className="activity-toggle activity-toggle--group" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {view.working ? <ActivitySpinner /> : <Layers aria-hidden="true" size={14} className="activity-icon" />}
        <span className="activity-label">
          {view.operationTool !== null
            ? <ActivityOperationLabel tool={view.operationTool} />
            : view.working ? <><strong>Working</strong> · {view.label}</> : view.label}
        </span>
        <Trailing durationMs={view.durationMs} at={view.firstAt} elapsed={workGroupElapsed(view, trailing, now)}>
          {view.summary.failures > 0 ? <span className="activity-badge activity-badge--failed">{view.summary.failures} failed</span> : null}
          {view.summary.retried > 0 ? <span className="activity-badge">{view.summary.retriedText}</span> : null}
        </Trailing>
      </button>
      <ActivityCollapse open={open}>
        <ul className="activity-lines activity-lines--grouped">
          {entries.map((entry) => <ActivityWorkLine key={entry.key} entry={entry} />)}
        </ul>
      </ActivityCollapse>
    </li>
  );
});

/* ------------------------------------------------------------------ */
/* Cards and dividers.                                                 */
/* ------------------------------------------------------------------ */

export interface ActivityAgentChip {
  id: string;
  /** "Subagent 3". */
  name: string;
  /** What it was asked to do, cut to one line. */
  title: string;
  current?: boolean;
}

/** A subagent launch: the agents it started, and its call on request. */
export function ActivitySubagentsCard({
  tool,
  agents,
  emptyNote,
  onOpen,
  onPrefetch,
  rowKey,
}: {
  tool: ActivityTool;
  rowKey?: string | undefined;
  agents: readonly ActivityAgentChip[];
  emptyNote?: string;
  onOpen?: (id: string) => void;
  onPrefetch?: (id: string) => void;
}) {
  const [showCall, setShowCall] = useState(false);
  const failed = toolFailed(tool);
  return (
    <li data-row-key={rowKey} className={`activity-row activity-card activity-subagents${failed ? " activity-card--failed" : ""}`}>
      <header>
        {tool.status === "running" ? <ActivitySpinner size={15} /> : <Users aria-hidden="true" size={15} className="activity-icon" />}
        <strong>{toolLabel(tool) || "Started subagents"}</strong>
        {failed ? <span className="activity-badge activity-badge--failed">Failed</span> : toolRetried(tool) ? <span className="activity-badge">Retried</span> : null}
        {tool.startedAt ? <time dateTime={tool.startedAt}>{formatActivityTime(tool.startedAt)}</time> : null}
      </header>
      {agents.length > 0 ? (
        <ul className="activity-agent-chips">
          {agents.map((agent) => (
            <li key={agent.id}>
              {onOpen ? (
                <button
                  type="button"
                  className="activity-agent-chip"
                  aria-current={agent.current ? "true" : undefined}
                  onClick={() => onOpen(agent.id)}
                  onPointerEnter={() => onPrefetch?.(agent.id)}
                >
                  <span className="activity-agent-chip-name">{agent.name}</span>
                  <span className="activity-agent-chip-title">{agent.title}</span>
                  <span className="activity-agent-chip-open">Open</span>
                </button>
              ) : (
                <span className="activity-agent-chip activity-agent-chip--static">
                  <span className="activity-agent-chip-name">{agent.name}</span>
                  <span className="activity-agent-chip-title">{agent.title}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : emptyNote ? <p className="activity-muted">{emptyNote}</p> : null}
      <button type="button" className="activity-link-button" onClick={() => setShowCall((value) => !value)} aria-expanded={showCall}>
        {showCall ? "Hide call details" : "Show call details"}
      </button>
      <ActivityCollapse open={showCall}><ActivityToolDetails tool={tool} /></ActivityCollapse>
    </li>
  );
}

/**
 * The words a publish card shows once its proposal is staged: its call's
 * label as a call that succeeded ("Proposed a Knowledge revision"), the same
 * words on the build page and the trace whatever its call later recorded.
 */
export function proposalLabel(proposal: ActivityProposal, tool?: Pick<ActivityTool, "label" | "toolName">): string {
  if (proposal.label) return proposal.label;
  const proposed = (tool === undefined ? "" : toolLabelForStatus(tool.label, tool.toolName, "succeeded")) || "Proposed";
  return proposal.waiting ? `${proposed} — waiting for review` : proposed;
}

/**
 * A handoff (results submitted, a Knowledge revision proposed). A staged
 * proposal reads as proposed whatever happened to its call afterwards: a
 * later merge failure is its own card, never this one's.
 */
export function ActivityHandoffCard({ tool, body, rowKey }: { tool: ActivityTool; body?: React.ReactNode; rowKey?: string | undefined }) {
  const [showCall, setShowCall] = useState(false);
  const proposal = tool.proposal ?? null;
  const failed = toolFailed(tool);
  const retried = toolRetried(tool);
  // A grade, like any outcome its call's input carries, is final only once
  // the call succeeded; before that (running, failed, cancelled, never
  // finished) the card says what the call did or tried to do.
  const graded = tool.verdict !== undefined && tool.status === "succeeded";
  return (
    <li data-row-key={rowKey} className={`activity-row activity-card activity-handoff${failed ? " activity-card--failed" : ""}${proposal ? " activity-handoff--proposed" : ""}`}>
      <header>
        {proposal
          ? <GitMerge aria-hidden="true" size={15} className="activity-icon" />
          : failed
            ? <TriangleAlert aria-hidden="true" size={15} className="activity-icon activity-icon--failed" />
            : tool.status === "running"
              ? <ActivitySpinner size={15} />
              : tool.status === "succeeded" && (tool.toolName === "complete_task" || tool.toolName === "submit_applicability" || tool.toolName === "submit_knowledge_answer" || graded)
                ? <Check aria-hidden="true" size={15} className="activity-icon activity-icon--good" />
                : <GitMerge aria-hidden="true" size={15} className="activity-icon" />}
        {graded
          ? <strong>Graded <span className="activity-verdict" data-verdict={tool.verdict!.verdict}>{tool.label}</span></strong>
          : <strong>{proposal ? proposalLabel(proposal, tool) : toolLabel(tool)}</strong>}
        {retried ? <span className="activity-badge">Retried</span> : null}
        {tool.startedAt ? <time dateTime={tool.startedAt}>{formatActivityTime(tool.startedAt)}</time> : null}
      </header>
      {body}
      {tool.verdict ? (
        <p className="activity-muted activity-verdict-meta">
          {`${tool.verdict.inputTokens.toLocaleString()} input · ${tool.verdict.outputTokens.toLocaleString()} output tokens`}
          {tool.verdict.estimatedUsd === null ? "" : ` · $${tool.verdict.estimatedUsd < 0.01 ? tool.verdict.estimatedUsd.toFixed(4) : tool.verdict.estimatedUsd.toFixed(2)}`}
        </p>
      ) : null}
      {/* Why the call failed; a retried one says so quietly. */}
      {(failed || retried) && tool.result
        ? <p className={failed ? "activity-error-text" : "activity-muted activity-retried-text"}>{errorSummary(tool.result.text, 400)}</p>
        : null}
      <div className="activity-card-actions">
        {proposal?.href ? <a className="activity-link-button" href={proposal.href}>View pull request</a> : null}
        <button type="button" className="activity-link-button" onClick={() => setShowCall((value) => !value)} aria-expanded={showCall}>
          {showCall ? "Hide call details" : "Show call details"}
        </button>
      </div>
      <ActivityCollapse open={showCall}><ActivityToolDetails tool={tool} /></ActivityCollapse>
    </li>
  );
}

/** A merge that failed after its proposal was approved: its own event. */
export function ActivityMergeFailureCard({ cause, at, href }: { cause: string; at: string | null; href?: string | null }) {
  return (
    <li className="activity-row activity-card activity-card--failed activity-merge-failure" role="alert">
      <header>
        <TriangleAlert aria-hidden="true" size={15} className="activity-icon activity-icon--failed" />
        <strong>Merge failed: {cause}</strong>
        {at ? <time dateTime={at}>{formatActivityTime(at)}</time> : null}
      </header>
      {href ? <div className="activity-card-actions"><a className="activity-link-button" href={href}>View pull request</a></div> : null}
    </li>
  );
}

/** One running subagent a wait names, linking to its thread. */
export interface ActivityWaitAgent {
  id: string;
  /** "Subagent 3". */
  name: string;
}

/**
 * The live line while an agent waits on its subagents: how many are still
 * running, for how long, and which (each opens its thread).
 */
export function ActivitySubagentWaitLine({
  running,
  total,
  elapsedMs,
  onOpen,
}: {
  running: readonly ActivityWaitAgent[];
  total: number;
  elapsedMs: number | null;
  onOpen?: (id: string) => void;
}) {
  return (
    <p className="trace-live activity-wait-line" role="status">
      <ActivitySpinner size={13} />
      <span>Waiting on {running.length} of {total} subagent{total === 1 ? "" : "s"}</span>
      {elapsedMs !== null ? <span className="activity-duration">{formatActivitySpan(elapsedMs)}</span> : null}
      {running.length > 0 ? (
        <span className="activity-wait-agents">
          {running.map((agent) => onOpen
            ? <button key={agent.id} type="button" className="trace-link-button" onClick={() => onOpen(agent.id)}>{agent.name}</button>
            : <span key={agent.id}>{agent.name}</span>)}
        </span>
      ) : null}
    </p>
  );
}

/** The task given to an agent, collapsed to one row. */
export function ActivityTaskRow({ label = "Task given to this agent", html }: { label?: string; html: () => string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="activity-task">
      <button type="button" className="activity-toggle activity-toggle--group" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <ClipboardList aria-hidden="true" size={14} className="activity-icon" />
        <span className="activity-label">{label}</span>
        <span className="activity-trailing"><ActivityChevron /></span>
      </button>
      <ActivityCollapse open={open}>
        {open ? <div className="activity-task-body prose build-agent-markdown" dangerouslySetInnerHTML={{ __html: html() }} /> : null}
      </ActivityCollapse>
    </div>
  );
}

/** A context compaction: a quiet divider that opens to the summary. */
export function ActivityCompactionRow({ label, summary, rowKey, payload }: { label: string; summary: string; rowKey?: string | undefined; payload?: ActivityPayload }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="activity-row activity-divider" data-row-key={rowKey}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{label}</span>
        <ActivityChevron size={12} />
      </button>
      <ActivityCollapse open={open}>
        <div className="activity-details">{payload
          ? <ActivityPayloadBlock payload={payload} label="Context summary" />
          : <div className="activity-thought-text">{summary || "No summary was recorded."}</div>}</div>
      </ActivityCollapse>
    </li>
  );
}

/**
 * Where a run went on again (an explicit resume or a new attempt): a quiet,
 * left-aligned line. A list item in the trace, a block in a conversation.
 */
export function ActivityResumptionDivider({ resumption, rowKey, as = "li" }: { resumption: RunResumption; rowKey?: string | undefined; as?: "li" | "div" }) {
  const label = resumptionLabel(resumption);
  if (label === null) return null;
  const Tag = as;
  return (
    <Tag className="activity-resumption" role="separator" aria-label={label} data-row-key={rowKey}>
      <time dateTime={resumption.at}>{label}</time>
    </Tag>
  );
}

/* ------------------------------------------------------------------ */
/* One non-item row, and the loading skeleton.                         */
/* ------------------------------------------------------------------ */

/**
 * Renders a work group, subagent card or handoff card. Item rows belong to
 * the surface (messages, compactions, answer text), so this returns null.
 */
export function ActivityRowView<Item>({
  row,
  trailing,
  working = trailing,
  subagents,
  handoffBody,
  rowKey,
}: {
  row: ActivityRow<Item>;
  rowKey?: string | undefined;
  trailing: boolean;
  working?: boolean;
  subagents?: (tool: ActivityTool) => { agents: ActivityAgentChip[]; emptyNote?: string; onOpen?: (id: string) => void; onPrefetch?: (id: string) => void };
  handoffBody?: (tool: ActivityTool) => React.ReactNode;
}) {
  if (row.type === "work") return <ActivityWorkGroup entries={row.entries} trailing={trailing} working={working} rowKey={rowKey} />;
  if (row.type === "subagents") {
    const props = subagents?.(row.tool) ?? {
      agents: (row.tool.agentTitles ?? []).map((title, index) => ({ id: `${row.key}:${index}`, name: `Subagent ${index + 1}`, title })),
    };
    return <ActivitySubagentsCard tool={row.tool} {...props} rowKey={rowKey} />;
  }
  if (row.type === "handoff") return <ActivityHandoffCard tool={row.tool} body={handoffBody?.(row.tool)} rowKey={rowKey} />;
  return null;
}

const SKELETON_ROWS = [
  { kind: "line", width: 46 },
  { kind: "prose", width: 92 },
  { kind: "prose", width: 64 },
  { kind: "line", width: 38 },
  { kind: "line", width: 52 },
  { kind: "prose", width: 88 },
  { kind: "prose", width: 71 },
  { kind: "line", width: 33 },
  { kind: "prose", width: 80 },
] as const;

export function ActivitySkeleton({ rows = SKELETON_ROWS.length, label = "Loading activity" }: { rows?: number; label?: string }) {
  return (
    <div className="activity-skeleton" aria-busy="true" aria-label={label}>
      {SKELETON_ROWS.slice(0, rows).map((row, index) => (
        <div key={index} className={`activity-skeleton-row activity-skeleton-row--${row.kind}`}>
          {row.kind === "line" ? <span className="activity-skeleton-icon" /> : null}
          <span className="activity-skeleton-bar" style={{ width: `${row.width}%` }} />
        </div>
      ))}
    </div>
  );
}
