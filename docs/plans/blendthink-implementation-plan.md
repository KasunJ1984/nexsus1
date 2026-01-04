 
 # Blendthink Implementation Plan

**Feature**: Background Intelligence Layer for Console Section
**Status**: Planning
**Created**: 2026-01-01

---

## Executive Summary

Blendthink is a background intelligence layer that users never see directly. It orchestrates how the console synthesizes responses by blending all 5 sections (exact, semantic, knowledge, common, values) using the Claude API.

**Key Innovation**: Adaptive routing + adaptive persona + multi-turn refinement + vector-embedded memory

---

## Part 1: Architecture Overview

### 1.1 System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER QUERY                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BLENDTHINK ENGINE                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Question   │  │  Adaptive   │  │   Persona   │  │ Conversation │    │
│  │  Analyzer   │──▶│   Router    │──▶│  Selector   │──▶│   Manager   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│         │                │                │                │            │
│         ▼                ▼                ▼                ▼            │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                       CLAUDE API ORCHESTRATOR                     │  │
│  │  • Multi-turn conversation                                        │  │
│  │  • Follow-up question generation                                  │  │
│  │  • Source attribution                                             │  │
│  │  • Confidence scoring                                             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   exact/     │ │  semantic/   │ │  knowledge/  │ │   common/    │
│              │ │              │ │              │ │              │
│ nexsus_search│ │semantic_search│ │ (future)    │ │graph_traverse│
│ aggregation  │ │find_similar  │ │ accounting  │ │schema_lookup │
│ filters      │ │patterns      │ │ rules       │ │vector_client │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
         │              │              │              │
         └──────────────┴──────────────┴──────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    QDRANT: nexsus_unified                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ point_type: │  │ point_type: │  │ point_type: │  │ point_type: │    │
│  │   'data'    │  │  'schema'   │  │   'graph'   │  │'conversation'│    │
│  │             │  │             │  │             │  │   (NEW!)     │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow Diagram

```
User Query: "What is the total revenue for hospital projects in Victoria?"
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 1: QUESTION ANALYSIS                                                │
│                                                                          │
│  Input:  "What is the total revenue for hospital projects in Victoria?" │
│  Output: {                                                               │
│    type: "aggregation_with_discovery",                                   │
│    entities: ["hospital", "Victoria"],                                   │
│    operation: "sum",                                                     │
│    field_hint: "revenue"                                                 │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 2: ADAPTIVE ROUTING                                                 │
│                                                                          │
│  Route Plan:                                                             │
│  1. semantic/ → Find hospital projects in Victoria (discovery)          │
│  2. exact/ → Sum revenue for discovered record IDs (aggregation)        │
│                                                                          │
│  Skip: knowledge/ (no accounting rules needed)                           │
│  Skip: common/ (no schema lookup needed)                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 3: PERSONA SELECTION                                                │
│                                                                          │
│  Question Type: aggregation_with_discovery                               │
│  Selected Persona: FORENSIC_ANALYST                                      │
│                                                                          │
│  Behavior:                                                               │
│  - Ground claims in exact data                                           │
│  - Say "the data shows..." before conclusions                            │
│  - High confidence threshold (80%)                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 4: MULTI-TURN EXECUTION                                             │
│                                                                          │
│  Turn 1: Query semantic/                                                 │
│  └─▶ semantic_search("hospital projects Victoria", model="crm.lead")    │
│  └─▶ Result: 15 matching records [IDs: 123, 456, ...]                   │
│                                                                          │
│  Turn 2: Query exact/                                                    │
│  └─▶ nexsus_search(filters=[{id IN [...]}], agg=[sum(expected_revenue)])│
│  └─▶ Result: { total_revenue: 4,250,000 }                               │
│                                                                          │
│  Turn 3: Synthesize                                                      │
│  └─▶ Claude API: Combine results with persona                           │
│  └─▶ Generate source-attributed answer                                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ STEP 5: RESPONSE + MEMORY                                                │
│                                                                          │
│  Response:                                                               │
│  "The data shows $4.25M total expected revenue across 15 hospital       │
│   projects in Victoria. [Source: semantic/ discovery + exact/ agg]"     │
│                                                                          │
│  Memory:                                                                 │
│  └─▶ Embed conversation turn into Qdrant (point_type='conversation')   │
│  └─▶ Future queries can recall: "Remember hospital projects query..."   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Component Responsibilities

| Component | Responsibility | Location |
|-----------|---------------|----------|
| **QuestionAnalyzer** | Parse query, extract intent/entities/operations | `src/console/blendthink/question-analyzer.ts` |
| **AdaptiveRouter** | Decide which sections to query and in what order | `src/console/blendthink/adaptive-router.ts` |
| **PersonaSelector** | Choose thinking style based on question type | `src/console/blendthink/persona-selector.ts` |
| **ConversationManager** | Manage multi-turn state, memory, history | `src/console/blendthink/conversation-manager.ts` |
| **ClaudeOrchestrator** | Execute Claude API calls with system prompts | `src/console/blendthink/claude-orchestrator.ts` |
| **BlendthinkEngine** | Main entry point coordinating all components | `src/console/blendthink/engine.ts` |

---

## Part 2: TypeScript Interfaces

### 2.1 Core Types (add to `src/common/types.ts`)

```typescript
// =============================================================================
// BLENDTHINK TYPES
// =============================================================================

