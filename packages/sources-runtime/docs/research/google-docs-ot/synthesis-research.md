# Synthesis Layer Research

Compiled from 5 research agents covering LLM approaches, writing analytics, agent architectures, Graphiti/knowledge graphs, and production systems.

## Key Finding

**No existing tool uses LLMs to synthesize OT data into narratives.** Every tool is either visual replay (Draftback, DocuViz) or statistical dashboards (WriteTrace, Revision History Extension). The narrative synthesis we want ("Ishan spent 45 minutes writing a LinkedIn post about getting into YC") does not exist anywhere in production. Microsoft Copilot comes closest but only summarizes content changes, not process patterns.

## Recommended Architecture: 3-Stage Pipeline

```
Stage 1: Pre-Aggregation (code, no LLM) — ALREADY BUILT
    ├── BehaviorSummary (paste, undo, sessions, collaboration)
    ├── HumanizedStyleChanges (bold, heading, font)
    ├── SuggestionLifecycle (create/modify/accept/reject)
    └── EditChunkDiff[] (what text changed per tile)

Stage 2: LLM Session Synthesis (Haiku, ~$0.001/session)
    ├── Input: structured pre-aggregated stats + text diffs
    ├── Output: narrative + entities + facts + behavioral observations
    └── One call per editing session per document

Stage 3: Knowledge Graph Ingestion (Graphiti-style episodes)
    ├── Each session synthesis → one episode
    ├── Graphiti extracts entities, resolves duplicates, tracks temporal edges
    └── Feeds Person, Document, Topic, Decision entities + relationships
```

## Stage 2 Detail: LLM Session Synthesis

### Why session is the right unit

Academic writing analytics (Conijn et al., Eindhoven/Antwerp) consistently identifies sessions (gap-delimited editing periods) as the natural cognitive unit. Within a session, a person has a goal. Between sessions, goals may change. Our behavior detector already identifies sessions using a 5-minute gap, which matches the literature's 2-5 minute threshold.

### Pre-aggregate, then LLM — no debate

Every production system does this:
- DailyLLM (UCSD 2025): 1.5B model beats 70B because structured features are better input than raw data
- Google ADK: simple events get template summaries (zero LLM cost), complex events get batched LLM calls
- Observability tools: pre-aggregate metrics, LLM writes narrative from stats
- Our codebase already computes the stats (BehaviorSummary, sessions, collaboration analysis)

### Output Schema

```typescript
interface SessionSynthesis {
  documentId: string;
  sessionIndex: number;
  userId: string;
  startTime: Date;
  endTime: Date;
  activeMinutes: number;

  // Human-readable narrative
  narrative: string;

  // Structured data for knowledge graph
  intent: "drafting" | "editing" | "reviewing" | "formatting" | "structuring";
  topics: string[];
  entities: Array<{
    name: string;
    type: "person" | "organization" | "place" | "document" | "concept";
    relationship: "mentioned" | "discussed" | "linked_to" | "decided";
  }>;
  keyChanges: Array<{
    description: string;
    type: "content_addition" | "content_deletion" | "content_revision" |
          "structural_change" | "formatting" | "copy_paste";
  }>;
  behavioralObservations: Array<{
    observation: string;
    confidence: number;
  }>;
  facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    validAt: Date;
  }>;
}
```

### Prompt Strategy: Chain-of-Density

Chain-of-Density (Adams et al., Columbia/Salesforce 2023) iteratively produces increasingly dense summaries. The LLM generates an initial entity-sparse summary, then incorporates missing salient entities without increasing length. Human evaluators prefer CoD summaries over vanilla prompts.

### Hierarchical Roll-Up

```
Operations → Sessions (LLM, per-session)
Sessions → Document-Day (LLM, merge session narratives)
Document-Days → User-Day (LLM, merge across documents)
User-Days → Weekly (LLM, trend detection)
```

Each level uses the output of the previous level as input — never re-processes raw operations.

