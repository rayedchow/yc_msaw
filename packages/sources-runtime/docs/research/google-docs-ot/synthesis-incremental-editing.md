# Incremental Summary Editing Research

How to update persistent document summaries without full rewrites.

## The Core Insight

Full rewrites are wasteful. If only Tab 4 was edited, only Tab 4's summary needs updating. The overview summary might not change at all. Entities only need appending.

## What Production Systems Do

### MemGPT/Letta: Surgical string replace (fragile)
- `core_memory_replace(section, old_content, new_content)` — exact substring match
- **Problem**: LLMs are bad at recalling exact strings. GPT-4 paraphrases when trying to specify `old_content`. Smaller models hallucinate non-existent functions.
- **Verdict**: Tool-based editing is the right idea, but exact-match replace is too fragile.

### Mem0 v3: Append-only (simplest, best benchmarks)
- Never mutate, only accumulate. Both old and new facts survive.
- Retrieval-time ranking handles disambiguation.
- Scored 91.6 on LoCoMo vs 71.4 for the old UPDATE/DELETE approach.
- **Verdict**: Best for fact storage. Not ideal for summaries (they'd grow forever).

### Claude's Memory Tool: File-based CRUD
- Full content replacement with optimistic concurrency (`content_sha256` precondition).
- Not a patch — replaces the entire file content.
- **Verdict**: Simple but wasteful for large summaries with small changes.

## Best Academic Approaches

### Chain-of-Key (CoK) — Google DeepMind, EMNLP 2024
**Most directly applicable.** Store summaries as structured JSON. When new info arrives:
1. LLM sees current JSON + new data
2. LLM answers: "What keys does this update? What new keys to add?"
3. LLM outputs only the delta — which keys to update/add

Results: 7-14% improvement over full regeneration. JSON outperforms Markdown by 40%.

### PRISM — Google DeepMind, EMNLP 2025
Extends CoK with typed hierarchical schema. LLM proposes revisions, applied programmatically.
4x shorter contexts than long-context models. 54% cost reduction via KV cache optimization.

### JSON Whisperer — Lightricks, EMNLP 2025
Tests RFC 6902 JSON Patch output from LLMs:
- 31% token reduction with their EASE encoding
- Quality within 5% of full regeneration
- **Failure mode**: LLMs can't handle array index arithmetic. Solution: use dictionaries with stable keys (tab IDs, not array indices).

### Airbnb Progressive Notes — EMNLP 2025
Production system: LLM generates only NEW bullets from recent activity. Previous bullets passed as context but NOT regenerated. 3% handling time reduction (9% for complex cases).

## Recommended Architecture: Three-Tier Updates

### Tier 1: Hot Path (every enrichment cycle)
Only run when new edits detected. Only touch affected tabs.

```
Input to LLM:
  - Current summary for AFFECTED TABS ONLY
  - New session's aggregated data (humanized, with text context)
  - Current entity list (for dedup)

Output from LLM:
  {
    "tabUpdates": {
      "t.4t74": { "summary": "Draft workspace where Ishan iterated location..." }
    },
    "newEntities": [
      { "name": "TBPN", "type": "concept", "context": "mentioned in coffee shop scene" }
    ],
    "overviewNeedsUpdate": false
  }
```

Cost: ~$0.0005 per cycle (only affected tabs, small context).

### Tier 2: Warm Path (daily or every N edits)
Regenerate overview summary from all tab summaries (they're already concise).
Check entity list for duplicates/staleness.

```
Input: all tab summaries (already short, ~50 words each)
Output: new 2-3 sentence overview summary
```

Cost: ~$0.001 per doc per day.

### Tier 3: Cold Path (weekly or on major structural changes)
Full recomputation from document content via Docs API `documents.get`.
Resets drift. Rebuilds entity list from scratch.

Cost: ~$0.01 per doc per week.

## Format Changes: Getting Affected Text

**Problem**: Format ops have position indices but not the text being formatted.
"Made bold characters 45-58" is useless. "Made 'Y Combinator' bold" is useful.

**Solution**: During OT replay, maintain a running text buffer. When a format operation arrives, extract the text at its range:

```typescript
// In the session aggregator, during replay
if (op.type === "format" && op.startIndex && op.endIndex) {
  const affectedText = docState.slice(op.startIndex - 1, op.endIndex).join("");
  // Now: "Made bold: 'Y Combinator'" instead of "Made bold: chars 45-58"
}
```

This uses the existing `replayWithDiffs` document state array — no additional API calls needed. The humanizer output becomes:

```
Before: "Text: bold (range 45-58)"
After:  "Text: made 'Y Combinator' bold"
```

## Summary Drift Prevention

1. **Schema enforcement**: JSON schema with Zod validation catches format corruption
2. **Tier 3 cold path**: Weekly full recomputation prevents accumulated drift
3. **Stable keys**: Use tab IDs (not array indices) as JSON keys — prevents the JSON Patch array arithmetic problem
4. **Entity dedup**: Run dedup on entity list during Tier 2 warm path
5. **Version tracking**: Store `lastRevisionId` per tab summary to know what's stale

## Tool Pattern Decision: Per-Tab Rewrite Wins

Research across MemGPT, Claude, CrewAI, and JSON Patch approaches:

| Approach | Reliability | Cost | Drift risk |
|----------|-------------|------|-----------|
| Full doc rewrite | HIGH | ~2000 output tokens | LOW |
| Per-tab rewrite | HIGH | ~300 output tokens | LOW |
| JSON Patch (RFC 6902) | MEDIUM | ~150 tokens | MEDIUM (5% quality loss) |
| Surgical string replace (MemGPT) | LOW | ~100 tokens | HIGH (LLMs can't match exact strings) |
| Natural language edit instructions | LOWEST | ~double (2 LLM calls) | HIGHEST |

**Winner: Per-tab rewrite with structured entity tools.**

Individual tab summaries are short (100-300 tokens). Rewriting one tab costs ~300 output tokens vs ~2000 for full document. The LLM doesn't need exact string matching.

Tool interface:
```typescript
interface SummaryUpdateTools {
  update_tab_summary(tab_id: string, new_summary: string): void;
  add_entities(entities: Array<{name: string, type: string}>): void;
  remove_entities(entity_names: string[]): void;
  set_document_summary(new_summary: string): void;  // only for structural changes
}
```

From MemGPT experience: `find_and_replace` on natural language is fragile. The entire community reports it as the #1 issue. Per-section rewrite is simpler and more reliable.

## Token Budget: Real Data

Last 10 chunks of Ishan LinkedIn Post (61-minute editing session):
- **~756 tokens total** for all chunk data
- Includes: inserted text, deleted text, format changes WITH affected text
- Format changes show: `"bold on 'Y Combinator'"` not `"bold at chars 45-58"`
- With system prompt + current summary: ~2K tokens total per LLM call
- Cost at Haiku: **<$0.002 per session**

## Key Papers

| Paper | Venue | Key Finding |
|-------|-------|-------------|
| Chain-of-Key (Hwang et al.) | EMNLP 2024 | JSON delta updates 7-14% better than full rewrites |
| PRISM (Jayalath et al.) | EMNLP 2025 | Typed hierarchical schema, 4x shorter context |
| JSON Whisperer (Duanis et al.) | EMNLP 2025 Industry | RFC 6902 patches work but need stable keys (EASE) |
| Airbnb Progressive Notes (Wu et al.) | EMNLP 2025 Industry | Incremental bullets, don't regenerate existing ones |
| Mem0 v3 | April 2026 | Append-only beats UPDATE/DELETE (91.6 vs 71.4) |
| RecMem | May 2026 | Only invoke LLM on sustained recurrence — 87% cost reduction |
