# Nexsus_common - Shared Foundation

## Section Objective
Shared infrastructure used by ALL other sections. This is the foundation layer containing utilities, API clients, type definitions, and services that multiple sections depend on.

**Think of this as**: The core plumbing and utilities that everything else builds upon.

---

## Anti-Patterns (NEVER do these)

1. **NEVER add section-specific logic here**
   - No semantic search algorithms (belongs in semantic/)
   - No aggregation/filtering logic (belongs in exact/)
   - No CLI/sync orchestration (belongs in console/)
   - No business domain rules (belongs in knowledge/)

2. **NEVER break backward compatibility without updating all consumers**
   - Changes here affect ALL sections
   - Test thoroughly before modifying shared interfaces

3. **NEVER add dependencies on other sections**
   - Common must remain the foundation layer
   - Other sections import from common, not vice versa

---

## File Ownership Manifest

Files in this section (under `src/common/`):

### Core Types & Configuration
```
src/common/types.ts              - All TypeScript interfaces (100+ types)
src/common/constants.ts          - Configuration values (ODOO, QDRANT, VOYAGE configs)
src/common/schemas/index.ts      - Zod validation schemas for MCP tools
```

### External API Clients
```
src/common/services/vector-client.ts     - Qdrant vector database client (15+ importers)
src/common/services/embedding-service.ts - Voyage AI embedding client
src/common/services/odoo-client.ts       - Odoo RPC API client
src/common/services/r2-client.ts         - Cloudflare R2 storage client
```

### Schema & Lookup Services
```
src/common/services/schema-loader.ts       - Load schema from Excel files
src/common/services/schema-lookup.ts       - O(1) field lookups
src/common/services/schema-query-service.ts - Schema queries (list, references)
src/common/services/model-registry.ts      - Model ID/name mapping
src/common/services/excel-schema-loader.ts - Excel schema parser
```

### Graph Infrastructure
```
src/common/services/knowledge-graph.ts  - FK relationship storage
src/common/services/nexsus-link.ts      - FK field resolution
src/common/tools/graph-tool.ts          - graph_traverse MCP tool
src/common/tools/inspect-graph-edge.ts  - inspect_graph_edge MCP tool
```

### Query Infrastructure (shared with exact/)
```
src/common/services/filter-builder.ts   - Qdrant filter generation
src/common/services/scroll-engine.ts    - Record pagination
src/common/services/token-estimator.ts  - Response size estimation
src/common/services/export-orchestrator.ts - Auto-export decision and execution
src/common/services/file-export.ts      - Excel export utility
```

### Utilities & Support Services
```
src/common/services/logger.ts           - Structured logging
src/common/services/circuit-breaker.ts  - Health monitoring
src/common/services/metrics.ts          - Performance tracking
src/common/services/dlq.ts              - Dead Letter Queue
src/common/services/cache-service.ts    - LRU query cache
src/common/services/json-fk-config.ts   - JSON FK mapping config
src/common/utils/uuid-v2.ts             - V2 UUID generation/parsing
src/common/utils/query-logger.ts        - Query logging
src/common/utils/odoo-error-parser.ts   - Odoo error parsing
```

---

## Interaction Contracts

### Who Can Import From This Section
- **semantic/** - YES (uses vector-client, embedding-service, schema-lookup)
- **exact/** - YES (uses vector-client, filter-builder base, schema-lookup)
- **knowledge/** - YES (will use schema services, types)
- **console/** - YES (uses all services for orchestration)

### What This Section Can Import
- **External packages only** (qdrant, voyageai, xlsx, etc.)
- **NEVER import from semantic/, exact/, knowledge/, or console/**

---

## Quality Gates

Before modifying files in this section:

1. **Check impact** - How many other files import this?
   - vector-client.ts has 15+ importers - be VERY careful
   - types.ts and constants.ts are imported by ALL files

2. **Maintain interfaces** - Don't change function signatures without updating callers

3. **Test all consumers** - After changes, verify:
   - `npm run build` passes
   - `npm run sync -- status` works
   - MCP server starts successfully

4. **Document changes** - Update JSDoc comments for any API changes

---

## Access Control

When working in this section:
```
WRITE: src/common/* and files listed above
READ-ONLY: src/semantic/*, src/exact/*, src/knowledge/*, src/console/*

If you find issues in other sections:
- NOTE them (TODO comment or tell user)
- DO NOT fix directly
```

---

## Common Patterns

### Adding a New Utility
1. Create file in appropriate location (src/services/ or src/utils/)
2. Export from this module
3. Add to this manifest
4. Ensure no section-specific logic

### Modifying an Existing Service
1. Check how many files import it
2. Maintain backward compatibility
3. Update all consumers if interface changes
4. Run full test suite
