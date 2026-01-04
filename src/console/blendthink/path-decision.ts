/**
 * Path Decision - System 1/System 2 Decision Layer
 *
 * Implements dual-process decision making:
 * - System 1 (Fast): Familiar patterns, single adapter, cached synthesis
 * - System 2 (Deep): Novel queries, full analysis, continuous integration
 *
 * Based on Daniel Kahneman's "Thinking, Fast and Slow"
 */

import type { QuestionAnalysis, RoutePlan, RouteStep, BlendSection } from '../../common/types.js';
import type { PatternMatch } from './memory/query-pattern-memory.js';
import { getQueryPatternMemory } from './memory/index.js';

// =============================================================================
// TYPES
// =============================================================================

export type PathType = 'system1' | 'system2';

export interface PathDecision {
  /** Which path to take */
  path: PathType;

  /** Confidence in the decision (0-1) */
  confidence: number;

  /** Reason for choosing this path */
  reason: string;

  /** For System 1: Cached route from memory (just section + tool info) */
  cachedRoute?: Array<{ section: BlendSection; tool: string }>;

  /** For System 2: Reason for deep analysis */
  deepAnalysisReason?: 'novel_query' | 'complex_query' | 'low_pattern_confidence' | 'multi_section_required';

  /** Estimated latency */
  estimatedLatencyMs: number;

  /** Memory match if found */
  memoryMatch?: PatternMatch;
}

// =============================================================================
// DECISION THRESHOLDS
// =============================================================================

const THRESHOLDS = {
  /** Minimum memory similarity for System 1 */
  MEMORY_SIMILARITY: 0.85,

  /** Minimum pattern confidence for System 1 */
  PATTERN_CONFIDENCE: 0.8,

  /** Maximum complexity for System 1 */
  COMPLEXITY: 0.3,

  /** Maximum sections for System 1 (fast path uses single adapter) */
  MAX_SECTIONS_SYSTEM1: 1,

  /** Minimum confidence to skip clarification */
  MIN_CONFIDENCE: 0.6,
};

// =============================================================================
// PATH DECISION ENGINE
// =============================================================================

/**
 * Decide between System 1 (fast) and System 2 (deep) paths
 *
 * System 1 criteria (ALL must be true):
 * 1. Very similar to past successful query (>85% similarity)
 * 2. Past pattern was successful (>80% outcome quality)
 * 3. Query is simple (<30% complexity)
 *
 * Otherwise → System 2
 */
export async function decidePath(
  query: string,
  analysis: QuestionAnalysis,
  routePlan: RoutePlan
): Promise<PathDecision> {
  // Check memory for similar patterns
  const patternMemory = getQueryPatternMemory();
  const patterns = await patternMemory.findSimilar(query, 1);
  const memoryMatch = patterns.length > 0 ? patterns[0] : null;

  // Extract values for decision
  const familiarity = memoryMatch?.similarity ?? 0;
  const patternConfidence = memoryMatch?.pattern.outcomeQuality ?? 0;
  const complexity = analysis.complexity ?? 0.5;
  const sectionCount = routePlan.steps.length;

  console.error(`[PathDecision] Evaluating: familiarity=${familiarity.toFixed(2)}, patternConf=${patternConfidence.toFixed(2)}, complexity=${complexity.toFixed(2)}, sections=${sectionCount}`);

  // System 1 criteria (ALL must be true)
  const highFamiliarity = familiarity >= THRESHOLDS.MEMORY_SIMILARITY;
  const highPatternConfidence = patternConfidence >= THRESHOLDS.PATTERN_CONFIDENCE;
  const lowComplexity = complexity <= THRESHOLDS.COMPLEXITY;
  const singleSection = sectionCount <= THRESHOLDS.MAX_SECTIONS_SYSTEM1;

  // Use System 1 (fast path) only if ALL criteria are met
  if (highFamiliarity && highPatternConfidence && lowComplexity && singleSection) {
    console.error('[PathDecision] → SYSTEM 1 (Fast Path)');
    return {
      path: 'system1',
      confidence: familiarity * patternConfidence,
      reason: `Familiar pattern (${(familiarity * 100).toFixed(0)}% similar), high confidence`,
      cachedRoute: memoryMatch?.pattern.successfulRoute,
      estimatedLatencyMs: 2000, // ~2 seconds
      memoryMatch: memoryMatch ?? undefined,
    };
  }

  // Otherwise, use System 2 (deep path)
  const deepReason = determineDeepReason(familiarity, complexity, patternConfidence, sectionCount);

  console.error(`[PathDecision] → SYSTEM 2 (Deep Analysis): ${deepReason}`);
  return {
    path: 'system2',
    confidence: analysis.confidence,
    reason: `Deep analysis needed: ${deepReason}`,
    deepAnalysisReason: deepReason,
    estimatedLatencyMs: 8000, // ~8 seconds
    memoryMatch: memoryMatch ?? undefined,
  };
}

