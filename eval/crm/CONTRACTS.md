# CRM contract fixtures — implementation spec (source of truth for fixtures, docs corpus, oracle)

SYNTHETIC CONTRACT FIXTURES. Each vendor module emulates a NARROW, documented subset of the vendor's public REST
API. Behaviour must follow the official docs cited below; where a detail is not documented, choose the most
conservative documented-consistent behaviour and mark it `// fixture-approximation:` in code and in the docs
corpus. Never invent traps (undocumented required fields, invented rate limits, invented cursor formats beyond
"opaque string").

## 0. Files

- `templates/integration/harness/fixtures/crm-fixture.mjs` — entry. Reads JSON config from stdin (like
  `notify-hub.mjs`): `{port, token, adminToken, vendor: "hubspot"|"pipedrive"|"zoho"|"attio", seed: string,
  spec: DatasetSpec}`. Listens on 127.0.0.1:port (or `cfg.host` if given, e.g. "0.0.0.0" for Modal tunnels).
  Prints `fixture listening <port>` on stdout.
- `templates/integration/harness/fixtures/crm/common.mjs`, `dataset.mjs`, `hubspot.mjs`, `pipedrive.mjs`,
  `zoho.mjs`, `attio.mjs` — pure ESM, Node 22 builtins only, no npm deps.
- Exports for host reuse (imported by TypeScript via tsx): `dataset.mjs` exports
  `generateDataset(seed, spec)` (canonical), `crm-fixture.mjs` must ALSO be importable without side effects
  via a separate module `crm/server.mjs` exporting `createCrmFixture({vendor, seed, spec, token, adminToken})`
  → `{ handle(req,res) /* node http handler */, state(), canonical(), listen(port, host) → Promise<{port, close()}> }`.
  `crm-fixture.mjs` is only the stdin wrapper around `crm/server.mjs`.

## 1. Canonical dataset (vendor-neutral, host-only)

`generateDataset(seed: string, spec)` is deterministic (use a seeded PRNG, e.g. sha256-counter or mulberry32 of
a sha256 of seed; NO Math.random). `spec`:

```
{
  instanceLabel: string,            // e.g. "Fabrikam EU production"
  target: { name: string, domain: string },   // the target company
  duplicateDomain: string,          // same display name, different domain (distractor company)
  fillerNames: [string, string, string],      // 3 filler companies (domains derived: slug + ".example")
  family: "exec-review" | "won-closeout",     // shapes which deal is the F2 target; dataset is otherwise the same shape
  closeoutDealName?: string         // F2 only: name of the target deal (also present on the duplicate company)
}
```

Canonical output:

```
{ companies: [{key, name, domain, role: "target"|"duplicate"|"filler"}],
  deals: [{key, companyKey, name, amount, pipeline: "default"|"enterprise",
           stage: <canonical stage key, see below>, stageClass: "open"|"won"|"lost",
           nextStep: string|null, tags: string[], createdOrder: int}],
  tagOptions: ["budget-hold","legal-review","renewal","at-risk","exec-review","closed-q4"] }
```

Canonical stages: default pipeline open `qualify`, `propose`, `negotiate`; enterprise pipeline open
`discovery`, `security-review`; closed: `won-default`, `lost-default`, `won-enterprise`, `lost-enterprise`.

Deal layout (createdOrder = global creation order, ascending; vendors list in that order by default):
- target company: 12 deals. Exactly 4 open (one of them `security-review` in enterprise), 4 won (≥1
  `won-enterprise`), 4 lost (≥1 `lost-enterprise`). The 4 open deals must sit at target-relative positions
  2, 6, 11, 12 (1-based) so that at least 2 open deals are beyond the first 10. 2 of the open deals have
  existing tags (e.g. ["budget-hold"], ["legal-review","renewal"]); 2 of the open deals have an existing non-null
  nextStep (e.g. "Send pricing"). Some closed deals have tags too.
- duplicate company (same name, different domain): 3 open deals + 1 won; if family=won-closeout, one open
  duplicate deal has name = closeoutDealName.
- each filler: 2 deals (1 open, 1 closed).
- won-closeout: closeoutDealName is ONE of the target's open deals (choose the enterprise `security-review`
  one) with existing tags ["renewal"].
