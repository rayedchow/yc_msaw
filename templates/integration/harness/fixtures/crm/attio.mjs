// SYNTHETIC CONTRACT FIXTURE — Attio REST API v2 (objects, attributes, options/statuses, record query/get/update/assert).
// Written from the public docs cited in eval/crm/CONTRACTS.md §7. Not an integration certification.
import { TAG_OPTIONS, createRng, createdIso, hashOther, isPlainObject, nowIso, pickCanonicalStage, reply, slug } from "./common.mjs";

const STATUSES = [
  { title: "Lead", canon: ["qualify"], cls: "open", celebration: false },
  { title: "In Progress", canon: ["propose", "discovery"], cls: "open", celebration: false },
  { title: "Negotiation", canon: ["negotiate", "security-review"], cls: "open", celebration: false },
  { title: "Won 🎉", canon: ["won-default", "won-enterprise"], cls: "won", celebration: true },
  { title: "Lost", canon: ["lost-default", "lost-enterprise"], cls: "lost", celebration: false },
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAIN_SUB = { text: "value", domain: "domain", status: "status", select: "option", currency: "currency_value", "record-reference": "target_record_id", timestamp: "value" };
const SUBS = {
  text: ["value"],
  domain: ["domain", "root_domain"],
  status: ["status"],
  select: ["option"],
  currency: ["currency_value", "currency_code"],
  "record-reference": ["target_record_id", "target_object"],
  timestamp: ["value"],
};
const STR_OPS = ["$eq", "$contains", "$starts_with", "$ends_with", "$in", "$not_empty"];
const OPS = {
  text: STR_OPS,
  domain: STR_OPS,
  status: ["$eq", "$in", "$not_empty"],
  select: ["$eq", "$in", "$not_empty"],
  currency: ["$eq", "$in", "$gt", "$gte", "$lt", "$lte", "$not_empty"],
  "record-reference": ["$eq", "$in", "$not_empty"],
  timestamp: ["$eq", "$gt", "$gte", "$lt", "$lte", "$not_empty"],
};
const rootDomain = (d) => d.split(".").slice(-2).join(".");

export function createAttio(ctx) {
  const rng = createRng(ctx.seed, "attio");
  const ds = ctx.dataset;
  const ws = rng.uuid();
  const wsSlug = slug(ctx.spec.instanceLabel || "workspace");
  const actorId = rng.uuid();
  const memberActor = { type: "workspace-member", id: rng.uuid() };
  const apiActor = { type: "api-token", id: actorId };
  const T0 = "2026-08-01T09:00:00.000Z";

  // ---- objects + attributes
  const objects = {
    companies: { id: { workspace_id: ws, object_id: rng.uuid() }, api_slug: "companies", singular_noun: "Company", plural_noun: "Companies", created_at: T0 },
    deals: { id: { workspace_id: ws, object_id: rng.uuid() }, api_slug: "deals", singular_noun: "Deal", plural_noun: "Deals", created_at: T0 },
  };
  const attr = (obj, api_slug, title, type, o = {}) => ({
    id: { workspace_id: ws, object_id: objects[obj].id.object_id, attribute_id: rng.uuid() },
    title,
    description: o.description ?? null,
    api_slug,
    type,
    is_system_attribute: o.system ?? true,
    is_writable: o.writable ?? true,
    is_required: o.required ?? false,
    is_unique: o.unique ?? false,
    is_multiselect: o.multi ?? false,
    is_default_value_enabled: false,
    is_archived: false,
    default_value: null,
    relationship: null,
    created_at: T0,
    config: {
      currency: type === "currency" ? { default_currency_code: "USD", display_type: "symbol" } : { default_currency_code: null, display_type: null },
      record_reference: { allowed_object_ids: type === "record-reference" ? [objects.companies.id.object_id] : null },
    },
  });
  const ATTRS = {
    companies: [
      attr("companies", "record_id", "Record ID", "text", { writable: false, unique: true }),
      attr("companies", "name", "Name", "text"),
      attr("companies", "domains", "Domains", "domain", { multi: true, unique: true }),
      attr("companies", "created_at", "Created at", "timestamp", { writable: false }),
    ],
    deals: [
      attr("deals", "record_id", "Record ID", "text", { writable: false, unique: true }),
      attr("deals", "name", "Deal name", "text", { required: true }),
      attr("deals", "stage", "Deal stage", "status", { required: true }),
      attr("deals", "value", "Deal value", "currency"),
      attr("deals", "associated_company", "Associated company", "record-reference"),
      attr("deals", "next_step", "Next step", "text", { system: false }),
      attr("deals", "review_tags", "Review tags", "select", { system: false, multi: true }),
      attr("deals", "created_at", "Created at", "timestamp", { writable: false }),
    ],
  };
  const attrOf = (obj, s) => ATTRS[obj].find((a) => a.api_slug === s || a.id.attribute_id === s);
  const stageAttr = attrOf("deals", "stage");
  const tagsAttr = attrOf("deals", "review_tags");
  const statuses = STATUSES.map((s) => ({
    ...s,
    out: { id: { ...stageAttr.id, status_id: rng.uuid() }, title: s.title, is_archived: false, target_time_in_status: null, celebration_enabled: s.celebration },
  }));
  const options = TAG_OPTIONS.map((t) => ({ id: { ...tagsAttr.id, option_id: rng.uuid() }, title: t, is_archived: false }));

  // ---- value object builders
  const meta = (at, actor) => ({ active_from: at, active_until: null, created_by_actor: { ...actor } });
  const V = {
    text: (v, at, a) => ({ ...meta(at, a), value: v, attribute_type: "text" }),
    domain: (d, at, a) => ({ ...meta(at, a), domain: d, root_domain: rootDomain(d), attribute_type: "domain" }),
    status: (s, at, a) => ({ ...meta(at, a), status: structuredClone(s.out), attribute_type: "status" }),
    select: (o, at, a) => ({ ...meta(at, a), option: structuredClone(o), attribute_type: "select" }),
    currency: (n, at, a) => ({ ...meta(at, a), currency_value: n, currency_code: "USD", attribute_type: "currency" }),
    "record-reference": (id, at, a) => ({ ...meta(at, a), target_object: "companies", target_record_id: id, attribute_type: "record-reference" }),
    timestamp: (v, at, a) => ({ ...meta(at, a), value: v, attribute_type: "timestamp" }),
  };
  const iso = (o) => createdIso(o).replace("Z", ".000Z");

  const records = { companies: [], deals: [] };
  for (const c of ds.companies) {
    const at = iso(c.createdOrder - 10);
    const rid = rng.uuid();
    records.companies.push({
      key: c.key,
      record_id: rid,
      created_at: at,
      values: { record_id: [V.text(rid, at, memberActor)], name: [V.text(c.name, at, memberActor)], domains: [V.domain(c.domain, at, memberActor)], created_at: [V.timestamp(at, at, memberActor)] },
    });
  }
  const compByKey = new Map(records.companies.map((c) => [c.key, c]));
  for (const d of ds.deals) {
    const at = iso(d.createdOrder);
    const rid = rng.uuid();
    const st = statuses.find((s) => s.canon.includes(d.stage));
    records.deals.push({
      key: d.key,
      companyKey: d.companyKey,
      initialStage: d.stage,
      record_id: rid,
      created_at: at,
      values: {
        record_id: [V.text(rid, at, memberActor)],
        name: [V.text(d.name, at, memberActor)],
        stage: [V.status(st, at, memberActor)],
        value: [V.currency(d.amount, at, memberActor)],
        associated_company: [V["record-reference"](compByKey.get(d.companyKey).record_id, at, memberActor)],
        next_step: d.nextStep ? [V.text(d.nextStep, at, memberActor)] : [],
        review_tags: d.tags.map((t) => V.select(options.find((o) => o.title === t), at, memberActor)),
        created_at: [V.timestamp(at, at, memberActor)],
      },
    });
  }

  // ---- helpers
  const err = (status, code, message, type = "invalid_request_error") => reply(status, { status_code: status, type, code, message }, {}, code);
  const validation = (m = "Body payload validation error.") => err(400, "validation_type", m);
  const objectOf = (o) => {
    const ob = objects[o] ?? Object.values(objects).find((x) => x.id.object_id === o);
    if (!ob) throw err(404, "not_found", `Object with slug/ID "${o}" not found.`);
    return ob.api_slug;
  };
  const recOut = (obj, r) => ({
    id: { workspace_id: ws, object_id: objects[obj].id.object_id, record_id: r.record_id },
    created_at: r.created_at,
    web_url: `https://app.attio.com/${wsSlug}/${obj === "companies" ? "company" : "deals"}/${r.record_id}`,
    values: structuredClone(r.values),
  });
  const findRec = (obj, id) => records[obj].find((r) => r.record_id === id);

  // ---- filter evaluation
  function candidates(type, sub, vo) {
    if (type === "status" && sub === "status") return [vo.status.title, vo.status.id.status_id];
    if (type === "select" && sub === "option") return [vo.option.title, vo.option.id.option_id];
    return [vo[sub]];
  }
  function applyOp(op, arg, cands, type) {
    const lc = (x) => (typeof x === "string" ? x.toLowerCase() : x);
    const exactCase = type === "status" || type === "select"; // titles/ids match exactly
    const eq = (a, b) => (exactCase ? a === b : typeof a === "string" && typeof b === "string" ? lc(a) === lc(b) : a === b); // fixture-approximation: text $eq case-insensitive
    const num = (x) => (type === "timestamp" ? Date.parse(x) : Number(x));
    switch (op) {
      case "$eq":
        return cands.some((c) => eq(c, arg));
      case "$in":
        if (!Array.isArray(arg)) throw validation("$in requires an array.");
        return cands.some((c) => arg.some((a) => eq(c, a)));
      case "$contains":
        return cands.some((c) => typeof c === "string" && lc(c).includes(lc(String(arg))));
      case "$starts_with":
        return cands.some((c) => typeof c === "string" && lc(c).startsWith(lc(String(arg))));
      case "$ends_with":
        return cands.some((c) => typeof c === "string" && lc(c).endsWith(lc(String(arg))));
      case "$gt":
        return cands.some((c) => num(c) > num(arg));
      case "$gte":
        return cands.some((c) => num(c) >= num(arg));
      case "$lt":
        return cands.some((c) => num(c) < num(arg));
      case "$lte":
        return cands.some((c) => num(c) <= num(arg));
      default:
        return false;
    }
  }
  function compileFilter(obj, f) {
    if (!isPlainObject(f)) throw validation("Filter must be an object.");
    const preds = [];
    for (const [k, v] of Object.entries(f)) {
      if (k === "$and" || k === "$or") {
        if (!Array.isArray(v)) throw validation(`${k} must be an array.`);
        const subs = v.map((x) => compileFilter(obj, x));
        preds.push(k === "$and" ? (r) => subs.every((p) => p(r)) : (r) => subs.some((p) => p(r)));
        continue;
      }
      if (k === "$not") {
        const p = compileFilter(obj, v);
        preds.push((r) => !p(r));
        continue;
      }
      if (k.startsWith("$")) throw validation(`Unknown logical operator "${k}".`);
      const a = attrOf(obj, k);
      if (!a) throw err(400, "unknown_filter_attribute_slug", `Unknown attribute slug: "${k}".`);
      const type = a.type;
      const conds = []; // [sub, op, arg]
      if (!isPlainObject(v)) conds.push([MAIN_SUB[type], "$eq", v]);
      else {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith("$")) conds.push([MAIN_SUB[type], sk, sv]);
          else {
            if (!SUBS[type].includes(sk)) throw err(400, "invalid_filter_operator", `Invalid sub-property "${sk}" for attribute "${k}" of type ${type}.`); // fixture-approximation: code
            if (isPlainObject(sv)) for (const [op, arg] of Object.entries(sv)) conds.push([sk, op, arg]);
            else conds.push([sk, "$eq", sv]);
          }
        }
      }
      for (const [, op] of conds) if (!OPS[type].includes(op)) throw err(400, "invalid_filter_operator", `Operator "${op}" is not valid for attribute "${k}" of type ${type}.`);
      preds.push((r) => {
        const vals = r.values[a.api_slug] ?? [];
        return conds.every(([sub, op, arg]) => (op === "$not_empty" ? vals.length > 0 === Boolean(arg) : vals.some((vo) => applyOp(op, arg, candidates(type, sub, vo), type))));
      });
    }
    return (r) => preds.every((p) => p(r));
  }

  // ---- value input normalisation -> list of value objects (validated)
  function normalize(obj, a, input, at) {
    const items = input === null ? [] : Array.isArray(input) ? input : [input];
    if (!a.is_multiselect && items.length > 1) throw validation(`Attribute "${a.api_slug}" accepts a single value.`);
    return items.map((it) => {
      switch (a.type) {
        case "text": {
          const s = isPlainObject(it) ? it.value : it;
          if (typeof s !== "string") throw validation(`Invalid value for text attribute "${a.api_slug}".`);
          return V.text(s, at, apiActor);
        }
        case "domain": {
          const s = isPlainObject(it) ? it.domain : it;
          if (typeof s !== "string" || !s.includes(".")) throw validation(`Invalid value for domain attribute "${a.api_slug}".`);
          return V.domain(s.toLowerCase(), at, apiActor);
        }
        case "status": {
          const s = isPlainObject(it) ? it.status : it;
          const st = statuses.find((x) => x.title === s || x.out.id.status_id === s);
          if (!st) throw err(400, "value_not_found", `Cannot find status with title or ID "${s}".`);
          return V.status(st, at, apiActor);
        }
        case "select": {
          const s = isPlainObject(it) ? it.option : it;
          const o = options.find((x) => x.title === s || x.id.option_id === s);
          if (!o) throw err(400, "value_not_found", `Cannot find select option with title "${s}".`);
          return V.select(o, at, apiActor);
        }
        case "currency": {
          const n = isPlainObject(it) ? it.currency_value : it;
          if (typeof n !== "number" || !Number.isFinite(n)) throw validation(`Invalid value for currency attribute "${a.api_slug}".`);
          return V.currency(n, at, apiActor);
        }
        case "record-reference": {
          // fixture-approximation: a bare record_id string is accepted as target_record_id.
          const id = isPlainObject(it) ? it.target_record_id : it;
          if (isPlainObject(it) && it.target_object !== undefined && it.target_object !== "companies") throw err(400, "value_not_found", `Object "${it.target_object}" is not an allowed target.`);
          if (typeof id !== "string" || !findRec("companies", id)) throw err(400, "value_not_found", `Record with ID "${id}" not found.`);
          return V["record-reference"](id, at, apiActor);
        }
        default:
          throw validation();
      }
    });
  }
  const identity = (vo) => {
    switch (vo.attribute_type) {
      case "text":
      case "timestamp":
        return vo.value;
      case "domain":
        return vo.domain;
      case "status":
        return vo.status.id.status_id;
      case "select":
        return vo.option.id.option_id;
      case "currency":
        return vo.currency_value;
      case "record-reference":
        return vo.target_record_id;
      default:
        return JSON.stringify(vo);
    }
  };
  const display = (a, vals) => {
    const xs = vals.map((vo) => (vo.attribute_type === "status" ? vo.status.title : vo.attribute_type === "select" ? vo.option.title : identity(vo)));
    return a.is_multiselect ? xs : (xs[0] ?? null);
  };
  const CANON_FIELD = { next_step: "nextStep", review_tags: "tags", stage: "stage" };

  // mode: "patch" (multiselect add) | "put" (multiselect replace) | "assert" (put, but matching attr kept+added)
  function update(obj, r, body, mode, matching, dryRun = false) {
    if (!isPlainObject(body) || Object.keys(body).some((k) => k !== "data") || !isPlainObject(body.data) || !isPlainObject(body.data.values)) throw validation();
    const at = nowIso().replace("Z", ".000Z");
    const plan = [];
    for (const [s, input] of Object.entries(body.data.values)) {
      const a = attrOf(obj, s);
      if (!a) throw err(400, "unknown_attribute_slug", `Unknown attribute slug: "${s}".`);
      if (!a.is_writable) throw validation(`Attribute "${s}" is not writable.`);
      const incoming = normalize(obj, a, input, at);
      if (a.is_required && incoming.length === 0) throw validation(`Attribute "${s}" is required and cannot be cleared.`); // fixture-approximation
      plan.push({ a, incoming });
    }
    if (dryRun) return;
    for (const { a, incoming } of plan) {
      const cur = r.values[a.api_slug] ?? [];
      let next;
      if (a.is_multiselect && (mode === "patch" || (mode === "assert" && a.api_slug === matching))) {
        next = [...cur];
        for (const vo of incoming) if (!next.some((x) => identity(x) === identity(vo))) next.push(vo);
      } else if (a.is_multiselect) {
        next = [];
        for (const vo of incoming) {
          if (next.some((x) => identity(x) === identity(vo))) continue;
          next.push(cur.find((x) => identity(x) === identity(vo)) ?? vo); // keep existing value objects
        }
      } else {
        next = incoming.length && cur.length && identity(cur[0]) === identity(incoming[0]) ? cur : incoming;
      }
      const before = display(a, cur);
      const after = display(a, next);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      r.values[a.api_slug] = next;
      ctx.mutate(obj === "deals" ? "deal" : "company", r.key, r.record_id, a.api_slug, before, after, obj === "deals" ? (CANON_FIELD[a.api_slug] ?? "other") : "other");
    }
  }

  const routes = [
    { re: /^\/v2\/objects$/, GET: () => ({ data: Object.values(objects) }) },
    { re: /^\/v2\/objects\/([^/]+)$/, GET: ({ params }) => ({ data: objects[objectOf(params[0])] }) },
    { re: /^\/v2\/objects\/([^/]+)\/attributes$/, GET: ({ params }) => ({ data: ATTRS[objectOf(params[0])] }) },
    {
      re: /^\/v2\/objects\/([^/]+)\/attributes\/([^/]+)$/,
      GET: ({ params }) => {
        const a = attrOf(objectOf(params[0]), params[1]);
        if (!a) throw err(404, "not_found", `Attribute with slug/ID "${params[1]}" not found.`);
        return { data: a };
      },
    },
    {
      re: /^\/v2\/objects\/([^/]+)\/attributes\/([^/]+)\/options$/,
      GET: ({ params }) => {
        const a = attrOf(objectOf(params[0]), params[1]);
        if (!a) throw err(404, "not_found", `Attribute with slug/ID "${params[1]}" not found.`);
        if (a.type !== "select") throw validation(`Attribute "${a.api_slug}" is not a select attribute.`); // fixture-approximation
        return { data: a === tagsAttr ? options : [] };
      },
    },
    {
      re: /^\/v2\/objects\/([^/]+)\/attributes\/([^/]+)\/statuses$/,
      GET: ({ params }) => {
        const a = attrOf(objectOf(params[0]), params[1]);
        if (!a) throw err(404, "not_found", `Attribute with slug/ID "${params[1]}" not found.`);
        if (a.type !== "status") throw validation(`Attribute "${a.api_slug}" is not a status attribute.`); // fixture-approximation
        return { data: statuses.map((s) => s.out) };
      },
    },
    {
      re: /^\/v2\/objects\/([^/]+)\/records\/query$/,
      readPost: () => true,
      POST: ({ params, body }) => {
        const obj = objectOf(params[0]);
        const b = body ?? {};
        if (!isPlainObject(b) || Object.keys(b).some((k) => !["filter", "sorts", "limit", "offset"].includes(k))) throw validation();
        const limit = b.limit === undefined ? 500 : b.limit;
        const offset = b.offset === undefined ? 0 : b.offset;
        if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) throw validation();
        let rows = records[obj];
        if (b.filter !== undefined && b.filter !== null) {
          const p = compileFilter(obj, b.filter);
          rows = rows.filter(p);
        }
        if (b.sorts !== undefined) {
          if (!Array.isArray(b.sorts)) throw validation();
          const specs = b.sorts.map((s) => {
            if (!isPlainObject(s) || !["asc", "desc"].includes(s.direction)) throw validation();
            const a = attrOf(obj, s.attribute);
            if (!a) throw err(400, "unknown_filter_attribute_slug", `Unknown attribute slug: "${s.attribute}".`);
            return { a, sub: s.field ?? MAIN_SUB[a.type], dir: s.direction === "desc" ? -1 : 1 };
          });
          rows = [...rows].sort((x, y) => {
            for (const { a, sub, dir } of specs) {
              const gx = (x.values[a.api_slug] ?? [])[0];
              const gy = (y.values[a.api_slug] ?? [])[0];
              const vx = gx ? candidates(a.type, sub, gx)[0] : null;
              const vy = gy ? candidates(a.type, sub, gy)[0] : null;
              if (vx === vy) continue;
              if (vx === null) return 1;
              if (vy === null) return -1;
              return (vx < vy ? -1 : 1) * dir;
            }
            return 0;
          });
        }
        return { data: rows.slice(offset, offset + limit).map((r) => recOut(obj, r)) };
      },
    },
    {
      re: /^\/v2\/objects\/([^/]+)\/records$/,
      PUT: ({ params, body, query }) => {
        const obj = objectOf(params[0]);
        const m = query.get("matching_attribute");
        if (!m) throw validation("matching_attribute query parameter is required.");
        const a = attrOf(obj, m);
        if (!a) throw err(400, "unknown_attribute_slug", `Unknown attribute slug: "${m}".`);
        if (!a.is_unique || !a.is_writable) throw err(400, "not_unique_attribute", "Matching attribute must be a unique attribute.");
        if (!isPlainObject(body?.data?.values)) throw validation();
        const at = nowIso().replace("Z", ".000Z");
        const wanted = normalize(obj, a, body.data.values[a.api_slug] ?? null, at).map(identity);
        if (!wanted.length) throw validation(`Value for matching attribute "${m}" is required.`);
        let r = records[obj].find((x) => (x.values[a.api_slug] ?? []).some((vo) => wanted.includes(identity(vo))));
        if (!r) {
          const rid = rng.uuid();
          r = { key: `created-${rid}`, record_id: rid, created_at: at, values: Object.fromEntries(ATTRS[obj].map((x) => [x.api_slug, []])) };
          r.values.record_id = [V.text(rid, at, apiActor)];
          r.values.created_at = [V.timestamp(at, at, apiActor)];
          if (obj === "deals") {
            // fixture-approximation: unreachable (deals have no writable unique attribute)
            throw err(400, "not_unique_attribute", "Matching attribute must be a unique attribute.");
          }
          update(obj, r, body, "assert", m, true); // validate first (throws on error; nothing applied)
          records[obj].push(r);
          ctx.created(obj === "deals" ? "deal" : "company", rid);
        }
        update(obj, r, body, "assert", m);
        return { data: recOut(obj, r) };
      },
    },
    {
      re: /^\/v2\/objects\/([^/]+)\/records\/([^/]+)$/,
      GET: ({ params }) => {
        const obj = objectOf(params[0]);
        const r = UUID_RE.test(params[1]) ? findRec(obj, params[1]) : null;
        if (!r) throw err(404, "not_found", `Record with ID "${params[1]}" not found.`);
        return { data: recOut(obj, r) };
      },
      PATCH: ({ params, body }) => {
        const obj = objectOf(params[0]);
        const r = findRec(obj, params[1]);
        if (!r) throw err(404, "not_found", `Record with ID "${params[1]}" not found.`);
        update(obj, r, body, "patch");
        return { data: recOut(obj, r) };
      },
      PUT: ({ params, body }) => {
        const obj = objectOf(params[0]);
        const r = findRec(obj, params[1]);
        if (!r) throw err(404, "not_found", `Record with ID "${params[1]}" not found.`);
        update(obj, r, body, "put");
        return { data: recOut(obj, r) };
      },
    },
  ];

  const first = (r, s) => (r.values[s] ?? [])[0];
  function canonical() {
    return {
      companies: records.companies
        .filter((c) => !c.key.startsWith("created-"))
        .map((c) => ({
          key: c.key,
          nativeId: c.record_id,
          name: first(c, "name")?.value ?? null,
          domain: first(c, "domains")?.domain ?? null,
          otherHash: hashOther({ name: first(c, "name")?.value ?? null, domains: (c.values.domains ?? []).map((d) => d.domain) }),
        })),
      deals: records.deals.map((d) => {
        const title = first(d, "stage")?.status.title;
        const st = statuses.find((s) => s.title === title);
        return {
          key: d.key,
          nativeId: d.record_id,
          companyKey: d.companyKey,
          name: first(d, "name")?.value ?? null,
          stageClass: st?.cls ?? "open",
          stage: st ? pickCanonicalStage(st.canon, d.initialStage) : null,
          nextStep: first(d, "next_step")?.value ?? null,
          tags: (d.values.review_tags ?? []).map((v) => v.option.title).sort(),
          otherHash: hashOther({
            name: first(d, "name")?.value ?? null,
            value: first(d, "value")?.currency_value ?? null,
            associated_company: (d.values.associated_company ?? []).map((v) => v.target_record_id),
          }),
        };
      }),
    };
  }

  return {
    routes,
    canonical,
    authenticate(req) {
      if ((req.headers.authorization ?? "") !== `Bearer ${ctx.token}`) return err(401, "unauthorized", "Invalid or missing access token.", "auth_error");
      return null;
    },
    // fixture-approximation: 404/405/413/invalid-JSON messages.
    notFound: (p) => err(404, "not_found", `Route ${p} not found.`),
    methodNotAllowed: (m) => err(405, "method_not_allowed", `Method ${m} is not allowed on this path.`),
    invalidJson: () => validation(),
    tooLarge: () => err(413, "payload_too_large", "Request body too large."),
    errorCodeOf: (b) => b?.code ?? null,
  };
}
