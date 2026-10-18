---
title: Attio — Related records (record-reference attributes)
vendor: attio
snapshot: 2026-10-17
sources:
  - https://api.attio.com/openapi/api
  - https://docs.attio.com/rest-api/guides/filtering-and-sorting
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

# Relationships between records

Attio does not have a separate associations API in this subset. A link from one record to another is
an **attribute** of type `record-reference` on the source object. Its values are arrays of references:

```json
"associated_company": [
  {
    "active_from": "2026-09-01T10:00:00.000Z",
    "active_until": null,
    "created_by_actor": { "type": "api-token", "id": "<uuid>" },
    "target_object": "companies",
    "target_record_id": "<company record uuid>",
    "attribute_type": "record-reference"
  }
]
```

- `target_object` — slug of the referenced object.
- `target_record_id` — the referenced record's `record_id` (the inner UUID of its composite id).

The standard `deals` object has a record-reference attribute to `companies`
(`associated_company`). Other workspace-defined record-reference attributes can exist; list the
object's attributes and look for `type: "record-reference"`. The allowed targets are in
`config.record_reference.allowed_object_ids`.

Some reference attributes are paired with a reverse attribute on the target object (the attribute's
`relationship` field describes the pairing when present). Do not assume a reverse attribute exists;
check the attribute list.

## Finding records that reference a given record

Filter the source object's records by the reference attribute. Two equivalent shapes:

Shorthand (both keys together):

```json
POST /v2/objects/deals/records/query
{
  "filter": {
    "associated_company": {
      "target_object": "companies",
      "target_record_id": "<company record uuid>"
    }
  }
}
```

Verbose on the sub-property:

```json
POST /v2/objects/deals/records/query
{
  "filter": {
    "associated_company": { "target_record_id": { "$eq": "<company record uuid>" } }
  }
}
```

Combine with other conditions using `$and`:

```json
{
  "filter": {
    "$and": [
      { "associated_company": { "target_record_id": { "$eq": "<company record uuid>" } } },
      { "value": { "currency_value": { "$gt": 0 } } }
    ]
  }
}
```

The result is paged with `limit`/`offset` like any record query (see `pagination.md`).

## Reading the referenced record

A reference only contains the target slug and UUID. To read the target's attributes, fetch it:

```
GET /v2/objects/companies/records/<company record uuid>
```

or query the target object with a filter. Record query results do not inline the referenced
record's values.

## Identifying the right company first

When looking a company up by attribute (e.g. its domain), query the `companies` object:

```json
POST /v2/objects/companies/records/query
{ "filter": { "domains": { "domain": { "$eq": "acme.test" } } } }
```

Display names are not unique; two company records can share a `name` while having different
`domains`. Use the returned `id.record_id` as the `target_record_id` in subsequent filters.

## Writing a reference

A record-reference value can be written in the update body (see `updating-records.md`) as:

```json
{ "data": { "values": {
  "associated_company": [ { "target_object": "companies", "target_record_id": "<uuid>" } ]
} } }
```

## Errors

- Filtering on a slug that does not exist on the object → 400 `unknown_filter_attribute_slug`.
- Referencing a `record_id` that does not exist → 400 `value_not_found`.
- Fetching a non-existent record → 404 `not_found`.
