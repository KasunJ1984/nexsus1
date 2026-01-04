# Blendthink Phase 2 - Claude API Integration

## Overview
Phase 2 adds the execution layer to blendthink: Claude API integration to synthesize responses, section adapters to call underlying services directly, and conversation memory for multi-turn refinement.

**Status:** ✅ COMPLETE (committed: `fa5d37a`)

## Architecture

```
User Query
    ↓
BlendthinkEngine.execute()
    ├── analyze() [Phase 1 - Done]
    │   ├── QuestionAnalyzer → classification
    │   ├── AdaptiveRouter → route plan
    │   └── PersonaSelector → persona + system prompt
    ↓
Section Adapters [Phase 2 - Done]
    ├── SemanticAdapter → embed() + searchByPointType()
    ├── ExactAdapter → buildQdrantFilter() + executeAggregation()
    └── GraphAdapter → retrievePointById() + FK traversal
    ↓
Claude API Orchestration [Phase 2 - Done]
    ├── Build context from section results
    ├── Call Claude with persona system prompt
    ├── Parse response with source attribution
    └── Track token usage
    ↓
Conversation Memory [Phase 2 - Done]
    ├── Record turn to session (in-memory)
    ├── Persist sessions periodically (JSON file)
    └── Future: Embed turns for semantic recall
```

## Stages

### Stage 1: Infrastructure Setup
**Goal:** Install dependencies and create base types
**Estimated effort:** Simple
**Status:** ✅ Complete

**Tasks:**
- [x] Install @anthropic-ai/sdk
- [x] Create section adapter types (SectionResult, SectionAdapter, AdapterContext)
- [x] Create adapter index with factory function

**Files Created:**
- `src/console/blendthink/section-adapters/types.ts`
- `src/console/blendthink/section-adapters/index.ts`

**Tests (Claude Code - stdio):**
- [x] `npm run build` passes

**Success Criteria:**
- TypeScript compiles without errors
- Adapter types are exported correctly

---

### Stage 2: Section Adapters
**Goal:** Create adapters that call underlying services directly
**Estimated effort:** Medium
**Status:** ✅ Complete

**Tasks:**
- [x] Create SemanticAdapter (calls embed + searchByPointType)
- [x] Create ExactAdapter (calls buildQdrantFilter + executeAggregation + scrollRecords)
- [x] Create GraphAdapter (calls retrievePointById + batchRetrievePoints)

**Files Created:**
- `src/console/blendthink/section-adapters/semantic-adapter.ts`
- `src/console/blendthink/section-adapters/exact-adapter.ts`
- `src/console/blendthink/section-adapters/graph-adapter.ts`

**Tests (Claude Code - stdio):**
- [x] `npm run build` passes
- [x] Adapters import correctly

**Success Criteria:**
- Each adapter implements SectionAdapter interface
- Adapters return SectionResult with data, token estimates, timing

---

### Stage 3: Claude API Client
**Goal:** Create wrapper for Anthropic SDK with persona-based synthesis
**Estimated effort:** Medium
**Status:** ✅ Complete

**Tasks:**
- [x] Create BlendthinkClaudeClient class
- [x] Implement synthesize() method with system prompts
- [x] Add source attribution parsing
- [x] Track token usage
- [x] Add isClaudeAvailable() check

**Files Created:**
- `src/console/blendthink/claude-client.ts`

**Tests (Claude Code - stdio):**
- [x] `npm run build` passes
- [x] `isClaudeAvailable()` returns true when ANTHROPIC_API_KEY set

**Success Criteria:**
- Claude API calls work with persona prompts
- Token usage tracked correctly
- Graceful fallback when API key missing

---

### Stage 4: Engine Execute Method
**Goal:** Implement full execution pipeline in BlendthinkEngine
**Estimated effort:** Medium
**Status:** ✅ Complete

**Tasks:**
- [x] Add execute() method to engine
- [x] Route plan execution via section adapters
- [x] Token budget monitoring (stop at 80%)
- [x] Claude synthesis call
- [x] Turn recording
- [x] Return BlendResult

**Files Modified:**
- `src/console/blendthink/engine.ts`
- `src/common/types.ts` (BlendResult interface)

**Tests (Claude Code - stdio):**
- [x] Engine executes queries successfully
- [x] Section results collected
- [x] Claude synthesizes response

