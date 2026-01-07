# Dynamic 4-Level Knowledge Template for Nexsus1

## Overview

Create a **fully dynamic, LLM-agnostic knowledge system** embedded in the schema Excel file. This enables ANY LLM (Claude, OpenAI, Gemini, etc.) to operate Nexsus effectively **without prior training or conversation history**.

**Key Principle**: The Excel file IS the configuration. The code reads it and acts on it.

### Knowledge Hierarchy

| Level | Scope | Storage Location |
|-------|-------|------------------|
| Level 1 | Universal (all Nexsus) | `src/knowledge/static/` (markdown) - NO CHANGE |
| Level 2 | MCP Instance | Excel: `Instance_Config` sheet - NEW |
| Level 3 | Table/Model | Excel: `Model_Metadata` sheet - NEW |
| Level 4 | Field/Column | Excel: 6 new columns in Schema sheet - NEW |

---

## Stages

### Stage 1: Schema Excel Extension (Types & Interfaces)
**Goal:** Define TypeScript types and Zod schemas for the new knowledge levels
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/knowledge/dynamic/schemas/instance-config-schema.ts` with Zod validation
- [ ] Create `src/knowledge/dynamic/schemas/model-metadata-schema.ts` with Zod validation
- [ ] Create `src/knowledge/dynamic/schemas/field-knowledge-schema.ts` extending SimpleSchemaRow
- [ ] Update `src/common/types.ts` with new interfaces:
  - `InstanceConfigRow`
  - `ModelMetadataRow`
  - `ExtendedSimpleSchemaRow`
  - `KnowledgeLevel` type
  - `ExtendedKnowledgePayload` interface

**Tests (Claude Code - stdio):**
- [ ] `npm run build` - TypeScript compiles without errors
- [ ] Create test file with sample data, validate with Zod schemas

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What types are defined for knowledge levels?" → Should list all new interfaces
- [ ] Ask: "Validate this instance config row..." → Should use Zod validation

**Success Criteria:**
- All TypeScript types compile
- Zod schemas validate sample data correctly
- Types are exported and accessible from `src/common/types.ts`

---

### Stage 2: Excel Loader Functions
**Goal:** Load Instance_Config, Model_Metadata, and extended Field Knowledge from Excel
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/knowledge/dynamic/loaders/excel-knowledge-loader.ts`:
  - `loadInstanceConfig(excelPath)` - Load Instance_Config sheet
  - `loadModelMetadata(excelPath)` - Load Model_Metadata sheet
  - `loadFieldKnowledge(excelPath)` - Load columns L-Q from Schema sheet
- [ ] Update `src/common/services/simple-schema-converter.ts`:
  - Handle new columns (backward compatible - columns optional)
  - Include field knowledge in semantic text generation

**Tests (Claude Code - stdio):**
- [ ] Create test Excel file with all 3 sheets
- [ ] Run loader functions, verify data structure matches interfaces
- [ ] Test backward compatibility: load old schema without new columns

**Tests (claude.ai - HTTP):**
- [ ] Ask: "Load instance config from schema" → Should return structured data
- [ ] Ask: "What fields have knowledge defined?" → Should list fields with Level 4 data

**Success Criteria:**
- Loaders read all 3 sheets correctly
- Missing sheets/columns don't break existing functionality
- Validation errors are clear and actionable

---

### Stage 3: Knowledge Point Builder
**Goal:** Convert Excel rows into Qdrant-ready knowledge points with embeddings
**Estimated effort:** Complex

**Tasks:**
- [ ] Create `src/knowledge/dynamic/loaders/knowledge-point-builder.ts`:
  - `buildInstanceKnowledgePoints()` - Create Level 2 points
  - `buildModelKnowledgePoints()` - Create Level 3 points
  - `buildFieldKnowledgePoints()` - Create Level 4 points
- [ ] Update `src/common/utils/uuid-v2.ts`:
  - Add `buildKnowledgeUuidV2(level, modelId, itemId)`
  - New namespace `00000005` for extended knowledge
- [ ] Create semantic text generators for each level:
  - Instance: "MCP Configuration: {key} = {value}. {description}. LLM Instruction: {instruction}"
  - Model: "Model {name}: {purpose}. Grain: {grain}. Query guidance: {guidance}"
  - Field: "Field {name} in {model}: {knowledge}. Valid values: {values}. {notes}"

**Tests (Claude Code - stdio):**
- [ ] Build points from test data, verify UUID format
- [ ] Verify semantic text includes all relevant fields
- [ ] Verify payload structure matches `ExtendedKnowledgePayload`

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What UUID would be generated for instance config COMPANY_NAME?"
- [ ] Ask: "Show the semantic text for field Month in actual model"

**Success Criteria:**
- UUIDs follow format: `00000005-LLLL-MMMM-0000-IIIIIIIIIIII`
- Semantic text is rich enough for embedding quality
- All payload fields are populated correctly

---

### Stage 4: Extended Knowledge Sync Command
**Goal:** CLI command to sync all knowledge levels from Excel to Qdrant
**Estimated effort:** Complex

**Tasks:**
- [ ] Create `src/knowledge/dynamic/loaders/extended-knowledge-sync.ts`:
  - Main sync function with progress reporting
  - Cross-level validation (Model_ID exists, etc.)
  - Batch embedding with Voyage AI
  - Upsert to Qdrant with `point_type: 'knowledge'`
- [ ] Update `src/console/sync/commands/sync-knowledge.ts` (or create new):
  - Add `--levels` option (instance, model, field, all)
  - Add `--validate-only` option
  - Add `--force` option to delete existing before sync

