# Nexsus Interconnectivity Improvement Plan

## Overview

This plan addressed **15 connection gaps** identified in the Nexsus system audit. The goal was to achieve 100% interconnectivity between all components following the philosophy: **"Understand and save, NOT save and understand"**.

**Components Audited:**
- Odoo (data source) → Schema → Pipeline → Vector Database → Knowledge Graph → Search Tools → Claude.ai

**Key Finding:** The system was well-architected but had gaps in validation and feedback loops, not core functionality.

---

## Implementation Status

| Stage | Status | Commit | Date |
|-------|--------|--------|------|
| Stage 1: Foundation Integrity | **COMPLETE** | `afee27e` | 2025-12-30 |
| Stage 2: FK Integrity Loop | **COMPLETE** | `c4a37fb` | 2025-12-30 |
| Stage 3: UUID and Graph Consistency | **COMPLETE** | `603c3cf` | 2025-12-30 |
| Stage 4: Data Integrity & Provenance | **COMPLETE** | `8bb1b5b` | 2025-12-30 |
| Stage 5: Optimization & Cleanup | **COMPLETE** | `d9b18df` | 2025-12-30 |

**All 5 stages completed on 2025-12-30.**

---

## Stages

### Stage 1: Foundation Integrity
**Goal:** Ensure schema is always available before data operations (Fixes: G1, G11)
**Status:** COMPLETE

**Tasks:**
- [x] Add `isSchemaEmpty()` check at start of `syncPipelineData()` in `src/services/pipeline-data-sync.ts`
- [x] Add `schemaExistsForModel()` check before cascade targets in `src/services/cascade-sync.ts`
- [x] Improve error messages to include "run `npm run sync -- sync schema` first"

**Implementation Notes:**
- Added `isQdrantSchemaEmpty()` check in pipeline-data-sync.ts (Line ~290)
- Added schema validation warning in cascade-sync.ts for FK targets
- Error messages now include exact command: `npm run sync -- sync schema`

---

### Stage 2: FK Integrity Loop
**Goal:** Close the loop between validation and sync - orphans trigger auto-sync (Fixes: G8, G9)
**Status:** COMPLETE

**Tasks:**
- [x] Add `--auto-sync` flag to `validate-fk` command
- [x] Create `syncMissingFkTargets()` function in `src/services/cascade-sync.ts`
- [x] Add CLI progress bars for auto-sync operation
- [x] Limit `cascade_sources` array to 100 entries

**Implementation Notes:**
- Added `fix-orphans` CLI command for syncing missing FK targets
- `validate-fk --auto-sync` triggers automatic sync of missing records
- `cascade_sources` bounded with `MAX_CASCADE_SOURCES = 100`
- Progress bars via `ora` spinner during sync operations

---

### Stage 3: UUID and Graph Consistency
**Goal:** Standardize on V2 UUIDs and strengthen graph integration (Fixes: G10, G5, G14)
**Status:** COMPLETE

**Tasks:**
- [x] Create `parseV2DataUuid()` utility with proper error handling in `src/utils/uuid-v2.ts`
- [x] Replace fragile regex in validate-fk with new utility
- [x] Add deprecation warning to legacy `generateRelationshipId()`
- [x] Add optional KG validation warning to Nexsus Link

