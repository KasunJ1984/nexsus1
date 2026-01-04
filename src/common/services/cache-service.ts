/**
 * Cache Service - LRU cache for search results
 *
 * Caches search results to avoid redundant Qdrant queries.
 * Especially valuable after scalar quantization (rescore overhead).
 * Cleared automatically after schema sync.
 */

import { LRUCache } from 'lru-cache';
import type { VectorSearchResult } from '../types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CACHE_MAX = parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '1800000', 10); // 30 min default
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';

// =============================================================================
// CACHE INSTANCE
// =============================================================================

const searchCache = new LRUCache<string, VectorSearchResult[]>({
  max: CACHE_MAX,
  ttl: CACHE_TTL,
});

// Statistics
let hits = 0;
let misses = 0;

// =============================================================================
// PUBLIC FUNCTIONS
// =============================================================================

/**
 * Generate cache key from search parameters
 *
 * The key includes all parameters that affect search results:
 * - query text (for semantic mode)
 * - search mode
 * - model filter
 * - field type filters
 * - result limit
 * - point type (schema, data, or all)
 */
export function generateCacheKey(
  query: string,
  mode: string,
  modelName?: string,
  fieldTypes?: string[],
  limit?: number,
  minSimilarity?: number,
  pointType?: string
): string {
  return JSON.stringify({
    query: query.toLowerCase().trim(),
    mode,
    modelName,
    fieldTypes: fieldTypes?.sort(),
    limit,
    minSimilarity,
    pointType,
  });
}

/**
 * Check if caching is enabled
 */
export function isCacheEnabled(): boolean {
  return CACHE_ENABLED;
}

/**
 * Get cached results
 *
 * Returns undefined if:
 * - Cache is disabled
 * - Key not found
 * - Entry expired (TTL)
 */
export function getCached(key: string): VectorSearchResult[] | undefined {
  if (!CACHE_ENABLED) {
    return undefined;
  }

  const result = searchCache.get(key);
  if (result) {
    hits++;
    console.error(`[Cache] HIT - ${hits} hits, ${misses} misses, ${getHitRate()}% hit rate`);
    return result;
  }

  misses++;
  return undefined;
}

/**
 * Store results in cache
 */
export function setCache(key: string, results: VectorSearchResult[]): void {
  if (!CACHE_ENABLED) {
    return;
  }

  searchCache.set(key, results);
  console.error(`[Cache] STORED - ${results.length} results cached`);
}

/**
 * Clear entire cache
 *
 * Called after schema sync to ensure fresh data.
 */
export function clearCache(): void {
  const previousSize = searchCache.size;
  searchCache.clear();
  console.error(`[Cache] CLEARED - ${previousSize} entries removed`);
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  enabled: boolean;
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: string;
  ttlMs: number;
} {
  return {
    enabled: CACHE_ENABLED,
    size: searchCache.size,
    maxSize: CACHE_MAX,
    hits,
    misses,
    hitRate: `${getHitRate()}%`,
    ttlMs: CACHE_TTL,
  };
}

/**
 * Reset statistics (for testing)
 */
export function resetStats(): void {
  hits = 0;
  misses = 0;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getHitRate(): string {
  const total = hits + misses;
  if (total === 0) return '0.0';
  return ((hits / total) * 100).toFixed(1);
}
