/**
 * Nexsus Search Tool
 *
 * MCP tool for precise data retrieval and aggregation.
 * Designed for financial reporting accuracy - must match Odoo Trial Balance.
 *
 * Two modes:
 * 1. Aggregation mode: SUM, COUNT, AVG, MIN, MAX with optional GROUP BY
 * 2. Record mode: Retrieve matching records with pagination
 *
 * @example
 * // Get total debit/credit for GL account 319 in March 2025
 * nexsus_search({
 *   model_name: "account.move.line",
 *   filters: [
 *     { field: "account_id_id", op: "eq", value: 319 },
 *     { field: "date", op: "gte", value: "2025-03-01" },
 *     { field: "date", op: "lte", value: "2025-03-31" },
 *     { field: "parent_state", op: "eq", value: "posted" }
 *   ],
 *   aggregations: [
 *     { field: "debit", op: "sum", alias: "total_debit" },
 *     { field: "credit", op: "sum", alias: "total_credit" }
 *   ]
 * })
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildQdrantFilter, validateFilters, formatFiltersForDisplay, validateIndexedFields } from '../../common/services/filter-builder.js';
import { executeAggregation, executeInMemoryAggregation } from '../services/aggregation-engine.js';
import { scrollRecords } from '../../common/services/scroll-engine.js';
import { isVectorClientAvailable } from '../../common/services/vector-client.js';
import {
  initializeSchemaLookup,
  isSchemaLookupInitialized,
  validateExactQuery,
  formatValidationErrors,
  getModelNameById
} from '../../common/services/schema-lookup.js';
import { parseDataUuidV2 } from '../../common/utils/uuid-v2.js';
import {
  resolveLinks,
  resolveGroupLinks,
  enrichRecordsWithLinks,
  getLinkedDisplayName,
  resolveJsonFkLinks,
  enrichRecordsWithJsonFkLinks,
  resolveGroupJsonFkLinks,
  formatGroupJsonFkDisplay,
} from '../../common/services/nexsus-link.js';
import {
  resolveDotNotationFilters,
  hasDotNotationFilters
} from '../services/dot-notation-resolver.js';
import { getGraphContext } from '../../common/services/knowledge-graph.js';
import { logQueryAsync, summarizeFilters } from '../../common/utils/query-logger.js';
import { enrichRecords, hasEnrichment, getIntelligenceUsed } from '../services/data-grid.js';
import { getModelIdByName } from '../../common/services/schema-lookup.js';
import {
  exportAggregationToExcel,
  exportRecordsToExcel,
  formatExportResponse,
} from '../../common/services/file-export.js';
import {
  orchestrateExport,
  estimateResultTokens,
  formatOrchestratorResponse,
  type ExportableResult,
} from '../../common/services/export-orchestrator.js';
import { AUTO_EXPORT_CONFIG } from '../../common/constants.js';
import type { NexsusSearchInput, Aggregation, FilterCondition, AggregationResult, ScrollResult, LinkResolutionResult, JsonFkResolutionResult, DataGridEnrichment, EnrichedRecord, FileExportResult } from '../../common/types.js';

// =============================================================================
// ZOD SCHEMA DEFINITIONS
// =============================================================================

/**
 * Filter condition schema
 */
const FilterConditionSchema = z.object({
  field: z.string()
    .min(1, 'Field name required')
    .describe('Payload field name (e.g., "account_id_id", "date", "parent_state")'),

  op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'])
    .describe('Comparison operator: eq(=), neq(!=), gt(>), gte(>=), lt(<), lte(<=), in(array), contains(text)'),

  value: z.unknown()
    .describe('Value to compare against (number, string, or array for "in" operator)')
});

/**
 * Aggregation definition schema
 */
const AggregationSchema = z.object({
  field: z.string()
    .min(1, 'Field name required')
    .describe('Field to aggregate (e.g., "debit", "credit", "balance")'),

  op: z.enum(['sum', 'count', 'avg', 'min', 'max'])
    .describe('Aggregation function: sum, count, avg, min, max'),

  alias: z.string()
    .min(1, 'Alias required')
    .describe('Result field name (e.g., "total_debit")')
});

/**
 * Full nexsus_search input schema
 *
 * Tier 3 Innovation: model_name is optional when filtering by point_id.
 * The model can be extracted from the UUID segment (00000002-MMMM-...).
 */
export const NexsusSearchSchema = z.object({
  model_name: z.string()
    .min(1, 'Model name required')
    .optional()
    .describe('Odoo model name (e.g., "account.move.line"). Optional when filtering by point_id (model extracted from UUID).'),

  filters: z.array(FilterConditionSchema)
    .min(1, 'At least one filter required')
    .describe('Filter conditions (combined with AND logic)'),

  aggregations: z.array(AggregationSchema)
    .optional()
    .describe('Aggregations to compute. If omitted, returns matching records instead.'),

  group_by: z.array(z.string())
    .optional()
    .describe('Fields to group by (only with aggregations). Supports _linked.FK.Field syntax for grouping by linked record fields (e.g., "_linked.Account_id.F1").'),

  fields: z.array(z.string())
    .optional()
    .describe('Fields to return (only for record retrieval, not aggregation)'),

  limit: z.number()
    .int()
    .positive()
    .optional()
    .describe('Max records to return. If omitted, returns ALL matching records. Use export_to_file=true for large datasets.'),

  offset: z.number()
    .int()
    .min(0)
    .optional()
    .describe('Pagination offset (skip first N records)'),

  // Nexsus Link: Optional FK resolution for cross-model queries
  link: z.array(z.string())
    .optional()
    .describe('Nexsus Link: FK fields to link related records for (e.g., ["partner_id", "account_id"]). Enriches results with linked record names.'),

  link_fields: z.array(z.string())
    .optional()
    .describe('Fields to return from linked relations. Defaults to ["name", "display_name"]. Use ["*"] for all fields.'),

  // Nexsus Link JSON: Resolve JSON FK fields (e.g., analytic_distribution)
  link_json: z.array(z.string())
    .optional()
    .describe('JSON FK fields to resolve (e.g., ["analytic_distribution"]). Keys in JSON objects are resolved to target record names.'),

  // Knowledge Graph: Show FK relationships
  show_relationships: z.boolean()
    .optional()
    .default(false)
    .describe('Show FK relationships from Knowledge Graph in output header. Shows edge counts and related models.'),

  // ==========================================================================
  // DATA GRID ENRICHMENT FLAGS (Phase 5)
  // All flags default to false - base search path unchanged when not requested
  // ==========================================================================

  // Graph context: Include FK relationships and connection counts per record
  include_graph_context: z.boolean()
    .optional()
    .default(false)
    .describe('Include FK relationships and connection counts per record. Shows outgoing FKs and incoming reference count.'),

  // Validation status: Include orphan FK detection and integrity score per record
  include_validation_status: z.boolean()
    .optional()
    .default(false)
    .describe('Include orphan FK detection per record. Shows which FK fields point to missing targets and integrity score.'),

  // Similar records: Include similar records within same model per record
  include_similar: z.boolean()
    .optional()
    .default(false)
    .describe('Include similar records within same model. Uses vector similarity to find duplicate/related records.'),

  // Similar limit: Number of similar records per result (max 5, default 3)
  similar_limit: z.number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('Number of similar records to include per result (1-5, default: 3). Only used when include_similar=true.'),

  // ==========================================================================
  // TOKEN LIMITATION - STAGE 2: Detail Level Control
  // ==========================================================================

  // Detail level: Controls response size for aggregation queries
  detail_level: z.enum(['summary', 'top_n', 'full'])
    .optional()
    .default('full')
    .describe('Response detail level for aggregations: "summary" (~400 tokens, grand total only), "top_n" (~800 tokens, top groups with %), "full" (all groups, default).'),

  // Top N: Number of groups to show in top_n mode
  top_n: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(10)
    .describe('Number of top groups to show when detail_level is "top_n" (1-100, default: 10). Groups sorted by first aggregation field descending.'),

  // ==========================================================================
  // TOKEN LIMITATION - STAGE 4: File Export
  // ==========================================================================

  // Export to file: Save results to Excel instead of inline response
  export_to_file: z.boolean()
    .optional()
    .default(false)
    .describe('Export results to Excel file instead of inline response. Returns file path. Use for large datasets that would exceed token limits.')
});

