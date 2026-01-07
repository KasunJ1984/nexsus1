/**
 * Aggregation Engine for Exact Queries
 *
 * Streams through Qdrant records and computes aggregations efficiently.
 * Designed for financial reporting accuracy - must match Odoo Trial Balance.
 *
 * Key features:
 * - Memory-efficient streaming (never loads all records)
 * - Supports SUM, COUNT, AVG, MIN, MAX
 * - GROUP BY support for multi-dimensional analysis
 * - Safety limits to prevent runaway queries
 *
 * Example use case:
 * "What is the total debit/credit for GL account 61181 in March 2025?"
 */

import { getQdrantClient } from '../../common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';
import { QdrantFilter, AppLevelFilter } from '../../common/services/filter-builder.js';
import { Aggregation, AggregatorState, AggregationResult, createReconciliationChecksum } from '../../common/types.js';

/**
 * Default batch size for streaming through Qdrant
 */
const AGGREGATION_BATCH_SIZE = 1000;

/**
 * No default maximum - process ALL matching records for accurate aggregations
 * For large datasets, use detail_level="summary" or export_to_file=true
 */
const DEFAULT_MAX_RECORDS = undefined;

/**
 * Execute aggregation query with streaming
 *
 * Streams through all matching records, computing aggregations in-flight.
 * Memory usage is O(number of groups), not O(number of records).
 *
 * @param filter - Qdrant filter from buildQdrantFilter()
 * @param aggregations - Array of aggregation definitions
 * @param groupBy - Optional fields to group by
 * @param maxRecords - Maximum records to process (safety limit)
 * @returns AggregationResult with computed values
 *
 * @example
 * ```typescript
 * const filter = buildQdrantFilter("account.move.line", [
 *   { field: "account_id_id", op: "eq", value: 319 },
 *   { field: "date", op: "gte", value: "2025-03-01" },
 *   { field: "parent_state", op: "eq", value: "posted" }
 * ]);
 *
 * const result = await executeAggregation(filter, [
 *   { field: "debit", op: "sum", alias: "total_debit" },
 *   { field: "credit", op: "sum", alias: "total_credit" },
 *   { field: "id", op: "count", alias: "line_count" }
 * ]);
 * // result.results = { total_debit: 1234.56, total_credit: 0, line_count: 15 }
 * ```
 */
