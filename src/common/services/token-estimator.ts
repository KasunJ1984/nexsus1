/**
 * Token Estimator Service
 *
 * Provides token estimation for nexsus_search results to enable
 * intelligent response sizing and auto-export routing.
 *
 * This service is part of the Token Limitation Handling feature (Stage 1)
 * that prevents context window overflow while maintaining data accuracy.
 *
 * Estimation formulas (empirically derived from actual response analysis):
 * - Aggregation (no GROUP BY): ~300 tokens (header + single result)
 * - Aggregation (N groups): ~300 + (N x 50) tokens (header + table rows)
 * - Record retrieval (N records): ~250 + (N x 100) tokens (header + JSON)
 *
 * Accuracy target: +/- 20% of actual token count
 *
 * @example
 * // Check if aggregation result would exceed threshold
 * const estimate = estimateAggregationTokens({ totalRecords: 1000, groupCount: 150 });
 * if (estimate.exceeds_threshold) {
 *   // Route to summary or export mode
 *   console.log(`Recommend: ${estimate.recommended_detail_level}`);
 * }
 *
 * @module services/token-estimator
 * @see docs/plans/token-limitation-handling.md
 */

import { TOKEN_MANAGEMENT } from '../constants.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Detailed token estimate with recommendation
 */
export interface TokenEstimate {
  /** Estimated token count for the response */
  estimated_tokens: number;

  /** Whether estimate exceeds the configured threshold */
  exceeds_threshold: boolean;

  /** Recommended detail level based on token estimate */
  recommended_detail_level: 'summary' | 'top_n' | 'full';

  /** Breakdown of how tokens were calculated */
  breakdown: {
    /** Fixed base tokens (header, metadata, formatting) */
    base_tokens: number;
    /** Variable tokens based on data size */
    variable_tokens: number;
    /** Human-readable description of calculation */
    description: string;
  };

  /** Potential token reduction if using recommended level */
  potential_reduction?: {
    /** Tokens if using recommended level */
    reduced_tokens: number;
    /** Percentage reduction */
    reduction_percent: number;
  };
}

/**
 * Input for aggregation token estimation
 */
export interface AggregationEstimateInput {
  /** Total records processed in aggregation */
  totalRecords: number;

  /** Number of groups (0 for non-grouped aggregation) */
  groupCount?: number;

  /** Number of aggregation fields (default: 1) */
  aggregationCount?: number;

  /** Number of group_by fields (affects row width) */
  groupByFieldCount?: number;
}

/**
 * Input for record retrieval token estimation
 */
export interface RecordEstimateInput {
  /** Number of records to return */
  recordCount: number;

  /** Average fields per record (default: 10) */
  fieldsPerRecord?: number;

  /** Whether records include nested objects */
  hasNestedObjects?: boolean;
}

/**
 * Comparison result between detail levels
 */
export interface DetailLevelComparison {
  full: number;
  top_n: number;
  summary: number;
  recommended: 'summary' | 'top_n' | 'full';
  savings: {
    top_n_vs_full: number;
    summary_vs_full: number;
  };
}

// =============================================================================
// CORE ESTIMATION FUNCTIONS
// =============================================================================

/**
 * Estimate tokens for aggregation query results
 *
 * Handles both simple aggregations (single row) and grouped aggregations (table).
 *
 * @param input - Aggregation parameters
 * @returns Detailed token estimate with recommendation
 *
 * @example
 * // Simple aggregation (SUM without GROUP BY)
 * estimateAggregationTokens({ totalRecords: 5000, groupCount: 0 });
 * // Returns ~320 tokens (just header + result line)
 *
 * @example
 * // Grouped aggregation (SUM with GROUP BY partner_id)
 * estimateAggregationTokens({ totalRecords: 5000, groupCount: 150 });
 * // Returns ~7,800 tokens (header + 150 table rows)
 */
