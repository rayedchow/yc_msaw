// Deterministic checks of the event-log adapter's lifecycle and dedup rules.
// Run: npx tsx demo-ui/tests/adapter-lifecycle.test.ts
import assert from "node:assert/strict";
import { adaptRun, type DemoEvent, type DemoState } from "../src/adapter.js";

let seq = 0;
const t = (s: number) => new Date(Date.parse("2026-10-17T23:30:00Z") + s * 1000).toISOString();
function ev(s: number, agentId: string, kind: string, title: string, extra: Partial<DemoEvent> = {}): DemoEvent {
  seq += 100;
  return { id: `e${seq}`, seq, at: t(s), agentId, parentId: null, kind, title, ...extra };
}
const phase = (s: number, title: string, key?: string) => ev(s, "host", "phase", title, { status: "running", ...(key ? { data: { phase: key } } : {}) });
const state = (status: string, agents: Array<[string, string, string | null]>): DemoState => ({
  runId: "r1", status, agents: agents.map(([id, st, parentId]) => ({ id, status: st, parentId, name: id })),
});
const statusOf = (run: ReturnType<typeof adaptRun>, id: string) => run.agents.find((agent) => agent.id === id)?.status;
const labelOf = (run: ReturnType<typeof adaptRun>, id: string) => run.agents.find((agent) => agent.id === id)?.statusLabel;
const alive = { producer: { pid: 1234, alive: true } };

