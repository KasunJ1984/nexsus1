/**
 * Knowledge Section Adapter
 *
 * Provides domain expertise to blendthink by:
 * 1. Reading static knowledge from markdown files (tool guidelines, blending rules) - Level 1
 * 2. Querying instance config from Qdrant (company context, limitations) - Level 2
 * 3. Querying model metadata from Qdrant (table meanings, query guidance) - Level 3
 * 4. Querying field knowledge from Qdrant (field meanings, valid values) - Level 4
 * 5. Querying dynamic knowledge from Qdrant vectors (KPIs, Odoo patterns)
 * 6. Blending all levels to return relevant domain expertise
 *
 * The 4-level knowledge hierarchy enables any LLM to operate Nexsus effectively
 * without prior training or conversation history.
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
import {
  getAggregationSafeFields,
  getAggregationSafeFieldsForModel,
  isFieldAggregationSafe,
  loadFieldKnowledge,
  type AggregationFieldInfo,
} from '../dynamic/loaders/index.js';

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
 * Knowledge level type for 4-level hierarchy
 */
export type KnowledgeLevelFilter = 'universal' | 'instance' | 'model' | 'field' | 'all';

/**
 * Extended knowledge item (Level 2, 3, 4)
 */
export interface ExtendedKnowledgeItem {
  id: string;
  level: 'instance' | 'model' | 'field';
  name: string;
  content: string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * Result from knowledge search operations
 */
export interface KnowledgeSearchResult {
  /** Static knowledge items found (Level 1) */
  staticItems: Array<{
    source: string;
    category: 'tool-guidelines' | 'blending' | 'general';
    content: string;
    relevanceScore: number;
  }>;

  /** Extended knowledge items (Levels 2, 3, 4) */
  extendedItems: ExtendedKnowledgeItem[];

  /** Dynamic knowledge items found (from Qdrant - KPIs, patterns) */
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
      // Search all knowledge levels
      const staticResults = await this.searchStaticKnowledge(analysis);
      const extendedResults = await this.searchExtendedKnowledge(analysis);
      const dynamicResults = await this.searchDynamicKnowledge(analysis);

      // Combine results
      const result: KnowledgeSearchResult = {
        staticItems: staticResults,
        extendedItems: extendedResults,
        dynamicItems: dynamicResults.items,
        totalItems: staticResults.length + extendedResults.length + dynamicResults.items.length,
        dynamicPlaceholder: dynamicResults.placeholder,
      };

      // Estimate tokens (100 per static item, 75 per extended, 50 per dynamic)
      const tokenEstimate =
        100 +
        staticResults.length * 100 +
        extendedResults.length * 75 +
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
  // EXTENDED KNOWLEDGE SEARCH (Levels 2, 3, 4)
  // ===========================================================================

  /**
   * Search extended knowledge (Levels 2, 3, 4) from Qdrant
   *
   * Searches for:
   * - Level 2: Instance config (company context, limitations)
   * - Level 3: Model metadata (table purposes, query guidance)
   * - Level 4: Field knowledge (field meanings, valid values)
   */
  private async searchExtendedKnowledge(
    analysis: QuestionAnalysis,
    levels: KnowledgeLevelFilter = 'all'
  ): Promise<ExtendedKnowledgeItem[]> {
    try {
      // Build search query
      const searchQuery = this.buildExtendedSearchQuery(analysis);

      // Embed the query
      const embedding = await embed(searchQuery, 'query');
      if (!embedding) {
        console.error('[KnowledgeAdapter] Failed to generate embedding for extended search');
        return [];
      }

      // Build level filter
      const levelValues = this.getLevelFilterValues(levels);

      // Search Qdrant for extended knowledge points
      const client = getQdrantClient();
      const searchResult = await client.search(UNIFIED_CONFIG.COLLECTION_NAME, {
        vector: embedding,
        limit: 15,
        score_threshold: 0.35,
        filter: {
          must: [
            { key: 'point_type', match: { value: 'knowledge' } },
            { key: 'knowledge_level', match: { any: levelValues } },
          ],
        },
        with_payload: true,
      });

      // Format results
      const items: ExtendedKnowledgeItem[] = searchResult.map((r) => {
        const payload = (r.payload || {}) as Record<string, unknown>;
        const level = payload.knowledge_level as 'instance' | 'model' | 'field';

        return {
          id: String(r.id),
          level,
          name: this.getExtendedKnowledgeName(payload, level),
          content: this.formatExtendedKnowledgeContent(payload, level),
          score: r.score,
          payload,
        };
      });

      return items;
    } catch (error) {
      console.error('[KnowledgeAdapter] Extended search error:', error);
      return [];
    }
  }

