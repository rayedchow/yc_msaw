# Operation Types

Every operation has a `ty` field. Verified across 19 docs (12 workspace + 6 personal + 1 shared), 552,861 total operations (including nested).

## How Logging Works

The changelog is NOT a diff format. It's a sequential log of individual operations — every keystroke, every format change, every structural modification gets its own entry (or is batched into a `mlti` container if they happen atomically). The system records:

1. **What happened**: The operation object (insert text, delete range, apply bold, etc.)
2. **When**: Millisecond timestamp
3. **Who**: Google user ID
4. **Position in history**: Revision number and session info

To reconstruct the document at any point, you replay operations from the beginning, applying each insert/delete/replace in order to a character array. This is "operational transform" — each operation transforms the document state.

## Frequency Distribution (552,861 operations across 12 workspace docs, all nesting levels)

| Type | Count | Pct | Category |
|------|-------|-----|----------|
| `nm` | 251,623 | 45.5% | Wrapper |
| `as` | 130,419 | 23.6% | Format |
| `is` | 105,755 | 19.1% | Text |
| `mlti` | 30,075 | 5.4% | Wrapper |
| `ds` | 29,593 | 5.4% | Text |
| `ae` | 1,434 | 0.3% | Element |
| `null` | 1,298 | 0.2% | No-op |
| `ue` | 1,128 | 0.2% | Element |
| `ac` | 259 | <0.1% | Comment/Tab |
| `ucp` | 254 | <0.1% | Cursor |
| `iss` | 245 | <0.1% | Text (suggestion) |
| `mch` | 238 | <0.1% | Comment/Tab |
| `de` | 206 | <0.1% | Element |
| `te` | 88 | <0.1% | Element |
| `dss` | 87 | <0.1% | Text (suggestion) |
| `dc` | 84 | <0.1% | Tab config |
| `msfd` | 42 | <0.1% | Suggestion |
| `mkch` | 7 | <0.1% | Comment/Tab |
| `sas` | 6 | <0.1% | Format (suggestion) |
| `usfd` | 5 | <0.1% | Suggestion |
| `astss` | 4 | <0.1% | Format (snapshot) |
| `rplc` | 3 | <0.1% | Snapshot |
| `utlp` | 3 | <0.1% | Config |
| `umv` | 3 | <0.1% | Config |
| `ras` | 2 | <0.1% | Suggestion |

Note: At the top level, most entries are `nm` (73%) or `mlti` (20%). The `as`, `is`, `ds` counts above include operations nested inside `nm` and `mlti` wrappers. Top-level `is`/`ds` are rare (older docs only).

## nm Inner Types (75,890 nm operations sampled from 5 docs)

| nmc.ty | Count | Description |
|--------|-------|-------------|
| `as` | 38,710 | Format changes (most common inner type) |
| `is` | 30,043 | Text insertions |
| `ds` | 6,331 | Text deletions |
| `ae` | 422 | Add element |
| `ue` | 306 | Update element |
| `de` | 55 | Delete element |
| `te` | 23 | Tether element |

**Verified**: nm never wraps another nm. The nmc field always contains a leaf operation type.

## Text Content Operations

### `is` — InsertString
Insert text at a position.
```json
{ "ty": "is", "ibi": 14, "s": "hello" }
```
- `ibi`: Insert-before-index (1-indexed position)
- `s`: String to insert (single char or multi-char)

### `ds` — DeleteString
Delete a range of characters.
```json
{ "ty": "ds", "si": 10, "ei": 15 }
```
- `si`: Start index (1-indexed, inclusive)
- `ei`: End index (1-indexed, inclusive)
- Deletes characters at positions si through ei

### `iss` — InsertStringSuggestion
Suggested text insertion (suggesting mode).
```json
{ "ty": "iss", "sugid": "suggest.gh3v2o30oabr", "ibi": 230, "s": "realized" }
```
- Same fields as `is` plus `sugid` (suggestion ID)

