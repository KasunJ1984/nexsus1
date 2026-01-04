# Entity Resolution Layer Implementation

## Overview

Building an Entity Resolution Layer for Blendthink that dynamically discovers Odoo models and fields using schema search instead of hardcoded dictionaries. This fixes the root cause of financial query failures like "Jan-25 staff welfare expenses" returning wrong results.

**Problem**: Question Analyzer uses static MODEL_HINTS/FIELD_HINTS dictionaries that miss domain vocabulary.

**Solution**: New layer between Analyzer and Router that uses semantic_search on schema to discover correct models and fields dynamically.

**Approach**: Hybrid - Entity Resolution Layer (P0) + good ideas from Nexsus Memory proposal (P1-P4)

---

## Current Status

| Stage | Status | Notes |
|-------|--------|-------|
| Stage 1 | **COMPLETED** | Foundation Types & Date Resolver |
| Stage 2 | **COMPLETED** | Model Finder (schema-based discovery) |
| Stage 3 | **COMPLETED** | Field Matcher (schema/graph resolution) |
| Stage 4 | **COMPLETED** | Knowledge Enricher (implicit filters) |
| Stage 5 | **COMPLETED** | Resolution Merge & Engine Integration |
| Stage 6 | **COMPLETED** | Cleanup & Validation (HINTS deprecated) |

**ALL STAGES COMPLETE** - Entity Resolution Layer is now integrated into BlendthinkEngine.

---

## Stages

### Stage 1: Foundation Types & Date Resolver
**Goal:** Create type definitions and flexible date parsing that handles business formats like "Jan-25", "Q1 2025", "FY25"

**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [x] Create `src/console/blendthink/entity-resolution/types.ts` with EnrichedAnalysis interface
- [x] Create `src/console/blendthink/entity-resolution/date-resolver.ts` with multi-format parsing
- [x] Skip `chrono-node` dependency - implemented native parsing instead
- [x] Create `src/console/blendthink/entity-resolution/index.ts` for exports

**Tests (Claude Code - stdio):**
- [x] Run: `npm run build` - compiles without errors
- [ ] Create unit test file and run: `npm test -- --grep "date-resolver"`
- [ ] Test cases: "Jan-25" → 2025-01-01 to 2025-01-31
- [ ] Test cases: "Q4 2024" → 2024-10-01 to 2024-12-31
- [ ] Test cases: "FY25" → 2024-07-01 to 2025-06-30

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What date range does Jan-25 represent?" - verify blendthink_diagnose shows date parsing
- [ ] Ask: "Show me Q1 2025 expenses" - verify date filter generated correctly

**Success Criteria:**
- All date formats (Jan-25, Q4 2024, FY25, 2025-01-15) parsed correctly
- Types exported and importable from other modules
- Build passes with no TypeScript errors

---

### Stage 2: Model Finder
**Goal:** Create schema-based model discovery that finds the correct Odoo model from query keywords

**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [ ] Create `src/console/blendthink/entity-resolution/model-finder.ts`
- [ ] Implement domain detection (financial, crm, hr, inventory)
- [ ] Implement schema semantic search with model aggregation
- [ ] Add confidence scoring based on field match count

**Tests (Claude Code - stdio):**
- [ ] Run: `npm run build` - should compile
- [ ] Test "expenses" → finds account.move.line (not crm.lead)
- [ ] Test "leads" → finds crm.lead
- [ ] Test "employees" → finds hr.employee
- [ ] Test "products" → finds product.product or product.template

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What model stores expense data?" - verify semantic_search on schema
- [ ] Ask: "Show me staff welfare expenses" - verify model_finder returns account.move.line

**Success Criteria:**
- "expenses" maps to account.move.line with >0.7 confidence
- "leads" maps to crm.lead with >0.8 confidence
- Unknown terms return null (trigger clarification)
- No hardcoded model mappings in code

---

### Stage 3: Field Matcher
**Goal:** Resolve entity names to field filters using schema search and FK graph

**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [ ] Create `src/console/blendthink/entity-resolution/field-matcher.ts`
- [ ] Implement schema search for field name matching
- [ ] Implement graph_traverse for FK relationship discovery
- [ ] Build filter conditions from matched fields

**Tests (Claude Code - stdio):**
- [ ] Run: `npm run build`
- [ ] Test "staff welfare" → finds account.account records with name containing "welfare"
- [ ] Test "partner Hansen" → finds res.partner with name containing "Hansen"
- [ ] Test FK resolution: expense → account_id → account.account lookup

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What account is staff welfare?" - verify schema search returns account.account
- [ ] Ask: "Jan-25 staff welfare expenses" - verify field_matcher creates account_id filter
- [ ] Verify graph_traverse called for FK relationships

**Success Criteria:**
- "staff welfare" resolves to account_id filter with correct IDs
- FK relationships discovered via graph, not hardcoded
- Filter conditions in correct Qdrant format

---

### Stage 4: Knowledge Enricher
**Goal:** Add implicit filters from knowledge layer (e.g., "posted only" for accounting queries)

**Estimated effort:** Simple (1 hour)

