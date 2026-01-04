/**
 * Knowledge Enricher
 *
 * Adds implicit filters and aggregation hints based on domain knowledge.
 * This provides the "expert knowledge" that a human accountant/analyst would apply.
 *
 * Domain Rules:
 * - Financial: Filter parent_state='posted', use SUM(debit) for expenses
 * - CRM: Filter active=true for non-archive queries
 * - HR: Filter active=true for current employees
 *
 * Note: This is a rules-based implementation. Future versions could
 * query a knowledge layer in Qdrant for more dynamic rules.
 */

import type { FilterCondition, Aggregation } from '../../../common/types.js';
import type { Domain } from './model-finder.js';
import type { ImplicitFilter, AggregationHint } from './types.js';

// =============================================================================
// DOMAIN-SPECIFIC RULES
// =============================================================================

/**
 * Implicit filter rules for each domain
 * These are filters that an expert would know to apply
 */
const IMPLICIT_FILTER_RULES: Record<
  Domain,
  Array<{
    condition: (query: string, modelName?: string) => boolean;
    filter: FilterCondition;
    reason: string;
    rule: string;
  }>
> = {
  financial: [
    {
      // For account.move.line: filter by parent_state (references parent invoice state)
      condition: (query, modelName) => modelName === 'account.move.line',
      filter: { field: 'parent_state', op: 'eq', value: 'posted' },
      reason: 'Only posted journal entries count in financial reports',
      rule: 'accounting_line_posted_only',
    },
    {
      // For account.move: filter by state directly (the invoice's own state)
      condition: (query, modelName) => modelName === 'account.move',
      filter: { field: 'state', op: 'eq', value: 'posted' },
      reason: 'Only posted invoices/bills count in financial reports',
      rule: 'accounting_move_posted_only',
    },
  ],
  crm: [
    {
      // Filter to active leads unless asking about archived
      condition: (query) =>
        !query.toLowerCase().includes('archive') &&
        !query.toLowerCase().includes('inactive') &&
        !query.toLowerCase().includes('all'),
      filter: { field: 'active', op: 'eq', value: true },
      reason: 'Archived leads excluded by default',
      rule: 'crm_active_only',
    },
  ],
  hr: [
    {
      // Filter to active employees unless asking about former
      condition: (query) =>
        !query.toLowerCase().includes('former') &&
        !query.toLowerCase().includes('terminated') &&
        !query.toLowerCase().includes('inactive') &&
        !query.toLowerCase().includes('all'),
      filter: { field: 'active', op: 'eq', value: true },
      reason: 'Only current employees included by default',
      rule: 'hr_active_employees',
    },
  ],
  inventory: [
    {
      // Filter to available products by default
      condition: (query) =>
        !query.toLowerCase().includes('archived') &&
        !query.toLowerCase().includes('inactive') &&
        !query.toLowerCase().includes('all'),
      filter: { field: 'active', op: 'eq', value: true },
      reason: 'Archived products excluded by default',
      rule: 'inventory_active_products',
    },
  ],
  general: [],
};

/**
 * Aggregation hints based on domain and query context
 */
const AGGREGATION_HINT_RULES: Record<
  Domain,
  Array<{
    condition: (query: string, modelName?: string) => boolean;
    aggregation: Aggregation;
    reason: string;
    confidence: number;
  }>
> = {
  financial: [
    {
      // Expense queries should sum debits
      condition: (query) =>
        /\b(expense|cost|spending|spend)\b/i.test(query) &&
        !/\bcredit\b/i.test(query),
      aggregation: { field: 'debit', op: 'sum', alias: 'total_expense' },
      reason: 'Expenses are recorded as debits in double-entry accounting',
      confidence: 0.9,
    },
    {
      // Revenue queries should sum credits
      condition: (query) =>
        /\b(revenue|income|sales|earn)\b/i.test(query) &&
        !/\bdebit\b/i.test(query),
      aggregation: { field: 'credit', op: 'sum', alias: 'total_revenue' },
      reason: 'Revenue is recorded as credits in double-entry accounting',
      confidence: 0.9,
    },
    {
      // Balance queries need both
      condition: (query) => /\bbalance\b/i.test(query),
      aggregation: { field: 'balance', op: 'sum', alias: 'net_balance' },
      reason: 'Balance = debits - credits',
      confidence: 0.85,
    },
    {
      // Count of entries/transactions
      condition: (query) =>
        /\b(how many|count|number of)\b/i.test(query) &&
        /\b(entries|transactions|lines|moves)\b/i.test(query),
      aggregation: { field: 'id', op: 'count', alias: 'entry_count' },
      reason: 'Counting journal entries/lines',
      confidence: 0.95,
    },
  ],
  crm: [
    {
      // Revenue queries should sum expected revenue
      condition: (query) =>
        /\b(revenue|value|worth|pipeline)\b/i.test(query),
      aggregation: { field: 'expected_revenue', op: 'sum', alias: 'total_revenue' },
      reason: 'CRM expected_revenue represents potential deal value',
      confidence: 0.85,
    },
    {
      // Count leads/opportunities
      condition: (query) =>
        /\b(how many|count|number of)\b/i.test(query) &&
        /\b(leads?|opportunities|deals?)\b/i.test(query),
      aggregation: { field: 'id', op: 'count', alias: 'lead_count' },
      reason: 'Counting CRM leads/opportunities',
      confidence: 0.95,
    },
    {
      // Average probability
      condition: (query) => /\b(average|avg|mean)\b/i.test(query) && /\b(probability|chance)\b/i.test(query),
      aggregation: { field: 'probability', op: 'avg', alias: 'avg_probability' },
      reason: 'Average win probability across leads',
      confidence: 0.9,
    },
  ],
  hr: [
    {
      // Count employees
      condition: (query) =>
        /\b(how many|count|number of|total)\b/i.test(query) &&
        /\b(employee|staff|people|workers?)\b/i.test(query),
      aggregation: { field: 'id', op: 'count', alias: 'employee_count' },
      reason: 'Counting employees',
      confidence: 0.95,
    },
  ],
  inventory: [
    {
      // Sum quantity
      condition: (query) =>
        /\b(total|sum)\b/i.test(query) && /\b(stock|quantity|inventory)\b/i.test(query),
      aggregation: { field: 'quantity', op: 'sum', alias: 'total_quantity' },
      reason: 'Total inventory quantity',
      confidence: 0.9,
    },
    {
      // Count products
      condition: (query) =>
        /\b(how many|count|number of)\b/i.test(query) &&
        /\b(products?|items?|skus?)\b/i.test(query),
      aggregation: { field: 'id', op: 'count', alias: 'product_count' },
      reason: 'Counting products',
      confidence: 0.95,
    },
  ],
  general: [],
};

