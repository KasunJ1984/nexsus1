# Data Verification Guidelines

## Purpose
Before returning financial or business-critical data to users, verify accuracy and completeness. These checks prevent returning incorrect or misleading results.

## Key Principles

1. **Sources must be cited** - Every data point should trace back to a tool call
2. **Confidence must be stated** - If uncertain, say so explicitly
3. **Reconciliation where possible** - Cross-check totals against known values
4. **Assumptions must be explicit** - State any filters or scope limitations

## Verification Checklist

### Before Executing Query
- [ ] Entity IDs verified through semantic search (not guessed)
- [ ] Date ranges explicitly stated
- [ ] Filters include `parent_state: "posted"` for financial data
- [ ] Model matches query intent

### After Getting Results
- [ ] Record count seems reasonable for the scope
- [ ] Amounts are in expected range (no obvious errors)
- [ ] Zero results trigger clarification (not silent acceptance)
- [ ] Debits equal credits for GL queries (if applicable)

### Before Returning to User
- [ ] Source tool calls cited in response
- [ ] Any limitations or excluded data noted
- [ ] Confidence level stated if below 80%
- [ ] Offer follow-up for clarification if needed

## Common Verification Patterns

### Pattern 1: Financial Totals
```
Query: "Total spend on vendor X in 2024"

Verify:
1. Partner ID confirmed via semantic search
2. Date range: 2024-01-01 to 2024-12-31
3. Filter: parent_state = "posted" (exclude drafts)
4. Aggregation: sum(debit) or sum(credit) as appropriate
5. Cross-check: Debit sum should balance if checking both sides
```

### Pattern 2: Record Counts
```
Query: "How many leads in Won stage?"

Verify:
1. Stage name/ID confirmed
2. Model is crm.lead
3. Count seems reasonable (not 0, not millions)
4. Compare to similar queries if available
```

### Pattern 3: Entity Search
```
Query: "Find partner Serafin Trust"

Verify:
1. Semantic search score > 0.7 for high confidence
2. Only one match, or clarify with user if multiple
3. Confirm partner is active (not archived)
4. Display full name to user for confirmation
```

## Red Flags (Require Extra Verification)

| Red Flag | Action |
|----------|--------|
| Zero results | Ask: Is the filter too narrow? Entity not synced? |
| Unexpectedly large numbers | Confirm date range and filters |
| Negative values where positive expected | Check debit/credit orientation |
| Same value across all groups | Possible filter issue |
| Similarity score < 0.5 | Low confidence match; confirm with user |

## Stating Uncertainty

When confidence is below 80%, use phrases like:
- "Based on the available data..."
- "This shows X, though there may be records not yet synced..."
- "The semantic search matched Y with 65% confidence..."
- "I found N results; please verify this is the complete set"

## Exceptions

Some queries don't need full verification:
- Schema lookups (not user data)
- Exploration without final answer
- Follow-up to previously verified query
- Explicitly stated as estimate/approximation

## Related Guidelines
- nexsus-search.md - Precise query verification
- semantic-search.md - Entity matching confidence
