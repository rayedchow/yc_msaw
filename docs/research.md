# Research and attribution

Patterns adapted (not copied wholesale) from private askshepherd repositories, read via `gh api`. No customer data, secrets, or deployment machinery were copied.

| Source | What we adopted | Where |
|---|---|---|
| `askshepherd/aeye-shepherd` `src/agent/workspace_agent.ts` — `KNOWLEDGE_ORGANIZATION_CONTRACT`, `CHILD_WORKSPACE_ISOLATION`, `SpawnAgentsSchema` / `DecideAgentResultsSchema` / `CompleteTaskSchema` | Recursive subject-wiki contract (one purpose per page, `foo.md` → `foo/index.md` promotion, every directory has `index.md`, repair parent indexes and cross-links, no catch-alls); root/child/grandchild delegation with exclusive `knowledgeWriteScope`, `includeParentDraft` read-only snapshot, explicit accept/reject of handoffs, only the root publishes | `src/harness/contract.ts`, `src/harness/*` |
| AEye publication gate (page character maximum, "split semantically, never at offsets") | Editorial page-size validation with the same guidance | `src/wiki/validate.ts` |
| AEye `src/pipeline/workspace_model.ts` `defaultWorkspaceRootInvestigationBudget` | Budget defaults: maxDepth 4, maxChildren 32, maxDescendants 32, maxTurns 24, maxToolCalls 64, maxInputBytes 128 MiB, maxOutputBytes 16 MiB | `src/harness/budget.ts` |
| AEye `src/mcp/server.ts` workspace tools (`read`, `grep`, `find`, `ls`, `shell`, `poll_command`, `write_command`, `cancel_command`, `write`, `edit`) | Customer MCP filesystem surface: frozen `$KNOWLEDGE`, private `$WORK/scratch`; source/evidence/ask tools deliberately excluded | `src/customer/*`, `src/server.ts` |
| AEye/Silicon Modal sandbox code (`modal_agent_sandbox.ts`) and architecture "Filesystem authority" | Unprivileged uid, root-owned read-only trees verified at setup, network blocked, no inherited credentials, bounded time/output, terminate in `finally` | `src/sandbox/modal.ts` |
| Silicon checkpoint store (`modal_workspace_checkpoint_store.ts`) | Content-addressed manifests, digest-verified restore, authority via CAS rather than last-writer-wins | `src/store/*`, `modal_worker/store_app.py` |
| gigabrain `materialize-memory-filesystem.ts`, aqueduct `materializer.ts` | Plain Markdown/JSON trees with stable indexes as an agent-readable surface; deterministic paths by identity | trace cohort layout (`src/traces/daily.ts`) |

External SDKs and docs (versions pinned in `package-lock.json`):

- mcp-use 2.10 (`MCPServer`, `oauthWorkOSProvider`, `oauthCustomProvider`, `createJwtVerifier`), Manufact deploy via `mcp-use deploy` (https://docs.manufact.com/cli/deploy, https://github.com/mcp-use/hack-yc).
- Modal JS SDK 0.11 (Sandboxes, `functions.fromName().remote()`), Modal Python 1.5.1 (Volume, Dict, Cron).
- Pi coding agent SDK 1.3 (`@earendil-works/pi-coding-agent`: `createAgentSession`, built-in MCP extension).
- Fireworks OpenAI-compatible chat completions; model ids taken from the live `GET /inference/v1/models` list (Kimi K3, GLM 5p3, MiniMax M3).
- WorkOS AuthKit MCP authorization (protected-resource metadata + JWKS-verified access tokens).
