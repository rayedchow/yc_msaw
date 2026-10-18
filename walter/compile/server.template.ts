// @ts-nocheck
// Template for a walter-compiled MCP (copied to index.ts; __META__ is replaced at compile time).
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { RULES } from "./src/rules.ts";
import { SystemClient, indexHistory, stateAtFrom, quarterOf, quarterRange, rootDomain } from "./src/system.ts";

const META = __META__;
const sys = new SystemClient(process.env.GURTAI_URL ?? "", process.env.GURTAI_TOKEN ?? "");
const ADMIN = process.env.WALTER_TOKEN ?? "";

// Live data, cached briefly. Rules see the same ctx they were backtested with.
let cache = null;
async function load() {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const [deals, contacts, companies, history, owners] = await Promise.all([
    sys.all("/crm/v3/objects/deals"), sys.all("/crm/v3/objects/contacts"), sys.all("/crm/v3/objects/companies"),
    sys.all("/warehouse/field_history", 5000), sys.get("/crm/v3/owners"),
  ]);
  const idx = indexHistory(history);
  const ctx = { stateAt: (o, id, t) => stateAtFrom(idx, o, id, t), quarterOf, quarterRange, rootDomain,
    deals: new Map(deals.map((d) => [d.id, d])), companies: new Map(companies.map((c) => [c.id, c])) };
  // Values the system actually uses. Rules were only checked on these, so tools refuse anything else instead of guessing.
  const countries = [...new Set(contacts.map((c) => c.properties.country).filter(Boolean))].sort();
  cache = { at: Date.now(), deals, contacts, companies, owners: owners.body?.results ?? [], ctx, countries };
  return cache;
}

const usage = [];
const feedback = [];
const rulesOf = (kind) => RULES.filter((r) => r.kind === kind);
const brief = (r) => ({ id: r.id, rule: r.title, learned: r.agreement.learned, heldOut: r.agreement.heldOut, ...(r.change ? { changed: r.change.month } : {}) });
const caveatsFor = (kinds) => [
  ...RULES.filter((r) => kinds.includes(r.kind) && r.change && r.status !== "confirmed").map((r) => `Rule ${r.id} ("${r.title}") stopped matching history in ${r.change.month}; a human has not confirmed the new behaviour yet.`),
  ...META.questions.filter((q) => RULES.some((r) => r.id === q.rule_id && kinds.includes(r.kind))).map((q) => `Open question on ${q.rule_id}: ${q.question}`),
];
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
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
  name: META.name, title: `GurtAI ${META.mcp}`, version: `1.${META.version}.0`,
  description: `GurtAI's ${META.mcp} system with the company's own rules built in (compiled by walter from history). Use these tools instead of raw CRM queries: they apply how GurtAI actually counts, routes and dedupes.`,
});

if (META.tools.includes("get_commit")) server.tool({
  name: "get_commit",
  description: "GurtAI's commit (forecast) for a quarter, computed the way RevOps reports it: which deals count, what value each counts at, and why. Defaults to the current quarter as of now.",
  inputSchema: z.object({ quarter: z.string().optional().describe("e.g. 2026-Q4"), as_of: z.string().optional().describe("ISO date; defaults to now") }),
  annotations: { readOnlyHint: true },
}, tracked("get_commit", async ({ quarter, as_of }) => {
  const d = await load();
  const asOf = as_of ? Date.parse(as_of) : Date.now();
  const q = quarter ? { label: quarter, ...quarterRange(quarter) } : quarterOf(asOf);
  const inc = rulesOf("commit_membership").filter((r) => r.role !== "exclude"), exc = rulesOf("commit_membership").filter((r) => r.role === "exclude");
  const value = rulesOf("commit_total")[0];
  const rows = [];
  let excluded = 0;
  for (const deal of d.deals) {
    const c = Date.parse(String(deal.properties.closedate));
    if (c < q.start || c > q.end) continue;
    const yes = inc.filter((r) => r.fn(deal, asOf, d.ctx)), no = exc.filter((r) => r.fn(deal, asOf, d.ctx));
    if (!yes.length || no.length) { if (yes.length) excluded++; continue; }
    const v = value ? Number(value.fn(deal, d.ctx)) : Number(deal.properties.amount);
    rows.push({ id: deal.id, name: deal.properties.dealname, stage: d.ctx.stateAt("deal", deal.id, asOf).dealstage ?? deal.properties.dealstage, value_usd: v, counted_by: yes.map((r) => r.id) });
  }
  rows.sort((a, b) => b.value_usd - a.value_usd);
  return ok({ quarter: q.label, as_of: new Date(asOf).toISOString(), commit_usd: rows.reduce((s, r) => s + r.value_usd, 0), deal_count: rows.length, excluded_by_rules: excluded,
    rules_applied: [...inc, ...exc, ...(value ? [value] : [])].map(brief), caveats: caveatsFor(["commit_membership", "commit_total"]), deals: rows.slice(0, 50) });
}));