export function estimateAggregationTokens(input: AggregationEstimateInput): TokenEstimate {
  const {
    totalRecords,
    groupCount = 0,
    aggregationCount = 1,
    groupByFieldCount = 1,
  } = input;

  const baseTokens = TOKEN_MANAGEMENT.BASE_AGGREGATION_TOKENS;
  let variableTokens: number;
  let description: string;

  if (groupCount > 0) {
    // Grouped aggregation: tokens scale with number of groups
    // Each group row includes: group key(s) + aggregation values + formatting
    const tokensPerGroup = TOKEN_MANAGEMENT.TOKENS_PER_GROUP +
      (groupByFieldCount - 1) * 10 + // Extra ~10 tokens per additional group_by field
      (aggregationCount - 1) * 15;   // Extra ~15 tokens per additional aggregation

    variableTokens = groupCount * tokensPerGroup;
    description = `Grouped aggregation: ${groupCount.toLocaleString()} groups x ~${tokensPerGroup} tokens/group`;
  } else {
    // Simple aggregation: minimal tokens for single result row
    variableTokens = aggregationCount * 25; // ~25 tokens per aggregation field
    description = `Simple aggregation: ${aggregationCount} field(s), ${totalRecords.toLocaleString()} records processed`;
  }

  const estimatedTokens = baseTokens + variableTokens;
  const recommendedLevel = getRecommendedDetailLevel(estimatedTokens, groupCount);

  // Calculate potential reduction
  let potentialReduction: TokenEstimate['potential_reduction'];
  if (recommendedLevel !== 'full') {
    const reducedTokens = recommendedLevel === 'summary'
      ? estimateSummaryTokens()
      : estimateTopNTokens(TOKEN_MANAGEMENT.TOP_N_DEFAULT);
    potentialReduction = {
      reduced_tokens: reducedTokens,
      reduction_percent: calculateTokenReduction(estimatedTokens, recommendedLevel),
    };
  }

  return {
    estimated_tokens: estimatedTokens,
    exceeds_threshold: estimatedTokens > TOKEN_MANAGEMENT.TOKEN_THRESHOLD,
    recommended_detail_level: recommendedLevel,
    breakdown: {
      base_tokens: baseTokens,
      variable_tokens: variableTokens,
      description,
    },
    potential_reduction: potentialReduction,
  };
}

/**
 * Estimate tokens for record retrieval results
 *
 * Record retrieval returns JSON objects, which are more token-heavy than
 * aggregation tables due to field names being repeated for each record.
 *
 * @param input - Record retrieval parameters
 * @returns Detailed token estimate with recommendation
 *
 * @example
 * // 10 records with default fields
 * estimateRecordTokens({ recordCount: 10 });
 * // Returns ~1,250 tokens
 *
 * @example
 * // 100 records with 20 fields each
 * estimateRecordTokens({ recordCount: 100, fieldsPerRecord: 20 });
 * // Returns ~20,250 tokens (over threshold!)
 */
export function estimateRecordTokens(input: RecordEstimateInput): TokenEstimate {
  const {
    recordCount,
    fieldsPerRecord = 10,
    hasNestedObjects = false,
  } = input;

  const baseTokens = TOKEN_MANAGEMENT.BASE_RECORD_TOKENS;

  // Calculate tokens per record based on field count
  // Base is 100 tokens for 10 fields, scales linearly
  let tokensPerRecord = TOKEN_MANAGEMENT.TOKENS_PER_RECORD * (fieldsPerRecord / 10);

  // Nested objects add ~50% overhead (FK resolution, etc.)
  if (hasNestedObjects) {
    tokensPerRecord *= 1.5;
  }

  // Cap at 3x base to prevent extreme estimates
  tokensPerRecord = Math.min(tokensPerRecord, TOKEN_MANAGEMENT.TOKENS_PER_RECORD * 3);

  const variableTokens = recordCount * tokensPerRecord;
  const estimatedTokens = baseTokens + variableTokens;

  const recommendedLevel = getRecommendedDetailLevel(estimatedTokens, recordCount);

  // Calculate potential reduction
  let potentialReduction: TokenEstimate['potential_reduction'];
  if (recommendedLevel !== 'full') {
    const reducedTokens = recommendedLevel === 'summary'
      ? estimateSummaryTokens()
      : estimateTopNTokens(Math.min(recordCount, TOKEN_MANAGEMENT.TOP_N_DEFAULT));
    potentialReduction = {
      reduced_tokens: reducedTokens,
      reduction_percent: calculateTokenReduction(estimatedTokens, recommendedLevel),
    };
  }

  return {
    estimated_tokens: estimatedTokens,
    exceeds_threshold: estimatedTokens > TOKEN_MANAGEMENT.TOKEN_THRESHOLD,
    recommended_detail_level: recommendedLevel,
    breakdown: {
      base_tokens: baseTokens,
      variable_tokens: Math.round(variableTokens),
      description: `Record retrieval: ${recordCount.toLocaleString()} records x ~${Math.round(tokensPerRecord)} tokens/record`,
    },
    potential_reduction: potentialReduction,
  };
}

