---
title: Generic — Connection-scoped HTTP requests
vendor: generic
snapshot: 2026-10-17
sources:
  - (benchmark harness concept; vendor specifics live in the per-vendor pages)
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## What a connection is

A **connection** is a pre-configured link to one CRM account. It has:

| Attribute | Meaning |
| --- | --- |
| Connection ID / name | How you choose the connection when you make a request. |
| Vendor | Which CRM product it talks to (HubSpot, Pipedrive, Zoho CRM, Attio, ...). |
| Base URL | Root of the vendor API for this account. Request paths are relative to it. |
| Injected credentials | The token and the vendor's auth scheme. Added to every request automatically; you never see or send the secret. |

A connection belongs to exactly one account. IDs, field keys, custom property names, pipeline
and stage IDs read through one connection are meaningful only in that account.

## The HTTP tool

A connection-scoped HTTP tool sends one raw request to the connection's vendor API:

```json
{
  "connection": "<connection id>",
  "method": "GET | POST | PATCH | PUT | DELETE",
  "path": "/vendor/specific/path?query=string",
  "body": { "any": "JSON value, sent as-is" }
}
```

What the tool does:

- Joins the connection's **base URL** and your `path` (with its query string) without changing
  either.
- Adds the vendor's **authentication header** for the connection. The header name and scheme
  differ by vendor (see each vendor's `overview.md`). Don't add your own auth header, and don't
  put credentials in the path.
- Sends `method` and `body` **exactly as given**. It doesn't rename fields, add or remove
  envelopes, convert IDs, translate filters or page for you.
- Returns the vendor's raw response: HTTP status, the relevant headers (for example request or
  correlation IDs) and the body exactly as received, which may be empty (for example a 204).

What the tool does **not** do:

- It doesn't turn one vendor's request format into another's. A request body written for one
  CRM, sent to a different CRM, is passed through unchanged, and that vendor responds however it
  responds (often with a validation error, sometimes by ignoring unknown parameters).
- It doesn't retry failed writes or merge multi-value fields.
- It doesn't follow pagination cursors.

## Reading responses

- Treat the **status code and body together** as the result. Vendors differ:
  - some return 200 with an error inside the body;
  - some return 207 for batches where some rows succeeded and others failed;
  - some return 204 with no body to mean "no results";
  - error envelopes differ by vendor (see each vendor's `overview.md`).
- A 2xx on a batch write doesn't always mean every row was applied. Check per-row results where
  the vendor provides them.
- Copy pagination tokens, cursors and IDs exactly as returned.

## Vendor pages

| Vendor | Start here |
| --- | --- |
| HubSpot | `../hubspot/overview.md` |
| Pipedrive | `../pipedrive/overview.md` |
| Zoho CRM | `../zoho/overview.md` |
| Attio | `../attio/overview.md` |

Each vendor folder has the same topics: overview (auth, base URL, IDs, errors),
objects-and-fields, search, pagination, associations, updating-records, and pipelines-and-stages.
Conventions that work in one vendor's API don't carry over to another vendor's API unless that
vendor's pages say so.