  /**
   * Search by specific knowledge level
   */
  async searchByLevel(
    query: string,
    levels: KnowledgeLevelFilter[]
  ): Promise<ExtendedKnowledgeItem[]> {
    const analysis: QuestionAnalysis = {
      query,
      type: 'explanation',
      entities: [],
      fieldHints: [],
      modelHints: [],
      confidence: 0.5,
    };

    const allItems: ExtendedKnowledgeItem[] = [];

    for (const level of levels) {
      const items = await this.searchExtendedKnowledge(analysis, level);
      allItems.push(...items);
    }

    // Sort by score and deduplicate
    allItems.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    return allItems.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  /**
   * Get hierarchical context for a specific model/field
   *
   * Returns all relevant knowledge from:
   * - Level 2: Instance limitations that apply
   * - Level 3: Model metadata for the model
   * - Level 4: Field knowledge for the field (if specified)
   */
  async getHierarchicalContext(
    modelName: string,
    fieldName?: string
  ): Promise<{
    instanceContext: ExtendedKnowledgeItem[];
    modelContext: ExtendedKnowledgeItem[];
    fieldContext: ExtendedKnowledgeItem[];
  }> {
    const result = {
      instanceContext: [] as ExtendedKnowledgeItem[],
      modelContext: [] as ExtendedKnowledgeItem[],
      fieldContext: [] as ExtendedKnowledgeItem[],
    };

    try {
      const client = getQdrantClient();

      // Get instance config that applies to this model
      const instanceResult = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'point_type', match: { value: 'knowledge' } },
            { key: 'knowledge_level', match: { value: 'instance' } },
          ],
          should: [
            { key: 'applies_to', match: { value: 'all' } },
            { key: 'applies_to', match: { value: modelName } },
          ],
        },
        with_payload: true,
        limit: 20,
      });

      result.instanceContext = instanceResult.points.map((p) => {
        const payload = (p.payload || {}) as Record<string, unknown>;
        return {
          id: String(p.id),
          level: 'instance' as const,
          name: String(payload.config_key || 'Unknown'),
          content: this.formatExtendedKnowledgeContent(payload, 'instance'),
          score: 1.0,
          payload,
        };
      });

      // Get model metadata
      const modelResult = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'point_type', match: { value: 'knowledge' } },
            { key: 'knowledge_level', match: { value: 'model' } },
            { key: 'model_name', match: { value: modelName } },
          ],
        },
        with_payload: true,
        limit: 5,
      });

      result.modelContext = modelResult.points.map((p) => {
        const payload = (p.payload || {}) as Record<string, unknown>;
        return {
          id: String(p.id),
          level: 'model' as const,
          name: String(payload.business_name || payload.model_name || 'Unknown'),
          content: this.formatExtendedKnowledgeContent(payload, 'model'),
          score: 1.0,
          payload,
        };
      });

      // Get field knowledge if field specified
      if (fieldName) {
        const fieldResult = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
          filter: {
            must: [
              { key: 'point_type', match: { value: 'knowledge' } },
              { key: 'knowledge_level', match: { value: 'field' } },
              { key: 'model_name', match: { value: modelName } },
              { key: 'field_name', match: { value: fieldName } },
            ],
          },
          with_payload: true,
          limit: 5,
        });

        result.fieldContext = fieldResult.points.map((p) => {
          const payload = (p.payload || {}) as Record<string, unknown>;
          return {
            id: String(p.id),
            level: 'field' as const,
            name: String(payload.field_label || payload.field_name || 'Unknown'),
            content: this.formatExtendedKnowledgeContent(payload, 'field'),
            score: 1.0,
            payload,
          };
        });
      }
    } catch (error) {
      console.error('[KnowledgeAdapter] Hierarchical context error:', error);
    }

    return result;
  }

  /**
   * Build search query for extended knowledge
   */
  private buildExtendedSearchQuery(analysis: QuestionAnalysis): string {
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
    parts.push(...knowledgeTerms.slice(0, 6));

    // Add model hints (Level 3)
    if (analysis.modelHints) {
      parts.push(...analysis.modelHints.slice(0, 2));
    }

    // Add field hints (Level 4)
    if (analysis.fieldHints) {
      parts.push(...analysis.fieldHints.slice(0, 3));
    }

    // Add entities
    for (const entity of analysis.entities.slice(0, 3)) {
      if (!entity.includes(':')) {
        parts.push(entity.toLowerCase());
      }
    }

    return parts.join(' ');
  }

  /**
   * Get level filter values for Qdrant query
   */
  private getLevelFilterValues(levels: KnowledgeLevelFilter): string[] {
    if (levels === 'all') {
      return ['instance', 'model', 'field'];
    }
    if (levels === 'universal') {
      return []; // Universal is static, not in Qdrant
    }
    return [levels];
  }

  /**
   * Get name for extended knowledge item
   */
  private getExtendedKnowledgeName(
    payload: Record<string, unknown>,
    level: 'instance' | 'model' | 'field'
  ): string {
    switch (level) {
      case 'instance':
        return String(payload.config_key || 'Unknown Config');
      case 'model':
        return String(payload.business_name || payload.model_name || 'Unknown Model');
      case 'field':
        return String(payload.field_label || payload.field_name || 'Unknown Field');
      default:
        return 'Unknown';
    }
  }

  /**
   * Format extended knowledge content for display
   */
  private formatExtendedKnowledgeContent(
    payload: Record<string, unknown>,
    level: 'instance' | 'model' | 'field'
  ): string {
    const parts: string[] = [];

    switch (level) {
      case 'instance':
        parts.push(`**${payload.config_key}**: ${payload.config_value}`);
        if (payload.description) parts.push(String(payload.description));
        if (payload.llm_instruction) parts.push(`*Instruction:* ${payload.llm_instruction}`);
        break;

      case 'model':
        parts.push(`**${payload.business_name || payload.model_name}**`);
        if (payload.business_purpose) parts.push(String(payload.business_purpose));
        if (payload.data_grain) parts.push(`*Grain:* ${payload.data_grain}`);
        if (payload.llm_query_guidance) parts.push(`*Query guidance:* ${payload.llm_query_guidance}`);
        if (payload.known_issues) parts.push(`*Known issues:* ${payload.known_issues}`);
        break;

      case 'field':
        parts.push(`**${payload.field_label || payload.field_name}** (${payload.model_name})`);
        if (payload.field_knowledge) parts.push(String(payload.field_knowledge));
        if (payload.valid_values && Array.isArray(payload.valid_values)) {
          parts.push(`*Valid values:* ${(payload.valid_values as string[]).join(', ')}`);
        }
        if (payload.data_format) parts.push(`*Format:* ${payload.data_format}`);
        if (payload.llm_usage_notes) parts.push(`*LLM guidance:* ${payload.llm_usage_notes}`);
        break;
    }

    return parts.join('\n\n');
  }

  // ===========================================================================
  // AGGREGATION FIELD DETECTION (Auto-detected from Schema)
  // ===========================================================================

  /**
   * Get aggregation-safe fields for all models
   *
   * Returns a map of model names to their aggregation-capable fields,
   * auto-detected from the schema based on Field_Type.
   *
   * @example
   * const adapter = createKnowledgeAdapter();
   * const allFields = adapter.getAllAggregationSafeFields();
   * // Map { 'actual' => [{ fieldName: 'Amount', fieldType: 'integer', ... }], ... }
   */
  getAllAggregationSafeFields(): Map<string, AggregationFieldInfo[]> {
    const { rows } = loadFieldKnowledge();
    return getAggregationSafeFields(rows);
  }

  /**
   * Get aggregation-safe fields for a specific model
   *
   * @param modelName - The model to check
   * @returns Array of fields that can be aggregated with their supported operations
   *
   * @example
   * const adapter = createKnowledgeAdapter();
   * const actualFields = adapter.getAggregationFieldsForModel('actual');
   * // [{ fieldName: 'Amount', fieldType: 'integer', supportedOps: ['sum', 'avg', 'min', 'max', 'count'] }]
   */
  getAggregationFieldsForModel(modelName: string): AggregationFieldInfo[] {
    return getAggregationSafeFieldsForModel(modelName);
  }

  /**
   * Check if a specific field supports a given aggregation operation
   *
   * @param modelName - The model name
   * @param fieldName - The field name
   * @param operation - The aggregation operation to check ('sum', 'avg', 'min', 'max', 'count')
   * @returns true if the field supports the operation
   *
   * @example
   * const adapter = createKnowledgeAdapter();
   * adapter.canAggregateField('actual', 'Amount', 'sum'); // true
   * adapter.canAggregateField('actual', 'Entity', 'sum'); // false (string field)
   */
  canAggregateField(
    modelName: string,
    fieldName: string,
    operation: 'sum' | 'avg' | 'min' | 'max' | 'count'
  ): boolean {
    return isFieldAggregationSafe(modelName, fieldName, operation);
  }

  /**
   * Get a summary of aggregation capabilities for display
   *
   * @returns Human-readable summary of aggregation-safe fields by model
   */
  getAggregationSummary(): string {
    const allFields = this.getAllAggregationSafeFields();
    const lines: string[] = ['## Aggregation-Safe Fields (Auto-detected from Schema)', ''];

    for (const [modelName, fields] of allFields.entries()) {
      lines.push(`### ${modelName}`);
      for (const field of fields) {
        const ops = field.supportedOps.join(', ').toUpperCase();
        lines.push(`- **${field.fieldName}** (${field.fieldType}): ${ops}`);
      }
      lines.push('');
    }

    if (allFields.size === 0) {
      lines.push('*No numeric or date fields found in schema.*');
    }

    return lines.join('\n');
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
