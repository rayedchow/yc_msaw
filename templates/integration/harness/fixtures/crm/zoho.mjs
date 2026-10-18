// SYNTHETIC CONTRACT FIXTURE — Zoho CRM REST API v8 (Accounts, Deals; records, search, related, field/module meta).
// Written from the public docs cited in eval/crm/CONTRACTS.md §6. Not an integration certification.
import { TAG_OPTIONS, createRng, createdIso, hashOther, isPlainObject, nowIso, pickCanonicalStage, reply, seedCloseIso } from "./common.mjs";

const STAGES = [
  { v: "Qualification", p: 10, canon: ["qualify"], cls: "open" },
  { v: "Needs Analysis", p: 20, canon: ["discovery"], cls: "open" },
  { v: "Proposal/Price Quote", p: 75, canon: ["propose", "security-review"], cls: "open" },
  { v: "Negotiation/Review", p: 90, canon: ["negotiate"], cls: "open" },
  { v: "Closed Won", p: 100, canon: ["won-default", "won-enterprise"], cls: "won" },
  { v: "Closed Lost", p: 0, canon: ["lost-default"], cls: "lost" },
  { v: "Closed-Lost to Competition", p: 0, canon: ["lost-enterprise"], cls: "lost" },
];
const INDUSTRIES = ["Wholesale", "Software", "Manufacturing", "Retail", "Services"];
const zTime = (iso) => iso.replace(/(\.\d{3})?Z$/, "+00:00");

