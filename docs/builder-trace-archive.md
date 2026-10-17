# Builder trace archive (`sources/`) and builder `shell`

The daily build processes one immutable cohort (`inputs/`). To judge whether a behavior, failure or workaround in that cohort is new,
recurring or already contradicted, build agents also need the history. Every build agent (root, children, grandchildren) therefore gets a
read-only **trace archive** of all retained traces of the build's tenant at `sources/`, plus (in Modal) a `shell` tool whose cwd is the
workspace root so `ls`, `find`, `grep -rn`, `cat`, `head`, `sed -n`, `wc`, `node` work directly on `sources/traces/...`.

This is BUILD-side only. The customer MCP filesystem has no `sources/`, `inputs/` or traces mount, and no build tools.

## Layout

```
sources/README.md                                    guide written by the host
sources/manifest.json                                days, sessions (with every day directory they span), counts
sources/traces/<YYYY-MM-DD>/index.json               sessions received that day
sources/traces/<YYYY-MM-DD>/<sessionId>/session.json partition summary + archive.{otherDays, otherPaths, session}
sources/traces/<YYYY-MM-DD>/<sessionId>/events.jsonl one event per line, seq order, same format as inputs/
sources/traces/<YYYY-MM-DD>/<sessionId>/payloads/*   full payloads, referenced as {"$payload": "payloads/<sha256>.<ext>"}
```

- **Day** is the server receipt day of each chunk, i.e. exactly the trace-store partition `traces/<day>/<session>/chunk-*.jsonl.gz`
  (UTC unless the ingestor's day offset is configured). A session whose chunks arrived on several days (long runs, late
  retries) has one directory per day; `session.json` → `archive.otherDays` and `manifest.json` → `sessions` link them, and
  `archive.session` gives the whole-session view (events, seq range, completeness, objective, outcome).
- Events keep every field the SDK sent (ids, ts, agent, tool arguments, results, errors, usage, outcome). Blob payloads are
  read in full and verified against their content address; inline payloads over 64 KiB are moved to `payloads/` verbatim.
  Evidence references are `<sessionId>#<seq>` as for `inputs/` (seqs are unique per session across days).
- The archive includes the current cohort's sessions. Prompts tell agents that `inputs/` is the new material and `sources/` is
  untrusted background evidence: do not re-document old sessions just because they are visible.

## How it is built (src/traces/archive.ts)

`buildTraceArchive(store, ns, opts)` runs once per build, before the first attempt, with the **host** namespace
(`repo.ns`, from the authenticated tenant context); models cannot choose a namespace.

1. Paged listing of `traces/` (`listPageSize`, default 1000 keys per call).
2. Batched reads (`maxGetKeys` ≤ 64 keys / `maxGetBytes` ≤ 8 MiB per call) of the create-once chunk index records; each must
   agree with the listed key/day/session/seq.
3. Each `(day, session)` partition is rendered by the same `materializeCohort` code as the daily cohort: chunk sha256 verified
   against the index claim, blobs digest-verified, duplicate seqs with different content rejected. Overlapping seq ranges across
   day partitions of one session are rejected.
4. Caps: `maxBytes` (decoded, default 128 MiB, `PROCMEM_TRACE_ARCHIVE_MAX_BYTES`), `maxFiles` (rendered files incl. indexes,
   default 50 000, `PROCMEM_TRACE_ARCHIVE_MAX_FILES`) and `maxChunks` (stored chunk objects, checked while listing before any
   chunk is read, default 200 000, `PROCMEM_TRACE_ARCHIVE_MAX_CHUNKS`). Chunks without an index record are decompressed with a
   2 MiB bound (the ingest chunk limit). Exceeding either, or any integrity failure, throws `TraceArchiveError`; `runMemoryBuild`
   records `failure.code = "trace_archive_failed"` and leaves the published head untouched. The archive is never partial.
5. The snapshot (`TraceArchiveSnapshot`, tree sha256 recorded as `receipt.traceArchive.sha256`) is shared by every agent of the
   build and by CAS-retry attempts, so all agents see the same files.

Dedup: rendered partitions depend only on their immutable chunk set, so `TraceArchiveCache` (one per `createConfiguredBuilder`,
`PROCMEM_TRACE_ARCHIVE_CACHE_BYTES`, default 64 MiB, non-negative integer, `0` disables, invalid values fail at startup, keyed by namespace + chunk sha256 list) reuses them across daily builds;
a late chunk only re-renders its own partition. For Modal, the snapshot is gzipped once (`bundle()`) and each sandbox receives
that one compressed object, which root unpacks after verifying its sha256 (`O_EXCL|O_NOFOLLOW`, file/byte counts compared with
the host). Cost per agent is one compressed upload; documented hackathon trade-off versus a shared volume mount.

## Options

```ts
runMemoryBuild({ ..., traceArchive })
//   undefined | TraceArchiveOptions -> build from repo.store + repo.ns (default; createConfiguredBuilder passes its cache)
//   TraceArchiveSnapshot            -> use as-is (must belong to repo.ns)
//   "disabled"                      -> empty sources/ whose README says the host disabled it
```

A tenant without traces gets `sources/README.md`, `sources/manifest.json` and an empty `sources/traces/`.

## Isolation (Modal)

| tree | owner / mode | FS tools (agent uid 1000) | `shell` (reader uid 1001) |
|---|---|---|---|
| `inputs/`, `sources/`, `published/`, `parent-draft/` | root, `a-w`, ancestors root-owned, symlinks removed, verified by an agent-uid write probe | read | read |
| `knowledge/` | agent uid, dirs 0755 / files 0644 | write only inside `knowledgeWriteScope` | read only |
| `work/` | agent uid, 0700 | read/write | invisible |
| `cmd-scratch/` (`$SCRATCH`) | reader uid, 0700 | — | read/write |

`shell` runs `bash -c <command>` through the sandbox's root-owned wrapper with `setpriv --reuid=1001 --regid=1001 --clear-groups
--no-new-privs --inh-caps=-all --bounding-set=-all`, `env -i` with an allowlisted environment (no keys/tokens), network blocked,
a deadline (≤ 120 s) and bounded output (stdout ≤ 12 KiB returned, stderr ≤ 2 KiB, explicit truncation flags). Because the reader
uid owns no workspace tree, writes, deletes, renames, `chmod` and symlink planting fail at the OS level; there is no command
denylist. Page edits stay with `write/edit/move/delete`, which enforce scopes, so commands cannot bypass a child's write scope.
The uid is fixed by the host and is never a model argument.

The local backend (`LocalBuildWorkspace`, trusted offline only) mounts `sources/` with read-only modes but does not offer `shell`;
tests may opt in with `trustedLocalCommandWorkspaceFactory` (host bash, no OS isolation).

## Verification

- `tests/trace-archive.test.ts`: old day excluded from `inputs/` but present in `sources/`; current session present too; exact
  event/payload reconstruction; cross-day chunks of one session; paging/batching equality; tenant isolation; explicit caps;
  tampered chunk / missing blob fail closed; cache reuse; root/child/grandchild read via `ls/read/grep/find/shell`, FS-tool
  writes/edits/moves/deletes into `sources/` rejected, shell mutations ineffective; knowledge symlink cannot write into `sources/`.
- `scripts/trace-archive-modal-smoke.ts` (real Modal): root → child → grandchild build where each agent's `shell` runs as uid
  1001 in `/build`, lists all days, greps and cats historical events, cannot see the other tenant, and every mutation/network
  attempt is denied; scoped FS-tool writes from all depths are published. Evidence: `reports/trace-archive-modal-smoke.json`.
