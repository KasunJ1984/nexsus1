/**
 * Zod validation schemas for MCP tools
 *
 * Redesigned for comprehensive Odoo schema search.
 * Phase 1: ONE tool - semantic_search for schema discovery
 */

import { z } from 'zod';

// =============================================================================
// SEMANTIC SEARCH SCHEMA
// =============================================================================

/**
 * Schema for semantic_search tool input
 *
 * Searches Odoo schema (17,930 fields) semantically to find:
 * - Where data is stored
 * - Field relationships
 * - Data types and locations
 */
export const SemanticSearchSchema = z.object({
  /**
   * Natural language query to search for fields
   * Examples:
   * - "Where is customer email stored?"
   * - "Fields related to revenue"
   * - "crm.lead date fields"
   * - "How is salesperson connected to leads?"
   */
  query: z
    .string()
    .min(1, 'Query must be at least 1 character')
    .max(500, 'Query must be at most 500 characters')
    .describe('Natural language query to search Odoo schema'),

  /**
   * Search mode determines how the query is processed:
   * - semantic: Natural language vector search (default)
   * - list: Get ALL fields in a model (filter-only, no vector similarity)
   * - references_out: Find fields that POINT TO a model (outgoing FKs)
   * - references_in: Find fields that are POINTED AT by other models (incoming FKs)
   */
  search_mode: z
    .enum(['semantic', 'list', 'references_out', 'references_in'])
    .default('semantic')
    .describe('Search mode: semantic=vector search, list=all fields in model, references_out=outgoing FKs, references_in=incoming FKs'),

  /**
   * Maximum number of results to return
   * Use 0 for unlimited (up to 10,000 results)
   */
  limit: z
    .number()
    .int()
    .min(0)
    .max(200)
    .default(25)
    .describe('Maximum results (0=unlimited up to 10000, 1-200 for specific limit, default: 25)'),

  /**
   * Minimum similarity score (0-1) - only used in semantic mode
   */
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.45)
    .describe('Minimum similarity score for semantic mode (0-1, default: 0.45)'),

  /**
   * Filter by model name (e.g., "crm.lead")
   * Required for list, references_out, and references_in modes
   */
  model_filter: z
    .string()
    .optional()
    .describe('Filter results to specific model (e.g., "crm.lead"). Required for list/references modes.'),

  /**
   * Filter by field type (e.g., "many2one", "char")
   */
  type_filter: z
    .string()
    .optional()
    .describe('Filter results to specific field type (e.g., "many2one")'),

  /**
   * Only show stored fields (exclude computed)
   */
  stored_only: z
    .boolean()
    .default(false)
    .describe('Only show stored fields, exclude computed fields'),

  /**
   * Filter by point type: schema, data, or all
   * - schema: Search field definitions (default)
   * - data: Search actual CRM records
   * - all: Search both schema and data together
   */
  point_type: z
    .enum(['schema', 'data', 'all'])
    .default('schema')
    .describe('Point type: schema=field definitions, data=CRM records, all=both'),

  /**
   * Enable graph-boosted ranking
   * When enabled, records with more FK connections rank higher.
   * Only applies to data point_type searches.
   */
  graph_boost: z
    .boolean()
    .default(false)
    .describe('Boost ranking by FK connection count (well-connected records rank higher). Only for data searches.'),
}).strict();

/**
 * Inferred type from schema
 */
export type SemanticSearchInput = z.infer<typeof SemanticSearchSchema>;

// =============================================================================
// SCHEMA SYNC SCHEMA (Unified - merges Odoo and Excel sync)
// =============================================================================

/**
 * Schema for schema_sync tool input (UNIFIED)
 *
 * Merges two previous tools:
 * - sync (Odoo API source)
 * - nexsus_sync (Excel file source)
 *
 * The preferred source is Excel (nexsus_schema_v2_generated.xlsx) which contains
 * 17,931 field definitions with pre-built semantic text and FK metadata.
 */
