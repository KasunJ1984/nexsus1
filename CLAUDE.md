# CLAUDE.md - Project Nexsus1

Self-Describing Vector Database MCP Server for Excel Data (Standalone).

## Overview

This MCP server implements a **self-describing vector database architecture** for Excel data. The key innovation is that Claude can **semantically discover** field meanings and navigate relationships through a unified vector collection with an embedded knowledge graph.

**This is a standalone version that works with Excel files instead of Odoo.**

## Core Innovation: Unified Collection with Semantic Search

The system uses a **single unified Qdrant collection** (`nexsus1_unified`) that combines:

1. **Schema Points** - Field definitions from Excel (schema.xlsx) enabling semantic discovery of "where data lives"
2. **Data Points** - Actual records loaded from Excel files (data/*.xlsx)
3. **Graph Points** - FK relationship edges forming a traversable knowledge graph

**Key Capabilities:**
- **Semantic Search**: Natural language queries like "hospital projects in Victoria" find relevant records
- **Precise Queries**: Filter, aggregate, and retrieve exact data matching Odoo
- **Graph Traversal**: Navigate FK relationships to explore connected records
- **Nexsus Link**: Enrich query results with related record names automatically

## Architecture: MCP Server + CLI

The system is split into two entry points:
- **MCP Server**: Fast, interactive query tools for Claude
- **CLI**: Long-running sync operations with progress output

### MCP Tools (11 Total)

#### Search Tools
| Tool | Description |
|------|-------------|
| `semantic_search` | Natural language search across schema/data. Use for **discovery**. |
| `nexsus_search` | Precise data queries with filtering and aggregation. Use for **exact data**. |
| `find_similar` | Find similar records within the same model using vector similarity. |

#### Navigation Tools
| Tool | Description |
|------|-------------|
| `graph_traverse` | Navigate FK relationships in knowledge graph |
| `inspect_record` | Debug/inspect exact record stored in Qdrant |
| `pipeline_preview` | Preview transformation for a model (without syncing) |
| `build_odoo_url` | Generate Odoo web URLs for direct navigation to forms/lists |

#### Status Tools
| Tool | Description |
|------|-------------|
| `system_status` | Unified status (data, pipeline, health, metrics) |
| `dlq_status` | Check Dead Letter Queue status |
| `dlq_clear` | Clear failed records from DLQ |
| `update_model_payload` | Update payload without re-embedding |

#### Blendthink Tools (Recommended Entry Point)
| Tool | Description |
|------|-------------|
| `blendthink_execute` | **RECOMMENDED** - Full query pipeline with automatic routing and persona |
| `blendthink_diagnose` | Test query analysis and routing without execution |

### Recommended Query Workflow

**For most queries, use `blendthink_execute` as the entry point.** It automatically:
1. Analyzes the query intent (discovery, aggregation, relationship, etc.)
2. Routes through appropriate sections (semantic → exact → knowledge)
3. Chains results between steps (IDs from discovery → filters for aggregation)
4. Applies the Forensic Analyst persona for consistent, evidence-based answers
5. Cites sources for every claim

**When to use direct tools instead:**
| Situation | Tool to Use |
|-----------|-------------|
| Simple ID lookup | `inspect_record` |
| Schema exploration | `semantic_search` with `point_type: "schema"` |
| Debugging/development | `blendthink_diagnose` → direct tools |
| Specific aggregation with known IDs | `nexsus_search` directly |

### CLI Commands (nexsus-sync)

Long-running sync operations are now handled via CLI with proper progress bars and colored output.

```bash
# Run CLI commands
npm run sync -- <command>

# Or use development mode
npm run sync:dev -- <command>
```

| Command | Description |
|---------|-------------|
| `sync model <model_name>` | Sync model with automatic FK cascade |
| `sync schema` | Sync schema from Excel to Qdrant |
| `cleanup <model_name>` | Remove records deleted in Odoo |
| `validate-fk` | Validate FK integrity across all models |
| `status` | Show system status (collection counts, health) |

**CLI Options:**
```bash
# Sync with date filtering
npm run sync -- sync model account.move.line --date-from 2023-07-01 --date-to 2024-06-30

# Dry run (preview without syncing)
npm run sync -- sync model crm.lead --dry-run

# Disable FK cascade
npm run sync -- sync model res.partner --no-cascade

# Force recreate schema
npm run sync -- sync schema --force

# Cleanup with dry run
npm run sync -- cleanup res.partner --dry-run

# Validate FK for specific model
npm run sync -- validate-fk --model account.move
```

---

## MCP Tool Details

### `semantic_search`
Natural language search across synced data. Use for **discovery** - finding entities, IDs, context.

**Graph Enhancement:**
- `graph_boost=true`: Boost ranking by FK connection count

```json
{
  "query": "partners",
  "point_type": "data",
  "model_filter": "res.partner",
  "graph_boost": true
}
```

### `nexsus_search`
Execute precise data queries with filtering and aggregation.

**Workflow:**
1. Use `semantic_search` first for entity discovery
2. Build query parameters from user intent
3. Present search plan for user approval
4. Execute only after confirmation

See [docs/SKILL-nexsus-search.md](./docs/SKILL-nexsus-search.md) for detailed workflow guidance.

### `graph_traverse`
Navigate FK relationships in the knowledge graph.

```json
{
  "model_name": "res.partner",
  "record_id": 286798,
  "direction": "both",
  "depth": 1,
  "incoming_limit": 50
}
```

### `find_similar`
Find records similar to a reference record within the same model.

```json
{
  "model_name": "crm.lead",
  "record_id": 12345,
  "limit": 5,
  "min_similarity": 0.7
}
```

### `system_status`
```json
{ "section": "all" }           // Everything
{ "section": "data" }          // Collection vector counts
{ "section": "pipeline" }      // Sync history and model info
{ "section": "health" }        // Circuit breaker states
{ "section": "metrics" }       // Sync performance stats
```

## Build & Run

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run server (stdio mode)
npm start

# Development mode
npm run dev
```

## Environment Variables

Create `.env`:

```bash
# Excel Data Source (No Odoo connection needed)

# Qdrant Vector Database
QDRANT_HOST=http://localhost:6333
QDRANT_API_KEY=

# Collection Name (isolated from main Nexsus)
UNIFIED_COLLECTION_NAME=nexsus1_unified

# Voyage AI Embeddings
VOYAGE_API_KEY=your_api_key
EMBEDDING_MODEL=voyage-3.5-lite    # Recommended: voyage-3.5-lite (1M tokens, $0.02/1M)
```

## Architecture (Unified Collection)

The system uses a **unified collection** that stores all point types in a single Qdrant collection with V2 UUIDs:

```
┌─────────────────────────────────────────────────────────────┐
│  QDRANT: nexsus1_unified                                    │
│  ├── 00000001-* → Knowledge Graph (point_type: 'graph')     │
│  ├── 00000002-* → Data Points (point_type: 'data')          │
│  └── 00000003-* → Schema (point_type: 'schema')             │
└─────────────────────────────────────────────────────────────┘
```

**V2 UUID Formats** (deterministic, decimal-based):

| Type | Format | Example |
|------|--------|---------|
| Data | `00000002-MMMM-0000-0000-RRRRRRRRRRRR` | `00000002-0078-0000-0000-000000286798` |
| Schema | `00000003-0004-0000-0000-FFFFFFFFFFFF` | `00000003-0004-0000-0000-000000005012` |
| Graph | `00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF` | `00000001-0312-0078-0031-000000005012` |

Where:
- `MMMM` = Model ID from schema (4 digits, padded)
- `RRRRRRRRRRRR` = Record ID (12 digits)
- `FFFFFFFFFFFF` = Field ID (12 digits)
- `SSSS/TTTT` = Source/Target model IDs
- `RR` = Relationship type (31=many2one, 32=many2many, 33=one2many)

**Data Flow:**
```
schema.xlsx → CLI: sync schema → QDRANT:nexsus1_unified (point_type='schema')
data/*.xlsx → CLI: sync model → QDRANT:nexsus1_unified (point_type='data')
                               → QDRANT:nexsus1_unified (point_type='graph')
```


## Project Structure

```
Nexsus1/
├── src/                    # Source code
│   ├── console/           # CLI and MCP server
│   ├── types.ts           # TypeScript interfaces
│   ├── constants.ts       # Configuration
│   ├── schemas/           # Zod validation
│   ├── services/          # Core business logic
│   ├── tools/             # MCP tools
│   ├── sync/              # CLI commands
│   └── utils/             # Helper functions
├── scripts/               # Utility scripts
│   └── add-missing-indexes.ts  # Add Qdrant payload indexes
├── docs/
│   ├── SKILL-nexsus-search.md   # nexsus_search workflow guide
│   └── SKILL-build-odoo-url.md  # URL builder guide
├── data/
│   └── pipeline_sync_metadata.json  # Sync state
├── dist/                  # Compiled JavaScript
├── feilds_to_add_payload.xlsx    # Field payload config
├── nexsus_schema_v2_generated.xlsx  # Schema definitions (V2 format)
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## Typical Usage Flow

### Initial Setup (CLI)

1. **Sync schema first** (one-time, ~2 minutes):
   ```bash
   npm run sync -- sync schema
   ```

2. **Sync data models** (long-running, hours for large models):
   ```bash
   # Sync CRM leads with all FK targets
   npm run sync -- sync model crm.lead

   # Sync financial data with date filter
   npm run sync -- sync model account.move.line --date-from 2023-07-01
   ```

3. **Validate FK integrity** (periodic maintenance):
   ```bash
   npm run sync -- validate-fk
   ```

### Daily Usage (MCP Tools via Claude)

1. **Search data**: "Hospital projects in Victoria"
   → `semantic_search` → Get matching records with semantic relevance

2. **Precise queries**: "Total debit for partner 286798"
   → `nexsus_search` with filters and aggregations

3. **Navigate relationships**: "Find all records linked to this partner"
   → `graph_traverse` → Explore FK relationships

4. **Check status**:
   → `system_status` → Data counts, health, metrics

## Graceful API Restriction Handling

When syncing certain Odoo models (e.g., `res.partner`, `product.template`), the API user may lack permission to read specific fields. Instead of failing completely, the system now handles these gracefully.

### How It Works

1. **Detection**: When Odoo returns a security error, the error message is parsed to extract restricted field names
2. **Retry**: The query is retried without the restricted fields (up to 5 attempts)
3. **Encoding**: Restricted fields are encoded as `Restricted_from_API` instead of actual values
4. **Decoding**: When decoded, restricted fields display as `[API Restricted]`

### Supported Error Patterns

**Pattern 1 - Security Restriction:**
```
The requested operation can not be completed due to security restrictions.
Document type: Contact (res.partner)
Operation: read
Fields:
- slide_channel_count (allowed for groups 'eLearning / Officer')
- slide_channel_ids (allowed for groups 'eLearning / Officer')
```

**Pattern 2 - Compute Error:**
```
ValueError: Compute method failed to assign product.template(6952,).po_ids
```

### Example Output

```
Data Sync Complete
===================
Model: res.partner
Records Processed: 1500
Records Embedded: 1500
Duration: 45.3s

API Restrictions (4 fields):
----------------------------------------
security_restriction: slide_channel_count, slide_channel_ids, slide_channel_company_count, karma

NOTE: Restricted fields are encoded as "Restricted_from_API"
in the vector database. They will decode as "[API Restricted]".
```

### Key Files

| File | Purpose |
|------|---------|
| `src/utils/odoo-error-parser.ts` | Parse Odoo security errors to extract field names |
| `src/services/odoo-client.ts` | `searchReadWithRetry()` method with automatic field fallback |
| `src/services/cascade-sync.ts` | FK cascade sync with knowledge graph updates |
| `src/services/pipeline-data-sync.ts` | Pipeline data sync orchestration |
| `src/types.ts` | TypeScript interfaces |

### Deployment

Server is deployed on **Railway**. After code changes:
1. Push to git repository
2. Railway auto-deploys from main branch
3. Server restarts with new code

---

## Architecture Refactoring Summary

The system was refactored to separate query tools (MCP) from sync operations (CLI):

### MCP Server (11 query tools - fast, interactive)
| Tool | Purpose |
|------|---------|
| `semantic_search` | Natural language search |
| `nexsus_search` | Precise queries with aggregation |
| `find_similar` | Find similar records in same model |
| `graph_traverse` | FK relationship navigation |
| `inspect_record` | Debug record inspection |
| `pipeline_preview` | Preview transformation |
| `build_odoo_url` | Generate Odoo web URLs |
| `system_status` | Status and health checks |
| `dlq_status` | Dead Letter Queue status |
| `dlq_clear` | Clear failed records |
| `update_model_payload` | Update payload without re-embedding |

### CLI (5 sync commands - long-running, batch)
| Command | Purpose |
|---------|---------|
| `sync model <model>` | Sync with FK cascade |
| `sync schema` | Sync schema from Excel |
| `cleanup <model>` | Remove deleted records |
| `validate-fk` | Validate FK integrity |
| `status` | Show system status |

### Why This Split?
- **MCP tools must be fast** (<10s response time) for Claude interactions
- **Sync operations take hours** for large models (134,949 account.move records = 2.76 hours)
- **CLI provides proper progress bars**, colored output, and terminal control
- **Same codebase**, shared services, dual entry points

---

## 5-Section Architecture

The codebase is organized into 5 logical sections to provide clear context during development. **Each section has its own CLAUDE.md** with specific rules.

### Human Cognition Parallel
This architecture mirrors how humans think:
1. **Exact** - What do I know for certain? (facts, database records)
2. **Semantic** - What similar experiences do I have? (patterns, associations)
3. **Knowledge** - What subject expertise applies? (rules, frameworks)
4. **Common** - What are my values/principles? (shared infrastructure)
5. **Console** - Synthesize all above into coherent response

### Section Routing Table

When working on this codebase, check the appropriate section CLAUDE.md:

| If working on... | Check section... | Key Files |
|------------------|------------------|-----------|
| nexsus-search, aggregation, filters | `src/exact/CLAUDE.md` | nexsus-search.ts, aggregation-engine.ts |
| semantic_search, vector search | `src/semantic/CLAUDE.md` | search-tool.ts, analytics-service.ts |
| vector-client, types, constants, schema | `src/common/CLAUDE.md` | types.ts, vector-client.ts |
| sync commands, pipeline, cascade | `src/console/CLAUDE.md` | sync/*, pipeline-data-sync.ts |
| accounting rules, Odoo knowledge | `src/knowledge/CLAUDE.md` | (future content) |

### Access Control Rules

```
WHEN WORKING IN A SECTION:

  WRITE: Current section + common/
  READ-ONLY: All other sections
  NEVER: Modify code in other sections directly

  Cross-section function calls allowed:
  - exact/ may CALL semantic/ for parameter suggestions
  - But results must remain true to section's objective

  If you find a bug in another section:
  - NOTE IT (TODO comment or tell user)
  - DO NOT FIX IT directly
```

### Section Dependencies

```
           common/ (shared foundation)
           ^  ^  ^  ^
    semantic/ exact/ knowledge/
           ^    ^    ^
           +----+----+
                v
            console/ (orchestrates all)
```

### Quick Reference

| Section | Purpose | MCP Tools |
|---------|---------|-----------|
| **semantic/** | AI-powered search, discovery | semantic_search, find_similar |
| **exact/** | Precise queries, SQL-like | nexsus_search, system_status |
| **knowledge/** | Domain expertise (future) | - |
| **common/** | Shared infrastructure | graph_traverse, inspect_record |
| **console/** | CLI sync operations | (CLI only, no MCP tools) |
