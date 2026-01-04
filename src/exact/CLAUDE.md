# Nexsus_exact - Precise Data Retrieval

## Section Objective
Precise data retrieval with SQL-like filtering and aggregation. This section returns EXACT data matching Odoo records - no AI inference, no fuzzy matching, no similarity scores. Results must be reproducible and verifiable.

**Think of this as**: "What do I know for certain?" - like looking up facts in a database where the answer is definitively right or wrong.

**Human cognition parallel**: When asked "What is 2+2?", you recall the exact answer (4), not similar numbers or approximate values.

---

## Data Completeness Guarantee (Zero Tolerance for Data Loss)

**Core Principle:** This section returns ALL matching data. No artificial limits, no silent truncation, no hidden caps.

### What This Means:

| Aspect | Behavior |
|--------|----------|
| **Record retrieval** | Returns ALL matching records (no default limit) |
| **Aggregations** | Processes ALL matching records (no 100K cap) |
| **FK resolution** | Resolves ALL FK targets (no sampling) |
| **Display output** | Shows ALL records (no slice to 10) |
| **Data grid enrichment** | Enriches ALL records (no 10-record limit) |

### User Control:

- **`limit` parameter**: User-specified only. If omitted, returns everything.
- **`export_to_file: true`**: For large datasets, exports to Excel with inline summary.
- **`detail_level: "summary"`**: For aggregations, returns totals without group breakdown.

### Why No Limits?

The exact/ section exists to provide **precise, complete data** for:
- Financial audits (must match Odoo Trial Balance exactly)
- Reconciliation (cannot miss any records)
- Reporting (user expects complete data)

**Artificial limits violate the core objective.** If a user asks for "all invoices for partner X", they must get ALL invoices - not a silent subset.

### Capacity Handling:

For genuinely large datasets, the system provides options WITHOUT hiding data:

```typescript
// Large dataset? Use Excel export
{ export_to_file: true }  // Returns: file path + inline summary

// Just need totals? Use summary mode
{ detail_level: "summary" }  // Returns: grand totals only

// Want top contributors? Use top_n mode
{ detail_level: "top_n", top_n: 20 }  // Returns: top 20 groups + "remaining X" summary
```

---

## Anti-Patterns (NEVER do these)

1. **NEVER use fuzzy matching in final results**
   - No similarity scores in output
   - No "approximate" or "similar" results
   - Same query MUST return same results every time

2. **NEVER inject AI inference into query results**
   - Results come directly from vector database payload
   - No interpretation, no enhancement, no "smart" additions
   - What Odoo stored is what we return

3. **NEVER hide data quality issues**
   - If data is missing, say so
   - If filters return zero results, report it
   - Never fabricate or guess missing values

4. **NEVER include semantic confidence scores**
   - This section returns FACTS, not probabilities
   - If uncertain, return nothing rather than guessing

5. **NEVER modify the objective when using helpers from other sections**
   - You MAY call semantic/ to help identify filter parameters
   - BUT the final result must be pure exact data
   - Semantic suggestions are for QUERY BUILDING, not result generation

---

## File Ownership Manifest

Files in this section (under `src/exact/`):

### MCP Tools
```
src/exact/tools/nexsus-search.ts    - nexsus_search MCP tool (56K - largest tool)
                                      Precise queries with filters, aggregations, GROUP BY
src/exact/tools/data-tool.ts        - system_status, dlq_status, dlq_clear, update_model_payload
                                      Admin/inspection tools returning exact data
```

### Query Engine Services
```
src/exact/services/aggregation-engine.ts  - SUM, COUNT, AVG, MIN, MAX aggregations
                                            Streaming aggregation with checksums
src/exact/services/dot-notation-resolver.ts - Related field filtering
                                              e.g., filter by partner_id.name
src/exact/services/data-grid.ts           - Data enrichment orchestration
                                            Graph context, validation, similar records
```

### Shared Services (in common/)
```
src/common/services/filter-builder.ts     - Qdrant filter generation (shared)
src/common/services/scroll-engine.ts      - Record pagination (shared)
src/common/services/token-estimator.ts    - Response size estimation (shared)
```

---

## Interaction Contracts

### Who Can CALL This Section
- **console/** - YES, for precise data in blended responses
- **knowledge/** - YES, for factual data to combine with domain rules

### What This Section Can CALL
- **common/** - YES (vector-client, schema-lookup, types)
- **semantic/** - YES, but ONLY for parameter suggestions
  - Example: Use semantic to find "which field means revenue?"
  - Then use that field in exact filter
  - Final result MUST be pure data, not semantic output

### What This Section CANNOT Import
- **console/** - NEVER (console imports us)
- Results from semantic/ as final output - NEVER

---

## Quality Gates

### Every Exact Result Must:
1. **Be reproducible** - Same query = Same results
2. **Include record identifiers** - record_id, model_name, point_id
3. **Match Odoo exactly** - Data must match source system

### Aggregation Results Must Include:
```typescript
// REQUIRED for financial/audit purposes
{
  aggregations: { total_debit: 125000.00 },
  record_count: 1543,
  checksum: {
    row_hash: "abc123...",      // For reconciliation
    created_at: "2024-01-15T..."
  }
}
```

### Query Validation:
- Validate field names against schema before execution
- Return helpful errors for invalid fields
- Suggest corrections using schema-lookup

---

## Access Control

When working in this section:
```
WRITE: src/exact/* and files listed above
READ-ONLY: src/semantic/*, src/knowledge/*, src/console/*
IMPORT FROM: src/common/* (shared infrastructure)
MAY CALL: src/semantic/* for parameter suggestions ONLY

If you find issues in other sections:
- NOTE them (TODO comment or tell user)
- DO NOT fix directly
```

---

## Key Concepts

### Filter Operators
| Operator | Meaning | Example |
|----------|---------|---------|
| eq | Equals | `{ field: "status", op: "eq", value: "posted" }` |
| neq | Not equals | `{ field: "type", op: "neq", value: "draft" }` |
| gt/gte | Greater than | `{ field: "amount", op: "gte", value: 1000 }` |
| lt/lte | Less than | `{ field: "date", op: "lt", value: "2024-01-01" }` |
| in | In list | `{ field: "state", op: "in", value: ["open", "paid"] }` |
| contains | Text contains | `{ field: "name", op: "contains", value: "Hospital" }` |

### Aggregation Functions
- **sum** - Total of numeric field
- **count** - Number of records
- **avg** - Average value
- **min** - Minimum value
- **max** - Maximum value

### Nexsus Link
- Resolves FK IDs to readable names
- `link: ["partner_id"]` adds partner_id_name to results
- Does NOT change the query, only enriches output

---

## Example Use Cases

### Appropriate for Exact Section:
- "Total debit for account 319 in March 2024" (aggregation)
- "List all invoices for partner ID 286798" (filtered records)
- "Count of leads by stage" (GROUP BY aggregation)
- "Balance of GL account 1200" (precise calculation)

### NOT Appropriate (Use Semantic Section Instead):
- "Find projects similar to this one" (similarity)
- "What leads look like our best customers?" (pattern matching)
- "Hospital projects in Victoria" (natural language)

---

## Financial Audit Requirements

For financial data (account.move.line, account.move):

1. **Always include reconciliation checksums** in aggregations
2. **Never round or modify monetary values** - return exactly as stored
3. **Include date ranges** in queries for period-based reports
4. **Filter by parent_state="posted"** for official figures (exclude drafts)
