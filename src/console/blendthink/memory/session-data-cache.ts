/**
 * Session Data Cache
 *
 * In-memory LRU cache for section results, enabling drilldown operations
 * without re-querying Qdrant.
 *
 * Design choices:
 * - In-memory only (no R2) for speed
 * - Session-scoped (data evicted with session)
 * - LRU eviction when max entries reached
 * - Size-aware (tracks estimated bytes)
 * - 30-minute TTL per entry
 */

import type { BlendSection, FilterCondition, Aggregation } from '../../../common/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Drilldown operation types
 */
export type DrilldownOperation =
  | 'regroup' // Change GROUP BY (e.g., "by customer" -> "by account")
  | 'expand' // Show underlying records for a group
  | 'export' // Export cached data to Excel
  | 'filter' // Add additional filter to cached data
  | 'sort'; // Re-sort cached data

/**
 * Union of possible section data types
 */
export type SectionDataUnion = AggregationCacheData | RecordsCacheData | SemanticCacheData;

/**
 * Aggregation results with underlying records
 */
export interface AggregationCacheData {
  type: 'aggregation';
  /** Aggregation results (totals or grouped) */
  results: Record<string, unknown>[];
  /** Group by fields if grouped */
  groupBy?: string[];
  /** Total records processed */
  totalRecords: number;
  /** Underlying records for re-aggregation (optional, for drilldown) */
  underlyingRecords?: Record<string, unknown>[];
  /** Reconciliation checksum */
  reconciliation?: {
    checksum: string;
    recordCount: number;
    grandTotal?: number;
  };
}

/**
 * Record scroll results
 */
export interface RecordsCacheData {
  type: 'records';
  /** Retrieved records */
  records: Record<string, unknown>[];
  /** Total matching records */
  totalMatched: number;
  /** Whether more records exist */
  hasMore: boolean;
}

/**
 * Semantic search results
 */
export interface SemanticCacheData {
  type: 'semantic';
  /** Matching records with scores */
  matches: Array<{
    id: string;
    score: number;
    model_name?: string;
    record_id?: number;
    display_name?: string;
    payload: Record<string, unknown>;
  }>;
  /** Total matches */
  totalMatches: number;
  /** Whether more exist */
  hasMore: boolean;
}

/**
 * Cached section result with full data
 */
export interface CachedSectionData {
  /** Session this data belongs to */
  sessionId: string;

  /** Turn number when this data was fetched */
  turnNumber: number;

  /** Which section produced this data */
  section: BlendSection;

  /** Which tool was called */
  tool: string;

  /** The actual data (records, aggregations, matches) */
  data: SectionDataUnion;

  /** Cache metadata */
  metadata: {
    /** When this data was cached */
    cachedAt: Date;
    /** Original query that produced this data */
    query: string;
    /** Model name for the data */
    modelName: string;
    /** Number of records in data */
    recordCount: number;
    /** Estimated bytes (for memory pressure monitoring) */
    estimatedBytes: number;
    /** Filters that were applied */
    filters?: FilterCondition[];
    /** Group by fields used */
    groupBy?: string[];
    /** Aggregations used */
    aggregations?: Aggregation[];
  };
}

/**
 * Drilldown request
 */
export interface DrilldownRequest {
  /** Operation to perform */
  operation: DrilldownOperation;
  /** Session to operate on */
  sessionId: string;
  /** New group by fields (for regroup) */
  newGroupBy?: string[];
  /** Group key to expand (for expand) */
  expandGroupKey?: Record<string, unknown>;
  /** Additional filter (for filter) */
  additionalFilter?: FilterCondition;
  /** Sort field and direction (for sort) */
  sort?: { field: string; direction: 'asc' | 'desc' };
}

/**
 * Drilldown result
 */
export interface DrilldownResult {
  /** Whether drilldown succeeded */
  success: boolean;
  /** Result data */
  data?: SectionDataUnion;
  /** Error message if failed */
  error?: string;
  /** Whether this came from cache */
  fromCache: boolean;
  /** Cache hit metadata */
  cacheStats?: {
    hitTurn: number;
    ageMs: number;
    originalQuery: string;
  };
}

