/**
 * Entity Resolution Layer
 *
 * This layer sits between QuestionAnalyzer and AdaptiveRouter to dynamically
 * discover models, fields, and filters using schema search instead of
 * hardcoded dictionaries.
 *
 * Components (implemented in stages):
 * - Stage 1: DateResolver - Flexible date parsing (Jan-25, Q1, FY25)
 * - Stage 2: ModelFinder - Schema-based model discovery
 * - Stage 3: FieldMatcher - Field resolution via schema/graph
 * - Stage 4: KnowledgeEnricher - Implicit filters from domain rules
 * - Stage 5: ResolutionMerge - Combine all resolutions
 */

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type {
  // Date resolution types
  DateResolution,
  DateResolutionType,
  // Model resolution types
  ModelResolution,
  // Field resolution types
  FieldResolution,
  // Knowledge enrichment types
  ImplicitFilter,
  AggregationHint,
  // Core entity types
  ResolvedEntity,
  ResolvedEntityType,
  // Main enriched analysis type
  EnrichedAnalysis,
  // Context type
  ResolutionContext,
} from './types.js';

// Type guards
export { isDateResolution, isModelResolution, isFieldResolution } from './types.js';

// =============================================================================
// DATE RESOLVER EXPORTS
// =============================================================================

export {
  resolveDates,
  dateResolutionsToFilters,
  containsDateExpression,
  getPrimaryDateResolution,
} from './date-resolver.js';

// =============================================================================
// MODEL FINDER EXPORTS (Stage 2)
// =============================================================================

export {
  findModel,
  identifyDomain,
  shouldFindModel,
  suggestModels,
  type Domain,
} from './model-finder.js';

// =============================================================================
// FIELD MATCHER EXPORTS (Stage 3)
// =============================================================================

export {
  matchField,
  matchFields,
  shouldMatchField,
} from './field-matcher.js';

// =============================================================================
// KNOWLEDGE ENRICHER EXPORTS (Stage 4)
// =============================================================================

export {
  enrichWithKnowledge,
  getImplicitFilters,
  getAggregationHints,
  mergeFilters,
  isFilterPresent,
} from './knowledge-enricher.js';

// =============================================================================
// PLACEHOLDER EXPORTS (TO BE IMPLEMENTED IN LATER STAGES)
// =============================================================================

// Stage 5: Resolution Merge - Now implemented in resolveEntities below

// =============================================================================
// MAIN ENTRY POINT (PLACEHOLDER)
// =============================================================================

import type { QuestionAnalysis, FilterCondition } from '../../../common/types.js';
import type { EnrichedAnalysis, ResolvedEntity } from './types.js';
import { resolveDates, dateResolutionsToFilters } from './date-resolver.js';
import { findModel, shouldFindModel, identifyDomain } from './model-finder.js';
import { matchFields, shouldMatchField } from './field-matcher.js';
import { enrichWithKnowledge, mergeFilters } from './knowledge-enricher.js';

/**
 * Resolve entities in a question analysis
 *
 * This is the main entry point for the Entity Resolution Layer.
 * It takes a QuestionAnalysis and enriches it with resolved entities,
 * pre-built filters, and implicit filters from the knowledge layer.
 *
 * @param analysis - Initial analysis from QuestionAnalyzer
 * @param query - Original query text
 * @returns EnrichedAnalysis with resolved entities and filters
 *
 * NOTE: This is a partial implementation for Stages 1-2.
 * Full implementation will be completed in Stage 5.
 */
