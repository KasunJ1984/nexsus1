/**
 * Graph Search Engine
 *
 * Provides graph-aware search capabilities by leveraging
 * the Knowledge Graph points in the unified collection.
 *
 * Key features:
 * - getGraphContext(): Fetch graph edges for a model
 * - countConnections(): Count FK connections in a record payload
 * - computeGraphBoost(): Compute ranking boost based on connections
 *
 * Boosts search ranking by FK connection count
 */

import {
  getModelRelationships,
  getIncomingRelationships,
  searchRelationships,
  getGraphContext,
  clearGraphCache,
  getGraphCacheStats,
  type GraphContext,
  type GraphContextOptions,
  type GraphDirection,
} from '../../common/services/knowledge-graph.js';
import type { RelationshipInfo, PipelineDataPayload } from '../../common/types.js';

// Re-export getGraphContext and related types from common
export {
  getGraphContext,
  clearGraphCache,
  getGraphCacheStats,
  type GraphContext,
  type GraphContextOptions,
  type GraphDirection,
};

// =============================================================================
// TYPES
// =============================================================================

/**
 * Connection counts for a record
 */
export interface ConnectionCounts {
  /** Number of outgoing FK references (populated *_qdrant fields) */
  outgoing: number;
  /** Number of FK field types that reference other models */
  outgoingFieldCount: number;
  /** Incoming references from graph edge_count (model level) */
  incomingEdgeCount: number;
  /** Total connection score */
  total: number;
}

// =============================================================================
// CONNECTION COUNTING
// =============================================================================

/**
 * Count FK connections in a record's payload
 *
 * Counts populated *_qdrant fields to determine how many
 * FK references this record has to other entities.
 *
 * @param payload - Record payload from Qdrant
 * @param graphContext - Optional graph context for incoming edge counts
 * @returns Connection counts
 *
 * @example
 * const counts = countConnections(recordPayload, graphContext);
 * console.log(`Outgoing: ${counts.outgoing}, Incoming: ${counts.incomingEdgeCount}`);
 */
export function countConnections(
  payload: PipelineDataPayload,
  graphContext?: GraphContext
): ConnectionCounts {
  let outgoing = 0;
  let outgoingFieldCount = 0;

  // Count *_qdrant fields that have values
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith('_qdrant')) {
      outgoingFieldCount++;
      if (value) {
        // Handle both single UUID and array of UUIDs
        if (Array.isArray(value)) {
          outgoing += value.length;
        } else if (typeof value === 'string' && value.startsWith('00000002-')) {
          outgoing++;
        }
      }
    }
  }

  // Get incoming edge count from graph context
  let incomingEdgeCount = 0;
  if (graphContext) {
    // Sum edge_count from all incoming relationships
    for (const rel of graphContext.incoming) {
      incomingEdgeCount += rel.edge_count || 0;
    }
  }

  return {
    outgoing,
    outgoingFieldCount,
    incomingEdgeCount,
    total: outgoing + (incomingEdgeCount > 0 ? Math.log10(incomingEdgeCount + 1) : 0),
  };
}

// =============================================================================
// GRAPH BOOST COMPUTATION
// =============================================================================

/**
 * Cardinality class weights for boost calculation
 */
export interface CardinalityWeights {
  /** Weight for one_to_one relationships (default: 1.5 - boost specific refs) */
  one_to_one: number;
  /** Weight for one_to_few relationships (default: 1.0 - neutral) */
  one_to_few: number;
  /** Weight for one_to_many relationships (default: 0.5 - reduce generic refs) */
  one_to_many: number;
}

/**
 * Boost factor configuration
 */
export interface BoostConfig {
  /** Max boost multiplier (default: 0.2 = 20% max boost) */
  maxBoost?: number;
  /** Weight for outgoing connections (default: 1.0) */
  outgoingWeight?: number;
  /** Weight for incoming references (default: 0.5) */
  incomingWeight?: number;
  /** Weight multipliers for cardinality classes (G4) */
  cardinalityWeights?: CardinalityWeights;
  /** Boost multiplier for hub models (default: 1.3) (G7) */
  hubBoostMultiplier?: number;
  /** Minimum degree (in + out) to qualify as hub (default: 10) (G7) */
  hubDegreeThreshold?: number;
}

const DEFAULT_BOOST_CONFIG: Required<BoostConfig> = {
  maxBoost: 0.2,
  outgoingWeight: 1.0,
  incomingWeight: 0.5,
  // G4: Cardinality class weights - boost specific refs, reduce generic ones
  cardinalityWeights: {
    one_to_one: 1.5,   // High uniqueness - most specific references
    one_to_few: 1.0,   // Moderate - typical FK relationships
    one_to_many: 0.5,  // Low - generic references (many records → same target)
  },
  // G7: Hub model boost - central entities rank higher
  hubBoostMultiplier: 1.3,
  hubDegreeThreshold: 10,
};