### `dss` — DeleteStringSuggestion
Suggested text deletion (suggesting mode).
```json
{ "ty": "dss", "sugid": "suggest.abc123", "si": 296, "ei": 296 }
```
- Same fields as `ds` plus `sugid`

### `msfd` — MarkStringForDeletion
Mark text for deletion within a suggestion. Changes characters' suggestion state to "pending delete" (shown as strikethrough in UI).
```json
{ "ty": "msfd", "sugid": "suggest.gh3v2o30oabr", "si": 230, "ei": 250 }
```

### `usfd` — UnmarkStringForDeletion
Reject a deletion suggestion. Reverts text back to normal state.
```json
{ "ty": "usfd", "sugid": "suggest.1dguw1hn6h5l", "si": 3336, "ei": 3339 }
```

### `ras` — RejectAllSuggestions
Reject a suggestion range.
```json
{ "ty": "ras", "sugid": "suggest.lzz7mex81dkx", "si": 4387, "ei": 4564 }
```

## Container/Wrapper Operations

### `nm` — NamedMutation
Wraps a text/format operation within a named range context. **This is the most common operation type** — 73% of all top-level operations and 85%+ when including those inside `mlti`.

```json
{
  "ty": "nm",
  "nmr": ["ksm", "t.taev36xqg9o0"],
  "nmc": { "ty": "is", "ibi": 14, "s": "hello" }
}
```
- `nmc`: The inner content operation (any operation type)
- `nmr`: Array of named range IDs affected by this operation
  - Always includes `"ksm"` (Kix State Manager)
  - Always includes a tab-scoped ID like `"t.taev36xqg9o0"`

See [named-ranges.md](named-ranges.md) for details on the nmr system.

### `mlti` — MultiOperation
Atomic container for multiple sub-operations that must be applied together.
```json
{
  "ty": "mlti",
  "mts": [
    { "ty": "nm", "nmr": [...], "nmc": { "ty": "ds", "si": 10, "ei": 15 } },
    { "ty": "nm", "nmr": [...], "nmc": { "ty": "is", "ibi": 10, "s": "world" } }
  ]
}
```
- `mts`: Array of sub-operations
- Sub-ops can be any type including nested `mlti` and `nm`
- Common patterns: delete+insert (replace word), insert+format, multi-line paste

## Formatting Operations

### `as` — ApplyStyle
Apply formatting to a range of text or paragraph.
```json
{
  "ty": "as",
  "st": "text",
  "si": 5,
  "ei": 10,
  "sm": { "ts_bd": true, "ts_bd_i": false }
}
```
- `st`: Style type — `"text"`, `"paragraph"`, `"document"`, `"headings"`, `"language"`
- `si`/`ei`: Range (1-indexed, inclusive)
- `sm`: Style modification object (see style properties below)

### `sas` — SuggestAdjustStyle
Suggested formatting change.
```json
{
  "ty": "sas",
  "sugid": "suggest.abc123",
  "st": "text",
  "si": 100,
  "ei": 200,
  "sm": { "ts_st": true, "ts_st_i": false }
}
```

### `astss` — ApplyStyleToSnapshot
Format change in a snapshot/replace context. Same fields as `as`.

### Style Properties (Complete Catalog)

Verified across 44,377 format operations and 371,340 individual style fields with 100% humanizer coverage. The humanizer is implemented in `brain/src/polling/gdocs-style-humanizer.ts`.

**Text styles** (`ts_` prefix — 45,884 occurrences):
| Field | Meaning | Example value |
|-------|---------|---------------|
| `ts_bd` | Bold | `true` / `false` |
| `ts_it` | Italic | `true` / `false` |
| `ts_un` | Underline | `true` / `false` |
| `ts_st` | Strikethrough | `true` / `false` |
| `ts_sc` | Small caps | `true` / `false` |
| `ts_fs` | Font size (points) | `10.5`, `16` |
| `ts_ff` | Font family | `"Roboto"`, `"Arial"` |
| `ts_tw` | Font weight (100-900) | `400` (normal), `700` (bold) |
| `ts_va` | Vertical alignment | `"nor"` (normal), `"sup"` (superscript), `"sub"` (subscript) |
| `ts_fgc` | Text color (legacy) | `"#000000"` |
| `ts_fgc2` | Text color | `{ hclr_color: "#0a66c2", clr_type: 0 }` |
| `ts_bgc` | Highlight color (legacy) | `"#ffff00"` |
| `ts_bgc2` | Highlight color | `{ hclr_color: "#ffffff", clr_type: 0 }` |