export async function executeAggregation(
  filter: QdrantFilter,
  aggregations: Aggregation[],
  groupBy?: string[],
  maxRecords?: number,  // undefined = no limit (process ALL records)
  appFilters?: AppLevelFilter[]
): Promise<AggregationResult> {
  const qdrant = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Deep clone the filter to avoid mutating the original
  // This is critical because the same filter object may be reused across multiple calls
  const workingFilter: QdrantFilter = {
    must: [...(filter.must || [])],
    must_not: filter.must_not ? [...filter.must_not] : undefined,
    should: filter.should ? [...filter.should] : undefined,
  };

  // Add point_type filter for unified collection (data records only)
  const hasPointTypeFilter = workingFilter.must!.some(
    (f: { key?: string }) => f.key === 'point_type'
  );
  if (!hasPointTypeFilter) {
    workingFilter.must!.push({ key: 'point_type', match: { value: 'data' } });
  }

  // Initialize global accumulator (for non-grouped queries)
  const globalState = createEmptyState(aggregations);

  // Group accumulators (for GROUP BY queries)
  const groupStates = new Map<string, AggregatorState>();

  // Counters
  let totalScanned = 0;   // All records from Qdrant (before filtering)
  let totalRecords = 0;   // Records that passed app-level filters
  let truncated = false;
  let appFilterDebugCount = 0;  // For debug logging (first 5 comparisons)

  // Qdrant scroll cursor (can be string, number, or object)
  let scrollOffset: string | number | Record<string, unknown> | null = null;

  console.error(`[Aggregation] Starting aggregation: ${aggregations.length} aggs, groupBy=${groupBy?.join(',') || 'none'}`);

  // Stream through all matching records
  do {
    // Build scroll params
    const scrollParams: {
      filter: QdrantFilter;
      limit: number;
      offset?: string | number;
      with_payload: boolean;
      with_vector: boolean;
    } = {
      filter: workingFilter,
      limit: AGGREGATION_BATCH_SIZE,
      with_payload: true,
      with_vector: false
    };

    if (scrollOffset !== null) {
      // Cast to expected type - Qdrant accepts the same value it returns
      scrollParams.offset = scrollOffset as string | number;
    }

    // Fetch batch
    const batch = await qdrant.scroll(collectionName, scrollParams);

    // Process each record
    for (const point of batch.points) {
      totalScanned++;
      const payload = point.payload as Record<string, unknown>;

      // Apply application-level filters (for date ranges on keyword fields)
      if (appFilters && appFilters.length > 0) {
        // Debug: Log first 5 date comparisons to diagnose filtering
        if (appFilterDebugCount < 5) {
          for (const af of appFilters) {
            console.error(`[AppFilter DEBUG] record_id=${payload['id'] || payload['record_id']}, field=${af.field}, payloadValue="${payload[af.field]}", op=${af.op}, filterValue="${af.value}"`);
          }
          appFilterDebugCount++;
        }

        if (!passesAppFilters(payload, appFilters)) {
          continue; // Skip this record
        }
      }

      // Determine target state (global or group-specific)
      let targetState: AggregatorState;

      if (groupBy && groupBy.length > 0) {
        // Build group key from field values
        const groupKey = buildGroupKey(payload, groupBy);

        // Get or create group state
        if (!groupStates.has(groupKey)) {
          groupStates.set(groupKey, createEmptyState(aggregations));
        }
        targetState = groupStates.get(groupKey)!;
      } else {
        targetState = globalState;
      }

      // Update accumulators for each aggregation
      for (const agg of aggregations) {
        const fieldValue = payload[agg.field];
        updateAccumulator(targetState, agg, fieldValue);
      }

      totalRecords++;
    }

    // Update cursor
    scrollOffset = batch.next_page_offset ?? null;

    // Safety limit check (only if maxRecords specified)
    if (maxRecords !== undefined && totalRecords >= maxRecords) {
      truncated = true;
      console.error(`[Aggregation] Safety limit reached: ${maxRecords} records`);
      break;
    }

    // Log progress every 10K records scanned
    if (totalScanned % 10000 === 0 && totalScanned > 0) {
      console.error(`[Aggregation] Progress: scanned=${totalScanned.toLocaleString()}, matched=${totalRecords.toLocaleString()}`);
    }
  } while (scrollOffset !== null);

  console.error(`[Aggregation] Complete: scanned=${totalScanned.toLocaleString()}, matched=${totalRecords.toLocaleString()}, groups=${groupStates.size}`);

  // Compute final results
  const results = computeFinalResults(globalState, aggregations);

  // Compute group results if grouped
  let groups: Array<{ key: Record<string, unknown>; values: Record<string, number> }> | undefined;

  if (groupBy && groupBy.length > 0 && groupStates.size > 0) {
    groups = [];
    for (const [keyStr, groupState] of groupStates) {
      // Parse key back to object
      const key = parseGroupKey(keyStr, groupBy);
      const values = computeFinalResults(groupState, aggregations);
      groups.push({ key, values });
    }

    // Sort groups by first group-by field
    groups.sort((a, b) => {
      const aVal = String(a.key[groupBy[0]] ?? '');
      const bVal = String(b.key[groupBy[0]] ?? '');
      return aVal.localeCompare(bVal);
    });
  }

  // Token Limitation Stage 3: Generate reconciliation checksum
  // Use primary (first) aggregation for checksum
  const primaryAgg = aggregations[0];
  let grandTotal: number;

  if (groups && groups.length > 0) {
    // Grouped: sum across all groups
    grandTotal = groups.reduce((sum, g) => sum + (g.values[primaryAgg.alias] ?? 0), 0);
  } else {
    // Simple: use direct result
    grandTotal = results[primaryAgg.alias] ?? 0;
  }

  const reconciliation = createReconciliationChecksum(
    grandTotal,
    totalRecords,
    primaryAgg.field,
    primaryAgg.op
  );

  return {
    results,
    groups,
    totalRecords,
    truncated,
    reconciliation
  };
}