- Interleave creation so target deals are not contiguous with duplicate deals (e.g. round-robin-ish with
  filler deals), but keep target-relative order positions as specified.
- amounts: integers 5_000..250_000.
- No canonical deal has "exec-review" or "closed-q4" pre-set.

## 2. Admin endpoint (all vendors)

`GET /__state` with header `x-fixture-admin: <adminToken>` (else 403) returns:

```
{ vendor, instanceLabel,
  canonical: { companies:[{key, nativeId, name, domain}],
               deals:[{key, nativeId, companyKey, name, stageClass, stage, nextStep, tags:[...sorted],
                       otherHash /* sha256 of every OTHER user-editable field, see vendor sections */}] },
  requests: [{seq, at, method, path /* incl. query string */, status, ms, write: bool, errorCode: string|null,
              foreignPattern: string|null, requestId}],
  mutations: [{seq, requestSeq, recordType, key, nativeId, field, before, after}],
  created: [{recordType, nativeId, requestSeq}], deleted: [...] }
```

`write` = any non-GET that changed state OR was a write attempt (POST/PATCH/PUT/DELETE except documented
read-POSTs: HubSpot `/search`, Attio `/records/query`). `foreignPattern` = a short tag when a request
recognisably applies ANOTHER vendor's convention (best effort, only when unambiguous), e.g.
`hubspot.filterGroups` (body has filterGroups on non-HubSpot), `hubspot.properties-wrapper` (body
`{properties:{...}}` on Zoho/Attio/Pipedrive), `pipedrive.custom_fields`, `attio.data.values`,
`zoho.data-array` (`{data:[...]}` on non-Zoho), `odata.$filter`, `zoho.criteria`, `semicolon-tags` (a
`;`-joined tag string sent to a non-HubSpot multiselect). Also log the admin-less 404s of unknown paths.
`requestId` is a fixture-generated id also returned in header `x-fixture-request-id` (and for HubSpot also in
`x-hubspot-correlation-id`).

`POST /__reset` is NOT provided (each instance is single-use).

## 3. Common HTTP behaviour

- JSON in/out (`content-type: application/json; charset=utf-8`). Body size cap 256 KiB → 413.
- Invalid JSON body → the vendor's validation error (see each vendor) with 400.
- Unknown path → vendor-style 404. Unsupported method on a known path → 405 (Attio/Zoho/Pipedrive) or 405
  HubSpot-style.
- Mutations are atomic per request; every mutated field logged in `mutations`.
- Timestamps: deterministic base `2026-09-01T10:00:00Z` + createdOrder minutes; updates use real clock.
- Native IDs deterministic from seed (tenant-specific): two different seeds must yield different IDs, custom
  pipeline/stage IDs, Pipedrive field hashes, Attio UUIDs, Zoho IDs.

## 4. HubSpot (A) — CRM API v3 objects/search/properties/pipelines, v4 associations

Docs: https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm ,
https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide ,
https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide ,
https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide ,
https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/guide

Auth: `Authorization: Bearer <token>` else 401
`{"status":"error","message":"Authentication credentials not found. This API supports OAuth 2.0 authentication and you can find more details at https://developers.hubspot.com/docs/methods/auth/oauth-overview","correlationId":"<uuid>","category":"INVALID_AUTHENTICATION"}`.
Error envelope: `{"status":"error","message":...,"correlationId":...,"category":"VALIDATION_ERROR"|"OBJECT_NOT_FOUND"|...,"errors"?:[...]}`.

IDs: numeric strings. Companies ~11 digits, deals ~11 digits. Deal properties: `dealname`, `amount` (string
number), `dealstage` (stage id), `pipeline` (pipeline id), `closedate` (ISO or null), `createdate`,
`hs_next_step` (label "Next step"), `review_tags` (custom multi-checkbox, label "Review tags", fieldType
`checkbox`, type `enumeration`; options label = value text e.g. label "exec-review" value "exec_review" — i.e.
option VALUES use underscores, LABELS use hyphens), `hs_is_closed` ("true"/"false", calculated read-only),
`hs_is_closed_won` (calculated read-only), `hs_object_id`, `hs_lastmodifieddate` (read-only). Company
properties: `name`, `domain`, `industry`, `createdate`, `hs_object_id`, `hs_lastmodifieddate`.

