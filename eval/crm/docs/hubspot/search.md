---
title: HubSpot — Searching the CRM
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Endpoint

```
POST /crm/v3/objects/{objectType}/search
Content-Type: application/json
```

Search uses POST because it takes a JSON body, but it **does not modify** anything.

### Request body

| Field | Type | Meaning |
| --- | --- | --- |
| `filterGroups` | array | Up to **5** groups, each with up to **6** `filters`. |
| `sorts` | array | Sort rules, e.g. `[{"propertyName": "createdate", "direction": "DESCENDING"}]`. |
| `query` | string | Free-text search over the object's default searchable properties (for example company `name`/`domain`, deal `dealname`). |
| `properties` | string[] | Properties to return. If omitted, the object's default properties are returned. |
| `limit` | int | Page size. Default **10**, maximum **200**. |
| `after` | string | Cursor from the previous page's `paging.next.after`. |

## Filter logic

- Filters **inside one group** are combined with **AND**.
- **Groups** are combined with **OR**.
- More than 5 groups or more than 6 filters in a group returns 400.

```json
{
  "filterGroups": [
    { "filters": [
        { "propertyName": "pipeline",  "operator": "EQ", "value": "default" },
        { "propertyName": "amount",    "operator": "GTE", "value": "10000" }
    ] },
    { "filters": [
        { "propertyName": "hs_is_closed", "operator": "EQ", "value": "false" }
    ] }
  ],
  "properties": ["dealname", "dealstage", "pipeline", "amount"],
  "limit": 100
}
```

This reads as `(pipeline = default AND amount >= 10000) OR (hs_is_closed = false)`.

## Operators

| Operator | Value fields | Meaning |
| --- | --- | --- |
| `EQ`, `NEQ` | `value` | Equal / not equal. |
| `LT`, `LTE`, `GT`, `GTE` | `value` | Range comparisons (numbers, dates). |
| `BETWEEN` | `value`, `highValue` | Inclusive range. |
| `IN`, `NOT_IN` | `values` (array) | Value is (not) one of the list. For enumeration properties, compare using lowercase option values. |
| `HAS_PROPERTY`, `NOT_HAS_PROPERTY` | — | Property has (no) value. |
| `CONTAINS_TOKEN`, `NOT_CONTAINS_TOKEN` | `value` | Token match; `*` wildcards allowed (e.g. `"*@acme.test"`). |

Filter on the property's **internal name** and, for enumerations, on the option **value**, not
the label. A `propertyName` that doesn't exist on the object returns 400 `VALIDATION_ERROR`.

For enumeration properties such as `dealstage` and `pipeline`, the value is the internal ID (see
`pipelines-and-stages.md`). A stage label like "Contract sent" won't match anything.

## Searching by association

To find deals associated with a given company, filter on the pseudo-property
`associations.company`:

```json
{
  "filterGroups": [ { "filters": [
    { "propertyName": "associations.company", "operator": "EQ", "value": "9876543210" }
  ] } ],
  "properties": ["dealname", "dealstage", "pipeline", "hs_is_closed"]
}
```

`IN` with `values` also works for several company IDs.

## Response

```json
{
  "total": 12,
  "results": [
    { "id": "18394027461", "properties": { "dealname": "Acme - pilot", "hs_object_id": "18394027461" },
      "createdAt": "...", "updatedAt": "...", "archived": false }
  ],
  "paging": { "next": { "after": "10" } }
}
```

- `total` counts **all** matches, not only the ones on this page. If `total` is larger than
  `results.length`, there are more pages.
- Without `sorts`, results are ordered by `hs_object_id` ascending (creation order).
- Search results **never include associations**, even if you ask for them. Use the v4
  associations endpoint or the `associations` param on a single-record GET instead.
- Archived records are excluded.

## Limits and caveats (documented)

- The default page is only **10** results. If you don't send a larger `limit` and follow
  `paging.next.after`, you only see part of the matches.
- `limit` above 200 is rejected.
- Only one sort rule is applied.
- A single query can page through at most 10,000 results.
- The search index can briefly lag recent writes.

See `pagination.md` for the paging loop.
