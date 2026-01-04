# graph_traverse Guidelines

## When to Use
- Exploring relationships from a specific record
- Finding what references a record (incoming FKs)
- Understanding data connections (partner -> invoices -> GL entries)
- Navigating from one record to related records
- Answering "what's connected to this?" questions

## When NOT to Use
- Searching for records by attributes (use semantic_search)
- Aggregating data across records (use nexsus_search)
- When you don't have a specific starting record
- Bulk relationship queries (expensive for large datasets)

## Key Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `model_name` | Starting model | `"crm.lead"`, `"res.partner"` |
| `record_id` | Starting record ID | `41085` |
| `direction` | Which relationships | `"outgoing"`, `"incoming"`, `"both"` |
| `depth` | How many hops | `1-3` (default: 1) |
| `follow` | Which FK fields | `"all"` or `["partner_id", "user_id"]` |
| `incoming_limit` | Max incoming refs | `20` (default), up to `100` |

## Direction Selection

| Direction | Shows | Use When |
|-----------|-------|----------|
| `"outgoing"` | What this record points TO | "What partner/user/stage is on this lead?" |
| `"incoming"` | What points TO this record | "What invoices reference this partner?" |
| `"both"` | Both directions | Full relationship map |

## Common Mistakes

1. **Using without a starting record** -> Must have model_name + record_id; use semantic_search first if needed

2. **Depth too deep** -> Start with depth 1; depth 3 can return massive trees

3. **No incoming_limit** -> For popular records (like main company), limit incoming results

4. **Following all fields** -> Specify `follow: ["partner_id"]` instead of `"all"` for focused traversal

5. **Expecting aggregations** -> Graph shows relationships, not sums; use nexsus_search for that

## Verification Steps

Before returning graph results:
- [ ] Starting record was verified (from semantic search or user confirmation)
- [ ] Direction matches the question (outgoing vs incoming)
- [ ] Depth is appropriate (1 for direct, 2-3 for chains)
- [ ] Incoming limit is set for popular records

## Traversal Patterns

### Pattern 1: Partner Relationships
```
User: "What's connected to partner 286798?"

graph_traverse:
  model_name: "res.partner"
  record_id: 286798
  direction: "both"
  depth: 1
  incoming_limit: 50
```

### Pattern 2: Record Chain
```
User: "Show me the invoice chain for lead 41085"

graph_traverse:
  model_name: "crm.lead"
  record_id: 41085
  direction: "outgoing"
  follow: ["partner_id", "user_id"]
  depth: 2
```

### Pattern 3: Find References
```
User: "What invoices reference this partner?"

graph_traverse:
  model_name: "res.partner"
  record_id: 286798
  direction: "incoming"
  incoming_limit: 100
```

## Understanding Results

**Outgoing results contain:**
- `fk_field`: The FK field name on source
- `target_model`: What model it points to
- `target_id`: The target record ID
- `display_name`: Target's name

**Incoming results contain:**
- `source_model`: What model references this
- `source_id`: The referencing record ID
- `fk_field`: Which FK field made the reference
- `display_name`: Source's name

## Related Tools
- `semantic_search`: Find starting record first
- `nexsus_search`: Aggregate data after understanding relationships
