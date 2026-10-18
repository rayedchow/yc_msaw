# Synthesis Layer: Open Questions & Design Decisions

From the architecture discussion on 2026-05-20.

## Open Question 1: Formatting changes need text context

**Problem**: Currently, format operations have `startIndex`/`endIndex` but not the actual text at those positions. The pre-synthesis output says:

```
"made bold characters 45-58"
```

But the LLM needs to see:

```
"made bold the words 'Y Combinator'"
```

To resolve this, the Session Aggregator needs to cross-reference format operation ranges with the document state at that point in the replay. The `replayWithDiffs` function already maintains a character array — we can read from it to annotate format changes with their affected text.

**Proposed solution**: During replay, when we encounter a format operation, read `docState.slice(si-1, ei)` to get the text being formatted. Attach this as `affectedText` to the format change description.

**Status**: Research agents deployed to investigate best approaches.

## Open Question 2: Incremental summary editing vs full rewrite

**Problem**: The initial design had the LLM rewriting the entire document summary after each session. But most sessions only change a small part of the document. A session that edits Tab 4 shouldn't require rewriting the summary of Tab 2.

**User's insight**: "It only really has to look at the part that was changed, with maybe some broader context."

**Options being researched**:

A) **Tool-based editing** — LLM gets tools like `update_tab_summary(tab_id, new_summary)` and `append_entity(name, type)`. It decides which tools to call based on what changed. Surgical edits, no unnecessary rewrites.

B) **Scoped prompt** — Only show the LLM the tabs/sections that were affected. If only Tab 4 changed, the LLM only sees and updates Tab 4's summary.

C) **Diff/patch output** — LLM outputs JSON Patch operations instead of a full object: `[{op: "replace", path: "/tabs/3/summary", value: "..."}]`

D) **Natural language edit instructions** — LLM outputs edit instructions like "Add TBPN to the entities list. Update Tab 4 summary to mention the location iterations." A second pass applies these.

**Key concern**: Over many incremental edits, summaries can drift — becoming inconsistent or losing important details. Need a periodic full recomputation as a backstop.

**Status**: Research agents deployed investigating MemGPT's `core_memory_replace`, Claude's memory tool, CrewAI's ConsolidationFlow, and JSON Patch approaches.

## Architecture Model (from discussion)

The user described this mental model:

```
PERSISTENT STATE (per document):
├── Document summary — what this doc IS right now
├── Tab summaries — what each tab contains  
├── Entity list — people, companies, topics mentioned
└── Contributors — who's involved, their roles

SESSION HISTORY (append-only):
├── [Session 1] "Ishan created initial draft..."
├── [Session 2] "Ishan iterated location details..."
└── [Session N] "Elijah accepted suggestion..."

FLOW:
1. New editing session detected
2. Pre-synthesis modules process the raw ops (BUILT)
3. Session Aggregator produces structured input (TO BUILD)
4. LLM EDITS the document summary (not rewrite) based on what changed
5. LLM produces a session event narrative (append-only)
6. Both get stored
```

The document summary gets patched/edited — NOT rewritten from scratch. The session history accumulates and never changes. When the agent asks "what's in this doc?" it reads the current summary. When it asks "how did it evolve?" it reads the session history.

## Decision: Full Tab Content Always

The LLM always gets the full tab content from the OT replay buffer — no tools to "expand context," no partial views. A typical tab is 2K-10K chars (500-2500 tokens), costing ~$0.001 at Haiku. Even a 50-page tab at 50K chars is only ~$0.01. Not worth optimizing.

This means:
- No stale-summary problem (LLM has the actual text)
- No tool calls for context expansion
- No complexity deciding what to show
- The warm/cold paths are still useful for the OVERVIEW summary (derived from tab summaries), but individual tab summaries are always based on real content

The LLM sees for each affected tab:
```
Previous tab summary: "Draft workspace, empty"
Full tab content (2698 chars): "I got into Y Combinator..."
What changed this session: [diffs, format changes with affected text, suggestions]
→ Write new tab summary
```

## Decision: Overview Summary Propagation

The main document summary is derived from tab summaries — never from raw operations.

Hot path: only update affected tab summaries (with full tab content)
Warm path: regenerate overview from all tab summaries when a tab flags `overviewNeedsUpdate: true`

The overview ALWAYS updates after tab summaries update. One enrichment cycle = two LLM calls:

```
Call 1: Update affected tab summary (with full tab content + diffs)
Call 2: Update overview from all tab summaries (always, not conditional)
```

No significance flag needed. The overview is always derived from current tab summaries, so it's always fresh. The cost of Call 2 is negligible (~200 tokens input, all tab summaries are already short).

The cold path (weekly full recompute from Docs API `documents.get`) is a drift backstop only — validates tab summaries haven't diverged from actual document content. Not the primary update mechanism.

## What the LLM should see

The LLM should receive:
1. The **specific tabs/sections that changed** (not the whole document summary)
2. **Humanized style changes with affected text** ("made 'Y Combinator' bold" not "bold at chars 45-58")
3. **Suggestion lifecycle events** with actual text
4. **Detected behaviors** (paste, undo, find & replace, collaboration)
5. **Content samples** — actual inserted/deleted text (capped for token budget)

It should NOT see:
- Raw OT operations
- Style field abbreviations (ts_bd, ps_hd)
- Position indices without text context
- Unchanged tabs/sections
