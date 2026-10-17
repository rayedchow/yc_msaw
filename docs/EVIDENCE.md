# Evidence ledger

Every claim below points at a report in `reports/`. Each line is labeled:
- **LIVE**: real cloud services and/or real models.
- **FIXTURE**: deterministic or scripted.
- **PENDING**: not yet measured.

## Hosting and auth

| Claim | Label | Evidence |
|---|---|---|
| Parent MCP deployed on Manufact (org Askshepherd `org-84350150-jpcs9`, account ishan@askshepherd.ai) at `https://wild-zero-kq08i.run.mcp-use.com/mcp` | LIVE | host deploy logs; `reports/auth-manufact-discovery.json` |
| **Final staging deployment verified.** Parent `https://wild-zero-kq08i.run.mcp-use.com/mcp` (server `f2352b28…`, ishan@askshepherd.ai / Askshepherd `org-84350150-jpcs9`) runs active webhook deployment `f5390025-53dc-40f2-ada9-86f5e943b4e2` from managed commit `d9af52dce25e7cca841bad171e28296d62e1c8a8`. `/healthz` returns 200. Runtime source hash `806bd575…` covers 179 runtime files; the CI workflow and credentials are excluded from the managed upload. On this deployment: WorkOS OAuth 10/10 (fullyAuthenticated; an existing grant refreshed via the CLI, then an authorized `open_memory` through the SDK), and SDK live tools 9/9 (16 direct tools from parent + child; stdio bridge 18 with fallbacks and `list_changed`) | LIVE. Labels: staging service; NotifyHub upstream simulated (real Manufact child endpoint); SDK from local tarball, not on npm | `reports/deploy-final.json`, `reports/auth-manufact-final.json`, `reports/sdk-live-tools-hosted.json` (latest) |
| Real WorkOS AuthKit OAuth: DCR/CIMD, JWKS, unauthenticated and forged tokens get 401, authorized `initialize` + `tools/list` + `open_memory` on the deployed parent | LIVE (fullyAuthenticated=true, 10/10 checks) | `reports/auth-manufact-oauth.json` |
| Edge probes with internal or Fly Host headers get health 200 and a canonical 401 challenge (not 403) | FIXTURE (raw `node:http` with a real Host header, plus a negative control) | `tests/health-public.test.ts` |
| Tenant isolation, ingest-only key refused on memory tools, two clients of the same principal pinned to separate workspaces | FIXTURE (real HTTP + real MCP client) | `tests/e2e-app.test.ts` |
| Host-implicit `memory:read` is not advertised in tool security schemes (WorkOS issues only OIDC scopes), yet every call enforces it: a build-only static key is denied | FIXTURE (real server + mock OIDC issuer + real MCP client) | `tests/server-oauth-scopes.test.ts` |
| Hosted end to end, 64/64 checks in 152 s, on the deployed parent: scoped SDK HTTP upload of a synthetic trace; real hosted daily build (Kimi + Modal) published new immutable revision `rev-22c43b7d…` from catch-up manifest `daily/2026-10-17/manifest-0002`; fresh MCP files/read/grep/find; private scratch edit; Modal shell protections | LIVE (synthetic trace fixture; real build, storage and MCP) | `reports/hosted-e2e-smoke.json` |

## Storage, sandboxes, scheduler

| Claim | Label | Evidence |
|---|---|---|
| Modal Volume object store: CAS race between 6 clients has exactly 1 winner; 13 MiB high-entropy and 7 MiB multipart objects round-trip byte-exact on a cold instance; cold MemoryRepo restore | LIVE | `reports/durability-smoke.json` |
| Customer sandbox: knowledge is OS read-only for uid 1000, network blocked, env allowlisted, timeouts, poll/stdin/cancel of the process group, terminate | LIVE (15/15) | `reports/modal-smoke.json` |
| Modal apps deployed: `procmem-store` (Volume + Dict lock), `procmem-daily` (Cron 00:20 UTC → parent `/v1/builds/daily` with catch-up) | LIVE | `modal app list` |
| The deployed scheduler function, invoked manually, authenticated to the hosted parent. The parent correctly answered `nothing_to_build` / no unprocessed days after the cohort was already processed. A scheduled 00:20 UTC firing has not yet been observed | LIVE (manualTrigger=true) | `reports/modal-daily-trigger.json` |
| Daily build: lease-fenced claim, crash recovery, catch-up, persistence errors stay visible | FIXTURE | `tests/daily-service.test.ts` |

## Recursive build harness (real models)