/**
 * Question types that blendthink can route
 */
export type QuestionType =
  | 'precise_query'           // "What is the balance of account 123?"
  | 'discovery'               // "Find hospital projects"
  | 'aggregation'             // "Total revenue by partner"
  | 'aggregation_with_discovery' // "Total revenue for hospital projects"
  | 'relationship'            // "How is this partner connected to...?"
  | 'explanation'             // "Why did this variance occur?"
  | 'comparison'              // "Compare Q1 vs Q2 performance"
  | 'unknown';                // Needs clarification

/**
 * Persona types for adaptive thinking
 */
export type PersonaType =
  | 'forensic_analyst'        // Evidence-first, "the data shows..."
  | 'systems_thinker'         // Connection-finder, patterns
  | 'socratic_guide'          // Question-asker, leads through discovery
  | 'neutral';                // Default balanced response

/**
 * Sections that blendthink can route to
 */
export type BlendSection = 'exact' | 'semantic' | 'knowledge' | 'common';

/**
 * Result of question analysis
 */
export interface QuestionAnalysis {
  /** Original query text */
  query: string;

  /** Classified question type */
  type: QuestionType;

  /** Confidence in classification (0-1) */
  confidence: number;

  /** Extracted entities (names, IDs, keywords) */
  entities: string[];

  /** Detected operation (sum, count, list, etc.) */
  operation?: string;

  /** Field hints extracted from query */
  fieldHints?: string[];

  /** Model hints extracted from query */
  modelHints?: string[];
}

/**
 * Routing decision for a section
 */
export interface RouteStep {
  /** Target section */
  section: BlendSection;

  /** Tool to call in that section */
  tool: string;

  /** Parameters for the tool call */
  params: Record<string, unknown>;

  /** Order in execution sequence (1 = first) */
  order: number;

  /** Why this section was chosen */
  reason: string;
}

/**
 * Complete routing plan
 */
export interface RoutePlan {
  /** Steps to execute */
  steps: RouteStep[];

  /** Sections explicitly skipped and why */
  skipped: Array<{ section: BlendSection; reason: string }>;

  /** Estimated token budget for this plan */
  estimatedTokens: number;
}

/**
 * A single turn in a conversation
 */
export interface ConversationTurn {
  /** Unique turn ID */
  id: string;

  /** Role: user or assistant */
  role: 'user' | 'assistant';

  /** Content of the turn */
  content: string;

  /** Timestamp */
  timestamp: Date;

  /** Question analysis (for user turns) */
  analysis?: QuestionAnalysis;

  /** Route plan (for user turns) */
  routePlan?: RoutePlan;

  /** Sections that contributed (for assistant turns) */
  sources?: Array<{ section: BlendSection; contribution: string }>;

  /** Confidence in response (for assistant turns) */
  confidence?: number;
}

/**
 * Conversation session with memory
 */
export interface BlendthinkSession {
  /** Unique session ID */
  sessionId: string;

  /** All turns in this session */
  turns: ConversationTurn[];

  /** Current persona being used */
  activePersona: PersonaType;

  /** Token usage so far */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    budget: number;
  };

  /** Session start time */
  startedAt: Date;

  /** Last activity time */
  lastActivityAt: Date;

  /** Whether session is still active */
  active: boolean;
}

/**
 * Blend result with full attribution
 */
export interface BlendResult {
  /** The synthesized answer */
  answer: string;

  /** Confidence score (0-1) */
  confidence: number;

  /** Source attribution */
  sources: Array<{
    section: BlendSection;
    tool: string;
    contribution: string;
    dataPoints?: number;
  }>;

  /** Reasoning chain */
  reasoning: string[];

  /** Follow-up suggestions */
  followUps?: string[];

  /** Warnings or caveats */
  warnings?: string[];

  /** Token usage for this blend */
  tokenUsage: {
    input: number;
    output: number;
  };
}

/**
 * Blendthink configuration
 */
export interface BlendthinkConfig {
  /** Maximum turns before forcing synthesis */
  maxTurns: number;

