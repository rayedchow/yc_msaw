---
title: Pipedrive — Search and list filters
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  - https://pipedrive.readme.io/docs/core-api-concepts-custom-fields
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

Pipedrive has two ways to find records: **search endpoints** (term-based, scored) and **list
endpoints with filter parameters** (exact parameter filters). All are `GET` requests with query
parameters; there is no JSON filter body.

## Search organizations

```
GET /api/v2/organizations/search?term=acme&fields=name&exact_match=false&limit=20
```

| Parameter | Description |
| --- | --- |
| `term` | Search term, minimum 2 characters (URL-encode it). Required. |
| `fields` | Comma list of fields to search: `name`, `address`, `custom_fields`, `notes`. Default: all. |
| `exact_match` | `true` to return only exact (case-insensitive) matches instead of partial matches. |
| `limit`, `cursor` | Cursor pagination (see `pagination.md`). |

Searching `custom_fields` matches text (`varchar`) custom-field values, e.g. a "Website" custom
field on organizations.

Response:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "result_score": 1.02,
        "item": {
          "id": 17,
          "type": "organization",
          "name": "Acme",
          "address": null,
          "visible_to": 3,
          "owner": { "id": 9 },
          "custom_fields": ["https://acme.test"]
        }
      }
    ]
  },
  "additional_data": { "next_cursor": null }
}
```

Note that in search results `custom_fields` is a list of the matched string values, not the
key→value object returned by `GET /organizations/{id}`. Search results are ranked by score;
several organizations can share a name, so inspect the returned items before acting on one.

## Search deals

```
GET /api/v2/deals/search?term=expansion&fields=title&organization_id=17&status=open
```

| Parameter | Description |
| --- | --- |
| `term` | Required, minimum 2 characters. |
| `fields` | Comma list of `title`, `custom_fields`, `notes`. |
| `exact_match` | Exact instead of partial matching. |
| `organization_id` | Only deals linked to this organization. |
| `status` | `open`, `won`, `lost`. |
| `limit`, `cursor` | Cursor pagination. |

Items have the same `{result_score, item}` wrapper with `item.type` = `"deal"` and deal summary
fields (`id`, `title`, `value`, `currency`, `status`, `stage`, `organization`, `owner`, ...).

## Listing deals with filters

```
GET /api/v2/deals?org_id=17&status=open&limit=100
```

| Parameter | Description |
| --- | --- |
| `org_id` | Only deals linked to this organization. |
| `person_id` | Only deals linked to this person. |
| `owner_id` | Only deals owned by this user. |
| `pipeline_id` | Only deals in this pipeline. |
| `stage_id` | Only deals in this stage. |
| `status` | `open`, `won`, `lost`, `deleted`; a comma list is allowed (`won,lost`). When omitted, all non-deleted deals are returned. |
| `ids` | Comma list of deal ids. |
| `filter_id` | Id of a saved filter (see below). |
| `sort_by` | `id`, `add_time`, `update_time`. Default `id`. |
| `sort_direction` | `asc` (default) or `desc`. |
| `limit`, `cursor` | Cursor pagination; default 100, max 500. |

Parameters combine with AND.

### `filter_id` overrides other filters

When `filter_id` is supplied, the saved filter's own conditions apply and the direct
`owner_id`, `person_id`, `org_id`, `pipeline_id` and `stage_id` parameters are **ignored**. Mixing
a saved filter with direct parameters therefore does not narrow the result; it can return records
outside the intended organization or pipeline. Saved filters are account-specific.

## Listing organizations

```
GET /api/v2/organizations?limit=100&sort_by=id&sort_direction=asc
```

Supports `ids`, `owner_id`, `filter_id`, `sort_by`, `sort_direction`, `limit`, `cursor`. There is
no free-text filter on this endpoint; use `/organizations/search` for term matching.

## Errors

- `term` shorter than 2 characters, unknown `fields` values, or invalid `status` → 400.
- `limit` above 500 → 400.
