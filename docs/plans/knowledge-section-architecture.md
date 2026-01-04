# Knowledge Section Architecture

## Overview
Design and implement the `src/knowledge/` section to provide domain expertise for blendthink and all MCP tools. Uses a **hybrid approach**: static rules in markdown files + dynamic knowledge in Qdrant vectors.

**Purpose:** Provide the "how to interpret" layer on top of raw data - subject matter expertise that makes answers meaningful.

## Architecture Decision: Hybrid Static + Dynamic

| Type | Format | Storage | Access Pattern |
|------|--------|---------|----------------|
| **Static** | Markdown files | Filesystem | Claude reads via file read |
| **Dynamic** | TypeScript → Vectors | Qdrant | Semantic search at runtime |

### What Goes Where

| Category | Type | Why |
|----------|------|-----|
| Tool usage guidelines | Static | Rarely changes, procedural |
| Financial KPIs | Dynamic | Business-specific, evolves |
| Blending mechanics | Static | Core system behavior |
| Odoo query patterns | Dynamic | Grows with experience |
| Report formats | Dynamic | Company-specific |
| General guidelines | Static | Core principles |

---

## Stages

### Stage 1: Folder Structure & CLAUDE.md
**Goal:** Create the skeleton structure with updated CLAUDE.md
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/knowledge/static/` folder structure
- [ ] Create `src/knowledge/dynamic/` folder structure
- [ ] Create `src/knowledge/adapter/` folder
- [ ] Update `src/knowledge/CLAUDE.md` with new architecture
- [ ] Create empty template files for each category

**Folder Structure:**
```
src/knowledge/
├── CLAUDE.md                    # Updated with architecture
├── static/
│   ├── tool-guidelines/
│   │   └── _template.md
│   ├── blending/
│   │   └── _template.md
│   └── general/
│       └── _template.md
├── dynamic/
│   ├── schemas/
│   │   └── _template.ts
│   └── loaders/
│       └── _template.ts
└── adapter/
    └── _placeholder.ts
```

**Tests (Claude Code - stdio):**
- [ ] `ls -la src/knowledge/` shows all folders created
- [ ] `cat src/knowledge/CLAUDE.md` shows updated content
- [ ] `tree src/knowledge/` matches expected structure

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What is the structure of the knowledge section?" - should describe hybrid approach
- [ ] Ask: "Where do financial KPIs go?" - should say `dynamic/`
- [ ] Ask: "Where do tool guidelines go?" - should say `static/tool-guidelines/`

**Success Criteria:**
- All folders exist
- CLAUDE.md accurately describes the architecture
- Template files explain expected content format

---

### Stage 2: Knowledge Adapter Skeleton
**Goal:** Create the knowledge-adapter.ts that blendthink can consume
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/knowledge/adapter/knowledge-adapter.ts`
- [ ] Implement `SectionAdapter` interface (match semantic/exact adapters)
- [ ] Add static file reading capability
- [ ] Add dynamic vector search capability (placeholder)
- [ ] Update `src/console/blendthink/section-adapters/index.ts` to use real adapter
- [ ] Export from adapter index

**Interface to implement:**
```typescript
interface SectionAdapter {
  execute(step: RouteStep, analysis: QuestionAnalysis): Promise<SectionResult>;
}
```

**Tests (Claude Code - stdio):**
- [ ] `npm run build` - no TypeScript errors
- [ ] `grep -r "knowledge-adapter" src/console/blendthink/` - shows import
- [ ] Run blendthink diagnose - knowledge section should not fallback to semantic

**Tests (claude.ai - HTTP):**
- [ ] N/A - adapter is internal, tested via blendthink

**Success Criteria:**
- Knowledge adapter compiles without errors
- Blendthink uses real adapter (no "using semantic" warning)
- Adapter returns valid `SectionResult`

---

### Stage 3: Static Knowledge - Tool Guidelines
**Goal:** Create first static knowledge content for tool usage
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/knowledge/static/tool-guidelines/nexsus-search.md`
- [ ] Create `src/knowledge/static/tool-guidelines/semantic-search.md`
- [ ] Create `src/knowledge/static/tool-guidelines/graph-traverse.md`
- [ ] Create `src/knowledge/static/general/data-verification.md`
- [ ] Update knowledge-adapter to read these files

**Content Template:**
```markdown
# [Tool Name] Guidelines

