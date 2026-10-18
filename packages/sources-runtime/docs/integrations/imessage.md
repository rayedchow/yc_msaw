# iMessage

Code: `src/integrations/imessage/` (currently a library; the raw-capture lane
is pending its standalone ingest endpoint — see the launch note in
`src/integrations/registry.ts`). Identity helpers exist but are unconsumed
until that endpoint wires device pushes into capture.

## Model: device-agent push, not provider polling

**Decision.** iMessage data is **pushed to us** by an agent running on the
user's Mac (reading the local Messages store), authenticated with a per-user
agent token (`gimsg_` prefix, 32 random bytes, base64url). There is no
provider-side polling loop.

**Why.** Apple exposes no iMessage API — the only access path is the local
`chat.db` on a signed-in Mac. That inverts the architecture: instead of us
holding provider credentials and polling, the device holds the data and pushes
to an ingest endpoint. This is the one integration where aqueduct is the
server, not the client.

## Auth and safety

- Agent tokens are stored encrypted in `integration_tokens` and verified with
  timing-safe comparison against an in-memory map (60s TTL cache) —
  `auth.ts`. Admin vs agent token kinds are distinguished so device agents
  can't perform management operations.
- `blocked-handles.ts` filters conversations the user has excluded before
  anything is persisted.
- Conversation and event identity are derived deterministically
  (`conversation-identity.ts`, `event-identity.ts`) so replays and re-pushes
  from the device dedupe instead of duplicating events.

**Revisit when.** The standalone ingest endpoint ships (registry note), or the
device agent gains local change-detection beyond full-table diffing.
