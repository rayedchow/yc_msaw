---
title: Zoho CRM — Searching records
vendor: zoho
snapshot: 2026-10-17
sources:
  - https://www.zoho.com/crm/developer/docs/api/v8/search-records.html
  - https://github.com/zoho/crm-oas/tree/main/v8.0/module_search
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Endpoint

```http
GET /crm/v8/{module}/search?criteria={criteria}&fields={api_names}&page={n}&per_page={n}
Authorization: Zoho-oauthtoken {token}
```

Exactly one search mode must be supplied:

| Parameter | Meaning |
| --- | --- |
| `criteria` | Structured filter expression (grammar below) |
| `word` | Free-text search across the module's searchable fields |
| `email` | Search email fields |
| `phone` | Search phone fields |

If none is present the API returns:

```json
{"code":"REQUIRED_PARAM_MISSING","details":{},"message":"One of the expected parameter is missing","status":"error"}
```

Optional parameters: `fields` (comma-separated API names; when omitted, all fields are returned),
`page` (default 1) and `per_page` (default and maximum 200).

## Criteria grammar

A single condition is written in parentheses as `field_api_name:operator:value`:

```
(Account_Name:equals:Acme)
```

Conditions combine with `and` / `or`, and groups nest with parentheses:

```
((Industry:equals:Software)and(Account_Name:starts_with:Ac))
((Stage:equals:Intro call)or(Amount:greater_than:50000))
```

URL-encode the whole criteria string when placing it in the query string.

### Operators

| Operator | Applies to | Notes |
| --- | --- | --- |
| `equals` | all | see "equals on text fields" below |
| `not_equal` | all | |
| `starts_with` | text | prefix match |
| `in` | text, picklist, id | comma-separated values: `(Industry:in:Software,Retail)` |
| `greater_than`, `greater_equal` | number, currency, date, datetime | |
| `less_than`, `less_equal` | number, currency, date, datetime | |
| `between` | number, currency, date, datetime | two comma-separated bounds |

### Escaping

Parentheses and commas are part of the grammar. If a value contains `(`, `)` or `,`, escape the
character with a backslash, e.g. `(Account_Name:equals:Acme \(EU\))`.

### equals on text fields is not an exact match

The documentation notes that `equals` on text fields behaves like a **contains** match and is
case-insensitive. For example, `(Account_Name:equals:ABC)` can return records named
"ABC Inc" or "abc holdings". The same applies to text fields such as `Website`. Search results
can therefore include near-matches; compare the returned field values yourself when you need an
exact record.

For picklist, number, currency and ID comparisons, `equals` is exact.

### Lookup fields

A lookup field can be filtered by the referenced record's ID or name:

```
(Account_Name.id:equals:1234567000000012345)
(Account_Name:equals:Acme)
```

The `.id` form is an exact ID comparison. The name form follows the text-matching rules above.

## Response

```http
HTTP/1.1 200 OK
```

```json
{
  "data": [
    { "id": "1234567000000012345", "Account_Name": "Acme", "Website": "acme.test" },
    { "id": "1234567000000012399", "Account_Name": "Acme Holdings", "Website": "acmeholdings.test" }
  ],
  "info": { "count": 2, "more_records": false, "page": 1, "per_page": 200 }
}
```

When nothing matches, the response is **HTTP 204 No Content** with an empty body.

When `info.more_records` is `true`, request the next `page` (see `pagination.md`).

## Errors

Malformed criteria (unbalanced parentheses, missing operator, unknown operator):

```json
{"code":"INVALID_QUERY","details":{"reason":"invalid criteria"},"message":"invalid query formed","status":"error"}
```

Unknown field API name in `criteria` or `fields`:

```json
{"code":"INVALID_DATA","details":{"api_name":"Webiste"},"message":"invalid data","status":"error"}
```

## Examples

Accounts whose Website contains a value (contains-like semantics apply):

```http
GET /crm/v8/Accounts/search?criteria=(Website:equals:acme.test)&fields=Account_Name,Website
```

Deals linked to one account and above an amount:

```http
GET /crm/v8/Deals/search?criteria=((Account_Name.id:equals:1234567000000012345)and(Amount:greater_than:10000))&fields=Deal_Name,Stage,Amount
```

Free-text search:

```http
GET /crm/v8/Accounts/search?word=Acme&fields=Account_Name
```
