---
title: Attio — Overview, authentication, base URL and identifiers
vendor: attio
snapshot: 2026-10-17
sources:
  - https://api.attio.com/openapi/api
  - https://docs.attio.com/rest-api/guides/authentication
  - https://docs.attio.com/rest-api/guides/filtering-and-sorting
  - https://docs.attio.com/mcp/overview
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# Overview

Attio's REST API (version 2) exposes a workspace's **objects** (for example `companies`, `people`,
`deals`), the **attributes** defined on each object, and the **records** stored in each object. Every
record holds its data as a map of attribute slugs to **arrays of typed value objects**. The API is
JSON in and JSON out.

This snapshot covers the subset used here: object and attribute metadata, select options and statuses,
record query, single-record read, and record update (PATCH / PUT / assert).

## Base URL

```
https://api.attio.com/v2
```

All paths in these pages are written relative to the host, including the `/v2` prefix, e.g.
`GET /v2/objects/companies/attributes`. When calling through a connection-scoped HTTP tool, the
connection supplies the host; you supply the method, the `/v2/...` path and the JSON body.

## Authentication

Requests are authenticated with a bearer token in the `Authorization` header. Both workspace API
tokens (created in workspace settings) and OAuth 2.0 access tokens use the same header form:

```
Authorization: Bearer <access_token>
```

Token scopes control which objects and operations are permitted. A missing or invalid token returns
HTTP 401:

```json
{
  "status_code": 401,
  "type": "auth_error",
  "code": "unauthorized",
  "message": "Invalid or missing access token."
}
```

(benchmark fixture detail) The exact wording of the 401 message is the fixture's own.

## Identifiers

Attio identifiers are UUID strings. Most resources return a **composite id object** rather than a
single scalar:

| Resource  | `id` shape |
|-----------|------------|
| Object    | `{ "workspace_id", "object_id" }` |
| Attribute | `{ "workspace_id", "object_id", "attribute_id" }` |
| Select option | `{ "workspace_id", "object_id", "attribute_id", "option_id" }` |
| Status    | `{ "workspace_id", "object_id", "attribute_id", "status_id" }` |
| Record    | `{ "workspace_id", "object_id", "record_id" }` |

Path parameters take the inner UUID only — for a record, use `id.record_id` in
`/v2/objects/{object}/records/{record_id}`. The `{object}` path parameter accepts either the object's
`api_slug` (e.g. `companies`) or its `object_id` UUID. Likewise attributes are addressed by `api_slug`
or `attribute_id`.

## Records and values

A record looks like:

```json
{
  "id": {
    "workspace_id": "<workspace uuid>",
    "object_id": "<object uuid>",
    "record_id": "<record uuid>"
  },
  "created_at": "2026-09-01T10:00:00.000Z",
  "web_url": "https://app.attio.com/<workspace-slug>/companies/<record uuid>",
  "values": {
    "name": [
      { "active_from": "...", "active_until": null,
        "created_by_actor": { "type": "api-token", "id": "<uuid>" },
        "value": "Acme", "attribute_type": "text" }
    ],
    "domains": [
      { "active_from": "...", "active_until": null,
        "created_by_actor": { "type": "api-token", "id": "<uuid>" },
        "domain": "acme.test", "root_domain": "acme.test",
        "attribute_type": "domain" }
    ]
  }
}
```

Key points:

- **Every attribute value is an array**, even single-value attributes. An unset attribute is an empty
  array `[]`.
- Each element carries metadata (`active_from`, `active_until`, `created_by_actor`) plus type-specific
  fields and an `attribute_type` discriminator. See `objects-and-fields.md` for each type's shape.
- Attribute keys under `values` are attribute **slugs** (`api_slug`), not display titles.

## Response envelope

Successful responses wrap the payload in a top-level `data` key: a single object for reads of one
resource, an array for lists and queries.

```json
{ "data": { "id": { "...": "..." }, "values": { } } }
{ "data": [ { }, { } ] }
```

## Error format

Errors use a flat envelope:

```json
{
  "status_code": 400,
  "type": "invalid_request_error",
  "code": "validation_type",
  "message": "Body payload validation error."
}
```

| Field | Meaning |
|-------|---------|
| `status_code` | Mirrors the HTTP status |
| `type` | Broad class: `invalid_request_error`, `auth_error`, ... |
| `code` | Machine-readable reason, e.g. `validation_type`, `not_found`, `unknown_filter_attribute_slug`, `value_not_found` |
| `message` | Human-readable explanation |

Common statuses in this subset: 400 (validation), 401 (auth), 404 (unknown record/object/attribute or
unknown path), 405 (method not allowed on a known path), 413 (body too large).

## Pages in this section

- `objects-and-fields.md` — object, attribute, option and status metadata; value shapes.
- `search.md` — `POST /v2/objects/{object}/records/query` filter and sort grammar.
- `pagination.md` — `limit` / `offset` for record queries.
- `associations.md` — record-reference attributes.
- `updating-records.md` — PATCH vs PUT, multiselect semantics, assert.
- `pipelines-and-stages.md` — status attributes used as stages.
