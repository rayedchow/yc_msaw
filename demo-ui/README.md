# Demo trace viewer

A read-only live view of the real end-to-end demo: what the customer agent,
the builder and its subagents, and the host checks are doing, as they do it.

```sh
npx tsx scripts/serve-demo-trace.ts                 # http://127.0.0.1:4318/
npx tsx scripts/serve-demo-trace.ts --port 4320     # if 4318 is taken (or TRACE_UI_PORT=4320)
npx tsx scripts/serve-demo-trace.ts --data-dir /tmp/some-fixture   # fixture data, flagged in the UI
```

No build step, no new dependencies: `index.html`, `app.js` (a vanilla ES
module) and `trace.css` are served as they are.

## What it reads

Only these files, by fixed path. The server takes no path parameters.

| File | Written by | Read as |
| --- | --- | --- |
| `.context/real-demo-events.jsonl` | the demo orchestrator, append-only | complete lines only, incrementally by byte offset; a partly written last line waits for its newline |
| `.context/real-demo-state.json` | the demo orchestrator, atomically replaced | whole file, resent only when its hash changes |
| `reports/real-integration-e2e.json` | the demo orchestrator, optional | shown under "Report" once the run has ended, if present |

With `--data-dir <dir>` the first two (and `real-integration-e2e.json`) are
read from `<dir>` instead, and the page shows a "Fixture data" banner.

Event lines follow the shared contract
`{id, at, agentId, parentId?, kind, title, status?, text?, data?}`. Known kinds
are `phase`, `message`, `tool_call`, `tool_result`, `agent_start`,
`agent_end`, `files`, `memory_diff`, `source_diff`, `sdk_update`, `check`,
`run_end`; any other kind is shown as a plain row labeled with its kind, and a
line that is not JSON is shown as "Unreadable line". Calls and results pair by
`data.callId` within one agent (or, without ids, an adjacent call and result
for the same tool).

A new run is detected when `runId` changes, the event file disappears or
shrinks, or its first line changes; the view then starts over.

## API (GET/HEAD only, 127.0.0.1 only)

- `GET /api/poll?offset=&key=&state=` – events after `offset`, state (unless unchanged).
- `GET /api/report` – the fixed report, or 404.
- `GET /api/snapshot` – everything above as one downloadable JSON file ("Export snapshot").
- `GET /healthz`.

Anything else is 404; other methods are 405; a Host header other than
`127.0.0.1:<port>` or `localhost:<port>` is refused (DNS rebinding). Responses
carry a strict CSP (`script-src 'self'`, no inline script or style) and
`no-store`. As defense in depth the server replaces values that look like
credentials (keys named like `token`/`apiKey`/`authorization`, and values
shaped like provider keys, JWTs or bearer tokens) with `[redacted]` and the
page shows how many it replaced. The client builds every node with
`textContent`; nothing from the API reaches `innerHTML`.

## Using it

- **Main view** (left): the whole run in recorded order, with an author line
  whenever the agent changes, or one agent's thread (View menu, or "Open in
  main view"). Tool calls open to their exact input and result; a running call
  shows a live elapsed clock.
- **Phases / Checks** strip: phase progression from `phase` events (click one
  to jump to it) and `state.checks` as recorded.
- **Files / Diff / Agents** (right): changed memory and source files, read-only,
  as contents or a line diff; the run-wide diff; the agent tree (parents and
  nested subagents) – click an agent to read its thread in the panel.
- **Live vs recorded**: "Live" while `state.status` is `running`/`waiting`;
  "Recorded run" once it has ended. A recorded run can be stepped through
  event by event (Replay); this reveals the retained events in order at a fixed
  pace and always shows their recorded times.
- **Following**: new rows scroll into view while you are at the bottom;
  scrolling up (or pressing `f`) stops it, and "Jump to latest" shows how many
  rows arrived.
- Keys: `/` search, `f` follow, `1` `2` `3` panel tabs, `Esc` back / clear.
- The URL hash keeps the view: `#view=<agentId>&tab=files&file=<path>&agent=<agentId>`.

## Attribution

The layout, class names, CSS and component structure are ported from AEye
(`askshepherd/aeye-shepherd`, branch `main` at
`a49aae10e219a7b3aa36102099b649340c2d42b0`), adapted from React/Next to a
dependency-free page over this demo's event contract:

| AEye source | Used for |
| --- | --- |
| `web/components/build-trace-workbench.tsx` | split workbench (`.build-ide.trace-ide`), resizable separator (pointer + keyboard, persisted), thread header/meta/toolbar, "Jump to latest", Files / Subagents panel tabs, agent list with `--trace-level` indentation, "All agents" / "Open in main view" panel thread |
| `web/components/build-trace-view.tsx`, `web/app/.../builds/[buildId]/trace/page.tsx` | page frame (`.build-trace-page`) |
| `web/components/build-trace.css` | thread, panel, pills, dots, agent list, skeleton styles (nearly verbatim) |
| `web/components/agent-activity/agent-activity.css` | activity rows, toggles, payload blocks, cards, agent chips, task row, dividers, collapse, file-change diff rows (nearly verbatim) |
| `web/components/agent-activity/activity-rows.tsx` | tool line anatomy: icon or spinner, label, trailing badges + duration/time + chevron; Input / Output / Result payloads |
| `web/components/agent-activity/trace-activity.ts` | merging call / result events into one tool row by call id; providers reusing an id start a new call |
| `web/components/knowledge-changes-panel.tsx` | run-wide read-only change list (Diff tab) |
| `web/components/workspace/live-agent-files.css` | files bar and segmented Contents / Diff toggle |
| `web/app/globals.css` | color, type and radius tokens; `.build-ide` grid, separator and file tree rules |

Icons are path data from [Lucide](https://lucide.dev) (ISC license), the icon
set AEye uses. The fonts fall back to the system UI and monospace faces
(AEye loads Geist).
