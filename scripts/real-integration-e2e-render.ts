/**
 * Renders reports/real-integration-e2e.{md,html} from the JSON report written by
 * scripts/real-integration-e2e.ts. Everything shown is captured data (events, transcript, diffs);
 * nothing is synthesized. The input is already secret-scrubbed; the caller scrubs the output again.
 */
type Json = Record<string, unknown>;

const esc = (s: unknown) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Json)[k] : undefined), o);
const fence = (s: unknown) => `\`\`\`\n${String(s ?? "").replaceAll("```", "ʼʼʼ")}\n\`\`\``;

export function renderMarkdown(r: Json): string {
  const checks = (r.checks ?? {}) as Record<string, boolean>;
  const p = (r.phases ?? {}) as Json;
  const lines: string[] = [];
  lines.push(`# Real integration E2E: ${r.ok ? "PASSED" : "FAILED"}`, "", `Run \`${String(r.runId)}\`, finished ${String(r.finishedAt)}.`, "");
  lines.push("## What is real and what is seeded", "");
  for (const [k, v] of Object.entries((r.labels ?? {}) as Json)) lines.push(`- **${k}**: ${String(v)}`);
  lines.push("", "## Checks", "", "| check | result |", "| --- | --- |");
  for (const [k, v] of Object.entries(checks)) lines.push(`| ${k} | ${v ? "PASS" : "FAIL"} |`);
  const agentRows = (r.agents ?? []) as Json[];
  if (agentRows.length) {
    lines.push("", "## Agents (final lifecycle)", "", "| agent | role | parent | status | last task |", "| --- | --- | --- | --- | --- |");
    for (const a of agentRows) lines.push(`| ${String(a.name ?? a.id)} | ${String(a.role ?? "")} | ${String(a.parentId ?? "")} | ${String(a.status)} | ${a.task ? `attempt ${String(get(a, "task.attempt"))}: ${String(get(a, "task.status"))}` : ""} |`);
  }
  lines.push("", "## Key identifiers", "");
  const kv: Array<[string, unknown]> = [
    ["hosted parent", get(r, "config.parent")],
    ["tenant namespace", get(r, "config.ns")],
    ["customer model", get(r, "config.customerModel")],
    ["Pi session id", get(p, "sameSession.piSessionId") ?? get(p, "customerSession.piSessionId")],
    ["process pid", get(p, "customerSession.pid")],
    ["builder", JSON.stringify(r.builderConfig ?? null)],
    ["GitHub default branch", get(p, "githubTruth.defaultBranch")],
    ["GitHub ?ref=master", `${String(get(p, "githubTruth.masterStatus"))} ${String(get(p, "githubTruth.masterMessage"))} (request ${String(get(p, "githubTruth.masterRequestId"))})`],
    ["GitHub README@v1.5.0", `${String(get(p, "githubTruth.refStatus"))} sha ${String(get(p, "githubTruth.sha"))}, ${String(get(p, "githubTruth.size"))} bytes, text sha256 ${String(get(p, "githubTruth.textSha256"))}`],
    ["seeded commit", get(p, "seed.promoted.commit")],
    ["repaired commit", get(p, "diffs.source.afterCommit")],
    ["memory revision before -> after", `${String(get(p, "diffs.memory.before"))} -> ${String(get(p, "diffs.memory.after"))}`],
    ["Manufact server", get(p, "diffs.deployment.serverId") ?? get(p, "seed.manufact.serverId")],
    ["deployment before -> after", `${String(get(p, "diffs.deployment.before.deploymentId"))} -> ${String(get(p, "diffs.deployment.after.deploymentId"))}`],
    ["live child MCP URL", get(p, "diffs.deployment.mcpUrl") ?? get(p, "seed.manufact.mcpUrl")],
    ["daily build", `${String(get(p, "dailyBuild.status"))} in ${String(get(p, "dailyBuild.buildMs"))} ms`],
    ["SDK detection", get(p, "sdkUpdate.detectedBy")],
  ];
  for (const [k, v] of kv) lines.push(`- **${k}**: ${String(v ?? "n/a")}`);
  lines.push("", "## Attempt 1 (seeded integration)", "", `Answer:`, "", fence(get(p, "attempt1.answer")), "");
  lines.push("## Attempt 2 (same session, repaired integration)", "", "Answer:", "", fence(get(p, "attempt2.answer")), "");
  lines.push("## read_file schema seen by the SDK", "", "Before:", fence(JSON.stringify(get(p, "sdkUpdate.initialSchema"), null, 2)), "After:", fence(JSON.stringify(get(p, "sdkUpdate.newSchema"), null, 2)), "");
  lines.push("## Integration source diff (model-authored repair)", "", fence(get(p, "diffs.source.diff")), "");
  lines.push("## Memory diff (model-authored wiki update)", "", fence(get(p, "diffs.memory.diff")), "");
  lines.push("## Customer transcript (captured Pi events)", "");
  for (const t of (r.transcript ?? []) as Json[]) {
    const head = `**${String(t.at)}** ${String(t.type)}${t.name ? ` \`${String(t.name)}\`` : ""}${t.isError ? " (error)" : ""}`;
    const body = t.type === "tool_call" ? JSON.stringify(t.args) : t.type === "assistant" ? `${String(t.text ?? "")}${(t.toolCalls as unknown[] | undefined)?.length ? `\n[tool calls: ${JSON.stringify(t.toolCalls)}]` : ""}` : String(t.text ?? "");
    lines.push(head, "", fence(body.slice(0, 4000)), "");
  }
  if (r.error) lines.push("## Error", "", fence(r.error));
  return `${lines.join("\n")}\n`;
}

export function renderHtml(r: Json): string {
  const events = (r.events ?? []) as Json[];
  const checks = (r.checks ?? {}) as Record<string, boolean>;
  const p = (r.phases ?? {}) as Json;
  const agents = new Map<string, string | null>();
  for (const e of events) if (!agents.has(String(e.agentId))) agents.set(String(e.agentId), (e.parentId as string | null) ?? null);
  const color = (s: unknown) => (s === "succeeded" ? "#1a7f37" : s === "failed" ? "#cf222e" : s === "running" ? "#9a6700" : "#57606a");
  const rows = events
    .map((e) => {
      const detail = [e.text ? `<pre>${esc(e.text)}</pre>` : "", e.data !== undefined ? `<details><summary>data</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details>` : ""].join("");
      return `<div class="ev" data-agent="${esc(e.agentId)}"><div class="meta"><span class="t">${esc(String(e.at).slice(11, 23))}</span> <span class="a">${esc(e.agentId)}${e.parentId ? ` ← ${esc(e.parentId)}` : ""}</span> <span class="k">${esc(e.kind)}</span>${e.status ? ` <span class="s" style="color:${color(e.status)}">${esc(e.status)}</span>` : ""}</div><div class="title">${esc(e.title)}</div>${detail}</div>`;
    })
    .join("\n");
  const agentButtons = [...agents.keys()].map((a) => `<button onclick="f('${esc(a)}')">${esc(a)}</button>`).join(" ");
  const checkRows = Object.entries(checks).map(([k, v]) => `<tr><td>${esc(k)}</td><td style="color:${v ? "#1a7f37" : "#cf222e"}">${v ? "PASS" : "FAIL"}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Real integration E2E replay ${esc(r.runId)}</title>
<style>body{font:13px/1.45 -apple-system,Segoe UI,sans-serif;margin:0;background:#f6f8fa;color:#1f2328}header{padding:16px 24px;background:#fff;border-bottom:1px solid #d0d7de}
main{display:grid;grid-template-columns:340px 1fr;gap:16px;padding:16px 24px}.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:12px;margin-bottom:12px}
.ev{background:#fff;border:1px solid #d0d7de;border-radius:6px;padding:8px 10px;margin-bottom:6px}.meta{color:#57606a;font-size:12px}.a{font-weight:600}.k{background:#eaeef2;border-radius:4px;padding:0 4px}
.title{margin-top:2px}pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border-radius:4px;padding:6px;max-height:340px;overflow:auto;font-size:12px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #eaeef2;padding:3px 4px}
button{margin:2px;border:1px solid #d0d7de;background:#fff;border-radius:4px;cursor:pointer}</style></head><body>
<header><h2 style="margin:0">Real integration E2E replay — ${r.ok ? "PASSED" : "FAILED"}</h2><div>Run ${esc(r.runId)} · captured events only (no simulation) · live child MCP: ${esc(get(p, "diffs.deployment.mcpUrl") ?? get(p, "seed.manufact.mcpUrl"))}</div></header>
<main><aside><div class="card"><b>Labels</b><ul>${Object.entries((r.labels ?? {}) as Json).map(([k, v]) => `<li><b>${esc(k)}</b>: ${esc(v)}</li>`).join("")}</ul></div>
<div class="card"><b>Checks</b><table>${checkRows}</table></div>
<div class="card"><b>Agents</b><table>${((r.agents ?? []) as Json[]).map((a) => `<tr><td>${esc(a.name ?? a.id)}<br><small>${esc(a.role)}${a.parentId ? ` ← ${esc(a.parentId)}` : ""}</small></td><td style="color:${color(a.status)}">${esc(a.status)}${a.task ? `<br><small>task ${esc(get(a, "task.attempt"))}: ${esc(get(a, "task.status"))}</small>` : ""}</td></tr>`).join("")}</table></div>
<div class="card"><b>Filter by agent</b><div><button onclick="f('')">all</button> ${agentButtons}</div></div>
<div class="card"><b>Source diff</b><pre>${esc(get(p, "diffs.source.diff"))}</pre></div>
<div class="card"><b>Memory diff</b><pre>${esc(get(p, "diffs.memory.diff"))}</pre></div></aside>
<section>${rows}</section></main>
<script>function f(a){for(const el of document.querySelectorAll('.ev'))el.style.display=!a||el.dataset.agent===a?'':'none'}</script></body></html>\n`;
}

// ------------------------------------------------------------------ pure lifecycle helpers (shared with the producer)

/** Demo status union (see .context/demo-lifecycle-contract.md). */
export type DemoStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "partial" | "interrupted" | "unknown";
export const TERMINAL_STATUSES: ReadonlySet<DemoStatus> = new Set(["succeeded", "failed", "partial", "interrupted", "unknown"]);

/** Harness AgentStatus -> demo status. Used for BOTH state rows and emitted events. Never invents success. */
export function harnessStatusToDemo(s: unknown): DemoStatus {
  switch (s) {
    case "completed":
      return "succeeded";
    case "running":
      return "running";
    case "budget_exhausted":
      return "partial";
    case "failed":
      return "failed";
    case "cancelled":
    case "aborted":
      return "interrupted";
    default:
      return "unknown";
  }
}

export interface DemoAgentRow {
  id: string;
  parentId?: string | null;
  name: string;
  model?: string;
  role: "operator" | "customer" | "build";
  status: DemoStatus;
  task?: { attempt: number; status: DemoStatus; startedAt: string; finishedAt?: string };
}

/**
 * Terminal cleanup (mutates rows): nothing is left running/waiting/pending; terminal statuses are kept.
 * Normal finish: the customer closes with its LAST task outcome, other active rows become "unknown".
 * Abort: active rows become "interrupted", pending/waiting non-customer rows "unknown".
 */
export function finalizeAgentRows(rows: DemoAgentRow[], aborted: boolean, runOk: boolean, now = () => new Date().toISOString()): DemoAgentRow[] {
  for (const a of rows) {
    if (TERMINAL_STATUSES.has(a.status)) continue;
    if (a.id === "host") a.status = !aborted && runOk ? "succeeded" : "failed";
    else if (a.role === "customer") {
      if (a.task && a.task.status === "running") a.task = { ...a.task, status: "interrupted", finishedAt: now() };
      if (aborted && (a.status === "running" || a.task?.status === "interrupted")) a.status = "interrupted";
      else a.status = a.task && TERMINAL_STATUSES.has(a.task.status) ? a.task.status : "unknown";
    } else a.status = aborted && a.status === "running" ? "interrupted" : "unknown";
  }
  return rows;
}
