---
title: Pipedrive — Pagination
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://pipedrive.readme.io/docs/core-api-concepts-pagination
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

Pipedrive uses **two pagination styles** depending on the API version of the endpoint. Do not assume
one style for every endpoint.

## Cursor pagination (v2 endpoints)

Used by `/api/v2/organizations`, `/api/v2/deals`, `/api/v2/organizations/search`,
`/api/v2/deals/search`, `/api/v2/pipelines`, `/api/v2/stages`.

| Parameter | Description |
| --- | --- |
| `limit` | Items per page. Default 100, maximum 500. |
| `cursor` | Opaque marker returned by the previous page. Omit for the first page. |

The response carries the next marker in `additional_data.next_cursor`:

```json
{
  "success": true,
  "data": [ { "id": 1201 }, { "id": 1202 } ],
  "additional_data": { "next_cursor": "eyJpZCI6MTIwMn0" }
}
```

To fetch the next page, repeat the same request with the same filters and add
`cursor=<next_cursor>`:

```
GET /api/v2/deals?org_id=17&status=open&limit=100&cursor=eyJpZCI6MTIwMn0
```

When `next_cursor` is `null` there are no more results.

Rules:

- Treat the cursor as an **opaque string**. Do not decode it, construct it, or do arithmetic on it.
- Keep all other query parameters identical between pages.
- A short page does not by itself mean the end; rely on `next_cursor`.

## Offset pagination (v1 endpoints)

Used by remaining v1 endpoints in this subset: `/api/v1/dealFields` and
`/api/v1/organizationFields`.

| Parameter | Description |
| --- | --- |
| `start` | Zero-based offset of the first item. Default 0. |
| `limit` | Items per page. Default 100, maximum 500. |

The response carries pagination metadata:

```json
{
  "success": true,
  "data": [ ],
  "additional_data": {
    "pagination": {
      "start": 0,
      "limit": 100,
      "more_items_in_collection": true,
      "next_start": 100
    }
  }
}
```

If `more_items_in_collection` is `true`, request again with `start` set to `next_start`. When it is
`false`, the collection is complete.

## Choosing the right style

| Endpoint family | Request param | Response field |
| --- | --- | --- |
| v2 lists and searches | `cursor` | `additional_data.next_cursor` |
| v1 field metadata | `start` | `additional_data.pagination.more_items_in_collection` / `next_start` |

Sending `start` to a v2 endpoint does not page it; sending `cursor` to a v1 endpoint is ignored.

## Limits

- `limit` above 500 returns 400.
- Default page size is 100 on both styles, so collections larger than 100 require paging unless a
  larger `limit` is passed.
