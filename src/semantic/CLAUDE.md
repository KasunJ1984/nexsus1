# Nexsus_semantic - AI-Powered Semantic Search

## Section Objective
AI-powered semantic and vector search. This section handles natural language queries, similarity matching, and discovery operations where the goal is to FIND relevant records based on meaning, not exact matches.

**Think of this as**: "What similar experiences or information do I have?" - like recalling memories based on associations and patterns.

**Human cognition parallel**: When asked about restaurants, you recall places with similar vibes, similar experiences, similar qualities - not exact database lookups.

---

## Anti-Patterns (NEVER do these)

1. **NEVER present semantic results as "exact" data**
   - Always include similarity scores
   - Always indicate results are based on vector similarity
   - Never claim "this IS the record" - say "this MATCHES your query"

2. **NEVER hide the AI/semantic nature of results**
   - Users must know results come from semantic matching
   - Include confidence indicators
   - Be transparent about ranking methodology

3. **NEVER mix semantic logic into exact query results**
   - If exact/ calls this section for help, that's fine
   - But exact/ results must remain pure data
   - This section provides SUGGESTIONS, not final answers for exact queries

4. **NEVER guarantee completeness**
   - Semantic search finds SIMILAR records, not ALL records
   - For complete data retrieval, use exact/ section

---

## File Ownership Manifest

Files in this section (under `src/semantic/`):

### MCP Tools
```
src/semantic/tools/search-tool.ts       - semantic_search, find_similar MCP tools
                                          Natural language search across schema/data
```

### Core Services
```
src/semantic/services/analytics-service.ts   - Field usage tracking, importance scoring
                                               Learns which fields are most used
src/semantic/services/graph-search-engine.ts - Graph boost computation
                                               Connection-aware ranking
```

---

## Interaction Contracts

### Who Can CALL This Section
- **exact/** - YES, for parameter suggestions
  - Example: exact/ may call semantic functions to help identify which fields to filter on
  - BUT exact/ must not include semantic results in final output

- **console/** - YES, for blending results
  - Console orchestrates all sections
  - May use semantic results as part of final answer

### What This Section Can Import
- **common/** - YES (vector-client, embedding-service, schema-lookup, types)
- **exact/** - READ-ONLY (may read, never write)
- **knowledge/** - READ-ONLY (may read for context)
- **console/** - NEVER (console imports us, not vice versa)

---

## Quality Gates

### Every Semantic Result Must Include:
1. **Similarity score** (0.0 - 1.0)
2. **Match type indicator** (semantic, fuzzy, vector)
3. **Source attribution** (which collection/model)

### Result Formatting:
```typescript
// GOOD - Shows semantic nature
{
  record: { ... },
  similarity: 0.85,
  match_type: "semantic",
  explanation: "Matched based on: project type, location, industry"
}

// BAD - Hides semantic nature
{
  record: { ... }
  // No similarity score = user thinks this is exact match
}
```

### Performance Requirements:
- Semantic searches should complete in <5 seconds
- Use caching for repeated queries
- Batch embeddings when possible

---

## Access Control

When working in this section:
```
WRITE: src/semantic/* and files listed above
READ-ONLY: src/exact/*, src/knowledge/*, src/console/*
IMPORT FROM: src/common/* (shared infrastructure)

If you find issues in other sections:
- NOTE them (TODO comment or tell user)
- DO NOT fix directly
```

---

## Key Concepts

### Vector Similarity
- Records are converted to 1024-dimensional vectors using Voyage AI
- Similar records have vectors close together in vector space
- Similarity = cosine distance between vectors

### Graph Boost
- Records with more FK connections rank higher
- Well-connected records are often more relevant
- Use `graph_boost=true` to enable

### Adaptive Key Fields
- Analytics tracks which fields are most queried
- Frequently used fields get promoted in search relevance
- System learns from usage patterns

---

## Example Use Cases

### Appropriate for Semantic Section:
- "Find hospital projects in Victoria" (natural language)
- "Projects similar to record #12345" (similarity)
- "What leads look like our best customers?" (pattern matching)

### NOT Appropriate (Use Exact Section Instead):
- "Show me the total revenue for March 2024" (aggregation)
- "List all invoices for partner ID 286798" (exact filter)
- "What is the balance of account 319?" (precise data)
