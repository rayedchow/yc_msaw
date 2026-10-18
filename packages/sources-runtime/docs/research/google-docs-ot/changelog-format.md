# Changelog Format

## Endpoints

### /revisions/load
```
GET https://docs.google.com/document/d/{fileId}/revisions/load?id={fileId}&start={start}&end={end}
Authorization: Bearer {accessToken}
```

Returns the OT changelog for a document within the given entry range. Works with OAuth tokens including domain-delegated service accounts.

**Anti-XSSI prefix**: Response starts with `)]}'\n`. Currently consistent across all docs. However, Google has historically used other prefixes for Docs endpoints:
- `)]}'\n` — current standard (4 chars + newline)
- `while(1);` — used by Calendar/Gmail
- `&&&START&&&` — historically used by Google Docs (pre-2015, per StackOverflow)

The parser should handle all three patterns, not just fixed character offsets.

**Response structure**:
```json
{
  "chunkedSnapshot": [[...]],
  "changelog": [
    [operationObj, timestampMs, userId, revisionId, sessionId, sessionIndex, null, null, false],
    ...
  ]
}
```

- `chunkedSnapshot`: Always present, always an array. Contains the initial document state snapshot (format/style operations).
- `changelog`: Array of 9-element tuples. May be empty for imported docs with no edit history.

### /revisions/tiles
```
GET https://docs.google.com/document/d/{fileId}/revisions/tiles?id={fileId}&start=1&showDetailedRevisions=true
Authorization: Bearer {accessToken}
```

Returns pre-computed chunk boundaries matching the Version History UI.

**Anti-XSSI prefix**: Same as /load — try `slice(4)`, fallback to `slice(5)`.

**Response structure**:
```json
{
  "tileInfo": [
    { "start": 1, "end": 28, "endMillis": 1747264954982, "users": ["12345"] },
    ...
  ],
  "userMap": {
    "12345": { "name": "Ishan Ramrakhiani", "photo": "...", "anonymous": false }
  },
  "firstRev": 1
}
```

## Entry Tuple Structure

Each changelog entry is a 9-element array:

| Index | Field | Type | Description |
|-------|-------|------|-------------|
| 0 | operation | object \| null | The OT operation (has `ty` field). Null for no-ops. |
| 1 | timestamp | number | Millisecond-precision Unix timestamp |
| 2 | userId | string | Google internal user ID (numeric string) |
| 3 | revisionId | number | Sequential revision number |
| 4 | sessionId | string | Editing session identifier |
| 5 | sessionIndex | number | Index within the editing session |
| 6 | (unknown) | null | Always null in observed data |
| 7 | (unknown) | null | Always null in observed data |
| 8 | (unknown) | boolean | Always false in observed data |

Verified: 552,861 operations across 12 workspace docs + 12,000 across 6 personal docs. Every single entry had exactly 9 elements. Timestamps are always valid (>1e12), userIds are always non-empty strings, revisionIds are always numbers.

## Pagination

**Critical**: The `/revisions/load` endpoint has a per-request page size limit. Requesting too many entries in one call returns HTTP 400.

### Observed limits (from exhaustive testing)

| Document | Total entries | Max working `end` | First failing `end` |
|----------|-------------|-------------------|---------------------|
| Ishan LinkedIn Post | 2,352 | 2,000 | 3,000 |
| Company Brain | 12,875 | 5,000+ | — |
| application_1 | 594 | 500 | 1,000 |
| Elijah LinkedIn Post | 2,101 | 2,000 | 3,000 |

The safe max page size is **1,000 entries**. This worked on every document tested.

### Correct pagination algorithm

```typescript
// 1. Fetch tiles to get total entry count
const tilesData = await fetchTiles(fileId);
const totalEntries = tilesData.tileInfo[tilesData.tileInfo.length - 1].end;

// 2. Paginate in chunks of 1000
const PAGE = 1000;
const allEntries = [];
let start = 1;

while (start <= totalEntries) {
  const end = Math.min(start + PAGE - 1, totalEntries);
  const page = await fetchLoad(fileId, start, end);
  allEntries.push(...page.changelog);
  if (page.changelog.length < PAGE) break;
  start = end + 1;
}
```

