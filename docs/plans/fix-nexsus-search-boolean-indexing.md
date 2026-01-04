# Fix nexsus_search Boolean Field Indexing

## Status: COMPLETED (2025-12-31)

## Overview
The `nexsus_search` tool fails with "Bad Request" when filtering on boolean fields like `is_company` because Qdrant requires payload indexes for filtering. This plan adds missing indexes, improves error messages, and implements app-level fallback for unindexed boolean fields.

**Root Cause:** `is_company` (res.partner) is NOT in the `UNIFIED_INDEXES` array in `vector-client.ts`

## Stages

### Stage 1: Add Missing Indexes
**Goal:** Fix the immediate `is_company` filtering failure by adding the missing index
**Estimated effort:** Simple
**Status:** COMPLETED

**Tasks:**
- [x] Add `is_company`, `customer_rank`, `supplier_rank` to UNIFIED_INDEXES in `src/services/vector-client.ts` (after line 1464)
- [x] Run `npx tsx scripts/add-missing-indexes.ts` to apply indexes to Qdrant

**Tests (Claude Code - stdio):**
- [x] Run: `mcp__nexsus__nexsus_search` with `{"model_name": "res.partner", "filters": [{"field": "is_company", "op": "eq", "value": true}], "aggregations": [{"field": "id", "op": "count", "alias": "total"}]}`
- [x] Verify: Returns count of companies (no "Bad Request" error) - **763 companies returned**

**Tests (claude.ai - HTTP):**
- [x] Ask: "How many companies are in res.partner?"
- [x] Verify: nexsus_search executes successfully with is_company filter

**Success Criteria:**
- Boolean filter `is_company = true` returns results without error
- Index script reports new indexes added successfully

---

### Stage 2: Add Index Validation with Error Messages
**Goal:** Provide helpful error messages when users filter on unindexed fields
**Estimated effort:** Medium
**Status:** COMPLETED

**Tasks:**
- [x] Add `INDEXED_FIELDS` Set to `src/services/schema-lookup.ts`
- [x] Add `isFieldIndexed()` function to `src/services/schema-lookup.ts`
- [x] Add `validateIndexedFields()` function to `src/services/filter-builder.ts`
- [x] Integrate validation in `src/tools/nexsus-search.ts` before query execution

**Tests (Claude Code - stdio):**
- [x] Filter on an unindexed field (e.g., `{"field": "some_random_field", "op": "eq", "value": "test"}`)
- [x] Verify: Returns helpful error message with instructions to add index

**Tests (claude.ai - HTTP):**
- [x] Ask: "Find res.partner records where color_index = 5" (unindexed field)
- [x] Verify: Error message explains field is not indexed and how to fix

**Success Criteria:**
- Unindexed field filters return clear error with fix instructions
- Indexed field filters work normally (no regression)

---

### Stage 3: App-Level Boolean Fallback
**Goal:** Gracefully handle unindexed boolean fields by filtering in application layer
**Estimated effort:** Medium
**Status:** COMPLETED

**Tasks:**
- [x] Extend `AppLevelFilter` interface in `src/services/filter-builder.ts` to support boolean operations
- [x] Add `shouldUseAppLevelBooleanFilter()` function to detect unindexed booleans
- [x] Update `buildQdrantFilter()` to route unindexed booleans to app-level filters
- [x] Extend `passesAppFilters()` in `src/services/scroll-engine.ts` for boolean comparison
- [x] Update `passesAppFilters()` in `src/services/aggregation-engine.ts` for boolean comparison

**Tests (Claude Code - stdio):**
- [x] Remove `is_company` from INDEXED_FIELDS (temporarily) and test filter
- [x] Verify: Query still works via app-level filtering (with console warning)
- [x] Restore `is_company` to INDEXED_FIELDS

**Tests (claude.ai - HTTP):**
- [x] Test filtering on a boolean field that exists in payload but isn't indexed
- [x] Verify: Query returns results (slower but functional)

**Success Criteria:**
- Unindexed boolean fields filter correctly via app-level fallback
- Warning logged when using app-level filtering
- No regression for indexed fields

---

## Files to Modify

| File | Stage | Changes |
|------|-------|---------|
| `src/services/vector-client.ts` | 1 | Add 3 indexes to UNIFIED_INDEXES (lines 1464-1465) |
| `src/services/schema-lookup.ts` | 2 | Add INDEXED_FIELDS set and isFieldIndexed() |
| `src/services/filter-builder.ts` | 2, 3 | Add validateIndexedFields(), extend AppLevelFilter, add boolean detection |
| `src/tools/nexsus-search.ts` | 2 | Add pre-query index validation |
| `src/services/scroll-engine.ts` | 3 | Extend passesAppFilters() for boolean |
| `src/services/aggregation-engine.ts` | 3 | Extend passesAppFilters() for boolean |

---

## Dependencies
- Qdrant server must be running and accessible
- `scripts/add-missing-indexes.ts` must exist (already present)
- Schema lookup must be initialized for Phase 2-3 validation

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Adding too many indexes impacts Qdrant performance | Only add essential indexes; monitor collection stats |
| INDEXED_FIELDS gets out of sync with UNIFIED_INDEXES | Add comment in both files referencing each other |
| App-level filtering too slow for large datasets | Log warnings; recommend adding index for frequent filters |
| Breaking existing queries | Run all Stage 1 tests before proceeding |

## Notes

### Index Types Reference
- `keyword`: Exact string match (model_name, field_type, UUIDs)
- `integer`: Numeric IDs and counts (record_id, partner_id_id)
- `float`: Decimal values (debit, credit, balance)
- `bool`: Boolean flags (active, is_company, stored)

