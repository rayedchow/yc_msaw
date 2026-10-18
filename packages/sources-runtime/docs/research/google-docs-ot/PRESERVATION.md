# Google Docs OT research: preserved donor material

These files are the reverse-engineering record behind the Docs history parser in
`src/polling/_archived-gdocs/gdocs-revisions-load.ts`: the op grammar
(`nm`/`mlti`/`rplc`/`rvrt`/`dc`/`mkch`/`ucp`…), nesting, tab encoding, pagination limits,
replay validation and endpoint risk. They come from gigabrain
`5448774e0a121570666adaa0c8ca18570df72be9` (main, 2026-07-20), the newest donor with this
material. The parser comments cite them.

They are documentation and archived research harnesses, not product code:
- nothing under `src/` imports them;
- `tsconfig.json` compiles `src/`, `tests/` and `scripts/` only;
- vitest only runs `tests/**/*.test.ts`.

`MANIFEST.json` gives, per file, the donor path, the donor SHA-256 (re-hashed from the git
object) and the current SHA-256. `tests/source-lane/providers/google-docs/research-preservation.test.ts`
checks it.

## What is here

| Donor path | Here | Files |
|---|---|---|
| `research/google-docs-ot/*.md` | `./*.md` | 14 notes. 8 are format research (README, changelog-format, operation-types, nesting-patterns, named-ranges, replay, reliability, tabs). 6 are design notes for the donor's LLM synthesis layer (synthesis-*, agent-architecture-research), which is not ported to the source lane; they are kept because they record what the session data was meant to support. |
| `research/google-docs-ot-operations.md` | `./google-docs-ot-operations.md` | The earlier op catalogue (a sibling of the directory in the donor). |
| `brain/scripts/*.ts` | `./scripts/*.ts` | 22 live research harnesses that probe `/revisions/tiles` and `/revisions/load` directly. |

All 15 notes and 14 of the 22 scripts are byte-identical to the donor.

### Which scripts, and why 22

The 22 scripts are every `brain/scripts` file at the donor commit that calls the private
changelog endpoints to study the format:
- `check-latest-entries`, `check-session-tokens`, `check-subtabs`, `check-tab-ops`, `check-undo-rvrt`;
- `test-chunked-diffs` (v1, v2, v3), `test-dc-ops`, `test-deep-ot-analysis`;
- `test-exhaustive-revisions-load`, `test-exhaustive-scan`, `test-last-chunks`;
- `test-multi-doc-validation`, `test-nm-parsing`, `test-nm-standalone`, `test-op-types`;
- `test-revisions-load`, `test-tabs-ops`, `test-tabs-standalone`, `test-tiles`, `verify-uncertain-fields`.

These scripts also reference the changelog but were not copied:
- `trace-ot-ops`, `run-docs-progressive`, `run-docs-synthesis`: they read the donor database and the LLM synthesis pipeline, not the endpoint.
- `test-synthesis-cost`, `test-synthesis-live`, `test-humanizer`, `verify-humanizer-against-api`: LLM synthesis and style-humanizer evaluation.
- `scan-personal-docs`, `show-linkedin-chunks`: they print the content of named personal documents.

## Safety changes (the 8 `patched` scripts)

All 37 files were scanned before copying for:
- credentials (OAuth/API tokens, keys, private keys, bearer strings, signed URLs);
- e-mail addresses;
- Drive file IDs;
- embedded changelog dumps.

No credentials or dumps were found. Eight scripts hard-coded the ID of a private Google Doc
(`check-latest-entries`, `check-session-tokens`, `check-undo-rvrt`, `test-dc-ops`,
`test-last-chunks`, `test-nm-parsing`, `test-nm-standalone`, `test-op-types`). A document ID is
an access capability when link sharing is on, so the literal was replaced, and nothing else
changed:

```ts
(process.env.GDOCS_RESEARCH_DOC_ID ?? "REDACTED_PRIVATE_DOC_ID")
```

The notes are unchanged. They name the donor's original test documents by title and give
counts, and the README names the two accounts used for the May 2026 live tests. A few
synthesis notes quote one-line summaries of those test documents. Nothing in them is a
credential, a document ID or a changelog dump.

## The scripts do not run here as-is

The scripts keep their donor imports, which resolve inside gigabrain's `brain/` package, not
here:

| Donor import | Closest module in this package |
|---|---|
| `../src/lib/google-auth.js` (`getGoogleAccessToken`) | `src/vault/google-auth.ts` (same name; the signature takes a tenant, mailbox and scopes) |
| `../src/polling/gdocs-api.js` (`gFetch`) | `src/polling/_archived-gdocs/gdocs-api.ts` |
| `../src/polling/gdocs-revisions-load.js` | `src/polling/_archived-gdocs/gdocs-revisions-load.ts` |
| `../src/polling/gdocs-style-humanizer.js` | not ported (LLM-adjacent presentation layer) |
| `dotenv/config` (8 scripts) | not a dependency of this package |

They also hit live Google with a real Workspace identity. They are kept as a record of how the
findings were obtained. Running one means adapting its imports and pointing it at a document
you are allowed to read; the production test suite never runs them.
