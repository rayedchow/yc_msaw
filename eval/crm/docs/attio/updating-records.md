---
title: Attio — Updating records (PATCH, PUT and assert)
vendor: attio
snapshot: 2026-10-17
sources:
  - https://api.attio.com/openapi/api
  - https://docs.attio.com/rest-api/endpoint-reference/records/upsert-a-record
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# Updating a record

Attio offers two update methods on the same path, which differ **only in how multiselect attributes
are treated**:

```
PATCH /v2/objects/{object}/records/{record_id}
PUT   /v2/objects/{object}/records/{record_id}
```

| Method | Single-value attributes | Multiselect attributes | Attributes omitted from `values` |
|--------|------------------------|------------------------|-------------------------------|
| `PATCH` | Replaced | Supplied values are **added** to the existing values (no duplicates) | Untouched |
| `PUT` | Replaced | Supplied values **replace** all existing values | Untouched |

Example: a company has `categories` = `["Enterprise"]` (multiselect select).

```
PATCH ... { "data": { "values": { "categories": ["Partner"] } } }
→ categories = ["Enterprise", "Partner"]

PUT   ... { "data": { "values": { "categories": ["Partner"] } } }
→ categories = ["Partner"]
```

To remove one multiselect value, use `PUT` with the full desired set. To clear, `PUT` an empty array.

## Request envelope

The body must be `{ "data": { "values": { <slug>: <value> } } }`.

```json
PATCH /v2/objects/companies/records/<record uuid>
{
  "data": {
    "values": {
      "name": "Acme Holdings",
      "categories": ["Partner"]
    }
  }
}
```

A body without `data.values` (for example a top-level `values` key, or a `properties` map) is rejected:

```json
{ "status_code": 400, "type": "invalid_request_error", "code": "validation_type",
  "message": "Body payload validation error." }
```

The response is `{ "data": <full updated record> }`.

## Accepted value input forms

For each slug you may pass a single input or an array of inputs (arrays are natural for multiselect).
Each input can be a raw scalar or a partial value object:

| Type | Raw form | Object form |
|------|----------|-------------|
| `text` | `"Acme"` | `{ "value": "Acme" }` |
| `select` | option title `"Partner"` | `{ "option": "Partner" }` (title or option_id) |
| `status` | status title | `{ "status": "<title or status_id>" }` |
| `currency` | `12000` | `{ "currency_value": 12000 }` |
| `domain` | `"acme.test"` | `{ "domain": "acme.test" }` |
| `record-reference` | — | `{ "target_object": "companies", "target_record_id": "<uuid>" }` |

Read-only metadata fields in value objects (`active_from`, `created_by_actor`, `attribute_type`) are
not needed on input.

## Errors

| Situation | Status | `code` |
|-----------|--------|--------|
| Missing `data.values` / wrong envelope | 400 | `validation_type` |
| Slug not defined on the object | 400 | `unknown_attribute_slug` (benchmark fixture detail: exact code string is the fixture's) |
| Select option or status title/id not found | 400 | `value_not_found` |
| Attribute has `is_writable: false` | 400 | `validation_type` |
| Record does not exist | 404 | `not_found` |

```json
{ "status_code": 400, "type": "invalid_request_error", "code": "value_not_found",
  "message": "Cannot find select option with title \"Parnter\"." }
```

Updates are atomic per request: if any attribute is invalid, nothing is written.

# Assert (upsert) a record

```
PUT /v2/objects/{object}/records?matching_attribute=<slug>
```

Body is the same `{ "data": { "values": { ... } } }` envelope. Attio looks for an existing record whose
`matching_attribute` value equals the supplied one: if found, it is updated; otherwise a record is
created. Per the vendor docs, for a multiselect matching attribute the matching values are kept and
other supplied values added, while other supplied multiselect attributes are replaced.

The matching attribute **must be unique** (`is_unique: true`). Otherwise:

```json
{ "status_code": 400, "type": "invalid_request_error", "code": "not_unique_attribute",
  "message": "Matching attribute must be a unique attribute." }
```

(benchmark fixture detail) Assert is implemented only for simple cases in this fixture; objects
without a unique attribute return the error above.

# Choosing a method

- Know whether the target attribute is multiselect (`is_multiselect` in the attribute list).
- Re-read the record after writing if you need to confirm the final value set.
