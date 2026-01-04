# Nexsus_console - Orchestration & CLI

## Section Objective
Orchestrates all other sections, blends their results, and handles CLI sync operations. This is the "decision layer" that combines semantic search, exact data, and subject knowledge to produce final user-facing responses.

**Think of this as**: "How do I synthesize all this information into a coherent answer?" - the final step that brings everything together.

**Human cognition parallel**: When answering "Do you know a good restaurant in Penrith?", you:
1. Recall exact facts (restaurants list - exact/)
2. Apply similar experiences (quality, vibes - semantic/)
3. Use subject knowledge (food safety, area info - knowledge/)
4. Apply your values (vegetarian options if needed - common/)
5. **THEN synthesize into final answer** (this section!)

---

## Blendthink as Default Entry Point

**`blendthink_execute` is the RECOMMENDED entry point for all Nexsus queries.**

### Why Blendthink First?

| Benefit | Description |
|---------|-------------|
| **Automatic routing** | Analyzes query intent and routes to correct sections |
| **Multi-section chaining** | Passes IDs from discovery → filters for aggregation |
| **Consistent persona** | Forensic Analyst ensures evidence-based, cited answers |
| **Knowledge integration** | Domain expertise (KPIs, Odoo patterns) automatically included |
| **Quality gates** | Confidence thresholds, source attribution, clarification requests |

### Query Flow

```
User Query: "Total revenue for hospital projects in Victoria"
    ↓
blendthink_execute
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 1: QuestionAnalyzer                                │
│   → Type: aggregation_with_discovery                    │
│   → Entities: [location:Victoria, industry:hospital]    │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 2: AdaptiveRouter                                  │
│   → Route: semantic/ → exact/ → knowledge/              │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 3: Execute Route with Chaining                     │
│   → semantic_search("hospital projects Victoria")       │
│   → Extract IDs: [41085, 41092, 41103]                 │
│   → nexsus_search(filters=[id IN extracted_ids])       │
│   → knowledge_search(context for KPI interpretation)   │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ Step 4: Claude Synthesis with Forensic Analyst          │
│   → Blend all section results                           │
│   → Cite sources for every claim                        │
│   → Return formatted response                           │
└─────────────────────────────────────────────────────────┘
```

### When to Use Direct Tools

| Situation | Use Instead |
|-----------|-------------|
| Testing/debugging | `blendthink_diagnose` |
| Simple record lookup by ID | `inspect_record` |
| Schema exploration | `semantic_search` (point_type: schema) |
| Known-filter aggregation | `nexsus_search` directly |

---

## Anti-Patterns (NEVER do these)

1. **NEVER duplicate logic from other sections**
   - Don't re-implement aggregation logic (use exact/)
   - Don't re-implement semantic search (use semantic/)
   - Don't re-implement schema lookup (use common/)
   - CALL the other sections instead

2. **NEVER bypass section boundaries**
   - Even if it seems faster, route through proper sections
   - Each section has specific guarantees and quality gates

3. **NEVER skip progress indicators for long operations**
   - Sync operations can take hours
   - Always show progress bars, status updates
   - Users must know the system is working

4. **NEVER fail silently**
   - Log errors with context
   - Provide actionable error messages
   - Record failures in DLQ for retry

---

## File Ownership Manifest

Files in this section (under `src/console/`):

### Blendthink - Background Intelligence Layer
```
src/console/blendthink/index.ts             - Main exports
src/console/blendthink/engine.ts            - BlendthinkEngine orchestration
src/console/blendthink/config.ts            - Configuration management
src/console/blendthink/question-analyzer.ts - Query classification
src/console/blendthink/adaptive-router.ts   - Section routing logic
src/console/blendthink/persona-selector.ts  - Persona selection
src/console/blendthink/path-decision.ts     - System 1/System 2 decision layer (Stage 10)
src/console/blendthink/continuous-integration-engine.ts - Running hypothesis (Stage 11)
src/console/blendthink/self-reflection.ts   - Conclusion validation (Stage 12)
src/console/blendthink/learning.ts          - Pattern learning (Stage 13)
src/console/blendthink/memory/              - Memory layer with R2 persistence (Stage 9)
src/console/blendthink/section-adapters/    - Adapters for each section
src/console/blendthink/tools/               - blendthink_diagnose, blendthink_execute
```

### MCP Server Entry Point
```
src/console/index.ts              - MCP server entry point (stdio + http)
```

### CLI Entry Point & Commands
```
src/console/sync/index.ts              - CLI entry point (commander.js)
src/console/sync/commands/             - (future: move commands here)
```

### Orchestration Services (in common/)
```
src/common/services/pipeline-data-sync.ts      - Pipeline orchestration
src/common/services/cascade-sync.ts            - FK cascade logic
src/common/services/pipeline-data-transformer.ts - Data transformation
src/common/services/data-transformer.ts        - Encode/decode records
src/common/services/sync-metadata.ts           - Sync state tracking
src/common/services/fk-dependency-discovery.ts - FK extraction
src/common/services/unified-schema-sync.ts     - Schema sync to Qdrant
src/common/services/excel-pipeline-loader.ts   - Payload config loading
```

---

## Interaction Contracts

