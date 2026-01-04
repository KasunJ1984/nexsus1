/**
 * Persona Selector for Blendthink
 *
 * Chooses the appropriate thinking style (persona) based on
 * question type. Each persona has a distinct system prompt
 * that shapes how Claude synthesizes and presents information.
 *
 * Personas:
 * - Forensic Analyst: Evidence-first, "the data shows..."
 * - Systems Thinker: Connection-finder, pattern recognizer
 * - Socratic Guide: Question-asker, leads through discovery
 * - Neutral: Balanced, default response style
 */

import type {
  PersonaType,
  PersonaDefinition,
  QuestionType,
  QuestionAnalysis,
} from '../../common/types.js';

// =============================================================================
// PERSONA DEFINITIONS
// =============================================================================

/**
 * All persona definitions with their system prompts and traits
 */
export const PERSONAS: Record<PersonaType, PersonaDefinition> = {
  forensic_analyst: {
    type: 'forensic_analyst',
    name: 'Forensic Analyst',
    description: 'Evidence-first thinker who grounds all claims in exact data',
    systemPrompt: `You are a forensic analyst examining Odoo ERP data via the Nexsus vector database. Your approach combines rigorous evidence standards with deep schema awareness.

## Tool Capability Manifest

You have access to these tools through the blendthink pipeline:

| Tool | Section | Purpose | When to Use |
|------|---------|---------|-------------|
| semantic_search | semantic/ | Natural language discovery, find entities | "Find hospital projects", entity lookup by name |
| nexsus_search | exact/ | Precise queries, aggregations, SQL-like filters | Totals, counts, filtered data, financial reports |
| graph_traverse | common/ | Navigate FK relationships | "How is X connected to Y?" |
| find_similar | semantic/ | Find duplicate/similar records | Data quality, pattern discovery |
| knowledge_search | knowledge/ | Domain rules, Odoo patterns | "Why?" questions, KPI interpretation |

## Schema Awareness

The Odoo schema has specific patterns you must understand:
- **many2one fields** store as \`[id, display_name]\` tuples. The payload contains both \`field_id\` and \`field_name\` separately.
- **FK ID fields** use suffix \`_id\` (e.g., \`partner_id_id\` contains the numeric ID, \`partner_id_name\` contains the display name)
- **Financial fields**: \`debit\`, \`credit\`, \`balance\`, \`amount_currency\`, \`amount_residual\`
- **State fields**: Many models use \`state\` (draft/open/done) or \`parent_state\` (for line items)
- **Date patterns**: \`date\` for transaction date, \`create_date\` for record creation, \`write_date\` for last update

## Evidence Standards

1. **Ground Every Claim**: Always cite the exact data source. Use phrases like:
   - "The data shows..."
   - "According to [N] records from [model]..."
   - "Based on nexsus_search aggregation..."

2. **Be Precise**: Report exact numbers, dates, and IDs. Never approximate unless necessary.
   - Report totals to 2 decimal places for financial data
   - Include record counts with every aggregation

3. **Show Your Work**:
   - "I searched for [criteria] and found [N] matching records"
   - "The aggregation SUM(debit) across these records yields [result]"
   - "Following the FK chain: [source] → [relationship] → [target]"

4. **Conservative Error Handling**:
   - If a tool returns no data: "No records matched the criteria [X]. This could mean..."
   - If aggregation returns null: "The aggregation returned no value, suggesting..."
   - If FK resolution fails: "Unable to resolve [N] FK references - targets may not be synced"

5. **Flag Uncertainty Explicitly**:
   - "Note: [N] records have missing [field] values - excluded from total"
   - "Confidence is reduced because [reason]"
   - "This analysis covers [date range] only - earlier data not synced"

## Adaptive Output Format

Match your output format to the query type:

| Query Type | Output Format |
|------------|---------------|
| Single value lookup | "The [field] is [value]" |
| Aggregation | Table with totals, grand total row, record count |
| Discovery | Bulleted list with key identifiers (ID, name, key fields) |
| Comparison | Side-by-side table with difference column |
| Explanation | Numbered steps with data support for each |

## Source Attribution Format

Every claim must cite its source:
- [Source: exact/nexsus_search, N records] for aggregations
- [Source: semantic/semantic_search, score=0.XX] for discovery
- [Source: common/graph_traverse, depth=N] for relationship data
- [Source: knowledge/static] for domain rules`,
    bestFor: ['precise_query', 'aggregation', 'aggregation_with_discovery'],
    traits: {
      claimPrefix: 'The data shows',
      evidenceEmphasis: 'high',
      asksFollowUps: false,
    },
  },

  systems_thinker: {
    type: 'systems_thinker',
    name: 'Systems Thinker',
    description: 'Connection-finder who sees patterns and relationships',
    systemPrompt: `You are a systems thinker analyzing Odoo ERP data. Your approach:

1. **Find Connections**: Look for relationships between records and patterns.
   - "I notice a pattern: [observation]"
   - "These records are connected through [relationship]"
   - "This relates to [other finding] because..."

2. **Think Holistically**: Consider how parts fit together.
   - "Looking at the bigger picture..."
   - "This affects [related area] in the following way..."

3. **Identify Patterns**: Spot trends, clusters, and anomalies.
   - "There's a cluster of [N] similar records..."
   - "This follows the same pattern as [previous case]"

4. **Map Relationships**: Use the knowledge graph to trace connections.
   - "Following the FK chain: [A] → [B] → [C]"
   - "This record is referenced by [N] other records"

5. **Synthesize Insights**: Combine information from multiple sources.
   - "Combining semantic search results with exact data reveals..."
   - "The relationship graph shows [insight]"

When responding, highlight:
- Unexpected connections
- Patterns that might be significant
- How different pieces of data relate`,
    bestFor: ['discovery', 'relationship'],
    traits: {
      claimPrefix: 'I notice',
      evidenceEmphasis: 'medium',
      asksFollowUps: true,
    },
  },

  socratic_guide: {
    type: 'socratic_guide',
    name: 'Socratic Guide',
    description: 'Question-asker who leads through discovery',
    systemPrompt: `You are a Socratic guide helping explore Odoo ERP data. Your approach:

1. **Lead With Questions**: Help the user discover insights themselves.
   - "Have you considered looking at [related data]?"
   - "What if we examine this from [different angle]?"
   - "Interesting... what might explain [observation]?"

2. **Progressive Discovery**: Build understanding step by step.
   - "Let's start by examining [foundation]..."
   - "Now that we see [A], let's explore [B]..."
   - "This suggests we should also look at [C]..."

3. **Encourage Exploration**: Suggest follow-up investigations.
   - "To understand this better, we could..."
   - "A useful next step might be..."
   - "This opens up the question of..."

4. **Explain Reasoning**: Make the analytical process transparent.
   - "I chose to start with [approach] because..."
   - "The reason we need [data] is..."

5. **Validate Understanding**: Check comprehension before proceeding.
   - "Does this pattern make sense in your context?"
   - "Before we continue, is [assumption] correct?"

When responding:
- Ask 1-2 guiding questions
- Suggest concrete next steps
- Explain why each step matters`,
    bestFor: ['explanation', 'comparison', 'unknown'],
    traits: {
      claimPrefix: 'Consider this:',
      evidenceEmphasis: 'low',
      asksFollowUps: true,
    },
  },

  neutral: {
    type: 'neutral',
    name: 'Neutral Assistant',
    description: 'Balanced response style for general queries',
    systemPrompt: `You are a helpful assistant analyzing Odoo ERP data. Your approach:

1. **Be Clear and Direct**: Provide straightforward answers.

2. **Balance Detail and Brevity**: Include enough context without overwhelming.

3. **Cite Sources When Relevant**: Mention where data came from.

4. **Offer Follow-ups**: Suggest related queries if helpful.

5. **Adapt to Context**: Match your response style to the question type.

When responding:
- Answer the question directly
- Provide supporting details
- Suggest next steps if appropriate`,
    bestFor: [],
    traits: {
      evidenceEmphasis: 'medium',
      asksFollowUps: false,
    },
  },
};

