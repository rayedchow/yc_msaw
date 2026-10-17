# Email redelivery runbook (notifications API)

Purpose: after a notification-service outage, re-deliver every failed "email" notification exactly once using only `list_notifications`, `get_deliveries`, `deliver`. Distilled from one fully verified trace, session `train-train-day1-a-kimi-k3-no-memory-r1-mvcv8p7t` (citations `<sessionId>#<seq>` below all refer to it). That run ended host-oracle-verified: eligible=5, delivered=5, duplicates=0, missed=0, wrong=0, failed_api_calls=4/19 (#96).

## Procedure

1. **List failed email notifications, page by page.**
   Call `list_notifications {status:"failed", channel:"email"}` (status is required). Keep passing each response's `next_cursor` as `cursor` (with the same status/channel) until `next_cursor` is null. Observed: server-default page size 3, three pages, 8 rows total (#9, #21, #27). The `limit` parameter exists but was never exercised.
   - **`status:"failed"` also returns `failed_permanent` rows** (#21: `ntf_ay1a_106` came back with status `failed_permanent`). Filter client-side; the server does not exclude them.
   - On **429 `rate_limited`** (body `error:"rate_limited"`, header `retry-after:"1"`, #15): wait ≥1s, then retry the **same cursor with the same filters** — pagination resumes correctly (#19–#21). Do not restart from page 1.

2. **Classify each row.**
   - Skip `last_error:"missing_recipient"` — the row has no `recipient` field at all; delivery is impossible (`ntf_ay1a_101`, #9).
   - Skip `status:"failed_permanent"` / `last_error:"recipient_unsubscribed"` — recipient opted out; must not re-send (`ntf_ay1a_106`, #21).
   - Redelivery candidates: transient errors (`upstream_timeout`, `ack_timeout`) with a recipient present — here 102, 104, 107, 108, 112, 113.

3. **Check existing deliveries before any send (exactly-once guard).**
   Call `get_deliveries {id}` for every candidate (a parallel batch of 6 worked fine, all 200, #32–#43). It returns **only successful deliveries**; `deliveries:[]` means never delivered. `ntf_ay1a_112` already had `dlv_0001` (idempotency_key `ntf_ay1a_112`) → skip as duplicate (#43). Skipping this step is the single biggest duplicate risk: 112 looked like any other failed row in the list.

4. **Deliver with a stable idempotency key.**
   `deliver {id, idempotency_key}` — the key is sent as the `Idempotency-Key` header. Scheme that worked, and which matched the pre-existing 112 delivery record (#43): **idempotency_key = the notification id itself** (#53–#57). Never change the key between retries of the same notification.
   - **202** = accepted, new delivery created: body `{delivery_id, deduplicated:false, delivered_at}` (#58–#60).
   - **200** + header `idempotent-replay:"true"` + body `deduplicated:true` = replay of an existing delivery under the same key; nothing new was sent (#72).
   - **503** `service_unavailable`, header `retry-after:"1"` = delivery gateway down; retry the same id with the **same key** after ≥1s (#61, #62, #78).

5. **Handle 503s (treat as "unknown", not "not delivered").**
   - `ntf_ay1a_108`: 503 (#61) → retry same key → 200 replay `deduplicated:true` (#71–#72). The first 503 attempt had **actually succeeded server-side** — inferred from the replay response; the 503 body itself gives no such hint. The unchanged key made a duplicate impossible.
   - `ntf_ay1a_113`: 503 (#62) → 503 again (#77–#78) → third attempt 202, new delivery `dlv_0006` (#83–#84). Two retries were needed.
   - The agent retried `deliver` directly without a `get_deliveries` re-check between the 503 and the retry; that is safe **only** because the key was unchanged. If you ever use a fresh key, you MUST `get_deliveries` first.

6. **Verify exactly-once for anything that saw a 503.**
   After the 108 replay the agent called `get_deliveries` for 108: exactly one delivery, `dlv_0005` (#89–#90). Do this for every id whose deliver path included a 503 or any ambiguity before reporting done.

7. **Report.**
   List delivered ids with their delivery_ids, and skipped ids with reasons. Verified final summary (#94): delivered 102→dlv_0002, 104→dlv_0003, 107→dlv_0004, 108→dlv_0005, 113→dlv_0006; skipped 101 (missing_recipient), 106 (failed_permanent/recipient_unsubscribed), 112 (already delivered dlv_0001). This matches the tool evidence and the host-oracle result (#96).

## Failure modes and anti-patterns

- **Deliver without checking `get_deliveries` first** → duplicate. 112 was indistinguishable from other failed rows until `get_deliveries` revealed the prior success (#43).
- **New idempotency key on retry after a 503** → duplicate. 108's first 503 attempt succeeded server-side (#61 vs the replay at #72); a fresh key would have double-sent.
- **Trusting `status:"failed"` to exclude `failed_permanent`** → re-send to an unsubscribed recipient. It does not exclude it (#21).
- **Ignoring `retry-after`** → wasted calls. Both 429 (#15) and 503 (#61) carry `retry-after:"1"`. In this trace the agent never explicitly waited; the ~2.9s gap before the 429 retry came from model generation latency (the retry turn took 2880ms, #19), which happened to exceed the hint. Do not rely on that — sleep ≥ retry-after yourself.
- **Restarting pagination after a 429** → wasted pages and possible re-processing. Resuming the same cursor worked cleanly (#19–#21).
- **Parallel deliver batch**: 5 simultaneous `deliver` calls (#53–#57) drew 2×503 (#61–#62); possibly gateway pressure (hypothesis, unverified). Parallel `get_deliveries` caused no trouble (#32–#43). If 503s cluster, narrow the batch or go serial.
- **Assuming 503 means "not delivered"** — false (the 108 case). Treat 503 as unknown outcome; same-key retry plus a `get_deliveries` verification resolves it.

## Open questions

- `limit` parameter behavior and the server maximum page size: never exercised (default 3 observed).
- Whether 429 can hit `get_deliveries`/`deliver` too: only observed on `list_notifications` (#15).
- Whether the 503s on the parallel batch were caused by concurrency or were independent transient faults: unverified.
