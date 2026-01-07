# graph_traverse Guidelines

## Nexsus1 Available Models

This is a standalone Excel-based system with only these models:
- `master` - Chart of Accounts (~560 GL accounts with classifications)
- `actual` - Monthly financial actuals (~15,000 transactions)
- `schema` - Field definitions (metadata only)

**FK Relationship**: `actual.Account_id → master.id`

## When to Use
- Exploring relationships from a specific record
- Finding what references a record (incoming FKs)
- Understanding data connections (account → transactions)
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
| `model_name` | Starting model | `"actual"`, `"master"` |
| `record_id` | Starting record ID | `10100` |
| `direction` | Which relationships | `"outgoing"`, `"incoming"`, `"both"` |
| `depth` | How many hops | `1-3` (default: 1) |
| `follow` | Which FK fields | `"all"` or `["Account_id"]` |
| `incoming_limit` | Max incoming refs | `20` (default), up to `100` |

## Direction Selection

| Direction | Shows | Use When |
|-----------|-------|----------|
| `"outgoing"` | What this record points TO | "What GL account is this transaction for?" |
| `"incoming"` | What points TO this record | "What transactions reference this account?" |
| `"both"` | Both directions | Full relationship map |

## Common Mistakes

1. **Using without a starting record** -> Must have model_name + record_id; use semantic_search first if needed

2. **Depth too deep** -> Start with depth 1; depth 3 can return massive trees

3. **No incoming_limit** -> For popular accounts (like revenue accounts), limit incoming results

4. **Following all fields** -> Specify `follow: ["Account_id"]` instead of `"all"` for focused traversal

5. **Expecting aggregations** -> Graph shows relationships, not sums; use nexsus_search for that

6. **Wrong model names** -> Use `actual` not `account.move.line`, use `master` not `res.partner`

## Verification Steps

Before returning graph results:
- [ ] Starting record was verified (from semantic search or user confirmation)
- [ ] Direction matches the question (outgoing vs incoming)
- [ ] Depth is appropriate (1 for direct, 2-3 for chains)
- [ ] Incoming limit is set for popular records

## Traversal Patterns

### Pattern 1: Account Relationships
```
User: "What's connected to account 10100?"

graph_traverse:
  model_name: "master"
  record_id: 10100
  direction: "both"
  depth: 1
  incoming_limit: 50
```

### Pattern 2: Transaction to Account
```
User: "Show me the account details for actual record 1234"

graph_traverse:
  model_name: "actual"
  record_id: 1234
  direction: "outgoing"
  follow: ["Account_id"]
  depth: 1
```

### Pattern 3: Find Transactions for Account
```
User: "What transactions reference this GL account?"

graph_traverse:
  model_name: "master"
  record_id: 10100
  direction: "incoming"
  incoming_limit: 100
```

## Understanding Results

**Outgoing results contain:**
- `fk_field`: The FK field name on source (e.g., Account_id)
- `target_model`: What model it points to (e.g., master)
- `target_id`: The target record ID (e.g., 10100)
- `display_name`: Target's name

**Incoming results contain:**
- `source_model`: What model references this (e.g., actual)
- `source_id`: The referencing record ID
- `fk_field`: Which FK field made the reference (e.g., Account_id)
- `display_name`: Source's name

## Related Tools
- `semantic_search`: Find starting record first
- `nexsus_search`: Aggregate data after understanding relationships
