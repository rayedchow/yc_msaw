---
title: CRM API documentation corpus — index
vendor: all
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm
  - https://developers.pipedrive.com/docs/api/v1/Deals
  - https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
  - https://api.attio.com/openapi/api
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

This corpus pins a snapshot of the public REST documentation for four CRMs. It is limited to
reading and updating companies/organizations/accounts and deals. Each vendor folder covers the
same topics so they're easy to compare, but **the APIs themselves differ**: auth headers, IDs,
envelopes, query languages, pagination and multi-value write semantics are all vendor-specific.
Wherever the synthetic API is more specific than the public docs, the text says
"(benchmark fixture detail)".

## Layout

| Topic | HubSpot | Pipedrive | Zoho CRM | Attio |
| --- | --- | --- | --- | --- |
| Overview, auth, base URL, IDs, errors | [overview](hubspot/overview.md) | [overview](pipedrive/overview.md) | [overview](zoho/overview.md) | [overview](attio/overview.md) |
| Objects and field/property metadata | [objects-and-fields](hubspot/objects-and-fields.md) | [objects-and-fields](pipedrive/objects-and-fields.md) | [objects-and-fields](zoho/objects-and-fields.md) | [objects-and-fields](attio/objects-and-fields.md) |
| Search / query, filter syntax, operators | [search](hubspot/search.md) | [search](pipedrive/search.md) | [search](zoho/search.md) | [search](attio/search.md) |
| Pagination | [pagination](hubspot/pagination.md) | [pagination](pipedrive/pagination.md) | [pagination](zoho/pagination.md) | [pagination](attio/pagination.md) |
| Associations / related records | [associations](hubspot/associations.md) | [associations](pipedrive/associations.md) | [associations](zoho/associations.md) | [associations](attio/associations.md) |
| Updating records (envelopes, multi-value fields, errors) | [updating-records](hubspot/updating-records.md) | [updating-records](pipedrive/updating-records.md) | [updating-records](zoho/updating-records.md) | [updating-records](attio/updating-records.md) |
| Pipelines, stages, status | [pipelines-and-stages](hubspot/pipelines-and-stages.md) | [pipelines-and-stages](pipedrive/pipelines-and-stages.md) | [pipelines-and-stages](zoho/pipelines-and-stages.md) | [pipelines-and-stages](attio/pipelines-and-stages.md) |

Cross-vendor: [generic/http-connections.md](generic/http-connections.md) explains the
connection-scoped HTTP tool. Each connection supplies a base URL and injects auth; the tool sends
your method, path and body exactly as written.

## API versions pinned

| Vendor | Surface |
| --- | --- |
| HubSpot | CRM v3 objects, search, properties and pipelines; v4 associations (read) |
| Pipedrive | API v2 organizations, deals, pipelines and stages; v1 `dealFields` / `organizationFields` |
| Zoho CRM | REST API v8 (`/crm/v8`): records, search, related records, field and module metadata |
| Attio | REST API v2 (`/v2`): objects, attributes, options/statuses, record query, get, update, assert |

## Quick contrast (pointers only; read each page for the details)

| Concern | HubSpot | Pipedrive | Zoho CRM | Attio |
| --- | --- | --- | --- | --- |
| Auth header | `Authorization: Bearer` | `x-api-token` | `Authorization: Zoho-oauthtoken` | `Authorization: Bearer` |
| Record ID type | numeric string | integer | 19-digit decimal string | UUID within a composite id object |
| Write envelope | `{properties:{...}}` | flat fields + `custom_fields:{<key>:...}` | `{data:[{...}]}` | `{data:{values:{...}}}` |
| Query style | POST `/search` with `filterGroups` | GET list filters + `/search?term=` | GET `/search?criteria=(F:op:v)` | POST `/records/query` with `$and/$or` filter |
| Pagination | `paging.next.after` cursor | `additional_data.next_cursor` (v2) | `page`/`per_page` + `info.more_records` | `limit`/`offset` |
| Multi-value write | `;`-joined string; a leading `;` appends | array of option ids replaces the set | array of strings replaces the set | PATCH adds, PUT replaces |
| Closed deals | stage `metadata.isClosed` per pipeline | `status` field, separate from `stage_id` | Stage picklist value | status attribute value |
