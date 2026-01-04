/**
 * Drilldown Handler
 *
 * Executes drilldown operations on cached session data:
 * - regroup: Re-aggregate with new GROUP BY
 * - expand: Show underlying detail records
 * - export: Export to Excel
 * - filter: Apply additional filter in-memory
 * - sort: Re-sort cached records
 *
 * All operations work on data cached in SessionDataCache,
 * avoiding re-queries to Qdrant for fast interaction.
 */

import type { FilterCondition, ScrollResult } from '../../../common/types.js';
import { exportRecordsToExcel } from '../../../common/services/file-export.js';
import {
  getSessionDataCache,
  type CachedSectionData,
  type SectionDataUnion,
  type AggregationCacheData,
  type RecordsCacheData,
  type SemanticCacheData,
  type DrilldownOperation,
  type DrilldownRequest,
  type DrilldownResult,
} from './session-data-cache.js';

// =============================================================================
// DRILLDOWN HANDLER CLASS
// =============================================================================

export class DrilldownHandler {
  private cache = getSessionDataCache();

  /**
   * Execute a drilldown operation on cached session data
   */
  async execute(request: DrilldownRequest): Promise<DrilldownResult> {
    console.error(`[DrilldownHandler] Executing ${request.operation} for session ${request.sessionId.substring(0, 8)}...`);

    // Get cached data for the session
    const cachedData = this.cache.get(request.sessionId);

    if (!cachedData) {
      console.error(`[DrilldownHandler] No cached data found for session`);
      return {
        success: false,
        error: 'No cached data found for this session. Please run a query first.',
        fromCache: false,
      };
    }

    // Dispatch to appropriate handler
    try {
      let result: SectionDataUnion | null = null;

      switch (request.operation) {
        case 'regroup':
          result = await this.handleRegroup(cachedData, request.newGroupBy || []);
          break;

        case 'expand':
          result = await this.handleExpand(cachedData, request.expandGroupKey);
          break;

        case 'export':
          result = await this.handleExport(cachedData);
          break;

        case 'filter':
          result = await this.handleFilter(cachedData, request.additionalFilter);
          break;

        case 'sort':
          result = await this.handleSort(cachedData, request.sort);
          break;

        default:
          return {
            success: false,
            error: `Unknown drilldown operation: ${request.operation}`,
            fromCache: true,
          };
      }

      if (!result) {
        return {
          success: false,
          error: `Failed to execute ${request.operation} operation`,
          fromCache: true,
        };
      }

      return {
        success: true,
        data: result,
        fromCache: true,
        cacheStats: {
          hitTurn: cachedData.turnNumber,
          ageMs: Date.now() - cachedData.metadata.cachedAt.getTime(),
          originalQuery: cachedData.metadata.query,
        },
      };
    } catch (error) {
      console.error(`[DrilldownHandler] Error executing ${request.operation}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        fromCache: true,
      };
    }
  }

  /**
   * Re-aggregate cached data with new GROUP BY fields
   */
  private async handleRegroup(
    cachedData: CachedSectionData,
    newGroupBy: string[]
  ): Promise<SectionDataUnion | null> {
    console.error(`[DrilldownHandler] Regroup by: ${newGroupBy.join(', ')}`);
    console.error(`[DrilldownHandler] Cached data type: ${cachedData.data.type}`);

    // Need aggregation data with underlying records
    if (cachedData.data.type !== 'aggregation') {
      console.error('[DrilldownHandler] Regroup requires aggregation data, got:', cachedData.data.type);
      return null;
    }

    const aggData = cachedData.data as AggregationCacheData;
    console.error(`[DrilldownHandler] Aggregation has ${aggData.results?.length || 0} results, ${aggData.underlyingRecords?.length || 0} underlying records`);

    // Check if we have underlying records to re-aggregate
    if (!aggData.underlyingRecords || aggData.underlyingRecords.length === 0) {
      const reason = aggData.totalRecords > 10000
        ? `Dataset too large (${aggData.totalRecords} records > 10,000 max) - underlying records not captured`
        : 'Underlying records not available';
      console.error(`[DrilldownHandler] No underlying records: ${reason}`);
      // Fall back to the grouped results if we can't re-aggregate
      return null;
    }

    // Import re-aggregation engine (will be created in Stage 5)
    const { reAggregate } = await import('./re-aggregation-engine.js');

    // Re-aggregate with new GROUP BY
    const newResults = reAggregate(
      aggData.underlyingRecords,
      newGroupBy,
      [], // No additional filters
      cachedData.metadata.aggregations || []
    );

    return {
      type: 'aggregation',
      results: newResults,
      groupBy: newGroupBy,
      totalRecords: aggData.totalRecords,
      underlyingRecords: aggData.underlyingRecords, // Keep for further regrouping
      reconciliation: aggData.reconciliation,
    };
  }

  /**
   * Expand aggregated data to show underlying detail records
   */
  private async handleExpand(
    cachedData: CachedSectionData,
    expandGroupKey?: Record<string, unknown>
  ): Promise<SectionDataUnion | null> {
    console.error('[DrilldownHandler] Expand to show details');

    if (cachedData.data.type === 'aggregation') {
      const aggData = cachedData.data as AggregationCacheData;

      if (!aggData.underlyingRecords || aggData.underlyingRecords.length === 0) {
        console.error('[DrilldownHandler] No underlying records to expand');
        return null;
      }

      let records = aggData.underlyingRecords;

      // If expand key provided, filter to matching records
      if (expandGroupKey && Object.keys(expandGroupKey).length > 0) {
        records = records.filter(record => {
          for (const [key, value] of Object.entries(expandGroupKey)) {
            if (record[key] !== value) {
              return false;
            }
          }
          return true;
        });
        console.error(`[DrilldownHandler] Filtered to ${records.length} records for group key`);
      }

      return {
        type: 'records',
        records,
        totalMatched: records.length,
        hasMore: false,
      };
    }

    if (cachedData.data.type === 'semantic') {
      const semData = cachedData.data as SemanticCacheData;

      // Convert semantic matches to records format
      const records = semData.matches.map(match => ({
        id: match.id,
        model_name: match.model_name,
        record_id: match.record_id,
        display_name: match.display_name,
        score: match.score,
        ...match.payload,
      }));

      return {
        type: 'records',
        records,
        totalMatched: records.length,
        hasMore: semData.hasMore,
      };
    }

    // Already records, just return as-is
    return cachedData.data;
  }

  /**
   * Export cached data to Excel
   */
  private async handleExport(cachedData: CachedSectionData): Promise<SectionDataUnion | null> {
    console.error('[DrilldownHandler] Export to Excel');

    // Get records to export
    let recordsToExport: Record<string, unknown>[] = [];

    if (cachedData.data.type === 'aggregation') {
      const aggData = cachedData.data as AggregationCacheData;
      // Export aggregated results
      recordsToExport = aggData.results;
    } else if (cachedData.data.type === 'records') {
      const recData = cachedData.data as RecordsCacheData;
      recordsToExport = recData.records;
    } else if (cachedData.data.type === 'semantic') {
      const semData = cachedData.data as SemanticCacheData;
      recordsToExport = semData.matches.map(m => ({
        id: m.id,
        model_name: m.model_name,
        record_id: m.record_id,
        display_name: m.display_name,
        score: m.score,
        ...m.payload,
      }));
    }

    if (recordsToExport.length === 0) {
      console.error('[DrilldownHandler] No records to export');
      return null;
    }

    try {
      // Create a ScrollResult-like object for the export function
      const scrollResult: ScrollResult = {
        records: recordsToExport,
        totalScanned: recordsToExport.length,
        hasMore: false,
      };

      const exportResult = await exportRecordsToExcel(
        scrollResult,
        {
          model_name: cachedData.metadata.modelName,
          filters_summary: `Drilldown export from session cache (turn ${cachedData.turnNumber})`,
          query_time_ms: 0, // From cache, no query time
        },
        {
          filenamePrefix: `drilldown_${cachedData.data.type}`,
        }
      );

      console.error(`[DrilldownHandler] Exported ${recordsToExport.length} records`);
      console.error(`[DrilldownHandler] File: ${exportResult.file_path || exportResult.download_url}`);

      // Return the original data - the export result is in the logs
      return cachedData.data;
    } catch (error) {
      console.error('[DrilldownHandler] Export failed:', error);
      return null;
    }
  }

  /**
   * Apply additional filter to cached data in-memory
   */
  private async handleFilter(
    cachedData: CachedSectionData,
    additionalFilter?: FilterCondition
  ): Promise<SectionDataUnion | null> {
    if (!additionalFilter) {
      console.error('[DrilldownHandler] No filter provided');
      return cachedData.data;
    }

    console.error(`[DrilldownHandler] Filter: ${additionalFilter.field} ${additionalFilter.op} ${additionalFilter.value}`);

    // Import filter utility (will be created in Stage 5)
    const { applyFilter } = await import('./re-aggregation-engine.js');

    if (cachedData.data.type === 'aggregation') {
      const aggData = cachedData.data as AggregationCacheData;

      if (aggData.underlyingRecords) {
        const filtered = applyFilter(aggData.underlyingRecords, additionalFilter);

        // Re-aggregate the filtered records
        const { reAggregate } = await import('./re-aggregation-engine.js');
        const newResults = reAggregate(
          filtered,
          aggData.groupBy || [],
          [],
          cachedData.metadata.aggregations || []
        );

        return {
          type: 'aggregation',
          results: newResults,
          groupBy: aggData.groupBy,
          totalRecords: filtered.length,
          underlyingRecords: filtered,
        };
      }

      // Filter the aggregated results directly
      const filtered = applyFilter(aggData.results, additionalFilter);
      return {
        type: 'aggregation',
        results: filtered,
        groupBy: aggData.groupBy,
        totalRecords: filtered.length,
      };
    }

    if (cachedData.data.type === 'records') {
      const recData = cachedData.data as RecordsCacheData;
      const filtered = applyFilter(recData.records, additionalFilter);

      return {
        type: 'records',
        records: filtered,
        totalMatched: filtered.length,
        hasMore: false,
      };
    }

    if (cachedData.data.type === 'semantic') {
      const semData = cachedData.data as SemanticCacheData;
      const recordsWithPayload = semData.matches.map(m => ({
        ...m.payload,
        _id: m.id,
        _score: m.score,
        _model_name: m.model_name,
        _record_id: m.record_id,
        _display_name: m.display_name,
      }));

      const filtered = applyFilter(recordsWithPayload, additionalFilter);

      return {
        type: 'semantic',
        matches: filtered.map(r => ({
          id: r._id as string,
          score: r._score as number,
          model_name: r._model_name as string,
          record_id: r._record_id as number,
          display_name: r._display_name as string,
          payload: Object.fromEntries(
            Object.entries(r).filter(([k]) => !k.startsWith('_'))
          ),
        })),
        totalMatches: filtered.length,
        hasMore: false,
      };
    }

    return null;
  }

  /**
   * Re-sort cached data
   */
  private async handleSort(
    cachedData: CachedSectionData,
    sort?: { field: string; direction: 'asc' | 'desc' }
  ): Promise<SectionDataUnion | null> {
    if (!sort) {
      console.error('[DrilldownHandler] No sort provided');
      return cachedData.data;
    }

    console.error(`[DrilldownHandler] Sort by ${sort.field} ${sort.direction}`);

    const sortFn = (a: Record<string, unknown>, b: Record<string, unknown>) => {
      const aVal = a[sort.field];
      const bVal = b[sort.field];

      // Handle nulls
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sort.direction === 'asc' ? -1 : 1;
      if (bVal == null) return sort.direction === 'asc' ? 1 : -1;

      // Compare values
      let comparison = 0;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        comparison = aVal - bVal;
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }

      return sort.direction === 'asc' ? comparison : -comparison;
    };

    if (cachedData.data.type === 'aggregation') {
      const aggData = cachedData.data as AggregationCacheData;
      return {
        ...aggData,
        results: [...aggData.results].sort(sortFn),
      };
    }

    if (cachedData.data.type === 'records') {
      const recData = cachedData.data as RecordsCacheData;
      return {
        ...recData,
        records: [...recData.records].sort(sortFn),
      };
    }

    if (cachedData.data.type === 'semantic') {
      const semData = cachedData.data as SemanticCacheData;
      return {
        ...semData,
        matches: [...semData.matches].sort((a, b) => {
          const aVal = a.payload[sort.field];
          const bVal = b.payload[sort.field];

          if (aVal == null && bVal == null) return 0;
          if (aVal == null) return sort.direction === 'asc' ? -1 : 1;
          if (bVal == null) return sort.direction === 'asc' ? 1 : -1;

          let comparison = 0;
          if (typeof aVal === 'number' && typeof bVal === 'number') {
            comparison = aVal - bVal;
          } else {
            comparison = String(aVal).localeCompare(String(bVal));
          }

          return sort.direction === 'asc' ? comparison : -comparison;
        }),
      };
    }

    return null;
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let handlerInstance: DrilldownHandler | null = null;

/**
 * Get the singleton DrilldownHandler instance
 */
export function getDrilldownHandler(): DrilldownHandler {
  if (!handlerInstance) {
    handlerInstance = new DrilldownHandler();
    console.error('[DrilldownHandler] Initialized');
  }
  return handlerInstance;
}
