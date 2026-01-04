# Console Improvements - Blendthink as Primary Query Router

## Overview

Transform Nexsus so that **blendthink is the primary entry point for all user queries**, using ALL sections:
- `semantic/` - AI-powered discovery
- `exact/` - Precise queries and aggregation
- `knowledge/` - Domain expertise (KPIs, Odoo patterns, reports)
- `common/` - Graph traversal and shared infrastructure

**Key Discovery**: All 4 section adapters ALREADY EXIST and are functional. The gap is:
1. Blendthink isn't exposed as the **default** entry point
2. Knowledge section isn't being routed to (only "explanation" queries)
3. System prompt needs the Forensic Analyst persona

---

# ALTERNATIVE ARCHITECTURES - Mimicking Human Cognition

## How Humans Actually Make Decisions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    HUMAN COGNITIVE PROCESS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. PERCEPTION        "What am I being asked?"                              │
│         ↓                                                                    │
│  2. INTUITION         "Does this feel familiar?" (System 1 - FAST)          │
│         ↓                                                                    │
│  3. PARALLEL          Multiple streams process SIMULTANEOUSLY:              │
│     PROCESSING        • Pattern matching (past experiences)                 │
│         ↓             • Fact retrieval (specific knowledge)                 │
│         ↓             • Rule application (domain expertise)                 │
│         ↓             • Value filtering (principles/constraints)            │
│         ↓                                                                    │
│  4. CONTINUOUS        Not discrete steps - understanding EMERGES            │
│     INTEGRATION       as information streams arrive                         │
│         ↓                                                                    │
│  5. GUT CHECK         "Does this conclusion feel right?"                    │
│         ↓             If not → seek more information                        │
│         ↓                                                                    │
│  6. CONFIDENCE        "How sure am I?" → Adjust language accordingly        │
│     ASSESSMENT                                                               │
│         ↓                                                                    │
│  7. ARTICULATION      Express understanding in appropriate form             │
│                                                                              │
│  NOTE: Humans LEARN - next similar query is faster (memory)                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Current Blendthink vs Human Cognition

| Human Process | Current Blendthink | Gap |
|---------------|-------------------|-----|
| Parallel processing | Sequential adapters | Processes one-at-a-time |
| Continuous integration | Discrete steps → synthesis | All-at-once at end |
| Intuition (System 1) | Always full analysis | No fast path for familiar |
| Gut check | None | No self-reflection |
| Learning/memory | Fresh start each query | No improvement over time |
| Seeking more info | Fixed route plan | Can't dynamically request more |

---

## Alternative Architecture Options

### Option A: Dual-Process Theory (System 1 + System 2)

Based on Daniel Kahneman's "Thinking, Fast and Slow":

```
Query Arrives
     ↓
┌─────────────────────────────────────────────────────────────┐
│              SYSTEM 1: INTUITIVE (Fast Path)                │
│                                                             │
│  • Pattern match against known query types                  │
│  • Check memory: "Have I seen this before?"                 │
│  • If HIGH confidence (>85%):                               │
│      → Single adapter call                                  │
│      → Minimal synthesis                                    │
│      → Response in ~2-3 seconds                             │
│                                                             │
│  • If LOW confidence or NOVEL query:                        │
│      → Trigger System 2                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
     ↓ (only if uncertain)
┌─────────────────────────────────────────────────────────────┐
│              SYSTEM 2: ANALYTICAL (Deep Path)               │
│                                                             │
│  • Full blendthink pipeline                                 │
│  • Multiple sections                                        │
│  • Deep analysis                                            │
│  • Self-reflection before answer                            │
│  • Response in ~8-12 seconds                                │
│                                                             │
│  AFTER: Store pattern for future System 1 use              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Human Parallel**: You don't calculate 2+2 every time - you KNOW it's 4.

---

### Option B: Continuous Integration (Streaming Understanding)

Instead of: Steps → Gather All → Synthesize Once
Use: Stream results → Update understanding continuously

```
┌─────────────────────────────────────────────────────────────┐
│           CONTINUOUS INTEGRATION ARCHITECTURE                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Initial Hypothesis: "User wants hospital project revenue"  │
│         ↓                                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Claude maintains RUNNING UNDERSTANDING              │    │
│  │                                                      │    │
│  │ semantic_search arrives → UPDATE understanding      │    │
│  │ "Found 12 hospital projects, IDs: [...]"           │    │
│  │                                                      │    │
│  │ nexsus_search arrives → UPDATE understanding        │    │
│  │ "Total revenue: $2.4M, largest: Hansen Yuncken"    │    │
│  │                                                      │    │
│  │ knowledge_search arrives → UPDATE understanding     │    │
│  │ "Revenue benchmark for construction: $500k/project" │    │
│  │                                                      │    │
│  │ EACH UPDATE refines the emerging answer             │    │
│  │ Claude can REQUEST MORE DATA if gaps detected       │    │
│  └─────────────────────────────────────────────────────┘    │
│         ↓                                                    │
│  Final answer emerges naturally, not assembled at end       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Human Parallel**: As you read a report, understanding builds page-by-page, not all-at-once at the end.

---

### Option C: Multi-Agent Debate (Internal Dialogue)

Multiple specialized "voices" that argue/collaborate:

```
┌─────────────────────────────────────────────────────────────┐
│              MULTI-AGENT DEBATE ARCHITECTURE                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Query: "Should we pursue the Hansen Yuncken project?"      │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │   FACT AGENT     │  │  PATTERN AGENT   │                │
│  │ "Data shows      │  │ "Similar to 2023 │                │
│  │  revenue $890k,  │  │  projects that   │                │
│  │  costs $650k"    │  │  succeeded"      │                │
│  └────────┬─────────┘  └────────┬─────────┘                │
│           │                     │                           │
│           ↓                     ↓                           │
│  ┌────────────────────────────────────────────────┐        │
│  │              MODERATOR AGENT                    │        │
│  │  Synthesizes viewpoints, identifies conflicts   │        │
│  └────────────────────────────────────────────────┘        │
│           ↑                     ↑                           │
│           │                     │                           │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  EXPERT AGENT    │  │  SKEPTIC AGENT   │                │
│  │ "Margin is 27%,  │  │ "But payment     │                │
│  │  above industry  │  │  history shows   │                │
│  │  benchmark"      │  │  90-day delays"  │                │
│  └──────────────────┘  └──────────────────┘                │
│                                                             │
│  Result: Balanced answer with multiple perspectives         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Human Parallel**: Internal debate - "On one hand... but on the other hand..."

---

### Option D: Memory-Enhanced Learning System

Add persistent memory that improves over time:

```
┌─────────────────────────────────────────────────────────────┐
│            MEMORY-ENHANCED ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              EPISODIC MEMORY                         │    │
│  │  "Last time user asked about Hansen Yuncken,        │    │
│  │   they wanted payment history AND project margin"   │    │
│  │                                                      │    │
│  │  "When user says 'revenue', they mean               │    │
│  │   expected_revenue not actual invoiced"             │    │
│  └─────────────────────────────────────────────────────┘    │
│                        ↓                                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              QUERY PROCESSING                        │    │
│  │  • Check memory for similar past queries            │    │
│  │  • Apply learned preferences                        │    │
│  │  • Route optimally based on past success            │    │
│  └─────────────────────────────────────────────────────┘    │
│                        ↓                                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              LEARNING FEEDBACK                       │    │
│  │  • User corrects answer → Update memory             │    │
│  │  • Successful pattern → Reinforce                   │    │
│  │  • Failed pattern → Adjust routing                  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Human Parallel**: You get better at your job over time by remembering what worked.

---

### Option E: Hypothesis-Test Loop (Scientific Method)

Claude generates hypotheses and actively tests them:

