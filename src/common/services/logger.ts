/**
 * Structured Logger Service
 *
 * Provides JSON-formatted logging for sync operations.
 * All logs go to stderr (stdout reserved for MCP JSON-RPC protocol).
 *
 * Benefits:
 * - Correlation: All logs from same sync share sync_id
 * - Filtering: grep "sync_abc123" shows entire sync lifecycle
 * - Parsing: JSON can be piped to jq, log aggregators, etc.
 * - Metrics: Can extract timing, record counts for dashboards
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  // Sync identification
  sync_id?: string;
  model_name?: string;

  // Progress tracking
  phase?: string;
  batch?: number;
  records?: number;
  total?: number;
  progress_pct?: number;

  // Performance
  duration_ms?: number;

  // Memory
  heap_mb?: number;
  heap_total_mb?: number;
  rss_mb?: number;

  // Errors
  error?: string;
  records_to_dlq?: number;

  // Extensible
  [key: string]: unknown;
}

/**
 * Log a structured message to stderr
 *
 * Output format:
 * {"ts":"2025-12-16T10:30:45.123Z","level":"info","msg":"Batch fetched","sync_id":"sync_abc123",...}
 */
export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...context,
  };
  console.error(JSON.stringify(entry));
}

// Convenience functions
export const logInfo = (msg: string, ctx?: LogContext) => log('info', msg, ctx);
export const logWarn = (msg: string, ctx?: LogContext) => log('warn', msg, ctx);
export const logError = (msg: string, ctx?: LogContext) => log('error', msg, ctx);
export const logDebug = (msg: string, ctx?: LogContext) => log('debug', msg, ctx);

/**
 * Generate unique sync ID for log correlation
 * Format: sync_<timestamp>_<random>
 *
 * Example: sync_1734345045123_a1b2c3
 */
export function generateSyncId(): string {
  return `sync_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}