  /** Maximum tokens per session */
  tokenBudget: number;

  /** Minimum confidence to return answer (vs admit uncertainty) */
  confidenceThreshold: number;

  /** Whether to require source attribution */
  requireAttribution: boolean;

  /** Claude API model to use */
  claudeModel: string;

  /** Whether to persist conversations to Qdrant */
  persistConversations: boolean;
}

/**
 * Conversation memory point (for Qdrant storage)
 */
export interface ConversationPayload {
  /** Point type discriminator */
  point_type: 'conversation';

  /** Session ID this turn belongs to */
  session_id: string;

  /** Turn number within session */
  turn_number: number;

  /** Role */
  role: 'user' | 'assistant';

  /** Raw content */
  content: string;

  /** Question type (for user turns) */
  question_type?: QuestionType;

  /** Sections queried (for assistant turns) */
  sections_queried?: BlendSection[];

  /** Timestamp ISO string */
  timestamp: string;

  /** Vector text that was embedded */
  vector_text: string;
}
```

### 2.2 V2 UUID Format for Conversations

Add to `src/utils/uuid-v2.ts`:

```typescript
/**
 * Generate V2 UUID for conversation points
 * Format: 00000004-SSSS-TTTT-0000-TTTTTTTTTTTT
 * - 00000004 = conversation namespace
 * - SSSS = session hash (first 4 hex chars of session ID)
 * - TTTT = turn number (4 digits, padded)
 * - TTTTTTTTTTTT = timestamp (12 digits, epoch ms mod 10^12)
 */
