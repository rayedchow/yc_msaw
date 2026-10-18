# procmem: procedural memory for agents

Agents keep relearning the same lessons: pagination quirks, retry rules, which call creates duplicates. procmem captures what your agents actually did, and **once a day a recursive multi-agent build** turns those traces into two things:
1. a navigable **procedural-memory wiki**, which any agent on any model reads through a **filesystem-only MCP server**;
2. repaired or new **integration MCP servers**, which the build agents research, author, test, commit and publish to Manufact themselves.

**Live (staging):** parent MCP at `https://wild-zero-kq08i.run.mcp-use.com/mcp`, hosted on Manufact (org Askshepherd, ishan@askshepherd.ai), with WorkOS AuthKit OAuth. This is a provisioned hackathon staging deployment, not a production-ready SaaS. Adding a new third-party vendor still needs real credential setup. Every verified claim, with its report and LIVE/FIXTURE/PENDING label, is in **[docs/EVIDENCE.md](docs/EVIDENCE.md)**.

```
your agent ──(@procmem/sdk)──► POST /v1/traces ──► day-partitioned immutable traces (Modal Volume)
                                                        │  Modal Cron 00:20 UTC → POST /v1/builds/daily
                                                        ▼
                     recursive build harness (ported from AEye): root ─► children ─► grandchildren
                     Fireworks Kimi K3 / GLM 5p3 / MiniMax M3, one Modal sandbox per agent,
                     exclusive write scopes, reviewed exact-base merges, root-only publish
                        │                                         │
                        ▼ validated content-addressed revision    ▼ integration tools (research, repo,
any agent ──(MCP)──► $KNOWLEDGE (read-only wiki)                    validate, commit, promote, publish)
                     $WORK/scratch (private)                      ▼
                                                  child integration MCPs on Manufact
any agent ──(GET /v1/integrations + POST …/token)──► connect to a child MCP with a short-lived token
```

## The customer MCP (`/mcp`, filesystem-only)

Tools: `open_memory` (pins the latest revision into a workspace and returns only a small receipt: `status: "opened"`, `workspaceId`, revision id/publishedAt/page count and the entrypoint `$KNOWLEDGE/index.md`; no file contents, so agents then `read` the index and follow its links), plus `read`, `grep`, `find`, `ls`, `shell`, `poll_command`, `write_command`, `cancel_command`, `write`, `edit` and `view_file`, ported from the AEye workspace tools.

