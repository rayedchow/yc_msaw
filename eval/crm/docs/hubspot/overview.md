---
title: HubSpot — Overview, authentication, IDs and errors
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
  - https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/guide
  - https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## What this subset covers

HubSpot's CRM stores records as *objects* (companies, contacts, deals, tickets, custom
objects). This snapshot covers the parts of the CRM API used to read and update
**companies** and **deals**:

| Area | Version / path prefix | Page |
| --- | --- | --- |
| Object list, read, update, batch read/update | `/crm/v3/objects/{objectType}` | `objects-and-fields.md`, `updating-records.md` |
| Search | `POST /crm/v3/objects/{objectType}/search` | `search.md` |
| Property definitions | `/crm/v3/properties/{objectType}` | `objects-and-fields.md` |
| Deal pipelines and stages | `/crm/v3/pipelines/deals` | `pipelines-and-stages.md` |
| Associations (read) | `/crm/v4/objects/{fromType}/{fromId}/associations/{toType}` | `associations.md` |

HubSpot also publishes date-versioned paths (for example `/crm/objects/2026-09/{object}/search`).
This snapshot pins the long-standing `v3` object/search/properties/pipelines paths and the `v4`
associations path. The two families are documented separately; do not mix them in one request.

Object type names in paths are the plural lowercase names: `companies`, `deals`.

## Base URL

The public API host is `https://api.hubapi.com`. In this benchmark, the connection supplies the
base URL; append the paths above to it unchanged.

## Authentication

HubSpot accepts OAuth 2.0 access tokens and private-app access tokens. Both are sent as a bearer
token:

```http
GET /crm/v3/objects/deals?limit=10 HTTP/1.1
Host: api.hubapi.com
Authorization: Bearer <access-token>
```

A missing or invalid token returns HTTP 401 with category `INVALID_AUTHENTICATION`:

```json
{
  "status": "error",
  "message": "Authentication credentials not found. This API supports OAuth 2.0 authentication ...",
  "correlationId": "5f1c0a8e-1d2b-4c1e-9a77-0c3b2f6d1e10",
  "category": "INVALID_AUTHENTICATION"
}
```

## Record IDs

- Record IDs are numeric but are returned and accepted as **strings** (`"id": "18394027461"`).
  Keep them as strings; do not do arithmetic on them.
- Every object also exposes the read-only property `hs_object_id`, which holds the same value.
- IDs are account-specific. An ID from one HubSpot account means nothing in another.
- In v4 association responses the related ID is returned as a JSON **number** in `toObjectId`
  (see `associations.md`). Convert it to a string before using it in an object path or in a
  filter value if you want to compare like for like.

## Record shape

Every object read returns the same envelope. User data lives under `properties`, and all
property values are strings (or `null`), including numbers, dates and booleans:

```json
{
  "id": "18394027461",
  "properties": {
    "dealname": "Acme - annual contract",
    "amount": "42000",
    "dealstage": "appointmentscheduled",
    "pipeline": "default",
    "closedate": null,
    "createdate": "2026-01-05T09:12:00.000Z",
    "hs_lastmodifieddate": "2026-02-01T14:30:11.000Z",
    "hs_object_id": "18394027461"
  },
  "createdAt": "2026-01-05T09:12:00.000Z",
  "updatedAt": "2026-02-01T14:30:11.000Z",
  "archived": false
}
```

Writes also wrap values in a `properties` object (see `updating-records.md`).

## Error format

All CRM v3 errors share one JSON envelope:

```json
{
  "status": "error",
  "message": "Property values were not valid: ...",
  "correlationId": "b0e0b6a4-3a8e-4d38-9b3e-7f8a2c1d9e55",
  "category": "VALIDATION_ERROR",
  "errors": [
    {
      "message": "Property \"lead_score_x\" does not exist",
      "code": "PROPERTY_DOESNT_EXIST",
      "context": { "propertyName": ["lead_score_x"] }
    }
  ]
}
```

| HTTP | `category` | Typical cause |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Bad JSON, unknown body field, unknown property, invalid option value, read-only property, stage not in pipeline, limit too high, too many filters |
| 401 | `INVALID_AUTHENTICATION` | Missing or invalid token |
| 404 | `OBJECT_NOT_FOUND` | Record ID does not exist (or is archived) for that object type |
| 404 | (HubSpot-style not-found) | Unknown path |
| 405 | — | Method not supported on that path |
| 413 | — | Request body too large |

- `errors[]` is optional and carries per-problem details with a machine-readable `code`
  (for example `PROPERTY_DOESNT_EXIST`, `INVALID_OPTION`, `READ_ONLY_VALUE`) and a `context` object.
- `correlationId` identifies the request; it is also returned in the response header
  `x-hubspot-correlation-id`. Quote it when reporting a problem.
- A 4xx response means the request was rejected; for single-record PATCH nothing was written.

## Rate limits and consistency notes

- Search requests are documented as limited per account per second, and a single search query
  can page through at most 10,000 results.
- Search is backed by an index and may lag very recent writes for a short time. Reading a record
  by ID returns its current stored state.
