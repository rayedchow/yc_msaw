/** Sales: GurtAI's HubSpot-style CRM and its warehouse (field history, reported commits). */
import path from "node:path";
import type { Decision } from "../../mine/data.js";
import { aggregateSet } from "../../mine/backtest.js";
import { HELD_OUT_FROM } from "../../mine/backtest.js";
import { quarterOf } from "../../mine/data.js";
import type { Domain, ReplayCase } from "../types.js";
import { fetchData, makeCtx, type SalesData } from "./runtime.js";

const month = (iso: string) => iso.slice(0, 7);

export const sales: Domain<SalesData> = {
  id: "sales",
  name: "GurtAI Sales MCP",
  title: "GurtAI's HubSpot-style CRM (deals, contacts, companies) and its warehouse (field history, forecast snapshots)",
  description: "GurtAI's sales system with the company's own rules built in. Use these tools instead of raw CRM queries: they apply how GurtAI actually counts commit, routes contacts and dedupes companies.",
  systems: ["GurtAI CRM", "warehouse"],
  integrations: [["gurtai-crm.md", "GurtAI CRM", "REST · read only", "GURTAI_TOKEN"], ["gurtai-warehouse.md", "GurtAI warehouse", "field history · snapshots", "GURTAI_TOKEN"]],
  mdFile: "gurtai-crm.md",
  dir: path.dirname(new URL(import.meta.url).pathname),
  fetchData, makeCtx,
  ctxHelp: 'ctx.stateAt(object, id, epochMs) -> properties as of that time (object is "deal" | "contact" | "company"), ctx.quarterOf(ms), ctx.quarterRange("2026-Q3"), ctx.rootDomain(s), ctx.deals / ctx.companies (Map id -> record)',

  kinds: {
    commit_membership: {
      description: "At each month end RevOps reported the current quarter's commit. For every non-merged deal whose closedate is in that quarter, did RevOps count it?",
      signature: "(deal, asOf, ctx) where deal = { id, properties } (current), asOf = epoch ms, ctx.stateAt('deal', id, asOf) = properties as of that time",
      returns: "true if the deal counts toward commit", unit: "deal-months", combine: "set",
    },
    commit_total: {
      description: "The reported commit total in USD for the deals RevOps counted (value per deal summed).",
      signature: "(deal, ctx) where deal = { id, properties }",
      returns: "the deal's value in USD (number)", unit: "month ends",
      apply: (fn, d, ctx) => (d.args[0] as string[]).reduce((s, id) => s + Number(fn(ctx.deals.get(id), ctx)), 0),
    },
    new_contact_owner: {
      description: "When a contact was created, which owner was it assigned?",
      signature: "(contact, ctx) where contact = { id, properties } (country, lead_source, ...)",
      returns: "owner id as a string", unit: "new contacts",
    },
    returning_contact_owner: {
      description: "When an existing contact showed up again (last_event changed in 2026), what owner did it have 30 days later?",
      signature: "(contact, ownerBefore, ctx) where contact = { id, properties }, ownerBefore = owner id before it showed up again",
      returns: "owner id as a string", unit: "returning contacts",
    },
    same_company: {
      description: "Were two company records the same company (RevOps merged them)? Pairs include every merge plus non-merged pairs.",
      signature: "(a, b, ctx) where a, b = company domains as stored (strings)",
      returns: "true if they are the same company", unit: "company pairs",
    },
  },

  decisions(ds, ctx): Decision[] {
    const out: Decision[] = [];
    for (const s of ds.snapshots) {
      const asOf = Date.parse(s.as_of);
      const q = quarterOf(asOf);
      const counted = new Set(s.deal_ids);
      for (const d of ds.deals) {
        const c = Date.parse(String(d.properties.closedate));
        if (c < q.start || c > q.end) continue;
        out.push({ kind: "commit_membership", month: month(s.as_of), key: `${s.as_of}:${d.id}`, args: [d, asOf], recorded: counted.has(d.id) });
      }
      out.push({ kind: "commit_total", month: month(s.as_of), key: s.as_of, args: [s.deal_ids], recorded: s.reported_commit_usd });
    }
    const contacts = new Map(ds.contacts.map((c: any) => [c.id, c]));
    for (const h of ds.history) {
      if (h.object === "contact" && h.property === "hubspot_owner_id" && h.old === null && contacts.has(h.id)) {
        out.push({ kind: "new_contact_owner", month: month(h.changed_at), key: h.id, args: [contacts.get(h.id)], recorded: h.new });
      }
      if (h.object === "contact" && h.property === "last_event" && h.changed_at >= "2026" && contacts.has(h.id)) {
        const t = Date.parse(h.changed_at);
        const before = ctx.stateAt("contact", h.id, t - 1).hubspot_owner_id ?? null;
        const after = ctx.stateAt("contact", h.id, t + 30 * 86_400_000).hubspot_owner_id ?? null;
        out.push({ kind: "returning_contact_owner", month: month(h.changed_at), key: `${h.id}:${h.changed_at}`, args: [contacts.get(h.id), before], recorded: after });
      }
    }
    const companies = new Map(ds.companies.map((c: any) => [c.id, c]));
    for (const m of ds.history.filter((h: any) => h.property === "merged_into")) {
      const a: any = companies.get(m.id), b: any = companies.get(String(m.new));
      if (a && b) out.push({ kind: "same_company", month: month(m.changed_at), key: `${a.id}~${b.id}`, args: [a.properties.domain, b.properties.domain], recorded: true });
    }
    // non-merged pairs (deterministic sample): neighbours in id order that were never merged
    const live = ds.companies.filter((c: any) => !c.properties.merged_into);
    for (let i = 0; i + 1 < live.length; i += 2) {
      const a = live[i]!, b = live[i + 1]!;
      out.push({ kind: "same_company", month: month(String(b.properties.createdate)), key: `${a.id}~${b.id}`, args: [a.properties.domain, b.properties.domain], recorded: false });
    }
    return out;
  },

  async describe(ds, c) {
    return {
      endpoints: ["GET /crm/v3/objects/{deals|contacts|companies}?limit&after&properties", "GET /crm/v3/objects/{type}/{id}", "POST /crm/v3/objects/{type}/search", "GET /crm/v3/pipelines/deals", "GET /crm/v3/owners", "GET /crm/v3/properties/{type}", "GET /warehouse/tables", "GET /warehouse/field_history?object&property&id&since&until&limit&after", "GET /warehouse/forecast_snapshots"],
      counts: { deals: ds.deals.length, contacts: ds.contacts.length, companies: ds.companies.length, history: ds.history.length, snapshots: ds.snapshots.length },
      properties: { deals: Object.keys(ds.deals[0]!.properties), contacts: Object.keys(ds.contacts[0]!.properties), companies: [...new Set(ds.companies.flatMap((x: any) => Object.keys(x.properties)))] },
      pipelines: ds.pipelines, owners: ds.owners,
      warehouse: (await c.get("/warehouse/tables")).body,
      analyze_data: "data = { deals, contacts, companies, history, snapshots, pipelines, owners }",
    };
  },

  aggregate: {
    setKind: "commit_membership", valueKind: "commit_total",
    run: (b, rules) => aggregateSet(rules, "commit_membership", "commit_total", b.ctx, b.data.snapshots.map((s: any) => {
      const asOf = Date.parse(s.as_of);
      const q = quarterOf(asOf);
      return {
        month: s.as_of.slice(0, 7), label: `${s.quarter} commit as of ${s.as_of.slice(0, 10)}`,
        candidates: b.data.deals.filter((d: any) => { const c = Date.parse(String(d.properties.closedate)); return c >= q.start && c <= q.end; }),
        args: (d: any) => [d, asOf], recordedIds: s.deal_ids, recorded: s.reported_commit_usd, value: (fn: any, d: any) => Number(fn(d, b.ctx)),
      };
    })),
  },

  tools: [
    { name: "get_commit", sig: "get_commit(quarter, as_of)", d: "Commit for a quarter, counted the way RevOps reports it", kinds: ["commit_membership", "commit_total"], task: "Month-end commit, as RevOps reported it" },
    { name: "route_contact", sig: "route_contact(email, country)", d: "Who should own a contact", kinds: ["new_contact_owner", "returning_contact_owner"], task: "Contact owner, as assigned" },
    { name: "find_account", sig: "find_account(query)", d: "The one company for a domain or name", kinds: ["same_company"], task: "Company merges, as RevOps did them" },
  ],

  async replay(mcp, ds) {
    const names = new Set(mcp.tools.map((t) => t.name));
    const out: ReplayCase[] = [];
    const push = (c: Omit<ReplayCase, "heldOut">) => out.push({ ...c, heldOut: c.month >= HELD_OUT_FROM });
    if (names.has("get_commit")) {
      for (const s of ds.snapshots) {
        const r = await mcp.call("get_commit", { as_of: s.as_of });
        push({ tool: "get_commit", month: s.as_of.slice(0, 7), label: `${s.quarter} commit as of ${s.as_of.slice(0, 10)}`, expected: s.reported_commit_usd, got: r.data?.commit_usd ?? r.text.slice(0, 200), ok: r.data?.commit_usd === s.reported_commit_usd });
      }
    }
    if (names.has("route_contact")) {
      const contacts = new Map(ds.contacts.map((c: any) => [c.id, c]));
      const created = ds.history.filter((h: any) => h.object === "contact" && h.property === "hubspot_owner_id" && h.old === null && contacts.has(h.id));
      const step = Math.max(1, Math.floor(created.length / 75));
      for (let i = 0, n = 0; i < created.length && n < 75; i += step, n++) {
        const h = created[i]!, c: any = contacts.get(h.id);
        const r = await mcp.call("route_contact", { country: c.properties.country });
        push({ tool: "route_contact", month: h.changed_at.slice(0, 7), label: `new contact from ${c.properties.country}`, expected: h.new, got: r.data?.owner_id ?? null, ok: r.data?.owner_id === h.new });
      }
      for (const h of ds.history.filter((h: any) => h.object === "contact" && h.property === "last_event" && h.changed_at >= "2026")) {
        const c: any = contacts.get(h.id);
        if (!c) continue;
        const t = Date.parse(h.changed_at) + 30 * 86_400_000;
        const after = ds.history.filter((x: any) => x.object === "contact" && x.id === h.id && x.property === "hubspot_owner_id" && Date.parse(x.changed_at) <= t).pop()?.new;
        const r = await mcp.call("route_contact", { contact_id: c.id });
        push({ tool: "route_contact", month: h.changed_at.slice(0, 7), label: `returning contact ${c.id}`, expected: after, got: r.data?.owner_id ?? null, ok: r.data?.owner_id === after });
      }
    }
    if (names.has("find_account")) {
      const companies = new Map(ds.companies.map((c: any) => [c.id, c]));
      for (const m of ds.history.filter((h: any) => h.property === "merged_into")) {
        const dup: any = companies.get(m.id);
        if (!dup) continue;
        const r = await mcp.call("find_account", { query: String(dup.properties.domain) });
        const ids = (r.data?.accounts ?? []).map((a: any) => a.id);
        push({ tool: "find_account", month: m.changed_at.slice(0, 7), label: `${dup.properties.domain} → canonical`, expected: m.new, got: ids.join(",") || null, ok: ids.length === 1 && ids[0] === m.new });
      }
    }
    return out;
  },
};
