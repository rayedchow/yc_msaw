# Synthesis Pipeline Plan

Final architecture decisions from the design discussion on 2026-05-20.

## Process Map

```
Process 1: Activity Polling (every 15s)
    │  Checks Drive Activity API: "was anything edited?"
    │  Stores activity_events: "Ishan edited Linkedin Post at 1:41 PM"
    │  Flags doc as active in conversationWatermarks
    │  This is METADATA — just that something happened.
    │
    └── If doc flagged as active ──►
                                    │
Process 3: OT Fetch + Pre-Synthesis (on schedule, only flagged docs)
    │  Fetches /revisions/load since last watermark position
    │  Runs: humanizer, suggestion tracker, behavior detector
    │  Groups operations into sessions (5-min gap = new session)
    │  Accumulates "fetched but not yet synthesized" buffer across runs
    │  Only hands COMPLETED sessions to Process 4
    │  This is PROCESSING — turns raw ops into structured data.
    │
    └── For each completed session ──►
                                      │
Process 4: LLM Synthesis (runs immediately after Process 3)
    │  Input: full tab content + previous summary + session diffs
    │  LLM Call 1: Update affected tab summaries
    │  LLM Call 2: Update document overview from all tab summaries
    │  Output: tab summaries, overview, entities, session narrative
    │  This is UNDERSTANDING — agent knows what happened.
    │
    └── Store everything, update synthesis watermark
```

## Session Detection + Buffer

Process 3 maintains a buffer of "fetched but not yet synthesized" entries. This handles sessions that span across multiple Process 3 runs:

```
Run at 1:00 PM:
  Fetch entries 2351-2355 (user typing since 12:30)
  Last op at 12:58 PM — only 2 minutes ago
  Session NOT complete → add to buffer
  Buffer: [2351-2355]

Run at 2:00 PM:
  Fetch entries 2356-2358 (user stopped at 1:12 PM)
  Last op at 1:12 PM — 48 minutes ago
  Session IS complete → hand buffer + new entries to Process 4
  Synthesize: [2351-2358]
  Clear buffer
```

### Two watermarks:
1. **OT fetch watermark** — last entry fetched from /revisions/load (never re-fetch)
2. **Synthesis watermark** — last entry synthesized by Process 4 (entries between fetch and synthesis watermarks are the buffer)

### Session completion rule:
A session is "complete" when the last operation from a user is >5 minutes old. If the user is still typing (last op <5 min ago), the session stays in the buffer until the next Process 3 run.

## What Process 4 Sees (LLM Input)

For each completed session, the LLM receives:

### LLM Call 1: Tab Summary Update (per affected tab)
```
Previous tab summary: "Draft workspace, empty"

Full tab content (from OT replay buffer):
"I got into Y Combinator as a high school student from Indiana,
choosing $500k and a shot at my dreams over Stanford and Penn M&T..."

What changed this session:
- Added 2693 chars (paste): "I got into Y Combinator..."
- Changed "SoMa" → "Dogpatch" → "the Bay"
- Changed "a billboard advertising an API" → "TBPN playing on the guy's laptop"
- Format: applied Roboto 15pt to full content
- Format: made 'Y Combinator' bold
- Format: added link to linkedin.com/in/philip-meng/ on "Philip Meng"
- Behaviors: 1 paste (2693 chars), 3 undos
- Duration: 61 min (38 active)

→ Output: new tab summary + entities + session narrative
```

### LLM Call 2: Overview Update (always runs after Call 1)
```
All current tab summaries:
- Tab "Final": "Published LinkedIn post, 2698 chars. Full rewrite from Tab 4."
- Tab "Philip Example": "Reference example post"
- Tab "dump": "Scratch notes"
- Tab "Tab 4": "Draft workspace where Ishan iterated the YC post..."

Current overview: "LinkedIn post about getting into YC..."
Current entities: ["Y Combinator", "Stanford", "Penn M&T"]

→ Output: updated overview + updated entity list
```

## Key Design Decisions

### Full tab content always
The LLM always gets the full tab text from the OT replay buffer. No tools to "expand context," no partial views. A typical tab is 500-2500 tokens (~$0.001 at GPT-OSS pricing). Even 50-page tabs are only ~$0.01. Not worth optimizing.

### Format changes include affected text
From the OT replay buffer, we extract the actual text at format operation positions:
- "made 'Y Combinator' bold" not "bold at chars 45-58"
- "added link to linkedin.com on 'Philip Meng'" not "link at chars 100-112"

### Per-tab summary update, not full doc rewrite
Only affected tabs get new summaries. Unedited tabs are untouched. Overview is derived from tab summaries (cheap, ~200 tokens input).

### Overview always updates
After any tab summary change, the overview regenerates from all tab summaries. Not on a separate schedule — same pipeline, same run.

### Process 3 and 4 run together
Same job, same schedule. Process 4 is just the next step after Process 3. No separate scheduling needed.

### Cold path as drift backstop only
Weekly full recompute from Docs API `documents.get` validates tab summaries haven't drifted. Not the primary update mechanism.

## Model Choice

**GPT-OSS-120B via Fireworks AI**
- $0.039/1M input, $0.19/1M output
- 117B total params, 5.1B active (MoE)
- 131K context, structured output support
- Apache 2.0 open-weight

### Cost projection
250 calls/day (50 docs × ~5 sessions):
- Input: 250 × 5K tokens = 1.25M tokens/day → $0.05/day
- Output: 250 × 1.5K tokens = 375K tokens/day → $0.07/day
- **Total: ~$0.12/day, ~$3.60/month**

## What Gets Stored

### document_summaries table (UPDATE per doc)
```
doc_id: "1_lFbE..."
title: "Ishan Linkedin Post"
overview: "LinkedIn post about getting into YC..."
tabs: {
  "t.taev": { name: "Final", summary: "Published post, 2698 chars..." },
  "t.4t74": { name: "Tab 4", summary: "Draft workspace..." },
  ...
}
entities: ["Y Combinator", "Stanford", "TBPN", ...]
contributors: ["Ishan Ramrakhiani"]
last_updated: "2026-05-19T14:41:55Z"
last_synthesis_entry: 2358
```

### session_events table (APPEND only)
```
doc_id: "1_lFbE..."
session_index: 47
user_id: "12978..."
start_time: "2026-05-19T13:41:15Z"
end_time: "2026-05-19T14:41:55Z"
narrative: "Ishan spent 61 minutes rewriting his LinkedIn post.
  Created Tab 4 as draft workspace, pasted 2693-char draft,
  iterated location (SoMa → Dogpatch → the Bay), changed
  coffee shop detail, copied final to Tab 2."
intent: "drafting"
significance: "high"
key_changes: [...]
entities_mentioned: ["Y Combinator", "Stanford", "TBPN"]
facts: [
  { subject: "Ishan", predicate: "WROTE_ABOUT", object: "YC acceptance" },
  { subject: "Ishan", predicate: "USES_PATTERN", object: "draft on scratch tab" }
]
behaviors: { pasteCount: 1, undoCount: 3, typingSpeedCpm: 420 }
```

## Implementation Order

1. **Session Aggregator** — combines pre-synthesis outputs into structured LLM input, manages the buffer of unfetched sessions, provides full tab content from replay
2. **LLM Synthesizer** — calls GPT-OSS-120B via Fireworks, produces tab summaries + overview + narrative
3. **Storage** — document_summaries + session_events tables (Drizzle schema)
4. **Integration** — wire into the existing enrichment job after Process 3
5. **Testing** — unit tests for aggregator, integration tests with real docs