/**
 * Create empty aggregator state for a set of aggregations
 */
function createEmptyState(aggregations: Aggregation[]): AggregatorState {
  const state: AggregatorState = {
    sums: {},
    counts: {},
    mins: {},
    maxs: {}
  };

  for (const agg of aggregations) {
    state.sums[agg.alias] = 0;
    state.counts[agg.alias] = 0;
    state.mins[agg.alias] = Infinity;
    state.maxs[agg.alias] = -Infinity;
  }

  return state;
}

/**
 * Update accumulator with a new value
 *
 * Handles type coercion and null/undefined values gracefully.
 */
function updateAccumulator(
  state: AggregatorState,
  agg: Aggregation,
  value: unknown
): void {
  const { alias, op, field } = agg;

  // COUNT always increments (counts records, not values)
  if (op === 'count') {
    state.counts[alias]++;
    return;
  }

  // For numeric operations, skip null/undefined/non-numeric
  if (value === null || value === undefined) {
    return;
  }

  // Try to convert to number
  let numValue: number;

  if (typeof value === 'number') {
    numValue = value;
  } else if (typeof value === 'string') {
    // Try parsing string as number (e.g., "123.45")
    numValue = parseFloat(value);
    if (isNaN(numValue)) {
      return; // Skip non-numeric strings
    }
  } else {
    return; // Skip other types
  }

  // Update appropriate accumulator
  switch (op) {
    case 'sum':
      state.sums[alias] += numValue;
      state.counts[alias]++;  // Track count for debugging
      break;

    case 'avg':
      state.sums[alias] += numValue;
      state.counts[alias]++;  // Needed to compute average
      break;

    case 'min':
      if (numValue < state.mins[alias]) {
        state.mins[alias] = numValue;
      }
      state.counts[alias]++;  // Track that we found at least one value
      break;

    case 'max':
      if (numValue > state.maxs[alias]) {
        state.maxs[alias] = numValue;
      }
      state.counts[alias]++;  // Track that we found at least one value
      break;
  }
}

/**
 * Compute final results from accumulator state
 */
function computeFinalResults(
  state: AggregatorState,
  aggregations: Aggregation[]
): Record<string, number> {
  const results: Record<string, number> = {};

  for (const agg of aggregations) {
    const { alias, op } = agg;

    switch (op) {
      case 'sum':
        results[alias] = state.sums[alias];
        break;

      case 'count':
        results[alias] = state.counts[alias];
        break;

      case 'avg':
        // Average = sum / count (handle division by zero)
        if (state.counts[alias] > 0) {
          results[alias] = state.sums[alias] / state.counts[alias];
        } else {
          results[alias] = 0;
        }
        break;

      case 'min':
        // Return 0 if no values found (Infinity means no data)
        results[alias] = state.mins[alias] === Infinity ? 0 : state.mins[alias];
        break;

      case 'max':
        // Return 0 if no values found (-Infinity means no data)
        results[alias] = state.maxs[alias] === -Infinity ? 0 : state.maxs[alias];
        break;
    }
  }

  return results;
}

/**
 * Build a group key string from payload fields
 *
 * Converts field values to a pipe-separated string for use as map key.
 * Example: groupBy=["account_id_id", "journal_id_id"] → "319|10"
 *
 * Handles JSON object fields (like analytic_distribution) by stringifying them.
 * Example: groupBy=["analytic_distribution"] → '{"5029":100}'
 */
