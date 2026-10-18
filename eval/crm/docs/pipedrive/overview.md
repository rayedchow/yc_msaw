---
title: Pipedrive — Overview, authentication, IDs and errors
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://pipedrive.readme.io/docs/core-api-concepts-authentication
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  - https://pipedrive.readme.io/docs/core-api-concepts-pagination
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## What this subset covers

Pipedrive is a deal-centric sales CRM. This snapshot covers the subset of the REST API used to
read organizations and deals, discover custom fields, look up pipelines and stages, and update
deals:

| Area | Version | Endpoints |
| --- | --- | --- |
| Organizations | v2 | `GET /api/v2/organizations`, `GET /api/v2/organizations/{id}`, `GET /api/v2/organizations/search`, `PATCH /api/v2/organizations/{id}` |
| Deals | v2 | `GET /api/v2/deals`, `GET /api/v2/deals/{id}`, `GET /api/v2/deals/search`, `PATCH /api/v2/deals/{id}` |
| Pipelines and stages | v2 | `GET /api/v2/pipelines`, `GET /api/v2/stages` |
| Field metadata | v1 | `GET /api/v1/dealFields`, `GET /api/v1/organizationFields` |

## API versions

Pipedrive exposes two API generations side by side. Most core entities (deals, organizations,
persons, pipelines, stages) have v2 endpoints under `/api/v2/...`. Some resources — including the
field-metadata endpoints — are still served only by v1 under `/api/v1/...`. The two generations
differ in pagination style (see `pagination.md`) and in some response details, so check which
version an endpoint belongs to before reusing a request pattern from another endpoint.

## Base URL

Production requests are sent to your company domain, e.g. `https://{companydomain}.pipedrive.com`,
or to `https://api.pipedrive.com`. Paths in this documentation are relative to that base, e.g.
`/api/v2/deals`. When you call through a connection, the connection supplies the base URL.

## Authentication

Two mechanisms are documented:

- **API token** — a personal token tied to one user in one company. Send it in the request header:

  ```http
  GET /api/v2/deals HTTP/1.1
  x-api-token: <your-api-token>
  ```

  The legacy form `?api_token=<token>` as a query parameter is still accepted, but the header is the
  documented recommendation (query-string credentials can leak into logs).
- **OAuth 2.0** — recommended for apps installed by many companies; send
  `Authorization: Bearer <access_token>`.

A user has a single active API token; regenerating it invalidates integrations that used the old one.

A request without valid credentials returns HTTP 401:

```json
{
  "success": false,
  "error": "unauthorized access",
  "errorCode": 401,
  "error_info": "Please check developers.pipedrive.com"
}
```

## IDs

- Organizations, deals, persons, pipelines, stages and users are identified by **integers**.
- References between records are integer fields: `org_id`, `person_id`, `pipeline_id`, `stage_id`,
  `owner_id`.
- Custom fields are identified by a **40-character hexadecimal key** that is generated per company
  account (see `objects-and-fields.md`). The same field label in two different accounts has two
  different keys.

## Response envelope

Successful v2 responses use a common envelope:

```json
{
  "success": true,
  "data": { "id": 42, "title": "Acme expansion" },
  "additional_data": null
}
```

List endpoints return `data` as an array and put pagination state in `additional_data`
(`next_cursor` in v2; `pagination` in v1).

## Error format

Errors set `success` to `false` and describe the problem in `error`. v2 errors carry a machine code:

```json
{
  "success": false,
  "error": "Deal not found",
  "code": "ERR_NOT_FOUND",
  "error_info": "Please check developers.pipedrive.com",
  "data": null,
  "additional_data": null
}
```

Common HTTP statuses:

| Status | Meaning |
| --- | --- |
| 400 | Request failed validation (unknown body key, wrong value type, invalid option id, stage not in pipeline, malformed JSON) |
| 401 | Missing or invalid credentials |
| 404 | Resource or path not found |
| 405 | Method not allowed on this path |
| 413 | Request body too large |

The exact `code` strings used here (for example `ERR_NOT_FOUND`, `ERR_SCHEMA_VALIDATION_FAILED`)
follow the v2 naming pattern (benchmark fixture detail).

## Related pages

- `objects-and-fields.md` — record shapes and field metadata
- `search.md` — search endpoints and list filters
- `pagination.md` — cursor and offset pagination
- `associations.md` — linking deals to organizations and persons
- `updating-records.md` — PATCH semantics, custom field values
- `pipelines-and-stages.md` — pipelines, stages and deal status