**Paragraph styles** (`ps_` prefix — 308,903 occurrences):
| Field | Meaning | Example value |
|-------|---------|---------------|
| `ps_hd` | Heading level | `0` (normal), `1`-`6` (Heading 1-6) |
| `ps_al` | Alignment | `0` (left), `1` (center), `2` (right), `3` (justified) |
| `ps_ls` | Line spacing | `1.15` |
| `ps_lslm` | Line spacing mode | `0` (multiples), `1` (points) |
| `ps_sa` / `ps_sb` | Space after/before (pts) | `0`, `6`, `16` |
| `ps_ifl` | First line indent (pts) | `0`, `36` |
| `ps_il` / `ps_ir` | Left/right indent (pts) | `0`, `36` |
| `ps_ltr` | Left-to-right direction | `true` / `false` |
| `ps_klt` | Keep lines together | `true` / `false` |
| `ps_kwn` | Keep with next paragraph | `true` / `false` |
| `ps_awao` | Avoid widow/orphan | `true` / `false` |
| `ps_pbb` | Page break before | `true` / `false` |
| `ps_bt` | Border top / bullet style | border object or `null` |
| `ps_bb` / `ps_bl` / `ps_br` | Borders bottom/left/right | border object or `null` |
| `ps_bbtw` | Border between paragraphs | border object or `null` |
| `ps_sd` | Shading | shading object or `null` |
| `ps_shd` | Shading enabled | `true` / `false` |
| `ps_sm` | Space mode | `0` |
| `ps_rd` | Run direction | `""` (default) |
| `ps_hdid` | Heading ID | `""` |
| `ps_ts` | Tab stops | `{ cv: { op: "set", opValue: [] } }` |

**Document styles** (`ds_` prefix — 697 occurrences):
| Field | Meaning | Example value |
|-------|---------|---------------|
| `ds_pw` / `ds_ph` | Page width/height (pts) | `612` (letter width), `792` (letter height) |
| `ds_mt` / `ds_mb` / `ds_ml` / `ds_mr` | Margins (pts) | `72` (1 inch) |
| `ds_lhs` | Layout header/section | `1` |
| `ds_ulhfl` | Landscape header/footer | `false` |
| `ds_df` | Default formatting | `{ df_dm: 0 }` |
| `ds_fpo` | First page different | `false` |
| `ds_pnsi` | Page number start index | `1` |

**Table cell styles** (`cell_` prefix — 1,776 occurrences):
| Field | Meaning | Example value |
|-------|---------|---------------|
| `cell_pt` / `cell_pb` / `cell_pl` / `cell_pr` | Cell padding (pts) | `6`, `9` |
| `cell_bt` / `cell_bb` / `cell_bl` / `cell_br` | Cell borders | border object |
| `cell_bgc2` | Cell background | `{ hclr_color: "#f3f3f3", clr_type: 0 }` |
| `cell_va` | Vertical alignment | `0` (top), `1` (middle), `2` (bottom) |
| `cell_cs` / `cell_rs` | Column/row span | `1` |

**Table row styles** (`row_` prefix — 180 occurrences):
| Field | Meaning | Example value |
|-------|---------|---------------|
| `row_th` | Header row | `true` / `false` |
| `row_mh` | Min row height (pts) | `26.25` |

**Table styles** (`tbls_` prefix — 174 occurrences):
`tbls_cols` (column widths), `tbls_al` (alignment), `tbls_bw` (border width), `tbls_bc2` (border color), `tbls_dshb`/`tbls_dsvb` (horizontal/vertical banding), `tbls_eslr`/`tbls_eslc`/`tbls_esfr`/`tbls_esfc` (show last/first row/column), plus 20+ conditional formatting fields (`tbls_cf*`).