export const SchemaSyncSchema = z.object({
  /**
   * Schema source to sync
   * - excel: Sync from Excel file (nexsus_schema_v2_generated.xlsx) - RECOMMENDED
   * - odoo: Sync from Odoo API (original source)
   */
  source: z
    .enum(['odoo', 'excel'])
    .default('excel')
    .describe('Source: excel=nexsus_schema_v2_generated.xlsx (default/recommended), odoo=Odoo API'),

  /**
   * Sync action to perform
   * - status: Check sync status
   * - full_sync: Upload ALL schema fields
   * - incremental_sync: Only sync changed fields (odoo source only)
   */
  action: z
    .enum(['status', 'full_sync', 'incremental_sync'])
    .describe('Action: status=check status, full_sync=upload all, incremental_sync=changes only (odoo only)'),

  /**
   * Force recreate collection (deletes existing data)
   * Only applies to full_sync action
   */
  force_recreate: z
    .boolean()
    .default(false)
    .describe('Delete and recreate collection before sync (full_sync only)'),
}).strict();

/**
 * Inferred type from schema
 */
export type SchemaSyncInput = z.infer<typeof SchemaSyncSchema>;

// Legacy aliases for backward compatibility
export const SyncSchema = SchemaSyncSchema;
export const NexsusSyncSchema = SchemaSyncSchema;
export type SyncInput = SchemaSyncInput;
export type NexsusSyncInput = SchemaSyncInput;

// =============================================================================
// SEARCH DATA SCHEMA (Phase 2 - Data Search)
// =============================================================================

/**
 * Schema for search_data tool input
 *
 * Searches synced Odoo data records semantically.
 */
export const SearchDataSchema = z.object({
  /**
   * Natural language query to search data
   * Examples:
   * - "Hospital projects in Victoria"
   * - "High value opportunities over 500000"
   * - "Leads from Hansen Yuncken"
   */
  query: z
    .string()
    .min(1, 'Query must be at least 1 character')
    .max(500, 'Query must be at most 500 characters')
    .describe('Natural language query to search CRM data'),

  /**
   * Maximum number of results to return
   */
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Maximum number of results (1-100, default: 10)'),

  /**
   * Minimum similarity score (0-1)
   */
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe('Minimum similarity score (0-1, default: 0.3)'),
}).strict();

/**
 * Inferred type from schema
 */
export type SearchDataInput = z.infer<typeof SearchDataSchema>;

// =============================================================================
// PIPELINE SYNC SCHEMA (with Cascade FK Support)
// =============================================================================

/**
 * Schema for pipeline_sync tool input (with cascade support)
 *
 * Syncs a model and automatically cascades to sync referenced FK targets.
 * Follows outgoing FKs only (one-direction cascading).
 *
 * Features:
 * - Automatic FK cascade (syncs all referenced records)
 * - Date filtering (for PRIMARY MODEL ONLY)
 * - Incremental sync (skip already-synced records)
 * - Cycle detection (prevent infinite loops on self-referencing FKs)
 * - Parallel cascading (configurable concurrent FK target syncs)
 * - Knowledge graph updates during cascade
 *
 * Trigger format: "pipeline_[model.name]_1984"
 * Examples:
 * - "pipeline_crm.lead_1984"
 * - "pipeline_account.move.line_1984"
 * - "pipeline_res.partner_1984"
 */
