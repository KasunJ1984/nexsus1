/**
 * Export Orchestrator Service
 *
 * Central coordinator for all export decisions and execution.
 * Determines when to auto-trigger Excel export based on token thresholds.
 *
 * Key responsibilities:
 * 1. Estimate token count for any result type
 * 2. Decide if auto-export should trigger (>10K tokens)
 * 3. Execute export via appropriate method (R2 or local)
 * 4. Format response with appropriate messaging
 *
 * Supported result types:
 * - aggregation: nexsus_search aggregation results
 * - records: nexsus_search record retrieval
 * - semantic: semantic_search results
 * - similar: find_similar results
 * - graph: graph_traverse results
 * - inspect: inspect_record results
 * - status: system_status results
 * - generic: any array of objects
 *
 * @module services/export-orchestrator
 */

import { AUTO_EXPORT_CONFIG } from '../constants.js';
import {
  estimateAggregationTokens,
  estimateRecordTokens,
  wouldExceedThreshold,
} from './token-estimator.js';
import {
  exportAggregationToExcel,
  exportRecordsToExcel,
  formatExportResponse,
  shouldUseR2,
  type ExportOptions,
} from './file-export.js';
import type {
  FileExportResult,
  AggregationResult,
  ScrollResult,
} from '../types.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Types of results that can be exported
 */
export type ExportableResultType =
  | 'aggregation'   // nexsus_search aggregation results
  | 'records'       // nexsus_search record retrieval
  | 'semantic'      // semantic_search results
  | 'similar'       // find_similar results
  | 'graph'         // graph_traverse results
  | 'inspect'       // inspect_record results
  | 'status'        // system_status results
  | 'generic';      // any array of objects

/**
 * Metadata about the query that produced the result
 */
export interface ExportMetadata {
  /** Name of the tool that produced the result */
  tool_name: string;
  /** Odoo model name (if applicable) */
  model_name?: string;
  /** Human-readable summary of filters applied */
  filters_summary?: string;
  /** Query execution time in milliseconds */
  query_time_ms: number;
  /** Fields requested (for record retrieval) */
  fields?: string[];
  /** Aggregation definitions (for aggregation results) */
  aggregations?: Array<{ field: string; op: string; alias: string }>;
  /** Group by fields (for aggregation results) */
  group_by?: string[];
}

/**
 * Wrapper for any exportable result with metadata
 */
export interface ExportableResult {
  /** Type of result for routing to correct export logic */
  type: ExportableResultType;
  /** The actual result data */
  data: unknown;
  /** Query metadata for reconciliation and tracking */
  metadata: ExportMetadata;
}

/**
 * Options for the orchestrator
 */
export interface OrchestratorOptions extends ExportOptions {
  /** Skip auto-export check (always return inline) */
  skipAutoExport?: boolean;
}

/**
 * Result of orchestrator decision
 */
export interface OrchestratorResult {
  /** Whether export was triggered */
  exported: boolean;
  /** Export result if exported */
  exportResult?: FileExportResult;
  /** Estimated tokens for the result */
  estimatedTokens: number;
  /** Whether result exceeds threshold */
  exceedsThreshold: boolean;
  /** Reason for export decision */
  reason: string;
}

// =============================================================================
// TOKEN ESTIMATION
// =============================================================================

/**
 * Estimate tokens for any exportable result type
 *
 * Routes to appropriate estimator based on result type.
 * Uses empirically-derived formulas for each result type.
 *
 * @param result - Exportable result with type and data
 * @returns Estimated token count
 *
 * @example
 * const tokens = estimateResultTokens({
 *   type: 'aggregation',
 *   data: aggregationResult,
 *   metadata: { tool_name: 'nexsus_search', ... }
 * });
 */
export function estimateResultTokens(result: ExportableResult): number {
  switch (result.type) {
    case 'aggregation':
      return estimateAggregationResultTokens(result.data as AggregationResult);

    case 'records':
      return estimateRecordsResultTokens(result.data as ScrollResult);

    case 'semantic':
      return estimateSemanticSearchTokens(result.data as Array<unknown>);

    case 'similar':
      return estimateFindSimilarTokens(result.data as Array<unknown>);

    case 'graph':
      return estimateGraphTraverseTokens(result.data as Record<string, unknown>);

    case 'inspect':
      return estimateInspectRecordTokens(result.data as Record<string, unknown>);

    case 'status':
      return estimateSystemStatusTokens(result.data as Record<string, unknown>);

    case 'generic':
      return estimateGenericTokens(result.data);

    default:
      // Fallback: JSON length / 4 (rough approximation)
      return estimateGenericTokens(result.data);
  }
}