// Type inference from schema
export type NexsusSearchSchemaInput = z.infer<typeof NexsusSearchSchema>;

// =============================================================================
// LINKED GROUP BY HELPERS
// =============================================================================

/**
 * Check if any GROUP BY field references linked data
 *
 * @example
 * hasLinkedGroupBy(['_linked.Account_id.F1', 'Entity']) // true
 * hasLinkedGroupBy(['Entity', 'F1']) // false
 */
function hasLinkedGroupBy(groupBy?: string[]): boolean {
  return groupBy?.some(f => f.startsWith('_linked.')) ?? false;
}

/**
 * Extract link field dependencies from linked GROUP BY fields
 *
 * @example
 * extractLinkedFieldDependencies(['_linked.Account_id.F1', 'Entity'])
 * // Returns: ['Account_id']
 */
function extractLinkedFieldDependencies(groupBy: string[]): string[] {
  return groupBy
    .filter(f => f.startsWith('_linked.'))
    .map(f => f.split('.')[1]); // "_linked.Account_id.F1" → "Account_id"
}

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

/**
 * Register the nexsus_search tool with the MCP server
 */
export function registerNexsusSearchTool(server: McpServer): void {
  server.tool(
    'nexsus_search',
    `Execute precise data queries against synced Odoo data with filtering and aggregation.

**WORKFLOW:** Before executing, Claude should:
1. Use semantic_search first for entity discovery (find IDs, verify names)
2. Build query parameters from user intent and discovery results
3. Present search plan for user approval (what, filters, output)
4. Execute only after user confirms

See docs/SKILL-nexsus-search.md for detailed workflow guidance.

**PURPOSE:** Get precise, complete data matching Odoo exactly - for financial reports, audits, validations.
**NOT FOR:** Discovery or semantic search (use semantic_search for that).

**OPERATORS:** eq, neq, gt, gte, lt, lte, in, contains

**AGGREGATIONS:** sum, count, avg, min, max

**EXAMPLE - GL Account Total:**
{
  "model_name": "account.move.line",
  "filters": [
    {"field": "account_id_id", "op": "eq", "value": 319},
    {"field": "date", "op": "gte", "value": "2025-03-01"},
    {"field": "date", "op": "lte", "value": "2025-03-31"},
    {"field": "parent_state", "op": "eq", "value": "posted"}
  ],
  "aggregations": [
    {"field": "debit", "op": "sum", "alias": "total_debit"},
    {"field": "credit", "op": "sum", "alias": "total_credit"}
  ]
}

**EXAMPLE - Retrieve Records:**
{
  "model_name": "account.move.line",
  "filters": [{"field": "partner_id_id", "op": "eq", "value": 286798}],
  "fields": ["date", "name", "debit", "credit", "balance"],
  "limit": 100
}

**NEXSUS LINK - Include Related Record Names:**
{
  "model_name": "account.move.line",
  "filters": [{"field": "account_id_id", "op": "eq", "value": 319}],
  "aggregations": [{"field": "debit", "op": "sum", "alias": "total"}],
  "group_by": ["partner_id_id"],
  "link": ["partner_id"]
}

**DOT NOTATION - Filter by Related Record Fields:**
{
  "model_name": "account.move.line",
  "filters": [{"field": "partner_id.name", "op": "contains", "value": "Wadsworth"}],
  "aggregations": [{"field": "debit", "op": "sum", "alias": "total"}]
}

**LINKED GROUP BY - Group by fields from FK-linked records:**
{
  "model_name": "actual",
  "filters": [{"field": "Entity", "op": "eq", "value": "AU"}],
  "aggregations": [{"field": "Amount", "op": "sum", "alias": "total"}],
  "group_by": ["_linked.Account_id.F1"],
  "link": ["Account_id"]
}
// Use _linked.FKField.TargetField syntax to group by a field from linked master records

**SYSTEM FIELDS:** point_id, point_type, sync_timestamp, record_id, model_id, model_name, vector_text

**POINT_ID QUERIES - Direct UUID Lookup (model_name auto-resolved):**
{
  "filters": [
    {"field": "point_id", "op": "eq", "value": "00000002-0312-0000-0000-000000691174"}
  ]
}

**UUID SEGMENT MATCHING - Find All Records for Model 312:**
{
  "model_name": "account.move.line",
  "filters": [{"field": "point_id", "op": "contains", "value": "00000002-0312"}],
  "aggregations": [{"field": "record_id", "op": "count", "alias": "total"}]
}

**SYNC TIMESTAMP - Find Recent Syncs:**
{
  "model_name": "account.move.line",
  "filters": [{"field": "sync_timestamp", "op": "gte", "value": "2025-12-28T00:00:00"}],
  "limit": 100
}

**DETAIL LEVELS (Token Limitation):**
- \`detail_level: "summary"\` - Grand total only (~400 tokens). Best for quick overview.
- \`detail_level: "top_n"\` - Top 10 groups with % of total (~800 tokens). Default top_n=10.
- \`detail_level: "full"\` - All groups (default). May be large for many groups.

**EXAMPLE - Summary Mode (89-99% token reduction):**
{
  "model_name": "account.move.line",
  "filters": [{"field": "date", "op": "gte", "value": "2025-01-01"}],
  "aggregations": [{"field": "debit", "op": "sum", "alias": "total_debit"}],
  "group_by": ["partner_id_id"],
  "detail_level": "summary"
}

**EXAMPLE - Top 5 Mode:**
{
  "model_name": "account.move.line",
  "filters": [{"field": "date", "op": "gte", "value": "2025-01-01"}],
  "aggregations": [{"field": "debit", "op": "sum", "alias": "total_debit"}],
  "group_by": ["partner_id_id"],
  "detail_level": "top_n",
  "top_n": 5
}`,
    NexsusSearchSchema.shape,
    async (args) => {
      const startTime = Date.now();

      try {
        // Parse and validate input
        const input = NexsusSearchSchema.parse(args) as NexsusSearchInput;

        // Tier 3: Auto-resolve model_name from point_id filter if not provided
        if (!input.model_name) {
          const pointIdFilter = input.filters.find(
            f => f.field === 'point_id' && ['eq', 'in'].includes(f.op)
          );

          if (pointIdFilter) {
            // Initialize schema lookup to get model mapping
            if (!isSchemaLookupInitialized()) {
              try {
                initializeSchemaLookup();
              } catch (err) {
                console.error('[NexsusSearch] Schema initialization failed for model lookup');
              }
            }

            // Extract model_id from point_id UUID
            const pointIdValue = pointIdFilter.op === 'eq'
              ? String(pointIdFilter.value)
              : Array.isArray(pointIdFilter.value) ? String(pointIdFilter.value[0]) : null;

            if (pointIdValue) {
              const parsed = parseDataUuidV2(pointIdValue);
              if (parsed) {
                const resolvedModelName = getModelNameById(parsed.modelId);
                if (resolvedModelName) {
                  console.error(`[NexsusSearch] Tier 3: Auto-resolved model_name="${resolvedModelName}" from point_id (model_id=${parsed.modelId})`);
                  (input as unknown as Record<string, unknown>).model_name = resolvedModelName;
                } else {
                  return {
                    content: [{
                      type: 'text' as const,
                      text: `# Model Resolution Failed\n\n**Error:** Could not find model_name for model_id=${parsed.modelId} extracted from point_id.\n\nPlease provide model_name explicitly or verify the point_id format.`
                    }]
                  };
                }
              } else {
                // Not a DATA UUID, might be SCHEMA or GRAPH - require model_name
                return {
                  content: [{
                    type: 'text' as const,
                    text: `# Model Name Required\n\n**Error:** point_id filter provided but could not extract model. The UUID format does not match DATA points (00000002-MMMM-...).\n\nFor SCHEMA (00000003-...) or GRAPH (00000001-...) queries, please provide model_name explicitly.`
                  }]
                };
              }
            }
          } else {
            // No point_id filter and no model_name
            return {
              content: [{
                type: 'text' as const,
                text: `# Model Name Required\n\n**Error:** model_name is required unless filtering by point_id.\n\n**Tip:** When filtering by point_id with "eq" or "in" operator, the model is auto-resolved from the UUID.`
              }]
            };
          }
        }

        // At this point, model_name is guaranteed to be defined (either provided or resolved from point_id)
        const modelName = input.model_name as string;

        // Check vector client availability
        if (!isVectorClientAvailable()) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: Vector database not available. Check QDRANT_HOST configuration.'
            }]
          };
        }

        // Initialize schema lookup if needed (for field validation)
        if (!isSchemaLookupInitialized()) {
          try {
            initializeSchemaLookup();
          } catch (err) {
            console.error('[NexsusSearch] Schema lookup initialization failed, proceeding without validation');
          }
        }

        // Validate query against schema (field existence, types, operators)
        // Note: Dot notation filters are validated separately by dot-notation-resolver
        const regularFilters = input.filters.filter(f => !f.field.includes('.'));
        const schemaValidation = validateExactQuery(
          modelName,
          regularFilters,
          input.aggregations,
          input.group_by
        );

        // Return errors if schema validation failed
        if (!schemaValidation.isValid) {
          return {
            content: [{
              type: 'text' as const,
              text: formatValidationErrors(schemaValidation.errors, schemaValidation.warnings)
            }]
          };
        }

        // Log warnings but continue
        if (schemaValidation.warnings.length > 0) {
          for (const w of schemaValidation.warnings) {
            console.error(`[NexsusSearch] Warning: ${w.message}`);
          }
        }

        // Dot Notation Resolution: Resolve partner_id.name style filters via Odoo
        let filtersToUse = input.filters;
        const dotNotationWarnings: string[] = [];

        if (hasDotNotationFilters(input.filters)) {
          console.error('[NexsusSearch] Resolving dot notation filters via Odoo...');

          const dotResolution = await resolveDotNotationFilters(
            modelName,
            input.filters
          );

          if (!dotResolution.success) {
            return {
              content: [{
                type: 'text' as const,
                text: `# Dot Notation Resolution Failed\n\n**Error:** ${dotResolution.error}\n\n---\n*Dot notation filters like "partner_id.name" require FK resolution via Odoo.*`
              }]
            };
          }

          filtersToUse = dotResolution.resolvedFilters;
          dotNotationWarnings.push(...dotResolution.warnings);

          // Log dot notation warnings
          for (const w of dotResolution.warnings) {
            console.error(`[NexsusSearch] Dot notation warning: ${w}`);
          }
        }

        // Validate filter syntax (basic operator/value checks)
        const filterValidation = validateFilters(filtersToUse);
        if (!filterValidation.isValid) {
          return {
            content: [{
              type: 'text' as const,
              text: `Filter validation failed:\n${filterValidation.errors.map(e => `- ${e}`).join('\n')}`
            }]
          };
        }

        // Validate that all filter fields have Qdrant payload indexes
        const indexValidation = validateIndexedFields(filtersToUse);
        if (!indexValidation.valid) {
          return {
            content: [{
              type: 'text' as const,
              text: indexValidation.errorMessage || 'Index validation failed'
            }]
          };
        }

        // Build Qdrant filter (returns both qdrantFilter and appFilters for date ranges)
        // Uses resolved filters if dot notation was processed
        const { qdrantFilter, appFilters } = buildQdrantFilter(modelName, filtersToUse);

        // Log if app-level filtering is being used
        if (appFilters.length > 0) {
          console.error(`[NexsusSearch] Using app-level filtering for: ${appFilters.map(f => f.field).join(', ')}`);
        }

        // Determine query type and execute
        if (input.aggregations && input.aggregations.length > 0) {
          // AGGREGATION QUERY
          let result: AggregationResult;

          // Check if GROUP BY includes linked fields (e.g., "_linked.Account_id.F1")
          if (hasLinkedGroupBy(input.group_by)) {
            // LINKED GROUP BY: Must enrich records BEFORE aggregation
            console.error(`[NexsusSearch] Linked GROUP BY detected: ${input.group_by?.filter(f => f.startsWith('_linked.')).join(', ')}`);

            // 1. Scroll all matching records first
            const scrollResult = await scrollRecords(
              qdrantFilter,
              {
                limit: undefined,  // No limit - get all records
                appFilters: appFilters.length > 0 ? appFilters : undefined
              }
            );

            console.error(`[NexsusSearch] Scrolled ${scrollResult.records.length} records for linked GROUP BY`);

            // 2. Get link dependencies from GROUP BY fields + explicit link param
            const linkDeps = extractLinkedFieldDependencies(input.group_by!);
            const combinedLinks = [...new Set([...(input.link || []), ...linkDeps])];

            // 3. Enrich with _linked data
            const preLinkResult = await resolveLinks(
              scrollResult.records,
              {
                linkFields: combinedLinks,
                returnFields: ['*'],  // Return all fields from linked records
                limit: 10000,  // High limit for GROUP BY - we need all unique targets
                modelName
              }
            );
            const enrichedRecords = enrichRecordsWithLinks(scrollResult.records, combinedLinks, preLinkResult);

            console.error(`[NexsusSearch] Enriched ${enrichedRecords.length} records with linked data from: ${combinedLinks.join(', ')}`);

            // 4. Run in-memory aggregation on enriched records
            result = executeInMemoryAggregation(
              enrichedRecords,
              input.aggregations as Aggregation[],
              input.group_by
            );
          } else {
            // STANDARD AGGREGATION: Process via Qdrant streaming (efficient for large datasets)
            // No artificial limit - trust the user, use export_to_file for large results
            result = await executeAggregation(
              qdrantFilter,
              input.aggregations as Aggregation[],
              input.group_by,
              undefined,
              appFilters.length > 0 ? appFilters : undefined
            );
          }

          // Nexsus Link: Resolve linked records for GROUP BY enrichment
          // Uses resolveGroupLinks() to extract FK IDs directly from group keys
          // This guarantees 100% resolution (no sampling limitation)
          let linkResult: LinkResolutionResult | undefined;
          if (input.link && input.link.length > 0 && result.groups && result.groups.length > 0 && input.group_by) {
            try {
              // Resolve links directly from aggregation group keys
              // This extracts ALL unique FK IDs from the GROUP BY results
              linkResult = await resolveGroupLinks(
                result.groups,
                input.group_by,
                input.link,
                modelName,
                input.link_fields ?? ['name', 'display_name']
              );
            } catch (linkError) {
              // Log but don't fail the aggregation - link is optional enrichment
              console.error(`[NexsusSearch] Link resolution failed for aggregation: ${linkError}`);
            }
          }

          // Nexsus Link JSON: Resolve JSON FK fields for GROUP BY enrichment (Bug #4 fix)
          // Works for fields like analytic_distribution that store FK IDs as JSON object keys
          let jsonFkResult: JsonFkResolutionResult | undefined;
          if (input.link_json && input.link_json.length > 0 && result.groups && result.groups.length > 0 && input.group_by) {
            try {
              // Resolve JSON FK fields from aggregation group keys
              jsonFkResult = await resolveGroupJsonFkLinks(
                result.groups,
                input.group_by,
                input.link_json,
                modelName
              );
            } catch (linkError) {
              // Log but don't fail the aggregation - link_json is optional enrichment
              console.error(`[NexsusSearch] JSON FK resolution failed for aggregation: ${linkError}`);
            }
          }

          const queryTimeMs = Date.now() - startTime;

          // Token Limitation Stage 4: Check for file export
          if (input.export_to_file) {
            // Enrich aggregation groups with linked names before export
            // This is dynamic - works for ANY FK field the user groups by and links
            console.error(`[NexsusSearch] Export: linkResult=${!!linkResult}, resolvedTargets=${linkResult?.stats.resolvedTargets ?? 0}, groups=${result.groups?.length ?? 0}, link=${JSON.stringify(input.link)}`);
            if (linkResult && linkResult.stats.resolvedTargets > 0 && result.groups && input.link) {
              let enrichedCount = 0;
              for (const group of result.groups) {
                for (const [keyField, keyValue] of Object.entries(group.key)) {
                  // Check if this is an FK field that we're linking
                  // e.g., partner_id_id -> partner_id, account_id_id -> account_id
                  const baseField = keyField.replace(/_id$/, '');
                  if (input.link.includes(baseField) && typeof keyValue === 'number') {
                    const displayName = getLinkedDisplayName(baseField, keyValue, linkResult);
                    if (displayName) {
                      // Add the name as a new column (e.g., partner_id_name, account_id_name)
                      group.key[`${baseField}_name`] = displayName;
                      enrichedCount++;
                    }
                  }
                }
              }
              console.error(`[NexsusSearch] Export enrichment: added ${enrichedCount} name columns`);
            } else {
              console.error(`[NexsusSearch] Export enrichment skipped - conditions not met`);
            }

            const filtersForDisplay = formatFiltersForDisplay(input.filters as FilterCondition[]);
            const exportResult = await exportAggregationToExcel(result, {
              model_name: modelName,
              filters_summary: filtersForDisplay.join('; '),
              query_time_ms: queryTimeMs,
              aggregations: input.aggregations || [],
              group_by: input.group_by,
            });

            // Log export query (async, fire-and-forget)
            logQueryAsync({
              tool: 'nexsus_search',
              model_name: modelName,
              filter_count: input.filters.length,
              filters_summary: summarizeFilters(input.filters as Array<{field: string; op: string; value: unknown}>),
              has_aggregation: true,
              aggregation_ops: input.aggregations?.map(a => a.op),
              group_by: input.group_by,
              result_count: result.totalRecords,
              latency_ms: queryTimeMs + exportResult.export_time_ms,
              success: exportResult.success,
            });

            return { content: [{ type: 'text' as const, text: formatExportResponse(exportResult) }] };
          }

          // Auto-Export: Check if results exceed token threshold
          if (AUTO_EXPORT_CONFIG.ENABLED && !input.export_to_file) {
            const exportable: ExportableResult = {
              type: 'aggregation',
              data: result,
              metadata: {
                model_name: modelName,
                query_time_ms: queryTimeMs,
                tool_name: 'nexsus_search',
                filters_summary: formatFiltersForDisplay(input.filters as FilterCondition[]).join('; '),
              },
            };

            const orchestratorResult = await orchestrateExport(exportable, undefined);

            if (orchestratorResult.exported && orchestratorResult.exportResult) {
              // Log auto-export query
              logQueryAsync({
                tool: 'nexsus_search',
                model_name: modelName,
                filter_count: input.filters.length,
                filters_summary: summarizeFilters(input.filters as Array<{field: string; op: string; value: unknown}>),
                has_aggregation: true,
                aggregation_ops: input.aggregations?.map(a => a.op),
                group_by: input.group_by,
                result_count: result.totalRecords,
                latency_ms: queryTimeMs + (orchestratorResult.exportResult.export_time_ms || 0),
                success: orchestratorResult.exportResult.success,
              });

              return { content: [{ type: 'text' as const, text: formatOrchestratorResponse(orchestratorResult) }] };
            }
          }

          // Token Limitation Stage 2: Route based on detail_level
          const detailLevel = input.detail_level ?? 'full';
          let output: string;

          switch (detailLevel) {
            case 'summary':
              output = await formatSummaryResult(input, result, linkResult, jsonFkResult, queryTimeMs);
              break;
            case 'top_n':
              output = await formatTopNResult(input, result, linkResult, jsonFkResult, queryTimeMs, input.top_n ?? 10);
              break;
            case 'full':
            default:
              output = await formatAggregationResult(input, result, linkResult, jsonFkResult, queryTimeMs);
              break;
          }

          // Log aggregation query (async, fire-and-forget)
          logQueryAsync({
            tool: 'nexsus_search',
            model_name: modelName,
            filter_count: input.filters.length,
            filters_summary: summarizeFilters(input.filters as Array<{field: string; op: string; value: unknown}>),
            has_aggregation: true,
            aggregation_ops: input.aggregations?.map(a => a.op),
            group_by: input.group_by,
            result_count: result.totalRecords,
            nexsus_link: !!(input.link && input.link.length > 0),
            dot_notation: hasDotNotationFilters(input.filters as FilterCondition[]),
            latency_ms: queryTimeMs,
            success: true,
          });

          return { content: [{ type: 'text' as const, text: output }] };

        } else {
          // RECORD RETRIEVAL QUERY
          // No artificial limits - return ALL matching records
          // For large datasets, user should use export_to_file=true
          const result = await scrollRecords(qdrantFilter, {
            fields: input.fields,
            limit: input.limit,  // User-specified or undefined (=all)
            offset: input.offset,
            maxRecords: undefined,  // No artificial cap - trust the user
            appFilters: appFilters.length > 0 ? appFilters : undefined
          });

          // Nexsus Link: Resolve linked records if specified
          // No artificial limit - resolve ALL FK targets for complete data
          let linkResult: LinkResolutionResult | undefined;
          if (input.link && input.link.length > 0 && result.records.length > 0) {
            linkResult = await resolveLinks(result.records, {
              linkFields: input.link,
              returnFields: input.link_fields ?? ['name', 'display_name'],
              limit: Number.MAX_SAFE_INTEGER,  // Effectively unlimited
              modelName: modelName,
            });
          }

          // Nexsus Link JSON: Resolve JSON FK fields (e.g., analytic_distribution)
          // No artificial limit - resolve ALL JSON FK targets for complete data
          let jsonFkResult: JsonFkResolutionResult | undefined;
          if (input.link_json && input.link_json.length > 0 && result.records.length > 0) {
            jsonFkResult = await resolveJsonFkLinks(result.records, {
              jsonFkFields: input.link_json,
              modelName: modelName,
              limit: Number.MAX_SAFE_INTEGER,  // Effectively unlimited
            });

            // Enrich records with resolved JSON FK data
            if (jsonFkResult.stats.resolved > 0) {
              result.records = enrichRecordsWithJsonFkLinks(
                result.records,
                input.link_json,
                jsonFkResult
              );
            }
          }

          // Data Grid Enrichment (Phase 5): Add graph context, validation, similar records
          const enrichment: DataGridEnrichment = {
            include_graph_context: input.include_graph_context,
            include_validation_status: input.include_validation_status,
            include_similar: input.include_similar,
            similar_limit: input.similar_limit,
          };

          let enrichedRecords: EnrichedRecord[] | undefined;
          let enrichmentTiming: { search_ms: number; graph_enrichment_ms: number; validation_enrichment_ms: number; similarity_enrichment_ms: number } | undefined;

          if (hasEnrichment(enrichment) && result.records.length > 0) {
            const modelId = getModelIdByName(modelName);
            if (modelId) {
              // Prepare records for enrichment (extract point_id from payload)
              const recordsToEnrich = result.records.map(r => ({
                record: r as Record<string, unknown>,
                pointId: (r as Record<string, unknown>).point_id as string || '',
                score: undefined,
              }));

              const enrichResult = await enrichRecords(
                recordsToEnrich,
                modelName,
                modelId,
                enrichment
              );

              enrichedRecords = enrichResult.records;
              enrichmentTiming = enrichResult.timing;
              console.error(`[NexsusSearch] Enriched ${enrichedRecords.length} records`);
            } else {
              console.error(`[NexsusSearch] Cannot enrich: model_id not found for ${modelName}`);
            }
          }

          const queryTimeMs = Date.now() - startTime;

          // Token Limitation Stage 4: Check for file export
          if (input.export_to_file) {
            const filtersForDisplay = formatFiltersForDisplay(input.filters as FilterCondition[]);
            const exportResult = await exportRecordsToExcel(result, {
              model_name: modelName,
              filters_summary: filtersForDisplay.join('; '),
              query_time_ms: queryTimeMs,
              fields: input.fields,
            });

            // Log export query (async, fire-and-forget)
            logQueryAsync({
              tool: 'nexsus_search',
              model_name: modelName,
              filter_count: input.filters.length,
              filters_summary: summarizeFilters(input.filters as Array<{field: string; op: string; value: unknown}>),
              has_aggregation: false,
              result_count: result.records.length,
              latency_ms: queryTimeMs + exportResult.export_time_ms,
              success: exportResult.success,
            });

            return { content: [{ type: 'text' as const, text: formatExportResponse(exportResult) }] };
          }

          // Auto-Export: Check if results exceed token threshold
          if (AUTO_EXPORT_CONFIG.ENABLED && !input.export_to_file) {
            const exportable: ExportableResult = {
              type: 'records',
              data: result,
              metadata: {
                model_name: modelName,
                query_time_ms: queryTimeMs,
                tool_name: 'nexsus_search',
                filters_summary: formatFiltersForDisplay(input.filters as FilterCondition[]).join('; '),
              },
            };

            const orchestratorResult = await orchestrateExport(exportable, undefined);

            if (orchestratorResult.exported && orchestratorResult.exportResult) {
              // Log auto-export query
              logQueryAsync({
                tool: 'nexsus_search',
                model_name: modelName,
                filter_count: input.filters.length,
                filters_summary: summarizeFilters(input.filters as Array<{field: string; op: string; value: unknown}>),
                has_aggregation: false,
                result_count: result.records.length,
                latency_ms: queryTimeMs + (orchestratorResult.exportResult.export_time_ms || 0),
                success: orchestratorResult.exportResult.success,
              });

              return { content: [{ type: 'text' as const, text: formatOrchestratorResponse(orchestratorResult) }] };
            }
          }

          const output = enrichedRecords
            ? await formatEnrichedRecordResult(input, result, enrichedRecords, linkResult, queryTimeMs, enrichmentTiming)
            : await formatRecordResult(input, result, linkResult, queryTimeMs);

          // Log record retrieval query (async, fire-and-forget)
          logQueryAsync({
            tool: 'nexsus_search',
            model_name: modelName,
            filter_count: input.filters.length,
            filters_summary: summarizeFilters(input.filters as Array<{field: string; op: string; value: unknown}>),
            has_aggregation: false,
            result_count: result.records.length,
            nexsus_link: !!(input.link && input.link.length > 0),
            nexsus_link_json: !!(input.link_json && input.link_json.length > 0),
            dot_notation: hasDotNotationFilters(input.filters as FilterCondition[]),
            latency_ms: queryTimeMs,
            success: true,
          });

          return { content: [{ type: 'text' as const, text: output }] };
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : '';

        // Log detailed error info to stderr for debugging
        console.error('[NexsusSearch] Error:', errorMsg);
        console.error('[NexsusSearch] Input args:', JSON.stringify(args, null, 2));
        if (errorStack) {
          console.error('[NexsusSearch] Stack:', errorStack);
        }

        // Log error for analytics (async, fire-and-forget)
        logQueryAsync({
          tool: 'nexsus_search',
          latency_ms: Date.now() - startTime,
          result_count: 0,
          success: false,
          error: errorMsg,
        });

        // Return user-friendly error with debugging hints
        return {
          content: [{
            type: 'text' as const,
            text: `Query failed: ${errorMsg}

**Input received:**
\`\`\`json
${JSON.stringify(args, null, 2)}
\`\`\`

**Tips:**
- Check that field names match payload structure (e.g., "account_id_id" not "account_id")
- Use "eq" for exact matches, "gte"/"lte" for date ranges
- Ensure values are correct type (numbers for IDs, strings for dates)
- The "contains" operator requires a TEXT index on the field (may fail on keyword-indexed fields)`
          }]
        };
      }
    }
  );

  console.error('[NexsusSearch] Registered nexsus_search tool');
}