/**
 * Cache statistics
 */
export interface SessionDataCacheStats {
  entries: number;
  maxEntries: number;
  totalBytes: number;
  maxBytes: number;
  oldestAgeMs: number;
  newestAgeMs: number;
  hitCount: number;
  missCount: number;
}

// =============================================================================
// SESSION DATA CACHE
// =============================================================================

export class SessionDataCache {
  private readonly MAX_ENTRIES = 100;
  private readonly MAX_BYTES = 50_000_000; // 50MB max memory
  private readonly TTL_MS = 30 * 60 * 1000; // 30 minutes

  // LRU cache: key -> CachedSectionData
  private cache: Map<string, CachedSectionData> = new Map();
  private totalBytes: number = 0;
  private hitCount: number = 0;
  private missCount: number = 0;

  /**
   * Store section result in cache
   */
  store(
    sessionId: string,
    turnNumber: number,
    section: BlendSection,
    tool: string,
    data: SectionDataUnion,
    metadata: Omit<CachedSectionData['metadata'], 'cachedAt' | 'estimatedBytes'>
  ): void {
    const key = this.buildKey(sessionId, turnNumber, section);
    const estimatedBytes = this.estimateBytes(data);

    // Check if we need to evict
    this.evictIfNeeded(estimatedBytes);

    const cached: CachedSectionData = {
      sessionId,
      turnNumber,
      section,
      tool,
      data,
      metadata: {
        ...metadata,
        cachedAt: new Date(),
        estimatedBytes,
      },
    };

    // If key exists, remove old entry first
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.metadata.estimatedBytes;
      this.cache.delete(key);
    }

    this.cache.set(key, cached);
    this.totalBytes += estimatedBytes;