export function generateConversationUuid(
  sessionId: string,
  turnNumber: number,
  timestamp: Date
): string {
  const sessionHash = sessionId.slice(0, 4).padStart(4, '0');
  const turnPadded = turnNumber.toString().padStart(4, '0');
  const epochMs = timestamp.getTime() % 1e12;
  const timestampPadded = epochMs.toString().padStart(12, '0');

  return `00000004-${sessionHash}-${turnPadded}-0000-${timestampPadded}`;
}
```

---

## Part 3: Phased Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

**Goal**: Core infrastructure and basic routing

#### Tasks

- [ ] **1.1 Create blendthink directory structure**
  ```
  src/console/blendthink/
  ├── index.ts              # Main exports
  ├── engine.ts             # BlendthinkEngine class
  ├── types.ts              # Local types (re-export from common)
  ├── question-analyzer.ts  # Question classification
  ├── adaptive-router.ts    # Section routing logic
  └── config.ts             # Default configuration
  ```

- [ ] **1.2 Implement QuestionAnalyzer**
  - Use Claude API to classify question type
  - Extract entities, operations, field hints
  - Return confidence score
  - Unit tests with 20+ example queries

- [ ] **1.3 Implement AdaptiveRouter**
  - Routing rules based on question type:
    | Question Type | Primary Section | Secondary | Skip |
    |--------------|-----------------|-----------|------|
    | precise_query | exact/ | - | semantic/, knowledge/ |
    | discovery | semantic/ | exact/ | knowledge/ |
    | aggregation | exact/ | - | semantic/, knowledge/ |
    | aggregation_with_discovery | semantic/ → exact/ | - | knowledge/ |
    | relationship | common/ (graph) | semantic/ | knowledge/ |
    | explanation | knowledge/ → exact/ | semantic/ | - |
  - Token budget estimation per route

- [ ] **1.4 Add types to common/types.ts**
  - Add all interfaces from Part 2
  - Add to existing type file (don't create new file)

- [ ] **1.5 Update console/CLAUDE.md**
  - Add blendthink to file ownership manifest
  - Document the architecture

#### Deliverables
- QuestionAnalyzer with 90%+ accuracy on test set
- AdaptiveRouter with all routing rules
- Types integrated into common/types.ts
- All unit tests passing

---

### Phase 2: Persona & Orchestration (Week 3-4)

**Goal**: Adaptive persona and Claude API integration

#### Tasks

- [ ] **2.1 Implement PersonaSelector**
  - Map question types to personas:
    | Question Type | Persona | System Prompt Focus |
    |--------------|---------|---------------------|
    | precise_query | forensic_analyst | "Ground all claims in exact data" |
    | discovery | systems_thinker | "Find patterns and connections" |
    | aggregation | forensic_analyst | "Report numbers with sources" |
    | explanation | socratic_guide | "Guide through reasoning" |
  - Generate persona-specific system prompts

- [ ] **2.2 Implement ClaudeOrchestrator**
  - Claude API client with retry logic
  - System prompt injection based on persona
  - Multi-turn conversation support
  - Token counting and budget enforcement
  - Source attribution extraction

- [ ] **2.3 Implement section execution**
  - Create adapters for each section's tools:
    - `executeExact(params)` → nexsus_search
    - `executeSemantic(params)` → semantic_search
    - `executeGraph(params)` → graph_traverse
  - Handle errors gracefully (circuit breaker pattern)

- [ ] **2.4 Integration tests**
  - End-to-end test: question → analysis → routing → execution → response
  - Test persona switching based on question type
  - Test token budget enforcement

#### Deliverables
- PersonaSelector with all personas defined
- ClaudeOrchestrator with full API integration
- Section execution adapters
- Integration test suite

---

### Phase 3: Multi-Turn & Memory (Week 5-6)

**Goal**: Conversation management and vector-embedded memory

#### Tasks

- [ ] **3.1 Implement ConversationManager**
  - Session creation and management
  - Turn tracking
  - Context window management (sliding window for long conversations)
  - Session timeout and cleanup

- [ ] **3.2 Implement conversation memory persistence**
  - Add point_type='conversation' to Qdrant
  - Embed conversation turns using existing embedding service
  - UUID V2 format for conversation points
  - Semantic recall: "Remember when we discussed..."

- [ ] **3.3 Implement multi-turn refinement**
  - Claude generates follow-up questions when needed
  - Console fetches additional data based on follow-ups
  - Max 5 turns before forcing synthesis
  - Graceful degradation when stuck

- [ ] **3.4 Add MCP tool (optional)**
  - Consider adding `blendthink` as MCP tool
  - Or keep as internal engine called by other tools

#### Deliverables
- ConversationManager with full lifecycle
- Conversation memory in Qdrant
- Multi-turn refinement working
- Semantic recall across sessions

---

### Phase 4: Constraints & Polish (Week 7-8)

**Goal**: Production-ready with all constraints

#### Tasks

- [ ] **4.1 Implement all constraints**
  - Turn limit (max 5 refinement turns)
  - Token budget (configurable per session)
  - Confidence threshold (80% or admit uncertainty)
  - Source attribution (every claim cites section)
  - Error handling (graceful degradation)

- [ ] **4.2 Add observability**
  - Structured logging for all blendthink operations
  - Metrics: question types, personas used, token usage
  - Performance tracking: latency per section

- [ ] **4.3 Configuration management**
  - Environment variables for all config
  - Default config with sensible values
  - Override capability per session

- [ ] **4.4 Documentation**
  - Update main CLAUDE.md
  - Create SKILL-blendthink.md
  - Add examples and usage patterns

#### Deliverables
- All 5 constraints implemented
- Full observability
- Configuration system
- Complete documentation

---

## Part 4: File Structure (Final)

```
src/console/
├── CLAUDE.md                          # Section documentation
├── index.ts                           # MCP server entry (existing)
└── blendthink/
    ├── index.ts                       # Main exports
    ├── engine.ts                      # BlendthinkEngine class
    ├── config.ts                      # Configuration defaults
    ├── question-analyzer.ts           # Question classification
    ├── adaptive-router.ts             # Section routing
    ├── persona-selector.ts            # Persona selection
    ├── claude-orchestrator.ts         # Claude API integration
    ├── conversation-manager.ts        # Session & memory
    ├── section-adapters/
    │   ├── exact-adapter.ts           # Adapter for exact/
    │   ├── semantic-adapter.ts        # Adapter for semantic/
    │   ├── graph-adapter.ts           # Adapter for common/graph
    │   └── knowledge-adapter.ts       # Adapter for knowledge/
    └── __tests__/
        ├── question-analyzer.test.ts
        ├── adaptive-router.test.ts
        ├── persona-selector.test.ts
        └── integration.test.ts
```

---

## Part 5: Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **Claude API costs spiral** | Token budget per session, turn limits, efficient routing |
| **Slow response times** | Parallel section queries where possible, caching |
| **Poor question classification** | Extensive test set, fallback to "unknown" with clarification |
| **Memory bloat in Qdrant** | TTL on conversation points, session cleanup |
| **Section failures cascade** | Circuit breaker pattern, graceful degradation |

---

## Part 6: Success Criteria

| Metric | Target |
|--------|--------|
| Question classification accuracy | > 90% |
| Average response latency | < 5 seconds for simple queries |
| Token efficiency | < 10k tokens per typical conversation |
| Confidence calibration | 80% threshold should be 80% accurate |
| Source attribution coverage | 100% of claims have sources |

---

## Next Steps

1. **Review this plan** with user for approval
2. **Start Phase 1** with directory structure and QuestionAnalyzer
3. **Iterate** based on learnings from each phase

---

*Plan generated by Claude Code - 2026-01-01*
