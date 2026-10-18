/**
 * Pull everything the miner needs from the system's REST API (with the host-held token) and build "decisions":
 * things people did repeatedly that history recorded. Rules are scored against these decisions.
 */
export interface Obj { id: string; properties: Record<string, string | null> }
export interface Change { object: string; id: string; property: string; old: string | null; new: string | null; changed_at: string; changed_by: string }
export interface Snapshot { as_of: string; quarter: string; reported_commit_usd: number; deal_ids: string[] }
export interface Dataset { deals: Obj[]; contacts: Obj[]; companies: Obj[]; history: Change[]; snapshots: Snapshot[]; pipelines: unknown; owners: unknown }

export class SystemClient {
  constructor(readonly baseUrl: string, private readonly token: string) {}
  async get(p: string): Promise<{ status: number; body: any }> {
    const r = await fetch(this.baseUrl.replace(/\/$/, "") + p, { headers: { authorization: `Bearer ${this.token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async post(p: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(this.baseUrl.replace(/\/$/, "") + p, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async all(p: string, limit = 200): Promise<any[]> {
    const out: any[] = [];
    let after: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const sep = p.includes("?") ? "&" : "?";
      const r = await this.get(`${p}${sep}limit=${limit}${after ? `&after=${after}` : ""}`);
      if (r.status !== 200) throw new Error(`GET ${p} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      out.push(...r.body.results);
      after = r.body.paging?.next?.after;
      if (!after) break;
    }
    return out;
  }
  async dataset(): Promise<Dataset> {
    const [deals, contacts, companies, history, snaps, pipelines, owners] = await Promise.all([
      this.all("/crm/v3/objects/deals"), this.all("/crm/v3/objects/contacts"), this.all("/crm/v3/objects/companies"),
      this.all("/warehouse/field_history", 5000), this.get("/warehouse/forecast_snapshots"), this.get("/crm/v3/pipelines/deals"), this.get("/crm/v3/owners"),
    ]);
    return { deals, contacts, companies, history, snapshots: snaps.body.results, pipelines: pipelines.body.results, owners: owners.body.results };
  }
}

// ── helpers shared by rules, the analysis sandbox and compiled tools ─────────
export function quarterOf(t: number): { label: string; start: number; end: number } {
  const d = new Date(t);
  const q = Math.floor(d.getUTCMonth() / 3);
  return { label: `${d.getUTCFullYear()}-Q${q + 1}`, start: Date.UTC(d.getUTCFullYear(), q * 3, 1), end: Date.UTC(d.getUTCFullYear(), q * 3 + 3, 1) - 1 };
}
export function quarterRange(label: string): { start: number; end: number } {
  const [y, q] = label.split("-Q").map(Number);
  return { start: Date.UTC(y!, (q! - 1) * 3, 1), end: Date.UTC(y!, q! * 3, 1) - 1 };
}
export const rootDomain = (s: string) => String(s ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split("/")[0]!.replace(/^www\./, "");

export function indexHistory(history: Change[]): Map<string, Change[]> {
  const m = new Map<string, Change[]>();
  for (const h of history) {
    const k = `${h.object}:${h.id}`;
    (m.get(k) ?? m.set(k, []).get(k)!).push(h);
  }
  for (const v of m.values()) v.sort((a, b) => a.changed_at.localeCompare(b.changed_at));
  return m;
}
export function stateAtFrom(idx: Map<string, Change[]>, object: string, id: string, t: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of idx.get(`${object}:${id}`) ?? []) {
    if (Date.parse(h.changed_at) > t) break;
    if (h.new == null) delete out[h.property];
    else out[h.property] = h.new;
  }
  return out;
}

// ── decisions ────────────────────────────────────────────────────────────────
/** One recorded decision. `month` is YYYY-MM; `input` is what a rule sees; `recorded` is what people did. */
export interface Decision { kind: DecisionKind; month: string; key: string; input: any; recorded: any }
export type DecisionKind = "commit_membership" | "commit_total" | "new_contact_owner" | "returning_contact_owner" | "same_company";

export const DECISION_KINDS: Record<DecisionKind, { description: string; signature: string; returns: string }> = {
  commit_membership: {
    description: "At each month end RevOps reported the current quarter's commit. For every non-merged deal whose closedate is in that quarter, did RevOps count it?",
    signature: "(deal, asOf, ctx) where deal = { id, properties } (current), asOf = epoch ms, ctx.stateAt('deal', id, asOf) = properties as of that time",
    returns: "true if the deal counts toward commit",
  },
  commit_total: {
    description: "The reported commit total in USD for the deals RevOps counted (value per deal summed).",
    signature: "(deal, ctx) where deal = { id, properties }",
    returns: "the deal's value in USD (number)",
  },
  new_contact_owner: {
    description: "When a contact was created, which owner was it assigned?",
    signature: "(contact, ctx) where contact = { id, properties } (country, lead_source, ...)",
    returns: "owner id as a string",
  },
  returning_contact_owner: {
    description: "When an existing contact showed up again (last_event changed in 2026), what owner did it have 30 days later?",
    signature: "(contact, ownerBefore, ctx) where contact = { id, properties }, ownerBefore = owner id before it showed up again",
    returns: "owner id as a string",
  },
  same_company: {
    description: "Were two company records the same company (RevOps merged them)? Pairs include every merge plus non-merged pairs.",
    signature: "(a, b, ctx) where a, b = company domains as stored (strings)",
    returns: "true if they are the same company",
  },
};

export function buildDecisions(ds: Dataset): Decision[] {
  const idx = indexHistory(ds.history);
  const out: Decision[] = [];
  const month = (iso: string) => iso.slice(0, 7);
  for (const s of ds.snapshots) {
    const asOf = Date.parse(s.as_of);
    const q = quarterOf(asOf);
    const counted = new Set(s.deal_ids);
    for (const d of ds.deals) {
      const c = Date.parse(String(d.properties.closedate));
      if (c < q.start || c > q.end) continue;
      out.push({ kind: "commit_membership", month: month(s.as_of), key: `${s.as_of}:${d.id}`, input: { deal: d, asOf }, recorded: counted.has(d.id) });
    }
    out.push({ kind: "commit_total", month: month(s.as_of), key: s.as_of, input: { members: s.deal_ids }, recorded: s.reported_commit_usd });
  }
  const contacts = new Map(ds.contacts.map((c) => [c.id, c]));
  for (const h of ds.history) {
    if (h.object === "contact" && h.property === "hubspot_owner_id" && h.old === null && contacts.has(h.id)) {
      out.push({ kind: "new_contact_owner", month: month(h.changed_at), key: h.id, input: { contact: contacts.get(h.id) }, recorded: h.new });
    }
    if (h.object === "contact" && h.property === "last_event" && h.changed_at >= "2026" && contacts.has(h.id)) {
      const t = Date.parse(h.changed_at);
      const before = stateAtFrom(idx, "contact", h.id, t - 1).hubspot_owner_id ?? null;
      const after = stateAtFrom(idx, "contact", h.id, t + 30 * 86_400_000).hubspot_owner_id ?? null;
      out.push({ kind: "returning_contact_owner", month: month(h.changed_at), key: `${h.id}:${h.changed_at}`, input: { contact: contacts.get(h.id), ownerBefore: before }, recorded: after });
    }
  }
  const companies = new Map(ds.companies.map((c) => [c.id, c]));
  const merges = ds.history.filter((h) => h.property === "merged_into");
  for (const m of merges) {
    const a = companies.get(m.id), b = companies.get(String(m.new));
    if (a && b) out.push({ kind: "same_company", month: month(m.changed_at), key: `${a.id}~${b.id}`, input: { a: a.properties.domain, b: b.properties.domain }, recorded: true });
  }
  // non-merged pairs (deterministic sample): neighbours in id order that were never merged
  const live = ds.companies.filter((c) => !c.properties.merged_into);
  for (let i = 0; i + 1 < live.length; i += 2) {
    const a = live[i]!, b = live[i + 1]!;
    out.push({ kind: "same_company", month: month(String(b.properties.createdate)), key: `${a.id}~${b.id}`, input: { a: a.properties.domain, b: b.properties.domain }, recorded: false });
  }
  return out;
}
