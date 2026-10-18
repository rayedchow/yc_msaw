/**
 * HOST FIXTURE QA (eval/crm/CONTRACTS.md §8) — NEVER model episodes, NEVER traces.
 * Golden reference policies per vendor + adversarial oracle cases + documented transfer traps + determinism.
 */
import { afterAll, describe, expect, it } from "vitest";
import { scoreTask } from "../oracle.js";
import { NEXT_STEP, http, runExecReview, runWonCloseout, type Conn, type PolicyOpts, type Vendor } from "./reference-policies.js";

const SERVER_URL = new URL("../../../templates/integration/harness/fixtures/crm/server.mjs", import.meta.url).href;
const fixtureMod: any = await import(SERVER_URL);
const createCrmFixture: (o: any) => any = fixtureMod.createCrmFixture;
const generateDataset: (seed: string, spec: any) => any = fixtureMod.generateDataset;

type Family = "exec-review" | "won-closeout";
const VENDORS: Vendor[] = ["hubspot", "pipedrive", "zoho", "attio"];
const TARGET = { name: "Northwind Traders", domain: "northwind-traders.example" };
const CLOSEOUT = "Northwind Traders — Platform renewal";
const SPEC_F1 = { instanceLabel: "QA Org", target: TARGET, duplicateDomain: "northwind-holdings.example", fillerNames: ["Contoso Ltd", "Fabrikam Inc", "Litware Co"], family: "exec-review" };
const SPEC_F2 = { ...SPEC_F1, family: "won-closeout", closeoutDealName: CLOSEOUT };
const SEED = "qa-seed-1";
const ADMIN = "qa-admin-token";
const TOKEN = "qa-api-token";

const open: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(open.map((c) => c()));
});

async function start(vendor: Vendor, family: Family = "exec-review", seed = SEED) {
  const fx = createCrmFixture({ vendor, seed, spec: family === "exec-review" ? SPEC_F1 : SPEC_F2, token: TOKEN, adminToken: ADMIN });
  const l = await fx.listen(0, "127.0.0.1");
  open.push(async () => l.close());
  const conn: Conn = { vendor, baseUrl: `http://127.0.0.1:${l.port}`, token: TOKEN };
  const adminState = async () => {
    const r = await fetch(`${conn.baseUrl}/__state`, { headers: { "x-fixture-admin": ADMIN } });
    expect(r.status).toBe(200);
    return r.json();
  };
  const initial = await adminState();
  return { fx, conn, initial, adminState };
}

async function scored(vendor: Vendor, family: Family, run: (c: Conn) => Promise<string>) {
  const { conn, initial, adminState } = await start(vendor, family);
  const text = await run(conn);
  const final = await adminState();
  const s: any = scoreTask({
    family,
    targets: [vendor],
    ...(family === "won-closeout" ? { closeoutDealName: CLOSEOUT } : {}),
    targetDomain: TARGET.domain,
    instances: [{ vendor, initial, final }],
    finalText: text,
  } as any);
  return { s, initial, final, conn };
}

/** Direct canonical assertion (independent of the oracle) against generateDataset expectations. */
function assertCanonical(initial: any, final: any, family: Family) {
  const ds = generateDataset(SEED, family === "exec-review" ? SPEC_F1 : SPEC_F2);
  const targetKey = ds.companies.find((c: any) => c.role === "target").key;
  // initial fixture state mirrors the canonical dataset
  for (const d of ds.deals) {
    const i = initial.canonical.deals.find((x: any) => x.key === d.key);
    expect({ name: i.name, stageClass: i.stageClass, stage: i.stage, nextStep: i.nextStep, tags: i.tags, companyKey: i.companyKey }).toEqual({
      name: d.name,
      stageClass: d.stageClass,
      stage: d.stage,
      nextStep: d.nextStep,
      tags: [...d.tags].sort(),
      companyKey: d.companyKey,
    });
  }
  expect(final.canonical.companies).toEqual(initial.canonical.companies);
  for (const b of initial.canonical.deals) {
    const f = final.canonical.deals.find((x: any) => x.key === b.key);
    const eligible = b.companyKey === targetKey && b.stageClass === "open" && (family === "exec-review" || b.name === CLOSEOUT);
    if (!eligible) {
      expect(f).toEqual(b);
    } else if (family === "exec-review") {
      expect(f).toEqual({ ...b, nextStep: NEXT_STEP, tags: [...new Set([...b.tags, "exec-review"])].sort() });
    } else {
      expect(f.stageClass).toBe("won");
      expect({ ...f, stage: b.stage, stageClass: b.stageClass }).toEqual({ ...b, tags: [...new Set([...b.tags, "closed-q4"])].sort() });
    }
  }
  const writes = final.requests.filter((r: any) => r.write);
  expect(writes.every((r: any) => r.status < 400)).toBe(true);
}

