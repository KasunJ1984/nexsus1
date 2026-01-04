# Blendthink - Claude Skill Guide

> **Version:** 1.0
> **Tools:** `blendthink_diagnose`, `blendthink_execute`
> **Purpose:** Intelligent orchestration layer that blends multiple data sections into coherent responses

---

## Overview

Blendthink is a **background intelligence layer** that orchestrates how the console synthesizes responses. It routes queries to the most appropriate sections (exact, semantic, knowledge, common) and uses adaptive personas to shape response style.

**Key Innovation:** Adaptive routing + adaptive persona + multi-turn refinement + vector-embedded memory

---

## Architecture

```
User Query: "What is the total revenue for hospital projects in Victoria?"
                                    |
                                    v
+-------------------------------------------------------------------------+
| STEP 1: QUESTION ANALYSIS                                                |
|   Input:  "What is the total revenue for hospital projects in Victoria?" |
|   Output: {                                                              |
|     type: "aggregation_with_discovery",                                  |
|     entities: ["hospital", "Victoria"],                                  |
|     operation: "sum",                                                    |
|     confidence: 0.85                                                     |
|   }                                                                      |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| STEP 2: ADAPTIVE ROUTING                                                 |
|   Route Plan:                                                            |
|   1. semantic/ -> Find hospital projects in Victoria (discovery)         |
|   2. exact/ -> Sum revenue for discovered record IDs (aggregation)       |
|                                                                          |
|   Skip: knowledge/ (no accounting rules needed)                          |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| STEP 3: PERSONA SELECTION                                                |
|   Question Type: aggregation_with_discovery                              |
|   Selected Persona: FORENSIC_ANALYST                                     |
|                                                                          |
|   Behavior:                                                              |
|   - Ground claims in exact data                                          |
|   - Say "the data shows..." before conclusions                           |
|   - High confidence threshold (80%)                                      |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| STEP 4: SECTION EXECUTION (Phase 2)                                      |
|   Turn 1: Query semantic/                                                |
|   -> semantic_search("hospital projects Victoria", model="crm.lead")     |
|   -> Result: 15 matching records [IDs: 123, 456, ...]                    |
|                                                                          |
|   Turn 2: Query exact/                                                   |
|   -> nexsus_search(filters=[{id IN [...]}], agg=[sum(expected_revenue)]) |
|   -> Result: { total_revenue: 4,250,000 }                                |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| STEP 5: CLAUDE SYNTHESIS                                                 |
|   Response:                                                              |
|   "The data shows $4.25M total expected revenue across 15 hospital       |
|    projects in Victoria. [Source: semantic/ discovery + exact/ agg]"     |
+-------------------------------------------------------------------------+
```

---

## Question Types

Blendthink classifies user queries into 7 types:

| Type | Description | Example |
|------|-------------|---------|
| `precise_query` | Lookup specific record/value | "What is the balance of account 123?" |
| `discovery` | Find entities without exact criteria | "Find hospital projects" |
| `aggregation` | Compute totals/counts/averages | "Total revenue by partner" |
| `aggregation_with_discovery` | Aggregate after finding entities | "Total revenue for hospital projects" |
| `relationship` | Explore FK connections | "How is partner 286798 connected?" |
| `explanation` | Understand why something happened | "Why did revenue drop in Q4?" |
| `comparison` | Compare two things | "Compare Q1 vs Q2 performance" |
| `unknown` | Needs clarification | "Help me" |

---

## Routing Rules

### Question Type to Section Mapping

| Question Type | Primary Section | Secondary | Skip |
|--------------|-----------------|-----------|------|
| `precise_query` | exact/ | - | semantic/, knowledge/ |
| `discovery` | semantic/ | exact/ | knowledge/ |
| `aggregation` | exact/ | - | semantic/, knowledge/ |
| `aggregation_with_discovery` | semantic/ -> exact/ | - | knowledge/ |
| `relationship` | common/graph | semantic/ | exact/, knowledge/ |
| `explanation` | exact/ | knowledge/, semantic/ | - |
| `comparison` | exact/ | semantic/ | knowledge/ |

### Section Adapters

