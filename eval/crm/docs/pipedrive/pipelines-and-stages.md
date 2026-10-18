---
title: Pipedrive — Pipelines, stages and deal status
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Concepts

- A **pipeline** is an ordered sequence of **stages** that open deals move through.
- An account can have several pipelines; each stage belongs to exactly one pipeline.
- A deal's **`status`** (`open`, `won`, `lost`) is a separate field from its **`stage_id`**.
  Pipedrive has no "won" or "lost" stages: winning or losing a deal is done by setting `status`,
  and the deal keeps whatever `stage_id` it had (typically the last stage it reached).

Consequently:

- "Open deals" means `status=open`, regardless of stage.
- A deal in the last stage of a pipeline is not necessarily won.
- Filtering by `stage_id` alone returns deals of every status in that stage.

Pipeline and stage ids and names are configured per account; read them from the API rather than
assuming them.

## List pipelines

```
GET /api/v2/pipelines
```

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Main pipeline",
      "order_nr": 1,
      "is_deal_probability_enabled": false,
      "add_time": "2026-01-01T00:00:00Z",
      "update_time": "2026-01-01T00:00:00Z"
    }
  ],
  "additional_data": { "next_cursor": null }
}
```

## List stages

```
GET /api/v2/stages?pipeline_id=1
```

Omit `pipeline_id` to list stages of all pipelines.

```json
{
  "success": true,
  "data": [
    {
      "id": 3,
      "order_nr": 1,
      "name": "Initial contact",
      "pipeline_id": 1,
      "deal_probability": 20,
      "is_deal_rot_enabled": false,
      "days_to_rotten": null,
      "add_time": "2026-01-01T00:00:00Z",
      "update_time": "2026-01-01T00:00:00Z"
    }
  ],
  "additional_data": { "next_cursor": null }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stage id used in a deal's `stage_id` |
| `order_nr` | Position within the pipeline |
| `pipeline_id` | Owning pipeline |
| `deal_probability` | Default win probability (0-100) for deals in this stage |
| `is_deal_rot_enabled`, `days_to_rotten` | Rotting settings |

## Moving deals

Move a deal to another stage in the same pipeline:

```json
PATCH /api/v2/deals/1201
{ "stage_id": 4 }
```

Move to another pipeline by sending both ids; the stage must belong to the new pipeline:

```json
{ "pipeline_id": 2, "stage_id": 7 }
```

A `stage_id` that does not belong to the deal's pipeline returns 400.

## Closing deals

```json
PATCH /api/v2/deals/1201
{ "status": "won" }
```

```json
{ "status": "lost" }
```

Won sets `won_time` and `close_time`; lost sets `lost_time` and `close_time`. Reopen with
`{"status": "open"}`. None of these change `stage_id`.

## Filtering by status and stage

```
GET /api/v2/deals?status=open&pipeline_id=1
GET /api/v2/deals?status=won,lost
GET /api/v2/deals?stage_id=3&status=open
```

Without `status`, all non-deleted deals (open, won and lost) are returned.
