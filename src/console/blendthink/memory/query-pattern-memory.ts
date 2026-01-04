/**
 * Query Pattern Memory
 *
 * Stores successful query patterns for fast lookup.
 * Enables "have I seen this before?" pattern matching
 * for System 1 fast path.
 *
 * Pattern storage:
 * - In-memory LRU cache for hot patterns
 * - R2 backup for persistence
 */

import { isR2Enabled, uploadJson, getJson, appendToFile } from '../../../common/services/r2-client.js';
import type { QuestionType, BlendSection } from '../../../common/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Query pattern with route and outcome
 */
export interface QueryPattern {
  /** Pattern ID (hash of normalized query) */
  patternId: string;

  /** Normalized query pattern */
  pattern: string;

  /** Question type that worked */
  questionType: QuestionType;

  /** Route that succeeded */
  successfulRoute: Array<{
    section: BlendSection;
    tool: string;
  }>;

  /** Outcome quality (0-1) */
  outcomeQuality: number;

  /** Number of times this pattern was used */
  hitCount: number;

  /** When pattern was first seen */
  createdAt: string;

  /** When pattern was last used */
  lastUsedAt: string;

  /** Average response time (ms) */
  avgLatencyMs: number;
}

/**
 * Pattern lookup result
 */
export interface PatternMatch {
  pattern: QueryPattern;
  similarity: number; // 0-1, how similar the query is
}

// =============================================================================
// QUERY PATTERN MEMORY
// =============================================================================

export class QueryPatternMemory {
  private readonly BACKUP_PREFIX = 'memory/patterns/';
  private readonly MAX_CACHE_SIZE = 1000;

  // In-memory LRU cache
  private cache: Map<string, QueryPattern> = new Map();

  /**
   * Find matching patterns for a query
   *
   * Returns patterns that are similar to the query, sorted by similarity
   */
  async findSimilar(query: string, limit: number = 5): Promise<PatternMatch[]> {
    const normalizedQuery = this.normalizeQuery(query);
    const matches: PatternMatch[] = [];

    // Search in-memory cache
    for (const pattern of this.cache.values()) {
      const similarity = this.calculateSimilarity(normalizedQuery, pattern.pattern);
      if (similarity > 0.7) {
        matches.push({ pattern, similarity });
      }
    }

    // Sort by similarity
    matches.sort((a, b) => b.similarity - a.similarity);

    return matches.slice(0, limit);
  }

  /**
   * Find exact pattern match
   */
  async findExact(query: string): Promise<QueryPattern | null> {
    const normalizedQuery = this.normalizeQuery(query);
    const patternId = this.hashQuery(normalizedQuery);

    // Check cache first
    if (this.cache.has(patternId)) {
      const pattern = this.cache.get(patternId)!;
      // Update LRU order
      this.cache.delete(patternId);
      this.cache.set(patternId, pattern);
      return pattern;
    }

    return null;
  }

  /**
   * Store a successful query pattern
   */
  async store(
    query: string,
    questionType: QuestionType,
    route: Array<{ section: BlendSection; tool: string }>,
    outcomeQuality: number,
    latencyMs: number
  ): Promise<void> {
    const normalizedQuery = this.normalizeQuery(query);
    const patternId = this.hashQuery(normalizedQuery);

    const existing = this.cache.get(patternId);
    const now = new Date().toISOString();

    if (existing) {
      // Update existing pattern
      existing.hitCount++;
      existing.lastUsedAt = now;
      existing.avgLatencyMs = (existing.avgLatencyMs * (existing.hitCount - 1) + latencyMs) / existing.hitCount;
      existing.outcomeQuality = (existing.outcomeQuality * (existing.hitCount - 1) + outcomeQuality) / existing.hitCount;
      this.cache.set(patternId, existing);
    } else {
      // Create new pattern
      const pattern: QueryPattern = {
        patternId,
        pattern: normalizedQuery,
        questionType,
        successfulRoute: route,
        outcomeQuality,
        hitCount: 1,
        createdAt: now,
        lastUsedAt: now,
        avgLatencyMs: latencyMs,
      };

      // Add to cache (LRU eviction if needed)
      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }

      this.cache.set(patternId, pattern);
    }

    // Backup to R2 (fire and forget)
    this.backupToR2(this.cache.get(patternId)!).catch(() => {});
  }

  /**
   * Get memory statistics
   */
  getStats(): {
    cacheSize: number;
    maxSize: number;
    topPatterns: Array<{ pattern: string; hitCount: number }>;
  } {
    const patterns = Array.from(this.cache.values())
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 10)
      .map(p => ({ pattern: p.pattern.substring(0, 50), hitCount: p.hitCount }));

    return {
      cacheSize: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
      topPatterns: patterns,
    };
  }

  /**
   * Normalize query for pattern matching
   */
  private normalizeQuery(query: string): string {
    return query
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      // Remove specific IDs and numbers
      .replace(/\b\d+\b/g, '<NUM>')
      // Remove quoted strings
      .replace(/"[^"]*"/g, '<STR>')
      .replace(/'[^']*'/g, '<STR>');
  }

  /**
   * Hash query for pattern ID
   */
  private hashQuery(normalizedQuery: string): string {
    let hash = 0;
    for (let i = 0; i < normalizedQuery.length; i++) {
      const char = normalizedQuery.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Calculate similarity between two normalized queries
   *
   * Uses simple word overlap for now (could upgrade to embeddings later)
   */
  private calculateSimilarity(query1: string, query2: string): number {
    const words1 = new Set(query1.split(' ').filter(w => w.length > 2));
    const words2 = new Set(query2.split(' ').filter(w => w.length > 2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const word of words1) {
      if (words2.has(word)) intersection++;
    }

    const union = words1.size + words2.size - intersection;
    return intersection / union; // Jaccard similarity
  }

  /**
   * Backup pattern to R2
   */
  private async backupToR2(pattern: QueryPattern): Promise<void> {
    if (!isR2Enabled()) return;

    const date = new Date().toISOString().split('T')[0];
    const filename = `${this.BACKUP_PREFIX}${date}/patterns.jsonl`;

    await appendToFile(filename, JSON.stringify(pattern));
  }

  /**
   * Restore patterns from R2 backup
   */
  async restoreFromBackup(date?: string): Promise<number> {
    if (!isR2Enabled()) return 0;

    const targetDate = date || new Date().toISOString().split('T')[0];
    const filename = `${this.BACKUP_PREFIX}${targetDate}/patterns.jsonl`;

    try {
      const content = await getJson<string>(filename);
      if (!content) return 0;

      const lines = content.split('\n').filter(l => l.trim());
      let restored = 0;

      for (const line of lines) {
        try {
          const pattern = JSON.parse(line) as QueryPattern;
          this.cache.set(pattern.patternId, pattern);
          restored++;
        } catch {
          // Skip invalid lines
        }
      }

      console.error(`[QueryPatternMemory] Restored ${restored} patterns from ${targetDate}`);
      return restored;
    } catch {
      return 0;
    }
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let memoryInstance: QueryPatternMemory | null = null;

/**
 * Get the query pattern memory singleton
 */
export function getQueryPatternMemory(): QueryPatternMemory {
  if (!memoryInstance) {
    memoryInstance = new QueryPatternMemory();
  }
  return memoryInstance;
}