```
┌─────────────────────────────────────────────────────────────┐
│            HYPOTHESIS-TEST ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Query: "Why did revenue drop in Q2?"                       │
│                                                             │
│  HYPOTHESIS 1: "Fewer new projects"                         │
│      → Test: Count new projects Q1 vs Q2                    │
│      → Result: Same count                                   │
│      → REJECTED                                             │
│                                                             │
│  HYPOTHESIS 2: "Lower project values"                       │
│      → Test: Average project value Q1 vs Q2                 │
│      → Result: Q2 avg $150k lower                           │
│      → SUPPORTED                                            │
│                                                             │
│  HYPOTHESIS 3: "Different project types"                    │
│      → Test: Project type distribution                      │
│      → Result: More residential, less commercial            │
│      → SUPPORTED (explains lower values)                    │
│                                                             │
│  SYNTHESIS: "Revenue dropped because project mix shifted    │
│              from commercial to residential"                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Human Parallel**: "Let me check a few theories..."

---

## Recommended Hybrid Architecture (USER SELECTED)

Combining the best of each approach:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   NEXSUS COGNITIVE ARCHITECTURE v2                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  LAYER 1: PERCEPTION + MEMORY CHECK                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Parse query intent                                                    │ │
│  │ • Check memory: "Have I seen this pattern before?"                     │ │
│  │ • Check memory: "What does this user typically want?"                  │ │
│  │ • Confidence score: How familiar is this?                              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              ↓                                               │
│  LAYER 2: SYSTEM 1 OR SYSTEM 2 DECISION                                     │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ IF confidence > 85% AND known pattern:                                 │ │
│  │     → SYSTEM 1: Fast path, single adapter, cached synthesis            │ │
│  │ ELSE:                                                                   │ │
│  │     → SYSTEM 2: Deep analysis with continuous integration             │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              ↓                                               │
│  LAYER 3: CONTINUOUS INTEGRATION (System 2 only)                            │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Claude maintains running hypothesis                                    │ │
│  │                                                                         │ │
│  │ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │ │
│  │ │   semantic   │ │    exact     │ │  knowledge   │ │    graph     │   │ │
│  │ │   results    │ │   results    │ │   results    │ │   results    │   │ │
│  │ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘   │ │
│  │        │                │                │                │            │ │
│  │        └────────────────┴────────────────┴────────────────┘            │ │
│  │                                   ↓                                     │ │
│  │                    Claude UPDATES understanding                        │ │
│  │                    after EACH result arrives                           │ │
│  │                                   ↓                                     │ │
│  │              Can REQUEST MORE DATA if gaps detected                    │ │
│  │              "I need to check payment history too..."                  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              ↓                                               │
│  LAYER 4: GUT CHECK + SELF-REFLECTION                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Before finalizing:                                                      │ │
│  │ • "Does this answer make logical sense?"                               │ │
│  │ • "Are there any contradictions in my sources?"                        │ │
│  │ • "Am I confident enough to state this?"                               │ │
│  │ • "What might I be missing?"                                           │ │
│  │                                                                         │ │
│  │ IF doubt detected → Request additional verification                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              ↓                                               │
│  LAYER 5: ARTICULATION + LEARNING                                           │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ • Express answer with appropriate confidence                           │ │
│  │ • Cite sources naturally                                               │ │
│  │ • STORE successful pattern for System 1 future use                    │ │
│  │ • UPDATE user preferences if feedback received                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Implications

| Feature | Current Plan | Cognitive v2 |
|---------|--------------|--------------|
| Fast path | Stage 8 (optional) | Layer 2 (core) |
| Memory | Not included | Layer 1 + 5 (core) |
| Continuous integration | Not included | Layer 3 (core) |
| Self-reflection | Not included | Layer 4 (core) |
| Parallel processing | Stage 7 (optional) | Layer 3 (core) |
| Learning | Not included | Layer 5 (core) |

---

# IMPLEMENTATION PLAN

## Stage Summary

### Foundation Stages (Original Plan)
| Stage | Description | Effort |
|-------|-------------|--------|
| 1 | Fix KnowledgeAdapter import paths | Simple |
| 2 | Route knowledge for all data queries | Simple |
| 3 | Forensic Analyst system prompt | Simple |
| 4 | Multi-section chaining | Medium |
| 5 | Populate knowledge content | Medium |
| 6 | Make blendthink_execute default | Simple |

### Performance Optimization (Optional)
| Stage | Description | Effort |
|-------|-------------|--------|
| 7 | Parallel adapter execution | Medium |
| 8 | Simple mode bypass | Simple |

### Cognitive Architecture v2 (New)
| Stage | Layer | Description | Effort |
|-------|-------|-------------|--------|
| 9 | 1 + 5 | Memory Layer (patterns, preferences) | Medium-High |
| 10 | 2 | System 1/System 2 Decision | Medium |
| 11 | 3 | Continuous Integration Engine | High |
| 12 | 4 | Self-Reflection Layer | Medium |
| 13 | 5 | Learning Layer | Medium |

---

## Implementation Phases

### Phase 1: Foundation (Stages 1-6)
- Core blendthink working
- All sections routing
- Forensic Analyst persona

### Phase 2: Performance (Stages 7-8)
- Parallel execution
- Fast path for simple queries

### Phase 3: Cognitive v2 (Stages 9-13)
- Memory layer first (enables System 1/2)
- System 1/2 decision
- Continuous integration
- Self-reflection
- Learning

---

## Two-Level Claude API Architecture (Confirmed)

Each query flows through TWO Claude API calls:

```
┌─────────────────────────────────────────────────────────────┐
│ LEVEL 1: Outer Claude (claude.ai / Claude Code)             │
│ • Receives user query                                       │
│ • Decides to call blendthink_execute                        │
│ • Presents final answer to user                             │
└───────────────────────┬─────────────────────────────────────┘
                        ↓ MCP Tool Call
┌─────────────────────────────────────────────────────────────┐
│ LEVEL 2: Inner Claude (BlendthinkClaudeClient)              │
│ • Receives section results (semantic, exact, knowledge)     │
│ • Applies Forensic Analyst persona                          │
│ • Synthesizes blended answer with source attribution        │
│ • Uses ANTHROPIC_API_KEY from environment                   │
└─────────────────────────────────────────────────────────────┘
```

**Trade-offs (User Accepted):**
| Aspect | Impact |
|--------|--------|
| Cost | 2x Claude API usage per query |
| Latency | Additional ~3-8s (see detailed analysis below) |
| Quality | Higher - controlled persona, consistent formatting |
| Control | Full control over synthesis prompt and behavior |

---

## Latency & Efficiency Analysis

### Current Architecture (Direct Tool Calls)

```
User Query
    ↓ (~0.5s)
┌─────────────────────────────────────────┐
│ Outer Claude (claude.ai/Claude Code)    │
│ • Receives query                        │  ~1-3s thinking
│ • Decides: call semantic_search         │
│ • Calls MCP tool                        │
└─────────────────────────────────────────┘
    ↓ (~0.3s MCP overhead)
┌─────────────────────────────────────────┐
│ MCP Tool (semantic_search)              │
│ • Embed query (Voyage AI)               │  ~0.3-0.5s
│ • Query Qdrant                          │  ~0.2-0.5s
│ • Return results                        │
└─────────────────────────────────────────┘
    ↓ (~0.3s)
┌─────────────────────────────────────────┐
│ Outer Claude (continues)                │
│ • Receives tool results                 │  ~1-2s synthesis
│ • Synthesizes answer                    │
│ • Presents to user                      │
└─────────────────────────────────────────┘

TOTAL: ~3-6 seconds (simple query)
```

### Proposed Architecture (Blendthink)

```
User Query
    ↓ (~0.5s)
┌─────────────────────────────────────────┐
│ Outer Claude (claude.ai/Claude Code)    │
│ • Receives query                        │  ~0.5-1s (simpler decision)
│ • Decides: call blendthink_execute      │
└─────────────────────────────────────────┘
    ↓ (~0.3s MCP overhead)
┌─────────────────────────────────────────┐
│ blendthink_execute (MCP Tool)           │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ 1. QuestionAnalyzer              │   │  ~50-100ms (local)
│  │ 2. AdaptiveRouter                │   │  ~10-50ms (local)
│  │ 3. PersonaSelector               │   │  ~10-50ms (local)
│  └──────────────────────────────────┘   │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ 4. Section Adapters (SEQUENTIAL) │   │
│  │    • semantic_search             │   │  ~0.5-1s
│  │    • nexsus_search               │   │  ~0.5-2s (if chained)
│  │    • knowledge_search            │   │  ~0.3-0.5s
│  │    Total: 1-4 sections           │   │  ~1-4s total
│  └──────────────────────────────────┘   │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │ 5. Inner Claude Synthesis        │   │  ~2-5s (API call)
│  │    • Forensic Analyst persona    │   │
│  │    • Source attribution          │   │
│  └──────────────────────────────────┘   │
│                                         │
└─────────────────────────────────────────┘
    ↓ (~0.3s)