Pipelines: `default` "Sales Pipeline" stages `appointmentscheduled` (Appointment Scheduled, isClosed false,
probability 0.2), `qualifiedtobuy` (0.4), `contractsent` (0.9), `closedwon` (isClosed true, 1.0),
`closedlost` (isClosed true, 0.0). Enterprise pipeline: numeric id (seeded), label "Enterprise", stages with
numeric ids: "Discovery", "Security review", "Closed won (Enterprise)" (isClosed true, prob 1.0), "Closed lost
(Enterprise)" (isClosed true, prob 0.0). Canonical mapping: qualify→appointmentscheduled,
propose→qualifiedtobuy, negotiate→contractsent, discovery/security-review/won-enterprise/lost-enterprise →
enterprise stages, won-default→closedwon, lost-default→closedlost. stageClass: closed & probability 1.0 → won,
closed & 0.0 → lost. `metadata` values are STRINGS ("true"/"false", "0.2") as in HubSpot.

Endpoints:
1. `GET /crm/v3/objects/{companies|deals}?limit&after&properties&associations&archived` — default limit 10,
   max 100 (higher → 400 VALIDATION_ERROR). `properties` comma list; when absent return default properties
   (deals: amount, closedate, createdate, dealname, dealstage, hs_lastmodifieddate, hs_object_id, pipeline;
   companies: createdate, domain, hs_lastmodifieddate, hs_object_id, name). Unknown names in `properties` are
   silently omitted (HubSpot behaviour). `associations=companies` (on deals) / `deals` (on companies) adds
   `associations: {companies: {results:[{id:"<id>", type:"deal_to_company"}]}}`. Response
   `{results:[{id, properties:{...}, createdAt, updatedAt, archived:false, associations?}], paging?:{next:{after:"<opaque>", link:"..."}}}`.
2. `GET /crm/v3/objects/{type}/{id}?properties&associations` → object or 404 OBJECT_NOT_FOUND.
3. `POST /crm/v3/objects/{type}/search` body `{filterGroups?, sorts?, query?, properties?, limit?, after?}`.
   limit default 10, max 200. ≤5 filterGroups, ≤6 filters per group (else 400). Operators EQ, NEQ, LT, LTE, GT,
   GTE, BETWEEN (value+highValue), IN / NOT_IN (values; for enumeration compare lowercase), HAS_PROPERTY,
   NOT_HAS_PROPERTY, CONTAINS_TOKEN (wildcard * ok), NOT_CONTAINS_TOKEN. AND within a group, OR across groups.
   For deals, pseudo-property `associations.company` with EQ/IN on company id is supported. `query` = text
   search over default searchable props (name/domain, dealname). Unknown propertyName → 400 VALIDATION_ERROR.
   Default sort: by hs_object_id ascending (creation order). Response `{total, results:[...default or requested
   properties...], paging?:{next:{after:"<str>"}}}`. Results never include associations.
