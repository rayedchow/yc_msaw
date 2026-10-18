# Integration decision records

One document per integration, recording the **architecture decisions** behind it:
which provider APIs we use, how we detect changes, what we persist vs fetch live,
auth model, quota strategy, and — critically — the alternatives we rejected and why.

The code shows *what* we do; these docs preserve *why*, so the next person
(human or agent) doesn't re-litigate a settled decision or, worse, "fix" a
deliberate choice. Research that fed these decisions lives in
[`brain/evals/research/knowledge-base.md`](../../brain/evals/research/knowledge-base.md).

## Format

Each doc uses the same section shape per decision:

- **Decision** — what we do, in one or two sentences.
- **Why** — the constraints and evidence that forced it.
- **Alternatives rejected** — what else was on the table and why it lost.
- **Revisit when** — the concrete trigger that should reopen the decision.

Keep entries current: when you change an integration's architecture, update its
doc in the same PR. The `/integration-decisions` skill enforces this convention.

## Index

| Integration | Doc | Change detection | Content extraction |
| --- | --- | --- | --- |
| Google Docs | [google-docs.md](google-docs.md) | Drive Changes API cursor polling + Activity API; hourly comment-edit refresh | Docs API `documents.get` structured JSON (tabs + suggestions); ported OT changelog client for edit/suggestion attribution (writer+, unscheduled) |
| Gmail | [gmail.md](gmail.md) | Gmail History API (`historyId` deltas) | `messages.get` full payload |
| Google Calendar | [google-calendar.md](google-calendar.md) | `syncToken` incremental + push watch channels | `events.list` resources |
| Google Contacts | [google-contacts.md](google-contacts.md) | Full paged resync per cycle (no syncToken) | People API `connections.list` + `otherContacts.list`; names only, for Person entity naming |
| Notion | [notion.md](notion.md) | Webhooks + `last_edited_time` polling | Blocks API + markdown, bounded recovery |
| Granola | [granola.md](granola.md) | `updated_at` watermark polling | Public API / MCP client |
| Slack | [slack.md](slack.md) | Socket Mode accelerator + 120s polling floor; 300s conversation discovery | User-token Conversations API; channel-day markdown from `activity_events` |
| Jira | [jira.md](jira.md) | Nango sync webhooks + Nango record cursor paging | Generic capture for every model; Issue ADF markdown mirror |
| Confluence | [confluence.md](confluence.md) | Nango sync webhooks + Nango record cursor paging | Generic capture for every model; Page storage-format markdown mirror |
| Bitbucket | [bitbucket.md](bitbucket.md) | Nango sync webhooks + Nango record cursor paging | Generic capture for every model; PR/repo markdown mirror; commits raw identity only |
| GitHub | [github.md](github.md) | Nango sync webhooks + Nango record cursor paging | Generic capture for every model; issue/PR/repo markdown mirror; commits raw identity only |
| iMessage | [imessage.md](imessage.md) | Device agent push (no provider API) | Raw ingest from Mac agent |

Pending connectors (`src/integrations/_pending/`) get a doc when they graduate
to the launch registry.

Cross-cutting:
- [google-access-matrix.md](google-access-matrix.md) maps Google access across
  all three gating axes — auth method (OAuth / service account / DWD), per-file
  role (reader/commenter/writer), and account type (Workspace vs consumer).
  Read it before assuming a capability is scope-limited.
- [limits.md](limits.md) — every enforced cap, budget, and truncation across
  the system, split into content-affecting (fidelity) vs cost/pacing. Check it
  first when output looks incomplete.
- [sync-platform.md](sync-platform.md) — build-vs-buy: native lanes stay
  in-house; Nango is rejected for Slack/Google auth models but is the settled
  auth+transport lane for Atlassian/long-tail sources whose pre-built syncs
  match the product contract.
