# Working in this integration repository

You are editing one integration MCP repository. The host owns Git state, tests
gates, promotion and deployment; you own the source.

- Edit files only through the integration file tools (or commands inside this
  repo). `.git/`, `node_modules/` (pre-baked, read-only) and `.mcp-use/` are host-owned.
- You work on the branch `codex/build-<build id>` the host checked out. Never try to
  rewrite history: reset, rebase, force-push, `git checkout --` of others' work and
  writes into `.git` are not available (the OS denies them).
- Inspect state with `integration_git_status` / `integration_git_diff` /
  `integration_git_log` before and after changes.
- Run `npm test` and `npm run build` with `integration_exec` while iterating. The
  sandbox has no network: tests must use local fixtures/fakes, never live APIs.
- `integration_validate` runs the sealed host gate on the exact working tree:
  policy scan, your tests, production build, MCP initialize/tools/list/call smoke
  from `integration.json`, and host-held regression/held-out cases you cannot see
  in advance. Only a passing validation can be committed with
  `integration_git_commit` (it must match the validated tree exactly).
- `integration_promote` marks a validated commit as the active revision; a failed
  repair never replaces the last passing revision.
- Record sources with `integration_record_research`; keep docs/research.md honest:
  tested facts vs inferences from traces/docs.
- Declare every tool in `integration.json` `tools` and every required environment
  variable (name only, `secret: true` for credentials). Never commit secret values.
- No new npm dependencies: only the pre-baked set (mcp-use, zod, tsx, typescript,
  @types/node) is available offline.