export async function resolveEntities(
  analysis: QuestionAnalysis,
  query: string
): Promise<EnrichedAnalysis> {
  const warnings: string[] = [];
  const resolvedEntities: ResolvedEntity[] = [];

  // Stage 1: Resolve dates
  const dateResolutions = resolveDates(query);
  const dateFilters = dateResolutionsToFilters(dateResolutions);

  // Convert date filters to FilterCondition format
  const resolvedFilters: FilterCondition[] = dateFilters.map((f) => ({
    field: f.field,
    op: f.op,
    value: f.value,
  }));

  // Build resolved entities for dates
  for (const dr of dateResolutions) {
    resolvedEntities.push({
      original: dr.originalText,
      type: 'date',
      resolved: {
        value: dr,
        confidence: dr.confidence,
        source: 'date_resolver',
      },
    });
  }

  if (dateResolutions.length === 0) {
    warnings.push('No date expressions found in query');
  }

  // Stage 2: Find model via schema search
  let resolvedModel = undefined;
  const domain = identifyDomain(analysis.entities, query);

  if (shouldFindModel(query, analysis.entities)) {
    const modelResult = await findModel(analysis.entities, query);

    if (modelResult) {
      resolvedModel = modelResult;

      // Add model as resolved entity
      resolvedEntities.push({
        original: query, // The whole query contributed to model detection
        type: 'model',
        resolved: {
          value: modelResult,
          confidence: modelResult.confidence,
          source: modelResult.source === 'schema_search' ? 'model_finder' : 'pattern',
        },
      });
    } else {
      warnings.push('Could not determine target model from query');
    }
  }

  // Stage 3: Match fields for non-date entities
  // IMPORTANT: Exclude entities that are GROUP BY keywords to avoid
  // misinterpreting "by partner" → partner filter instead of GROUP BY
  const groupByKeywords = new Set([
    'partner', 'customer', 'vendor', 'account', 'product', 'user',
    'salesperson', 'stage', 'category', 'region', 'country', 'journal',
    'month', 'year', 'quarter', 'week', 'day',
  ]);

  // Check if this query has GROUP BY hints - if so, skip those keywords
  const hasGroupByHints = analysis.groupByHints && analysis.groupByHints.length > 0;

  const fieldEntities = analysis.entities.filter((entity) => {
    // Standard filter
    if (!shouldMatchField(entity)) {
      return false;
    }

    // If we have GROUP BY hints, skip entities that are GROUP BY keywords
    if (hasGroupByHints) {
      const lowerEntity = entity.toLowerCase();
      if (groupByKeywords.has(lowerEntity)) {
        console.error(`[EntityResolution] Skipping "${entity}" - already used for GROUP BY`);
        return false;
      }
    }

    return true;
  });
  const targetModel = resolvedModel?.modelName;

  if (fieldEntities.length > 0) {
    const fieldResolutions = await matchFields(fieldEntities, domain, targetModel);

    for (const fr of fieldResolutions) {
      // Add to resolved entities
      resolvedEntities.push({
        original: fr.originalEntity,
        type: 'field',
        resolved: {
          value: fr,
          confidence: fr.confidence,
          source: 'field_matcher',
        },
      });

      // Build filter condition if we have a value
      if (fr.value !== null) {
        const filterCondition: FilterCondition = {
          field: fr.fieldName,
          op: fr.operator as FilterCondition['op'],
          value: fr.value,
        };
        resolvedFilters.push(filterCondition);
      }
    }
  }

  // Stage 4: Knowledge enrichment - add implicit filters and aggregation hints
  const knowledgeResult = enrichWithKnowledge(domain, query, targetModel);
  const implicitFilters = knowledgeResult.implicitFilters.map((f) => f.filter);

  // Get top aggregation hint (if any)
  const resolvedAggregations =
    knowledgeResult.aggregationHints.length > 0
      ? [knowledgeResult.aggregationHints[0].aggregation]
      : undefined;

  // Merge implicit filters with resolved filters
  const finalFilters = mergeFilters(resolvedFilters, knowledgeResult.implicitFilters);

  // Calculate overall confidence
  const confidences = resolvedEntities.map((e) => e.resolved.confidence);
  const avgConfidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

  // Return enriched analysis
  return {
    ...analysis,
    resolvedModel,
    resolvedFilters: finalFilters,
    resolvedAggregations,
    implicitFilters,
    resolvedEntities,
    dateResolutions,
    resolutionConfidence: avgConfidence,
    wasEnriched: true,
    resolutionWarnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Quick check if entity resolution would be beneficial
 *
 * Returns true if the query contains:
 * - Date expressions that need parsing
 * - Keywords that might need model discovery
 * - Entity names that might need field resolution
 */
export function shouldResolveEntities(analysis: QuestionAnalysis): boolean {
  // For now, always try to resolve
  // In future, might skip for very simple queries
  return true;
}

/**
 * Get entity resolution statistics for debugging
 */
export function getResolutionStats(enriched: EnrichedAnalysis): {
  dateCount: number;
  filterCount: number;
  hasModel: boolean;
  confidence: number;
} {
  return {
    dateCount: enriched.dateResolutions?.length || 0,
    filterCount: enriched.resolvedFilters?.length || 0,
    hasModel: !!enriched.resolvedModel,
    confidence: enriched.resolutionConfidence || 0,
  };
}