**List styles** (`ls_` prefix — 10,546 occurrences):
`ls_nest` (nesting level), `ls_id` (list ID), `ls_ts` (text style), `ls_c` (continuation).

**Heading style definitions** (`hs_` prefix — 603 occurrences):
`hs_h1` through `hs_h6` (heading level styles), `hs_t` (title), `hs_st` (subtitle), `hs_nt` (normal text). Each contains `{ sdef_ps: {...}, sdef_ts: {...} }` defining paragraph and text styles for that heading level.

**Link styles** (`lnks_` prefix — 244 occurrences):
`lnks_link` with `{ lnk_type: 0, ulnk_url: "https://..." }`.

**Section styles** (`css_` prefix):
`css_ml`/`css_mr`/`css_mt`/`css_mb` (section margins), `css_pnsi` (page number start), `css_fpo` (first page different).

**Language** (`lgs_` prefix):
`lgs_l` — language code (e.g., `"en"`).

**The `_i` suffix**: Fields ending in `_i` are "inherit" flags. When `true`, the property inherits from the parent style. When `false`, the explicit value takes effect. The humanizer skips these since they're metadata about styling intent, not visible changes.

## Structural Element Operations

### `ae` — AddElement
Add a structural element (list, table, image, etc.).
```json
{ "ty": "ae", "et": "list", "id": "kix.5dg9uurdx6il", "epm": { "le_nb": { ... } } }
```
- `et`: Element type (`"list"`, `"inline"`, `"table"`, etc.)
- `id`: Element ID (prefixed `kix.`)
- `epm`: Element properties map

### `de` — DeleteElement
Remove a structural element.
```json
{ "ty": "de", "id": "kix.4b85bkzarnm4", "et": "inline" }
```

### `ue` — UpdateElement
Update element properties (resize image, change list style, etc.).
```json
{ "ty": "ue", "id": "kix.e649nf93438e", "epm": { "le_nb": { ... } } }
```

### `te` — TetherElement
Anchor a floating element to a text position.
```json
{ "ty": "te", "id": "kix.6y2r9du4zdgs", "spi": 1 }
```
- `spi`: Start position index

## Document State Operations

### `rplc` — Replace
Full document replacement. Contains a `snapshot` array of operations that rebuild the document from scratch.
```json
{
  "ty": "rplc",
  "snapshot": [
    { "ty": "mkch", "d": [[1, "Tab Name"]] },
    { "ty": "ac", "d": ["t.xxx", [1, "Tab 2"], [1]] },
    { "ty": "nm", "nmr": [...], "nmc": { "ty": "is", "ibi": 1, "s": "..." } },
    ...
  ]
}
```
When replaying: clear the document state, then process each snapshot sub-operation.

### `rvrt` — Revert
Revert to a previous snapshot (Version History > Restore this version). Same structure as `rplc`.

## Tab/Comment Operations

### `dc` — DocumentConfiguration
Creates/configures document tabs.
```json
{ "ty": "dc", "d": ["", [1], 0] }           // default tab (empty string = default)
{ "ty": "dc", "d": ["t.8ah971vt1cwz", [2, 0], 0] }  // create named tab
```

### `ac` — AddComment/AddTab
Creates a comment anchor OR a new tab in the document.
```json
// Creating a tab:
{ "ty": "ac", "d": ["t.taev36xqg9o0", [1, "Tab 2"], [1]] }
// The second element is [index, "Tab Name"]
```

### `mch` — ModifyComment/Header
Modify a comment anchor or header/footer configuration.
```json
{ "ty": "mch", "d": [[1], [0]] }
```

### `mkch` — MarkComment/RenameTab
Resolve/unresolve a comment, or rename a tab.
```json
{ "ty": "mkch", "d": [[1, "Idea Matrix"]] }  // rename tab to "Idea Matrix"
```

## Non-Content Operations

