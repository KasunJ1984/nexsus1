# semantic_search Guidelines

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
| `query` | Natural language search text | `"hospital projects in Victoria"` |
| `point_type` | What to search | `"data"`, `"schema"`, `"all"` |
| `model_filter` | Limit to specific model | `"crm.lead"`, `"res.partner"` |
| `limit` | Max results to return | `10` (default), up to `200` |
| `min_similarity` | Score threshold 0-1 | `0.35` (default) |
| `graph_boost` | Boost well-connected records | `true` for ranked results |

## Common Mistakes

1. **Using for exact queries** -> semantic_search is probabilistic; use nexsus_search for precise filters

2. **Ignoring similarity scores** -> Check scores; below 0.5 may not be relevant matches

3. **Not specifying point_type** -> Defaults to `"schema"`; use `"data"` to search actual records

4. **Too high min_similarity** -> Start with 0.35; increase only if getting too many irrelevant results

5. **Missing model_filter** -> Without it, searches all synced models; filter for efficiency

## Verification Steps

Before using results for nexsus_search:
- [ ] Similarity score > 0.5 for high confidence
- [ ] Extracted ID matches user's description
- [ ] Model name is appropriate for the query
- [ ] Multiple results? Ask user to clarify which one

## Point Type Selection

| User Intent | Use point_type |
|-------------|----------------|
| Find a partner/lead/record | `"data"` |
| What fields exist on a model | `"schema"` |
| Both field info and records | `"all"` |

## Graph Boost Usage

Enable `graph_boost: true` when:
- Looking for "main" or "important" records
- Records with many relationships are more relevant
- Searching partners or leads that are well-referenced

## Example Workflow

```
User: "Show me the Wadsworth account transactions"

1. semantic_search:
   query: "Wadsworth"
   point_type: "data"
   model_filter: "res.partner"
   graph_boost: true

2. Results show: Wadsworth Painting (id: 286798, score: 0.92)

3. Use partner_id_id: 286798 in nexsus_search filters
```

## Related Tools
- `nexsus_search`: Use AFTER semantic_search with discovered IDs
- `find_similar`: Find records similar to a discovered record
