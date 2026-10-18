# Metadata audit — e2e-20261018T003409-5fec

Audit: **VERIFIED** (read-only observations of the hosted tenant store).

| check | result |
| --- | --- |
| bindings.presentAndNonLegacy | PASS |
| chunks.sha256VerifiedAgainstIndex | PASS |
| correlation.sameConversation | PASS |
| correlation.conversationIsNativePiIdentity | PASS |
| correlation.distinctRunIdsMatchingProducerRecords | PASS |
| correlation.previousRunIdLinksRetryToFirstRun | PASS |
| events.turnAndSpanStructurePresent | PASS |
| cohort.manifestMatchesReceipt | PASS |
| cohort.includesFreshCustomerFailureTrace | PASS |

```json
{
  "traceCorrelation": [
    {
      "attempt": 1,
      "sessionId": "ses-mvd3jr7e-8ff24dcdc54a",
      "binding": {
        "boundAt": "2026-10-18T00:38:33.278Z",
        "correlation": {
          "conversationId": "pi:01a14c71-b6b2-765e-99ed-3bf68a25e16a",
          "conversationSource": "harness",
          "runId": "e2e-20261018t003409-5fec-a1"
        },
        "day": "2026-10-18",
        "firstChunkSeq": 1,
        "legacy": false,
        "schema": "procmem.trace-session/v1",
        "sessionId": "ses-mvd3jr7e-8ff24dcdc54a"
      },
      "chunks": [
        {
          "key": "traces/2026-10-18/ses-mvd3jr7e-8ff24dcdc54a/chunk-000001.jsonl.gz",
          "sha256Matches": true
        }
      ],
      "events": 33,
      "sessionStartCorrelation": null,
      "correlationValuesInEvents": [
        {
          "conversationId": null,
          "runId": null
        }
      ],
      "turnIds": 2,
      "spanIds": 9,
      "parentSpanRefs": 8
    },
    {
      "attempt": 2,
      "sessionId": "ses-mvd3vsnu-8e637251cfd8",
      "binding": {
        "boundAt": "2026-10-18T00:47:56.966Z",
        "correlation": {
          "conversationId": "pi:01a14c71-b6b2-765e-99ed-3bf68a25e16a",
          "conversationSource": "harness",
          "previousRunId": "e2e-20261018t003409-5fec-a1",
          "runId": "e2e-20261018t003409-5fec-a2"
        },
        "day": "2026-10-18",
        "firstChunkSeq": 1,
        "legacy": false,
        "schema": "procmem.trace-session/v1",
        "sessionId": "ses-mvd3vsnu-8e637251cfd8"
      },
      "chunks": [
        {
          "key": "traces/2026-10-18/ses-mvd3vsnu-8e637251cfd8/chunk-000001.jsonl.gz",
          "sha256Matches": true
        }
      ],
      "events": 27,
      "sessionStartCorrelation": null,
      "correlationValuesInEvents": [
        {
          "conversationId": null,
          "runId": null
        }
      ],
      "turnIds": 2,
      "spanIds": 7,
      "parentSpanRefs": 6
    }
  ],
  "cohort": {
    "buildId": "bld-mvd3ko1m-2a179be130",
    "manifestKey": "daily/2026-10-18/manifest-0001.json",
    "day": "2026-10-18",
    "sessionIds": [
      "ses-mvd2n98x-399c659ea532",
      "ses-mvd2ngtu-93d997cd3819",
      "ses-mvd2noef-7e79df026363",
      "ses-mvd3jr7e-8ff24dcdc54a"
    ],
    "chunks": 5,
    "receiptSessions": [
      "ses-mvd2n98x-399c659ea532",
      "ses-mvd2ngtu-93d997cd3819",
      "ses-mvd2noef-7e79df026363",
      "ses-mvd3jr7e-8ff24dcdc54a"
    ],
    "traceArchive": {
      "bytes": 1710671,
      "chunks": 9,
      "days": 2,
      "disabled": false,
      "events": 160,
      "files": 31,
      "firstDay": "2026-10-17",
      "lastDay": "2026-10-18",
      "partitions": 8,
      "schema": "procmem.trace-archive/v1",
      "sessions": 8,
      "sha256": "1231f684410c983a5f1244adb3f6fc204f506e1507499a648585f746a8f2e466"
    },
    "freshCustomerSession": "ses-mvd3jr7e-8ff24dcdc54a",
    "otherSessions": [
      "ses-mvd2n98x-399c659ea532",
      "ses-mvd2ngtu-93d997cd3819",
      "ses-mvd2noef-7e79df026363"
    ],
    "note": "The other current-day sessions are earlier synthetic hosted SDK wire-verification traces in the same tenant; the build input labelled their objectives synthetic. This is normal full-tenant daily catch-up, not a fresh-only cohort."
  }
}
```