// =============================================================================
// FORMAT-SPECIFIC ESTIMATION
// =============================================================================

/**
 * Estimate tokens for summary format output
 *
 * Summary format shows only:
 * - Grand total
 * - Record count
 * - Reconciliation checksum
 * - Basic metadata
 *
 * @returns Fixed token count for summary format (~400 tokens)
 */
export function estimateSummaryTokens(): number {
  return TOKEN_MANAGEMENT.SUMMARY_FORMAT_TOKENS;
}

/**
 * Estimate tokens for top_n format output
 *
 * Top N format shows:
 * - Top N groups (sorted by aggregation value)
 * - "Remaining X groups" summary
 * - Grand total
 * - Reconciliation checksum
 *
 * @param n - Number of top items to show (default: 10)
 * @returns Token count for top_n format
 */
export function estimateTopNTokens(n: number = TOKEN_MANAGEMENT.TOP_N_DEFAULT): number {
  // Clamp to valid range
  const clampedN = Math.max(1, Math.min(n, TOKEN_MANAGEMENT.TOP_N_MAX));
  return TOKEN_MANAGEMENT.TOP_N_BASE_TOKENS + (clampedN * TOKEN_MANAGEMENT.TOP_N_PER_ITEM_TOKENS);
}

/**
 * Estimate tokens for full format output
 *
 * Delegates to aggregation or record estimation based on query type.
 *
 * @param groupCount - Number of groups (0 for simple aggregation or records)
 * @param itemCount - Total items (records or aggregation rows)
 * @param isRecordQuery - Whether this is a record retrieval (not aggregation)
 * @returns Estimated tokens for full output
 */
export function estimateFullTokens(
  groupCount: number,
  itemCount: number,
  isRecordQuery: boolean = false
): number {
  if (isRecordQuery) {
    return estimateRecordTokens({ recordCount: itemCount }).estimated_tokens;
  }
  return estimateAggregationTokens({
    totalRecords: itemCount,
    groupCount,
  }).estimated_tokens;
}

// =============================================================================
// DECISION HELPERS
// =============================================================================

/**
 * Check if estimated tokens would exceed the threshold
 *
 * @param estimatedTokens - Token count to check
 * @returns True if over threshold
 */
export function wouldExceedThreshold(estimatedTokens: number): boolean {
  return estimatedTokens > TOKEN_MANAGEMENT.TOKEN_THRESHOLD;
}

/**
 * Get recommended detail level based on estimated tokens
 *
 * Decision logic:
 * - Under 20% of threshold (2,000 tokens): full
 * - Under threshold but many items: top_n
 * - At or over threshold: summary
 *
 * @param estimatedTokens - Estimated token count for full output
 * @param itemCount - Number of items (groups or records)
 * @returns Recommended detail level
 */
export function getRecommendedDetailLevel(
  estimatedTokens: number,
  itemCount: number = 0
): 'summary' | 'top_n' | 'full' {
  const threshold = TOKEN_MANAGEMENT.TOKEN_THRESHOLD;

  // Well under threshold: show full
  if (estimatedTokens < threshold * TOKEN_MANAGEMENT.FULL_THRESHOLD_PERCENT) {
    return 'full';
  }

  // Under threshold but many items: use top_n for readability
  if (estimatedTokens < threshold) {
    if (itemCount > TOKEN_MANAGEMENT.TOP_N_DEFAULT * 2) {
      return 'top_n';
    }
    return 'full';
  }

  // At or over threshold: check if top_n is sufficient
  const topNTokens = estimateTopNTokens(TOKEN_MANAGEMENT.TOP_N_DEFAULT);
  if (topNTokens < threshold * 0.8) {
    return 'top_n';
  }

  // Default to summary for maximum reduction
  return 'summary';
}

/**
 * Calculate token reduction percentage for a given detail level
 *
 * @param fullTokens - Token count for full output
 * @param detailLevel - Target detail level
 * @param topN - Number of items for top_n (default: 10)
 * @returns Percentage reduction (0-100)
 *
 * @example
 * calculateTokenReduction(50000, 'summary');
 * // Returns 99.2 (50,000 -> 400 tokens = 99.2% reduction)
 */
