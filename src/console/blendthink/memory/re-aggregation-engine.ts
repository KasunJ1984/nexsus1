/**
 * Re-Aggregation Engine
 *
 * Performs aggregation operations on in-memory records.
 * Used by DrilldownHandler to re-aggregate cached data
 * without querying Qdrant.
 *
 * Operations:
 * - sum: Total of numeric values
 * - count: Number of records
 * - avg: Average of numeric values
 * - min: Minimum value
 * - max: Maximum value
 *
 * Performance target: <100ms for 10,000 records
 */

import type { FilterCondition, Aggregation } from '../../../common/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Grouped aggregation result
 */
export interface GroupedResult {
  /** Group key values */
  [key: string]: unknown;
}

// =============================================================================
// FILTER FUNCTIONS
// =============================================================================

/**
 * Apply a single filter to records
 */
export function applyFilter(
  records: Record<string, unknown>[],
  filter: FilterCondition
): Record<string, unknown>[] {
  const { field, op, value } = filter;

  return records.filter(record => {
    const recordValue = record[field];

    switch (op) {
      case 'eq':
        return recordValue === value;

      case 'neq':
        return recordValue !== value;

      case 'gt':
        if (typeof recordValue === 'number' && typeof value === 'number') {
          return recordValue > value;
        }
        return String(recordValue) > String(value);

      case 'gte':
        if (typeof recordValue === 'number' && typeof value === 'number') {
          return recordValue >= value;
        }
        return String(recordValue) >= String(value);

      case 'lt':
        if (typeof recordValue === 'number' && typeof value === 'number') {
          return recordValue < value;
        }
        return String(recordValue) < String(value);

      case 'lte':
        if (typeof recordValue === 'number' && typeof value === 'number') {
          return recordValue <= value;
        }
        return String(recordValue) <= String(value);

      case 'in':
        if (Array.isArray(value)) {
          return value.includes(recordValue);
        }
        return false;

      case 'contains':
        if (typeof recordValue === 'string' && typeof value === 'string') {
          return recordValue.toLowerCase().includes(value.toLowerCase());
        }
        return false;

      default:
        console.error(`[ReAggregationEngine] Unknown filter op: ${op}`);
        return true;
    }
  });
}

/**
 * Apply multiple filters to records (AND logic)
 */
export function applyFilters(
  records: Record<string, unknown>[],
  filters: FilterCondition[]
): Record<string, unknown>[] {
  let result = records;

  for (const filter of filters) {
    result = applyFilter(result, filter);
  }

  return result;
}

// =============================================================================
// AGGREGATION FUNCTIONS
// =============================================================================

/**
 * Compute a single aggregation on a set of values
 */
function computeAggregation(
  values: unknown[],
  op: 'sum' | 'count' | 'avg' | 'min' | 'max'
): number {
  // Filter to numeric values for numeric operations
  const numericValues = values
    .filter(v => typeof v === 'number' && !isNaN(v))
    .map(v => v as number);

  switch (op) {
    case 'count':
      return values.length;

    case 'sum':
      return numericValues.reduce((a, b) => a + b, 0);

    case 'avg':
      if (numericValues.length === 0) return 0;
      return numericValues.reduce((a, b) => a + b, 0) / numericValues.length;

    case 'min':
      if (numericValues.length === 0) return 0;
      return Math.min(...numericValues);

    case 'max':
      if (numericValues.length === 0) return 0;
      return Math.max(...numericValues);

    default:
      console.error(`[ReAggregationEngine] Unknown aggregation op: ${op}`);
      return 0;
  }
}

/**
 * Build a group key from record and group-by fields
 */
