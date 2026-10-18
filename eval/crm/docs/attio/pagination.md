---
title: Attio — Pagination
vendor: attio
snapshot: 2026-10-17
sources:
  - https://docs.attio.com/rest-api/guides/pagination
  - https://api.attio.com/openapi/api
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# Pagination

Attio uses **two different pagination styles** depending on the endpoint. Do not assume a single
paginator works everywhere.

| Style | Used by | Parameters |
|-------|---------|-----------|
| Limit / offset | Record query (`POST /v2/objects/{object}/records/query`) and list-entry query | `limit`, `offset` in the JSON body |
| Cursor | Some other list endpoints (outside this subset) | opaque cursor returned by the previous page |

## Limit / offset (record query)

- `limit` — maximum records per response. Default **500**.
- `offset` — number of records to skip. Default **0**.

The response is just `{ "data": [ ... ] }`. It contains **no total count and no next-page marker**. To
read everything, keep requesting with increasing `offset` until a page returns fewer records than
`limit` (or none).

```
POST /v2/objects/deals/records/query
{ "filter": { "value": { "currency_value": { "$gte": 10000 } } }, "limit": 50, "offset": 0 }
→ 50 records

POST /v2/objects/deals/records/query
{ "filter": { "value": { "currency_value": { "$gte": 10000 } } }, "limit": 50, "offset": 50 }
→ 12 records   (fewer than limit: done)
```

Keep the `filter` and `sorts` identical across pages; changing them between pages makes offsets
meaningless. Include a deterministic sort if you need a stable order; without sorts the order is
creation order.

Because `limit` and `offset` belong in the body, they are not query-string parameters for this
endpoint.

## Cursor pagination (other endpoints)

Endpoints that use cursors return an opaque cursor value with each page and accept it on the next
request. Treat the cursor as an opaque string: do not decode it or compute offsets from it. None of the
endpoints in this benchmark subset use cursor pagination.

## Metadata endpoints

`GET /v2/objects`, `GET /v2/objects/{object}/attributes`, `.../options` and `.../statuses` return the
full list in a single `{ "data": [...] }` response in this subset.

## Checklist

1. Pick the paging style for the specific endpoint.
2. For record queries, page with body `limit`/`offset` until a short page.
3. Do not stop after the first page just because no "next" marker is present — record query never
   returns one.
