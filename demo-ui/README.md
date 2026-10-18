# Demo trace viewer

A read-only view of the real end-to-end demo that shows each agent's own
conversation the way AEye's build trace does. The left side is the agent's
thread: its task, its Markdown messages, and its tool calls with the exact
arguments and results. The right side has Files, Subagents and Run tabs. The
page has no header, phase strip, check list, replay controls or search: it is
the AEye trace workbench and nothing else.

```sh
npm --prefix demo-ui ci            # once: React, markdown-it, lucide-react, esbuild (isolated from the root package)
npm --prefix demo-ui run build     # writes demo-ui/dist/app.js and dist/trace.css
npx tsx scripts/serve-demo-trace.ts                 # http://127.0.0.1:4318/
npx tsx scripts/serve-demo-trace.ts --port 4320     # if 4318 is taken (or TRACE_UI_PORT=4320)
npx tsx scripts/serve-demo-trace.ts --data-dir /tmp/some-fixture   # fixture data instead of .context
```

`dist/` is git-ignored by the root `.gitignore`, so build it before serving.
The server reads assets from disk on every request: after a rebuild, reloading
the page is enough.

Checks:

```sh
npm --prefix demo-ui run typecheck
npx tsx demo-ui/tests/adapter-lifecycle.test.ts     # lifecycle, dedup and contract checks of the adapter
npx tsx demo-ui/tests/file-tree.test.ts             # Files tree from recorded paths, ancestor expansion, safe Markdown
```

## What is ported, and what is adapted

The AEye source comes from `askshepherd/aeye-shepherd`, branch `main` at
`a49aae10e219a7b3aa36102099b649340c2d42b0`. It is vendored under
`src/aeye/`, mirroring AEye's paths.

| File (under `src/aeye/`) | Status |
| --- | --- |
| `web/components/agent-activity/activity-rows.tsx`, `activity-model.ts`, `activity-format.ts`, `activity-file-change.tsx`, `edit-call.ts`, `resumption.ts`, `trace-activity.ts` | verbatim |
| `web/lib/duration-format.ts`, `src/build/workspace_display.ts`, `src/web/text_diff.ts` | verbatim |
| `web/components/agent-activity/agent-activity.css`, `web/components/build-trace.css`, `web/components/workspace/live-agent-files.css` | verbatim |
| `web/components/workspace/workspace-panel-modes.css` | the Whole / Diff switch rules of `workspace-panel.css` |
| `src/build/build_trace_threads.ts` | the database-free part: types, `describeToolCall`, `toolLabelForStatus` and helpers verbatim; `mapEvent` kept as `traceThreadEvent` without the benchmark grade lookup |
| `src/build/run_resumptions.ts` | the `RunResumption` type only |
| `src/web/markdown.ts` | the same markdown-it setup (HTML off, linkify, external link `rel`, tables), without KaTeX, citations or Knowledge links |
| `src/styles/aeye-globals.css` | whole rules copied from `web/app/globals.css`: tokens, type, prose, `.build-ide`, file tree |

The following are ports of `web/components/build-trace-workbench.tsx`:

- `src/workbench.tsx` keeps:
  - the `AgentThread` layout, including the header meta, the task row, `MessageRow`, the shared activity rows, subagent cards, the wait line, `Working…`, `Jump to latest`, scroll following and per-agent scroll memory;
  - the resizable split, the Files / Subagents panel with its "All agents" / "Open in main view" thread, and the default main agent rule.
- Adaptations:
  - Threads come from the in-memory event log instead of the paging API and EventSource.
  - "Attempt N of M" becomes a menu over the customer agent and the build root, which are separate roots.
  - Files shows the files the run recorded, not a sandbox snapshot.
  - A Run tab holds the operator's own records (seed, deploy, checks, phases), so these never enter an agent's conversation.
