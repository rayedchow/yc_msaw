# Real integration E2E: PASSED

Run `e2e-20261018T003409-5fec`, finished 2026-10-18T00:48:05.039Z.

## What is real and what is seeded

- **seededDefect**: HOST-SEEDED DEFECT (yesterday's state): github-read always sends ?ref=master and exposes no ref parameter (templates/integration/demo/github-read/seeded). Not model-authored.
- **upstream**: LIVE: real public api.github.com REST contents API (unauthenticated, read-only) called by the Manufact-hosted child MCP
- **customer**: LIVE: one Pi 1.3 session (Fireworks) with procmem SDK LiveToolRegistry tools against the hosted parent; SDK trace capture to the hosted parent
- **dailyCycle**: OPERATOR-TRIGGERED NOW: real DailyBuildService -> runMemoryBuild on the same Modal store/namespace as the hosted parent. Observed cohort (manifest daily/2026-10-18/manifest-0001.json): 4 sessions = this run's fresh customer failure trace ses-mvd3jr7e-8ff24dcdc54a + 3 earlier synthetic hosted SDK wire-verification traces of the same day (ses-mvd2n98x-399c659ea532, ses-mvd2ngtu-93d997cd3819, ses-mvd2noef-7e79df026363); the build also had read-only historical trace sources. [clarified post-run]
- **repair**: MODEL-AUTHORED: every integration/wiki tool call in the build is chosen by the Fireworks build agents; the host gives no repaired source
- **validation**: Sealed validation runs offline with a FAKE-data GitHub fixture; all proof calls to GitHub are real
- **lifecycle**: Agent rows/events follow .context/demo-lifecycle-contract.md: customer running only during real Pi agent runs (waiting between attempts, task_start/task_end carry per-attempt outcome); build agents from the live logger then authoritative receipts (harnessStatusToDemo for state AND events); operator rows (host, builder wrapper) separate; finalizeAgentRows leaves no running/waiting/pending row

## Checks

| check | result |
| --- | --- |
| preflight.orgPinned | PASS |
| github.masterIs404 | PASS |
| github.refIs200WithFact | PASS |
| seed.publishedAndProbed | PASS |
| sdk.seededToolVisible | PASS |
| invariant.sameSessionAndProcess | PASS |
| invariant.messageHistoryGrewWithExactPrefixes | PASS |
| invariant.everyAttemptTraceDelivered | PASS |
| invariant.buildCycleBudgetRespected | PASS |
| invariant.everyBuildCycleRecorded | PASS |
| invariant.independentGithubCheck | PASS |
| final.memoryReopenedNewestRevision | PASS |
| final.readMemoryAfterReopenBeforeTool | PASS |
| final.finalAttemptRanAfterARealBuild | PASS |
| final.finalAnswerHasFact | PASS |
| final.taskSucceeded | PASS |
| final.requestedMechanismProven | PASS |

## Agents (final lifecycle)

| agent | role | parent | status | last task |
| --- | --- | --- | --- | --- |
| Host orchestrator (operator script) | operator |  | succeeded |  |
| Customer agent (Pi session 01a14c71-b6b2-765e-99ed-3bf68a25e16a) | customer |  | succeeded | attempt 2: succeeded |
| Daily build service cycle 1 (operator wrapper, kimi-k3) | operator |  | succeeded |  |
| c1 root build agent root (depth 0) | build |  | succeeded |  |

## Key identifiers

- **hosted parent**: https://wild-zero-kq08i.run.mcp-use.com
- **tenant namespace**: t-5e37d0950c1f98d30baa
- **customer model**: accounts/fireworks/models/kimi-k3
- **Pi session id**: 01a14c71-b6b2-765e-99ed-3bf68a25e16a
- **process pid**: 21018
- **Pi constructions / same object**: 1 / true
- **message history per attempt**: [{"attempt":1,"length":11},{"attempt":2,"length":20}]
- **trace correlation per attempt**: [{"attempt":1,"conversationId":"pi:01a14c71-b6b2-765e-99ed-3bf68a25e16a","runId":"e2e-20261018t003409-5fec-a1","previousRunId":null},{"attempt":2,"conversationId":"pi:01a14c71-b6b2-765e-99ed-3bf68a25e16a","runId":"e2e-20261018t003409-5fec-a2","previousRunId":"e2e-20261018t003409-5fec-a1"}]
- **builder**: {"buildModel":"kimi-k3","rootProfileId":"kimi-k3","childProfileIds":["kimi-k3","glm-5p3","minimax-m3"],"budget":{"maxTurns":60,"maxToolCalls":220,"maxDescendants":4},"maxCycles":3,"path":"DailyBuildService -> runMemoryBuild (same profiles/workspace/integration providers as createConfiguredBuilder) + observing client wrapper; one service run per build cycle"}
- **GitHub default branch**: main
- **GitHub ?ref=master**: 404 No commit found for the ref master (request 9631:25929D:1EFA11:21EF02:6AD41407)
- **GitHub README@v1.5.0**: 200 sha e43507d88d2e7545f54724fea6509ba00f40f57d, 19725 bytes, text sha256 b330a5549e9d80107b8a1f2302838c28ddbf29b3979e76597e0c28cbdc0ad1ad
- **seeded commit**: 31f49ce45ddbaac0c53fd3abcf6e1a3715dfdd88
- **repaired commit**: 5ed8c88ca51f2312f7d846abb2aeba0a8f2bb5de
- **memory revision before -> after**: rev-72708034d58396c6408b2fcc -> rev-b6c7f4c3c80156f021605d7b
- **Manufact server**: 814475b5-d73b-4a8d-8b52-3c3a1799a7c7
- **deployment before -> after**: e65debb0-e869-4987-8295-b2e970a94ac7 -> d5478e1f-9da2-4c01-ab7b-5586a839609a
- **live child MCP URL**: https://fast-cloud-frwwq.run.mcp-use.com/mcp
- **daily build**: undefined in undefined ms
- **SDK detection**: {"kind":"integration","sdkAutomatic":true,"piAutomatic":true,"forcedRefreshUsed":false,"manualApplyUsed":false,"sdkObservedAt":"2026-10-18T00:47:25.144Z"}
- **build cohort (last cycle)**: {"manifestKey":"daily/2026-10-18/manifest-0001.json","sessions":["ses-mvd2n98x-399c659ea532","ses-mvd2ngtu-93d997cd3819","ses-mvd2noef-7e79df026363","ses-mvd3jr7e-8ff24dcdc54a"]}

## Feedback loop (customer attempts and real build cycles)

Verdict: {"ok":true,"task":{"ok":true,"failing":[]},"mechanism":{"ok":true,"failing":[]},"expectedInitialFailure":true,"cycleProofs":[{"cycle":1,"buildOk":true,"memoryChanged":true,"sourceChanged":true,"newDeployment":true,"sdkAutomatic":true,"piAutomatic":true}]}

Loop stop: {"action":"stop","verdict":"succeeded","reason":"real GitHub 200 with the host-truth sha via the integration, and the answer has the fact"}

### Attempt 1 — failed (integration)

run e2e-20261018t003409-5fec-a1 (previous null), trace ses-mvd3jr7e-8ff24dcdc54a, reason: integration tool error(s): 404 GitHub error 404: No commit found for the ref master (GET /repos/mcp-use/mcp-use/contents/README.md?ref=master; request id A17C:351787:5D28D7:12F6976:6AD414FC)

Answer:

```
I can't complete this as requested. Here's exactly what happened:

**Memory check:** The procedural memory has a page on this exact integration (`$KNOWLEDGE/integrations/github-read.md`) documenting a known failure mode: the GitHub Read tool hardcodes `?ref=master` and — in the broken revision — exposes no `ref` parameter, so reading `mcp-use/mcp-use/README.md` fails with a 404 even though the file exists, and there is no way to pin the `v1.5.0` tag. The memory records that a fixed build (commit `fb720207`) added an optional `ref` parameter and was verified to read this exact file at `v1.5.0` successfully.

**Live attempt:** I called `integration__github-read-10180034__read_file` with `owner=mcp-use`, `repo=mcp-use`, `path=README.md`. The current tool schema still has no `ref` parameter, and the call failed with:

> **GitHub error 404: No commit found for the ref master** (`GET /repos/mcp-use/mcp-use/contents/README.md?ref=master`; request id `A17C:351787:5D28D7:12F6976:6AD414FC`)

This is the documented hardcoded-`master` regression — the deployed integration in this session is the broken revision, not the fixed one. Per the memory's guidance, I did not retry with path variations, since the error names the ref, not the path.

**Conclusion:** I could not retrieve the README at tag `v1.5.0`, so I can't quote the TypeScript server-creation command from it. To unblock this, the GitHub Read integration needs to be redeployed/updated to the fixed build that supports the `ref` parameter.
```

#### Build cycle 1 — published (published changes)

- memory rev-72708034d58396c6408b2fcc -> rev-b6c7f4c3c80156f021605d7b (4 files)
- source 31f49ce45ddbaac0c53fd3abcf6e1a3715dfdd88 -> 5ed8c88ca51f2312f7d846abb2aeba0a8f2bb5de (3 files)
- deployment e65debb0-e869-4987-8295-b2e970a94ac7 -> d5478e1f-9da2-4c01-ab7b-5586a839609a new=true
- SDK: {"kind":"integration","sdkAutomatic":true,"piAutomatic":true,"forcedRefreshUsed":false,"manualApplyUsed":false}

### Attempt 2 — succeeded

run e2e-20261018t003409-5fec-a2 (previous e2e-20261018t003409-5fec-a1), trace ses-mvd3vsnu-8e637251cfd8, reason: real GitHub 200 with the host-truth sha via the integration, and the answer has the fact

Answer:

```
Success this time. The newly pinned memory revision (`rev-b6c7f4c3c80156f021605d7b`) documented that the `ref` fix had been re-applied to the re-seeded `github-read-10180034` integration (commit `5ed8c88c`), and the live tool schema now includes the `ref` parameter. The read of `mcp-use/mcp-use/README.md` at `ref: v1.5.0` succeeded (file sha `e43507d88d2e7545f54724fea6509ba00f40f57d`, 19,725 bytes, untruncated — matching the sha recorded in memory).

**Answer:** In the "Create an MCP Server" → TypeScript section, the README at v1.5.0 gives this exact shell command sequence:

ʼʼʼbash
npx create-mcp-use-app my-server
cd my-server
npm install
ʼʼʼ

The scaffolding command itself is `npx create-mcp-use-app my-server` (via the `create-mcp-use-app` package), followed by `cd my-server` and `npm install`. The README then shows a TypeScript example using `createMCPServer` from `mcp-use/server` to define tools and start the server with `server.listen(3000)`.
```

## read_file schema seen by the SDK

Before:
```
{
  "type": "object",
  "properties": {
    "owner": {
      "type": "string",
      "description": "Repository owner, e.g. octocat"
    },
    "repo": {
      "type": "string",
      "description": "Repository name, e.g. hello-world"
    },
    "path": {
      "type": "string",
      "description": "File path inside the repository, e.g. README.md"
    }
  },
  "required": [
    "owner",
    "repo",
    "path"
  ],
  "$schema": "https://json-schema.org/draft/2020-12/schema"
}
```
After:
```
{
  "type": "object",
  "properties": {
    "owner": {
      "type": "string",
      "description": "Repository owner, e.g. octocat"
    },
    "repo": {
      "type": "string",
      "description": "Repository name, e.g. hello-world"
    },
    "path": {
      "type": "string",
      "description": "File path inside the repository, e.g. README.md"
    },
    "ref": {
      "description": "Branch, tag or commit SHA, e.g. v1.5.0. Omit to use the repository's default branch.",
      "type": "string"
    }
  },
  "required": [
    "owner",
    "repo",
    "path"
  ],
  "$schema": "https://json-schema.org/draft/2020-12/schema"
}
```

## Post-run metadata clarification

```
{
  "clarifiedFields": [
    "labels.dailyCycle",
    "phases.attempts[].conversationId",
    "phases.attempts[].correlationObserved (new)",
    "postRunClarification (new)"
  ],
  "unchanged": "ok, verdict, checks, loopStop, tool calls/results and evidence, transcript, events, state and all other phases are byte-for-byte the emitted values",
  "originalEmitted": {
    "sha256": {
      "reports/real-integration-e2e-e2e-20261018T003409-5fec.json": "31d91db15074270227d36c771741dca6e3513054b3646647c38023eeaeb7ceba",
      "reports/real-integration-e2e-e2e-20261018T003409-5fec.md": "1aa206344f52124bed12964c17c0da42c4794a1188cae25b6e236cef53aa2440",
      "reports/real-integration-e2e-e2e-20261018T003409-5fec.html": "451a7617b9c47d32a6372abc14d8bd6f8eb53e5e16d35d6ab90f1791dad6d602"
    },
    "preservedAt": ".context/real-demo-fresh/as-emitted-reports"
  },
  "checks": {
    "bindings.presentAndNonLegacy": true,
    "chunks.sha256VerifiedAgainstIndex": true,
    "correlation.sameConversation": true,
    "correlation.conversationIsNativePiIdentity": true,
    "correlation.distinctRunIdsMatchingProducerRecords": true,
    "correlation.previousRunIdLinksRetryToFirstRun": true,
    "events.turnAndSpanStructurePresent": true,
    "cohort.manifestMatchesReceipt": true,
    "cohort.includesFreshCustomerFailureTrace": true
  },
  "auditReport": "reports/real-integration-e2e-e2e-20261018T003409-5fec-metadata-audit.json"
}
```

## Integration source diff (model-authored repair)

```
diff --git aa/src/github.ts bb/src/github.ts
index 4fefe11..9d259cb 100644
--- aa/src/github.ts
+++ bb/src/github.ts
@@ -1,9 +1,9 @@
 /** Client for the GitHub REST "Get repository content" endpoint (public repositories, no credentials). */
 const DEFAULT_API = "https://api.github.com";
-const DEFAULT_REF = "master";
 const MAX_TEXT_CHARS = 24_000;
 const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
 const PATH_SEGMENT_RE = /^[A-Za-z0-9._@+ -]{1,255}$/;
+const REF_RE = /^[A-Za-z0-9._\/-]{1,255}$/;
 
 export class GithubError extends Error {
   constructor(
@@ -37,12 +37,18 @@ export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
   throw new GithubError(0, "GITHUB_API_BASE_URL must be https://api.github.com or a loopback test fixture", null, null, "config");
 }
 
-export async function readFile(input: { owner: string; repo: string; path: string }, opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<GithubFile> {
+export async function readFile(input: { owner: string; repo: string; path: string; ref?: string }, opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<GithubFile> {
   if (!NAME_RE.test(input.owner) || !NAME_RE.test(input.repo)) throw new GithubError(0, "owner and repo must be plain GitHub names", null, null, "validation");
   const segments = input.path.split("/");
   if (segments.some((s) => !PATH_SEGMENT_RE.test(s) || s === "." || s === "..")) throw new GithubError(0, "path must be a repository-relative file path", null, null, "validation");
+  const ref = input.ref?.trim() ? input.ref.trim() : undefined;
+  if (ref !== undefined && (!REF_RE.test(ref) || ref.includes("..") || ref.split("/").some((s) => s.length === 0))) {
+    throw new GithubError(0, "ref must be a branch, tag or commit SHA (no empty segments or '..')", null, null, "validation");
+  }
   const base = opts.baseUrl ?? apiBase();
-  const route = `/repos/${input.owner}/${input.repo}/contents/${segments.map(encodeURIComponent).join("/")}?ref=${DEFAULT_REF}`;
+  // Omitting the ref query parameter makes GitHub serve the repository's DEFAULT branch
+  // (documented behavior of the contents API); never hardcode a branch name here.
+  const route = `/repos/${input.owner}/${input.repo}/contents/${segments.map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
   const res = await (opts.fetchImpl ?? fetch)(`${base}${route}`, {
     headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "procmem-github-read" },
   });
@@ -59,7 +65,7 @@ export async function readFile(input: { owner: string; repo: string; path: strin
     owner: input.owner,
     repo: input.repo,
     path: input.path,
-    ref: DEFAULT_REF,
+    ref: ref ?? "(default branch)",
     sha: String(body.sha),
     size: Number(body.size),
     text: full.slice(0, MAX_TEXT_CHARS),
diff --git aa/src/tools.ts bb/src/tools.ts
index 270a0eb..16167a5 100644
--- aa/src/tools.ts
+++ bb/src/tools.ts
@@ -35,12 +35,13 @@ export function registerTools(server: MCPServer) {
         owner: z.string().describe("Repository owner, e.g. octocat"),
         repo: z.string().describe("Repository name, e.g. hello-world"),
         path: z.string().describe("File path inside the repository, e.g. README.md"),
+        ref: z.string().optional().describe("Branch, tag or commit SHA, e.g. v1.5.0. Omit to use the repository's default branch."),
       }),
       annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
     },
-    async ({ owner, repo, path }) => {
+    async ({ owner, repo, path, ref }) => {
       try {
-        const f = await readFile({ owner, repo, path });
+        const f = await readFile({ owner, repo, path, ref });
         return { content: [{ type: "text", text: `${f.owner}/${f.repo}/${f.path}@${f.ref} (sha ${f.sha}, ${f.size} bytes${f.truncated ? ", truncated" : ""}):\n${f.text}` }], structuredContent: { ...f } };
       } catch (error) {
         return toolError(error);
diff --git aa/tests/github.test.ts bb/tests/github.test.ts
index 87ce14b..99bc7df 100644
--- aa/tests/github.test.ts
+++ bb/tests/github.test.ts
@@ -7,8 +7,20 @@ function fakeFetch(status: number, body: unknown): typeof fetch {
   return (async () => new Response(JSON.stringify(body), { status, headers: { "x-github-request-id": "TEST:1" } })) as typeof fetch;
 }
 
+/** Records the requested URL so tests can assert on the ref query parameter. */
+function recordingFetch(status: number, body: unknown): { fetchImpl: typeof fetch; urls: string[] } {
+  const urls: string[] = [];
+  const fetchImpl = (async (input: unknown) => {
+    urls.push(String(input));
+    return new Response(JSON.stringify(body), { status, headers: { "x-github-request-id": "TEST:1" } });
+  }) as typeof fetch;
+  return { fetchImpl, urls };
+}
+
+const FILE_BODY = { type: "file", encoding: "base64", content: Buffer.from("hello").toString("base64"), sha: "abc", size: 5 };
+
 test("decodes a base64 file", async () => {
-  const f = await readFile({ owner: "o", repo: "r", path: "README.md" }, { baseUrl: "http://127.0.0.1:9", fetchImpl: fakeFetch(200, { type: "file", encoding: "base64", content: Buffer.from("hello").toString("base64"), sha: "abc", size: 5 }) });
+  const f = await readFile({ owner: "o", repo: "r", path: "README.md" }, { baseUrl: "http://127.0.0.1:9", fetchImpl: fakeFetch(200, FILE_BODY) });
   assert.equal(f.text, "hello");
   assert.equal(f.github.requestId, "TEST:1");
 });
@@ -19,3 +31,48 @@ test("surfaces GitHub errors with status and message", async () => {
     (e: unknown) => e instanceof GithubError && e.status === 404 && e.message === "Not Found",
   );
 });
+
+// Regression: the seeded revision hardcoded ?ref=master, which 404s with
+// "No commit found for the ref master" on any repo whose default branch is not
+// master (observed live on mcp-use/mcp-use, ses-mvd3jr7e-8ff24dcdc54a#27).
+test("omitted ref sends NO ref query parameter (GitHub then serves the default branch)", async () => {
+  const { fetchImpl, urls } = recordingFetch(200, FILE_BODY);
+  const f = await readFile({ owner: "mcp-use", repo: "mcp-use", path: "README.md" }, { baseUrl: "http://127.0.0.1:9", fetchImpl });
+  assert.equal(urls.length, 1);
+  assert.ok(!urls[0].includes("ref="), `URL must not pin a ref: ${urls[0]}`);
+  assert.equal(f.ref, "(default branch)");
+});
+
+test("explicit ref is sent as the ref query parameter (release tag)", async () => {
+  const { fetchImpl, urls } = recordingFetch(200, FILE_BODY);
+  const f = await readFile({ owner: "mcp-use", repo: "mcp-use", path: "README.md", ref: "v1.5.0" }, { baseUrl: "http://127.0.0.1:9", fetchImpl });
+  assert.ok(urls[0].endsWith("?ref=v1.5.0"), `URL must pin the tag: ${urls[0]}`);
+  assert.equal(f.ref, "v1.5.0");
+});
+
+test("explicit ref works for branch names with slashes and commit SHAs", async () => {
+  const { fetchImpl, urls } = recordingFetch(200, FILE_BODY);
+  await readFile({ owner: "o", repo: "r", path: "a/b.txt", ref: "feature/login-fix" }, { baseUrl: "http://127.0.0.1:9", fetchImpl });
+  assert.ok(urls[0].includes("?ref=feature%2Flogin-fix"), `slash branch must be encoded: ${urls[0]}`);
+  await readFile({ owner: "o", repo: "r", path: "a/b.txt", ref: "fb720207c51a3d2d5cd61455122054f96c77f09f" }, { baseUrl: "http://127.0.0.1:9", fetchImpl });
+  assert.ok(urls[1].includes("?ref=fb720207c51a3d2d5cd61455122054f96c77f09f"), `SHA ref: ${urls[1]}`);
+});
+
+test("blank ref is treated as omitted (default branch)", async () => {
+  const { fetchImpl, urls } = recordingFetch(200, FILE_BODY);
+  await readFile({ owner: "o", repo: "r", path: "README.md", ref: "   " }, { baseUrl: "http://127.0.0.1:9", fetchImpl });
+  assert.ok(!urls[0].includes("ref="), `blank ref must not be sent: ${urls[0]}`);
+});
+
+test("invalid refs are rejected client-side before any request", async () => {
+  const { fetchImpl, urls } = recordingFetch(200, FILE_BODY);
+  await assert.rejects(
+    readFile({ owner: "o", repo: "r", path: "README.md", ref: "bad..ref" }, { baseUrl: "http://127.0.0.1:9", fetchImpl }),
+    (e: unknown) => e instanceof GithubError && e.request === "validation",
+  );
+  await assert.rejects(
+    readFile({ owner: "o", repo: "r", path: "README.md", ref: "a//b" }, { baseUrl: "http://127.0.0.1:9", fetchImpl }),
+    (e: unknown) => e instanceof GithubError && e.request === "validation",
+  );
+  assert.equal(urls.length, 0);
+});

```

## Memory diff (model-authored wiki update)

```
diff --git aa/index.md bb/index.md
index bc62148..3b72d44 100644
--- aa/index.md
+++ bb/index.md
@@ -6,6 +6,6 @@ This wiki is maintained by the daily procedural-memory build from captured agent
 
 - [Integrations](integrations/index.md) — how specific APIs and tools actually behave (endpoints, pagination, idempotency, errors).
   - [Ledgerly (fictional invoices API)](integrations/ledgerly/index.md) — cursor pagination with a 50-item limit cap, idempotent payments, and safe retry after ambiguous 503s.
-  - [GitHub Read integration](integrations/github-read.md) — reading files from public GitHub repos at the default branch or a pinned tag/branch/SHA; hardcoded-`master` 404 failure mode and its fix.
+  - [GitHub Read integration](integrations/github-read.md) — reading files from public GitHub repos at the default branch or a pinned tag/branch/SHA; hardcoded-`master` 404 failure mode (regressed once via re-seeding) and its fixes.
 - [Tools](tools/index.md) — behavior of the platform's own tools.
   - [Memory MCP tools (`memory__*`)](tools/memory-mcp.md) — pinning a revision with `open_memory`; always pass `workspaceId` or multi-workspace calls fail with `workspace_ambiguous`.
diff --git aa/integrations/github-read.md bb/integrations/github-read.md
index 17d6644..5e27338 100644
--- aa/integrations/github-read.md
+++ bb/integrations/github-read.md
@@ -4,7 +4,10 @@ Parent: [Integrations](../index.md)
 
 MCP integration that reads files from **public** GitHub repositories through the GitHub
 REST "Get repository content" endpoint (`GET /repos/{owner}/{repo}/contents/{path}`,
-unauthenticated). Deployed tool: `integration__github-read__read_file`.
+unauthenticated). Deployed tool: `integration__github-read__read_file` (the exact
+integration slug in the tool name varies per environment, e.g.
+`integration__github-read-10180034__read_file` — match on the `read_file` suffix and
+the "GitHub Read" title, not the full prefix).
 
 ## Tool: `read_file`
 
@@ -12,46 +15,58 @@ Parameters: `owner`, `repo`, `path` (required), `ref` (optional — branch, tag
 SHA, e.g. `v1.5.0`). Returns the decoded UTF-8 text (capped at 24 000 chars, flagged
 `truncated`), the file `sha`, the effective `ref`, and the GitHub request id.
 
-**Ref semantics (current, fixed revision):** omit `ref` to read from the repository's
+**Ref semantics (fixed revision):** omit `ref` to read from the repository's
 **default branch** — the client then sends no `ref` query parameter and GitHub applies
 its documented default ("Default: the repository's default branch",
 <https://docs.github.com/en/rest/repos/contents>). Pass `ref` explicitly to pin a
 release tag, branch or SHA.
 
-## Failure mode (fixed 2026-10-17): hardcoded `master` ref
+## Failure mode: hardcoded `master` ref (regressed, fixed twice)
 
-The initially deployed revision always sent `?ref=master` and exposed no `ref`
-parameter. On any repository whose default branch is not `master` this fails with
-HTTP 404 and message `No commit found for the ref master` — even when the file exists.
-Observed in `ses-mvd18evw-507ec38e35a1`: both `read_file(owner=mcp-use, repo=mcp-use,
-path=README.md)` (`#14`→`#15`) and a retry with `readme.md` (`#20`→`#21`) returned that
-404, and the session failed because the requested tag `v1.5.0` could not be passed at
-all (client-reported, `#25`).
+The broken revision always sends `?ref=master` and exposes no `ref` parameter. On any
+repository whose default branch is not `master` this fails with HTTP 404 and message
+`No commit found for the ref master` — even when the file exists. Observed twice:
+
+- `ses-mvd18evw-507ec38e35a1` (2026-10-17): both `read_file(owner=mcp-use,
+  repo=mcp-use, path=README.md)` (`#14`→`#15`) and a retry with `readme.md`
+  (`#20`→`#21`) returned that 404; the session failed because tag `v1.5.0` could not
+  be passed at all (client-reported, `#25`).
+- `ses-mvd3jr7e-8ff24dcdc54a` (2026-10-18): a freshly seeded copy of the integration
+  (slug `github-read-10180034`) was deployed from the **pre-fix template**, so the
+  regression returned. The live tool schema listed only `owner`/`repo`/`path` (`#3`)
+  and the call failed with the identical 404 (`#26`→`#27`, request id
+  `A17C:351787:5D28D7:12F6976:6AD414FC`). The agent correctly did not retry path
+  variations and reported the missing `ref` capability (`#31`).
 
 **Lesson:** changing the file path does not help when the 404 message names the *ref*;
-read the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to see
-which parameter is wrong. Do not retry with path variations — report the missing `ref`
-capability instead.
+read the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to
+see which parameter is wrong. Do not retry with path variations — report the missing
+`ref` capability instead.
+
+**Lesson (platform):** a fix committed to one integration repo does not propagate to
+newly seeded copies of the same integration. When a task's tool slug differs from the
+one a memory page names, re-check the live tool schema for the documented parameter
+before assuming the fix is deployed.
 
-**Repair (this build):** added optional `ref` parameter; omitted `ref` now means the
-default branch. Validated (`val-d23ff76f05c300dd5adac809`: regression cases "omitted
-ref reads the repository default branch (main)", "reads a file at an explicit release
-tag ref", heldout slash-branch/SHA/nested-path cases), commit `fb720207`, deployed and
-probe-passed (`pub-b166454ef8c67af24ab8bc9b`, deployment `2050cca9`).
+**Repairs:** first fixed 2026-10-17 in `github-read` (commit `fb720207`, validation
+`val-d23ff76f05c300dd5adac809`, deployment `2050cca9`, probe `pub-b166454ef8c67af24ab8bc9b`).
+Re-applied 2026-10-18 to the re-seeded `github-read-10180034` (commit `5ed8c88c`,
+validation `val-ff16ce86a2702b0c965b5a48` — regression cases "omitted ref reads the
+repository default branch (main)", "reads a file at an explicit release tag ref",
+heldout slash-branch/SHA/nested-path cases — deployment `d5478e1f`, probe
+`pub-ececa8ab3da9d7093ff4c581`).
 
 **Verified end-to-end 2026-10-17:** the retry session read
 `mcp-use/mcp-use/README.md` at `ref: v1.5.0` successfully — `isError: false`, file sha
 `e43507d88d2e7545f54724fea6509ba00f40f57d`, size 19 725 bytes, `truncated: false`
-(`ses-mvd1jluf-7bdaed74e87a#26`→`#27`). The deployed tool schema now lists `ref` as an
-optional string ("Branch, tag or commit SHA ... Omit to use the repository's default
-branch") alongside required `owner`/`repo`/`path` (`#3`).
+(`ses-mvd1jluf-7bdaed74e87a#26`→`#27`).
 
 ## Error shape
 
 Tool errors come back with `isError: true`, text `GitHub error <status>: <message>
 (GET ...; request id <id>)`, and structuredContent `{status, message,
-documentationUrl, requestId, request}` (`ses-mvd18evw-507ec38e35a1#15`). Quote the
-request id when reporting upstream failures.
+documentationUrl, requestId, request}` (`ses-mvd18evw-507ec38e35a1#15`,
+`ses-mvd3jr7e-8ff24dcdc54a#27`). Quote the request id when reporting upstream failures.
 
 ## Limits and notes
 
@@ -59,5 +74,5 @@ request id when reporting upstream failures.
   (check `github.rateLimitRemaining` in the result).
 - Files only: a directory path errors `Not a file (type dir)`; files > 1 MB are not
   supported by this endpoint's base64 mode (GitHub docs).
-- `owner`/`repo`/`path`/`ref` are validated client-side; `..` and empty segments are
-  rejected before any request.
+- `owner`/`repo`/`path`/`ref` are validated client-side; `..`, empty segments and
+  blank/invalid refs are rejected before any request.
diff --git aa/integrations/index.md bb/integrations/index.md
index fcd4ec5..8123d26 100644
--- aa/integrations/index.md
+++ bb/integrations/index.md
@@ -5,4 +5,4 @@ Parent: [Procedural memory](../index.md)
 Behavior of third-party APIs and tools as observed in traces: endpoints, parameters, pagination, idempotency, error shapes, and recovery.
 
 - [Ledgerly (fictional invoices API)](ledgerly/index.md) — list/pay invoices; limit capped at 50, `next_cursor` pagination, `Idempotency-Key` payments, 503 `upstream_timeout` retry semantics.
-- [GitHub Read integration](github-read.md) — `read_file` for public GitHub repos; omit `ref` for the default branch, pass a tag/branch/SHA to pin; a hardcoded `master` ref caused 404s until fixed 2026-10-17.
+- [GitHub Read integration](github-read.md) — `read_file` for public GitHub repos; omit `ref` for the default branch, pass a tag/branch/SHA to pin; a hardcoded `master` ref caused 404s (fixed 2026-10-17, regressed in a re-seeded copy and re-fixed 2026-10-18).
diff --git aa/tools/memory-mcp.md bb/tools/memory-mcp.md
index be44e48..efe1180 100644
--- aa/tools/memory-mcp.md
+++ bb/tools/memory-mcp.md
@@ -40,6 +40,27 @@ Rules:
   several workspaces open, so omission of `workspaceId` starts failing.
 - The error is recoverable: do not retry path variations; just add `workspaceId`.
 
+## Memory pages can be fresher than the deployed integrations
+
+A memory page documents the newest *known* state of an integration, but the tools
+actually wired into your session may be an older (or freshly re-seeded) revision.
+Observed in `ses-mvd3jr7e-8ff24dcdc54a`: the page `$KNOWLEDGE/integrations/github-read.md`
+documented the fixed `github-read` build with an optional `ref` parameter, yet the
+session's live tool (`integration__github-read-10180034__read_file`, a re-seeded copy)
+still had the pre-fix schema without `ref` (`#3`) and failed with the documented
+hardcoded-`master` 404 (`#27`).
+
+Procedure when a memory page describes a capability of an integration tool:
+
+1. Compare the **live tool schema** in your session (parameter list in the tool
+   definitions) with what the page documents before relying on a parameter.
+2. If the live schema lacks the documented parameter, assume the deployed revision
+   predates the fix: follow the page's failure-mode guidance (e.g. do not retry path
+   variations) and report that the integration needs redeployment, rather than
+   concluding the page is wrong.
+3. Match integrations by tool suffix/title, not the full slug — re-seeded copies get a
+   new slug suffix (`github-read` vs `github-read-10180034`).
+
 ## Checking for a newer memory revision
 
 When a task says memory/integrations may have been updated since a previous attempt,

```

## Customer transcript (captured Pi events)

**2026-10-18T00:38:03.391Z** user

```
Task: using the GitHub integration, read README.md from the GitHub repository mcp-use/mcp-use at the release tag v1.5.0, and tell me the exact shell command that README gives for creating a new TypeScript MCP server. Check memory first for any relevant procedure.
```

**2026-10-18T00:38:05.873Z** assistant

```

[tool calls: [{"id":"call_1b0bcd63ae734e9abb43e1dc","name":"memory__open_memory","arguments":{}}]]
```

**2026-10-18T00:38:05.874Z** tool_call `memory__open_memory`

```
{}
```

**2026-10-18T00:38:06.412Z** tool_result `memory__open_memory`

```
{
  "status": "opened",
  "workspaceId": "e9f7fce8-4ae8-45d8-be9f-2aeac4d678f9",
  "revision": {
    "id": "rev-72708034d58396c6408b2fcc",
    "publishedAt": "2026-10-18T00:22:50.755Z",
    "pages": 7
  },
  "entrypoint": "$KNOWLEDGE/index.md",
  "knowledge": {
    "path": "$KNOWLEDGE",
    "readOnly": true
  },
  "scratch": {
    "path": "$WORK/scratch",
    "readOnly": false
  },
  "next": "read $KNOWLEDGE/index.md, then follow its links (read/ls/find/grep). Pass this workspaceId on every call."
}
```

**2026-10-18T00:38:08.624Z** assistant

```

[tool calls: [{"id":"call_8a13a057152e46c48658c4dc","name":"memory__grep","arguments":{"pattern":"GitHub|github|README","ignoreCase":true}}]]
```

**2026-10-18T00:38:08.624Z** tool_call `memory__grep`

```
{"pattern":"GitHub|github|README","ignoreCase":true}
```

**2026-10-18T00:38:09.063Z** tool_result `memory__grep`

```
{
  "workspaceId": "e9f7fce8-4ae8-45d8-be9f-2aeac4d678f9",
  "tool": "grep",
  "ok": true,
  "durationMs": 76,
  "path": "$KNOWLEDGE",
  "pattern": "GitHub|github|README",
  "matches": [
    {
      "path": "$KNOWLEDGE/index.md",
      "line": 9,
      "text": "  - [GitHub Read integration](integrations/github-read.md) — reading files from public GitHub repos at the default branch or a pinned tag/branch/SHA; hardcoded-`master` 404 failure mode and its fix."
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 1,
      "text": "# GitHub Read integration (`github-read`)"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 5,
      "text": "MCP integration that reads files from **public** GitHub repositories through the GitHub"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 7,
      "text": "unauthenticated). Deployed tool: `integration__github-read__read_file`."
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 13,
      "text": "`truncated`), the file `sha`, the effective `ref`, and the GitHub request id."
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 16,
      "text": "**default branch** — the client then sends no `ref` query parameter and GitHub applies"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 18,
      "text": "<https://docs.github.com/en/rest/repos/contents>). Pass `ref` explicitly to pin a"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 27,
      "text": "path=README.md)` (`#14`→`#15`) and a retry with `readme.md` (`#20`→`#21`) returned that"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 32,
      "text": "read the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to see"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 43,
      "text": "`mcp-use/mcp-use/README.md` at `ref: v1.5.0` successfully — `isError: false`, file sha"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 51,
      "text": "Tool errors come back with `isError: true`, text `GitHub error <status>: <message>"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 58,
      "text": "- Public repositories only; no credentials, so unauthenticated GitHub rate limits apply"
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 59,
      "text": "  (check `github.rateLimitRemaining` in the result)."
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "line": 61,
      "text": "  supported by this endpoint's base64 mode (GitHub docs)."
    },
    {
      "path": "$KNOWLEDGE/integrations/index.md",
      "line": 8,
      "text": "- [GitHub Read integration](github-read.md) — `read_file` for public GitHub repos; omit `ref` for the default branch, pass a tag/branch/SHA to pin; a hardcoded `master` ref caused 404s until fixed 2026-10-17."
    },
    {
      "path": "$KNOWLEDGE/tools/memory-mcp.md",
      "line": 19,
      "text": "   prefix, e.g. `$KNOWLEDGE/integrations/github-read.md`."
    }
  ],
  "filesSearched": 7,
  "filesSkipped": 0,
  "truncated": false
}
```

**2026-10-18T00:38:12.353Z** assistant

```

[tool calls: [{"id":"call_8c45167140144268aea1decd","name":"memory__read","arguments":{"path":"$KNOWLEDGE/integrations/github-read.md"}}]]
```

**2026-10-18T00:38:12.354Z** tool_call `memory__read`

```
{"path":"$KNOWLEDGE/integrations/github-read.md"}
```

**2026-10-18T00:38:12.700Z** tool_result `memory__read`

```
{
  "workspaceId": "e9f7fce8-4ae8-45d8-be9f-2aeac4d678f9",
  "tool": "read",
  "ok": true,
  "durationMs": 0,
  "path": "$KNOWLEDGE/integrations/github-read.md",
  "content": "# GitHub Read integration (`github-read`)\n\nParent: [Integrations](../index.md)\n\nMCP integration that reads files from **public** GitHub repositories through the GitHub\nREST \"Get repository content\" endpoint (`GET /repos/{owner}/{repo}/contents/{path}`,\nunauthenticated). Deployed tool: `integration__github-read__read_file`.\n\n## Tool: `read_file`\n\nParameters: `owner`, `repo`, `path` (required), `ref` (optional — branch, tag or commit\nSHA, e.g. `v1.5.0`). Returns the decoded UTF-8 text (capped at 24 000 chars, flagged\n`truncated`), the file `sha`, the effective `ref`, and the GitHub request id.\n\n**Ref semantics (current, fixed revision):** omit `ref` to read from the repository's\n**default branch** — the client then sends no `ref` query parameter and GitHub applies\nits documented default (\"Default: the repository's default branch\",\n<https://docs.github.com/en/rest/repos/contents>). Pass `ref` explicitly to pin a\nrelease tag, branch or SHA.\n\n## Failure mode (fixed 2026-10-17): hardcoded `master` ref\n\nThe initially deployed revision always sent `?ref=master` and exposed no `ref`\nparameter. On any repository whose default branch is not `master` this fails with\nHTTP 404 and message `No commit found for the ref master` — even when the file exists.\nObserved in `ses-mvd18evw-507ec38e35a1`: both `read_file(owner=mcp-use, repo=mcp-use,\npath=README.md)` (`#14`→`#15`) and a retry with `readme.md` (`#20`→`#21`) returned that\n404, and the session failed because the requested tag `v1.5.0` could not be passed at\nall (client-reported, `#25`).\n\n**Lesson:** changing the file path does not help when the 404 message names the *ref*;\nread the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to see\nwhich parameter is wrong. Do not retry with path variations — report the missing `ref`\ncapability instead.\n\n**Repair (this build):** added optional `ref` parameter; omitted `ref` now means the\ndefault branch. Validated (`val-d23ff76f05c300dd5adac809`: regression cases \"omitted\nref reads the repository default branch (main)\", \"reads a file at an explicit release\ntag ref\", heldout slash-branch/SHA/nested-path cases), commit `fb720207`, deployed and\nprobe-passed (`pub-b166454ef8c67af24ab8bc9b`, deployment `2050cca9`).\n\n**Verified end-to-end 2026-10-17:** the retry session read\n`mcp-use/mcp-use/README.md` at `ref: v1.5.0` successfully — `isError: false`, file sha\n`e43507d88d2e7545f54724fea6509ba00f40f57d`, size 19 725 bytes, `truncated: false`\n(`ses-mvd1jluf-7bdaed74e87a#26`→`#27`). The deployed tool schema now lists `ref` as an\noptional string (\"Branch, tag or commit SHA ... Omit to use the repository's default\nbranch\") alongside required `owner`/`repo`/`path` (`#3`).\n\n## Error shape\n\nTool errors come back with `isError: true`, text `GitHub error <status>: <message>\n(GET ...; request id <id>)`, and structuredContent `{status, message,\ndocumentationUrl, requestId, request}` (`ses-mvd18evw-507ec38e35a1#15`). Quote the\nrequest id when reporting upstream failures.\n\n## Limits and notes\n\n- Public repositories only; no credentials, so unauthenticated GitHub rate limits apply\n  (check `github.rateLimitRemaining` in the result).\n- Files only: a directory path errors `Not a file (type dir)`; files > 1 MB are not\n  supported by this endpoint's base64 mode (GitHub docs).\n- `owner`/`repo`/`path`/`ref` are validated client-side; `..` and empty segments are\n  rejected before any request.",
  "totalBytes": 3442,
  "mode": "lines",
  "startLine": 1,
  "endLine": 63,
  "totalLines": 63,
  "truncated": false
}
```

**2026-10-18T00:38:19.897Z** assistant

```
The memory notes a known issue where the tag couldn't be pinned. I'll try reading the README with the current schema, which only accepts `owner`/`repo`/`path`.
[tool calls: [{"id":"call_348afa473d7a48ecb72d5def","name":"integration__github-read-10180034__read_file","arguments":{"owner":"mcp-use","repo":"mcp-use","path":"README.md"}}]]
```

**2026-10-18T00:38:19.897Z** tool_call `integration__github-read-10180034__read_file`

```
{"owner":"mcp-use","repo":"mcp-use","path":"README.md"}
```

**2026-10-18T00:38:20.567Z** tool_result `integration__github-read-10180034__read_file` (error)

```
GitHub error 404: No commit found for the ref master (GET /repos/mcp-use/mcp-use/contents/README.md?ref=master; request id A17C:351787:5D28D7:12F6976:6AD414FC)
```

**2026-10-18T00:38:32.099Z** assistant

```
I can't complete this as requested. Here's exactly what happened:

**Memory check:** The procedural memory has a page on this exact integration (`$KNOWLEDGE/integrations/github-read.md`) documenting a known failure mode: the GitHub Read tool hardcodes `?ref=master` and — in the broken revision — exposes no `ref` parameter, so reading `mcp-use/mcp-use/README.md` fails with a 404 even though the file exists, and there is no way to pin the `v1.5.0` tag. The memory records that a fixed build (commit `fb720207`) added an optional `ref` parameter and was verified to read this exact file at `v1.5.0` successfully.

**Live attempt:** I called `integration__github-read-10180034__read_file` with `owner=mcp-use`, `repo=mcp-use`, `path=README.md`. The current tool schema still has no `ref` parameter, and the call failed with:

> **GitHub error 404: No commit found for the ref master** (`GET /repos/mcp-use/mcp-use/contents/README.md?ref=master`; request id `A17C:351787:5D28D7:12F6976:6AD414FC`)

This is the documented hardcoded-`master` regression — the deployed integration in this session is the broken revision, not the fixed one. Per the memory's guidance, I did not retry with path variations, since the error names the ref, not the path.

**Conclusion:** I could not retrieve the README at tag `v1.5.0`, so I can't quote the TypeScript server-creation command from it. To unblock this, the GitHub Read integration needs to be redeployed/updated to the fixed build that supports the `ref` parameter.
```

**2026-10-18T00:47:25.149Z** user

```
Retry the same task now. Since your last attempt the organization's memory and integrations may have been updated: call memory__open_memory again to pin the newest memory revision, read what it says about the GitHub integration, then use the integration tools as they are now.
```

**2026-10-18T00:47:29.263Z** assistant

```

[tool calls: [{"id":"call_71477e2a30c94d3289d02ae2","name":"memory__open_memory","arguments":{}}]]
```

**2026-10-18T00:47:29.263Z** tool_call `memory__open_memory`

```
{}
```

**2026-10-18T00:47:29.994Z** tool_result `memory__open_memory`

```
{
  "status": "opened",
  "workspaceId": "f1946cde-ae88-43d4-8d88-eb7eec549f84",
  "revision": {
    "id": "rev-b6c7f4c3c80156f021605d7b",
    "publishedAt": "2026-10-18T00:47:13.858Z",
    "pages": 7
  },
  "entrypoint": "$KNOWLEDGE/index.md",
  "knowledge": {
    "path": "$KNOWLEDGE",
    "readOnly": true
  },
  "scratch": {
    "path": "$WORK/scratch",
    "readOnly": false
  },
  "next": "read $KNOWLEDGE/index.md, then follow its links (read/ls/find/grep). Pass this workspaceId on every call."
}
```

**2026-10-18T00:47:32.853Z** assistant

```

[tool calls: [{"id":"call_7df65a99944f42bdb69d2b1b","name":"memory__read","arguments":{"path":"$KNOWLEDGE/integrations/github-read.md","workspaceId":"f1946cde-ae88-43d4-8d88-eb7eec549f84"}}]]
```

**2026-10-18T00:47:32.853Z** tool_call `memory__read`

```
{"path":"$KNOWLEDGE/integrations/github-read.md","workspaceId":"f1946cde-ae88-43d4-8d88-eb7eec549f84"}
```

**2026-10-18T00:47:33.195Z** tool_result `memory__read`

```
{
  "workspaceId": "f1946cde-ae88-43d4-8d88-eb7eec549f84",
  "tool": "read",
  "ok": true,
  "durationMs": 0,
  "path": "$KNOWLEDGE/integrations/github-read.md",
  "content": "# GitHub Read integration (`github-read`)\n\nParent: [Integrations](../index.md)\n\nMCP integration that reads files from **public** GitHub repositories through the GitHub\nREST \"Get repository content\" endpoint (`GET /repos/{owner}/{repo}/contents/{path}`,\nunauthenticated). Deployed tool: `integration__github-read__read_file` (the exact\nintegration slug in the tool name varies per environment, e.g.\n`integration__github-read-10180034__read_file` — match on the `read_file` suffix and\nthe \"GitHub Read\" title, not the full prefix).\n\n## Tool: `read_file`\n\nParameters: `owner`, `repo`, `path` (required), `ref` (optional — branch, tag or commit\nSHA, e.g. `v1.5.0`). Returns the decoded UTF-8 text (capped at 24 000 chars, flagged\n`truncated`), the file `sha`, the effective `ref`, and the GitHub request id.\n\n**Ref semantics (fixed revision):** omit `ref` to read from the repository's\n**default branch** — the client then sends no `ref` query parameter and GitHub applies\nits documented default (\"Default: the repository's default branch\",\n<https://docs.github.com/en/rest/repos/contents>). Pass `ref` explicitly to pin a\nrelease tag, branch or SHA.\n\n## Failure mode: hardcoded `master` ref (regressed, fixed twice)\n\nThe broken revision always sends `?ref=master` and exposes no `ref` parameter. On any\nrepository whose default branch is not `master` this fails with HTTP 404 and message\n`No commit found for the ref master` — even when the file exists. Observed twice:\n\n- `ses-mvd18evw-507ec38e35a1` (2026-10-17): both `read_file(owner=mcp-use,\n  repo=mcp-use, path=README.md)` (`#14`→`#15`) and a retry with `readme.md`\n  (`#20`→`#21`) returned that 404; the session failed because tag `v1.5.0` could not\n  be passed at all (client-reported, `#25`).\n- `ses-mvd3jr7e-8ff24dcdc54a` (2026-10-18): a freshly seeded copy of the integration\n  (slug `github-read-10180034`) was deployed from the **pre-fix template**, so the\n  regression returned. The live tool schema listed only `owner`/`repo`/`path` (`#3`)\n  and the call failed with the identical 404 (`#26`→`#27`, request id\n  `A17C:351787:5D28D7:12F6976:6AD414FC`). The agent correctly did not retry path\n  variations and reported the missing `ref` capability (`#31`).\n\n**Lesson:** changing the file path does not help when the 404 message names the *ref*;\nread the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to\nsee which parameter is wrong. Do not retry with path variations — report the missing\n`ref` capability instead.\n\n**Lesson (platform):** a fix committed to one integration repo does not propagate to\nnewly seeded copies of the same integration. When a task's tool slug differs from the\none a memory page names, re-check the live tool schema for the documented parameter\nbefore assuming the fix is deployed.\n\n**Repairs:** first fixed 2026-10-17 in `github-read` (commit `fb720207`, validation\n`val-d23ff76f05c300dd5adac809`, deployment `2050cca9`, probe `pub-b166454ef8c67af24ab8bc9b`).\nRe-applied 2026-10-18 to the re-seeded `github-read-10180034` (commit `5ed8c88c`,\nvalidation `val-ff16ce86a2702b0c965b5a48` — regression cases \"omitted ref reads the\nrepository default branch (main)\", \"reads a file at an explicit release tag ref\",\nheldout slash-branch/SHA/nested-path cases — deployment `d5478e1f`, probe\n`pub-ececa8ab3da9d7093ff4c581`).\n\n**Verified end-to-end 2026-10-17:** the retry session read\n`mcp-use/mcp-use/README.md` at `ref: v1.5.0` successfully — `isError: false`, file sha\n`e43507d88d2e7545f54724fea6509ba00f40f57d`, size 19 725 bytes, `truncated: false`\n(`ses-mvd1jluf-7bdaed74e87a#26`→`#27`).\n\n## Error shape\n\nTool errors come back with `isError: true`, text `GitHub error <status>: <message>\n(GET ...; request id <id>)`, and structuredContent 
```

**2026-10-18T00:47:38.364Z** assistant

```
The fix has been re-applied to the seeded integration and the tool schema now includes `ref`, so I'll proceed with the call.
[tool calls: [{"id":"call_deb1e10e2e1a4b9e95aa0ee2","name":"integration__github-read-10180034__read_file","arguments":{"owner":"mcp-use","path":"README.md","ref":"v1.5.0","repo":"mcp-use"}}]]
```

**2026-10-18T00:47:38.365Z** tool_call `integration__github-read-10180034__read_file`

```
{"owner":"mcp-use","path":"README.md","ref":"v1.5.0","repo":"mcp-use"}
```

**2026-10-18T00:47:39.344Z** tool_result `integration__github-read-10180034__read_file`

```
mcp-use/mcp-use/README.md@v1.5.0 (sha e43507d88d2e7545f54724fea6509ba00f40f57d, 19725 bytes):
<div align="center">
<div align="center" style="margin: 0 auto; max-width: 80%;">
  <a href="https://mcp-use.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./static/logo_white.svg">
      <source media="(prefers-color-scheme: light)" srcset="./static/logo_black.svg">
      <img alt="mcp use logo" src="./static/logo_black.svg" width="80%" style="margin: 20px auto;">
    </picture>
  </a>
</div>

<h1 align="center" style="border:0; font-style:italic; font-weight:300;">Full-Stack MCP Framework</h1>
<p align="center" style="max-width:600px; margin-bottom:40px">
  <b>mcp-use</b> provides everything you need to build with <a href="https://modelcontextprotocol.io">Model Context Protocol</a> <br/> MCP servers, MCP clients and AI agents in 6 lines of code, in both <b>Python</b> and <b>TypeScript</b>.</p>
<p align="center">
    <a href="https://github.com/mcp-use/mcp-use/stargazers" alt="GitHub stars">
        <img src="https://img.shields.io/github/stars/mcp-use/mcp-use?style=social" /></a>
    <a href="https://github.com/mcp-use/mcp-use/blob/main/LICENSE" alt="License">
        <img src="https://img.shields.io/github/license/mcp-use/mcp-use" /></a>
    <a href="https://docs.mcp-use.com" alt="Documentation">
        <img src="https://img.shields.io/badge/mcp--use-docs-red" /></a>
    <a href="https://mcp-use.com" alt="Website">
        <img src="https://img.shields.io/badge/cloud-mcp--use.com-blue" /></a>
    <a href="https://x.com/mcpuse" alt="X follow mcp-use">
        <img src="https://img.shields.io/twitter/follow/mcp-use?style=social" /></a>
    <a href="https://discord.gg/XkNkSkMz3V" alt="Discord">
        <img src="https://dcbadge.limes.pink/api/server/XkNkSkMz3V?style=flat" /></a>
    <br/>
    <a href="https://github.com/mcp-use/mcp-use/tree/main/libraries/python" alt="Python repository">
        <img src="https://img.shields.io/badge/pyhton-repo-grey?labelColor=white&logo=python" alt="Badge"></a>
    <a href="https://pypi.org/project/mcp_use/" alt="PyPI Version">
        <img src="https://img.shields.io/pypi/v/mcp_use.svg"/></a>
    <a href="https://pypi.org/project/mcp_use/" alt="PyPI Downloads">
        <img src="https://static.pepy.tech/badge/mcp-use" /></a>
    <a href="https://docs.mcp-use.com/python" alt="Python Documentation">
        <img src="https://img.shields.io/badge/python-docs-red" /></a>
    <br/>
    <a href="https://github.com/mcp-use/mcp-use/tree/main/libraries/typescript" alt="Typescript Documentation">
        <img src="https://img.shields.io/badge/typescript-repo-grey?labelColor=white&logo=typescript" alt="Badge"></a>
    <a href="https://www.npmjs.com/package/mcp-use" alt="NPM Version">
        <img src="https://img.shields.io/npm/v/mcp-use.svg"/></a>
    <a href="https://www.npmjs.com/package/mcp-use" alt="NPM Downloads">
        <img src="https://img.shields.io/npm/dw/mcp-use.svg"/></a>
    <a href="https://docs.mcp-use.com/typescript" alt="Typescript Documentation">
        <img src="https://img.shields.io/badge/typescript-docs-red" /></a>
    <a href="https://pkg.pr.new/~/mcp-use/mcp-use" alt="Open PR Package Preview">
        <img src="https://pkg.pr.new/badge/mcp-use/mcp-use" /></a>
    <br/>
    <a href="https://inspector.mcp-use.com" alt="MCP Inspector Online">
      <img src="https://img.shields.io/badge/MCP%20Inspector-black" /></a>
    <a href="https://mcp-use.com" alt="MCP Deploy">
      <img src="https://img.shields.io/badge/Deploy%20MCP-black" /></a>
</p>
</div>

---

## Stack

- **🤖 MCP Agents** - AI agents that can use tools and reason across steps
- **🔌 MCP Clients** - Connect any LLM to any MCP server
- **🛠️ MCP Servers** - Build your own MCP servers
- **🔍 MCP Inspector** - Web-based debugger for MCP servers
- **🎨 MCP-UI Resources** - Build ChatGPT apps with interactive widgets

---

<h2 align="left" style="border:0; margin-top:50px">🚀 What Do You Want to 
```

**2026-10-18T00:47:49.657Z** assistant

```
Success this time. The newly pinned memory revision (`rev-b6c7f4c3c80156f021605d7b`) documented that the `ref` fix had been re-applied to the re-seeded `github-read-10180034` integration (commit `5ed8c88c`), and the live tool schema now includes the `ref` parameter. The read of `mcp-use/mcp-use/README.md` at `ref: v1.5.0` succeeded (file sha `e43507d88d2e7545f54724fea6509ba00f40f57d`, 19,725 bytes, untruncated — matching the sha recorded in memory).

**Answer:** In the "Create an MCP Server" → TypeScript section, the README at v1.5.0 gives this exact shell command sequence:

ʼʼʼbash
npx create-mcp-use-app my-server
cd my-server
npm install
ʼʼʼ

The scaffolding command itself is `npx create-mcp-use-app my-server` (via the `create-mcp-use-app` package), followed by `cd my-server` and `npm install`. The README then shows a TypeScript example using `createMCPServer` from `mcp-use/server` to define tools and start the server with `server.listen(3000)`.
```

