---
title: Pipedrive — Updating deals
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  - https://pipedrive.readme.io/docs/core-api-concepts-custom-fields
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Endpoint

```
PATCH /api/v2/deals/{id}
content-type: application/json
```

Only the fields present in the body are changed; omitted fields keep their values. The body is a
flat JSON object of deal fields — there is no `properties` or `data` wrapper.

## Accepted body keys

| Key | Type | Notes |
| --- | --- | --- |
| `title` | string | |
| `value` | number | |
| `currency` | string | 3-letter code |
| `status` | string | `open`, `won`, `lost` |
| `stage_id` | integer | Must belong to the deal's pipeline (or the `pipeline_id` sent in the same request) |
| `pipeline_id` | integer | |
| `org_id` | integer or null | |
| `custom_fields` | object | Map of custom field key → value |

Unknown top-level keys are rejected with 400 `ERR_SCHEMA_VALIDATION_FAILED`.

## Custom field values

In v2, custom field values go inside `custom_fields`, keyed by the field's **40-character hash key**
from `/api/v1/dealFields`:

```json
{
  "custom_fields": {
    "0123456789abcdef0123456789abcdef01234567": "Called back on Monday",
    "fedcba9876543210fedcba9876543210fedcba98": [41, 43]
  }
}
```

Value shapes by `field_type`:

- `varchar` — a string.
- `enum` — a single option id (integer).
- `set` — an **array of option ids** (integers) taken from the field's `options`.

Errors:

- Using a field's label (e.g. `"Lead source"`) or any key that is not a custom field key in this
  account → 400.
- A `set` value given as a string, as labels, or containing an id not in the field's options → 400.

### `set` fields are replaced, not merged

The array supplied for a `set` field becomes the field's **complete new value**. Option ids that
were set before and are not in the array are removed. To add an option while keeping the existing
ones, read the deal first, take the current array from `custom_fields`, add the new id, and send
the combined array:

```
GET /api/v2/deals/1201
→ "custom_fields": { "fedcba98...": [41] }

PATCH /api/v2/deals/1201
{ "custom_fields": { "fedcba98...": [41, 42] } }
```

An empty array clears the field. (The truncated key `fedcba98...` above is illustrative; send the
full 40-character key.)

## Status changes

- Setting `status` to `won` records `won_time` and `close_time`.
- Setting `status` to `lost` records `lost_time` and `close_time`.
- Setting `status` back to `open` clears the close timestamps.
- Changing `status` does not change `stage_id`, and changing `stage_id` does not change `status`
  (see `pipelines-and-stages.md`).
- Changing `stage_id` updates `stage_change_time`.

## Response

```json
{
  "success": true,
  "data": {
    "id": 1201,
    "title": "Acme expansion",
    "value": 25000,
    "currency": "USD",
    "status": "open",
    "stage_id": 3,
    "pipeline_id": 1,
    "org_id": 17,
    "update_time": "2026-10-17T09:12:44Z",
    "custom_fields": { "fedcba9876543210fedcba9876543210fedcba98": [41, 42] }
  }
}
```

The full deal object is returned.

## Error examples

Unknown key:

```json
{
  "success": false,
  "error": "Validation failed: unknown field 'properties'",
  "code": "ERR_SCHEMA_VALIDATION_FAILED",
  "error_info": "Please check developers.pipedrive.com",
  "data": null,
  "additional_data": null
}
```

Stage not in pipeline, invalid option id, or non-existent deal produce the same envelope with an
explanatory `error` (404 `ERR_NOT_FOUND` for a missing deal). Exact message wording and code names
are approximations of the v2 format (benchmark fixture detail).

Updates are atomic: if any part of the body is invalid, nothing is changed.
