# Integration MCPs: research, repair, create, publish

The daily build harness keeps a procedural wiki. It can also research, repair and create
third-party **integration MCP servers**. Each one is its own Git repository and a runnable
mcp-use v2 server, and each is hosted on Manufact. This document covers the subsystem in
`src/integrations/`.

| Piece | Where | Authority |
| --- | --- | --- |
| Research tools (`research_*`) | host process | live Exa API / bounded HTTPS fetch / configured upstream MCPs. Results are untrusted data |
| Repo workspace (`integration_*` file/exec/git tools) | Modal sandbox, network blocked | the integration repository; host-owned git |
| Sealed validation gate | Modal sandbox (uids: agent 1000, harness 1001) | host harness and receipts |
| Durable state | `ObjectStore` (host-supplied namespace) | refs `integrations/<slug>`, blobs, receipts |
| Lifecycle (`integration_retire`, `integration_restore`) | host process | durable catalog record (CAS) + optional live Manufact stop |
| Publisher (`integration_publish` and related) | host process | live Manufact Cloud API, pinned to org `org-84350150-jpcs9` |
| Customer catalog (`GET /v1/integrations`, `POST /v1/integrations/:slug/token`) | parent HTTP API (NOT the `/mcp` tool surface) | host catalog + host-minted child tokens |

None of these tools are on the customer MCP: the parent `/mcp` endpoint stays filesystem-only (memory read-only + scratch). Customers discover children through separate authenticated HTTP routes that main wires in `src/app.ts`/`src/server.ts`. These are `GET /v1/integrations` and `POST /v1/integrations/:slug/token`, and both use `createIntegrationCatalog`.

## Wiring (main harness)

```ts
import { createIntegrationRuntime } from "./src/integrations/index.js";
const rt = createIntegrationRuntime({ ns: tenantNs, store, buildId, suites });   // ns from the authenticated host context
try {
  // register rt.tools (exact names, JSON schemas) as dynamic tools; dispatch by name:
  const result = await rt.invoke(call.function.name, call.function.arguments);
  // add rt.instructions to the builder system prompt
} finally {
  await rt.close();           // persists git bundles, terminates the sandbox
}
```

Parent HTTP catalog (customer side, already wired by main in `src/app.ts` and `src/server.ts`; not MCP tools):

```ts
const catalog = createIntegrationCatalog({ ns, store, childAuth: loadChildAuthFromEnv(env) });
await catalog.listDeployed();                       // GET  /v1/integrations
await catalog.accessToken(slug, { subject });       // POST /v1/integrations/:slug/token
```

`createCustomerIntegrationTools` exists only for embedders that want an MCP tool form. The production parent does not register it on `/mcp`.

## Repository and Git trust boundary

- The worktree is `/srv/integ/mcps/<slug>/` and is owned by the agent uid. The git dir is `/srv/integ/git/<slug>.git`, owned by root, with a root-owned 0755 parent. It sits **outside** every agent-writable tree, so the agent cannot rename, replace, symlink or write it.
- Host git always runs with explicit `--git-dir/--work-tree` (no repository discovery). It also sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `core.attributesFile=/dev/null`. The git dir has no hooks directory, and its config is written by the host.
- The validation policy rejects any `.git` entry or `.gitattributes` file in the worktree, plus symlinks, `.gitmodules`, special files, files over 1 MiB, and paths that the stock Manufact CLI drops (`build`, `dist`, `out`, `.env*`, …).
- The agent's own shell gets `GIT_DIR`/`GIT_WORK_TREE`, so `git status/diff/log` work. Writes to git (`commit`, `update-ref`, `reset`, rebase) fail with EACCES.
- Commits only happen through `integration_git_commit`. It requires a passing validation receipt whose tree id equals the current working tree exactly. The commit goes on `codex/build-<buildId>`.
- `integration_promote` fast-forwards `main` (compare-and-swap). It then stores the deterministic `git archive --prefix=app/` tar.gz, extracts it, and verifies its content sha256 equals the validated source hash. If a repair fails, the promoted revision stays as it was.
- Persistence: a full-history `git bundle --branches` goes to `blobs/<sha256>` (snapshot receipt). Before it is saved, every previously persisted branch must still exist and may only have moved forward. Cold restore fetches from the bundle into a new sandbox.