**Tests (Claude Code - stdio):**
- [ ] `npm run sync -- sync knowledge --validate-only` → Shows validation results
- [ ] `npm run sync -- sync knowledge --levels instance` → Syncs only Level 2
- [ ] `npm run sync -- sync knowledge --all` → Syncs all levels
- [ ] `npm run sync -- sync knowledge --force --all` → Clears and rebuilds

**Tests (claude.ai - HTTP):**
- [ ] After sync, ask: "What is the company name?" → Should return from Instance_Config
- [ ] Ask: "What does the actual model contain?" → Should return from Model_Metadata
- [ ] Ask: "What are valid values for F1 field?" → Should return from Field Knowledge

**Success Criteria:**
- Sync completes without errors
- All 3 levels are stored in Qdrant
- Progress bar shows meaningful progress
- Validation catches cross-level inconsistencies

---

### Stage 5: Knowledge Adapter Enhancement
**Goal:** Enable knowledge search with level discrimination and hierarchical results
**Estimated effort:** Medium

**Tasks:**
- [ ] Update `src/knowledge/adapter/knowledge-adapter.ts`:
  - Add `knowledge_level` filter support
  - Implement `searchByLevel(query, levels)` function
  - Implement `getHierarchicalContext(modelId, fieldId)` function
- [ ] Update search to include level in results
- [ ] Add payload index for `knowledge_level` field

**Tests (Claude Code - stdio):**
- [ ] Search with level filter: verify only matching levels returned
- [ ] Hierarchical search: verify all relevant levels included
- [ ] Performance test: verify search <100ms

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What limitations does this MCP have?" → Returns Level 2 limitations
- [ ] Ask: "Explain the actual model" → Returns Level 3 + related Level 4
- [ ] Ask: "What does Month field mean?" → Returns Level 4 + Level 3 context

**Success Criteria:**
- Level filtering works correctly
- Hierarchical context enriches field-level queries
- Search performance not degraded

---

### Stage 6: Sample Data & Documentation
**Goal:** Create sample Instance_Config and Model_Metadata for Nexsus1 (DuraCube)
**Estimated effort:** Simple

**Tasks:**
- [ ] Update `samples/Nexsus1_schema.xlsx`:
  - Add Sheet 2: Model_Metadata (master, actual models)
  - Add Sheet 3: Instance_Config (DuraCube context)
  - Add columns L-Q to Schema sheet with field knowledge
- [ ] Update `CLAUDE.md` with:
  - 4-level knowledge hierarchy documentation
  - How to add new knowledge via Excel
  - CLI commands for knowledge sync
- [ ] Create example queries in `docs/SKILL-knowledge-search.md`

**Tests (Claude Code - stdio):**
- [ ] `npm run sync -- sync schema` → Still works (backward compatible)
- [ ] `npm run sync -- sync knowledge --all` → Syncs sample data
- [ ] Verify all sample data appears in Qdrant

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What company is this data for?" → "DuraCube (The Almar Group)"
- [ ] Ask: "What are the limitations?" → Lists all LIMITATION_* configs
- [ ] Ask: "How do I query actual model?" → Returns LLM_Query_Guidance

**Success Criteria:**
- Sample data represents realistic DuraCube configuration
- Documentation is clear and complete
- New LLM can answer questions about the data without prior context

---

## Dependencies

Before starting:
- [x] Nexsus1 schema Excel format is stable
- [x] Simple schema converter is working
- [x] Voyage AI embedding is configured
- [x] Qdrant collection exists and is accessible
- [ ] User has provided DuraCube-specific instance config values

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Large Excel files slow down sync | Add caching, only re-sync changed rows |
| Too many knowledge points impact search quality | Use knowledge_level filter by default |
| LLM_Instruction column gets stale | Add validation warning for missing instructions |
| Cross-level validation is too strict | Make validation warnings vs. errors configurable |
| Backward compatibility breaks existing schemas | Make all new columns optional with defaults |

## Notes

### Design Decisions Made
1. **Single Excel file** - All knowledge in Nexsus1_schema.xlsx (Option A)
2. **Extended schema columns** - Level 4 knowledge in same sheet as schema (not separate sheet)
3. **LLM-agnostic design** - Every config includes LLM_Instruction for explicit guidance
4. **Fully dynamic** - NO code changes needed to add new models/fields/limitations

### UUID Namespace
```
00000005-LLLL-MMMM-0000-IIIIIIIIIIII

Where:
- 00000005 = Extended knowledge namespace (new)
- LLLL = Level (0002=instance, 0003=model, 0004=field)
- MMMM = Model_ID (0000 for instance level)
- IIIIIIIIIIII = Item index or Field_ID
```

### Instance_Config Categories
- `operational` - Company name, industry, timezone
- `financial` - Fiscal year, currency
- `technical` - Synced models, embedding settings
- `limitation` - Known issues with workarounds (CRITICAL)
- `query` - Common query patterns

### Required Instance Config Keys
```
COMPANY_NAME, INDUSTRY, BUSINESS_UNIT, PRIMARY_USERS, BUSINESS_PURPOSE
FISCAL_YEAR_START, FISCAL_YEAR_END, DEFAULT_CURRENCY, TIME_ZONE
DATE_FORMAT, SYNC_FREQUENCY, DATA_LATENCY
SYNCED_MODELS, PAYLOAD_ENABLED_MODELS
LIMITATION_* (one per limitation)
COMMON_QUERY_* (one per pattern)
```

---

*Plan created: January 2025*
*Target: Nexsus1 v2.0 with Dynamic Knowledge*
