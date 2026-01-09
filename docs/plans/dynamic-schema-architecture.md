# Dynamic Schema Architecture for Nexsus1 MCP Server

## Overview
Transform Nexsus1 into a fully dynamic, schema-driven MCP server suitable for commercialization. Users can add new models/fields to Excel schema and immediately use them via MCP tools without server restart.

---

## Status Summary

| Stage | Status | Commits |
|-------|--------|---------|
| Stage 1 | ✅ COMPLETED | `0e9d91f`, `ae9e5f3`, `e8d0dc3`, `b25f21a`, `7c722a0` |
| Stage 2 | ✅ COMPLETED | `816a520` |
| Stage 3 | ✅ COMPLETED | (pending commit) |
| Stage 4 | 🔲 NOT STARTED | - |
| Stage 5 | 🔲 NOT STARTED | - |
| Stage 6 | 🔲 NOT STARTED | - |
| Stage 7 | 🔲 NOT STARTED | - |

---

## Lessons Learned from Stage 1

### Critical Discoveries

1. **More bugs than expected**: Stage 1 uncovered 5 bugs, not just 1:
   - Bug 1: `clearSchemaLookup()` not called in sync-schema
   - Bug 2: Wrong default schema file path (was `nexsus_schema_v2_generated.xlsx`)
   - Bug 3: Wrong default payload config path (was `feilds_to_add_payload.xlsx`)
   - Bug 4: Railway server requires restart after code changes
   - Bug 5: Excel files not committed to git (budget model missing)

2. **Cache architecture is more complex than documented**: Found 10+ cache locations, not 6:
   | Cache | File | Clear Function |
   |-------|------|----------------|
   | `schemaCache` | `excel-schema-loader.ts` | `clearNexsusSchemaCache()` |
   | `schemaLookup`, `validModels`, `modelIdToName` | `schema-lookup.ts` | `clearSchemaLookup()` |
   | `payloadConfigCache`, `pipelineSchemaCache`, `modelIdCache` | `excel-pipeline-loader.ts` | `clearPipelineCache()` |
   | `schemaCache`, `payloadConfigCache` | `schema-query-service.ts` | `clearSchemaCache()` |
   | `cache` | `sample-payload-loader.ts` | `clearSamplePayloadCache()` |
   | `syncedModelsCache` | `model-registry.ts` | `clearSyncedModelsCache()` |
   | `graphContextCache` | `knowledge-graph.ts` | `clearGraphCache()` |
   | `searchCache` | `cache-service.ts` | `clearCache()` |
   | `coordinateLookupCache` | `data-transformer.ts` | `clearCoordinateLookup()` |
   | `schemaCache` | `schema-loader.ts` | `clearSchemaCache()` (Odoo version) |

3. **Railway deployment workflow**: Code push → auto-deploy, but caches persist in memory. Need server restart or empty commit to trigger redeploy.

4. **Git workflow gap**: Excel files in `samples/` are easily forgotten. Created pre-push hook to warn.

5. **Actual effort was 6+ hours**, not 1-2 hours estimated. Root cause analysis and debugging took most time.

---

## Stages (Updated)

### Stage 1: Fix Schema Cache Bug ✅ COMPLETED
**Goal:** Fix immediate bug - `sync schema` must clear ALL caches
**Actual effort:** 6+ hours (debugging, 5 bugs, testing)

**Completed Tasks:**
- [x] Add import for `clearSchemaLookup` in `src/console/sync/commands/sync-schema.ts`
- [x] Add `clearSchemaLookup()` call at line 110 after `clearSchemaCache()`
- [x] Add `refreshSchemaLookup()` function to `src/common/services/schema-lookup.ts`
- [x] Fix default schema file path in `constants.ts` line 60
- [x] Fix default payload config path in `constants.ts` line 295
- [x] Push Excel files with budget model to git
- [x] Create pre-push hook to warn about uncommitted Excel files

**Files Modified:**
- `src/console/sync/commands/sync-schema.ts` (lines 14, 110)
- `src/common/services/schema-lookup.ts` (lines 322-355)
- `src/common/constants.ts` (lines 60, 295)
- `.git/hooks/pre-push` (new file, not committed)

**Commits:**
- `0e9d91f` - fix: Clear all schema caches in sync-schema command
- `ae9e5f3` - fix: Update default schema file path to samples/Nexsus1_schema.xlsx
- `e8d0dc3` - fix: Update default payload config path to samples/SAMPLE_payload_config.xlsx
- `b25f21a` - chore: trigger redeploy for cache refresh
- `7c722a0` - data: Add budget model to schema and sync Excel data files

