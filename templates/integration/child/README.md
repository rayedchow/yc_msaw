# {{title}} MCP

{{description}}

Generated and maintained by the procmem integration builder. This repository is
an independent Git repository (mcps/{{slug}}/) and a runnable mcp-use v2 server.

- `npm run build` / `npm start` — production build and server (`mcp-use`).
- `npm test` — deterministic tests (`tsx --test`).
- `integration.json` — declared tools, environment variables (names only) and smoke cases.
- `docs/research.md` — sources consulted, with hashes.

Deployment is host-owned (Manufact managed upload of an exact, validated commit).
Required environment variables are listed in `integration.json`; values are
configured by the host publisher, never committed.
