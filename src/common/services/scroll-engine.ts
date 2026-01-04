/**
 * Scroll Engine for Exact Queries
 *
 * Provides memory-efficient pagination through Qdrant records.
 * Used for retrieving matching records without aggregation.
 *
 * Key features:
 * - Streaming through large datasets without loading all into memory
 * - Pagination support with limit/offset
 * - Safety limits to prevent runaway queries
 */

import { getQdrantClient } from './vector-client.js';
import { UNIFIED_CONFIG } from '../constants.js';
import { QdrantFilter, AppLevelFilter } from './filter-builder.js';
import { ScrollResult } from '../types.js';

/**
 * Default batch size for scrolling through Qdrant
 * Larger batches = fewer API calls but more memory per batch
 */
const SCROLL_BATCH_SIZE = 1000;

/**
 * No default maximum - trust the user to specify limits
 * For large datasets, use export_to_file=true in nexsus_search
 */
const DEFAULT_MAX_RECORDS = undefined;

/**
 * Options for scroll operation
 */
export interface ScrollOptions {
  /** Specific fields to return (payload projection) */
  fields?: string[];
  /** Maximum records to return */
  limit?: number;
  /** Number of records to skip (for pagination) */
  offset?: number;
  /** Maximum records to scan (safety limit) */
  maxRecords?: number;
  /** App-level filters for date ranges (Qdrant can't filter keywords by range) */
  appFilters?: AppLevelFilter[];
}

/**
 * Scroll through all matching records with pagination
 *
 * Memory-efficient retrieval for non-aggregation queries.
 * Supports pagination via limit/offset parameters.
 *
 * @param filter - Qdrant filter object from buildQdrantFilter()
 * @param options - Scroll options (limit, offset, fields)
 * @returns ScrollResult with records, count, and hasMore flag
 *
 * @example
 * ```typescript
 * const filter = buildQdrantFilter("account.move.line", [
 *   { field: "partner_id_id", op: "eq", value: 286798 }
 * ]);
 *
 * const result = await scrollRecords(filter, {
 *   fields: ["date", "name", "debit", "credit"],
 *   limit: 100,
 *   offset: 0
 * });
 * // result.records = [...100 records...]
 * // result.totalScanned = 100
 * // result.hasMore = true
 * ```
 */
