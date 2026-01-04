# Nexsus Search - Claude Skill Guide

> **Version:** 1.0
> **Tool:** `nexsus_search`
> **Purpose:** Intelligent search workflow combining discovery with precise queries

---

## Overview

This skill guides Claude through an intelligent search workflow inspired by Anthropic's **4D Framework** for AI Fluency. When users cannot perfectly describe what they're looking for, the system helps them refine their request through intelligent follow-up questions rather than returning empty or incorrect results.

---

## Search Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         NEXSUS SEARCH WORKFLOW                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌──────────────────┐                                                  │
│   │   User Query     │                                                  │
│   └────────┬─────────┘                                                  │
│            ▼                                                            │
│   ┌──────────────────┐                                                  │
│   │ SEMANTIC SEARCH  │  ← Discovery phase                               │
│   │ (if needed)      │    Find entities, IDs, context                   │
│   └────────┬─────────┘                                                  │
│            ▼                                                            │
│   ┌──────────────────┐                                                  │
│   │ CLAUDE ESTIMATES │  ← Parameter building                            │
│   │ PARAMETERS       │    Extract filters, model, aggregations          │
│   └────────┬─────────┘                                                  │
│            ▼                                                            │
│   ┌──────────────────┐         ┌─────────────────────┐                  │
│   │ Sufficient Info? │───NO───►│ ASK FOLLOW-UP       │                  │
│   └────────┬─────────┘         │ QUESTIONS (max 2-3) │                  │
│            │ YES               └──────────┬──────────┘                  │
│            ▼                              │                             │
│   ┌──────────────────┐                    │                             │
│   │ PRESENT SEARCH   │◄───────────────────┘                             │
│   │ PLAN TO USER     │                                                  │
│   └────────┬─────────┘                                                  │
│            ▼                                                            │
│   ┌──────────────────┐                                                  │
│   │ USER APPROVAL?   │                                                  │
│   └────────┬─────────┘                                                  │
│            │                                                            │
│      ┌─────┼─────────────────┐                                          │
│      ▼     ▼                 ▼                                          │
│    [YES] [NO]            [MODIFY]                                       │
│      │     │                 │                                          │
│      ▼     ▼                 ▼                                          │
│   ┌──────┐ ┌──────────┐  ┌──────────────────┐                           │
│   │EXECUTE│ │Ask what  │  │User provides     │                          │
│   │SEARCH │ │to change │  │new info/changes  │                          │
│   └───┬───┘ └──────────┘  └────────┬─────────┘                          │
│       │                            │                                    │
│       │                            └──────► [Return to ESTIMATE]        │
│       ▼                                                                 │
│   ┌──────────────────┐                                                  │
│   │ RETURN RESULTS   │                                                  │
│   │ TO USER          │                                                  │
│   └──────────────────┘                                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Parameter Estimation

### From User Query

| Element | Extraction Logic | Example |
|---------|------------------|---------|
| **Intent** | What is the user trying to find? | "total spend", "list of invoices", "find contact" |
| **Entities** | Names, companies, people mentioned | "Serafin Trust", "Hansen Yuncken" |
| **Time Range** | Date references | "2025", "last month", "Q3" |
| **Metrics** | Amounts, counts, aggregations | "total", "how much", "count" |
| **Categories** | Types, classifications | "suppliers", "posted entries", "won deals" |

### From Semantic Search Results

| Element | Extraction Logic | Example |
|---------|------------------|---------|
| **Partner IDs** | Extract `id` field from matching records | `partner_id_id: 291956` |
| **Model Names** | Confirm correct Odoo model | `account.move.line` |
| **Field Names** | Validate field names exist | `date`, `debit`, `credit` |
| **Relationships** | Identify FK connections | `parent_id`, `account_id` |

### Model Selection Logic

| Query Pattern | Target Model |
|---------------|--------------|
| Financial data, transactions, GL | `account.move.line` |
| Contacts, vendors, customers | `res.partner` |
| Sales pipeline, opportunities | `crm.lead` |
| Invoices, bills | `account.move` |

---

## Follow-up Questions Framework

### When to Ask

| Condition | Example Scenario |
|-----------|------------------|
| Entity not found | Searched "Serafin Trust" but no match in semantic results |
| Multiple matches | Found 3 partners named "Smith" |
| Missing critical parameter | Financial query without date range |
| Ambiguous intent | "Show me their transactions" (purchases or sales?) |

