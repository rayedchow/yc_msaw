---
title: Zoho CRM — Updating records
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/update-records.html
  - https://www.zoho.com/crm/developer/docs/api/v8/insert-records.html
  - https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html
  - https://github.com/zoho/crm-oas
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Endpoints

Bulk update (up to 100 records per call; each row carries its `id`):

```http
PUT /crm/v8/{module}
Authorization: Zoho-oauthtoken {token}
Content-Type: application/json

{
  "data": [
    { "id": "1234567000000045001", "Amount": 15000 },
    { "id": "1234567000000045002", "Closing_Date": "2026-12-31" }
  ],
  "trigger": ["workflow"]
}
```

Single-record update (the ID is in the path; the body still uses the `data` array):

```http
PUT /crm/v8/Deals/1234567000000045001
Content-Type: application/json

{ "data": [ { "Amount": 15000 } ] }
```

### Body rules

- The body must be an object with a `data` array. A body without `data` (for example fields at
  the top level, or a `properties` wrapper) is rejected with `400`
  `{"code":"INVALID_DATA","details":{},"message":"body","status":"error"}` (benchmark fixture detail).
- Keys inside each row are **field API names** (from `settings/fields`), not labels.
- Only the fields you include are changed; other fields are left as they are.
- `trigger` (optional) lists automation to run, e.g. `["workflow","approval","blueprint"]`. An
  empty array runs none.

## Value formats

| `data_type` | Send |
| --- | --- |
| `text` | string |
| `picklist` | one allowed `actual_value` string |
| `multiselectpicklist` | **array** of allowed `actual_value` strings |
| `lookup` | `{ "id": "<record id>" }` |
| `currency`, `integer` | number |
| `date` | `"YYYY-MM-DD"` |

### Multi-select picklists replace the whole set

The array you send for a `multiselectpicklist` becomes the field's complete new value. Values not
in the array are removed. To add an option while keeping existing ones, read the current value,
merge, and send the combined array:

```json
// current: "Product_Interest": ["Analytics"]
{ "data": [ { "id": "1234567000000045001", "Product_Interest": ["Analytics", "Storage"] } ] }
```

Sending `["Storage"]` alone would leave only `Storage`. Sending `[]` clears the field. A plain
string instead of an array, or an option that is not in `pick_list_values`, fails with
`INVALID_DATA`.

### Picklists

A `picklist` value must exactly match one of the field's allowed values; otherwise the row fails
with `INVALID_DATA` and `details.api_name` naming the field.

### Read-only fields

System fields such as `Created_Time` and `Modified_Time` (`read_only: true` in metadata) cannot
be written; including them fails the row with `INVALID_DATA` (benchmark fixture detail). `id` in
a row identifies the record and is not itself updated.

## Response: per-row results

Every row gets its own result object in the same order as the request:

```json
{
  "data": [
    {
      "code": "SUCCESS",
      "details": {
        "Modified_Time": "2026-10-17T12:00:00+00:00",
        "Modified_By": { "name": "API User", "id": "1234567000000000111" },
        "Created_Time": "2026-09-01T10:00:00+00:00",
        "id": "1234567000000045001",
        "Created_By": { "name": "API User", "id": "1234567000000000111" }
      },
      "message": "record updated",
      "status": "success"
    },
    {
      "code": "INVALID_DATA",
      "details": { "api_name": "Amount", "expected_data_type": "double" },
      "message": "invalid data",
      "status": "error"
    }
  ]
}
```

### HTTP status

| Outcome | HTTP status | Body |
| --- | --- | --- |
| All rows succeeded | 200 | `{"data":[...]}` |
| Some rows succeeded, some failed | **207 Multi-Status** | `{"data":[...]}` |
| All rows failed | 400 | `{"data":[...]}` |

A 2xx status does not mean every row was applied: inspect each row's `status` / `code`. Rows
that succeeded in a 207 response are committed.

### Row error codes

| `code` | `details` | Cause |
| --- | --- | --- |
| `INVALID_DATA` | `{ "api_name": "X", "expected_data_type"? }` | Unknown field API name, wrong type, invalid picklist option, read-only field |
| `INVALID_DATA` | `{ "id": "..." }` | Record ID does not exist (`message`: "the id given seems to be invalid") |
| `MANDATORY_NOT_FOUND` | `{ "api_name": "X" }` | A required field was blanked or missing |

## Example: update a text field and a picklist

```http
PUT /crm/v8/Deals
Content-Type: application/json

{ "data": [ { "id": "1234567000000045001", "Description": "Updated by integration", "Stage": "Intro call" } ] }
```

```json
{ "data": [ { "code": "SUCCESS", "details": { "id": "1234567000000045001", "Modified_Time": "2026-10-17T12:00:00+00:00" }, "message": "record updated", "status": "success" } ] }
```
