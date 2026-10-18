# Tabs in Google Docs OT

How multi-tab documents work in the `/revisions/load` changelog.

## Key Finding

The OT changelog is a **single flat stream** across ALL tabs. There is no separate changelog per tab. Tab identity is encoded in several places but NOT as a direct field on individual `is`/`ds` operations.

## Where Tab IDs Appear

### 1. `nm.nmr[]` — Named Range References
Every `nm` operation includes an array of named range IDs. One of these is a tab-scoped ID:

```json
{
  "ty": "nm",
  "nmr": ["ksm", "t.taev36xqg9o0"],
  "nmc": { "ty": "is", "ibi": 14, "s": "hello" }
}
```

- `"ksm"` — Always present. Stands for "Kix State Manager" (internal state tracker).
- `"t.taev36xqg9o0"` — Tab-scoped named range. The `t.` prefix indicates a tab ID.

**This is how you determine which tab an edit happened on.** The `t.xxxxx` string maps to a specific tab.

### 2. `dc` — DocumentConfiguration
Creates tabs:
```json
{ "ty": "dc", "d": ["", [1], 0] }                    // Default tab (empty string)
{ "ty": "dc", "d": ["t.9gdcs73pcwbg", [2], 0] }      // Create tab with ID t.9gdcs73pcwbg
{ "ty": "dc", "d": ["t.rpxohybjjjft", [1], 0] }      // Create another tab
```

### 3. `ac` — AddComment/AddTab
Creates a tab with a name:
```json
{ "ty": "ac", "d": ["t.taev36xqg9o0", [1, "Tab 2"], [1]] }
```
The `[1, "Tab 2"]` is `[index, "Tab Name"]`.

### 4. `mkch` — MarkComment/RenameTab
Renames a tab:
```json
{ "ty": "mkch", "d": [[1, "Idea Matrix"]] }
```

### 5. `ucp` — UpdateCursorPosition
Cursor position includes which tab the cursor is on:
```json
{ "ty": "ucp", "d": ["t.ao989aeozkre", [[], [1, "dump"]]] }
```
The first element is the tab ID.

## Tab ID Format

Tab IDs come in two forms:
- **Default tab**: `t.0` — the original tab that every document starts with. This is NOT in the `t.xxxxx` random-string format.
- **Created tabs**: `t.<random12chars>` — e.g., `t.taev36xqg9o0`, `t.ao989aeozkre`. These are generated when a user creates a new tab.

The default tab (`t.0`) does NOT appear in `nm.nmr[]` in the OT changelog. Only created tabs have their IDs tracked in named range references.

## Tab Names vs Tab IDs

Tab names are **mutable** — users can rename tabs at any time. The OT log records:
- **Creation name** via `ac`: e.g., `["t.taev36xqg9o0", [1, "Tab 2"], [1]]` — Google auto-assigns "Tab N" where N is a sequential counter
- **Renames** via `mkch`: e.g., `[[1, "Final"]]` — the user renamed the tab

The name in the OT log is a **point-in-time snapshot**. To get the current name, use the official Docs API:
```
GET https://docs.googleapis.com/v1/documents/{docId}?fields=tabs(tabProperties)
```

### Example: Ishan LinkedIn Post tab evolution

| Tab ID | OT creation name | Current name (Docs API) | Index |
|--------|-----------------|------------------------|-------|
| `t.0` | "Tab 1" (via `mkch`) | "Philip Example" | 0 |
| `t.taev36xqg9o0` | "Tab 2" (via `ac`) | "Final" | 1 |
| `t.ao989aeozkre` | (not captured) | "dump" | 2 |
| `t.4t74r7ngu6hd` | (not captured) | "Tab 4" | 3 |

The `tabProperties.index` field from the Docs API gives the **current display order** (0-indexed). This can differ from creation order if tabs have been reordered.

## Mapping Tab IDs to Tab Names