### Current UNIFIED_INDEXES Count
- Before: 38 indexes
- After Stage 1: 41 indexes (+3 for res.partner)

### Key Code Locations
- UNIFIED_INDEXES: `vector-client.ts:1427-1481`
- buildQdrantFilter: `filter-builder.ts:163-231`
- passesAppFilters (scroll): `scroll-engine.ts`
- passesAppFilters (aggregation): `aggregation-engine.ts`

---
---

# Fix Validation Status & Add Graph Edge Inspection (Stage 2 Verification)

## Overview
Address two partial/missing features identified during Stage 2 interconnectivity audit verification:
1. `include_validation_status` not showing `integrity_score` fields in nexsus_search output
2. MCP tools don't expose graph point inspection (can't see `cascade_sources`)

**Root Causes:**
- Validation returns nothing when Knowledge Graph has no relationships or errors are silently caught
- `inspect_record` tool explicitly excludes graph points (only 'data' and 'schema')

## Stages

### Stage 4: Add Diagnostic Field to validation_status
**Goal:** Provide feedback when validation_status can't compute results
**Estimated effort:** Simple
**Status:** COMPLETED

**Tasks:**
- [x] Add `diagnostic?: string` to `RecordValidationStatus` interface in `src/types.ts` (lines 1839-1848)
- [x] Modify `getRecordValidationStatus()` in `src/services/data-grid.ts` to return diagnostic when no relationships found
- [x] Modify catch block in `src/services/data-grid.ts` (lines 196-207) to return diagnostic instead of silent fail
- [x] Update markdown output in `src/tools/nexsus-search.ts` (lines 1029-1037) to display diagnostic

**Tests (Claude Code - stdio):**
- [x] Run: `mcp__nexsus__nexsus_search` with `{"model_name": "crm.lead", "filters": [{"field": "record_id", "op": "gt", "value": 0}], "limit": 3, "include_validation_status": true}`
- [x] Verify: Returns `validation_status` with either actual integrity scores OR diagnostic message

**Tests (claude.ai - HTTP):**
- [x] Ask: "Search crm.lead with validation status enabled"
- [x] Verify: Output shows validation section with integrity score or diagnostic note

**Success Criteria:**
- validation_status always appears when flag is true (with data OR diagnostic)
- No more silent failures

---

### Stage 5: Create inspect_graph_edge Tool
**Goal:** Allow inspection of knowledge graph edges including cascade_sources
**Estimated effort:** Medium
**Status:** COMPLETED

**Tasks:**
- [x] Add `getRelationshipByFields()` function to `src/services/knowledge-graph.ts`
- [x] Add `InspectGraphEdgeSchema` to `src/schemas/index.ts`
- [x] Create new file `src/tools/inspect-graph-edge.ts` with tool implementation
- [x] Register tool in `src/index.ts`

**Tests (Claude Code - stdio):**
- [x] Run: `mcp__nexsus__inspect_graph_edge` with `{"source_model": "crm.lead", "target_model": "res.partner", "field_name": "partner_id"}`
- [x] Verify: Returns full edge payload including cascade_sources array - **3,100 edges, 350 unique targets**

**Tests (claude.ai - HTTP):**
- [x] Ask: "Inspect the graph edge from crm.lead to res.partner via partner_id"
- [x] Verify: Shows edge statistics, cascade sources (up to 100), and validation info

**Success Criteria:**
- New tool appears in MCP tool list
- cascade_sources array visible (confirms Stage 2 100-entry limit working)
- Full edge payload accessible (all 15+ fields verified)

---

## Files to Modify (Stages 4-5)

| File | Stage | Changes |
|------|-------|---------|
| `src/types.ts` | 4 | Add `diagnostic?: string` to RecordValidationStatus |
| `src/services/data-grid.ts` | 4 | Add diagnostic returns in validation logic |
| `src/tools/nexsus-search.ts` | 4 | Display diagnostic in markdown output |
| `src/services/knowledge-graph.ts` | 5 | Add `getRelationshipByFields()` function |
| `src/schemas/index.ts` | 5 | Add InspectGraphEdgeSchema |
| `src/tools/inspect-graph-edge.ts` | 5 | **NEW FILE** - Tool implementation |
| `src/index.ts` | 5 | Register inspect_graph_edge tool |

---

## Dependencies (Stages 4-5)
- Knowledge Graph must have graph points (1,714 exist per Stage 2 verification)
- Models must be synced with cascade FK for validation to find relationships

## Risks & Mitigations (Stages 4-5)

| Risk | Mitigation |
|------|------------|
| Diagnostic message too verbose | Keep message concise with actionable fix |
| New tool increases MCP surface area | Tool is read-only, minimal risk |
| getRelationshipByFields slow for large graphs | Uses indexed filter on point_type + source_model + field_name |

## Notes (Stages 4-5)

### Graph Edge UUID Format (V2)
```
00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF
│        │    │    │    │
└─Graph  └─src└─tgt└─type└─field_id
  ns      model model code
```

### cascade_sources Behavior
- FIFO queue, max 100 entries (Stage 2 limit)
- Tracks which models triggered discovery of this relationship
- Oldest entries dropped when limit exceeded

### Key Code Locations (Stages 4-5)
- RecordValidationStatus: `types.ts:1839-1848`
- getRecordValidationStatus: `data-grid.ts:305-354`
- Error catch block: `data-grid.ts:196-207`
- MAX_CASCADE_SOURCES: `knowledge-graph.ts:43` (value: 100)
- RelationshipPayload: `types.ts:1340-1399`
