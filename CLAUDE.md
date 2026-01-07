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

### MCP Tools (13 Total)

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
| `inspect_graph_edge` | Inspect Knowledge Graph edge metadata (edge_count, validation status) |
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
| `sync schema` | Sync schema from Excel to Qdrant |
| `sync model <model_name>` | Sync model from Odoo with automatic FK cascade |
| `sync data <model\|all>` | Sync data from Excel files (standalone mode) |
| `sync knowledge` | Sync dynamic knowledge (KPIs, patterns, reports) |
| `cleanup <model_name>` | Remove records deleted in source |
| `validate-fk` | Validate FK integrity across all models |
| `fix-orphans [model]` | Find and sync missing FK targets |
| `status` | Show system status (collection counts, health) |

**CLI Options:**
```bash
# Sync schema from Excel (Simple or V2 format)
npm run sync -- sync schema --force

# Sync data from Excel files (standalone mode)
npm run sync -- sync data customer
npm run sync -- sync data all --dry-run

# Sync from Odoo with date filtering
npm run sync -- sync model account.move.line --date-from 2023-07-01 --date-to 2024-06-30

# Dry run (preview without syncing)
npm run sync -- sync model crm.lead --dry-run

# Disable FK cascade
npm run sync -- sync model res.partner --no-cascade

# Cleanup with dry run
npm run sync -- cleanup res.partner --dry-run

# Validate FK for specific model
npm run sync -- validate-fk --model account.move

# Fix orphan FK references
npm run sync -- fix-orphans account.move --dry-run
npm run sync -- fix-orphans --all
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
| Schema (V2) | `00000003-0004-0000-0000-FFFFFFFFFFFF` | `00000003-0004-0000-0000-000000005012` |
| Schema (Simple) | `00000003-MMMM-0000-0000-FFFFFFFFFFFF` | `00000003-0002-0000-0000-000000000202` |
| Graph | `00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF` | `00000001-0312-0078-0031-000000005012` |

Where:
- `MMMM` = Model ID from schema (4 digits, padded)
- `RRRRRRRRRRRR` = Record ID (12 digits)
- `FFFFFFFFFFFF` = Field ID (12 digits)
- `SSSS/TTTT` = Source/Target model IDs
- `RR` = Relationship type (31=many2one, 32=many2many, 33=one2many)

**UUID Generation Functions** (in `src/common/utils/uuid-v2.ts`):
- `buildDataUuidV2(modelId, recordId)` - Data point UUID
- `buildSchemaUuidV2(fieldId)` - Schema UUID (V2 format, hardcoded model 0004)
- `buildSchemaUuidV2Simple(fieldId, modelId)` - Schema UUID (Simple format, dynamic model)
- `buildGraphUuidV2(sourceModelId, targetModelId, fieldId, relType)` - Graph edge UUID
- `buildSchemaFkRefUuidV2(targetModelId, targetFieldId)` - FK reference UUID

**Data Flow:**
```
schema.xlsx → CLI: sync schema → QDRANT:nexsus1_unified (point_type='schema')
data/*.xlsx → CLI: sync data  → QDRANT:nexsus1_unified (point_type='data')
                               → QDRANT:nexsus1_unified (point_type='graph')
```

---

## Excel Data Sync (Standalone Mode)

This is the **key innovation** of Nexsus1 - syncing data directly from Excel files without requiring an Odoo connection.

### Simple Schema Format (11 Columns)

User-friendly Excel format that auto-converts to V2 format. Create your schema in `samples/Nexsus1_schema.xlsx`:

| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| Field_ID | number | Unique field identifier | 202 |
| Model_ID | number | Model identifier | 2 |
| Field_Name | string | Technical field name | "country_name" |
| Field_Label | string | Display label | "Country Name" |
| Field_Type | string | Field type | "char", "many2one", "integer", "date" |
| Model_Name | string | Model name | "country" |
| Stored | string | "Yes" or "No" | "Yes" |
| FK location field model | string | Target model (FK only) | "region" |
| FK location field model id | number | Target model ID (FK only) | 3 |
| FK location record Id | number | Target field ID (FK only) | 301 |
| Qdrant ID for FK | string | Auto-generated | (leave blank) |

**Auto-Detection**: The system automatically detects whether your schema file uses Simple (11 columns) or V2 (3 columns) format.

### Data File Format

Create data files in `samples/SAMPLE_{model_name}_data.xlsx`:

```
samples/
├── Nexsus1_schema.xlsx           # Schema definition (Simple format)
├── SAMPLE_payload_config.xlsx    # Which fields to store in payload
├── SAMPLE_customer_data.xlsx     # Customer records
├── SAMPLE_country_data.xlsx      # Country master data
└── SAMPLE_actual_data.xlsx       # Transaction data
```

### Data Sync Pipeline

```
Excel File (SAMPLE_{model}_data.xlsx)
    ↓
readExcelData() - Parse Excel using XLSX library
    ↓
transformRecords() - Apply schema-driven conversions
├── generateSemanticText() - Create embedding text (ALL fields)
├── Apply type conversion (date/int/float/bool)
├── Build payload (only configured fields)
├── Generate FK Qdrant UUIDs for graph traversal
└── Track conversion statistics
    ↓
embedBatch() - Generate embeddings (50 records per batch)
    ↓
upsertToUnifiedCollection() - Store in Qdrant (point_type='data')
    ↓
updateKnowledgeGraph() - Create FK relationship edges
├── Extract unique FK targets per field
├── Create graph edges (point_type='graph')
└── Create payload indexes automatically
    ↓
FK Cascade (optional) - Recursively sync referenced models
```

### Schema-Driven Type Conversion

The system automatically converts values based on the `field_type` from schema:

| Field Type | Input | Output | Example |
|------------|-------|--------|---------|
| date/datetime | Excel serial (45658) | Unix timestamp (ms) | 45658 → 1736899200000 |
| date/datetime | ISO string | Unix timestamp (ms) | "2024-01-15" → 1705276800000 |
| integer | "42" or 42 | number | "42" → 42 |
| float/monetary | "$1,234.56" | number | "$1,234.56" → 1234.56 |
| boolean | "yes"/"true"/"1" | boolean | "yes" → true |
| other | any | as-is | (no conversion) |

**Null Value Handling**: These values are treated as null:
`'', 'null', 'NULL', 'n/a', 'N/A', '#N/A', 'undefined', 'none', 'None', '-', '--'`

### FK Detection and Resolution

The system detects FK values in **three formats** automatically:

| Format | Example | Use Case |
|--------|---------|----------|
| **Scalar** | `{ country_id: 45 }` | Excel native (most common) |
| **Tuple** | `{ country_id: [45, "Australia"] }` | Odoo API format |
| **Expanded** | `{ country_id_id: 45, country_id_name: "Australia" }` | Legacy format |

**FK Resolution**: When an FK is detected, the system:
1. Extracts the target record ID (e.g., 45)
2. Looks up the target model's Model_ID from schema (e.g., country → Model_ID 2)
3. Generates the Qdrant UUID: `00000002-0002-0000-0000-000000000045`
4. Stores both the original ID and Qdrant UUID in payload

### Payload Configuration

Control which fields are stored in Qdrant using `samples/SAMPLE_payload_config.xlsx`:

| Field_ID | Model_ID | Model_Name | Field_Name | payload |
|----------|----------|------------|------------|---------|
| 101 | 1 | customer | name | 1 |
| 102 | 1 | customer | email | 1 |
| 103 | 1 | customer | internal_notes | 0 |

- **payload=1**: Field is stored in Qdrant payload (searchable/filterable)
- **payload=0**: Field is only used for semantic text (embedding)

This reduces storage while maintaining search quality - semantic text uses ALL fields, but payload stores only what you need.

### Automatic Index Creation

During sync, the system automatically creates Qdrant payload indexes for:
- Core fields: `record_id`, `model_id`, `model_name`, `point_type`
- All FK Qdrant reference fields (e.g., `country_id_qdrant`, `partner_id_qdrant`)

This enables O(1) filtering on these fields during queries.

### Key Files

| File | Purpose |
|------|---------|
| `src/common/services/excel-data-sync.ts` | Main Excel data sync orchestrator |
| `src/common/services/simple-schema-converter.ts` | Convert Simple → V2 format |
| `src/common/services/sample-payload-loader.ts` | Load payload config from Excel |
| `src/common/utils/type-converter.ts` | Schema-driven type conversion |
| `src/common/utils/fk-value-extractor.ts` | Extract FK values (3 formats) |

---

## Project Structure

```
Nexsus1/
├── src/
│   ├── common/                    # Shared infrastructure
│   │   ├── services/
│   │   │   ├── excel-data-sync.ts        # Main Excel data sync orchestrator
│   │   │   ├── excel-schema-loader.ts    # Load schema from Excel (V2/Simple)
│   │   │   ├── simple-schema-converter.ts # Convert Simple → V2 format
│   │   │   ├── sample-payload-loader.ts  # Load payload config from Excel
│   │   │   ├── vector-client.ts          # Qdrant operations
│   │   │   ├── knowledge-graph.ts        # FK relationship storage
│   │   │   └── embedding-service.ts      # Voyage AI embeddings
│   │   ├── utils/
│   │   │   ├── uuid-v2.ts                # V2 UUID generation
│   │   │   ├── type-converter.ts         # Schema-driven type conversion
│   │   │   └── fk-value-extractor.ts     # Extract FK values (3 formats)
│   │   ├── types.ts                      # TypeScript interfaces
│   │   └── constants.ts                  # Configuration
│   ├── console/                   # CLI and MCP server
│   │   ├── index.ts                      # MCP server entry point
│   │   ├── sync/
│   │   │   ├── index.ts                  # CLI entry point
│   │   │   └── commands/                 # CLI commands
│   │   └── blendthink/                   # Query routing engine
│   ├── exact/                     # Precise queries
│   │   └── tools/nexsus-search.ts        # nexsus_search tool
│   ├── semantic/                  # AI-powered search
│   │   └── tools/search-tool.ts          # semantic_search tool
│   └── knowledge/                 # Domain expertise (future)
├── samples/                       # Sample data files
│   ├── Nexsus1_schema.xlsx               # Schema (Simple format)
│   ├── SAMPLE_payload_config.xlsx        # Payload field config
│   ├── SAMPLE_actual_data.xlsx           # Transaction data
│   └── SAMPLE_master_data.xlsx           # Master data
├── scripts/
│   ├── add-missing-indexes.ts            # Add Qdrant payload indexes
│   ├── verify-uuids.ts                   # Validate UUID generation
│   └── verify-uuids-simple.cjs           # Simple format UUID validation
├── docs/
│   ├── SKILL-nexsus-search.md            # nexsus_search workflow guide
│   └── SKILL-build-odoo-url.md           # URL builder guide
├── data/
│   └── pipeline_sync_metadata.json       # Sync state
├── dist/                          # Compiled JavaScript
├── feilds_to_add_payload.xlsx     # Field payload config (legacy)
├── nexsus_schema_v2_generated.xlsx # Schema definitions (V2 format)
├── package.json
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## Typical Usage Flow

### Initial Setup (CLI) - Standalone Excel Mode

1. **Create your schema** in `samples/Nexsus1_schema.xlsx` (Simple 11-column format)

2. **Configure payload fields** in `samples/SAMPLE_payload_config.xlsx`

3. **Sync schema first** (one-time, ~2 minutes):
   ```bash
   npm run sync -- sync schema
   ```

4. **Sync data from Excel files**:
   ```bash
   # Sync a single model
   npm run sync -- sync data customer

   # Sync all data files
   npm run sync -- sync data all

   # Preview without syncing
   npm run sync -- sync data customer --dry-run
   ```

5. **Validate FK integrity** (periodic maintenance):
   ```bash
   npm run sync -- validate-fk
   ```

### Initial Setup (CLI) - Odoo Mode (Optional)

If you have an Odoo connection configured:

1. **Sync from Odoo** (long-running, hours for large models):
   ```bash
   # Sync CRM leads with all FK targets
   npm run sync -- sync model crm.lead

   # Sync financial data with date filter
   npm run sync -- sync model account.move.line --date-from 2023-07-01
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

5. **Full pipeline** (recommended):
   → `blendthink_execute` → Automatic routing, chaining, and synthesis

## Graceful API Restriction Handling (Odoo Mode Only)

When syncing from Odoo (not Excel), certain models (e.g., `res.partner`, `product.template`) may have fields restricted by permissions. Instead of failing completely, the system handles these gracefully.

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

### Key Files (Odoo Integration)

| File | Purpose |
|------|---------|
| `src/common/utils/odoo-error-parser.ts` | Parse Odoo security errors to extract field names |
| `src/common/services/odoo-client.ts` | `searchReadWithRetry()` method with automatic field fallback |
| `src/common/services/cascade-sync.ts` | FK cascade sync with knowledge graph updates |
| `src/common/services/pipeline-data-sync.ts` | Pipeline data sync orchestration |
| `src/common/types.ts` | TypeScript interfaces |

### Deployment

Server is deployed on **Railway**. After code changes:
1. Push to git repository
2. Railway auto-deploys from main branch
3. Server restarts with new code

---

## Architecture Refactoring Summary

The system was refactored to separate query tools (MCP) from sync operations (CLI):

### MCP Server (13 query tools - fast, interactive)
| Tool | Purpose |
|------|---------|
| `semantic_search` | Natural language search |
| `nexsus_search` | Precise queries with aggregation |
| `find_similar` | Find similar records in same model |
| `graph_traverse` | FK relationship navigation |
| `inspect_graph_edge` | Inspect graph edge metadata |
| `inspect_record` | Debug record inspection |
| `pipeline_preview` | Preview transformation |
| `build_odoo_url` | Generate Odoo web URLs |
| `system_status` | Status and health checks |
| `dlq_status` | Dead Letter Queue status |
| `dlq_clear` | Clear failed records |
| `update_model_payload` | Update payload without re-embedding |
| `blendthink_execute` | Full query pipeline with routing |
| `blendthink_diagnose` | Query analysis without execution |

### CLI (8 sync commands - long-running, batch)
| Command | Purpose |
|---------|---------|
| `sync schema` | Sync schema from Excel |
| `sync model <model>` | Sync from Odoo with FK cascade |
| `sync data <model\|all>` | Sync from Excel files |
| `sync knowledge` | Sync dynamic knowledge |
| `cleanup <model>` | Remove deleted records |
| `validate-fk` | Validate FK integrity |
| `fix-orphans` | Find and sync missing FK targets |
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
| **common/** | Shared infrastructure | graph_traverse, inspect_record, inspect_graph_edge |
| **console/** | CLI sync, query routing | blendthink_execute, blendthink_diagnose |

---

## Recent Updates (January 2025)

### New Features
1. **Simple Schema Format** - User-friendly 11-column Excel format with auto-conversion
2. **Excel Data Sync** - Complete standalone mode without Odoo connection
3. **Schema-Driven Type Conversion** - Automatic date/int/float/bool conversion
4. **FK Detection** - Support for 3 data formats (Scalar, Tuple, Expanded)
5. **Automatic Payload Indexes** - O(1) filtering on FK reference fields
6. **Payload Configuration** - Control which fields are stored vs. embedded

### New Files Added
- `src/common/services/simple-schema-converter.ts`
- `src/common/services/sample-payload-loader.ts`
- `src/common/services/excel-data-sync.ts`
- `src/common/utils/type-converter.ts`
- `scripts/verify-uuids-simple.cjs`
- `samples/Nexsus1_schema.xlsx`
- `samples/SAMPLE_payload_config.xlsx`

### CLI Changes
- Added `sync data` command for Excel-based data sync
- Added `fix-orphans` command for FK repair
- Added `sync knowledge` command for dynamic knowledge sync
- Added `sync knowledge-extended` command for 4-Level Knowledge System

---

## Extended Knowledge System (4-Level Hierarchy)

The Extended Knowledge System enables **ANY LLM** (Claude, OpenAI, Gemini, etc.) to operate Nexsus effectively **without prior training or conversation history**. It's fully dynamic - all configuration comes from Excel.

### 4-Level Knowledge Hierarchy

| Level | Name | Location | Purpose |
|-------|------|----------|---------|
| Level 1 | Universal | `src/knowledge/static/` | Tool reference, architecture, common concepts |
| Level 2 | Instance Config | `Instance_Config` sheet | MCP instance configuration (company, fiscal year, limitations) |
| Level 3 | Model Metadata | `Model_Metadata` sheet | Business meaning of each model/table |
| Level 4 | Field Knowledge | Schema sheet (columns L-Q) | Field-level business context |

### What's Dynamic (No Code Changes Needed)

After implementation, users can make these changes by **only editing Excel**:

| Change | Excel Action |
|--------|--------------|
| Add new model | Add rows to Schema + Model_Metadata sheets |
| Add new fields | Add rows to Schema sheet |
| Add field knowledge | Fill columns L-Q (Field_Knowledge, Valid_Values, etc.) |
| Add model knowledge | Add row to Model_Metadata sheet |
| Add limitation | Add row to Instance_Config with category="limitation" |
| Change fiscal year | Update Instance_Config FISCAL_YEAR_START row |
| Add query pattern | Add row to Instance_Config with category="query" |
| Document valid values | Fill Valid_Values column in Schema sheet |
| Add LLM instructions | Fill LLM_Instruction or LLM_Usage_Notes columns |

### Schema Excel Structure (Updated)

`samples/Nexsus1_schema.xlsx` now has 3 sheets:

**Sheet 1: Schema** (original + 6 new columns)
| Column | Name | Purpose |
|--------|------|---------|
| A | Field_ID | Unique field identifier |
| B | Model_ID | Model identifier |
| C | Field_Name | Technical field name |
| D | Field_Label | Display label |
| E | Field_Type | Field type (char, integer, many2one, etc.) |
| F | Model_Name | Model name |
| G | Stored | Yes/No |
| H | FK location field model | Target model (FK only) |
| I | FK location field model id | Target model ID (FK only) |
| J | FK location record Id | Target field ID (FK only) |
| K | Qdrant ID for FK | Auto-generated |
| **L** | **Field_Knowledge** | **Business meaning of this field** |
| **M** | **Valid_Values** | **Allowed values (pipe-separated)** |
| **N** | **Data_Format** | **Format/pattern description** |
| **O** | **Calculation_Formula** | **If computed field** |
| **P** | **Validation_Rules** | **Constraints** |
| **Q** | **LLM_Usage_Notes** | **How LLM should handle this field** |

**Sheet 2: Instance_Config** (Level 2)
| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| Config_Key | string | Unique identifier | COMPANY_NAME |
| Config_Value | string | The configuration value | DuraCube |
| Config_Category | enum | operational/financial/policy/technical/limitation/query | operational |
| Description | string | What this config means | Legal entity name |
| Applies_To | string | Which models/tools this affects | all |
| LLM_Instruction | string | How LLM should use this | "Always use this name..." |
| Last_Updated | date | When last modified | 2025-01-07 |

**Sheet 3: Model_Metadata** (Level 3)
| Column | Type | Purpose | Example |
|--------|------|---------|---------|
| Model_ID | number | Links to schema | 2 |
| Model_Name | string | Technical name | master |
| Business_Name | string | Human-friendly name | Chart of Accounts |
| Business_Purpose | string | What this table contains | GL account definitions |
| Data_Grain | string | What one row represents | One row per GL account |
| Record_Count | number | Approximate records | 560 |
| Is_Payload_Enabled | boolean | Can use nexsus_search | Yes |
| Primary_Use_Cases | string | When to query this | Account lookups |
| Key_Relationships | string | FK connections | actual.Account_id → master.id |
| LLM_Query_Guidance | string | How to query effectively | "Use Id for exact lookup..." |
| Known_Issues | string | Data quality notes | "Some DCFL fields undocumented" |
| Last_Updated | date | When last modified | 2025-01-07 |

### Extended Knowledge UUID Format

```
00000005-LLLL-MMMM-0000-IIIIIIIIIIII

Where:
- 00000005 = Extended knowledge namespace
- LLLL = Level (0002=instance, 0003=model, 0004=field)
- MMMM = Model_ID (0000 for instance level)
- IIIIIIIIIIII = Item index or Field_ID
```

### Extended Knowledge CLI Commands

```bash
# Sync all extended knowledge from Excel
npm run sync -- sync knowledge-extended

# Sync specific levels
npm run sync -- sync knowledge-extended --levels instance,model

# Validate without syncing
npm run sync -- sync knowledge-extended --validate-only

# Force rebuild (delete existing first)
npm run sync -- sync knowledge-extended --force

# Include all fields in Level 4 (not just those with knowledge)
npm run sync -- sync knowledge-extended --include-all-fields
```

### Key Files (Extended Knowledge)

| File | Purpose |
|------|---------|
| `src/knowledge/dynamic/schemas/instance-config-schema.ts` | Zod schema for Level 2 |
| `src/knowledge/dynamic/schemas/model-metadata-schema.ts` | Zod schema for Level 3 |
| `src/knowledge/dynamic/schemas/field-knowledge-schema.ts` | Zod schema for Level 4 |
| `src/knowledge/dynamic/loaders/excel-knowledge-loader.ts` | Load knowledge from Excel |
| `src/knowledge/dynamic/loaders/knowledge-point-builder.ts` | Build Qdrant points |
| `src/knowledge/dynamic/loaders/extended-knowledge-sync.ts` | CLI sync command |
| `src/knowledge/adapter/knowledge-adapter.ts` | Search knowledge by level |

### Qdrant Payload Structure (Extended Knowledge)

```typescript
interface ExtendedKnowledgePayload {
  // Common (all levels)
  point_type: 'knowledge';
  knowledge_level: 'instance' | 'model' | 'field';
  vector_text: string;
  sync_timestamp: string;

  // Level 2 (Instance) - config_key, config_value, config_category, applies_to, llm_instruction
  // Level 3 (Model) - model_id, model_name, business_name, business_purpose, data_grain, llm_query_guidance
  // Level 4 (Field) - field_id, field_name, field_knowledge, valid_values[], data_format, llm_usage_notes
}
```

### Sample Data (DuraCube Financial Model)

The schema Excel file includes pre-populated knowledge for the DuraCube financial model:

**Instance Config (Level 2):**
- COMPANY_NAME: DuraCube (The Almar Group)
- FISCAL_YEAR_START: 2024-07-01 (Australian FY)
- DEFAULT_CURRENCY: AUD
- LIMITATION_ACTUAL_NO_PAYLOAD: actual model has no payload fields
- QUERY_PATTERN_REVENUE: F1 = "REV"

**Model Metadata (Level 3):**
- schema: Field Definitions (metadata only)
- master: Chart of Accounts (560 GL accounts, payload enabled)
- actual: Monthly Actuals (15,000 records, semantic search only)

**Field Knowledge (Level 4):**
- Month: "Accounting period (Excel serial date)" + conversion formula
- Amount: "Net transaction amount" + "Positive=debit, negative=credit"
- F1: "Level 1 P&L classification" + "REV|VCOS|FCOS|OH" valid values
