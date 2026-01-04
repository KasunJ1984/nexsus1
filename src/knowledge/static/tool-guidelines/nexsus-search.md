# nexsus_search Guidelines

## When to Use
- Precise data queries with exact filters (partner ID, date range, account)
- Aggregations (sum, count, average) with group by
- Financial reports requiring audit-trail accuracy
- When you have specific IDs or filter values (from semantic search or user)
- Reconciliation queries where data must match Odoo exactly

## When NOT to Use
- Discovery searches (use semantic_search first)
- Finding entities when you don't have IDs
- Exploring what data exists
- Natural language queries without clear filter criteria

## Key Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `model_name` | Target Odoo model | `account.move.line` |
| `filters` | Array of filter conditions | `[{field: "partner_id_id", op: "eq", value: 286798}]` |
| `aggregations` | Sum/count/avg operations | `[{field: "debit", op: "sum", alias: "total_debit"}]` |
| `group_by` | Group aggregations by fields | `["partner_id_id", "account_id_id"]` |
| `link` | Enrich with related names | `["partner_id", "account_id"]` |
| `detail_level` | Control response size | `"summary"`, `"top_n"`, `"full"` |
| `export_to_file` | Force Excel export | `true` for large datasets |

## Auto-Export Feature

Large results are automatically exported to Excel to prevent context overflow.

**How it works:**
1. System estimates token count before returning results
2. If estimate exceeds 10,000 tokens, auto-exports to Excel
3. Returns file URL + inline summary instead of raw data

**Thresholds:**
| Result Type | Full Output | Auto-Export Triggers |
|-------------|-------------|---------------------|
| Aggregation (no GROUP BY) | ~300 tokens | N/A (always small) |
| Aggregation (150 groups) | ~7,800 tokens | No auto-export |
| Aggregation (250 groups) | ~12,800 tokens | **Yes** |
| Records (50 records) | ~5,250 tokens | No auto-export |
| Records (150 records) | ~15,250 tokens | **Yes** |

**Manual export:**
Use `export_to_file: true` to force Excel export regardless of size.

**Output when auto-exported:**
```
## Excel Export (Auto-triggered)
File: https://r2.example.com/exports/query_2024-01-15.xlsx
Records: 500
Summary: Total debit: $125,000.00, Total credit: $125,000.00
```

**R2 Cloud Storage:**
When R2 is configured, exports are uploaded to cloud storage for easy sharing.
Otherwise, saved to local `data/exports/` directory.

## Common Mistakes

1. **Searching without discovery first** -> Always use semantic_search first to find entity IDs, then use nexsus_search with exact filters

2. **Using name strings instead of IDs** -> Filter by `partner_id_id: 286798` not by partner name. Use `link: ["partner_id"]` to get names in output

3. **Missing date filters on large models** -> Always add date range for `account.move.line` to avoid scanning millions of records

4. **Forgetting `parent_state` filter** -> For financial data, add `{field: "parent_state", op: "eq", value: "posted"}` to exclude drafts

5. **Wrong field name for FK IDs** -> Use `partner_id_id` (with `_id` suffix) not `partner_id` when filtering by ID

## Verification Steps

Before returning results, verify:
- [ ] Model name matches query intent (financial -> account.move.line, contacts -> res.partner)
- [ ] All filter IDs were obtained from semantic search (not guessed)
- [ ] Date ranges are appropriate for the query period
- [ ] Aggregation fields exist on the model
- [ ] For financial data: `parent_state: "posted"` filter is included if appropriate

## Workflow Pattern

```
1. User asks: "Total spend on Serafin Trust in 2024"

2. semantic_search to discover:
   - Partner ID for "Serafin Trust" -> 286798
   - Model confirmation -> account.move.line

3. Build nexsus_search:
   - model_name: account.move.line
   - filters: partner_id_id=286798, date>=2024-01-01, parent_state=posted
   - aggregations: sum(debit), sum(credit)

4. Present plan to user for approval

5. Execute and return results with sources
```

## Related Tools
- `semantic_search`: Use BEFORE nexsus_search for entity discovery
- `graph_traverse`: Use AFTER nexsus_search to explore relationships