/**
 * Compute graph boost for a record
 *
 * Calculates a boost multiplier based on how connected the record is.
 * More connected records get higher scores.
 *
 * Enhanced with:
 * - G4: Cardinality class weighting (one_to_one > one_to_few > one_to_many)
 * - G7: Hub model boost (high connectivity models rank higher)
 *
 * Formula:
 * boost = min(maxBoost, (outgoing * outWeight * cardWeight + log10(incoming) * inWeight) / 10)
 * if hub: boost *= hubMultiplier (capped at maxBoost * 1.5)
 *
 * @param payload - Record payload
 * @param graphContext - Graph context for the model
 * @param config - Boost configuration
 * @returns Boost multiplier (0.0 to maxBoost * 1.5 for hubs)
 *
 * @example
 * const boost = computeGraphBoost(payload, context);
 * const boostedScore = originalScore * (1 + boost);
 */
export function computeGraphBoost(
  payload: PipelineDataPayload,
  graphContext?: GraphContext,
  config?: BoostConfig
): number {
  const cfg = { ...DEFAULT_BOOST_CONFIG, ...config };
  const counts = countConnections(payload, graphContext);

  // Calculate base outgoing score
  let outgoingScore = counts.outgoing * cfg.outgoingWeight;

  // G4: Apply cardinality weight if graph context available
  if (graphContext && graphContext.outgoing.length > 0) {
    // Average cardinality weight across outgoing relationships
    let totalCardWeight = 0;
    let cardCount = 0;

    for (const rel of graphContext.outgoing) {
      // Access cardinality_class from relationship payload
      const relPayload = rel as unknown as { cardinality_class?: string };
      if (relPayload.cardinality_class) {
        const cardClass = relPayload.cardinality_class as keyof CardinalityWeights;
        totalCardWeight += cfg.cardinalityWeights[cardClass] ?? 1.0;
        cardCount++;
      }
    }

    if (cardCount > 0) {
      const avgCardWeight = totalCardWeight / cardCount;
      outgoingScore *= avgCardWeight;
    }
  }

  // Calculate incoming score
  const incomingScore = counts.incomingEdgeCount > 0
    ? Math.log10(counts.incomingEdgeCount + 1) * cfg.incomingWeight
    : 0;

  // Normalize and cap at maxBoost
  const rawBoost = (outgoingScore + incomingScore) / 10;
  let boost = Math.min(cfg.maxBoost, rawBoost);

  // G7: Apply hub model boost
  // Hub = high connectivity both incoming AND outgoing
  if (graphContext) {
    const totalDegree = graphContext.outgoing.length + graphContext.incoming.length;
    if (totalDegree >= cfg.hubDegreeThreshold) {
      boost *= cfg.hubBoostMultiplier;
      // Allow hubs to exceed normal maxBoost by up to 50%
      boost = Math.min(cfg.maxBoost * 1.5, boost);
    }
  }

  return boost;
}

/**
 * Apply graph boost to a search score
 *
 * @param originalScore - Original similarity score (0-1)
 * @param boost - Boost multiplier from computeGraphBoost
 * @returns Boosted score
 */
export function applyBoost(originalScore: number, boost: number): number {
  return originalScore * (1 + boost);
}

// =============================================================================
// SEMANTIC GRAPH SEARCH
// =============================================================================

/**
 * Search graph edges semantically
 *
 * Find relationships matching a natural language query.
 *
 * @param query - Natural language query
 * @param limit - Max results
 * @returns Matching relationships with scores
 */
export async function searchGraphEdges(
  query: string,
  limit: number = 10
): Promise<Array<RelationshipInfo & { score: number }>> {
  return searchRelationships(query, limit);
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Format connection info for display
 *
 * @param counts - Connection counts
 * @returns Formatted string
 */
export function formatConnectionInfo(counts: ConnectionCounts): string {
  return `${counts.outgoing} outgoing, ${counts.incomingEdgeCount} references`;
}

/**
 * Check if a record is well-connected
 *
 * @param counts - Connection counts
 * @param threshold - Minimum total for "well-connected" (default: 5)
 * @returns true if record has many connections
 */
export function isWellConnected(counts: ConnectionCounts, threshold: number = 5): boolean {
  return counts.outgoing >= threshold || counts.incomingEdgeCount >= threshold;
}

/**
 * Get boost explanation string
 *
 * @param originalScore - Original score
 * @param boost - Applied boost
 * @returns Explanation string
 */
export function getBoostExplanation(originalScore: number, boost: number): string {
  if (boost === 0) {
    return '';
  }
  const boostPercent = (boost * 100).toFixed(1);
  return `+${boostPercent}% graph boost`;
}
