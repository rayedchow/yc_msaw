---
title: Attio — Objects, attributes, options, statuses and value types
vendor: attio
snapshot: 2026-10-17
sources:
  - https://api.attio.com/openapi/api
  - https://docs.attio.com/rest-api/guides/filtering-and-sorting
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# Objects

## List objects

`GET /v2/objects` returns every object in the workspace, standard and custom.

```json
{
  "data": [
    {
      "id": { "workspace_id": "<uuid>", "object_id": "<uuid>" },
      "api_slug": "companies",
      "singular_noun": "Company",
      "plural_noun": "Companies",
      "created_at": "2026-09-01T10:00:00.000Z"
    }
  ]
}
```

`GET /v2/objects/{object}` returns one object (`{ "data": { ... } }`), addressed by slug or `object_id`.

# Attributes

## List attributes

`GET /v2/objects/{object}/attributes` lists the attribute definitions of an object. Use this to learn
slugs, types, and whether an attribute is writable or multi-valued before reading or writing values.

```json
{
  "data": [
    {
      "id": { "workspace_id": "<uuid>", "object_id": "<uuid>", "attribute_id": "<uuid>" },
      "title": "Categories",
      "description": null,
      "api_slug": "categories",
      "type": "select",
      "is_system_attribute": false,
      "is_writable": true,
      "is_required": false,
      "is_unique": false,
      "is_multiselect": true,
      "is_default_value_enabled": false,
      "is_archived": false,
      "default_value": null,
      "relationship": null,
      "created_at": "2026-09-01T10:00:00.000Z",
      "config": {
        "currency": { "default_currency_code": null, "display_type": null },
        "record_reference": { "allowed_object_ids": null }
      }
    }
  ]
}
```

Important fields:

| Field | Meaning |
|-------|---------|
| `api_slug` | Key used under `values` and in filters/sorts. Titles are for display only. |
| `type` | Value type: `text`, `domain`, `status`, `select`, `currency`, `record-reference`, ... |
| `is_multiselect` | The attribute holds several values (several array elements are meaningful). |
| `is_writable` | Whether the API may write this attribute. Writing a non-writable attribute is rejected. |
| `is_unique` | Values must be unique across records; only unique attributes can be used as a `matching_attribute` for assert/upsert. |
| `config.currency` | For `currency`: the default currency code and display type. |
| `config.record_reference.allowed_object_ids` | For `record-reference`: which objects may be targeted. |

# Select options

`GET /v2/objects/{object}/attributes/{attribute}/options` lists the options of a `select` attribute
(single or multi).

```json
{
  "data": [
    {
      "id": { "workspace_id": "<uuid>", "object_id": "<uuid>",
              "attribute_id": "<uuid>", "option_id": "<uuid>" },
      "title": "Enterprise",
      "is_archived": false
    }
  ]
}
```

Options are referenced in writes and filters by their **title** or their **option_id**.

# Statuses

`GET /v2/objects/{object}/attributes/{attribute}/statuses` lists the statuses of a `status` attribute.

```json
{
  "data": [
    {
      "id": { "workspace_id": "<uuid>", "object_id": "<uuid>",
              "attribute_id": "<uuid>", "status_id": "<uuid>" },
      "title": "In review",
      "is_archived": false,
      "target_time_in_status": null,
      "celebration_enabled": false
    }
  ]
}
```

See `pipelines-and-stages.md` for how status attributes are used.

# Value object shapes

Every element of a `values[slug]` array has the common fields `active_from`, `active_until` (null for
current values), `created_by_actor` (`{ "type": "api-token" | "workspace-member" | ..., "id": "<uuid>" }`)
and `attribute_type`, plus the type-specific fields below.

| Type | Type-specific fields | Main sub-property for filtering |
|------|----------------------|--------------------------------|
| `text` | `value` (string) | `value` |
| `domain` | `domain`, `root_domain` | `domain` (also `root_domain`) |
| `status` | `status: { id, title, is_archived, target_time_in_status, celebration_enabled }` | `status` |
| `select` | `option: { id, title, is_archived }` | `option` |
| `currency` | `currency_value` (number), `currency_code` (e.g. `"USD"`) | `currency_value` |
| `record-reference` | `target_object` (slug), `target_record_id` (uuid) | `target_record_id` |

Examples:

```json
{ "value": "Acme", "attribute_type": "text" }
{ "domain": "acme.test", "root_domain": "acme.test", "attribute_type": "domain" }
{ "status": { "id": { "...": "...", "status_id": "<uuid>" }, "title": "In review",
              "is_archived": false, "target_time_in_status": null, "celebration_enabled": false },
  "attribute_type": "status" }
{ "option": { "id": { "...": "...", "option_id": "<uuid>" }, "title": "Enterprise", "is_archived": false },
  "attribute_type": "select" }
{ "currency_value": 12000, "currency_code": "USD", "attribute_type": "currency" }
{ "target_object": "companies", "target_record_id": "<uuid>", "attribute_type": "record-reference" }
```

(Common metadata fields omitted for brevity.)

A multiselect attribute (for example a multi `select` or `domain`) returns one array element per
value. A single-value attribute returns at most one current element.

## Standard objects in this subset

- `companies`: `name` (text), `domains` (domain, multiselect), plus any workspace-defined attributes.
- `deals`: `name` (text), `stage` (status), `value` (currency), `associated_company`
  (record-reference to `companies`), plus any workspace-defined attributes.

Workspace-defined (custom) attributes vary per workspace; always list attributes rather than assuming
slugs.
