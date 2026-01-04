/**
 * Semantic Section Adapter
 *
 * Executes semantic search and find_similar operations by calling
 * underlying embedding and vector-client services directly.
 */

import { embed } from '../../../common/services/embedding-service.js';
import {
  searchByPointType,
  findSimilarRecords,
} from '../../../common/services/vector-client.js';
import type { QuestionAnalysis, RouteStep } from '../../../common/types.js';
import type {
  SectionAdapter,
  SectionResult,
  SemanticSearchResult,
  AdapterContext,
} from './types.js';
import { DEFAULT_ADAPTER_CONTEXT } from './types.js';

// =============================================================================
// SEMANTIC ADAPTER
// =============================================================================

export class SemanticAdapter implements SectionAdapter {
  readonly section = 'semantic' as const;
  private context: AdapterContext;

  constructor(context: Partial<AdapterContext> = {}) {
    this.context = { ...DEFAULT_ADAPTER_CONTEXT, ...context };
  }

  /**
   * Execute a semantic search or find_similar operation
   */
  async execute(step: RouteStep, analysis: QuestionAnalysis): Promise<SectionResult> {
    const startTime = Date.now();

    try {
      if (step.tool === 'find_similar') {
        return await this.executeFindSimilar(step, analysis, startTime);
      } else {
        return await this.executeSemanticSearch(step, analysis, startTime);
      }
    } catch (error) {
      return {
        section: this.section,
        tool: step.tool,
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
        tokenEstimate: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute semantic_search
   */
  private async executeSemanticSearch(
    step: RouteStep,
    analysis: QuestionAnalysis,
    startTime: number
  ): Promise<SectionResult> {
    // Build search query from analysis
    const searchQuery = this.buildSearchQuery(analysis);

    // Embed the query
    const embedding = await embed(searchQuery, 'query');
    if (!embedding) {
      throw new Error('Failed to generate embedding for search query');
    }

    // Determine point type and model filter from analysis
    const pointType = 'data'; // Always search data for blendthink
    const modelFilter = this.extractModelFilter(analysis);

    // Execute search
    const limit = Math.min(this.context.maxRecords, 50);
    const results = await searchByPointType(embedding, {
      limit,
      minScore: 0.35,
      filter: modelFilter ? { model_name: modelFilter } : undefined,
      pointType,
    });

    // Format results
    const searchResult: SemanticSearchResult = {
      matches: results.map((r) => ({
        id: r.qdrant_id || String(r.id),
        score: r.score,
        model_name: (r.payload as Record<string, unknown>)?.model_name as string | undefined,
        record_id: (r.payload as Record<string, unknown>)?.record_id as number | undefined,
        display_name: this.extractDisplayName(r.payload as Record<string, unknown>),
        payload: this.context.includePayloads ? (r.payload as Record<string, unknown>) : {},
      })),
      totalMatches: results.length,
      hasMore: results.length === limit,
    };

    // Estimate tokens (roughly 50 tokens per result)
    const tokenEstimate = 100 + searchResult.matches.length * 50;

    return {
      section: this.section,
      tool: 'semantic_search',
      success: true,
      data: searchResult,
      recordCount: searchResult.totalMatches,
      tokenEstimate,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Execute find_similar
   */
  private async executeFindSimilar(
    step: RouteStep,
    analysis: QuestionAnalysis,
    startTime: number
  ): Promise<SectionResult> {
    // Extract record reference from analysis
    const recordRef = this.extractRecordReference(analysis);
    if (!recordRef) {
      throw new Error('No record reference found for find_similar');
    }

    // Execute find similar
    const result = await findSimilarRecords(recordRef.pointId, {
      limit: Math.min(this.context.maxRecords, 20),
      minSimilarity: 0.5,
      applyGraphBoost: true,
    });

    // Format results
    const searchResult: SemanticSearchResult = {
      matches: result.similar_records.map((s) => ({
        id: s.point_id,
        score: s.similarity_score,
        model_name: s.model_name,
        record_id: s.record_id,
        display_name: (s.payload_summary?.name as string) || `#${s.record_id}`,
        payload: s.payload_summary,
      })),
      totalMatches: result.similar_records.length,
      hasMore: false,
    };

    // Estimate tokens
    const tokenEstimate = 100 + searchResult.matches.length * 30;

    return {
      section: this.section,
      tool: 'find_similar',
      success: true,
      data: searchResult,
      recordCount: searchResult.totalMatches,
      tokenEstimate,
      executionTimeMs: Date.now() - startTime,
    };
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Build search query from question analysis
   */
  private buildSearchQuery(analysis: QuestionAnalysis): string {
    // Start with extracted entities
    const parts: string[] = [];

    // Add entities (locations, names, etc.)
    if (analysis.entities.length > 0) {
      parts.push(...analysis.entities);
    }

    // Add field hints as context
    if (analysis.fieldHints && analysis.fieldHints.length > 0) {
      parts.push(...analysis.fieldHints.slice(0, 3));
    }

    // If no parts, use the original query
    if (parts.length === 0) {
      return analysis.query;
    }

    return parts.join(' ');
  }

  /**
   * Extract model filter from analysis
   */
  private extractModelFilter(analysis: QuestionAnalysis): string | undefined {
    // Check model hints first
    if (analysis.modelHints && analysis.modelHints.length > 0) {
      return analysis.modelHints[0];
    }

    // Check entities for model patterns
    for (const entity of analysis.entities) {
      if (entity.includes('.') && entity.match(/^[a-z]+\.[a-z_]+$/)) {
        return entity;
      }
    }

    return undefined;
  }

  /**
   * Extract record reference for find_similar
   */
  private extractRecordReference(
    analysis: QuestionAnalysis
  ): { modelName: string; recordId: number; pointId: string } | undefined {
    // Look for ID patterns in entities
    for (const entity of analysis.entities) {
      // Pattern: id:12345
      const idMatch = entity.match(/^id:(\d+)$/);
      if (idMatch) {
        const recordId = parseInt(idMatch[1], 10);
        const modelName = analysis.modelHints?.[0] || 'crm.lead';
        // Build point ID (simplified - in real impl would use buildDataUuidV2)
        const pointId = `00000002-0000-0000-0000-${recordId.toString().padStart(12, '0')}`;
        return { modelName, recordId, pointId };
      }

      // Pattern: partner:12345
      const prefixMatch = entity.match(/^(partner|lead|account|invoice):(\d+)$/);
      if (prefixMatch) {
        const recordId = parseInt(prefixMatch[2], 10);
        const modelMap: Record<string, string> = {
          partner: 'res.partner',
          lead: 'crm.lead',
          account: 'account.account',
          invoice: 'account.move',
        };
        const modelName = modelMap[prefixMatch[1]] || 'crm.lead';
        const pointId = `00000002-0000-0000-0000-${recordId.toString().padStart(12, '0')}`;
        return { modelName, recordId, pointId };
      }
    }

    return undefined;
  }

  /**
   * Extract display name from payload
   */
  private extractDisplayName(payload: Record<string, unknown> | undefined): string {
    if (!payload) return '(unknown)';

    // Try common name fields
    const nameFields = ['display_name', 'name', 'partner_name', 'login'];
    for (const field of nameFields) {
      if (payload[field] && typeof payload[field] === 'string') {
        return payload[field] as string;
      }
    }

    // Fall back to record ID
    if (payload.record_id) {
      return `#${payload.record_id}`;
    }

    return '(unknown)';
  }
}