**Test Results (Claude.ai):**
- [x] Budget model query works: 706 records, $68.6M total
- [x] Schema validation with "Did you mean" suggestions works
- [x] All 3 data models queryable: master (560), actual (12,313), budget (2,987)

---

### Stage 2: Central Cache Manager ✅ COMPLETED
**Goal:** Create centralized cache coordination service that clears ALL 10+ caches
**Actual effort:** ~1 hour

**Why this is needed:**
- Stage 1 showed caches are scattered across 10+ files
- Easy to miss one when adding new code
- Need single source of truth for "clear all caches"

**Completed Tasks:**
- [x] Create `src/common/services/schema-cache-manager.ts`
- [x] Import ALL cache clear functions (10 total):
  ```typescript
  import { clearNexsusSchemaCache } from './excel-schema-loader.js';
  import { clearSchemaLookup, refreshSchemaLookup } from './schema-lookup.js';
  import { clearPipelineCache } from './excel-pipeline-loader.js';
  import { clearSchemaCache } from './schema-query-service.js';
  import { clearSamplePayloadCache } from './sample-payload-loader.js';
  import { clearSyncedModelsCache } from './model-registry.js';
  import { clearGraphCache } from './knowledge-graph.js';
  import { clearCache } from './cache-service.js';
  import { clearCoordinateLookup } from './data-transformer.js';
  import { clearSyncMetadata } from './sync-metadata.js';
  ```
- [x] Implement `refreshAllCaches()` that calls all clear functions
- [x] Implement `getCacheStatus()` returning all cache stats
- [x] Add change detection (compare models before/after refresh)
- [x] Update `sync-schema.ts` to use `refreshAllCaches()` instead of individual calls
- [x] Export `RefreshResult` and `CacheStatus` types
- [x] Also added `clearAllCaches()` for cases where reload not needed

**Files Created:**
- `src/common/services/schema-cache-manager.ts`

**Files Modified:**
- `src/console/sync/commands/sync-schema.ts` (replaced individual clears with `refreshAllCaches()`)

**Test Results:**
- [x] `npm run build` passes
- [x] `refreshAllCaches()` clears all 10 caches (verified via logging)
- [x] Model change detection works: `Models: 4 → 4`
- [x] Performance: refresh in 10-19ms (well under 5s target)

**Output Example:**
```
[CacheManager] Starting full cache refresh...
[Cache] CLEARED - 0 entries removed
[GraphContext] Cache cleared
[NEXUS Decode] Coordinate lookup cache cleared
[ModelRegistry] Synced models cache cleared
[SamplePayloadLoader] Cache cleared
[SchemaQuery] Cache cleared
[PipelineLoader] All caches cleared
[NexsusLoader] Schema cache cleared
[SchemaLookup] Refreshed: 4 models, 58 fields, 2 FK fields
[CacheManager] Refresh complete in 10ms
[CacheManager] Cleared 10 caches
[CacheManager] Models: 4 → 4
All 10 schema caches cleared in 10ms
```

**Success Criteria Met:**
- [x] Single function clears ALL schema-related caches
- [x] No cache can be "forgotten" when new code is added
- [x] Change detection reports models added/removed

---

### Stage 3: refresh_schema MCP Tool ✅ COMPLETED
**Goal:** Create new MCP tool for on-demand schema refresh via Claude
**Actual effort:** ~30 minutes

**Why this is needed:**
- Users on Railway can't run CLI commands
- Need way to refresh schema after Excel changes without server restart
- Now tool #15 in the MCP server

**Completed Tasks:**
- [x] Create `src/common/tools/refresh-schema-tool.ts`
- [x] Implement Zod schema for tool parameters:
  ```typescript
  export const RefreshSchemaSchema = z.object({
    include_status: z.boolean().default(false)
      .describe('Include detailed cache status from all services'),
  });
  ```
- [x] Implement tool handler calling `refreshAllCaches()`
- [x] Format response with:
  - `duration_ms`: Time taken
  - `models_before` / `models_after`: Model counts
  - `models_added` / `models_removed`: Changed models
  - `fields_loaded`, `fk_fields_loaded`: Field counts
  - `caches_cleared`: List of cleared caches
- [x] Register tool in `src/console/index.ts`
- [x] Error handling with helpful troubleshooting tips

**Files Created:**
- `src/common/tools/refresh-schema-tool.ts`

**Files Modified:**
- `src/console/index.ts` (added import and registration)

**Test Results (Local):**
- [x] `npm run build` passes
- [ ] Call `refresh_schema {}` - (test on Railway after deploy)

**Success Criteria:
- Tool appears in MCP tool list
- Returns accurate stats
- Performance: < 5 seconds
- Works from Claude.ai without server restart

---

