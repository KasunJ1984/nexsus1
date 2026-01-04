/**
 * Graph Tool - Phase 3: FK Graph Traversal
 *
 * MCP tool for navigating the Vector Knowledge Graph by traversing FK relationships.
 *
 * Key Concepts:
 * - FK Qdrant IDs: Each many2one field has a corresponding *_qdrant field containing
 *   the UUID of the target record in Qdrant
 * - Outgoing traversal: Follow *_qdrant fields to find related records
 * - Incoming traversal: Find records that reference this record via FK
 *
 * Example Graph:
 *   crm.stage #1
 *     ├── create_uid_qdrant → res.users #1 (OdooBot)
 *     │                         ├── partner_id_qdrant → res.partner #2
 *     │                         └── company_id_qdrant → res.company #1
 *     └── write_uid_qdrant → res.users #88 (Rick Kennard)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GraphTraverseSchema } from '../schemas/index.js';
import type { GraphTraverseInput } from '../schemas/index.js';
import {
  retrievePointById,
  batchRetrievePoints,
  getQdrantClient,
  initializeVectorClient,
  isVectorClientAvailable,
} from '../services/vector-client.js';
import { getModelIdFromSchema, getModelIdFromData } from '../services/schema-query-service.js';
import { isValidModel, getModelNotFoundError } from '../services/model-registry.js';
import { getGraphContext } from '../services/knowledge-graph.js';
import { UNIFIED_CONFIG } from '../constants.js';
import { buildDataUuidV2, isValidDataUuidV2 } from '../utils/uuid-v2.js';
import {
  orchestrateExport,
  formatOrchestratorResponse,
  type ExportableResult,
} from '../services/export-orchestrator.js';
import { AUTO_EXPORT_CONFIG } from '../constants.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * A node in the graph traversal result
 */
interface TraverseNode {
  model_name: string;
  record_id: number;
  qdrant_id: string;
  display_name: string;
  fk_field?: string;  // Which FK field led here (for outgoing)
}

/**
 * Result of outgoing FK traversal
 * Maps field name to the target node(s) or null if not synced
 *
 * - many2one: single TraverseNode
 * - many2many/one2many: array of TraverseNodes
 * - null: FK target not synced in Qdrant
 */
interface OutgoingResult {
  [fieldName: string]: TraverseNode | TraverseNode[] | null;
}

/**
 * Multi-depth traversal results
 * Maps "field → model_name" to its outgoing references
 */
interface DepthTraversalResult {
  [path: string]: OutgoingResult;
}

/**
 * Complete traversal result
 */
interface TraverseResult {
  root: TraverseNode;
  outgoing: OutgoingResult;
  incoming: TraverseNode[];
  depth: number;
  not_synced: string[];  // FK fields where target is not synced
  depth_traversal?: DepthTraversalResult;  // Multi-depth results (depth > 1)
}

// =============================================================================
// FALLBACK FK FIELDS FOR INCOMING SEARCH
// =============================================================================

/**
 * Fallback FK field names used when Knowledge Graph is unavailable
 *
 * These are now only used as fallback.
 * Primary discovery uses getGraphContext() for dynamic FK field discovery.
 *
 * Includes both:
 * - many2one fields (single UUID)
 * - many2many/one2many fields (array of UUIDs)
 */
const FALLBACK_FK_FIELDS = [
  // === many2one fields (single UUID) ===
  'partner_id_qdrant',
  'user_id_qdrant',
  'company_id_qdrant',
  'create_uid_qdrant',
  'write_uid_qdrant',
  'move_id_qdrant',
  'account_id_qdrant',
  'journal_id_qdrant',
  'stage_id_qdrant',
  'team_id_qdrant',
  'parent_id_qdrant',
  'commercial_partner_id_qdrant',
  'country_id_qdrant',
  'state_id_qdrant',
  'currency_id_qdrant',
  'analytic_account_id_qdrant',
  'product_id_qdrant',
  'product_tmpl_id_qdrant',
  'categ_id_qdrant',
  'salesperson_id_qdrant',
  'sales_team_id_qdrant',
  'campaign_id_qdrant',
  'source_id_qdrant',
  'medium_id_qdrant',

  // === many2many/one2many fields (array of UUIDs) ===
  'distribution_analytic_account_ids_qdrant',
  'analytic_account_ids_qdrant',
  'tag_ids_qdrant',
  'category_id_qdrant',
  'invoice_line_ids_qdrant',
  'line_ids_qdrant',
  'tax_ids_qdrant',
  'allowed_company_ids_qdrant',
];