/**
 * Estimate tokens for aggregation result
 */
function estimateAggregationResultTokens(result: AggregationResult): number {
  const groupCount = result.groups?.length ?? 0;
  const estimate = estimateAggregationTokens({
    totalRecords: result.totalRecords,
    groupCount,
  });
  return estimate.estimated_tokens;
}

/**
 * Estimate tokens for record retrieval result
 */
function estimateRecordsResultTokens(result: ScrollResult): number {
  const estimate = estimateRecordTokens({
    recordCount: result.records.length,
  });
  return estimate.estimated_tokens;
}

/**
 * Estimate tokens for semantic search results
 *
 * Formula: 300 (base) + (count × 150)
 * Each result includes: score, payload summary, metadata
 */
export function estimateSemanticSearchTokens(results: Array<unknown>): number {
  const BASE_TOKENS = 300;
  const TOKENS_PER_RESULT = 150;
  return BASE_TOKENS + (results.length * TOKENS_PER_RESULT);
}

/**
 * Estimate tokens for find_similar results
 *
 * Formula: 250 (base) + (count × 120)
 * Similar to semantic but slightly less metadata per result
 */
export function estimateFindSimilarTokens(results: Array<unknown>): number {
  const BASE_TOKENS = 250;
  const TOKENS_PER_RESULT = 120;
  return BASE_TOKENS + (results.length * TOKENS_PER_RESULT);
}

/**
 * Estimate tokens for graph traverse results
 *
 * Formula: 400 (base) + (outgoing × 50) + (incoming × 30)
 */
export function estimateGraphTraverseTokens(result: Record<string, unknown>): number {
  const BASE_TOKENS = 400;
  const TOKENS_PER_OUTGOING = 50;
  const TOKENS_PER_INCOMING = 30;

  // Extract counts from result structure
  const outgoing = Array.isArray(result.outgoing) ? result.outgoing.length : 0;
  const incoming = Array.isArray(result.incoming) ? result.incoming.length : 0;

  return BASE_TOKENS + (outgoing * TOKENS_PER_OUTGOING) + (incoming * TOKENS_PER_INCOMING);
}

/**
 * Estimate tokens for inspect_record results
 *
 * Formula: 200 (base) + (fields × 10)
 */
export function estimateInspectRecordTokens(result: Record<string, unknown>): number {
  const BASE_TOKENS = 200;
  const TOKENS_PER_FIELD = 10;

  // Count payload fields
  const payload = result.payload as Record<string, unknown> | undefined;
  const fieldCount = payload ? Object.keys(payload).length : 0;

  return BASE_TOKENS + (fieldCount * TOKENS_PER_FIELD);
}

/**
 * Estimate tokens for system_status results
 *
 * Formula: 300 (base) + (models × 20)
 */
export function estimateSystemStatusTokens(result: Record<string, unknown>): number {
  const BASE_TOKENS = 300;
  const TOKENS_PER_MODEL = 20;

  // Count synced models if available
  const syncs = result.syncs as Record<string, unknown> | undefined;
  const modelCount = syncs ? Object.keys(syncs).length : 0;

  return BASE_TOKENS + (modelCount * TOKENS_PER_MODEL);
}

/**
 * Estimate tokens for generic data (fallback)
 *
 * Formula: JSON.stringify(data).length / 4
 * This is a rough approximation based on average chars per token
 */
export function estimateGenericTokens(data: unknown): number {
  try {
    const jsonString = JSON.stringify(data);
    return Math.ceil(jsonString.length / 4);
  } catch {
    // If JSON serialization fails, return a default
    return 500;
  }
}

// =============================================================================
// DECISION LOGIC
// =============================================================================

