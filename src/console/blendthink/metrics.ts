/**
 * Blendthink Metrics Service
 *
 * Tracks blendthink operation statistics for monitoring and observability.
 * In-memory storage (resets on restart) - suitable for MCP server lifecycle.
 *
 * Tracks:
 * - Question type distribution
 * - Persona usage
 * - Token consumption
 * - Execution latency per section
 * - Session statistics
 *
 * @module blendthink/metrics
 */

import type { QuestionType, PersonaType, BlendSection } from '../../common/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Per-section execution statistics
 */
interface SectionStats {
  executions: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalTokens: number;
}

/**
 * Question type statistics
 */
interface QuestionTypeStats {
  count: number;
  avgConfidence: number;
  totalConfidence: number;
}

/**
 * Persona usage statistics
 */
interface PersonaStats {
  count: number;
}

/**
 * Aggregate blendthink metrics
 */
export interface BlendthinkMetrics {
  // Query execution counters
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  clarificationRequests: number;

  // Token usage
  totalInputTokens: number;
  totalOutputTokens: number;
  avgTokensPerQuery: number;

  // Timing
  totalDurationMs: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;

  // Timestamps
  firstQueryTimestamp: string | null;
  lastQueryTimestamp: string | null;

  // Breakdowns
  byQuestionType: Record<QuestionType, QuestionTypeStats>;
  byPersona: Record<PersonaType, PersonaStats>;
  bySection: Record<BlendSection, SectionStats>;

  // Session stats
  totalSessions: number;
  avgTurnsPerSession: number;
}

// =============================================================================
// IN-MEMORY STORAGE
// =============================================================================

const createEmptyMetrics = (): BlendthinkMetrics => ({
  totalQueries: 0,
  successfulQueries: 0,
  failedQueries: 0,
  clarificationRequests: 0,

  totalInputTokens: 0,
  totalOutputTokens: 0,
  avgTokensPerQuery: 0,

  totalDurationMs: 0,
  avgDurationMs: 0,
  minDurationMs: Infinity,
  maxDurationMs: 0,

  firstQueryTimestamp: null,
  lastQueryTimestamp: null,

  byQuestionType: {} as Record<QuestionType, QuestionTypeStats>,
  byPersona: {} as Record<PersonaType, PersonaStats>,
  bySection: {} as Record<BlendSection, SectionStats>,

  totalSessions: 0,
  avgTurnsPerSession: 0,
});

let metrics: BlendthinkMetrics = createEmptyMetrics();

// =============================================================================
// RECORDING FUNCTIONS
// =============================================================================

/**
 * Record a query execution
 *
 * @param questionType - The classified question type
 * @param persona - The selected persona
 * @param success - Whether the query succeeded
 * @param needsClarification - Whether clarification was requested
 * @param durationMs - Total execution duration in milliseconds
 * @param inputTokens - Input tokens consumed
 * @param outputTokens - Output tokens generated
 * @param confidence - Classification confidence (0-1)
 */
export function recordQueryExecution(
  questionType: QuestionType,
  persona: PersonaType,
  success: boolean,
  needsClarification: boolean,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  confidence: number
): void {
  const now = new Date().toISOString();

  // Update aggregate counters
  metrics.totalQueries++;
  if (success) {
    metrics.successfulQueries++;
  } else {
    metrics.failedQueries++;
  }
  if (needsClarification) {
    metrics.clarificationRequests++;
  }

  // Update token usage
  metrics.totalInputTokens += inputTokens;
  metrics.totalOutputTokens += outputTokens;
  metrics.avgTokensPerQuery =
    (metrics.totalInputTokens + metrics.totalOutputTokens) / metrics.totalQueries;

  // Update timing
  metrics.totalDurationMs += durationMs;
  metrics.avgDurationMs = metrics.totalDurationMs / metrics.totalQueries;
  metrics.minDurationMs = Math.min(metrics.minDurationMs, durationMs);
  metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);

  // Update timestamps
  metrics.lastQueryTimestamp = now;
  if (!metrics.firstQueryTimestamp) {
    metrics.firstQueryTimestamp = now;
  }

  // Update question type stats
  if (!metrics.byQuestionType[questionType]) {
    metrics.byQuestionType[questionType] = {
      count: 0,
      avgConfidence: 0,
      totalConfidence: 0,
    };
  }
  const typeStats = metrics.byQuestionType[questionType];
  typeStats.count++;
  typeStats.totalConfidence += confidence;
  typeStats.avgConfidence = typeStats.totalConfidence / typeStats.count;

  // Update persona stats
  if (!metrics.byPersona[persona]) {
    metrics.byPersona[persona] = { count: 0 };
  }
  metrics.byPersona[persona].count++;

  console.error(
    `[BlendthinkMetrics] Query recorded: ${questionType} / ${persona} / ${durationMs}ms`
  );
}

/**
 * Record section execution
 *
 * @param section - The section that was executed
 * @param success - Whether execution succeeded
 * @param durationMs - Execution duration in milliseconds
 * @param tokenEstimate - Estimated tokens used
 */