┌─────────────────────────────────────────┐
│ Outer Claude (continues)                │
│ • Receives blendthink result            │  ~0.5-1s (mostly pass-through)
│ • Presents to user                      │
└─────────────────────────────────────────┘

TOTAL: ~5-12 seconds (complex blended query)
```

### Latency Breakdown Comparison

| Component | Current | Proposed | Delta |
|-----------|---------|----------|-------|
| Outer Claude thinking | 1-3s | 0.5-1s | -0.5s (simpler) |
| MCP overhead | 0.3s | 0.3s | 0 |
| Question analysis | - | 0.1s | +0.1s |
| Section adapters | 0.5-1s | 1-4s | +0.5-3s (multiple) |
| **Inner Claude synthesis** | - | **2-5s** | **+2-5s** |
| Outer Claude synthesis | 1-2s | 0.5-1s | -0.5s (simpler) |
| **TOTAL** | **3-6s** | **5-12s** | **+2-6s** |

### Efficiency Trade-off Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    EFFICIENCY TRADE-OFF                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  LATENCY:  ████████████░░░░░░░░  +50-100% slower            │
│  COST:     ████████████░░░░░░░░  +100-150% more expensive   │
│  QUALITY:  ████████████████████  +200% better synthesis     │
│  CONTROL:  ████████████████████  Full persona control       │
│                                                             │
│  VERDICT: Worth it for complex queries                      │
│           Consider bypass for simple lookups                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Current State

```
User Query → Claude → Directly calls semantic_search OR nexsus_search
                      (Claude decides, blendthink bypassed)
```

## Target State

```
User Query → Claude → blendthink_execute → Intelligent Routing
                                          ├→ semantic/ (discovery)
                                          ├→ exact/ (aggregation)
                                          ├→ knowledge/ (interpretation)
                                          └→ common/ (relationships)
                                          ↓
                                     Synthesized Answer (Forensic Analyst)
```

---

## Existing Infrastructure (Already Built)

| Component | Location | Status |
|-----------|----------|--------|
| BlendthinkEngine | `src/console/blendthink/engine.ts` | Complete |
| QuestionAnalyzer | `src/console/blendthink/question-analyzer.ts` | Complete |
| AdaptiveRouter | `src/console/blendthink/adaptive-router.ts` | Complete |
| PersonaSelector | `src/console/blendthink/persona-selector.ts` | Complete |
| ClaudeClient | `src/console/blendthink/claude-client.ts` | Complete |
| SemanticAdapter | `src/console/blendthink/section-adapters/semantic-adapter.ts` | Complete |
| ExactAdapter | `src/console/blendthink/section-adapters/exact-adapter.ts` | Complete |
| GraphAdapter | `src/console/blendthink/section-adapters/graph-adapter.ts` | Complete |
| KnowledgeAdapter | `src/knowledge/adapter/knowledge-adapter.ts` | Complete |
| Adapter Registry | `src/console/blendthink/section-adapters/index.ts` | Complete |

---

# DETAILED STAGE SPECIFICATIONS

## Stage 1: Fix Architecture Violation in KnowledgeAdapter

**Goal:** Move SectionAdapter types to common/ so knowledge/ can import correctly

**Estimated effort:** Simple

**Tasks:**
- [ ] Verify types are already in `src/common/types.ts` (SectionAdapter, SectionResult, AdapterContext)
- [ ] Update `src/knowledge/adapter/knowledge-adapter.ts` to import from `../../common/types.js`
- [ ] Remove redundant type definitions if any exist in section-adapters/types.ts

**Files to modify:**
- `src/knowledge/adapter/knowledge-adapter.ts` (import path fix)

**Tests (Claude Code - stdio):**
- [ ] `npm run build` compiles without errors
- [ ] Import paths resolve correctly

**Tests (claude.ai - HTTP):**
- [ ] `blendthink_execute` with explanation query routes to knowledge adapter

**Success Criteria:**
- No circular import errors
- Knowledge adapter loads successfully in adapter registry

---

## Stage 2: Update Routing to Include Knowledge Section

**Goal:** Route more query types through knowledge/ for domain expertise

**Estimated effort:** Simple

**Tasks:**
- [ ] Update `adaptive-router.ts` to include knowledge/ for:
  - `aggregation` queries (add KPI interpretation)
  - `discovery` queries (add Odoo pattern guidance)
  - `explanation` queries (already included - verify)
- [ ] Add knowledge as secondary step for data-heavy queries
- [ ] Update routing table in blendthink-guide.md

**Files to modify:**
- `src/console/blendthink/adaptive-router.ts`
- `src/knowledge/static/blending/blendthink-guide.md`

**Current Routing Table:**
| Question Type | Knowledge Role |
|---|---|
| precise_query | Skipped |
| discovery | Skipped |
| aggregation | Skipped |
| explanation | Secondary |

**Target Routing Table (User Confirmed):**
| Question Type | Knowledge Role |
|---|---|
| precise_query | Skipped |
| discovery | **Secondary** (Odoo patterns, common pitfalls) |
| aggregation | **Secondary** (KPI formulas, benchmarks) |
| aggregation_with_discovery | **Secondary** (both patterns + KPIs) |
| explanation | **Primary** (full interpretation) |
| relationship | Skipped |
| comparison | **Secondary** (benchmark context) |

**Tests (Claude Code - stdio):**
- [ ] Test aggregation query routes: exact → knowledge
- [ ] Test discovery query routes: semantic → knowledge

**Tests (claude.ai - HTTP):**
- [ ] "Total revenue by partner" → includes KPI context
- [ ] "Find hospital projects" → includes Odoo pattern guidance

**Success Criteria:**
- Knowledge adapter called for aggregation and discovery queries
- Results include domain expertise alongside raw data

---

## Stage 3: Update Forensic Analyst System Prompt

**Goal:** Integrate the refined persona with Tool Capability Manifest and Schema Awareness

**Estimated effort:** Simple

**Tasks:**
- [ ] Update `persona-selector.ts` with new Forensic Analyst prompt including:
  - Tool Capability Manifest (semantic, exact, graph, knowledge descriptions)
  - Schema Awareness injection (key models summary)
  - Conservative error handling phrases
  - Adaptive output format guidance
- [ ] Add query history context building
- [ ] Add "conservative path first" clarification behavior

**Files to modify:**
- `src/console/blendthink/persona-selector.ts`

**New System Prompt Elements:**
```markdown
### YOUR PERSONA: Forensic Analyst
- Evidence-first: Every claim cites source tool and data
- Conservative: Never speculate or hallucinate
- Uncertainty handling: "I need to run another query to confirm"
- Phrases: "The data shows...", "Based on [tool] results..."

### TOOL CAPABILITY MANIFEST
| Tool | Best For |
|------|----------|
| semantic_search | Discovery, fuzzy matching |
| nexsus_search | Precise queries, aggregation |
| graph_traverse | Relationship navigation |
| knowledge_search | KPIs, Odoo patterns, domain rules |

### ADAPTIVE OUTPUT FORMAT
| Query Type | Format |
|------------|--------|
| Discovery | Bulleted list |
| Aggregation | Tables with totals |
| Relationship | Path notation |
| Explanation | Narrative with formulas |
```

**Tests (Claude Code - stdio):**
- [ ] `npm run build` compiles
- [ ] Unit test persona selection

**Tests (claude.ai - HTTP):**
- [ ] `blendthink_diagnose` shows Forensic Analyst persona
- [ ] Response includes source attribution

**Success Criteria:**
- Forensic Analyst is default persona for data queries
- Responses cite sources: "[Source: exact/nexsus_search]"
- Adaptive formatting matches query type

---

## Stage 4: Enable Multi-Section Chaining

**Goal:** Pass results between sections (semantic IDs → exact filters → knowledge interpretation)

**Estimated effort:** Medium

**Tasks:**
- [ ] Update `engine.ts` execute loop to pass previous results to next step
- [ ] Implement ID extraction from semantic results for exact filters
- [ ] Add aggregation results to knowledge context for interpretation
- [ ] Handle partial failures gracefully (continue with available data)

**Files to modify:**
- `src/console/blendthink/engine.ts` (step result passing)

**Chaining Example:**
```
Query: "Gross margin for hospital projects in Victoria"