/**
 * Determine if auto-export should trigger for a result
 *
 * Decision logic:
 * 1. If user explicitly requested export (export_to_file=true), always export
 * 2. If user explicitly declined (export_to_file=false), never auto-export
 * 3. If auto-export is disabled globally, don't auto-export
 * 4. If estimated tokens exceed threshold, auto-export
 *
 * @param result - Exportable result to evaluate
 * @param userRequested - User's explicit export_to_file preference (true/false/undefined)
 * @param options - Orchestrator options
 * @returns Whether to trigger export
 *
 * @example
 * if (shouldAutoExport(result, input.export_to_file)) {
 *   const exportResult = await executeExport(result);
 *   return formatExportResponse(exportResult);
 * }
 */
export function shouldAutoExport(
  result: ExportableResult,
  userRequested?: boolean,
  options?: OrchestratorOptions
): boolean {
  // Skip auto-export check if explicitly disabled
  if (options?.skipAutoExport) {
    return false;
  }

  // User explicitly requested export
  if (userRequested === true) {
    return true;
  }

  // User explicitly declined export
  if (userRequested === false) {
    return false;
  }

  // Check if auto-export is globally enabled
  if (!AUTO_EXPORT_CONFIG.ENABLED) {
    return false;
  }

  // Estimate tokens and check threshold
  const estimatedTokens = estimateResultTokens(result);
  return estimatedTokens > AUTO_EXPORT_CONFIG.TOKEN_THRESHOLD;
}

/**
 * Get the reason for export decision
 *
 * @param estimatedTokens - Token estimate
 * @param userRequested - User's explicit preference
 * @returns Human-readable reason string
 */
export function getExportReason(
  estimatedTokens: number,
  userRequested?: boolean
): string {
  if (userRequested === true) {
    return 'User requested export (export_to_file: true)';
  }

  if (estimatedTokens > AUTO_EXPORT_CONFIG.TOKEN_THRESHOLD) {
    return `Result exceeds ${AUTO_EXPORT_CONFIG.TOKEN_THRESHOLD.toLocaleString()} token threshold (~${estimatedTokens.toLocaleString()} tokens)`;
  }

  return 'Export not triggered';
}

// =============================================================================
// EXPORT EXECUTION
// =============================================================================

/**
 * Execute export for any exportable result
 *
 * Routes to appropriate export function based on result type.
 * Handles both R2 cloud and local filesystem exports.
 *
 * @param result - Exportable result to export
 * @param options - Export options (forceLocal, useR2, etc.)
 * @returns Export result with file path or download URL
 *
 * @example
 * const exportResult = await executeExport({
 *   type: 'aggregation',
 *   data: aggregationResult,
 *   metadata: { tool_name: 'nexsus_search', model_name: 'account.move.line', ... }
 * });
 */
export async function executeExport(
  result: ExportableResult,
  options?: OrchestratorOptions
): Promise<FileExportResult> {
  const estimatedTokens = estimateResultTokens(result);
  const isAutoTriggered = !options?.useR2 && estimatedTokens > AUTO_EXPORT_CONFIG.TOKEN_THRESHOLD;

  // Build export options with auto-trigger info
  const exportOptions: ExportOptions = {
    ...options,
    autoTriggered: isAutoTriggered || options?.autoTriggered,
    autoTriggerReason: isAutoTriggered
      ? `Result exceeded ${AUTO_EXPORT_CONFIG.TOKEN_THRESHOLD.toLocaleString()} token threshold (~${estimatedTokens.toLocaleString()} tokens)`
      : options?.autoTriggerReason,
  };

  // Route to appropriate export function
  switch (result.type) {
    case 'aggregation':
      return await exportAggregationToExcel(
        result.data as AggregationResult,
        {
          model_name: result.metadata.model_name || 'unknown',
          filters_summary: result.metadata.filters_summary || '',
          query_time_ms: result.metadata.query_time_ms,
          aggregations: result.metadata.aggregations || [],
          group_by: result.metadata.group_by,
        },
        exportOptions
      );

    case 'records':
      return await exportRecordsToExcel(
        result.data as ScrollResult,
        {
          model_name: result.metadata.model_name || 'unknown',
          filters_summary: result.metadata.filters_summary || '',
          query_time_ms: result.metadata.query_time_ms,
          fields: result.metadata.fields,
        },
        exportOptions
      );

    case 'semantic':
    case 'similar':
    case 'graph':
    case 'inspect':
    case 'status':
    case 'generic':
      // Convert to generic records format and export
      return await exportGenericToExcel(result, exportOptions);

    default:
      throw new Error(`Unsupported export type: ${result.type}`);
  }
}