### Question Rules

1. **Maximum 2-3 questions** per interaction
2. **Combine related questions** where possible
3. **Prioritize by importance** (identity → attributes → context)
4. **Never ask obvious questions** that can be inferred
5. **Provide context** from what was discovered

### Question Categories (Priority Order)

| Priority | Category | When to Ask | Example Question |
|----------|----------|-------------|------------------|
| 1 | **Identity** | Entity not found or ambiguous | "What's the exact name or alternative name this might be registered under?" |
| 2 | **Attributes** | No matches with any variation | "Do you know any identifiers - ABN, email, phone, or address?" |
| 3 | **Relationships** | Entity found but unclear connection | "Is this linked to [discovered entity]? Should I search under their parent company?" |
| 4 | **Context** | Intent is ambiguous | "Are you looking for purchases from them (vendor bills) or sales to them (customer invoices)?" |
| 5 | **Time** | Financial query without date range | "What date range should I search? (e.g., 2025, last quarter)" |

### Question Template

```markdown
I searched for "[user's term]" and here's what I found:

**Discovered:**
- [Entity 1] - [brief description]
- [Entity 2] - [brief description]
- [Or: No exact matches found]

**To build your search, I need to clarify:**

1. [Most important question - Identity/Attributes]

2. [Second question - Context/Time if needed]
```

---

## Search Plan Presentation

### Format

```markdown
**WHAT I UNDERSTOOD:**
[1-2 sentence plain English summary of user's intent]

**HOW I'LL SEARCH:**
[Business term for model - e.g., "Vendor Bills" not "account.move.line"]

**FILTERS:**
- [Filter 1 in plain English - e.g., "Partner: Document Witnesses"]
- [Filter 2 in plain English - e.g., "Date: January 1, 2025 to today"]
- [Filter 3 in plain English - e.g., "Status: Posted entries only"]

**WHAT YOU'LL GET:**
[Description of output - e.g., "List of transactions with dates and amounts, plus total spend"]

---
**Shall I proceed?** (Yes / No / Modify)
```

### Business Term Mappings

| Technical Model | Business Term |
|-----------------|---------------|
| `account.move.line` | Journal Entries / Transactions |
| `account.move` (type=in_invoice) | Vendor Bills |
| `account.move` (type=out_invoice) | Customer Invoices |
| `res.partner` (supplier_rank>0) | Vendors / Suppliers |
| `res.partner` (customer_rank>0) | Customers |
| `res.partner` | Contacts |
| `crm.lead` | Opportunities / Leads |

### Filter Presentation

| Technical Filter | Human Presentation |
|------------------|-------------------|
| `partner_id_id eq 291956` | Partner: Document Witnesses |
| `date gte "2025-01-01"` | Date: From January 1, 2025 |
| `parent_state eq "posted"` | Status: Posted entries only |
| `debit gt 0` | Debit amount: Greater than zero |

---

## Approval Handling

| User Response | Claude Action |
|---------------|---------------|
| "Yes" / "Proceed" / "Go ahead" | Execute `nexsus_search` with built parameters |
| "No" / "Stop" / "Cancel" | Acknowledge and offer to start fresh |
| Provides corrections | Rebuild parameters with new info, present updated plan |
| Asks for modification | Ask what specific changes needed |
| Unclear response | Clarify: "Would you like me to proceed with this search?" |

### After Execution

```markdown
**Results:**

[Formatted results - table, summary, or list as appropriate]

**Summary:**
- [Key metric 1]
- [Key metric 2]

---
Would you like me to:
- Drill down into specific transactions?
- Export this data?
- Search for something else?
```

---

## Example Flows

### Example 1: Successful Search

**User:** "What did we spend with Hansen Yuncken in 2025?"

**Claude (runs semantic_search internally):**
> Finds: Hansen Yuncken Pty Ltd, Partner ID #282161

**Claude (presents plan):**
```markdown
**WHAT I UNDERSTOOD:**
You want to see total spending with Hansen Yuncken for 2025.

**HOW I'LL SEARCH:**
Vendor Bills & Journal Entries

**FILTERS:**
- Partner: Hansen Yuncken Pty Ltd
- Date: January 1, 2025 to today
- Status: Posted entries only

**WHAT YOU'LL GET:**
Total debit and credit amounts, with transaction count.

---
**Shall I proceed?** (Yes / No / Modify)
```