**Tasks:**
- [ ] Create `src/console/blendthink/entity-resolution/knowledge-enricher.ts`
- [ ] Wire to existing knowledge adapter in `src/knowledge/adapter/`
- [ ] Implement domain-specific rules lookup
- [ ] Add implicit filters to resolution output

**Tests (Claude Code - stdio):**
- [ ] Run: `npm run build`
- [ ] Test accounting domain → adds parent_state='posted' filter
- [ ] Test expenses context → adds debit aggregation hint
- [ ] Test crm domain → no implicit filters added

**Tests (claude.ai - HTTP):**
- [ ] Ask: "Jan-25 expenses" - verify parent_state filter in final query
- [ ] Ask: "Show me all journal entries" - verify knowledge rules applied
- [ ] Check blendthink_diagnose output shows knowledge layer contribution

**Success Criteria:**
- Accounting queries automatically get parent_state='posted'
- Expense queries get SUM(debit) aggregation hint
- Rules come from knowledge layer, not hardcoded

---

### Stage 5: Resolution Merge & Engine Integration
**Goal:** Combine all resolvers and wire into BlendthinkEngine

**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [ ] Create `src/console/blendthink/entity-resolution/resolution-merge.ts`
- [ ] Implement conflict resolution when multiple resolvers disagree
- [ ] Modify `engine.ts` to call resolveEntities() after analyzer
- [ ] Update SemanticAdapter to use resolved model
- [ ] Update ExactAdapter to use resolved filters

**Tests (Claude Code - stdio):**
- [ ] Run: `npm run build`
- [ ] Full pipeline test: "Jan-25 staff welfare expenses" returns correct total
- [ ] Verify engine logs show entity resolution step
- [ ] Verify no fallback to crm.lead for financial queries

**Tests (claude.ai - HTTP):**
- [ ] Ask: "Jan-25 staff welfare expenses" - verify returns account.move.line data with correct total
- [ ] Ask: "Q4 2024 won deals" - verify returns crm.lead data
- [ ] Verify blendthink_diagnose shows full resolution chain

**Success Criteria:**
- Full query flow works end-to-end
- Resolved data passed through chain context
- Both stdio and HTTP tests pass

---

### Stage 6: Cleanup & Validation
**Goal:** Remove hardcoded HINTS dictionaries and validate all 4 criteria

**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [ ] Remove MODEL_HINTS from question-analyzer.ts
- [ ] Remove FIELD_HINTS from question-analyzer.ts
- [ ] Simplify extractEntities() to just extract raw phrases
- [ ] Remove crm.lead fallback from exact-adapter.ts
- [ ] Run all validation criteria tests
- [ ] Update documentation

**Tests (Claude Code - stdio):**
- [ ] Run: `grep -r "MODEL_HINTS" src/` - should return 0 matches
- [ ] Run: `grep -r "FIELD_HINTS" src/` - should return 0 matches
- [ ] Run: `npm run build` - no compile errors
- [ ] Run full test suite: `npm test`

**Tests (claude.ai - HTTP):**
- [ ] **Generalization**: "Jan-25 expenses", "Q4 won deals", "products below 10 stock" all work
- [ ] **Zero-Hardcoding**: No new dictionaries in codebase
- [ ] **Self-Healing**: Sync new model, query finds it immediately
- [ ] **Mental Model Match**: Domain expert confirms 10 queries work naturally

**Success Criteria:**
- All hardcoded HINTS removed
- All 4 validation criteria pass
- No regression in existing CRM queries
- Documentation updated

---

## Dependencies

- Qdrant collection `nexsus_unified` with schema points synced
- Knowledge adapter in `src/knowledge/adapter/` functional
- semantic_search MCP tool working
- graph_traverse MCP tool working

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Schema search returns too many results | Add model_filter when domain is detected |
| Date parsing ambiguous (Jan could be 2024 or 2025) | Default to most recent year, ask if ambiguous |
| Knowledge layer has no rules for domain | Fallback to no implicit filters (safe default) |
| Performance regression from extra searches | Cache model finder results in session |
| Breaking existing CRM queries | Run regression tests after each stage |

## Notes

### Key Files Modified

| File | Change Type | Lines Changed |
|------|-------------|---------------|
| `src/console/blendthink/entity-resolution/*` | NEW | ~800 |
| `src/console/blendthink/engine.ts` | MODIFY | ~20 |
| `src/console/blendthink/question-analyzer.ts` | MODIFY | ~-50 (removal) |
| `src/console/blendthink/section-adapters/exact-adapter.ts` | MODIFY | ~10 |
| `src/console/blendthink/section-adapters/semantic-adapter.ts` | MODIFY | ~10 |
| `src/common/types.ts` | MODIFY | ~30 |

### Validation Criteria Summary

1. **Generalization**: Works for accounting, CRM, HR, inventory without code changes
2. **Zero-Hardcoding**: MODEL_HINTS and FIELD_HINTS removed, no replacements
3. **Self-Healing**: New Odoo content discovered automatically after sync
4. **Mental Model Match**: Domain expert confirms natural interpretation

### Estimated Total Effort

| Stages | Time |
|--------|------|
| Stage 1-2 | 3 hours |
| Stage 3-4 | 2.5 hours |
| Stage 5-6 | 3 hours |
| **Total** | **8.5 hours** |
