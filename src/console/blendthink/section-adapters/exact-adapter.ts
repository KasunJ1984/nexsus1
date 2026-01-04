/**
 * Exact Section Adapter
 *
 * Executes precise data queries using nexsus_search by calling
 * underlying filter-builder, aggregation-engine, and scroll-engine services.
 */

import { buildQdrantFilter, validateFilters } from '../../../common/services/filter-builder.js';
import { executeAggregation } from '../../../exact/services/aggregation-engine.js';
import { scrollRecords, countRecords } from '../../../common/services/scroll-engine.js';
import type { QuestionAnalysis, RouteStep, FilterCondition, Aggregation } from '../../../common/types.js';
import type { EnrichedAnalysis } from '../entity-resolution/index.js';
import type {
  SectionAdapter,
  SectionResult,
  AggregationResult,
  RecordScrollResult,
  AdapterContext,
} from './types.js';
import { DEFAULT_ADAPTER_CONTEXT } from './types.js';

// =============================================================================
// EXACT ADAPTER
// =============================================================================

export class ExactAdapter implements SectionAdapter {
  readonly section = 'exact' as const;
  private context: AdapterContext;

  constructor(context: Partial<AdapterContext> = {}) {
    this.context = { ...DEFAULT_ADAPTER_CONTEXT, ...context };
  }