These properties are verified on a real Modal sandbox as uid 1000 in `tests/integrations-modal-live.test.ts`:

- the git dir cannot be moved, deleted or written;
- refs cannot be updated and commits cannot be made;
- an agent-planted `.git` config (fsmonitor, hooks, filter) and a `sub/.git` gitdir file are never executed: no `/tmp/pwned-*` files appear after host tree/status/validate runs;
- the sealed harness, fixtures and host scratch cannot be read;
- a harness-uid process cannot be killed and its `environ` cannot be read;
- the tools and pre-baked dependencies cannot be written;
- file tools refuse symlink escapes;
- the network is blocked and the environment contains no secrets.

## Sealed validation (`integration_validate`)

1. Policy scan, then the exact tree id (computed with a temporary index), then `git archive <tree>` into a fresh stage directory and the content sha256 of that stage.
2. Manifest checks. `integration.json` must declare tools, env var names and smoke cases. `package.json` must have `build` = `mcp-use build` and `start` = `mcp-use start`, and its dependencies must be pinned to the pre-baked offline set: mcp-use 2.10.0, zod 4.6.7, tsx, typescript, @types/node.
3. `npm test` and `npm run build`, run as the agent uid with no network.
4. Real MCP checks. `harness/run-suite.mjs` (root) starts host fixtures as uid 1001. It starts the child with the production command (`mcp-use start`) as uid 1000, using a fresh per-run Ed25519 child-auth key. `case-client.mjs` (uid 1001) then uses the official MCP client to check:
   - an unauthenticated request, a foreign-key token, a wrong-audience token and an expired token are all rejected with 401;
   - initialize works;
   - `tools/list` equals the declared tools;
   - `tools/call` steps pass their assertions;
   - the fixture-state oracle passes.
5. Held-out suites come in through stdin and never touch disk. The harness directory is root:1001 with mode 0750, and its files are 0640. For held-out cases the agent sees only the case name and where it failed.

The receipt (`val-<sha>`) binds the tree, the source sha256, the commands, every case result and the sandbox policy.

**Binding tested source to the attested tree.**

- **Sealed source.** After staging, every source file and directory is root-owned and non-writable. Only `.mcp-use/` (build output) and the generated `mcp-env.d.ts` are agent-writable. This is OS-enforced on Modal.
- **Reaping and re-hashing after every untrusted phase** (`npm test`, `npm run build`, the MCP suites):
  - every agent-uid process is SIGKILLed, including `setsid`-daemonized ones;
  - the stage is re-hashed (`sourceChecks`).
- **Hard stop on mismatch.** Any mismatch fails the gate immediately, so no later result is attributed to the attested tree.
- **Fresh outputs for the build.** Test-phase outputs are wiped before the production build.
- **Frozen build output.** After building, `.mcp-use/` is frozen root-owned. `buildOutputSha256` is recorded and re-checked after the MCP suites.
- **Scope of the claim.** This is practical tamper resistance for the gate. It does not make builds hermetic or reproducible: the Manufact cloud build runs `npm install`/`mcp-use build` again from the attested archive.
- **Concurrency caveat.** Reaping kills every agent-uid process in that integration sandbox, so concurrent `integration_exec` commands in the same runtime are terminated by a validation.

## Publishing to Manufact (`integration_publish`, `_deployment_status`, `_deployment_logs`, `_rollback`, `_probe`)

**Route.** The publisher uses the Manufact Cloud REST API with the same endpoints, headers and multipart fields as the official `@mcp-use/cli@4.4.0` (`deploy --no-github`, `deployments`, `servers`). The hosted control-plane MCP (`mcp.manufact.com/mcp`) requires an interactive OAuth JWT and rejects API keys, so it is not used headlessly.

**Credentials.** These come from host env: `MCP_USE_API_KEY` plus `MANUFACT_ORG_SLUG`, optionally `MANUFACT_ORG_ID` and `MCP_USE_CLOUD_API_URL`. On a workstation the CLI profile is used as a fallback. Every operation calls `/test-auth` first and refuses any org other than the configured slug. The key is never logged, stored, returned, or forwarded to models or sandboxes, and it is redacted from errors.

**Publish flow.**

