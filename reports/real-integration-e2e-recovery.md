# POST-RUN VERIFICATION CORRECTION: the original verifier failed because it validated a bounded (clipped) transcript copy and its unauthenticated GitHub re-check was rate limited (403). No agent was rerun; no integration, memory, events or state were changed.

Audit: **ALL REQUIRED PROOFS VERIFIED** at 2026-10-17T23:45:28.116Z.

Original report (unchanged, verdict ok=false): `reports/real-integration-e2e-failed-e2e-20261017T232926-fe8d.json`, finished 2026-10-17T23:42:31.300Z. sha256:
- `reports/real-integration-e2e-failed-e2e-20261017T232926-fe8d.json`: 3696d8c80e64bb06fc6cc8dc6a3807fcceb87444d4485838fd6331a5302c84bc
- `reports/real-integration-e2e-failed-e2e-20261017T232926-fe8d.md`: a8af17f6467d4ebdc73791602920336e5148e74e31b11f5883f1c49e9b1aaf24
- `reports/real-integration-e2e-failed-e2e-20261017T232926-fe8d.html`: 41e5b0ec37aa53945f6b14d3f999a513e53b3568ade86107f4ca39819f9e5b90
- `.context/real-demo-events.jsonl`: 7c58389ce83dda84f29e9b295be087762d68c70954b2f1360973d3c17e655a30
- `.context/real-demo-state.json`: f852b0a105b5da318f941f99cd3860f88d3e78e2199b3a2f1d172aa4b7eebd59

Original failed checks (preserved): attempt2.calledRepairedToolWithRef, attempt2.realGithub200SameShaAsHostCheck, github.independentAfterSameSha

## Re-audit checks (primary evidence)

| check | result |
| --- | --- |
| trace2.chunksVerifiedAgainstIndex | PASS |
| trace2.eventCountMatchesOriginalFinish | PASS |
| trace1.chunksVerifiedAgainstIndex | PASS |
| trace2.toolCallFoundByCallId | PASS |
| trace2.toolResultBlobVerified | PASS |
| attempt2.calledRepairedToolWithRef | PASS |
| attempt2.resultNotError | PASS |
| attempt2.realGithub200SameShaAsHostCheck | PASS |
| attempt2.returnedTextSha256MatchesHostCheck | PASS |
| attempt2.finalAnswerInTraceHasFact | PASS |
| attempt2.finalAnswerMatchesOriginalTranscript | PASS |
| github.authenticatedCrossCheckSameSha | PASS |

## Evidence

```json
{
  "trace2": {
    "sessionId": "ses-mvd1jluf-7bdaed74e87a",
    "chunks": [
      {
        "key": "traces/2026-10-17/ses-mvd1jluf-7bdaed74e87a/chunk-000001.jsonl.gz",
        "indexKey": "trace-index/ses-mvd1jluf-7bdaed74e87a/chunk-000001.json",
        "chunkSeq": 1,
        "indexSha256": "76ca5e7ac3a3278d84c2dd0f40c78ca9dc70bec990ca81630263f2952e1fb0c8",
        "computedSha256": "76ca5e7ac3a3278d84c2dd0f40c78ca9dc70bec990ca81630263f2952e1fb0c8",
        "sha256Matches": true,
        "storedObjectBytes": 59081,
        "events": 33,
        "indexEvents": 33,
        "final": true,
        "receivedAt": "2026-10-17T23:42:29.558Z"
      }
    ],
    "events": 33,
    "toolCall": {
      "seq": 26,
      "ts": "2026-10-17T23:42:14.012Z",
      "callId": "call_65de0e5681684206ba9b7a3d",
      "name": "integration__github-read__read_file",
      "arguments": {
        "owner": "mcp-use",
        "path": "README.md",
        "ref": "v1.5.0",
        "repo": "mcp-use"
      }
    },
    "toolResult": {
      "seq": 27,
      "ts": "2026-10-17T23:42:14.644Z",
      "storedAs": "content-addressed blob",
      "blob": {
        "sha256": "2d242add38f750d3734c76c02bbf7f07f4d31f63d6f612268305f231af98b662",
        "bytes": 83990,
        "computedSha256": "2d242add38f750d3734c76c02bbf7f07f4d31f63d6f612268305f231af98b662",
        "matches": true
      },
      "isError": false,
      "rawResultChars": 82806
    },
    "githubEvidence": {
      "sha": "e43507d88d2e7545f54724fea6509ba00f40f57d",
      "ref": "v1.5.0",
      "owner": "mcp-use",
      "repo": "mcp-use",
      "path": "README.md",
      "size": 19725,
      "githubStatus": 200,
      "requestId": "C5DC:DAEBE:5E8412:12FCC0F:6AD407D6",
      "textSha256": "b330a5549e9d80107b8a1f2302838c28ddbf29b3979e76597e0c28cbdc0ad1ad",
      "textChars": 19429
    },
    "finalAnswer": {
      "seq": 31,
      "ts": "2026-10-17T23:42:23.963Z",
      "text": "Success this time. The updated memory revision (`rev-0a0cefcf1537a9df1e5c9497`) documented the fix to the GitHub Read integration — `read_file` now takes an optional `ref` — and reading `mcp-use/mcp-use/README.md` at `ref: v1.5.0` worked (file sha `e43507d88d2e7545f54724fea6509ba00f40f57d`).\n\n**The exact command the v1.5.0 README gives for creating a new TypeScript MCP server** (in the \"Create an MCP Server\" → TypeScript section) is:\n\n```bash\nnpx create-mcp-use-app my-server\ncd my-server\nnpm install\n```\n\nSo the scaffolding command itself is `npx create-mcp-use-app my-server`, followed by `cd my-server` and `npm install`. The README then shows building the server with `createMCPServer` from `mcp-use/server` (Python server creation is marked \"Coming Soon\" at this tag)."
    }
  },
  "githubAuthenticatedCrossCheck": {
    "via": "gh api (user-authorized GitHub CLI; token handled by gh, never read/printed)",
    "authenticated": true,
    "at": "2026-10-17T23:45:28.115Z",
    "status": 200,
    "requestId": "243B:7AFC7:1B0205:1D4E29:6AD40897",
    "sha": "e43507d88d2e7545f54724fea6509ba00f40f57d",
    "size": 19725,
    "textSha256": "b330a5549e9d80107b8a1f2302838c28ddbf29b3979e76597e0c28cbdc0ad1ad",
    "containsFact": true
  },
  "githubUnauthenticatedAfterOriginal": {
    "status": 403,
    "requestId": "E157:318781:1687EE:18C1A5:6AD407E7",
    "rateLimitRemaining": "0",
    "note": "original unauthenticated re-check: rate limited on the shared local IP (kept as recorded)"
  }
}
```
