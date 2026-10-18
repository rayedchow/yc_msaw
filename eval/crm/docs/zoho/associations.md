---
title: Zoho CRM — Lookups and related records
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/get-related-records.html
  - https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html
  - https://www.zoho.com/crm/developer/docs/api/v8/search-records.html
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

Zoho CRM relates records in two complementary ways:

1. **Lookup fields** stored on the child record (for example a Deal's `Account_Name` points to
   an Account).
2. **Related lists** on the parent record, which expose the child records through a sub-path
   (for example an Account's Deals).

## Lookup fields

In metadata, a lookup has `data_type: "lookup"` and names its target module:

```json
{ "api_name": "Account_Name", "data_type": "lookup",
  "lookup": { "module": { "api_name": "Accounts", "id": "1234567000000002175" } } }
```

In record data, a lookup value is an object with the target's string `id` and display `name`:

```json
{
  "id": "1234567000000045001",
  "Deal_Name": "Acme pilot",
  "Account_Name": { "name": "Acme", "id": "1234567000000012345" }
}
```

Several accounts may share a display name; the `id` is the unambiguous reference.

### Filtering by lookup

Use the search endpoint with the lookup's `.id` sub-key for an exact match, or the bare field for
a name match (name matching follows text-search rules; see `search.md`):

```http
GET /crm/v8/Deals/search?criteria=(Account_Name.id:equals:1234567000000012345)&fields=Deal_Name,Stage
```

### Writing a lookup

To set or change a lookup, send an object with the target `id`:

```json
{ "data": [ { "id": "1234567000000045001", "Account_Name": { "id": "1234567000000012345" } } ] }
```

## Related lists

```http
GET /crm/v8/{module}/{record_id}/{related_list_api_name}?fields=...&page=1&per_page=200
Authorization: Zoho-oauthtoken {token}
```

The related-list API name depends on the org's configuration; for the standard Accounts module,
the Deals related list is `Deals`:

```http
GET /crm/v8/Accounts/1234567000000012345/Deals?fields=Deal_Name,Stage,Amount
```

| Parameter | Required | Notes |
| --- | --- | --- |
| `fields` | **yes** | Comma-separated API names of the related module's fields (≤ 50) |
| `page` | no | default 1 |
| `per_page` | no | default 200, maximum 200 |

Omitting `fields` returns `400 REQUIRED_PARAM_MISSING` with `details.param = "fields"`, as for
the list endpoint.

Response:

```json
{
  "data": [
    { "id": "1234567000000045001", "Deal_Name": "Acme pilot", "Stage": "Intro call", "Amount": 12000 },
    { "id": "1234567000000045002", "Deal_Name": "Acme expansion", "Stage": "Intro call", "Amount": 40000 }
  ],
  "info": { "per_page": 200, "count": 2, "page": 1, "more_records": false }
}
```

If the parent record has no related records, the API returns **HTTP 204 No Content** with an
empty body. Page through results using `info.more_records` as described in `pagination.md`.

Related lists return every related record regardless of its stage or status; filter the
returned rows (or use search with combined criteria) if you need a subset.

## Getting a single record

```http
GET /crm/v8/Deals/1234567000000045001
```

returns `{"data":[ { ...all fields... } ]}`. If the ID does not exist, this API responds with
`400` and
`{"code":"INVALID_DATA","details":{"id":"1234567000000045999"},"message":"the related id given seems to be invalid","status":"error"}`
(benchmark fixture detail).
