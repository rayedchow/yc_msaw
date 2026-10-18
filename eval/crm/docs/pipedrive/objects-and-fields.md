---
title: Pipedrive — Objects and fields
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://pipedrive.readme.io/docs/core-api-concepts-custom-fields
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Organization (v2)

```json
{
  "id": 17,
  "name": "Acme",
  "owner_id": 9,
  "add_time": "2026-01-05T10:00:00Z",
  "update_time": "2026-02-01T08:30:00Z",
  "visible_to": 3,
  "custom_fields": {
    "0123456789abcdef0123456789abcdef01234567": "https://acme.test"
  }
}
```

Organizations have a small set of standard fields. Anything a company adds — for example a
"Website" text field — is a **custom field** and appears under `custom_fields`, keyed by the field's
generated key.

## Deal (v2)

```json
{
  "id": 1201,
  "title": "Acme expansion",
  "value": 25000,
  "currency": "USD",
  "status": "open",
  "stage_id": 3,
  "pipeline_id": 1,
  "org_id": 17,
  "person_id": null,
  "owner_id": 9,
  "add_time": "2026-01-05T10:00:00Z",
  "update_time": "2026-02-01T08:30:00Z",
  "stage_change_time": null,
  "won_time": null,
  "lost_time": null,
  "close_time": null,
  "probability": null,
  "custom_fields": {
    "fedcba9876543210fedcba9876543210fedcba98": [41, 43]
  }
}
```

- `value` is a number; `currency` is a 3-letter code.
- `status` is one of `open`, `won`, `lost` (and `deleted` for deleted deals). It is independent of
  `stage_id` — see `pipelines-and-stages.md`.
- `org_id`, `person_id`, `pipeline_id`, `stage_id`, `owner_id` are integer references.

## Custom field keys

Every user-created custom field gets a key that is a **40-character lowercase hexadecimal string**,
generated when the field is created in that company account. Consequences documented by Pipedrive:

- The key is not the label. A field shown as "Lead source" in the UI is addressed by its hash key,
  never by `"Lead source"` or a slug of it.
- Keys differ between company accounts even when label and type match, so keys must be resolved per
  account through the field-metadata endpoints below rather than reused from another account.
- Custom field values in v2 responses and requests live in the nested `custom_fields` object.

## Field metadata endpoints (v1)

```
GET /api/v1/dealFields?start=0&limit=100
GET /api/v1/organizationFields?start=0&limit=100
```

Both use the v1 envelope and v1 offset pagination (`start`, `limit`; default 100, max 500):

```json
{
  "success": true,
  "data": [
    { "id": 12, "key": "title", "name": "Title", "field_type": "varchar",
      "edit_flag": false, "active_flag": true, "mandatory_flag": false },
    { "id": 13, "key": "status", "name": "Status", "field_type": "status",
      "edit_flag": false, "active_flag": true, "mandatory_flag": false },
    { "id": 58, "key": "fedcba9876543210fedcba9876543210fedcba98", "name": "Lead source",
      "field_type": "set",
      "options": [ { "id": 41, "label": "Webinar" }, { "id": 42, "label": "Referral" },
                   { "id": 43, "label": "Trade show" } ],
      "edit_flag": true, "active_flag": true, "mandatory_flag": false }
  ],
  "additional_data": {
    "pagination": { "start": 0, "limit": 100, "more_items_in_collection": false }
  }
}
```

Key attributes:

| Attribute | Meaning |
| --- | --- |
| `key` | The key used in API payloads. Standard fields have readable keys (`title`, `value`, `status`, `stage_id`, `org_id`); custom fields have a 40-hex key. |
| `name` | Human label shown in the UI. |
| `field_type` | Data type (below). |
| `options` | For `enum` and `set` fields: the allowed options, each `{id, label}`. |
| `edit_flag` | `true` for user-created (custom) fields. |
| `active_flag`, `mandatory_flag` | Field state flags. |

## Field types

| `field_type` | Value shape in v2 |
| --- | --- |
| `varchar` | String (up to 255 chars) |
| `int`, `double` | Number |
| `monetary` | Number (with currency) |
| `date` | `YYYY-MM-DD` string |
| `enum` | Single option id (integer) |
| `set` | **Array of option ids** (integers) |
| `org`, `people` | Integer record id |
| `status`, `stage` | Standard deal status / stage reference |

In v2, option-based fields carry option **ids**, not labels. To display or compare labels, map ids
through the `options` array of the field's metadata.

## Single-record and list reads

```
GET /api/v2/organizations/{id}
GET /api/v2/organizations?limit&cursor&ids&sort_by&sort_direction
GET /api/v2/deals/{id}
```

A missing record returns 404 with `code` `ERR_NOT_FOUND`.
