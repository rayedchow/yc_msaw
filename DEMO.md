# Demo walkthrough (about 5–6 minutes, using artifacts prepared in advance)

Long steps are run **before** the demo; the table shows their measured durations. Only the quick steps run live on stage.

| Step | Live on stage? | Measured duration |
|---|---|---|
| Hosted e2e smoke (SDK upload → hosted daily build → MCP) | optional | 152 s |
| Depth-2 recursive build | no (show report) | 6.2 min |
| LLM integration repair + publish | no (show report + live child) | 9.8 min |
| Full Pi train → daily build → held-out eval | no (show report) | ~25 min total (build 15.7 min) |
| SDK live tools in one Pi session (3 models) | no (show report) | prepared run |
| SDK OAuth refresh against WorkOS | no (show report) | prepared run |

1. **The problem (30 s).** Agents repeat the same API mistakes: they stop at page 1, retry without idempotency, ignore Retry-After. Show the two synthetic customer traces in `reports/integration-llm-run-20261017-5a8be8.json` (`cohort`): a truncated audit, and a duplicate send after a lost ack.

2. **Capture (30 s).** Show the `@procmem/sdk` snippet in the README, installed from the tarball with `npm run sdk:pack`. The Pi adapter records the full model request (system prompt, tool schemas, messages). Traces are partitioned by day and immutable.

3. **The daily build is a team of agents (60 s).** Open `reports/build-live-depth2.json`:
   - a Kimi K3 root delegates `billing/**`, `deploy/**` and `search/**` to GLM children
   - the billing child delegates `billing/refunds.md` to a grandchild
   - each handoff is a reviewed patch accepted with an exact-base merge, and only the root publishes the validated revision
   - every agent ran in its own Modal sandbox
   
   Then show the resulting wiki (`index.md` → subject directories) and a page citing `ses-…#seq`.

4. **The build fixes integrations itself (60 s).** In `reports/integration-llm-run-20261017-5a8be8.json`, the build agent read the faulty notify-hub repo and edited the client: cursor pagination, a content-derived Idempotency-Key, and retries for 429/503. It then ran `npm test`, validated against host suites (regressions 6/6, sealed held-out 4/4), committed, promoted, and called `integration_publish`. The result is the live child `https://warm-cloud-e1lye.run.mcp-use.com/mcp`, whose probe passed. The setup revision was scripted; everything after it was model-authored.

5. **Any agent reads memory (60 s, live).** Connect an MCP client to `https://wild-zero-kq08i.run.mcp-use.com/mcp`. WorkOS OAuth runs through discovery, DCR and consent. Then:
   - `open_memory` → small "opened" receipt (workspaceId + pinned revision, no contents)
   - `read $KNOWLEDGE/index.md`, then follow links
   - `read $KNOWLEDGE/...`
   - `write $WORK/scratch/notes.md`
   - `shell "id -u; touch $KNOWLEDGE/x"`, which shows uid 1000 and a read-only error
   
   Point out that `/mcp` exposes filesystem tools only. Evidence for the deployed build: `reports/auth-manufact-final.json` (10/10, fullyAuthenticated) and `reports/deploy-final.json`.

6. **Every tenant MCP, updated without a restart (45 s).** Open `reports/sdk-live-tools-pi-live.json`. In one Pi session per model (Kimi, GLM, MiniMax), with simulated orders and billing services:
   - a billing tool appears and gets used;
   - the orders schema gains a required `region`, and the model passes it;
   - billing is removed, and the model says it is unavailable instead of inventing a result.
   
   Then `reports/sdk-live-tools-hosted.json`: against the hosted parent the SDK exposes 12 memory + 4 child tools; the `procmem-live-mcp` stdio bridge adds 2 fixed fallback tools for clients that ignore `list_changed`. `/mcp` itself stays filesystem-only.

7. **Tokens keep themselves fresh (15 s).** `reports/oauth-sdk-refresh.json`: WorkOS access tokens last 300 s. 8 concurrent calls across 2 SDK instances caused exactly one refresh, and the rotated refresh token was persisted atomically, with no new consent. `reports/sdk-live-tools-oauth-hosted.json` shows the live registry running on that refreshed credential. There is no login UI: the SDK reuses the grant from your existing OAuth login.

8. **Honest results (30 s).** `reports/eval-2026-10-17T21-04-05-704Z.md`: held-out GLM and MiniMax agents succeeded 100% with and without memory. On this task memory did not help and cost extra turns and tokens. The next step is a harder world. `docs/EVIDENCE.md` labels every claim as LIVE, FIXTURE or PENDING.

Offline fallback (no credentials): `npm test` covers the scripted e2e (SDK → ingest → build → MCP), scripted recursion, conflicts, page promotion, the daily lease and recovery, and auth.