| Section | Adapter | Tools Used |
|---------|---------|------------|
| **semantic/** | SemanticAdapter | `semantic_search`, `find_similar` |
| **exact/** | ExactAdapter | `nexsus_search` |
| **common/** | GraphAdapter | `graph_traverse` |
| **knowledge/** | (fallback to semantic) | - |

---

## Personas

Blendthink uses 4 personas that shape how responses are framed:

### Forensic Analyst
- **Best for:** `precise_query`, `aggregation`
- **Style:** Evidence-first, grounded in data
- **Claim prefix:** "The data shows..."
- **Evidence emphasis:** High
- **Asks follow-ups:** No

### Systems Thinker
- **Best for:** `discovery`, `relationship`
- **Style:** Finds patterns and connections
- **Evidence emphasis:** Medium
- **Asks follow-ups:** Yes

### Socratic Guide
- **Best for:** `explanation`
- **Style:** Leads through reasoning with questions
- **Evidence emphasis:** Medium
- **Asks follow-ups:** Yes

### Neutral
- **Best for:** `unknown`
- **Style:** Balanced, asks for clarification
- **Evidence emphasis:** Low
- **Asks follow-ups:** Yes

---

## MCP Tools

### blendthink_diagnose

Analyzes a query without executing it. Useful for testing and understanding how blendthink would process a query.

**Input:**
```json
{
  "query": "Find hospital projects in Victoria"
}
```

**Output:**
- Question type classification
- Confidence score
- Extracted entities
- Route plan (which sections to query)
- Selected persona with traits
- Estimated token usage
- Warnings if any

**Use Cases:**
- Testing query classification accuracy
- Understanding routing decisions
- Debugging unexpected behavior
- Previewing token costs

---

### blendthink_execute

Executes a query through the full blendthink pipeline. Requires `ANTHROPIC_API_KEY`.

**Input:**
```json
{
  "query": "Total revenue for hospital projects in Victoria",
  "session_id": "optional-uuid-for-multi-turn"
}
```

**Output:**
- Synthesized response from Claude
- Source attributions (which sections contributed)
- Confidence score
- Session information (turns used, tokens consumed)
- Section execution results
- Performance timing

**Use Cases:**
- Full end-to-end query execution
- Multi-turn conversations (pass session_id)
- Complex queries requiring multiple sections

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | - | Required for `blendthink_execute` |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Claude model to use |
| `BLENDTHINK_MAX_TURNS` | `5` | Max refinement turns per session |
| `BLENDTHINK_TOKEN_BUDGET` | `50000` | Max tokens per session |
| `BLENDTHINK_CONFIDENCE_THRESHOLD` | `0.8` | Min confidence to answer vs clarify |
| `BLENDTHINK_PERSIST_CONVERSATIONS` | `true` | Store conversations in Qdrant |

### Default Configuration

```typescript
{
  maxTurns: 5,
  tokenBudget: 50000,
  confidenceThreshold: 0.8,
  requireAttribution: true,
  claudeModel: 'claude-sonnet-4-20250514',
  persistConversations: true
}
```

---

## Session Management

### Creating Sessions

Sessions are automatically created when you call `blendthink_execute` without a `session_id`.

```
First call: blendthink_execute({ query: "Find hospital projects" })
Response includes: session_id: "abc123..."

Continue: blendthink_execute({ query: "What is their total revenue?", session_id: "abc123..." })
```

### Session Limits

| Limit | Value | What Happens |
|-------|-------|--------------|
| Max turns | 5 | Session forces synthesis, returns error for more |
| Token budget | 50,000 | Stops early if approaching budget |
| Session TTL | 24 hours | Expired sessions are cleaned up |
| Max sessions | 100 | Oldest sessions evicted when exceeded |

### Conversation Memory

Conversations are embedded in Qdrant with `point_type='conversation'`. This enables:

- **Semantic recall:** "Remember when we discussed hospital projects?"
- **Context persistence:** Session history across restarts
- **Similar conversation search:** Find past conversations like current query

---

## Example Flows

### Example 1: Discovery + Aggregation

**User:** "What is the total expected revenue for hospital projects in Victoria?"

**Blendthink Process:**

1. **Analysis:**
   - Type: `aggregation_with_discovery`
   - Entities: ["hospital", "Victoria"]
   - Operation: "sum"

2. **Route Plan:**
   - Step 1: semantic/ -> semantic_search("hospital projects Victoria")
   - Step 2: exact/ -> nexsus_search with discovered IDs

3. **Persona:** Forensic Analyst

4. **Execution:**
   - Semantic finds 15 matching crm.lead records
   - Exact aggregates expected_revenue: $4,250,000

5. **Response:**
   > "The data shows $4.25M total expected revenue across 15 hospital projects in Victoria.
   >
   > **Sources:**
   > - semantic/semantic_search: 15 records discovered
   > - exact/nexsus_search: aggregation computed"

---

### Example 2: Relationship Query

**User:** "How is partner 286798 connected to other records?"

**Blendthink Process:**

1. **Analysis:**
   - Type: `relationship`
   - Entities: ["286798"]

2. **Route Plan:**
   - Step 1: common/ -> graph_traverse(model="res.partner", record_id=286798)

3. **Persona:** Systems Thinker

4. **Response:**
   > "Partner 286798 is a hub in your data network with connections to:
   >
   > **Outgoing:**
   > - company_id -> res.company (parent company)
   > - user_id -> res.users (assigned salesperson)
   >
   > **Incoming (67 references):**
   > - 45 crm.lead records (partner_id)
   > - 15 account.move records (partner_id)
   > - 7 sale.order records (partner_id)
   >
   > Would you like me to explore any of these connections further?"

---

### Example 3: Low Confidence / Clarification Needed

**User:** "Show me stuff"

**Blendthink Process:**

1. **Analysis:**
   - Type: `unknown`
   - Confidence: 0.2
   - needsClarification: true

2. **Response (no execution):**
   > "I need a bit more information to help you accurately.
   >
   > 1. What type of data are you looking for? (CRM leads, invoices, partners, etc.)
   > 2. Do you want to search for something specific or see a summary?
   >
   > Please provide additional context so I can give you the best answer."

---

## Constraints

### 5 Key Constraints

| Constraint | Implementation | Why |
|------------|----------------|-----|
| **Turn limit** | max 5 refinement turns | Prevents infinite loops |
| **Token budget** | max 50k per session | Controls API costs |
| **Confidence threshold** | 80% or admit uncertainty | Ensures reliable responses |
| **Source attribution** | every claim cites section | Transparency and trust |
| **Error handling** | graceful degradation | Continues despite failures |

### Graceful Degradation

If a section fails, blendthink continues with remaining sections:

```
Step 1: semantic/ -> SUCCESS (found 15 records)
Step 2: exact/ -> FAILED (Qdrant timeout)

Response: "I found 15 hospital projects in Victoria using semantic search,
but I was unable to aggregate their revenue due to a database timeout.

Would you like me to try again, or show you the individual records?"
```

---

## Testing

### Manual Test Script

```bash
npx tsx src/console/blendthink/__tests__/test-engine.ts
```

### Test Queries

```typescript
const TEST_QUERIES = [
  // Precise queries
  "What is the balance of account 123?",
  "Get me record id:45678",

  // Discovery
  "Find hospital projects in Victoria",
  "Search for similar leads to Hansen Yuncken",

  // Aggregation
  "What is the total revenue?",
  "Count all invoices this month",

  // Aggregation with discovery
  "Total revenue for hospital projects in Victoria",

  // Relationship
  "How is partner 286798 connected to other records?",

  // Explanation
  "Why did revenue drop in Q4?",

  // Comparison
  "Compare Q1 vs Q2 performance",

  // Unknown
  "Help me",
  "What?",
];
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Claude API not available" | Missing `ANTHROPIC_API_KEY` | Set environment variable |
| Low confidence on clear queries | Question patterns not recognized | Use `blendthink_diagnose` to debug |
| Session not found | Session expired or evicted | Start new session |
| Token budget exceeded | Complex multi-turn conversation | Start new session or increase budget |
| Section adapter failed | Qdrant/Odoo connectivity | Check system_status |

### Debugging with blendthink_diagnose

Always test with `blendthink_diagnose` first to understand how your query will be processed:

```json
{
  "query": "Your query here"
}
```

Check:
- Is the question type correct?
- Are entities extracted properly?
- Is the route plan sensible?
- Is the persona appropriate?
- Are there any warnings?

---

## Future Enhancements (Phase 3-4)

| Feature | Status | Description |
|---------|--------|-------------|
| Similar conversation recall | Implemented | Search past conversations semantically |
| Knowledge section | Planned | Accounting rules and domain expertise |
| Parallel section execution | Planned | Execute independent steps simultaneously |
| Structured metrics | Planned | Prometheus-compatible observability |
| Jest unit tests | Planned | Automated test coverage |

---

*End of Skill Guide*
