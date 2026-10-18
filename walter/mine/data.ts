/**
 * Shared by the miner, backtests and compiled MCPs: a REST client for GurtAI's systems (host-held token), helpers
 * rules can use, and the Decision shape. What a system's data and decisions look like lives in walter/domains/<id>.
 */
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
  /** Page through a { results, paging.next.after } endpoint. */
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

export interface Change { object: string; id: string; property: string; old: string | null; new: string | null; changed_at: string; changed_by: string }
/** Index field history by object:id, oldest first. Works for any { object, id, property, new, changed_at } rows. */
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

/** One recorded decision. `month` is YYYY-MM; a rule is called as fn(...args, ctx); `recorded` is what people did. */
export interface Decision { kind: string; month: string; key: string; args: unknown[]; recorded: unknown }