1. Take the promoted revision and its passing receipt. Upload the stored archive (rooted at `app/`, as the CLI does). The first publish creates a managed server; later publishes push source to that server.
2. Track the deployment group whose `gitCommitMessage` carries this upload's unique message. Live behaviour shows that one upload creates two deployments, webhook and manual, and Manufact stops whichever one is superseded.
3. Wait for a member to reach `running` or `failed`, and fetch its full build log. "running" alone is never trusted.
   - **Appearance grace (default 60 s, `appearanceGraceMs`).** Re-uploading a tree identical to the managed repo's current commit makes no new commit and therefore no webhook deployment. This happens, for example, when the same commit is republished with only env changed. If no deployment carrying this upload's message appears within the grace, the publisher makes ONE explicit `POST /deployments {trigger:"redeploy"}` and gives that build the full budget (default 15 min).
   - **No premature fallback.** Once any member appears (including a stopped placeholder next to a still-building webhook), there is no fallback and the full budget applies.
   - **Receipt evidence.** The receipt records `uploadAppearance {appeared, waitedMs, graceMs}`, the bounded and redacted `uploadResponse`, `uploadDeployments` membership and `deploymentTrigger`.
   - **Residual race.** A webhook that first appears after the grace and after the explicit redeploy would cause a second build. Both carry the same source, and the probe-checked chosen deployment is the explicit one.
4. Probe the live endpoint over MCP:
   - an unauthenticated request must return 401;
   - foreign-key and wrong-audience tokens must return 401;
   - with a host-minted token: initialize, `tools/list` equals the validated manifest, and the fixture-free smoke cases pass;
   - `server.activeDeploymentId` must equal the chosen deployment.

**Outcome.** A deployment becomes active only if the probe passes. If a new revision builds but fails the probe, the publisher redeploys the previous active archive (`auto_rollback`) and probes that as well. Each step is recorded in a `pub-<sha>` receipt. Receipts include the deployment ids, build log sha and tail, MCP URL, dashboard URL, probe statuses, and env var **names** (never values).

**Deploy env.** Each child gets `CHILD_AUTH_PUBLIC_JWK`, `CHILD_AUTH_ISSUER`, `CHILD_AUTH_AUDIENCE` and `NODE_ENV=production`, plus host-configured `deployEnv(slug)`. Required env names from the manifest must be present.

## Dynamic catalog and retirement (`integration_retire`, `integration_restore`)

**What the catalog lists.** `GET /v1/integrations` lists an integration only if all of these hold:

- its lifecycle is active (not retired);
- its active Manufact deployment is recorded as `running` AND passed the live MCP probe (`isListed`);
- it has an `mcpUrl`.

Each request reads durable state; there is no cache. A publish, update, retire or restore therefore shows up on the next poll, from any process, including cold stores and read-through caches. SDKs diff successive listings:

- a new `deploymentId` or `commit` means the child was edited;
- a missing slug means it was removed.

`integrationCatalogFingerprint(entries)` gives an order-independent sha256 of a listing. Entries carry only `slug, title, description, mcpUrl, tools, commit, deploymentId, deployedAt, audience`, never source, receipts, traces or env.

**Retire.** `integration_retire {slug, reason, stopDeployment?}` CAS-writes a reversible tombstone (`lifecycle.state = "retired"`) and an immutable `life-` receipt.

- Nothing is deleted: the repo, history bundles, receipts and promoted revision all stay.
- The catalog stops listing the integration immediately, and `POST /v1/integrations/:slug/token` refuses it.
- **Tokens already issued are not revoked.** They are stateless JWTs and stay valid at the child until they expire: at most 900 s through the parent route, 3600 s hard cap.
- With `stopDeployment: true`, the host also stops the active Manufact deployment (`POST /deployments/:id/stop`; data is not deleted). The child then stops serving, which does cut off outstanding tokens. The stopped deployment moves to history, so after a restore it needs a new `integration_publish` before it is listed again.

**Restore.** `integration_restore {slug, reason}` flips the state back to active. If the recorded active deployment is still probe-passed, it is listed again at once; otherwise it is listed after the next publish.

**Publishing while retired.** `integration_publish` and `integration_rollback` refuse a retired integration with `integration_retired`, at both the publisher and tool layers. Re-enabling is always an explicit restore. Repo work (open, edit, validate, commit, promote) is still allowed while retired.

