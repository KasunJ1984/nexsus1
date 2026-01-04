# Blendthink Guide

## Overview
Blendthink is the background intelligence layer that orchestrates how Claude answers questions. It routes queries through different sections, selects appropriate thinking styles (personas), and blends results into coherent responses.

## Question Types and Routing

| Question Type | Example | Primary Section | Secondary | Parallel |
|--------------|---------|-----------------|-----------|----------|
| `precise_query` | "Show me partner 286798" | exact/ | - | No |
| `discovery` | "Find hospital projects" | semantic/ | knowledge/ (parallel), exact/ | Yes |
| `aggregation` | "Total revenue by stage" | exact/ | knowledge/ (parallel) | Yes |
| `aggregation_with_discovery` | "Total for Hansen Yuncken leads" | semantic/ | knowledge/ (parallel), exact/ | Yes |
| `relationship` | "What's connected to this partner?" | common/ (graph) | semantic/ | No |
| `explanation` | "Why did revenue drop?" | knowledge/ | exact/, semantic/ (parallel) | Yes |
| `comparison` | "Compare Q1 vs Q2 revenue" | exact/ | knowledge/, semantic/ (parallel) | Yes |
| `unknown` | Ambiguous queries | semantic/ | exact/ | No |

## Personas

Blendthink selects a persona to shape how Claude presents information.

### Forensic Analyst
- **When used**: precise_query, aggregation, aggregation_with_discovery
- **Style**: Evidence-first, "the data shows..."
- **Behavior**: Cites exact sources, precise numbers, conservative conclusions
- **Example prefix**: "The data shows 15 matching records..."

### Systems Thinker
- **When used**: discovery, relationship
- **Style**: Connection-finder, pattern recognizer
- **Behavior**: Highlights relationships, spots patterns, synthesizes insights
- **Example prefix**: "I notice a pattern connecting these records..."

### Socratic Guide
- **When used**: explanation, comparison, unknown
- **Style**: Question-asker, leads through discovery
- **Behavior**: Asks guiding questions, suggests next steps, explains reasoning
- **Example prefix**: "Consider this: have you looked at..."

### Neutral
- **When used**: Fallback when no clear match
- **Style**: Balanced, straightforward
- **Behavior**: Direct answers without strong stylistic emphasis

## Routing Flow

```
User Query
    |
    v
+-------------------+
| Question Analyzer |  Classify query type
+-------------------+
    |
    v
+-------------------+
| Adaptive Router   |  Create route plan with dependency levels
+-------------------+
    |
    v
+-------------------+
| Persona Selector  |  Choose thinking style
+-------------------+
    |
    v
+-------------------+
| Execute Sections  |  Run tools (parallel where possible)
+-------------------+
    |
    v
+-------------------+
| Claude Synthesis  |  Blend results with persona
+-------------------+
    |
    v
Final Response
```

## Parallel Execution

Blendthink optimizes latency by running independent section adapters in parallel.

**Dependency Levels:**
- **Level 0**: No dependencies - runs immediately (e.g., semantic + knowledge in parallel)
- **Level 1**: Depends on level 0 results (e.g., after graph traversal)
- **Level 2**: Depends on chain context (e.g., exact needs semantic IDs)

**Parallelizable Routes:**
| Query Type | Parallel Steps | Sequential Steps |
|------------|---------------|------------------|
| `discovery` | semantic + knowledge | exact (needs IDs) |
| `aggregation` | exact + knowledge | - |
| `aggregation_with_discovery` | semantic + knowledge | exact (needs IDs) |
| `explanation` | exact + semantic | after knowledge |
| `comparison` | exact + knowledge + semantic | - |

**Latency Savings:**
- Parallel execution saves ~0.5-1.5s per query
- Most significant for multi-section queries
- Example: semantic (0.8s) + knowledge (0.5s) parallel = 0.8s (vs 1.3s sequential)

## Section Roles

