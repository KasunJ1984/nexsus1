# Nexsus 5-Section Architecture: Context-Only Implementation

## Overview
Create logical section boundaries using CLAUDE.md files to provide clear context for Claude Code development, WITHOUT moving any files. This mirrors human cognition (Exact → Semantic → Knowledge → Common → Console) and prevents context pollution during development.

**Approach**: Context-Only (Phase 1) - Create CLAUDE.md files defining section boundaries without moving code files. Zero risk of breaking the build.

**Origin**: Evaluated using 4D Prompt Framework, scored 30/30 after 7 refinement rounds.

---

## Stages

### Stage 1: Create Section Directory Structure
**Goal:** Create empty section folders with placeholder files
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/semantic/` directory
- [ ] Create `src/exact/` directory
- [ ] Create `src/knowledge/` directory
- [ ] Create `src/common/` directory
- [ ] Create `src/console/` directory

**Tests (Claude Code - stdio):**
- [ ] Run `dir src\semantic` - directory exists
- [ ] Run `dir src\exact` - directory exists
- [ ] Run `npm run build` - still compiles (no changes to code)

**Tests (claude.ai - HTTP):**
- [ ] Verify directories appear in file explorer
- [ ] Confirm no TypeScript errors in IDE

**Success Criteria:**
- 5 new directories exist under src/
- Build still passes

---

### Stage 2: Create Nexsus_common CLAUDE.md
**Goal:** Define the shared foundation section rules
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/common/CLAUDE.md` with:
  - Section objective: Shared infrastructure used by all sections
  - Anti-patterns: Never add section-specific logic here
  - File ownership manifest (list of files that belong here)
  - Quality gates: Changes must not break other sections

**File Ownership (existing files that logically belong here):**
```
src/types.ts
src/constants.ts
src/schemas/index.ts
src/services/vector-client.ts
src/services/embedding-service.ts
src/services/odoo-client.ts
src/services/schema-loader.ts
src/services/schema-lookup.ts
src/services/schema-query-service.ts
src/services/model-registry.ts
src/services/knowledge-graph.ts
src/services/nexsus-link.ts
src/services/logger.ts
src/services/circuit-breaker.ts
src/services/metrics.ts
src/services/dlq.ts
src/services/cache-service.ts
src/services/file-export.ts
src/services/json-fk-config.ts
src/utils/*
src/tools/graph-tool.ts
```

**Tests (Claude Code - stdio):**
- [ ] Read `src/common/CLAUDE.md` - content is correct
- [ ] Verify all listed files exist at their current locations

**Tests (claude.ai - HTTP):**
- [ ] Ask Claude to work on vector-client.ts - should reference common section rules

**Success Criteria:**
- CLAUDE.md clearly defines common section boundaries
- All files in manifest actually exist

---

### Stage 3: Create Nexsus_semantic CLAUDE.md
**Goal:** Define the semantic search section rules
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/semantic/CLAUDE.md` with:
  - Section objective: AI-powered semantic/vector search
  - Anti-patterns: NEVER return results as "exact" data, always include similarity scores
  - File ownership manifest
  - Interaction contracts: May be CALLED by exact/ for parameter suggestions
  - Quality gates: Semantic results must include confidence/similarity

**File Ownership (existing files that logically belong here):**
```
src/tools/search-tool.ts
src/services/analytics-service.ts
src/services/graph-search-engine.ts
```

**Tests (Claude Code - stdio):**
- [ ] Read `src/semantic/CLAUDE.md` - content is correct

**Tests (claude.ai - HTTP):**
- [ ] Ask Claude to modify search-tool.ts - should apply semantic section rules

**Success Criteria:**
- CLAUDE.md clearly separates semantic from exact functionality
- Anti-patterns prevent mixing semantic with exact results

---

### Stage 4: Create Nexsus_exact CLAUDE.md
**Goal:** Define the precise query section rules
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/exact/CLAUDE.md` with:
  - Section objective: Precise data retrieval, SQL-like queries, NO AI inference in results
  - Anti-patterns: NEVER use fuzzy matching, similarity scores, or AI inference in output
  - File ownership manifest
  - Interaction contracts: May CALL semantic/ functions to help identify filter parameters, but results must be pure data
  - Quality gates: Same query = same results (reproducible)

**File Ownership (existing files that logically belong here):**
```
src/tools/nexsus-search.ts
src/tools/data-tool.ts
src/services/aggregation-engine.ts
src/services/filter-builder.ts
src/services/scroll-engine.ts
src/services/token-estimator.ts
src/services/dot-notation-resolver.ts
src/services/data-grid.ts
```

**Tests (Claude Code - stdio):**
- [ ] Read `src/exact/CLAUDE.md` - content is correct

**Tests (claude.ai - HTTP):**
- [ ] Ask Claude to add feature to nexsus-search.ts - should apply exact section rules
- [ ] Verify Claude doesn't add AI/semantic logic to exact results

**Success Criteria:**
- CLAUDE.md enforces pure data output (no AI inference)
- Clear boundary between exact and semantic

---