export function createZoho(ctx) {
  const rng = createRng(ctx.seed, "zoho");
  const ds = ctx.dataset;
  const orgPrefix = rng.digits(7);
  let counter = rng.int(1_000_000, 9_000_000);
  const zid = () => `${orgPrefix}000${String((counter += rng.int(1, 999))).padStart(9, "0")}`;
  const owner = { name: "API User", id: zid(), email: "api.user@crm.example" };
  const moduleIds = { Accounts: zid(), Deals: zid() };

  const accounts = ds.companies.map((c) => ({
    key: c.key,
    rec: {
      id: zid(),
      Account_Name: c.name,
      Website: c.domain,
      Industry: c.role === "filler" ? "Software" : "Wholesale",
      Owner: { ...owner },
      Created_Time: zTime(createdIso(c.createdOrder - 10)),
      Modified_Time: zTime(createdIso(c.createdOrder - 10)),
    },
  }));
  const accByKey = new Map(accounts.map((a) => [a.key, a]));
  const deals = ds.deals.map((d) => {
    const st = STAGES.find((s) => s.canon.includes(d.stage));
    const acc = accByKey.get(d.companyKey).rec;
    return {
      key: d.key,
      companyKey: d.companyKey,
      initialStage: d.stage,
      rec: {
        id: zid(),
        Deal_Name: d.name,
        Stage: st.v,
        Amount: d.amount,
        Closing_Date: d.stageClass === "open" ? null : seedCloseIso(d.createdOrder).slice(0, 10),
        Account_Name: { name: acc.Account_Name, id: acc.id },
        Next_Step: d.nextStep,
        Review_Tags: [...d.tags],
        Probability: st.p,
        Description: null,
        Owner: { ...owner },
        Created_Time: zTime(createdIso(d.createdOrder)),
        Modified_Time: zTime(createdIso(d.createdOrder)),
      },
    };
  });
  const store = { Accounts: accounts, Deals: deals };

  // ---- field metadata
  const pick = (vals) => vals.map((v, i) => ({ display_value: v, actual_value: v, id: zid(), sequence_number: i + 1, type: "used" }));
  const fld = (api_name, label, data_type, extra = {}) => ({
    api_name,
    field_label: label,
    display_label: label,
    data_type,
    read_only: extra.read_only ?? false,
    system_mandatory: extra.system_mandatory ?? false,
    ...(extra.pick ? { pick_list_values: pick(extra.pick) } : {}),
    ...(extra.lookup ? { lookup: { module: { api_name: extra.lookup, id: moduleIds[extra.lookup] } } } : {}),
    ...(extra.length ? { length: extra.length } : {}),
  });
  const FIELDS = {
    Accounts: [
      fld("Account_Name", "Account Name", "text", { system_mandatory: true, length: 200 }),
      fld("Website", "Website", "text", { length: 255 }),
      fld("Industry", "Industry", "picklist", { pick: INDUSTRIES }),
      fld("Owner", "Account Owner", "ownerlookup"),
      fld("Created_Time", "Created Time", "datetime", { read_only: true }),
      fld("Modified_Time", "Modified Time", "datetime", { read_only: true }),
    ],
    Deals: [
      fld("Deal_Name", "Deal Name", "text", { system_mandatory: true, length: 120 }),
      fld("Stage", "Stage", "picklist", { system_mandatory: true, pick: STAGES.map((s) => s.v) }),
      fld("Amount", "Amount", "currency"),
      fld("Closing_Date", "Closing Date", "date"),
      fld("Account_Name", "Account Name", "lookup", { lookup: "Accounts" }),
      fld("Next_Step", "Next Step", "text", { length: 255 }),
      fld("Review_Tags", "Review Tags", "multiselectpicklist", { pick: TAG_OPTIONS }),
      fld("Probability", "Probability (%)", "integer"),
      fld("Description", "Description", "text", { length: 32000 }),
      fld("Owner", "Deal Owner", "ownerlookup"),
      fld("Created_Time", "Created Time", "datetime", { read_only: true }),
      fld("Modified_Time", "Modified Time", "datetime", { read_only: true }),
    ],
  };
  const fieldDef = (mod, name) => FIELDS[mod].find((f) => f.api_name === name);

  // ---- helpers
  const err = (status, code, details, message) => reply(status, { code, details, message, status: "error" }, {}, code);
  const required = (param) => err(400, "REQUIRED_PARAM_MISSING", param ? { param } : {}, "One of the expected parameter is missing");
  const invalidData = (details) => err(400, "INVALID_DATA", details, "invalid data");
  const invalidQuery = () => err(400, "INVALID_QUERY", { reason: "invalid criteria" }, "invalid query formed");
  const moduleOf = (m) => {
    if (!store[m]) throw err(400, "INVALID_MODULE", { resource_path_index: 0 }, "the module name given seems to be invalid");
    return m;
  };
  const findRec = (mod, id) => store[mod].find((r) => r.rec.id === String(id));
  const parseFields = (mod, raw, isRequired) => {
    if (raw === null || raw.trim() === "") {
      if (isRequired) throw required("fields");
      return null;
    }
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length > 50) throw err(400, "LIMIT_EXCEEDED", { limit: 50, param: "fields" }, "fields limit exceeded"); // fixture-approximation: code
    for (const n of names) if (n !== "id" && !fieldDef(mod, n)) throw invalidData({ api_name: n });
    return names;
  };
  const project = (rec, names) => {
    if (!names) return structuredClone(rec);
    const out = { id: rec.id };
    for (const n of names) if (n !== "id") out[n] = structuredClone(rec[n] ?? null);
    return out;
  };
  const pageParams = (q) => {
    const page = q.get("page") === null ? 1 : Number(q.get("page"));
    let perPage = q.get("per_page") === null ? 200 : Number(q.get("per_page"));
    if (!Number.isInteger(page) || page < 1) throw invalidData({ param: "page" }); // fixture-approximation
    if (!Number.isInteger(perPage) || perPage < 1) throw invalidData({ param: "per_page" });
    perPage = Math.min(perPage, 200); // fixture-approximation: per_page above 200 is clamped
    return { page, perPage };
  };
  function listResponse(rows, q, names, extraInfo = {}, searchInfo = false) {
    const { page, perPage } = pageParams(q);
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    if (!slice.length) return reply(204, undefined);
    const more = page * perPage < rows.length;
    const info = searchInfo
      ? { count: slice.length, more_records: more, page, per_page: perPage }
      : { per_page: perPage, count: slice.length, page, ...extraInfo, more_records: more, next_page_token: null, previous_page_token: null, page_token_expiry: null };
    return { data: slice.map((r) => project(r.rec, names)), info };
  }

  // ---- criteria
  function parseCriteria(s) {
    let i = 0;
    const ws = () => {
      while (s[i] === " ") i++;
    };
    const conj = () => {
      ws();
      const m = /^(and|or)/i.exec(s.slice(i));
      if (!m) return null;
      i += m[0].length;
      ws();
      return m[1].toLowerCase();
    };
    function group() {
      ws();
      if (s[i] !== "(") throw invalidQuery();
      i++;
      ws();
      if (s[i] === "(") {
        let node = group();
        for (let c = conj(); c; c = conj()) node = { op: c, l: node, r: group() }; // fixture-approximation: left-to-right
        ws();
        if (s[i] !== ")") throw invalidQuery();
        i++;
        return node;
      }
      const f = s.indexOf(":", i);
      if (f < 0) throw invalidQuery();
      const field = s.slice(i, f).trim();
      const o = s.indexOf(":", f + 1);
      if (o < 0) throw invalidQuery();
      const op = s.slice(f + 1, o).trim();
      i = o + 1;
      const parts = [""];
      while (i < s.length && s[i] !== ")") {
        if (s[i] === "\\" && i + 1 < s.length) {
          parts[parts.length - 1] += s[i + 1];
          i += 2;
        } else if (s[i] === ",") {
          parts.push("");
          i++;
        } else parts[parts.length - 1] += s[i++];
      }
      if (s[i] !== ")") throw invalidQuery();
      i++;
      if (!field || !op) throw invalidQuery();
      return { field, op, value: parts.join(","), values: parts };
    }
    let node = group();
    for (let c = conj(); c; c = conj()) node = { op: c, l: node, r: group() };
    ws();
    if (i !== s.length) throw invalidQuery();
    return node;
  }
  const OPS_BY_TYPE = {
    text: ["equals", "not_equal", "starts_with", "in"],
    picklist: ["equals", "not_equal", "in"],
    multiselectpicklist: ["equals", "not_equal", "in"],
    id: ["equals", "not_equal", "in"],
    number: ["equals", "not_equal", "greater_than", "greater_equal", "less_than", "less_equal", "between", "in"],
    date: ["equals", "not_equal", "greater_than", "greater_equal", "less_than", "less_equal", "between"],
  };
  function condInfo(mod, field) {
    if (field === "id") return { type: "id", get: (r) => [r.id] };
    if (field.endsWith(".id")) {
      const base = fieldDef(mod, field.slice(0, -3));
      if (!base || !["lookup", "ownerlookup"].includes(base.data_type)) throw invalidData({ api_name: field });
      return { type: "id", get: (r) => [r[base.api_name]?.id ?? null] };
    }
    if (field.endsWith(".name")) {
      const base = fieldDef(mod, field.slice(0, -5));
      if (!base || !["lookup", "ownerlookup"].includes(base.data_type)) throw invalidData({ api_name: field });
      return { type: "text", get: (r) => [r[base.api_name]?.name ?? null] };
    }
    const def = fieldDef(mod, field);
    if (!def) throw invalidData({ api_name: field });
    const t = def.data_type;
    if (t === "lookup" || t === "ownerlookup") return { type: "text", get: (r) => [r[field]?.name ?? null] };
    if (t === "multiselectpicklist") return { type: "multiselectpicklist", get: (r) => r[field] ?? [] };
    if (t === "currency" || t === "integer") return { type: "number", get: (r) => [r[field]] };
    if (t === "date" || t === "datetime") return { type: "date", get: (r) => [r[field]] };
    return { type: t === "picklist" ? "picklist" : "text", get: (r) => [r[field]] };
  }
  function compileCriteria(mod, node) {
    if (node.op === "and" || node.op === "or") {
      const l = compileCriteria(mod, node.l);
      const r = compileCriteria(mod, node.r);
      return node.op === "and" ? (x) => l(x) && r(x) : (x) => l(x) || r(x);
    }
    const info = condInfo(mod, node.field);
    if (!OPS_BY_TYPE[info.type].includes(node.op)) throw invalidQuery();
    const lower = (v) => String(v ?? "").toLowerCase();
    const num = (v) => (info.type === "date" ? Date.parse(String(v)) : Number(v));
    const eq = (have, want) => {
      if (have === null || have === undefined) return false;
      // Documented: equals on text fields is contains-like and case-insensitive; picklist/number/id exact.
      if (info.type === "text") return lower(have).includes(lower(want));
      if (info.type === "number" || info.type === "date") return num(have) === num(want);
      return String(have) === want;
    };
    const any = (pred) => (rec) => info.get(rec).some(pred);
    switch (node.op) {
      case "equals":
        return any((h) => eq(h, node.value));
      case "not_equal":
        return (rec) => !info.get(rec).some((h) => eq(h, node.value));
      case "starts_with":
        return any((h) => h !== null && lower(h).startsWith(lower(node.value)));
      case "in":
        return any((h) => node.values.some((v) => eq(h, v)));
      case "greater_than":
        return any((h) => h !== null && num(h) > num(node.value));
      case "greater_equal":
        return any((h) => h !== null && num(h) >= num(node.value));
      case "less_than":
        return any((h) => h !== null && num(h) < num(node.value));
      case "less_equal":
        return any((h) => h !== null && num(h) <= num(node.value));
      case "between":
        if (node.values.length !== 2) throw invalidQuery();
        return any((h) => h !== null && num(h) >= num(node.values[0]) && num(h) <= num(node.values[1]));
      default:
        throw invalidQuery();
    }
  }

  // ---- writes
  const READ_ONLY = new Set(["Created_Time", "Modified_Time"]);
  const rowErr = (code, details, message = "invalid data") => ({ code, details, message, status: "error" });
  function validateRow(mod, row) {
    if (!isPlainObject(row)) return { error: rowErr("INVALID_DATA", { expected_data_type: "jsonobject" }) };
    const changes = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === "id") continue;
      const def = fieldDef(mod, k);
      if (!def) return { error: rowErr("INVALID_DATA", { api_name: k }) };
      if (READ_ONLY.has(k)) return { error: rowErr("INVALID_DATA", { api_name: k }) };
      const t = def.data_type;
      const bad = (expected) => ({ error: rowErr("INVALID_DATA", { api_name: k, ...(expected ? { expected_data_type: expected } : {}) }) });
      if (t === "text") {
        if (v !== null && typeof v !== "string") return bad("text");
        if (def.system_mandatory && (v === null || v.trim() === "")) return { error: rowErr("MANDATORY_NOT_FOUND", { api_name: k }, "required field not found") };
        if (v !== null && def.length && v.length > def.length) return bad("text");
        changes[k] = v === "" ? null : v;
      } else if (t === "picklist") {
        if (v === null && def.system_mandatory) return { error: rowErr("MANDATORY_NOT_FOUND", { api_name: k }, "required field not found") };
        if (v !== null && (typeof v !== "string" || !def.pick_list_values.some((p) => p.actual_value === v))) return bad();
        changes[k] = v;
      } else if (t === "multiselectpicklist") {
        if (v === null) {
          changes[k] = [];
          continue;
        }
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !def.pick_list_values.some((p) => p.actual_value === x))) return bad(Array.isArray(v) ? undefined : "jsonarray");
        changes[k] = [...new Set(v)];
      } else if (t === "currency" || t === "integer") {
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || (t === "integer" && !Number.isInteger(v)))) return bad(t === "integer" ? "integer" : "double");
        if (k === "Probability" && v !== null && (v < 0 || v > 100)) return bad("integer");
        changes[k] = v;
      } else if (t === "date") {
        if (v !== null && (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))) return bad("date");
        changes[k] = v;
      } else if (t === "lookup") {
        const id = isPlainObject(v) ? v.id : undefined;
        if (v === null) {
          changes[k] = null;
          continue;
        }
        const target = typeof id === "string" || typeof id === "number" ? findRec(def.lookup.module.api_name, String(id)) : null;
        if (!target) return bad(isPlainObject(v) ? undefined : "jsonobject");
        changes[k] = { name: target.rec.Account_Name, id: target.rec.id };
      } else if (t === "ownerlookup") {
        if (!isPlainObject(v) || String(v.id) !== owner.id) return bad("jsonobject"); // fixture-approximation: only one user exists
        changes[k] = { ...owner };
      }
    }
    return { changes };
  }
  const CANON_FIELD = { Next_Step: "nextStep", Review_Tags: "tags", Stage: "stage" };
  function applyRow(mod, r, changes) {
    const recordType = mod === "Deals" ? "deal" : "company";
    let changed = false;
    for (const [k, after] of Object.entries(changes)) {
      const before = r.rec[k] ?? null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      r.rec[k] = after;
      changed = true;
      ctx.mutate(recordType, r.key, r.rec.id, k, before, after, mod === "Deals" ? (CANON_FIELD[k] ?? "other") : "other");
    }
    // Documented in the corpus: Closing_Date and Probability are NOT auto-changed on stage change.
    if (changed) r.rec.Modified_Time = zTime(nowIso());
    if (mod === "Accounts" && "Account_Name" in changes) {
      for (const d of deals) if (d.rec.Account_Name?.id === r.rec.id) d.rec.Account_Name = { name: r.rec.Account_Name, id: r.rec.id };
    }
  }
  function update(mod, body, pathId) {
    if (!isPlainObject(body) || !Array.isArray(body.data)) throw err(400, "INVALID_DATA", {}, "body"); // fixture-approximation
    if (body.data.length === 0) throw err(400, "INVALID_DATA", {}, "body");
    if (body.data.length > 100) throw err(400, "LIMIT_EXCEEDED", { limit: 100 }, "data limit exceeded"); // fixture-approximation: code
    if (pathId !== undefined && body.data.length !== 1) throw err(400, "INVALID_DATA", {}, "body");
    for (const k of Object.keys(body)) if (!["data", "trigger"].includes(k)) throw err(400, "INVALID_DATA", { api_name: k }, "body"); // fixture-approximation
    const results = body.data.map((row) => {
      const id = pathId ?? (isPlainObject(row) ? row.id : undefined);
      if (id === undefined || id === null || id === "") return rowErr("MANDATORY_NOT_FOUND", { api_name: "id" }, "required field not found");
      const r = findRec(mod, String(id));
      if (!r) return rowErr("INVALID_DATA", { id: String(id) }, "the id given seems to be invalid");
      const { error, changes } = validateRow(mod, row);
      if (error) return error;
      applyRow(mod, r, changes);
      return {
        code: "SUCCESS",
        details: { Modified_Time: r.rec.Modified_Time, Modified_By: { name: owner.name, id: owner.id }, Created_Time: r.rec.Created_Time, id: r.rec.id, Created_By: { name: owner.name, id: owner.id } },
        message: "record updated",
        status: "success",
      };
    });
    const ok = results.filter((r) => r.status === "success").length;
    const status = ok === results.length ? 200 : ok === 0 ? 400 : 207;
    return reply(status, { data: results }, {}, status === 200 ? null : results.find((r) => r.status === "error").code);
  }

  const routes = [
    {
      re: /^\/crm\/v8\/settings\/modules$/,
      GET: () => ({
        modules: [
          { api_name: "Accounts", module_name: "Accounts", singular_label: "Account", plural_label: "Accounts", id: moduleIds.Accounts },
          { api_name: "Deals", module_name: "Deals", singular_label: "Deal", plural_label: "Deals", id: moduleIds.Deals },
        ],
      }),
    },
    {
      re: /^\/crm\/v8\/settings\/fields$/,
      GET: ({ query }) => {
        const m = query.get("module");
        if (!m) throw required("module");
        return { fields: FIELDS[moduleOf(m)] };
      },
    },
    {
      re: /^\/crm\/v8\/([A-Za-z_]+)\/search$/,
      GET: ({ params, query }) => {
        const mod = moduleOf(params[0]);
        const names = parseFields(mod, query.get("fields"), false);
        let rows;
        if (query.get("criteria")) {
          const pred = compileCriteria(mod, parseCriteria(query.get("criteria")));
          rows = store[mod].filter((r) => pred(r.rec));
        } else if (query.get("word")) {
          const w = query.get("word").toLowerCase();
          const textFields = FIELDS[mod].filter((f) => f.data_type === "text").map((f) => f.api_name);
          rows = store[mod].filter((r) => textFields.some((f) => String(r.rec[f] ?? "").toLowerCase().includes(w)));
        } else if (query.get("email") || query.get("phone")) {
          rows = []; // no email/phone fields in these modules
        } else throw required(null);
        return listResponse(rows, query, names, {}, true);
      },
    },
    {
      re: /^\/crm\/v8\/([A-Za-z_]+)$/,
      GET: ({ params, query }) => {
        const mod = moduleOf(params[0]);
        const names = parseFields(mod, query.get("fields"), true);
        let rows = store[mod];
        if (query.get("ids")) {
          const ids = query.get("ids").split(",").map((s) => s.trim());
          rows = rows.filter((r) => ids.includes(r.rec.id));
        }
        const sortBy = query.get("sort_by") ?? "id";
        const sortOrder = query.get("sort_order") ?? "asc";
        if (!["id", "Created_Time", "Modified_Time"].includes(sortBy)) throw invalidData({ param: "sort_by" });
        if (!["asc", "desc"].includes(sortOrder)) throw invalidData({ param: "sort_order" });
        rows = [...rows].sort((a, b) => {
          const x = a.rec[sortBy];
          const y = b.rec[sortBy];
          const c = sortBy === "id" ? (BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0) : x < y ? -1 : x > y ? 1 : 0;
          return sortOrder === "desc" ? -c : c;
        });
        return listResponse(rows, query, names, { sort_by: sortBy, sort_order: sortOrder });
      },
      PUT: ({ params, body }) => update(moduleOf(params[0]), body),
    },
    {
      re: /^\/crm\/v8\/([A-Za-z_]+)\/([0-9]+)$/,
      GET: ({ params }) => {
        const mod = moduleOf(params[0]);
        const r = findRec(mod, params[1]);
        if (!r) throw err(400, "INVALID_DATA", { id: params[1] }, "the related id given seems to be invalid"); // fixture-approximation
        return { data: [structuredClone(r.rec)] };
      },
      PUT: ({ params, body }) => update(moduleOf(params[0]), body, params[1]),
    },
    {
      re: /^\/crm\/v8\/([A-Za-z_]+)\/([0-9]+)\/([A-Za-z_]+)$/,
      GET: ({ params, query }) => {
        const mod = moduleOf(params[0]);
        if (mod !== "Accounts" || params[2] !== "Deals") throw err(400, "INVALID_DATA", { api_name: params[2] }, "the related list name given seems to be invalid"); // fixture-approximation
        const acc = findRec("Accounts", params[1]);
        if (!acc) throw err(400, "INVALID_DATA", { id: params[1] }, "the related id given seems to be invalid");
        const names = parseFields("Deals", query.get("fields"), true);
        return listResponse(deals.filter((d) => d.rec.Account_Name?.id === acc.rec.id), query, names, {}, true);
      },
    },
  ];

  function canonical() {
    return {
      companies: accounts.map((a) => ({
        key: a.key,
        nativeId: a.rec.id,
        name: a.rec.Account_Name,
        domain: a.rec.Website,
        otherHash: hashOther({ Account_Name: a.rec.Account_Name, Website: a.rec.Website, Industry: a.rec.Industry, Owner: a.rec.Owner?.id ?? null }),
      })),
      deals: deals.map((d) => {
        const st = STAGES.find((s) => s.v === d.rec.Stage);
        return {
          key: d.key,
          nativeId: d.rec.id,
          companyKey: d.companyKey,
          name: d.rec.Deal_Name,
          stageClass: st?.cls ?? "open",
          stage: st ? pickCanonicalStage(st.canon, d.initialStage) : null,
          nextStep: d.rec.Next_Step ?? null,
          tags: [...(d.rec.Review_Tags ?? [])].sort(),
          otherHash: hashOther({
            Deal_Name: d.rec.Deal_Name,
            Amount: d.rec.Amount,
            Closing_Date: d.rec.Closing_Date,
            Account_Name: d.rec.Account_Name?.id ?? null,
            Probability: d.rec.Probability,
            Description: d.rec.Description,
            Owner: d.rec.Owner?.id ?? null,
          }),
        };
      }),
    };
  }

  return {
    routes,
    canonical,
    authenticate(req) {
      if ((req.headers.authorization ?? "") !== `Zoho-oauthtoken ${ctx.token}`) return err(401, "INVALID_TOKEN", {}, "invalid oauth token");
      return null;
    },
    notFound: () => err(404, "INVALID_URL_PATTERN", {}, "Please check if the URL trying to access is a correct one"),
    methodNotAllowed: () => err(405, "INVALID_REQUEST_METHOD", {}, "The http request method type is not a valid one"),
    invalidJson: () => err(400, "INVALID_DATA", { expected_data_type: "jsonobject" }, "body"), // fixture-approximation
    tooLarge: () => err(413, "REQUEST_ENTITY_TOO_LARGE", {}, "request entity too large"), // fixture-approximation
    errorCodeOf: (b) => b?.code ?? b?.data?.find?.((r) => r.status === "error")?.code ?? null,
  };
}
