/**
 * Search Tool
 *
 * Provides semantic_search tool for searching schema/data semantically.
 *
 * NOTE: schema_sync has been moved to CLI (nexsus-sync sync schema)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SemanticSearchSchema } from '../../common/schemas/index.js';
import type { SemanticSearchInput } from '../../common/schemas/index.js';
import type { SchemaFilter, VectorSearchResult, SchemaPayload, DataPayload, NexsusPayload, PipelineDataPayload, SimilaritySearchResult } from '../../common/types.js';
import { isDataPayload, isPipelineDataPayload, isAnyDataPayload } from '../../common/types.js';
import { embed, isEmbeddingServiceAvailable } from '../../common/services/embedding-service.js';
import { searchSchemaCollection, scrollSchemaCollection, isVectorClientAvailable, getCollectionInfo, searchByPointType, findSimilarRecords } from '../../common/services/vector-client.js';
import { buildDataUuidV2 } from '../../common/utils/uuid-v2.js';
import { isValidModel, getModelNotFoundError, getValidModels } from '../../common/services/model-registry.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';
import { generateCacheKey, getCached, setCache } from '../../common/services/cache-service.js';
import { decodeRecord, decodeRecordToText } from '../../common/services/data-transformer.js';
import {
  trackFieldUsageBatch,
  recordTrainingPair,
  getAdaptiveKeyFields,
  getAnalyticsSummary,
  getTrainingStats,
} from '../services/analytics-service.js';
import {
  getGraphContext,
  countConnections,
  computeGraphBoost,
  formatConnectionInfo,
  getBoostExplanation,
} from '../services/graph-search-engine.js';
import { logQueryAsync } from '../../common/utils/query-logger.js';
import {
  orchestrateExport,
  formatOrchestratorResponse,
  type ExportableResult,
} from '../../common/services/export-orchestrator.js';
import { AUTO_EXPORT_CONFIG } from '../../common/constants.js';

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

/**
 * Register search tools with the MCP server
 */
