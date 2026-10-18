// SYNTHETIC CONTRACT FIXTURE — Pipedrive API v2 (organizations, deals, pipelines, stages) + v1 field metadata (subset).
// Written from the public docs cited in eval/crm/CONTRACTS.md §5. Not an integration certification.
import { TAG_OPTIONS, createRng, createdIso, decodeCursor, encodeCursor, hashOther, intParam, isPlainObject, nowIso, reply } from "./common.mjs";

const INFO = "Please check developers.pipedrive.com";

export function createPipedrive(ctx) {
  const rng = createRng(ctx.seed, "pipedrive");
  const ds = ctx.dataset;
  const ownerId = rng.int(10_000_000, 25_000_000);

  // ---- pipelines / stages (seeded small ints)
  const salesId = rng.int(1, 5);
  const entId = salesId + rng.int(1, 3);
  let stageId = rng.int(1, 20);
  const T0 = "2026-08-01T09:00:00Z";
  const mkStage = (name, pipeline_id, order_nr, deal_probability) => ({ id: stageId++, order_nr, name, pipeline_id, deal_probability, is_deal_rot_enabled: false, days_to_rotten: null, add_time: T0, update_time: T0 });
  const stages = [
    mkStage("Qualified", salesId, 1, 20),
    mkStage("Proposal made", salesId, 2, 50),
    mkStage("Negotiations started", salesId, 3, 80),
    mkStage("Discovery", entId, 1, 10),
    mkStage("Security review", entId, 2, 40),
    mkStage("Contract", entId, 3, 90),
  ];
  const pipelines = [
    { id: salesId, name: "Sales", order_nr: 1, is_deal_probability_enabled: false, add_time: T0, update_time: T0 },
    { id: entId, name: "Enterprise", order_nr: 2, is_deal_probability_enabled: false, add_time: T0, update_time: T0 },
  ];
  const stageByName = (n) => stages.find((s) => s.name === n);
  // Pipedrive has no won/lost stages: closed seed deals keep an ordinary stage and carry status won/lost.
  const CANON_TO_STAGE = {
    qualify: "Qualified",
    propose: "Proposal made",
    negotiate: "Negotiations started",
    discovery: "Discovery",
    "security-review": "Security review",
    "won-default": "Negotiations started",
    "lost-default": "Proposal made",
    "won-enterprise": "Contract",
    "lost-enterprise": "Security review",
  };
  const STAGE_TO_CANON = { Qualified: "qualify", "Proposal made": "propose", "Negotiations started": "negotiate", Discovery: "discovery", "Security review": "security-review", Contract: "security-review" };

  // ---- custom fields (40-hex keys, seeded per tenant)
  const domainKey = rng.hex(40);
  const nextKey = rng.hex(40);
  const tagsKey = rng.hex(40);
  let optId = rng.int(20, 200);
  const tagOptions = TAG_OPTIONS.map((label) => ({ id: optId++, label }));
  const optIdOf = (label) => tagOptions.find((o) => o.label === label).id;
  const labelOf = (id) => tagOptions.find((o) => o.id === id)?.label;

  // ---- records
  let orgId = rng.int(100, 300);
  const orgs = ds.companies.map((c) => ({
    key: c.key,
    id: (orgId += rng.int(1, 9)),
    name: c.name,
    owner_id: ownerId,
    add_time: createdIso(c.createdOrder - 10),
    update_time: createdIso(c.createdOrder - 10),
    visible_to: 3,
    custom_fields: { [domainKey]: c.domain },
  }));
  const orgByKey = new Map(orgs.map((o) => [o.key, o]));
  let dealId = rng.int(1000, 4000);
  const deals = ds.deals.map((d) => {
    const st = stageByName(CANON_TO_STAGE[d.stage]);
    const add = createdIso(d.createdOrder);
    const close = d.stageClass === "open" ? null : createdIso(d.createdOrder + 20 * 24 * 60);
    return {
      key: d.key,
      companyKey: d.companyKey,
      initialStage: d.stage,
      data: {
        id: (dealId += rng.int(1, 20)),
        title: d.name,
        owner_id: ownerId,
        person_id: null,
        org_id: orgByKey.get(d.companyKey).id,
        pipeline_id: st.pipeline_id,
        stage_id: st.id,
        value: d.amount,
        currency: "USD",
        add_time: add,
        update_time: add,
        stage_change_time: null,
        is_deleted: false,
        status: d.stageClass,
        probability: null,
        won_time: d.stageClass === "won" ? close : null,
        lost_time: d.stageClass === "lost" ? close : null,
        close_time: close,
        custom_fields: { [nextKey]: d.nextStep, [tagsKey]: d.tags.length ? d.tags.map(optIdOf) : null },
      },
    };
  });

  // ---- field metadata (v1)
  let fieldId = rng.int(12000, 12400);
  const f = (key, name, field_type, extra = {}) => ({ id: fieldId++, key, name, field_type, ...extra, edit_flag: extra.edit_flag ?? false, active_flag: true, mandatory_flag: false });
  const dealFields = [
    f("title", "Title", "varchar"),
    f("value", "Value", "monetary"),
    f("currency", "Currency", "varchar"),
    f("org_id", "Organization", "org"),
    f("person_id", "Contact person", "people"),
    f("pipeline_id", "Pipeline", "int"), // fixture-approximation: field_type of the pipeline reference
    f("stage_id", "Stage", "stage"),
    f("status", "Status", "status", { options: ["open", "won", "lost", "deleted"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }),
    f("add_time", "Deal created", "date"),
    f("update_time", "Update time", "date"),
    f("won_time", "Won time", "date"),
    f("lost_time", "Lost time", "date"),
    f("close_time", "Deal closed on", "date"),
    f(nextKey, "Next step", "varchar", { edit_flag: true }),
    f(tagsKey, "Review tags", "set", { edit_flag: true, options: tagOptions }),
  ];
  const orgFields = [
    f("name", "Name", "varchar"),
    f("owner_id", "Owner", "int"), // fixture-approximation: field_type of the owner reference
    f("add_time", "Organization created", "date"),
    f("update_time", "Update time", "date"),
    f("visible_to", "Visible to", "enum"),
    f(domainKey, "Domain", "varchar", { edit_flag: true }),
  ];
  const DEAL_CUSTOM = { [nextKey]: "varchar", [tagsKey]: "set" };

  // ---- helpers
  const err = (status, code, message) => reply(status, { success: false, error: message, code, error_info: INFO, data: null, additional_data: null }, {}, code);
  const schema = (msg) => err(400, "ERR_SCHEMA_VALIDATION_FAILED", msg);
  const notFound = (what) => err(404, "ERR_NOT_FOUND", `${what} not found`);
  const findDeal = (id) => deals.find((d) => String(d.data.id) === String(id));
  const findOrg = (id) => orgs.find((o) => String(o.id) === String(id));

  function cursorPage(q, rows, fingerprint) {
    const limit = intParam(q, "limit", 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw schema(`Validation failed: limit must be between 1 and 500`);
    let offset = 0;
    const c = q.get("cursor");
    if (c) {
      offset = decodeCursor(c, fingerprint);
      if (offset === null) throw schema("Validation failed: invalid cursor"); // fixture-approximation: code for bad cursor
    }
    const page = rows.slice(offset, offset + limit);
    return { page, next_cursor: offset + limit < rows.length ? encodeCursor(offset + limit, fingerprint) : null };
  }
  const fp = (q) => {
    const p = new URLSearchParams(q);
    p.delete("cursor");
    p.delete("api_token");
    p.sort();
    return p.toString();
  };
  function sortRows(rows, q) {
    const by = q.get("sort_by") ?? "id";
    const dir = q.get("sort_direction") ?? "asc";
    if (!["id", "add_time", "update_time"].includes(by) || !["asc", "desc"].includes(dir)) throw schema(`Validation failed: invalid sort_by/sort_direction`);
    const key = (r) => (by === "id" ? r.id : r[by]);
    const out = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id));
    return dir === "desc" ? out.reverse() : out;
  }
  const intList = (s, name) => {
    const parts = String(s).split(",").map((x) => x.trim());
    if (parts.some((x) => !/^\d+$/.test(x))) throw schema(`Validation failed: ${name} must be a comma separated list of integers`);
    return parts.map(Number);
  };
  const intOpt = (q, name) => {
    const v = q.get(name);
    if (v === null || v === "") return null;
    if (!/^\d+$/.test(v)) throw schema(`Validation failed: ${name} must be an integer`);
    return Number(v);
  };
  const dealOut = (d, q) => {
    const cf = q?.get("custom_fields");
    if (!cf) return structuredClone(d.data);
    const keys = cf.split(",").map((s) => s.trim());
    const out = structuredClone(d.data);
    out.custom_fields = Object.fromEntries(Object.entries(out.custom_fields).filter(([k]) => keys.includes(k)));
    return out;
  };
  const termParams = (q, allowedFields) => {
    const term = (q.get("term") ?? "").trim();
    if (term.length < 2) throw schema("Validation failed: term must be at least 2 characters");
    const fields = (q.get("fields") ?? allowedFields.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    if (fields.some((x) => !allowedFields.includes(x))) throw schema(`Validation failed: fields must be a subset of ${allowedFields.join(",")}`);
    const exact = q.get("exact_match") === "true";
    return { term: term.toLowerCase(), fields, exact };
  };
  const matchStr = (val, term, exact) => {
    if (typeof val !== "string") return 0;
    const v = val.toLowerCase();
    if (v === term) return 1;
    return !exact && v.includes(term) ? 0.5 : 0;
  };

  // ---- PATCH /api/v2/deals/{id}
  const ALLOWED = new Set(["title", "value", "currency", "status", "stage_id", "pipeline_id", "org_id", "custom_fields"]);
  function patchDeal(d, body) {
    if (!isPlainObject(body)) throw schema("Validation failed: request body must be a JSON object");
    for (const k of Object.keys(body)) if (!ALLOWED.has(k)) throw schema(`Validation failed: unknown field '${k}'`);
    const ch = {};
    if ("title" in body) {
      if (typeof body.title !== "string" || !body.title.trim()) throw schema("Validation failed: title must be a non-empty string");
      ch.title = body.title;
    }
    if ("value" in body) {
      if (typeof body.value !== "number" || !Number.isFinite(body.value)) throw schema("Validation failed: value must be a number");
      ch.value = body.value;
    }
    if ("currency" in body) {
      if (typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency)) throw schema("Validation failed: currency must be a 3-letter code");
      ch.currency = body.currency;
    }
    if ("status" in body) {
      if (!["open", "won", "lost"].includes(body.status)) throw schema("Validation failed: status must be one of open, won, lost");
      ch.status = body.status;
    }
    for (const k of ["stage_id", "pipeline_id"]) {
      if (k in body && !Number.isInteger(body[k])) throw schema(`Validation failed: ${k} must be an integer`);
    }
    if ("pipeline_id" in body) {
      if (!pipelines.some((p) => p.id === body.pipeline_id)) throw err(400, "ERR_INVALID_INPUT", `Pipeline ${body.pipeline_id} not found`); // fixture-approximation: code
      ch.pipeline_id = body.pipeline_id;
    }
    if ("stage_id" in body) {
      if (!stages.some((s) => s.id === body.stage_id)) throw err(400, "ERR_INVALID_INPUT", `Stage ${body.stage_id} not found`);
      ch.stage_id = body.stage_id;
    }
    const pipe = ch.pipeline_id ?? d.data.pipeline_id;
    const stg = ch.stage_id ?? d.data.stage_id;
    if (stages.find((s) => s.id === stg).pipeline_id !== pipe) throw err(400, "ERR_INVALID_INPUT", `Stage ${stg} does not belong to pipeline ${pipe}`);
    if ("org_id" in body) {
      if (body.org_id !== null && (!Number.isInteger(body.org_id) || !findOrg(body.org_id))) throw err(400, "ERR_INVALID_INPUT", `Organization ${body.org_id} not found`);
      ch.org_id = body.org_id;
    }
    const cf = {};
    if ("custom_fields" in body) {
      if (!isPlainObject(body.custom_fields)) throw schema("Validation failed: custom_fields must be an object");
      for (const [k, v] of Object.entries(body.custom_fields)) {
        const t = DEAL_CUSTOM[k];
        if (!t) throw schema(`Validation failed: unknown custom field '${k}'`);
        if (t === "varchar") {
          if (v !== null && typeof v !== "string") throw schema(`Validation failed: custom field '${k}' must be a string`);
          cf[k] = v === "" ? null : v;
        } else {
          if (v === null) {
            cf[k] = null;
            continue;
          }
          if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x))) throw schema(`Validation failed: custom field '${k}' must be an array of option ids`);
          const bad = v.filter((x) => !tagOptions.some((o) => o.id === x));
          if (bad.length) throw err(400, "ERR_INVALID_INPUT", `Invalid option id(s) ${bad.join(",")} for custom field '${k}'`);
          const set = [...new Set(v)];
          cf[k] = set.length ? set : null;
        }
      }
    }
    // apply (all validated -> atomic)
    const now = nowIso();
    const rec = d.data;
    const M = (field, before, after, cf2) => ctx.mutate("deal", d.key, rec.id, field, before, after, cf2);
    let changed = false;
    for (const [k, v] of Object.entries(ch)) {
      if (rec[k] === v) continue;
      const before = rec[k];
      rec[k] = v;
      changed = true;
      M(k, before, v, k === "status" || k === "stage_id" ? "stage" : "other");
      if (k === "stage_id") {
        M("stage_change_time", rec.stage_change_time, now, "derived");
        rec.stage_change_time = now;
      }
      if (k === "status") {
        const times = { won_time: v === "won" ? now : null, lost_time: v === "lost" ? now : null, close_time: v === "open" ? null : now };
        for (const [tk, tv] of Object.entries(times)) {
          if (rec[tk] !== tv) {
            M(tk, rec[tk], tv, "derived");
            rec[tk] = tv;
          }
        }
      }
    }
    for (const [k, v] of Object.entries(cf)) {
      const before = rec.custom_fields[k] ?? null;
      if (JSON.stringify(before) === JSON.stringify(v)) continue;
      rec.custom_fields[k] = v;
      changed = true;
      M(k, before, v, k === nextKey ? "nextStep" : "tags");
    }
    if (changed) rec.update_time = now;
  }

  // ---- routes
  const routes = [
    {
      re: /^\/api\/v2\/organizations$/,
      GET: ({ query }) => {
        let rows = orgs;
        if (query.get("ids")) {
          const ids = intList(query.get("ids"), "ids");
          rows = rows.filter((o) => ids.includes(o.id));
        }
        const owner = intOpt(query, "owner_id");
        if (owner !== null) rows = rows.filter((o) => o.owner_id === owner);
        const { page, next_cursor } = cursorPage(query, sortRows(rows, query), `orgs:${fp(query)}`);
        return { success: true, data: structuredClone(page), additional_data: { next_cursor } };
      },
    },
    {
      re: /^\/api\/v2\/organizations\/search$/,
      GET: ({ query }) => {
        const { term, fields, exact } = termParams(query, ["name", "address", "custom_fields", "notes"]);
        const items = [];
        for (const o of orgs) {
          let score = 0;
          const matched = [];
          if (fields.includes("name")) score = Math.max(score, matchStr(o.name, term, exact));
          if (fields.includes("custom_fields")) {
            const s = matchStr(o.custom_fields[domainKey], term, exact);
            if (s) matched.push(o.custom_fields[domainKey]);
            score = Math.max(score, s);
          }
          if (score > 0) items.push({ result_score: score, item: { id: o.id, type: "organization", name: o.name, address: null, visible_to: o.visible_to, owner: { id: o.owner_id }, custom_fields: matched } });
        }
        items.sort((a, b) => b.result_score - a.result_score || a.item.id - b.item.id);
        const { page, next_cursor } = cursorPage(query, items, `orgsearch:${fp(query)}`);
        return { success: true, data: { items: page }, additional_data: { next_cursor } };
      },
    },
    {
      re: /^\/api\/v2\/organizations\/([^/]+)$/,
      GET: ({ params }) => {
        const o = findOrg(params[0]);
        if (!o) throw notFound("Organization");
        return { success: true, data: structuredClone(o), additional_data: null };
      },
      // Documented v2 organization update (name, owner_id, visible_to, custom_fields). Not needed by the tasks; any
      // applied change is logged as a company mutation so the oracle can reject it.
      PATCH: ({ params, body }) => {
        const o = findOrg(params[0]);
        if (!o) throw notFound("Organization");
        if (!isPlainObject(body)) throw schema("Validation failed: request body must be a JSON object");
        for (const k of Object.keys(body)) if (!["name", "owner_id", "visible_to", "custom_fields"].includes(k)) throw schema(`Validation failed: unknown field '${k}'`);
        const ch = {};
        if ("name" in body) {
          if (typeof body.name !== "string" || !body.name.trim()) throw schema("Validation failed: name must be a non-empty string");
          ch.name = body.name;
        }
        if ("owner_id" in body) {
          if (body.owner_id !== ownerId) throw err(400, "ERR_INVALID_INPUT", `User ${body.owner_id} not found`); // fixture-approximation: single user
          ch.owner_id = body.owner_id;
        }
        if ("visible_to" in body) {
          if (![1, 3, 5, 7].includes(body.visible_to)) throw schema("Validation failed: visible_to must be one of 1, 3, 5, 7");
          ch.visible_to = body.visible_to;
        }
        const cf = {};
        if ("custom_fields" in body) {
          if (!isPlainObject(body.custom_fields)) throw schema("Validation failed: custom_fields must be an object");
          for (const [k, v] of Object.entries(body.custom_fields)) {
            if (k !== domainKey) throw schema(`Validation failed: unknown custom field '${k}'`);
            if (v !== null && typeof v !== "string") throw schema(`Validation failed: custom field '${k}' must be a string`);
            cf[k] = v === "" ? null : v;
          }
        }
        let changed = false;
        for (const [k, v] of Object.entries(ch)) {
          if (o[k] === v) continue;
          ctx.mutate("company", o.key, o.id, k, o[k], v, "other");
          o[k] = v;
          changed = true;
        }
        for (const [k, v] of Object.entries(cf)) {
          if (o.custom_fields[k] === v) continue;
          ctx.mutate("company", o.key, o.id, k, o.custom_fields[k] ?? null, v, "other");
          o.custom_fields[k] = v;
          changed = true;
        }
        if (changed) o.update_time = nowIso();
        return { success: true, data: structuredClone(o), additional_data: null };
      },
    },
    {
      re: /^\/api\/v2\/deals$/,
      GET: ({ query }) => {
        const statusRaw = query.get("status");
        let statuses = null;
        if (statusRaw) {
          statuses = statusRaw.split(",").map((s) => s.trim());
          if (statuses.some((s) => !["open", "won", "lost", "deleted"].includes(s))) throw schema("Validation failed: status must be one of open, won, lost, deleted");
        }
        const filterId = intOpt(query, "filter_id");
        let rows = deals.map((d) => d.data);
        if (filterId !== null) {
          // Documented: with filter_id, owner/person/org/pipeline/stage params are ignored.
          if (filterId !== 1) throw notFound("Filter"); // fixture-approximation: only saved filter 1 "All open deals" exists
          rows = rows.filter((r) => r.status === "open");
        } else {
          for (const [p, k] of [["org_id", "org_id"], ["pipeline_id", "pipeline_id"], ["stage_id", "stage_id"], ["owner_id", "owner_id"], ["person_id", "person_id"]]) {
            const v = intOpt(query, p);
            if (v !== null) rows = rows.filter((r) => r[k] === v);
          }
        }
        rows = rows.filter((r) => (statuses ? statuses.includes(r.status) : r.status !== "deleted"));
        if (query.get("ids")) {
          const ids = intList(query.get("ids"), "ids");
          rows = rows.filter((r) => ids.includes(r.id));
        }
        const { page, next_cursor } = cursorPage(query, sortRows(rows, query), `deals:${fp(query)}`);
        return { success: true, data: page.map((r) => dealOut(findDeal(r.id), query)), additional_data: { next_cursor } };
      },
    },
    {
      re: /^\/api\/v2\/deals\/search$/,
      GET: ({ query }) => {
        const { term, fields, exact } = termParams(query, ["title", "custom_fields", "notes"]);
        const orgF = intOpt(query, "organization_id");
        const st = query.get("status");
        if (st && !["open", "won", "lost"].includes(st)) throw schema("Validation failed: status must be one of open, won, lost");
        const items = [];
        for (const d of deals) {
          const r = d.data;
          if (orgF !== null && r.org_id !== orgF) continue;
          if (st && r.status !== st) continue;
          let score = 0;
          const matched = [];
          if (fields.includes("title")) score = Math.max(score, matchStr(r.title, term, exact));
          if (fields.includes("custom_fields")) {
            const s = matchStr(r.custom_fields[nextKey], term, exact);
            if (s) matched.push(r.custom_fields[nextKey]);
            score = Math.max(score, s);
          }
          if (score <= 0) continue;
          const org = findOrg(r.org_id);
          const stage = stages.find((s) => s.id === r.stage_id);
          items.push({
            result_score: score,
            item: {
              id: r.id,
              type: "deal",
              title: r.title,
              value: r.value,
              currency: r.currency,
              status: r.status,
              visible_to: 3,
              owner: { id: r.owner_id },
              stage: { id: stage.id, name: stage.name },
              person: null,
              organization: org ? { id: org.id, name: org.name, address: null } : null,
              custom_fields: matched,
              notes: [],
            },
          });
        }
        items.sort((a, b) => b.result_score - a.result_score || a.item.id - b.item.id);
        const { page, next_cursor } = cursorPage(query, items, `dealsearch:${fp(query)}`);
        return { success: true, data: { items: page }, additional_data: { next_cursor } };
      },
    },
    {
      re: /^\/api\/v2\/deals\/([^/]+)$/,
      GET: ({ params, query }) => {
        const d = findDeal(params[0]);
        if (!d) throw notFound("Deal");
        return { success: true, data: dealOut(d, query), additional_data: null };
      },
      PATCH: ({ params, body }) => {
        const d = findDeal(params[0]);
        if (!d) throw notFound("Deal");
        patchDeal(d, body);
        return { success: true, data: dealOut(d), additional_data: null };
      },
    },
    {
      re: /^\/api\/v2\/pipelines$/,
      GET: ({ query }) => {
        const { page, next_cursor } = cursorPage(query, pipelines, `pipelines:${fp(query)}`);
        return { success: true, data: page, additional_data: { next_cursor } };
      },
    },
    {
      re: /^\/api\/v2\/pipelines\/([^/]+)$/,
      GET: ({ params }) => {
        const p = pipelines.find((x) => String(x.id) === params[0]);
        if (!p) throw notFound("Pipeline");
        return { success: true, data: p, additional_data: null };
      },
    },
    {
      re: /^\/api\/v2\/stages$/,
      GET: ({ query }) => {
        const pid = intOpt(query, "pipeline_id");
        const rows = pid === null ? stages : stages.filter((s) => s.pipeline_id === pid);
        const { page, next_cursor } = cursorPage(query, rows, `stages:${fp(query)}`);
        return { success: true, data: page, additional_data: { next_cursor } };
      },
    },
    {
      re: /^\/api\/v2\/stages\/([^/]+)$/,
      GET: ({ params }) => {
        const s = stages.find((x) => String(x.id) === params[0]);
        if (!s) throw notFound("Stage");
        return { success: true, data: s, additional_data: null };
      },
    },
    { re: /^\/api\/v1\/dealFields$/, GET: ({ query }) => v1Page(query, dealFields) },
    { re: /^\/api\/v1\/organizationFields$/, GET: ({ query }) => v1Page(query, orgFields) },
  ];
  function v1Page(q, rows) {
    const start = intParam(q, "start", 0);
    const limit = intParam(q, "limit", 100);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw reply(400, { success: false, error: "Validation failed: start/limit out of range", errorCode: 400, error_info: INFO }, {}, "400");
    const page = rows.slice(start, start + limit);
    const more = start + limit < rows.length;
    return { success: true, data: page, additional_data: { pagination: { start, limit, more_items_in_collection: more, ...(more ? { next_start: start + limit } : {}) } } };
  }

  function canonical() {
    return {
      companies: orgs.map((o) => ({
        key: o.key,
        nativeId: o.id,
        name: o.name,
        domain: o.custom_fields[domainKey],
        otherHash: hashOther({ name: o.name, owner_id: o.owner_id, visible_to: o.visible_to, custom_fields: o.custom_fields }),
      })),
      deals: deals.map((d) => {
        const r = d.data;
        const stage = stages.find((s) => s.id === r.stage_id);
        const pipe = r.pipeline_id === entId ? "enterprise" : "default";
        const stageKey = r.status === "open" ? STAGE_TO_CANON[stage.name] : `${r.status}-${pipe}`;
        const otherCustom = Object.fromEntries(Object.entries(r.custom_fields).filter(([k]) => k !== nextKey && k !== tagsKey));
        return {
          key: d.key,
          nativeId: r.id,
          companyKey: d.companyKey,
          name: r.title,
          stageClass: r.status,
          // fixture-approximation: open deals map back from stage name ("Contract" -> security-review); closed deals from status + pipeline.
          stage: stageKey,
          nextStep: r.custom_fields[nextKey] ?? null,
          tags: (r.custom_fields[tagsKey] ?? []).map(labelOf).sort(),
          otherHash: hashOther({ title: r.title, value: r.value, currency: r.currency, pipeline_id: r.pipeline_id, stage_id: r.stage_id, org_id: r.org_id, custom: otherCustom }),
        };
      }),
    };
  }

  return {
    routes,
    canonical,
    authenticate(req, url) {
      const h = req.headers["x-api-token"];
      if (h === ctx.token || url.searchParams.get("api_token") === ctx.token) return null;
      return reply(401, { success: false, error: "unauthorized access", errorCode: 401, error_info: INFO }, {}, "unauthorized");
    },
    // fixture-approximation: unknown path / 405 / 413 / invalid JSON envelopes and codes.
    notFound: () => err(404, "ERR_NOT_FOUND", "Unknown method ."),
    methodNotAllowed: (m) => err(405, "ERR_METHOD_NOT_ALLOWED", `Method ${m} not allowed`),
    invalidJson: () => schema("Validation failed: malformed JSON body"),
    tooLarge: () => err(413, "ERR_PAYLOAD_TOO_LARGE", "Request body too large"),
    errorCodeOf: (b) => b?.code ?? (b?.errorCode ? String(b.errorCode) : null),
    redactPath: (url) => {
      const u = new URL(url.href);
      if (u.searchParams.has("api_token")) u.searchParams.set("api_token", "REDACTED");
      return u.pathname + u.search;
    },
  };
}