function buildGroupKey(record: Record<string, unknown>, groupBy: string[]): string {
  const keyParts = groupBy.map(field => {
    const value = record[field];
    // Handle null/undefined
    if (value == null) return '__NULL__';
    // Handle objects (like dates)
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
  return keyParts.join('|');
}

/**
 * Parse a group key back to field values
 */
function parseGroupKey(key: string, groupBy: string[]): Record<string, unknown> {
  const parts = key.split('|');
  const result: Record<string, unknown> = {};

  for (let i = 0; i < groupBy.length; i++) {
    const value = parts[i];
    if (value === '__NULL__') {
      result[groupBy[i]] = null;
    } else {
      // Try to parse as number
      const num = Number(value);
      result[groupBy[i]] = isNaN(num) ? value : num;
    }
  }

  return result;
}

// =============================================================================
// MAIN RE-AGGREGATION FUNCTION
// =============================================================================

/**
 * Re-aggregate records with new GROUP BY and aggregations
 *
 * @param records - Records to aggregate
 * @param groupBy - Fields to group by (empty for grand total)
 * @param filters - Additional filters to apply first
 * @param aggregations - Aggregations to compute
 * @returns Array of grouped results with aggregation values
 */
export function reAggregate(
  records: Record<string, unknown>[],
  groupBy: string[],
  filters: FilterCondition[],
  aggregations: Aggregation[]
): Record<string, unknown>[] {
  const startTime = Date.now();
  console.error(`[ReAggregationEngine] Re-aggregating ${records.length} records, group by: [${groupBy.join(', ')}]`);

  // Apply filters first
  let filteredRecords = records;
  if (filters.length > 0) {
    filteredRecords = applyFilters(records, filters);
    console.error(`[ReAggregationEngine] After filters: ${filteredRecords.length} records`);
  }

  // If no GROUP BY, compute grand totals
  if (groupBy.length === 0) {
    const result: Record<string, unknown> = {};

    for (const agg of aggregations) {
      const values = filteredRecords.map(r => r[agg.field]);
      result[agg.alias] = computeAggregation(values, agg.op);
    }

    // Add record count
    result._count = filteredRecords.length;

    console.error(`[ReAggregationEngine] Grand total computed in ${Date.now() - startTime}ms`);
    return [result];
  }

  // Group records by the GROUP BY fields
  const groups = new Map<string, Record<string, unknown>[]>();

  for (const record of filteredRecords) {
    const key = buildGroupKey(record, groupBy);
    const group = groups.get(key);
    if (group) {
      group.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  console.error(`[ReAggregationEngine] Created ${groups.size} groups`);

  // Compute aggregations for each group
  const results: Record<string, unknown>[] = [];

  for (const [key, groupRecords] of groups) {
    // Start with group key values
    const result = parseGroupKey(key, groupBy);

    // Compute each aggregation
    for (const agg of aggregations) {
      const values = groupRecords.map(r => r[agg.field]);
      result[agg.alias] = computeAggregation(values, agg.op);
    }

    // Add record count for this group
    result._count = groupRecords.length;

    results.push(result);
  }

  // Sort by first aggregation descending (most common use case)
  if (aggregations.length > 0) {
    const sortField = aggregations[0].alias;
    results.sort((a, b) => {
      const aVal = a[sortField] as number || 0;
      const bVal = b[sortField] as number || 0;
      return bVal - aVal;
    });
  }

  const elapsed = Date.now() - startTime;
  console.error(`[ReAggregationEngine] Completed in ${elapsed}ms: ${results.length} groups`);

  return results;
}

// =============================================================================
// AUTO-DETECT AGGREGATIONS
// =============================================================================

/**
 * Auto-detect appropriate aggregations based on field types
 * Used when no explicit aggregations provided
 */
export function detectAggregations(
  records: Record<string, unknown>[],
  sampleSize: number = 100
): Aggregation[] {
  if (records.length === 0) return [];

  const aggregations: Aggregation[] = [];
  const sample = records.slice(0, sampleSize);

  // Find numeric fields
  const numericFields: string[] = [];

  for (const field of Object.keys(sample[0])) {
    // Skip system/internal fields
    if (field.startsWith('_') || field.endsWith('_id')) continue;

    // Check if field is numeric across samples
    const values = sample.map(r => r[field]).filter(v => v != null);
    const numericCount = values.filter(v => typeof v === 'number').length;

    if (numericCount > values.length * 0.8) {
      numericFields.push(field);
    }
  }

  // Create SUM aggregations for common financial fields
  const financialFields = ['debit', 'credit', 'balance', 'amount_total', 'expected_revenue', 'price_total'];
  for (const field of financialFields) {
    if (numericFields.includes(field)) {
      aggregations.push({
        field,
        op: 'sum',
        alias: `total_${field}`,
      });
    }
  }

  // Always add COUNT
  aggregations.push({
    field: 'id',
    op: 'count',
    alias: 'record_count',
  });

  console.error(`[ReAggregationEngine] Auto-detected ${aggregations.length} aggregations`);
  return aggregations;
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

/**
 * Sort records by a field
 */
export function sortRecords(
  records: Record<string, unknown>[],
  field: string,
  direction: 'asc' | 'desc' = 'desc'
): Record<string, unknown>[] {
  return [...records].sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];

    // Handle nulls
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return direction === 'asc' ? -1 : 1;
    if (bVal == null) return direction === 'asc' ? 1 : -1;

    // Compare
    let comparison = 0;
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      comparison = aVal - bVal;
    } else {
      comparison = String(aVal).localeCompare(String(bVal));
    }

    return direction === 'asc' ? comparison : -comparison;
  });
}

/**
 * Get top N records by a field
 */
export function topN(
  records: Record<string, unknown>[],
  field: string,
  n: number,
  direction: 'asc' | 'desc' = 'desc'
): Record<string, unknown>[] {
  return sortRecords(records, field, direction).slice(0, n);
}