function buildGroupKey(
  payload: Record<string, unknown>,
  groupBy: string[]
): string {
  return groupBy.map(field => {
    let value: unknown;

    // Handle linked field paths: "_linked.Account_id.F1"
    if (field.startsWith('_linked.')) {
      const parts = field.split('.');
      // parts = ["_linked", "Account_id", "F1"]
      const linkField = parts[1];  // "Account_id"
      const targetField = parts[2]; // "F1"

      const linked = payload._linked as Record<string, { data?: Record<string, unknown> }> | undefined;
      value = linked?.[linkField]?.data?.[targetField];
    } else {
      value = payload[field];
    }

    if (value === null || value === undefined) {
      return 'null';
    }
    // Handle objects (JSON fields) by stringifying them
    // This prevents [object Object] from being used as the key
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }).join('|');
}

/**
 * Parse a group key string back to an object
 *
 * Handles JSON object fields by detecting and parsing JSON strings.
 * Example: '{"5029":100}' → { "5029": 100 }
 */
function parseGroupKey(
  keyStr: string,
  groupBy: string[]
): Record<string, unknown> {
  const parts = keyStr.split('|');
  const key: Record<string, unknown> = {};

  for (let i = 0; i < groupBy.length; i++) {
    const fieldName = groupBy[i];
    const valueStr = parts[i] ?? 'null';

    if (valueStr === 'null') {
      key[fieldName] = null;
    } else {
      // Try to parse as JSON first (for object values like analytic_distribution)
      if (valueStr.startsWith('{') || valueStr.startsWith('[')) {
        try {
          key[fieldName] = JSON.parse(valueStr);
          continue;
        } catch {
          // Not valid JSON, fall through to number/string handling
        }
      }
      // Try to restore numeric values
      const numValue = parseFloat(valueStr);
      key[fieldName] = isNaN(numValue) ? valueStr : numValue;
    }
  }

  return key;
}

/**
 * Quick count aggregation (optimized for count-only queries)
 *
 * Uses Qdrant's native count API which is more efficient than scrolling.
 *
 * @param filter - Qdrant filter
 * @returns Record count
 */
export async function countOnly(filter: QdrantFilter): Promise<number> {
  const qdrant = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Deep clone the filter to avoid mutating the original
  const workingFilter: QdrantFilter = {
    must: [...(filter.must || [])],
    must_not: filter.must_not ? [...filter.must_not] : undefined,
    should: filter.should ? [...filter.should] : undefined,
  };

  // Add point_type filter for unified collection (data records only)
  const hasPointTypeFilter = workingFilter.must!.some(
    (f: { key?: string }) => f.key === 'point_type'
  );
  if (!hasPointTypeFilter) {
    workingFilter.must!.push({ key: 'point_type', match: { value: 'data' } });
  }

  const result = await qdrant.count(collectionName, {
    filter: workingFilter,
    exact: true
  });

  return result.count;
}

/**
 * Check if a payload passes all application-level filters
 *
 * Used for filtering on fields that Qdrant can't filter natively:
 * - Range filtering on keyword-indexed string fields (dates)
 * - Boolean equality filtering on unindexed boolean fields
 */
function passesAppFilters(
  payload: Record<string, unknown>,
  filters: AppLevelFilter[]
): boolean {
  for (const filter of filters) {
    const value = payload[filter.field];

    // Skip if field doesn't exist
    if (value === null || value === undefined) {
      return false;
    }

    // Boolean comparison (for unindexed boolean fields)
    if (filter.fieldType === 'boolean' || typeof value === 'boolean') {
      // Normalize both values to boolean
      const payloadBool = value === true || value === 'true' || value === 1 || value === '1';
      const filterBool = filter.value === true || filter.value === 'true';

      if (filter.op === 'eq' && payloadBool !== filterBool) return false;
      if (filter.op === 'neq' && payloadBool === filterBool) return false;
      continue;
    }

    const strValue = String(value);
    const filterValue = String(filter.value);

    // String comparison (lexicographic for dates in YYYY-MM-DD format)
    switch (filter.op) {
      case 'gte':
        if (strValue < filterValue) return false;
        break;
      case 'gt':
        if (strValue <= filterValue) return false;
        break;
      case 'lte':
        if (strValue > filterValue) return false;
        break;
      case 'lt':
        if (strValue >= filterValue) return false;
        break;
      case 'eq':
        if (strValue !== filterValue) return false;
        break;
      case 'neq':
        if (strValue === filterValue) return false;
        break;
    }
  }

  return true;
}