Step 1: semantic_search("hospital projects Victoria")
        → IDs: [41085, 41092, 41156]

Step 2: nexsus_search(filters=[id IN IDs], agg=[sum(revenue), sum(cogs)])
        → revenue: $5.2M, cogs: $3.1M

Step 3: knowledge_search("gross margin interpretation")
        → Formula: (Revenue - COGS) / Revenue
        → Benchmark: >30% healthy

Synthesis: "Hospital projects gross margin: 40.4% ($2.1M / $5.2M) - exceeds benchmark"
```

**Tests (Claude Code - stdio):**
- [ ] Unit test step chaining with mock adapters
- [ ] Test ID extraction from semantic results

**Tests (claude.ai - HTTP):**
- [ ] Hybrid query executes all 3 steps in order
- [ ] Final response includes data from all sections

**Success Criteria:**
- Semantic IDs flow to exact filters automatically
- Knowledge interprets aggregation results
- Token budget prevents runaway execution

---

## Stage 5: Populate Knowledge Content

**Goal:** Add static knowledge files and sync dynamic knowledge

**Estimated effort:** Medium

**Tasks:**
- [ ] Create/verify static knowledge files:
  - `src/knowledge/static/tool-guidelines/nexsus-search.md`
  - `src/knowledge/static/tool-guidelines/semantic-search.md`
  - `src/knowledge/static/tool-guidelines/graph-traverse.md`
  - `src/knowledge/static/blending/blendthink-guide.md`
  - `src/knowledge/static/general/data-verification.md`
- [ ] Sync dynamic knowledge to Qdrant:
  - KPIs (Gross Margin, Current Ratio, DSO, etc.)
  - Odoo Patterns (Aged Receivables, GL Balance, Sales Pipeline)
  - Report structures (P&L, Balance Sheet)

**Commands:**
```bash
npm run sync -- sync knowledge
```

**Tests (Claude Code - stdio):**
- [ ] Knowledge sync completes without errors
- [ ] `system_status` shows knowledge vectors in collection

**Tests (claude.ai - HTTP):**
- [ ] Knowledge adapter returns real KPI formulas
- [ ] "What is gross margin?" returns definition and formula

**Success Criteria:**
- Static files loaded and cached
- Dynamic knowledge searchable in Qdrant
- Knowledge results enrich data queries

---

## Stage 6: Make blendthink_execute the Default

**Goal:** Update documentation to route queries through blendthink first

**Estimated effort:** Simple

**Tasks:**
- [ ] Update MCP tool descriptions to recommend blendthink_execute
- [ ] Update `CLAUDE.md` with blendthink-first workflow
- [ ] Add "simple mode" bypass for trivial queries (optional)
- [ ] Update section CLAUDE.md files with routing guidance

**Files to modify:**
- `src/console/blendthink/tools/execute-tool.ts` (description)
- `CLAUDE.md` (workflow section)
- `src/console/CLAUDE.md` (orchestration guidance)

**Tool Description Update:**
```typescript
description: `Execute a query through the full blendthink pipeline.
This is the RECOMMENDED entry point for all Nexsus queries.
Analyzes query → Routes to sections → Synthesizes response.

Use this instead of calling semantic_search or nexsus_search directly
unless you need specific low-level control.`
```

**Tests (Claude Code - stdio):**
- [ ] Tool descriptions updated in build output

**Tests (claude.ai - HTTP):**
- [ ] Natural language question uses blendthink_execute
- [ ] Response quality better than direct tool calls

**Success Criteria:**
- Claude naturally routes through blendthink
- Complex queries get blended answers
- Simple queries still fast

---

## OPTIONAL: Performance Optimizations

These stages are optional - implement based on cost-benefit analysis after core functionality works.

### Stage 7: Parallel Adapter Execution (OPTIONAL)

**Goal:** Run independent adapters simultaneously to reduce latency by 1-2 seconds

**Estimated effort:** Medium

**Latency Savings:** -1-2 seconds per query

**Current Behavior (Sequential):**
```
semantic_search → wait → nexsus_search → wait → knowledge_search → wait
Total: 0.8s + 1.5s + 0.5s = 2.8s
```

**Proposed Behavior (Parallel where possible):**
```
┌─ semantic_search ─┐
│                   ├─→ nexsus_search (needs semantic IDs) → knowledge_search
└───────────────────┘
Total: max(0.8s, dependent) + 1.5s + 0.5s = 2.0s (saves 0.8s)
```

**Tasks:**
- [ ] Identify which adapters are independent (can run in parallel)
- [ ] Group route steps by dependency level
- [ ] Use `Promise.all()` for independent steps at same level
- [ ] Maintain sequential execution for dependent steps (`dependsOnPrevious: true`)

**Files to modify:**
- `src/console/blendthink/engine.ts` (execution loop)
- `src/console/blendthink/adaptive-router.ts` (add dependency metadata)

**Implementation Pattern:**
```typescript
// Current (sequential)
for (const step of routePlan.steps) {
  const result = await adapter.execute(step, analysis);
  sectionResults.push(result);
}

// Proposed (parallel where possible)
const stepsByLevel = groupByDependencyLevel(routePlan.steps);
for (const levelSteps of stepsByLevel) {
  const results = await Promise.all(
    levelSteps.map(step => getAdapter(step.section).execute(step, analysis))
  );
  sectionResults.push(...results);
}
```

**Dependency Rules:**
| Step | Depends On | Can Parallel With |
|------|------------|-------------------|
| semantic_search | None | knowledge_search (if no IDs needed) |
| nexsus_search | semantic_search (if using discovered IDs) | - |
| knowledge_search | None (or semantic for context) | semantic_search |
| graph_traverse | semantic/nexsus (needs record IDs) | - |

**Tests (Claude Code - stdio):**
- [ ] Measure latency before/after
- [ ] Verify results are same regardless of execution order
- [ ] Test failure handling in parallel execution

**Success Criteria:**
- 1-2 second latency reduction for multi-adapter queries
- No change in result quality
- Graceful failure handling (one adapter fails, others continue)

---

### Stage 8: Simple Mode Bypass (OPTIONAL)

**Goal:** Skip blendthink for trivial queries, route directly to tools

**Estimated effort:** Simple

**Latency Savings:** -3-5 seconds for simple queries (avoids inner Claude)

**When to Bypass:**
| Query Pattern | Example | Action |
|---------------|---------|--------|
| Exact ID lookup | "Get partner 286798" | Direct nexsus_search |
| Single model scan | "List all crm.lead" | Direct nexsus_search |
| Simple count | "How many partners?" | Direct nexsus_search |
| Schema lookup | "What fields in crm.lead?" | Direct semantic_search |

**When NOT to Bypass:**
| Query Pattern | Example | Action |
|---------------|---------|--------|
| Discovery + aggregation | "Revenue for hospital projects" | Full blendthink |
| Explanation needed | "Why did revenue drop?" | Full blendthink |
| Multi-model query | "Partners and their invoices" | Full blendthink |
| Comparison | "Compare Q1 vs Q2" | Full blendthink |

**Tasks:**
- [ ] Add `complexity` score to QuestionAnalysis
- [ ] Define bypass threshold (e.g., complexity < 0.3)
- [ ] Create `blendthink_execute_simple` or add `mode: 'simple' | 'full'` parameter
- [ ] Route simple queries directly to single tool
- [ ] Outer Claude synthesizes for simple mode (no inner Claude)

**Files to modify:**
- `src/console/blendthink/question-analyzer.ts` (add complexity scoring)
- `src/console/blendthink/engine.ts` (add bypass logic)
- `src/console/blendthink/tools/execute-tool.ts` (add mode parameter)

**Implementation Pattern:**
```typescript
async execute(query: string, options: { mode?: 'auto' | 'simple' | 'full' } = {}) {
  const analysis = await this.analyzer.analyze(query);

  // Auto-detect or use explicit mode
  const mode = options.mode === 'auto'
    ? (analysis.complexity < 0.3 ? 'simple' : 'full')
    : options.mode;

  if (mode === 'simple') {
    // Bypass inner Claude - return raw tool results
    const adapter = getAdapter(analysis.primarySection);
    const result = await adapter.execute(step, analysis);
    return {
      mode: 'simple',
      data: result.data,
      // No Claude synthesis - outer Claude handles this
    };
  }

  // Full blendthink with inner Claude synthesis
  return this.executeFullPipeline(query, analysis);
}
```

**Tests (Claude Code - stdio):**
- [ ] Simple query routes to bypass mode
- [ ] Complex query routes to full mode
- [ ] `mode: 'full'` forces full pipeline even for simple queries

**Tests (claude.ai - HTTP):**
- [ ] "Get partner 286798" → fast response (~3s)
- [ ] "Revenue for hospital projects" → full blendthink (~8s)

**Success Criteria:**
- Simple queries respond in ~3-4 seconds (vs ~6-8 seconds)
- Complex queries still get full blendthink treatment
- User can override with explicit mode parameter

---

## Optimization Summary

| Optimization | Savings | When Applied | Complexity |
|--------------|---------|--------------|------------|
| Stage 7: Parallel adapters | -1-2s | All multi-adapter queries | Medium |
| Stage 8: Simple bypass | -3-5s | Simple queries only | Simple |
| **Combined** | **-4-7s** | Varies by query | - |

**Post-Optimization Latency:**

| Query Type | Current | Core Stages | + Stage 7 | + Stage 8 |
|------------|---------|-------------|-----------|-----------|
| Simple lookup | 3s | 6s | 5s | **3s** |
| Discovery | 4s | 7s | **5.5s** | 5.5s |
| Aggregation | 5s | 9s | **7.5s** | 7.5s |
| Complex hybrid | 6s | 12s | **10s** | 10s |

---

# COGNITIVE ARCHITECTURE v2 - DETAILED STAGES

## Stage 9: Memory Layer (Layer 1 + 5)

**Goal:** Add persistent memory for query patterns, user preferences, and learned optimizations

**Estimated effort:** Medium-High

**Components:**

```
┌─────────────────────────────────────────────────────────────┐
│                    MEMORY ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          QUERY PATTERN MEMORY                        │    │
│  │  • Store: query → successful route → outcome         │    │
│  │  • Vector similarity for "have I seen this before?"  │    │
│  │  • Fast lookup: ~50ms                                │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          USER PREFERENCE MEMORY                      │    │
│  │  • "This user prefers detailed tables"               │    │
│  │  • "This user means 'expected_revenue' for revenue"  │    │
│  │  • Stored per-user or per-session                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │          ROUTING OPTIMIZATION MEMORY                 │    │
│  │  • "Queries about 'hospital' need semantic first"   │    │
│  │  • "Aggregation queries skip knowledge section"     │    │
│  │  • Learned from successful/failed patterns           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Tasks:**
- [ ] Create `src/console/blendthink/memory/` directory
- [ ] Implement `query-pattern-memory.ts` - vector-based pattern storage
- [ ] Implement `user-preference-memory.ts` - per-user settings
- [ ] Implement `routing-memory.ts` - learned route optimizations
- [ ] Store memory in Qdrant with `point_type: 'memory'`
- [ ] Add memory check in Layer 1 before routing