export async function scrollRecords(
  filter: QdrantFilter,
  options: ScrollOptions = {}
): Promise<ScrollResult> {
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

  // Extract options - NO silent defaults for limit
  // If user wants all records, they simply don't specify a limit
  const maxRecords = options.maxRecords;  // undefined = no limit
  const limit = options.limit;  // undefined = return all matching records
  const skipCount = options.offset ?? 0;

  // Result accumulator
  const records: Array<Record<string, unknown>> = [];
  let totalScanned = 0;
  let skipped = 0;
  let appFilterDebugCount = 0;  // For debug logging (first 5 comparisons)

  // Qdrant scroll cursor (can be string, number, or object)
  let scrollOffset: string | number | Record<string, unknown> | null = null;

  // Log scroll start
  console.error(`[ScrollEngine] Starting scroll: limit=${limit ?? 'unlimited'}, offset=${skipCount}, maxRecords=${maxRecords ?? 'unlimited'}`);

  // When fields are specified but we have app-level filters, we MUST also include
  // the app filter fields in the payload request. Otherwise passesAppFilters will
  // fail because the filter field won't be in the returned payload.
  let payloadFields = options.fields;
  if (options.fields && options.appFilters && options.appFilters.length > 0) {
    const appFilterFieldNames = options.appFilters.map(f => f.field);
    const missingFields = appFilterFieldNames.filter(f => !options.fields!.includes(f));
    if (missingFields.length > 0) {
      payloadFields = [...options.fields, ...missingFields];
      console.error(`[ScrollEngine] Auto-added app filter fields to payload: ${missingFields.join(', ')}`);
    }
  }

  do {
    // Build scroll parameters
    const scrollParams: {
      filter: QdrantFilter;
      limit: number;
      offset?: string | number;
      with_payload: boolean | { include: string[] };
      with_vector: boolean;
    } = {
      filter: workingFilter,
      limit: SCROLL_BATCH_SIZE,
      with_payload: payloadFields
        ? { include: payloadFields }
        : true,
      with_vector: false,  // Never need vectors for exact queries
    };

    // Add cursor if continuing from previous batch
    if (scrollOffset !== null) {
      // Cast to expected type - Qdrant accepts the same value it returns
      scrollParams.offset = scrollOffset as string | number;
    }

    // Fetch batch from Qdrant
    const batch = await qdrant.scroll(collectionName, scrollParams);

    // Process each record in batch
    for (const point of batch.points) {
      totalScanned++;
      const payload = point.payload as Record<string, unknown>;

      // Apply app-level filters (for date ranges on keyword fields)
      if (options.appFilters && options.appFilters.length > 0) {
        // Debug: Log first 5 date comparisons to diagnose filtering
        if (appFilterDebugCount < 5) {
          for (const af of options.appFilters) {
            console.error(`[ScrollEngine AppFilter DEBUG] record_id=${payload['id'] || payload['record_id']}, field=${af.field}, payloadValue="${payload[af.field]}", op=${af.op}, filterValue="${af.value}"`);
          }
          appFilterDebugCount++;
        }

        if (!passesAppFilters(payload, options.appFilters)) {
          continue; // Skip this record
        }
      }

      // Skip records for pagination offset
      if (skipped < skipCount) {
        skipped++;
        continue;
      }

      // Check if we've reached the limit (only if limit is specified)
      if (limit !== undefined && records.length >= limit) {
        console.error(`[ScrollEngine] Reached limit: ${limit} records`);
        return {
          records,
          totalScanned,
          hasMore: true
        };
      }

      // Add record to results
      records.push(payload);
    }

    // Update cursor for next batch
    scrollOffset = batch.next_page_offset ?? null;

    // Safety check: stop if we've scanned too many records (only if maxRecords specified)
    if (maxRecords !== undefined && totalScanned >= maxRecords) {
      console.error(`[ScrollEngine] Safety limit reached: ${maxRecords} records scanned`);
      break;
    }
  } while (scrollOffset !== null);

  console.error(`[ScrollEngine] Scroll complete: ${records.length} records returned, ${totalScanned} scanned`);

  return {
    records,
    totalScanned,
    hasMore: scrollOffset !== null
  };
}

/**
 * Count total records matching a filter
 *
 * Uses Qdrant's count API for efficient counting without fetching data.
 *
 * @param filter - Qdrant filter object
 * @returns Total count of matching records
 */
export async function countRecords(filter: QdrantFilter): Promise<number> {
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
    exact: true  // Use exact count for accuracy
  });

  console.error(`[ScrollEngine] Count: ${result.count} records match filter`);
  return result.count;
}

/**
 * Check if any records match a filter
 *
 * Efficient existence check - only fetches 1 record.
 *
 * @param filter - Qdrant filter object
 * @returns True if at least one record matches
 */
export async function hasRecords(filter: QdrantFilter): Promise<boolean> {
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

  const result = await qdrant.scroll(collectionName, {
    filter: workingFilter,
    limit: 1,
    with_payload: false,
    with_vector: false
  });

  return result.points.length > 0;
}

/**
 * Get a sample of matching records
 *
 * Useful for previewing data before running full query.
 *
 * @param filter - Qdrant filter object
 * @param sampleSize - Number of records to sample (default: 5)
 * @returns Array of sample records
 */
export async function sampleRecords(
  filter: QdrantFilter,
  sampleSize: number = 5
): Promise<Array<Record<string, unknown>>> {
  const result = await scrollRecords(filter, {
    limit: sampleSize,
    maxRecords: sampleSize
  });

  return result.records;
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
