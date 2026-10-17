# Notify Hub API (simulated)

Auth: `Authorization: Bearer <token>` on every /v1 route (401 otherwise).

- `GET /v1/notifications?limit=&cursor=&recipient=` → `{ data: Notification[], has_more, next_cursor }`.
  The server caps page size (default 10) regardless of `limit`. Follow `next_cursor` until null.
- `POST /v1/notifications {recipient, message}` with optional `Idempotency-Key` header → 201 Notification.
  - `429` + `Retry-After: <seconds>` when rate limited (not committed).
  - `503` may happen before OR after the notification was committed (lost ack).
  - Same Idempotency-Key + same body → original response (`Idempotent-Replayed: true`);
    same key + different body → `422 idempotency_key_reused`.
- `GET /v1/notifications/:id` → Notification | 404.

Notification: `{ id: "ntf_0001", recipient, message, created_at }`.