// Customer turn, then the build: the customer idles while the build runs.
const customerTurn = [
  phase(0, "Customer attempt 1 with the seeded integration"),
  ev(1, "customer", "message", "user prompt", { text: "Read README.md" }),
  ev(2, "customer", "tool_call", "integration__github-read__read_file", { data: { callId: "c1", args: { path: "README.md" } } }),
];
{
  const run = adaptRun(customerTurn, state("running", [["customer", "running", null]]), alive);
  assert.equal(statusOf(run, "customer"), "running", "open call inside a customer phase is a running turn");
}
const customerDone = [...customerTurn,
  ev(3, "customer", "tool_result", "read_file (error)", { status: "failed", text: "404 Not Found", data: { callId: "c1" } }),
  ev(4, "customer", "message", "assistant", { text: "The file could not be read." }),
];
{
  const run = adaptRun(customerDone, state("running", [["customer", "running", null]]), alive);
  assert.equal(statusOf(run, "customer"), "waiting", "answered turn is idle even while state says running");
  assert.equal(run.agents.find((agent) => agent.id === "customer")?.objective, "Read README.md");
}
const build = [...customerDone,
  phase(10, "Operator-triggered daily cycle NOW"),
  ev(11, "builder", "message", "daily build started"),
  ev(12, "root", "agent_start", "agent_started", { data: { profile: "kimi-k3", source: "build logger (live)" } }),
  ev(12, "root", "message", "task given to the agent", { text: "Fix the github-read integration.", data: { source: "build agent model input (live)" } }),
  ev(13, "root", "message", "assistant", { text: "I will read the source.", data: { source: "build agent model output (live)" } }),
  ev(13, "root", "tool_call", "integration_read", { data: { callId: "m1", args: { path: "src/index.ts" }, source: "build agent model output (live)" } }),
  ev(14, "root", "tool_call", "integration_read", { data: { callId: "int-1", args: { path: "src/index.ts" }, source: "integration provider (live)" } }),
  ev(14, "root", "tool_result", "integration_read: ok", { status: "succeeded", data: { callId: "int-1", result: { ok: true } } }),
  ev(15, "root", "tool_result", "integration_read ok", { status: "succeeded", data: { tool: "integration_read", ok: true, source: "build logger (live)" } }),
  ev(16, "root", "tool_result", "tool result (as seen by the model)", { text: "export const ref = 'master';", data: { callId: "m1", source: "build agent model input (live)" } }),
];
{
  const run = adaptRun(build, state("running", [["customer", "running", null], ["builder", "running", null], ["root", "running", null]]), alive);
  assert.deepEqual(run.agents.map((agent) => agent.id).sort(), ["customer", "root"], "operators are not agents");
  assert.equal(statusOf(run, "customer"), "waiting", "customer idles during the build phase");
  assert.equal(statusOf(run, "root"), "running");
  const thread = run.threads.get("root")!;
  const rows = thread.parts.flatMap((part) => (part.type === "events" ? part.events : []));
  assert.equal(rows.filter((row) => row.kind === "tool_start").length, 1, "provider duplicate is not a second call");
  assert.equal(rows.filter((row) => row.kind === "tool_result").length, 1, "logger/provider results are not second results");
  assert.equal(rows.find((row) => row.kind === "tool_result")?.status, "succeeded", "logger outcome gives the model-seen result its status");
  assert.equal(thread.receipts.get("m1")?.length, 3, "provider call, provider result and logger receipt sit under the call");
  assert.equal(rows.find((row) => row.kind === "assistant_text")?.text, "I will read the source.");
}
{
  // Long silence alone does not stop a thinking agent.
  const run = adaptRun(build, state("running", [["root", "running", null]]), alive);
  assert.equal(statusOf(run, "root"), "running");
}
// The build cycle ends (builder's run_end); the customer's retry continues.
const retry = [...build,
  ev(40, "root", "agent_end", "[retained receipt] root failed", { status: "failed", data: { summary: "Could not publish", source: "agent receipt (retained after run)" } }),
  ev(41, "builder", "run_end", "daily build failed", { status: "failed" }),
  phase(42, "Customer retry with the repaired integration"),
  ev(43, "customer", "message", "user prompt", { text: "Try again." }),
];
{
  const run = adaptRun(retry, state("running", [["customer", "running", null], ["root", "running", null]]), alive);
  assert.equal(run.mode, "live", "the builder's run_end does not end the run");
  assert.equal(statusOf(run, "root"), "failed", "a terminal receipt outranks a stale running state");
  assert.equal(run.agents.find((agent) => agent.id === "root")?.failure, "Could not publish");
  assert.equal(statusOf(run, "customer"), "running", "the retry prompt starts a new customer turn");
  const prompts = run.threads.get("customer")!.parts.filter((part) => part.type === "prompt");
  assert.equal(prompts.length, 1, "a later prompt is its own row; the first is the task");
}
{
  // Build ended without a receipt for a child: that child stops; nothing claims success.
  const child = [...build,
    ev(20, "root.1", "agent_start", "agent_started", { parentId: "root" }),
    ev(21, "root.1", "message", "task given to the agent", { text: "Check the tag." }),
    ev(30, "builder", "run_end", "daily build published", { status: "succeeded" }),
  ];
  const run = adaptRun(child, state("running", [["root.1", "running", "root"]]), alive);
  assert.equal(statusOf(run, "root.1"), "stopped");
  assert.equal(run.agents.find((agent) => agent.id === "root.1")?.depth, 1);
}
{
  // The operator's run_end ends everyone; recorded outcomes stay.
  const done = [...retry, ev(50, "customer", "message", "assistant", { text: "Done." }), ev(51, "host", "run_end", "ALL CHECKS PASSED", { status: "succeeded" })];
  const run = adaptRun(done, state("running", [["customer", "running", null], ["root", "running", null]]), alive);
  assert.equal(run.mode, "ended");
  assert.equal(statusOf(run, "customer"), "stopped");
  assert.equal(statusOf(run, "root"), "failed");
  assert.equal(run.endedBy?.title, "ALL CHECKS PASSED");
}
{
  // Aborted: state terminal without a run_end line.
  const run = adaptRun(build, { ...state("failed", [["root", "running", null]]) }, alive);
  assert.equal(run.mode, "ended");
  assert.equal(statusOf(run, "root"), "stopped");
}
{
  // Producer gone without a terminal record: orphaned, nothing live.
  const run = adaptRun(build, state("running", [["root", "running", null]]), { producer: { pid: 1234, alive: false } });
  assert.equal(run.mode, "orphaned");
  assert.equal(run.active, false);
  assert.equal(statusOf(run, "root"), "stopped");
}
{
  const run = adaptRun(build, state("running", [["root", "running", null]]), { ...alive, disconnected: true });
  assert.equal(run.mode, "disconnected");
  assert.equal(run.active, false);
}
{
  // An agent that ends and then works again is not terminal.
  const again = [...build, ev(30, "root", "agent_end", "done", { status: "succeeded" }), ev(31, "root", "message", "assistant", { text: "One more thing." })];
  const run = adaptRun(again, state("running", []), alive);
  assert.equal(statusOf(run, "root"), "running");
}
{
  const run = adaptRun([], null, {});
  assert.equal(run.mode, "waiting");
  assert.equal(run.agents.length, 0);
}

