/**
 * Evals: replay past work through the deployed MCP and compare with what people actually did (history is the
 * answer key). Cases are generic per tool: each tool the compiler produced gets replayed on recorded decisions.
 */
import type { Mcp } from "../mcp-client.js";
import type { Dataset } from "../mine/data.js";
import { HELD_OUT_FROM } from "../mine/backtest.js";

export interface ReplayCase { tool: string; month: string; heldOut: boolean; label: string; expected: unknown; got: unknown; ok: boolean }

export async function replayThroughMcp(mcp: Mcp, ds: Dataset, opts: { maxPerTool?: number } = {}): Promise<ReplayCase[]> {
  const names = new Set(mcp.tools.map((t) => t.name));
  const out: ReplayCase[] = [];
  const push = (c: Omit<ReplayCase, "heldOut">) => out.push({ ...c, heldOut: c.month >= HELD_OUT_FROM });
  const max = opts.maxPerTool ?? 40;

  if (names.has("get_commit")) {
    for (const s of ds.snapshots) {
      const r = await mcp.call("get_commit", { as_of: s.as_of });
      push({ tool: "get_commit", month: s.as_of.slice(0, 7), label: `${s.quarter} commit as of ${s.as_of.slice(0, 10)}`, expected: s.reported_commit_usd, got: r.data?.commit_usd ?? r.text.slice(0, 200), ok: r.data?.commit_usd === s.reported_commit_usd });
    }
  }
  if (names.has("route_contact")) {
    const contacts = new Map(ds.contacts.map((c) => [c.id, c]));
    // new contacts: ask as if the person were new (email unknown to the CRM), with their country
    const created = ds.history.filter((h) => h.object === "contact" && h.property === "hubspot_owner_id" && h.old === null && contacts.has(h.id));
    const step = Math.max(1, Math.floor(created.length / max));
    for (let i = 0; i < created.length && out.filter((c) => c.tool === "route_contact").length < max; i += step) {
      const h = created[i]!, c = contacts.get(h.id)!;
      const r = await mcp.call("route_contact", { country: c.properties.country });
      push({ tool: "route_contact", month: h.changed_at.slice(0, 7), label: `new contact from ${c.properties.country}`, expected: h.new, got: r.data?.owner_id ?? null, ok: r.data?.owner_id === h.new });
    }
    // returning contacts: what owner did they have 30 days after showing up again?
    for (const h of ds.history.filter((h) => h.object === "contact" && h.property === "last_event" && h.changed_at >= "2026")) {
      const c = contacts.get(h.id);
      if (!c) continue;
      const t = Date.parse(h.changed_at) + 30 * 86_400_000;
      const after = ds.history.filter((x) => x.object === "contact" && x.id === h.id && x.property === "hubspot_owner_id" && Date.parse(x.changed_at) <= t).pop()?.new;
      const r = await mcp.call("route_contact", { contact_id: c.id });
      push({ tool: "route_contact", month: h.changed_at.slice(0, 7), label: `returning contact ${c.id}`, expected: after, got: r.data?.owner_id ?? null, ok: r.data?.owner_id === after });
    }
  }
  if (names.has("find_account")) {
    const companies = new Map(ds.companies.map((c) => [c.id, c]));
    for (const m of ds.history.filter((h) => h.property === "merged_into")) {
      const dup = companies.get(m.id);
      if (!dup) continue;
      const r = await mcp.call("find_account", { query: String(dup.properties.domain) });
      const ids = (r.data?.accounts ?? []).map((a: any) => a.id);
      push({ tool: "find_account", month: m.changed_at.slice(0, 7), label: `${dup.properties.domain} → canonical`, expected: m.new, got: ids.join(",") || null, ok: ids.length === 1 && ids[0] === m.new });
    }
  }
  return out;
}

export function summarizeReplays(cases: ReplayCase[]) {
  const by = new Map<string, { tool: string; n: number; ok: number; learned: { n: number; ok: number }; heldOut: { n: number; ok: number } }>();
  for (const c of cases) {
    const s = by.get(c.tool) ?? { tool: c.tool, n: 0, ok: 0, learned: { n: 0, ok: 0 }, heldOut: { n: 0, ok: 0 } };
    s.n++; if (c.ok) s.ok++;
    const b = c.heldOut ? s.heldOut : s.learned;
    b.n++; if (c.ok) b.ok++;
    by.set(c.tool, s);
  }
  return [...by.values()];
}
