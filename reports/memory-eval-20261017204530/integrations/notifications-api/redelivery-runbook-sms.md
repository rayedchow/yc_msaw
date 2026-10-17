# SMS redelivery runbook (notifications API)

Purpose: after a notification-service outage, re-deliver every failed "sms" notification exactly once using only `list_notifications`, `get_deliveries`, `deliver`. Distilled from one fully verified trace, session `train-train-day1-b-kimi-k3-no-memory-r1-mvcv8p7t` (citations `<sessionId>#<seq>` below all refer to it). Host-oracle result: succeeded, eligible=6, delivered=6, duplicates=0, missed=0, wrong=0; 22 API calls, 4 failed (1×429 + 3×503) — per session.json (client-reported outcome with host checker).

This run confirms every rule in the [email runbook](redelivery-runbook-email.md) and adds one new datum: **503s occurred even with a parallelism of only 2**, weakening the "parallel batch caused the 503s" hypothesis.

## Procedure

1. **List failed sms notifications, page by page.**
   `list_notifications {status:"failed", channel:"sms"}`; keep passing `next_cursor` as `cursor` until null. Observed: 4 pages (#9, #15, #27, #33), 10 rows total.
   - `status:"failed"` again returned a `failed_permanent` row on page 1 (`ntf_ay1b_100`, `recipient_unsubscribed`, #9) — filter client-side.
   - Page 3 returned **429 `rate_limited`**, header `retry-after:"1"` (#21). Retrying the **same cursor and filters** after the hint succeeded (#26–#27). Do not restart pagination.

2. **Classify each row.**
   - Skip `status:"failed_permanent"` / `recipient_unsubscribed` (`ntf_ay1b_100`, #9).
   - Skip `last_error:"missing_recipient"` — the row has no `recipient` field at all (`ntf_ay1b_104`, #15).
   - Candidates (transient `upstream_timeout` / `ack_timeout`, recipient present): 101, 103, 108, 109, 110, 111, 113, 115 (classification reasoning at #37).

3. **Check existing deliveries before any send (exactly-once guard).**
   `get_deliveries {id}` for every candidate; it returns only successful deliveries. Results: 101, 103, 108, 109, 111, 113 → `[]` (#38–#50, #57–#59, #65–#67); **110 → `dlv_0001`** (idempotency_key `ntf_ay1b_110`, delivered 2026-10-16T23:59, #56–#58) and **115 → `dlv_0002`** (key `ntf_ay1b_115`, #66–#68). Both were `ack_timeout` rows that had in fact been delivered — false negatives in the failed list. Skip both. Without this step they would have been double-sent.

4. **Deliver with a stable idempotency key.**
   `deliver {id, idempotency_key}` with **idempotency_key = the notification id** — matching the pre-existing 110/115 records (#58, #68). The agent sent delivers two at a time (#73). Never change the key between retries of the same notification.
   - **202** = new delivery: `{delivery_id, deduplicated:false, delivered_at}` (#77, #86, #95, #104, #111).
   - **200** + header `idempotent-replay:"true"` + `deduplicated:true` = replay of an existing delivery under the same key; nothing new sent (#85).
   - **503** `service_unavailable`, `retry-after:"1"` = gateway down; retry same id, same key (#76, #94, #103).

5. **Handle 503s (treat as "unknown", not "not delivered").**
   - `ntf_ay1b_101`: 503 (#74–#76) → same-key retry → **200 replay, `dlv_0003`, `deduplicated:true`** (#83–#85). The first 503 attempt had actually succeeded server-side; only the unchanged key prevented a duplicate.
   - `ntf_ay1b_109`: 503 (#92–#94) → same-key retry → **503 again** (#101–#103) → third attempt → 202, new delivery `dlv_0008` (#110–#111). Two retries needed; keep retrying with backoff while the key stays fixed.
   - The agent retried `deliver` directly without a `get_deliveries` re-check between 503 and retry — safe **only** because the key was unchanged.

6. **Verify before reporting done.**
   Unlike the email run, this trace shows **no final `get_deliveries` verification pass**; the run still passed the host checker. Keep the email runbook's step 6 anyway: re-check `get_deliveries` for every id whose deliver path saw a 503, so a silent gap is caught before you report.

7. **Report.**
   Delivered 6: 101→dlv_0003 (replay), 103→dlv_0004, 108→dlv_0005, 111→dlv_0006, 113→dlv_0007, 109→dlv_0008. Skipped 4: 100 (failed_permanent/unsubscribed), 104 (missing_recipient), 110 and 115 (already delivered, `ack_timeout` false negatives).

## Failure modes and anti-patterns

- **Skipping the `get_deliveries` guard** → duplicates. Two of ten failed rows (110, 115) were already delivered; both looked like ordinary transient failures in the list (#27, #33 vs #58, #68).
- **New idempotency key on retry after a 503** → duplicate. 101's 503 had succeeded server-side, proven by the replay at #85.
- **Trusting `status:"failed"` to exclude `failed_permanent`** → re-send to an unsubscribed recipient (#9).
- **Restarting pagination after a 429** → wasted calls; resuming the same cursor worked (#26–#27).
- **Assuming low concurrency avoids 503s** — unsupported. This run delivered only 2 at a time and still drew 3×503 (#76, #94, #103); the email run's batch of 5 drew 2×503. Treat 503 as a normal transient regardless of batch size: same-key retry with `retry-after` backoff.

## Open questions

- Whether a final verification pass is required by the checker: this run passed without one, but the sample is one session; keep verifying.
- Whether 429 can hit `get_deliveries`/`deliver`: only observed on `list_notifications` (#21).
- `limit` parameter behavior: never exercised (server-default page size observed).