// Regression (live run e2e-20261017T232926-fe8d): the retry phase's title names no customer,
// attempt or retry; the customer's real activity after it decides.
{
  const live = [...retry.slice(0, -2),
    phase(42, "Same Pi session: reopen memory, use the repaired tool against real GitHub", "attempt-2"),
    ev(43, "customer", "message", "user prompt", { text: "Retry the task." }),
    ev(44, "customer", "tool_call", "integration__github-read__read_file", { data: { callId: "c9", args: { path: "README.md", ref: "v1.0.0" } } }),
  ];
  const run = adaptRun(live, state("running", [["customer", "running", null], ["root", "succeeded", null]]), alive);
  assert.equal(statusOf(run, "customer"), "running", "an open call in attempt-2 is a running turn whatever the phase title says");
  const answered = adaptRun([...live,
    ev(45, "customer", "tool_result", "integration__github-read__read_file", { status: "succeeded", text: "# README", data: { callId: "c9" } }),
  ], state("running", [["customer", "running", null]]), alive);
  assert.equal(statusOf(answered, "customer"), "running", "a result the model has not answered keeps the turn running");
  const between = adaptRun([...live.slice(0, -2)], state("running", [["customer", "running", null]]), alive);
  assert.equal(statusOf(between, "customer"), "waiting", "the attempt-2 phase began, no prompt yet: idle");
}
// Contract events (new producer): turn and task boundaries, roles, labels.
{
  const contract: DemoEvent[] = [
    phase(0, "Customer attempt 1", "attempt-1"),
    ev(1, "customer", "task_start", "task attempt 1 started", { status: "running", data: { attempt: 1, prompt: "Read README.md at v1.0.0" } }),
    ev(1, "customer", "turn_start", "Pi agent run started", { status: "running" }),
    ev(2, "customer", "message", "user prompt", { text: "Read README.md at v1.0.0" }),
    ev(3, "customer", "message", "assistant", { text: "It failed with 404." }),
  ];
  const states = { runId: "r2", status: "running", agents: [
    { id: "host", role: "operator", status: "running", name: "Host" },
    { id: "wrapper", role: "operator", status: "running", name: "Daily build service" },
    { id: "customer", role: "customer", status: "waiting", name: "Customer agent (Pi session x)" },
  ] } satisfies DemoState;
  const during = adaptRun(contract, states, alive);
  assert.equal(statusOf(during, "customer"), "running", "a newer turn_start outranks the state row's stale waiting");
  assert.deepEqual(during.agents.map((agent) => agent.id), ["customer"], "role operator rows are not agents");
  const thread = during.threads.get("customer")!;
  assert.equal(during.agents[0]?.objective, "Read README.md at v1.0.0", "task_start's prompt is the task");
  assert.equal(thread.parts.filter((part) => part.type === "prompt").length, 0, "the matching user message is not repeated");
  const after = adaptRun([...contract,
    ev(4, "customer", "turn_end", "Pi agent run ended (session idle)", { status: "waiting" }),
    ev(5, "customer", "task_end", "task attempt 1 failed", { status: "failed", data: { attempt: 1 } }),
  ], states, alive);
  assert.equal(statusOf(after, "customer"), "waiting", "turn_end: idle, not ended, even after a failed task");
  const notice = after.threads.get("customer")!.parts.find((part) => part.type === "notice");
  assert.ok(notice && notice.type === "notice" && notice.failed && notice.text === "task attempt 1 failed", "task outcome is shown as recorded");
  const final = adaptRun([...contract, ev(6, "host", "run_end", "CHECKS FAILED", { status: "failed" })],
    { ...states, status: "failed", agents: [...states.agents.slice(0, 2), { id: "customer", role: "customer", status: "interrupted", name: "c" }] }, alive);
  assert.equal(statusOf(final, "customer"), "cancelled");
  assert.equal(labelOf(final, "customer"), "interrupted", "interrupted stays interrupted, never failed or succeeded");
}
{
  const receipts = [...build,
    ev(30, "root", "agent_end", "[retained receipt] root partial", { status: "partial", data: { harnessStatus: "budget_exhausted" } }),
  ];
  const run = adaptRun(receipts, state("running", [["root", "running", null]]), alive);
  assert.equal(labelOf(run, "root"), "partial");
  assert.equal(statusOf(run, "root"), "stopped", "partial is not done");
  const unknownEnd = adaptRun([...build, ev(30, "root", "agent_end", "[retained receipt] root ?", { data: { harnessStatus: "weird" } })], state("running", []), alive);
  assert.equal(labelOf(unknownEnd, "root"), "unknown", "an unmapped receipt is unknown, never success");
  const globalEnd = adaptRun([...build, ev(30, "host", "run_end", "ABORTED: crash", { status: "failed" })], state("running", [["root", "running", null]]), alive);
  assert.equal(labelOf(globalEnd, "root"), "unknown", "a run end without a receipt claims no outcome");
}
// Regression (live attempt-2, call_65de0e5681684206ba9b7a3d): the producer cut a 41k result's whole
// data to { truncated, originalChars, preview }; callId survives only at the start of the preview.
{
  const big = "# mcp-use\n" + "x".repeat(8000);
  const callArgs = { owner: "mcp-use", repo: "mcp-use", path: "README.md", ref: "v1.5.0" };
  const clippedData = (preview: string) => ({ truncated: true, originalChars: 41445, preview });
  const base = [
    phase(0, "Same Pi session: reopen memory, use the repaired tool against real GitHub", "attempt-2"),
    ev(1, "customer", "message", "user prompt", { text: "Retry." }),
    ev(2, "customer", "tool_call", "integration__github-read__read_file", { status: "running", data: { callId: "call_65de0e5681684206ba9b7a3d", args: callArgs } }),
  ];
  const real = [...base, ev(3, "customer", "tool_result", "integration__github-read__read_file", { status: "succeeded", text: big,
    data: clippedData(`{"callId":"call_65de0e5681684206ba9b7a3d","details":{"source":"integration:github-read","upstreamN`) })];
  const run = adaptRun(real, state("running", [["customer", "running", null]]), alive);
  const thread = run.threads.get("customer")!;
  const rows = thread.parts.flatMap((part) => (part.type === "events" ? part.events : []));
  assert.equal(rows.filter((row) => row.kind === "tool_start").length, 1);
  const result = rows.find((row) => row.kind === "tool_result");
  assert.equal(result?.callId, "call_65de0e5681684206ba9b7a3d", "the preview's recorded call id pairs the result");
  assert.equal(result?.length, big.length, "the recorded result text is kept whole (shown via Show all)");
  assert.equal(thread.full.get(result!.id), big);
  assert.match(thread.receipts.get("call_65de0e5681684206ba9b7a3d")?.[0]?.label ?? "", /cut by the demo from 41,445 characters\)$/u);
  assert.equal(thread.parts.some((part) => part.type === "notice"), false);
  assert.equal(statusOf(run, "customer"), "running", "an answered call is no longer open (the model has not replied yet)");
  const replied = adaptRun([...real, ev(4, "customer", "message", "assistant", { text: "Found it." })], state("running", [["customer", "running", null]]), alive);
  assert.equal(statusOf(replied, "customer"), "waiting", "the clipped result closes its call");

  // Preview without an id, one open call of that tool: paired, and the receipt says how.
  const noId = [...base, ev(3, "customer", "tool_result", "integration__github-read__read_file", { status: "succeeded", text: big, data: clippedData(`{"details":{"source":"integration`) })];
  const single = adaptRun(noId, state("running", []), alive).threads.get("customer")!;
  const singleRows = single.parts.flatMap((part) => (part.type === "events" ? part.events : []));
  assert.equal(singleRows.find((row) => row.kind === "tool_result")?.callId, "call_65de0e5681684206ba9b7a3d");
  assert.match(single.receipts.get("call_65de0e5681684206ba9b7a3d")?.[0]?.label ?? "", /only open call of this tool/u);

  // Two concurrent calls of the same tool, a clipped result without an id: no guess.
  const concurrent = [...base,
    ev(2, "customer", "tool_call", "integration__github-read__read_file", { status: "running", data: { callId: "call_other", args: { ...callArgs, path: "docs/a.md" } } }),
    ev(3, "customer", "tool_result", "integration__github-read__read_file", { status: "succeeded", text: big, data: clippedData(`{"details":{}}`) }),
  ];
  const ambiguous = adaptRun(concurrent, state("running", []), alive).threads.get("customer")!;
  const ambiguousRows = ambiguous.parts.flatMap((part) => (part.type === "events" ? part.events : []));
  assert.equal(ambiguousRows.find((row) => row.kind === "tool_result")?.callId, null, "not paired with either open call");
  assert.equal(ambiguousRows.filter((row) => row.kind === "tool_start").length, 2);
  const notice = ambiguous.parts.find((part) => part.type === "notice");
  assert.ok(notice && notice.type === "notice" && /several calls of this tool were open/u.test(notice.text), "the unpaired result says why");
  assert.equal(ambiguous.receipts.size, 0, "no receipt is attached to a guessed call");
}
console.log("adapter lifecycle checks passed");