4. `PATCH /crm/v3/objects/{type}/{id}` body `{properties:{...}}`. Body without `properties` or with unknown
   top-level key → 400 VALIDATION_ERROR "Invalid input JSON on line 1, column N: Unrecognized field \"x\"…".
   Unknown property → 400 VALIDATION_ERROR with errors `[{"message":"Property \"x\" does not exist","code":"PROPERTY_DOESNT_EXIST","context":{"propertyName":["x"]}}]`.
   Read-only/calculated property → 400 (READ_ONLY_VALUE). `dealstage` must belong to the deal's (possibly
   simultaneously updated) pipeline else 400. Enumeration values must be option VALUES (not labels) else 400
   INVALID_OPTION. **Multi-checkbox `review_tags`: value is a `;`-separated string. A LEADING `;`
   (e.g. ";exec_review") APPENDS the listed values to existing ones (Properties guide "Add values to checkbox
   type properties"); without a leading `;` the listed set REPLACES the existing set; empty string clears.**
   Duplicates are de-duplicated. Moving to a closed stage sets `closedate` to now if null and recalculates
   hs_is_closed*. Returns 200 the updated object (all default props + changed ones).
5. `POST /crm/v3/objects/{type}/batch/update` body `{inputs:[{id, properties}]}` (≤100) → 200
   `{status:"COMPLETE", results:[...], startedAt, completedAt}`; if any input invalid → 400 and NOTHING applied
   (fixture-approximation: all-or-nothing).
6. `POST /crm/v3/objects/{type}/batch/read` body `{inputs:[{id}], properties:[...]}` → same shape (no
   associations).
7. `GET /crm/v3/properties/{deals|companies}` → `{results:[{name,label,type,fieldType,description,groupName,options:[{label,value,displayOrder,hidden:false}],calculated,hasUniqueValue:false,modificationMetadata:{readOnlyValue}}]}`;
   `GET /crm/v3/properties/{type}/{name}` single or 404.
8. `GET /crm/v3/pipelines/deals` → `{results:[{id,label,displayOrder,archived:false,stages:[{id,label,displayOrder,archived:false,metadata:{isClosed:"false",probability:"0.2"}}]}]}`;
   `GET /crm/v3/pipelines/deals/{pipelineId}` and `/stages`.
9. `GET /crm/v4/objects/{fromType}/{fromId}/associations/{toType}?limit&after` (default limit 500) →
   `{results:[{toObjectId: <number>, associationTypes:[{category:"HUBSPOT_DEFINED",typeId:<n>,label:<str|null>}]}], paging?}`.
   company→deals: typeIds [342 unlabeled, 6 "Primary"]... use: deal→company `[{HUBSPOT_DEFINED,5,"Primary"},{HUBSPOT_DEFINED,341,null}]`,
   company→deal `[{HUBSPOT_DEFINED,6,"Primary"},{HUBSPOT_DEFINED,342,null}]`. Note `toObjectId` is a NUMBER.
otherHash fields (deals): dealname, amount, pipeline, closedate-if-not-auto, plus anything else user-editable
except dealstage, hs_next_step, review_tags. (Auto-set closedate on stage change is NOT an unintended edit.)
Canonical stageClass from current dealstage; nextStep = hs_next_step; tags = option VALUES mapped back to
canonical tag names (exec_review → exec-review).

## 5. Pipedrive (B) — API v2 (orgs, deals, pipelines, stages) + v1 fields

Docs: https://developers.pipedrive.com/docs/api/v1/Deals , https://pipedrive.readme.io/docs/core-api-concepts-pagination ,
https://pipedrive.readme.io/docs/core-api-concepts-custom-fields , https://pipedrive.readme.io/docs/core-api-concepts-authentication ,
v2 OpenAPI https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml (sha256 b14dad25…57d5)

Auth: header `x-api-token: <token>` (also accept legacy `?api_token=` query). Else 401
`{"success":false,"error":"unauthorized access","errorCode":401,"error_info":"Please check developers.pipedrive.com"}`.
Error envelope v2: `{"success":false,"error":"<message>","code":"<ERR_...>","error_info":"Please check developers.pipedrive.com","data":null,"additional_data":null}` (fixture-approximation of code names).

IDs: integers (orgs ~3 digits, deals ~3-4 digits, seeded). Org: `{id, name, owner_id, add_time, update_time,
visible_to, custom_fields:{<hash>: value}}`; org custom field "Domain" (varchar) — the only place the domain
lives. Deal: `{id, title, value (number), currency:"USD", status:"open"|"won"|"lost", stage_id, pipeline_id,
org_id, person_id:null, owner_id, add_time, update_time, stage_change_time, won_time, lost_time, close_time,
probability:null, custom_fields:{<hash>: value}}`. Deal custom fields: "Next step" (varchar),
"Review tags" (`set`, options [{id:int,label:"exec-review"},...]). Hash keys: 40 lowercase hex, seeded per tenant.
v2 `set` value = array of option IDs (integers); `varchar` = string.
Pipelines: "Sales" (id seeded small int) stages Qualified, Proposal made, Negotiations started; "Enterprise"
stages Discovery, Security review, Contract. NOTE: Pipedrive has NO won/lost stages: canonical closed deals
keep an ordinary stage_id and have status won/lost. stageClass = status.

Endpoints:
1. `GET /api/v2/organizations?limit&cursor&ids&sort_by&sort_direction` default limit 100, max 500. Response
   `{success:true, data:[...], additional_data:{next_cursor: "<opaque>"|null}}`.
2. `GET /api/v2/organizations/search?term&fields&exact_match&limit&cursor` (term ≥2 chars; fields subset of
   `name,address,custom_fields,notes`; custom_fields search matches varchar custom values) →
   `{success:true, data:{items:[{result_score:<n>, item:{id, type:"organization", name, address:null, visible_to, owner:{id}, custom_fields:[<matched string values>]}}]}, additional_data:{next_cursor}}`.
3. `GET /api/v2/organizations/{id}`.
4. `GET /api/v2/deals?org_id&status&pipeline_id&stage_id&filter_id&ids&limit&cursor&sort_by&sort_direction`
   default limit 100, max 500; `status` one of open|won|lost|deleted (comma list allowed); default excludes
   deleted. If `filter_id` present, owner/org/pipeline/stage params are IGNORED (documented) — no saved filters
   exist except id 1 "All open deals" (status=open). Response `{success:true, data:[deal...], additional_data:{next_cursor}}`.
5. `GET /api/v2/deals/{id}` → `{success:true, data:deal}` or 404 `{"success":false,"error":"Deal not found","code":"ERR_NOT_FOUND",...}`.
6. `GET /api/v2/deals/search?term&fields&exact_match&organization_id&status&limit&cursor` (fields title,
   custom_fields, notes) → items like org search with deal fields.
7. `PATCH /api/v2/deals/{id}` body any of `{title, value, currency, status, stage_id, pipeline_id, org_id,
   custom_fields:{hash: value}}`. Unknown top-level keys → 400 ERR_SCHEMA_VALIDATION_FAILED. Unknown custom
   field key (incl. using a field LABEL as key) → 400. `set` value must be an array of valid option ids; a
   string or labels → 400. Replacement semantics for set (the array is the new full set). status "won" sets
   won_time+close_time; stage_id must belong to pipeline. → `{success:true, data:deal}`.
8. `GET /api/v2/pipelines`, `GET /api/v2/stages?pipeline_id` → `{success:true, data:[{id, order_nr, name,
   pipeline_id, deal_probability, is_deal_rot_enabled:false, days_to_rotten:null, add_time, update_time}], additional_data:{next_cursor:null}}`.
9. `GET /api/v1/dealFields?start&limit` and `GET /api/v1/organizationFields` (v1 envelope,
   default limit 100, max 500) → `{success:true, data:[{id, key, name, field_type ("varchar","set","enum","monetary","int","double","date","org","people","status","stage"), options?:[{id,label}], edit_flag, active_flag:true, mandatory_flag:false}], additional_data:{pagination:{start, limit, more_items_in_collection:false}}}`.
   Include standard fields (title, value, status, stage_id, org_id, …) with their standard keys plus the two hashed
   custom fields (and org "Domain").
otherHash: title, value, currency, pipeline_id, stage_id, org_id + any custom fields other than the two.
Canonical: stageClass = status, nextStep = custom Next step, tags = option labels.

## 6. Zoho CRM v8 (C, near)

Docs: https://www.zoho.com/crm/developer/docs/api/v8/get-records.html , /search-records.html ,
/update-records.html , /get-related-records.html , /field-meta.html , /access-refresh.html ,
spec https://github.com/zoho/crm-oas (v8.0/record/record.yaml sha256 5397f63e…423a)

Auth: header `Authorization: Zoho-oauthtoken <token>`. Missing/other scheme (incl. `Bearer`) → 401
`{"code":"INVALID_TOKEN","details":{},"message":"invalid oauth token","status":"error"}`.
Error envelope: `{"code":"<CODE>","details":{...},"message":"...","status":"error"}`.

Base path `/crm/v8`. IDs: 19-digit decimal STRINGS (e.g. "5725767000001234567"), seeded. Modules `Accounts`,
`Deals`. Account: `{id, Account_Name, Website, Industry, Created_Time, Modified_Time, Owner:{name,id,email}}`.
Deal: `{id, Deal_Name, Stage, Amount, Closing_Date, Account_Name:{name, id}, Next_Step, Review_Tags:[...strings],
Probability, Created_Time, Modified_Time, Owner:{...}}`. Pipeline feature NOT enabled in this synthetic org.
Stages (picklist actual=display): "Qualification", "Needs Analysis", "Proposal/Price Quote",
"Negotiation/Review", "Closed Won", "Closed Lost", "Closed-Lost to Competition". Canonical: qualify→Qualification,
propose→Proposal/Price Quote, negotiate→Negotiation/Review, discovery→Needs Analysis,
security-review→Negotiation/Review? NO — use "Needs Analysis" for discovery and "Proposal/Price Quote" for
security-review; won-*→"Closed Won"; lost-default→"Closed Lost"; lost-enterprise→"Closed-Lost to Competition".
stageClass: "Closed Won"→won, the two lost→lost, else open. Review_Tags multiselect picklist values = the 6 tag
names.

Endpoints:
1. `GET /crm/v8/{module}?fields&page&per_page&sort_by&sort_order&page_token&ids` — `fields` REQUIRED (≤50) else
   400 `{"code":"REQUIRED_PARAM_MISSING","details":{"param":"fields"},"message":"One of the expected parameter is missing","status":"error"}`;
   unknown field name → 400 INVALID_DATA details {api_name}. per_page default 200 max 200; page ≥1. Response
   `{data:[records with requested fields + id], info:{per_page, count, page, sort_by, sort_order, more_records, next_page_token:null, previous_page_token:null, page_token_expiry:null}}`.
   Empty → HTTP 204 no body.
2. `GET /crm/v8/{module}/{id}` → `{data:[record all fields]}`; missing → 204? Use 400? Use documented
   `{"code":"INVALID_DATA","details":{"id":"..."},"message":"the related id given seems to be invalid","status":"error"}` 400 (fixture-approximation).
3. `GET /crm/v8/{module}/search?criteria|word|email|phone&fields&page&per_page` — criteria grammar
   `(Field:operator:value)`, combined with `and`/`or` and parentheses: `((A:equals:x)and(B:starts_with:y))`.
   Operators: equals, not_equal, starts_with, in (comma values), greater_than, greater_equal, less_than,
   less_equal, between. Lookup: `Account_Name.id:equals:<id>` and `Account_Name:equals:<name>`.
   **equals on text fields is contains-like (case-insensitive substring)** per research of the v8 search doc;
   picklist/number/id equality is exact. Values with `(` `)` `,` must be escaped with `\`. `fields` optional
   (default: all). per_page max 200. No match → 204. Response `{data, info:{count, more_records, page, per_page}}`.
   Missing criteria/word/email/phone → 400 REQUIRED_PARAM_MISSING. Malformed criteria → 400 INVALID_QUERY
   `{"code":"INVALID_QUERY","details":{"reason":"invalid criteria"...},...}`.
4. `GET /crm/v8/Accounts/{id}/Deals?fields&page&per_page` related list (fields required, same as 1) → same as
   list; 204 when none.
5. `PUT /crm/v8/{module}` body `{data:[{id, ...fields}], trigger?:[...]}` (≤100) and `PUT /crm/v8/{module}/{id}`
   body `{data:[{...fields}]}`. Per-row result
   `{code:"SUCCESS",details:{Modified_Time, Modified_By:{name,id}, Created_Time, id, Created_By:{name,id}},message:"record updated",status:"success"}`
   or `{code:"INVALID_DATA",details:{api_name:"X", expected_data_type?:"..."},message:"invalid data",status:"error"}`
   / `{code:"MANDATORY_NOT_FOUND"...}` / `{code:"INVALID_DATA", details:{id}, message:"the id given seems to be invalid"}`.
   HTTP: all success → 200; all failed → 400 with same `{data:[...]}` body; mixed → 207. Unknown api name →
   INVALID_DATA. Multiselect `Review_Tags` takes an ARRAY of strings and REPLACES the set; a string value or an
   unknown option → INVALID_DATA. Stage must be a valid picklist value. Read-only (`id`, Created_Time,
   Modified_Time) ignored? → INVALID_DATA for Created_Time/Modified_Time (fixture-approximation).
   Body without `data` array → 400 `{"code":"INVALID_DATA","details":{},"message":"body","status":"error"}`
   (fixture-approximation; real code may differ — mark it).
6. `GET /crm/v8/settings/fields?module=Deals|Accounts` → `{fields:[{api_name, field_label, display_label,
   data_type ("text","picklist","multiselectpicklist","lookup","currency","date","ownerlookup","integer","datetime"),
   read_only:bool, system_mandatory, pick_list_values?:[{display_value, actual_value, id, sequence_number, type:"used"}],
   lookup?:{module:{api_name,id}}, length}]}`. Missing module → 400 REQUIRED_PARAM_MISSING.
7. `GET /crm/v8/settings/modules` → `{modules:[{api_name:"Accounts",module_name:"Accounts",singular_label,plural_label,id},...Deals]}`.
otherHash: Deal_Name, Amount, Closing_Date, Account_Name.id, Probability. Canonical nextStep = Next_Step, tags = Review_Tags.

## 7. Attio (D, far) — REST v2

Docs: https://api.attio.com/openapi/api (OpenAPI 3.1, sha256 81e667ad…5a40), https://docs.attio.com/rest-api/guides/filtering-and-sorting ,
https://docs.attio.com/rest-api/guides/pagination , https://docs.attio.com/rest-api/endpoint-reference/records/upsert-a-record ,
https://docs.attio.com/mcp/overview

Auth `Authorization: Bearer <token>` else 401 `{"status_code":401,"type":"auth_error","code":"unauthorized","message":"Invalid or missing access token."}`
(fixture-approximation of message). Error envelope `{"status_code":N,"type":"invalid_request_error"|"auth_error","code":"validation_type"|"not_found"|"unknown_filter_attribute_slug"|"value_not_found"|...,"message":"..."}`.

IDs: UUID v4-format strings seeded; record id object `{workspace_id, object_id, record_id}`. Objects:
`companies` (attrs `name` text, `domains` domain multiselect), `deals` (attrs `name` text, `stage` status,
`value` currency, `associated_company` record-reference → companies, custom `next_step` text title "Next step",
custom `review_tags` select is_multiselect title "Review tags" with options = the 6 tag names). Deal statuses:
"Lead", "In Progress", "Negotiation", "Won 🎉", "Lost". Canonical: qualify→Lead, propose/discovery→In Progress,
negotiate/security-review→Negotiation, won-*→"Won 🎉", lost-*→"Lost". stageClass from title.

Value objects (every attribute value is an ARRAY; empty array when unset):
- text `{active_from, active_until:null, created_by_actor:{type:"api-token",id:"<uuid>"}, value:"…", attribute_type:"text"}`
- domain `{…, domain:"x.example", root_domain:"x.example", attribute_type:"domain"}`
- status `{…, status:{id:{workspace_id,object_id,attribute_id,status_id}, title, is_archived:false, target_time_in_status:null, celebration_enabled:bool}, attribute_type:"status"}`
- select `{…, option:{id:{workspace_id,object_id,attribute_id,option_id}, title, is_archived:false}, attribute_type:"select"}`
- currency `{…, currency_value: 12000, currency_code:"USD", attribute_type:"currency"}`
- record-reference `{…, target_object:"companies", target_record_id:"<uuid>", attribute_type:"record-reference"}`
Record: `{id:{workspace_id,object_id,record_id}, created_at, web_url:"https://app.attio.com/<ws>/<object>/<record_id>", values:{...}}`.

Endpoints:
1. `GET /v2/objects` → `{data:[{id:{workspace_id,object_id}, api_slug, singular_noun, plural_noun, created_at}]}`; `GET /v2/objects/{object}`.
2. `GET /v2/objects/{object}/attributes` → `{data:[{id:{workspace_id,object_id,attribute_id}, title, description, api_slug, type, is_system_attribute, is_writable, is_required, is_unique, is_multiselect, is_default_value_enabled:false, is_archived:false, default_value:null, relationship:null, created_at, config:{currency:{default_currency_code,display_type}|..., record_reference:{allowed_object_ids:[...]}}}]}`.
3. `GET /v2/objects/{object}/attributes/{attribute}/options` (select) → `{data:[{id:{...option_id}, title, is_archived}]}`;
   `GET /v2/objects/{object}/attributes/{attribute}/statuses` → `{data:[{id:{...status_id}, title, is_archived, target_time_in_status, celebration_enabled}]}`.
4. `POST /v2/objects/{object}/records/query` body `{filter?, sorts?, limit?, offset?}`; limit default 500;
   response `{data:[records]}` (no pagination metadata — caller pages with limit/offset). Unknown body keys
   (e.g. `filterGroups`, `properties`, `query`) → 400 validation_type "Body payload validation error". Filter
   grammar: logical `$and:[…]`, `$or:[…]`, `$not:{…}`; shorthand `{slug: value}` (equality on the main
   sub-property; for multiselect = contains option); verbose `{slug: {$op: v}}` or `{slug: {sub_property: {$op: v}}}`.
   Ops: `$eq`, `$contains`, `$starts_with`, `$ends_with`, `$in`, `$not_empty`, `$gt/$gte/$lt/$lte` (currency
   `currency_value`, timestamps). Sub-properties: text `value`; domain `domain`, `root_domain`; status `status`
   (match by status title OR status_id); select `option` (title or option_id); currency `currency_value`;
   record-reference `target_record_id`, `target_object`; also shorthand
   `{associated_company: {target_object:"companies", target_record_id:"<id>"}}`. Unknown slug → 400
   `unknown_filter_attribute_slug`; bad op for type → 400 `invalid_filter_operator`(fixture-approximation code).
   Sorts `[{attribute, direction:"asc"|"desc", field?}]`. Default order = creation order.
5. `GET /v2/objects/{object}/records/{record_id}` → `{data: record}`; 404 `{"status_code":404,"type":"invalid_request_error","code":"not_found","message":"Record with ID \"…\" not found."}`.
6. `PATCH /v2/objects/{object}/records/{record_id}` body `{data:{values:{slug: value}}}` → `{data: record}`.
   **Multiselect values supplied are ADDED to existing values (set union, no duplicates).** Single-value attributes
   replaced. `PUT` same path → **multiselect values supplied REPLACE existing values**; single-value replaced;
   attributes omitted from `values` untouched in both. Accepted input forms: raw scalar (`"text"`, `"exec-review"`
   option title, status title, number), array of scalars for multiselect, or value objects (`{value:"…"}`,
   `{option:"exec-review"}`, `{status:"Lost"}`, `{currency_value:1}`, `{target_object, target_record_id}`).
   Missing `data.values` (e.g. `{values:…}` or `{properties:…}`) → 400 validation_type. Unknown slug → 400
   `value_not_found`? use code `unknown_attribute_slug` (fixture-approximation). Unknown option title → 400
   `value_not_found`. Writing a non-writable attribute → 400.
7. `PUT /v2/objects/{object}/records?matching_attribute=<slug>` (assert/upsert) — implement for companies by
   `domains` and deals by unique attribute only if trivial; otherwise 400 `{code:"not_unique_attribute"}`
   for non-unique matching attribute. (deals have no unique attribute in this workspace.)
otherHash: name, value, associated_company, stage-excluded. Canonical nextStep = next_step value, tags = option titles.

## 8. QA (host fixture QA — NEVER model episodes, NEVER traces)

`eval/crm/qa/fixture-qa.test.ts` (vitest, run with `npx vitest run eval/crm/qa`): for each vendor, start
`createCrmFixture` on an ephemeral port, then a scripted REFERENCE policy using raw HTTP performs F1 exec-review
correctly (vendor-native: HubSpot via search+pipelines+PATCH with leading-`;` append AND, in a second
instance, read-existing+replace; Pipedrive via org search on Domain custom field + deals?org_id&status=open +
dealFields + PATCH custom_fields with merged option ids; Zoho via search Website + related Deals + PUT data[];
Attio via query domains + query deals by associated_company + PATCH) and F2 won-closeout; then asserts the
oracle (`eval/crm/oracle.ts`, written by the runner owner — QA may import it if present, otherwise assert
canonical state directly) reports exact success with 0 unintended writes. Also NEGATIVE QA per vendor showing
each documented transfer trap produces the documented error or a measurable wrong state (e.g. Attio PUT drops
existing tags; HubSpot non-leading-`;` replace drops tags; Pipedrive label-as-key 400; Zoho Bearer 401;
Zoho missing fields 400; HubSpot default search page has 10 of 12; Attio filterGroups 400). Determinism test:
same seed → identical `/__state.canonical`; different seed → different native IDs.
