# Notifications API

Back to [integrations index](../index.md).

A notification service with three tools: `list_notifications`, `get_deliveries`, `deliver`. The learned workflows cover outage recovery: re-delivering every failed notification for a channel exactly once, under rate limits (429) and transient gateway errors (503).

## Pages
- [API reference](reference.md) — endpoints, parameters, response shapes, status codes, pagination, idempotency and retry rules, eligibility traps. Read this first.
- [Email redelivery runbook](redelivery-runbook-email.md) — observed end-to-end run for channel `email` (5 delivered, 3 skipped).
- [SMS redelivery runbook](redelivery-runbook-sms.md) — observed end-to-end run for channel `sms` (6 delivered, skips with reasons).

## Core invariants
- Never re-deliver without checking `get_deliveries`: `status=failed` does not imply "never delivered" (train-train-day1-a-kimi-k3-no-memory-r1-mvcv8p7t#42).
- Always send `idempotency_key` (use the notification id) so 503 retries cannot duplicate.
- Skip `missing_recipient` (no recipient) and `failed_permanent` items even when they appear in a `status=failed` listing.
