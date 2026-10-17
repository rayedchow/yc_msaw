"use client";

import React, { useEffect, useMemo, useState } from "react";

import { displayWorkspaceText } from "../../../src/build/workspace_display.js";
import type { DiffRow, LineDiff } from "../../../src/web/text_diff.js";
import type { ActivityPayloadLoader } from "./activity-rows.js";
import type { ActivityTool } from "./activity-model.js";
import {
  FILE_CHANGE_STATE_LABELS,
  fileChangeComplete,
  fileChangeDiff,
  fileChangeReceipt,
  fileChangeReceiptBinding,
  fileChangeState,
  parseFileChangeCall,
  type ParsedFileChangeCall,
  type ReceiptBinding,
} from "./edit-call.js";

/*
 * An edit or write call as a readable change: the removed and added lines
 * the call's own input names, in a bounded scrolling frame, with whether it
 * was applied. The exact input and result stay one disclosure away
 * (ActivityToolDetails). Every text is rendered as text, never as HTML, so
 * Markdown comments and evidence markers read literally.
 */

/** Rows rendered at once; more open on request (a huge write never renders whole). */
export const DIFF_ROW_PAGE = 400;

/**
 * One line diff in a bounded frame: removed and added lines with their own
 * gutters and labels for assistive technology. Shared by activity rows and
 * the Knowledge changes panel.
 */
export function LineDiffView({ diff, label, numbered = false }: { diff: LineDiff; label: string; numbered?: boolean }) {
  const [visible, setVisible] = useState(DIFF_ROW_PAGE);
  const rows = diff.rows.slice(0, visible);
  const remaining = diff.rows.length - rows.length;
  return (
    <div className="activity-diff" role="region" aria-label={label}>
      <ol className="activity-diff-rows">
        {rows.map((row, index) => <DiffLine key={index} row={row} numbered={numbered} />)}
      </ol>
      {remaining > 0 ? (
        <button type="button" className="activity-link-button activity-diff-more" onClick={() => setVisible((count) => count + DIFF_ROW_PAGE)}>
          Show {Math.min(DIFF_ROW_PAGE, remaining).toLocaleString()} more of {remaining.toLocaleString()} lines
        </button>
      ) : null}
      {diff.truncated ? <p className="activity-muted activity-diff-note">Too large to align line by line: shown as whole removed and added blocks.</p> : null}
    </div>
  );
}

function DiffLine({ row, numbered }: { row: DiffRow; numbered: boolean }) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " ";
  const spoken = row.kind === "add" ? "Added: " : row.kind === "del" ? "Removed: " : "";
  return (
    <li className={`activity-diff-row activity-diff-row--${row.kind}`}>
      {numbered ? <span className="activity-diff-number" aria-hidden="true">{row.oldLine ?? ""}</span> : null}
      {numbered ? <span className="activity-diff-number" aria-hidden="true">{row.newLine ?? ""}</span> : null}
      <span className="activity-diff-sign" aria-hidden="true">{sign}</span>
      <code>{spoken ? <span className="visually-hidden">{spoken}</span> : null}{row.text || " "}</code>
    </li>
  );
}

function useReceiptBinding(call: ParsedFileChangeCall | null, receipt: ReturnType<typeof fileChangeReceipt>): ReceiptBinding {
  const [binding, setBinding] = useState<ReceiptBinding>("unavailable");
  useEffect(() => {
    if (call === null) return;
    let disposed = false;
    void fileChangeReceiptBinding(call, receipt).then((value) => { if (!disposed) setBinding(value); }, () => undefined);
    return () => { disposed = true; };
  }, [call, receipt]);
  return binding;
}

/**
 * The change an edit or write call made, or null for any other call (and
 * for one whose input cannot be read as an edit or write at all).
 */
export function ActivityFileChange({ tool, payloads }: { tool: ActivityTool; payloads: ActivityPayloadLoader }) {
  const input = tool.input;
  const full = input?.id === undefined ? undefined : payloads.full.get(input.id);
  const inputText = full ?? input?.text ?? null;
  const resultFull = tool.result?.id === undefined ? undefined : payloads.full.get(tool.result.id);
  const resultText = resultFull ?? tool.result?.text ?? null;
  const call = useMemo(() => parseFileChangeCall(tool.toolName, inputText), [tool.toolName, inputText]);
  const receipt = useMemo(() => fileChangeReceipt(resultText), [resultText]);
  const binding = useReceiptBinding(call, receipt);
  const complete = call !== null && fileChangeComplete(call);
  // Only a whole input is diffed: a clipped one is never shown as the change.
  const diff = useMemo(() => (call !== null && complete ? fileChangeDiff(call) : null), [call, complete]);
  if (call === null) return null;
  const state = fileChangeState(tool.status, receipt);
  const path = call.path === null ? null : displayWorkspaceText(call.path);
  const loadable = input?.truncated === true && input.id !== undefined && full === undefined;
  const failure = state === "not_applied"
    ? receipt?.message ?? receipt?.error ?? null
    : null;
  const replacements = call.kind === "edit" && state === "applied" && receipt?.replacements !== null && receipt?.replacements !== undefined && receipt.replacements > 1
    ? `${receipt.replacements.toLocaleString()} replacements`
    : null;
  return (
    <section className="activity-file-change" data-state={state} data-receipt={binding}>
      <header>
        <span className="activity-file-change-path" title={call.path ?? undefined}>{path ?? (call.kind === "edit" ? "Edit" : "Write")}</span>
        {diff !== null && call.kind === "edit" ? (
          <span className="activity-file-change-stat" aria-label={`${diff.addedLines} added, ${diff.removedLines} removed lines`}>
            <ins>+{diff.addedLines}</ins> <del>−{diff.removedLines}</del>
          </span>
        ) : diff !== null ? (
          // A write's previous contents are unknown: its lines are counted as written, never as a net change.
          <span className="activity-file-change-stat" aria-label={`${diff.addedLines} lines written; previous contents not recorded`}>
            {diff.addedLines.toLocaleString()} lines written
          </span>
        ) : null}
        <span className={`activity-badge activity-file-change-state${state === "not_applied" ? " activity-badge--failed" : state === "pending" ? " activity-badge--running" : ""}`}>
          {FILE_CHANGE_STATE_LABELS[state]}
        </span>
        {replacements ? <span className="activity-file-change-meta">{replacements}</span> : null}
      </header>
      {failure ? <p className="activity-error-text">{failure}</p> : null}
      {binding === "differs" ? (
        <p className="activity-error-text" role="note">This text does not match what the call recorded.</p>
      ) : null}
      {diff !== null ? (
        <LineDiffView diff={diff} label={`${call.kind === "edit" ? "Edit" : "Write"} of ${path ?? "a file"}`} />
      ) : loadable ? (
        <button type="button" className="activity-link-button" onClick={() => payloads.load(input.id!)} disabled={payloads.loading.has(input.id!)}>
          {payloads.loading.has(input.id!) ? "Loading…" : "Show the change"}
        </button>
      ) : (
        <p className="activity-muted">Only part of this change was recorded here.</p>
      )}
      {call.kind === "write" && diff !== null ? <p className="activity-muted">Previous contents are not part of a write.</p> : null}
    </section>
  );
}