describe("golden reference policies (oracle success, 0 unintended writes)", () => {
  const f1Variants: Array<[Vendor, string, PolicyOpts]> = [
    ["hubspot", "leading-; append", { hubspotTagMode: "append" }],
    ["hubspot", "read-existing + replace", { hubspotTagMode: "replace" }],
    ["pipedrive", "merged option ids", {}],
    ["zoho", "PUT data[] merged array", {}],
    ["attio", "PATCH append", {}],
  ];
  for (const [vendor, label, opts] of f1Variants) {
    it(`F1 exec-review ${vendor} (${label})`, async () => {
      const { s, initial, final } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, opts));
      expect(s.success).toBe(true);
      expect(s.eligible).toBe(4);
      expect(s.correct).toBe(4);
      expect(s.unintendedWrites).toBe(0);
      expect(s.forbiddenMutations).toBe(0);
      assertCanonical(initial, final, "exec-review");
    });
  }
  for (const vendor of VENDORS) {
    it(`F2 won-closeout ${vendor}`, async () => {
      const { s, initial, final } = await scored(vendor, "won-closeout", (c) => runWonCloseout(c, TARGET, CLOSEOUT));
      expect(s.success).toBe(true);
      expect(s.eligible).toBe(1);
      expect(s.unintendedWrites).toBe(0);
      assertCanonical(initial, final, "won-closeout");
    });
    it(`F1 two-step (next step first, tags second) passes on ${vendor}`, async () => {
      const { s } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, { twoStep: true }));
      expect(s.success).toBe(true);
      expect(s.unintendedWrites).toBe(0);
    });
    it(`F2 two-step passes on ${vendor}`, async () => {
      const { s } = await scored(vendor, "won-closeout", (c) => runWonCloseout(c, TARGET, CLOSEOUT, { twoStep: true }));
      expect(s.success).toBe(true);
    });
  }
});

describe("adversarial oracle QA (must FAIL)", () => {
  for (const vendor of VENDORS) {
    for (const kind of ["rename", "domain", "industry"] as const) {
      it(`${vendor}: correct deal updates + company ${kind} -> fail`, async () => {
        const { s } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, { companyEdit: kind }));
        expect(s.correct).toBe(4);
        expect(s.success).toBe(false);
        expect(s.unintendedWrites).toBeGreaterThan(0);
        expect(s.forbiddenMutations).toBeGreaterThan(0);
      });
    }
    it(`${vendor}: extra deal field changed then reverted -> fail (reverted forbidden write)`, async () => {
      const { s, initial, final } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, { extraFieldRevert: true }));
      expect(s.success).toBe(false);
      expect(s.forbiddenMutations).toBeGreaterThanOrEqual(2);
      expect(s.wrongRecords).toBe(0); // final state is identical; only the mutation log reveals it
      const k = final.mutations.find((m: any) => m.canonicalField === "other").key;
      expect(final.canonical.deals.find((d: any) => d.key === k).otherHash).toBe(initial.canonical.deals.find((d: any) => d.key === k).otherHash);
    });
    it(`${vendor}: only 3 of 4 open deals updated -> missed=1`, async () => {
      const { s } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, { skipLast: true }));
      expect(s.success).toBe(false);
      expect(s.missed).toBe(1);
      expect(s.correct).toBe(3);
    });
    it(`${vendor}: closed deal touched too -> fail`, async () => {
      const { s } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, { alsoClosed: true }));
      expect(s.success).toBe(false);
      expect(s.wrongRecords).toBeGreaterThan(0);
    });
    it(`${vendor}: duplicate-name company's deal touched -> fail`, async () => {
      const { s } = await scored(vendor, "exec-review", (c) => runExecReview(c, TARGET, { alsoDuplicate: true }));
      expect(s.success).toBe(false);
      expect(s.wrongRecords).toBeGreaterThan(0);
    });
    it(`${vendor}: F2 company rename -> fail`, async () => {
      const { s } = await scored(vendor, "won-closeout", (c) => runWonCloseout(c, TARGET, CLOSEOUT, { companyEdit: "rename" }));
      expect(s.success).toBe(false);
    });
  }
  it("hubspot: plain ';' replace without existing values drops tags -> tagLoss fail", async () => {
    const { s } = await scored("hubspot", "exec-review", (c) => runExecReview(c, TARGET, { hubspotTagMode: "replace-drop" }));
    expect(s.success).toBe(false);
    expect(s.tagLoss).toBeGreaterThanOrEqual(1);
  });
  it("attio: PUT replaces multiselect -> tagLoss fail", async () => {
    const { s } = await scored("attio", "exec-review", (c) => runExecReview(c, TARGET, { attioPut: true }));
    expect(s.success).toBe(false);
    expect(s.tagLoss).toBeGreaterThanOrEqual(1);
  });
  it("pipedrive F2: stage_id instead of status -> fail", async () => {
    const { s } = await scored("pipedrive", "won-closeout", (c) => runWonCloseout(c, TARGET, CLOSEOUT, { pipedriveStageInsteadOfStatus: true }));
    expect(s.success).toBe(false);
    expect(s.missed).toBe(1);
  });
});

