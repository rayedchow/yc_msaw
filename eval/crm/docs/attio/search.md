---
title: Attio — Querying records (filtering and sorting)
vendor: attio
snapshot: 2026-10-17
sources:
  - https://docs.attio.com/rest-api/guides/filtering-and-sorting
  - https://api.attio.com/openapi/api
  - https://docs.attio.com/rest-api/guides/pagination
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# List / query records

```
POST /v2/objects/{object}/records/query
```

Listing and filtering records is a **POST** with a JSON body, even though it does not modify data. The
body accepts only these keys, all optional:

| Key | Type | Meaning |
|-----|------|---------|
| `filter` | object | Filter expression (grammar below). Omit for all records. |
| `sorts` | array | Sort rules. |
| `limit` | integer | Max records to return (default 500). |
| `offset` | integer | Number of records to skip (default 0). |

Any other top-level key is rejected with 400:

```json
{ "status_code": 400, "type": "invalid_request_error", "code": "validation_type",
  "message": "Body payload validation error." }
```

Response:

```json
{ "data": [ { "id": { "...": "..." }, "created_at": "...", "web_url": "...", "values": { } } ] }
```

There is no `total` and no paging object in the response; see `pagination.md`. Without `sorts`, records
come back in creation order.

# Filter grammar

## Shorthand

The simplest filter maps an attribute slug to a value. It tests equality on the attribute's main
sub-property (see the table in `objects-and-fields.md`). For multiselect attributes, the shorthand
means "contains this value".

```json
{ "filter": { "name": "Acme" } }
{ "filter": { "domains": "acme.test" } }
{ "filter": { "categories": "Enterprise" } }
```

Several keys in the same object are combined with AND.

## Verbose form

Use an operator object, optionally nested under a sub-property:

```json
{ "filter": { "name": { "$starts_with": "Ac" } } }
{ "filter": { "domains": { "root_domain": { "$eq": "acme.test" } } } }
{ "filter": { "value": { "currency_value": { "$gte": 10000 } } } }
```

## Logical operators

```json
{
  "filter": {
    "$and": [
      { "categories": "Enterprise" },
      { "$or": [
          { "name": { "$contains": "Acme" } },
          { "domains": { "domain": { "$ends_with": ".test" } } }
      ] },
      { "$not": { "name": { "$eq": "Acme Holdings" } } }
    ]
  }
}
```

`$and` and `$or` take arrays of filter expressions; `$not` takes a single expression.

## Comparison operators

| Operator | Applies to |
|----------|-----------|
| `$eq` | Most types (exact match on the chosen sub-property) |
| `$contains` | Text-like sub-properties (substring) |
| `$starts_with`, `$ends_with` | Text-like sub-properties |
| `$in` | Array of candidate values |
| `$not_empty` | `true` — attribute has at least one value |
| `$gt`, `$gte`, `$lt`, `$lte` | Numbers (e.g. `currency_value`) and timestamps |

## Sub-properties by attribute type

| Type | Sub-properties |
|------|----------------|
| `text` | `value` |
| `domain` | `domain`, `root_domain` |
| `status` | `status` — matches the status **title** or its **status_id** |
| `select` | `option` — matches the option **title** or its **option_id** |
| `currency` | `currency_value` |
| `record-reference` | `target_record_id`, `target_object` |

Examples:

```json
{ "filter": { "stage": { "status": { "$eq": "In review" } } } }
{ "filter": { "categories": { "option": { "$in": ["Enterprise", "SMB"] } } } }
```

## Errors

- Unknown attribute slug in a filter → 400 with `code: "unknown_filter_attribute_slug"`.
- An operator not valid for the attribute type → 400 with `code: "invalid_filter_operator"`
  (benchmark fixture detail: the exact code string is the fixture's).
- Malformed body → 400 `validation_type`.

```json
{ "status_code": 400, "type": "invalid_request_error",
  "code": "unknown_filter_attribute_slug",
  "message": "Unknown attribute slug: \"industry_code\"." }
```

# Sorting

```json
{
  "sorts": [
    { "attribute": "name", "direction": "asc" },
    { "attribute": "domains", "field": "root_domain", "direction": "desc" }
  ]
}
```

`direction` is `asc` or `desc`; `field` optionally selects a sub-property.

# Get a single record

```
GET /v2/objects/{object}/records/{record_id}
```

Returns `{ "data": <record> }`. A missing record returns 404:

```json
{ "status_code": 404, "type": "invalid_request_error", "code": "not_found",
  "message": "Record with ID \"<uuid>\" not found." }
```

# Notes

- Record query is exact/structured matching. Attio's fuzzy full-text search (used by some tools) is a
  different feature with different matching behaviour.
- Filter keys are attribute slugs. Filter shapes from other CRMs (for example `filterGroups` arrays)
  are not part of this grammar and are rejected as unknown body keys.