### This Section CAN Import From
- **common/** - YES (all shared infrastructure)
- **semantic/** - YES (for discovery and suggestions)
- **exact/** - YES (for precise data retrieval)
- **knowledge/** - YES (for domain expertise)

### Nothing Should Import This Section
- **common/** - NEVER imports console
- **semantic/** - NEVER imports console
- **exact/** - NEVER imports console
- **knowledge/** - NEVER imports console

Console is the TOP of the dependency tree. It calls others, others don't call it.

---

## Quality Gates

### For CLI Commands:
1. **Show progress** - Use `ora` spinners for all operations
2. **Colored output** - Use `chalk` for status (green=success, red=error)
3. **Exit codes** - Return 0 for success, 1 for failure
4. **Dry-run support** - Allow `--dry-run` to preview changes

### For Long Operations:
1. **Batch processing** - Process records in configurable batches
2. **Resume support** - Track sync state for interrupted operations
3. **Error recovery** - Use DLQ for failed records, continue processing
4. **Memory management** - Stream large datasets, don't load all in memory

### For Blendthink Responses:
1. **Cite sources** - Every claim attributes to section (exact/, semantic/, etc.)
2. **Confidence levels** - 80% threshold or admit uncertainty
3. **Actionable output** - Provide next steps or follow-up queries
4. **Turn limits** - Max 5 refinement turns per conversation
5. **Token budgets** - Stay within configurable budget (default: 50k)

---

## Access Control

When working in this section:
```
WRITE: src/console/* and files listed above
READ-ONLY: All other sections (but can CALL their functions)
IMPORT FROM: ALL sections (this is the orchestration layer)

If you find issues in other sections:
- NOTE them (TODO comment or tell user)
- DO NOT fix directly - changes must go through proper section
```

---

## CLI Command Reference

### sync model <model_name>
```bash
npm run sync -- sync model crm.lead
npm run sync -- sync model account.move.line --date-from 2024-01-01
npm run sync -- sync model res.partner --dry-run
npm run sync -- sync model crm.lead --no-cascade
```

### sync schema
```bash
npm run sync -- sync schema
npm run sync -- sync schema --force  # Recreate from scratch
```

### cleanup <model_name>
```bash
npm run sync -- cleanup res.partner
npm run sync -- cleanup res.partner --dry-run
```

### validate-fk
```bash
npm run sync -- validate-fk
npm run sync -- validate-fk --model account.move
npm run sync -- validate-fk --auto-sync  # Fix missing targets
```

### status
```bash
npm run sync -- status
```

---

## Orchestration Patterns

### Blendthink Flow (Implemented in Phase 1)
```
User Query: "Total revenue for hospital projects in Victoria"
    ↓
┌──────────────────────────────────────────────────────────────────┐
│ STEP 1: QuestionAnalyzer                                         │
│   → Type: aggregation_with_discovery                             │
│   → Entities: [location:Victoria, hospital, projects]            │
│   → Operation: aggregate                                         │
│   → Confidence: 85%                                              │
└────────────────────────────────────────────────────────────────┬─┘
                                                                  ↓
┌──────────────────────────────────────────────────────────────────┐
│ STEP 2: AdaptiveRouter                                           │
│   → Route: semantic/ (discovery) → exact/ (aggregation)         │
│   → Skip: knowledge/ (no rules needed)                           │
│   → Estimated tokens: 5000                                       │
└────────────────────────────────────────────────────────────────┬─┘
                                                                  ↓
┌──────────────────────────────────────────────────────────────────┐
│ STEP 3: PersonaSelector                                          │
│   → Persona: Forensic Analyst                                    │
│   → Traits: Evidence-first, "the data shows..."                  │
└────────────────────────────────────────────────────────────────┬─┘
                                                                  ↓
┌──────────────────────────────────────────────────────────────────┐
│ STEP 4: Execute Route Plan (Phase 2)                             │
│   1. semantic_search("hospital projects Victoria")               │
│   2. nexsus_search(filters=[id IN results], agg=[sum(revenue)]) │
│   3. Claude synthesizes with persona prompt                      │
└──────────────────────────────────────────────────────────────────┘
```

### Question Type Routing Table
| Question Type | Primary | Secondary | Skip |
|--------------|---------|-----------|------|
| precise_query | exact/ | - | semantic/, knowledge/ |
| discovery | semantic/ | exact/ | knowledge/ |
| aggregation | exact/ | - | semantic/, knowledge/ |
| aggregation_with_discovery | semantic/ → exact/ | - | knowledge/ |
| relationship | common/graph | semantic/ | exact/, knowledge/ |
| explanation | exact/ | knowledge/, semantic/ | - |
| comparison | exact/ | semantic/ | knowledge/ |

### Sync Orchestration Flow
```
Model Sync Request
    ↓
┌─────────────────┐
│  Check Schema   │  ← Validate model exists (common/)
└────────┬────────┘
         ↓
┌─────────────────┐
│  Fetch Records  │  ← Get from Odoo (common/odoo-client)
└────────┬────────┘
         ↓
┌─────────────────┐
│  Transform      │  ← Encode for vector DB (console/)
└────────┬────────┘
         ↓
┌─────────────────┐
│  Embed          │  ← Generate vectors (common/embedding)
└────────┬────────┘
         ↓
┌─────────────────┐
│  Upsert         │  ← Store in Qdrant (common/vector-client)
└────────┬────────┘
         ↓
┌─────────────────┐
│  FK Cascade     │  ← Sync related records (console/)
└─────────────────┘
```

---

## Example Use Cases

### Appropriate for Console Section:
- "Sync all CRM leads to vector database"
- "Validate FK integrity across all models"
- "Show me system status"
- "Blend semantic and exact results for this query" (future)

### NOT Appropriate (Use Other Sections):
- "Run semantic search" (use semantic/ directly)
- "Execute aggregation query" (use exact/ directly)
- "Lookup schema field info" (use common/ directly)
