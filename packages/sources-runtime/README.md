# @procmem/sources-runtime

Source-only collector runtime for procmem's `sources/` filesystem. It is the sourcing
transport of [askshepherd/aqueduct@b26d3f46](../../../aqueduct) copied verbatim, with the graph/LLM/chat planes
removed, plus `src/source-lane/` (journal, exporter, internal API, entrypoints, provider registry) and provider
modules. Every file is recorded in `PROVENANCE.json` as `verbatim`, `shim`, `patched` (reason + regression test),
or `new`. Files copied from other Shepherd repositories (e.g. gigabrain's Docs session aggregator) carry their own
`donorRepo`/`donorCommit`/`donorSha256`, and adapted ports (e.g. the iMessage receiver) list `derivedFrom`; donor
hashes are re-checkable from git with `npm run provenance -- --verify-donors <dir with the donor clones>`.

* Own dependencies at the donor's locked versions (zod 3, drizzle, postgres, hono); never shares
  code with the yc_msaw server, only the HTTP publish protocol (`docs/sources.md` in the root).
* Durability is the donor's: PostgreSQL task queue/cursors/vault/raw ledger and S3 binaries.
* No graph work can run: `graph/wiring/{ingest-hook,default-kb}.ts` are shims that do nothing,
  `9000_source_lane_export.sql` refuses `graph.*`/`wiki.*` rows in `task_queue`/`task_schedules`,
  the worker registers no graph handlers and consumes only `sync`/`backfill`.

## Processes

| Command | Role |
|---|---|
| `npm run db:migrate` | Source-only migration plan (`src/source-lane/core/migrations.ts`): donor subset + `9NNN` lane files; every excluded donor file has a recorded reason |
| `npm run start:api` | Public: `/health`, donor OAuth callbacks/webhooks, provider public routes. Internal `/internal/v1` (service token) on the same port, or on `SOURCES_RUNTIME_INTERNAL_PORT` |
| `npm run start:worker` | Donor connector handlers + provider module handlers |
| `npm run start:sweeper` | Donor schedule sweeper + expiry reaper |
| `npm run start:exporter` | Journal → yc_msaw publish, coverage heartbeats |

Environment and grants: [`docs/sources-setup.md`](../../docs/sources-setup.md) in the repository root.

## Tests

`npm test` runs the copied donor suite plus `tests/source-lane/**`. Real-PostgreSQL suites run
when `SOURCES_TEST_PG_URL` points at a synthetic superuser fixture (each run creates and drops its
own database): `SOURCES_TEST_PG_URL=postgresql://…/postgres npm test`.
`npm run provenance:check` verifies every donor-derived file against `PROVENANCE.json`.
