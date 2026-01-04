/**
 * Knowledge Section Adapter
 *
 * Provides domain expertise to blendthink by:
 * 1. Reading static knowledge from markdown files (tool guidelines, blending rules)
 * 2. Querying dynamic knowledge from Qdrant vectors (KPIs, Odoo patterns)
 * 3. Blending both to return relevant domain expertise
 */

import { readFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  QuestionAnalysis,
  RouteStep,
  SectionAdapter,
  SectionResult,
  AdapterContext,
} from '../../common/types.js';
import { DEFAULT_ADAPTER_CONTEXT } from '../../common/types.js';
import { embed } from '../../common/services/embedding-service.js';
import { getQdrantClient } from '../../common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';

// Get the directory of this file for resolving static paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Static files are in src/knowledge/static/, but at runtime we're in dist/
// Navigate from dist/knowledge/adapter/ to src/knowledge/static/
const STATIC_DIR = join(__dirname, '..', '..', '..', 'src', 'knowledge', 'static');

// =============================================================================
// KNOWLEDGE RESULT TYPE
// =============================================================================

/**
 * Result from knowledge search operations
 */
export interface KnowledgeSearchResult {
  /** Static knowledge items found */
  staticItems: Array<{
    source: string;
    category: 'tool-guidelines' | 'blending' | 'general';
    content: string;
    relevanceScore: number;
  }>;

  /** Dynamic knowledge items found (from Qdrant) */
  dynamicItems: Array<{
    id: string;
    category: string;
    name: string;
    content: string;
    score: number;
  }>;

  /** Total items found */
  totalItems: number;

  /** Whether this is a placeholder response (dynamic not yet implemented) */
  dynamicPlaceholder: boolean;
}

// =============================================================================
// STATIC KNOWLEDGE CACHE
// =============================================================================

/**
 * Cached static knowledge for fast retrieval
 */
interface StaticKnowledgeItem {
  path: string;
  category: 'tool-guidelines' | 'blending' | 'general';
  name: string;
  content: string;
  keywords: string[];
}

let staticKnowledgeCache: StaticKnowledgeItem[] | null = null;

/**
 * Load and cache all static knowledge files
 */
async function loadStaticKnowledge(): Promise<StaticKnowledgeItem[]> {
  if (staticKnowledgeCache) {
    return staticKnowledgeCache;
  }

  const items: StaticKnowledgeItem[] = [];
  const categories = ['tool-guidelines', 'blending', 'general'] as const;

  for (const category of categories) {
    const categoryDir = join(STATIC_DIR, category);
    try {
      // Read directory and filter to markdown files (except templates)
      const entries = await readdir(categoryDir);
      const files = entries.filter(
        (f) => f.endsWith('.md') && !f.startsWith('_')
      );

      for (const file of files) {
        const filePath = join(categoryDir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const name = file.replace('.md', '');

          // Extract keywords from content (headings, bold text)
          const keywords = extractKeywords(content);

          items.push({
            path: filePath,
            category,
            name,
            content,
            keywords,
          });
        } catch (err) {
          console.error(`[KnowledgeAdapter] Failed to read ${filePath}:`, err);
        }
      }
    } catch {
      // Category directory may not exist yet - this is fine
    }
  }

  staticKnowledgeCache = items;
  console.error(`[KnowledgeAdapter] Loaded ${items.length} static knowledge items`);
  return items;
}

/**
 * Extract keywords from markdown content
 */
function extractKeywords(content: string): string[] {
  const keywords: string[] = [];

  // Extract headings
  const headingMatches = content.match(/^#+\s+(.+)$/gm);
  if (headingMatches) {
    keywords.push(...headingMatches.map(h => h.replace(/^#+\s+/, '').toLowerCase()));
  }

  // Extract bold text
  const boldMatches = content.match(/\*\*([^*]+)\*\*/g);
  if (boldMatches) {
    keywords.push(...boldMatches.map(b => b.replace(/\*\*/g, '').toLowerCase()));
  }

  // Extract inline code
  const codeMatches = content.match(/`([^`]+)`/g);
  if (codeMatches) {
    keywords.push(...codeMatches.map(c => c.replace(/`/g, '').toLowerCase()));
  }

  return [...new Set(keywords)];
}

/**
 * Clear the static knowledge cache (for testing or updates)
 */
export function clearStaticKnowledgeCache(): void {
  staticKnowledgeCache = null;
}

