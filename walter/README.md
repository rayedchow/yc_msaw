# walter

walter mines a company's tribal knowledge from its systems' history, compiles it into the company's own MCP server,
deploys it to Manufact, and checks it against history. GurtAI (a simulated HubSpot-style CRM with 22 months of history)
is the demo company.

Needs `.env` with `FIREWORKS_API_KEY` and `MANUFACT_API_KEY` (optional `MANUFACT_ORG_SLUG`). State, generated projects,
knowledge and evals live in `.walter/` (gitignored).

| Phase | Command | What it does |
| --- | --- | --- |
| 1 | `npx tsx walter/scripts/phase1-system.ts --deploy` | Builds the GurtAI system as an mcp-use project, checks it locally, deploys it to Manufact |
| 2 | `npx tsx walter/scripts/phase2-mine.ts` | Kimi (Fireworks) explores the hosted system, proposes rules as code; the host backtests every one month by month → `.walter/knowledge/sales.json` |
| 3 | `npx tsx walter/scripts/phase3-compile.ts` | Compiles knowledge into an mcp-use MCP and verifies its tools locally over MCP |
| 4 | `npx tsx walter/scripts/phase4-deploy.ts` | Deploys the MCP to Manufact, waits for the new build, replays history through it → `.walter/evals/sales.json` |
| 5 | `npx tsx walter/platform/server.ts` | The walter UI on http://localhost:4500 from real data; answering a question settles the rule, rebuilds and redeploys |
| 6 | `npx tsx walter/scripts/phase6-agent.ts` | GLM agent does GurtAI tasks with the raw CRM API vs the walter MCP, scored against history |

Layout: `system/` (GurtAI simulator), `mine/` (dataset, decisions, backtests, miner, settle), `compile/` (MCP generator
and server template), `deploy/` (mcp-use projects, Manufact CLI), `evals/` (history replays), `platform/` (API + views),
`pipeline.ts` (compile → deploy → evals). Tests: `npx vitest run walter/tests`.