    console.error(
      `[SessionDataCache] Stored: session=${sessionId.substring(0, 8)}... turn=${turnNumber} section=${section} (${this.formatBytes(estimatedBytes)}, ${this.cache.size} entries)`
    );
  }

  /**
   * Get cached data for a session's most recent matching section
   */
  get(sessionId: string, section?: BlendSection): CachedSectionData | null {
    let newest: CachedSectionData | null = null;
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (entry.sessionId !== sessionId) continue;
      if (section && entry.section !== section) continue;

      // Check TTL
      if (Date.now() - entry.metadata.cachedAt.getTime() > this.TTL_MS) {
        keysToDelete.push(key);
        continue;
      }

      if (!newest || entry.turnNumber > newest.turnNumber) {
        newest = entry;
      }
    }

    // Clean up expired entries
    for (const key of keysToDelete) {
      const entry = this.cache.get(key);
      if (entry) {
        this.totalBytes -= entry.metadata.estimatedBytes;
        this.cache.delete(key);
      }
    }

    if (newest) {
      // Update LRU order (delete and re-add)
      const key = this.buildKey(newest.sessionId, newest.turnNumber, newest.section);
      this.cache.delete(key);
      this.cache.set(key, newest);

      this.hitCount++;
      console.error(
        `[SessionDataCache] Hit: session=${sessionId.substring(0, 8)}... turn=${newest.turnNumber} (age: ${this.formatAge(newest.metadata.cachedAt)})`
      );
    } else {
      this.missCount++;
    }

    return newest;
  }

  /**
   * Get cached data for a specific turn
   */
  getByTurn(sessionId: string, turnNumber: number, section?: BlendSection): CachedSectionData | null {
    const key = section
      ? this.buildKey(sessionId, turnNumber, section)
      : this.findKeyByTurn(sessionId, turnNumber);

    if (!key) {
      this.missCount++;
      return null;
    }

    const entry = this.cache.get(key);

    if (!entry) {
      this.missCount++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.metadata.cachedAt.getTime() > this.TTL_MS) {
      this.cache.delete(key);
      this.totalBytes -= entry.metadata.estimatedBytes;
      this.missCount++;
      return null;
    }

    // Update LRU order
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hitCount++;
    return entry;
  }

  /**
   * Get all cached entries for a session
   */
  getSessionEntries(sessionId: string): CachedSectionData[] {
    const entries: CachedSectionData[] = [];

    for (const entry of this.cache.values()) {
      if (entry.sessionId === sessionId) {
        // Check TTL
        if (Date.now() - entry.metadata.cachedAt.getTime() <= this.TTL_MS) {
          entries.push(entry);
        }
      }
    }

    return entries.sort((a, b) => b.turnNumber - a.turnNumber);
  }

  /**
   * Clear all entries for a session
   */
  clearSession(sessionId: string): number {
    let cleared = 0;

    for (const [key, entry] of this.cache) {
      if (entry.sessionId === sessionId) {
        this.cache.delete(key);
        this.totalBytes -= entry.metadata.estimatedBytes;
        cleared++;
      }
    }

    if (cleared > 0) {
      console.error(`[SessionDataCache] Cleared ${cleared} entries for session ${sessionId.substring(0, 8)}...`);
    }

    return cleared;
  }

  /**
   * Get cache statistics
   */
  getStats(): SessionDataCacheStats {
    let oldest = Date.now();
    let newest = 0;

    for (const entry of this.cache.values()) {
      const age = entry.metadata.cachedAt.getTime();
      if (age < oldest) oldest = age;
      if (age > newest) newest = age;
    }

    return {
      entries: this.cache.size,
      maxEntries: this.MAX_ENTRIES,
      totalBytes: this.totalBytes,
      maxBytes: this.MAX_BYTES,
      oldestAgeMs: this.cache.size > 0 ? Date.now() - oldest : 0,
      newestAgeMs: this.cache.size > 0 ? Date.now() - newest : 0,
      hitCount: this.hitCount,
      missCount: this.missCount,
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now - entry.metadata.cachedAt.getTime() > this.TTL_MS) {
        this.cache.delete(key);
        this.totalBytes -= entry.metadata.estimatedBytes;
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.error(`[SessionDataCache] Cleaned ${cleaned} expired entries`);
    }

    return cleaned;
  }

  // ============ Private Methods ============

  private buildKey(sessionId: string, turnNumber: number, section: BlendSection): string {
    return `${sessionId}:${turnNumber}:${section}`;
  }

  private findKeyByTurn(sessionId: string, turnNumber: number): string | null {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${sessionId}:${turnNumber}:`)) {
        return key;
      }
    }
    return null;
  }

  private estimateBytes(data: SectionDataUnion): number {
    try {
      return JSON.stringify(data).length * 2; // UTF-16 estimate
    } catch {
      return 10000; // Default estimate
    }
  }

  private evictIfNeeded(newBytes: number): void {
    // Evict by entry count
    while (this.cache.size >= this.MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const entry = this.cache.get(oldestKey);
        if (entry) {
          this.totalBytes -= entry.metadata.estimatedBytes;
          console.error(`[SessionDataCache] Evicted (count limit): ${oldestKey.substring(0, 20)}...`);
        }
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    // Evict by byte size
    while (this.totalBytes + newBytes > this.MAX_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const entry = this.cache.get(oldestKey);
        if (entry) {
          this.totalBytes -= entry.metadata.estimatedBytes;
          console.error(`[SessionDataCache] Evicted (memory limit): ${oldestKey.substring(0, 20)}...`);
        }
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  }

  private formatAge(cachedAt: Date): string {
    const ageMs = Date.now() - cachedAt.getTime();
    if (ageMs < 1000) return `${ageMs}ms`;
    if (ageMs < 60000) return `${(ageMs / 1000).toFixed(1)}s`;
    return `${(ageMs / 60000).toFixed(1)}min`;
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let cacheInstance: SessionDataCache | null = null;

/**
 * Get the singleton SessionDataCache instance
 */
export function getSessionDataCache(): SessionDataCache {
  if (!cacheInstance) {
    cacheInstance = new SessionDataCache();
    console.error('[SessionDataCache] Initialized');
  }
  return cacheInstance;
}