// =============================================================================
// KNOWLEDGE ADAPTER
// =============================================================================

export class KnowledgeAdapter implements SectionAdapter {
  readonly section = 'knowledge' as const;
  private context: AdapterContext;

  constructor(context: Partial<AdapterContext> = {}) {
    this.context = { ...DEFAULT_ADAPTER_CONTEXT, ...context };
  }

  /**
   * Execute a knowledge lookup operation
   */
  async execute(step: RouteStep, analysis: QuestionAnalysis): Promise<SectionResult> {
    const startTime = Date.now();

    try {
      // Search both static and dynamic knowledge
      const staticResults = await this.searchStaticKnowledge(analysis);
      const dynamicResults = await this.searchDynamicKnowledge(analysis);

      // Combine results
      const result: KnowledgeSearchResult = {
        staticItems: staticResults,
        dynamicItems: dynamicResults.items,
        totalItems: staticResults.length + dynamicResults.items.length,
        dynamicPlaceholder: dynamicResults.placeholder,
      };

      // Estimate tokens (100 per static item, 50 per dynamic)
      const tokenEstimate =
        100 +
        staticResults.length * 100 +
        dynamicResults.items.length * 50;

      return {
        section: this.section,
        tool: step.tool || 'knowledge_search',
        success: true,
        data: result,
        recordCount: result.totalItems,
        tokenEstimate,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        section: this.section,
        tool: step.tool || 'knowledge_search',
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
        tokenEstimate: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  // ===========================================================================
  // STATIC KNOWLEDGE SEARCH
  // ===========================================================================

  /**
   * Search static knowledge files based on query analysis
   */
  private async searchStaticKnowledge(
    analysis: QuestionAnalysis
  ): Promise<KnowledgeSearchResult['staticItems']> {
    const allKnowledge = await loadStaticKnowledge();
    const results: KnowledgeSearchResult['staticItems'] = [];

    // Build search terms from analysis
    const searchTerms = this.buildSearchTerms(analysis);

    // Score each knowledge item
    for (const item of allKnowledge) {
      const score = this.calculateRelevance(item, searchTerms, analysis);
      if (score > 0.3) {
        results.push({
          source: item.name,
          category: item.category,
          content: item.content,
          relevanceScore: score,
        });
      }
    }

    // Sort by relevance and limit
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, 5); // Return top 5 matches
  }

  /**
   * Build search terms from question analysis
   */
  private buildSearchTerms(analysis: QuestionAnalysis): string[] {
    const terms: string[] = [];

    // Add original query words
    const queryWords = analysis.query.toLowerCase().split(/\s+/);
    terms.push(...queryWords);

    // Add entities
    terms.push(...analysis.entities.map(e => e.toLowerCase()));

    // Add field hints
    if (analysis.fieldHints) {
      terms.push(...analysis.fieldHints.map(f => f.toLowerCase()));
    }

    // Add model hints
    if (analysis.modelHints) {
      terms.push(...analysis.modelHints.map(m => m.toLowerCase()));
    }

    return [...new Set(terms)];
  }

  /**
   * Calculate relevance score for a knowledge item
   */
  private calculateRelevance(
    item: StaticKnowledgeItem,
    searchTerms: string[],
    analysis: QuestionAnalysis
  ): number {
    let score = 0;
    const maxScore = searchTerms.length + 3; // +3 for category/type bonuses

    // Check keyword matches
    for (const term of searchTerms) {
      if (item.keywords.some(k => k.includes(term) || term.includes(k))) {
        score += 1;
      }
      if (item.name.toLowerCase().includes(term)) {
        score += 0.5;
      }
      if (item.content.toLowerCase().includes(term)) {
        score += 0.25;
      }
    }

    // Category-specific bonuses
    if (analysis.type === 'explanation' && item.category === 'general') {
      score += 1;
    }
    if (
      (analysis.type === 'aggregation' || analysis.type === 'precise_query') &&
      item.category === 'tool-guidelines'
    ) {
      score += 1;
    }

    // Tool mention bonus
    const toolKeywords = ['nexsus_search', 'semantic_search', 'graph_traverse', 'blendthink'];
    for (const tool of toolKeywords) {
      if (analysis.query.toLowerCase().includes(tool) && item.name.includes(tool.replace('_', '-'))) {
        score += 2;
      }
    }

    return Math.min(score / maxScore, 1);
  }

  // ===========================================================================
  // DYNAMIC KNOWLEDGE SEARCH
  // ===========================================================================

  /**
   * Search dynamic knowledge from Qdrant vectors
   *
   * Searches nexsus_unified with point_type='knowledge' to find
   * relevant KPIs, Odoo patterns, and report formats.
   */
  private async searchDynamicKnowledge(
    analysis: QuestionAnalysis
  ): Promise<{ items: KnowledgeSearchResult['dynamicItems']; placeholder: boolean }> {
    try {
      // Build search query from analysis
      const searchQuery = this.buildDynamicSearchQuery(analysis);

      // Embed the query
      const embedding = await embed(searchQuery, 'query');
      if (!embedding) {
        console.error('[KnowledgeAdapter] Failed to generate embedding for dynamic search');
        return { items: [], placeholder: false };
      }

      // Search Qdrant for knowledge points using direct client
      const client = getQdrantClient();
      const searchResult = await client.search(UNIFIED_CONFIG.COLLECTION_NAME, {
        vector: embedding,
        limit: 10,
        score_threshold: 0.4,
        filter: {
          must: [{ key: 'point_type', match: { value: 'knowledge' } }],
        },
        with_payload: true,
      });

      // Format results
      const items: KnowledgeSearchResult['dynamicItems'] = searchResult.map((r) => {
        const payload = (r.payload || {}) as Record<string, unknown>;
        return {
          id: String(payload.id || r.id),
          category: String(payload.knowledge_category || payload.category || 'unknown'),
          name: String(payload.name || 'Unknown'),
          content: this.formatDynamicKnowledgeContent(payload),
          score: r.score,
        };
      });

      return { items, placeholder: false };
    } catch (error) {
      console.error('[KnowledgeAdapter] Dynamic search error:', error);
      // Return empty but not placeholder - search was attempted
      return { items: [], placeholder: false };
    }
  }

  /**
   * Build search query for dynamic knowledge
   */
  private buildDynamicSearchQuery(analysis: QuestionAnalysis): string {
    const parts: string[] = [];

    // Add key question concepts
    const queryWords = analysis.query
      .toLowerCase()
      .replace(/[?.,!]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // Focus on knowledge-related terms
    const knowledgeTerms = queryWords.filter((w) =>
      !['the', 'and', 'for', 'with', 'how', 'what', 'show', 'find', 'get'].includes(w)
    );
    parts.push(...knowledgeTerms.slice(0, 5));

    // Add entities that might match knowledge items
    for (const entity of analysis.entities) {
      if (!entity.includes(':')) {
        parts.push(entity.toLowerCase());
      }
    }

    // Add field hints (might match KPI names)
    if (analysis.fieldHints) {
      parts.push(...analysis.fieldHints.slice(0, 3));
    }

    return parts.join(' ');
  }

  /**
   * Format dynamic knowledge content for display
   */
  private formatDynamicKnowledgeContent(payload: Record<string, unknown>): string {
    const parts: string[] = [];

    // Add name and description
    if (payload.name) parts.push(`**${payload.name}**`);
    if (payload.description) parts.push(String(payload.description));

    // Add category-specific content
    const category = payload.knowledge_category || payload.category;

    if (category === 'KPIs' || category === 'kpi') {
      if (payload.formula) {
        const formula = payload.formula as Record<string, unknown>;
        if (formula.formula) parts.push(`Formula: ${formula.formula}`);
      }
      if (payload.interpretation) {
        parts.push(`Interpretation: ${payload.interpretation}`);
      }
    }

    if (category === 'Odoo Patterns' || category === 'odoo_pattern') {
      if (payload.model) parts.push(`Model: ${payload.model}`);
      if (payload.pitfalls && Array.isArray(payload.pitfalls)) {
        parts.push(`Pitfalls: ${(payload.pitfalls as string[]).join('; ')}`);
      }
    }

    if (category === 'Reports' || category === 'report') {
      if (payload.sections && Array.isArray(payload.sections)) {
        const sectionNames = (payload.sections as Array<{ name: string }>)
          .map((s) => s.name)
          .slice(0, 5);
        parts.push(`Sections: ${sectionNames.join(', ')}`);
      }
    }

    return parts.join('\n\n');
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Create a new KnowledgeAdapter instance
 */
export function createKnowledgeAdapter(context?: Partial<AdapterContext>): KnowledgeAdapter {
  return new KnowledgeAdapter(context);
}