**Files to create:**
- `src/console/blendthink/memory/index.ts`
- `src/console/blendthink/memory/query-pattern-memory.ts`
- `src/console/blendthink/memory/user-preference-memory.ts`
- `src/console/blendthink/memory/routing-memory.ts`

**Memory Point Structure:**
```typescript
interface MemoryPoint {
  point_type: 'memory';
  memory_type: 'query_pattern' | 'user_preference' | 'routing';
  query_embedding: number[];  // For similarity search
  query_text: string;
  successful_route: RouteStep[];
  outcome_quality: number;  // 0-1 rating
  user_id?: string;
  created_at: string;
  used_count: number;
}
```

**Success Criteria:**
- Similar queries find matching patterns in <100ms
- Memory size bounded (LRU eviction)
- Privacy: user memory isolated

---

## Stage 10: System 1/System 2 Decision Layer (Layer 2)

**Goal:** Fast path for familiar queries, deep analysis only when needed

**Estimated effort:** Medium

**Decision Logic:**

```typescript
async function decidePath(query: string, memoryResult: MemoryMatch | null): PathDecision {
  // Calculate familiarity score
  const familiarity = memoryResult?.similarity ?? 0;
  const patternConfidence = memoryResult?.outcomeQuality ?? 0;
  const queryComplexity = await analyzeComplexity(query);

  // System 1 criteria (fast path)
  if (
    familiarity > 0.85 &&           // Very similar to past query
    patternConfidence > 0.8 &&       // Past pattern was successful
    queryComplexity < 0.3            // Query is simple
  ) {
    return {
      path: 'system1',
      cachedRoute: memoryResult.successfulRoute,
      estimatedLatency: '2-3s'
    };
  }

  // System 2 criteria (deep path)
  return {
    path: 'system2',
    reason: familiarity < 0.5 ? 'novel_query' :
            queryComplexity > 0.7 ? 'complex_query' :
            'low_pattern_confidence',
    estimatedLatency: '8-12s'
  };
}
```

**Tasks:**
- [ ] Implement `path-decision.ts` - System 1/2 decision logic
- [ ] Add complexity scoring to QuestionAnalyzer
- [ ] Create fast-path executor (single adapter, cached synthesis)
- [ ] Create deep-path executor (full continuous integration)
- [ ] Add path decision logging for analysis

**Files to modify:**
- `src/console/blendthink/engine.ts` (add path decision)
- `src/console/blendthink/question-analyzer.ts` (add complexity)

**Files to create:**
- `src/console/blendthink/path-decision.ts`
- `src/console/blendthink/fast-path-executor.ts`

**Success Criteria:**
- System 1 responds in <3 seconds
- System 1 only triggers for genuinely familiar patterns
- Novel queries always go to System 2

---

## Stage 11: Continuous Integration Layer (Layer 3)

**Goal:** Claude updates understanding as each result arrives, can request more data

**Estimated effort:** High

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│           CONTINUOUS INTEGRATION ENGINE                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              RUNNING HYPOTHESIS                      │    │
│  │                                                      │    │
│  │  initial: "User wants hospital project revenue"     │    │
│  │                                                      │    │
│  │  after semantic: "Found 12 projects, key players:   │    │
│  │                   Hansen Yuncken, Watpac, Probuild" │    │
│  │                                                      │    │
│  │  after exact: "Total revenue $2.4M, but 3 projects  │    │
│  │                have $0 - might be early stage"      │    │
│  │                                                      │    │
│  │  after knowledge: "Revenue per project ($200k) is   │    │
│  │                    below benchmark ($500k)"         │    │
│  │                                                      │    │
│  │  Claude identifies gap: "Should check project       │    │
│  │                          stages to explain $0s"     │    │
│  │                                                      │    │
│  │  → REQUESTS MORE DATA                               │    │
│  │                                                      │    │
│  │  after graph: "3 projects are in 'Proposal' stage"  │    │
│  │                                                      │    │
│  │  FINAL: "12 hospital projects, $2.4M total.         │    │
│  │          3 at proposal stage with no revenue yet.   │    │
│  │          Active projects average $267k/project."    │    │
│  │                                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Implementation Pattern:**

```typescript
class ContinuousIntegrationEngine {
  private runningHypothesis: string = '';
  private collectedEvidence: SectionResult[] = [];
  private requestedSections: Set<string> = new Set();

  async executeWithIntegration(
    query: string,
    initialRoute: RoutePlan
  ): Promise<BlendResult> {

    // Initialize hypothesis
    this.runningHypothesis = await this.claudeClient.formHypothesis(query);

    // Execute sections (parallel where possible)
    for (const step of initialRoute.steps) {
      const result = await this.executeSection(step);
      this.collectedEvidence.push(result);

      // UPDATE hypothesis after each result
      const update = await this.claudeClient.updateHypothesis(
        this.runningHypothesis,
        result
      );

      this.runningHypothesis = update.newHypothesis;

      // CHECK if Claude wants more data
      if (update.needsMoreData) {
        const additionalSection = update.requestedSection;
        if (!this.requestedSections.has(additionalSection)) {
          this.requestedSections.add(additionalSection);
          // Add to route dynamically
          initialRoute.steps.push(this.createStep(additionalSection));
        }
      }
    }

    // Final synthesis already embedded in hypothesis
    return this.buildResult(this.runningHypothesis, this.collectedEvidence);
  }
}
```

