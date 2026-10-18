# Nesting Patterns

Operations nest inside container types. Understanding the nesting is critical for parsing all text changes.

## Container Types

Only three operation types contain other operations:
1. **`nm`** — wraps one operation in `nmc`
2. **`mlti`** — wraps N operations in `mts[]`
3. **`rplc`/`rvrt`** — wraps N operations in `snapshot[]`

## Top 20 Patterns (from 122,560 entries)

| Count | Pattern | What it is |
|-------|---------|------------|
| 81,260 | `nm[is]` | Single character insert (most common) |
| 6,612 | `nm[ds]` | Single character delete |
| 5,857 | `is` | Direct insert (no nm wrapper, older docs) |
| 4,482 | `mlti[nm[ds],nm[ds]]` | Two deletes in one action |
| 3,930 | `mlti[nm[ds],nm[is]]` | Replace: delete + insert |
| 2,798 | `mlti[nm[is],nm[as]]` | Insert with formatting |
| 1,516 | `nm[as]` | Format change |
| 1,476 | `mlti[nm[is],nm[as],nm[as]]` | Insert with two format changes |
| 1,287 | `null` | No-op |
| 1,006 | `mlti[mlti[nm[is],nm[as]],mlti[nm[is],nm[as]]]` | Two formatted inserts |
| 825 | `mlti[nm[as],nm[as]]` | Two format changes |
| 542 | `mlti[nm[ds],nm[ds],nm[ds]]` | Three deletes |
| 490 | `ds` | Direct delete (no nm wrapper) |
| 403 | `mlti[nm[as],nm[as],nm[ds]]` | Format + delete |
| 348 | `mlti[nm[ds],nm[ds],nm[is]]` | Two deletes + insert |
| 343 | `mlti[nm[ae],nm[ue],nm[ue],nm[as],nm[as]]` | Add element with styling |
| 334 | `mlti[ds,ds]` | Two direct deletes (older docs) |
| 325 | `mlti[ds,is]` | Direct replace (older docs) |
| 333 | `mlti[nm[as],nm[as],nm[as]]` | Three format changes |
| 292 | `mlti[mlti[nm[is],nm[as],nm[as]],mlti[nm[as],nm[as]]]` | Complex formatted insert |

## Nested Path Frequency (what's inside what)

| Path | Count | Description |
|------|-------|-------------|
| `mlti>nm` | 126,333 | nm inside mlti (very common) |
| `mlti>nm>as` | 89,843 | Format change inside nm inside mlti |
| `nm>is` | 81,260 | Text insert inside nm |
| `mlti>mlti>nm` | 33,312 | nm inside nested mlti |
| `mlti>mlti>nm>as` | 27,457 | Deep nested format |
| `mlti>nm>ds` | 20,080 | Delete inside nm inside mlti |
| `mlti>nm>is` | 14,007 | Insert inside nm inside mlti |
| `mlti>as` | 7,451 | Direct format inside mlti |
| `nm>ds` | 6,612 | Delete inside nm |
| `mlti>mlti` | 6,193 | Nested mlti |
| `rplc>nm` | 5,542 | nm inside replace snapshot |

## How to Parse Everything

```
function extractTextOps(op):
  if op.ty == "mlti":
    for sub in op.mts:
      extractTextOps(sub)
  
  else if op.ty == "nm":
    if op.nmc exists:
      extractTextOps(op.nmc)
  
  else if op.ty == "rplc" or op.ty == "rvrt":
    clear document state
    for sub in op.snapshot:
      extractTextOps(sub)
  
  else if op.ty in ["is", "ds", "iss", "dss"]:
    // This is a leaf text operation — process it
    applyToDocumentState(op)
  
  else:
    // Format, element, cursor, etc. — skip for text extraction
```

## Key Observations

1. **Modern docs use `nm` everywhere** — docs created/edited after ~2020 wrap nearly all operations in `nm`. Older docs have more direct `is`/`ds` at the top level.

2. **`mlti` nesting can go 2+ levels deep** — `mlti[mlti[nm[is],nm[as]],mlti[nm[as]]]` is common for paste operations with complex formatting.

3. **`rplc` snapshots contain full document rebuilds** — the snapshot array has `mkch` (tab names), `ac` (tab creation), then `nm[is]` and `nm[as]` operations to populate content.

4. **No `nm` wrapping `nm`** — Verified across 75,890 nm operations: every single `nmc` contained a leaf type, never another `nm`. The observed inner types are: `as` (51%), `is` (40%), `ds` (8%), `ae`, `ue`, `de`, `te` (all <1%).

5. **`mlti` CAN wrap `mlti`** — and frequently does (6,193 occurrences).

6. **Every `nm` has `nmc`** — Verified: 75,890 out of 75,890 nm operations had a non-null `nmc` field. Zero nm operations without nmc were observed.
