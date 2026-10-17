# Demo integration: Notify Hub (simulated third-party notification API)

SCRIPTED FIXTURE — these overlays are hand-written demo inputs that exercise the
integration infrastructure (workspace, sealed validation, promotion, Manufact publish,
rollback). They are NOT model-generated; the daily build harness's LLM agents use the
same tools to write their own revisions.

- `initial/`     — first revision: works for small single-page lists and clean sends,
                   but truncates pagination and has no retry/idempotency.
- `repair-bad/`  — plausible but wrong repair: paginates and retries WITHOUT an
                   Idempotency-Key, so a 503-after-commit duplicates notifications.
- `repair-good/` — correct repair: cursor pagination, bounded retries honoring
                   Retry-After, one stable Idempotency-Key per logical send, plus tests.
- `suites/`      — host-held suites: `v1` (day-1 regression), `v2-regression`
                   (cases distilled from failing traces) and `v2-heldout` (sealed variants).

The API itself is documented in API.md and implemented by the host fixture
templates/integration/harness/fixtures/notify-hub.mjs (sealed harness) and by the
child's own in-process simulator (`NOTIFY_HUB_SIMULATED=1`) used for the hosted demo.