**Tasks:**
- [ ] Create `continuous-integration-engine.ts`
- [ ] Modify Claude client to support streaming hypothesis updates
- [ ] Implement "request more data" capability
- [ ] Add dynamic route modification
- [ ] Parallel execution for independent sections
- [ ] Token budget tracking across updates

**Files to create:**
- `src/console/blendthink/continuous-integration-engine.ts`

**Files to modify:**
- `src/console/blendthink/claude-client.ts` (add updateHypothesis)
- `src/console/blendthink/engine.ts` (use CI engine for System 2)

**Claude API Implications:**
- Multiple Claude calls per query (hypothesis updates)
- Each update is small (~500 tokens)
- Total may be 4-8 Claude calls vs 1 large call
- Potentially more expensive but more human-like

**Success Criteria:**
- Understanding builds incrementally
- Claude can request additional data when gaps detected
- No discrete "synthesis" step - answer emerges naturally

---

## Stage 12: Self-Reflection Layer (Layer 4)

**Goal:** Claude questions its own conclusions before finalizing

**Estimated effort:** Medium

**Reflection Prompts:**

```typescript
const REFLECTION_PROMPTS = {
  logical_check: `
    Review your conclusion: "{hypothesis}"

    Ask yourself:
    1. Does this make logical sense given the data?
    2. Are there any contradictions between sources?
    3. Have I made any assumptions that should be stated?
    4. What might I be missing?

    If any concerns, explain and request verification.
  `,

  confidence_check: `
    For each claim in your answer:
    - Rate confidence: HIGH (>90%), MEDIUM (70-90%), LOW (<70%)
    - For LOW confidence claims, either:
      a) Request more data to verify
      b) Phrase with appropriate uncertainty
  `,

  completeness_check: `
    The user asked: "{original_query}"
    Your answer addresses: "{hypothesis}"

    Does your answer fully address what they asked?
    If not, what additional information is needed?
  `
};
```

**Implementation:**

```typescript
async function performSelfReflection(
  hypothesis: string,
  query: string,
  evidence: SectionResult[]
): Promise<ReflectionResult> {

  // Run all reflection checks
  const logicalCheck = await claudeClient.reflect(
    REFLECTION_PROMPTS.logical_check.replace('{hypothesis}', hypothesis)
  );

  const confidenceCheck = await claudeClient.reflect(
    REFLECTION_PROMPTS.confidence_check
  );

  const completenessCheck = await claudeClient.reflect(
    REFLECTION_PROMPTS.completeness_check
      .replace('{original_query}', query)
      .replace('{hypothesis}', hypothesis)
  );

  // Aggregate concerns
  if (logicalCheck.hasConcerns || completenessCheck.needsMoreInfo) {
    return {
      passed: false,
      concerns: [...logicalCheck.concerns, ...completenessCheck.gaps],
      requestedVerification: logicalCheck.verificationNeeded
    };
  }

  // Adjust confidence language
  return {
    passed: true,
    adjustedHypothesis: applyConfidenceLanguage(hypothesis, confidenceCheck),
    confidenceLevels: confidenceCheck.levels
  };
}
```

**Tasks:**
- [ ] Create `self-reflection.ts` with reflection prompts
- [ ] Implement reflection checks (logical, confidence, completeness)
- [ ] Add verification loop if concerns detected
- [ ] Apply confidence language to final answer
- [ ] Limit reflection iterations (max 2)

**Files to create:**
- `src/console/blendthink/self-reflection.ts`

**Success Criteria:**
- Contradictions in sources are caught
- Low-confidence claims are phrased appropriately
- Incomplete answers trigger additional data requests

---

## Stage 13: Learning Layer (Layer 5)

**Goal:** Store successful patterns for future System 1 use

**Estimated effort:** Medium

**Learning Triggers:**

```typescript
interface LearningEvent {
  query: string;
  queryEmbedding: number[];
  routeUsed: RouteStep[];
  outcomeQuality: number;  // From user feedback or heuristics
  userPreferences: {
    preferredFormat: 'table' | 'narrative' | 'bullets';
    detailLevel: 'concise' | 'detailed';
    terminology: Record<string, string>;  // "revenue" → "expected_revenue"
  };
}

async function learnFromInteraction(event: LearningEvent) {
  // Only learn from successful interactions
  if (event.outcomeQuality < 0.7) return;

  // Store query pattern
  await queryPatternMemory.store({
    query_text: event.query,
    query_embedding: event.queryEmbedding,
    successful_route: event.routeUsed,
    outcome_quality: event.outcomeQuality,
    used_count: 1
  });

  // Update routing optimization
  await routingMemory.updateOptimization(
    event.queryType,
    event.routeUsed,
    event.outcomeQuality
  );

  // Store user preferences
  if (event.userPreferences) {
    await userPreferenceMemory.update(
      event.userId,
      event.userPreferences
    );
  }
}
```

**Feedback Mechanisms:**

1. **Explicit feedback**: User says "that's not what I meant"
2. **Implicit feedback**: User asks follow-up clarifying question (negative)
3. **Implicit success**: User accepts answer and moves on (positive)
4. **Correction tracking**: User provides correct interpretation

**Tasks:**
- [ ] Implement feedback detection heuristics
- [ ] Create learning event processor
- [ ] Store patterns to memory layer (Stage 9)
- [ ] Implement decay for old patterns
- [ ] Add preference extraction from corrections

**Files to create:**
- `src/console/blendthink/learning.ts`
- `src/console/blendthink/feedback-detector.ts`

**Success Criteria:**
- Successful patterns are stored
- Future similar queries use System 1
- User preferences are learned over time

---

## Cognitive v2 API Cost Estimate

| Layer | Claude Calls | Tokens (est) |
|-------|--------------|--------------|
| System 1 (fast) | 0-1 | 500 |
| System 2 hypothesis init | 1 | 1000 |
| System 2 updates (4x avg) | 4 | 2000 |
| Self-reflection | 1-2 | 1500 |
| **System 1 Total** | **~1** | **~500** |
| **System 2 Total** | **~6-8** | **~5000-6000** |

**Cost per query:**
- System 1: ~$0.01
- System 2: ~$0.08-0.12

**Note**: More expensive than current plan, but significantly more human-like behavior.

---

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| All 4 section adapters | Done | Already implemented |
| Adapter registry | Done | All 4 sections registered |
| BlendthinkEngine | Done | Orchestration complete |
| ClaudeClient | Done | Synthesis working |
| `ANTHROPIC_API_KEY` | Required | For blendthink_execute |
| Static knowledge files | Partial | Some exist, need verification |
| Dynamic knowledge sync | Pending | Need to run sync command |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Knowledge adds latency | Make knowledge secondary step, not blocking |
| Wrong section routing | Conservative-first, ask for clarification |
| Token budget exceeded | Strict tracking, early termination |
| Breaking direct tools | Keep direct tools available as fallback |
| Architecture violation | Stage 1 fixes import paths first |

---

## Critical Files to Modify

| Stage | File | Change |
|-------|------|--------|
| 1 | `src/knowledge/adapter/knowledge-adapter.ts` | Fix import path |
| 2 | `src/console/blendthink/adaptive-router.ts` | Add knowledge routing |
| 3 | `src/console/blendthink/persona-selector.ts` | Forensic Analyst prompt |
| 4 | `src/console/blendthink/engine.ts` | Step result chaining |
| 5 | `src/knowledge/static/**/*.md` | Add/verify content |
| 6 | `CLAUDE.md`, tool descriptions | Documentation |
| 7 | `src/console/blendthink/engine.ts` | Parallel adapter execution (optional) |
| 8 | `src/console/blendthink/adaptive-router.ts` | Simple mode bypass (optional) |
| 9 | `src/console/blendthink/memory/*.ts` | Memory layer (new files) |
| 10 | `src/console/blendthink/path-decision.ts` | System 1/2 decision (new) |
| 11 | `src/console/blendthink/continuous-integration-engine.ts` | CI engine (new) |
| 12 | `src/console/blendthink/self-reflection.ts` | Reflection layer (new) |
| 13 | `src/console/blendthink/learning.ts` | Learning layer (new) |

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    BLENDTHINK ENGINE                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  Question   │→ │  Adaptive   │→ │   Persona   │             │
│  │  Analyzer   │  │   Router    │  │  Selector   │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         ↓                ↓                ↓                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  SECTION ADAPTERS                         │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │  │
│  │  │ Semantic │ │  Exact   │ │Knowledge │ │  Graph   │     │  │
│  │  │ Adapter  │ │ Adapter  │ │ Adapter  │ │ Adapter  │     │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘     │  │
│  └───────┼────────────┼────────────┼────────────┼───────────┘  │
│          ↓            ↓            ↓            ↓               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              SECTION SERVICES (via common/)              │  │
│  │  semantic_  │ nexsus_   │ static/   │ graph_            │  │
│  │  search     │ search    │ dynamic   │ traverse          │  │
│  └──────────────────────────────────────────────────────────┘  │
│         ↓                                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              CLAUDE SYNTHESIS                            │   │
│  │  Forensic Analyst persona + Adaptive formatting          │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