| Section | Purpose | Example Tools |
|---------|---------|---------------|
| **exact/** | Precise data, aggregations | nexsus_search |
| **semantic/** | Discovery, fuzzy search | semantic_search, find_similar |
| **common/** | Graph navigation, schema | graph_traverse, inspect_record |
| **knowledge/** | Domain rules, expertise | knowledge_lookup (this section) |

## Token Budget Management

- Default budget: 50,000 tokens per session
- Each section step estimates tokens used
- Route stops early if approaching 80% of budget
- Token-heavy queries (explanation) get larger estimates

## Quality Gates

Blendthink enforces these quality standards:

1. **Confidence Threshold**: 80% minimum or acknowledge uncertainty
2. **Source Attribution**: Every claim must cite a section/tool
3. **Turn Limits**: Max 5 refinement turns per conversation
4. **Clarification**: Low confidence queries trigger clarification questions

## When Knowledge Section Is Used

Knowledge section is included in routing when:
- **`explanation`** - PRIMARY role (knowledge is first, not secondary)
- **`discovery`** - Secondary role (Odoo patterns, common pitfalls)
- **`aggregation`** - Secondary role (KPI formulas, benchmarks)
- **`aggregation_with_discovery`** - Secondary role (both patterns and KPIs)
- **`comparison`** - Secondary role (industry benchmarks, what differences mean)
- User asks "how" or "why" questions requiring domain expertise
- Interpretation of data is needed (not just retrieval)

Knowledge section is skipped when:
- Pure data retrieval (`precise_query`) - just looking up a specific record
- Relationship navigation (`relationship`) - structure is in the graph itself
- Unknown queries - need discovery first to understand intent

## Interpreting Route Plans

A route plan shows:
```
steps: [
  { section: "semantic", tool: "semantic_search" },
  { section: "exact", tool: "nexsus_search" }
]
skipped: [
  { section: "knowledge", reason: "Focus on data" }
]
estimatedTokens: 5000
```

This means:
1. semantic_search runs first (discovery)
2. nexsus_search uses discovered IDs
3. knowledge was skipped (not needed)
4. Budget is ~5000 tokens

## Advanced Features (Stages 8-13)

### Stage 8: Simple Mode Bypass

For trivial queries (low complexity), blendthink can skip the full Claude API synthesis and return results directly.

**Triggers:**
- Query complexity < 30%
- Single section needed
- No interpretation required

**Benefits:**
- Faster response (~200ms vs ~2s)
- Lower token usage
- No Claude API cost for simple lookups

**Example:** "Show me partner 286798" → Direct to exact/, no synthesis needed

---

### Stage 9: Memory Layer (R2 Persistence)

Blendthink remembers query patterns and successful responses for faster future processing.

**Components:**
| Component | Purpose | Storage |
|-----------|---------|---------|
| Query Pattern Memory | Remember successful routes | R2 |
| Synthesis Cache | Cache Claude's synthesis | R2 |
| Session Persistence | Save session state | R2 |

**Pattern Matching:**
- Similar queries (>85% similarity) reuse cached routes
- Reduces latency for repeated query patterns
- Learns from successful interactions

---

### Stage 10: System 1/System 2 Decision Layer

Based on Daniel Kahneman's "Thinking, Fast and Slow" - dual-process decision making.

| Path | When Used | Characteristics |
|------|-----------|-----------------|
| **System 1 (Fast)** | Familiar patterns, single adapter, >85% memory match | ~200ms, cached synthesis |
| **System 2 (Deep)** | Novel queries, complex analysis, multi-section | Full analysis, continuous integration |

**System 1 Criteria (ALL must be true):**
1. Very similar to past successful query (>85% similarity)
2. Past pattern was successful (>80% outcome quality)
3. Query is simple (<30% complexity)

---

### Stage 11: Continuous Integration Engine

Unlike "gather all → synthesize once", understanding builds incrementally as results arrive.

**Features:**
- **Running Hypothesis**: Builds understanding page-by-page
- **Gap Detection**: Claude can request more data if needed
- **Dynamic Route Modification**: Adjust routing based on findings
- **Parallel Execution**: Independent sections run simultaneously

**Example Flow:**
```
semantic_search → "Found 3 hospital projects"
   ↓ (hypothesis updates)
exact_search → "Total revenue: $2.5M"
   ↓ (hypothesis updates)
Claude: "Need partner details" → request additional data
   ↓
nexsus_search → "Partner: Hansen Yuncken"
   ↓
Final synthesis with complete understanding
```

---

### Stage 12: Self-Reflection Layer

Claude questions its own conclusions before finalizing - the "gut check" humans naturally do.

**Reflection Checks:**
| Check | Question | Action if Failed |
|-------|----------|------------------|
| Logical | Does this make sense given the data? | Request verification |
| Confidence | How sure am I of each claim? | Add hedging language |
| Completeness | Did I fully address the question? | Identify gaps |

**Claim Confidence Levels:**
- **HIGH**: Data directly supports claim
- **MEDIUM**: Inferred from partial data
- **LOW**: Uncertain, needs verification

**Output:**
- Adjusted response with confidence language
- Verification requests if needed
- Identified gaps for follow-up

---

### Stage 13: Learning Layer

Stores successful patterns for future System 1 use. Learns from user feedback.

**Learning Triggers:**
| Feedback Type | Meaning | Action |
|---------------|---------|--------|
| `explicit_positive` | User says "correct" | Strengthen pattern |
| `explicit_negative` | User says "that's wrong" | Weaken pattern |
| `implicit_success` | User moves on (no correction) | Slight strengthen |
| `implicit_failure` | User asks follow-up clarification | Slight weaken |
| `correction` | User provides correct answer | Learn new pattern |

**What Gets Learned:**
- Query → Question type mapping
- Successful route patterns
- User preferences (verbosity, detail level)
- Token usage patterns

**Persistence:**
- Learning events stored in R2
- Survives server restarts
- Aggregated for pattern analysis

---

## Related Guidelines
- nexsus-search.md - Exact section tool
- semantic-search.md - Semantic section tool
- data-verification.md - Quality verification