### Stage 5: Create Nexsus_knowledge CLAUDE.md
**Goal:** Define the subject knowledge section rules (placeholder for future)
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/knowledge/CLAUDE.md` with:
  - Section objective: Subject matter expertise (accounting rules, Odoo knowledge, P&L structure)
  - Anti-patterns: Never hardcode business logic that should be configurable
  - File ownership manifest: (empty - to be built)
  - Future content examples: P&L templates, balance sheet rules, Odoo workflow knowledge

**File Ownership (future files):**
```
(No files yet - section to be built with experience)
Examples of future content:
- accounting-rules.ts (P&L structure, balance sheet format)
- odoo-knowledge.ts (workflow rules, field meanings)
- claude-skills/ (financial analysis skills)
```

**Tests (Claude Code - stdio):**
- [ ] Read `src/knowledge/CLAUDE.md` - content is correct

**Tests (claude.ai - HTTP):**
- [ ] Verify section is marked as "future/placeholder"

**Success Criteria:**
- CLAUDE.md explains section purpose even though empty
- Clear guidance for future content

---

### Stage 6: Create Nexsus_console CLAUDE.md
**Goal:** Define the orchestration/CLI section rules
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/console/CLAUDE.md` with:
  - Section objective: Orchestrates all other sections, blends results, handles CLI sync operations
  - Anti-patterns: Never duplicate logic from other sections - call them instead
  - File ownership manifest
  - Interaction contracts: CAN import from ALL sections
  - Quality gates: Long-running operations must show progress, handle errors gracefully

**File Ownership (existing files that logically belong here):**
```
src/sync/index.ts
src/sync/commands/*
src/services/pipeline-data-sync.ts
src/services/cascade-sync.ts
src/services/pipeline-data-transformer.ts
src/services/data-transformer.ts
src/services/sync-metadata.ts
src/services/fk-dependency-discovery.ts
src/services/unified-schema-sync.ts
src/services/excel-pipeline-loader.ts
```

**Tests (Claude Code - stdio):**
- [ ] Read `src/console/CLAUDE.md` - content is correct
- [ ] Run `npm run sync -- status` - CLI still works

**Tests (claude.ai - HTTP):**
- [ ] Ask Claude to modify cascade-sync.ts - should apply console section rules

**Success Criteria:**
- CLAUDE.md defines console as the orchestration layer
- CLI operations continue to work

---

### Stage 7: Update Root CLAUDE.md with Section Routing
**Goal:** Add section routing table to main CLAUDE.md
**Estimated effort:** Simple

**Tasks:**
- [ ] Update `CLAUDE.md` (project root) to add:
  - Section routing table (which files → which section)
  - Access control rules (READ-ONLY cross-section)
  - Human cognition parallel explanation
  - Instructions to check section CLAUDE.md when working on files

**Content to Add:**
```markdown
## 5-Section Architecture

When working on this codebase, check the appropriate section CLAUDE.md:

| If working on... | Check section... |
|------------------|------------------|
| nexsus-search.ts, aggregation, filters | src/exact/CLAUDE.md |
| search-tool.ts, semantic search | src/semantic/CLAUDE.md |
| vector-client, types, constants, schema | src/common/CLAUDE.md |
| sync commands, pipeline, cascade | src/console/CLAUDE.md |
| accounting rules, Odoo knowledge | src/knowledge/CLAUDE.md |

### Access Control
- WRITE: Only to current section + common/
- READ-ONLY: All other sections
- If you find a bug in another section: NOTE IT, don't fix it directly
```

**Tests (Claude Code - stdio):**
- [ ] Read `CLAUDE.md` - section routing table present
- [ ] Run `npm run build` - build still passes

**Tests (claude.ai - HTTP):**
- [ ] Start new conversation, ask to modify nexsus-search.ts
- [ ] Verify Claude references exact section rules

**Success Criteria:**
- Root CLAUDE.md routes Claude to correct section
- Build still passes
- Claude Code follows section boundaries

---

## Dependencies
- None - this approach doesn't change any code files

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Claude ignores section CLAUDE.md | Add explicit "CHECK SECTION RULES" reminder in root CLAUDE.md |
| Section boundaries unclear | Include concrete examples in each CLAUDE.md |
| Files listed in wrong section | Review during implementation, adjust as needed |

## Notes

### Human Cognition Parallel
This architecture mirrors how humans think:
1. **Exact** → What do I know for certain? (facts, records)
2. **Semantic** → What similar experiences do I have? (patterns, associations)
3. **Knowledge** → What subject expertise applies? (rules, frameworks)
4. **Common** → What are my values/principles? (applies to everything)
5. **Console** → Synthesize all above into coherent response

### Restaurant Example
When asked "Do you know a good restaurant in Penrith?":
1. **Exact**: List of restaurants in Penrith (Google, records)
2. **Semantic**: Quality ratings, parking, previous experiences
3. **Knowledge**: Food safety, cuisine types, area knowledge
4. **Common**: User values (vegetarian options if user is vegetarian)
5. **Console**: Blend all above → "Try Luca's - great pasta, good parking, veggie options"

### Future: File Migration
If context-only approach proves insufficient, a full migration plan exists to actually move files to their section directories. This is optional and can be done gradually.

### File Ownership Summary

| Section | File Count | Key Files |
|---------|------------|-----------|
| common/ | ~20 | types.ts, constants.ts, vector-client.ts, odoo-client.ts |
| semantic/ | ~3 | search-tool.ts, analytics-service.ts |
| exact/ | ~8 | nexsus-search.ts, data-tool.ts, aggregation-engine.ts |
| knowledge/ | 0 | (future: accounting rules, Odoo knowledge) |
| console/ | ~12 | sync/*, pipeline-data-sync.ts, cascade-sync.ts |

### Prompt Evaluation Journey
This plan was developed using the 4D Framework (30-point rubric):

| Round | Score | Key Addition |
|-------|-------|--------------|
| Initial | 14/30 | 5-section concept with human cognition parallel |
| Round 1 | 16/30 | Conditional routing (query-type based) |
| Round 2 | 18/30 | LLM-based intent classification |
| Round 3 | 19/30 | Clarified purpose: development organization |
| Round 4 | 22/30 | Directory structure with per-section CLAUDE.md |
| Round 5 | 25/30 | Access control: READ-ONLY cross-section |
| Round 6 | 28/30 | CLAUDE.md content: objectives, manifests, contracts |
| Round 7 | 30/30 | Complete file-to-section mapping |