  /**
   * Execute a nexsus_search operation (aggregation or record scroll)
   */
  async execute(step: RouteStep, analysis: QuestionAnalysis): Promise<SectionResult> {
    const startTime = Date.now();

    try {
      // Determine if this is an aggregation or record query
      const isAggregation = this.isAggregationQuery(analysis);

      if (isAggregation) {
        return await this.executeAggregation(step, analysis, startTime);
      } else {
        return await this.executeRecordQuery(step, analysis, startTime);
      }
    } catch (error) {
      // Enhanced error logging for debugging
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`[ExactAdapter] Execution failed:`, errorMessage);
      if (errorStack) {
        console.error(`[ExactAdapter] Stack trace:`, errorStack);
      }

      // Check for common issues and provide helpful hints
      let errorHint = '';
      if (errorMessage.includes('Bad Request')) {
        errorHint = ' (Possible causes: missing field index in Qdrant, model not synced, or invalid filter value)';
      } else if (errorMessage.includes('not found')) {
        errorHint = ' (Possible causes: model not synced or field does not exist)';
      }

      return {
        section: this.section,
        tool: step.tool,
        success: false,
        data: null,
        error: errorMessage + errorHint,
        tokenEstimate: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute an aggregation query
   *
   * Also captures underlying records for drilldown re-aggregation
   * if totalRecords <= MAX_UNDERLYING_RECORDS (10,000).
   */
  private async executeAggregation(
    step: RouteStep,
    analysis: QuestionAnalysis,
    startTime: number
  ): Promise<SectionResult> {
    // Maximum records to capture for drilldown re-aggregation
    const MAX_UNDERLYING_RECORDS = 10000;

    // Build filters from analysis
    const { filters, modelName } = this.buildFiltersFromAnalysis(analysis);

    // DEBUG: Log built filters
    console.error(`[ExactAdapter] Built ${filters.length} filters for ${modelName}:`);
    for (const f of filters) {
      console.error(`  - ${f.field} ${f.op} ${JSON.stringify(f.value)}`);
    }

    // Validate filters
    const validation = validateFilters(filters);
    if (!validation.isValid) {
      throw new Error(`Invalid filters: ${validation.errors.join(', ')}`);
    }

    // Build Qdrant filter AND app-level filters (date ranges go to appFilters)
    const { qdrantFilter, appFilters } = buildQdrantFilter(modelName, filters);

    // DEBUG: Log Qdrant filter and app filters
    console.error(`[ExactAdapter] Qdrant filter: ${JSON.stringify(qdrantFilter, null, 2).substring(0, 500)}...`);
    if (appFilters.length > 0) {
      console.error(`[ExactAdapter] App-level filters (date ranges): ${appFilters.length}`);
      for (const af of appFilters) {
        console.error(`  - ${af.field} ${af.op} ${af.value}`);
      }
    }

    // Build aggregations from analysis
    const aggregations = this.buildAggregationsFromAnalysis(analysis);

    // Determine group by from analysis
    const groupBy = this.extractGroupBy(analysis);

    // Execute aggregation with app-level filters (date ranges applied in JS)
    const result = await executeAggregation(qdrantFilter, aggregations, groupBy, undefined, appFilters);

    // Format result for blendthink (convert to our internal format)
    const aggResult: {
      results: Record<string, unknown>[];
      groupBy?: string[];
      totalRecords: number;
      reconciliation?: { checksum: string; recordCount: number };
      underlyingRecords?: Record<string, unknown>[];
    } = {
      results: result.groups
        ? result.groups.map((g) => ({ ...g.key, ...g.values }))
        : [result.results],
      groupBy: groupBy.length > 0 ? groupBy : undefined,
      totalRecords: result.totalRecords,
      reconciliation: result.reconciliation
        ? {
            checksum: result.reconciliation.hash,
            recordCount: result.reconciliation.record_count,
          }
        : undefined,
    };

    // Capture underlying records for drilldown re-aggregation if dataset is small enough
    if (result.totalRecords <= MAX_UNDERLYING_RECORDS && result.totalRecords > 0) {
      console.error(`[ExactAdapter] Capturing ${result.totalRecords} underlying records for drilldown`);

      try {
        // Scroll all matching records
        const scrollResult = await scrollRecords(qdrantFilter, {
          fields: undefined, // Get all fields
          limit: MAX_UNDERLYING_RECORDS,
          offset: 0,
        });

        aggResult.underlyingRecords = scrollResult.records;
        console.error(`[ExactAdapter] Captured ${scrollResult.records.length} records for re-aggregation`);
      } catch (scrollError) {
        // Don't fail the aggregation if scroll fails
        console.error(`[ExactAdapter] Failed to capture underlying records:`, scrollError);
        // Leave underlyingRecords undefined - drilldown will fall back to re-query
      }
    } else if (result.totalRecords > MAX_UNDERLYING_RECORDS) {
      console.error(
        `[ExactAdapter] Too many records (${result.totalRecords}) for underlying capture (max: ${MAX_UNDERLYING_RECORDS})`
      );
    }

    // Estimate tokens (100 base + 20 per group)
    const groupCount = result.groups?.length || 1;
    const tokenEstimate = 100 + groupCount * 20;

    return {
      section: this.section,
      tool: 'nexsus_search',
      success: true,
      data: aggResult,
      recordCount: result.totalRecords,
      tokenEstimate,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute a record scroll query
   */
  private async executeRecordQuery(
    step: RouteStep,
    analysis: QuestionAnalysis,
    startTime: number
  ): Promise<SectionResult> {
    // Build filters from analysis
    const { filters, modelName } = this.buildFiltersFromAnalysis(analysis);

    // Build Qdrant filter
    const { qdrantFilter } = buildQdrantFilter(modelName, filters);

    // Determine fields to return
    const fields = this.extractFields(analysis);

    // Execute scroll
    const limit = Math.min(this.context.maxRecords, 100);
    const result = await scrollRecords(qdrantFilter, {
      fields: fields.length > 0 ? fields : undefined,
      limit,
      offset: 0,
    });

    // Get total count
    const totalCount = await countRecords(qdrantFilter);

    // Format result
    const scrollResult: RecordScrollResult = {
      records: result.records,
      totalMatched: totalCount,
      hasMore: totalCount > limit,
    };

    // Estimate tokens (50 per record)
    const tokenEstimate = 100 + scrollResult.records.length * 50;

    return {
      section: this.section,
      tool: 'nexsus_search',
      success: true,
      data: scrollResult,
      recordCount: scrollResult.records.length,
      tokenEstimate,
      executionTimeMs: Date.now() - startTime,
    };
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Determine if query is aggregation or record retrieval
   */
  private isAggregationQuery(analysis: QuestionAnalysis): boolean {
    // Check operation type
    if (analysis.operation) {
      return ['aggregate', 'sum', 'count', 'average'].includes(analysis.operation.toLowerCase());
    }

    // Check question type
    return ['aggregation', 'aggregation_with_discovery', 'comparison'].includes(analysis.type);
  }

  /**
   * Build filters from question analysis
   */
  private buildFiltersFromAnalysis(analysis: QuestionAnalysis): {
    filters: FilterCondition[];
    modelName: string;
  } {
    const filters: FilterCondition[] = [];

    // Check if this is an enriched analysis with resolved entities
    const enriched = analysis as EnrichedAnalysis;

    // DEBUG: Log enrichment state
    console.error(`[ExactAdapter] DEBUG enrichment check:`);
    console.error(`  wasEnriched: ${enriched.wasEnriched}`);
    console.error(`  resolvedModel: ${JSON.stringify(enriched.resolvedModel)}`);
    console.error(`  resolvedFilters: ${enriched.resolvedFilters?.length || 0} filters`);
    if (enriched.resolvedFilters?.length > 0) {
      console.error(`  filters: ${JSON.stringify(enriched.resolvedFilters)}`);
    }

    const hasResolvedData = enriched.wasEnriched && enriched.resolvedModel;

    // Determine model name - prefer resolved model from entity resolution
    const modelName = hasResolvedData
      ? enriched.resolvedModel!.modelName
      : (analysis.modelHints?.[0] || 'crm.lead');

    console.error(`[ExactAdapter] Using model: ${modelName} (from ${hasResolvedData ? 'entity resolution' : 'hints/default'})`);

    // Add model filter
    filters.push({
      field: 'model_name',
      op: 'eq',
      value: modelName,
    });

    // If we have resolved filters from entity resolution, use those first
    if (hasResolvedData && enriched.resolvedFilters?.length > 0) {
      console.error(`[ExactAdapter] Using ${enriched.resolvedFilters.length} resolved filters from entity resolution`);
      // Add resolved filters (skip model_name filter as we already added it)
      for (const rf of enriched.resolvedFilters) {
        if (rf.field !== 'model_name') {
          filters.push(rf);
        }
      }
      // Return early - entity resolution filters are complete
      return { filters, modelName };
    }

    // Add filters from entities
    for (const entity of analysis.entities) {
      // Pattern: id:12345
      const idMatch = entity.match(/^id:(\d+)$/);
      if (idMatch) {
        filters.push({
          field: 'record_id',
          op: 'eq',
          value: parseInt(idMatch[1], 10),
        });
        continue;
      }

      // Pattern: partner:286798, lead:41085, etc. (entity record IDs)
      // These are direct record ID lookups, not FK references
      const entityIdMatch = entity.match(/^(partner|lead|invoice|account|product|user):(\d+)$/);
      if (entityIdMatch) {
        filters.push({
          field: 'record_id',
          op: 'eq',
          value: parseInt(entityIdMatch[2], 10),
        });
        continue;
      }

      // Pattern: partner_id:12345 (FK reference filter)
      const refMatch = entity.match(/^(partner|account|user)_id:(\d+)$/);
      if (refMatch) {
        filters.push({
          field: `${refMatch[1]}_id_id`,
          op: 'eq',
          value: parseInt(refMatch[2], 10),
        });
        continue;
      }

      // Pattern: stage:Won
      const stageMatch = entity.match(/^stage:(.+)$/);
      if (stageMatch) {
        filters.push({
          field: 'stage_id_name',
          op: 'eq',
          value: stageMatch[1],
        });
        continue;
      }
    }

    // Add date filters from entities
    const dateEntities = analysis.entities.filter((e) => e.match(/^\d{4}-\d{2}(-\d{2})?$/));
    if (dateEntities.length >= 2) {
      filters.push({
        field: 'date',
        op: 'gte',
        value: dateEntities[0],
      });
      filters.push({
        field: 'date',
        op: 'lte',
        value: dateEntities[1],
      });
    } else if (dateEntities.length === 1) {
      // Single date - assume month
      const date = dateEntities[0];
      if (date.length === 7) {
        // YYYY-MM format
        filters.push({
          field: 'date',
          op: 'gte',
          value: `${date}-01`,
        });
        const [year, month] = date.split('-').map(Number);
        const lastDay = new Date(year, month, 0).getDate();
        filters.push({
          field: 'date',
          op: 'lte',
          value: `${date}-${lastDay.toString().padStart(2, '0')}`,
        });
      }
    }

    return { filters, modelName };
  }

  /**
   * Build aggregations from analysis
   */
  private buildAggregationsFromAnalysis(analysis: QuestionAnalysis): Aggregation[] {
    // Check if this is an enriched analysis with resolved aggregations
    const enriched = analysis as EnrichedAnalysis;
    if (enriched.wasEnriched && enriched.resolvedAggregations?.length) {
      console.error(`[ExactAdapter] Using ${enriched.resolvedAggregations.length} resolved aggregations from entity resolution`);
      return enriched.resolvedAggregations;
    }

    const aggregations: Aggregation[] = [];

    // Map field hints to aggregations
    const fieldHints = analysis.fieldHints || [];

    // Default aggregation based on common fields
    const sumFields = ['revenue', 'expected_revenue', 'amount_total', 'debit', 'credit', 'balance'];
    const countFields = ['id', 'record_id'];

    for (const hint of fieldHints) {
      if (sumFields.includes(hint)) {
        aggregations.push({
          field: hint,
          op: 'sum',
          alias: `total_${hint}`,
        });
      } else if (countFields.includes(hint)) {
        aggregations.push({
          field: hint,
          op: 'count',
          alias: 'record_count',
        });
      }
    }

    // Default aggregation if none specified - MODEL AWARE
    if (aggregations.length === 0) {
      // Determine model from enriched analysis or hints
      const modelName = enriched.resolvedModel?.modelName || analysis.modelHints?.[0] || 'crm.lead';
      const isFinancial = modelName.startsWith('account.');

      console.error(`[ExactAdapter] Building default aggregations for model: ${modelName}`);

      if (analysis.operation?.toLowerCase().includes('count')) {
        aggregations.push({
          field: 'record_id',
          op: 'count',
          alias: 'record_count',
        });
      } else if (isFinancial) {
        // Financial models use debit/credit
        aggregations.push({
          field: 'debit',
          op: 'sum',
          alias: 'total_debit',
        });
        aggregations.push({
          field: 'credit',
          op: 'sum',
          alias: 'total_credit',
        });
      } else {
        // CRM models use expected_revenue
        aggregations.push({
          field: 'expected_revenue',
          op: 'sum',
          alias: 'total_expected_revenue',
        });
      }
    }

    return aggregations;
  }

  /**
   * Extract group by fields from analysis
   */
  private extractGroupBy(analysis: QuestionAnalysis): string[] {
    const groupBy: string[] = [];

    // First, check for groupByHints from question analyzer (preferred)
    if (analysis.groupByHints && analysis.groupByHints.length > 0) {
      console.error(`[ExactAdapter] Using groupByHints from analysis: ${analysis.groupByHints.join(', ')}`);
      groupBy.push(...analysis.groupByHints);
    }

    // Also check for "by:" patterns in entities (legacy fallback)
    for (const entity of analysis.entities) {
      if (entity.match(/^by:(partner|account|stage|user)$/)) {
        const field = entity.replace('by:', '') + '_id_id';
        if (!groupBy.includes(field)) {
          groupBy.push(field);
        }
      }
    }

    // For comparison queries, group by the comparison dimension
    if (analysis.type === 'comparison') {
      // Often comparing time periods or categories
      if (!groupBy.includes('date')) {
        // Could add date grouping for period comparisons
      }
    }

    return groupBy;
  }

  /**
   * Extract fields to return for record queries
   */
  private extractFields(analysis: QuestionAnalysis): string[] {
    const fields: string[] = [];

    // Always include core fields
    fields.push('record_id', 'display_name', 'name');

    // Add field hints
    if (analysis.fieldHints) {
      fields.push(...analysis.fieldHints);
    }

    // Add model-specific defaults
    const modelName = analysis.modelHints?.[0] || '';
    if (modelName === 'crm.lead') {
      fields.push('expected_revenue', 'stage_id_name', 'partner_id_name');
    } else if (modelName === 'account.move.line') {
      fields.push('date', 'debit', 'credit', 'balance', 'account_id_name');
    } else if (modelName === 'res.partner') {
      fields.push('email', 'phone', 'city', 'country_id_name');
    }

    // Deduplicate
    return [...new Set(fields)];
  }
}