### `ucp` — UpdateCursorPosition
Records cursor position for real-time collaboration presence. No effect on document content. Contains tab context.
```json
{ "ty": "ucp", "d": ["t.ao989aeozkre", [[], [1, "dump"]]] }
// First element is the tab ID where the cursor is
```

### `umv` — UpdateModelVersion
Internal model version bump.
```json
{ "ty": "umv", "mv": 61 }
```

### `utlp` — UpdateTopLevelProperties
Document-level configuration (language, etc.).
```json
{ "ty": "utlp", "d": [[[], [1, "en"]]] }
```

### `null` — No-op
Placeholder entry with no content effect.
```json
{ "ty": "null" }
```

## Completeness

This list was compiled by exhaustively scanning 552,861 operations across 19 docs (12 workspace, 6 personal, 1 shared) at every nesting level. Cross-verified against 5 independent sources (KumoDocs, Harvard gdocrevisions, DocuViz2, AuthorViz, Draftback) and Exa web search. **No source has types we don't have.** Our 25 types + null is the most comprehensive catalog that exists.

### Types NOT in any external source but found in our data
- `dc` (tab configuration)
- `ac` (tab creation, not just comments)
- `mkch` (tab renaming)
- `astss` (snapshot style)
- `ras` (reject suggestions)
- `umv` (model version)
- `utlp` (top-level properties)

### Untested features — predicted operation mapping

These features were not present in our test corpus. Based on the Google Docs API `batchUpdate` request types and the OT protocol structure, here's how they likely map:

| Feature | Predicted OT type(s) | Confidence | Reasoning |
|---------|---------------------|------------|-----------|
| Equations/LaTeX | `ae` (AddElement) | HIGH | Equations are ParagraphElements in the API. Content edits inside equations likely use `is`/`ds` within the equation segment. |
| Smart chips (@mentions, dates) | `ae` + `is` in `nm` | HIGH | Person, RichLink, DateElement are ParagraphElements. Inline objects added via `ae`. |
| Drawings | `ae`/`de`/`ue` | HIGH | Inline objects. KumoDocs specifically handles drawing recovery from the changelog. |
| Footnotes | `ae` (add FootnoteReference) | HIGH | API has `CreateFootnoteRequest`. Creates a new segment + FootnoteReference element. |
| Headers/Footers | `ae`/`de` | MEDIUM | API has `CreateHeaderRequest`/`CreateFooterRequest`. May produce `ae` or config-level op. |
| Table of contents | `ae` | HIGH | ToC is a StructuralElement in the API. |
| Page breaks | `ae` or `is` (special char) | MEDIUM | API has `InsertPageBreakRequest`. Could be element add or special char insert. |
| Section breaks | `ae` | HIGH | SectionBreak is a StructuralElement in the API. |
| Watermarks | `ue`/`utlp` | LOW | No public API documentation. May use `utlp` or doc-level config. |
| Linked Sheets charts | `ae` (InlineObject) | HIGH | API has `InsertInlineSheetsChartRequest`. |
| Building blocks | `ae` + `nm` | MEDIUM | Templates expand into standard structural elements. |
| Table cell merge/unmerge | `ue` | MEDIUM | API has `MergeTableCellsRequest`. Likely `ue` on table cells. |

**Key insight**: None of these features produce new top-level `ty` codes. They all use existing element operations (`ae`/`de`/`ue`/`te`) with different element type values in the payload. The element type is in the operation data, not the `ty` field.

### Theoretical types that may exist but were never observed

Based on the Google Docs API request types:
- `uds` — UpdateDocumentStyle (our `utlp` may cover this)
- `uss` — UpdateSectionStyle (our `as` may cover section-level styling)
- `mtc`/`utc` — MergeTableCells/UnmergeTableCells (likely `ue` in practice)
- `rimg` — ReplaceImage (likely `ue` on the inline object)
- `adt`/`dlt`/`utp` — AddDocumentTab/DeleteTab/UpdateTabProperties (our `dc` covers creation; delete/update not observed)

Risk: LOW. These either decompose into compound operations using existing types, or are extremely rare operations not triggered in normal editing.