// =============================================================================
// RESULT FORMATTING
// =============================================================================

/**
 * Format relationship info from Knowledge Graph
 */
async function formatRelationshipSection(modelName: string): Promise<string[]> {
  const lines: string[] = [];

  try {
    const graphContext = await getGraphContext(modelName);

    if (graphContext.totalEdges === 0) {
      lines.push('');
      lines.push('## Knowledge Graph Relationships');
      lines.push('*No relationships found in Knowledge Graph. Run pipeline_sync to populate.*');
      return lines;
    }

    lines.push('');
    lines.push('## Knowledge Graph Relationships');
    lines.push('');

    // Outgoing relationships (FKs from this model)
    if (graphContext.outgoing.length > 0) {
      lines.push(`**Outgoing FK Fields:** (${graphContext.outgoing.length})`);
      const topOutgoing = graphContext.outgoing
        .sort((a, b) => (b.edge_count || 0) - (a.edge_count || 0))
        .slice(0, 8);

      for (const rel of topOutgoing) {
        const edgeInfo = rel.edge_count ? ` (${rel.edge_count.toLocaleString()} edges)` : '';
        lines.push(`- ${rel.field_name} → ${rel.target_model}${edgeInfo}`);
      }
      if (graphContext.outgoing.length > 8) {
        lines.push(`- *...and ${graphContext.outgoing.length - 8} more*`);
      }
      lines.push('');
    }

    // Incoming relationships (other models referencing this one)
    if (graphContext.incoming.length > 0) {
      lines.push(`**Incoming References:** (${graphContext.incoming.length} models reference this)`);
      const topIncoming = graphContext.incoming
        .sort((a, b) => (b.edge_count || 0) - (a.edge_count || 0))
        .slice(0, 5);

      for (const rel of topIncoming) {
        const edgeInfo = rel.edge_count ? ` (${rel.edge_count.toLocaleString()} edges)` : '';
        lines.push(`- ${rel.target_model}.${rel.field_name}${edgeInfo}`);
      }
      if (graphContext.incoming.length > 5) {
        lines.push(`- *...and ${graphContext.incoming.length - 5} more*`);
      }
      lines.push('');
    }

    // Suggested explorations
    lines.push('**Suggested Explorations:**');
    if (graphContext.outgoing.length > 0) {
      const suggestedFk = graphContext.outgoing[0];
      lines.push(`- Add \`group_by: ["${suggestedFk.field_name}_id"]\` to group by ${suggestedFk.target_model}`);
    }
    if (graphContext.incoming.length > 0) {
      const suggestedIncoming = graphContext.incoming[0];
      lines.push(`- Query ${suggestedIncoming.target_model} with filter on this model's records`);
    }

  } catch (error) {
    console.error(`[NexsusSearch] Failed to get graph context: ${error}`);
    lines.push('');
    lines.push('## Knowledge Graph Relationships');
    lines.push('*Unable to load relationships. Check Knowledge Graph status.*');
  }

  return lines;
}