// =============================================================================
// IN-MEMORY AGGREGATION (for pre-enriched records with _linked data)
// =============================================================================

/**
 * Execute aggregation on pre-fetched, enriched records
 *
 * Used when GROUP BY includes linked fields (e.g., "_linked.Account_id.F1").
 * Records must already be enriched with _linked data via enrichRecordsWithLinks().
 *
 * @param records - Pre-fetched records with _linked data
 * @param aggregations - Array of aggregation definitions
 * @param groupBy - Optional fields to group by (supports _linked.* paths)
 * @returns AggregationResult with computed values
 *
 * @example
 * ```typescript
 * // Records already enriched with _linked data
 * const enrichedRecords = enrichRecordsWithLinks(rawRecords, ['Account_id'], linkResult);
 *
 * // Now aggregate by linked field
 * const result = executeInMemoryAggregation(enrichedRecords, [
 *   { field: 'Amount', op: 'sum', alias: 'total' }
 * ], ['_linked.Account_id.F1']);
 * ```
 */
export function executeInMemoryAggregation(
  records: Array<Record<string, unknown>>,
  aggregations: Aggregation[],
  groupBy?: string[]
): AggregationResult {
  // Initialize global accumulator (for non-grouped queries)
  const globalState = createEmptyState(aggregations);

  // Group accumulators (for GROUP BY queries)
  const groupStates = new Map<string, AggregatorState>();

  console.error(`[InMemoryAggregation] Processing ${records.length} enriched records, groupBy=${groupBy?.join(',') || 'none'}`);

  // Process each pre-fetched record
  for (const record of records) {
    // Determine target state (global or group-specific)
    let targetState: AggregatorState;

    if (groupBy && groupBy.length > 0) {
      // Build group key from field values (supports _linked.* paths)
      const groupKey = buildGroupKey(record, groupBy);

      // Get or create group state
      if (!groupStates.has(groupKey)) {
        groupStates.set(groupKey, createEmptyState(aggregations));
      }
      targetState = groupStates.get(groupKey)!;
    } else {
      targetState = globalState;
    }

    // Update accumulators for each aggregation
    for (const agg of aggregations) {
      const fieldValue = record[agg.field];
      updateAccumulator(targetState, agg, fieldValue);
    }
  }

  console.error(`[InMemoryAggregation] Complete: ${records.length} records, ${groupStates.size} groups`);

  // Compute final results
  const results = computeFinalResults(globalState, aggregations);

  // Compute group results if grouped
  let groups: Array<{ key: Record<string, unknown>; values: Record<string, number> }> | undefined;

  if (groupBy && groupBy.length > 0 && groupStates.size > 0) {
    groups = [];
    for (const [keyStr, groupState] of groupStates) {
      // Parse key back to object
      const key = parseGroupKey(keyStr, groupBy);
      const values = computeFinalResults(groupState, aggregations);
      groups.push({ key, values });
    }

    // Sort groups by first group-by field
    groups.sort((a, b) => {
      const aVal = String(a.key[groupBy[0]] ?? '');
      const bVal = String(b.key[groupBy[0]] ?? '');
      return aVal.localeCompare(bVal);
    });
  }

  // Generate reconciliation checksum
  const primaryAgg = aggregations[0];
  let grandTotal: number;

  if (groups && groups.length > 0) {
    grandTotal = groups.reduce((sum, g) => sum + (g.values[primaryAgg.alias] ?? 0), 0);
  } else {
    grandTotal = results[primaryAgg.alias] ?? 0;
  }

  const reconciliation = createReconciliationChecksum(
    grandTotal,
    records.length,
    primaryAgg.field,
    primaryAgg.op
  );

  return {
    results,
    groups,
    totalRecords: records.length,
    truncated: false,
    reconciliation
  };
}
