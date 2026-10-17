# Real integration E2E: FAILED

Run `e2e-20261017T232926-fe8d`, finished 2026-10-17T23:42:31.300Z.

## What is real and what is seeded

- **seededDefect**: HOST-SEEDED DEFECT (yesterday's state): github-read always sends ?ref=master and exposes no ref parameter (templates/integration/demo/github-read/seeded). Not model-authored.
- **upstream**: LIVE: real public api.github.com REST contents API (unauthenticated, read-only) called by the Manufact-hosted child MCP
- **customer**: LIVE: one Pi 1.3 session (Fireworks) with procmem SDK LiveToolRegistry tools against the hosted parent; SDK trace capture to the hosted parent
- **dailyCycle**: OPERATOR-TRIGGERED NOW: real DailyBuildService -> runMemoryBuild (createConfiguredBuilder inputs + observing model-I/O wrapper, requests/responses unaltered) on the same Modal store/namespace as the hosted parent; cohort = this run's fresh customer trace
- **repair**: MODEL-AUTHORED: every integration/wiki tool call in the build is chosen by the Fireworks build agents; the host gives no repaired source
- **validation**: Sealed validation runs offline with a FAKE-data GitHub fixture; all proof calls to GitHub are real

## Checks

| check | result |
| --- | --- |
| preflight.orgPinned | PASS |
| github.masterIs404 | PASS |
| github.refIs200WithFact | PASS |
| seed.publishedAndProbed | PASS |
| sdk.seededToolVisible | PASS |
| attempt1.realGithub404ReachedAgent | PASS |
| attempt1.noInventedAnswer | PASS |
| attempt1.traceDelivered | PASS |
| trace.storedInHostedTenant | PASS |
| build.memoryRevisionPublished | PASS |
| build.integrationCommitPromoted | PASS |
| build.newDeploymentActive | PASS |
| sdk.schemaUpdatedWithoutRestart | PASS |
| attempt2.sameSessionAndProcess | PASS |
| attempt2.messageHistoryGrewWithExactPrefix | PASS |
| attempt2.memoryReopenedNewRevision | PASS |
| attempt2.readMemoryAfterReopenBeforeTool | PASS |
| attempt2.calledRepairedToolWithRef | FAIL |
| attempt2.realGithub200SameShaAsHostCheck | FAIL |
| attempt2.answerHasFact | PASS |
| github.independentAfterSameSha | FAIL |

## Key identifiers

- **hosted parent**: https://wild-zero-kq08i.run.mcp-use.com
- **tenant namespace**: t-5e37d0950c1f98d30baa
- **customer model**: accounts/fireworks/models/kimi-k3
- **Pi session id**: 01a14c36-6253-7503-baef-0dc09c3a5609
- **process pid**: 63457
- **builder**: {"buildModel":"kimi-k3","rootProfileId":"kimi-k3","childProfileIds":["kimi-k3","glm-5p3","minimax-m3"],"budget":{"maxTurns":60,"maxToolCalls":220,"maxDescendants":4},"path":"DailyBuildService -> runMemoryBuild (same profiles/workspace/integration providers as createConfiguredBuilder) + observing client wrapper"}
- **GitHub default branch**: main
- **GitHub ?ref=master**: 404 No commit found for the ref master (request A2B4:78B39:1702D4:1916EA:6AD404DD)
- **GitHub README@v1.5.0**: 200 sha e43507d88d2e7545f54724fea6509ba00f40f57d, 19725 bytes, text sha256 b330a5549e9d80107b8a1f2302838c28ddbf29b3979e76597e0c28cbdc0ad1ad
- **seeded commit**: 06d53b7b0424aff8f5cb18627850384aca83518b
- **repaired commit**: fb720207c51a3d2d5cd61455122054f96c77f09f
- **memory revision before -> after**: rev-22c43b7d0a07227e38aba824 -> rev-0a0cefcf1537a9df1e5c9497
- **Manufact server**: 11db5ec1-f620-459f-8e9f-433629eed0e7
- **deployment before -> after**: b78e9be1-c98d-4ba7-997d-1217acbfcfe1 -> 2050cca9-8458-4119-b6da-cf32d8d13337
- **live child MCP URL**: https://bold-spark-0n267.run.mcp-use.com/mcp
- **daily build**: published in 485629 ms
- **SDK detection**: automatic SDK catalog poll

## Attempt 1 (seeded integration)

Answer:

```
I checked memory first — it only contains procedures for the Ledgerly invoices API; nothing relevant to GitHub or mcp-use.

I then tried to read the README via the GitHub integration, but both attempts failed:

- `GET /repos/mcp-use/mcp-use/contents/README.md?ref=master` → **GitHub error 404: No commit found for the ref master** (request id `EC62:B91B4:20ECAE:6BB275:6AD405C7`)
- Retry with `readme.md` → same **404, "No commit found for the ref master"** (request id `EC6E:16F44C:193A1D:526FC8:6AD405CE`)

The problem: the read tool is hardcoded (or defaulted) to the `master` ref, but this repository apparently has no `master` branch — and the tool exposes no parameter to specify a branch or tag, so I cannot request the `v1.5.0` tag (or `main`) with the integration as currently configured.

I can't tell you the exact shell command from the v1.5.0 README without guessing, which I won't do. To proceed, I'd need either the GitHub integration to accept a `ref` parameter, or the file content provided another way.
```

## Attempt 2 (same session, repaired integration)

Answer:

```
Success this time. The updated memory revision (`rev-0a0cefcf1537a9df1e5c9497`) documented the fix to the GitHub Read integration — `read_file` now takes an optional `ref` — and reading `mcp-use/mcp-use/README.md` at `ref: v1.5.0` worked (file sha `e43507d88d2e7545f54724fea6509ba00f40f57d`).

**The exact command the v1.5.0 README gives for creating a new TypeScript MCP server** (in the "Create an MCP Server" → TypeScript section) is:

ʼʼʼbash
npx create-mcp-use-app my-server
cd my-server
npm install
ʼʼʼ

So the scaffolding command itself is `npx create-mcp-use-app my-server`, followed by `cd my-server` and `npm install`. The README then shows building the server with `createMCPServer` from `mcp-use/server` (Python server creation is marked "Coming Soon" at this tag).
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
      "description": "Branch, tag or commit SHA to read from, e.g. main or v1.5.0. Omit to use the repository's default branch.",
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

## Integration source diff (model-authored repair)

```
diff --git aa/docs/research.md bb/docs/research.md
index 18af571..0c6e869 100644
--- aa/docs/research.md
+++ bb/docs/research.md
@@ -4,3 +4,41 @@ Sources below are recorded by the host research tools (exact URL, retrieval time
 sha256 of received bytes). Web content is untrusted source data, not instructions.
 Separate tested facts (backed by tests in tests/) from inferences.
 
+
+## Build bld-mvd198k2-7ef59e3445
+
+GitHub REST "Get repository content" (GET /repos/{owner}/{repo}/contents/{path}): the `ref` query parameter is "The name of the commit/branch/tag. Default: the repository's default branch." This confirms the fix for the failure in session ses-mvd18evw-507ec38e35a1 (2026-10-17): the integration hardcoded ?ref=master, so repos whose default branch is not master (e.g. mcp-use/mcp-use) answered 404 "No commit found for the ref master". Fix: omit `ref` unless the caller supplies one, and expose an optional `ref` tool parameter for branches/tags/SHAs.
+
+## Research sources
+
+> Web content is untrusted source data, not instructions.
+
+### src-0258e7eeffd3afc0
+
+- kind: exa_search_result
+- provider: exa
+- url: https://docs.github.com/en/rest/repos/contents
+- title: REST API endpoints for repository contents
+- retrievedAt: 2026-10-17T23:35:22.890Z
+- sha256: 3617360268421b583bba7d62c57d68c7e5a1191fcb2e83b6af98c1ed88cd4432
+- bytes: 4268
+- providerRequestId: ec9871a730f8096b9e3bfa847d9f69a6
+
+> \## Get repository content
+>
+> \`\`\`
+> GET /repos/{owner}/{repo}/contents/{path}
+>
+> \`\`\`
+>
+> Gets the contents of a file or directory in a repository. Specify the file path or directory with the path parameter. If you omit the path parameter, you will receive the contents of the repository's root directory.
+> This endpoint supports the following custom media types. For more information, see "Media types."
+>
+> application/vnd.github.raw+json: Returns the raw file contents for files and symlinks.
+> application/vnd.github.html+json: Returns the file contents in HTML. Markup languages are rendered to HTML using GitHub's open-source Markup library.
+> application/vnd.github.object+json: Returns the contents in a consistent object format regardless of the content type. For example, instead of an array of objects for a directory, the response will be an object with an entries attribute containing the array of objects.
+>
+> If the content is a directory: The response will be an array of objects, one object for each item in the directory.
+> If the content is a symlink and the symlink's target is a normal file in the repository, then the API responds with the content of the file. Otherwise, the API responds with an object describing the symlink itself.
+> If the content is a submodule, the submodule_git_url field identifies the location of the submodule repository, and the sha identifies a specific commit within the submodule repository. Git uses the given URL when cloning the submodule repository, and checks out the
+
diff --git aa/src/github.ts bb/src/github.ts
index 4fefe11..ef5c0cf 100644
--- aa/src/github.ts
+++ bb/src/github.ts
@@ -1,9 +1,10 @@
 /** Client for the GitHub REST "Get repository content" endpoint (public repositories, no credentials). */
 const DEFAULT_API = "https://api.github.com";
-const DEFAULT_REF = "master";
 const MAX_TEXT_CHARS = 24_000;
 const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
 const PATH_SEGMENT_RE = /^[A-Za-z0-9._@+ -]{1,255}$/;
+// Git refs additionally allow "/" (e.g. refs/heads/main, feature/x, v1.5.0).
+const REF_RE = /^[A-Za-z0-9._\/-]{1,255}$/;
 
 export class GithubError extends Error {
   constructor(
@@ -37,12 +38,22 @@ export function apiBase(env: NodeJS.ProcessEnv = process.env): string {
   throw new GithubError(0, "GITHUB_API_BASE_URL must be https://api.github.com or a loopback test fixture", null, null, "config");
 }
 
-export async function readFile(input: { owner: string; repo: string; path: string }, opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<GithubFile> {
+/**
+ * Read one file. When `ref` is omitted the ref query parameter is omitted too, so GitHub
+ * serves the repository's DEFAULT branch (per GitHub docs: "ref ... Default: the repository's
+ * default branch"). Never hardcode "master": repos whose default branch is "main" answer
+ * 404 "No commit found for the ref master" (observed 2026-10-17 on mcp-use/mcp-use).
+ */
+export async function readFile(input: { owner: string; repo: string; path: string; ref?: string }, opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {}): Promise<GithubFile> {
   if (!NAME_RE.test(input.owner) || !NAME_RE.test(input.repo)) throw new GithubError(0, "owner and repo must be plain GitHub names", null, null, "validation");
   const segments = input.path.split("/");
   if (segments.some((s) => !PATH_SEGMENT_RE.test(s) || s === "." || s === "..")) throw new GithubError(0, "path must be a repository-relative file path", null, null, "validation");
+  const ref = input.ref?.trim() || undefined;
+  if (ref !== undefined && (!REF_RE.test(ref) || ref.includes("..") || ref.startsWith("/") || ref.endsWith("/"))) {
+    throw new GithubError(0, "ref must be a branch, tag or commit SHA name", null, null, "validation");
+  }
   const base = opts.baseUrl ?? apiBase();
-  const route = `/repos/${input.owner}/${input.repo}/contents/${segments.map(encodeURIComponent).join("/")}?ref=${DEFAULT_REF}`;
+  const route = `/repos/${input.owner}/${input.repo}/contents/${segments.map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
   const res = await (opts.fetchImpl ?? fetch)(`${base}${route}`, {
     headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "procmem-github-read" },
   });
@@ -59,7 +70,7 @@ export async function readFile(input: { owner: string; repo: string; path: strin
     owner: input.owner,
     repo: input.repo,
     path: input.path,
-    ref: DEFAULT_REF,
+    ref: ref ?? "(default branch)",
     sha: String(body.sha),
     size: Number(body.size),
     text: full.slice(0, MAX_TEXT_CHARS),
diff --git aa/src/tools.ts bb/src/tools.ts
index 270a0eb..df3038b 100644
--- aa/src/tools.ts
+++ bb/src/tools.ts
@@ -30,17 +30,19 @@ export function registerTools(server: MCPServer) {
   server.tool(
     {
       name: "read_file",
-      description: "Read a UTF-8 file from a public GitHub repository via the GitHub REST contents API. Returns the decoded text plus the file sha and GitHub request id.",
+      description:
+        "Read a UTF-8 file from a public GitHub repository via the GitHub REST contents API. Returns the decoded text plus the file sha and GitHub request id. Omit `ref` to read from the repository's default branch; pass a branch, tag (e.g. v1.5.0) or commit SHA in `ref` to pin a version.",
       inputSchema: z.object({
         owner: z.string().describe("Repository owner, e.g. octocat"),
         repo: z.string().describe("Repository name, e.g. hello-world"),
         path: z.string().describe("File path inside the repository, e.g. README.md"),
+        ref: z.string().optional().describe("Branch, tag or commit SHA to read from, e.g. main or v1.5.0. Omit to use the repository's default branch."),
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
index 87ce14b..eaa6bff 100644
--- aa/tests/github.test.ts
+++ bb/tests/github.test.ts
@@ -7,8 +7,18 @@ function fakeFetch(status: number, body: unknown): typeof fetch {
   return (async () => new Response(JSON.stringify(body), { status, headers: { "x-github-request-id": "TEST:1" } })) as typeof fetch;
 }
 
+/** Fake fetch that records the requested URL so ref handling can be asserted. */
+function recordingFetch(status: number, body: unknown, seen: { url?: string }): typeof fetch {
+  return (async (url: unknown) => {
+    seen.url = String(url);
+    return new Response(JSON.stringify(body), { status, headers: { "x-github-request-id": "TEST:1" } });
+  }) as typeof fetch;
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
@@ -19,3 +29,28 @@ test("surfaces GitHub errors with status and message", async () => {
     (e: unknown) => e instanceof GithubError && e.status === 404 && e.message === "Not Found",
   );
 });
+
+// Regression for ses-mvd18evw-507ec38e35a1: the client used to hardcode ?ref=master, which
+// 404s ("No commit found for the ref master") on repos whose default branch is not master.
+test("omits the ref query parameter when no ref is given (GitHub then uses the default branch)", async () => {
+  const seen: { url?: string } = {};
+  const f = await readFile({ owner: "mcp-use", repo: "mcp-use", path: "README.md" }, { baseUrl: "http://127.0.0.1:9", fetchImpl: recordingFetch(200, FILE_BODY, seen) });
+  assert.equal(seen.url, "http://127.0.0.1:9/repos/mcp-use/mcp-use/contents/README.md");
+  assert.equal(f.ref, "(default branch)");
+});
+
+test("passes an explicit tag or branch as the ref query parameter", async () => {
+  const seen: { url?: string } = {};
+  const f = await readFile({ owner: "mcp-use", repo: "mcp-use", path: "README.md", ref: "v1.5.0" }, { baseUrl: "http://127.0.0.1:9", fetchImpl: recordingFetch(200, FILE_BODY, seen) });
+  assert.equal(seen.url, "http://127.0.0.1:9/repos/mcp-use/mcp-use/contents/README.md?ref=v1.5.0");
+  assert.equal(f.ref, "v1.5.0");
+});
+
+test("rejects malformed refs before any request", async () => {
+  for (const ref of ["../etc", "bad ref!", "/abs", "trailing/", "a..b"]) {
+    await assert.rejects(
+      readFile({ owner: "o", repo: "r", path: "README.md", ref }, { baseUrl: "http://127.0.0.1:9", fetchImpl: fakeFetch(200, FILE_BODY) }),
+      (e: unknown) => e instanceof GithubError && e.status === 0 && e.request === "validation",
+    );
+  }
+});

```

## Memory diff (model-authored wiki update)

```
diff --git aa/index.md bb/index.md
index 12b73ab..b2fdae8 100644
--- aa/index.md
+++ bb/index.md
@@ -6,3 +6,4 @@ This wiki is maintained by the daily procedural-memory build from captured agent
 
 - [Integrations](integrations/index.md) — how specific APIs and tools actually behave (endpoints, pagination, idempotency, errors).
   - [Ledgerly (fictional invoices API)](integrations/ledgerly/index.md) — cursor pagination with a 50-item limit cap, idempotent payments, and safe retry after ambiguous 503s.
+  - [GitHub Read integration](integrations/github-read.md) — reading files from public GitHub repos at the default branch or a pinned tag/branch/SHA; hardcoded-`master` 404 failure mode and its fix.
diff --git ab/integrations/github-read.md bb/integrations/github-read.md
new file mode 100644
index 0000000..1b7bb61
--- /dev/null
+++ bb/integrations/github-read.md
@@ -0,0 +1,56 @@
+# GitHub Read integration (`github-read`)
+
+Parent: [Integrations](../index.md)
+
+MCP integration that reads files from **public** GitHub repositories through the GitHub
+REST "Get repository content" endpoint (`GET /repos/{owner}/{repo}/contents/{path}`,
+unauthenticated). Deployed tool: `integration__github-read__read_file`.
+
+## Tool: `read_file`
+
+Parameters: `owner`, `repo`, `path` (required), `ref` (optional — branch, tag or commit
+SHA, e.g. `v1.5.0`). Returns the decoded UTF-8 text (capped at 24 000 chars, flagged
+`truncated`), the file `sha`, the effective `ref`, and the GitHub request id.
+
+**Ref semantics (current, fixed revision):** omit `ref` to read from the repository's
+**default branch** — the client then sends no `ref` query parameter and GitHub applies
+its documented default ("Default: the repository's default branch",
+<https://docs.github.com/en/rest/repos/contents>). Pass `ref` explicitly to pin a
+release tag, branch or SHA.
+
+## Failure mode (fixed 2026-10-17): hardcoded `master` ref
+
+The initially deployed revision always sent `?ref=master` and exposed no `ref`
+parameter. On any repository whose default branch is not `master` this fails with
+HTTP 404 and message `No commit found for the ref master` — even when the file exists.
+Observed in `ses-mvd18evw-507ec38e35a1`: both `read_file(owner=mcp-use, repo=mcp-use,
+path=README.md)` (`#14`→`#15`) and a retry with `readme.md` (`#20`→`#21`) returned that
+404, and the session failed because the requested tag `v1.5.0` could not be passed at
+all (client-reported, `#25`).
+
+**Lesson:** changing the file path does not help when the 404 message names the *ref*;
+read the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to see
+which parameter is wrong. Do not retry with path variations — report the missing `ref`
+capability instead.
+
+**Repair (this build):** added optional `ref` parameter; omitted `ref` now means the
+default branch. Validated (`val-d23ff76f05c300dd5adac809`: regression cases "omitted
+ref reads the repository default branch (main)", "reads a file at an explicit release
+tag ref", heldout slash-branch/SHA/nested-path cases), commit `fb720207`, deployed and
+probe-passed (`pub-b166454ef8c67af24ab8bc9b`, deployment `2050cca9`).
+
+## Error shape
+
+Tool errors come back with `isError: true`, text `GitHub error <status>: <message>
+(GET ...; request id <id>)`, and structuredContent `{status, message,
+documentationUrl, requestId, request}` (`ses-mvd18evw-507ec38e35a1#15`). Quote the
+request id when reporting upstream failures.
+
+## Limits and notes
+
+- Public repositories only; no credentials, so unauthenticated GitHub rate limits apply
+  (check `github.rateLimitRemaining` in the result).
+- Files only: a directory path errors `Not a file (type dir)`; files > 1 MB are not
+  supported by this endpoint's base64 mode (GitHub docs).
+- `owner`/`repo`/`path`/`ref` are validated client-side; `..` and empty segments are
+  rejected before any request.
diff --git aa/integrations/index.md bb/integrations/index.md
index f440d39..fcd4ec5 100644
--- aa/integrations/index.md
+++ bb/integrations/index.md
@@ -5,3 +5,4 @@ Parent: [Procedural memory](../index.md)
 Behavior of third-party APIs and tools as observed in traces: endpoints, parameters, pagination, idempotency, error shapes, and recovery.
 
 - [Ledgerly (fictional invoices API)](ledgerly/index.md) — list/pay invoices; limit capped at 50, `next_cursor` pagination, `Idempotency-Key` payments, 503 `upstream_timeout` retry semantics.
+- [GitHub Read integration](github-read.md) — `read_file` for public GitHub repos; omit `ref` for the default branch, pass a tag/branch/SHA to pin; a hardcoded `master` ref caused 404s until fixed 2026-10-17.

```

## Customer transcript (captured Pi events)

**2026-10-17T23:33:14.976Z** user

```
Task: using the GitHub integration, read README.md from the GitHub repository mcp-use/mcp-use at the release tag v1.5.0, and tell me the exact shell command that README gives for creating a new TypeScript MCP server. Check memory first for any relevant procedure.
```

**2026-10-17T23:33:19.550Z** assistant

```

[tool calls: [{"id":"call_56720aa559df457a9465a0b6","name":"memory__open_memory","arguments":{}}]]
```

**2026-10-17T23:33:19.551Z** tool_call `memory__open_memory`

```
{}
```

**2026-10-17T23:33:19.975Z** tool_result `memory__open_memory`

```
{
  "workspaceId": "a8afd786-93ca-4f10-8b46-da45b5ee62e8",
  "revision": {
    "id": "rev-22c43b7d0a07227e38aba824",
    "publishedAt": "2026-10-17T20:57:07.985Z",
    "pages": 4,
    "summary": "Cohort contained one synthetic smoke-fixture session (smoke-e2e-mvcvkvlt-89798e) re-running the Ledgerly paginate-then-pay workflow already documented from smoke-e2e-mvcvfc5o-5f79fc. Verified all 30 events: identical behavior at identical seq numbers (400 invalid_limit at #5, two pages at #9→#13, 503 upstream_timeout → same-key retry → 201 pay_9001 at #17→#23, idempotent replay 200 at #27). No new procedural learning; updated the two Ledgerly pages to record the second corroborating observation and its session id. No other pages changed."
  },
  "rootIndex": "# Procedural memory\n\nThis wiki is maintained by the daily procedural-memory build from captured agent traces.\n\n## Subjects\n\n- [Integrations](integrations/index.md) — how specific APIs and tools actually behave (endpoints, pagination, idempotency, errors).\n  - [Ledgerly (fictional invoices API)](integrations/ledgerly/index.md) — cursor pagination with a 50-item limit cap, idempotent payments, and safe retry after ambiguous 503s.\n",
  "outline": [
    {
      "path": "$KNOWLEDGE/index.md",
      "title": "Procedural memory",
      "description": "This wiki is maintained by the daily procedural-memory build from captured agent traces."
    },
    {
      "path": "$KNOWLEDGE/integrations/index.md",
      "title": "Integrations",
      "description": "Parent: [Procedural memory](../index.md)"
    },
    {
      "path": "$KNOWLEDGE/integrations/ledgerly/index.md",
      "title": "Ledgerly API (fictional)",
      "description": "Parent: [Integrations](../index.md)"
    },
    {
      "path": "$KNOWLEDGE/integrations/ledgerly/reconcile-open-invoices.md",
      "title": "Reconcile open invoices and pay one exactly once (Ledgerly)",
      "description": "Workflow observed in `smoke-e2e-mvcvfc5o-5f79fc` and re-observed identically in"
    }
  ],
  "orientation": "How to orient: start by reading $KNOWLEDGE/index.md, then follow the index links to subject and workflow pages; use grep/find on $KNOWLEDGE to locate specific procedures. $KNOWLEDGE is the published procedural memory (read-only); $WORK/scratch is your private writable scratch (never published)."
}
```

**2026-10-17T23:33:27.195Z** assistant

```
I found no GitHub-specific procedure in memory, so I'll now read the README from GitHub. Note that the available `read_file` tool doesn't support a tag parameter, so I'll attempt the call as-is.
[tool calls: [{"id":"call_4ea294d5e68241128c950009","name":"integration__github-read__read_file","arguments":{"owner":"mcp-use","repo":"mcp-use","path":"README.md"}}]]
```

**2026-10-17T23:33:27.196Z** tool_call `integration__github-read__read_file`

```
{"owner":"mcp-use","repo":"mcp-use","path":"README.md"}
```

**2026-10-17T23:33:27.738Z** tool_result `integration__github-read__read_file` (error)

```
GitHub error 404: No commit found for the ref master (GET /repos/mcp-use/mcp-use/contents/README.md?ref=master; request id EC62:B91B4:20ECAE:6BB275:6AD405C7)
```

**2026-10-17T23:33:34.235Z** assistant

```

[tool calls: [{"id":"call_3b0bc828121f4ef2afcfe31e","name":"integration__github-read__read_file","arguments":{"owner":"mcp-use","repo":"mcp-use","path":"readme.md"}}]]
```

**2026-10-17T23:33:34.236Z** tool_call `integration__github-read__read_file`

```
{"owner":"mcp-use","repo":"mcp-use","path":"readme.md"}
```

**2026-10-17T23:33:34.642Z** tool_result `integration__github-read__read_file` (error)

```
GitHub error 404: No commit found for the ref master (GET /repos/mcp-use/mcp-use/contents/readme.md?ref=master; request id EC6E:16F44C:193A1D:526FC8:6AD405CE)
```

**2026-10-17T23:33:45.511Z** assistant

```
I checked memory first — it only contains procedures for the Ledgerly invoices API; nothing relevant to GitHub or mcp-use.

I then tried to read the README via the GitHub integration, but both attempts failed:

- `GET /repos/mcp-use/mcp-use/contents/README.md?ref=master` → **GitHub error 404: No commit found for the ref master** (request id `EC62:B91B4:20ECAE:6BB275:6AD405C7`)
- Retry with `readme.md` → same **404, "No commit found for the ref master"** (request id `EC6E:16F44C:193A1D:526FC8:6AD405CE`)

The problem: the read tool is hardcoded (or defaulted) to the `master` ref, but this repository apparently has no `master` branch — and the tool exposes no parameter to specify a branch or tag, so I cannot request the `v1.5.0` tag (or `main`) with the integration as currently configured.

I can't tell you the exact shell command from the v1.5.0 README without guessing, which I won't do. To proceed, I'd need either the GitHub integration to accept a `ref` parameter, or the file content provided another way.
```

**2026-10-17T23:41:57.209Z** user

```
Retry the same task now. Since your last attempt the organization's memory and integrations may have been updated: call memory__open_memory again to pin the newest memory revision, read what it says about the GitHub integration, then use the integration tools as they are now.
```

**2026-10-17T23:41:59.737Z** assistant

```

[tool calls: [{"id":"call_bd438090ffc74708ac7f9b97","name":"memory__open_memory","arguments":{}}]]
```

**2026-10-17T23:41:59.738Z** tool_call `memory__open_memory`

```
{}
```

**2026-10-17T23:42:00.466Z** tool_result `memory__open_memory`

```
{
  "workspaceId": "fdf513a1-b344-4dec-91ae-a69bdc9a0680",
  "revision": {
    "id": "rev-0a0cefcf1537a9df1e5c9497",
    "publishedAt": "2026-10-17T23:41:47.290Z",
    "pages": 5,
    "summary": "Cohort: one session (ses-mvd18evw-507ec38e35a1) in which the customer agent failed to read mcp-use/mcp-use README.md at tag v1.5.0 because the github-read integration's read_file hardcoded ?ref=master and exposed no ref parameter (GitHub 404 \"No commit found for the ref master\", twice). Repaired the integration: read_file now accepts an optional ref (branch/tag/SHA) and defaults to the repository's default branch per GitHub docs, with regression tests for omitted/explicit/malformed refs. Validated (val-d23ff76f05c300dd5adac809, all smoke/regression/heldout suites passed), committed fb720207, promoted, deployed and probe-passed (pub-b166454ef8c67af24ab8bc9b). Wiki: new page integrations/github-read.md documenting read_file ref semantics, the hardcoded-master failure mode (with the diagnostic lesson: match the 404 message to the parameter, don't retry path variants), error shape and limits; index pages updated. Ledgerly pages unchanged (no new evidence)."
  },
  "rootIndex": "# Procedural memory\n\nThis wiki is maintained by the daily procedural-memory build from captured agent traces.\n\n## Subjects\n\n- [Integrations](integrations/index.md) — how specific APIs and tools actually behave (endpoints, pagination, idempotency, errors).\n  - [Ledgerly (fictional invoices API)](integrations/ledgerly/index.md) — cursor pagination with a 50-item limit cap, idempotent payments, and safe retry after ambiguous 503s.\n  - [GitHub Read integration](integrations/github-read.md) — reading files from public GitHub repos at the default branch or a pinned tag/branch/SHA; hardcoded-`master` 404 failure mode and its fix.\n",
  "outline": [
    {
      "path": "$KNOWLEDGE/index.md",
      "title": "Procedural memory",
      "description": "This wiki is maintained by the daily procedural-memory build from captured agent traces."
    },
    {
      "path": "$KNOWLEDGE/integrations/github-read.md",
      "title": "GitHub Read integration (`github-read`)",
      "description": "Parent: [Integrations](../index.md)"
    },
    {
      "path": "$KNOWLEDGE/integrations/index.md",
      "title": "Integrations",
      "description": "Parent: [Procedural memory](../index.md)"
    },
    {
      "path": "$KNOWLEDGE/integrations/ledgerly/index.md",
      "title": "Ledgerly API (fictional)",
      "description": "Parent: [Integrations](../index.md)"
    },
    {
      "path": "$KNOWLEDGE/integrations/ledgerly/reconcile-open-invoices.md",
      "title": "Reconcile open invoices and pay one exactly once (Ledgerly)",
      "description": "Workflow observed in `smoke-e2e-mvcvfc5o-5f79fc` and re-observed identically in"
    }
  ],
  "orientation": "How to orient: start by reading $KNOWLEDGE/index.md, then follow the index links to subject and workflow pages; use grep/find on $KNOWLEDGE to locate specific procedures. $KNOWLEDGE is the published procedural memory (read-only); $WORK/scratch is your private writable scratch (never published)."
}
```

**2026-10-17T23:42:05.702Z** assistant

```

[tool calls: [{"id":"call_0e07e54f89b3408f93c0f06d","name":"memory__read","arguments":{"path":"$KNOWLEDGE/integrations/github-read.md"}}]]
```

**2026-10-17T23:42:05.703Z** tool_call `memory__read`

```
{"path":"$KNOWLEDGE/integrations/github-read.md"}
```

**2026-10-17T23:42:06.012Z** tool_result `memory__read` (error)

```
{
  "tool": "read",
  "ok": false,
  "code": "workspace_ambiguous",
  "error": "You have 2 open workspaces; pass the workspaceId returned by your open_memory call"
}
```

**2026-10-17T23:42:09.472Z** assistant

```

[tool calls: [{"id":"call_42216d42df6a4a16b1c6bb5a","name":"memory__read","arguments":{"path":"$KNOWLEDGE/integrations/github-read.md","workspaceId":"fdf513a1-b344-4dec-91ae-a69bdc9a0680"}}]]
```

**2026-10-17T23:42:09.473Z** tool_call `memory__read`

```
{"path":"$KNOWLEDGE/integrations/github-read.md","workspaceId":"fdf513a1-b344-4dec-91ae-a69bdc9a0680"}
```

**2026-10-17T23:42:09.811Z** tool_result `memory__read`

```
{
  "workspaceId": "fdf513a1-b344-4dec-91ae-a69bdc9a0680",
  "tool": "read",
  "ok": true,
  "durationMs": 1,
  "path": "$KNOWLEDGE/integrations/github-read.md",
  "content": "# GitHub Read integration (`github-read`)\n\nParent: [Integrations](../index.md)\n\nMCP integration that reads files from **public** GitHub repositories through the GitHub\nREST \"Get repository content\" endpoint (`GET /repos/{owner}/{repo}/contents/{path}`,\nunauthenticated). Deployed tool: `integration__github-read__read_file`.\n\n## Tool: `read_file`\n\nParameters: `owner`, `repo`, `path` (required), `ref` (optional — branch, tag or commit\nSHA, e.g. `v1.5.0`). Returns the decoded UTF-8 text (capped at 24 000 chars, flagged\n`truncated`), the file `sha`, the effective `ref`, and the GitHub request id.\n\n**Ref semantics (current, fixed revision):** omit `ref` to read from the repository's\n**default branch** — the client then sends no `ref` query parameter and GitHub applies\nits documented default (\"Default: the repository's default branch\",\n<https://docs.github.com/en/rest/repos/contents>). Pass `ref` explicitly to pin a\nrelease tag, branch or SHA.\n\n## Failure mode (fixed 2026-10-17): hardcoded `master` ref\n\nThe initially deployed revision always sent `?ref=master` and exposed no `ref`\nparameter. On any repository whose default branch is not `master` this fails with\nHTTP 404 and message `No commit found for the ref master` — even when the file exists.\nObserved in `ses-mvd18evw-507ec38e35a1`: both `read_file(owner=mcp-use, repo=mcp-use,\npath=README.md)` (`#14`→`#15`) and a retry with `readme.md` (`#20`→`#21`) returned that\n404, and the session failed because the requested tag `v1.5.0` could not be passed at\nall (client-reported, `#25`).\n\n**Lesson:** changing the file path does not help when the 404 message names the *ref*;\nread the error's `request` field (`GET /repos/.../contents/README.md?ref=master`) to see\nwhich parameter is wrong. Do not retry with path variations — report the missing `ref`\ncapability instead.\n\n**Repair (this build):** added optional `ref` parameter; omitted `ref` now means the\ndefault branch. Validated (`val-d23ff76f05c300dd5adac809`: regression cases \"omitted\nref reads the repository default branch (main)\", \"reads a file at an explicit release\ntag ref\", heldout slash-branch/SHA/nested-path cases), commit `fb720207`, deployed and\nprobe-passed (`pub-b166454ef8c67af24ab8bc9b`, deployment `2050cca9`).\n\n## Error shape\n\nTool errors come back with `isError: true`, text `GitHub error <status>: <message>\n(GET ...; request id <id>)`, and structuredContent `{status, message,\ndocumentationUrl, requestId, request}` (`ses-mvd18evw-507ec38e35a1#15`). Quote the\nrequest id when reporting upstream failures.\n\n## Limits and notes\n\n- Public repositories only; no credentials, so unauthenticated GitHub rate limits apply\n  (check `github.rateLimitRemaining` in the result).\n- Files only: a directory path errors `Not a file (type dir)`; files > 1 MB are not\n  supported by this endpoint's base64 mode (GitHub docs).\n- `owner`/`repo`/`path`/`ref` are validated client-side; `..` and empty segments are\n  rejected before any request.",
  "totalBytes": 2979,
  "mode": "lines",
  "startLine": 1,
  "endLine": 56,
  "totalLines": 56,
  "truncated": false
}
```

**2026-10-17T23:42:14.011Z** assistant

```
The memory page confirms the fix: `read_file` now accepts an optional `ref` parameter. Retrying with the tag pinned:
[tool calls: [{"id":"call_65de0e5681684206ba9b7a3d","name":"integration__github-read__read_file","arguments":{"owner":"mcp-use","repo":"mcp-use","path":"README.md","ref":"v1.5.0"}}]]
```

**2026-10-17T23:42:14.012Z** tool_call `integration__github-read__read_file`

```
{"owner":"mcp-use","repo":"mcp-use","path":"README.md","ref":"v1.5.0"}
```

**2026-10-17T23:42:14.643Z** tool_result `integration__github-read__read_file`

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

**2026-10-17T23:42:23.963Z** assistant

```
Success this time. The updated memory revision (`rev-0a0cefcf1537a9df1e5c9497`) documented the fix to the GitHub Read integration — `read_file` now takes an optional `ref` — and reading `mcp-use/mcp-use/README.md` at `ref: v1.5.0` worked (file sha `e43507d88d2e7545f54724fea6509ba00f40f57d`).

**The exact command the v1.5.0 README gives for creating a new TypeScript MCP server** (in the "Create an MCP Server" → TypeScript section) is:

ʼʼʼbash
npx create-mcp-use-app my-server
cd my-server
npm install
ʼʼʼ

So the scaffolding command itself is `npx create-mcp-use-app my-server`, followed by `cd my-server` and `npm install`. The README then shows building the server with `createMCPServer` from `mcp-use/server` (Python server creation is marked "Coming Soon" at this tag).
```

