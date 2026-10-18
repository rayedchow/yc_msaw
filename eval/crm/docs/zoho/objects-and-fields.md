---
title: Zoho CRM — Modules and field metadata
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/field-meta.html
  - https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
  - https://github.com/zoho/crm-oas
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

Field names, data types and picklist options differ between Zoho organizations (custom fields,
layout changes, renamed picklist values). The metadata APIs describe the schema of the org you
are connected to. Use them to find the exact API names and allowed values before filtering or
writing.

## List modules

```http
GET /crm/v8/settings/modules
Authorization: Zoho-oauthtoken {token}
```

```json
{
  "modules": [
    { "api_name": "Accounts", "module_name": "Accounts", "singular_label": "Account",
      "plural_label": "Accounts", "id": "1234567000000002175" },
    { "api_name": "Deals", "module_name": "Deals", "singular_label": "Deal",
      "plural_label": "Deals", "id": "1234567000000002181" }
  ]
}
```

Use `api_name` in every record URL (`/crm/v8/Accounts`, `/crm/v8/Deals`).

## Field metadata

```http
GET /crm/v8/settings/fields?module=Deals
Authorization: Zoho-oauthtoken {token}
```

The `module` query parameter is required. Without it:

```json
{"code":"REQUIRED_PARAM_MISSING","details":{"param":"module"},"message":"One of the expected parameter is missing","status":"error"}
```

Response (abridged):

```json
{
  "fields": [
    {
      "api_name": "Deal_Name",
      "field_label": "Deal Name",
      "display_label": "Deal Name",
      "data_type": "text",
      "read_only": false,
      "system_mandatory": true,
      "length": 120
    },
    {
      "api_name": "Account_Name",
      "field_label": "Account Name",
      "display_label": "Account Name",
      "data_type": "lookup",
      "read_only": false,
      "system_mandatory": false,
      "lookup": { "module": { "api_name": "Accounts", "id": "1234567000000002175" } }
    },
    {
      "api_name": "Product_Interest",
      "field_label": "Product Interest",
      "display_label": "Product Interest",
      "data_type": "multiselectpicklist",
      "read_only": false,
      "system_mandatory": false,
      "pick_list_values": [
        { "display_value": "Analytics", "actual_value": "Analytics",
          "id": "1234567000000300001", "sequence_number": 1, "type": "used" },
        { "display_value": "Storage", "actual_value": "Storage",
          "id": "1234567000000300002", "sequence_number": 2, "type": "used" }
      ]
    },
    {
      "api_name": "Created_Time",
      "field_label": "Created Time",
      "display_label": "Created Time",
      "data_type": "datetime",
      "read_only": true,
      "system_mandatory": false
    }
  ]
}
```

### Key attributes

| Attribute | Meaning |
| --- | --- |
| `api_name` | Name to use in `fields=`, search criteria and write bodies |
| `field_label` / `display_label` | UI label; not accepted as a key in API requests |
| `data_type` | See table below |
| `read_only` | `true` means the API will not accept a value for this field |
| `system_mandatory` | Required by the system when creating records |
| `pick_list_values` | Allowed options for `picklist` / `multiselectpicklist` |
| `lookup.module` | Target module of a `lookup` field |
| `length` | Maximum length for text values |

### Data types in this subset

| `data_type` | Value shape in records |
| --- | --- |
| `text` | string |
| `picklist` | string (one allowed option) |
| `multiselectpicklist` | array of strings (allowed options) |
| `lookup` | object `{ "name": ..., "id": "<string id>" }` |
| `ownerlookup` | object `{ "name", "id", "email" }` |
| `currency` | number |
| `integer` | number |
| `date` | `"YYYY-MM-DD"` string |
| `datetime` | ISO 8601 string with offset |

### Picklist values: display vs actual

Each picklist option has a `display_value` (shown in the UI, may be translated or renamed) and an
`actual_value` (stored and used by the API). Requests and responses use the `actual_value`.
In many orgs the two are identical, but do not assume so: read `pick_list_values` and send the
`actual_value`.

## Standard fields commonly found

These are typical of the standard Accounts and Deals layouts; your org may differ, so confirm
with the fields endpoint.

- **Accounts:** `Account_Name` (text), `Website` (text), `Industry` (picklist), `Owner`
  (ownerlookup), `Created_Time`, `Modified_Time`.
- **Deals:** `Deal_Name` (text), `Stage` (picklist), `Amount` (currency), `Closing_Date` (date),
  `Account_Name` (lookup to Accounts), `Probability` (integer), `Owner`, `Created_Time`,
  `Modified_Time`. Custom fields appear alongside standard ones.

## Selecting fields when reading records

List and related-list reads require a `fields` parameter naming the API names to return (see
`pagination.md`). Naming a field that does not exist in the module yields:

```json
{"code":"INVALID_DATA","details":{"api_name":"Webiste"},"message":"invalid data","status":"error"}
```