export function registerSearchTools(server: McpServer): void {
  // =========================================================================
  // SEMANTIC SEARCH TOOL
  // =========================================================================

  server.tool(
    'semantic_search',
    `Search Odoo schema AND data with semantic understanding.

**UNIFIED SEARCH - Schema + Data in One Collection:**
- Schema: 17,930 field definitions (WHERE data lives)
- Data: CRM records like crm.lead (WHAT the actual values are)

**POINT TYPES:**
- \`schema\` (default): Search field definitions only
- \`data\`: Search actual CRM records
- \`all\`: Search both schema and data together

**V2 UUID FORMAT:**
Records are identified by deterministic UUIDs: \`00000002-MMMM-0000-0000-RRRRRRRRRRRR\`
Example crm.lead record #12345: \`00000002-0344-0000-0000-000000012345\`
- \`00000002\` = data namespace
- \`0344\` = model_id (crm.lead = 344)
- \`000000012345\` = record_id (12345)

**SEARCH MODES:**
1. \`semantic\` (default): Natural language vector search
   - Schema: "Where is customer email?" → finds field definitions
   - Data: "Hospital projects in Victoria" → finds CRM records

2. \`list\`: Get ALL fields in a model (schema only)
   - { "query": "all", "model_filter": "crm.lead", "search_mode": "list" }

3. \`references_out\`: Find outgoing FK fields (schema only)
4. \`references_in\`: Find incoming FK fields (schema only)

**GRAPH BOOST:**
Set graph_boost=true to rank well-connected records higher.
Connection count = outgoing FKs + incoming references from Knowledge Graph.

**LIMITS:**
- Default: 25 results (user-controlled, 1-200)
- Unlimited: Set limit=0 for up to 10,000 results

**EXAMPLES:**
- Search schema: { "query": "revenue fields", "point_type": "schema" }
- Search data: { "query": "hospital projects Victoria", "point_type": "data" }
- Search with graph boost: { "query": "partners", "point_type": "data", "graph_boost": true }
- Search both: { "query": "Hansen Yuncken", "point_type": "all" }
- List fields: { "query": "all", "model_filter": "crm.lead", "search_mode": "list" }
- Unlimited: { "query": "all partners", "point_type": "data", "limit": 0 }`,
    SemanticSearchSchema.shape,
    async (args) => {
      const startTime = Date.now();

      try {
        const input = SemanticSearchSchema.parse(args) as SemanticSearchInput;

        // Handle limit=0 as "unlimited" (up to 10,000 results)
        const effectiveLimit = input.limit === 0 ? 10000 : input.limit;

        // Check prerequisites
        if (!isVectorClientAvailable()) {
          return {
            content: [{
              type: 'text',
              text: '❌ Vector database not available. Check QDRANT_HOST configuration.',
            }],
          };
        }

        // Check if collection has data (use unified collection)
        const collectionInfo = await getCollectionInfo(UNIFIED_CONFIG.COLLECTION_NAME);
        if (!collectionInfo.exists || collectionInfo.vectorCount === 0) {
          return {
            content: [{
              type: 'text',
              text: `❌ Unified collection is empty. Run schema_sync first to upload schema data.

**To sync schema:**
Use the sync tool with action: "full_sync"`,
            }],
          };
        }

        // Validate model_filter if provided (uses model-registry for point_type-aware validation)
        if (input.model_filter) {
          if (!isValidModel(input.model_filter, { point_type: input.point_type })) {
            return {
              content: [{
                type: 'text',
                text: getModelNotFoundError(input.model_filter, {
                  point_type: input.point_type,
                  toolName: 'semantic_search',
                }),
              }],
            };
          }
        }

        // Route based on search_mode
        let results: VectorSearchResult[];

        // MODE: LIST - Get all fields in a model (filter-only, no vector similarity)
        if (input.search_mode === 'list') {
          if (!input.model_filter) {
            return {
              content: [{
                type: 'text',
                text: `❌ **list** mode requires model_filter parameter.

**Example:**
{ "query": "all", "model_filter": "crm.lead", "search_mode": "list" }`,
              }],
            };
          }

          const filter: SchemaFilter = { model_name: input.model_filter };
          if (input.type_filter) filter.field_type = input.type_filter;
          if (input.stored_only) filter.stored_only = true;

          results = await scrollSchemaCollection({
            filter,
            limit: effectiveLimit,
          });

          const output = formatListResults(input.model_filter, results, input.type_filter);

          // Log list mode query (async, fire-and-forget)
          logQueryAsync({
            tool: 'semantic_search',
            query: input.query,
            model_name: input.model_filter,
            point_type: 'schema',
            search_mode: 'list',
            result_count: results.length,
            latency_ms: Date.now() - startTime,
            success: true,
          });

          return { content: [{ type: 'text', text: output }] };
        }

        // MODE: REFERENCES_OUT - Find many2one/one2many/many2many fields IN target model
        if (input.search_mode === 'references_out') {
          if (!input.model_filter) {
            return {
              content: [{
                type: 'text',
                text: `❌ **references_out** mode requires model_filter parameter.

**Example:**
{ "query": "out", "model_filter": "crm.lead", "search_mode": "references_out" }`,
              }],
            };
          }

          const filter: SchemaFilter = {
            model_name: input.model_filter,
            field_type: ['many2one', 'one2many', 'many2many'],
          };

          results = await scrollSchemaCollection({
            filter,
            limit: effectiveLimit,
          });

          const output = formatReferencesOutResults(input.model_filter, results);

          // Log references_out query (async, fire-and-forget)
          logQueryAsync({
            tool: 'semantic_search',
            query: input.query,
            model_name: input.model_filter,
            point_type: 'schema',
            search_mode: 'references_out',
            result_count: results.length,
            latency_ms: Date.now() - startTime,
            success: true,
          });

          return { content: [{ type: 'text', text: output }] };
        }

        // MODE: REFERENCES_IN - Find fields in OTHER models that point TO target model
        if (input.search_mode === 'references_in') {
          if (!input.model_filter) {
            return {
              content: [{
                type: 'text',
                text: `❌ **references_in** mode requires model_filter parameter.

**Example:**
{ "query": "in", "model_filter": "res.partner", "search_mode": "references_in" }`,
              }],
            };
          }

          // Filter where primary_data_location starts with target model
          // e.g., primary_data_location = "res.partner.id" for many2one to res.partner
          const filter: SchemaFilter = {
            primary_data_location_prefix: input.model_filter,
            field_type: 'many2one', // Only many2one stores FK to other model
          };

          results = await scrollSchemaCollection({
            filter,
            limit: effectiveLimit,
          });

          const output = formatReferencesInResults(input.model_filter, results);

          // Log references_in query (async, fire-and-forget)
          logQueryAsync({
            tool: 'semantic_search',
            query: input.query,
            model_name: input.model_filter,
            point_type: 'schema',
            search_mode: 'references_in',
            result_count: results.length,
            latency_ms: Date.now() - startTime,
            success: true,
          });

          return { content: [{ type: 'text', text: output }] };
        }

        // MODE: SEMANTIC (default) - Vector similarity search

        // Check cache first (saves embedding API call + vector search)
        const cacheKey = generateCacheKey(
          input.query,
          'semantic',
          input.model_filter,
          input.type_filter ? [input.type_filter] : undefined,
          input.limit,
          input.min_similarity,
          input.point_type  // Include point_type in cache key
        );

        const cachedResults = getCached(cacheKey);
        if (cachedResults) {
          // Cache hit - return cached results directly
          const output = formatSearchResults(input.query, cachedResults);

          // Log cache hit (async, fire-and-forget)
          logQueryAsync({
            tool: 'semantic_search',
            query: input.query,
            model_name: input.model_filter,
            point_type: input.point_type || 'schema',
            search_mode: 'semantic',
            result_count: cachedResults.length,
            cache_hit: true,
            latency_ms: Date.now() - startTime,
            success: true,
          });

          return {
            content: [{ type: 'text', text: output + '\n\n*📦 Results from cache*' }],
          };
        }

        // Cache miss - proceed with embedding and search
        if (!isEmbeddingServiceAvailable()) {
          return {
            content: [{
              type: 'text',
              text: '❌ Embedding service not available. Check VOYAGE_API_KEY configuration.',
            }],
          };
        }

        // Generate embedding for query
        const queryEmbedding = await embed(input.query, 'query');

        // Build filter
        const filter: SchemaFilter = {};
        if (input.model_filter) filter.model_name = input.model_filter;
        if (input.type_filter) filter.field_type = input.type_filter;
        if (input.stored_only) filter.stored_only = true;
        if (input.point_type) filter.point_type = input.point_type;

        // Search - uses searchByPointType to select correct collection based on point_type
        results = await searchByPointType(queryEmbedding, {
          limit: effectiveLimit,
          minScore: input.min_similarity,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
          pointType: input.point_type as 'schema' | 'data' | 'all' | undefined,
        });

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No results found for: "${input.query}"

Try:
- Using different keywords
- Lowering min_similarity (current: ${input.min_similarity})
- Removing filters
- Using **list** mode to see all fields in a model`,
            }],
          };
        }

        // =====================================================================
        // GRAPH BOOST
        // When graph_boost=true and searching data, boost ranking by connections
        // =====================================================================
        let graphBoostApplied = false;
        const boostedResults: Array<VectorSearchResult & { boost?: number; connections?: { outgoing: number; incoming: number } }> = [];

        if (input.graph_boost && (input.point_type === 'data' || input.point_type === 'all')) {
          console.error(`[GraphBoost] Applying graph boost to ${results.length} results`);

          // Get unique models from results
          const dataResults = results.filter(r => isPipelineDataPayload(r.payload) || isDataPayload(r.payload));

          if (dataResults.length > 0) {
            // Get graph context for unique models
            const uniqueModels = new Set<string>();
            for (const r of dataResults) {
              const payload = r.payload as PipelineDataPayload | DataPayload;
              uniqueModels.add(payload.model_name);
            }

            // Fetch graph context for each model
            const graphContexts = new Map<string, Awaited<ReturnType<typeof getGraphContext>>>();
            for (const modelName of uniqueModels) {
              try {
                const ctx = await getGraphContext(modelName);
                graphContexts.set(modelName, ctx);
                console.error(`[GraphBoost] Got graph context for ${modelName}: ${ctx.totalEdges} edges`);
              } catch (error) {
                console.error(`[GraphBoost] Failed to get graph context for ${modelName}: ${error}`);
              }
            }

            // Apply boost to each data result
            for (const result of results) {
              if (isPipelineDataPayload(result.payload)) {
                const payload = result.payload as PipelineDataPayload;
                const graphContext = graphContexts.get(payload.model_name);
                const connections = countConnections(payload, graphContext);
                const boost = computeGraphBoost(payload, graphContext);
                const boostedScore = result.score * (1 + boost);

                boostedResults.push({
                  ...result,
                  score: boostedScore,
                  boost,
                  connections: { outgoing: connections.outgoing, incoming: connections.incomingEdgeCount },
                });
              } else {
                // Non-data results keep original score
                boostedResults.push({ ...result, boost: 0 });
              }
            }

            // Re-sort by boosted score
            boostedResults.sort((a, b) => b.score - a.score);
            graphBoostApplied = true;
            console.error(`[GraphBoost] Applied boost to ${boostedResults.length} results`);
          }
        }

        // Use boosted results if graph boost was applied, otherwise use original
        const finalResults = graphBoostApplied ? boostedResults : results;

        // Store in cache for future queries (store original, not boosted)
        setCache(cacheKey, results);

        // Format results (pass boost info if available)
        const output = formatSearchResults(input.query, finalResults, graphBoostApplied);
        const queryTimeMs = Date.now() - startTime;

        // Auto-Export: Check if results exceed token threshold
        if (AUTO_EXPORT_CONFIG.ENABLED) {
          const exportable: ExportableResult = {
            type: 'semantic',
            data: finalResults,
            metadata: {
              model_name: input.model_filter || 'all',
              query_time_ms: queryTimeMs,
              tool_name: 'semantic_search',
              filters_summary: `query="${input.query}", point_type=${input.point_type || 'schema'}`,
            },
          };

          const orchestratorResult = await orchestrateExport(exportable, undefined);

          if (orchestratorResult.exported && orchestratorResult.exportResult) {
            // Log auto-export query
            logQueryAsync({
              tool: 'semantic_search',
              query: input.query,
              model_name: input.model_filter,
              point_type: input.point_type || 'schema',
              search_mode: input.search_mode || 'semantic',
              result_count: finalResults.length,
              cache_hit: false,
              graph_boost: input.graph_boost || false,
              latency_ms: queryTimeMs + (orchestratorResult.exportResult.export_time_ms || 0),
              success: true,
            });

            return {
              content: [{ type: 'text', text: formatOrchestratorResponse(orchestratorResult) }],
            };
          }
        }

        // Log query for analytics (async, fire-and-forget)
        logQueryAsync({
          tool: 'semantic_search',
          query: input.query,
          model_name: input.model_filter,
          point_type: input.point_type || 'schema',
          search_mode: input.search_mode || 'semantic',
          result_count: finalResults.length,
          cache_hit: false,
          graph_boost: input.graph_boost || false,
          latency_ms: queryTimeMs,
          success: true,
        });

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Log error (async, fire-and-forget)
        logQueryAsync({
          tool: 'semantic_search',
          latency_ms: Date.now() - startTime,
          result_count: 0,
          success: false,
          error: errorMsg,
        });

        return {
          content: [{
            type: 'text',
            text: `❌ Search failed: ${errorMsg}`,
          }],
        };
      }
    }
  );

  // =========================================================================
  // FIND SIMILAR TOOL (Phase 4 - Same-Model Similarity)
  // =========================================================================

  /**
   * Zod schema for find_similar tool input
   */
  const FindSimilarSchema = z.object({
    point_id: z.string().optional().describe('Qdrant UUID of reference record (e.g., "00000002-0312-0000-0000-000000012345")'),
    model_name: z.string().optional().describe('Model name (e.g., "crm.lead") - required if using record_id'),
    record_id: z.number().optional().describe('Odoo record ID - requires model_name'),
    limit: z.number().optional().default(25).describe('Maximum results to return (default: 25)'),
    min_similarity: z.number().optional().default(0.5).describe('Minimum similarity score 0-1 (default: 0.5)'),
    graph_boost: z.boolean().optional().default(false).describe('Rank well-connected records higher'),
  });

  server.tool(
    'find_similar',
    `Find records similar to a reference record within the same model.

**What it does:**
Uses the reference record's existing vector embedding to find semantically similar records.
No re-embedding needed - uses the 1024-dimensional Voyage AI vectors already stored in Qdrant.

**Use cases:**
- Find duplicate/similar leads: "Find leads similar to lead 12345"
- Pattern discovery: "What other partners look like this one?"
- Data quality: "Are there duplicate journal entries?"
- Recommendations: "Similar products to product 456"

**Input options:**
1. By Qdrant UUID: \`{ "point_id": "00000002-0312-0000-0000-000000012345" }\`
2. By model + record_id: \`{ "model_name": "crm.lead", "record_id": 12345 }\`

**Parameters:**
- \`point_id\`: Qdrant UUID of reference record (V2 format)
- \`model_name\`: Odoo model name (required with record_id)
- \`record_id\`: Odoo record ID (requires model_name)
- \`limit\`: Max results (default: 10)
- \`min_similarity\`: Minimum similarity score 0-1 (default: 0.5)
- \`graph_boost\`: Rank by FK connections (default: false)

**Performance:**
- ~100ms total response time
- Uses existing vectors (no embedding API calls)

**Example:**
\`{ "model_name": "res.partner", "record_id": 286798, "limit": 5, "min_similarity": 0.7 }\``,
    FindSimilarSchema.shape,
    async (args) => {
      const startTime = Date.now();

      try {
        const input = FindSimilarSchema.parse(args);

        // Check prerequisites
        if (!isVectorClientAvailable()) {
          return {
            content: [{
              type: 'text',
              text: '❌ Vector database not available. Check QDRANT_HOST configuration.',
            }],
          };
        }

        // Validate input - need either point_id OR (model_name + record_id)
        if (!input.point_id && (!input.model_name || input.record_id === undefined)) {
          return {
            content: [{
              type: 'text',
              text: `❌ Invalid input. Provide either:
- \`point_id\`: Qdrant UUID (e.g., "00000002-0312-0000-0000-000000012345")
- OR \`model_name\` + \`record_id\` (e.g., { "model_name": "crm.lead", "record_id": 12345 })`,
            }],
          };
        }

        // Build point_id from model_name + record_id if not provided
        let pointId = input.point_id;
        if (!pointId && input.model_name && input.record_id !== undefined) {
          // Validate model exists in synced data (find_similar only works with data points)
          if (!isValidModel(input.model_name, { point_type: 'data' })) {
            return {
              content: [{
                type: 'text',
                text: getModelNotFoundError(input.model_name, {
                  point_type: 'data',
                  toolName: 'find_similar',
                }),
              }],
            };
          }

          // Look up model_id from model_name (needed to build UUID)
          const modelId = await getModelIdFromName(input.model_name);
          if (!modelId) {
            return {
              content: [{
                type: 'text',
                text: `❌ Model "${input.model_name}" exists in synced data but model_id not found in pipeline config.

**This is unusual.** The model may have been synced with a different configuration.
Try using the \`point_id\` parameter directly instead (format: 00000002-MMMM-0000-0000-RRRRRRRRRRRR).`,
              }],
            };
          }
          pointId = buildDataUuidV2(modelId, input.record_id);
        }

        if (!pointId) {
          return {
            content: [{
              type: 'text',
              text: '❌ Could not determine point_id. Please provide point_id directly or model_name + record_id.',
            }],
          };
        }

        // Find similar records
        const result = await findSimilarRecords(pointId, {
          limit: input.limit,
          minSimilarity: input.min_similarity,
          applyGraphBoost: input.graph_boost,
        });

        // Format results
        const output = formatSimilarityResults(result);
        const queryTimeMs = Date.now() - startTime;

        // Auto-Export: Check if results exceed token threshold
        if (AUTO_EXPORT_CONFIG.ENABLED) {
          const exportable: ExportableResult = {
            type: 'similar',
            data: result.similar_records,
            metadata: {
              model_name: result.model_name,
              query_time_ms: queryTimeMs,
              tool_name: 'find_similar',
              filters_summary: `reference=${pointId}`,
            },
          };

          const orchestratorResult = await orchestrateExport(exportable, undefined);

          if (orchestratorResult.exported && orchestratorResult.exportResult) {
            // Log auto-export query
            logQueryAsync({
              tool: 'find_similar',
              query: pointId,
              model_name: result.model_name,
              point_type: 'data',
              result_count: result.similar_records.length,
              graph_boost: input.graph_boost || false,
              latency_ms: queryTimeMs + (orchestratorResult.exportResult.export_time_ms || 0),
              success: true,
            });

            return {
              content: [{ type: 'text', text: formatOrchestratorResponse(orchestratorResult) }],
            };
          }
        }

        // Log query (async)
        logQueryAsync({
          tool: 'find_similar',
          query: pointId,
          model_name: result.model_name,
          point_type: 'data',
          result_count: result.similar_records.length,
          graph_boost: input.graph_boost || false,
          latency_ms: queryTimeMs,
          success: true,
        });

        return {
          content: [{ type: 'text', text: output }],
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // Log error
        logQueryAsync({
          tool: 'find_similar',
          latency_ms: Date.now() - startTime,
          result_count: 0,
          success: false,
          error: errorMsg,
        });

        return {
          content: [{
            type: 'text',
            text: `❌ Find similar failed: ${errorMsg}`,
          }],
        };
      }
    }
  );

  console.error('[SearchTool] Registered 2 search tools: semantic_search, find_similar');
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if payload is a NexsusPayload (from Excel-based nexsus collection)
 * NexsusPayload has raw_payload field, SchemaPayload has raw_encoded instead
 */
function isNexsusPayload(payload: SchemaPayload | NexsusPayload): payload is NexsusPayload {
  return 'raw_payload' in payload && typeof (payload as NexsusPayload).raw_payload === 'string';
}

// =============================================================================
// FORMATTING FUNCTIONS
// =============================================================================

/**
 * Extended result type with graph boost info
 */
interface BoostedResult extends VectorSearchResult {
  boost?: number;
  connections?: { outgoing: number; incoming: number };
}

/**
 * Format semantic search results for display (handles both schema and data)
 */
function formatSearchResults(
  query: string,
  results: VectorSearchResult[] | BoostedResult[],
  graphBoostApplied: boolean = false
): string {
  const lines: string[] = [];

  // Count schema vs data results (includes both old DataPayload and new PipelineDataPayload)
  const schemaResults = results.filter(r => !isAnyDataPayload(r.payload));
  const dataResults = results.filter(r => isAnyDataPayload(r.payload));

  lines.push(`**Found ${results.length} results for:** "${query}"`);
  if (schemaResults.length > 0 && dataResults.length > 0) {
    lines.push(`(${schemaResults.length} schema, ${dataResults.length} data)`);
  }
  if (graphBoostApplied) {
    lines.push(`🔗 *Graph boost applied - well-connected records ranked higher*`);
  }
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const { score, payload, qdrant_id } = results[i];

    lines.push(`---`);

    if (isPipelineDataPayload(payload)) {
      // Format PIPELINE DATA result (new format from pipeline_sync)
      const pipelinePayload = payload as PipelineDataPayload;
      const boostedResult = results[i] as BoostedResult;
      lines.push(`### ${i + 1}. [DATA] ${pipelinePayload.model_name} #${pipelinePayload.record_id}`);

      // Show score with boost info if applicable
      if (boostedResult.boost && boostedResult.boost > 0) {
        const originalScore = score / (1 + boostedResult.boost);
        lines.push(`**Score:** ${(score * 100).toFixed(1)}% (+${(boostedResult.boost * 100).toFixed(1)}% graph boost from ${(originalScore * 100).toFixed(1)}%)`);
      } else {
        lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
      }

      // Show connection info if available
      if (boostedResult.connections) {
        lines.push(`**Connections:** ${boostedResult.connections.outgoing} outgoing, ${boostedResult.connections.incoming} references`);
      }

      if (qdrant_id) {
        lines.push(`**Qdrant ID:** ${qdrant_id}`);
      }

      // Show data freshness (G6 - Surface provenance in search)
      if (pipelinePayload.sync_timestamp) {
        const syncDate = new Date(pipelinePayload.sync_timestamp);
        const now = new Date();
        const daysDiff = Math.floor((now.getTime() - syncDate.getTime()) / (1000 * 60 * 60 * 24));

        let freshnessLabel = '';
        if (daysDiff === 0) freshnessLabel = '(today)';
        else if (daysDiff === 1) freshnessLabel = '(yesterday)';
        else if (daysDiff < 7) freshnessLabel = `(${daysDiff} days ago)`;
        else freshnessLabel = `(${Math.floor(daysDiff / 7)} weeks ago)`;

        lines.push(`**Last synced:** ${syncDate.toLocaleDateString()} ${freshnessLabel}`);
      }
      lines.push('');

      // Display payload fields (all fields marked with payload=1 in Excel)
      lines.push('**Record Fields:**');
      const skipFields = ['record_id', 'model_name', 'model_id', 'sync_timestamp', 'point_type', 'vector_text', 'graph_refs', 'point_id'];
      const payloadFields = Object.entries(pipelinePayload)
        .filter(([key]) => !skipFields.includes(key))
        .filter(([, value]) => value !== null && value !== undefined && value !== '');

      if (payloadFields.length > 0) {
        for (const [key, value] of payloadFields) {
          // Format field name: convert snake_case to Title Case
          const fieldLabel = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          // Handle JSON objects properly (e.g., analytic_distribution)
          let displayValue: string;
          if (value === null || value === undefined) {
            displayValue = '(null)';
          } else if (typeof value === 'object') {
            displayValue = JSON.stringify(value);
          } else {
            displayValue = String(value);
          }
          lines.push(`- **${fieldLabel}:** ${displayValue}`);
        }
      } else {
        lines.push('*No fields in payload*');
      }
    } else if (isDataPayload(payload)) {
      // Format old DATA result with NEXUS decoding (legacy format)
      const dataPayload = payload as DataPayload;
      lines.push(`### ${i + 1}. [DATA] ${dataPayload.model_name} #${dataPayload.record_id}`);
      lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
      lines.push('');

      // Get adaptive key fields (config + analytics-discovered)
      const keyFields = getAdaptiveKeyFields(dataPayload.model_name);

      // Decode the record using NEXUS decoder
      const decoded = decodeRecord(dataPayload.encoded_string, keyFields);

      if (decoded.length > 0) {
        lines.push('**Key Fields:**');
        for (const field of decoded) {
          lines.push(`- **${field.field_label}:** ${field.display_value}`);
        }

        // Track field usage for analytics (async, fire-and-forget)
        setImmediate(() => {
          const fieldNames = decoded.map(f => f.field_name);
          trackFieldUsageBatch(dataPayload.model_name, fieldNames, 'decode');
        });

        // Record training pair for Phase 2
        const decodedText = decodeRecordToText(dataPayload.encoded_string, keyFields);
        setImmediate(() => {
          recordTrainingPair(dataPayload.encoded_string, decodedText, dataPayload.model_name);
        });
      } else {
        lines.push('*No decodable key fields found*');
      }

      // Collapsible raw encoded data
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Raw encoded data (click to expand)</summary>');
      lines.push('');
      lines.push('```');
      lines.push(dataPayload.encoded_string);
      lines.push('```');
      lines.push('</details>');
    } else if (isNexsusPayload(payload)) {
      // Format NEXSUS SCHEMA result (from Excel-based nexsus collection)
      const nexsusPayload = payload as NexsusPayload;
      lines.push(`### ${i + 1}. [SCHEMA] ${nexsusPayload.model_name}.${nexsusPayload.field_name}`);
      lines.push(`**Label:** ${nexsusPayload.field_label}`);
      lines.push(`**Type:** ${nexsusPayload.field_type}`);

      // Show relationship info for relational fields
      if (nexsusPayload.field_type === 'many2one' && nexsusPayload.fk_location_model) {
        lines.push(`**Relates to:** ${nexsusPayload.fk_location_model}`);
      } else if ((nexsusPayload.field_type === 'one2many' || nexsusPayload.field_type === 'many2many') && nexsusPayload.fk_location_model) {
        lines.push(`**Related location:** ${nexsusPayload.fk_location_model}`);
      }

      lines.push(`**Stored:** ${nexsusPayload.stored ? 'Yes' : 'No (Computed)'}`);
      lines.push(`**IDs:** Model ${nexsusPayload.model_id} | Field ${nexsusPayload.field_id}`);
      if (qdrant_id) {
        lines.push(`**Qdrant ID:** ${qdrant_id}`);
      }
      lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
    } else {
      // Format OLD SCHEMA result (SchemaPayload from crm_schema collection)
      const schemaPayload = payload as SchemaPayload;
      lines.push(`### ${i + 1}. [SCHEMA] ${schemaPayload.model_name}.${schemaPayload.field_name}`);
      lines.push(`**Label:** ${schemaPayload.field_label}`);
      lines.push(`**Type:** ${schemaPayload.field_type}`);

      // Show relationship info for relational fields
      if (schemaPayload.field_type === 'many2one' && schemaPayload.primary_data_location) {
        const relatedModel = schemaPayload.primary_data_location.replace('.id', '');
        lines.push(`**Relates to:** ${relatedModel}`);
      } else if ((schemaPayload.field_type === 'one2many' || schemaPayload.field_type === 'many2many') && schemaPayload.primary_data_location) {
        lines.push(`**Related location:** ${schemaPayload.primary_data_location}`);
      }

      lines.push(`**Primary Data Location:** ${schemaPayload.primary_data_location || 'N/A'}`);
      lines.push(`**Stored:** ${schemaPayload.stored ? 'Yes' : 'No (Computed)'}`);
      lines.push(`**IDs:** Model ${schemaPayload.primary_model_id || 'N/A'} | Field ${schemaPayload.primary_field_id || 'N/A'}`);
      lines.push(`**Score:** ${(score * 100).toFixed(1)}%`);
    }
  }

  // Add helpful tip at the end
  lines.push(`\n---`);
  if (dataResults.length > 0) {
    lines.push(`💡 **Field Decoding:** Key fields automatically extracted from record payload.`);
    lines.push(`   Use Qdrant ID with inspect_record for full record details.`);
  } else {
    lines.push(`💡 **Tip:** Use Model ID and Field ID to access data directly via Odoo API.`);
  }

  return lines.join('\n');
}

/**
 * Format list mode results (all fields in a model)
 * Note: List mode only works with schema, so we cast payloads to SchemaPayload
 */
function formatListResults(
  modelName: string,
  results: VectorSearchResult[],
  typeFilter?: string
): string {
  const lines: string[] = [];

  // Summary header
  lines.push(`## Fields in ${modelName}`);
  lines.push(`**Total fields:** ${results.length}${typeFilter ? ` (filtered by type: ${typeFilter})` : ''}\n`);

  // Group by field type for better overview
  const byType: Record<string, VectorSearchResult[]> = {};
  for (const r of results) {
    const payload = r.payload as SchemaPayload;
    const type = payload.field_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  }

  // Show type counts
  lines.push(`**By Type:**`);
  for (const [type, fields] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`- ${type}: ${fields.length}`);
  }
  lines.push('');

  // List fields organized by type
  for (const [type, fields] of Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`### ${type} (${fields.length})`);

    for (const { payload: p } of fields) {
      // Handle both NexsusPayload and SchemaPayload
      const payload = p as SchemaPayload & NexsusPayload;
      const storedMark = payload.stored ? '' : ' *(computed)*';

      lines.push(`- **${payload.field_name}** - ${payload.field_label}${storedMark}`);

      // Show target for relational fields
      if (type === 'many2one') {
        // Use fk_location_model for Nexsus, primary_data_location for Schema
        const target = payload.fk_location_model ||
                       (payload.primary_data_location?.replace('.id', '') || 'unknown');
        lines.push(`  → ${target}`);
      }
    }
    lines.push('');
  }

  // Model coordinate info
  if (results.length > 0) {
    const firstPayload = results[0].payload as SchemaPayload & NexsusPayload;
    const modelId = firstPayload.model_id;
    lines.push(`---`);
    // Check if this is from Nexsus collection (has raw_payload) or old Schema (has raw_encoded)
    if ('raw_payload' in firstPayload) {
      // Nexsus format
      lines.push(`📍 **Model ID:** ${modelId}`);
    } else {
      lines.push(`📍 **Model ID:** ${modelId}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format references_out results (fields that POINT TO other models)
 * Note: References mode only works with schema, so we cast payloads to SchemaPayload
 */
function formatReferencesOutResults(
  modelName: string,
  results: VectorSearchResult[]
): string {
  const lines: string[] = [];

  lines.push(`## Outgoing References from ${modelName}`);
  lines.push(`**Total relational fields:** ${results.length}\n`);

  // Group by relationship type
  const byType: Record<string, VectorSearchResult[]> = {};
  for (const r of results) {
    const payload = r.payload as SchemaPayload;
    const type = payload.field_type;
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  }

  // Many2one = FK to another model
  if (byType['many2one']?.length) {
    lines.push(`### Many-to-One (Foreign Keys) - ${byType['many2one'].length}`);
    lines.push(`*Fields that link to ONE record in another model*\n`);

    for (const { payload: p } of byType['many2one']) {
      const payload = p as SchemaPayload & NexsusPayload;
      // Use fk_location_model for Nexsus, primary_data_location for Schema
      const targetModel = payload.fk_location_model ||
                          (payload.primary_data_location?.replace('.id', '') || 'unknown');
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Links to: **${targetModel}**`);
    }
    lines.push('');
  }

  // One2many = reverse relationship
  if (byType['one2many']?.length) {
    lines.push(`### One-to-Many - ${byType['one2many'].length}`);
    lines.push(`*Fields that show MANY records from another model*\n`);

    for (const { payload: p } of byType['one2many']) {
      const payload = p as SchemaPayload & NexsusPayload;
      const relatedModel = payload.fk_location_model || payload.primary_data_location || 'unknown';
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Shows records from: ${relatedModel}`);
    }
    lines.push('');
  }

  // Many2many = bidirectional relationship
  if (byType['many2many']?.length) {
    lines.push(`### Many-to-Many - ${byType['many2many'].length}`);
    lines.push(`*Fields with bidirectional many-to-many relationship*\n`);

    for (const { payload: p } of byType['many2many']) {
      const payload = p as SchemaPayload & NexsusPayload;
      const relatedModel = payload.fk_location_model || payload.primary_data_location || 'unknown';
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → Related: ${relatedModel}`);
    }
    lines.push('');
  }

  if (results.length === 0) {
    lines.push(`*No relational fields found in ${modelName}*`);
  }

  return lines.join('\n');
}

/**
 * Format references_in results (fields in OTHER models that point TO target)
 * Note: References mode only works with schema, so we cast payloads to SchemaPayload
 */
function formatReferencesInResults(
  targetModel: string,
  results: VectorSearchResult[]
): string {
  const lines: string[] = [];

  lines.push(`## Incoming References to ${targetModel}`);
  lines.push(`**Models that link TO ${targetModel}:** ${results.length} fields\n`);

  if (results.length === 0) {
    lines.push(`*No incoming references found to ${targetModel}*`);
    lines.push(`\n**Tip:** This model may not be referenced by other models, or may use a different naming pattern.`);
    return lines.join('\n');
  }

  // Group by source model
  const byModel: Record<string, VectorSearchResult[]> = {};
  for (const r of results) {
    const payload = r.payload as SchemaPayload;
    const sourceModel = payload.model_name;
    if (!byModel[sourceModel]) byModel[sourceModel] = [];
    byModel[sourceModel].push(r);
  }

  lines.push(`**Referenced from ${Object.keys(byModel).length} models:**\n`);

  for (const [sourceModel, fields] of Object.entries(byModel).sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${sourceModel} (${fields.length} field${fields.length > 1 ? 's' : ''})`);

    for (const { payload: p } of fields) {
      const payload = p as SchemaPayload & NexsusPayload;
      lines.push(`- **${payload.field_name}** (${payload.field_label})`);
      lines.push(`  → many2one FK to ${targetModel}`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`💡 **Use case:** These are the models that have a direct relationship to ${targetModel}.`);
  lines.push(`You can use these foreign keys to join data across models.`);

  return lines.join('\n');
}

// =============================================================================
// SIMILARITY SEARCH HELPERS (Phase 4)
// =============================================================================

/**
 * Get model_id from model_name by querying the pipeline loader
 *
 * Uses the pipeline loader to look up the numeric model ID.
 * Returns undefined if model not found.
 */
async function getModelIdFromName(modelName: string): Promise<number | undefined> {
  try {
    // Import dynamically to avoid circular dependencies
    const { getModelId } = await import('../../common/services/excel-pipeline-loader.js');
    return getModelId(modelName);
  } catch (error) {
    console.error(`[SearchTool] Failed to get model_id for ${modelName}: ${error}`);
    return undefined;
  }
}

/**
 * Format similarity search results for display
 *
 * Presents similar records in a clear, readable format with:
 * - Reference record info
 * - Similar records ranked by similarity score
 * - Key payload fields for comparison
 * - Connection counts if graph boost was applied
 */
function formatSimilarityResults(result: SimilaritySearchResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`## Similar Records in ${result.model_name}`);
  lines.push('');
  lines.push(`**Reference:** #${result.reference_record_id} (${result.reference_point_id})`);
  lines.push(`**Found:** ${result.similar_records.length} similar records`);
  lines.push(`**Total in model:** ${result.total_model_records.toLocaleString()} records`);
  lines.push(`**Search time:** ${result.search_time_ms}ms`);

  if (result.search_params.graph_boost_applied) {
    lines.push(`🔗 *Graph boost applied - well-connected records ranked higher*`);
  }
  lines.push('');

  if (result.similar_records.length === 0) {
    lines.push(`*No similar records found above ${(result.search_params.min_similarity * 100).toFixed(0)}% similarity threshold*`);
    lines.push('');
    lines.push('**Tips:**');
    lines.push('- Lower the `min_similarity` threshold (e.g., 0.3)');
    lines.push('- Check that the reference record has been synced to Qdrant');
    return lines.join('\n');
  }

  // Similar records
  for (let i = 0; i < result.similar_records.length; i++) {
    const record = result.similar_records[i];
    lines.push('---');
    lines.push(`### ${i + 1}. Record #${record.record_id}`);
    lines.push(`**Similarity:** ${(record.similarity_score * 100).toFixed(1)}%`);
    lines.push(`**Qdrant ID:** ${record.point_id}`);

    // Show connection count if graph boost was applied
    if (record.connection_count !== undefined) {
      lines.push(`**Connections:** ${record.connection_count} FK references`);
    }

    // Show payload summary
    const summaryEntries = Object.entries(record.payload_summary);
    if (summaryEntries.length > 0) {
      lines.push('');
      lines.push('**Key Fields:**');
      for (const [key, value] of summaryEntries) {
        // Format field name nicely
        const fieldLabel = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        // Handle different value types
        let displayValue: string;
        if (value === null || value === undefined) {
          displayValue = '(null)';
        } else if (typeof value === 'object') {
          displayValue = JSON.stringify(value);
        } else {
          displayValue = String(value);
        }
        // Truncate long values
        if (displayValue.length > 100) {
          displayValue = displayValue.substring(0, 97) + '...';
        }
        lines.push(`- **${fieldLabel}:** ${displayValue}`);
      }
    }
    lines.push('');
  }

  // Footer tips
  lines.push('---');
  lines.push('💡 **Tips:**');
  lines.push(`- Use \`graph_traverse\` to explore relationships for specific records`);
  lines.push(`- Use \`nexsus_search\` to filter and aggregate data`);
  lines.push(`- Higher similarity = more semantically similar record text`);

  return lines.join('\n');
}
