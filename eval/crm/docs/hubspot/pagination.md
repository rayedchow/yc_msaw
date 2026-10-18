---
title: HubSpot — Pagination
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
  - https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

HubSpot CRM endpoints use **cursor pagination** with an `after` token. The token is an opaque
string. Copy it exactly from the previous response; don't build, decode or increment it.

## Page size per endpoint

| Endpoint | Param | Default | Maximum | Over the maximum |
| --- | --- | --- | --- | --- |
| `GET /crm/v3/objects/{type}` | `limit` (query) | 10 | 100 | 400 `VALIDATION_ERROR` |
| `POST /crm/v3/objects/{type}/search` | `limit` (body) | 10 | 200 | 400 `VALIDATION_ERROR` |
| `GET /crm/v4/objects/{from}/{id}/associations/{to}` | `limit` (query) | 500 | 500 | — |
| `POST .../batch/read`, `.../batch/update` | `inputs` length | — | 100 | 400 |

The default of 10 on list and search is small. A request without `limit` that matches 12
records returns 10 of them plus a `paging` object.

## Where the cursor lives

On list endpoints:

```json
"paging": {
  "next": {
    "after": "NTI1Cg%3D%3D",
    "link": "https://api.hubapi.com/crm/v3/objects/companies?after=NTI1Cg%3D%3D"
  }
}
```

On search:

```json
"paging": { "next": { "after": "10" } }
```

The search cursor can look like a number. It is still opaque, so send it back as the string
you received.

**No `paging` key (or no `paging.next`) means this is the last page.**

## Paging through a list (GET)

```
GET /crm/v3/objects/deals?limit=100&properties=dealname,dealstage
GET /crm/v3/objects/deals?limit=100&properties=dealname,dealstage&after=<paging.next.after>
...
```

Keep the same `properties`, `associations` and `archived` params on every page.

## Paging through search (POST)

Send the **same body** each time, adding `after`:

```json
{ "filterGroups": [ ... ], "properties": [ ... ], "limit": 200, "after": "200" }
```

Repeat until a response has no `paging.next`. The search response also has `total`, the number
of matches across all pages. Use it to check that you have collected every result.

A single search query can't page past 10,000 results. For larger sets, narrow the filters (for
example by a date range) and run several queries.

## Associations (v4)

The v4 associations read endpoint returns up to 500 associated IDs per page, with the same
`paging.next.after` convention.

## Checklist

1. Set `limit` explicitly, up to the endpoint maximum.
2. Loop while `paging.next.after` is present.
3. Pass the cursor back unchanged.
4. Compare the number of collected results with `total` (search only).