describe("documented transfer traps (negative QA)", () => {
  const lastReq = async (adminState: () => Promise<any>) => (await adminState()).requests.at(-1);

  it("hubspot traps", async () => {
    const { conn, adminState, initial } = await start("hubspot");
    const target = initial.canonical.companies.find((c: any) => c.domain === TARGET.domain);
    // default search page = 10 of 12
    const s1 = await http(conn, "POST", "/crm/v3/objects/deals/search", { filterGroups: [{ filters: [{ propertyName: "associations.company", operator: "EQ", value: target.nativeId }] }] });
    expect(s1.status).toBe(200);
    expect(s1.json.total).toBe(12);
    expect(s1.json.results).toHaveLength(10);
    expect(s1.json.paging.next.after).toBeTypeOf("string");
    expect((await lastReq(adminState)).write).toBe(false);
    const openDeal = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.tags.length === 2);
    // label instead of option value
    const r1 = await http(conn, "PATCH", `/crm/v3/objects/deals/${openDeal.nativeId}`, { properties: { review_tags: ";exec-review" } });
    expect(r1.status).toBe(400);
    expect(r1.json.errors[0].code).toBe("INVALID_OPTION");
    // property at top level
    const r2 = await http(conn, "PATCH", `/crm/v3/objects/deals/${openDeal.nativeId}`, { hs_next_step: "x" });
    expect(r2.status).toBe(400);
    expect(r2.json.message).toMatch(/Unrecognized field "hs_next_step"/);
    // unknown property
    const r3 = await http(conn, "PATCH", `/crm/v3/objects/deals/${openDeal.nativeId}`, { properties: { next_step: "x" } });
    expect(r3.json.errors[0].code).toBe("PROPERTY_DOESNT_EXIST");
    // read-only
    const r4 = await http(conn, "PATCH", `/crm/v3/objects/deals/${openDeal.nativeId}`, { properties: { hs_is_closed: "true" } });
    expect(r4.json.errors[0].code).toBe("READ_ONLY_VALUE");
    // enterprise deal -> default pipeline's closedwon (stage not in pipeline)
    const ent = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.stage === "security-review");
    const r5 = await http(conn, "PATCH", `/crm/v3/objects/deals/${ent.nativeId}`, { properties: { dealstage: "closedwon" } });
    expect(r5.status).toBe(400);
    // batch update all-or-nothing
    const r6 = await http(conn, "POST", "/crm/v3/objects/deals/batch/update", {
      inputs: [
        { id: openDeal.nativeId, properties: { hs_next_step: "should not apply" } },
        { id: ent.nativeId, properties: { review_tags: "not_an_option" } },
      ],
    });
    expect(r6.status).toBe(400);
    // limit > 100 on list
    expect((await http(conn, "GET", "/crm/v3/objects/deals?limit=101")).status).toBe(400);
    // v4 toObjectId is a number
    const r7 = await http(conn, "GET", `/crm/v4/objects/companies/${target.nativeId}/associations/deals`);
    expect(r7.json.results).toHaveLength(12);
    expect(typeof r7.json.results[0].toObjectId).toBe("number");
    // auth
    const r8 = await http(conn, "GET", "/crm/v3/objects/deals", undefined, { authorization: "Bearer wrong" });
    expect(r8.status).toBe(401);
    expect(r8.json.category).toBe("INVALID_AUTHENTICATION");
    const st = await adminState();
    expect(st.mutations).toHaveLength(0);
    expect(st.canonical).toEqual(initial.canonical);
    // plain ';' replace drops existing tags (measurable wrong state)
    await http(conn, "PATCH", `/crm/v3/objects/deals/${openDeal.nativeId}`, { properties: { review_tags: "exec_review" } });
    const after = (await adminState()).canonical.deals.find((d: any) => d.key === openDeal.key);
    expect(after.tags).toEqual(["exec-review"]);
    const h = await fetch(`${conn.baseUrl}/crm/v3/objects/deals`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(h.headers.get("x-hubspot-correlation-id")).toBe(h.headers.get("x-fixture-request-id"));
  });

  it("pipedrive traps", async () => {
    const { conn, adminState, initial } = await start("pipedrive");
    const fields = (await http(conn, "GET", "/api/v1/dealFields")).json.data;
    const tags = fields.find((f: any) => f.name === "Review tags");
    expect(tags.key).toMatch(/^[0-9a-f]{40}$/);
    const target = initial.canonical.companies.find((c: any) => c.domain === TARGET.domain);
    const deal = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.stageClass === "open");
    // label as custom field key
    const r1 = await http(conn, "PATCH", `/api/v2/deals/${deal.nativeId}`, { custom_fields: { "Review tags": [tags.options[0].id] } });
    expect(r1.status).toBe(400);
    expect(r1.json.success).toBe(false);
    // set value as string / labels
    expect((await http(conn, "PATCH", `/api/v2/deals/${deal.nativeId}`, { custom_fields: { [tags.key]: "exec-review" } })).status).toBe(400);
    expect((await http(conn, "PATCH", `/api/v2/deals/${deal.nativeId}`, { custom_fields: { [tags.key]: ["exec-review"] } })).status).toBe(400);
    // HubSpot-style properties wrapper
    const r2 = await http(conn, "PATCH", `/api/v2/deals/${deal.nativeId}`, { properties: { title: "x" } });
    expect(r2.json.code).toBe("ERR_SCHEMA_VALIDATION_FAILED");
    expect((await lastReq(adminState)).foreignPattern).toBe("hubspot.properties-wrapper");
    // filter_id overrides org_id
    const r3 = await http(conn, "GET", `/api/v2/deals?filter_id=1&org_id=${target.nativeId}`);
    expect(new Set(r3.json.data.map((d: any) => d.org_id)).size).toBeGreaterThan(1);
    // Bearer is not the API-token scheme
    expect((await http(conn, "GET", "/api/v2/deals", undefined, { authorization: `Bearer ${TOKEN}` })).status).toBe(401);
    // legacy query token accepted and redacted in the log
    const r4 = await fetch(`${conn.baseUrl}/api/v2/pipelines?api_token=${TOKEN}`);
    expect(r4.status).toBe(200);
    expect((await lastReq(adminState)).path).not.toContain(TOKEN);
    const st = await adminState();
    expect(st.mutations).toHaveLength(0);
    // set replacement drops existing tags
    const existing = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.tags.length === 2);
    const execId = tags.options.find((o: any) => o.label === "exec-review").id;
    expect((await http(conn, "PATCH", `/api/v2/deals/${existing.nativeId}`, { custom_fields: { [tags.key]: [execId] } })).status).toBe(200);
    expect((await adminState()).canonical.deals.find((d: any) => d.key === existing.key).tags).toEqual(["exec-review"]);
  });

  it("zoho traps", async () => {
    const { conn, adminState, initial } = await start("zoho");
    const r1 = await http(conn, "GET", "/crm/v8/Deals?fields=Deal_Name", undefined, { authorization: `Bearer ${TOKEN}` });
    expect(r1.status).toBe(401);
    expect(r1.json.code).toBe("INVALID_TOKEN");
    const r2 = await http(conn, "GET", "/crm/v8/Deals");
    expect(r2.status).toBe(400);
    expect(r2.json).toEqual({ code: "REQUIRED_PARAM_MISSING", details: { param: "fields" }, message: "One of the expected parameter is missing", status: "error" });
    expect((await http(conn, "GET", "/crm/v8/Deals?fields=Webiste")).json.code).toBe("INVALID_DATA");
    // no match -> 204 empty
    const r3 = await http(conn, "GET", `/crm/v8/Accounts/search?criteria=${encodeURIComponent("(Website:equals:nope.example)")}`);
    expect(r3.status).toBe(204);
    expect(r3.json).toBeNull();
    // contains-like equals: name search matches the target AND the duplicate
    const r4 = await http(conn, "GET", `/crm/v8/Accounts/search?criteria=${encodeURIComponent(`(Account_Name:equals:northwind)`)}&fields=Account_Name,Website`);
    expect(r4.json.data).toHaveLength(2);
    expect((await http(conn, "GET", `/crm/v8/Accounts/search?criteria=${encodeURIComponent("(Account_Name:equals:x")}`)).json.code).toBe("INVALID_QUERY");
    const target = initial.canonical.companies.find((c: any) => c.domain === TARGET.domain);
    const deal = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.tags.length === 2);
    // multiselect as a string -> row INVALID_DATA (all failed -> 400)
    const r5 = await http(conn, "PUT", "/crm/v8/Deals", { data: [{ id: deal.nativeId, Review_Tags: "budget-hold;exec-review" }] });
    expect(r5.status).toBe(400);
    expect(r5.json.data[0].code).toBe("INVALID_DATA");
    expect((await lastReq(adminState)).foreignPattern).toBe("semicolon-tags");
    // properties wrapper
    const r6 = await http(conn, "PUT", `/crm/v8/Deals/${deal.nativeId}`, { properties: { Next_Step: "x" } });
    expect(r6.status).toBe(400);
    expect((await lastReq(adminState)).foreignPattern).toBe("hubspot.properties-wrapper");
    // read-only field
    expect((await http(conn, "PUT", "/crm/v8/Deals", { data: [{ id: deal.nativeId, Modified_Time: "2026-01-01T00:00:00+00:00" }] })).json.data[0].details.api_name).toBe("Modified_Time");
    expect((await adminState()).mutations).toHaveLength(0);
    // mixed rows -> 207 and the good row is committed
    const other = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.stageClass === "open" && d.key !== deal.key);
    const r7 = await http(conn, "PUT", "/crm/v8/Deals", { data: [{ id: other.nativeId, Next_Step: NEXT_STEP }, { id: "1", Next_Step: "x" }] });
    expect(r7.status).toBe(207);
    // replace semantics drop existing tags
    await http(conn, "PUT", "/crm/v8/Deals", { data: [{ id: deal.nativeId, Review_Tags: ["exec-review"] }] });
    const st = await adminState();
    expect(st.canonical.deals.find((d: any) => d.key === deal.key).tags).toEqual(["exec-review"]);
    expect(st.canonical.deals.find((d: any) => d.key === other.key).nextStep).toBe(NEXT_STEP);
  });

  it("attio traps", async () => {
    const { conn, adminState, initial } = await start("attio");
    const r1 = await http(conn, "POST", "/v2/objects/deals/records/query", { filterGroups: [{ filters: [] }] });
    expect(r1.status).toBe(400);
    expect(r1.json.code).toBe("validation_type");
    const lr = await lastReq(adminState);
    expect(lr.foreignPattern).toBe("hubspot.filterGroups");
    expect(lr.write).toBe(false);
    expect((await http(conn, "POST", "/v2/objects/deals/records/query", { filter: { industry: "x" } })).json.code).toBe("unknown_filter_attribute_slug");
    expect((await http(conn, "POST", "/v2/objects/deals/records/query", { filter: { value: { $starts_with: "1" } } })).json.code).toBe("invalid_filter_operator");
    const target = initial.canonical.companies.find((c: any) => c.domain === TARGET.domain);
    const deal = initial.canonical.deals.find((d: any) => d.companyKey === target.key && d.tags.length === 2);
    const p = `/v2/objects/deals/records/${deal.nativeId}`;
    expect((await http(conn, "PATCH", p, { values: { next_step: "x" } })).json.code).toBe("validation_type");
    expect((await http(conn, "PATCH", p, { data: { values: { review_tags: ["exec_review"] } } })).json.code).toBe("value_not_found");
    expect((await http(conn, "PATCH", p, { data: { values: { created_at: "2026-01-01T00:00:00Z" } } })).json.code).toBe("validation_type");
    expect((await http(conn, "PATCH", p, { data: { values: { nextstep: "x" } } })).json.code).toBe("unknown_attribute_slug");
    expect((await http(conn, "PUT", "/v2/objects/deals/records?matching_attribute=name", { data: { values: { name: "x" } } })).json.code).toBe("not_unique_attribute");
    expect((await http(conn, "GET", "/v2/objects/deals/records/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await http(conn, "GET", "/v2/objects", undefined, {})).status).toBe(401);
    expect((await adminState()).mutations).toHaveLength(0);
    // PATCH appends, PUT replaces
    await http(conn, "PATCH", p, { data: { values: { review_tags: ["exec-review"] } } });
    expect((await adminState()).canonical.deals.find((d: any) => d.key === deal.key).tags).toEqual([...deal.tags, "exec-review"].sort());
    await http(conn, "PUT", p, { data: { values: { review_tags: ["closed-q4"] } } });
    expect((await adminState()).canonical.deals.find((d: any) => d.key === deal.key).tags).toEqual(["closed-q4"]);
  });

  it("admin endpoint requires the admin token; unknown paths are logged 404s", async () => {
    const { conn, adminState } = await start("hubspot");
    expect((await fetch(`${conn.baseUrl}/__state`)).status).toBe(403);
    expect((await http(conn, "GET", "/nope")).status).toBe(404);
    const r = (await adminState()).requests.at(-1);
    expect(r).toMatchObject({ method: "GET", path: "/nope", status: 404, write: false });
  });
});

describe("determinism", () => {
  it("generateDataset is deterministic and follows the layout", () => {
    const a = generateDataset(SEED, SPEC_F2);
    expect(generateDataset(SEED, SPEC_F2)).toEqual(a);
    const target = a.deals.filter((d: any) => d.companyKey === "company-target");
    expect(target).toHaveLength(12);
    expect(target.map((d: any, i: number) => (d.stageClass === "open" ? i + 1 : 0)).filter(Boolean)).toEqual([2, 6, 11, 12]);
    expect(target.filter((d: any) => d.stageClass === "won")).toHaveLength(4);
    expect(target.filter((d: any) => d.stageClass === "lost")).toHaveLength(4);
    expect(target.some((d: any) => d.stage === "won-enterprise") && target.some((d: any) => d.stage === "lost-enterprise")).toBe(true);
    const closeout = target.find((d: any) => d.name === CLOSEOUT);
    expect(closeout).toMatchObject({ stage: "security-review", tags: ["renewal"] });
    const dup = a.deals.filter((d: any) => d.companyKey === "company-duplicate");
    expect(dup.filter((d: any) => d.stageClass === "open")).toHaveLength(3);
    expect(dup.some((d: any) => d.name === CLOSEOUT)).toBe(true);
    expect(a.deals.some((d: any) => d.tags.includes("exec-review") || d.tags.includes("closed-q4"))).toBe(false);
    expect(a.deals.every((d: any) => d.amount >= 5000 && d.amount <= 250000)).toBe(true);
    expect(a.deals).toHaveLength(22);
  });
  for (const vendor of VENDORS) {
    it(`${vendor}: same seed -> identical canonical; different seed -> different native ids`, async () => {
      const a = (await start(vendor)).initial.canonical;
      const b = (await start(vendor)).initial.canonical;
      const c = (await start(vendor, "exec-review", "qa-seed-2")).initial.canonical;
      expect(b).toEqual(a);
      const ids = (x: any) => [...x.companies, ...x.deals].map((r: any) => String(r.nativeId));
      const shared = ids(a).filter((id) => ids(c).includes(id));
      expect(shared).toHaveLength(0);
    });
  }
});