if (META.tools.includes("route_contact")) server.tool({
  name: "route_contact",
  description: "Who should own a contact at GurtAI. Pass an email (and, for new people, the country by full English name, e.g. \"Germany\"). Returning contacts and new contacts follow different company rules; the answer says which applied.",
  inputSchema: z.object({ email: z.string().optional(), country: z.string().optional().describe("full English country name, e.g. Germany"), contact_id: z.string().optional() }),
  annotations: { readOnlyHint: true },
}, tracked("route_contact", async ({ email, country, contact_id }) => {
  const d = await load();
  const existing = d.contacts.find((c) => (contact_id && c.id === contact_id) || (email && String(c.properties.email).toLowerCase() === email.toLowerCase()));
  const ownerName = (id) => { const o = d.owners.find((x) => String(x.id) === String(id)); return o ? `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || o.email : null; };
  if (existing) {
    const r = rulesOf("returning_contact_owner")[0];
    const before = existing.properties.hubspot_owner_id;
    const owner = r ? String(r.fn(existing, before, d.ctx)) : before;
    return ok({ contact: existing.id, existing: true, owner_id: owner, owner: ownerName(owner), rule: r ? brief(r) : null, caveats: caveatsFor(["returning_contact_owner"]) });
  }
  if (!country) throw new Error("new contact: pass country");
  const known = d.countries.find((c) => c.toLowerCase() === country.trim().toLowerCase());
  if (!known) throw new Error(`GurtAI stores countries by full name, and "${country}" is not one it has used. Pass one of: ${d.countries.join(", ")}.`);
  country = known;
  const r = rulesOf("new_contact_owner")[0];
  const owner = String(r.fn({ id: "new", properties: { email: email ?? null, country } }, d.ctx));
  return ok({ existing: false, owner_id: owner, owner: ownerName(owner), rule: brief(r), caveats: caveatsFor(["new_contact_owner"]) });
}));

if (META.tools.includes("find_account")) server.tool({
  name: "find_account",
  description: "Find GurtAI's canonical company record for a domain or name, with known duplicates folded in the way RevOps merges them.",
  inputSchema: z.object({ query: z.string().describe("domain, URL or company name") }),
  annotations: { readOnlyHint: true },
}, tracked("find_account", async ({ query }) => {
  const d = await load();
  const same = rulesOf("same_company")[0];
  const ql = query.toLowerCase();
  const hits = d.companies.filter((c) => String(c.properties.name ?? "").toLowerCase().includes(ql) || (same ? same.fn(String(c.properties.domain), query, d.ctx) : c.properties.domain === query));
  const groups = [];
  for (const c of hits) {
    const g = groups.find((g) => same ? same.fn(String(g[0].properties.domain), String(c.properties.domain), d.ctx) : false);
    g ? g.push(c) : groups.push([c]);
  }
  return ok({ query, accounts: groups.map((g) => {
    const canon = g.find((c) => !c.properties.merged_into) ?? g[0];
    return { id: canon.id, name: canon.properties.name, domain: canon.properties.domain, duplicates: g.filter((c) => c !== canon).map((c) => ({ id: c.id, domain: c.properties.domain, merged_into: c.properties.merged_into ?? null })) };
  }), rule: same ? brief(same) : null });
}));

server.tool({
  name: "company_rules",
  description: "The GurtAI rules this MCP applies, with how well each matched history, plus questions still open.",
  inputSchema: z.object({}), annotations: { readOnlyHint: true },
}, tracked("company_rules", async () => ok({ version: META.version, rules: RULES.map((r) => ({ ...brief(r), kind: r.kind, evidence: r.evidence, status: r.status })), open_questions: META.questions, answered: META.answers })));

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
