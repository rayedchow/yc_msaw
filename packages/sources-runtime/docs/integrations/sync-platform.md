# Sync platform: build vs buy

Cross-cutting decision covering all connectors. Evaluated 2026-07-05 against
Nango (nango.dev) as the representative hosted-sync platform, prompted by
their pre-built Slack syncs.

## Platform: native lanes stay in-house; Atlassian uses Nango

**Decision.** Native connectors run our own sync machinery end to end:
OAuth/token storage in `integration_tokens` (encrypted), scheduling via the
per-`group_key` task queue (`src/queue/queue.ts`), hand-rolled per-method rate
limiting, and persistence directly into `activity_events` + the mirror.

**Amendment, 2026-07-07.** Nango is the settled auth+transport lane for Jira
and Confluence (and the same lane is intended for Bitbucket/GitHub). Nango
records do not become a product data shape: every model is immediately
captured into `activity_events` with redaction and outbox emission, and only
selected high-value models get mirror docs now.

**Amendment, 2026-07-07 (polling floor).** Record ingestion from Nango is
driven by a scheduled floor, not by webhooks: a `nango.poll` task schedule
(300s, one per tenant×provider, group `<tenant>:nango:<provider>`) enqueues
`nango.sync_records` for every active connection × registered processor model
(`registeredModelsForProvider`, enumerated from the live processor registry so
the floor and processors cannot drift). Sync tasks resume from the STORED
cursor, so a floor tick with no changes is a cheap incremental no-op. The
Nango sync webhook remains an accelerant only — floor and webhook enqueues
share the same dedupe key (`nango:sync_records:...:start` for cursor-less
payloads) and collapse to one task. This is load-bearing for the lane split:
one Nango environment serves both lanes but its webhook endpoint points at ONE
lane; the other lane gets data exclusively from the floor. The schedule starts
on connect and on auth-webhook reconciliation to `active`, and is disabled on
disconnect and on reconciliation to `revoked`.

**Amendment, 2026-07-08 (pull auth reconcile).** Nango auth/connection webhooks
are not required for a connection to become usable. Dashboard status polling
and the `nango.poll` floor call Nango's connections API and match remote
connections whose `end_user.id` is the tenant id. A matching local
`pending`/`error` row is promoted to `active`, stores the Nango `connection_id`,
starts the polling floor, and enqueues the initial record fan-out immediately.
The auth webhook path remains only an accelerant and uses the same activation
fan-out.

**Why.** Hosted sync platforms sell two layers: (1) generic infrastructure —
hosted auth, scheduling, retries, a records cache with change detection,
webhooks to the consumer — and (2) pre-built provider sync functions, which is
where the actual time savings live. Layer 2 is written against specific auth
modes, and our settled auth constraints reject those modes on both providers
that matter:

- **Slack.** Nango's pre-built messages sync runs on the **bot token**
  ("conversations the bot can access"): no user DMs, no private channels the
  bot isn't in, duplicate channel data when multiple users in one workspace
  connect. Our design is user-token per user (see
  `src/integrations/slack/connect.ts`) precisely to capture per-user
  visibility including DMs. Nango supports user tokens only as an escape
  hatch — extract `credentials.raw.authed_user.access_token` and override the
  proxy auth header — with no documented pre-built-sync support. Their
  messages sync also resyncs a sliding 10-day window, so edits/deletes/
  reactions on older messages drift; our watermark poller
  (`src/integrations/slack/poller.ts`) plus Socket Mode
  (`realtime.ts`) doesn't have that gap.
- **Google Workspace.** We are DWD-only (per-user OAuth deliberately
  disabled — see `CLAUDE.md` and `google-access-matrix.md`). Nango has a
  `google-service-account` provider with a per-connection "Delegated Access
  Email" (one connection per impersonated user), but their pre-built
  Gmail/Calendar syncs attach to the OAuth `google-mail`/`google-calendar`
  integrations, not the service-account provider. Using DWD means writing
  custom sync functions anyway — and our Google sync logic (suggestion/tab
  intelligence, Activity API attribution, live-tested edge cases) is exactly
  the part already built.

With layer 2 discarded, what remains is infrastructure we already have
equivalents for, purchased at real cost:

- **Data residency.** Synced records (customer Slack messages, Gmail bodies)
  persist in the platform's record store before we pull them. For a
  data-transport product this is a sales/security-review liability, and
  invariants like `contentUri`-never-persisted (see `google-docs.md`) would
  have to hold inside a third party's cache we don't control.
- **Key custody.** DWD requires handing the platform the customer's
  service-account private key — a domain-wide skeleton key — replicated
  across every per-user connection. Categorically worse than holding it
  ourselves.
- **Provisioning.** One-connection-per-impersonated-user means minting and
  reconciling N platform connections per customer as employees join/leave;
  Nango's connection-import API is documented as "mostly meant for one-off
  bulk imports," not a provisioning surface.

**Alternatives rejected for native lanes.**

- *Nango with pre-built syncs as-is for Slack/Google* — requires bot-token Slack visibility
  and per-user Google OAuth; both contradict settled product/auth decisions.
- *Nango with custom sync functions (our logic on their runtime)* — keeps our
  auth model but we maintain the same provider logic in their SDK, gaining
  only hosted scheduling/retries we already have (task queue, watermarks,
  rate-limit buckets), while paying the residency/key-custody costs above.
- *Nango for auth brokering only (no record store)* — thinnest slice, but
  Slack user tokens are second-class there, DWD key custody still transfers,
  and token storage is the cheapest part of what we've built.

**Revisit when.** (a) Nango (or a competitor) ships first-class user-token
Slack syncs or service-account-native Gmail/Drive/Calendar syncs with
customer-controlled data residency (e.g. self-hosted record store); (b) we
need to add many long-tail connectors (5+) whose pre-built syncs *do* match
our auth model and the queue/watermark boilerplate becomes the bottleneck; or
(c) provider auth churn (token refresh, rate-limit upkeep) becomes a
measurable operational drain.

For Atlassian, this revisit already happened: the connector value is in
complete capture and mirror rendering, not bespoke OAuth transport. The live
gate is Nango-specific payload verification, not another platform decision.

Research context: `brain/evals/research/knowledge-base.md` — "Nango as hosted
sync platform (build-vs-buy)" entry, 2026-07-05.
