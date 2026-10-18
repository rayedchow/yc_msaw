---
title: Attio — Pipelines, stages and status attributes
vendor: attio
snapshot: 2026-10-17
sources:
  - https://api.attio.com/openapi/api
  - https://docs.attio.com/rest-api/guides/filtering-and-sorting
  - https://docs.attio.com/mcp/overview
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# Stages as status attributes

Attio represents a pipeline stage as a **status attribute**: a single-value attribute whose allowed
values are a configured, ordered set of statuses. On the standard `deals` object the stage is the
`stage` attribute (`type: "status"`).

There is no separate "pipeline" object and no separate open/won/lost flag in this subset. Whether a
status represents an open, won or lost outcome is conveyed only by the status itself (its title as
configured by the workspace). Status titles are workspace-specific and can be renamed; read them
rather than assuming them.

## Listing statuses

```
GET /v2/objects/deals/attributes/stage/statuses
```

```json
{
  "data": [
    {
      "id": { "workspace_id": "<uuid>", "object_id": "<uuid>",
              "attribute_id": "<uuid>", "status_id": "<uuid>" },
      "title": "In review",
      "is_archived": false,
      "target_time_in_status": null,
      "celebration_enabled": false
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `title` | Display name of the status; also usable as input and in filters. |
| `status_id` | Stable UUID of the status. |
| `is_archived` | Archived statuses cannot be newly assigned. |
| `target_time_in_status` | Optional duration target for records in this status (null if unset). |
| `celebration_enabled` | Whether the UI celebrates moving a record into this status — typically enabled on a "won"-type status. It is a UI flag, not an outcome field. |

Order of the array is the configured order of the stages.

## Reading a record's stage

```json
"stage": [
  {
    "active_from": "2026-09-01T10:00:00.000Z",
    "active_until": null,
    "created_by_actor": { "type": "api-token", "id": "<uuid>" },
    "status": {
      "id": { "...": "...", "status_id": "<uuid>" },
      "title": "In review",
      "is_archived": false,
      "target_time_in_status": null,
      "celebration_enabled": false
    },
    "attribute_type": "status"
  }
]
```

## Filtering by stage

The `status` sub-property matches the status **title** or **status_id**:

```json
POST /v2/objects/deals/records/query
{ "filter": { "stage": "In review" } }

{ "filter": { "stage": { "status": { "$eq": "<status_id>" } } } }

{ "filter": { "stage": { "status": { "$in": ["In review", "Proposal"] } } } }

{ "filter": { "$not": { "stage": { "status": { "$eq": "In review" } } } } }
```

## Changing a record's stage

Write the status title or id (single-value, so PATCH and PUT both replace it):

```json
PATCH /v2/objects/deals/records/<record uuid>
{ "data": { "values": { "stage": "In review" } } }

PATCH /v2/objects/deals/records/<record uuid>
{ "data": { "values": { "stage": [ { "status": "<status_id>" } ] } } }
```

An unknown title or id returns 400 `value_not_found`. Status matching is by exact title; check
spelling, casing and any emoji or punctuation in the configured titles.

# Lists and entries (context)

Attio also supports **lists**: collections of records (for example a sales pipeline list of
companies) where each membership is an **entry** with its own entry-level attributes, often including a
status attribute used as the list's stage. An entry has its own `entry_id`, which is **not** the
parent record's `record_id`; updating an entry's stage is a different operation from updating a
record attribute. Lists and entries are outside this benchmark subset: here, stages live directly on
records as status attributes.
