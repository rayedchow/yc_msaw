# Named Ranges (nm/nmr System)

How Google Docs uses named ranges internally and why nearly all operations are wrapped in `nm`.

## What Are Named Ranges?

Google Docs tracks internal positional markers called "named ranges." These are used for:
- **Comment anchors** — where in the document a comment thread is attached
- **Bookmark anchors** — internal links within the document
- **Link references** — hyperlink target positions
- **Tab boundaries** — which tab owns which portion of the index space
- **State management** — internal cursor and selection tracking

The public Docs API exposes these as `NamedRange` objects. The OT system uses them to track which ranges need to be updated when text is inserted or deleted.

## Why `nm` Wraps Everything

When you type a character at position 14 in a document, Google needs to:
1. Insert the character (the `nmc` operation: `{ty: "is", ibi: 14, s: "a"}`)
2. Shift all named ranges that start at or after position 14 forward by 1

The `nm` operation bundles both actions atomically. The `nmr` array lists which named ranges are affected.

This is why 73%+ of top-level operations are `nm` in modern docs — any text change that falls within a named range (which is almost all text in a document) gets wrapped.

## nmr Field Values

The `nmr` array always contains strings. Observed prefixes:

| Prefix | Count | Description |
|--------|-------|-------------|
| `ksm` | 254,837 | "Kix State Manager" — always present, internal state tracker |
| `t.` | 254,837 | Tab-scoped named range ID (e.g., `t.taev36xqg9o0`) |

Every `nm` operation in our 10-doc, 122,560-entry dataset had exactly two `nmr` values: `"ksm"` and a `t.` prefixed string.

Note: Documents with comments, bookmarks, or links may have additional `kix.` prefixed named range IDs in `nmr`. Our test corpus had no active comment anchors overlapping with edit positions, so `kix.` prefixed entries only appeared in `ae`/`de`/`te` operations (not in `nmr`).

## kix Prefix

`kix` is the internal codename for the Google Docs editor (appears in element IDs):
```json
{ "ty": "ae", "id": "kix.5dg9uurdx6il", "et": "list" }
{ "ty": "te", "id": "kix.6y2r9du4zdgs", "spi": 1 }
```

These are structural element identifiers, separate from the named range system.

## Practical Implications for Parsing

1. **Always unwrap `nm`** — the text operation is in `nmc`, not at the top level
2. **The `nmr` array tells you which tab** — extract the `t.xxxxx` value to know which tab was edited
3. **`ksm` is always present** — it's the default state tracker, safe to ignore for attribution purposes
4. **No `nm` inside `nm`** — the `nmc` field always contains a leaf operation type, never another `nm`
5. **`mlti` CAN contain `nm`** — and frequently does (126,333 occurrences of `mlti>nm`)