## Child auth that customer agents can actually use

Children verify **EdDSA JWTs minted by the parent** (`src/integrations/child-auth.ts`; the child side is `templates/integration/child/src/auth.ts`, which uses only node:crypto).

- `iss` is `INTEGRATION_CHILD_ISSUER` and `aud` is `urn:procmem:integration:<ns>:<slug>`. Tokens last at most 1 h and carry scope `integration:call`.
- A customer agent that is already authenticated to the parent (WorkOS) calls `POST /v1/integrations/:slug/token` and connects to the child's `mcpUrl` with `Authorization: Bearer`.
- The private key exists only on the host (`INTEGRATION_CHILD_SIGNING_JWK`). Children get the public JWK.
- Because the audience is scoped to tenant and integration, a token for one child is rejected by every other child.

This avoids registering a broad WorkOS resource wildcard for all Manufact hostnames. A narrow, per-deployment WorkOS resource indicator could be added later. That requires a host dashboard step per child URL and is not implemented.

## Research tools

These are `research_exa_search`, `research_exa_contents`, `research_exa_code_context` (Exa `/context`, verified live), `research_fetch_url`, `research_openapi_inspect` (JSON only), and `research_upstream_mcp_list_tools`/`_call` (host-configured upstreams; read-only tools only).

- `research_fetch_url` only fetches HTTPS. It pins DNS, rejects private and reserved addresses on every redirect hop, sends no credentials, and is capped by bytes and time.
- Every result carries SourceRecords (URL, final URL, retrieval time, sha256 of the received bytes, verbatim excerpt).
- `integration_record_research` writes those records into the repo's `docs/research.md`.

## Demo

`npx tsx scripts/integration-demo.ts [--no-publish] [--rollback]` runs a real Modal + Manufact demo through `runtime.invoke(...)`, the same tool API the agents use. The code revisions are **scripted fixtures** (`templates/integration/demo/notify-hub`), not LLM output. The report goes to `.data/integration-demo/<run>/report.json`.

| Build | What happens |
| --- | --- |
| A | Scaffold, then the faulty initial revision. It passes suite v1 and is committed, promoted and published. The deployed child (simulated upstream) returns 10 of 23 items and fails a send whose acknowledgement is lost. |
| B | A new sandbox restores the repo from the bundle. Suite v2 (trace regressions plus held-out) fails the current revision. The wrong repair (retries without an Idempotency-Key) fails and cannot be committed, and deployment A stays active. The correct repair passes all 13 cases and is committed, promoted and published as an update. The live child then returns 23 items and survives the lost acknowledgement without a duplicate. |
| C | A cold restore again: history is intact. With `--rollback`, the previous archive is redeployed and then the promoted revision is republished. |

## Tests

- `tests/integrations.test.ts` (offline) covers:
  - paths, porcelain parsing, store CAS and idempotency, and tenant isolation;
  - child-auth claims;
  - the Manufact client (headers, org pinning, redaction);
  - the publisher: placeholder deployments, probe failure leading to auto-rollback, and failed builds not activating;
  - git logic in the host-test sandbox: external git dir, commits only of the exact tree, bundle round trip, history verification;
  - the runtime's tool contract and sandbox isolation refusal;
  - the customer catalog.
- `tests/integrations-research.test.ts` covers the URL guard, safe fetch, Exa client, OpenAPI and upstream MCP. A live Exa test is gated behind `INTEGRATION_LIVE_EXA=1`.
- `tests/integrations-modal-live.test.ts` runs the adversarial checks on a real sandbox, gated behind `INTEGRATION_LIVE_MODAL=1`.

## Limitations

- Generated repos can only use the pre-baked dependency set; there is no network npm install.
- The hosted demo child uses an in-process simulated upstream (`NOTIFY_HUB_SIMULATED=1`). No real third-party side effects happen.
- Manufact's in-memory child state is per instance.
- `research_openapi_inspect` does not parse YAML.
- Customers reach children only through main's parent HTTP routes (`/v1/integrations`). The demo exercised the same `IntegrationCatalog.accessToken` code path in-process, not through the deployed parent.
- Manufact's REST API is the one the official CLI uses, not a separately versioned public API.
