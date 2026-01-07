# semantic_search Guidelines

## Nexsus1 Available Models

This is a standalone Excel-based system with only these models:
- `master` - Chart of Accounts (~560 GL accounts with classifications)
- `actual` - Monthly financial actuals (~15,000 transactions)
- `schema` - Field definitions (metadata only)

**FK Relationship**: `actual.Account_id → master.id`

## When to Use
- Discovery: Finding entities, IDs, and context from natural language
- Fuzzy matching: When user provides partial names or descriptions
- Exploring: What records exist matching a description
- Schema lookup: Finding field names and meanings
- Initial step: Before nexsus_search to get filter values

## When NOT to Use
- Precise data retrieval (use nexsus_search)
- Aggregations and calculations (use nexsus_search)
- When you already have specific IDs
- Financial reconciliation (requires exact match)

## Key Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `query` | Natural language search text | `"revenue accounts"` |
| `point_type` | What to search | `"data"`, `"schema"`, `"all"` |
| `model_filter` | Limit to specific model | `"actual"`, `"master"` |
| `limit` | Max results to return | `10` (default), up to `200` |
| `min_similarity` | Score threshold 0-1 | `0.35` (default) |
| `graph_boost` | Boost well-connected records | `true` for ranked results |

## Common Mistakes

1. **Using for exact queries** -> semantic_search is probabilistic; use nexsus_search for precise filters

2. **Ignoring similarity scores** -> Check scores; below 0.5 may not be relevant matches

3. **Not specifying point_type** -> Defaults to `"schema"`; use `"data"` to search actual records

4. **Too high min_similarity** -> Start with 0.35; increase only if getting too many irrelevant results

5. **Missing model_filter** -> Without it, searches all synced models; filter for efficiency

6. **Wrong model names** -> Use `actual` not `account.move.line`, use `master` not `res.partner`

## Verification Steps

Before using results for nexsus_search:
- [ ] Similarity score > 0.5 for high confidence
- [ ] Extracted ID matches user's description
- [ ] Model name is appropriate for the query
- [ ] Multiple results? Ask user to clarify which one

## Point Type Selection

| User Intent | Use point_type |
|-------------|----------------|
| Find a GL account/transaction | `"data"` |
| What fields exist on a model | `"schema"` |
| Both field info and records | `"all"` |

## Graph Boost Usage

Enable `graph_boost: true` when:
- Looking for "main" or "important" records
- Records with many relationships are more relevant
- Searching accounts that are heavily used in transactions

## Example Workflow

```
User: "Show me the cash account transactions"

1. semantic_search:
   query: "cash account"
   point_type: "data"
   model_filter: "master"
   graph_boost: true

2. Results show: Cash on Hand (id: 10100, score: 0.92)

3. Use Account_id: 10100 in nexsus_search filters
```

## Example: Finding Revenue Accounts
```
User: "What revenue accounts do we have?"

semantic_search:
  query: "revenue accounts"
  point_type: "data"
  model_filter: "master"

Results will return accounts where F1="REV" with high scores.
```

## Example: Schema Discovery
```
User: "What fields are available on the actual model?"

semantic_search:
  query: "actual model fields"
  point_type: "schema"
  model_filter: "actual"

Results will show: id, Account_id, Month, Entity, Classification, Amount
```

## Related Tools
- `nexsus_search`: Use AFTER semantic_search with discovered IDs
- `find_similar`: Find records similar to a discovered record