/**
 * Export generic results to Excel
 *
 * Converts any array of objects or single object to Excel format.
 * Used for semantic_search, find_similar, graph_traverse, etc.
 *
 * @param result - Exportable result
 * @param options - Export options
 * @returns Export result
 */
async function exportGenericToExcel(
  result: ExportableResult,
  options?: ExportOptions
): Promise<FileExportResult> {
  // Convert data to array of records
  let records: Array<Record<string, unknown>>;

  if (Array.isArray(result.data)) {
    records = result.data.map((item, index) => {
      if (typeof item === 'object' && item !== null) {
        return { _index: index + 1, ...item as Record<string, unknown> };
      }
      return { _index: index + 1, value: item };
    });
  } else if (typeof result.data === 'object' && result.data !== null) {
    // Single object - flatten it
    records = [result.data as Record<string, unknown>];
  } else {
    records = [{ value: result.data }];
  }

  // Create a ScrollResult-like structure
  const scrollResult: ScrollResult = {
    records,
    totalScanned: records.length,
    hasMore: false,
  };

  return await exportRecordsToExcel(
    scrollResult,
    {
      model_name: result.metadata.model_name || result.metadata.tool_name,
      filters_summary: result.metadata.filters_summary || `${result.metadata.tool_name} export`,
      query_time_ms: result.metadata.query_time_ms,
      fields: result.metadata.fields,
    },
    options
  );
}

// =============================================================================
// ORCHESTRATION
// =============================================================================

/**
 * Main orchestration function - evaluate and optionally export a result
 *
 * This is the primary entry point for tools to use.
 * Handles the complete decision flow:
 * 1. Estimate tokens
 * 2. Decide if export should trigger
 * 3. Execute export if needed
 * 4. Return appropriate result
 *
 * @param result - Exportable result to evaluate
 * @param userRequested - User's explicit export_to_file preference
 * @param options - Orchestrator options
 * @returns Orchestrator result with export status and data
 *
 * @example
 * // In a tool handler:
 * const orchestratorResult = await orchestrateExport(
 *   { type: 'aggregation', data: result, metadata: { ... } },
 *   input.export_to_file
 * );
 *
 * if (orchestratorResult.exported) {
 *   return { content: [{ type: 'text', text: formatExportResponse(orchestratorResult.exportResult!) }] };
 * }
 * // Continue with inline response...
 */
export async function orchestrateExport(
  result: ExportableResult,
  userRequested?: boolean,
  options?: OrchestratorOptions
): Promise<OrchestratorResult> {
  const estimatedTokens = estimateResultTokens(result);
  const exceedsThreshold = wouldExceedThreshold(estimatedTokens);
  const shouldExport = shouldAutoExport(result, userRequested, options);
  const reason = getExportReason(estimatedTokens, userRequested);

  if (!shouldExport) {
    return {
      exported: false,
      estimatedTokens,
      exceedsThreshold,
      reason,
    };
  }

  // Execute export
  const exportResult = await executeExport(result, options);

  return {
    exported: true,
    exportResult,
    estimatedTokens,
    exceedsThreshold,
    reason,
  };
}

/**
 * Format orchestrator result for MCP response
 *
 * Convenience function that combines orchestration result with response formatting.
 *
 * @param result - Orchestrator result
 * @param options - Export options for formatting
 * @returns Formatted markdown string
 */
export function formatOrchestratorResponse(
  result: OrchestratorResult,
  options?: ExportOptions
): string {
  if (!result.exported || !result.exportResult) {
    return `Export not triggered: ${result.reason}`;
  }

  return formatExportResponse(result.exportResult, options);
}

// =============================================================================
// UTILITY EXPORTS
// =============================================================================

/**
 * Re-export key functions for convenience
 */
export { formatExportResponse, shouldUseR2 };
export type { ExportOptions };
