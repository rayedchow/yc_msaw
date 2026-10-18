---
title: Zoho CRM — Listing records and pagination
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
  - https://www.zoho.com/crm/developer/docs/api/v8/search-records.html
  - https://github.com/zoho/crm-oas
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## List records

```http
GET /crm/v8/{module}?fields=Deal_Name,Stage,Amount&page=1&per_page=200
Authorization: Zoho-oauthtoken {token}
```

| Parameter | Required | Notes |
| --- | --- | --- |
| `fields` | **yes** | Comma-separated field API names, at most 50. `id` is always returned. |
| `page` | no | 1-based page number, default 1 |
| `per_page` | no | Default 200, maximum 200 |
| `sort_by` | no | e.g. `id`, `Created_Time`, `Modified_Time` |
| `sort_order` | no | `asc` or `desc` |
| `ids` | no | Comma-separated record IDs to fetch |
| `page_token` | no | Continuation token for large result sets (below) |

### fields is mandatory

Omitting `fields` returns:

```http
HTTP/1.1 400 Bad Request
```

```json
{"code":"REQUIRED_PARAM_MISSING","details":{"param":"fields"},"message":"One of the expected parameter is missing","status":"error"}
```

An unknown API name in `fields` returns `INVALID_DATA` with `details.api_name`.

## Response

```json
{
  "data": [
    { "id": "1234567000000045001", "Deal_Name": "Acme pilot", "Stage": "Intro call", "Amount": 12000 }
  ],
  "info": {
    "per_page": 200,
    "count": 1,
    "page": 1,
    "sort_by": "id",
    "sort_order": "desc",
    "more_records": false,
    "next_page_token": null,
    "previous_page_token": null,
    "page_token_expiry": null
  }
}
```

| `info` key | Meaning |
| --- | --- |
| `count` | Number of records in this page |
| `page`, `per_page` | Echo of the paging position |
| `more_records` | `true` when another page exists |
| `next_page_token` | Token for the next page when token paging is in use |
| `page_token_expiry` | Expiry time of the token |

If no records exist the API returns **HTTP 204 No Content** with no body.

## Paging procedure

1. Request `page=1` with the desired `per_page` (≤ 200).
2. While `info.more_records` is `true`, request `page=2`, `page=3`, ... with the same parameters.
3. Stop when `more_records` is `false` (or a 204 is returned).

## Beyond 2,000 records: page_token

Page-number pagination only reaches the first 2,000 records of a listing. To go further, use the
`next_page_token` from `info` and pass it as `page_token` on the next request. Rules from the
documentation:

- Do not send `page` and `page_token` together.
- Tokens are bound to the user and to the original query parameters; reuse the same `fields`,
  `sort_by` and `sort_order`.
- Tokens expire (`page_token_expiry`).

Treat the token as an opaque string.

## Search and related lists

`GET /crm/v8/{module}/search` and related-list endpoints use the same `page` / `per_page`
parameters (maximum 200) and the same `info.more_records` flag; a search with no match also
returns 204. For search, `fields` is optional; for related lists it is required (see
`associations.md`).
