---
title: Pipedrive — Linking deals, organizations and persons
vendor: pipedrive
snapshot: 2026-10-17
sources:
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://developers.pipedrive.com/docs/api/v1/Persons
  - https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Relationship model

Pipedrive does not have a separate associations API for the core entities. Relationships are plain
**integer foreign-key fields on the record**:

| Field on deal | Points to |
| --- | --- |
| `org_id` | The organization the deal belongs to (at most one) |
| `person_id` | The primary contact person (at most one) |
| `owner_id` | The user who owns the deal |
| `pipeline_id`, `stage_id` | The pipeline and stage the deal sits in |

A person likewise has an `org_id`. A deal can be linked to an organization, a person, both, or
neither (`null`).

```json
{
  "id": 1201,
  "title": "Acme expansion",
  "org_id": 17,
  "person_id": null,
  "owner_id": 9,
  "pipeline_id": 1,
  "stage_id": 3
}
```

## Listing an organization's deals

Filter the deals list by the organization id:

```
GET /api/v2/deals?org_id=17
```

Combine with `status` to restrict to open, won or lost deals:

```
GET /api/v2/deals?org_id=17&status=open
```

The result is cursor-paginated like any other v2 list (see `pagination.md`). Remember that
`filter_id` causes `org_id` to be ignored (see `search.md`).

Alternatively, `GET /api/v2/deals/search?term=...&organization_id=17` limits a term search to one
organization.

## Resolving an organization first

Organization names are not unique. Two organizations can have the same `name` and differ only in
other fields (address, owner, custom fields such as a website). To identify an organization:

1. Search with `/api/v2/organizations/search` (`fields=name`, or `fields=custom_fields` to match a
   text custom field value).
2. Inspect the returned items, or fetch `GET /api/v2/organizations/{id}` and read its
   `custom_fields` (keys resolved via `/api/v1/organizationFields`).
3. Use the chosen `id` as `org_id` when listing deals.

## Reading the linked organization from a deal

The deal carries only the integer `org_id`. Fetch the organization separately:

```
GET /api/v2/organizations/17
```

```json
{
  "success": true,
  "data": {
    "id": 17,
    "name": "Acme",
    "owner_id": 9,
    "visible_to": 3,
    "add_time": "2026-01-05T10:00:00Z",
    "update_time": "2026-02-01T08:30:00Z",
    "custom_fields": {}
  }
}
```

## Changing a link

Re-linking is an ordinary field update:

```http
PATCH /api/v2/deals/1201
content-type: application/json

{ "org_id": 18 }
```

Setting `org_id` or `person_id` to `null` removes the link. The referenced organization or person
must exist, otherwise the request fails with 400.

## Persons

`person_id` is part of the deal shape; person endpoints themselves (`/api/v2/persons`) are outside
the subset covered by this snapshot.