| Claim | Label | Evidence |
|---|---|---|
| Real multi-agent delegation: Kimi K3 root spawned 3 GLM 5p3 children with exclusive scopes (`billing/**`, `deploy/**`, `search/**`). It accepted 2 reviewed handoffs and published `rev-a2661b19…` (13 pages in subject directories) | LIVE (Fireworks + Modal workspaces; synthetic multi-domain cohort) | `reports/build-live-nested.json` |
| One child (billing) failed: the model emitted invalid JSON tool arguments and the provider then rejected the replayed history. **Fixed:** the loop now replays invalid arguments as `{"_invalid_arguments": …}`; covered by a unit test | LIVE failure + FIXTURE test | same report, `root.1.failure`; `tests/build-units.test.ts` |
| Depth-2 delegation: the Kimi root spawned 3 GLM children (`billing/**`, `deploy/**`, `search/**`), and the billing child spawned a grandchild (`billing/refunds.md`). Every handoff was reviewed and accepted (grandchild by its parent, children by the root). The root alone published `rev-30e27c1a…` (13 pages, valid). ~1.74M prompt / 52k completion tokens, 6.2 min, one Modal sandbox per agent | LIVE (delegation explicitly requested via operator instructions in the objective; not forced by code) | `reports/build-live-depth2.json` |
| Earlier runs: root-only builds (no delegation) | LIVE | `reports/build-live-nested-prev-nodelegation.json`, `reports/build-live-nested-small.json` |
| Scope overlap rejection, write-outside-scope rejection, exact-base merge conflicts, root-only publish, `foo.md` → `foo/index.md` promotion, budget exhaustion | FIXTURE (scripted model) | `tests/build-harness.test.ts`, `tests/build-units.test.ts` |

## Integration MCPs

| Claim | Label | Evidence |
|---|---|---|
| The compiled production artifact (`.mcp-use/build`) bundles the integrations runtime. It exposes research tools (Exa/fetch/OpenAPI) and repo, validate, commit, promote, publish and rollback tools, with host credentials present | LIVE (artifact check) | `reports/built-integrations-check.json` |
| Infrastructure demo: publish, repair, update, rollback and republish of a generated child MCP on Manufact (Askshepherd org), called over MCP with parent-minted EdDSA child tokens. Re-gated under the hardened sealed-source validation | LIVE infra; code revisions are SCRIPTED FIXTURES (not LLM-authored) | `reports/integration-demo-live.json` |
| **OPERATOR IMPORT** of the LLM-generated notify-hub integration into the hosted staging tenant. A trusted operator CLI copied the unmodified record (commit `66986288`, validation `val-6c082feebcfc…`) into the Modal-backed tenant of the real OAuth user, then republished child `https://warm-cloud-e1lye.run.mcp-use.com/mcp` (deployment `32cb7c2e…`). Verified through the real parent: catalog listing and token exchange return 200. The child returns 401 without a token or with an invalid one, and with a valid token lists 4 tools and returns all 23 notifications (pagination works) | LIVE. Labels from the report: OPERATOR IMPORT (not performed by the model, not via the customer API); LLM-AUTHORED code/commits/validation/promotion preserved unmodified; Notify Hub SIMULATED in-process | `reports/hosted-integration-import.json` (21:25:49 UTC) |
| Token endpoint contract on the real server: absent integration → 404 `integration_not_found`; no child signing key → 503 `child_auth_not_configured` (`retryable:false`); unexpected failure → 502 `token_failed` with a sanitized message and a redacted server log; no catalog on the host → `GET /v1/integrations` returns `{integrations:[], childAuthConfigured:false}`. The tenant always comes from the verified caller | FIXTURE (real HTTP) | `tests/integration-token-route.test.ts` |
| `IntegrationRuntimeProvider.close` reports runtime persistence or termination errors as a failed `providerClose` entry, never as success | FIXTURE | `tests/build-provider-close.test.ts` |
| An LLM build agent repairs and publishes an integration from trace failures. Run: a real `runMemoryBuild` with a Kimi K3 root, the real integration runtime (Modal repo sandbox, host-held suites, Manufact publisher pinned to Askshepherd as ishan@askshepherd.ai). Over 26 integration tool calls of its own choosing (open → 12 reads → write/4 edits/write → `npm test` via exec → validate → commit → promote → publish), the model rewrote the client to: follow `has_more`/`next_cursor`; send a content-derived Idempotency-Key on every attempt; retry 429 (honoring Retry-After) and 503 (backoff, max 3). It also added regression tests. Host validation `val-6c082feebcfc…` passed smoke 3/3, trace regressions 6/6 and sealed held-out 4/4. Commit `66986288` was published as an update to `https://warm-cloud-e1lye.run.mcp-use.com/mcp` (deployment `1eda23e6…`, live probe passed), replacing faulty `ef971d93`. The same build wrote the wiki subtree `integrations/notify-hub/{index,auditing-notifications,sending-exactly-once}.md` with trace citations (`rev-78cbebee…`). The model did not call the Exa research tools (the API docs were in the repo). 23 turns, 46 calls, 583k prompt / 12k completion tokens, 9.8 min | LIVE (LLM-authored code and tool choices). SCRIPTED: setup of the faulty initial revision. SYNTHETIC: 2 customer trace sessions against the simulated Notify Hub service | `reports/integration-llm-run-20261017-5a8be8.json`, `reports/live-integration-llm-1.log` |

## Packaging and artifacts