export const CascadeSyncSchema = z.object({
  /**
   * Trigger command - must match pattern to prevent accidents
   *
   * Format: "pipeline_[model.name]_1984"
   */
  command: z
    .string()
    .regex(
      /^pipeline_[a-z_]+(\.[a-z_]+)*_1984$/,
      'Command must be "pipeline_[model.name]_1984" (e.g., pipeline_crm.lead_1984)'
    )
    .describe('Trigger command: "pipeline_[model.name]_1984"'),

  /**
   * Specific record IDs to sync (optional)
   * If omitted, syncs all records from the model
   */
  record_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe('Specific record IDs to sync. If omitted, syncs all records.'),

  /**
   * Skip records that already exist in Qdrant (default: true)
   * When true, only syncs FK targets that are missing from the database.
   */
  skip_existing: z
    .boolean()
    .default(true)
    .describe('Skip already-synced records (default: true)'),

  /**
   * Number of FK targets to sync in parallel (default: 3)
   * Higher values = faster but more API load
   */
  parallel_targets: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe('Parallel FK target syncs (1-10, default: 3)'),

  /**
   * Dry run mode - show plan without executing
   * Useful for previewing what would be synced
   */
  dry_run: z
    .boolean()
    .default(false)
    .describe('Show sync plan without executing'),

  /**
   * Update knowledge graph during cascade (default: true)
   * Records FK relationships in nexsus_unified with point_type='graph'
   */
  update_graph: z
    .boolean()
    .default(true)
    .describe('Update knowledge graph with FK relationships (default: true)'),

  /**
   * Filter by create_date - start of period (inclusive)
   * Format: YYYY-MM-DD
   * NOTE: Date filter applies to PRIMARY MODEL ONLY. FK targets sync regardless of date.
   */
  date_from: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      'Date must be in YYYY-MM-DD format (e.g., "2023-07-01")'
    )
    .optional()
    .describe('Start date for PRIMARY MODEL ONLY (FK targets sync regardless of date)'),

  /**
   * Filter by create_date - end of period (inclusive)
   * Format: YYYY-MM-DD
   * NOTE: Date filter applies to PRIMARY MODEL ONLY. FK targets sync regardless of date.
   */
  date_to: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}$/,
      'Date must be in YYYY-MM-DD format (e.g., "2024-06-30")'
    )
    .optional()
    .describe('End date for PRIMARY MODEL ONLY (FK targets sync regardless of date)'),
}).strict();

/**
 * Inferred type from schema
 */
export type CascadeSyncInput = z.infer<typeof CascadeSyncSchema>;

/**
 * Schema for pipeline_status tool input
 */
export const PipelineStatusSchema = z.object({
  /**
   * Optional model name to check status for
   */
  model_name: z
    .string()
    .optional()
    .describe('Optional model name to check specific sync status'),
}).strict();

/**
 * Inferred type from schema
 */
export type PipelineStatusInput = z.infer<typeof PipelineStatusSchema>;

/**
 * Schema for pipeline_preview tool input
 */
export const PipelinePreviewSchema = z.object({
  /**
   * Model name to preview
   */
  model_name: z
    .string()
    .min(1)
    .describe('Model name to preview transformation for (e.g., "crm.lead")'),
}).strict();

/**
 * Inferred type from schema
 */
export type PipelinePreviewInput = z.infer<typeof PipelinePreviewSchema>;

// =============================================================================
// INSPECT RECORD SCHEMA
// =============================================================================

/**
 * Schema for inspect_record tool input
 *
 * Retrieve and display exact point data stored in Qdrant.
 * Useful for debugging, verification, and data inspection.
 *
 * **Provide EITHER:**
 * - model_name + record_id: e.g., "crm.lead" + 41085
 * - point_id: Direct UUID e.g., "00000344-0000-0000-0000-000000041085"
 */
export const InspectRecordSchema = z.object({
  /**
   * Odoo model name (e.g., "crm.lead", "res.partner")
   * Required if not using point_id
   */
  model_name: z
    .string()
    .optional()
    .describe('Odoo model name (e.g., "crm.lead", "res.partner")'),

  /**
   * Odoo record ID (e.g., 41085)
   * Required if not using point_id
   */
  record_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Odoo record ID (e.g., 41085)'),

  /**
   * Direct Qdrant UUID
   * Format: 00000344-0000-0000-0000-000000041085
   * If provided, overrides model_name/record_id
   */
  point_id: z
    .string()
    .regex(
      /^[0-9]{8}-0000-0000-0000-[0-9]{12}$/,
      'UUID must be format: 00000344-0000-0000-0000-000000041085'
    )
    .optional()
    .describe('Direct Qdrant UUID (e.g., "00000344-0000-0000-0000-000000041085")'),

  /**
   * Include the 1024-dimension embedding vector in response
   * Default: false (vectors are large)
   */
  with_vector: z
    .boolean()
    .default(false)
    .describe('Include the 1024-dimension embedding vector'),

  /**
   * Include raw encoded text that was embedded
   * Default: true
   */
  with_raw: z
    .boolean()
    .default(true)
    .describe('Include raw encoded text that was embedded'),

  /**
   * Point type to query in nexsus_unified
   * - data: Synced CRM/Odoo records (point_type='data') - DEFAULT
   * - schema: Field definitions from Excel schema (point_type='schema')
   */
  collection: z
    .enum(['data', 'schema'])
    .default('data')
    .describe('Point type in unified collection: data (CRM records), schema (field definitions)'),
}).strict();