/**
 * Dynamically discover FK fields that point to a target model using Knowledge Graph
 *
 * Uses graph edges to find which models/fields reference the target.
 * Falls back to FALLBACK_FK_FIELDS if Knowledge Graph is unavailable.
 *
 * @param targetModelName - Model name to find incoming references for
 * @returns Array of FK field names (with _qdrant suffix) that point to this model
 */
async function discoverIncomingFkFields(targetModelName: string): Promise<string[]> {
  try {
    const graphContext = await getGraphContext(targetModelName);

    if (graphContext.incoming.length === 0) {
      console.error(`[Graph] No incoming edges found for ${targetModelName}, using fallback fields`);
      return FALLBACK_FK_FIELDS;
    }

    // Build FK field names from incoming edges
    // Each incoming edge has: { target_model, field_name, edge_count }
    // where field_name is the FK field on the source model pointing to targetModelName
    const discoveredFields = graphContext.incoming.map(edge => `${edge.field_name}_qdrant`);

    // Deduplicate and combine with high-priority fallbacks
    const combinedFields = new Set([
      ...discoveredFields,
      // Always include common fields that might not be in graph yet
      'partner_id_qdrant',
      'user_id_qdrant',
      'company_id_qdrant',
      'create_uid_qdrant',
      'write_uid_qdrant',
    ]);

    console.error(`[Graph] Discovered ${discoveredFields.length} FK fields for ${targetModelName} (+ 5 fallbacks)`);
    return Array.from(combinedFields);

  } catch (error) {
    console.error(`[Graph] Failed to discover FK fields for ${targetModelName}:`, error);
    return FALLBACK_FK_FIELDS;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get display name from payload
 *
 * Priority order optimized for res.users and other models:
 * 1. display_name - Full name (preferred for res.users)
 * 2. name - Standard name field
 * 3. login - Username fallback for res.users
 * 4. partner_name - Partner name fallback
 * 5. #recordId - Last resort
 */
function getDisplayName(payload: Record<string, unknown>, recordId: number): string {
  return (
    (payload.display_name as string) ||  // Full name (preferred for res.users)
    (payload.name as string) ||          // Standard name field
    (payload.login as string) ||         // Username fallback for res.users
    (payload.partner_name as string) ||  // Partner name
    `#${recordId}`
  );
}

/**
 * Group array items by a key
 */
function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

/**
 * Build Qdrant filter for incoming references
 * Searches for records that have any FK field pointing to the target UUID
 *
 * Accepts dynamic field list from graph discovery
 */
function buildIncomingFilter(targetUuid: string, fkFields: string[]): { should: object[] } {
  return {
    should: fkFields.map(field => ({
      key: field,
      match: { value: targetUuid }
    }))
  };
}

/**
 * Format traversal result for output
 */
function formatTraverseResult(result: TraverseResult): string {
  const lines: string[] = [];

  // Header
  lines.push('# Graph Traversal Result');
  lines.push('');

  // Root node
  lines.push(`## Root: ${result.root.model_name} #${result.root.record_id}`);
  lines.push(`- Display Name: ${result.root.display_name}`);
  lines.push(`- Qdrant UUID: ${result.root.qdrant_id}`);
  lines.push('');

  // Outgoing FK references
  const outgoingKeys = Object.keys(result.outgoing);
  if (outgoingKeys.length > 0) {
    lines.push('## Outgoing FK References');
    lines.push('');

    for (const field of outgoingKeys) {
      const target = result.outgoing[field];

      // Handle array of targets (many2many/one2many)
      if (Array.isArray(target)) {
        lines.push(`- **${field}** → [${target.length} records]`);
        for (const node of target) {
          lines.push(`  - ${node.model_name} #${node.record_id}: ${node.display_name}`);
          lines.push(`    UUID: ${node.qdrant_id}`);
        }
      }
      // Handle single target (many2one)
      else if (target) {
        lines.push(`- **${field}** → ${target.model_name} #${target.record_id}`);
        lines.push(`  - Name: ${target.display_name}`);
        lines.push(`  - UUID: ${target.qdrant_id}`);
      }
      // Handle not synced
      else {
        lines.push(`- **${field}** → [Not synced to Qdrant]`);
      }
    }
    lines.push('');
  }

  // Not synced targets
  if (result.not_synced.length > 0) {
    lines.push('## Missing FK Targets');
    lines.push('');
    lines.push('The following FK targets are not synced to Qdrant yet:');
    for (const field of result.not_synced) {
      lines.push(`- ${field}`);
    }
    lines.push('');
    lines.push('Use `pipeline_[model.name]_1984` to sync missing models.');
    lines.push('');
  }

  // Multi-depth traversal results (depth > 1)
  if (result.depth_traversal && Object.keys(result.depth_traversal).length > 0) {
    lines.push('## Depth 2 Traversal');
    lines.push('');
    lines.push('Following FK chains from outgoing targets:');
    lines.push('');

    for (const [path, nestedOutgoing] of Object.entries(result.depth_traversal)) {
      lines.push(`### ${path}`);
      for (const [field, target] of Object.entries(nestedOutgoing)) {
        // Handle array of targets (many2many/one2many)
        if (Array.isArray(target)) {
          lines.push(`  - **${field}** → [${target.length} records]`);
          for (const node of target) {
            lines.push(`    - ${node.model_name} #${node.record_id} (${node.display_name})`);
          }
        }
        // Handle single target (many2one)
        else if (target) {
          lines.push(`  - **${field}** → ${target.model_name} #${target.record_id} (${target.display_name})`);
        }
        // Handle not synced
        else {
          lines.push(`  - **${field}** → [Not synced]`);
        }
      }
      lines.push('');
    }
  }

  // Incoming references
  if (result.incoming.length > 0) {
    lines.push('## Incoming References');
    lines.push('');
    lines.push(`Found ${result.incoming.length} record(s) that reference this record:`);
    lines.push('');

    // Group by model name
    const grouped = groupBy(result.incoming, node => node.model_name);

    for (const [model, nodes] of Object.entries(grouped)) {
      lines.push(`### ${model} (${nodes.length} record${nodes.length > 1 ? 's' : ''})`);
      for (const node of nodes.slice(0, 10)) {
        const fkField = node.fk_field ? ` via ${node.fk_field}` : '';
        lines.push(`- #${node.record_id}: ${node.display_name}${fkField}`);
      }
      if (nodes.length > 10) {
        lines.push(`- ... and ${nodes.length - 10} more`);
      }
      lines.push('');
    }
  }

  // Traversal info
  lines.push('---');
  lines.push(`Depth: ${result.depth}`);
  lines.push(`Outgoing FKs found: ${outgoingKeys.length}`);
  lines.push(`Incoming references found: ${result.incoming.length}`);

  return lines.join('\n');
}

// =============================================================================
// GRAPH TRAVERSAL LOGIC
// =============================================================================

/**
 * Perform outgoing traversal - follow FK fields to find related records
 *
 * OPTIMIZED: Uses batch retrieval for 8-15x faster performance
 * Instead of N sequential calls, makes 1 batch call for all FK targets
 *
 * Supports both:
 * - many2one: single UUID string → single TraverseNode
 * - many2many/one2many: array of UUIDs → array of TraverseNodes
 */
async function traverseOutgoing(
  payload: Record<string, unknown>,
  follow: 'all' | string[]
): Promise<{ outgoing: OutgoingResult; notSynced: string[] }> {
  const outgoing: OutgoingResult = {};
  const notSynced: string[] = [];

  // Step 1: Collect all target UUIDs to fetch (handling both single and array)
  const fkFields = Object.keys(payload).filter(k => k.endsWith('_qdrant'));

  // Track: fieldName → { isArray: boolean, uuids: string[] }
  const fieldUuidMap: Map<string, { isArray: boolean; uuids: string[] }> = new Map();
  const allUuids: string[] = [];

  for (const fkField of fkFields) {
    const fieldName = fkField.replace('_qdrant', '');

    // Filter if specific fields requested
    if (follow !== 'all' && !follow.includes(fieldName)) {
      continue;
    }

    const fkValue = payload[fkField];

    // Handle array of UUIDs (many2many/one2many)
    if (Array.isArray(fkValue)) {
      const validUuids = fkValue.filter(
        (uuid): uuid is string => typeof uuid === 'string' && isValidDataUuidV2(uuid)
      );
      if (validUuids.length > 0) {
        fieldUuidMap.set(fieldName, { isArray: true, uuids: validUuids });
        allUuids.push(...validUuids);
      }
    }
    // Handle single UUID (many2one)
    else if (typeof fkValue === 'string' && isValidDataUuidV2(fkValue)) {
      fieldUuidMap.set(fieldName, { isArray: false, uuids: [fkValue] });
      allUuids.push(fkValue);
    }
  }

  // Early return if no FK targets to fetch
  if (allUuids.length === 0) {
    return { outgoing, notSynced };
  }

  // Step 2: Single batch fetch for ALL FK targets (8-15x faster than sequential)
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const results = await batchRetrievePoints(
      collectionName,
      allUuids
    );

    // Step 3: Process batch results - build outgoing structure
    for (const [fieldName, { isArray, uuids }] of fieldUuidMap.entries()) {
      if (isArray) {
        // many2many/one2many: build array of TraverseNodes
        const nodes: TraverseNode[] = [];
        let missedCount = 0;

        for (const uuid of uuids) {
          const point = results.get(uuid);
          if (point) {
            const tPayload = point.payload;
            nodes.push({
              model_name: tPayload.model_name as string,
              record_id: tPayload.record_id as number,
              qdrant_id: uuid,
              display_name: getDisplayName(tPayload, tPayload.record_id as number),
              fk_field: fieldName,
            });
          } else {
            missedCount++;
          }
        }

        if (nodes.length > 0) {
          outgoing[fieldName] = nodes;
        } else {
          outgoing[fieldName] = null;
        }

        if (missedCount > 0) {
          notSynced.push(`${fieldName} (${missedCount}/${uuids.length} not synced)`);
        }
      } else {
        // many2one: single TraverseNode
        const uuid = uuids[0];
        const point = results.get(uuid);
        if (point) {
          const tPayload = point.payload;
          outgoing[fieldName] = {
            model_name: tPayload.model_name as string,
            record_id: tPayload.record_id as number,
            qdrant_id: uuid,
            display_name: getDisplayName(tPayload, tPayload.record_id as number),
            fk_field: fieldName,
          };
        } else {
          outgoing[fieldName] = null;
          notSynced.push(fieldName);
        }
      }
    }
  } catch (error) {
    // Batch fetch failed - mark all as not synced
    console.error('[Graph] Batch retrieve failed:', error);
    for (const [fieldName] of fieldUuidMap.entries()) {
      outgoing[fieldName] = null;
      notSynced.push(fieldName);
    }
  }

  return { outgoing, notSynced };
}

/**
 * Perform incoming traversal - find records that reference this record
 *
 * Uses dynamic FK field discovery from Knowledge Graph
 *
 * @param targetUuid - UUID of the target record to find references to
 * @param targetModelName - Model name of the target (used for graph context lookup)
 * @param limit - Maximum number of incoming references to return
 */
async function traverseIncoming(
  targetUuid: string,
  targetModelName: string,
  limit: number
): Promise<TraverseNode[]> {
  const incoming: TraverseNode[] = [];

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Dynamic FK field discovery using Knowledge Graph
    const fkFields = await discoverIncomingFkFields(targetModelName);
    console.error(`[Graph] Using ${fkFields.length} FK fields for incoming traversal of ${targetModelName}`);

    const qdrant = getQdrantClient();
    const baseFilter = buildIncomingFilter(targetUuid, fkFields);

    // Build filter with point_type for unified collection
    const filter = {
      must: [
        { key: 'point_type', match: { value: 'data' } },
      ],
      ...baseFilter,  // Merge the should clause
    };

    const result = await qdrant.scroll(collectionName, {
      filter,
      limit,
      with_payload: true,
      with_vector: false,
    });

    for (const point of result.points) {
      const payload = point.payload as Record<string, unknown>;

      // Find which FK field(s) reference the target using discovered fields
      const referencingFields: string[] = [];
      for (const fkField of fkFields) {
        const fieldValue = payload[fkField];
        // Handle both single UUID and array of UUIDs
        if (fieldValue === targetUuid ||
            (Array.isArray(fieldValue) && fieldValue.includes(targetUuid))) {
          referencingFields.push(fkField.replace('_qdrant', ''));
        }
      }

      incoming.push({
        model_name: payload.model_name as string,
        record_id: payload.record_id as number,
        qdrant_id: point.id as string,
        display_name: getDisplayName(payload, payload.record_id as number),
        fk_field: referencingFields.join(', ') || undefined,
      });
    }
  } catch (error) {
    console.error('[Graph] Error in incoming traversal:', error);
  }

  return incoming;
}

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