**Implementation Notes:**
- `parseV2DataUuid()` returns `{ namespace, model_id, record_id }` or null
- Nexsus Link logs orphan FK warnings (doesn't fail request)
- All graph UUIDs now use V2 format: `00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF`

---

### Stage 4: Data Integrity & Provenance
**Goal:** Ensure data integrity through validation and surface data provenance (Fixes: G3, G2, G6)
**Status:** COMPLETE

**Restructuring Note:** Original Stage 4 was restructured during implementation:
- Moved G4, G7 to Stage 5 (optimization, not core integrity)
- Removed G12 (already handled by `searchReadWithRetry()`)
- Added G2 (deferred from Stage 3)

**Tasks:**
- [x] Add field_id collision detection in `src/services/unified-schema-sync.ts`
- [x] Add optional model_id validation against Odoo (VALIDATE_ODOO_MODELS=true)
- [x] Add sync_timestamp with freshness label to search results

**Implementation Notes:**
- Field_id collision check runs during schema sync (Phase 2.5)
- Model_id validation optional via env var (Phase 2.6)
- Search results show: "Last synced: 12/30/2024 (today)"
- Freshness labels: today, yesterday, X days ago, X weeks ago

---

### Stage 5: Optimization & Cleanup
**Goal:** Optimize search ranking using Knowledge Graph metadata and clean up technical debt (Fixes: G4, G7, G13, G15)
**Status:** COMPLETE

**Tasks:**
- [x] Add `cardinality_class` weighting to graph boost (G4)
- [x] Add hub model boost for high-connectivity entities (G7)
- [x] Auto-invalidate cache on schema sync (G13)
- [x] Add `getPayloadType()` utility function (G15)

**Implementation Notes:**
- Cardinality weights: one_to_one (1.5x), one_to_few (1.0x), one_to_many (0.5x)
- Hub boost: 1.3x for models with >10 incoming+outgoing relationships
- `clearSchemaCache()` called automatically after `syncSchemaToUnified()`
- `getPayloadType(payload)` returns 'data' | 'schema' | 'graph' | 'unknown'

---

## Gap Reference (Final Status)

| Gap ID | Description | Stage | Status |
|--------|-------------|-------|--------|
| G1 | Schema check before data sync | 1 | **COMPLETE** |
| G2 | model_id validation against Odoo | 4 | **COMPLETE** (optional) |
| G3 | field_id collision detection | 4 | **COMPLETE** |
| G4 | KG cardinality in graph_boost | 5 | **COMPLETE** |
| G5 | Nexsus Link uses KG validation | 3 | **COMPLETE** |
| G6 | Surface provenance in search | 4 | **COMPLETE** |
| G7 | Hub model ranking boost | 5 | **COMPLETE** |
| G8 | Orphans trigger auto-sync | 2 | **COMPLETE** |
| G9 | Bound cascade_sources array | 2 | **COMPLETE** |
| G10 | Robust UUID parsing | 3 | **COMPLETE** |
| G11 | Cascade validates FK schema | 1 | **COMPLETE** |
| G12 | API-restricted fields handling | - | **PRE-EXISTING** |
| G13 | Auto cache invalidation | 5 | **COMPLETE** |
| G14 | V2 Graph UUID only | 3 | **COMPLETE** |
| G15 | Simplify type guards | 5 | **COMPLETE** |

**Note:** G12 was already handled by `searchReadWithRetry()` before this audit.

---

## Files Modified

### Stage 1
- `src/services/pipeline-data-sync.ts` - Schema empty check
- `src/services/cascade-sync.ts` - FK target schema validation

### Stage 2
- `src/sync/commands/validate-fk.ts` - Auto-sync flag
- `src/services/cascade-sync.ts` - syncMissingFkTargets()
- `src/sync/commands/fix-orphans.ts` - New CLI command
- `src/services/knowledge-graph.ts` - Bound cascade_sources

### Stage 3
- `src/utils/uuid-v2.ts` - parseV2DataUuid()
- `src/sync/commands/validate-fk.ts` - Use new parser
- `src/services/nexsus-link.ts` - Orphan FK warnings

### Stage 4
- `src/services/unified-schema-sync.ts` - Collision + Odoo validation
- `src/tools/search-tool.ts` - sync_timestamp display

### Stage 5
- `src/services/graph-search-engine.ts` - Cardinality + hub boost
- `src/sync/commands/sync-schema.ts` - Auto cache clear
- `src/services/unified-schema-sync.ts` - Auto cache clear
- `src/types.ts` - getPayloadType() utility

---

## Connection Chain (Final State)

```
Odoo → Schema → Pipeline → Vector Database → Knowledge Graph → Search Tools → Claude.ai
       ↑          ↑             ↑                  ↑                ↑
     Stage 1   Stage 1,2     Stage 4            Stage 2,3          Stage 4,5
   (validation) (validation)  (integrity)       (auto-sync)      (provenance,
                + Stage 5                        (UUID)           ranking)
              (auto-cache)
```

All connection points are now validated, self-maintaining, and optimized.

---

## Future Maintenance Notes

### Running the Sync Pipeline
```bash
# 1. Always sync schema first (one-time or after Excel changes)
npm run sync -- sync schema

# 2. Sync data models
npm run sync -- sync model crm.lead
npm run sync -- sync model account.move.line --date-from 2024-01-01

# 3. Validate FK integrity periodically
npm run sync -- validate-fk

# 4. Fix orphans if needed
npm run sync -- fix-orphans crm.lead
```

### Key Environment Variables
```bash
# Optional: Validate Excel model_ids against Odoo during schema sync
VALIDATE_ODOO_MODELS=true
```

### Cache Behavior
- Schema cache auto-clears after `npm run sync -- sync schema`
- Graph context cache has 5-minute TTL
- No manual cache clearing needed in normal operation

### Graph Boost Tuning
Default weights in `src/services/graph-search-engine.ts`:
```typescript
cardinalityWeights: {
  one_to_one: 1.5,   // Specific refs boosted
  one_to_few: 1.0,   // Neutral
  one_to_many: 0.5,  // Generic refs reduced
}
hubBoostMultiplier: 1.3,   // Hub models get 30% boost
hubDegreeThreshold: 10,    // Min connections to qualify as hub
```

### Known Hub Models
These models typically qualify for hub boost (>10 connections):
- `res.partner` - Central contact entity
- `account.move` - Journal entries
- `res.users` - System users
- `res.company` - Company records

---

## Audit Context

- **Audit Date:** 2025-12-30
- **Implementation Completed:** 2025-12-30
- **Auditor Role:** Full-Stack Technical Auditor
- **Philosophy:** "Understand and save, NOT save and understand"
- **Methodology:** Reverse engineering to find lost, conflicting, or duplicate connections

---

## Key Architectural Insights

1. **V2 UUID System** - Deterministic IDs enable direct lookups: `00000002-MMMM-0000-0000-RRRRRRRRRRRR`
2. **Knowledge Graph** - Stores FK relationships as graph points (00000001-*)
3. **Unified Collection** - All point types (schema, data, graph) in single Qdrant collection
4. **Schema-First Design** - Pipeline queries Qdrant schema to understand Odoo structure
5. **Self-Maintaining** - Caches auto-clear, validations auto-run, orphans auto-detected

---

## Business Analogies (for Power BI/DAX users)

- **Schema** = Chart of Accounts (defines where data lives)
- **Pipeline** = ETL process (Extract-Transform-Load)
- **UUID** = Unique invoice number (decode customer + transaction from ID)
- **Knowledge Graph** = Relationships view in Power BI (which tables connect)
- **Nexsus Link** = RELATED() function (resolve FK to display name)
- **Graph Boost** = Popularity ranking (well-connected records rank higher)
- **Cardinality Class** = Relationship type (1:1, 1:N, M:N)
