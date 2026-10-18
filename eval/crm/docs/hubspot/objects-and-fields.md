---
title: HubSpot — Objects, records and property metadata
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Listing records

```
GET /crm/v3/objects/{objectType}?limit=&after=&properties=&associations=&archived=
```

`objectType` is `companies` or `deals`.

| Query param | Meaning |
| --- | --- |
| `limit` | Page size. Default **10**, maximum **100**. A larger value is rejected with 400 `VALIDATION_ERROR`. |
| `after` | Paging cursor taken from the previous response's `paging.next.after` (see `pagination.md`). |
| `properties` | Comma-separated property internal names to return. |
| `associations` | Comma-separated object types whose associated IDs should be included (for example `associations=companies` on deals). |
| `archived` | `true` returns archived records only. Default `false`. |

Records are returned in creation order.

### Default properties

When `properties` is omitted, only a default set is returned:

- deals: `amount`, `closedate`, `createdate`, `dealname`, `dealstage`, `hs_lastmodifieddate`,
  `hs_object_id`, `pipeline`
- companies: `createdate`, `domain`, `hs_lastmodifieddate`, `hs_object_id`, `name`

Any other property, including custom properties, must be requested explicitly. Names in
`properties` that don't exist are **silently left out** of the response; they don't cause an error.
If a property you asked for is missing from the response, check the spelling against the property
definitions below.

### Response

```json
{
  "results": [
    {
      "id": "18394027461",
      "properties": { "dealname": "Acme - pilot", "amount": "12000", "dealstage": "appointmentscheduled", "pipeline": "default" },
      "createdAt": "2026-01-05T09:12:00.000Z",
      "updatedAt": "2026-01-05T09:12:00.000Z",
      "archived": false
    }
  ],
  "paging": { "next": { "after": "NTI1Cg%3D%3D", "link": "https://api.hubapi.com/crm/v3/objects/deals?after=NTI1Cg%3D%3D" } }
}
```

`paging` is absent on the last page.

## Reading one record

```
GET /crm/v3/objects/{objectType}/{recordId}?properties=&associations=
```

Returns the single record object (same shape as a list item), or 404 `OBJECT_NOT_FOUND`.

## Batch read

```
POST /crm/v3/objects/{objectType}/batch/read
{ "inputs": [ { "id": "18394027461" }, { "id": "18394027462" } ], "properties": ["dealname", "dealstage"] }
```

Response: `{ "status": "COMPLETE", "results": [ ... ], "startedAt": "...", "completedAt": "..." }`.
Batch read never returns associations.

## Common deal properties

| Internal name | Label | Type | Notes |
| --- | --- | --- | --- |
| `dealname` | Deal name | string | |
| `amount` | Amount | number | Returned as a string, e.g. `"42000"`. |
| `pipeline` | Pipeline | enumeration | Holds a pipeline **ID**, not its label. |
| `dealstage` | Deal stage | enumeration | Holds a stage **ID** that belongs to the deal's pipeline. |
| `closedate` | Close date | datetime | ISO 8601 or `null`. |
| `hs_is_closed` | Is closed | bool (calculated) | `"true"`/`"false"`, read-only. |
| `hs_is_closed_won` | Is closed won | bool (calculated) | Read-only. |
| `createdate`, `hs_lastmodifieddate`, `hs_object_id` | | | Read-only system values. |

Common company properties: `name`, `domain`, `industry`, `createdate`, `hs_object_id`,
`hs_lastmodifieddate`.

Accounts can add **custom properties**. Their internal names are chosen by the account and can
differ between accounts even when labels match, so look them up rather than guessing.

## Property definitions

```
GET /crm/v3/properties/{objectType}
GET /crm/v3/properties/{objectType}/{propertyName}
```

The list returns `{ "results": [ ... ] }`; the single form returns one definition or 404.
The example below is a standard multiple-checkbox property from the contacts object; deal and
company property definitions have the same shape.

```json
{
  "name": "hs_buying_role",
  "label": "Buying role",
  "type": "enumeration",
  "fieldType": "checkbox",
  "description": "Role(s) the contact plays in the purchase.",
  "groupName": "contactinformation",
  "options": [
    { "label": "Decision maker", "value": "DECISION_MAKER", "displayOrder": 0, "hidden": false },
    { "label": "Champion",  "value": "CHAMPION",  "displayOrder": 1, "hidden": false }
  ],
  "calculated": false,
  "hasUniqueValue": false,
  "modificationMetadata": { "readOnlyValue": false }
}
```

Key fields:

- `name`: the **internal name**. Use this in `properties` params, filters and writes. The `label` is
  for display only.
- `type` + `fieldType`: the data type and the UI control. For enumerations:
  - `fieldType: "select"` or `"radio"` holds a single option;
  - `fieldType: "checkbox"` (multiple checkboxes) holds **several** options as one
    `;`-separated string;
  - `fieldType: "booleancheckbox"` is a single true/false checkbox.
- `options[]`: each option has a display `label` and an internal `value`. They often differ in
  case or punctuation (for example label `Decision maker`, value `DECISION_MAKER`). **Filters and
  writes use the `value`**; a label is rejected with `INVALID_OPTION` unless it happens to equal
  the value.
- `calculated: true` or `modificationMetadata.readOnlyValue: true` means the value can't be written
  through the API.

For deals, the `pipeline` and `dealstage` property definitions don't list every pipeline's stages
in a usable form. Use the pipelines API (`pipelines-and-stages.md`) for that.
