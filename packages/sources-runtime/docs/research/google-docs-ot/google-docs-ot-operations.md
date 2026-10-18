# Google Docs OT Operation Types Reference

Comprehensive reference for all operation types in the undocumented `/revisions/load` endpoint. Based on live testing against 5 workspace docs + analysis of KumoDocs, Harvard gdocrevisions, and DocuViz2 source code.

## Changelog Entry Structure

Each entry is a tuple: `[operationObj, timestampMs, userId, revisionId, sessionId, sessionIndex]`

## Operation Types

### Text Content Operations

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `is` | InsertString | `s` (text), `ibi` (1-indexed position) | Insert text. Rarely top-level; usually inside `nm` |
| `ds` | DeleteString | `si` (start), `ei` (end, inclusive, 1-indexed) | Delete range |
| `iss` | InsertStringSuggestion | `s`, `ibi`, `sugid` | Suggested insert |
| `dss` | DeleteStringSuggestion | `si`, `ei`, `sugid` | Suggested delete |
| `msfd` | MarkStringForDeletion | `si`, `ei` | Mark text for deletion in suggestion mode |
| `usfd` | UnmarkStringForDeletion | `si`, `ei` | Reject deletion suggestion |

### Container/Wrapper Operations

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `nm` | NamedMutation | `nmc` (inner op), `nmr` (named range IDs) | Wraps text ops in named range context. **85%+ of all operations in modern Docs.** |
| `mlti` | MultiOperation | `mts[]` (sub-operations) | Atomic container for multiple operations |

`nm` is critical: nearly ALL user keystrokes are wrapped in `nm`. The inner text op is in `nmc`, the affected named ranges in `nmr[]` (prefixed `kix.` or `t.`).

### Formatting Operations

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `as` | ApplyStyle | `si`, `ei`, `st` (style type), `sm` (style mod) | Format change (bold, italic, heading, etc.) |
| `sas` | SuggestAdjustStyle | `si`, `ei`, `st`, `sm`, `sugid` | Suggested format change |

Style types (`st`): `"text"`, `"paragraph"`, `"language"`, `"headings"`, `"document"`
Style sub-properties use prefixes: `ts_` (text), `ps_` (paragraph), `ds_` (document), `hs_` (headings)

### Structural Element Operations

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `ae` | AddElement | `et`, `epm`, `spi` | Add table, image, drawing, page break, etc. |
| `de` | DeleteElement | element ID fields | Remove structural element |
| `ue` | UpdateElement | element ID + properties | Update element properties (resize image, etc.) |
| `te` | TetherElement | position + element fields | Anchor floating element to text position |

### Document State Operations

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `rplc` | Replace | `snapshot[]` (array of ops) | Full document replacement. Snapshot contains `is`/`as` ops to rebuild |
| `rvrt` | Revert | `snapshot[]` | Revert to snapshot (Version History > Restore) |

### Annotation/Comment Operations

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `ac` | AddComment | comment anchor fields | Create comment anchor in document |
| `mch` | ModifyComment | modified properties | Modify comment anchor or header/footer |
| `mkch` | MarkComment | mark state fields | Resolve/unresolve comment |

### Document Configuration

| Type | Name | Fields | Description |
|------|------|--------|-------------|
| `dc` | DocumentConfiguration | `d` = `[tabId, indices, flags]` | Tab creation/structure. Tab IDs prefixed `t.` |

### Non-Content Operations

| Type | Name | Description |
|------|------|-------------|
| `ucp` | UpdateCursorPosition | Real-time cursor tracking for collaboration. No content effect |
| `null` | Null/No-op | Placeholder entries. No content effect |

## Frequency Distribution (from real data)

From the Ishan LinkedIn Post (2,352 entries):
- `nm`: 1,952 (83%) — contains 2,067 inserts + format ops inside `nmc`
- `mlti`: 388 (16.5%) — multi-op containers
- `ucp`: 3
- `null`: 8
- `mch`: 1

From the Pivot doc (22,890 entries):
- `nm`: 16,757 (73%)
- `mlti`: 3,870 (17%)
- `is` (direct): 1,827 (8%)
- `ds` (direct): 160
- `as`: 67
- `mch`: 71
- `ucp`: 63
- `null`: 68
- `dc`: 7

## Tab Support

The `/revisions/load` changelog is a single flat stream across all tabs. Tab identity is encoded in:
- `nm.nmr[]` values with `t.` prefix (e.g., `t.9gdcs73pcwbg`)
- `dc` operations that create/configure tabs
- The document's index space (each tab occupies a separate index range)

There is no explicit `tabId` field on individual `is`/`ds` operations.

## Key Implementation Notes

1. To extract ALL text changes: unwrap `nm.nmc`, recurse into `mlti.mts[]`, handle `nm` inside `mlti`
2. Indices are 1-indexed throughout (matching Python library convention)
3. Anti-XSSI prefix: 5 chars for `/revisions/load`, 4 chars for `/revisions/tiles`
4. `rplc`/`rvrt` clear document state; their `snapshot[]` sub-ops rebuild it
5. `dc` with `d[0] = ""` is the default tab; non-empty strings are custom tab IDs
