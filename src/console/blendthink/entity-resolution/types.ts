/**
 * Entity Resolution Layer - Type Definitions
 *
 * Types for the entity resolution layer that sits between
 * QuestionAnalyzer and AdaptiveRouter to dynamically discover
 * models, fields, and filters using schema search.
 */

import type { QuestionAnalysis, FilterCondition, Aggregation } from '../../../common/types.js';

// =============================================================================
// DATE RESOLUTION TYPES
// =============================================================================

/**
 * Type of date resolution
 */
export type DateResolutionType = 'point' | 'range';

/**
 * Result of resolving a date expression
 */
export interface DateResolution {
  /** Single date or date range */
  type: DateResolutionType;
  /** Start date in ISO format (YYYY-MM-DD) */
  from: string;
  /** End date in ISO format (YYYY-MM-DD) - only for ranges */
  to?: string;
  /** Confidence in the resolution (0-1) */
  confidence: number;
  /** Original text that was parsed */
  originalText: string;
  /** Pattern that matched */
  pattern: 'month-year' | 'quarter' | 'fiscal-year' | 'iso-date' | 'natural-language';
}

// =============================================================================
// MODEL RESOLUTION TYPES
// =============================================================================

/**
 * Result of resolving a model from query keywords
 */
export interface ModelResolution {
  /** Odoo model name (e.g., "account.move.line") */
  modelName: string;
  /** Confidence in the resolution (0-1) */
  confidence: number;
  /** Keywords that matched in schema */
  matchedKeywords: string[];
  /** Source of the resolution */
  source: 'schema_search' | 'hint' | 'context' | 'default';
}

// =============================================================================
// FIELD RESOLUTION TYPES
// =============================================================================

/**
 * Result of resolving an entity to a field filter
 */
export interface FieldResolution {
  /** Original entity text (e.g., "staff welfare") */
  originalEntity: string;
  /** Field to filter on (e.g., "account_id_id") */
  fieldName: string;
  /** Filter operator */
  operator: 'eq' | 'in' | 'contains' | 'gte' | 'lte';
  /** Resolved value(s) */
  value: unknown;
  /** Confidence in the resolution (0-1) */
  confidence: number;
  /** Source of the resolution */
  source: 'schema_search' | 'graph_traverse' | 'direct_lookup';
  /** Related record info (if FK resolution) */
  relatedRecords?: Array<{
    id: number;
    name: string;
    model: string;
  }>;
}

// =============================================================================
// KNOWLEDGE ENRICHMENT TYPES
// =============================================================================

/**
 * Implicit filter from knowledge layer
 */
export interface ImplicitFilter {
  /** Filter condition to add */
  filter: FilterCondition;
  /** Reason for adding this filter */
  reason: string;
  /** Source rule */
  rule: string;
  /** Domain that triggered this rule */
  domain: 'financial' | 'crm' | 'hr' | 'inventory' | 'general';
}

/**
 * Aggregation hint from knowledge layer
 */
export interface AggregationHint {
  /** Suggested aggregation */
  aggregation: Aggregation;
  /** Reason for suggesting this */
  reason: string;
  /** Confidence */
  confidence: number;
}

// =============================================================================
// RESOLVED ENTITY TYPE
// =============================================================================

/**
 * Type of resolved entity
 */
export type ResolvedEntityType = 'date' | 'model' | 'field' | 'value' | 'unknown';

/**
 * A fully resolved entity from the original query
 */
export interface ResolvedEntity {
  /** Original text from query */
  original: string;
  /** Type of entity */
  type: ResolvedEntityType;
  /** Resolution result */
  resolved: {
    /** The resolved value (date range, model name, filter, etc.) */
    value: DateResolution | ModelResolution | FieldResolution | string | null;
    /** Confidence in resolution (0-1) */
    confidence: number;
    /** How this was resolved */
    source: 'date_resolver' | 'model_finder' | 'field_matcher' | 'knowledge' | 'pattern' | 'unresolved';
  };
}

// =============================================================================
// ENRICHED ANALYSIS TYPE
// =============================================================================

/**
 * Extended QuestionAnalysis with resolved entities
 *
 * This is the output of the Entity Resolution Layer,
 * containing pre-built filters ready for the adapters.
 */
export interface EnrichedAnalysis extends QuestionAnalysis {
  /** Resolved model from schema search */
  resolvedModel?: ModelResolution;

  /** Pre-built filters ready for nexsus_search */
  resolvedFilters: FilterCondition[];

  /** Suggested aggregations based on context */
  resolvedAggregations?: Aggregation[];

  /** Implicit filters from knowledge layer */
  implicitFilters: FilterCondition[];

  /** All resolved entities with their mappings */
  resolvedEntities: ResolvedEntity[];

  /** Date resolutions extracted from query */
  dateResolutions: DateResolution[];

  /** Overall confidence in the resolution (0-1) */
  resolutionConfidence: number;

  /** Whether entity resolution was attempted */
  wasEnriched: boolean;

  /** Errors during resolution (non-fatal) */
  resolutionWarnings?: string[];
}

// =============================================================================
// RESOLUTION CONTEXT TYPE
// =============================================================================

/**
 * Context passed through the resolution pipeline
 */
export interface ResolutionContext {
  /** Original query text */
  query: string;
  /** Initial analysis from QuestionAnalyzer */
  analysis: QuestionAnalysis;
  /** Detected domain (if any) */
  domain?: 'financial' | 'crm' | 'hr' | 'inventory';
  /** Session ID for caching */
  sessionId?: string;
}

// =============================================================================
// HELPER TYPE GUARDS
// =============================================================================

/**
 * Check if a resolved entity value is a DateResolution
 */
export function isDateResolution(value: unknown): value is DateResolution {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'from' in value &&
    'confidence' in value &&
    ((value as DateResolution).type === 'point' || (value as DateResolution).type === 'range')
  );
}

/**
 * Check if a resolved entity value is a ModelResolution
 */
export function isModelResolution(value: unknown): value is ModelResolution {
  return (
    typeof value === 'object' &&
    value !== null &&
    'modelName' in value &&
    'confidence' in value &&
    'matchedKeywords' in value
  );
}

/**
 * Check if a resolved entity value is a FieldResolution
 */
export function isFieldResolution(value: unknown): value is FieldResolution {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fieldName' in value &&
    'operator' in value &&
    'value' in value
  );
}