- The Files tab uses AEye's workspace file picker and preview:
  - `web/components/workspace/draft-tree.tsx` (`DraftTreeNodes`, verbatim): nested collapsible folders with carets and file-type icons, basename rows. Selecting a file opens its ancestors and closes nothing. Open folders are remembered per run, and the selection is kept in `?file=`, so it survives polls, tab switches and Whole/Diff.
  - `web/components/tree-row-name.tsx` (ported): the same one-line ellipsis row. A cut name shows its full path as a native title, replacing AEye's Radix tooltip.
  - `web/components/file-type-icon.ts` (verbatim).
  - Whole mode follows AEye's `DraftFileBody`:
    - A `.md` file renders through the same `renderMarkdown` in `.prose.build-preview-markdown`, with the file name as `h1` when the page has none (`leadingMarkdownTitle`). HTML is disabled, so recorded HTML stays text.
    - Other text uses `web/components/workspace/text-file-view.tsx` (`TextFileView`, verbatim).
    - Links in a Markdown file follow `src/file-links.ts`. A relative link (`./`, `../`, percent-encoding, `#anchor`, a folder's `index.md`) resolves against the file's own folder and opens the recorded file it names in the same viewer, through `?file=`; agent and panel stay. A target that was not recorded is marked and says so when clicked, and nothing is fetched or invented. Links with a scheme (`https:`, `mailto:`) stay ordinary links.
    - A Rendered / Source switch shows a Markdown file's exact text (AEye's preview has no raw view; this is local). Rendered is the default.
    - Deleted, empty, truncated and content-less files say so.
  - Diff mode keeps the same tree and shows only the selected file's change. It uses `LineDiffView` with old/new line numbers and colored added/deleted rows, plus a `+N −M` stat. Added, deleted and unchanged files say so.
- `src/styles/local.css`:
  - sets no app header;
  - keeps long names, model ids, paths and payloads inside their own column, using ellipsis with a title or the payload's own scroll.

## How the event log becomes AEye's trace (`src/adapter.ts`)

The server reads only these files, by fixed path, and never writes:

- `.context/real-demo-events.jsonl`: complete lines only, read incrementally by byte offset.
- `.context/real-demo-state.json`: resent only when its hash changes.
- `reports/real-integration-e2e.json`: the snapshot export only.

The adapter maps the log's records onto AEye's trace like this:

- **Agents** are the customer agent (state `role: "customer"`, or `customer`) and the build agents (`root`, `root.1`, …).
  - `host`, `builder` and any `role: "operator"` row are operators. Their events go to the Run tab.
- **Messages:**
  - An assistant message becomes `assistant_text`, which renders as Markdown.
  - The first user prompt (or `task_start.data.prompt`) is the agent's task.
  - A later prompt becomes an inline "Prompt given to this agent" row.
  - `task_end` and prompt errors become notice rows, worded as recorded.
- **Calls:**
  - The model's `tool_call` becomes `tool_start` with its exact arguments.
  - The `tool_result` with the same `callId` becomes its result, with the exact text or else the exact data.
  - The host's other records of the same call appear under that call as receipts, not as extra rows:
    - the integration provider call and its result;
    - the build logger's outcome, which also gives a result its status when the model-side result carries none;
    - Pi's result details.
  - A record that joins nothing is shown on its own.

Lifecycle follows `.context/demo-lifecycle-contract.md`. For each agent, the strongest evidence wins:

1. The agent's own terminal receipt (`agent_end`, using `status` or else `data.harnessStatus`).
2. A terminal status on its state row.
3. The end of the run (an operator `run_end` or a terminal state status), or for a build agent the build service's `run_end`, with no receipt of its own. This shows as **unknown**, never as success or failure. The builder's `run_end` does not end the customer agent or the run.
4. A run that is not live:
   - its producer process (`state.pid`) is gone with no end recorded;
   - or this page lost the server.

   Either shows as **unknown**.
5. Explicit `turn_start` (running) and `turn_end` (waiting, idle) boundaries. A newer start outranks a stale waiting row.
6. For older logs without boundaries, the customer agent:
   - is idle once an operator phase begins after its last turn activity;
   - otherwise is running while a call is open, a result is unanswered, or a prompt is fresh;
   - is idle after its final answer.

   Phase titles are never read.

Silence alone never stops an agent.

The labels partial, interrupted, pending and unknown are kept as recorded.
The thread's closing line says which one applies.

## Server

`scripts/serve-demo-trace.ts` binds 127.0.0.1 only and accepts GET/HEAD only.

- **Host header:** requests without `127.0.0.1:<port>` or `localhost:<port>` are refused.
- **Headers:** responses carry a strict CSP (`script-src 'self'; style-src 'self'`) and `no-store`.
- **Assets:** served from a fixed allowlist: `index.html`, `dist/app.js`, `dist/trace.css`, `favicon.svg`.
- **Redaction:** values shaped like credentials are replaced with `[redacted]`.
- **Producer liveness:** `/api/poll` reports whether `state.pid` is still running (signal 0), so the page can say "outcome unknown" instead of trusting a stale "running".

Other endpoints: `/api/report`, `/api/snapshot` and `/healthz`.