**Success Criteria:**
- Full pipeline: analyze → execute steps → synthesize
- Token budget respected
- Sources attributed in response

---

### Stage 5: Conversation Memory
**Goal:** Dual storage for session persistence
**Estimated effort:** Medium
**Status:** ✅ Complete

**Tasks:**
- [x] Create in-memory session store
- [x] JSON file persistence (every 5 minutes)
- [x] Session TTL (24 hours)
- [x] Qdrant storage for turns (point_type='conversation')
- [x] Initialize/shutdown handlers

**Files Created:**
- `src/console/blendthink/conversation-memory.ts`

**Storage:**
- In-memory: `Map<string, BlendthinkSession>`
- File: `data/blendthink-sessions.json`
- Qdrant: `point_type='conversation'` in unified collection

**Tests (Claude Code - stdio):**
- [x] Sessions persist to file
- [x] Sessions load on restart

**Success Criteria:**
- Sessions survive server restart
- Turns embedded to Qdrant for future semantic recall

---

### Stage 6: MCP Tool Registration
**Goal:** Expose blendthink_execute as MCP tool
**Estimated effort:** Simple
**Status:** ✅ Complete

**Tasks:**
- [x] Create execute-tool.ts with MCP registration
- [x] Register in console/index.ts
- [x] Add conversation memory initialization to startup

**Files Created:**
- `src/console/blendthink/tools/execute-tool.ts`

**Files Modified:**
- `src/console/index.ts`
- `src/console/blendthink/index.ts`

**Tests (Claude Code - stdio):**
- [x] Server starts with tool registered
- [x] Tool appears in MCP tool list

**Tests (claude.ai - HTTP):**
- [ ] Call `blendthink_execute({ "query": "Find hospital projects in Victoria" })`
- [ ] Verify response includes sources and persona

**Success Criteria:**
- Tool callable via MCP protocol
- Returns formatted BlendResult

---

## Dependencies

| Dependency | Purpose | Status |
|------------|---------|--------|
| @anthropic-ai/sdk | Claude API calls | ✅ Installed |
| ANTHROPIC_API_KEY | API authentication | ✅ Configured locally |
| Railway env var | Cloud deployment | ⏳ User needs to add |

## Build Errors Fixed

| Error | Fix |
|-------|-----|
| `DEFAULT_ADAPTER_CONTEXT` import type vs value | Separate imports |
| `validation.isValid` not `validation.valid` | Property name |
| `AggregationResult` format | Map to groups/results |
| `SimilaritySearchResult.similar_records` | Correct property access |
| `batchRetrievePoints` returns Map | Iterate with `for..of` |
| `RouteStep.estimatedTokens` missing | Use default 2000 estimate |
| `ConversationPayload` cast | Cast through `unknown` |

## Test Results

**Query:** "Find hospital projects in Victoria"

| Metric | Value |
|--------|-------|
| Question Type | discovery (80% confidence) |
| Persona | Systems Thinker |
| Route | semantic → exact |
| Records Found | 50 + 100 |
| Total Time | 18.9 seconds |
| Claude Response | ✅ With source citations |

## Files Summary

| File | Action | Lines |
|------|--------|-------|
| `package.json` | Modified | +1 dep |
| `src/common/types.ts` | Modified | BlendResult update |
| `section-adapters/types.ts` | Created | ~50 |
| `section-adapters/semantic-adapter.ts` | Created | ~270 |
| `section-adapters/exact-adapter.ts` | Created | ~390 |
| `section-adapters/graph-adapter.ts` | Created | ~330 |
| `section-adapters/index.ts` | Created | ~50 |
| `claude-client.ts` | Created | ~200 |
| `conversation-memory.ts` | Created | ~250 |
| `engine.ts` | Modified | +150 |
| `tools/execute-tool.ts` | Created | ~200 |
| `console/index.ts` | Modified | +10 |
| `blendthink/index.ts` | Modified | +5 |

**Total:** 15 files, 2570 insertions

## Notes

- Phase 2 builds on Phase 1 (question analysis, routing, persona selection)
- Section adapters bypass MCP protocol for efficiency (direct service calls)
- Conversation memory follows analytics-service.ts dual storage pattern
- 5 turn limit and 50k token budget enforced per session
- Source attribution required in all Claude responses