## When to Use
- Use case 1
- Use case 2

## When NOT to Use
- Anti-pattern 1
- Anti-pattern 2

## Key Parameters
| Parameter | Purpose | Example |
|-----------|---------|---------|

## Common Mistakes
1. Mistake → Correction
2. Mistake → Correction

## Verification Steps
Before returning results, verify:
- [ ] Check 1
- [ ] Check 2
```

**Tests (Claude Code - stdio):**
- [ ] `cat src/knowledge/static/tool-guidelines/nexsus-search.md` - content exists
- [ ] Knowledge adapter returns guidelines when queried

**Tests (claude.ai - HTTP):**
- [ ] Ask: "How should I use nexsus_search?" - blendthink returns guidelines
- [ ] Ask: "What should I verify before giving data to user?" - returns verification steps

**Success Criteria:**
- All 4 static files created with meaningful content
- Knowledge adapter successfully reads and returns static content
- Blendthink can access tool guidelines

---

### Stage 4: Static Knowledge - Blending Guide
**Goal:** Document how blendthink works for Claude's reference
**Estimated effort:** Simple

**Tasks:**
- [ ] Create `src/knowledge/static/blending/blendthink-guide.md`
- [ ] Document question types and routing
- [ ] Document persona selection logic
- [ ] Document section orchestration flow

**Tests (Claude Code - stdio):**
- [ ] File exists and contains routing table
- [ ] Knowledge adapter can read blending guide

**Tests (claude.ai - HTTP):**
- [ ] Ask: "How does blendthink route questions?" - returns routing explanation
- [ ] Ask: "What personas are available?" - returns persona list

**Success Criteria:**
- Blending guide accurately describes blendthink behavior
- Matches actual implementation in engine.ts

---

### Stage 5: Dynamic Knowledge Schema
**Goal:** Define TypeScript schemas for vector-searchable knowledge
**Estimated effort:** Medium

**Tasks:**
- [ ] Create `src/knowledge/dynamic/schemas/kpi-schema.ts`
- [ ] Create `src/knowledge/dynamic/schemas/odoo-pattern-schema.ts`
- [ ] Create `src/knowledge/dynamic/schemas/report-schema.ts`
- [ ] Define Zod validation schemas
- [ ] Define vector embedding format

**Schema Example:**
```typescript
export const KPISchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  formula: z.string().optional(),
  category: z.enum(['profitability', 'liquidity', 'efficiency', 'leverage']),
  interpretation: z.string(),
  related_accounts: z.array(z.number()).optional(),
});
```

**Tests (Claude Code - stdio):**
- [ ] `npm run build` - schemas compile
- [ ] Schema validation works on sample data

**Tests (claude.ai - HTTP):**
- [ ] N/A - internal schemas

**Success Criteria:**
- All 3 schemas defined
- Schemas have clear documentation
- Validation works correctly

---

### Stage 6: Dynamic Knowledge Loader
**Goal:** CLI command to sync knowledge to Qdrant vectors
**Estimated effort:** Complex

**Tasks:**
- [ ] Create `src/knowledge/dynamic/loaders/knowledge-sync.ts`
- [ ] Add CLI command: `npm run sync -- sync knowledge`
- [ ] Implement embedding generation for knowledge content
- [ ] Store in `nexsus_unified` with `point_type: 'knowledge'`
- [ ] Add to sync/commands/

**Point Format:**
```
UUID: 00000004-KKKK-0000-0000-RRRRRRRRRRRR
Where:
- 00000004 = knowledge namespace
- KKKK = knowledge category (0001=kpi, 0002=odoo, 0003=report)
- RRRRRRRRRRRR = knowledge item ID
```

**Tests (Claude Code - stdio):**
- [ ] `npm run sync -- sync knowledge --dry-run` - shows what would sync
- [ ] `npm run sync -- sync knowledge` - syncs to Qdrant
- [ ] `mcp__nexsus__semantic_search` with `point_type: 'knowledge'` - finds items

**Tests (claude.ai - HTTP):**
- [ ] Ask: "What KPIs relate to profitability?" - returns KPI definitions
- [ ] Ask: "Which Odoo model should I search for invoices?" - returns pattern

**Success Criteria:**
- Knowledge syncs to Qdrant successfully
- Semantic search finds knowledge items
- Knowledge adapter queries dynamic knowledge

---

### Stage 7: Knowledge Adapter Full Integration
**Goal:** Complete knowledge adapter with static + dynamic blending
**Estimated effort:** Medium

**Tasks:**
- [ ] Update knowledge-adapter to query both static and dynamic
- [ ] Implement smart selection based on query type
- [ ] Add caching for static content
- [ ] Test end-to-end with blendthink

**Tests (Claude Code - stdio):**
- [ ] Blendthink diagnose shows knowledge section in route plan
- [ ] Blendthink execute uses knowledge when appropriate

**Tests (claude.ai - HTTP):**
- [ ] Ask complex question requiring knowledge - blendthink includes knowledge
- [ ] Ask: "What is aged receivables and how do I calculate it?" - gets both KPI + query pattern

**Success Criteria:**
- Knowledge adapter blends static and dynamic content
- Blendthink routes to knowledge section when appropriate
- No fallback to semantic adapter

---

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| Blendthink engine | Exists | `src/console/blendthink/engine.ts` |
| Section adapters | Exist | semantic, exact, graph adapters |
| BlendSection type | Defined | Includes 'knowledge' already |
| Qdrant collection | Exists | `nexsus_unified` |
| CLI sync commands | Exist | Pattern to follow |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Static files become stale | Add last-updated timestamps, review process |
| Dynamic knowledge too generic | Use specific examples from real usage |
| Knowledge adapter too slow | Cache static content, batch vector queries |
| Duplicate info with other sections | Strict "no code details" constraint |
| Scope creep | Only add knowledge from actual user needs |

---

## Constraints (From Prompt Evaluation)

These constraints MUST be enforced:

1. **No implementation details** - WHAT to do, not HOW code works
2. **No tool-specific code** - Domain knowledge only, not syntax
3. **No duplication** - Reference other section CLAUDE.md files instead

---

## Open Questions (Awaiting User Input)

1. **Dynamic knowledge collection**: Same `nexsus_unified` with `point_type: 'knowledge'` or separate collection?
   - Recommendation: Same collection (consistent with architecture)

2. **Static file reading**: Read ALL files or selective based on query?
   - Recommendation: Selective (smarter, less context pollution)

3. **Initial content priority**: Which knowledge category to populate first?
   - From prompt evaluation: Architecture first, content later

---

## Notes

- This plan emerged from prompt evaluation session (score: 27/30)
- User chose "architecture first, content later" approach
- 4-checkpoint validation required before implementation:
  1. Design review (this document)
  2. Pattern check (match other sections)
  3. Blendthink compatibility
  4. Create files

---

## Validation Checkpoints

- [x] Checkpoint 1: Investigate blendthink and present architecture design
- [x] Checkpoint 2: Verify patterns match existing sections
- [x] Checkpoint 3: Confirm blendthink can consume designed format
- [x] Checkpoint 4: Create skeleton files after all gates pass

---

## Implementation Status: COMPLETE

All 7 stages implemented on 2026-01-02:

| Stage | Status | Files Created |
|-------|--------|---------------|
| Stage 1: Folder Structure | Complete | CLAUDE.md, templates |
| Stage 2: Knowledge Adapter | Complete | knowledge-adapter.ts, index.ts |
| Stage 3: Tool Guidelines | Complete | nexsus-search.md, semantic-search.md, graph-traverse.md |
| Stage 4: Blending Guide | Complete | blendthink-guide.md, data-verification.md |
| Stage 5: Dynamic Schemas | Complete | kpi-schema.ts, odoo-pattern-schema.ts, report-schema.ts |
| Stage 6: CLI Command | Complete | knowledge-sync.ts, CLI sync knowledge |
| Stage 7: Full Integration | Complete | Dynamic search, adapter updates |

**Next Steps:**
1. Run `npm run sync -- sync knowledge` to populate dynamic knowledge
2. Test blendthink with knowledge section via MCP