| Claim | Label | Evidence |
|---|---|---|
| `@procmem/sdk` 0.1.0 packs to a tarball (`npm pack ./packages/procmem-sdk`). Entry points: `.`, `./pi`, `./live`, `./live/pi`, `./oauth`, plus the `procmem-live-mcp` bin. A fresh consumer that installed only the tarball passed the host's install/import checks. The package is **not** published to npm | LIVE (host clean-consumer check) | host verification; `npm run sdk:pack` |
| The compiled build bundles the integrations runtime | LIVE | `reports/built-integrations-check.json` |
| The stock Manufact managed archive includes every runtime source and import, and no secrets | FIXTURE | `npm run deploy:check` |

## SDK live tools and OAuth refresh

| Claim | Label | Evidence |
|---|---|---|
| Dynamic tools in the **same real Pi session**, for each of Kimi K3, GLM 5p3 and MiniMax M3, in 4 steps: (1) initial orders lookup; (2) billing `get_invoice` added and used; (3) orders schema gains a required `region` argument, which the model uses; (4) billing removed, and the model reports it unavailable (no invented answer, no child call). Full SDK trace capture with recorded counts. No efficiency claim | LIVE (real Fireworks, real MCP protocol). The orders and billing third parties are SIMULATED locally | `reports/sdk-live-tools-pi-live.json` |
| Live registry against the hosted parent with a read-only static key: 12 memory tools + 4 tools from the LLM-generated child = 16 direct tools. The stdio bridge serves 18 (16 + 2 fixed fallbacks), with real `notifications/tools/list_changed` and real read-only calls | LIVE (real Manufact, Modal and auth). Notify Hub upstream SIMULATED. Does not test OAuth refresh | `reports/sdk-live-tools-hosted.json` |
| SDK `OAuthRefreshProvider` refreshes a real existing WorkOS grant without new consent: 8 concurrent calls across 2 instances → exactly 1 issuer refresh and 1 distinct token; the refresh token rotated; new access token expires in 299 s; both CLI credential aliases updated atomically (0600); `tools/list` then returned 12 tools; errors `[]` | LIVE (host-run) | `reports/oauth-sdk-refresh.json` |
| Composed check: the live registry, given the WorkOS OAuth credential refreshed above (not a static key), uses the real parent catalog and child-token exchange. It exposes 12 memory + 4 child tools, and real read-only `memory__open_memory` and child `integration_info` calls succeed. No extra issuer refresh was needed in this check | LIVE (host-run; separate from the force-refresh test) | `reports/sdk-live-tools-oauth-hosted.json` |
| Offline source gate (host, final): full suite 361 passed (9 cloud-gated skipped), typecheck clean. Included: SDK live tools 68/68 (registry, resilience, real Pi session with Pi's scripted faux model, real stdio bridge with the official MCP client) and OAuth refresh 42 (real HTTP fixtures: cross-process lock, rotation, lost response, persist failure). Fresh-consumer pack check 7/7. CI results are reported separately in the pull request checks | FIXTURE (host-run, local) | `tests/sdk-live-tools*.test.ts`, `tests/sdk-oauth-refresh.test.ts`; `reports/sdk-live-tools-pack.json` |

## Memory reuse evaluation (Pi agents)

| Claim | Label | Evidence |
|---|---|---|
| Pi + Fireworks agents (Kimi, GLM, MiniMax) solve the notification task without memory; trace capture includes the system prompt and tool schemas | LIVE | `reports/pi-smoke-{kimi,glm,minimax}.json`, `reports/eval-pi-smoke-traced.json` |
| Full product loop (live). Day-1 Kimi K3 Pi agents (2 train scenarios) were traced through the real SDK adapter, with system prompt and tool schemas captured. The real recursive daily build ran with a Kimi root, 2 GLM children in Modal workspaces and integration tools registered. The email-runbook child completed and was accepted. The SMS-runbook child stopped with `no_progress`; the root wrote that page itself and published `rev-e1e20dae…` (15.7 min). Held-out GLM 5p3 and MiniMax M3 agents then ran 2 scenarios each, with the memory MCP and without | LIVE (real Pi + Fireworks, real daily build, simulated notification world, host oracle) | `reports/eval-2026-10-17T21-04-05-704Z.{md,json}`, published wiki `reports/memory-eval-20261017204530/` |
| **Result, reported as is:** all 8 held-out runs succeeded in both conditions, with 0 duplicates, misses or wrong deliveries. Memory did **not** improve outcomes on this task. Frontier models already solve it without memory (ceiling effect). Agents with memory read it (GLM avg 3.5, MiniMax avg 10 memory calls) and spent more turns and tokens (GLM 13 vs 9.5 turns, 122k vs 17k input tokens; MiniMax 21 vs 10 turns, 267k vs 29k). Failed API calls: GLM 3.5 vs 3.5, MiniMax 3.5 vs 4. A harder world, where first attempts usually fail, is needed to measure benefit | LIVE | same |
