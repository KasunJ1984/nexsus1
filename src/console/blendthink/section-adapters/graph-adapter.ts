/**
 * Graph Section Adapter
 *
 * Executes graph traversal operations by calling underlying
 * vector-client and graph services directly.
 */

import {
  retrievePointById,
  batchRetrievePoints,
  getQdrantClient,
} from '../../../common/services/vector-client.js';
import { getModelIdFromSchema } from '../../../common/services/schema-query-service.js';
import { getGraphContext } from '../../../common/services/knowledge-graph.js';
import { buildDataUuidV2 } from '../../../common/utils/uuid-v2.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';
import type { QuestionAnalysis, RouteStep } from '../../../common/types.js';
import type {
  SectionAdapter,
  SectionResult,
  GraphTraversalResult,
  AdapterContext,
} from './types.js';
import { DEFAULT_ADAPTER_CONTEXT } from './types.js';

// =============================================================================
// GRAPH ADAPTER
// =============================================================================

export class GraphAdapter implements SectionAdapter {
  readonly section = 'common' as const;
  private context: AdapterContext;

  constructor(context: Partial<AdapterContext> = {}) {
    this.context = { ...DEFAULT_ADAPTER_CONTEXT, ...context };
  }

  /**
   * Execute a graph traversal operation
   */
  async execute(step: RouteStep, analysis: QuestionAnalysis): Promise<SectionResult> {
    const startTime = Date.now();

    try {
      // Extract record reference from analysis
      const recordRef = this.extractRecordReference(analysis);
      if (!recordRef) {
        throw new Error('No record reference found for graph traversal');
      }

      // Build UUID for the root record
      const modelId = await getModelIdFromSchema(recordRef.modelName);
      if (!modelId) {
        throw new Error(`Unknown model: ${recordRef.modelName}`);
      }

      const rootUuid = buildDataUuidV2(modelId, recordRef.recordId);

      // Retrieve root record
      const root = await retrievePointById(
        UNIFIED_CONFIG.COLLECTION_NAME,
        rootUuid
      );

      if (!root) {
        throw new Error(`Record not found: ${recordRef.modelName}#${recordRef.recordId}`);
      }

      // Build result
      const result: GraphTraversalResult = {
        root: {
          model_name: recordRef.modelName,
          record_id: recordRef.recordId,
          display_name: this.extractDisplayName(root.payload),
        },
        outgoing: [],
        incoming: [],
        notSynced: [],
      };

      // Traverse outgoing FK relationships
      const rootPayload = root.payload as Record<string, unknown> | undefined;
      if (rootPayload) {
        await this.traverseOutgoing(rootPayload, result);
      }

      // Traverse incoming references
      await this.traverseIncoming(recordRef.modelName, rootUuid, result);

      // Estimate tokens
      const tokenEstimate =
        100 +
        result.outgoing.length * 30 +
        result.incoming.length * 30;

      return {
        section: this.section,
        tool: 'graph_traverse',
        success: true,
        data: result,
        recordCount: result.outgoing.length + result.incoming.length,
        tokenEstimate,
        executionTimeMs: Date.now() - startTime,
      };
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

  // ===========================================================================
  // TRAVERSAL METHODS
  // ===========================================================================

  /**
   * Traverse outgoing FK relationships from payload
   */
  private async traverseOutgoing(
    payload: Record<string, unknown>,
    result: GraphTraversalResult
  ): Promise<void> {
    // Find all *_qdrant fields (FK references)
    const qdrantFields = Object.keys(payload).filter(
      (k) => k.endsWith('_qdrant') && payload[k]
    );

    // Collect UUIDs to batch retrieve
    const uuidsToFetch: string[] = [];
    const fieldMap: Map<string, string> = new Map();

    for (const field of qdrantFields) {
      const value = payload[field];
      if (typeof value === 'string' && value.length > 0) {
        uuidsToFetch.push(value);
        fieldMap.set(value, field.replace('_qdrant', ''));
      } else if (Array.isArray(value)) {
        for (const uuid of value) {
          if (typeof uuid === 'string' && uuid.length > 0) {
            uuidsToFetch.push(uuid);
            fieldMap.set(uuid, field.replace('_qdrant', ''));
          }
        }
      }
    }

    if (uuidsToFetch.length === 0) {
      return;
    }

    // Batch retrieve targets
    const targetsMap = await batchRetrievePoints(
      UNIFIED_CONFIG.COLLECTION_NAME,
      uuidsToFetch
    );

    // Process results
    for (const [uuid, target] of targetsMap) {
      if (!target) continue;

      const fkField = fieldMap.get(uuid) || 'unknown';
      const targetPayload = target.payload as Record<string, unknown>;

      result.outgoing.push({
        fk_field: fkField,
        target_model: (targetPayload.model_name as string) || 'unknown',
        target_id: (targetPayload.record_id as number) || 0,
        display_name: this.extractDisplayName(targetPayload),
      });
    }

    // Track not synced fields
    const foundUuids = new Set(targetsMap.keys());
    for (const uuid of uuidsToFetch) {
      if (!foundUuids.has(uuid)) {
        const field = fieldMap.get(uuid);
        if (field && !result.notSynced.includes(field)) {
          result.notSynced.push(field);
        }
      }
    }
  }

  /**
   * Traverse incoming FK references to this record
   */
  private async traverseIncoming(
    modelName: string,
    rootUuid: string,
    result: GraphTraversalResult
  ): Promise<void> {
    try {
      // Get graph context to find incoming FK fields
      const graphContext = await getGraphContext(modelName);
      if (!graphContext || !graphContext.incoming) {
        return;
      }

      // Build list of FK fields to check
      const fkFields: string[] = [];
      for (const edge of graphContext.incoming) {
        const field = `${edge.field_name}_qdrant`;
        if (!fkFields.includes(field)) {
          fkFields.push(field);
        }
      }

      if (fkFields.length === 0) {
        return;
      }

      // Search for records referencing this UUID
      const qdrant = getQdrantClient();
      const searchResult = await qdrant.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
        filter: {
          should: fkFields.map((field) => ({
            key: field,
            match: { value: rootUuid },
          })),
        },
        limit: Math.min(this.context.maxRecords, 20),
        with_payload: true,
        with_vector: false,
      });

      // Process results
      for (const point of searchResult.points) {
        const payload = point.payload as Record<string, unknown>;

        // Find which FK field matched
        let matchedField = 'unknown';
        for (const field of fkFields) {
          if (payload[field] === rootUuid) {
            matchedField = field.replace('_qdrant', '');
            break;
          }
        }

        result.incoming.push({
          source_model: (payload.model_name as string) || 'unknown',
          source_id: (payload.record_id as number) || 0,
          fk_field: matchedField,
          display_name: this.extractDisplayName(payload),
        });
      }
    } catch (error) {
      // Silently handle graph context errors
      console.error('[GraphAdapter] Incoming traversal error:', error);
    }
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Extract record reference from analysis
   */
  private extractRecordReference(
    analysis: QuestionAnalysis
  ): { modelName: string; recordId: number } | undefined {
    // Look for patterns in entities
    for (const entity of analysis.entities) {
      // Pattern: id:12345
      const idMatch = entity.match(/^id:(\d+)$/);
      if (idMatch) {
        return {
          modelName: analysis.modelHints?.[0] || 'crm.lead',
          recordId: parseInt(idMatch[1], 10),
        };
      }

      // Pattern: partner:12345
      const prefixMatch = entity.match(/^(partner|lead|account|invoice|user):(\d+)$/);
      if (prefixMatch) {
        const modelMap: Record<string, string> = {
          partner: 'res.partner',
          lead: 'crm.lead',
          account: 'account.account',
          invoice: 'account.move',
          user: 'res.users',
        };
        return {
          modelName: modelMap[prefixMatch[1]] || 'crm.lead',
          recordId: parseInt(prefixMatch[2], 10),
        };
      }

      // Pattern: res.partner#12345 or res.partner 12345
      const modelMatch = entity.match(/^([a-z]+\.[a-z_]+)[#\s](\d+)$/);
      if (modelMatch) {
        return {
          modelName: modelMatch[1],
          recordId: parseInt(modelMatch[2], 10),
        };
      }
    }

    return undefined;
  }

  /**
   * Extract display name from payload
   */
  private extractDisplayName(payload: Record<string, unknown> | undefined): string {
    if (!payload) return '(unknown)';

    const nameFields = ['display_name', 'name', 'partner_name', 'login'];
    for (const field of nameFields) {
      if (payload[field] && typeof payload[field] === 'string') {
        return payload[field] as string;
      }
    }

    if (payload.record_id) {
      return `#${payload.record_id}`;
    }

    return '(unknown)';
  }
}
