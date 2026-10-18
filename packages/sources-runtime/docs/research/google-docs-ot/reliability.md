# Endpoint Reliability and Stability

Assessment of the `/revisions/load` and `/revisions/tiles` endpoints for production use.

## Format Stability (12+ years)

The response format has been stable since at least 2014. Evidence from independent parsers:

| Tool | First release | Last update | Still works? |
|------|--------------|-------------|-------------|
| Draftback | Nov 2014 | Apr 2026 | YES (500K+ users) |
| DocuViz2 | 2015 | Jan 2025 | YES |
| Harvard gdocrevisions | 2016 | Aug 2018 | YES (our code is ported from this) |
| Revision History Extension | 2024 | Apr 2026 | YES (200K+ users) |
| Process Feedback | 2025 | 2026 | YES (5K+ users) |

The only known format change was the anti-XSSI prefix shifting from `&&&START&&&` (pre-2015) to `)]}'\n` (current). The tuple structure `[operationObj, timestampMs, userId, revisionId, sessionId, ...]` has been the same since 2014.

New operation types have been added over time (e.g., `dc` for tabs in 2024), but as extensions to the existing structure, not breaking changes.

## OT Changelog vs Drive API Revisions — CRITICAL DISTINCTION

These are **two completely different systems**:

| | OT Changelog (`/revisions/load`) | Drive API Revisions (`/drive/v3/.../revisions`) |
|---|---|---|
| Granularity | Every keystroke | Coarse snapshots |
| Merging | No evidence of compaction (append-only) | Explicitly merged by Google ("revisions may be merged to save storage space") |
| Stability | Entry count appears monotonically increasing | Revision IDs can disappear after merging |
| Documentation | Undocumented | Official API |

**The Drive Revisions API `lastRevId` is NOT safe as a changelog end value** — revision IDs can change over time as Google merges them. This is why our code uses tiles (which are derived from the OT log, not Drive revisions) for pagination.

Source: Google's own docs state "Each time the content changes, Drive creates a new revision history entry for that file. However, these editor file revisions may be merged together, so the API response might not show all changes to a file."

Source: Martin Hawksey (2022) confirmed that previously-returned `revisionId` values can be "dropped from the Revisions resource if there was a minor edit."

## Endpoint Deprecation Risk

**LOW.** No evidence of deprecation in 12+ years. The `/revisions/tiles` endpoint powers Google's own Version History UI — breaking it would break a core Docs feature used by every Workspace customer.

However, there was a one-time history wipe during a major Google Docs infrastructure upgrade in 2013 (pre-OT-log era). This has not recurred.

## Rate Limits

**Unknown but generous.** The endpoints live on `docs.google.com`, not `googleapis.com`, so standard Drive API quotas (20K queries/100s) likely don't apply. The 500K+ Draftback user base has operated at scale without reports of systematic rate limiting.

Recommended self-imposed limits:
- Max 5-10 requests per second per user
- Max 1000 entries per page (our `CHANGELOG_PAGE_SIZE`)
- Back off on 429 responses

## Bot Detection

**LOW risk.** The OAuth token is the sole access control. No evidence of browser fingerprinting, CAPTCHAs, or bot detection on these endpoints. The response format (JSON with anti-XSSI prefix) is designed for programmatic consumption by the Docs frontend.

Potential future risk: Google could start requiring additional headers (like SAPISIDHASH cookies or specific User-Agent strings). Monitor response headers for new requirements.

## Document Operations Impact

| Operation | OT changelog | Tile boundaries | File ID |
|-----------|-------------|----------------|---------|
| Edit | Entries appended | New tiles created | Same |
| Move (between folders) | Preserved | Preserved | Same |
| Ownership transfer | Preserved | Preserved | Same |
| **Copy ("Make a copy")** | **LOST** (fresh start) | **LOST** | **New ID** |
| Shared Drive transfer | Preserved | Preserved | **May change** |

**Copies are destructive** — a copy creates a new document with zero revision history. This is by design and is the documented way to "delete" version history.

## Recommended Mitigations

1. **Cache aggressively**: OT log is append-only. Cache previously-fetched entries and only request new ranges (`start = lastKnownCount + 1`).

2. **Track entry count monotonicity**: If `totalEntries` for a document decreases between polls, log it as an anomaly — this would indicate compaction is occurring (unprecedented but possible).

3. **Store tile snapshots**: Save tile boundaries at fetch time. If a future fetch returns different boundaries for the same range, log the discrepancy.

4. **Self-impose rate limits**: Max 5-10 req/s per user, even though Google's limits appear generous.

5. **Maintain fallback path**: If `/revisions/load` fails, degrade to the official Drive Revisions API (coarser data but guaranteed-supported).

6. **Monitor the ecosystem**: Track Draftback, DocuViz2, and Revision History Extension for breakage reports — they'd be the first to notice endpoint changes.

## Sources

- James Somers, "How I Reverse-Engineered Google Docs" (2014) — features.jsomers.net
- Shane McCulley thesis, "Forensic Analysis of G Suite Collaborative Protocols" (UNO, 2017)
- McCulley & Roussev, "Forensic analysis of cloud-native artifacts" (DFRWS 2016)
- Martin Hawksey, "Working with the Google Drive API Revisions" (2022) — hawksey.info
- Google Drive API documentation — developers.google.com/workspace/drive/api/guides/change-overview
- StackExchange, "Is Google Docs revision history a stable long-term audit trail?" (2013)
- Hacker News discussion of Somers' post (2020) — confirmed by former Google Slides team member