- `$KNOWLEDGE/…` is the published wiki. It is immutable (root-owned and read-only for the agent's uid).
- `$WORK/scratch/…` is private per caller and never published.
- `shell` runs in a Modal sandbox as uid 1000, with networking blocked, no secrets, deadlines and bounded output.
- `view_file` returns MCP image content for scratch images, identified by magic bytes.
- There are no traces, inputs, builder or integration tools on `/mcp`.
- Every tool needs `memory:read`. WorkOS users get it implicitly on their own tenant (org or subject); static keys must carry it.
- Pass the `workspaceId` that `open_memory` returned. When you have several open workspaces, omitting it is refused rather than guessed.

The wiki is a recursive subject wiki, not a journal:
- every directory has an `index.md` linking each child with context
- `foo.md` is promoted to `foo/index.md` plus focused children when it grows
- there is no `plan.md` and no `status/`
- evidence is cited as `<sessionId>#<seq>`, and client-reported outcomes are kept distinct from host-verified ones

## Integration MCPs (separate HTTP surface)

```bash
# list child MCPs the build published for your tenant (scope integrations:read)
curl -H "Authorization: Bearer $TOKEN" https://wild-zero-kq08i.run.mcp-use.com/v1/integrations
# short-lived EdDSA token bound to tenant + integration audience, plus the child URL
curl -X POST -H "Authorization: Bearer $TOKEN" https://wild-zero-kq08i.run.mcp-use.com/v1/integrations/notify-hub/token
# -> { "mcpUrl": "https://<child>.run.mcp-use.com/mcp", "token": "<jwt>", "expiresAt": ... }
# then point any MCP client at mcpUrl with  Authorization: Bearer <jwt>
```

Token errors are typed:
- `404 integration_not_found`: no live integration with that slug for your tenant.
- `503 child_auth_not_configured` (`retryable:false`): this host cannot mint child tokens; `GET /v1/integrations` then reports `childAuthConfigured:false`.
- `502 token_failed` (`retryable:true`): a transient failure.

## Live tool exposure (SDK): every tenant MCP in one place, updated without restarts

You don't have to wire each child by hand. The SDK keeps a **live registry** of every tool your tenant can use:
- the memory tools from `/mcp`, prefixed `memory__*`;
- the tools of every live integration MCP from `GET /v1/integrations`, prefixed `integration__<slug>__*`.

When the daily build adds, updates or retires an integration, the registry picks it up on its next catalog poll (default 30 s). Integration tools are added, their schemas replaced, or removed inside the **same harness session and the same MCP connection**. No restart is needed.

The parent `/mcp` itself stays filesystem-only; aggregation happens in the SDK on the client side.

- **`@procmem/sdk/live`:** `startLiveTools({ parent: { baseUrl, credential } })` returns a `LiveToolRegistry` with:
  - `getTools()` (full input schemas);
  - `onToolsChanged()` (added / updated / removed);
  - `callTool(name, args)`, which returns the MCP `CallToolResult` verbatim.

  Calls to a removed tool fail closed. A call that may already have executed is never replayed.
- **`@procmem/sdk/live/pi`:** `createPiLiveTools(registry)` returns a Pi extension. It applies tool changes only at a safe turn boundary of the running Pi session, keeps unrelated tools, and keeps tools the user disabled disabled.
- **`procmem-live-mcp` (stdio bin):** a single MCP server for any MCP client. It exposes every live tool and emits `notifications/tools/list_changed`. It is configured only from the environment:
  - `PROCMEM_BASE_URL`;
  - one credential source: `PROCMEM_API_KEY`, `PROCMEM_TOKEN_FILE` or `PROCMEM_OAUTH_CONFIG`.

  Legacy clients that ignore `list_changed` keep the two fixed fallback tools, `procmem_list_live_tools` and `procmem_call_live_tool`. Through them they can discover and call current tools, but they will not see new tools as individual entries until they reconnect.
- **Credentials:**
  - The parent credential is a callback fetched fresh for every request. After a pre-execution 401 the registry calls `onUnauthorized(rejectedToken)` once and retries only that request.
  - Child integration tokens are short-lived EdDSA JWTs (900 s), minted per child and renewed automatically.
  - Bearer tokens are only ever sent to their own origin, and redirects are refused.
- **Retirement:** a retired integration disappears from the catalog and its tools are removed on the next poll. A child JWT that was already issued stays valid until it expires (at most 900 s) unless that child deployment is stopped.

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { startLiveTools, oauthParentCredential } from "@procmem/sdk/live";
import { createOAuthRefreshProvider, FileTokenStore } from "@procmem/sdk/oauth";

const oauth = createOAuthRefreshProvider({
  tokenEndpoint: "https://sincere-umbrella-45-staging.authkit.app/oauth2/token",
  clientId: "<your OAuth client id>",
  resource: "https://wild-zero-kq08i.run.mcp-use.com/mcp",
  store: new FileTokenStore(join(homedir(), ".procmem", "oauth.json")), // seeded once from your existing OAuth login (0600)
});
const registry = await startLiveTools({ parent: { baseUrl: "https://wild-zero-kq08i.run.mcp-use.com", ...oauthParentCredential(oauth) } });
registry.onToolsChanged((c) => console.log("tools changed", c));
```

**OAuth refresh (`@procmem/sdk/oauth`).**
- What it does: `OAuthRefreshProvider` keeps an existing OAuth grant alive.
  - Parent WorkOS access tokens last 300 s. The provider refreshes them before expiry and rotates the refresh token.
  - It persists tokens atomically to a `FileTokenStore` (0600), coordinates processes with a file lock, and shares one refresh across concurrent callers.
  - When the grant is no longer usable it fails closed with `reauthRequired`.
- What it doesn't do: it ships **no login UI**. Reuse the grant your MCP client's OAuth/DCR login already produced.

Full API and review notes: `docs/sdk-live-tools.md`, `docs/sdk-oauth.md`.

## Results (live, see docs/EVIDENCE.md)

- **Hosted end to end:** 64/64 checks. A scoped SDK upload triggered a real hosted daily build (Kimi + Modal), which published a new revision; a fresh FS-MCP client then read it, used scratch and the sandboxed shell.
- **Hosted WorkOS OAuth:** 10/10 checks, fullyAuthenticated.
- **Recursive delegation:** root → 3 children → 1 grandchild, every handoff reviewed and accepted, root-only publish (`reports/build-live-depth2.json`). In ordinary builds the root decides whether to delegate.
- **LLM-authored integration repair:** a Kimi build agent repaired a faulty notify-hub integration from traces, without any scripted step after setup. It added cursor pagination, a stable Idempotency-Key, and 429/503 retries. Host suites passed: regressions 6/6 and sealed held-out 4/4. The agent committed, promoted and published the update to Manufact itself; the live probe passed.
- **Hosted integration access:** an operator imported the unmodified LLM-generated integration into the hosted staging tenant. Through the real parent, the catalog and token exchange work, and the child MCP lists its tools and returns all 23 notifications (`reports/hosted-integration-import.json`; labeled OPERATOR IMPORT).
- **Live tools, real Pi, three models:** in one Pi session each, Kimi K3, GLM 5p3 and MiniMax M3 went through four steps on real Fireworks over the real MCP protocol. The orders and billing services were simulated.
  1. They used the initial orders tool.
  2. A billing `get_invoice` tool was added, and they used it.
  3. The orders schema gained a required `region` argument, and they used the new argument.
  4. Billing was removed. They reported it unavailable without inventing results and without calling the child.

  Full SDK traces were captured. This test makes no efficiency claim (`reports/sdk-live-tools-pi-live.json`).
- **Live tools against the hosted parent:**
  - With a read-only static key, the SDK exposed 12 memory tools and 4 tools from the LLM-generated child: 16 direct tools.
  - The stdio bridge listed 18 tools (the 16 plus 2 fallbacks), with real `list_changed` and real read-only calls (`reports/sdk-live-tools-hosted.json`).
  - This report does not test OAuth refresh.
- **OAuth refresh, live:** the SDK provider refreshed a real existing WorkOS grant with no new consent.
  - 8 concurrent calls across 2 provider instances caused exactly one issuer refresh, ending with one token.
  - The refresh token rotated; the new access token expires in 299 s, and both CLI credential aliases were updated atomically. A follow-up `tools/list` returned 12 tools (`reports/oauth-sdk-refresh.json`).
  - In a separate composed check, the live registry ran on that refreshed OAuth credential (not a static key): catalog and child-token exchange worked, and real read-only memory and child calls succeeded (`reports/sdk-live-tools-oauth-hosted.json`).
- **Real upstream repair loop (GitHub, one build cycle):** separate from the synthetic NotifyHub/CRM worlds. A host-seeded `github-read` child sent `?ref=master`, so one Pi session (Kimi K3) got a real GitHub 404. That failure trace fed a real daily build, whose agents authored the MCP fix and a memory update and published a new child. The SDK and Pi applied the new tool automatically; the **same Pi object, process and history** reread the new memory, called with `ref: v1.5.0`, and got GitHub 200 with the SHA an independent host check saw (`reports/real-integration-e2e-e2e-20261018T003409-5fec.{md,json,html}`, plus `-metadata-audit`). Only one real repair cycle ran. The demo controller can feed a genuine post-repair failure into up to 3 cycles (source and tests); in production, customer failures enter the next daily build, not an instant build per tool error.
- **Conversation correlation and durable outbox:** conversation/run/turn/span correlation and lost-ack dedup survive a real OS-process restart on Modal storage (`reports/sdk-conversation-modal-smoke.json`, 13/13) and work over the hosted wire, including old-SDK compatibility (`reports/sdk-conversation-hosted-wire-smoke.json`, 13/13).
- **Trace viewer:** an AEye-style workbench (`demo-ui/`, served by `scripts/serve-demo-trace.ts`) shows each agent's messages and tool calls, with a nested Files tree, per-file diffs and rendered Markdown.
- **CRM generalization (active, no results yet):** exploratory benchmark with real Pi/Fireworks agents and real Modal builds against synthetic vendor fixtures; protocol in immutable manifests plus a recorded amendment. See `docs/crm-evaluation.md`; final results are pending.
- **Memory reuse eval (honest):** on the simulated notification world, GLM 5p3 and MiniMax M3 succeeded in 100% of held-out runs **with and without** memory. Memory did not improve outcomes on this task (ceiling effect) and cost extra turns and tokens. A harder task is needed to show benefit.

## Setup

Node ≥ 22.22.2 for this repo (the minimum for the installed mcp-use). The SDK alone runs as a standalone MCP client on Node ≥ 20; the Pi adapters need Node ≥ 22.19.

```bash
npm ci
cp .env.example .env      # FIREWORKS_API_KEY etc. (never committed)
npm run typecheck && npm test && npm run build
```

Local dev (loopback, directory store, Modal sandboxes for shell): `PROCMEM_STORE=directory npm run dev`, then use `http://localhost:3000/mcp`.

MCP client config. OAuth clients discover WorkOS from the 401 challenge. Headless clients use a static key from `npx tsx src/auth/keygen.ts --tenant <tenant> --scopes memory:read`:

```json
{ "mcpServers": { "procmem": { "url": "https://wild-zero-kq08i.run.mcp-use.com/mcp",
  "headers": { "Authorization": "Bearer pmk_..." } } } }
```

## Capture traces (SDK)

`@procmem/sdk` 0.1.0 is **not published to npm**. Install it from the packed tarball (the host installed it into a clean consumer project and verified it):

```bash
npm run sdk:pack                                   # -> artifacts/procmem-sdk-0.1.0.tgz
cd your-agent && npm install /path/to/procmem-sdk-0.1.0.tgz
```

```ts
import { TraceRecorder, HttpTraceTransport } from "@procmem/sdk";
import { attachPiTraceCapture } from "@procmem/sdk/pi";   // optional, Pi agents

const recorder = new TraceRecorder({
  transport: new HttpTraceTransport({ baseUrl: "https://wild-zero-kq08i.run.mcp-use.com", token: process.env.PROCMEM_API_KEY! }),
  agent: { id: "billing-agent", model: "kimi-k3" },
});
const session = recorder.begin({ objective: "Recover failed notifications" });
session.toolCall("deliver", { id: "n-4" }, "call-1");
session.toolResult("deliver", "call-1", { status: 503 }, true);
await session.finish({ status: "succeeded", summary: "all eligible delivered once" });
```

SDK entry points:

| Entry | Purpose |
|---|---|
| `@procmem/sdk` | Trace capture (`TraceRecorder`, transports) |
| `@procmem/sdk/pi` | Pi trace adapter (`attachPiTraceCapture`) |
| `@procmem/sdk/live` | Live tool registry |
| `@procmem/sdk/live/pi` | Hot tools for Pi |
| `@procmem/sdk/oauth` | OAuth refresh provider and token stores |
| `procmem-live-mcp` | stdio bridge (bin) |

`attachPiTraceCapture(piSession, session)` records every model request (system prompt, tool schemas, transformed messages, minus credentials), outputs, tool calls and usage. Large payloads are content-addressed and never truncated. Redaction is opt-in.

## Components

| Path | What |
|---|---|
| `src/sdk/` → `packages/procmem-sdk` | Trace SDK (recorder, transports, Pi adapter); `live/` registry, Pi hot tools, stdio bridge; `oauth-refresh.ts` OAuth refresh provider |
| `src/traces/` | Tenant-isolated ingest by receipt day (UTC); immutable daily manifests with catch-up; `materializeCohort`; `buildTraceArchive` (all retained traces → read-only builder `sources/`, see `docs/builder-trace-archive.md`) |
| `src/harness/` | AEye-ported recursive build harness (`spawn_agents`, `wait_agents`, `read_agent_result`, `decide_agent_results`, `complete_task`, `publish`). Budgets maxDepth 4, maxChildren 32, maxDescendants 32, maxTurns 24, maxToolCalls 64. ToolProvider hook that registers the integration runtime. Every agent reads `inputs/` (today's cohort) and `sources/` (all history); in Modal a `shell` tool runs as a separate uid for which every area is read-only |
| `src/daily/` | Daily build service: manifest pin, lease-fenced claim, heartbeat, crash recovery, catch-up, durable receipts |
| `src/store/` | `ObjectStore` (immutable objects, listing, CAS refs). Modal Volume backend with a Dict create-only lock and multipart up to 32 MiB (`modal_worker/store_app.py`). `MemoryRepo` content-addressed revisions |
| `src/customer/`, `src/sandbox/` | Customer FS workspace; Modal sandbox lease (protected trees, uid 1000, command handles) |
| `src/auth/` | WorkOS AuthKit / OIDC on mcp-use OAuth (protected-resource metadata, JWKS, iss/aud/exp), tenant namespaces, static scoped keys |
| `src/server.ts`, `src/app.ts`, `index.ts` | Parent MCP plus `/v1/traces/*`, `/v1/builds/daily`, `/v1/builds/:id`, `/v1/integrations*`, `/health`, `/healthz` |
| `src/integrations/` | Integration research, per-repo Git in Modal, sealed validation, promotion, Manufact publisher, child auth (see `docs/integrations.md`) |
| `modal_worker/daily_cron.py` | Modal Cron 00:20 UTC → each tenant's parent build endpoint, with bounded catch-up |
| `eval/` | Pi agents on Fireworks against a host-owned notification world with a deterministic oracle |

## Deploy

```bash
npm run modal:deploy           # procmem-store + procmem-daily
npm run build && npm run deploy:check && npm run build:check-integrations
npx mcp-use deploy --no-github --name procmem-yc --org org-84350150-jpcs9 --env-file <protected env file>
```

Production env:
- core: `HOST=0.0.0.0`, `PROCMEM_STORE=modal`, `PROCMEM_SANDBOX=modal`, `AUTH_MODE=workos`, `WORKOS_AUTHKIT_DOMAIN`, `MCP_PUBLIC_URL`
- integrations: `PROCMEM_INTEGRATIONS=required`, `PROCMEM_INTEGRATION_DEPLOY=1`
- credentials (host-side only): Modal, Fireworks, Exa, `MCP_USE_API_KEY`, `INTEGRATION_CHILD_SIGNING_JWK`

`npm run deploy:check` reproduces the CLI's upload selection. The CLI has no deploy-specific ignore file, so `.github/workflows/ci.yml` is uploaded too. If the managed repository refuses workflow files, run `npx tsx scripts/check-deploy-tree.ts --stage <empty dir>` and deploy that directory: it holds the same files minus `.github/`, plus the server link.

Manufact containers are ephemeral. All durable state lives in the Modal Volume, and a cold container restores the same revision. The server refuses a public bind without Modal store and sandbox plus auth. Do not set `MCP_ALLOWED_HOSTS` behind Manufact: edge probes use internal Host headers. See `docs/auth.md` for the WorkOS resource indicator.

## Verification

- **CI** (`.github/workflows/ci.yml`, Node 22, read-only permissions, no secrets): typecheck, offline tests, `mcp-use build`, archive check, SDK pack (tgz uploaded as an artifact).
- **Live scripts** (need credentials):
  - `npm run modal:smoke`
  - `npm run durability:smoke`
  - `npm run auth:smoke`
  - `npm run build:check-integrations`
  - `npx tsx scripts/eval-e2e.ts`
  - `npx tsx scripts/integration-llm-run.ts`
  - `npx tsx src/harness/live-smoke.ts --depth2 --modal`

## Limits

- Memory benefit is **not demonstrated** on the current eval world (ceiling effect). Structural wiki validation proves navigability, not correctness; task success comes only from the external oracle.
- Children can fail (one live child ended `no_progress`). The root then reviews and covers the branch itself, but there is no automatic retry of a failed child.
- In-process build jobs do not survive a container restart. The lease expires, and the next trigger supersedes the manifest and rebuilds, without losing or double-processing chunks.
- A crashed CAS lock holder stalls that ref until an operator clears it (fail closed).
- mcp-use 2.10's Node bridge buffers request bodies before our routes run; the raw size bound is left to the hosting edge.
- The scheduled 00:20 UTC cron firing has not been observed yet; manual invocation of the same function is verified.
- Local sandbox mode is for trusted offline tests and cannot execute commands.
- This is a staging deployment for a hackathon, not a production SaaS. Each new third-party integration needs real vendor credentials configured on the host; the notify-hub demo uses a simulated service.
- Live tools: clients that ignore `list_changed` only get the two fallback tools. A retired child's already-issued JWT stays valid for up to 900 s unless that deployment is stopped.
- Staging only: the current deployment is verified on Manufact (webhook deployment `5fa7a319…`, managed commit `80d2408e…`, runtime source `dbaa472`; see `reports/parent-delegation-deploy-verification.json`; earlier `f5390025…` in `reports/deploy-final.json` is historical), but this is not a production-hardened SaaS.