/**
 * Inferred type from schema
 */
export type InspectRecordInput = z.infer<typeof InspectRecordSchema>;

// =============================================================================
// GRAPH TRAVERSAL SCHEMA (Phase 3 - FK Graph Navigation)
// =============================================================================

/**
 * Schema for graph_traverse tool input
 *
 * Navigate the Vector Knowledge Graph by traversing FK relationships.
 * Supports both outgoing (follow FKs) and incoming (find references) traversal.
 *
 * The graph is built from FK Qdrant IDs stored in payload (*_qdrant fields).
 * Each *_qdrant field contains a UUID that points to another record in Qdrant.
 *
 * Example FK chain:
 *   crm.stage → create_uid_qdrant → res.users → partner_id_qdrant → res.partner
 *                                              → company_id_qdrant → res.company
 */
export const GraphTraverseSchema = z.object({
  /**
   * Starting model name (e.g., "crm.lead", "crm.stage", "res.users")
   */
  model_name: z
    .string()
    .min(1)
    .describe('Starting model name (e.g., "crm.lead", "crm.stage")'),

  /**
   * Starting record ID (Odoo ID, e.g., 1, 41085)
   */
  record_id: z
    .number()
    .int()
    .positive()
    .describe('Starting record ID (Odoo ID)'),

  /**
   * Traversal depth (how many hops to follow)
   * - 1: Only immediate FK references
   * - 2: References of references
   * - 3: Maximum depth (prevents runaway traversal)
   */
  depth: z
    .number()
    .int()
    .min(1)
    .max(3)
    .default(1)
    .describe('Traversal depth: 1-3 hops (default: 1)'),

  /**
   * Traversal direction:
   * - outgoing: Follow FK fields (*_qdrant) to find related records
   * - incoming: Find records that reference this record via FK
   * - both: Both outgoing and incoming
   */
  direction: z
    .enum(['outgoing', 'incoming', 'both'])
    .default('outgoing')
    .describe('Direction: outgoing=follow FKs, incoming=find references, both=all'),

  /**
   * FK fields to follow (for outgoing traversal)
   * - "all": Follow all *_qdrant fields
   * - Array of field names: Only follow specified fields (without _qdrant suffix)
   *
   * Example: ["partner_id", "user_id"] to only follow those FKs
   */
  follow: z
    .union([
      z.literal('all'),
      z.array(z.string())
    ])
    .default('all')
    .describe('FK fields to follow: "all" or specific field names (e.g., ["partner_id", "user_id"])'),

  /**
   * Maximum results for incoming traversal (prevents too many results)
   */
  incoming_limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum incoming references to return (default: 20)'),
}).strict();

/**
 * Inferred type from schema
 */
export type GraphTraverseInput = z.infer<typeof GraphTraverseSchema>;

// =============================================================================
// SYSTEM STATUS SCHEMA (Unified Status Tool)
// =============================================================================

/**
 * Schema for system_status tool input
 *
 * Unified status tool that combines:
 * - data: Collection vector counts
 * - pipeline: Sync history and model info
 * - health: Circuit breaker states
 * - metrics: Sync performance statistics
 * - all: Everything (default)
 */
export const SystemStatusSchema = z.object({
  /**
   * Status section to display
   */
  section: z
    .enum(['all', 'pipeline', 'health', 'metrics', 'data'])
    .default('all')
    .describe('Section: all=everything, pipeline=sync history, health=circuit breakers, metrics=performance, data=collection stats'),

  /**
   * Optional model name for detailed pipeline status
   */
  model_name: z
    .string()
    .optional()
    .describe('Model name for detailed sync status (pipeline section only)'),

  /**
   * Reset sync metrics when viewing metrics section
   */
  reset_metrics: z
    .boolean()
    .default(false)
    .describe('Reset sync metrics to zero (metrics section only)'),

  /**
   * Reset circuit breakers when viewing health section
   */
  reset_circuits: z
    .boolean()
    .default(false)
    .describe('Reset circuit breakers to closed state (health section only)'),
}).strict();

