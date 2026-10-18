---
title: HubSpot — Deal pipelines and stages
vendor: hubspot
snapshot: 2026-10-17
sources:
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/pipelines/guide
  - https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide
---

> Paraphrased excerpt of official vendor documentation pinned for this benchmark; the API you call is a synthetic contract fixture of this subset.

## Concept

Every deal belongs to one **pipeline** (the `pipeline` property) and one **stage** of that
pipeline (the `dealstage` property). An account can have several deal pipelines, and each has
its own ordered set of stages.

Both properties store **internal IDs**, not display labels:

- The account's original pipeline has the ID `default`. Its stages have readable internal IDs
  (for example `appointmentscheduled`) that don't always match their labels.
- Pipelines and stages created later get **numeric IDs** (as strings), which are different in
  every account.
- Two pipelines can each have a stage with the same label (for example both have a "Closed won"
  stage), but those stages have different IDs.

Look stage IDs up with the pipelines API. Don't build them from labels, and don't reuse IDs from
another account.

## Endpoints

```
GET /crm/v3/pipelines/deals
GET /crm/v3/pipelines/deals/{pipelineId}
GET /crm/v3/pipelines/deals/{pipelineId}/stages
```

### Response

```json
{
  "results": [
    {
      "id": "default",
      "label": "Sales Pipeline",
      "displayOrder": 0,
      "archived": false,
      "stages": [
        {
          "id": "appointmentscheduled",
          "label": "Appointment Scheduled",
          "displayOrder": 0,
          "archived": false,
          "metadata": { "isClosed": "false", "probability": "0.2" }
        }
      ]
    },
    {
      "id": "71234567",
      "label": "Partner deals",
      "displayOrder": 1,
      "archived": false,
      "stages": [
        { "id": "71234568", "label": "Intro", "displayOrder": 0, "archived": false,
          "metadata": { "isClosed": "false", "probability": "0.1" } },
        { "id": "71234571", "label": "Closed won", "displayOrder": 3, "archived": false,
          "metadata": { "isClosed": "true", "probability": "1.0" } }
      ]
    }
  ]
}
```

The `/stages` sub-resource returns `{ "results": [ ...stage objects... ] }` for one pipeline.

## Stage metadata

| Key | Values | Meaning |
| --- | --- | --- |
| `isClosed` | `"true"` / `"false"` | Whether the stage is a closed stage. |
| `probability` | `"0.0"` to `"1.0"` | Win probability. A closed stage with `"1.0"` is a **won** stage; a closed stage with `"0.0"` is a **lost** stage. |

Metadata values are **strings**, not JSON booleans or numbers. Compare `"true"`, not `true`.

## Open vs. closed deals

- Each pipeline has its **own** closed-won and closed-lost stages. Being "closed" is a property
  of the stage, so checking the stage ID against one pipeline's closed stages misses closed stages
  in other pipelines.
- Ways to tell whether a deal is closed:
  - the calculated deal properties `hs_is_closed` and `hs_is_closed_won` (`"true"`/`"false"`,
    read-only), which can also be used in search filters;
  - looking up the deal's `dealstage` in its pipeline's `stages[]` and reading `metadata.isClosed`.
- Stage `label`s are display text and may be renamed at any time.

## Changing a deal's stage

```
PATCH /crm/v3/objects/deals/{dealId}
{ "properties": { "dealstage": "<stage id from this deal's pipeline>" } }
```

- The stage must belong to the deal's current pipeline, or to the `pipeline` sent in the same
  request. Otherwise the request fails with 400 `VALIDATION_ERROR`.
- Moving into a closed stage recalculates `hs_is_closed*` and fills `closedate` if it was empty.
- `hs_is_closed` and `hs_is_closed_won` can't be written directly. Change `dealstage` instead.

## Filtering by pipeline or stage in search

```json
{ "filterGroups": [ { "filters": [
  { "propertyName": "pipeline",  "operator": "EQ", "value": "71234567" },
  { "propertyName": "dealstage", "operator": "IN", "values": ["71234568", "71234569"] }
] } ] }
```

Use pipeline and stage **IDs** as filter values.
