# Document State Replay

How to reconstruct the document at any point by replaying the OT changelog.

## Core Concept

The changelog is NOT a diff format. It's a sequential log of individual operations. Each entry is one atomic action (a keystroke, a paste, a format change). To get the document state at any point, replay operations from the beginning.

## The Document State Model

The document is a flat array of characters (1-indexed):

```
docState = []  // starts empty
```

### InsertString (`is`)
Insert characters at position `ibi` (1-indexed, insert-before):
```
// { ty: "is", ibi: 1, s: "Hello" }
docState.splice(ibi - 1, 0, ...chars)
// docState = ['H','e','l','l','o']
```

### DeleteString (`ds`)
Delete characters from position `si` to `ei` (inclusive, 1-indexed):
```
// { ty: "ds", si: 2, ei: 4 }
count = ei - si + 1  // 3 characters
docState.splice(si - 1, count)
// removes chars at positions 2, 3, 4
```

### Replace (`rplc`) / Revert (`rvrt`)
Clear the entire document, then process the `snapshot[]` sub-operations:
```
docState.length = 0
for sub of op.snapshot:
  apply(sub)
```

### Format (`as`, `sas`, etc.)
Format changes don't affect the character array. Skip for text reconstruction.

### Elements (`ae`, `de`, `ue`, `te`)
Structural elements (lists, tables, images) don't appear in the character array. Skip for text reconstruction.

## Replay Algorithm

```typescript
const docState: string[] = [];

for (const entry of changelog) {
  const ops = flattenOp(entry[0]); // unwrap nm, mlti, rplc
  
  for (const op of ops) {
    switch (op.type) {
      case "insert":
      case "insert_suggestion":
        const chars = op.text.split("");
        const pos = op.ibi - 1; // convert to 0-indexed
        docState.splice(pos, 0, ...chars);
        break;
        
      case "delete":
      case "delete_suggestion":
        const si = op.si - 1;
        const count = op.ei - op.si + 1;
        docState.splice(si, count);
        break;
        
      case "replace":
      case "revert":
        docState.length = 0;
        // snapshot sub-ops will rebuild via recursion
        break;
    }
  }
}

const finalText = docState.join("");
```

## Recovering Deleted Text

To capture what was deleted (not just that something was deleted), read the document state BEFORE applying the delete:

```typescript
if (op.type === "delete") {
  const si = op.si - 1;
  const count = op.ei - op.si + 1;
  const deletedText = docState.slice(si, si + count).join("");
  // Now deletedText contains what was removed
  docState.splice(si, count);
}
```

## Chunked Diffs (Version History Style)

To produce chunks that match the Version History UI:

1. Fetch tiles from `/revisions/tiles` (these define chunk boundaries)
2. Fetch the full changelog from `/revisions/load`
3. For each tile, replay all operations whose `changelogIndex` falls within `[tile.start, tile.end]`
4. Collect insertions and deletions within each chunk

```typescript
for (const tile of tiles) {
  while (opIndex < ops.length && ops[opIndex].changelogIndex <= tile.end) {
    // apply operation and track insertions/deletions
    opIndex++;
  }
  // emit chunk diff
}
```

**Important**: Match operations to tiles by their 1-indexed `changelogIndex` (position in the raw changelog array), NOT by `revisionId`. Tiles use changelog entry indices.

## Consolidation

Adjacent insertions at sequential positions can be merged into single strings:
```
[{text: "H", pos: 0}, {text: "e", pos: 1}, {text: "l", pos: 2}]
  → [{text: "Hel", pos: 0}]
```

Adjacent deletions at the same position (text shrinks under cursor) can be merged similarly.

## Verified Results

Tested across 5 docs:

| Document | Entries | Tiles | Chunks w/ content | Replay length |
|----------|---------|-------|--------------------|---------------|
| LinkedIn Post | 2,352 | 97 | 90/97 (93%) | 12,199 chars |
| Company Brain | 12,875 | 108 | 106/108 (98%) | 53,927 chars |
| application_1 | 594 | 28 | 25/28 (89%) | 1,915 chars |
| Elijah LinkedIn Post | 2,101 | 62 | 61/62 (98%) | 2,561 chars |
| Pivot | 22,890 | 167 | 150/167 (90%) | 95,797 chars |

Chunks without content are format-only or element-only changes (expected).

## Replay vs API Comparison

The replayed document length may differ from the Google Docs API content length because:
1. The replay processes operations sequentially — the final state depends on having ALL entries
2. If pagination stops early (e.g., only first 2000 of 12000 entries), the replay is incomplete
3. `chunkedSnapshot` at position 0 is NOT replayed by default (it's initial state, not edit history)
4. `rplc`/`rvrt` operations clear and rebuild the document — if one appears partway through, earlier operations are irrelevant

For accurate replay, always fetch ALL changelog entries (use tiles to get total count, paginate in 1000-entry pages).