### Stage 4: Auto-Generated Field Knowledge (Level 4)
**Goal:** Auto-generate field knowledge from schema structure
**Estimated effort:** Medium (3-4 hours)

**DEFERRED** - This stage depends on the Extended Knowledge System being fully functional. Consider implementing after Stage 3 is tested.

**Tasks (unchanged from original):**
- [ ] Create `src/knowledge/dynamic/auto-generators/field-knowledge-generator.ts`
- [ ] Implement type-to-format mapping
- [ ] Implement type-to-valid-values mapping
- [ ] Implement FK-to-LLM-notes generation

---

### Stage 5: Auto-Generated Model Knowledge (Level 3)
**Goal:** Auto-generate model metadata from schema structure
**Estimated effort:** Medium (2-3 hours)

**DEFERRED** - Depends on Stage 4.

---

### Stage 6: Integrate Knowledge Generation into Refresh
**Goal:** Auto-generate knowledge during refresh_schema
**Estimated effort:** Simple (1-2 hours)

**DEFERRED** - Depends on Stages 4-5.

---

### Stage 7: Dynamic Validation for All Tools
**Goal:** Ensure all 14 tools validate models dynamically
**Estimated effort:** Medium (3-4 hours)

**Current Status:** Partially working. Tests showed:
- `nexsus_search` already has dynamic validation with `isValidModel()`
- `findSimilarModels()` already provides "Did you mean" suggestions
- Need to audit other tools

**Revised Tasks:**
- [ ] Audit all 14 tools for hardcoded model checks:
  - [ ] `semantic_search` - check model_filter validation
  - [ ] `nexsus_search` - ✅ already dynamic
  - [ ] `find_similar` - check model_name validation
  - [ ] `graph_traverse` - check model validation
  - [ ] `inspect_record` - check model validation
  - [ ] `pipeline_preview` - check model validation
  - [ ] `build_odoo_url` - check model_name validation
  - [ ] `system_status` - N/A (no model input)
  - [ ] `dlq_status` - N/A
  - [ ] `dlq_clear` - check model_name validation
  - [ ] `update_model_payload` - check model_name validation
  - [ ] `blendthink_diagnose` - N/A
  - [ ] `blendthink_execute` - N/A (routes to other tools)
  - [ ] `inspect_graph_edge` - check model validation
- [ ] Replace any hardcoded checks with `isValidModel()`
- [ ] Ensure helpful "Did you mean" errors for typos

**Files to Audit:**
- `src/semantic/tools/search-tool.ts`
- `src/common/tools/graph-tool.ts`
- `src/common/tools/pipeline-tool.ts`
- `src/exact/tools/data-tool.ts`

---

## Recommended Next Steps

1. **Stage 2** (Central Cache Manager) - Highest priority
   - Consolidates all cache clearing into single function
   - Prevents future "forgot to clear cache X" bugs
   - Foundation for Stage 3

2. **Stage 3** (refresh_schema Tool) - High priority
   - Enables zero-restart schema updates from Claude.ai
   - Essential for commercialization

3. **Stage 7** (Dynamic Validation) - Medium priority
   - Audit and fix if needed
   - May already be working based on Stage 1 tests

4. **Stages 4-6** (Knowledge Generation) - Lower priority
   - Nice to have, not blocking
   - Defer until Extended Knowledge System is stable

---

## Dependencies
- Qdrant vector database running
- VOYAGE_API_KEY configured
- `Nexsus1_schema.xlsx` exists in samples/
- `npm run build` passes before starting

## Risks & Mitigations (Updated)
| Risk | Mitigation |
|------|------------|
| Missing a cache location | Stage 2 centralizes all caches in one file |
| Excel files not pushed | Pre-push hook warns about uncommitted files |
| Breaking existing queries | All changes are additive |
| Railway cache persistence | refresh_schema tool clears in-memory caches |
| Performance regression | refresh_schema has 5s timeout |

## Rollback Plan
| Stage | Rollback Action |
|-------|-----------------|
| Stage 1 | ✅ COMPLETED - No rollback needed |
| Stage 2 | Delete schema-cache-manager.ts, revert sync-schema.ts |
| Stage 3 | Remove tool registration, delete refresh-schema-tool.ts |
| Stage 4-6 | Delete auto-generator files |
| Stage 7 | Revert validation changes in tool files |

---

## Notes
- Each stage is independently deployable
- Stage 1 alone fixed the immediate budget model issue
- Stages 2-3 provide user-facing refresh capability (recommended next)
- Stages 4-6 add auto-knowledge (optional, defer)
- Stage 7 may already be partially working
- **Total remaining effort: ~12-15 hours** (Stages 2-7)