## Cost Model

| Task | Model | Cost/call | Daily (50 docs, 5 sessions each) |
|------|-------|-----------|-----------------------------------|
| Session synthesis | Haiku 4.5 | ~$0.004 | $0.90 |
| Document-day merge | Haiku 4.5 | ~$0.006 | $0.28 |
| **Total** | | | **~$1.18/day (~$35/month)** |

With prompt caching (90% discount on system prompt): **~$0.50/day**.

## Writing Process Metrics (from Academic Literature)

Directly computable from our OT data:

| Metric | Source | What it reveals |
|--------|--------|----------------|
| P-bursts (pause bursts) | Inputlog research | Chunks of fluent production between planning pauses |
| R-bursts (revision bursts) | Inputlog research | Revision frequency → text quality correlation |
| Production rate | KLiCKe corpus | Characters/minute over time windows |
| Deletion ratio | Keystroke analytics | % of work that was deletion/revision vs new content |
| Revision distance | Writing process theory | Near-cursor vs distant edits → revision strategy |
| Stage detection | BEAST algorithm (Conijn) | Drafting vs revising vs polishing phase |
| Paste ratio | WriteTrace | Pasted chars / total chars |

## Edit Intention Classification

**IteraTeR** (Grammarly + UVA, ACL 2022) provides a pre-trained classifier:
- `wanyu/IteraTeR-ROBERTA-Intention-Classifier` on HuggingFace
- 6 categories: Fluency, Clarity, Coherence, Style, Meaning-changing, Other
- Input: before/after text pairs (reconstructable from our OT operations)
- Could replace or supplement LLM-based intent classification

## Knowledge Graph Integration (Graphiti)

| Google Docs Concept | Graphiti Concept |
|---------------------|------------------|
| Editing session | Episode (EpisodicNode) |
| Person who edited | EntityNode (type: Person) |
| Document | EntityNode (type: Document) |
| Topic mentioned | EntityNode (type: Concept) |
| "Ishan edited doc X" | EntityEdge (EDITED, with valid_at) |
| "Doc X mentions YC" | EntityEdge (MENTIONS) |
| "Location changed SoMa→Bay" | Temporal invalidation (old edge expired, new edge created) |

Graphiti's bi-temporal model:
- `valid_at`: when the edit happened (OT timestamp)
- `invalid_at`: when a fact stopped being true (content revision detected)
- `created_at`: when synthesis ran
- `expired_at`: when superseded by newer synthesis

## Production Systems Comparison

| Product | Content summary | Activity summary | Process analytics | Our approach |
|---------|----------------|-----------------|-------------------|-------------|
| Microsoft Copilot | Yes | Recent changes | No | All three |
| Google Gemini in Docs | Yes | No | No | All three |
| Draftback | No | Visual replay | Visual only | Narrative + structured |
| DocuViz | No | Visual heatmap | Collaboration | Narrative + structured |
| WriteTrace | No | Statistical | Paste detection | Narrative + structured |
| **Gigabrain** | **Yes** | **Yes** | **Yes** | **Unique combination** |

## Usable Libraries and Resources

| Resource | What | Relevance |
|----------|------|-----------|
| IteraTeR classifier (HuggingFace) | Edit intention classification | Categorize each edit's purpose |
| DocuViz2 (github.com/neuhai/docuviz2) | Revision visualization (JS, MIT) | Study their data parsing |
| Graphiti (github.com/getzep/graphiti) | Temporal knowledge graph | Episode ingestion, entity resolution |
| Mem0 (github.com/mem0ai/mem0) | Agent memory | Simpler alternative to Graphiti |
| KLiCKe Corpus | 5K essays with keystroke logs | Training/validation data |
| ECSEA (Blatt et al. 2023) | Event abstraction for collaboration logs | Raw ops → meaningful activities |
| BEAST algorithm (Conijn) | Writing phase detection | Bayesian change point detection |
