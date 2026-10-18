# Google Docs OT Synthesis Layer Design

Design proposal for combining parsed OT operations, humanized styles, suggestion lifecycles, and detected behaviors into structured summaries suitable for AI agent consumption and knowledge graph ingestion.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Session Aggregator Design](#2-session-aggregator-design)
3. [LLM Prompt Design](#3-llm-prompt-design)
4. [Output Schema](#4-output-schema)
5. [Incremental vs Full Summarization](#5-incremental-vs-full-summarization)
6. [Multi-Document Daily Digest](#6-multi-document-daily-digest)
7. [Knowledge Graph Feeding](#7-knowledge-graph-feeding)
8. [Implementation Plan](#8-implementation-plan)

---

## 1. Architecture Overview

### Data Flow

```
Phase 1: Activity API               Phase 2: OT Changelog
(gdocs-edits.ts, gdocs-comments.ts)  (gdocs-revisions-load.ts)
         │                                     │
         │  activity_events table              │
         ▼                                     ▼
    ┌─────────────────────────────────────────────────┐
    │              Session Aggregator                  │
    │  (NEW: gdocs-session-aggregator.ts)             │
    │                                                  │
    │  Inputs:                                         │
    │  ├── ChangelogOperation[] (filtered by time)     │
    │  ├── HumanizedStyleChange[] (style-humanizer)    │
    │  ├── SuggestionSummary (suggestion-tracker)      │
    │  ├── BehaviorSummary (behavior-detector)         │
    │  └── activity_events (Phase 1 events)            │
    │                                                  │
    │  Outputs:                                        │
    │  └── AggregatedDocSession[]                      │
    └──────────────────┬──────────────────────────────┘
                       │
                       ▼
    ┌─────────────────────────────────────────────────┐
    │              LLM Summarizer                      │
    │  (NEW: gdocs-llm-summarizer.ts)                 │
    │                                                  │
    │  Per-session → DocSessionSummary                 │
    │  Per-document → DocDaySummary                    │
    │  Per-user → DailyDigest                          │
    └──────────────────┬──────────────────────────────┘
                       │
                       ▼
    ┌─────────────────────────────────────────────────┐
    │           Knowledge Graph Feeder                 │
    │  (NEW: gdocs-graph-feeder.ts)                   │
    │                                                  │
    │  Episodes → entities table                       │
    │  Episodes → wiki_pages / wiki_refs               │
    │  (Future: Graphiti add_episode)                   │
    └─────────────────────────────────────────────────┘
```

### Design Principles

1. **Separate aggregation from summarization.** The aggregator produces deterministic, structured data from raw operations. The LLM only sees pre-aggregated data, never raw OT. This keeps prompts small, costs low, and outputs reproducible.

2. **Two-stage LLM pattern.** Following the Execute-Summarize framework from recent research: first let the aggregator do all the deterministic work (counting, grouping, humanizing), then ask the LLM only for narrative synthesis and intent inference.

3. **Incremental by default.** Process only new activity since the last synthesis run. Store watermarks per document. Only re-summarize the full history on explicit request or when context is needed.

4. **Token-budget aware.** Cap aggregated session data to fit within a single LLM context window (~8K tokens for the prompt + input, reserving 2K for output). If a session is too large, chunk it.

---

## 2. Session Aggregator Design

### Session Boundary Definition

A "session" is a contiguous period of editing activity by one or more users on a single document, bounded by gaps of 5+ minutes of inactivity (matching `SESSION_BREAK_MS` in the behavior detector). This aligns with how the behavior detector already segments sessions.

For collaborative documents with multiple simultaneous editors, we create a single session that tracks all users, since their edits are interleaved and context-dependent.

### AggregatedDocSession Type

```typescript
// gdocs-session-aggregator.ts

import type { ChangelogOperation, DocChangelog } from "./gdocs-revisions-load.js";
import type { HumanizedStyleChange } from "./gdocs-style-humanizer.js";
import type { SuggestionLifecycle } from "./gdocs-suggestion-tracker.js";
import type { DetectedBehavior, SessionAnalysis, CollaborationAnalysis } from "./gdocs-behavior-detector.js";

export interface AuthorSessionStats {
  userId: string;
  email: string;
  name: string;
  /** Characters inserted (excluding pastes, which are tracked separately). */
  charsTyped: number;
  /** Characters inserted via paste. */
  charsPasted: number;
  /** Characters deleted. */
  charsDeleted: number;
  /** Number of format operations. */
  formatOps: number;
  /** Number of suggestions created. */
  suggestionsCreated: number;
  /** Number of suggestions accepted (by this user). */
  suggestionsAccepted: number;
  /** Number of suggestions rejected (by this user). */
  suggestionsRejected: number;
  /** Estimated active editing time in ms. */
  activeTimeMs: number;
  /** Average typing speed (chars per minute) during bursts. */
  avgTypingSpeedCpm: number;
  /** Number of undo operations. */
  undoCount: number;
}

export interface SessionSuggestionEvent {
  sugId: string;
  action: "created" | "modified" | "accepted" | "rejected";
  authorUserId: string;
  resolvedByUserId?: string;
  text?: string;
  timestamp: Date;
}

export interface SessionFormatSummary {
  /** Deduplicated human-readable descriptions, grouped by category. */
  text: string[];
  paragraph: string[];
  document: string[];
  table: string[];
  list: string[];
  link: string[];
  other: string[];
}

export interface AggregatedDocSession {
  /** Document file ID. */
  fileId: string;
  /** Document name at the time of the session. */
  fileName: string;
  /** Session start timestamp. */
  startTime: Date;
  /** Session end timestamp. */
  endTime: Date;
  /** Total duration in ms. */
  durationMs: number;

  // --- Per-author stats ---
  authors: AuthorSessionStats[];

  // --- Aggregate content metrics ---
  totalInsertions: number;
  totalDeletions: number;
  netCharChange: number;
  totalOperations: number;

  // --- Content samples (for LLM context) ---
  /** Up to 5 longest inserted text fragments, truncated to 200 chars each. */
  insertionSamples: Array<{ text: string; author: string; timestamp: Date }>;
  /** Up to 5 longest deleted text fragments, truncated to 200 chars each. */
  deletionSamples: Array<{ text: string; author: string; timestamp: Date }>;

  // --- Formatting summary ---
  formatChanges: SessionFormatSummary;

  // --- Suggestion lifecycle events ---
  suggestionEvents: SessionSuggestionEvent[];

  // --- Detected behaviors ---
  behaviors: Array<{
    type: DetectedBehavior["type"];
    userId: string;
    timestamp: Date;
    detail: string;  // Human-readable one-liner
  }>;

  // --- Collaboration ---
  collaboration: {
    isCollaborative: boolean;
    userCount: number;
    interleaveRatio: number;
    overlapMs: number;
  };

  // --- Tab activity ---
  tabsUsed: string[];
  tabsCreated: string[];
  tabsRenamed: Array<{ tabId: string; newName: string }>;

  // --- Phase 1 events in this window ---
  activityApiEvents: Array<{
    eventType: string;
    actorEmail: string;
    timestamp: Date;
    detail?: string;
  }>;
}
```

### Aggregation Algorithm

```typescript
const SESSION_GAP_MS = 5 * 60 * 1000; // 5 minutes

export function aggregateSessions(
  changelog: DocChangelog,
  since: Date,
  until: Date,
  activityEvents: ActivityEvent[],
  emailResolver: (userId: string) => string,
): AggregatedDocSession[] {
  // 1. Filter operations to [since, until]
  const ops = changelog.operations.filter(op => {
    const t = op.timestamp.getTime();
    return t >= since.getTime() && t <= until.getTime();
  });

  if (ops.length === 0) return [];

  // 2. Sort by timestamp
  const sorted = [...ops].sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  // 3. Split into sessions at 5-minute gaps
  const sessionBoundaries: number[] = [0];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime();
    if (gap >= SESSION_GAP_MS) {
      sessionBoundaries.push(i);
    }
  }

  // 4. For each session, run sub-aggregators
  const sessions: AggregatedDocSession[] = [];
  for (let b = 0; b < sessionBoundaries.length; b++) {
    const start = sessionBoundaries[b];
    const end = b + 1 < sessionBoundaries.length
      ? sessionBoundaries[b + 1]
      : sorted.length;
    const sessionOps = sorted.slice(start, end);

    // Run style humanizer on format ops
    // Run suggestion tracker on suggestion ops
    // Run behavior detector on session ops
    // Collect content samples
    // Merge with Phase 1 activity events by timestamp overlap

    sessions.push(buildSessionAggregate(
      changelog, sessionOps, activityEvents, emailResolver
    ));
  }

  return sessions;
}
```

### Token Budget Management

Each `AggregatedDocSession` is serialized to JSON before passing to the LLM. We enforce a budget:

- **Target**: 4,000 tokens per session (roughly 16KB of JSON)
- **Overflow strategy**: If a session exceeds the budget, progressively truncate:
  1. Reduce `insertionSamples` and `deletionSamples` to 3 items, then 1
  2. Truncate text samples to 100 chars, then 50
  3. Collapse `formatChanges` to just category counts
  4. Collapse `behaviors` to just type counts
  5. Drop `activityApiEvents` detail strings

```typescript
const MAX_SESSION_TOKENS = 4000;

function truncateSessionForLLM(session: AggregatedDocSession): string {
  let json = JSON.stringify(session);
  let estimatedTokens = Math.ceil(json.length / 4);

  if (estimatedTokens <= MAX_SESSION_TOKENS) return json;

  // Progressive truncation steps...
  const truncated = { ...session };
  truncated.insertionSamples = truncated.insertionSamples.slice(0, 3);
  truncated.deletionSamples = truncated.deletionSamples.slice(0, 3);
  // ... continue until within budget
  return JSON.stringify(truncated);
}
```

---

## 3. LLM Prompt Design

### Prompt Architecture

We use a **system + user** two-message pattern with structured output (JSON mode). The system prompt is static and defines the task, output schema, and quality expectations. The user prompt contains only the serialized session data.

### System Prompt

```
You are a document activity analyst. You receive structured data about
editing sessions on Google Docs and produce concise, factual summaries
for an AI agent's memory system.

Your summaries must:
1. Focus on WHAT changed and WHO did it, not low-level operations
2. Infer the likely PURPOSE of edits when the content makes it clear
3. Note collaboration patterns (who reviewed whose work, suggestion flows)
4. Highlight significant structural changes (new sections, reorganization)
5. Flag notable behaviors (large pastes, bulk formatting, undo patterns)
6. Be written in past tense, third person
7. Never fabricate content that is not supported by the data

Output a JSON object matching the DocSessionSummary schema exactly.
Do not include any text outside the JSON object.
```

### User Prompt Template

```
Summarize this editing session on "${fileName}":

SESSION DATA:
${truncatedSessionJson}

Produce a DocSessionSummary JSON object with these fields:
- narrative: 2-4 sentence natural language summary of what happened
- intent: one of ["drafting", "editing", "reviewing", "formatting", "restructuring", "collaborating", "commenting", "unknown"]
- significance: one of ["major", "moderate", "minor", "trivial"]
- keyChanges: array of 1-5 specific changes (each a short sentence)
- topics: array of 0-3 topic keywords extracted from inserted text
- entities: array of {name, type, role} for people/docs/projects mentioned
- openQuestions: array of 0-2 unresolved items (pending suggestions, unresolved comments)
```

### Concrete Example

**Input (truncated session JSON):**

```json
{
  "fileId": "1abc...",
  "fileName": "Q3 Product Roadmap",
  "startTime": "2026-05-20T10:15:00Z",
  "endTime": "2026-05-20T10:47:00Z",
  "durationMs": 1920000,
  "authors": [
    {
      "userId": "u123",
      "email": "alice@company.com",
      "name": "Alice Chen",
      "charsTyped": 1842,
      "charsPasted": 450,
      "charsDeleted": 312,
      "formatOps": 8,
      "suggestionsCreated": 0,
      "suggestionsAccepted": 2,
      "suggestionsRejected": 0,
      "activeTimeMs": 1200000,
      "avgTypingSpeedCpm": 92,
      "undoCount": 1
    },
    {
      "userId": "u456",
      "email": "bob@company.com",
      "name": "Bob Park",
      "charsTyped": 0,
      "charsPasted": 0,
      "charsDeleted": 0,
      "formatOps": 0,
      "suggestionsCreated": 3,
      "suggestionsAccepted": 0,
      "suggestionsRejected": 0,
      "activeTimeMs": 180000,
      "avgTypingSpeedCpm": 0,
      "undoCount": 0
    }
  ],
  "totalInsertions": 2292,
  "totalDeletions": 312,
  "netCharChange": 1980,
  "totalOperations": 187,
  "insertionSamples": [
    {
      "text": "## Mobile SDK Launch (July)\n\nTarget: iOS and Android SDK v2.0 with offline sync support. Dependencies: API v3 migration (owned by Platform team).",
      "author": "Alice Chen",
      "timestamp": "2026-05-20T10:22:00Z"
    },
    {
      "text": "Revenue impact: estimated $2.4M ARR from enterprise mobile deployments based on Q2 pipeline.",
      "author": "Alice Chen",
      "timestamp": "2026-05-20T10:35:00Z"
    }
  ],
  "deletionSamples": [
    {
      "text": "TBD - needs discussion with eng leads",
      "author": "Alice Chen",
      "timestamp": "2026-05-20T10:23:00Z"
    }
  ],
  "formatChanges": {
    "text": ["bold", "font size 14pt"],
    "paragraph": ["Heading 2", "Heading 3"],
    "document": [],
    "table": [],
    "list": ["list nesting level 1"],
    "link": ["link to https://jira.company.com/PLAT-2847"],
    "other": []
  },
  "suggestionEvents": [
    {"sugId": "s1", "action": "accepted", "authorUserId": "u456", "resolvedByUserId": "u123", "text": "Q3 target date should be July 15", "timestamp": "2026-05-20T10:30:00Z"},
    {"sugId": "s2", "action": "accepted", "authorUserId": "u456", "resolvedByUserId": "u123", "text": "Add offline sync as explicit requirement", "timestamp": "2026-05-20T10:32:00Z"},
    {"sugId": "s3", "action": "created", "authorUserId": "u456", "text": "Consider adding React Native support to scope", "timestamp": "2026-05-20T10:40:00Z"}
  ],
  "behaviors": [
    {"type": "paste", "userId": "u123", "timestamp": "2026-05-20T10:35:00Z", "detail": "Pasted 450 chars with newlines (likely from spreadsheet or other doc)"},
    {"type": "structuring", "userId": "u123", "timestamp": "2026-05-20T10:20:00Z", "detail": "4 heading changes in 3 minutes (H2, H3, H2, H3) — document structuring burst"}
  ],
  "collaboration": {
    "isCollaborative": true,
    "userCount": 2,
    "interleaveRatio": 0.34,
    "overlapMs": 600000
  },
  "tabsUsed": ["t.0"],
  "tabsCreated": [],
  "tabsRenamed": [],
  "activityApiEvents": [
    {"eventType": "doc_edited", "actorEmail": "alice@company.com", "timestamp": "2026-05-20T10:47:00Z"},
    {"eventType": "doc_suggestion_accepted", "actorEmail": "alice@company.com", "timestamp": "2026-05-20T10:30:00Z"}
  ]
}
```

**Expected LLM Output:**

```json
{
  "narrative": "Alice Chen spent 32 minutes drafting the Mobile SDK Launch section of the Q3 Product Roadmap, structuring it with headings and adding revenue projections ($2.4M ARR estimate). Bob Park reviewed concurrently, creating 3 suggestions — Alice accepted 2 (setting July 15 target date, adding offline sync requirement) and left 1 pending (React Native scope expansion).",
  "intent": "drafting",
  "significance": "major",
  "keyChanges": [
    "Added 'Mobile SDK Launch (July)' section with iOS/Android SDK v2.0 scope",
    "Added revenue impact estimate of $2.4M ARR from enterprise mobile deployments",
    "Accepted Bob's suggestion to set July 15 as target date",
    "Accepted Bob's suggestion to add offline sync as explicit requirement",
    "Linked to JIRA ticket PLAT-2847 for API v3 migration dependency"
  ],
  "topics": ["mobile SDK", "product roadmap", "revenue projections"],
  "entities": [
    {"name": "Alice Chen", "type": "person", "role": "author"},
    {"name": "Bob Park", "type": "person", "role": "reviewer"},
    {"name": "Q3 Product Roadmap", "type": "document", "role": "subject"},
    {"name": "Platform team", "type": "team", "role": "dependency"},
    {"name": "PLAT-2847", "type": "ticket", "role": "reference"}
  ],
  "openQuestions": [
    "Bob suggested expanding scope to include React Native support — pending Alice's decision"
  ]
}
```

### Model Selection and Parameters

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Model | `claude-sonnet-4-20250514` | Good balance of quality, speed, and cost for summarization |
| Temperature | 0.2 | Low creativity needed, high factual accuracy |
| Max tokens | 2048 | Sufficient for the output schema |
| Response format | JSON mode / tool_use | Enforce schema compliance |

### Cost Estimate

At ~6K input tokens and ~500 output tokens per session:
- ~$0.02 per session summary (Sonnet pricing)
- ~20 sessions/day for an active user across all docs
- ~$0.40/user/day, ~$12/user/month

---

## 4. Output Schema

### DocSessionSummary (per-session, LLM-produced)

```typescript
export interface DocSessionSummary {
  /** 2-4 sentence narrative of what happened. */
  narrative: string;
  /** Inferred primary intent of the editing session. */
  intent:
    | "drafting"
    | "editing"
    | "reviewing"
    | "formatting"
    | "restructuring"
    | "collaborating"
    | "commenting"
    | "unknown";
  /** How significant this session was for the document. */
  significance: "major" | "moderate" | "minor" | "trivial";
  /** 1-5 specific changes described in short sentences. */
  keyChanges: string[];
  /** 0-3 topic keywords extracted from the content. */
  topics: string[];
  /** People, documents, teams, tickets mentioned or involved. */
  entities: Array<{
    name: string;
    type: "person" | "document" | "team" | "project" | "ticket" | "url" | "other";
    role: "author" | "reviewer" | "mentioned" | "dependency" | "reference" | "subject";
  }>;
  /** 0-2 unresolved items (pending suggestions, open questions). */
  openQuestions: string[];
}
```

### DocDaySummary (per-document-per-day, code-assembled + LLM-refined)

```typescript
export interface DocDaySummary {
  fileId: string;
  fileName: string;
  date: string; // ISO date YYYY-MM-DD

  /** Rolled-up narrative across all sessions for this doc today. */
  narrative: string;
  /** Dominant intent across sessions. */
  primaryIntent: DocSessionSummary["intent"];
  /** Overall significance. */
  significance: DocSessionSummary["significance"];

  /** All key changes across sessions, deduplicated. */
  keyChanges: string[];
  /** All topics across sessions, deduplicated. */
  topics: string[];
  /** All entities across sessions, deduplicated by name. */
  entities: DocSessionSummary["entities"];
  /** All open questions across sessions. */
  openQuestions: string[];

  /** Per-author aggregate stats for the day. */
  authorStats: Array<{
    email: string;
    name: string;
    sessionCount: number;
    totalActiveTimeMs: number;
    charsTyped: number;
    charsDeleted: number;
    suggestionsCreated: number;
    suggestionsAccepted: number;
    suggestionsRejected: number;
  }>;

  /** Number of editing sessions. */
  sessionCount: number;
  /** Total editing time across all sessions. */
  totalEditingTimeMs: number;
  /** Net character change for the day. */
  netCharChange: number;

  /** Individual session summaries (for drill-down). */
  sessions: DocSessionSummary[];
}
```

### DailyDigest (per-user-per-day, LLM-produced)

```typescript
export interface DailyDigest {
  userId: string;
  date: string; // ISO date YYYY-MM-DD

  /** 3-6 sentence narrative of the user's document activity today. */
  narrative: string;
  /** Ranked list of documents by significance. */
  documentActivity: Array<{
    fileId: string;
    fileName: string;
    significance: DocSessionSummary["significance"];
    oneLiner: string; // Single sentence summary
  }>;
  /** All topics across all docs today. */
  topics: string[];
  /** All entities across all docs today. */
  entities: DocSessionSummary["entities"];
  /** Cross-document observations (patterns, themes). */
  crossDocInsights: string[];
  /** Items needing attention. */
  actionItems: string[];
  /** Total time spent editing across all docs. */
  totalEditingTimeMs: number;
  /** Count of unique documents edited. */
  documentsEdited: number;
}
```

### JSON Schema for LLM Validation

We define the schemas as Zod types and derive JSON Schema for LLM tool_use:

```typescript
import { z } from "zod";

export const DocSessionSummarySchema = z.object({
  narrative: z.string().max(1000),
  intent: z.enum([
    "drafting", "editing", "reviewing", "formatting",
    "restructuring", "collaborating", "commenting", "unknown"
  ]),
  significance: z.enum(["major", "moderate", "minor", "trivial"]),
  keyChanges: z.array(z.string().max(200)).min(1).max(5),
  topics: z.array(z.string().max(50)).max(3),
  entities: z.array(z.object({
    name: z.string().max(100),
    type: z.enum(["person", "document", "team", "project", "ticket", "url", "other"]),
    role: z.enum(["author", "reviewer", "mentioned", "dependency", "reference", "subject"]),
  })).max(10),
  openQuestions: z.array(z.string().max(300)).max(2),
});
```

---

## 5. Incremental vs Full Summarization

### Recommendation: Incremental with Periodic Full Recomputation

**Primary mode: Incremental (per-run)**

- Each synthesis run processes only operations since `lastSynthesizedAt` watermark
- New sessions are aggregated, summarized, and appended to the document's summary history
- The `DocDaySummary` for the current day is recomputed by merging new session summaries with existing ones
- Watermark stored in `conversationWatermarks.metadata` as `{ lastSynthesizedAt, lastSynthesizedRevisionId }`

**Secondary mode: Full recomputation (periodic)**

- Triggered weekly or on explicit request
- Re-processes the full changelog to produce a complete document history
- Corrects any drift from incremental processing (e.g., suggestion accepted in a later session that was created in an earlier one)
- Used when a document is first onboarded

### Watermark Strategy

```typescript
interface SynthesisWatermark {
  /** Last changelog index that was synthesized. */
  lastChangelogIndex: number;
  /** Timestamp of the last synthesized operation. */
  lastSynthesizedAt: string; // ISO
  /** Number of sessions synthesized so far today. */
  todaySessionCount: number;
  /** Date of the last synthesis run. */
  lastRunDate: string; // YYYY-MM-DD
}
```

### Incremental Processing Flow

```
1. Read watermark from conversationWatermarks.metadata
2. Fetch changelog (full, cached in memory for the run)
3. Filter to ops after lastChangelogIndex
4. If no new ops → skip
5. Run aggregateSessions() on new ops
6. For each new session:
   a. Serialize to JSON, apply token budget
   b. Call LLM for DocSessionSummary
   c. Store session summary in activity_events (new event type: "doc_synthesis")
7. Rebuild DocDaySummary by merging all today's session summaries
8. Update watermark
```

### Why Not Full-Only?

| Factor | Incremental | Full |
|--------|-------------|------|
| Cost | ~$0.02/session | ~$0.50-5.00/doc (depends on history size) |
| Latency | <5s per session | 30s-5min for large docs |
| Freshness | Near-real-time | Stale until next full run |
| Accuracy | May miss cross-session patterns | Perfect retroactive context |

The incremental approach is 10-100x cheaper and fast enough to run hourly. Full recomputation serves as a correctness backstop.

### Cross-Session Pattern Handling

Some patterns span multiple sessions (e.g., a suggestion created in session 1 and accepted in session 3). The incremental approach handles this by:

1. **Suggestion tracker runs on the full changelog** (not just new ops), so it always knows the current status
2. **Session summaries reference sugIds**, so the daily roll-up can correlate creation and resolution across sessions
3. **The DocDaySummary LLM prompt** receives all of today's session summaries, allowing it to synthesize cross-session narratives

---

## 6. Multi-Document Daily Digest

### Architecture

The daily digest is a second LLM call that takes per-document summaries as input and produces a cross-document synthesis.

```
DocDaySummary (doc A)  ─┐
DocDaySummary (doc B)  ─┤──→ LLM ──→ DailyDigest
DocDaySummary (doc C)  ─┘
```

### Digest Prompt

```
You are an executive assistant summarizing a person's Google Docs activity
for the day. You receive summaries of their editing sessions across
multiple documents.

Produce a DailyDigest JSON object that:
1. Starts with a 3-6 sentence narrative of the day's document work
2. Ranks documents by significance (most important first)
3. Identifies cross-document themes (e.g., "focused on Q3 planning across
   3 docs", "reviewed 2 team members' proposals")
4. Extracts action items from open questions across all docs
5. Uses the person's name or "you" (second person) for the narrative

USER DATA:
Name: ${userName}
Date: ${date}
Documents edited: ${docCount}

DOCUMENT SUMMARIES:
${docDaySummariesJson}
```

### Scheduling

The daily digest runs at end-of-day (configurable, default 6 PM local time) or on-demand:

```typescript
// In the EOD enrichment job (eod-enrich.ts)
async function runDailyDigest(userId: string, date: string): Promise<DailyDigest> {
  // 1. Collect all DocDaySummary for this user + date
  const docSummaries = await getDocDaySummaries(userId, date);
  if (docSummaries.length === 0) return emptyDigest(userId, date);

  // 2. Serialize and send to LLM
  const digest = await llmSummarize("daily_digest", {
    userName: await getUserName(userId),
    date,
    docCount: docSummaries.length,
    docSummaries,
  });

  // 3. Store as activity_event with type "daily_digest"
  await storeDigestEvent(userId, date, digest);

  return digest;
}
```

### Digest Storage

Daily digests are stored as `activity_events` with:
- `source`: `"gdocs"`
- `eventType`: `"daily_digest"`
- `sourceEventId`: `"gdocs:digest:${userId}:${date}"`
- `rawPayload`: The full `DailyDigest` JSON

This allows the existing event processing pipeline to handle entity resolution and wiki page linking for digest events.

---

## 7. Knowledge Graph Feeding

### Entity Mapping

The synthesis layer produces entities that map to the existing `entities` table schema:

| Summary Entity Type | entities.type | Identifier Type | Example |
|---------------------|---------------|-----------------|---------|
| person | person | email | alice@company.com |
| document | document | google_drive_file_id | 1abc... |
| team | team | name | Platform team |
| project | project | name | Mobile SDK v2.0 |
| ticket | ticket | external_id | PLAT-2847 |

### Relationship Extraction

From each `DocSessionSummary`, we extract relationships for the knowledge graph:

```typescript
interface ExtractedRelationship {
  sourceEntity: { name: string; type: string };
  targetEntity: { name: string; type: string };
  relationship: string;
  timestamp: Date;
  confidence: number;
  sourceDocId: string;
}

// Example relationships from the roadmap session:
[
  {
    sourceEntity: { name: "Alice Chen", type: "person" },
    targetEntity: { name: "Q3 Product Roadmap", type: "document" },
    relationship: "authored_section",
    timestamp: "2026-05-20T10:15:00Z",
    confidence: 1.0,
    sourceDocId: "1abc..."
  },
  {
    sourceEntity: { name: "Bob Park", type: "person" },
    targetEntity: { name: "Q3 Product Roadmap", type: "document" },
    relationship: "reviewed",
    timestamp: "2026-05-20T10:30:00Z",
    confidence: 0.9,
    sourceDocId: "1abc..."
  },
  {
    sourceEntity: { name: "Mobile SDK v2.0", type: "project" },
    targetEntity: { name: "Platform team", type: "team" },
    relationship: "depends_on",
    timestamp: "2026-05-20T10:22:00Z",
    confidence: 0.8,
    sourceDocId: "1abc..."
  },
  {
    sourceEntity: { name: "Mobile SDK v2.0", type: "project" },
    targetEntity: { name: "PLAT-2847", type: "ticket" },
    relationship: "tracked_by",
    timestamp: "2026-05-20T10:35:00Z",
    confidence: 0.9,
    sourceDocId: "1abc..."
  }
]
```

### Feeding into the Existing System

The graph feeder integrates with the existing `process-event.ts` entity resolution pipeline:

```typescript
// gdocs-graph-feeder.ts

import { resolvePersonByEmail } from "../pipeline/entities.js";
import { createPageShell, linkEventToPage } from "../wiki/pages.js";

export async function feedSummaryToGraph(
  userId: string,
  summary: DocSessionSummary,
  sessionEventId: string,
  fileId: string,
  fileName: string,
): Promise<void> {
  // 1. Resolve person entities via existing pipeline
  for (const entity of summary.entities) {
    if (entity.type === "person") {
      // Use existing resolvePersonByEmail from process-event.ts
      const entityId = await resolvePersonByEmail(
        userId, entity.name, entity.name, "gdocs"
      );
      if (entityId) {
        const pageId = await createPageShell(
          userId,
          `entities/people/${entityId}`,
          { entityId, name: entity.name, type: "person", source: "gdocs" }
        );
        await linkEventToPage(pageId, sessionEventId);
      }
    }
  }

  // 2. Resolve/create document entity
  const docEntityId = await resolveDocumentEntity(userId, fileId, fileName);
  if (docEntityId) {
    const pageId = await createPageShell(
      userId,
      `documents/${slugify(fileName)}`,
      {
        entityId: docEntityId,
        name: fileName,
        type: "document",
        fileId,
        source: "gdocs",
        topics: summary.topics,
        lastIntent: summary.intent,
        lastSignificance: summary.significance,
      }
    );
    await linkEventToPage(pageId, sessionEventId);
  }

  // 3. Create/update topic entities
  for (const topic of summary.topics) {
    await resolveTopicEntity(userId, topic, fileId, sessionEventId);
  }
}
```

### Future: Graphiti Integration

When Graphiti is integrated, each synthesis event becomes an episode:

```typescript
// Future: gdocs-graphiti-feeder.ts
// Uses Graphiti's add_episode with custom entity and edge types

import { Graphiti } from "@graphiti-ai/sdk";

// Custom entity types for Google Docs domain
class DocumentEntity extends EntityModel {
  fileId: string;
  fileType: "doc" | "sheet" | "slides";
  topics: string[];
}

class EditingSessionEntity extends EntityModel {
  intent: string;
  significance: string;
  durationMs: number;
}

// Custom edge types
class AuthoredEdge extends EdgeModel {
  charsWritten: number;
  intent: string;
}

class ReviewedEdge extends EdgeModel {
  suggestionsCreated: number;
  suggestionsAccepted: number;
}

// Episode ingestion
async function feedToGraphiti(
  graphiti: Graphiti,
  summary: DocSessionSummary,
  session: AggregatedDocSession,
): Promise<void> {
  // Convert summary narrative + structured data into episode text
  const episodeText = [
    summary.narrative,
    ...summary.keyChanges.map(c => `- ${c}`),
    ...summary.openQuestions.map(q => `Open question: ${q}`),
  ].join("\n");

  await graphiti.add_episode(
    name: `doc_session_${session.fileId}_${session.startTime.toISOString()}`,
    episode_body: episodeText,
    source: "google_docs",
    source_description: `Editing session on "${session.fileName}"`,
    reference_time: session.startTime,
    entity_types: [DocumentEntity, EditingSessionEntity],
    edge_types: [AuthoredEdge, ReviewedEdge],
  );
}
```

The Graphiti integration benefits from temporal awareness: each episode carries `reference_time`, enabling the graph to track how documents evolve, who collaborates with whom over time, and how topics emerge and shift across the workspace.

---

## 8. Implementation Plan

### Phase 1: Session Aggregator (1-2 days)

**New file: `brain/src/polling/gdocs-session-aggregator.ts`**

1. Define `AggregatedDocSession` and related types
2. Implement `aggregateSessions()` — splits ops into sessions, runs sub-aggregators
3. Implement token budget truncation
4. Unit tests with fixture data from existing test docs

**Dependencies:** All existing modules (revisions-load, style-humanizer, suggestion-tracker, behavior-detector) are already built and tested.

### Phase 2: LLM Summarizer (1-2 days)

**New file: `brain/src/polling/gdocs-llm-summarizer.ts`**

1. Define output schemas (Zod + JSON Schema)
2. Implement `summarizeSession()` — serializes session, calls LLM, validates output
3. Implement `summarizeDocDay()` — merges sessions, calls LLM for daily doc summary
4. Implement `summarizeDailyDigest()` — cross-doc synthesis
5. Add retry logic and fallback (if LLM fails, store raw aggregated data)

### Phase 3: Graph Feeder (1 day)

**New file: `brain/src/polling/gdocs-graph-feeder.ts`**

1. Entity extraction from summaries → existing entity resolution pipeline
2. Document entity creation/update
3. Wiki page creation for documents with topics and intent metadata
4. Store synthesis events in `activity_events`

### Phase 4: EOD Integration (0.5 days)

**Modify: `brain/src/jobs/eod-enrich.ts`**

1. After enriching Phase 1 events with OT data, run session aggregation
2. Run LLM summarization on new sessions
3. Feed results to graph
4. Run daily digest at end of day
5. Update watermarks

### Phase 5: Testing (1 day)

1. Integration tests with real doc changelogs (from existing test fixtures)
2. LLM output validation tests (mock LLM responses)
3. Watermark/incremental correctness tests
4. Token budget tests

### Total Estimate: 5-7 days

---

## Appendix A: Token Budget Analysis

Based on analysis of 12 workspace docs (129K changelog entries):

| Metric | P50 | P90 | P99 |
|--------|-----|-----|-----|
| Ops per session | 45 | 280 | 1,200 |
| Sessions per doc per day | 3 | 8 | 15 |
| Docs per user per day | 2 | 5 | 12 |
| Session JSON size (bytes) | 2,400 | 8,500 | 24,000 |
| Session JSON tokens (est.) | 600 | 2,125 | 6,000 |

The 4,000 token budget per session covers P90 without truncation. P99 sessions require progressive truncation but retain all structural information.

## Appendix B: Alternative Approaches Considered

### Map-Reduce Summarization

We considered a map-reduce pattern where each operation batch is independently summarized, then summaries are merged. Rejected because:
- Operations are interdependent (an insert at position X is meaningless without knowing what was already there)
- The aggregator already reduces the data to session-level, so there is nothing to parallelize
- Sequential refinement is more appropriate for temporal editing data

### Real-Time Streaming Summarization

We considered updating summaries on every operation (streaming approach). Rejected because:
- Google Docs OT data arrives in batches (hourly polling), not real-time
- Per-operation LLM calls would be prohibitively expensive
- Session boundaries are only knowable after a gap occurs

### Full-Document State Reconstruction

We considered replaying the full document state to extract "what the document says now" for each session. Rejected for Phase 1 because:
- The `replayWithDiffs()` function exists but produces character-level state, not semantic content
- Reconstructing readable document text requires understanding paragraph boundaries, headings, tables, etc.
- The aggregated session data (insertion samples, deletion samples) provides sufficient content context for LLM summarization
- Future enhancement: use document state replay for richer LLM context when needed

## Appendix C: References

- [DailyLLM: Context-Aware Log Generation](https://www.emergentmind.com/topics/dailyllm) -- modular three-stage pipeline for activity narrative generation
- [Structured Output from LLMs](https://www.instill-ai.com/blog/llm-structured-outputs) -- schema-based validation patterns
- [LLM Summarization Strategies](https://galileo.ai/blog/llm-summarization-strategies) -- chunking and aggregation approaches
- [FlowMind: Execute-Summarize Framework](https://arxiv.org/pdf/2602.11782) -- two-stage reasoning pattern
- [Graphiti: Temporal Knowledge Graphs](https://www.presidio.com/technical-blog/graphiti-giving-ai-a-real-memory-a-story-of-temporal-knowledge-graphs/) -- episodic memory architecture
- [Graphiti Temporal KG for Agent Memory](https://codex.danielvaughan.com/2026/03/30/graphiti-agent-memory-store/) -- knowledge flywheel integration
- [Zep: Temporal Knowledge Graph Architecture](https://arxiv.org/html/2501.13956v1) -- four-timestamp temporal tracking
- [Custom Entity and Edge Types (Graphiti)](https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types) -- Pydantic model-based entity/edge definition
- [Adding Episodes (Graphiti)](https://help.getzep.com/graphiti/core-concepts/adding-episodes) -- episode ingestion API
- [Enhancing Incremental Summarization](https://arxiv.org/html/2407.15021v1) -- structured representations for rolling summaries
- [Memory for Autonomous LLM Agents](https://arxiv.org/html/2603.07670v1) -- memory mechanisms survey (2026)
- [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026) -- benchmarks and production gaps