### Example 2: Follow-up Needed

**User:** "Find Serafin trust transactions"

**Claude (runs semantic_search):**
> Finds: Nicholas Serafin (Duracube), Nina Serafin (Document Witnesses), no "Serafin Trust"

**Claude (asks follow-up):**
```markdown
I searched for "Serafin Trust" but couldn't find an exact match.

**Discovered:**
- Nicholas Serafin - Duracube employee
- Nina Serafin - Contact under Document Witnesses
- Duracube Rewards Trust - Same address as Nicholas

**To build your search:**

1. Is the trust registered under a different name - perhaps "The Trustee for..." or a trading name?

2. What type of transactions - purchases from them or services they provided?
```

---

## Knowledge Graph Integration (KG_improvements_1984)

The nexsus_search tool now integrates with the Knowledge Graph for enhanced context.

### show_relationships Parameter

When `show_relationships=true` is set, the output includes a **Knowledge Graph Relationships** section:

```markdown
## Knowledge Graph Relationships

**Outgoing FK Fields:** (27)
- partner_id -> res.partner (487 edges)
- account_id -> account.account (517 edges)
- journal_id -> account.journal (517 edges)
- ...

**Incoming References:** (8 models reference this)
- account.move.line_ids (2,746 edges)
- account.partial.reconcile.debit_move_id (1,904 edges)
- ...

**Suggested Explorations:**
- Add `group_by: ["partner_id_id"]` to group by res.partner
- Query account.move with filter on this model's records
```

### When to Use show_relationships

| Scenario | Use Case |
|----------|----------|
| **Before complex queries** | Understand available FK fields for GROUP BY |
| **Data exploration** | Discover related models for comprehensive analysis |
| **Planning aggregations** | Identify which fields can be grouped meaningfully |
| **Understanding data flow** | See how records connect across models |

### Example with Graph Context

**User:** "Show me transactions for account 319 with relationship context"

```json
{
  "model_name": "account.move.line",
  "filters": [{"field": "account_id_id", "op": "eq", "value": 319}],
  "aggregations": [
    {"field": "debit", "op": "sum", "alias": "total_debit"},
    {"field": "credit", "op": "sum", "alias": "total_credit"}
  ],
  "show_relationships": true
}
```

**Output includes:**
- Standard aggregation results
- Knowledge Graph section showing related models
- Suggestions for further exploration

### Combining with Nexsus Link

For comprehensive analysis, combine `show_relationships` with `link`:

```json
{
  "model_name": "account.move.line",
  "filters": [{"field": "account_id_id", "op": "eq", "value": 319}],
  "aggregations": [{"field": "balance", "op": "sum", "alias": "total"}],
  "group_by": ["partner_id_id"],
  "link": ["partner_id"],
  "show_relationships": true
}
```

This provides:
- Aggregation by partner with resolved names (Nexsus Link)
- Relationship context for further exploration (show_relationships)

---

## Operator Reference

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equal | `{"field": "state", "op": "eq", "value": "posted"}` |
| `neq` | Not equal | `{"field": "state", "op": "neq", "value": "draft"}` |
| `gt` | Greater than | `{"field": "amount", "op": "gt", "value": 1000}` |
| `gte` | Greater or equal | `{"field": "date", "op": "gte", "value": "2025-01-01"}` |
| `lt` | Less than | `{"field": "amount", "op": "lt", "value": 500}` |
| `lte` | Less or equal | `{"field": "date", "op": "lte", "value": "2025-12-31"}` |
| `in` | Value in array | `{"field": "state", "op": "in", "value": ["posted", "paid"]}` |
| `contains` | String contains | `{"field": "name", "op": "contains", "value": "Hansen"}` |

## Aggregation Reference

| Function | Description | Example |
|----------|-------------|---------|
| `sum` | Sum of values | `{"field": "debit", "op": "sum", "alias": "total"}` |
| `count` | Count records | `{"field": "id", "op": "count", "alias": "count"}` |
| `avg` | Average | `{"field": "amount", "op": "avg", "alias": "average"}` |
| `min` | Minimum value | `{"field": "date", "op": "min", "alias": "first_date"}` |
| `max` | Maximum value | `{"field": "date", "op": "max", "alias": "last_date"}` |

---

*End of Skill Guide*
