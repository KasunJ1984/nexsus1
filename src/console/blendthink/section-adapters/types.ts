/**
 * Section Adapter Types
 *
 * Defines interfaces for section adapters that execute route plan steps
 * by calling underlying service functions directly.
 *
 * NOTE: Core adapter types (SectionAdapter, SectionResult, AdapterContext,
 * DEFAULT_ADAPTER_CONTEXT) are now defined in common/types.ts and re-exported
 * here for backward compatibility. Adapter-specific result types remain here.
 */

// Re-export shared types from common for backward compatibility
export type {
  SectionAdapter,
  SectionResult,
  AdapterContext,
} from '../../../common/types.js';

export { DEFAULT_ADAPTER_CONTEXT } from '../../../common/types.js';

// =============================================================================
// SEMANTIC SECTION RESULTS
// =============================================================================

/**
 * Result from semantic search operations
 */
export interface SemanticSearchResult {
  /** Matching records with similarity scores */
  matches: Array<{
    id: string;
    score: number;
    model_name?: string;
    record_id?: number;
    display_name?: string;
    payload: Record<string, unknown>;
  }>;

  /** Total matches found */
  totalMatches: number;

  /** Whether more results exist beyond limit */
  hasMore: boolean;
}

// =============================================================================
// EXACT SECTION RESULTS
// =============================================================================

/**
 * Result from aggregation operations
 */
export interface AggregationResult {
  /** Aggregation results (totals or grouped) */
  results: Record<string, unknown>[];

  /** Group keys if grouped */
  groupBy?: string[];

  /** Total records processed */
  totalRecords: number;

  /** Reconciliation checksum */
  reconciliation?: {
    checksum: string;
    recordCount: number;
  };
}

/**
 * Result from record scroll operations
 */
export interface RecordScrollResult {
  /** Retrieved records */
  records: Record<string, unknown>[];

  /** Total records matching filter */
  totalMatched: number;

  /** Whether more records exist */
  hasMore: boolean;
}

// =============================================================================
// GRAPH SECTION RESULTS
// =============================================================================

/**
 * Result from graph traversal operations
 */
export interface GraphTraversalResult {
  /** Root record info */
  root: {
    model_name: string;
    record_id: number;
    display_name: string;
  };

  /** Outgoing FK targets */
  outgoing: Array<{
    fk_field: string;
    target_model: string;
    target_id: number;
    display_name: string;
  }>;

  /** Incoming references */
  incoming: Array<{
    source_model: string;
    source_id: number;
    fk_field: string;
    display_name: string;
  }>;

  /** FK fields with no synced targets */
  notSynced: string[];
}

