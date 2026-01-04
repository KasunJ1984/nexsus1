/**
 * Sync Metrics Service
 *
 * Tracks sync operation statistics for monitoring and observability.
 * In-memory storage (resets on restart) - suitable for MCP server lifecycle.
 *
 * Integrates with:
 * - Stage 4: Circuit breaker states included in metrics output
 * - Stage 3: Uses structured logging for metric events
 */

import { logInfo } from './logger.js';

/**
 * Per-model sync statistics
 */
interface ModelStats {
  syncs: number;
  records: number;
  failures: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  last_sync: string | null;
}

/**
 * Aggregate sync metrics
 */
export interface SyncMetrics {
  // Aggregate counters
  total_syncs: number;
  successful_syncs: number;
  failed_syncs: number;
  total_records_processed: number;
  total_records_embedded: number;
  total_records_failed: number;
  total_duration_ms: number;

  // Timing
  last_sync_timestamp: string | null;
  first_sync_timestamp: string | null;

  // Per-model breakdown
  by_model: Record<string, ModelStats>;
}

/**
 * In-memory metrics storage
 */
let metrics: SyncMetrics = {
  total_syncs: 0,
  successful_syncs: 0,
  failed_syncs: 0,
  total_records_processed: 0,
  total_records_embedded: 0,
  total_records_failed: 0,
  total_duration_ms: 0,
  last_sync_timestamp: null,
  first_sync_timestamp: null,
  by_model: {},
};

/**
 * Record completion of a sync operation
 *
 * Call this at the end of syncModelData() to track metrics.
 *
 * @param modelName - Odoo model that was synced
 * @param success - Whether sync completed successfully
 * @param recordsProcessed - Total records fetched from Odoo
 * @param recordsEmbedded - Records successfully embedded and stored
 * @param durationMs - Total sync duration in milliseconds
 */
export function recordSyncComplete(
  modelName: string,
  success: boolean,
  recordsProcessed: number,
  recordsEmbedded: number,
  durationMs: number
): void {
  const now = new Date().toISOString();

  // Update aggregate counters
  metrics.total_syncs++;
  if (success) {
    metrics.successful_syncs++;
  } else {
    metrics.failed_syncs++;
  }

  metrics.total_records_processed += recordsProcessed;
  metrics.total_records_embedded += recordsEmbedded;
  metrics.total_records_failed += (recordsProcessed - recordsEmbedded);
  metrics.total_duration_ms += durationMs;

  // Update timestamps
  metrics.last_sync_timestamp = now;
  if (!metrics.first_sync_timestamp) {
    metrics.first_sync_timestamp = now;
  }

  // Update per-model stats
  if (!metrics.by_model[modelName]) {
    metrics.by_model[modelName] = {
      syncs: 0,
      records: 0,
      failures: 0,
      total_duration_ms: 0,
      avg_duration_ms: 0,
      last_sync: null,
    };
  }

  const modelStats = metrics.by_model[modelName];
  modelStats.syncs++;
  modelStats.records += recordsEmbedded;
  modelStats.failures += (recordsProcessed - recordsEmbedded);
  modelStats.total_duration_ms += durationMs;
  modelStats.avg_duration_ms = Math.round(modelStats.total_duration_ms / modelStats.syncs);
  modelStats.last_sync = now;

  // Log metric event (structured)
  logInfo('Sync metrics recorded', {
    model_name: modelName,
    success,
    records_processed: recordsProcessed,
    records_embedded: recordsEmbedded,
    duration_ms: durationMs,
    total_syncs: metrics.total_syncs,
  });
}

/**
 * Get current sync metrics
 *
 * Returns a copy to prevent external mutation.
 */
export function getMetrics(): SyncMetrics {
  return {
    ...metrics,
    by_model: { ...metrics.by_model },
  };
}

/**
 * Reset all metrics to initial state
 *
 * Useful for testing or manual reset via admin tool.
 */
export function resetMetrics(): void {
  metrics = {
    total_syncs: 0,
    successful_syncs: 0,
    failed_syncs: 0,
    total_records_processed: 0,
    total_records_embedded: 0,
    total_records_failed: 0,
    total_duration_ms: 0,
    last_sync_timestamp: null,
    first_sync_timestamp: null,
    by_model: {},
  };

  logInfo('Sync metrics reset', {});
}

/**
 * Get formatted metrics summary string
 *
 * Useful for tool output formatting.
 */
export function formatMetricsSummary(): string {
  const m = metrics;
  const lines: string[] = [];

  lines.push('Sync Metrics Summary');
  lines.push('====================');
  lines.push('');

  // Overall stats
  const successRate = m.total_syncs > 0
    ? Math.round((m.successful_syncs / m.total_syncs) * 100)
    : 0;

  lines.push('Overall:');
  lines.push(`  Total Syncs: ${m.total_syncs} (${m.successful_syncs} success, ${m.failed_syncs} failed)`);
  lines.push(`  Success Rate: ${successRate}%`);
  lines.push(`  Records Processed: ${m.total_records_processed.toLocaleString()}`);
  lines.push(`  Records Embedded: ${m.total_records_embedded.toLocaleString()}`);
  lines.push(`  Records Failed: ${m.total_records_failed.toLocaleString()}`);
  lines.push(`  Total Duration: ${formatDuration(m.total_duration_ms)}`);
  lines.push('');

  // Timing
  lines.push('Timing:');
  lines.push(`  First Sync: ${m.first_sync_timestamp || 'Never'}`);
  lines.push(`  Last Sync: ${m.last_sync_timestamp || 'Never'}`);
  lines.push('');

  // Per-model breakdown
  if (Object.keys(m.by_model).length > 0) {
    lines.push('By Model:');
    for (const [model, stats] of Object.entries(m.by_model)) {
      const modelSuccessRate = stats.syncs > 0 && stats.failures === 0 ? 100 :
        stats.syncs > 0 ? Math.round(((stats.records) / (stats.records + stats.failures)) * 100) : 0;
      lines.push(`  ${model}:`);
      lines.push(`    Syncs: ${stats.syncs}`);
      lines.push(`    Records: ${stats.records.toLocaleString()} (${stats.failures} failed)`);
      lines.push(`    Avg Duration: ${formatDuration(stats.avg_duration_ms)}`);
      lines.push(`    Last Sync: ${stats.last_sync || 'Never'}`);
    }
  } else {
    lines.push('By Model: No syncs recorded yet');
  }

  return lines.join('\n');
}

/**
 * Format milliseconds as human-readable duration
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  } else {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.round((ms % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  }
}
