# Agent Memory Architecture Research

How AI agents process, store, and recall information from continuous activity streams.

## Three Dominant Paradigms

### 1. Tiered Memory (MemGPT/Letta) — 22K+ stars
- OS-inspired: context window = RAM, external storage = disk
- Three tiers: Core Memory (always in-context) → Recall Memory (searchable history) → Archival Memory (long-term vector store)
- The agent itself decides when to page data in/out via function calls
- 1M+ stateful agents deployed in production

### 2. Temporal Knowledge Graph (Graphiti/Zep) — 26K stars
- Dynamic knowledge graph with temporal metadata (valid_from, valid_to)
- Hybrid retrieval: semantic + BM25 + graph traversal, fused via Reciprocal Rank Fusion
- Bi-temporal model: when facts were recorded AND when they occurred
- 94.8% on Deep Memory Retrieval benchmark
- Uses Neo4j/FalkorDB as backend

### 3. Vector-First with LLM Extraction (Mem0) — 56K stars
- ADD-only architecture: single LLM call extracts facts, no UPDATE/DELETE
- Both old and new facts survive; retrieval handles recency
- Parallel scoring: semantic + BM25 + entity matching → score fusion
- 91.6% on LoCoMo, 94.8% on LongMemEval
- 91% lower p95 latency, 90% less token cost vs full-context

## Key Design Decisions

### ADD-only vs Update-in-place

| Approach | Used by | Tradeoff |
|----------|---------|----------|
| ADD-only | Mem0 v3 | Simpler, no destructive updates, retrieval handles recency. But storage grows. |
| Temporal invalidation | Graphiti | Old edges get `invalid_at`, new edges created. Richer but more complex. |
| LLM-decided merge | CrewAI | ConsolidationFlow detects near-duplicates, LLM decides merge/update/delete. |

**Recommendation for Gigabrain:** Graphiti's temporal invalidation. Document editing history is inherently temporal — "the location was SoMa, then Dogpatch, then the Bay." ADD-only loses the supersession chain.

### Batch vs Per-Event Processing

Production consensus: **batch by time window (5-30 min) or by session**, not per-event.
- Mem0: per `add()` call (conversation turn)
- Graphiti: per-episode ingestion
- Apple Saga: hybrid batch-incremental

### Retrieval: Hybrid is non-negotiable

Every top system uses multiple signals fused together:
1. Semantic search (vector embeddings)
2. BM25 full-text keyword search
3. Graph traversal (relationship paths)
4. Temporal filtering (point-in-time queries)
5. Result fusion via RRF (Reciprocal Rank Fusion)

### Cost Optimization (ranked by impact)

1. **Model routing** (40-60% savings): 60-80% of extraction → Haiku ($0.80/1M)
2. **Prompt caching** (30-50%): 90% discount on cached system prompts
3. **Batch API** (50%): Anthropic/OpenAI batch at half price for async work
4. **Token reduction** (20-40%): compress prompts, structured JSON output
5. **Semantic caching**: eliminate redundant calls for similar queries

## Multi-Source Entity Resolution

For Gmail + Slack + Stripe + Docs + GitHub + Linear + Calendar:

1. **Shared identifiers**: Email as primary key across sources
2. **Temporal correlation**: Events within time window likely relate to same topic
3. **Entity extraction per source**: Pull person/company/project names
4. **Cross-source linking**: Fuzzy match + shared identifiers
5. **Topic clustering**: Group events by extracted entities across sources

Rox's 4-step pipeline (directly applicable):
1. Build lookup table using shared IDs
2. Merge into knowledge graph with universal ID
3. Resolve relationships with source priority
4. Materialize unified entities

## Production Systems

| System | Approach | Key insight |
|--------|----------|-------------|
| Rewind/Limitless | Capture everything (screen + audio), query later | Local-first, OCR + transcription |
| Granola | Meeting audio + raw notes → AI-enhanced notes | Per-meeting, not continuous |
| Glean | 100+ connectors, Content + People + Activity graph | Self-tuning search ranking |
| Microsoft Copilot | Microsoft Graph (email + docs + teams + calendar) | Cross-source via single unified graph |
| Dust.tt | Agent platform with multi-source semantic search | Agent-per-task architecture |
| Google NotebookLM | Source-grounded RAG, 500K context | Document-centric, not activity-centric |
| Apple Saga | Hybrid batch-incremental KG at industrial scale | 98.8% precision on 19M facts |

## What to Steal for Gigabrain

1. **Mem0 v3**: ADD-only extraction — one LLM call per event batch, no UPDATE/DELETE
2. **Graphiti**: Temporal knowledge graph with bi-temporal edges for entity relationships
3. **Rox**: 4-step multi-source entity resolution pipeline
4. **CrewAI**: Composite scoring for retrieval (`semantic * similarity + recency * decay + importance * weight`)
5. **Glean**: Three-pillar KG (Content + People + Activity) with self-tuning search

## Suggested Architecture for Gigabrain

```
Gmail/Slack/Stripe/Docs/GitHub/Linear/Calendar
         │
    [Source Adapters — normalize to common event schema]
         │
    [Entity Resolution — email primary key + fuzzy matching]
         │
    [Batch Extraction Queue (5-30 min windows)]
         │
    [LLM Extraction (Haiku) — ADD-only facts per session]
         │
    [Dedup + Entity Linking]
         │
    [Storage: Vector DB + Temporal Entity Graph + SQL audit log]
         │
    [Retrieval: Semantic + BM25 + Entity + Temporal → RRF fusion]
         │
    [Synthesis LLM (Sonnet) — generates answers from retrieved context]
```