### What NOT to do

- Do NOT pass `end=999999` — returns 400
- Do NOT use the Drive Revisions API `lastRevId` as the `end` param — that's an opaque revision ID, not a changelog entry count
- Do NOT assume a fixed max page size — it varies per document (500 to 5000+)

### Pagination verification

Tested across 5 docs with complete pagination:

| Document | Tile count | Expected entries | Fetched entries | Match |
|----------|-----------|-----------------|----------------|-------|
| Ishan LinkedIn Post | 97 | 2,352 | 2,352 | 100% |
| Company Brain | 395 | 12,875 | 12,875 | 100% |
| application_1 | 28 | 594 | 594 | 100% |
| Elijah LinkedIn Post | 62 | 2,101 | 2,101 | 100% |
| Pivot | 151 | 22,890 | 22,890 | 100% |

The last tile's `end` value is always exactly equal to the total number of changelog entries.

## Tile Boundaries

Tiles define the chunk boundaries used by Version History. Each tile has:
- `start`: First changelog entry index (1-indexed)
- `end`: Last changelog entry index (1-indexed, inclusive)
- `endMillis`: Timestamp of the last operation in the chunk
- `users[]`: Array of user IDs who contributed to this chunk

With `showDetailedRevisions=true`, tiles are fine-grained (one per typing burst). Without it, tiles are coarser (matching the sidebar entries in Version History).

### Tile contiguity

Tiles are **usually** contiguous: `tiles[i].start === tiles[i-1].end + 1`. But there can be gaps in **multi-tab documents**. Tiles skip `null` (no-op) entries and tab management operations.

Observed in "Ishan LinkedIn Post" (2,352 entries, 97 tiles, **2 tabs**: "Tab 1" + "Tab 2"):
- Gap at tile 1: entry 2 skipped (`null` no-op)
- Gap at tile 16: entries 495-496 skipped (`nm` + `null`)
- Gap at tile 40: entries 1236-1237 skipped (`nm` + `null`)
- Gap at tile 64: entries 1637-1638 skipped (`nm` + `null`)

The `ac` operation at entry 4 creates Tab 2 (`t.taev36xqg9o0`) and `mkch` renames the default tab to "Tab 1". The gaps contain null entries and tab-related operations that don't produce visible content changes.

Single-tab docs (e.g., "Company Brain", "application_1") have fully contiguous tiles.

The codebase handles this correctly by matching operations to tiles via `op.changelogIndex <= tile.end`, not by assuming contiguity.

### Tile vs entry count

Tile boundaries are defined by changelog entry indices, NOT by revision IDs. When matching operations to tiles, use the 1-indexed position in the raw changelog array (our `changelogIndex` field), not the `revisionId` from the entry tuple.

## Access Control

| Auth method | /revisions/load | /revisions/tiles | Notes |
|------------|----------------|-----------------|-------|
| Domain delegation (Workspace) | All docs | All docs | Full access via service account |
| OAuth2 (personal Gmail) | Some docs | Not tested | Research-only local scripts; not a runtime auth path |
| OAuth2 (Workspace user) | Same as delegation | Same | Historical research note; runtime fallback is disabled |

For personal Gmail accounts, many owned docs return 403 from `/revisions/load` even though the user can see Version History in the browser. The browser uses session cookies which grant broader access than OAuth tokens.

## Empty/Imported Documents

Some documents have tiles but no changelog entries (e.g., imported docs, docs with only structural changes). The response still has `chunkedSnapshot` (always an array) but `changelog` is an empty array. This is expected — these docs were created without keystroke-level edit tracking.

Observed: `application_1` (28 tiles, 0 changelog entries), `GTM` (13 tiles, 0 entries), `Untitled document` (2 tiles, 0 entries).

## Index Convention

All document indices are **1-indexed**. Position 1 is the first character. This matches the Python library convention and the Documents API body content indexing.