/**
 * Format aggregation results for display
 */
async function formatAggregationResult(
  query: NexsusSearchInput,
  result: AggregationResult,
  linkResult: LinkResolutionResult | undefined,
  jsonFkResult: JsonFkResolutionResult | undefined,
  queryTimeMs: number
): Promise<string> {
  const lines: string[] = [];

  // Header
  lines.push('# Nexsus Search Result');
  lines.push('');
  lines.push(`**Model:** ${query.model_name!}`);
  lines.push(`**Records Processed:** ${result.totalRecords.toLocaleString()}`);
  lines.push(`**Query Time:** ${queryTimeMs}ms`);

  // Nexsus Link info
  if (linkResult && linkResult.stats.resolvedTargets > 0) {
    lines.push(`**Nexsus Link:** ${linkResult.stats.resolvedTargets} linked records resolved`);
  }

  // Nexsus Link JSON info
  if (jsonFkResult && jsonFkResult.stats.resolved > 0) {
    lines.push(`**Nexsus Link JSON:** ${jsonFkResult.stats.resolved} JSON FK targets resolved`);
  }

  // Truncation warning
  if (result.truncated) {
    lines.push('');
    lines.push('> **Warning:** Results truncated due to safety limit (100,000 records).');
  }

  // Relationships section
  if (query.show_relationships) {
    const relSection = await formatRelationshipSection(query.model_name!);
    lines.push(...relSection);
  }

  // Filters section
  lines.push('');
  lines.push('## Filters Applied');
  const filterDisplay = formatFiltersForDisplay(query.filters);
  for (const f of filterDisplay) {
    lines.push(`- ${f}`);
  }

  // Results section
  lines.push('');
  lines.push('## Aggregation Results');
  lines.push('');

  if (result.groups && result.groups.length > 0) {
    // Grouped results - format as table
    const groupByFields = query.group_by || [];
    const aggAliases = Object.keys(result.groups[0].values);

    // Table header
    const headerCells = [...groupByFields, ...aggAliases];
    lines.push(`| ${headerCells.join(' | ')} |`);
    lines.push(`|${groupByFields.map(() => '---').join('|')}|${aggAliases.map(() => '---:').join('|')}|`);

    // Table rows
    for (const group of result.groups) {
      const keyCells = groupByFields.map(f => {
        const value = group.key[f];

        // Nexsus Link: Try to get display name for FK fields
        if (linkResult && query.link && typeof value === 'number') {
          const baseField = f.replace(/_id$/, ''); // partner_id_id -> partner_id
          if (query.link.includes(baseField)) {
            const displayName = getLinkedDisplayName(baseField, value, linkResult);
            if (displayName) return displayName;
          }
        }

        // Nexsus Link JSON: Try to format JSON FK fields with resolved names (Bug #4 fix)
        if (jsonFkResult && query.link_json && query.link_json.includes(f)) {
          if (typeof value === 'object' || (typeof value === 'string' && value.startsWith('{'))) {
            const formatted = formatGroupJsonFkDisplay(f, value as Record<string, unknown> | string, jsonFkResult);
            return formatted;
          }
        }

        // Handle objects (JSON fields) by stringifying for display (Bug #1 complete fix)
        // Without this, objects display as [object Object]
        if (typeof value === 'object' && value !== null) {
          return JSON.stringify(value);
        }

        return String(value ?? 'null');
      });
      const valueCells = aggAliases.map(alias => {
        const value = group.values[alias];
        return formatNumber(value);
      });
      lines.push(`| ${keyCells.join(' | ')} | ${valueCells.join(' | ')} |`);
    }

    lines.push('');
    lines.push(`*${result.groups.length} groups*`);

  } else {
    // Single aggregation result
    for (const [alias, value] of Object.entries(result.results)) {
      lines.push(`- **${alias}:** ${formatNumber(value)}`);
    }
  }

  // Reconciliation checksum (Token Limitation Stage 3)
  if (result.reconciliation) {
    lines.push('');
    lines.push('## Reconciliation');
    lines.push(`**Hash:** ${result.reconciliation.hash}`);
    lines.push(`**Total:** ${formatNumber(result.reconciliation.grand_total)} (${result.reconciliation.aggregation_field})`);
    lines.push(`**Records:** ${result.reconciliation.record_count.toLocaleString()}`);
  }

  // Footer
  lines.push('');
  lines.push('---');
  lines.push('*Results based on synced data. For audit-grade accuracy, verify with Odoo.*');

  return lines.join('\n');
}

