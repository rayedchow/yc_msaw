// SYNTHETIC CONTRACT FIXTURE — HubSpot CRM API v3 objects/search/properties/pipelines + v4 associations (subset).
// Written from the public docs cited in eval/crm/CONTRACTS.md §4. Not an integration certification.
import { TAG_OPTIONS, createRng, createdIso, decodeCursor, encodeCursor, hashOther, intParam, isPlainObject, nowIso, pickCanonicalStage, reply, seedCloseIso } from "./common.mjs";

const AUTH_MESSAGE =
  "Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview";
const tagValue = (t) => t.replace(/-/g, "_");
const TAG_VALUES = TAG_OPTIONS.map(tagValue);
const tagFromValue = (v) => TAG_OPTIONS[TAG_VALUES.indexOf(v)] ?? v;

const DEAL_DEFAULT = ["amount", "closedate", "createdate", "dealname", "dealstage", "hs_lastmodifieddate", "hs_object_id", "pipeline"];
const COMPANY_DEFAULT = ["createdate", "domain", "hs_lastmodifieddate", "hs_object_id", "name"];
const TYPE_ALIASES = { companies: "companies", company: "companies", deals: "deals", deal: "deals", "0-2": "companies", "0-3": "deals" };

export function createHubspot(ctx) {
  const rng = createRng(ctx.seed, "hubspot");
  const ds = ctx.dataset;

  // ---- pipelines (default ids are HubSpot's fixed internal ids; enterprise ids are seeded numerics)
  const entId = String(rng.int(700_000_000, 899_999_999));
  let stageBase = rng.int(100_000_000, 699_999_999);
  const sid = () => String((stageBase += rng.int(1, 40)));
  const pipelines = [
    {
      id: "default",
      label: "Sales Pipeline",
      displayOrder: 0,
      stages: [
        { id: "appointmentscheduled", label: "Appointment Scheduled", isClosed: false, probability: "0.2", canon: ["qualify"] },
        { id: "qualifiedtobuy", label: "Qualified To Buy", isClosed: false, probability: "0.4", canon: ["propose"] },
        { id: "contractsent", label: "Contract Sent", isClosed: false, probability: "0.9", canon: ["negotiate"] },
        { id: "closedwon", label: "Closed Won", isClosed: true, probability: "1.0", canon: ["won-default"] },
        { id: "closedlost", label: "Closed Lost", isClosed: true, probability: "0.0", canon: ["lost-default"] },
      ],
    },
    {
      id: entId,
      label: "Enterprise",
      displayOrder: 1,
      stages: [
        { id: sid(), label: "Discovery", isClosed: false, probability: "0.1", canon: ["discovery"] },
        { id: sid(), label: "Security review", isClosed: false, probability: "0.6", canon: ["security-review"] },
        { id: sid(), label: "Closed won (Enterprise)", isClosed: true, probability: "1.0", canon: ["won-enterprise"] },
        { id: sid(), label: "Closed lost (Enterprise)", isClosed: true, probability: "0.0", canon: ["lost-enterprise"] },
      ],
    },
  ];
  const stageById = new Map();
  for (const p of pipelines) p.stages.forEach((s, i) => stageById.set(s.id, { ...s, pipelineId: p.id, displayOrder: i }));
  const stageForCanon = (c) => [...stageById.values()].find((s) => s.canon.includes(c));

  // ---- records
  let companyId = rng.int(15_000_000_000, 39_000_000_000);
  const companies = ds.companies.map((c) => ({
    key: c.key,
    id: String((companyId += rng.int(1, 5000))),
    createdAt: createdIso(c.createdOrder - 10),
    updatedAt: createdIso(c.createdOrder - 10),
    props: { name: c.name, domain: c.domain, industry: c.role === "target" || c.role === "duplicate" ? "Wholesale" : "Software" },
  }));
  const companyByKey = new Map(companies.map((c) => [c.key, c]));
  let dealId = rng.int(40_000_000_000, 69_000_000_000);
  const deals = ds.deals.map((d) => {
    const st = stageForCanon(d.stage);
    const closed = st.isClosed;
    return {
      key: d.key,
      companyKey: d.companyKey,
      initialStage: d.stage,
      id: String((dealId += rng.int(1, 5000))),
      createdAt: createdIso(d.createdOrder),
      updatedAt: createdIso(d.createdOrder),
      closedateAuto: false,
      props: {
        dealname: d.name,
        amount: String(d.amount),
        pipeline: st.pipelineId,
        dealstage: st.id,
        closedate: closed ? seedCloseIso(d.createdOrder) : null,
        hs_next_step: d.nextStep,
        review_tags: d.tags.length ? d.tags.map(tagValue).join(";") : null,
        description: null,
      },
    };
  });
  const store = { companies, deals };

  // ---- property definitions
  const opt = (label, value, i) => ({ label, value, displayOrder: i, hidden: false });
  const prop = (name, label, type, fieldType, groupName, extra = {}) => ({
    name,
    label,
    type,
    fieldType,
    description: extra.description ?? "",
    groupName,
    options: extra.options ?? [],
    calculated: extra.calculated ?? false,
    hasUniqueValue: false,
    modificationMetadata: { readOnlyValue: extra.readOnly ?? false },
  });
  const boolOpts = [opt("True", "true", 0), opt("False", "false", 1)];
  const PROPS = {
    deals: [
      prop("amount", "Amount", "number", "number", "dealinformation"),
      prop("closedate", "Close Date", "datetime", "date", "dealinformation"),
      prop("createdate", "Create Date", "datetime", "date", "dealinformation", { readOnly: true }),
      prop("dealname", "Deal Name", "string", "text", "dealinformation"),
      prop("dealstage", "Deal Stage", "enumeration", "radio", "dealinformation", {
        options: [...stageById.values()].map((s, i) => opt(s.label, s.id, i)),
      }),
      prop("description", "Deal Description", "string", "textarea", "dealinformation"),
      prop("hs_is_closed", "Is Deal Closed?", "bool", "booleancheckbox", "dealinformation", { calculated: true, readOnly: true, options: boolOpts }),
      prop("hs_is_closed_won", "Is Closed Won", "bool", "booleancheckbox", "dealinformation", { calculated: true, readOnly: true, options: boolOpts }),
      prop("hs_lastmodifieddate", "Last Modified Date", "datetime", "date", "dealinformation", { readOnly: true }),
      prop("hs_next_step", "Next step", "string", "textarea", "dealinformation"),
      prop("hs_object_id", "Record ID", "number", "number", "dealinformation", { readOnly: true }),
      prop("pipeline", "Pipeline", "enumeration", "select", "dealinformation", { options: pipelines.map((p, i) => opt(p.label, p.id, i)) }),
      prop("review_tags", "Review tags", "enumeration", "checkbox", "dealinformation", {
        description: "Review tags for deal desk follow-up.",
        options: TAG_OPTIONS.map((t, i) => opt(t, tagValue(t), i)),
      }),
    ],
    companies: [
      prop("createdate", "Create Date", "datetime", "date", "companyinformation", { readOnly: true }),
      prop("domain", "Company Domain Name", "string", "text", "companyinformation"),
      prop("hs_lastmodifieddate", "Last Modified Date", "datetime", "date", "companyinformation", { readOnly: true }),
      prop("hs_object_id", "Record ID", "number", "number", "companyinformation", { readOnly: true }),
      // fixture-approximation: industry modelled as free text (real HubSpot uses an enumeration).
      prop("industry", "Industry", "string", "text", "companyinformation"),
      prop("name", "Name", "string", "text", "companyinformation"),
    ],
  };
  const propDef = (type, name) => PROPS[type].find((p) => p.name === name);

  // ---- helpers
  const err = (status, category, message, errors) =>
    reply(status, { status: "error", message, correlationId: ctx.requestId, category, ...(errors ? { errors } : {}) }, {}, category);
  const validation = (message, errors) => err(400, "VALIDATION_ERROR", message, errors);
  const notFoundObj = () => err(404, "OBJECT_NOT_FOUND", "resource not found");
  const resolveType = (t) => {
    const r = TYPE_ALIASES[t];
    if (!r) throw err(404, "OBJECT_NOT_FOUND", `Unable to infer object type from: ${t}`);
    return r;
  };
  const findRec = (type, id) => store[type].find((r) => r.id === String(id));

  function readProp(type, rec, name) {
    if (name === "hs_object_id") return rec.id;
    if (name === "createdate") return rec.createdAt;
    if (name === "hs_lastmodifieddate") return rec.updatedAt;
    if (type === "deals") {
      const st = stageById.get(rec.props.dealstage);
      if (name === "hs_is_closed") return String(st.isClosed);
      if (name === "hs_is_closed_won") return String(st.isClosed && st.probability === "1.0");
    }
    const v = rec.props[name];
    return v === undefined ? null : v;
  }
  const parseProps = (raw, type) => {
    if (raw === null || raw === undefined) return type === "deals" ? DEAL_DEFAULT : COMPANY_DEFAULT;
    const list = (Array.isArray(raw) ? raw : String(raw).split(",")).map((s) => String(s).trim()).filter(Boolean);
    return list.filter((n) => propDef(type, n)); // unknown names are silently omitted
  };
  function serialize(type, rec, names, assocTypes = []) {
    const properties = {};
    for (const n of names) properties[n] = readProp(type, rec, n);
    for (const n of ["hs_object_id", "createdate", "hs_lastmodifieddate"]) if (!(n in properties)) properties[n] = readProp(type, rec, n);
    const out = { id: rec.id, properties, createdAt: rec.createdAt, updatedAt: rec.updatedAt, archived: false };
    if (assocTypes.length) {
      const associations = {};
      for (const a of assocTypes) {
        const at = TYPE_ALIASES[a];
        if (type === "deals" && at === "companies") {
          associations.companies = { results: [{ id: companyByKey.get(rec.companyKey).id, type: "deal_to_company" }] };
        } else if (type === "companies" && at === "deals") {
          const ds2 = deals.filter((d) => d.companyKey === rec.key);
          if (ds2.length) associations.deals = { results: ds2.map((d) => ({ id: d.id, type: "company_to_deal" })) };
        }
      }
      if (Object.keys(associations).length) out.associations = associations;
    }
    return out;
  }
  const assocList = (q) => (q.get("associations") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  // ---- search
  const OPS = new Set(["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN", "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN"]);
  function filterValue(type, rec, name) {
    if (name === "associations.company") return type === "deals" ? companyByKey.get(rec.companyKey).id : null;
    if (name === "associations.deal") return type === "companies" ? deals.filter((d) => d.companyKey === rec.key).map((d) => d.id).join(";") : null;
    return readProp(type, rec, name);
  }
  const cmpKey = (def, v) => {
    if (v === null || v === undefined || v === "") return null;
    if (def?.type === "number") return Number(v);
    if (def?.type === "datetime") return /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
    return String(v).toLowerCase();
  };
  function matchFilter(type, rec, f) {
    const def = propDef(type, f.propertyName);
    const raw = filterValue(type, rec, f.propertyName);
    const multi = def?.fieldType === "checkbox" || f.propertyName === "associations.deal";
    const vals = raw === null || raw === "" ? [] : multi ? String(raw).split(";") : [raw];
    const keys = vals.map((v) => cmpKey(def, v));
    const one = (v) => cmpKey(def, v);
    switch (f.operator) {
      case "HAS_PROPERTY":
        return keys.length > 0;
      case "NOT_HAS_PROPERTY":
        return keys.length === 0;
      case "EQ":
        return keys.some((k) => k === one(f.value));
      case "NEQ":
        return !keys.some((k) => k === one(f.value));
      case "IN":
        return keys.some((k) => f.values.map(one).includes(k));
      case "NOT_IN":
        return !keys.some((k) => f.values.map(one).includes(k));
      case "LT":
        return keys.some((k) => k < one(f.value));
      case "LTE":
        return keys.some((k) => k <= one(f.value));
      case "GT":
        return keys.some((k) => k > one(f.value));
      case "GTE":
        return keys.some((k) => k >= one(f.value));
      case "BETWEEN":
        return keys.some((k) => k >= one(f.value) && k <= one(f.highValue));
      case "CONTAINS_TOKEN":
      case "NOT_CONTAINS_TOKEN": {
        // fixture-approximation: tokens = whitespace/';'-separated words plus the whole value; '*' is a wildcard.
        const pat = String(f.value ?? "").toLowerCase();
        const re = new RegExp(`^${pat.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        const hit = vals.some((v) => {
          const s = String(v).toLowerCase();
          return re.test(s) || s.split(/[\s;]+/).some((t) => re.test(t));
        });
        return f.operator === "CONTAINS_TOKEN" ? hit : !hit;
      }
      default:
        return false;
    }
  }
  function search(type, body) {
    if (body !== undefined && !isPlainObject(body)) throw validation("Invalid input JSON: expected an object");
    const b = body ?? {};
    const allowed = new Set(["filterGroups", "sorts", "query", "properties", "limit", "after"]);
    for (const k of Object.keys(b)) if (!allowed.has(k)) throw validation(`Invalid input JSON on line 1, column 2: Unrecognized field "${k}"`);
    const limit = b.limit === undefined ? 10 : Number(b.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw validation(`limit must be between 1 and 200, got ${b.limit}`);
    const groups = b.filterGroups ?? [];
    if (!Array.isArray(groups) || groups.length > 5) throw validation("Too many filter groups (maximum 5)");
    for (const g of groups) {
      const fs = g?.filters ?? [];
      if (!Array.isArray(fs) || fs.length > 6) throw validation("Too many filters in a filter group (maximum 6)");
      for (const f of fs) {
        if (!isPlainObject(f) || typeof f.propertyName !== "string" || !OPS.has(f.operator)) throw validation(`Invalid filter: ${JSON.stringify(f)}`);
        const pseudo = (type === "deals" && f.propertyName === "associations.company") || (type === "companies" && f.propertyName === "associations.deal");
        if (!pseudo && !propDef(type, f.propertyName))
          throw validation(`There was a problem with the request.`, [
            { message: `Property "${f.propertyName}" does not exist`, code: "PROPERTY_DOESNT_EXIST", context: { propertyName: [f.propertyName] } },
          ]);
        if ((f.operator === "IN" || f.operator === "NOT_IN") && !Array.isArray(f.values)) throw validation(`Operator ${f.operator} requires "values"`);
        if (f.operator === "BETWEEN" && (f.value === undefined || f.highValue === undefined)) throw validation("Operator BETWEEN requires value and highValue");
        if (!["IN", "NOT_IN", "HAS_PROPERTY", "NOT_HAS_PROPERTY"].includes(f.operator) && f.value === undefined) throw validation(`Operator ${f.operator} requires "value"`);
      }
    }
    let rows = store[type].filter((r) => groups.length === 0 || groups.some((g) => (g.filters ?? []).every((f) => matchFilter(type, r, f))));
    if (typeof b.query === "string" && b.query.trim()) {
      // fixture-approximation: case-insensitive substring over default searchable properties.
      const q = b.query.trim().toLowerCase();
      const fields = type === "deals" ? ["dealname"] : ["name", "domain"];
      rows = rows.filter((r) => fields.some((n) => String(r.props[n] ?? "").toLowerCase().includes(q)));
    }
    const sorts = Array.isArray(b.sorts) ? b.sorts : [];
    const s0 = sorts[0];
    if (s0) {
      const pn = typeof s0 === "string" ? s0.replace(/^-/, "") : s0.propertyName;
      const desc = typeof s0 === "string" ? s0.startsWith("-") : s0.direction === "DESCENDING";
      const def = propDef(type, pn);
      if (!def) throw validation(`Property "${pn}" does not exist`, [{ message: `Property "${pn}" does not exist`, code: "PROPERTY_DOESNT_EXIST", context: { propertyName: [pn] } }]);
      rows = [...rows].sort((a, c) => {
        const x = cmpKey(def, readProp(type, a, pn));
        const y = cmpKey(def, readProp(type, c, pn));
        const r = x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1;
        return desc ? -r : r;
      });
    }
    let offset = 0;
    if (b.after !== undefined && b.after !== null && b.after !== "") {
      // fixture-approximation: search `after` is the offset as a decimal string (opaque to callers).
      if (!/^\d+$/.test(String(b.after))) throw validation(`Invalid after value: ${b.after}`);
      offset = Number(b.after);
    }
    const names = parseProps(b.properties ?? null, type);
    const page = rows.slice(offset, offset + limit);
    const out = { total: rows.length, results: page.map((r) => serialize(type, r, names)) };
    if (offset + limit < rows.length) out.paging = { next: { after: String(offset + limit) } };
    return out;
  }

  // ---- writes (validate everything first, apply later -> atomic)
  const READ_ONLY = new Set(["hs_is_closed", "hs_is_closed_won", "hs_object_id", "createdate", "hs_lastmodifieddate"]);
  function validateInput(type, rec, properties, raw) {
    if (!isPlainObject(properties)) throw validation("Invalid input JSON: \"properties\" must be an object");
    const errors = [];
    const changes = {};
    for (const [name, value] of Object.entries(properties)) {
      const def = propDef(type, name);
      if (!def) {
        errors.push({ message: `Property "${name}" does not exist`, code: "PROPERTY_DOESNT_EXIST", context: { propertyName: [name] } });
        continue;
      }
      if (READ_ONLY.has(name) || def.modificationMetadata.readOnlyValue) {
        errors.push({ message: `"${name}" is a read only property; its value cannot be set.`, code: "READ_ONLY_VALUE", context: { propertyName: [name] } });
        continue;
      }
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        errors.push({ message: `${JSON.stringify(value)} is not a valid value for property ${name}`, code: "INVALID_PROPERTY_VALUE", context: { propertyName: [name] } }); // fixture-approximation: code name
        continue;
      }
      const s = value === null ? null : String(value);
      if (def.type === "number" && s !== null && s !== "" && !Number.isFinite(Number(s))) {
        errors.push({ message: `${s} was not a valid number.`, code: "INVALID_FLOAT", context: { propertyName: [name] } }); // fixture-approximation: code name
        continue;
      }
      if (def.type === "datetime" && s !== null && s !== "" && !/^\d+$/.test(s) && Number.isNaN(Date.parse(s))) {
        errors.push({ message: `${s} was not a valid date.`, code: "INVALID_DATE", context: { propertyName: [name] } }); // fixture-approximation: code name
        continue;
      }
      if (name === "review_tags") {
        if (s === null || s === "") {
          changes[name] = null;
          continue;
        }
        const append = s.startsWith(";");
        const parts = s.split(";").map((x) => x.trim()).filter(Boolean); // fixture-approximation: elements are trimmed
        const bad = parts.filter((p) => !TAG_VALUES.includes(p));
        if (bad.length) {
          errors.push({
            message: `${bad.map((x) => `"${x}"`).join(", ")} was not one of the allowed options: [${TAG_VALUES.join(", ")}]`,
            code: "INVALID_OPTION",
            context: { propertyName: [name] },
          });
          continue;
        }
        const base = append && rec.props.review_tags ? rec.props.review_tags.split(";") : [];
        const merged = [...new Set([...base, ...parts])];
        changes[name] = merged.length ? merged.join(";") : null;
        continue;
      }
      if (name === "pipeline" && !pipelines.some((p) => p.id === s)) {
        errors.push({ message: `"${s}" was not one of the allowed options: [${pipelines.map((p) => p.id).join(", ")}]`, code: "INVALID_OPTION", context: { propertyName: [name] } });
        continue;
      }
      if (name === "dealstage" && !stageById.has(s)) {
        errors.push({ message: `"${s}" was not one of the allowed options`, code: "INVALID_OPTION", context: { propertyName: [name] } });
        continue;
      }
      if (name === "closedate" || def.type === "datetime") {
        changes[name] = s === null || s === "" ? null : /^\d+$/.test(s) ? new Date(Number(s)).toISOString() : new Date(Date.parse(s)).toISOString();
        continue;
      }
      if (name === "amount") {
        changes[name] = s === null || s === "" ? null : String(Number(s));
        continue;
      }
      changes[name] = s;
    }
    if (type === "deals" && !errors.length) {
      const pipe = changes.pipeline ?? rec.props.pipeline;
      const stage = changes.dealstage ?? rec.props.dealstage;
      if (stageById.get(stage)?.pipelineId !== pipe)
        errors.push({
          message: `${stage} is not a valid dealstage for pipeline ${pipe}`,
          code: "INVALID_OPTION",
          context: { propertyName: ["dealstage"] },
        });
    }
    if (errors.length) {
      const e = validation(`Property values were not valid: ${JSON.stringify(errors.map((x) => ({ isValid: false, message: x.message, error: x.code, name: x.context.propertyName[0] })))}`, errors);
      throw e;
    }
    return changes;
  }
  const CANON_FIELD = { hs_next_step: "nextStep", review_tags: "tags", dealstage: "stage" };
  function apply(type, rec, changes) {
    const recordType = type === "deals" ? "deal" : "company";
    const now = nowIso();
    const wasClosed = type === "deals" && stageById.get(rec.props.dealstage).isClosed;
    let changed = false;
    for (const [name, after] of Object.entries(changes)) {
      const before = rec.props[name] ?? null;
      if (before === after) continue;
      rec.props[name] = after;
      if (name === "closedate") rec.closedateAuto = false;
      changed = true;
      ctx.mutate(recordType, rec.key, rec.id, name, before, after, type === "deals" ? (CANON_FIELD[name] ?? "other") : "other");
    }
    if (type === "deals") {
      const st = stageById.get(rec.props.dealstage);
      if (st.isClosed && !wasClosed && rec.props.closedate === null && !("closedate" in changes)) {
        rec.props.closedate = now;
        rec.closedateAuto = true;
        ctx.mutate("deal", rec.key, rec.id, "closedate", null, now, "derived");
      }
      if (st.isClosed !== wasClosed) ctx.mutate("deal", rec.key, rec.id, "hs_is_closed", String(wasClosed), String(st.isClosed), "derived");
    }
    if (changed) rec.updatedAt = now;
  }
  function checkTopLevel(body, raw) {
    if (!isPlainObject(body)) throw validation("Invalid input JSON on line 1, column 1: expected an object");
    for (const k of Object.keys(body)) {
      if (k !== "properties") {
        const col = (raw.indexOf(`"${k}"`) ?? 0) + 1;
        throw validation(
          `Invalid input JSON on line 1, column ${col}: Unrecognized field "${k}" (class com.hubspot.inbounddb.publicobject.core.v2.SimplePublicObjectInput), not marked as ignorable`,
        );
      }
    }
    if (!("properties" in body)) throw validation("Invalid input JSON: missing required field \"properties\"");
  }

  const pageOf = (q, rows, dflt, max, fingerprint, linkBase) => {
    const limit = intParam(q, "limit", dflt);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) throw validation(`limit must be between 1 and ${max}, got ${q.get("limit")}`);
    let offset = 0;
    const after = q.get("after");
    if (after) {
      offset = decodeCursor(after, fingerprint);
      if (offset === null) throw validation(`Invalid after value: ${after}`);
    }
    const page = rows.slice(offset, offset + limit);
    let paging;
    if (offset + limit < rows.length) {
      const next = encodeCursor(offset + limit, fingerprint);
      const qs = new URLSearchParams(q);
      qs.set("after", next);
      paging = { next: { after: next, ...(linkBase ? { link: `https://api.hubapi.com${linkBase}?${qs}` } : {}) } };
    }
    return { page, paging };
  };

  // ---- routes
  const routes = [
    {
      re: /^\/crm\/v3\/objects\/([^/]+)$/,
      GET: ({ params, query, url }) => {
        const type = resolveType(params[0]);
        const rows = query.get("archived") === "true" ? [] : store[type];
        const { page, paging } = pageOf(query, rows, 10, 100, `list:${type}`, url.pathname);
        const names = parseProps(query.get("properties"), type);
        return { results: page.map((r) => serialize(type, r, names, assocList(query))), ...(paging ? { paging } : {}) };
      },
    },
    {
      re: /^\/crm\/v3\/objects\/([^/]+)\/search$/,
      readPost: () => true,
      POST: ({ params, body }) => search(resolveType(params[0]), body),
    },
    {
      re: /^\/crm\/v3\/objects\/([^/]+)\/batch\/read$/,
      readPost: () => true, // documented read via POST; never changes state
      POST: ({ params, body }) => {
        const type = resolveType(params[0]);
        if (!isPlainObject(body) || !Array.isArray(body.inputs)) throw validation("Invalid input JSON: \"inputs\" is required");
        if (body.inputs.length > 100) throw validation("Too many inputs (maximum 100)");
        const names = parseProps(body.properties ?? null, type);
        const startedAt = nowIso();
        const missing = [];
        const results = [];
        for (const i of body.inputs) {
          const r = findRec(type, i?.id);
          if (r) results.push(serialize(type, r, names));
          else missing.push(String(i?.id));
        }
        const out = { status: "COMPLETE", results, startedAt, completedAt: nowIso() };
        if (missing.length) {
          // fixture-approximation: partial batch read -> 207 with errors[] (HubSpot multi-status shape).
          return reply(207, { ...out, numErrors: 1, errors: [{ status: "error", category: "OBJECT_NOT_FOUND", message: "Could not get some records", context: { ids: missing } }] });
        }
        return out;
      },
    },
    {
      re: /^\/crm\/v3\/objects\/([^/]+)\/batch\/update$/,
      POST: ({ params, body, raw }) => {
        const type = resolveType(params[0]);
        if (!isPlainObject(body) || !Array.isArray(body.inputs)) throw validation("Invalid input JSON: \"inputs\" is required");
        if (body.inputs.length > 100) throw validation("Too many inputs (maximum 100)");
        const startedAt = nowIso();
        const seen = new Set();
        const plans = body.inputs.map((inp) => {
          if (!isPlainObject(inp) || inp.id === undefined) throw validation("Each input requires \"id\" and \"properties\"");
          const rec = findRec(type, inp.id);
          if (!rec) throw err(400, "VALIDATION_ERROR", `Object with id ${inp.id} not found`, [{ message: `Object not found: ${inp.id}`, code: "OBJECT_NOT_FOUND", context: { ids: [String(inp.id)] } }]); // fixture-approximation: all-or-nothing 400
          if (seen.has(rec.id)) throw validation(`Duplicate IDs found in batch input: [${rec.id}]`);
          seen.add(rec.id);
          for (const k of Object.keys(inp)) if (!["id", "properties", "idProperty", "objectWriteTraceId"].includes(k)) throw validation(`Invalid input JSON: Unrecognized field "${k}"`);
          return { rec, changes: validateInput(type, rec, inp.properties, raw) };
        });
        for (const p of plans) apply(type, p.rec, p.changes);
        const def = type === "deals" ? DEAL_DEFAULT : COMPANY_DEFAULT;
        return { status: "COMPLETE", results: plans.map((p) => serialize(type, p.rec, [...new Set([...def, ...Object.keys(p.changes)])])), startedAt, completedAt: nowIso() };
      },
    },
    {
      re: /^\/crm\/v3\/objects\/([^/]+)\/([^/]+)$/,
      GET: ({ params, query }) => {
        const type = resolveType(params[0]);
        const rec = findRec(type, params[1]);
        if (!rec) throw notFoundObj();
        return serialize(type, rec, parseProps(query.get("properties"), type), assocList(query));
      },
      PATCH: ({ params, body, raw }) => {
        const type = resolveType(params[0]);
        const rec = findRec(type, params[1]);
        if (!rec) throw notFoundObj();
        checkTopLevel(body, raw);
        const changes = validateInput(type, rec, body.properties, raw);
        apply(type, rec, changes);
        const def = type === "deals" ? DEAL_DEFAULT : COMPANY_DEFAULT;
        return serialize(type, rec, [...new Set([...def, ...Object.keys(changes)])]);
      },
    },
    {
      re: /^\/crm\/v3\/properties\/([^/]+)$/,
      GET: ({ params }) => ({ results: PROPS[resolveType(params[0])] }),
    },
    {
      re: /^\/crm\/v3\/properties\/([^/]+)\/([^/]+)$/,
      GET: ({ params }) => {
        const p = propDef(resolveType(params[0]), params[1]);
        if (!p) throw err(404, "OBJECT_NOT_FOUND", `Unable to find property ${params[1]}`);
        return p;
      },
    },
    { re: /^\/crm\/v3\/pipelines\/deals$/, GET: () => ({ results: pipelines.map(pipelineOut) }) },
    {
      re: /^\/crm\/v3\/pipelines\/deals\/([^/]+)$/,
      GET: ({ params }) => pipelineOut(findPipeline(params[0])),
    },
    {
      re: /^\/crm\/v3\/pipelines\/deals\/([^/]+)\/stages$/,
      GET: ({ params }) => ({ results: pipelineOut(findPipeline(params[0])).stages }),
    },
    {
      re: /^\/crm\/v4\/objects\/([^/]+)\/([^/]+)\/associations\/([^/]+)$/,
      GET: ({ params, query }) => {
        const from = resolveType(params[0]);
        const to = resolveType(params[2]);
        const rec = findRec(from, params[1]);
        let rows = [];
        // fixture-approximation: unknown fromId yields an empty result list rather than 404.
        if (rec && from === "deals" && to === "companies") {
          rows = [{ toObjectId: Number(companyByKey.get(rec.companyKey).id), associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 5, label: "Primary" }, { category: "HUBSPOT_DEFINED", typeId: 341, label: null }] }];
        } else if (rec && from === "companies" && to === "deals") {
          rows = deals
            .filter((d) => d.companyKey === rec.key)
            .map((d) => ({ toObjectId: Number(d.id), associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 6, label: "Primary" }, { category: "HUBSPOT_DEFINED", typeId: 342, label: null }] }));
        }
        const { page, paging } = pageOf(query, rows, 500, 500, `assoc:${from}:${params[1]}:${to}`, null);
        return { results: page, ...(paging ? { paging } : {}) };
      },
    },
  ];
  function findPipeline(id) {
    const p = pipelines.find((x) => x.id === id);
    if (!p) throw err(404, "OBJECT_NOT_FOUND", `Unable to find pipeline with id ${id}`);
    return p;
  }
  function pipelineOut(p) {
    return {
      id: p.id,
      label: p.label,
      displayOrder: p.displayOrder,
      archived: false,
      stages: p.stages.map((s, i) => ({ id: s.id, label: s.label, displayOrder: i, archived: false, metadata: { isClosed: String(s.isClosed), probability: s.probability } })),
    };
  }

  function canonical() {
    return {
      companies: companies.map((c) => ({
        key: c.key,
        nativeId: c.id,
        name: c.props.name,
        domain: c.props.domain,
        otherHash: hashOther({ name: c.props.name, domain: c.props.domain, industry: c.props.industry }),
      })),
      deals: deals.map((d) => {
        const st = stageById.get(d.props.dealstage);
        const stageClass = !st.isClosed ? "open" : st.probability === "1.0" ? "won" : "lost";
        return {
          key: d.key,
          nativeId: d.id,
          companyKey: d.companyKey,
          name: d.props.dealname,
          stageClass,
          stage: pickCanonicalStage(st.canon, d.initialStage),
          nextStep: d.props.hs_next_step ?? null,
          tags: (d.props.review_tags ? d.props.review_tags.split(";").map(tagFromValue) : []).sort(),
          otherHash: hashOther({
            dealname: d.props.dealname,
            amount: d.props.amount,
            pipeline: d.props.pipeline,
            closedate: d.closedateAuto ? null : d.props.closedate,
            description: d.props.description,
          }),
        };
      }),
    };
  }

  return {
    routes,
    canonical,
    authenticate(req) {
      const h = req.headers.authorization ?? "";
      if (h !== `Bearer ${ctx.token}`) return err(401, "INVALID_AUTHENTICATION", AUTH_MESSAGE);
      return null;
    },
    // fixture-approximation: unknown path / 405 / 413 bodies use the shared HubSpot error envelope.
    notFound: (p) => err(404, "OBJECT_NOT_FOUND", `Unable to route request: ${p}`),
    methodNotAllowed: (m) => err(405, "METHOD_NOT_ALLOWED", `HTTP ${m} is not supported by this endpoint`),
    invalidJson: () => validation("Invalid input JSON on line 1, column 1: Unexpected character"),
    tooLarge: () => err(413, "VALIDATION_ERROR", "Request body too large"),
    errorCodeOf: (b) => b?.errors?.[0]?.code ?? b?.category ?? null,
    extraHeaders: (id) => ({ "x-hubspot-correlation-id": id }),
  };
}