export function calculateTokenReduction(
  fullTokens: number,
  detailLevel: 'summary' | 'top_n' | 'full',
  topN: number = TOKEN_MANAGEMENT.TOP_N_DEFAULT
): number {
  if (detailLevel === 'full' || fullTokens <= 0) {
    return 0;
  }

  const reducedTokens = detailLevel === 'summary'
    ? estimateSummaryTokens()
    : estimateTopNTokens(topN);

  const reduction = ((fullTokens - reducedTokens) / fullTokens) * 100;
  return Math.max(0, Math.min(100, reduction));
}

/**
 * Compare token usage across all detail levels
 *
 * Useful for showing users what they'd get with each option.
 *
 * @param groupCount - Number of groups in aggregation
 * @param totalRecords - Total records processed
 * @param isRecordQuery - Whether this is record retrieval
 * @returns Comparison of all detail levels with savings
 */
export function compareDetailLevels(
  groupCount: number,
  totalRecords: number,
  isRecordQuery: boolean = false
): DetailLevelComparison {
  const fullTokens = estimateFullTokens(groupCount, totalRecords, isRecordQuery);
  const topNTokens = estimateTopNTokens(TOKEN_MANAGEMENT.TOP_N_DEFAULT);
  const summaryTokens = estimateSummaryTokens();

  const recommended = getRecommendedDetailLevel(fullTokens, groupCount || totalRecords);

  return {
    full: fullTokens,
    top_n: topNTokens,
    summary: summaryTokens,
    recommended,
    savings: {
      top_n_vs_full: calculateTokenReduction(fullTokens, 'top_n'),
      summary_vs_full: calculateTokenReduction(fullTokens, 'summary'),
    },
  };
}

// =============================================================================
// FORMATTING HELPERS
// =============================================================================

/**
 * Format token estimate for display in query results
 *
 * Generates human-readable summary of token estimate with recommendation.
 *
 * @param estimate - Token estimate to format
 * @returns Markdown-formatted string
 */
export function formatTokenEstimate(estimate: TokenEstimate): string {
  const lines: string[] = [];

  lines.push(`**Token Estimate:** ${estimate.estimated_tokens.toLocaleString()}`);
  lines.push(`**Threshold:** ${TOKEN_MANAGEMENT.TOKEN_THRESHOLD.toLocaleString()}`);

  if (estimate.exceeds_threshold) {
    lines.push(`**Status:** Exceeds threshold`);
    lines.push(`**Recommendation:** Use \`detail_level: "${estimate.recommended_detail_level}"\``);

    if (estimate.potential_reduction) {
      lines.push(`**Reduced Tokens:** ${estimate.potential_reduction.reduced_tokens.toLocaleString()}`);
      lines.push(`**Token Reduction:** ${estimate.potential_reduction.reduction_percent.toFixed(1)}%`);
    }
  } else {
    lines.push(`**Status:** Within threshold`);
    if (estimate.recommended_detail_level !== 'full') {
      lines.push(`**Suggestion:** Consider \`detail_level: "${estimate.recommended_detail_level}"\` for faster response`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a brief token warning for inclusion in query results
 *
 * @param estimate - Token estimate
 * @returns Short warning string or empty string if within threshold
 */
export function formatTokenWarning(estimate: TokenEstimate): string {
  if (!estimate.exceeds_threshold) {
    return '';
  }

  const reduction = estimate.potential_reduction?.reduction_percent ?? 0;
  return `> **Token Warning:** Response is ~${estimate.estimated_tokens.toLocaleString()} tokens (exceeds ${TOKEN_MANAGEMENT.TOKEN_THRESHOLD.toLocaleString()} threshold). ` +
    `Use \`detail_level: "${estimate.recommended_detail_level}"\` for ${reduction.toFixed(0)}% reduction.`;
}

/**
 * Format detail level comparison for user
 *
 * @param comparison - Comparison result
 * @returns Markdown table showing options
 */
export function formatDetailLevelComparison(comparison: DetailLevelComparison): string {
  const lines: string[] = [];

  lines.push('| Detail Level | Tokens | Savings |');
  lines.push('|--------------|--------|---------|');
  lines.push(`| full | ${comparison.full.toLocaleString()} | - |`);
  lines.push(`| top_n | ${comparison.top_n.toLocaleString()} | ${comparison.savings.top_n_vs_full.toFixed(0)}% |`);
  lines.push(`| summary | ${comparison.summary.toLocaleString()} | ${comparison.savings.summary_vs_full.toFixed(0)}% |`);
  lines.push('');
  lines.push(`**Recommended:** \`${comparison.recommended}\``);

  return lines.join('\n');
}