# R2 CLOUDFLARE STORAGE ENHANCEMENTS

## Overview

Nexsus already has **production-ready R2 integration** for Excel exports. This section extends R2 usage to enhance the Cognitive Architecture with persistent storage, caching, and session continuity.

**Existing R2 Capabilities:**
| Capability | Status | Location |
|------------|--------|----------|
| Excel export to cloud | Complete | `src/common/services/r2-client.ts` |
| Signed URL generation | Complete | 1-hour expiry, configurable |
| Auto-export on token threshold | Complete | `src/common/services/export-orchestrator.ts` |
| Fallback to local filesystem | Complete | Graceful degradation |

**R2 Configuration (4 env vars required):**
```bash
R2_ACCOUNT_ID=<cloudflare_account_id>
R2_ACCESS_KEY_ID=<api_token_access_key>
R2_SECRET_ACCESS_KEY=<api_token_secret>
R2_BUCKET_NAME=nexsus-exports
```

---

## Hybrid Memory Architecture with R2

```
┌─────────────────────────────────────────────────────────────┐
│                 HYBRID MEMORY ARCHITECTURE                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  QDRANT (Hot Storage)          R2 (Cold Storage)           │
│  ┌─────────────────────┐       ┌─────────────────────┐     │
│  │ • Query patterns    │       │ • Memory backups    │     │
│  │ • User preferences  │  ───► │ • Session archives  │     │
│  │ • Routing memory    │ sync  │ • Learning history  │     │
│  │ • Fast lookup ~50ms │       │ • Large artifacts   │     │
│  └─────────────────────┘       └─────────────────────┘     │
│                                                             │
│  Benefits:                                                  │
│  • Qdrant restart doesn't lose memory                      │
│  • User sessions persist across deployments                │
│  • Audit trail for learning events                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## R2 Bucket Structure

```
nexsus-exports/
├── exports/                    # Existing Excel exports
│   └── nexsus_export_*.xlsx
├── sessions/                   # NEW: Session persistence
│   └── {session_id}.json
├── cache/                      # NEW: Synthesis cache
│   └── synthesis/
│       └── {hash}.json
├── memory/                     # NEW: Memory backups
│   ├── patterns/
│   │   └── {date}/patterns.jsonl
│   └── preferences/
│       └── {user_id}.json
└── learning/                   # NEW: Learning archives
    ├── events/
    │   └── {date}/events.jsonl
    └── feedback/
        └── corrections.jsonl
```

---

## R2 Enhancement 1: Synthesis Cache (QUICK WIN)

**Impact:** 30-50% cost reduction on repeated/similar queries
**Effort:** Low
**Stage:** 9 (or standalone before Stage 9)

**Problem:** System 2 queries cost ~$0.08-0.12 each (multiple Claude calls)

**Solution:** Cache successful synthesis results in R2

```typescript
// src/console/blendthink/cache/synthesis-cache.ts

import { getR2Client, isR2Available } from '../../common/services/r2-client.js';
import crypto from 'crypto';

interface CachedSynthesis {
  queryHash: string;
  dataHash: string;
  response: string;
  sources: SynthesisResult['sources'];
  createdAt: string;
  expiresAt: string;
  hitCount: number;
}

export class SynthesisCache {
  private readonly CACHE_TTL = 3600; // 1 hour
  private readonly CACHE_PREFIX = 'cache/synthesis/';

  async get(query: string, sectionResults: SectionResult[]): Promise<CachedSynthesis | null> {
    if (!isR2Available()) return null;

    const key = this.buildCacheKey(query, sectionResults);
    try {
      const cached = await getR2Client().getJson<CachedSynthesis>(
        `${this.CACHE_PREFIX}${key}.json`
      );

      if (cached && new Date(cached.expiresAt) > new Date()) {
        // Update hit count (fire and forget)
        this.incrementHitCount(key, cached);
        return cached;
      }
    } catch {
      // Cache miss or error - continue without cache
    }
    return null;
  }

  async set(
    query: string,
    sectionResults: SectionResult[],
    synthesis: SynthesisResult
  ): Promise<void> {
    if (!isR2Available()) return;

    const key = this.buildCacheKey(query, sectionResults);
    const now = new Date();

    await getR2Client().uploadJson(`${this.CACHE_PREFIX}${key}.json`, {
      queryHash: this.hash(query),
      dataHash: this.hash(JSON.stringify(sectionResults)),
      response: synthesis.response,
      sources: synthesis.sources,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.CACHE_TTL * 1000).toISOString(),
      hitCount: 0
    });
  }

  private buildCacheKey(query: string, sectionResults: SectionResult[]): string {
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');
    const dataFingerprint = sectionResults
      .map(r => `${r.section}:${r.recordCount}`)
      .join('|');
    return this.hash(`${normalizedQuery}|${dataFingerprint}`);
  }

  private hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  private async incrementHitCount(key: string, cached: CachedSynthesis): Promise<void> {
    getR2Client().uploadJson(`${this.CACHE_PREFIX}${key}.json`, {
      ...cached,
      hitCount: cached.hitCount + 1
    }).catch(() => {});
  }
}
```

**Integration in engine.ts:**
```typescript
// Before Claude synthesis:
const cache = new SynthesisCache();
const cached = await cache.get(query, sectionResults);

if (cached) {
  return {
    response: cached.response,
    sources: cached.sources,
    fromCache: true,
    tokensSaved: estimatedTokens
  };
}

// After Claude synthesis:
await cache.set(query, sectionResults, synthesisResult);
```

**Cost Impact:**
| Scenario | Without Cache | With Cache |
|----------|--------------|------------|
| Repeated query | $0.08 | $0.00 |
| Similar query (cache hit) | $0.08 | $0.00 |
| Novel query | $0.08 | $0.08 |
| **Daily savings (est)** | - | **30-50%** |

---

## R2 Enhancement 2: Session Persistence

**Impact:** UX improvement - resume conversations across restarts
**Effort:** Low
**Stage:** 9

**Problem:** `conversation-memory.ts` loses state on server restart

**Solution:** Persist session state to R2

```typescript
// src/console/blendthink/memory/session-persistence.ts

interface SessionState {
  session_id: string;
  user_id?: string;
  discovered_ids: number[];       // From semantic search
  active_filters: FilterCondition[];
  query_history: string[];
  preferences: UserPreferences;
  last_activity: string;
  created_at: string;
}

export class SessionPersistence {
  private readonly SESSION_PREFIX = 'sessions/';
  private readonly SESSION_TTL = 86400; // 24 hours

  async save(sessionId: string, state: SessionState): Promise<void> {
    if (!isR2Available()) return;

    await getR2Client().uploadJson(
      `${this.SESSION_PREFIX}${sessionId}.json`,
      {
        ...state,
        last_activity: new Date().toISOString()
      }
    );
  }

  async load(sessionId: string): Promise<SessionState | null> {
    if (!isR2Available()) return null;

    try {
      const state = await getR2Client().getJson<SessionState>(
        `${this.SESSION_PREFIX}${sessionId}.json`
      );

      // Check if session expired
      if (state && this.isExpired(state.last_activity)) {
        return null;
      }

      return state;
    } catch {
      return null;
    }
  }