export function recordSectionExecution(
  section: BlendSection,
  success: boolean,
  durationMs: number,
  tokenEstimate: number
): void {
  if (!metrics.bySection[section]) {
    metrics.bySection[section] = {
      executions: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      totalTokens: 0,
    };
  }

  const stats = metrics.bySection[section];
  stats.executions++;
  if (success) {
    stats.successes++;
  } else {
    stats.failures++;
  }
  stats.totalDurationMs += durationMs;
  stats.avgDurationMs = stats.totalDurationMs / stats.executions;
  stats.totalTokens += tokenEstimate;
}

/**
 * Record a new session
 *
 * @param turnsCount - Number of turns in the session
 */
export function recordSession(turnsCount: number): void {
  metrics.totalSessions++;
  metrics.avgTurnsPerSession =
    (metrics.avgTurnsPerSession * (metrics.totalSessions - 1) + turnsCount) /
    metrics.totalSessions;
}

// =============================================================================
// RETRIEVAL FUNCTIONS
// =============================================================================

/**
 * Get current metrics snapshot
 *
 * @returns Copy of current metrics
 */
export function getBlendthinkMetrics(): BlendthinkMetrics {
  // Clean up Infinity for display
  const snapshot = { ...metrics };
  if (snapshot.minDurationMs === Infinity) {
    snapshot.minDurationMs = 0;
  }
  return snapshot;
}

/**
 * Get metrics summary for display
 *
 * @returns Human-readable metrics summary
 */
export function getMetricsSummary(): string {
  const m = getBlendthinkMetrics();
  const lines: string[] = [];

  lines.push('# Blendthink Metrics');
  lines.push('');

  // Overview
  lines.push('## Overview');
  lines.push(`- Total Queries: ${m.totalQueries}`);
  lines.push(`- Success Rate: ${m.totalQueries > 0 ? ((m.successfulQueries / m.totalQueries) * 100).toFixed(1) : 0}%`);
  lines.push(`- Clarification Rate: ${m.totalQueries > 0 ? ((m.clarificationRequests / m.totalQueries) * 100).toFixed(1) : 0}%`);
  lines.push('');

  // Token Usage
  lines.push('## Token Usage');
  lines.push(`- Total Input Tokens: ${m.totalInputTokens.toLocaleString()}`);
  lines.push(`- Total Output Tokens: ${m.totalOutputTokens.toLocaleString()}`);
  lines.push(`- Avg Tokens/Query: ${m.avgTokensPerQuery.toFixed(0)}`);
  lines.push('');

  // Timing
  lines.push('## Timing');
  lines.push(`- Avg Duration: ${m.avgDurationMs.toFixed(0)}ms`);
  lines.push(`- Min Duration: ${m.minDurationMs}ms`);
  lines.push(`- Max Duration: ${m.maxDurationMs}ms`);
  lines.push('');

  // Question Types
  if (Object.keys(m.byQuestionType).length > 0) {
    lines.push('## Question Types');
    for (const [type, stats] of Object.entries(m.byQuestionType)) {
      const pct = ((stats.count / m.totalQueries) * 100).toFixed(1);
      lines.push(`- ${type}: ${stats.count} (${pct}%) | Avg Confidence: ${(stats.avgConfidence * 100).toFixed(0)}%`);
    }
    lines.push('');
  }

  // Personas
  if (Object.keys(m.byPersona).length > 0) {
    lines.push('## Personas');
    for (const [persona, stats] of Object.entries(m.byPersona)) {
      const pct = ((stats.count / m.totalQueries) * 100).toFixed(1);
      lines.push(`- ${persona}: ${stats.count} (${pct}%)`);
    }
    lines.push('');
  }

  // Sections
  if (Object.keys(m.bySection).length > 0) {
    lines.push('## Section Execution');
    for (const [section, stats] of Object.entries(m.bySection)) {
      const successRate = ((stats.successes / stats.executions) * 100).toFixed(1);
      lines.push(`- ${section}: ${stats.executions} calls | ${successRate}% success | ${stats.avgDurationMs.toFixed(0)}ms avg`);
    }
    lines.push('');
  }

  // Sessions
  lines.push('## Sessions');
  lines.push(`- Total Sessions: ${m.totalSessions}`);
  lines.push(`- Avg Turns/Session: ${m.avgTurnsPerSession.toFixed(1)}`);
  lines.push('');

  // Timestamps
  if (m.firstQueryTimestamp) {
    lines.push('## Timeline');
    lines.push(`- First Query: ${m.firstQueryTimestamp}`);
    lines.push(`- Last Query: ${m.lastQueryTimestamp}`);
  }

  return lines.join('\n');
}

/**
 * Reset all metrics
 */
export function resetBlendthinkMetrics(): void {
  metrics = createEmptyMetrics();
  console.error('[BlendthinkMetrics] Metrics reset');
}

// =============================================================================
// EXPORT SINGLETON
// =============================================================================

export const blendthinkMetrics = {
  recordQueryExecution,
  recordSectionExecution,
  recordSession,
  getMetrics: getBlendthinkMetrics,
  getSummary: getMetricsSummary,
  reset: resetBlendthinkMetrics,
};
