# Remove Old Encoding References from Nexsus Codebase

## Overview
Update the Nexsus codebase to remove or update outdated references to the old coordinate encoding format (`model_id^field_id*VALUE`) and replace them with the current V2 UUID architecture documentation. This ensures Claude and developers see consistent, accurate documentation.

## Stages

### Stage 1: Update HIGH Priority MCP Tool Descriptions
**Goal:** Fix the public-facing tool documentation that Claude sees directly
**Estimated effort:** Medium

**Tasks:**
- [ ] Update `src/tools/search-tool.ts:64-68` - Replace coordinate encoding examples with V2 UUID format
- [ ] Update `src/tools/search-tool.ts:80` - Remove or clarify "KG_improvements_1984" reference
- [ ] Update `src/tools/search-tool.ts:801` - Change "coordinate encoding" terminology to "V2 UUID format"
- [ ] Update `src/types.ts:341` - Fix EncodedRecord interface documentation

**Tests (Claude Code - stdio):**
- [ ] Run `npm run build` - ensure no TypeScript errors
- [ ] Search for "344^6327" in src/tools/ - should return 0 results
- [ ] Search for "coordinate encoding" in tool descriptions - should return 0 results
- [ ] Verify MCP tool loads correctly: `npm start` and check tool list

**Tests (claude.ai - HTTP):**
- [ ] Call `semantic_search` tool and inspect its description - should show V2 UUID format
- [ ] Verify search results don't mention "coordinate encoding" in hints

**Success Criteria:**
- No old encoding format examples in MCP tool descriptions
- V2 UUID format clearly documented in tool descriptions
- Build passes without errors

---

### Stage 2: Update Type Definitions and Constants
**Goal:** Fix internal documentation in type definitions and constants
**Estimated effort:** Medium

**Tasks:**
- [ ] Update `src/types.ts:4` - File header comment
- [ ] Update `src/types.ts:86-98` - OdooSchemaRow interface JSDoc
- [ ] Update `src/types.ts:314-316` - Field encoding comment
- [ ] Update `src/types.ts:531-556` - CoordinateMetadata comments
- [ ] Update `src/constants.ts:4` - File header
- [ ] Update `src/constants.ts:89-110` - Prefix codes section (mark as "internal/legacy")
- [ ] Update `src/constants.ts:116-118` - Column position documentation

**Tests (Claude Code - stdio):**
- [ ] Run `npm run build` - ensure no TypeScript errors
- [ ] Run `grep -r "4\^XX\*" src/types.ts src/constants.ts` - verify context is "legacy/internal"
- [ ] Verify type definitions still work: `npm test` (if tests exist)

**Tests (claude.ai - HTTP):**
- [ ] N/A - internal documentation changes don't affect HTTP interface

**Success Criteria:**
- All type definition comments clearly distinguish "internal/legacy" encoding from "V2 UUID" format
- Build passes
- No misleading documentation for developers

---

### Stage 3: Update Service Documentation
**Goal:** Fix service file headers and JSDoc comments
**Estimated effort:** Simple

**Tasks:**
- [ ] Update `src/services/data-transformer.ts:5-8` - Service header (mark as "internal encoding for parsing")
- [ ] Add clarification comments explaining the dual-system architecture:
  - Internal: coordinate encoding for schema parsing
  - External: V2 UUID for vector storage and MCP tools

**Tests (Claude Code - stdio):**
- [ ] Run `npm run build` - ensure no TypeScript errors
- [ ] Review data-transformer.ts header - should explain "internal use only"

**Tests (claude.ai - HTTP):**
- [ ] N/A - internal service changes

**Success Criteria:**
- data-transformer.ts clearly marked as internal/legacy encoding
- Dual-system architecture documented

---

### Stage 4: Verify Uncertain Cases
**Goal:** Confirm intentional vs accidental old references
**Estimated effort:** Simple

**Tasks:**
- [ ] Review `src/services/data-transformer.ts` - Confirm coordinate encoding is intentionally used for internal parsing
- [ ] Review `src/services/schema-loader.ts:121-138` - Confirm "4^XX*" parsing is intentional for Excel schema files
- [ ] Review `src/services/analytics-service.ts:462-545` - Confirm training data format is intentional
- [ ] Document findings in code comments if intentional

**Tests (Claude Code - stdio):**
- [ ] Run full test suite: `npm test`
- [ ] Verify schema loading still works: `npm run sync -- sync schema --dry-run`

**Tests (claude.ai - HTTP):**
- [ ] Call `semantic_search` with a schema query - verify results return correctly
- [ ] Call `pipeline_preview` for a model - verify it works

**Success Criteria:**
- All "uncertain" cases reviewed and documented
- No regression in functionality
- Clear comments explaining intentional legacy code

---

## Dependencies
- Access to src/tools/search-tool.ts
- Access to src/types.ts
- Access to src/constants.ts
- Access to src/services/data-transformer.ts
- npm build must pass after changes

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Breaking internal coordinate encoding | Only update COMMENTS/DOCS, not actual encoding logic |
| Removing something intentionally kept | Review each "uncertain" case before changing |
| TypeScript errors from doc changes | Run `npm run build` after each stage |
| MCP tool description breaking | Test tool loading after Stage 1 |

## Notes

### Two Parallel Systems (Intentional)
The codebase maintains two encoding systems:

| System | Purpose | Location | Action |
|--------|---------|----------|--------|
| **Legacy `4^XX*`** | Schema parsing from Excel | data-transformer.ts, schema-loader.ts | Keep, but mark as "internal" |
| **V2 UUID** | Vector storage, MCP tools | uuid-v2.ts, all tools | Document as the current standard |

### V2 UUID Format Reference
```
Data:   00000002-MMMM-0000-0000-RRRRRRRRRRRR
Schema: 00000003-0004-0000-0000-FFFFFFFFFFFF
Graph:  00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF
```

### Files Already Correct (No Action Needed)
- DNU folder files (archived)
- @deprecated markers in data-sync.ts, excel-schema-loader.ts, knowledge-graph.ts

### Original Audit Report
Full audit findings saved at: `C:\Users\KasunJ\.claude\plans\wiggly-honking-elephant.md`