/**
 * Determine why System 2 is needed
 */
function determineDeepReason(
  familiarity: number,
  complexity: number,
  patternConfidence: number,
  sectionCount: number
): PathDecision['deepAnalysisReason'] {
  if (familiarity < 0.5) {
    return 'novel_query';
  }
  if (complexity > 0.7) {
    return 'complex_query';
  }
  if (sectionCount > 1) {
    return 'multi_section_required';
  }
  return 'low_pattern_confidence';
}

// =============================================================================
// SYSTEM 1 FAST PATH EXECUTOR
// =============================================================================

/**
 * Execute System 1 fast path
 *
 * Uses cached route and minimal synthesis.
 * Returns raw tool results for outer Claude to synthesize.
 */
export interface System1Result {
  /** The fast-path route used */
  route: RouteStep[];

  /** Whether execution succeeded */
  success: boolean;

  /** Raw section results (no inner Claude synthesis) */
  sectionResults: Array<{
    section: BlendSection;
    tool: string;
    success: boolean;
    data: unknown;
    recordCount?: number;
    error?: string;
  }>;

  /** Total execution time */
  durationMs: number;

  /** Pattern that was matched */
  matchedPattern?: PatternMatch;
}

/**
 * Fast path executor - single adapter, no inner Claude
 */
export function createFastPathRoute(
  analysis: QuestionAnalysis,
  cachedRoute?: Array<{ section: BlendSection; tool: string }>
): RouteStep[] {
  // If we have a cached route, use first step only
  if (cachedRoute && cachedRoute.length > 0) {
    const cached = cachedRoute[0];
    return [
      {
        section: cached.section,
        tool: cached.tool,
        params: {},
        order: 1,
        reason: 'Fast path from memory pattern',
        dependsOnPrevious: false,
        dependencyLevel: 0,
      },
    ];
  }

  // Otherwise create minimal route based on analysis
  const primarySection = determinePrimarySection(analysis);
  return [
    {
      section: primarySection,
      tool: getPrimaryTool(primarySection),
      params: {},
      order: 1,
      reason: 'Fast path primary section',
      dependsOnPrevious: false,
      dependencyLevel: 0,
    },
  ];
}

/**
 * Determine primary section for a query type
 */
function determinePrimarySection(analysis: QuestionAnalysis): BlendSection {
  switch (analysis.type) {
    case 'precise_query':
    case 'aggregation':
      return 'exact';
    case 'discovery':
      return 'semantic';
    case 'explanation':
      return 'knowledge';
    case 'relationship':
      return 'common';
    default:
      return 'semantic';
  }
}

/**
 * Get primary tool for a section
 */
function getPrimaryTool(section: BlendSection): string {
  switch (section) {
    case 'exact':
      return 'nexsus_search';
    case 'semantic':
      return 'semantic_search';
    case 'knowledge':
      return 'knowledge_search';
    case 'common':
      return 'graph_traverse';
    default:
      return 'semantic_search';
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export { THRESHOLDS };