  private isExpired(lastActivity: string): boolean {
    const elapsed = Date.now() - new Date(lastActivity).getTime();
    return elapsed > this.SESSION_TTL * 1000;
  }
}
```

**Benefits:**
- Resume conversations after server restart
- "Continue where I left off" across devices
- Session replay for debugging
- Discovered IDs persist for follow-up queries

---

## R2 Enhancement 3: Memory Backup

**Impact:** Reliability - memory survives Qdrant issues
**Effort:** Medium
**Stage:** 9

**Solution:** Periodic backup of Qdrant memory to R2

```typescript
// src/console/blendthink/memory/r2-backup.ts

export class MemoryBackupService {
  private readonly BACKUP_PREFIX = 'memory/';
  private readonly BACKUP_INTERVAL = 3600000; // 1 hour

  async backupPatterns(patterns: QueryPattern[]): Promise<void> {
    if (!isR2Available()) return;

    const date = new Date().toISOString().split('T')[0];
    const filename = `${this.BACKUP_PREFIX}patterns/${date}/patterns.jsonl`;

    // Append to daily file (JSONL format)
    const content = patterns.map(p => JSON.stringify(p)).join('\n');
    await getR2Client().appendToFile(filename, content);
  }

  async restoreFromBackup(date?: string): Promise<QueryPattern[]> {
    if (!isR2Available()) return [];

    const targetDate = date || new Date().toISOString().split('T')[0];
    const filename = `${this.BACKUP_PREFIX}patterns/${targetDate}/patterns.jsonl`;

    try {
      const content = await getR2Client().getText(filename);
      return content.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async backupUserPreferences(userId: string, prefs: UserPreferences): Promise<void> {
    if (!isR2Available()) return;

    await getR2Client().uploadJson(
      `${this.BACKUP_PREFIX}preferences/${userId}.json`,
      prefs
    );
  }
}
```

**Backup Strategy:**
| Data Type | Backup Frequency | Retention |
|-----------|------------------|-----------|
| Query patterns | Hourly | 30 days |
| User preferences | On change | Forever |
| Routing optimizations | Daily | 7 days |
| Learning events | Real-time | 90 days |

---

## R2 Enhancement 4: Learning Archive

**Impact:** Analytics and improvement insights
**Effort:** Low
**Stage:** 13

**Solution:** Store learning events for analysis

```typescript
// src/console/blendthink/learning/r2-archive.ts

interface LearningEvent {
  event_id: string;
  timestamp: string;
  query: string;
  route_used: RouteStep[];
  outcome_quality: number;
  feedback_type: 'explicit' | 'implicit_success' | 'implicit_failure';
  user_correction?: string;
  token_usage: { input: number; output: number };
  latency_ms: number;
}

export class LearningArchive {
  async recordEvent(event: LearningEvent): Promise<void> {
    if (!isR2Available()) return;

    const date = new Date().toISOString().split('T')[0];
    const filename = `learning/events/${date}/events.jsonl`;

    await getR2Client().appendToFile(
      filename,
      JSON.stringify(event) + '\n'
    );
  }

  async recordCorrection(
    originalQuery: string,
    userCorrection: string,
    correctedInterpretation: string
  ): Promise<void> {
    if (!isR2Available()) return;

    await getR2Client().appendToFile(
      'learning/feedback/corrections.jsonl',
      JSON.stringify({
        timestamp: new Date().toISOString(),
        original_query: originalQuery,
        user_correction: userCorrection,
        corrected_interpretation: correctedInterpretation
      }) + '\n'
    );
  }
}
```

**Analytics Queries (future):**
- "Which query patterns have lowest outcome quality?"
- "What corrections do users make most often?"
- "How has routing accuracy improved over time?"

---

## R2 Enhancement 5: Dynamic Knowledge (Optional)

**Impact:** Flexibility - update knowledge without deployment
**Effort:** Medium
**Stage:** 5

**Solution:** Serve knowledge content from R2 with local fallback

```typescript
// src/knowledge/services/r2-knowledge-loader.ts

export class R2KnowledgeLoader {
  private readonly KNOWLEDGE_PREFIX = 'knowledge/';
  private localFallback: LocalKnowledgeLoader;

  async loadKnowledge(path: string): Promise<string> {
    // Try R2 first
    if (isR2Available()) {
      try {
        return await getR2Client().getText(
          `${this.KNOWLEDGE_PREFIX}${path}`
        );
      } catch {
        // Fall through to local
      }
    }

    // Fall back to local filesystem
    return this.localFallback.load(path);
  }

  async updateKnowledge(path: string, content: string): Promise<void> {
    if (!isR2Available()) {
      throw new Error('R2 not available for knowledge updates');
    }

    await getR2Client().uploadText(
      `${this.KNOWLEDGE_PREFIX}${path}`,
      content
    );
  }
}
```

**Benefits:**
- Update KPI definitions without code deployment
- A/B test different knowledge content
- Version history in R2

---

## R2 Enhancement 6: Blendthink Report Export

**Impact:** Completeness - export complex multi-section results
**Effort:** Low
**Stage:** 6

**Solution:** Extend auto-export to blendthink results

```typescript
// In blendthink engine, after synthesis:
if (shouldAutoExport(blendResult, tokenUsage)) {
  const exportResult = await exportOrchestrator.exportBlendthinkResult({
    query,
    analysis: questionAnalysis,
    sectionResults,
    synthesis: synthesisResult,
    sources: synthesisResult.sources,
    tokenUsage,
    timing: {
      total: totalDuration,
      perSection: sectionTimings
    }
  });

  blendResult.exportUrl = exportResult.downloadUrl;
}
```

**Multi-sheet Excel report:**
| Sheet | Content |
|-------|---------|
| Summary | Query, synthesis, sources, confidence |
| Semantic | Discovery results, similarity scores |
| Exact | Aggregations, record data |
| Knowledge | KPIs applied, patterns matched |
| Graph | Relationship traversal data |
| Metadata | Timing, tokens, route plan |

---

## Updated Stage 9 with R2 Integration

**Stage 9 (Revised): Memory Layer with R2 Persistence**

**Original Tasks:**
- [ ] Create `src/console/blendthink/memory/` directory
- [ ] Implement `query-pattern-memory.ts` - vector-based pattern storage
- [ ] Implement `user-preference-memory.ts` - per-user settings
- [ ] Implement `routing-memory.ts` - learned route optimizations
- [ ] Store memory in Qdrant with `point_type: 'memory'`
- [ ] Add memory check in Layer 1 before routing

**New R2 Tasks:**
- [ ] Implement `synthesis-cache.ts` - cache Claude responses in R2
- [ ] Implement `session-persistence.ts` - persist sessions to R2
- [ ] Implement `r2-backup.ts` - backup memory to R2
- [ ] Add cache check before Claude synthesis in engine.ts
- [ ] Add session save/restore in conversation-memory.ts

**New Files:**
```
src/console/blendthink/
├── cache/
│   └── synthesis-cache.ts      # NEW
├── memory/
│   ├── index.ts
│   ├── query-pattern-memory.ts
│   ├── user-preference-memory.ts
│   ├── routing-memory.ts
│   ├── session-persistence.ts  # NEW
│   └── r2-backup.ts            # NEW
```

---

## R2 Enhancement Summary

| Enhancement | Impact | Effort | Stage | Priority |
|-------------|--------|--------|-------|----------|
| Synthesis Cache | High (cost -30-50%) | Low | 9 | **P0 - Quick Win** |
| Session Persistence | Medium (UX) | Low | 9 | P1 |
| Memory Backup | Medium (reliability) | Medium | 9 | P2 |
| Learning Archive | Low (analytics) | Low | 13 | P3 |
| Dynamic Knowledge | Medium (flexibility) | Medium | 5 | P3 |
| Report Export | Low (completeness) | Low | 6 | P4 |

**Recommended Implementation Order:**
1. **Synthesis Cache** - Immediate ROI, simple to implement
2. **Session Persistence** - Improves UX significantly
3. **Memory Backup** - Adds reliability layer
4. Rest can be implemented as needed

---

## R2 Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| R2 client (`r2-client.ts`) | Done | Already implemented |
| Export orchestrator | Done | Already implemented |
| R2 bucket created | Required | Must create in Cloudflare |
| R2 env vars set | Required | 4 variables in Railway |

---

*Last Updated: 2026-01-03*
*Plan Version: Cognitive Architecture v2 + R2 Enhancements (Complete 13-Stage Plan)*
