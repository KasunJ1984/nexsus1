/**
 * Synthesis Cache
 *
 * Caches Claude synthesis results in R2 to reduce API costs
 * for repeated or similar queries.
 *
 * Cache key = hash(normalized_query + section_fingerprint)
 * TTL = 1 hour (configurable)
 */

import crypto from 'crypto';
import { isR2Enabled, uploadJson, getJson } from '../../../common/services/r2-client.js';
import type { BlendSection } from '../../../common/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Cached synthesis data
 */
export interface CachedSynthesis {
  /** Hash of the query */
  queryHash: string;

  /** Hash of section results (for cache invalidation) */
  dataHash: string;

  /** Cached response text */
  response: string;

  /** Cached sources */
  sources: Array<{
    section: BlendSection;
    tool: string;
    contribution: string;
    dataPoints?: number;
  }>;

  /** When this was cached */
  createdAt: string;

  /** When this cache entry expires */
  expiresAt: string;

  /** Number of cache hits */
  hitCount: number;
}

/**
 * Section result summary for cache key
 */
interface SectionResultSummary {
  section: string;
  tool: string;
  recordCount?: number;
  success: boolean;
}

// =============================================================================
// SYNTHESIS CACHE
// =============================================================================

export class SynthesisCache {
  private readonly CACHE_PREFIX = 'cache/synthesis/';
  private readonly CACHE_TTL_SECONDS: number;

  constructor(ttlSeconds: number = 3600) {
    this.CACHE_TTL_SECONDS = ttlSeconds;
  }

  /**
   * Get cached synthesis if available and not expired
   */
  async get(
    query: string,
    sectionResults: SectionResultSummary[]
  ): Promise<CachedSynthesis | null> {
    if (!isR2Enabled()) return null;

    const key = this.buildCacheKey(query, sectionResults);

    try {
      const cached = await getJson<CachedSynthesis>(
        `${this.CACHE_PREFIX}${key}.json`
      );

      if (!cached) return null;

      // Check expiry
      if (new Date(cached.expiresAt) <= new Date()) {
        console.error(`[SynthesisCache] Cache expired for key: ${key.substring(0, 8)}...`);
        return null;
      }

      // Update hit count (fire and forget)
      this.incrementHitCount(key, cached).catch(() => {});

      console.error(`[SynthesisCache] Cache HIT for key: ${key.substring(0, 8)}... (hits: ${cached.hitCount})`);
      return cached;
    } catch {
      return null;
    }
  }

  /**
   * Store synthesis result in cache
   */
  async set(
    query: string,
    sectionResults: SectionResultSummary[],
    response: string,
    sources: CachedSynthesis['sources']
  ): Promise<boolean> {
    if (!isR2Enabled()) return false;

    const key = this.buildCacheKey(query, sectionResults);
    const now = new Date();

    const cacheEntry: CachedSynthesis = {
      queryHash: this.hash(query),
      dataHash: this.hash(JSON.stringify(sectionResults)),
      response,
      sources,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.CACHE_TTL_SECONDS * 1000).toISOString(),
      hitCount: 0,
    };

    const success = await uploadJson(`${this.CACHE_PREFIX}${key}.json`, cacheEntry);

    if (success) {
      console.error(`[SynthesisCache] Cached result for key: ${key.substring(0, 8)}... (TTL: ${this.CACHE_TTL_SECONDS}s)`);
    }

    return success;
  }

  /**
   * Build cache key from query and section results
   */
  private buildCacheKey(query: string, sectionResults: SectionResultSummary[]): string {
    // Normalize query: lowercase, trim, collapse whitespace
    const normalizedQuery = query.toLowerCase().trim().replace(/\s+/g, ' ');

    // Create fingerprint from section results
    const dataFingerprint = sectionResults
      .filter(r => r.success)
      .map(r => `${r.section}:${r.tool}:${r.recordCount || 0}`)
      .sort()
      .join('|');

    return this.hash(`${normalizedQuery}|${dataFingerprint}`);
  }

  /**
   * Hash a string using SHA-256 (truncated to 16 chars)
   */
  private hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  /**
   * Increment hit count for analytics
   */
  private async incrementHitCount(key: string, cached: CachedSynthesis): Promise<void> {
    await uploadJson(`${this.CACHE_PREFIX}${key}.json`, {
      ...cached,
      hitCount: cached.hitCount + 1,
    });
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let cacheInstance: SynthesisCache | null = null;

/**
 * Get the synthesis cache singleton
 */
export function getSynthesisCache(): SynthesisCache {
  if (!cacheInstance) {
    cacheInstance = new SynthesisCache();
  }
  return cacheInstance;
}
