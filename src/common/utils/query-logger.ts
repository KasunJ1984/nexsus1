/**
 * Query Logger - Async JSONL logging for search analytics
 *
 * Logs all search queries to logs/query_log.jsonl for Power BI analysis.
 * Uses fire-and-forget async pattern to avoid blocking search operations.
 */

import { appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Log file location
const LOGS_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'query_log.jsonl');

// Ensure logs directory exists (called once on first log)
let logsInitialized = false;

async function ensureLogsDir(): Promise<void> {
  if (logsInitialized) return;

  if (!existsSync(LOGS_DIR)) {
    await mkdir(LOGS_DIR, { recursive: true });
  }
  logsInitialized = true;
}

/**
 * Query log entry structure - designed for Power BI analysis
 */
export interface QueryLogEntry {
  // Timestamp
  timestamp: string;           // ISO 8601 format
  date: string;                // YYYY-MM-DD for easy date filtering
  hour: number;                // 0-23 for time analysis

  // Tool identification
  tool: 'semantic_search' | 'nexsus_search' | 'find_similar';

  // Query details
  query?: string;              // Search query text (semantic_search)
  model_name?: string;         // Target model
  point_type?: string;         // schema, data, all
  search_mode?: string;        // semantic, list, references_out, references_in

  // Filters (nexsus_search)
  filter_count?: number;       // Number of filters applied
  filters_summary?: string;    // Brief filter description

  // Aggregations (nexsus_search)
  has_aggregation?: boolean;
  aggregation_ops?: string[];  // ['sum', 'count', etc.]
  group_by?: string[];

  // Results
  result_count: number;        // Number of results returned
  cache_hit?: boolean;         // Was result from cache?

  // Performance
  latency_ms: number;          // Query execution time

  // Features used
  graph_boost?: boolean;
  nexsus_link?: boolean;
  nexsus_link_json?: boolean;
  dot_notation?: boolean;

  // Error tracking
  error?: string;              // Error message if failed
  success: boolean;
}

/**
 * Log a query asynchronously - fire and forget
 *
 * This function returns immediately and logs in the background.
 * Logging failures are silently ignored to never affect search.
 */
export function logQueryAsync(entry: Partial<QueryLogEntry>): void {
  // Use setImmediate for true async behavior
  setImmediate(async () => {
    try {
      await ensureLogsDir();

      // Build complete log entry with defaults
      const now = new Date();
      const fullEntry: QueryLogEntry = {
        timestamp: now.toISOString(),
        date: now.toISOString().split('T')[0],
        hour: now.getHours(),
        tool: entry.tool || 'semantic_search',
        result_count: entry.result_count ?? 0,
        latency_ms: entry.latency_ms ?? 0,
        success: entry.success ?? true,
        ...entry
      };

      // Append as single JSON line
      const line = JSON.stringify(fullEntry) + '\n';
      await appendFile(LOG_FILE, line, 'utf-8');

    } catch (err) {
      // Silent failure - never affect search operations
      // Uncomment for debugging: console.error('[QueryLogger] Write failed:', err);
    }
  });
}

/**
 * Helper to summarize filters for logging
 */
export function summarizeFilters(filters: Array<{ field: string; op: string; value: unknown }>): string {
  if (!filters || filters.length === 0) return '';

  return filters
    .slice(0, 3)  // First 3 filters only
    .map(f => `${f.field} ${f.op} ${JSON.stringify(f.value)}`.substring(0, 50))
    .join('; ') + (filters.length > 3 ? ` (+${filters.length - 3} more)` : '');
}