// =============================================================================
// MAIN ENRICHER FUNCTIONS
// =============================================================================

/**
 * Get implicit filters based on domain and context
 *
 * @param domain - The detected domain
 * @param query - The original query text
 * @param modelName - The resolved model name (if any)
 * @returns Array of implicit filters to apply
 */
export function getImplicitFilters(
  domain: Domain,
  query: string,
  modelName?: string
): ImplicitFilter[] {
  const rules = IMPLICIT_FILTER_RULES[domain] || [];
  const applicableFilters: ImplicitFilter[] = [];

  for (const rule of rules) {
    if (rule.condition(query, modelName)) {
      applicableFilters.push({
        filter: rule.filter,
        reason: rule.reason,
        rule: rule.rule,
        domain,
      });
      console.error(`[KnowledgeEnricher] Applied rule: ${rule.rule}`);
    }
  }

  return applicableFilters;
}

/**
 * Get aggregation hints based on domain and query context
 *
 * @param domain - The detected domain
 * @param query - The original query text
 * @param modelName - The resolved model name (if any)
 * @returns Array of suggested aggregations
 */
export function getAggregationHints(
  domain: Domain,
  query: string,
  modelName?: string
): AggregationHint[] {
  const rules = AGGREGATION_HINT_RULES[domain] || [];
  const hints: AggregationHint[] = [];

  for (const rule of rules) {
    if (rule.condition(query, modelName)) {
      hints.push({
        aggregation: rule.aggregation,
        reason: rule.reason,
        confidence: rule.confidence,
      });
      console.error(
        `[KnowledgeEnricher] Suggested aggregation: ${rule.aggregation.op}(${rule.aggregation.field})`
      );
    }
  }

  // Sort by confidence
  hints.sort((a, b) => b.confidence - a.confidence);

  return hints;
}

/**
 * Enrich the analysis with knowledge layer insights
 *
 * @param domain - The detected domain
 * @param query - The original query text
 * @param modelName - The resolved model name (if any)
 * @returns Object with implicit filters and aggregation hints
 */
export function enrichWithKnowledge(
  domain: Domain,
  query: string,
  modelName?: string
): {
  implicitFilters: ImplicitFilter[];
  aggregationHints: AggregationHint[];
} {
  console.error(`[KnowledgeEnricher] Enriching for domain: ${domain}, model: ${modelName}`);

  const implicitFilters = getImplicitFilters(domain, query, modelName);
  const aggregationHints = getAggregationHints(domain, query, modelName);

  console.error(
    `[KnowledgeEnricher] Applied ${implicitFilters.length} filters, ${aggregationHints.length} hints`
  );

  return {
    implicitFilters,
    aggregationHints,
  };
}

/**
 * Check if a filter is already present in the list
 */
export function isFilterPresent(
  filters: FilterCondition[],
  newFilter: FilterCondition
): boolean {
  return filters.some(
    (f) =>
      f.field === newFilter.field &&
      f.op === newFilter.op &&
      JSON.stringify(f.value) === JSON.stringify(newFilter.value)
  );
}

/**
 * Merge implicit filters with existing filters (avoiding duplicates)
 */
export function mergeFilters(
  existingFilters: FilterCondition[],
  implicitFilters: ImplicitFilter[]
): FilterCondition[] {
  const merged = [...existingFilters];

  for (const implicit of implicitFilters) {
    if (!isFilterPresent(merged, implicit.filter)) {
      merged.push(implicit.filter);
    }
  }

  return merged;
}
