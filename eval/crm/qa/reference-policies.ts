/**
 * HOST FIXTURE QA ONLY — scripted raw-HTTP REFERENCE POLICIES for the synthetic CRM contract fixtures.
 *
 * These scripts exist solely to check that the host-owned fixtures (templates/integration/harness/fixtures/crm)
 * and the host oracle (eval/crm/oracle.ts) behave as specified in eval/crm/CONTRACTS.md §8. They must NEVER be
 * used as model episodes, never be recorded as traces, and never be placed in prompts, docs, memory, builder
 * inputs or archives. Adversarial options deliberately perform WRONG behaviour to prove the oracle rejects it.
 */
export type Vendor = "hubspot" | "pipedrive" | "zoho" | "attio";
export const NEXT_STEP = "Exec review 2026-11-03";

export interface Conn {
  vendor: Vendor;
  baseUrl: string;
  token: string;
}
export interface HttpResult {
  status: number;
  json: any;
}

export function authHeaders(vendor: Vendor, token: string): Record<string, string> {
  if (vendor === "pipedrive") return { "x-api-token": token };
  if (vendor === "zoho") return { authorization: `Zoho-oauthtoken ${token}` };
  return { authorization: `Bearer ${token}` };
}

/** Raw HTTP call. `headers` replaces the vendor auth headers when given. */
export async function http(c: Conn, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(c.baseUrl + path, {
    method,
    headers: { ...(headers ?? authHeaders(c.vendor, c.token)), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function ok(c: Conn, method: string, path: string, body?: unknown): Promise<any> {
  const r = await http(c, method, path, body);
  if (r.status >= 300 && r.status !== 204) throw new Error(`${c.vendor} ${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}
const q = encodeURIComponent;

export interface DealView {
  id: string | number;
  name: string;
  open: boolean;
  /** canonical tag names */
  tags: string[];
  raw: any;
}
export interface UpdateIntent {
  nextStep?: string;
  addTags?: string[];
  won?: boolean;
}
export interface PolicyOpts {
  /** HubSpot: "append" = leading ';' (default), "replace" = read existing + full ';' list, "replace-drop" = plain new value only (WRONG). */
  hubspotTagMode?: "append" | "replace" | "replace-drop";
  /** Attio: use PUT instead of PATCH (WRONG: replaces multiselect). */
  attioPut?: boolean;
  /** Pipedrive F2: move stage_id instead of setting status (WRONG). */
  pipedriveStageInsteadOfStatus?: boolean;
  /** Write next step and tags in two separate requests per deal (still correct). */
  twoStep?: boolean;
  /** Skip the last eligible deal (WRONG). */
  skipLast?: boolean;
  /** Also update one closed deal of the target company (WRONG). */
  alsoClosed?: boolean;
  /** Also update one open deal of the same-name duplicate company (WRONG). */
  alsoDuplicate?: boolean;
  /** Also edit the target company (WRONG). */
  companyEdit?: "rename" | "domain" | "industry";
  /** Change an extra deal field and revert it (WRONG even though the final state is identical). */
  extraFieldRevert?: boolean;
}

interface Adapter {
  init(): Promise<void>;
  findCompany(domain: string): Promise<string | number>;
  findDuplicate(name: string, notDomain: string): Promise<string | number>;
  listDeals(companyId: string | number): Promise<DealView[]>;
  update(d: DealView, u: UpdateIntent): Promise<void>;
  editCompany(companyId: string | number, kind: "rename" | "domain" | "industry"): Promise<void>;
  bumpAndRevert(d: DealView): Promise<void>;
}

// ------------------------------------------------------------------ HubSpot
function hubspot(c: Conn, o: PolicyOpts): Adapter {
  const stages = new Map<string, { pipelineId: string; isClosed: boolean; probability: string }>();
  const pipelines: any[] = [];
  const labelToValue = new Map<string, string>();
  const valueToLabel = new Map<string, string>();
  const search = async (type: string, body: any) => {
    const out: any[] = [];
    let after: string | undefined;
    for (;;) {
      const r = await ok(c, "POST", `/crm/v3/objects/${type}/search`, { ...body, ...(after ? { after } : {}) });
      out.push(...r.results);
      after = r.paging?.next?.after;
      if (!after) return out;
    }
  };
  const view = (r: any): DealView => ({
    id: r.id,
    name: r.properties.dealname,
    open: !stages.get(r.properties.dealstage)!.isClosed,
    tags: (r.properties.review_tags ? String(r.properties.review_tags).split(";") : []).map((v: string) => valueToLabel.get(v) ?? v),
    raw: r,
  });
  const patch = (id: string | number, properties: any) => ok(c, "PATCH", `/crm/v3/objects/deals/${id}`, { properties });
  return {
    async init() {
      for (const p of (await ok(c, "GET", "/crm/v3/pipelines/deals")).results) {
        pipelines.push(p);
        for (const s of p.stages) stages.set(s.id, { pipelineId: p.id, isClosed: s.metadata.isClosed === "true", probability: s.metadata.probability });
      }
      for (const op of (await ok(c, "GET", "/crm/v3/properties/deals/review_tags")).options) {
        labelToValue.set(op.label, op.value);
        valueToLabel.set(op.value, op.label);
      }
    },
    async findCompany(domain) {
      const rs = await search("companies", { filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }], properties: ["name", "domain"] });
      if (rs.length !== 1) throw new Error(`hubspot: expected 1 company for ${domain}, got ${rs.length}`);
      return rs[0].id;
    },
    async findDuplicate(name, notDomain) {
      const rs = await search("companies", { filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }], properties: ["name", "domain"] });
      return rs.find((r) => r.properties.domain !== notDomain).id;
    },
    async listDeals(companyId) {
      // default page size (10) on purpose: follows paging.next.after to get all 12
      const rs = await search("deals", {
        filterGroups: [{ filters: [{ propertyName: "associations.company", operator: "EQ", value: String(companyId) }] }],
        properties: ["dealname", "dealstage", "pipeline", "review_tags", "hs_next_step"],
      });
      return rs.map(view);
    },
    async update(d, u) {
      const props: any = {};
      if (u.nextStep !== undefined) props.hs_next_step = u.nextStep;
      if (u.addTags?.length) {
        const add = u.addTags.map((t) => labelToValue.get(t)!);
        const mode = o.hubspotTagMode ?? "append";
        if (mode === "append") props.review_tags = `;${add.join(";")}`;
        else if (mode === "replace-drop") props.review_tags = add.join(";");
        else {
          const cur = (await ok(c, "GET", `/crm/v3/objects/deals/${d.id}?properties=review_tags`)).properties.review_tags;
          props.review_tags = [...new Set([...(cur ? String(cur).split(";") : []), ...add])].join(";");
        }
      }
      if (u.won) {
        const cur = await ok(c, "GET", `/crm/v3/objects/deals/${d.id}?properties=pipeline`);
        const p = pipelines.find((x) => x.id === cur.properties.pipeline);
        props.dealstage = p.stages.find((s: any) => s.metadata.isClosed === "true" && s.metadata.probability === "1.0").id;
      }
      await patch(d.id, props);
    },
    async editCompany(id, kind) {
      const properties = kind === "rename" ? { name: "Renamed Co" } : kind === "domain" ? { domain: "renamed.example" } : { industry: "Retail" };
      await ok(c, "PATCH", `/crm/v3/objects/companies/${id}`, { properties });
    },
    async bumpAndRevert(d) {
      const cur = await ok(c, "GET", `/crm/v3/objects/deals/${d.id}?properties=amount`);
      await patch(d.id, { amount: String(Number(cur.properties.amount) + 1) });
      await patch(d.id, { amount: cur.properties.amount });
    },
  };
}

// ------------------------------------------------------------------ Pipedrive
function pipedrive(c: Conn, o: PolicyOpts): Adapter {
  let domainKey = "";
  let nextKey = "";
  let tagsKey = "";
  let tagOpts: Array<{ id: number; label: string }> = [];
  const stagesByPipeline = new Map<number, any[]>();
  const listAll = async (path: string) => {
    const out: any[] = [];
    let cursor: string | null = null;
    for (;;) {
      const r: any = await ok(c, "GET", `${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&cursor=${q(cursor)}` : ""}`);
      out.push(...(Array.isArray(r.data) ? r.data : r.data.items));
      cursor = r.additional_data?.next_cursor ?? null;
      if (!cursor) return out;
    }
  };
  const view = (r: any): DealView => ({
    id: r.id,
    name: r.title,
    open: r.status === "open",
    tags: (r.custom_fields[tagsKey] ?? []).map((id: number) => tagOpts.find((x) => x.id === id)!.label),
    raw: r,
  });
  return {
    async init() {
      domainKey = (await ok(c, "GET", "/api/v1/organizationFields")).data.find((f: any) => f.name === "Domain").key;
      const df = (await ok(c, "GET", "/api/v1/dealFields")).data;
      nextKey = df.find((f: any) => f.name === "Next step").key;
      const tf = df.find((f: any) => f.name === "Review tags");
      tagsKey = tf.key;
      tagOpts = tf.options;
      for (const s of (await ok(c, "GET", "/api/v2/stages")).data) {
        stagesByPipeline.set(s.pipeline_id, [...(stagesByPipeline.get(s.pipeline_id) ?? []), s]);
      }
    },
    async findCompany(domain) {
      const items = await listAll(`/api/v2/organizations/search?term=${q(domain)}&fields=custom_fields&exact_match=true`);
      const hits = items.filter((i: any) => i.item.custom_fields.includes(domain));
      if (hits.length !== 1) throw new Error(`pipedrive: expected 1 org for ${domain}`);
      return hits[0].item.id;
    },
    async findDuplicate(name, notDomain) {
      const items = await listAll(`/api/v2/organizations/search?term=${q(name)}&fields=name&exact_match=true`);
      for (const i of items) {
        const org = (await ok(c, "GET", `/api/v2/organizations/${i.item.id}`)).data;
        if (org.custom_fields[domainKey] !== notDomain) return org.id;
      }
      throw new Error("no duplicate org");
    },
    async listDeals(orgId) {
      return (await listAll(`/api/v2/deals?org_id=${orgId}`)).map(view);
    },
    async update(d, u) {
      const body: any = {};
      const cf: any = {};
      if (u.nextStep !== undefined) cf[nextKey] = u.nextStep;
      if (u.addTags?.length) {
        const cur: number[] = (await ok(c, "GET", `/api/v2/deals/${d.id}`)).data.custom_fields[tagsKey] ?? [];
        cf[tagsKey] = [...new Set([...cur, ...u.addTags.map((t) => tagOpts.find((x) => x.label === t)!.id)])];
      }
      if (Object.keys(cf).length) body.custom_fields = cf;
      if (u.won) {
        if (o.pipedriveStageInsteadOfStatus) {
          const st = stagesByPipeline.get(d.raw.pipeline_id)!;
          body.stage_id = st[st.length - 1].id;
        } else body.status = "won";
      }
      await ok(c, "PATCH", `/api/v2/deals/${d.id}`, body);
    },
    async editCompany(id, kind) {
      const body = kind === "rename" ? { name: "Renamed Co" } : kind === "domain" ? { custom_fields: { [domainKey]: "renamed.example" } } : { visible_to: 1 };
      await ok(c, "PATCH", `/api/v2/organizations/${id}`, body);
    },
    async bumpAndRevert(d) {
      const cur = (await ok(c, "GET", `/api/v2/deals/${d.id}`)).data.value;
      await ok(c, "PATCH", `/api/v2/deals/${d.id}`, { value: cur + 1 });
      await ok(c, "PATCH", `/api/v2/deals/${d.id}`, { value: cur });
    },
  };
}

// ------------------------------------------------------------------ Zoho
function zoho(c: Conn): Adapter {
  let closedStages: string[] = [];
  const pages = async (path: string) => {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const r = await http(c, "GET", `${path}&page=${page}&per_page=200`);
      if (r.status === 204) return out;
      if (r.status !== 200) throw new Error(`zoho GET ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
      out.push(...r.json.data);
      if (!r.json.info.more_records) return out;
    }
  };
  const put = async (module: string, row: any) => {
    const r = await ok(c, "PUT", `/crm/v8/${module}`, { data: [row] });
    if (r.data[0].status !== "success") throw new Error(`zoho row failed ${JSON.stringify(r.data[0])}`);
  };
  return {
    async init() {
      const f = (await ok(c, "GET", "/crm/v8/settings/fields?module=Deals")).fields.find((x: any) => x.api_name === "Stage");
      closedStages = f.pick_list_values.map((p: any) => p.actual_value).filter((v: string) => v.startsWith("Closed"));
    },
    async findCompany(domain) {
      const rows = await pages(`/crm/v8/Accounts/search?criteria=${q(`(Website:equals:${domain})`)}&fields=Account_Name,Website`);
      const hits = rows.filter((r) => r.Website === domain); // equals is contains-like: compare exactly
      if (hits.length !== 1) throw new Error(`zoho: expected 1 account for ${domain}`);
      return hits[0].id;
    },
    async findDuplicate(name, notDomain) {
      const rows = await pages(`/crm/v8/Accounts/search?criteria=${q(`(Account_Name:equals:${name})`)}&fields=Account_Name,Website`);
      return rows.find((r) => r.Account_Name === name && r.Website !== notDomain).id;
    },
    async listDeals(id) {
      const rows = await pages(`/crm/v8/Accounts/${id}/Deals?fields=Deal_Name,Stage,Review_Tags,Next_Step,Amount`);
      return rows.map((r) => ({ id: r.id, name: r.Deal_Name, open: !closedStages.includes(r.Stage), tags: r.Review_Tags ?? [], raw: r }));
    },
    async update(d, u) {
      const row: any = { id: d.id };
      if (u.nextStep !== undefined) row.Next_Step = u.nextStep;
      if (u.addTags?.length) {
        const cur = (await ok(c, "GET", `/crm/v8/Deals/${d.id}`)).data[0].Review_Tags ?? [];
        row.Review_Tags = [...new Set([...cur, ...u.addTags])];
      }
      if (u.won) row.Stage = "Closed Won";
      await put("Deals", row);
    },
    async editCompany(id, kind) {
      await put("Accounts", { id, ...(kind === "rename" ? { Account_Name: "Renamed Co" } : kind === "domain" ? { Website: "renamed.example" } : { Industry: "Retail" }) });
    },
    async bumpAndRevert(d) {
      const cur = (await ok(c, "GET", `/crm/v8/Deals/${d.id}`)).data[0].Amount;
      await put("Deals", { id: d.id, Amount: cur + 1 });
      await put("Deals", { id: d.id, Amount: cur });
    },
  };
}

// ------------------------------------------------------------------ Attio
function attio(c: Conn, o: PolicyOpts): Adapter {
  let closedTitles: string[] = [];
  const query = async (obj: string, filter: any) => {
    const out: any[] = [];
    for (let offset = 0; ; offset += 50) {
      const r = await ok(c, "POST", `/v2/objects/${obj}/records/query`, { filter, limit: 50, offset });
      out.push(...r.data);
      if (r.data.length < 50) return out;
    }
  };
  const first = (r: any, s: string) => r.values[s]?.[0];
  return {
    async init() {
      const st = (await ok(c, "GET", "/v2/objects/deals/attributes/stage/statuses")).data.map((s: any) => s.title);
      closedTitles = st.filter((t: string) => /^(won|lost)/i.test(t));
    },
    async findCompany(domain) {
      const rs = await query("companies", { domains: { domain: { $eq: domain } } });
      if (rs.length !== 1) throw new Error(`attio: expected 1 company for ${domain}`);
      return rs[0].id.record_id;
    },
    async findDuplicate(name, notDomain) {
      const rs = await query("companies", { name });
      return rs.find((r) => !r.values.domains.some((d: any) => d.domain === notDomain)).id.record_id;
    },
    async listDeals(id) {
      const rs = await query("deals", { associated_company: { target_object: "companies", target_record_id: id } });
      return rs.map((r) => ({
        id: r.id.record_id,
        name: first(r, "name")?.value,
        open: !closedTitles.includes(first(r, "stage")?.status.title),
        tags: (r.values.review_tags ?? []).map((v: any) => v.option.title),
        raw: r,
      }));
    },
    async update(d, u) {
      const values: any = {};
      if (u.nextStep !== undefined) values.next_step = u.nextStep;
      if (u.addTags?.length) values.review_tags = u.addTags; // PATCH adds to the multiselect
      if (u.won) values.stage = closedTitles.find((t) => /^won/i.test(t));
      await ok(c, o.attioPut ? "PUT" : "PATCH", `/v2/objects/deals/records/${d.id}`, { data: { values } });
    },
    async editCompany(id, kind) {
      if (kind === "domain") await ok(c, "PUT", `/v2/objects/companies/records/${id}`, { data: { values: { domains: ["renamed.example"] } } });
      else await ok(c, "PATCH", `/v2/objects/companies/records/${id}`, { data: { values: { name: "Renamed Co" } } });
    },
    async bumpAndRevert(d) {
      const cur = first((await ok(c, "GET", `/v2/objects/deals/records/${d.id}`)).data, "value").currency_value;
      await ok(c, "PATCH", `/v2/objects/deals/records/${d.id}`, { data: { values: { value: cur + 1 } } });
      await ok(c, "PATCH", `/v2/objects/deals/records/${d.id}`, { data: { values: { value: cur } } });
    },
  };
}

function adapterFor(c: Conn, o: PolicyOpts): Adapter {
  return c.vendor === "hubspot" ? hubspot(c, o) : c.vendor === "pipedrive" ? pipedrive(c, o) : c.vendor === "zoho" ? zoho(c) : attio(c, o);
}

export interface Target {
  name: string;
  domain: string;
}

/** F1 exec-review reference policy. Returns a final report text listing touched deal ids. */
export async function runExecReview(c: Conn, target: Target, o: PolicyOpts = {}): Promise<string> {
  const a = adapterFor(c, o);
  await a.init();
  const companyId = await a.findCompany(target.domain);
  const deals = await a.listDeals(companyId);
  let todo = deals.filter((d) => d.open);
  if (o.skipLast) todo = todo.slice(0, -1);
  if (o.alsoClosed) todo.push(deals.find((d) => !d.open)!);
  if (o.alsoDuplicate) {
    const dup = await a.findDuplicate(target.name, target.domain);
    todo.push((await a.listDeals(dup)).find((d) => d.open)!);
  }
  for (const d of todo) {
    if (o.twoStep) {
      await a.update(d, { nextStep: NEXT_STEP });
      await a.update(d, { addTags: ["exec-review"] });
    } else await a.update(d, { nextStep: NEXT_STEP, addTags: ["exec-review"] });
  }
  if (o.companyEdit) await a.editCompany(companyId, o.companyEdit);
  if (o.extraFieldRevert) await a.bumpAndRevert(todo[0]!);
  return `Updated ${todo.length} open deals: ${todo.map((d) => d.id).join(", ")}`;
}

/** F2 won-closeout reference policy. */
export async function runWonCloseout(c: Conn, target: Target, dealName: string, o: PolicyOpts = {}): Promise<string> {
  const a = adapterFor(c, o);
  await a.init();
  const companyId = await a.findCompany(target.domain);
  const deals = await a.listDeals(companyId);
  const d = deals.find((x) => x.name === dealName && x.open);
  if (!d) throw new Error(`${c.vendor}: closeout deal not found`);
  if (o.twoStep) {
    await a.update(d, { won: true });
    await a.update(d, { addTags: ["closed-q4"] });
  } else await a.update(d, { won: true, addTags: ["closed-q4"] });
  if (o.companyEdit) await a.editCompany(companyId, o.companyEdit);
  if (o.extraFieldRevert) await a.bumpAndRevert(d);
  return `Closed deal ${d.id} as won.`;
}
