/**
 * Blendthink Memory Layer
 *
 * Provides persistent memory for:
 * - Synthesis caching (reduce Claude API costs)
 * - Session persistence (resume conversations)
 * - Query pattern memory (System 1 fast path)
 *
 * Uses hybrid storage:
 * - In-memory for hot data (fast lookup)
 * - R2 for persistence (survive restarts)
 */

// Synthesis Cache
export {
  SynthesisCache,
  getSynthesisCache,
  type CachedSynthesis,
} from './synthesis-cache.js';

// Session Persistence
export {
  SessionPersistence,
  getSessionPersistence,
  type PersistedSession,
} from './session-persistence.js';

// Query Pattern Memory
export {
  QueryPatternMemory,
  getQueryPatternMemory,
  type QueryPattern,
  type PatternMatch,
} from './query-pattern-memory.js';

// Session Data Cache (for drilldown)
export {
  SessionDataCache,
  getSessionDataCache,
  type CachedSectionData,
  type SectionDataUnion,
  type AggregationCacheData,
  type RecordsCacheData,
  type SemanticCacheData,
  type DrilldownOperation,
  type DrilldownRequest,
  type DrilldownResult,
  type SessionDataCacheStats,
} from './session-data-cache.js';

// Drilldown Handler
export { DrilldownHandler, getDrilldownHandler } from './drilldown-handler.js';

// Re-Aggregation Engine
export {
  reAggregate,
  applyFilter,
  applyFilters,
  detectAggregations,
  sortRecords,
  topN,
} from './re-aggregation-engine.js';

// =============================================================================
// MEMORY LAYER FACADE
// =============================================================================

import { getSynthesisCache } from './synthesis-cache.js';
import { getSessionPersistence } from './session-persistence.js';
import { getQueryPatternMemory } from './query-pattern-memory.js';
import { getSessionDataCache } from './session-data-cache.js';
import { isR2Enabled } from '../../../common/services/r2-client.js';

/**
 * Memory layer status
 */
export interface MemoryStatus {
  /** Whether R2 storage is available */
  r2Available: boolean;

  /** Synthesis cache stats */
  synthesisCache: {
    enabled: boolean;
  };

  /** Session persistence stats */
  sessionPersistence: {
    enabled: boolean;
  };

  /** Query pattern memory stats */
  queryPatternMemory: {
    cacheSize: number;
    maxSize: number;
  };

  /** Session data cache stats (for drilldown) */
  sessionDataCache: {
    entries: number;
    maxEntries: number;
    totalBytes: number;
    maxBytes: number;
    hitCount: number;
    missCount: number;
  };
}

/**
 * Get memory layer status
 */
export function getMemoryStatus(): MemoryStatus {
  const patternStats = getQueryPatternMemory().getStats();
  const dataCacheStats = getSessionDataCache().getStats();

  return {
    r2Available: isR2Enabled(),
    synthesisCache: {
      enabled: isR2Enabled(),
    },
    sessionPersistence: {
      enabled: isR2Enabled(),
    },
    queryPatternMemory: {
      cacheSize: patternStats.cacheSize,
      maxSize: patternStats.maxSize,
    },
    sessionDataCache: {
      entries: dataCacheStats.entries,
      maxEntries: dataCacheStats.maxEntries,
      totalBytes: dataCacheStats.totalBytes,
      maxBytes: dataCacheStats.maxBytes,
      hitCount: dataCacheStats.hitCount,
      missCount: dataCacheStats.missCount,
    },
  };
}

/**
 * Initialize memory layer (restore from R2 if available)
 */
export async function initializeMemoryLayer(): Promise<void> {
  console.error('[MemoryLayer] Initializing...');

  // Restore query patterns from today's backup
  if (isR2Enabled()) {
    const restored = await getQueryPatternMemory().restoreFromBackup();
    console.error(`[MemoryLayer] Restored ${restored} patterns from R2`);
  }

  console.error('[MemoryLayer] Ready:', getMemoryStatus());
}
