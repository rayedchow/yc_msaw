---
title: HubSpot — Associations between records
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
  - https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Concept

In HubSpot, the link between a deal and a company is **not a property on the deal**. It's a
separate, typed, **directional** association record. A company may have many deals, and a deal
may be associated with several companies (one of them is usually labeled *Primary*).

Each direction has its own association type ID:

| Direction | typeId | Label | Category |
| --- | --- | --- | --- |
| deal → company | 5 | `"Primary"` | `HUBSPOT_DEFINED` |
| deal → company | 341 | `null` (unlabeled) | `HUBSPOT_DEFINED` |
| company → deal | 6 | `"Primary"` | `HUBSPOT_DEFINED` |
| company → deal | 342 | `null` (unlabeled) | `HUBSPOT_DEFINED` |

The same relationship appears with different type IDs depending on which side you read it from.
Accounts can define custom association labels with their own type IDs (category
`USER_DEFINED`); read them from the API instead of assuming fixed numbers.

## Reading associations (v4)

```
GET /crm/v4/objects/{fromObjectType}/{fromObjectId}/associations/{toObjectType}?limit=&after=
```

Example: all deals of a company.

```
GET /crm/v4/objects/companies/9876543210/associations/deals?limit=500
```

```json
{
  "results": [
    {
      "toObjectId": 18394027461,
      "associationTypes": [
        { "category": "HUBSPOT_DEFINED", "typeId": 6,   "label": "Primary" },
        { "category": "HUBSPOT_DEFINED", "typeId": 342, "label": null }
      ]
    }
  ],
  "paging": { "next": { "after": "MTg..." } }
}
```

- `toObjectId` is a JSON **number**. Object paths and v3 bodies use **string** IDs, so convert it
  (`18394027461` → `"18394027461"`).
- The response only gives IDs. To get the deals' properties, call
  `GET /crm/v3/objects/deals/{id}` or `POST /crm/v3/objects/deals/batch/read` with the IDs.
- The default and maximum page size is 500. Follow `paging.next.after` if present.

## Including associations on an object read (v3)

List and single-record GETs accept an `associations` query param:

```
GET /crm/v3/objects/deals/18394027461?associations=companies
```

```json
{
  "id": "18394027461",
  "properties": { "...": "..." },
  "associations": {
    "companies": { "results": [ { "id": "9876543210", "type": "deal_to_company" } ] }
  }
}
```

Here the associated ID is a string, and `type` is a readable name instead of a type ID.
On companies, use `associations=deals`.

## Associations are not returned by search or batch read

- `POST /crm/v3/objects/{type}/search` results never include associations.
- `POST /crm/v3/objects/{type}/batch/read` never includes associations.

To filter deals by company inside search, use the `associations.company` pseudo-property (see
`search.md`):

```json
{ "propertyName": "associations.company", "operator": "EQ", "value": "9876543210" }
```

## Identity notes

- The company `name` property is not unique. HubSpot deduplicates companies by `domain`, and the
  record ID is the only guaranteed identifier.
- Association results include every associated deal, in any pipeline or stage. The deal
  properties `pipeline`, `dealstage` and `hs_is_closed` tell you which state a deal is in.
