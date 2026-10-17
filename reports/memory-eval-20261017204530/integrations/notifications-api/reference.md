# Notifications API reference

HTTP-style JSON tools for a notification service. Tool results are objects with `http_status`, `headers`, and `body` (train-train-day1-a-kimi-k3-no-memory-r1-mvcv8p7t#3). Used for outage recovery: re-delivering failed notifications exactly once.

## Tools / endpoints

### `list_notifications` — GET /notifications
- Params: `status` (required: `failed` | `failed_permanent` | `delivered` | `pending`), `channel` (optional, e.g. `email`, `sms`, `push`), `cursor` (opaque, from a previous response's `next_cursor`), `limit` (page size; server maximum applies).
- Body: `{ "data": [ {id, status, channel, recipient?, created_at, last_error}, ... ], "next_cursor": <string|null> }`. `next_cursor` is `null` on the last page (A#27).
- Paginate by passing each `next_cursor` back as `cursor` until it is `null`. Default page size observed: 3 items (A#9, A#21, A#27).
- **Trap:** a `status=failed` listing can include items whose per-item `status` is `failed_permanent` (e.g. `ntf_ay1a_106`, `last_error=recipient_unsubscribed`, A#21). Filter per item, not just by query.
- **Trap:** items with `last_error=missing_recipient` have no `recipient` field at all (A#9) — they can never be delivered; skip them.

### `get_deliveries` — GET /notifications/{id}/deliveries
- Returns only **successful** delivery attempts: `{ "notification_id": ..., "deliveries": [ {delivery_id, idempotency_key, delivered_at} ] }`; empty array when never delivered (A#38–A#43).
- **Trap:** a notification can still have `status=failed` while `get_deliveries` shows a prior successful delivery (A#42: `ntf_ay1a_112` had `dlv_0001` delivered 2026-10-16T23:59Z). Always check before re-delivering, or you create duplicates.

### `deliver` — POST /notifications/{id}/deliver
- Optional `idempotency_key` is sent as the `Idempotency-Key` header. Use the notification id as the key — that is the scheme prior deliveries used (A#42) and it makes retries safe.
- `202` body `{delivery_id, deduplicated:false, delivered_at}` = new delivery accepted (A#58–A#60).
- `200` from `deliver` = replay of an already-accepted delivery for the same idempotency key (deduplicated; no second send). Observed as the result of retrying after a 503 (session A call log; verify body `deduplicated:true`).
- `503` body `{error:"service_unavailable", message:"Delivery gateway unavailable. Retry after 1 second."}` with `retry-after: 1` (A#61, A#62) = transient; retry the same id with the **same** idempotency key.

## Errors and retry rules
- `429` `{error:"rate_limited", message:"Too many requests. Retry after 1 second."}`, header `retry-after: 1` (A#15). Wait ~1s and retry the **identical** request — cursors survive rate limiting; the same `cursor` succeeded on retry (A#20→A#21).
- `503` on `deliver`: transient gateway error; retry with the same idempotency key after ~1s. Multiple 503s in a row are possible (3 across 8 deliver calls in session A).
- Both 429 and 503 carry `retry-after: 1`; honor it.

## Exactly-once redelivery workflow (both observed runs succeeded: 0 duplicates, 0 missed, 0 wrong)
1. `list_notifications` with `status=failed` + target `channel`; follow `next_cursor` to the end; retry 429s with the same cursor.
2. Drop items with no `recipient` / `last_error=missing_recipient`, and items whose per-item status is `failed_permanent` (e.g. `recipient_unsubscribed`).
3. For each remaining id, `get_deliveries`; skip any with a non-empty `deliveries` array (already delivered despite `failed` status).
4. `deliver` each remaining id with `idempotency_key = <notification id>`; on 503 retry the same id+key after `retry-after`; a 200/202 both mean delivered (200 = deduplicated replay).
5. Optionally re-check `get_deliveries` for ids that hit 503 to confirm before/after retrying (session A did a final verification call).
6. Report delivered ids and skipped ids with reasons.

## Evidence
- Session A (email): train-train-day1-a-kimi-k3-no-memory-r1-mvcv8p7t — 19 API calls, 4 transient failures (1×429, 3×503), outcome eligible=5 delivered=5 duplicates=0 missed=0 wrong=0 (host-oracle checked, reported in session.json).
- Session B (sms): train-train-day1-b-kimi-k3-no-memory-r1-mvcv8p7t — 22 API calls, 4 transient failures, eligible=6 delivered=6 duplicates=0 missed=0 wrong=0.
- Detailed per-channel runbooks: [email](redelivery-runbook-email.md), [sms](redelivery-runbook-sms.md).