/**
 * Format aggregation results in SUMMARY mode (~400 tokens)
 *
 * Shows only grand total and basic metrics without group breakdown.
 * Use when token budget is limited or for quick overview.
 *
 * Token Limitation - Stage 2
 */
async function formatSummaryResult(
  query: NexsusSearchInput,
  result: AggregationResult,
  linkResult: LinkResolutionResult | undefined,
  jsonFkResult: JsonFkResolutionResult | undefined,
  queryTimeMs: number
): Promise<string> {
  const lines: string[] = [];

  // Header (compact)
  lines.push('# Nexsus Search Result (Summary)');
  lines.push('');
  lines.push(`**Model:** ${query.model_name!}`);
  lines.push(`**Records Processed:** ${result.totalRecords.toLocaleString()}`);
  lines.push(`**Query Time:** ${queryTimeMs}ms`);

  // Truncation warning
  if (result.truncated) {
    lines.push('');
    lines.push('> **Warning:** Results truncated due to safety limit (100,000 records).');
  }

  // Filters (compact - first 3 only)
  lines.push('');
  lines.push('## Filters');
  const filterDisplay = formatFiltersForDisplay(query.filters);
  const displayFilters = filterDisplay.slice(0, 3);
  for (const f of displayFilters) {
    lines.push(`- ${f}`);
  }
  if (filterDisplay.length > 3) {
    lines.push(`- *... and ${filterDisplay.length - 3} more filters*`);
  }

  // Grand Total section
  lines.push('');
  lines.push('## Summary');

  if (result.groups && result.groups.length > 0) {
    // Calculate grand totals from groups
    const aggAliases = Object.keys(result.groups[0].values);
    const grandTotals: Record<string, number> = {};

    for (const alias of aggAliases) {
      grandTotals[alias] = result.groups.reduce((sum, group) => {
        const value = group.values[alias];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
    }

    lines.push(`**Groups Found:** ${result.groups.length.toLocaleString()}`);
    lines.push('');
    lines.push('**Grand Totals:**');
    for (const [alias, total] of Object.entries(grandTotals)) {
      lines.push(`- ${alias}: **${formatNumber(total)}**`);
    }

  } else {
    // Simple aggregation (no groups)
    for (const [alias, value] of Object.entries(result.results)) {
      lines.push(`- ${alias}: **${formatNumber(value)}**`);
    }
  }

  // Reconciliation checksum (Token Limitation Stage 3) - compact for summary mode
  if (result.reconciliation) {
    lines.push('');
    lines.push(`**Checksum:** ${result.reconciliation.hash} (${result.reconciliation.record_count.toLocaleString()} records)`);
  }

  // Footer with hint
  lines.push('');
  lines.push('---');
  lines.push('*Summary mode. Use `detail_level: "top_n"` for top groups or `"full"` for all data.*');

  return lines.join('\n');
}

/**
 * Format aggregation results in TOP_N mode (~800 tokens)
 *
 * Shows top N groups sorted by first aggregation field (descending),
 * with percentages and a "remaining" summary.
 *
 * Token Limitation - Stage 2
 */
async function formatTopNResult(
  query: NexsusSearchInput,
  result: AggregationResult,
  linkResult: LinkResolutionResult | undefined,
  jsonFkResult: JsonFkResolutionResult | undefined,
  queryTimeMs: number,
  topN: number
): Promise<string> {
  const lines: string[] = [];

  // Header
  lines.push('# Nexsus Search Result (Top ' + topN + ')');
  lines.push('');
  lines.push(`**Model:** ${query.model_name!}`);
  lines.push(`**Records Processed:** ${result.totalRecords.toLocaleString()}`);
  lines.push(`**Query Time:** ${queryTimeMs}ms`);

  // Nexsus Link info
  if (linkResult && linkResult.stats.resolvedTargets > 0) {
    lines.push(`**Nexsus Link:** ${linkResult.stats.resolvedTargets} linked records resolved`);
  }

  // Nexsus Link JSON info
  if (jsonFkResult && jsonFkResult.stats.resolved > 0) {
    lines.push(`**Nexsus Link JSON:** ${jsonFkResult.stats.resolved} JSON FK targets resolved`);
  }

  // Truncation warning
  if (result.truncated) {
    lines.push('');
    lines.push('> **Warning:** Results truncated due to safety limit (100,000 records).');
  }

  // Filters (compact - first 3 only)
  lines.push('');
  lines.push('## Filters');
  const filterDisplay = formatFiltersForDisplay(query.filters);
  const displayFilters = filterDisplay.slice(0, 3);
  for (const f of displayFilters) {
    lines.push(`- ${f}`);
  }
  if (filterDisplay.length > 3) {
    lines.push(`- *... and ${filterDisplay.length - 3} more filters*`);
  }

  // Results section
  lines.push('');
  lines.push('## Top ' + topN + ' Results');
  lines.push('');

  if (result.groups && result.groups.length > 0) {
    const groupByFields = query.group_by || [];
    const aggAliases = Object.keys(result.groups[0].values);
    const primaryAggAlias = aggAliases[0]; // Sort by first aggregation

    // Calculate grand total for percentages
    const grandTotal = result.groups.reduce((sum, group) => {
      const value = group.values[primaryAggAlias];
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);

    // Sort groups by primary aggregation (descending)
    const sortedGroups = [...result.groups].sort((a, b) => {
      const aVal = typeof a.values[primaryAggAlias] === 'number' ? a.values[primaryAggAlias] : 0;
      const bVal = typeof b.values[primaryAggAlias] === 'number' ? b.values[primaryAggAlias] : 0;
      return bVal - aVal;
    });

    // Take top N
    const topGroups = sortedGroups.slice(0, topN);
    const remainingGroups = sortedGroups.slice(topN);

    // Table header with % column
    const headerCells = [...groupByFields, ...aggAliases, '% of Total'];
    lines.push(`| ${headerCells.join(' | ')} |`);
    lines.push(`|${groupByFields.map(() => '---').join('|')}|${aggAliases.map(() => '---:').join('|')}|---:|`);

    // Table rows for top N
    for (const group of topGroups) {
      const keyCells = groupByFields.map(f => {
        const value = group.key[f];

        // Nexsus Link: Try to get display name for FK fields
        if (linkResult && query.link && typeof value === 'number') {
          const baseField = f.replace(/_id$/, '');
          if (query.link.includes(baseField)) {
            const displayName = getLinkedDisplayName(baseField, value, linkResult);
            if (displayName) return displayName;
          }
        }

        // Nexsus Link JSON: Try to format JSON FK fields with resolved names (Bug #4 fix)
        if (jsonFkResult && query.link_json && query.link_json.includes(f)) {
          if (typeof value === 'object' || (typeof value === 'string' && value.startsWith('{'))) {
            const formatted = formatGroupJsonFkDisplay(f, value as Record<string, unknown> | string, jsonFkResult);
            return formatted;
          }
        }

        // Handle objects (JSON fields) by stringifying for display (Bug #1 complete fix)
        // Without this, objects display as [object Object]
        if (typeof value === 'object' && value !== null) {
          return JSON.stringify(value);
        }

        return String(value ?? 'null');
      });

      const valueCells = aggAliases.map(alias => {
        const value = group.values[alias];
        return formatNumber(value);
      });

      // Calculate percentage
      const primaryValue = typeof group.values[primaryAggAlias] === 'number' ? group.values[primaryAggAlias] : 0;
      const percentage = grandTotal > 0 ? ((primaryValue / grandTotal) * 100).toFixed(1) : '0.0';

      lines.push(`| ${keyCells.join(' | ')} | ${valueCells.join(' | ')} | ${percentage}% |`);
    }

    // Remaining groups summary
    if (remainingGroups.length > 0) {
      const remainingTotal = remainingGroups.reduce((sum, group) => {
        const value = group.values[primaryAggAlias];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
      const remainingPercent = grandTotal > 0 ? ((remainingTotal / grandTotal) * 100).toFixed(1) : '0.0';

      lines.push('');
      lines.push(`*+ ${remainingGroups.length.toLocaleString()} more groups (${remainingPercent}% of total)*`);
    }

    // Grand total
    lines.push('');
    lines.push('**Grand Total:**');
    for (const alias of aggAliases) {
      const total = result.groups.reduce((sum, group) => {
        const value = group.values[alias];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
      lines.push(`- ${alias}: **${formatNumber(total)}**`);
    }

  } else {
    // Simple aggregation (no groups) - just show the result
    for (const [alias, value] of Object.entries(result.results)) {
      lines.push(`- **${alias}:** ${formatNumber(value)}`);
    }
    lines.push('');
    lines.push('*No groups to show - this is a simple aggregation.*');
  }

  // Reconciliation checksum (Token Limitation Stage 3)
  if (result.reconciliation) {
    lines.push('');
    lines.push(`**Checksum:** ${result.reconciliation.hash}`);
  }

  // Footer with hint
  lines.push('');
  lines.push('---');
  lines.push(`*Showing top ${topN} of ${result.groups?.length.toLocaleString() ?? '0'} groups. Use \`detail_level: "full"\` to see all.*`);

  return lines.join('\n');
}

/**
 * Format record retrieval results for display
 */
async function formatRecordResult(
  query: NexsusSearchInput,
  result: ScrollResult,
  linkResult: LinkResolutionResult | undefined,
  queryTimeMs: number
): Promise<string> {
  const lines: string[] = [];

  // Header
  lines.push('# Nexsus Search Result');
  lines.push('');
  lines.push(`**Model:** ${query.model_name!}`);
  lines.push(`**Records Returned:** ${result.records.length.toLocaleString()}`);
  lines.push(`**Total Scanned:** ${result.totalScanned.toLocaleString()}`);
  lines.push(`**Query Time:** ${queryTimeMs}ms`);

  // Nexsus Link info
  if (linkResult && linkResult.stats.resolvedTargets > 0) {
    lines.push(`**Nexsus Link:** ${linkResult.stats.resolvedTargets} linked records resolved`);
  }

  // Pagination hint
  if (result.hasMore) {
    lines.push('');
    lines.push('> More records available. Use `limit` and `offset` for pagination.');
  }

  // Relationships section
  if (query.show_relationships) {
    const relSection = await formatRelationshipSection(query.model_name!);
    lines.push(...relSection);
  }

  // Filters section
  lines.push('');
  lines.push('## Filters Applied');
  const filterDisplay = formatFiltersForDisplay(query.filters);
  for (const f of filterDisplay) {
    lines.push(`- ${f}`);
  }

  // Nexsus Link warnings
  if (linkResult && linkResult.invalidFields.length > 0) {
    lines.push('');
    lines.push('> **Nexsus Link Warning:** Invalid link fields: ' + linkResult.invalidFields.join(', '));
  }

  // Records section
  lines.push('');
  lines.push('## Records');
  lines.push('');

  if (result.records.length === 0) {
    lines.push('*No records found matching filters.*');
  } else {
    // Return ALL records - no artificial display truncation
    // For large results, user should use export_to_file=true
    let displayRecords = result.records;
    if (linkResult && query.link && query.link.length > 0) {
      displayRecords = enrichRecordsWithLinks(displayRecords, query.link, linkResult);
    }

    lines.push('```json');
    lines.push(JSON.stringify(displayRecords, null, 2));
    lines.push('```');

    // Inform user about total count and export option for large results
    if (result.records.length > 100) {
      lines.push('');
      lines.push(`*${result.records.length.toLocaleString()} records returned. For large datasets, use \`export_to_file: true\` for Excel export.*`);
    }
  }

  return lines.join('\n');
}

/**
 * Format enriched record results with Data Grid intelligence layers (Phase 5)
 */
async function formatEnrichedRecordResult(
  query: NexsusSearchInput,
  result: ScrollResult,
  enrichedRecords: EnrichedRecord[],
  linkResult: LinkResolutionResult | undefined,
  queryTimeMs: number,
  timing?: { search_ms: number; graph_enrichment_ms: number; validation_enrichment_ms: number; similarity_enrichment_ms: number }
): Promise<string> {
  const lines: string[] = [];

  // Header
  lines.push('# Nexsus Search Result (Enriched)');
  lines.push('');
  lines.push(`**Model:** ${query.model_name!}`);
  lines.push(`**Records Returned:** ${enrichedRecords.length.toLocaleString()}`);
  lines.push(`**Total Scanned:** ${result.totalScanned.toLocaleString()}`);
  lines.push(`**Query Time:** ${queryTimeMs}ms`);

  // Intelligence layers used
  const layers: string[] = [];
  if (query.include_graph_context) layers.push('Graph Context');
  if (query.include_validation_status) layers.push('Validation Status');
  if (query.include_similar) layers.push('Similar Records');
  if (layers.length > 0) {
    lines.push(`**Intelligence Layers:** ${layers.join(', ')}`);
  }

  // Timing breakdown
  if (timing) {
    const timingParts: string[] = [];
    if (timing.graph_enrichment_ms > 0) timingParts.push(`Graph: ${timing.graph_enrichment_ms}ms`);
    if (timing.validation_enrichment_ms > 0) timingParts.push(`Validation: ${timing.validation_enrichment_ms}ms`);
    if (timing.similarity_enrichment_ms > 0) timingParts.push(`Similarity: ${timing.similarity_enrichment_ms}ms`);
    if (timingParts.length > 0) {
      lines.push(`**Enrichment Time:** ${timingParts.join(', ')}`);
    }
  }

  // Nexsus Link info
  if (linkResult && linkResult.stats.resolvedTargets > 0) {
    lines.push(`**Nexsus Link:** ${linkResult.stats.resolvedTargets} linked records resolved`);
  }

  // Pagination hint
  if (result.hasMore) {
    lines.push('');
    lines.push('> More records available. Use `limit` and `offset` for pagination.');
  }

  // Note about enrichment for large datasets
  if (result.records.length > 100) {
    lines.push('');
    lines.push(`> **Note:** ${result.records.length.toLocaleString()} records enriched. Use \`export_to_file: true\` for Excel export of large datasets.`);
  }

  // Relationships section
  if (query.show_relationships) {
    const relSection = await formatRelationshipSection(query.model_name!);
    lines.push(...relSection);
  }

  // Filters section
  lines.push('');
  lines.push('## Filters Applied');
  const filterDisplay = formatFiltersForDisplay(query.filters);
  for (const f of filterDisplay) {
    lines.push(`- ${f}`);
  }

  // Records section with enrichment
  lines.push('');
  lines.push('## Enriched Records');
  lines.push('');

  if (enrichedRecords.length === 0) {
    lines.push('*No records found matching filters.*');
  } else {
    // Show ALL enriched records - no artificial truncation
    const displayRecords = enrichedRecords;

    for (let i = 0; i < displayRecords.length; i++) {
      const enriched = displayRecords[i];
      const recordId = (enriched.record as Record<string, unknown>).record_id;
      const recordName = (enriched.record as Record<string, unknown>).name ||
                         (enriched.record as Record<string, unknown>).display_name ||
                         `Record #${recordId}`;

      lines.push(`### ${i + 1}. ${recordName}`);
      lines.push('');

      // Core record data (compact view)
      lines.push('**Record Data:**');
      lines.push('```json');
      // Show only key fields, not the full record
      const compactRecord: Record<string, unknown> = {
        record_id: recordId,
        name: (enriched.record as Record<string, unknown>).name,
      };
      // Add a few more relevant fields if they exist
      for (const key of ['date', 'state', 'partner_id_id', 'amount_total', 'balance']) {
        if ((enriched.record as Record<string, unknown>)[key] !== undefined) {
          compactRecord[key] = (enriched.record as Record<string, unknown>)[key];
        }
      }
      lines.push(JSON.stringify(compactRecord, null, 2));
      lines.push('```');

      // Graph context
      if (enriched.graph_context) {
        const gc = enriched.graph_context;
        lines.push('');
        lines.push(`**Graph Context:** ${gc.total_connections} connections`);
        if (gc.outgoing_fks.length > 0) {
          const fkSummary = gc.outgoing_fks
            .slice(0, 3)
            .map(fk => `${fk.field_name}→${fk.target_model}`)
            .join(', ');
          lines.push(`- Outgoing FKs: ${fkSummary}${gc.outgoing_fks.length > 3 ? ` (+${gc.outgoing_fks.length - 3} more)` : ''}`);
        }
        if (gc.incoming_reference_count > 0) {
          lines.push(`- Incoming refs: ${gc.incoming_reference_count} from ${gc.referencing_models.slice(0, 3).join(', ')}${gc.referencing_models.length > 3 ? '...' : ''}`);
        }
      }

      // Validation status
      if (enriched.validation_status) {
        const vs = enriched.validation_status;
        lines.push('');

        // Check for diagnostic message first (indicates incomplete/error validation)
        if (vs.diagnostic) {
          lines.push(`**Validation Status:** ℹ️ ${vs.diagnostic}`);
        } else {
          const status = vs.has_orphan_fks ? '⚠️ Orphan FKs detected' : '✅ All FKs valid';
          lines.push(`**Validation Status:** ${status} (integrity: ${vs.integrity_score}%)`);
          if (vs.orphan_fk_fields.length > 0) {
            lines.push(`- Orphan fields: ${vs.orphan_fk_fields.join(', ')}`);
          }
        }
      }

      // Similar records
      if (enriched.similar_records && enriched.similar_records.length > 0) {
        lines.push('');
        lines.push(`**Similar Records:** (${enriched.similar_records.length} found)`);
        for (const sim of enriched.similar_records.slice(0, 3)) {
          const simName = sim.name || `#${sim.record_id}`;
          lines.push(`- ${simName} (${(sim.similarity_score * 100).toFixed(0)}% similar)`);
        }
      }

      lines.push('');
      lines.push('---');
    }

    // For large enriched result sets, suggest export
    if (enrichedRecords.length > 100) {
      lines.push('');
      lines.push(`*${enrichedRecords.length.toLocaleString()} enriched records. Use \`export_to_file: true\` for Excel export.*`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a number for display (with commas and 2 decimal places for decimals)
 */
function formatNumber(value: number): string {
  // Check if it's a whole number
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }

  // Format with 2 decimal places for decimals
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}