To build a tab map from the OT log alone:
1. Scan for `ac` operations — these create tabs with IDs and initial names: `"Tab 2"`, etc.
2. Scan for `mkch` operations — these rename tabs: `"Final"`, `"dump"`, etc.
3. The default tab (`t.0`) name comes from `mkch` only (it's not created via `ac`)

**Caveat**: The OT log only records the name at creation time and at each rename. If you need the current name, query the Docs API. Tab names in the OT log can be stale.

## Index Space

Each tab has its own independent 1-indexed character space. When an `nm` operation has `nmc.ibi = 14` and `nmr` contains `t.abc123`, that means position 14 within tab `t.abc123` — NOT position 14 in the global document. The codebase handles this with per-tab replay state (`Map<tabId, string[]>` in `replayWithDiffs`).

## Data from Our Workspace (12 docs)

| Document | Tab IDs | dc ops | ac ops | Tile gaps | Status |
|----------|---------|--------|--------|-----------|--------|
| Ishan LinkedIn Post | 3 (+default) | 0 | 1 | 4 | 4 tabs (edits on 2) |
| Company Brain | 6 | 29 | 5 | 0 | MULTI-TAB |
| Shepherd | 2 | 0 | 2 | 5 | MULTI-TAB |
| Apple for Health | 3 | 0 | 3 | 3 | MULTI-TAB |
| Shepherd YC Application | 2 | 21 | 1 | 43 | MULTI-TAB |
| All Shepherd Accelerator Apps | 2 | 0 | 1 | 12 | MULTI-TAB |
| Pivot | 1 | 0 | 1 | 0 | 2 tabs (edits on 1) |
| Others | 0 | 0 | 0 | 0-1 | single tab |

Key findings:
- **Company Brain** has 6 distinct tab IDs and 29 `dc` operations — the most complex multi-tab doc
- **Shepherd YC Application** has 43 tile gaps — the most gaps, correlating with 21 `dc` tab creation ops
- The LinkedIn Post has 4 tabs (confirmed via Docs API) but only 3 created tab IDs appear in the OT log — the default tab (`t.0`) doesn't show up in `nm.nmr[]`
- The OT log only recorded edits on 2 of the 4 tabs (Tab 2/"Final" and Tab 4)

## Tile Gaps and Tabs

Tile gaps correlate with multi-tab documents. The tile system skips entries that are:
1. `null` no-ops
2. Tab creation/management operations (`ac`, `dc`, `mkch`)
3. Entries between tab contexts

Tiles only cover entries where **content edits** happened. Tabs with no edits produce no tiles.

## Tab Move/Reorder Operations

Tab moves ARE recorded in the OT log via `mch` (ModifyComment/Header) operations. The `d` field contains the position change:

```json
{ "ty": "mch", "d": [[5], [1]] }           // move from position 5 to position 1
{ "ty": "mch", "d": [[3], [2, 0]] }        // move from position 3 to position 2, child 0
{ "ty": "mch", "d": [[1, 0], [1]] }        // move from position [1,0] to position [1]
```

The nested arrays represent hierarchical positions — Google Docs supports child/nested tabs (subtabs).

### Position array format

- `[2]` — top-level tab at position 2
- `[2, 0]` — first child (subtab) of tab at position 2
- `[2, 1, 0]` — first child of second child of tab 2 (3 levels deep!)
- `[1, 3]` — fourth child of tab at position 1

### Subtab operations

All standard tab operations work with hierarchical positions:

| Action | Op | Example | Meaning |
|--------|-----|---------|---------|
| Create subtab | `ac` | `["t.xxx", [1, "Tab 5"], [3, 0]]` | Create as child 0 of tab 3 |
| Move into subtab | `mch` | `[[3], [2, 0]]` | Move from top-level → child of tab 2 |
| Move out of subtab | `mch` | `[[2, 1, 0], [2, 0]]` | Promote from deep nesting → shallower |
| Reorder subtabs | `mch` | `[[1, 1], [1, 0]]` | Swap order of children under tab 1 |
| Configure subtab | `dc` | `["t.xxx", [2, 3], 0]` | Configure child 3 of tab 2 |
| Delete subtab | `dc` | `["t.xxx", [1, 0], 0]` | Delete child 0 of tab 1 |

### Observed subtab usage

| Document | Nested position ops | Max depth | Notes |
|----------|-------------------|-----------|-------|
| Shepherd | 171 | 2 | `[9, 3]`, `[4, 3]`, `[1, 2]` |
| Pivot | 103 | 2 | `[2, 0]`, `[1, 2]`, `[1, 0, 0]` |
| Company Brain | 44 | 2 | `[2, 6]`, `[2, 0]` |
| Shepherd YC App | 22 | 2 | `[2, 2]`, `[1, 4]` |
| Apple for Health | 9 | **3** | `[2, 1, 0]` — deepest nesting observed (matches Google's max) |

**Google's official limit: 3 levels of nesting** (source: [support.google.com/docs/answer/15499791](https://support.google.com/docs/answer/15499791)). This means position arrays have a max length of 3: `[parent, child, grandchild]`. Our observed data confirms this — Apple for Health hits the max at `[2, 1, 0]`.

**Every `mch` has a millisecond timestamp** (like all changelog entries), so tab reorders are fully timestamped.

### Hierarchy changes (top-level ↔ subtab)

Tabs frequently change hierarchy depth. In the Pivot doc alone, 36 of 69 `mch` moves change depth:

| Move type | Example | Meaning |
|-----------|---------|---------|
| TOP→SUB | `[3] → [2, 0]` | Top-level tab becomes child of tab 2 |
| SUB→TOP | `[3, 0] → [4]` | Subtab promoted to top-level |
| SUB→DEEPER | `[1, 1] → [1, 0, 1]` | Moved deeper into 3-level nesting |
| BATCH | entries 18148-18157 | 9 tabs nested under one parent in 7 seconds |

**The tab ID (`t.xxxxx`) is stable through all hierarchy changes.** A tab keeps the same ID regardless of its position in the tree. Our codebase uses `tabId` from `nm.nmr[]` for replay/attribution, not the position array — so hierarchy changes don't affect content tracking.

To reconstruct the hierarchy at a specific point in time, you'd need to replay all `ac` (create) and `mch` (move) operations in order, maintaining a tree of `[tabId → parentTabId, position]` mappings.

### Observed patterns

After creating a tab (via `ac`), it's immediately followed by `mch` to move it to the desired position:
```
[4766] May 7, 10:09:30 PM | ac   | ["t.v0xlshp5aryk", [1, "Tab 19"], [6]]
[4767] May 7, 10:09:34 PM | mch  | [[6], [3, 0]]
```
Tab 19 was created at position 6, then moved to position [3, 0] four seconds later.

### Scale

- Company Brain: 67 tab operations (ac + dc + mkch + mch)
- Pivot: 115+ tab operations
- The `mch` operation is the most frequent tab op — tabs are moved constantly

## Tab Deletion

Tab deletion uses the `dc` (DocumentConfiguration) operation — the same type used for tab creation/configuration, but with a simpler payload.

**Confirmed** by creating and deleting "Tab 5" in the Ishan LinkedIn Post:

```
[2353] 12:12:15 PM | mlti  | ac: CREATE ["t.19wqjoeiswww", [1, "Tab 5"], [4]]  ← tab created
[2354-2357]        | nm    | INSERT on t.19wqjoeiswww: "efwefwefwef"             ← typed in it
[2358] 12:12:21 PM | dc    | ["t.19wqjoeiswww", [4], 0]                         ← tab DELETED
```

The deletion `dc` payload is `[tabId, [positionIndex], 0]`:
- First element: the tab ID being deleted
- Second element: the position array `[4]` = tab was at position 4
- Third element: `0` (likely a flag indicating removal)

Compare with tab creation `dc` entries which have more complex position arrays like `[tabId, [index, subindex], 0]`.

## Timestamps

Every tab operation has a millisecond timestamp (entry tuple element [1]):
- Tab creation (`ac`): when the tab was created
- Tab rename (`mkch`): when the rename happened
- Tab move (`mch`): when the tab was dragged to its new position
- Tab config (`dc`): when the configuration was applied

## Limitations

- Tab deletion uses `dc` with `[tabId, [pos], 0]` — confirmed by live test
- The default tab (`t.0`) does not appear in `nm.nmr[]` — edits on the default tab may not have a tab ID in the OT log
- The Docs API `tabProperties.index` gives current order, but this may not match historical OT log positions after reorders
- Nested/child tab positions (e.g., `[2, 3]`) are not fully understood — the hierarchy depth and semantics need more testing
