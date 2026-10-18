---
title: Zoho CRM — Overview, authentication, base URL and IDs
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html
  - https://www.zoho.com/crm/developer/docs/api/v8/token-validity.html
  - https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
  - https://github.com/zoho/crm-oas
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## What this subset covers

The Zoho CRM REST API (version 8) exposes CRM data as *modules* (for example `Accounts`,
`Contacts`, `Deals`). Records inside a module are read, searched and updated through
module-scoped endpoints. This snapshot covers:

| Area | Endpoints |
| --- | --- |
| Module metadata | `GET /crm/v8/settings/modules` |
| Field metadata | `GET /crm/v8/settings/fields?module={module}` |
| List records | `GET /crm/v8/{module}` |
| Get one record | `GET /crm/v8/{module}/{id}` |
| Search records | `GET /crm/v8/{module}/search` |
| Related records | `GET /crm/v8/{module}/{id}/{related_list}` |
| Update records | `PUT /crm/v8/{module}` and `PUT /crm/v8/{module}/{id}` |

Pages in this folder: `objects-and-fields.md`, `search.md`, `pagination.md`,
`associations.md`, `updating-records.md`, `pipelines-and-stages.md`.

## Base URL and data centers

Zoho CRM is hosted in several regional data centers. When an OAuth token is issued, the token
response includes an `api_domain` (for example `https://www.zohoapis.com`,
`https://www.zohoapis.eu`, ...). All CRM API calls must be sent to that domain; a token from one
region/environment is not valid against another. Every path in this subset begins with the
version prefix:

```
{api_domain}/crm/v8/...
```

Sandbox and developer environments have their own domains; use whichever `api_domain` came back
with the token.

## Authentication

Zoho CRM uses OAuth 2.0. Access tokens are valid for one hour; refresh tokens stay valid until
revoked. The important detail for API calls is the **authorization scheme**:

```
Authorization: Zoho-oauthtoken 1000.xxxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyy
```

The token endpoint's JSON response reports `"token_type": "Bearer"`, but CRM resource requests
must still use the `Zoho-oauthtoken` prefix. A request with a missing header, or with a different
scheme such as `Bearer`, is rejected:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"code":"INVALID_TOKEN","details":{},"message":"invalid oauth token","status":"error"}
```

## Record IDs

Record IDs are long decimal numbers (typically 19 digits) delivered as **JSON strings**, e.g.
`"1234567000000098765"`. They exceed JavaScript's safe integer range (2^53 − 1), so parsing them
as numbers silently corrupts them. Always keep IDs as strings, and send them back as strings.

Lookup fields (references to another record) are returned as objects containing the target's
`id` (string) and `name`:

```json
"Account_Name": { "name": "Acme", "id": "1234567000000012345" }
```

## Module and field API names

Modules and fields each have a **display label** (what users see in the UI) and an **API name**
(what the API accepts). They often differ: the "Account Name" field is `Account_Name`, the
"Deal Name" field is `Deal_Name`, and custom fields get generated API names with underscores.
Request parameters, criteria and update bodies always use API names. Discover them via the
metadata endpoints (see `objects-and-fields.md`) rather than deriving them from labels.

## Response envelopes

Successful record reads return a `data` array, even for a single record:

```json
{ "data": [ { "id": "1234567000000012345", "Account_Name": "Acme" } ],
  "info": { "per_page": 200, "count": 1, "page": 1, "more_records": false } }
```

When a list, search or related-list request matches nothing, Zoho responds with
**HTTP 204 No Content and an empty body** — not `200` with an empty array. Clients must handle
an empty body before attempting to parse JSON.

## Error format

Request-level errors share one envelope:

```json
{
  "code": "REQUIRED_PARAM_MISSING",
  "details": { "param": "fields" },
  "message": "One of the expected parameter is missing",
  "status": "error"
}
```

| Field | Meaning |
| --- | --- |
| `code` | Machine-readable error code (`INVALID_TOKEN`, `INVALID_DATA`, `REQUIRED_PARAM_MISSING`, `INVALID_QUERY`, ...) |
| `details` | Object with context, e.g. the offending `api_name`, `param` or `id` |
| `message` | Human-readable explanation |
| `status` | Always `"error"` for errors |

Write requests (`PUT`) additionally report a status **per row** inside `data[]`; an HTTP 2xx
does not guarantee every row succeeded. See `updating-records.md`.

Common HTTP statuses in this subset:

| Status | When |
| --- | --- |
| 200 | Success (all rows succeeded for writes) |
| 204 | No records matched (list/search/related) |
| 207 | Multi-status: some write rows succeeded, some failed |
| 400 | Validation errors (missing parameters, bad criteria, invalid data) |
| 401 | Missing/invalid token or wrong authorization scheme |
| 404 | Unknown URL |
| 405 | Method not supported on a known path |
