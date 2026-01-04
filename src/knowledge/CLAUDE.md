# Nexsus_knowledge - Subject Matter Expertise

## Section Objective
Subject matter expertise including accounting rules, Odoo domain knowledge, financial report structures, and business logic. This section provides the "how to interpret" layer on top of raw data.

**Think of this as**: "What subject expertise applies here?" - like applying professional knowledge to make sense of raw information.

**Human cognition parallel**: When asked about restaurants, you apply knowledge about food safety, nutrition, cuisine types, and local regulations - not just raw data about the restaurants.

---

## Architecture: Hybrid Static + Dynamic

This section uses a **hybrid approach**: static rules in markdown files + dynamic knowledge in Qdrant vectors.

| Type | Format | Storage | Access Pattern |
|------|--------|---------|----------------|
| **Static** | Markdown files | Filesystem | Claude reads via file read |
| **Dynamic** | TypeScript -> Vectors | Qdrant | Semantic search at runtime |

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

## Folder Structure

```
src/knowledge/
├── CLAUDE.md                    # This file - architecture guide
├── static/                      # Markdown files (read by Claude)
│   ├── tool-guidelines/         # How to use each MCP tool
│   │   ├── _template.md
│   │   ├── nexsus-search.md     # (Stage 3)
│   │   ├── semantic-search.md   # (Stage 3)
│   │   └── graph-traverse.md    # (Stage 3)
│   ├── blending/                # How blendthink works
│   │   ├── _template.md
│   │   └── blendthink-guide.md  # (Stage 4)
│   └── general/                 # General principles
│       ├── _template.md
│       └── data-verification.md # (Stage 3)
├── dynamic/                     # Vector-searchable knowledge
│   ├── schemas/                 # Zod schemas for knowledge types
│   │   ├── _template.ts
│   │   ├── kpi-schema.ts        # (Stage 5)
│   │   ├── odoo-pattern-schema.ts # (Stage 5)
│   │   └── report-schema.ts     # (Stage 5)
│   └── loaders/                 # CLI loaders to sync to Qdrant
│       ├── _template.ts
│       └── knowledge-sync.ts    # (Stage 6)
└── adapter/                     # Blendthink integration
    └── knowledge-adapter.ts     # (Stage 2)
```

---

## File Ownership Manifest

### Static Knowledge Files
```
src/knowledge/static/tool-guidelines/*.md    # Tool usage guidelines
src/knowledge/static/blending/*.md           # Blending mechanics
src/knowledge/static/general/*.md            # General principles
```

### Dynamic Knowledge Code
```
src/knowledge/dynamic/schemas/*.ts           # Zod schemas
src/knowledge/dynamic/loaders/*.ts           # Sync loaders
```

### Adapter Code
```
src/knowledge/adapter/knowledge-adapter.ts   # SectionAdapter implementation
src/knowledge/adapter/index.ts               # Exports
```

---

## Constraints (MUST Follow)

1. **No implementation details** - WHAT to do, not HOW code works
2. **No tool-specific code** - Domain knowledge only, not syntax
3. **No duplication** - Reference other section CLAUDE.md files instead
4. **No hardcoded business logic** - Make rules data-driven where possible

---

## Anti-Patterns (NEVER do these)

1. **NEVER hardcode business logic that should be configurable**
   - P&L structure may vary by company
   - Balance sheet formats differ by jurisdiction
   - Make rules data-driven where possible

2. **NEVER duplicate data from exact/**
   - This section interprets data, doesn't store it
   - Always fetch current data from exact/ or semantic/

3. **NEVER apply rules without context**
   - Different industries have different accounting rules
   - Different countries have different regulations
   - Always consider the user's context

4. **NEVER add implementation code details**
   - Tool guidelines describe WHAT to do, not HOW the code works
   - Reference tool documentation for syntax

---

## Interaction Contracts

### Who Will CALL This Section
- **console/blendthink** - YES, via KnowledgeAdapter for domain expertise
- **exact/** - YES, for understanding how to interpret results

### What This Section Can Import
- **common/** - YES (types, utilities)
- **exact/** - YES (for fetching current data to interpret)
- **semantic/** - YES (for finding relevant context)
- **console/** - NEVER (console imports us)

---

## Access Control

When working in this section:
```
WRITE: src/knowledge/* and files listed above
READ-ONLY: src/semantic/*, src/exact/*, src/console/*
IMPORT FROM: src/common/* (shared infrastructure)

If you find issues in other sections:
- NOTE them (TODO comment or tell user)
- DO NOT fix directly
```

---

## Dynamic Knowledge Point Format

Dynamic knowledge is stored in `nexsus_unified` collection with `point_type: 'knowledge'`.

**UUID Format**: `00000004-KKKK-0000-0000-RRRRRRRRRRRR`

Where:
- `00000004` = knowledge namespace
- `KKKK` = category code:
  - `0001` = KPI definitions
  - `0002` = Odoo patterns
  - `0003` = Report formats
- `RRRRRRRRRRRR` = knowledge item ID (12 digits)

---

## Example Use Cases

### Appropriate for Knowledge Section:
- "What accounts make up Cost of Goods Sold?" -> Static (accounting rules)
- "How should I structure a P&L report?" -> Static (report guidelines)
- "What does the partner_id field mean in invoices?" -> Dynamic (Odoo patterns)
- "What KPIs measure liquidity?" -> Dynamic (KPI definitions)
- "How does blendthink route questions?" -> Static (blending guide)

### NOT Appropriate (Use Other Sections):
- "Show me the COGS for March 2024" -> use exact/
- "Find similar expense patterns" -> use semantic/
- "Sync all invoice data" -> use console/

---

## Quality Gates

When adding knowledge content:

1. **Rules must be documented** - Explain WHY each rule exists
2. **Rules must be testable** - Include examples
3. **Rules must be overridable** - Allow company-specific customization
4. **Sources must be cited** - Link to accounting standards, regulations

---

## Getting Started

### Adding Static Knowledge
1. Create markdown file in appropriate folder (tool-guidelines/, blending/, general/)
2. Follow the `_template.md` format in that folder
3. Keep content focused on WHAT to do, not implementation details

### Adding Dynamic Knowledge
1. Define schema in `dynamic/schemas/` following `_template.ts`
2. Create loader in `dynamic/loaders/`
3. Run `npm run sync -- sync knowledge` to sync to Qdrant

### Using Knowledge Adapter
The adapter is consumed by blendthink automatically:
```typescript
// In blendthink engine:
const adapter = getAdapter('knowledge');
const result = await adapter.execute(step, analysis);
```