/**
 * Register graph traversal tools with the MCP server
 */
export function registerGraphTools(server: McpServer): void {
  // =========================================================================
  // GRAPH_TRAVERSE TOOL
  // =========================================================================
  server.tool(
    'graph_traverse',
    `Navigate the Vector Knowledge Graph by traversing FK relationships.

**Use this to explore how records are connected:**
- Outgoing: What records does this record link to via FK fields?
- Incoming: What records reference this record?

**Example Use Cases:**
- "Show me the user who created crm.stage #1 and their company"
- "Find all crm.lead records that reference res.partner #282161"
- "Traverse from res.users #1 to see partner and company info"

**Tested Graph Chain:**
crm.stage #1 → create_uid_qdrant → res.users #1 (OdooBot)
                                    ├── partner_id_qdrant → res.partner #2
                                    └── company_id_qdrant → res.company #1

**Parameters:**
- model_name: Starting model (e.g., "crm.stage", "res.users")
- record_id: Starting Odoo record ID
- depth: 1-3 hops (default: 1)
- direction: "outgoing" | "incoming" | "both" (default: "outgoing")
- follow: "all" or specific fields like ["partner_id", "company_id"]
- incoming_limit: Max incoming results (default: 20)

**Examples:**
1. Simple outgoing:
   { "model_name": "crm.stage", "record_id": 1 }

2. Follow specific FK:
   { "model_name": "res.users", "record_id": 1, "follow": ["partner_id", "company_id"] }

3. Find incoming references:
   { "model_name": "res.users", "record_id": 1, "direction": "incoming" }

4. Both directions:
   { "model_name": "res.partner", "record_id": 282161, "direction": "both" }`,
    GraphTraverseSchema.shape,
    async (args) => {
      try {
        // Parse and validate input
        const input = GraphTraverseSchema.parse(args) as GraphTraverseInput;
        const { model_name, record_id, depth, direction, follow, incoming_limit } = input;

        console.error(`[Graph] Traversing ${model_name} #${record_id}, direction=${direction}, depth=${depth}`);

        // Initialize vector client if needed
        if (!isVectorClientAvailable()) {
          initializeVectorClient();
        }

        // Validate model exists in schema or data
        if (!isValidModel(model_name, { point_type: 'all' })) {
          return {
            content: [{
              type: 'text' as const,
              text: getModelNotFoundError(model_name, {
                point_type: 'all',
                toolName: 'graph_traverse',
              }),
            }],
          };
        }

        // Get model_id from schema first, fallback to data points
        let modelId = await getModelIdFromSchema(model_name);
        if (!modelId) {
          // Try getting model_id from data points (for data-only models)
          modelId = await getModelIdFromData(model_name);
        }
        if (!modelId) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Could not determine model_id for '${model_name}'.

The model exists but model_id couldn't be found in schema or data points.
This might be a sync issue. Try re-syncing the model.`
            }],
          };
        }

        // Build starting UUID with V2 format
        const startUuid = buildDataUuidV2(modelId, record_id);
        const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

        // Fetch root record
        const rootPoint = await retrievePointById(
          collectionName,
          startUuid,
          false
        );

        if (!rootPoint.found || !rootPoint.payload) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Record not found in Qdrant.\n\nModel: ${model_name}\nRecord ID: ${record_id}\nQdrant UUID: ${startUuid}\n\nMake sure the record is synced using:\n  pipeline_${model_name}_1984`
            }],
          };
        }

        const payload = rootPoint.payload;

        // Initialize result
        const result: TraverseResult = {
          root: {
            model_name: payload.model_name as string,
            record_id: payload.record_id as number,
            qdrant_id: startUuid,
            display_name: getDisplayName(payload, record_id),
          },
          outgoing: {},
          incoming: [],
          depth,
          not_synced: [],
        };

        // Outgoing traversal
        if (direction === 'outgoing' || direction === 'both') {
          const { outgoing, notSynced } = await traverseOutgoing(payload, follow);
          result.outgoing = outgoing;
          result.not_synced = notSynced;

          // Multi-depth traversal (depth > 1)
          // For each outgoing target, traverse one more level
          if (depth >= 2) {
            const depthResults: DepthTraversalResult = {};

            // Collect all outgoing targets that exist (handling both single and array)
            const targetsToTraverse: { fieldName: string; target: TraverseNode }[] = [];

            for (const [fieldName, targetValue] of Object.entries(outgoing)) {
              if (targetValue === null) continue;

              // Handle array of targets (many2many/one2many)
              if (Array.isArray(targetValue)) {
                for (const node of targetValue) {
                  targetsToTraverse.push({ fieldName, target: node });
                }
              }
              // Handle single target (many2one)
              else {
                targetsToTraverse.push({ fieldName, target: targetValue });
              }
            }

            // Batch fetch all target payloads for depth 2
            // Uses same collection as root record (collectionName already defined above)
            const targetUuids = targetsToTraverse.map(t => t.target.qdrant_id);
            if (targetUuids.length > 0) {
              const targetPayloads = await batchRetrievePoints(
                collectionName,
                targetUuids
              );

              // Traverse each target's outgoing FKs
              for (const { fieldName, target } of targetsToTraverse) {
                const targetData = targetPayloads.get(target.qdrant_id);
                if (targetData) {
                  const { outgoing: nestedOutgoing } = await traverseOutgoing(
                    targetData.payload,
                    'all'  // Follow all at nested levels
                  );

                  if (Object.keys(nestedOutgoing).length > 0) {
                    const path = `${fieldName} → ${target.model_name} #${target.record_id}`;
                    depthResults[path] = nestedOutgoing;
                  }
                }
              }
            }

            if (Object.keys(depthResults).length > 0) {
              result.depth_traversal = depthResults;
            }
          }
        }

        // Incoming traversal (dynamic FK discovery)
        if (direction === 'incoming' || direction === 'both') {
          result.incoming = await traverseIncoming(startUuid, model_name, incoming_limit);
        }

        // Format and return result
        const output = formatTraverseResult(result);

        // Auto-Export: Check if results exceed token threshold
        if (AUTO_EXPORT_CONFIG.ENABLED) {
          const exportable: ExportableResult = {
            type: 'graph',
            data: result,
            metadata: {
              model_name,
              query_time_ms: 0,  // Not tracked in graph_traverse
              tool_name: 'graph_traverse',
              filters_summary: `${model_name} #${record_id}, direction=${direction}, depth=${depth}`,
            },
          };

          const orchestratorResult = await orchestrateExport(exportable, undefined);

          if (orchestratorResult.exported && orchestratorResult.exportResult) {
            console.error(`[Graph] Auto-exported to ${orchestratorResult.exportResult.storage_type || 'file'}`);
            return {
              content: [{ type: 'text' as const, text: formatOrchestratorResponse(orchestratorResult) }],
            };
          }
        }

        return {
          content: [{ type: 'text' as const, text: output }],
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[Graph] Traversal error:', errorMsg);
        return {
          content: [{ type: 'text' as const, text: `Graph traversal failed: ${errorMsg}` }],
        };
      }
    }
  );

  console.error('[GraphTool] Registered 1 graph tool: graph_traverse');
}
