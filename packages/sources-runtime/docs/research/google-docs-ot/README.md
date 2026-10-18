# Google Docs OT (Operational Transform) Protocol Reference

Comprehensive reverse-engineered documentation of Google Docs' undocumented `/revisions/load` endpoint, verified against 19 real documents (13 workspace + 6 personal) totaling 141,427 changelog entries across two Google accounts.

## What is this?

Google Docs uses OT (Operational Transform) to synchronize edits across collaborators in real-time. Every keystroke, paste, format change, and structural modification is logged as an OT operation in a changelog. The `/revisions/load` endpoint exposes the complete raw changelog, and `/revisions/tiles` provides pre-computed chunk boundaries (used by the Version History UI).

These endpoints are undocumented but stable — they power the Version History feature and have been studied by Harvard, KumoDocs, and DocuViz2.

## Files

| File | Description |
|------|-------------|
| [changelog-format.md](changelog-format.md) | Entry tuple structure, anti-XSSI prefix, endpoint URLs |
| [operation-types.md](operation-types.md) | Every operation type with fields, examples, and frequency |
| [nesting-patterns.md](nesting-patterns.md) | How operations nest: nm, mlti, rplc containers |
| [tabs.md](tabs.md) | How multi-tab documents work in the OT stream |
| [replay.md](replay.md) | How to replay the changelog to reconstruct document state |
| [named-ranges.md](named-ranges.md) | The nm/nmr system and named range identifiers |
| [reliability.md](reliability.md) | Endpoint stability, revision merging, rate limits, production risks |

## Key Insight

**85%+ of all operations are `nm` (NamedMutation).** Google wraps nearly every user edit in `nm`, with the actual text change nested in the `nmc` sub-field. If you only parse top-level `is`/`ds` operations, you'll miss almost everything.

## Data Sources

- **Live testing (workspace)**: 13 Google Workspace docs (the donor team's Workspace account), 129,427 changelog entries via domain delegation
- **Live testing (personal)**: 6 personal Google Docs (a team member's personal Google account), 12,000 changelog entries via OAuth2
- **KumoDocs** (kumofx/kumodocs): Most complete reverse-engineering, `mappings.py`
- **Harvard gdocrevisions** (harvard-vpal/gdocrevisions): Clean Python OT parser
- **DocuViz2** (neuhai/docuviz2): Chrome extension for changelog visualization

## Cross-verification

Our 25 types + null catalog was verified against:
- 12 workspace docs (129k entries) + 6 personal docs (12k entries) — exhaustive scan
- 5 independent codebases: KumoDocs (12 types), Harvard (7), DocuViz2 (7), AuthorViz (5), Draftback (4)
- Exa web search across blog posts, papers, and StackOverflow
- McCulley & Roussev academic papers (DFRWS 2016, UNO thesis 2017)

No external source has any types we don't have. Our catalog is the most comprehensive that exists.

## Known Risks

1. **Anti-XSSI prefix could change.** Google has historically used `)]}'`, `while(1);`, and `&&&START&&&`. Our parser handles all three patterns but a new format would cause silent failures (returns null).

2. **`/revisions/load` page size limit is undocumented.** Currently ~1000-2000 per request, varies per doc. If Google changes this, pagination could break.

3. **These are undocumented internal endpoints.** Google could change the response format, field names, or remove the endpoints entirely without notice. The endpoints have been stable since at least 2014 (when James Somers reverse-engineered them) but there's no guarantee.

4. **New Google Docs features could add new operation types.** We predict they'd use existing `ae`/`de`/`ue`/`te` element operations, but this is unverified. The parser returns `type: "other"` for unknown types, which is safe but lossy.

5. **Imported/pasted documents may have no changelog.** Initial content lives in `chunkedSnapshot`, not `changelog`. The current parser only processes changelog entries — a doc that was imported and never edited will show 0 operations.

## Pre-Synthesis Layer

The OT parser feeds into three pre-processing modules that transform raw operations into structured, human-readable data before the synthesis/LLM layer:

```
OT Parser (gdocs-revisions-load.ts)
    │
    ├── Style Humanizer (gdocs-style-humanizer.ts)
    │   └── 100+ fields across 15 prefixes → English descriptions
    │   └── 245 tests, 100% field coverage, verified against Docs API
    │
    ├── Suggestion Tracker (gdocs-suggestion-tracker.ts)
    │   └── Groups ops by sugId, tracks create/modify/accept/reject lifecycle
    │   └── 56 tests, links to Activity API comment threads
    │
    ├── Behavior Detector (gdocs-behavior-detector.ts)
    │   └── Paste detection, undo chains, find & replace, collaboration
    │   └── Session analysis (active time, typing speed, bursts, pauses)
    │   └── Document structuring, bulk formatting, link insertion
    │
    ▼
Session Pre-Aggregator (next to build)
    ▼
LLM Summarizer (next to design)
```

## Codebase

- **OT Parser**: `brain/src/polling/gdocs-revisions-load.ts` — 25 op types, pagination, tab-aware replay
- **Style Humanizer**: `brain/src/polling/gdocs-style-humanizer.ts` — 100+ style field translations
- **Suggestion Tracker**: `brain/src/polling/gdocs-suggestion-tracker.ts` — suggestion lifecycle by sugId
- **Behavior Detector**: `brain/src/polling/gdocs-behavior-detector.ts` — implicit behavior heuristics
- **Activity Polling**: `brain/src/polling/gdocs-edits.ts` — edit/create/rename/move/delete/restore/settings/permission events
- **Comment Polling**: `brain/src/polling/gdocs-comments.ts` — comment/suggestion/assignment lifecycle
- **Enrichment**: `brain/src/jobs/eod-enrich.ts` — Phase 2 OT enrichment of Phase 1 events
- **Live API tests**: `brain/scripts/test-exhaustive-revisions-load.ts` (36/36 pass)
- **Unit tests**: `brain/tests/gdocs-revisions-load.test.ts` (Vitest)
- **OT research scripts**: `brain/scripts/test-*.ts` (16 scripts)

## Access Notes

The `/revisions/load` endpoint on `docs.google.com` has stricter access control than the official Docs/Drive APIs on `googleapis.com`. Domain-wide delegation grants full access to all workspace docs. OAuth2 tokens for personal accounts only work on a subset of owned docs (recently edited ones). Older docs may return 403/400 even when the user owns them — this is a Google-side restriction on revision history access, not a scope issue.
