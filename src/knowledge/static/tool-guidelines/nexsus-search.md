# nexsus_search Guidelines

## Nexsus1 Available Models

This is a standalone Excel-based system with only these models:
- `master` - Chart of Accounts (~560 GL accounts with classifications)
- `actual` - Monthly financial actuals (~15,000 transactions)
- `schema` - Field definitions (metadata only)

**FK Relationship**: `actual.Account_id → master.id`

## When to Use
- Precise data queries with exact filters (account ID, month, entity)
- Aggregations (sum, count, average) with group by
- Financial reports requiring accuracy
- When you have specific IDs or filter values (from semantic search or user)

## When NOT to Use
- Discovery searches (use semantic_search first)
- Finding entities when you don't have IDs
- Exploring what data exists
- Natural language queries without clear filter criteria

## Key Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `model_name` | Target model | `actual` or `master` |
| `filters` | Array of filter conditions | `[{field: "Account_id", op: "eq", value: 10100}]` |
| `aggregations` | Sum/count/avg operations | `[{field: "Amount", op: "sum", alias: "total"}]` |
| `group_by` | Group aggregations by fields | `["Entity", "Account_id"]` |
| `link` | Enrich with related names | `["Account_id"]` |
| `detail_level` | Control response size | `"summary"`, `"top_n"`, `"full"` |

## Nexsus1 Field Reference

### actual model (Monthly Actuals)
| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Row identifier |
| `Account_id` | integer | FK to master.id (GL account) |
| `Month` | date | Accounting period (Excel serial date) |
| `Entity` | string | Business segment: Product, Installation, Freight, Other |
| `Classification` | string | Account classification code |
| `Amount` | float | Net amount (positive=debit, negative=credit) |

### master model (Chart of Accounts)
| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | GL account code (10000-99999) |
| `Gllinkname` | string | Full account name with code |
| `Type2` | string | Statement type: BS (Balance Sheet) or PL (Profit & Loss) |
| `F1` | string | Level 1 P&L code: REV, VCOS, FCOS, OH, CASH, etc. |
| `F1_des` | string | F1 description |
| `Entity` | string | Business segment |
| `EBITA` | string | Y/N - Include in EBITA calculations |

## Common Query Patterns

### Total Amount by Classification
```json
{
  "model_name": "actual",
  "aggregations": [{"field": "Amount", "op": "sum", "alias": "total"}],
  "group_by": ["Classification"]
}
```

### Revenue Accounts (master)
```json
{
  "model_name": "master",
  "filters": [{"field": "F1", "op": "eq", "value": "REV"}]
}
```

### Actual by Entity and Month
```json
{
  "model_name": "actual",
  "aggregations": [{"field": "Amount", "op": "sum", "alias": "total"}],
  "group_by": ["Entity", "Month"],
  "filters": [{"field": "Entity", "op": "eq", "value": "Product"}]
}
```

## Common Mistakes

1. **Searching without discovery first** -> Always use semantic_search first to find account IDs, then use nexsus_search with exact filters

2. **Wrong model name** -> Use `actual` not `account.move.line`, use `master` not `res.partner`

3. **Excel serial dates** -> Month field uses Excel serial dates (45658 = Jan 1, 2025). Convert before displaying to user.

4. **Case sensitivity** -> Field names are case-sensitive: `Account_id` not `account_id`

5. **Missing link for FK** -> Use `link: ["Account_id"]` to get account names from master

## Verification Steps

Before returning results, verify:
- [ ] Model name is correct (`actual` or `master`)
- [ ] Field names match exactly (case-sensitive)
- [ ] Aggregation fields are numeric (Amount, id)
- [ ] Date values are Excel serial numbers if filtering Month

## Workflow Pattern

```
1. User asks: "Total revenue by entity for Product segment"

2. semantic_search to discover:
   - Revenue accounts have F1="REV" in master
   - Or search actual model for revenue-related records

3. Build nexsus_search:
   - model_name: actual
   - filters: Entity=Product
   - aggregations: sum(Amount)
   - group_by: Entity
   - link: Account_id (to get account names)

4. Present plan to user for approval

5. Execute and return results with sources
```

## Related Tools
- `semantic_search`: Use BEFORE nexsus_search for entity discovery
- `graph_traverse`: Use AFTER nexsus_search to explore FK relationships (actual → master)
