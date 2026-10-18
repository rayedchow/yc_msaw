---
title: Zoho CRM — Deal stages, pipelines and closed status
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html
  - https://www.zoho.com/crm/developer/docs/api/v8/update-records.html
  - https://www.zoho.com/crm/developer/docs/api/v8/insert-records.html
  - https://www.zoho.com/crm/developer/docs/api/v8/search-records.html
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Stage is a picklist field

In Zoho CRM a Deal's position in the sales process is the `Stage` field on the Deals module. It
is an ordinary `picklist`: there is no separate status field and no separate stages endpoint in
this subset. Whether a deal is open, won or lost is expressed by which `Stage` value it holds.
Closed outcomes (won, lost, and any org-specific variants such as "lost to competition") are
simply picklist values.

Stage options are configurable per org, so read them from field metadata instead of assuming a
fixed list:

```http
GET /crm/v8/settings/fields?module=Deals
```

```json
{
  "fields": [
    {
      "api_name": "Stage",
      "field_label": "Stage",
      "display_label": "Stage",
      "data_type": "picklist",
      "read_only": false,
      "system_mandatory": true,
      "pick_list_values": [
        { "display_value": "Intro call", "actual_value": "Intro call",
          "id": "1234567000000400001", "sequence_number": 1, "type": "used" },
        { "display_value": "...", "actual_value": "...",
          "id": "1234567000000400002", "sequence_number": 2, "type": "used" }
      ]
    }
  ]
}
```

- Use `actual_value` in criteria and updates.
- `sequence_number` gives the display order of stages.
- The metadata does not carry an explicit "is closed" flag in this subset; closed stages are
  identified by their values as configured in the org (read the full option list and their
  labels).

## Reading and filtering by stage

`Stage` is returned as a plain string:

```json
{ "id": "1234567000000045001", "Deal_Name": "Acme pilot", "Stage": "Intro call", "Probability": 10 }
```

Picklist comparisons in search are exact, and `in` / `not_equal` are available:

```http
GET /crm/v8/Deals/search?criteria=(Stage:in:Intro call,Prospecting)&fields=Deal_Name,Stage
GET /crm/v8/Deals/search?criteria=((Account_Name.id:equals:1234567000000012345)and(Stage:not_equal:Intro call))&fields=Deal_Name,Stage
```

(URL-encode spaces and other characters when sending.)

## Changing the stage

Send the new stage's `actual_value` in an update:

```http
PUT /crm/v8/Deals
Content-Type: application/json

{ "data": [ { "id": "1234567000000045001", "Stage": "Intro call" } ] }
```

A value that is not one of the field's allowed options fails that row with `INVALID_DATA`
(`details.api_name: "Stage"`). See `updating-records.md` for the per-row response format.

## Probability

`Probability` (integer, percent) is a standard Deals field. In Zoho the default probability of
each stage is configured with the stage; the record's `Probability` field is stored on the deal
and can be read like any other field.

## Pipelines

Zoho CRM has an optional **Pipeline** feature. When it is enabled for the Deals module, a
`Pipeline` field appears in the Deals field metadata, each pipeline exposes its own subset of
stages, and the documentation lists `Pipeline` among the fields required when creating a deal.
When the feature is not enabled, no `Pipeline` field exists and all deals share the single
`Stage` picklist.

To know which case applies to your org, check whether `settings/fields?module=Deals` returns a
field with `api_name: "Pipeline"`. Do not send a `Pipeline` key unless that field exists;
unknown API names fail with `INVALID_DATA`.

## Closing date

`Closing_Date` (`date`, `"YYYY-MM-DD"`) is a regular editable field. It is not automatically
tied to stage changes in this subset; set it explicitly if your process requires it.
