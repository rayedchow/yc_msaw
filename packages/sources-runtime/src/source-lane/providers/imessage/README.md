# iMessage (Mac uploader receiver)

Receiver for the bundled Mac Messages uploader (`shepherd-onboard messages-agent`,
gigabrain@5448774e `packages/shepherd-onboard`). Port of gigabrain@5448774e
`brain/src/routes/imessage-ingest.ts` onto the source runtime's Postgres. There is no Aqueduct
receiver; the copied `src/integrations/imessage/{auth,connect}.ts` (global admin key with a
client-chosen `userId`) are not imported anywhere (guarded by `mac-config.test.ts`).

## Wire (unchanged for the Mac)

Served on the runtime's **public** host; the Mac's `apiUrl` is that host (`SOURCES_DEVICE_API_URL` in yc_msaw).

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| POST | `/api/imessage/ingest` | `{userId?, messages[≤10000], syncProgress?}` | donor counts `{stored, updated, skipped, rejected, total, …}` + `projection` |
| POST | `/api/imessage/ingest/sync-contacts` | `{userId?, contacts:[{handle,name}]}` | donor counts (graph fields are 0) |
| POST | `/api/imessage/ingest/local-status` | `{status}` | `{ok, status}` |
| GET | `/api/imessage/ingest/command` | — | `{command}` (oldest pending for this device) |
| POST | `/api/imessage/ingest/command/ack` | `{id, status, result?, error?}` | `{ok, command?, run?}` or `{ok, ignored:true}` |

Errors keep the donor `{error: string}`; transient failures contain "503" so the uploader's
retry classifier re-sends. A body `userId` is ignored: the tenant is the one inside the key.

**Why not on yc_msaw:** yc_msaw's mcp-use 2.10 HTTP layer runs a global JSON-body middleware
before any route and answers `GET /api/imessage/ingest/command` — which the uploader sends with
`Content-Type: application/json` and no body — with 400 `Invalid JSON`. yc_msaw therefore stays the
*authority* but not the host (proved in yc_msaw `tests/sources-imessage-device.test.ts`).

## Credentials and revocation

1. yc_msaw `POST /v1/sources/devices/imessage/setup` (WorkOS/OIDC principal with `traces:write`
   or `memory:build`) mints a `kind=device`, `transport=runtime-ingest` binding
   (`providers:["imessage"]`), derives `gimsg_<tenantNs>.<bindingId>.<secret>` from its one-time
   `psb_` token, enrols **sha256(key)** here (internal `POST /tenants/:t/devices/imessage`), and
   returns `messagesConfig {apiUrl, userId: tenantNs, agentToken, backfillDays?, allowedChatIds?}` once.
2. Every uploader request needs (a) an active `imessage_devices` row whose hash matches in
   constant time and (b) yc_msaw's confirmation, asked **per request** with the key itself:
   `GET <tenant binding publishUrl>/v1/sources/devices/imessage/verify` (`authority.ts`). No
   answer → 503, nothing stored. A refusal also revokes the row here (convergence).
3. `DELETE /v1/sources/bindings/:id` in yc_msaw revokes the binding (authoritative at once via 2b)
   and forwards `DELETE /internal/v1/tenants/:t/devices/imessage/:bindingId`, which revokes the
   row, cancels pending commands and fails their source-sync runs.
4. The key never authorizes MCP, admin or publish routes: MCP/admin auth do not accept binding
   tokens, and yc_msaw refuses `transport=runtime-ingest` bindings on `/v1/sources/publish`,
   `/blobs`, `/status-report`, so the Mac cannot write `sources/` files directly.

The namespace-wide runtime exporter binding (`PUT /tenants/:t/binding`) is separate and unchanged.

## Storage (drizzle `9550_imessage_device_ingest.sql`)

- `activity_events` (`source='imessage'`): donor payload shape and ids
  (`imessage:message:<GUID>`, legacy `imessage:<chatId>:<messageId>`), lifecycle
  `collected → mirrored`. Local-row ids (no GUID) are scoped per Mac (`deviceId`, else binding).
- `activity_event_source_aliases`: donor table; legacy/raw-chat ids → canonical row; donor
  duplicates are archived as `source='imessage_alias'` (kept, exported raw).
- `imessage_message_mutations`: exact previous payload before every in-place change (edits,
  unsends, alias evidence, reactions), journaled and exported.
- `imessage_ingest_rejections`: entries that could not be stored, verbatim; journaled, exported,
  and reported as partial coverage.
- `imessage_devices`, `imessage_device_commands` (durable, superseding, ack-once),
  `imessage_contacts`, `imessage_sync_progress`, `imessage_projection_dirty`.

One transaction per batch under a per-tenant advisory lock; a replayed batch is all `skipped`.
Older observations (late retry, second Mac) never roll back an edited/unsent state.

## sources/imessage/ layout

```
conversations/<name>-chat-<sha12>/<yyyy-mm>.md        projection (current text, edits, unsends, tapbacks, replies, attachment metadata)
conversations/<name>-chat-<sha12>/conversation.json   summary (raw chat ids, months)
contacts.json                                         address-book names synced by the Mac
_raw/<conversation>/<yyyy-mm>/<source event id>.json  activity_events row
_raw/<conversation>/<yyyy-mm>/_mutations/<id>/<at>-<mutation>.json
_rejected/<yyyy-mm>/<at>-<id>.json
```

The donor month renderer (`mirror.backfill` → `sources/imessage/<name>-chat-*/`) prints reaction
objects as JSON and ignores unsends; its rows are not exported.

## Local setup (no install performed here)

```sh
# 1. yc_msaw: mint the device (shown once). Use a WorkOS/OIDC token with traces:write.
curl -sS -X POST "$YC/v1/sources/devices/imessage/setup" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"label":"My Mac","backfillDays":30}' > setup.json
# 2. On the Mac: add the chats you chose, write the config from stdin (token never in argv).
jq '.messagesConfig + {allowedChatIds: ["iMessage;-;+15551234567"]}' setup.json \
  | npx -y -p askshepherd shepherd-onboard write-messages-config     # prints {configPath}
# 3. Separately, when ready to collect: install / run the agent.
npx -y -p askshepherd shepherd-onboard install-messages-agent --config "$CONFIG_PATH"
```

## Coverage (truthful)

- `device:<binding>:messages`: `complete` only after a validated all-history
  `messages_source_sync` receipt and an idle local status; otherwise `partial` / `pending`;
  `blocked` once revoked.
- `attachments`: always `partial`: the uploader sends metadata (name, type, size, transfer
  status), never bytes.
- `rejected-uploads` (`partial`) and `projections` (`pending`) when non-empty.

## Limitations

- Attachment bytes are not collected (uploader protocol has no byte upload).
- Contact names come only from the Mac's `sync-contacts`; raw payloads keep the uploaded `_resolved_name`.
- Coverage is limited to the chats the user selected on the Mac (`allowedChatIds`).
- If yc_msaw is unreachable the runtime refuses uploads (503) and the Mac queues locally.
