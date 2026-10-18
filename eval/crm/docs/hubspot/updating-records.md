---
title: HubSpot — Updating records
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/guide
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Update one record

```
PATCH /crm/v3/objects/{objectType}/{recordId}
Content-Type: application/json

{
  "properties": {
    "dealname": "Acme - expansion",
    "amount": "55000"
  }
}
```

- The body must have a top-level `properties` object. Only properties listed in it are changed;
  every other property keeps its value.
- A body without `properties`, or with any other top-level key, is rejected with 400
  `VALIDATION_ERROR`, for example
  `Invalid input JSON on line 1, column 2: Unrecognized field "dealstage" ...`.
  This happens when a property is sent at the top level instead of inside `properties`.
- Values are sent as strings (numbers are accepted for number properties).
- Success returns **200** with the updated record: the default properties plus any you changed.

## Validation rules

| Problem | Result |
| --- | --- |
| Property doesn't exist | 400 `VALIDATION_ERROR`, `errors[].code = "PROPERTY_DOESNT_EXIST"`, `context.propertyName` lists it |
| Property is calculated or read-only (`hs_is_closed`, `hs_is_closed_won`, `hs_object_id`, `createdate`, `hs_lastmodifieddate`, ...) | 400 `VALIDATION_ERROR` (`READ_ONLY_VALUE`) |
| Enumeration value is not one of the property's option **values** (for example, a label was sent) | 400 `VALIDATION_ERROR` (`INVALID_OPTION`) |
| `dealstage` is not a stage of the deal's pipeline | 400 `VALIDATION_ERROR` |
| Record ID doesn't exist | 404 `OBJECT_NOT_FOUND` |

If a single-record PATCH returns 4xx, nothing in it was applied.

## Moving a deal between stages and pipelines

- `dealstage` takes a **stage ID**, and the stage must belong to the deal's pipeline.
- To move a deal to another pipeline, send `pipeline` and a `dealstage` from that pipeline in the
  same request. The stage is checked against the new pipeline.
- When a deal moves into a stage whose metadata has `isClosed: "true"`, HubSpot recalculates
  `hs_is_closed` / `hs_is_closed_won`. If `closedate` was empty, it is set to the current time.
- See `pipelines-and-stages.md` for finding stage IDs.

## Multiple checkbox properties (enumeration, `fieldType: "checkbox"`)

A multiple-checkbox property stores **several option values as one string separated by `;`**.
Read the current value as a string and split it on `;`:

```json
"properties": { "hs_buying_role": "DECISION_MAKER;CHAMPION" }
```

When you write one of these properties, the format of the string decides what happens:

| Value sent | Effect |
| --- | --- |
| `"A;B"` (no leading semicolon) | **Replaces** the stored set with exactly `A` and `B`. Options that were checked but are not listed are removed. |
| `";C"` (leading semicolon) | **Appends** `C` to the options already stored. Existing options stay. |
| `";C;D"` | Appends `C` and `D`. |
| `""` (empty string) | Clears every option. |

This follows the Properties guide section "Add values to checkbox type properties". To add a
value without removing existing ones, either start the string with `;`, or read the current value
and send the full combined list.

Example: the stored value is `"DECISION_MAKER"`.

```json
{ "properties": { "hs_buying_role": ";CHAMPION" } }
```
→ stored value becomes `"DECISION_MAKER;CHAMPION"`.

```json
{ "properties": { "hs_buying_role": "CHAMPION" } }
```
→ stored value becomes `"CHAMPION"` (`DECISION_MAKER` is removed).

Further rules:

- Every element must be an option **value**, not a label. Values often differ from labels in case
  or punctuation. Check `options[].value` with
  `GET /crm/v3/properties/{type}/{name}`.
- Repeated values are stored once.
- An element that is not a valid option rejects the whole request with `INVALID_OPTION`.
- Single-select enumerations (`select`, `radio`) take exactly one value. The `;` syntax only
  applies to `checkbox` fields.

## Batch update

```
POST /crm/v3/objects/{objectType}/batch/update
{ "inputs": [ { "id": "18394027461", "properties": { "amount": "1000" } },
              { "id": "18394027462", "properties": { "amount": "2000" } } ] }
```

- Up to 100 inputs.
- Success: 200 `{ "status": "COMPLETE", "results": [ ...updated records... ], "startedAt": "...", "completedAt": "..." }`.
- If any input is invalid, the request returns 400 and **no input is applied**. (benchmark fixture
  detail)
- Each input follows the same rules as single PATCH, including the multiple-checkbox semantics.

## Checklist before writing

1. Confirm the record ID points at the intended record.
2. Use property internal names, not labels.
3. Use option values for enumerations, and stage IDs from the right pipeline for `dealstage`.
4. For multiple-checkbox properties, decide whether you mean append (leading `;`) or replace.
5. Read the record back if you need to confirm the stored result.