/**
 * Inferred type from schema
 */
export type SystemStatusInput = z.infer<typeof SystemStatusSchema>;

// =============================================================================
// BUILD ODOO URL SCHEMA
// =============================================================================

/**
 * Schema for build_odoo_url tool input
 *
 * Generates clickable Odoo web URLs for direct navigation to:
 * - Forms (create/edit records)
 * - Lists (browse records)
 * - Reports (aged receivables, etc.)
 *
 * Prerequisites: ir.ui.menu and ir.actions.act_window must be synced to Qdrant
 */
export const BuildOdooUrlSchema = z.object({
  /**
   * Odoo model name (technical name)
   * Examples: "account.move", "crm.lead", "res.partner"
   */
  model_name: z
    .string()
    .optional()
    .describe('Odoo model name (e.g., "account.move", "crm.lead", "res.partner")'),

  /**
   * View type to open
   * - form: Create/edit single record
   * - list: Browse multiple records
   * - kanban: Card-based view
   * - pivot: Pivot table
   * - graph: Charts
   * - calendar: Calendar view
   */
  view_type: z
    .enum(['form', 'list', 'kanban', 'pivot', 'graph', 'calendar'])
    .optional()
    .describe('View type. If not specified, returns all available view types.'),

  /**
   * Specific record ID to open in form view
   * Only applies when view_type is "form"
   */
  record_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Specific record ID to open in form view'),

  /**
   * Search term to find matching actions by name
   * Useful when you don't know the exact model name
   * Examples: "vendor bill", "aged receivable", "sales order"
   */
  search_term: z
    .string()
    .optional()
    .describe('Search term to find matching actions by name (e.g., "vendor bill", "aged receivable")'),
}).strict();

/**
 * Inferred type from schema
 */
export type BuildOdooUrlInput = z.infer<typeof BuildOdooUrlSchema>;

// =============================================================================
// INSPECT GRAPH EDGE SCHEMA
// =============================================================================

/**
 * Schema for inspect_graph_edge tool input
 *
 * Inspects a specific Knowledge Graph edge to see FK relationship details
 * including cascade_sources array and validation metadata.
 */
export const InspectGraphEdgeSchema = z.object({
  /**
   * Source model containing the FK field (e.g., "crm.lead")
   */
  source_model: z
    .string()
    .min(1, 'Source model is required')
    .describe('Source model containing the FK (e.g., "crm.lead")'),

  /**
   * Target model referenced by the FK (e.g., "res.partner")
   */
  target_model: z
    .string()
    .min(1, 'Target model is required')
    .describe('Target model referenced by FK (e.g., "res.partner")'),

  /**
   * FK field name (e.g., "partner_id")
   */
  field_name: z
    .string()
    .min(1, 'Field name is required')
    .describe('FK field name (e.g., "partner_id")'),
}).strict();

/**
 * Inferred type from schema
 */
export type InspectGraphEdgeInput = z.infer<typeof InspectGraphEdgeSchema>;

// =============================================================================
// EXPORT ALL SCHEMAS
// =============================================================================

// Type alias for backward compatibility (PipelineSyncSchema was merged into CascadeSyncSchema)
export const PipelineSyncSchema = CascadeSyncSchema;
export type PipelineSyncInput = CascadeSyncInput;

export const schemas = {
  SemanticSearchSchema,
  SchemaSyncSchema,
  SyncSchema,      // alias for backward compatibility
  NexsusSyncSchema, // alias for backward compatibility
  SearchDataSchema,
  PipelineSyncSchema,
  CascadeSyncSchema,
  PipelineStatusSchema,
  PipelinePreviewSchema,
  InspectRecordSchema,
  GraphTraverseSchema,
  SystemStatusSchema,
  BuildOdooUrlSchema,
  InspectGraphEdgeSchema,
};