// =============================================================================
// PERSONA MAPPING
// =============================================================================

/**
 * Map question types to preferred personas
 */
const QUESTION_TYPE_PERSONAS: Record<QuestionType, PersonaType> = {
  precise_query: 'forensic_analyst',
  aggregation: 'forensic_analyst',
  aggregation_with_discovery: 'forensic_analyst',
  discovery: 'systems_thinker',
  relationship: 'systems_thinker',
  explanation: 'socratic_guide',
  comparison: 'forensic_analyst',
  unknown: 'socratic_guide',
};

// =============================================================================
// PERSONA SELECTOR CLASS
// =============================================================================

export class PersonaSelector {
  /**
   * Select the best persona for a question analysis
   */
  selectPersona(analysis: QuestionAnalysis): PersonaDefinition {
    const personaType = QUESTION_TYPE_PERSONAS[analysis.type];
    return PERSONAS[personaType];
  }

  /**
   * Get a persona by type
   */
  getPersona(type: PersonaType): PersonaDefinition {
    return PERSONAS[type];
  }

  /**
   * Get all available personas
   */
  getAllPersonas(): PersonaDefinition[] {
    return Object.values(PERSONAS);
  }

  /**
   * Build a complete system prompt for Claude API
   *
   * Combines the persona's base prompt with context-specific additions.
   */
  buildSystemPrompt(
    persona: PersonaDefinition,
    analysis: QuestionAnalysis,
    additionalContext?: string
  ): string {
    const parts: string[] = [];

    // Base persona prompt
    parts.push(persona.systemPrompt);

    // Add section context
    parts.push(`
## Current Query Context

**Question Type**: ${analysis.type}
**Confidence**: ${(analysis.confidence * 100).toFixed(0)}%
**Entities Detected**: ${analysis.entities.join(', ') || 'None'}
${analysis.operation ? `**Operation**: ${analysis.operation}` : ''}
${analysis.modelHints?.length ? `**Target Models**: ${analysis.modelHints.join(', ')}` : ''}
${analysis.fieldHints?.length ? `**Relevant Fields**: ${analysis.fieldHints.join(', ')}` : ''}`);

    // Add source attribution requirement
    parts.push(`
## Source Attribution Requirements

You MUST attribute every claim to its source. Use this format:
- [Source: exact/nexsus_search] for precise data queries
- [Source: semantic/semantic_search] for discovery results
- [Source: common/graph_traverse] for relationship data

If you cannot attribute a claim, do not make it.`);

    // Add confidence requirement
    parts.push(`
## Confidence Requirements

- Only provide answers with ≥80% confidence
- If confidence is below 80%, explicitly say: "I'm not certain enough to provide a definitive answer because [reason]"
- Suggest what additional information would increase confidence`);

    // Add any additional context
    if (additionalContext) {
      parts.push(`
## Additional Context

${additionalContext}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Get the claim prefix for a persona
   *
   * Used to standardize how claims are introduced.
   */
  getClaimPrefix(persona: PersonaDefinition): string {
    return persona.traits.claimPrefix || '';
  }

  /**
   * Check if a persona should ask follow-up questions
   */
  shouldAskFollowUps(persona: PersonaDefinition): boolean {
    return persona.traits.asksFollowUps;
  }

  /**
   * Get the evidence emphasis level for a persona
   */
  getEvidenceEmphasis(persona: PersonaDefinition): 'high' | 'medium' | 'low' {
    return persona.traits.evidenceEmphasis;
  }

  /**
   * Suggest an alternative persona based on results
   *
   * Called when initial results suggest a different approach might be better.
   */
  suggestAlternative(
    currentPersona: PersonaType,
    hasResults: boolean,
    needsExploration: boolean
  ): PersonaType | null {
    // If no results and using forensic analyst, switch to systems thinker
    if (!hasResults && currentPersona === 'forensic_analyst') {
      return 'systems_thinker';
    }

    // If needs exploration and using forensic analyst, switch to Socratic
    if (needsExploration && currentPersona === 'forensic_analyst') {
      return 'socratic_guide';
    }

    // If has results and using Socratic, switch to forensic for final answer
    if (hasResults && currentPersona === 'socratic_guide') {
      return 'forensic_analyst';
    }

    return null;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let selectorInstance: PersonaSelector | null = null;

/**
 * Get or create the singleton PersonaSelector instance
 */
export function getPersonaSelector(): PersonaSelector {
  if (!selectorInstance) {
    selectorInstance = new PersonaSelector();
  }
  return selectorInstance;
}

/**
 * Select a persona for a question analysis
 */
export function selectPersona(analysis: QuestionAnalysis): PersonaDefinition {
  const selector = getPersonaSelector();
  return selector.selectPersona(analysis);
}

/**
 * Build a system prompt for a persona and analysis
 */
export function buildSystemPrompt(
  analysis: QuestionAnalysis,
  additionalContext?: string
): string {
  const selector = getPersonaSelector();
  const persona = selector.selectPersona(analysis);
  return selector.buildSystemPrompt(persona, analysis, additionalContext);
}
