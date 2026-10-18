// @ts-nocheck
// Template for a walter-compiled MCP (copied to index.ts; __META__ is replaced at compile time).
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { RULES } from "./src/rules.ts";
import { SystemClient, quarterOf, quarterRange, rootDomain } from "./src/system.ts";
import { fetchData, makeCtx } from "./src/domain.ts";

const META = __META__;
const sys = new SystemClient(process.env.GURTAI_URL ?? "", process.env.GURTAI_TOKEN ?? "");
const ADMIN = process.env.WALTER_TOKEN ?? "";

// Live data, cached briefly. Rules see the same ctx they were backtested with.
let cache = null;
async function load() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const data = await fetchData(sys);
  cache = { at: Date.now(), ...data, ctx: makeCtx(data) };
  return cache;
}

const usage = [];
const feedback = [];
const rulesOf = (kind) => RULES.filter((r) => r.kind === kind);
// Case rules of one kind as one decision: the first rule that returns a value decides (fallbacks come last in RULES).
const cases = (kind) => {
  const rs = rulesOf(kind);
  if (rs.length <= 1) return rs[0] ?? null;
  const min = (k) => Math.min(...rs.map((r) => r.agreement[k] ?? 100));
  return { id: rs.map((r) => r.id).join("+"), kind, title: rs.map((r) => r.title).join("; "), agreement: { learned: min("learned"), heldOut: min("heldOut") },
    change: rs.find((r) => r.change && r.status !== "confirmed")?.change ?? null, status: rs.every((r) => r.status === "confirmed") ? "confirmed" : "changed",
    fn: (...a) => { for (const r of rs) { const v = r.fn(...a); if (v !== null && v !== undefined) return v; } return null; } };
};
const brief = (r) => ({ id: r.id, rule: r.title, learned: r.agreement.learned, heldOut: r.agreement.heldOut, ...(r.change ? { changed: r.change.month } : {}) });
const caveatsFor = (kinds) => [
  ...RULES.filter((r) => kinds.includes(r.kind) && r.change && r.status !== "confirmed").map((r) => `Rule ${r.id} ("${r.title}") stopped matching history in ${r.change.month}; a human has not confirmed the new behaviour yet.`),
  ...META.questions.filter((q) => RULES.some((r) => r.id === q.rule_id && kinds.includes(r.kind))).map((q) => `Open question on ${q.rule_id}: ${q.question}`),
];
// Tool descriptions name the company rules each tool applies, so agents see the context before calling.
const ctxDesc = (kinds) => {
  const rs = RULES.filter((r) => kinds.includes(r.kind));
  return rs.length ? ` GurtAI rules applied: ${rs.map((r) => `${r.id} ${r.title}`).join("; ")}. Details: walter://playbook.` : "";
};
// compact JSON: agents read every character of a result
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
function tracked(name, fn) {
  return async (args, ctx) => {
    let client = null;
    try { client = ctx?.client?.info?.()?.name ?? null; } catch {}
    const t0 = Date.now();
    try {
      const out = await fn(args ?? {});
      usage.push({ tool: name, client, args, at: new Date().toISOString(), ms: Date.now() - t0, ok: true });
      return out;
    } catch (e) {
      usage.push({ tool: name, client, args, at: new Date().toISOString(), ms: Date.now() - t0, ok: false, error: String(e?.message ?? e) });
      return { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true };
    }
  };
}

const server = new MCPServer({
  name: META.name, title: META.title, version: `1.${META.version}.0`,
  description: `${META.description} Compiled by walter from history.`,
  instructions: META.instructions,
});

// __DOMAIN_TOOLS__

server.tool({
  name: "company_rules",
  description: "The GurtAI rules this MCP applies with their evidence, the full playbook (observed policies, answers from people) and questions still open. Call this when you need to explain or double-check an answer.",
  inputSchema: z.object({}), annotations: { readOnlyHint: true },
}, tracked("company_rules", async () => ok({ version: META.version, rules: RULES.map((r) => ({ ...brief(r), kind: r.kind, evidence: r.evidence, status: r.status })), open_questions: META.questions, answered: META.answers, playbook: META.playbook })));

server.resource({ name: "playbook", uri: "walter://playbook", title: `${META.title} playbook`, description: "GurtAI's tribal knowledge for this system: verified rules with evidence, observed policies, answers from people, open questions.", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: META.playbook }] }));

server.tool({
  name: "report_outcome",
  description: "Tell walter whether a tool's answer was right. Wrong answers become new evidence for the next version of this MCP.",
  inputSchema: z.object({ tool: z.string(), correct: z.boolean(), note: z.string().optional(), expected: z.string().optional() }),
}, tracked("report_outcome", async (a) => { feedback.push({ ...a, at: new Date().toISOString() }); return ok({ recorded: true, total: feedback.length }); }));

// Manufact answers /health itself; walter checks which build is live here.
server.get("/walter/health", (c) => c.json({ ok: true, name: META.name, version: META.version, hash: META.hash, tools: META.tools }));
// walter pulls usage and feedback from here to improve the next version.
server.get("/walter/usage", (c) => (ADMIN && c.req.header("authorization") === `Bearer ${ADMIN}` ? c.json({ usage, feedback }) : c.json({ error: "unauthorized" }, 401)));

export default server;
