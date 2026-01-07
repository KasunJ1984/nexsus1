/**
 * TypeScript type definitions for Nexsus MCP Server
 *
 * V2 UUID Format:
 * - Data:   00000002-MMMM-0000-0000-RRRRRRRRRRRR
 * - Schema: 00000003-0004-0000-0000-FFFFFFFFFFFF
 * - Graph:  00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF
 */

// =============================================================================
// ODOO TYPES (KEPT FOR PHASE 2)
// =============================================================================

/**
 * Odoo connection configuration
 */
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

/**
 * Odoo relation field tuple [id, name] or false if not set
 */
export type OdooRelation = [number, string] | false;

/**
 * Type guard to check if an Odoo relation is valid (not false)
 */
export function isValidRelation(relation: OdooRelation | undefined): relation is [number, string] {
  return Array.isArray(relation) && relation.length === 2;
}

/**
 * Safely get relation name
 */
export function getRelationName(relation: OdooRelation | undefined): string {
  return isValidRelation(relation) ? relation[1] : '';
}

/**
 * Safely get relation ID
 */
export function getRelationId(relation: OdooRelation | undefined): number | undefined {
  return isValidRelation(relation) ? relation[0] : undefined;
}

/**
 * CRM Lead record from Odoo (KEPT FOR PHASE 2)
 *
 * This type represents a crm.lead record with all its relational fields.
 * Used by odoo-client.ts for fetching lead data.
 */
export interface CrmLead {
  id: number;
  name: string | false;
  expected_revenue: number;
  probability: number;
  description: string | false;
  create_date: string | false;
  write_date: string | false;
  date_closed: string | false;
  city: string | false;
  active: boolean;

  // Standard FK relations (return [id, name] or false)
  partner_id: OdooRelation;
  stage_id: OdooRelation;
  user_id: OdooRelation;
  team_id: OdooRelation;
  state_id: OdooRelation;
  lost_reason_id: OdooRelation;

  // Custom FK relations
  x_specification_id: OdooRelation;
  x_lead_source_id: OdooRelation;
  x_architect_id: OdooRelation;
}

// =============================================================================
// ODOO SCHEMA TYPES
// =============================================================================

/**
 * Parsed Odoo schema row
 *
 * Each row describes one field from ir.model.fields with relationship tracing.
 */
export interface OdooSchemaRow {
  /** Model ID in ir.model */
  model_id: number;
  /** Field ID in ir.model.fields */
  field_id: number;

  /** Technical name (e.g., "user_id") */
  field_name: string;
  /** Display label (e.g., "Salesperson") */
  field_label: string;
  /** Type (char, many2one, one2many, etc.) */
  field_type: string;
  /** Model name (e.g., "crm.lead") */
  model_name: string;

  /** Where the data actually lives (e.g., "res.users.id") */
  primary_data_location: string;
  /** Is field stored in database? */
  stored: boolean;

  /** Model ID where data lives */
  primary_model_id: number | string;
  /** Field ID where data lives */
  primary_field_id: number | string;

  /** Original encoded string */
  raw_encoded: string;
}

/**
 * Schema search result with similarity score
 */
export interface SchemaSearchResult {
  score: number;              // Similarity score (0-1)
  schema: OdooSchemaRow;      // The matched schema row
}

/**
 * Filter for schema search
 *
 * Supports multiple search modes:
 * - semantic: Vector similarity search with optional filters
 * - list: Get all fields in a model (filter only)
 * - references_out: Find relational fields in a model
 * - references_in: Find fields that reference a model
 */
export interface SchemaFilter {
  model_name?: string;                    // Filter by model (e.g., "crm.lead")
  field_type?: string | string[];         // Filter by type(s) (e.g., "many2one" or ["many2one", "one2many"])
  stored_only?: boolean;                  // Only stored fields
  primary_data_location_prefix?: string;  // Filter by primary_data_location prefix (for references_in)
  point_type?: 'schema' | 'data' | 'graph' | 'all'; // Filter by point type in unified collection
}

/**
 * Schema payload stored in Qdrant vector
 */
export interface SchemaPayload {
  // Core identifiers
  model_id: number;
  field_id: number;
  model_name: string;
  field_name: string;
  field_label: string;
  field_type: string;

  // Data location
  primary_data_location: string;
  primary_model_id: string;
  primary_field_id: string;
  stored: boolean;

  // The semantic text that was embedded
  semantic_text: string;

  // Original encoded string
  raw_encoded: string;

  // Sync metadata
  sync_timestamp: string;

  // Type discriminator (added for unified search)
  point_type?: 'schema';
}

/**
 * Union type for any payload in the collection
 * All payloads use point_type='data' or point_type='schema'
 */
export type AnyPayload = SchemaPayload | DataPayload | PipelineDataPayload;

/**
 * Type guard to check if payload is DataPayload
 */
export function isDataPayload(payload: AnyPayload): payload is DataPayload {
  return (payload as DataPayload).point_type === 'data';
}

/**
 * Type guard to check if payload is PipelineDataPayload (alias for data payloads with extra fields)
 */
export function isPipelineDataPayload(payload: AnyPayload): payload is PipelineDataPayload {
  return (payload as PipelineDataPayload).point_type === 'data';
}

/**
 * Type guard to check if payload is ANY data type
 * Use this for searching data points
 */
export function isAnyDataPayload(payload: AnyPayload): payload is DataPayload | PipelineDataPayload {
  const pt = (payload as DataPayload | PipelineDataPayload).point_type;
  return pt === 'data';
}

/**
 * Type guard to check if payload is SchemaPayload
 */
export function isSchemaPayload(payload: AnyPayload): payload is SchemaPayload {
  return !isAnyDataPayload(payload);
}

/**
 * Get the point type from any payload (G15 - Unified utility)
 *
 * Returns the point_type discriminator value from any Qdrant payload.
 * Use this instead of multiple type guard functions for simpler code.
 *
 * @param payload - Any payload from Qdrant
 * @returns 'data' | 'schema' | 'graph' | 'unknown'
 *
 * @example
 * const type = getPayloadType(payload);
 * if (type === 'data') {
 *   // Handle data payload
 * } else if (type === 'schema') {
 *   // Handle schema payload
 * } else if (type === 'graph') {
 *   // Handle graph/relationship payload
 * }
 */
export function getPayloadType(payload: Record<string, unknown>): 'data' | 'schema' | 'graph' | 'unknown' {
  const pointType = payload?.point_type;

  if (pointType === 'data') return 'data';
  if (pointType === 'schema') return 'schema';
  if (pointType === 'graph' || pointType === 'relationship') return 'graph';

  return 'unknown';
}

// =============================================================================
// VECTOR TYPES
// =============================================================================

/**
 * Schema point for upserting to Qdrant
 */
export interface SchemaPoint {
  id: number;                 // Using field_id as unique identifier
  vector: number[];           // Embedding vector
  payload: SchemaPayload;     // Metadata
}

/**
 * Vector search result from Qdrant (supports both schema and data)
 */
export interface VectorSearchResult {
  id: number;
  score: number;
  payload: AnyPayload;
  /** Actual Qdrant point ID (UUID string) for display */
  qdrant_id?: string;
}

// =============================================================================
// SYNC TYPES
// =============================================================================

/**
 * Schema sync result
 */
export interface SchemaSyncResult {
  success: boolean;
  uploaded: number;
  failed: number;
  durationMs: number;
  errors?: string[];
}

/**
 * Schema sync status
 */
export interface SchemaSyncStatus {
  collection: string;
  vectorCount: number;
  lastSync: string | null;
}

// =============================================================================
// MCP TOOL TYPES
// =============================================================================

/**
 * Tool response content
 */
export interface ToolContent {
  type: 'text';
  text: string;
}

/**
 * Tool result
 */
export interface ToolResult {
  content: ToolContent[];
}

// =============================================================================
// INCREMENTAL SYNC TYPES
// =============================================================================

/**
 * Result of incremental sync operation
 */
export interface IncrementalSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Number of new fields added */
  added: number;
  /** Number of modified fields updated */
  modified: number;
  /** Number of deleted fields removed */
  deleted: number;
  /** Number of unchanged fields skipped */
  unchanged: number;
  /** Total sync duration in milliseconds */
  durationMs: number;
  /** Whether cache was cleared (only if changes occurred) */
  cacheCleared: boolean;
  /** Error messages if any */
  errors?: string[];
}

// =============================================================================
// DATA TRANSFORMER TYPES (Phase 2 - Data Encoding)
// =============================================================================

/**
 * Field encoding map: field_name → encoding metadata
 */
export interface FieldEncodingMap {
  [field_name: string]: {
    /** Encoding prefix for this field */
    prefix: string;
    /** Field type from schema (char, many2one, boolean, etc.) */
    field_type: string;
    /** True if many2one/many2many field */
    is_foreign_key: boolean;
    /** For FK fields: target model name (e.g., "res.partner") */
    target_model?: string;
  };
}

/**
 * Encoded record ready for embedding
 */
export interface EncodedRecord {
  /** Odoo record ID */
  record_id: number;
  /** Source model name (e.g., "crm.lead") */
  model_name: string;
  /** Model ID for point ID generation */
  model_id: number;
  /** The full encoded string for embedding */
  encoded_string: string;
  /** Number of fields in the encoded string */
  field_count: number;
}

/**
 * Data payload stored in Qdrant vector
 * Distinguished from SchemaPayload by point_type: 'data'
 */
export interface DataPayload {
  /** Odoo record ID */
  record_id: number;
  /** Source model name */
  model_name: string;
  /** Model ID */
  model_id: number;
  /** The encoded string */
  encoded_string: string;
  /** Number of fields encoded */
  field_count: number;
  /** When this record was synced */
  sync_timestamp: string;
  /** Type discriminator to distinguish from schema */
  point_type: 'data';
}

/**
 * Data point for upserting to Qdrant
 */
export interface DataPoint {
  /** Unique ID: model_id * 10_000_000 + record_id */
  id: number;
  /** Embedding vector */
  vector: number[];
  /** Data payload */
  payload: DataPayload;
}

/**
 * Result of data sync operation
 */
export interface DataSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Model name that was synced */
  model_name: string;
  /** Total records processed from Odoo */
  records_processed: number;
  /** Records successfully embedded and uploaded */
  records_embedded: number;
  /** Records that failed to process */
  records_failed: number;
  /** Total duration in milliseconds */
  duration_ms: number;
  /** Error messages if any */
  errors?: string[];
}

// =============================================================================
// API RESTRICTION HANDLING TYPES
// =============================================================================

/**
 * Reason why a field is restricted from API access
 *
 * - security_restriction: Odoo ACL blocks field access
 * - compute_error: Odoo compute method failed (e.g., "Compute method failed to assign")
 * - odoo_error: Odoo-side bug (e.g., singleton error in computed field)
 * - unknown: Unrecognized error pattern
 */
export type FieldRestrictionReason = 'security_restriction' | 'compute_error' | 'odoo_error' | 'unknown';

/**
 * Information about a restricted field
 *
 * Tracks fields that couldn't be read due to API permissions.
 * These fields are marked as "Restricted_from_API" in the encoded output.
 */
export interface FieldRestriction {
  /** Field name that was restricted */
  field_name: string;
  /** Reason for the restriction */
  reason: FieldRestrictionReason;
  /** When the restriction was detected (ISO timestamp) */
  detected_at: string;
}

/**
 * Context passed through the encoding pipeline
 *
 * Tracks which fields are restricted for the current sync operation.
 * Used by the encoder to mark restricted fields appropriately.
 */
export interface EncodingContext {
  /** Model being encoded */
  model_name: string;
  /** Map of field names to restriction reasons */
  restricted_fields: Map<string, FieldRestrictionReason>;
}

/**
 * Extended DataSyncResult with API restriction information
 *
 * Used when syncing models that have some fields restricted.
 * The sync can still succeed with partial field data.
 */
export interface DataSyncResultWithRestrictions extends DataSyncResult {
  /** Fields that were restricted and excluded from sync */
  restricted_fields: FieldRestriction[];
  /** Warning messages about restrictions */
  warnings: string[];
  /** Type of sync performed: 'full' or 'incremental' */
  sync_type?: 'full' | 'incremental';
}

/**
 * Result of a resilient search-read operation
 *
 * Returned by searchReadWithRetry when it successfully handles
 * field restrictions through automatic retry.
 */
export interface ResilientSearchResult<T> {
  /** Records fetched from Odoo */
  records: T[];
  /** Fields that were removed due to restrictions */
  restrictedFields: string[];
  /** Number of retries needed to succeed */
  retryCount: number;
  /** Warning messages generated during retries */
  warnings: string[];
}

/**
 * Configuration for resilient search-read operation
 */
export interface ResilientSearchConfig {
  /** Maximum number of retries (default: 5) */
  maxRetries?: number;
  /** Optional callback when a field is found to be restricted */
  onFieldRestricted?: (field: string, reason: FieldRestrictionReason) => void;
}

/**
 * Schema-Data validation result
 *
 * Ensures every Odoo field has a corresponding schema entry.
 * Sync will FAIL if any field is missing from schema.
 */
export interface ValidationResult {
  /** True if all Odoo fields have schema entries */
  valid: boolean;
  /** Fields that matched between Odoo and schema */
  matched_fields: string[];
  /** Odoo fields NOT in schema - CAUSES FAILURE */
  missing_in_schema: string[];
  /** Schema fields not in Odoo - informational only */
  missing_in_odoo: string[];
}

/**
 * Configuration for data transform operation
 */
export interface DataTransformConfig {
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Model ID (e.g., 344 for crm.lead) */
  model_id: number;
  /** Field ID for the 'id' column (e.g., 6327 for crm.lead.id) */
  id_field_id: number;
  /** Include archived records (active=false). Default: true */
  include_archived?: boolean;
  /** Testing only: limit records for debugging */
  test_limit?: number;
  /** If true, only sync records modified since last sync. Default: true */
  incremental?: boolean;
  /** If true, force full sync even if incremental is enabled. Default: false */
  force_full?: boolean;
}

// =============================================================================
// NEXUS DECODE TYPES (Human Interface Layer)
// =============================================================================

/**
 * Field metadata from schema lookup
 */
export interface CoordinateMetadata {
  /** Technical field name (e.g., "expected_revenue") */
  field_name: string;
  /** Human-readable label (e.g., "Expected Revenue") */
  field_label: string;
  /** Field type (e.g., "monetary", "many2one", "char") */
  field_type: string;
  /** Model this field belongs to (e.g., "crm.lead") */
  model_name: string;
  /** Model ID */
  model_id: number;
  /** Field ID */
  field_id: number;
  /** True if this is a foreign key field */
  is_foreign_key: boolean;
  /** Target model for FK fields (e.g., "res.partner") */
  target_model?: string;
}

/**
 * Schema lookup map for field metadata
 */
export type CoordinateLookupMap = Map<string, CoordinateMetadata>;

/**
 * Parsed field from encoded string
 */
export interface ParsedField {
  /** The coordinate portion */
  coordinate: string;
  /** Model ID extracted */
  model_id: number;
  /** Field ID extracted */
  field_id: number;
  /** The value portion */
  raw_value: string;
}

/**
 * Decoded field with human-readable display value
 *
 * The final output of the NEXUS decoder - ready for display to users.
 */
export interface DecodedField {
  /** Technical field name */
  field_name: string;
  /** Human-readable label */
  field_label: string;
  /** Field type */
  field_type: string;
  /** Original raw value from encoding */
  raw_value: string;
  /** Formatted display value (e.g., "$450,000" or "#201 (res.partner)") */
  display_value: string;
  /** True if this is a foreign key field */
  is_foreign_key: boolean;
  /** Target model for FK fields */
  target_model?: string;
}

// =============================================================================
// NEXUS ANALYTICS TYPES (Self-Improving System)
// =============================================================================

/**
 * Field usage tracking record
 *
 * Tracks how often each field is decoded or appears in search results.
 * Used to discover which fields are most important to users.
 */
export interface FieldUsageRecord {
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Field name (e.g., "expected_revenue") */
  field_name: string;
  /** Coordinate string */
  coordinate: string;
  /** Number of times this field was decoded in results */
  decode_count: number;
  /** Number of times this field appeared in search results */
  search_count: number;
  /** Last time this field was used (ISO timestamp) */
  last_used: string;
}

/**
 * Field importance score (calculated from usage)
 *
 * Used to determine which fields should be promoted to key fields.
 */
export interface FieldImportanceScore {
  /** Model name */
  model_name: string;
  /** Field name */
  field_name: string;
  /** Calculated importance score (0-100) */
  total_score: number;
  /** Decode frequency contribution */
  decode_frequency: number;
  /** Search frequency contribution */
  search_frequency: number;
  /** True if this field should be promoted to key fields */
  is_promoted: boolean;
}

/**
 * Persisted analytics data
 *
 * Stored in data/analytics.json for persistence across restarts.
 */
export interface AnalyticsData {
  /** Data format version */
  version: number;
  /** Schema hash - analytics cleared if schema changes */
  schema_hash: string;
  /** When analytics data was created */
  created_at: string;
  /** Last update timestamp */
  updated_at: string;
  /** Field usage records keyed by "model.field" */
  field_usage: Record<string, FieldUsageRecord>;
  /** Total number of decode operations */
  total_decodes: number;
  /** Total number of searches */
  total_searches: number;
}

/**
 * Analytics summary for display
 *
 * Returned by getAnalyticsSummary() for showing in sync status.
 */
export interface AnalyticsSummary {
  /** Total decode operations */
  total_decodes: number;
  /** Total searches */
  total_searches: number;
  /** Top decoded fields by count */
  top_fields: Array<{ field: string; count: number }>;
  /** Fields suggested for promotion to key fields */
  suggested_promotions: string[];
  /** How long analytics has been collecting (hours) */
  data_age_hours: number;
}

// =============================================================================
// NEXUS TRAINING DATA TYPES (Phase 2 Preparation)
// =============================================================================

/**
 * Training data pair: NEXUS encoded → human readable
 *
 * These pairs are collected during decode operations and can be
 * exported for Phase 2 model training on the NEXUS language.
 */
export interface TrainingPair {
  /** Encoded input string */
  input: string;
  /** Human-readable output (e.g., "Name: Westfield | Revenue: $450,000") */
  output: string;
  /** Model name for context */
  model_name: string;
  /** When this pair was recorded */
  timestamp: string;
}

/**
 * Training data statistics
 */
export interface TrainingStats {
  /** Total training pairs collected */
  total_pairs: number;
  /** Pairs by model name */
  by_model: Record<string, number>;
  /** Oldest pair timestamp */
  oldest: string | null;
  /** Newest pair timestamp */
  newest: string | null;
}

// =============================================================================
// NEXSUS SCHEMA TYPES (Excel-based schema format)
// =============================================================================

/**
 * Parsed row from nexsus_schema_v2_generated.xlsx Excel file
 *
 * Excel format (3 columns):
 * - Column A: Qdrant ID (V2 UUID, e.g., "00000003-0004-0000-0000-000000028105")
 * - Column B: Vector (semantic text for embedding)
 * - Column C: Payload fields (structured metadata string)
 *
 * Example payload fields:
 * "Field_ID - 28105, Model_ID - 292, Field_Name - account_type, Field_Label - Type,
 *  Field_Type - selection, Model_Name - account.account, Stored - Yes"
 *
 * For FK fields, additional fields:
 * "FK location field model - calendar.event, FK location field model id - 184,
 *  FK location record Id - 2675, Qdrant ID for FK - 00000002-0184-0000-0000-000000002675"
 */
export interface NexsusSchemaRow {
  /** Qdrant point ID (UUID format from Excel Column A, e.g., "00000004-0000-0000-0000-000000028105") */
  qdrant_id: string;

  /** Pre-built semantic text from Column B - used for embedding */
  semantic_text: string;

  /** Raw payload fields string from Column C */
  raw_payload: string;

  /** Field ID parsed from payload (e.g., 28105) */
  field_id: number;

  /** Model ID parsed from payload (e.g., 292) */
  model_id: number;

  /** Technical field name (e.g., "account_type") */
  field_name: string;

  /** Display label (e.g., "Type") */
  field_label: string;

  /** Field type (e.g., "selection", "many2one", "char") */
  field_type: string;

  /** Field category for semantic grouping (Stage 6) */
  field_category?: FieldCategory;

  /** Model name (e.g., "account.account") */
  model_name: string;

  /** Whether field is stored in database */
  stored: boolean;

  // FK-specific fields (optional, only for relational fields)

  /** For FK fields: target model name (e.g., "calendar.event") */
  fk_location_model?: string;

  /** For FK fields: target model ID (e.g., 184) */
  fk_location_model_id?: number;

  /** For FK fields: target field/record ID (e.g., 2675) */
  fk_location_record_id?: number;

  /** For FK fields: Qdrant UUID reference for FK linking (e.g., "00000184-0000-0000-0000-000000002675") */
  fk_qdrant_id?: string;
}

/**
 * Simple Schema Row - User's simplified 11-column format
 * Used by simple-schema-converter.ts
 *
 * This format allows users to provide schema in a human-readable Excel format
 * without having to manually generate semantic text and payload strings.
 * The converter auto-generates:
 * - V2 UUIDs (00000003-0004-0000-0000-{field_id})
 * - Semantic text for embedding
 * - Payload strings for Qdrant storage
 *
 * FK Metadata is CRITICAL: Used to build knowledge graph edges
 */
export interface SimpleSchemaRow {
  /** Unique field identifier (user-assigned) */
  Field_ID: number;

  /** Model identifier (user-assigned) */
  Model_ID: number;

  /** Technical field name (e.g., "country_id") */
  Field_Name: string;

  /** Display label (e.g., "Country") */
  Field_Label: string;

  /** Odoo field type (e.g., "many2one", "char", "integer") */
  Field_Type: string;

  /** Model technical name (e.g., "customer", "res.partner") */
  Model_Name: string;

  /** "Yes" or "No" - indicates if field is stored in database */
  Stored: string;

  /** For FK fields: Target model name (e.g., "country") */
  'FK location field model'?: string;

  /** For FK fields: Target model ID (e.g., 2) - CRITICAL for graph edges */
  'FK location field model id'?: number;

  /** For FK fields: Target field ID (e.g., 201 for id field) - CRITICAL for graph edges */
  'FK location record Id'?: number;

  /** For FK fields: Auto-generated Qdrant UUID reference (optional in user input) */
  'Qdrant ID for FK'?: string;
}

/**
 * Payload structure for nexsus collection in Qdrant
 *
 * This is what gets stored in each Qdrant point's payload.
 * Includes all fields from NexsusSchemaRow plus sync metadata.
 * Note: vector_id is removed - Qdrant point ID (UUID) is the identifier.
 */
export interface NexsusPayload {

  /** Field ID (also used as point ID) */
  field_id: number;

  /** Model ID */
  model_id: number;

  /** Technical field name */
  field_name: string;

  /** Display label */
  field_label: string;

  /** Field type */
  field_type: string;

  /** Model name */
  model_name: string;

  /** Whether field is stored in database */
  stored: boolean;

  /** The semantic text that was embedded (Column B) */
  semantic_text: string;

  /** Original payload fields string from Excel (Column C) */
  raw_payload: string;

  // FK-specific fields (optional)
  fk_location_model?: string;
  fk_location_model_id?: number;
  fk_location_record_id?: number;
  /** Qdrant UUID reference for FK linking (e.g., "00000184-0000-0000-0000-000000002675") */
  fk_qdrant_id?: string;

  /** Primary data location for references_in mode compatibility (e.g., "res.partner.id") */
  primary_data_location?: string;

  /** When this record was synced to Qdrant */
  sync_timestamp: string;
}

/**
 * Qdrant point for nexsus collection
 */
export interface NexsusPoint {
  /** Point ID = field_id (numeric part of vector_id) */
  id: number;
  /** 1024-dimensional embedding vector */
  vector: number[];
  /** Payload with all metadata */
  payload: NexsusPayload;
}

/**
 * Result of nexsus sync operation
 */
export interface NexsusSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Number of records uploaded to Qdrant */
  uploaded: number;
  /** Number of records that failed */
  failed: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Error messages if any */
  errors?: string[];
}

/**
 * Status of nexsus collection
 */
export interface NexsusSyncStatus {
  /** Collection name */
  collection: string;
  /** Number of vectors in collection */
  vectorCount: number;
  /** Last sync timestamp */
  lastSync: string | null;
}

// =============================================================================
// PIPELINE TYPES (Excel-Based Data Pipeline)
// =============================================================================

/**
 * Payload field configuration from feilds_to_add_payload.xlsx
 *
 * Determines which fields should be included in the Qdrant payload.
 * Only fields with include_in_payload=true (payload=1 in Excel) are stored.
 */
export interface PayloadFieldConfig {
  /** Field ID from ir.model.fields */
  field_id: number;
  /** Model ID from ir.model */
  model_id: number;
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Technical field name (e.g., "expected_revenue") */
  field_name: string;
  /** Whether this field should be included in payload */
  include_in_payload: boolean;
}

/**
 * Pipeline field definition with FK metadata
 *
 * Loaded from nexsus_schema_v2_generated.xlsx via loadNexsusSchema().
 * Contains all field metadata including FK location information.
 */
export interface PipelineField {
  /** Field ID from ir.model.fields */
  field_id: number;
  /** Model ID from ir.model */
  model_id: number;
  /** Technical field name (e.g., "partner_id") */
  field_name: string;
  /** Human-readable label (e.g., "Customer") */
  field_label: string;
  /** Field type (char, many2one, integer, etc.) */
  field_type: string;
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Whether field is stored in database */
  stored: boolean;

  // FK metadata from Excel columns (only for many2one/one2many fields)

  /** Target model for FK fields (e.g., "calendar.event") */
  fk_location_model?: string;
  /** Target model ID (e.g., 184) */
  fk_location_model_id?: number;
  /** Target record/field ID (e.g., 2675) */
  fk_location_record_id?: number;
  /** Qdrant UUID reference for FK linking (e.g., "00000184-0000-0000-0000-000000002675") */
  fk_qdrant_id?: string;

  /** Whether this field should be included in payload (from feilds_to_add_payload.xlsx) */
  include_in_payload: boolean;
}

/**
 * Transformed record ready for embedding and upload
 *
 * Output format from pipeline-data-transformer.ts
 * Note: vector_id removed from payload - Qdrant point ID (UUID) is the identifier.
 * The qdrant_point_id is calculated from model_id^record_id and converted to UUID.
 */
export interface EncodedPipelineRecord {
  /** Odoo record ID */
  record_id: number;
  /** Source model name (e.g., "crm.lead") */
  model_name: string;
  /** Model ID (e.g., 344) */
  model_id: number;
  /** Human-readable vector text for embedding */
  vector_text: string;
  /** Payload with only payload=1 fields (empty fields skipped) */
  payload: Record<string, unknown>;
  /** Number of non-empty fields included */
  field_count: number;
}

/**
 * Payload stored in Qdrant for pipeline data points
 *
 * Contains only fields marked with payload=1 in Excel.
 * Empty/null fields are skipped during sync.
 * Note: vector_id removed - Qdrant point ID (UUID) is the identifier.
 *
 * point_type: 'data' for unified collection records
 */
export interface PipelineDataPayload {
  /** Odoo record ID */
  record_id: number;
  /** Source model name */
  model_name: string;
  /** Model ID */
  model_id: number;
  /** When this record was synced */
  sync_timestamp: string;
  /** Type discriminator for unified collection */
  point_type: 'data';
  /** Human-readable text that was embedded (for debugging) */
  vector_text?: string;
  /** Dynamic fields from payload=1 configuration */
  [key: string]: unknown;
}

/**
 * Qdrant point for pipeline data collection
 *
 * Uses V2 UUID format for IDs
 */
export interface PipelineDataPoint {
  /** V2 UUID string */
  id: string;
  /** 1024-dimensional embedding vector */
  vector: number[];
  /** Payload with selected fields */
  payload: PipelineDataPayload;
}

/**
 * Options for pipeline sync operation
 */
export interface PipelineSyncOptions {
  /** Force full sync (ignore incremental) */
  force_full?: boolean;
  /** Include archived records (active=false) */
  include_archived?: boolean;
  /** Limit records for testing */
  test_limit?: number;
  /** Custom batch size for Odoo fetch */
  fetch_batch_size?: number;
  /** Custom batch size for embedding */
  embed_batch_size?: number;
  /**
   * Filter records by create_date - start of period (inclusive)
   * Format: YYYY-MM-DD (e.g., "2023-07-01")
   * Only records created ON or AFTER this date will be synced
   */
  date_from?: string;
  /**
   * Filter records by create_date - end of period (inclusive)
   * Format: YYYY-MM-DD (e.g., "2024-06-30")
   * Only records created ON or BEFORE this date will be synced
   */
  date_to?: string;
  /**
   * Collect FK dependencies during sync (Solution 2 for cascade sync)
   *
   * When true, the sync will extract FK IDs from every record as they stream
   * through, accumulating them for return in fk_dependencies.
   * This ensures ALL FK targets are discovered, not limited by Qdrant scroll.
   */
  collect_fk_dependencies?: boolean;
  /**
   * Specific record IDs to sync (instead of all records)
   * Used by fix-orphans to sync only missing records
   */
  specificIds?: number[];
  /**
   * Skip records that already exist in Qdrant
   */
  skipExisting?: boolean;
  /**
   * Update knowledge graph during sync
   */
  updateGraph?: boolean;
}

/**
 * FK dependency extracted during sync (for cascade sync)
 *
 * Contains the unique FK IDs discovered while syncing records.
 * Used by cascade-sync to determine which FK targets need syncing.
 * Includes full field metadata for knowledge graph updates.
 */
export interface SyncFkDependency {
  /** FK field ID from ir.model.fields (for V2 Graph UUID) */
  field_id: number;
  /** FK field name (e.g., "partner_id") */
  field_name: string;
  /** Human-readable field label (e.g., "Partner") */
  field_label: string;
  /** Relationship type (many2one, many2many, one2many) */
  field_type: RelationshipType;
  /** Target model name (e.g., "res.partner") */
  target_model: string;
  /** Target model ID */
  target_model_id: number;
  /** Unique IDs referenced */
  unique_ids: number[];
  /** Total references count */
  total_references: number;
}

/**
 * Result of pipeline sync operation
 */
export interface PipelineSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Model name that was synced */
  model_name: string;
  /** Model ID */
  model_id: number;
  /** Total records fetched from Odoo */
  records_fetched: number;
  /** Records successfully embedded and uploaded */
  records_uploaded: number;
  /** Records that failed to process */
  records_failed: number;
  /** Total duration in milliseconds */
  duration_ms: number;
  /** Whether this was a full or incremental sync */
  sync_type: 'full' | 'incremental';
  /** Fields that were restricted from API access */
  restricted_fields?: string[];
  /** Error messages if any */
  errors?: string[];
  /**
   * FK dependencies discovered during sync (Solution 2 - collect during sync)
   *
   * Contains ALL FK IDs from ALL records synced, not limited by Qdrant scroll.
   * Used by cascade-sync for accurate FK target discovery.
   */
  fk_dependencies?: SyncFkDependency[];
}

/**
 * Model configuration discovered from Excel schema
 */
export interface PipelineModelConfig {
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Model ID (e.g., 344) */
  model_id: number;
  /** Field ID for the primary key 'id' field */
  primary_key_field_id: number;
  /** Total fields for this model in schema */
  total_fields: number;
  /** Fields marked with payload=1 */
  payload_field_count: number;
}

// =============================================================================
// EXACT QUERY TYPES (Financial Reporting & Validation)
// =============================================================================

/**
 * Filter operator for exact queries
 *
 * Maps to Qdrant filter syntax:
 * - eq: match.value
 * - neq: match with must_not
 * - gt/gte/lt/lte: range filters
 * - in: match.any
 * - contains: match.text
 */
export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

/**
 * Filter condition for exact queries
 *
 * Example: { field: "account_id_id", op: "eq", value: 319 }
 */
export interface FilterCondition {
  /** Payload field name (e.g., "account_id_id", "date", "parent_state") */
  field: string;
  /** Comparison operator */
  op: FilterOperator;
  /** Value to compare against (number, string, or array for 'in' operator) */
  value: unknown;
}

/**
 * Aggregation operation type
 */
export type AggregationOp = 'sum' | 'count' | 'avg' | 'min' | 'max';

/**
 * Aggregation definition for exact queries
 *
 * Example: { field: "debit", op: "sum", alias: "total_debit" }
 */
export interface Aggregation {
  /** Field to aggregate (e.g., "debit", "credit", "balance") */
  field: string;
  /** Aggregation function */
  op: AggregationOp;
  /** Result field name in output */
  alias: string;
}

/**
 * Input parameters for nexsus_search tool
 *
 * Supports two modes:
 * 1. Aggregation mode: filters + aggregations → returns computed totals
 * 2. Record mode: filters only → returns matching records
 */
export interface NexsusSearchInput {
  /** Odoo model name (e.g., "account.move.line"). Optional when filtering by point_id (auto-resolved from UUID). */
  model_name?: string;
  /** Filter conditions (AND logic) - at least one required */
  filters: FilterCondition[];
  /** Aggregations to compute (SUM, COUNT, AVG, MIN, MAX) */
  aggregations?: Aggregation[];
  /** Fields to group by (for grouped aggregations) */
  group_by?: string[];
  /** Fields to return (for record retrieval mode) */
  fields?: string[];
  /** Max records to return (default: 1000 for records, unlimited for aggregation) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Nexsus Link: FK fields to resolve and include (e.g., ["partner_id", "account_id"]) */
  link?: string[];
  /** Fields to return from linked relations (defaults to ["name", "display_name"]) */
  link_fields?: string[];
  /** JSON FK fields to resolve (e.g., ["analytic_distribution"]) - keys resolved to target names */
  link_json?: string[];
  /** Show FK relationships from Knowledge Graph */
  show_relationships?: boolean;

  // Data Grid Enrichment Flags (Phase 5)
  /** Include FK relationships and connection counts per record */
  include_graph_context?: boolean;
  /** Include orphan FK detection and integrity score per record */
  include_validation_status?: boolean;
  /** Include similar records within same model per record */
  include_similar?: boolean;
  /** Number of similar records per result (1-5, default: 3) */
  similar_limit?: number;

  // Token Limitation - Stage 2
  /** Response detail level: "summary" (~400 tokens), "top_n" (~800 tokens), "full" (all data, default) */
  detail_level?: DetailLevel;
  /** Number of top groups to show in top_n mode (1-100, default: 10) */
  top_n?: number;

  // Token Limitation - Stage 4: File Export
  /** Export results to Excel file instead of inline response. Returns file path. */
  export_to_file?: boolean;
}

// =============================================================================
// NEXSUS LINK TYPES
// =============================================================================

/**
 * A linked record resolved via FK Qdrant ID
 */
export interface LinkedRecord {
  /** Target model name (e.g., "res.partner") */
  model_name: string;
  /** Target record ID in Odoo */
  record_id: number;
  /** Qdrant UUID of the linked record */
  qdrant_id: string;
  /** Requested fields from the linked record */
  data: Record<string, unknown>;
}

/**
 * Result of Nexsus Link resolution
 */
export interface LinkResolutionResult {
  /** Map of FK field -> Map of record_id -> LinkedRecord */
  linked: Map<string, Map<number, LinkedRecord>>;
  /** FK fields that were invalid (not FK type) */
  invalidFields: string[];
  /** FK targets that were not found in Qdrant */
  missingTargets: string[];
  /** Resolution statistics */
  stats: {
    totalTargets: number;
    resolvedTargets: number;
    batchCalls: number;
  };
}

/**
 * Result of nexsus_search tool
 */
export interface NexsusSearchResult {
  /** For aggregation queries: computed values */
  aggregations?: Record<string, number>;
  /** For grouped aggregation queries: values by group */
  groups?: Array<{
    key: Record<string, unknown>;
    aggregations: Record<string, number>;
  }>;
  /** For record queries: matching records */
  records?: Array<Record<string, unknown>>;
  /** Total records processed/scanned */
  total_records: number;
  /** Query execution time in milliseconds */
  query_time_ms: number;
  /** True if results were truncated due to safety limits */
  truncated: boolean;
  /** Warning message if any */
  warning?: string;
}

/**
 * Internal state for streaming aggregation
 *
 * Used by aggregation-engine.ts to accumulate results
 * without loading all records into memory.
 */
export interface AggregatorState {
  /** Running sums for each alias */
  sums: Record<string, number>;
  /** Record counts for each alias (used for AVG calculation) */
  counts: Record<string, number>;
  /** Minimum values for each alias */
  mins: Record<string, number>;
  /** Maximum values for each alias */
  maxs: Record<string, number>;
}

/**
 * Result from scroll engine
 */
export interface ScrollResult {
  /** Retrieved records */
  records: Array<Record<string, unknown>>;
  /** Total records scanned */
  totalScanned: number;
  /** True if more records available */
  hasMore: boolean;
}

/**
 * Result from aggregation engine
 */
export interface AggregationResult {
  /** Computed aggregation values (for non-grouped queries) */
  results: Record<string, number>;
  /** Grouped results (for GROUP BY queries) */
  groups?: Array<{
    key: Record<string, unknown>;
    values: Record<string, number>;
  }>;
  /** Total records processed */
  totalRecords: number;
  /** True if truncated due to safety limit */
  truncated: boolean;
  /** Reconciliation checksum for verification (Token Limitation - Stage 3) */
  reconciliation?: ReconciliationChecksum;
}

// =============================================================================
// RECONCILIATION TYPES (Token Limitation - Stage 1)
// =============================================================================

/**
 * Checksum for reconciliation verification
 *
 * Generated during aggregation to enable cross-dimension verification.
 * Implements the reconciliation invariant:
 *   SUM(amount) WHERE group_by=GL
 *     = SUM(amount) WHERE group_by=customer
 *     = SUM(amount) WHERE group_by=job
 *     = Grand Total
 *
 * @example
 * // Checksum from revenue query
 * {
 *   grand_total: 1234567.89,
 *   hash: "#A7B3C9",
 *   record_count: 5432,
 *   computed_at: "2025-01-15T10:30:00Z",
 *   aggregation_field: "credit"
 * }
 */
export interface ReconciliationChecksum {
  /** Grand total of the primary aggregation field */
  grand_total: number;

  /** Short hash for reference (e.g., "#A7B3C9") */
  hash: string;

  /** Number of records included in aggregation */
  record_count: number;

  /** ISO timestamp when checksum was computed */
  computed_at: string;

  /** Aggregation field used (e.g., "debit", "credit", "balance") */
  aggregation_field: string;

  /** Aggregation operation used (e.g., "sum", "count") */
  aggregation_op?: string;
}

/**
 * Result of reconciliation verification across dimensions
 *
 * Used when reconcile_with parameter is specified to verify
 * that totals match across different grouping dimensions.
 */
export interface ReconciliationResult {
  /** Primary checksum from the query */
  checksum: ReconciliationChecksum;

  /** Whether all dimensions match the grand total */
  verified: boolean;

  /** Per-dimension verification results */
  dimensions?: DimensionVerification[];

  /** Description of any discrepancy found */
  discrepancy?: string;

  /** Tolerance used for floating-point comparison */
  tolerance?: number;
}

/**
 * Verification result for a single dimension
 *
 * Each dimension (e.g., by GL account, by customer, by job) is verified
 * independently against the grand total.
 */
export interface DimensionVerification {
  /** Dimension field name (e.g., "account_id_id", "partner_id_id") */
  dimension: string;

  /** Total computed for this dimension (sum of all groups) */
  total: number;

  /** Number of groups in this dimension */
  group_count: number;

  /** Whether this dimension's total matches grand total */
  matches_grand_total: boolean;

  /** Difference from grand total (if any, for debugging) */
  difference?: number;

  /** Time taken to verify this dimension in ms */
  verification_time_ms?: number;
}

/**
 * Token estimation result for response sizing
 *
 * Returned by token estimator to help decide detail level.
 * Used in Stage 2+ for automatic routing.
 */
export interface TokenEstimationResult {
  /** Estimated token count for full response */
  estimated_tokens: number;

  /** Whether estimate exceeds threshold (default: 10,000) */
  exceeds_threshold: boolean;

  /** Recommended detail level based on token estimate */
  recommended_detail_level: 'summary' | 'top_n' | 'full';

  /** Token reduction if using recommended level (0-100%) */
  potential_reduction_percent?: number;

  /** Breakdown of token calculation */
  breakdown?: {
    base_tokens: number;
    variable_tokens: number;
    description: string;
  };
}

/**
 * Detail level for nexsus_search responses (Stage 2)
 *
 * Controls how much data is returned inline vs exported.
 */
export type DetailLevel = 'summary' | 'top_n' | 'full';

/**
 * Helper to generate short hash for reconciliation checksum
 *
 * Uses a simple hash of grand_total + record_count to create
 * a 6-character alphanumeric reference code.
 *
 * @param grandTotal - The total amount
 * @param recordCount - Number of records
 * @returns Hash string like "#A7B3C9"
 */
export function generateReconciliationHash(grandTotal: number, recordCount: number): string {
  // Simple hash: combine values and convert to base36
  const combined = Math.abs(grandTotal * 1000 + recordCount);
  const hash = combined.toString(36).toUpperCase().slice(-6).padStart(6, '0');
  return `#${hash}`;
}

/**
 * Create a ReconciliationChecksum from aggregation data
 *
 * @param grandTotal - Sum/total value
 * @param recordCount - Number of records processed
 * @param aggregationField - Field that was aggregated (e.g., "debit")
 * @param aggregationOp - Operation used (e.g., "sum")
 * @returns Complete checksum object
 */
export function createReconciliationChecksum(
  grandTotal: number,
  recordCount: number,
  aggregationField: string,
  aggregationOp: string = 'sum'
): ReconciliationChecksum {
  return {
    grand_total: grandTotal,
    hash: generateReconciliationHash(grandTotal, recordCount),
    record_count: recordCount,
    computed_at: new Date().toISOString(),
    aggregation_field: aggregationField,
    aggregation_op: aggregationOp,
  };
}

// =============================================================================
// KNOWLEDGE GRAPH TYPES (Cascading FK Sync)
// =============================================================================

/**
 * Relationship type for FK fields
 */
export type RelationshipType = 'many2one' | 'many2many' | 'one2many';

/**
 * Field category for semantic grouping in V2 vector text (Stage 6)
 *
 * Used to organize fields within semantic blocks for better embeddings.
 */
export type FieldCategory =
  | 'identity'      // Name, ID, reference fields
  | 'temporal'      // Dates, timestamps
  | 'financial'     // Amounts, costs, prices
  | 'foreign_key'   // Relational references (many2one)
  | 'status'        // State, flags, selections
  | 'content'       // Text, descriptions, notes
  | 'metadata'      // System fields, checksums
  | 'custom';       // Unsorted/custom fields

/**
 * Payload structure for relationship points in unified collection
 *
 * Stored with point_type='graph' in nexsus_unified.
 * Stores FK relationship metadata discovered during cascade sync.
 * Enables graph traversal and relationship discovery.
 */
export interface RelationshipPayload {
  /** V2 UUID for querying/filtering (same as Qdrant point ID) */
  point_id?: string;
  /** Type discriminator - V2 uses 'graph' for consistency */
  point_type: 'graph' | 'relationship';

  // Relationship definition
  /** Source model containing the FK (e.g., "account.move.line") */
  source_model: string;
  /** Source model ID in Odoo (e.g., 389) */
  source_model_id: number;
  /** FK field ID from ir.model.fields (for V2 Graph UUID) */
  field_id?: number;
  /** FK field name (e.g., "partner_id") */
  field_name: string;
  /** Human-readable field label (e.g., "Partner") */
  field_label: string;
  /** Relationship cardinality */
  field_type: RelationshipType;
  /** Target model referenced by FK (e.g., "res.partner") */
  target_model: string;
  /** Target model ID in Odoo (e.g., 78) */
  target_model_id: number;

  // Graph metadata
  /** True if target model has no outgoing FKs (endpoint) */
  is_leaf: boolean;
  /** How many hops from the origin model in cascade */
  depth_from_origin: number;

  // Statistics (updated on each cascade)
  /** Total edges discovered (for many2many, may exceed unique_targets) */
  edge_count: number;
  /** Unique target records referenced */
  unique_targets: number;
  /** Last cascade timestamp (ISO format) */
  last_cascade: string;
  /** Models that triggered this relationship discovery */
  cascade_sources: string[];

  // Semantic description
  /** Human-readable description for embedding */
  description: string;

  // Validation metadata (populated by FK validation with --store-orphans)
  /** When this edge was last validated (ISO timestamp) */
  last_validation?: string;
  /** Number of orphan FK references found for this relationship */
  orphan_count?: number;
  /** Integrity score for this specific FK relationship (0-100%) */
  validation_integrity_score?: number;
  /** Sample orphan records for debugging (limited to 10) */
  validation_samples?: OrphanInfo[];

  // Pattern metadata (Phase 3 - populated by analyze-patterns or validate-fk --extract-patterns)
  /** Cardinality classification: one_to_one, one_to_few, one_to_many */
  cardinality_class?: CardinalityClass;
  /** Ratio of unique_targets / edge_count (0-1) */
  cardinality_ratio?: number;
  /** Average references per target (edge_count / unique_targets) */
  avg_refs_per_target?: number;
  /** Rolling window of validation history (max 10 entries) */
  validation_history?: ValidationHistoryEntry[];
  /** Computed trend from validation history */
  integrity_trend?: 'improving' | 'stable' | 'degrading';
}

/**
 * Qdrant point for graph relationships in unified collection
 */
export interface RelationshipPoint {
  /** UUID: deterministic hash of "source_model|field_name|target_model" */
  id: string;
  /** 1024-dimensional embedding vector */
  vector: number[];
  /** Relationship metadata */
  payload: RelationshipPayload;
}

/**
 * Input for upserting a relationship
 */
export interface UpsertRelationshipInput {
  /** Source model containing the FK */
  source_model: string;
  /** Source model ID in Odoo */
  source_model_id: number;
  /** FK field ID from ir.model.fields (needed for V2 Graph UUID) */
  field_id: number;
  /** FK field name */
  field_name: string;
  /** Human-readable field label */
  field_label: string;
  /** Relationship cardinality */
  field_type: RelationshipType;
  /** Target model referenced by FK */
  target_model: string;
  /** Target model ID in Odoo */
  target_model_id: number;
  /** Total edges discovered */
  edge_count: number;
  /** Unique target records */
  unique_targets: number;
  /** True if target is a leaf model */
  is_leaf?: boolean;
  /** Depth from cascade origin */
  depth_from_origin?: number;
  /** Model that triggered this discovery */
  cascade_source?: string;
}

/**
 * Result from getModelRelationships
 */
export interface RelationshipInfo {
  /** FK field name */
  field_name: string;
  /** Human-readable label */
  field_label: string;
  /** Relationship type */
  field_type: RelationshipType;
  /** Target model */
  target_model: string;
  /** Target model ID */
  target_model_id: number;
  /** Number of edges */
  edge_count: number;
  /** Unique targets */
  unique_targets: number;
  /** Is target a leaf? */
  is_leaf: boolean;
  /** Qdrant point UUID */
  qdrant_id: string;
}

// =============================================================================
// FK VALIDATION TYPES (Graph-Enhanced Validation)
// =============================================================================

/**
 * Information about an orphan FK reference
 *
 * Represents a FK field value that points to a record that doesn't exist
 * in the Qdrant collection. Used during FK validation to track missing targets.
 */
export interface OrphanInfo {
  /** Source model containing the orphan FK (e.g., "account.move.line") */
  source_model: string;
  /** Source record ID that has the orphan FK */
  source_record_id: number;
  /** FK field name (e.g., "partner_id") */
  fk_field: string;
  /** Target model that should contain the record (e.g., "res.partner") */
  missing_target_model: string;
  /** Target record ID that is missing */
  missing_target_id: number;
  /** Missing target's Qdrant UUID */
  missing_uuid: string;
  /** When this orphan was detected (ISO timestamp) */
  detected_at: string;
}

/**
 * Validation result for a single FK field
 *
 * Contains statistics and samples for one FK field's validation.
 */
export interface FkFieldValidationResult {
  /** FK field name (e.g., "partner_id") */
  field_name: string;
  /** Target model for this FK */
  target_model: string;
  /** Target model ID */
  target_model_id: number;
  /** Total FK references found in data points */
  total_references: number;
  /** Number of references pointing to missing targets */
  missing_count: number;
  /** Sample orphan records (limited to prevent memory issues) */
  orphan_samples: OrphanInfo[];
}

/**
 * Complete validation report for a model
 *
 * Contains comprehensive FK integrity information for a single model.
 * Generated by the graph-enhanced FK validation process.
 */
export interface ValidationReport {
  /** Model that was validated (e.g., "account.move.line") */
  model_name: string;
  /** Model ID in Odoo */
  model_id: number;
  /** Total data records checked */
  total_records: number;
  /** FK fields that were validated */
  fk_fields_validated: FkFieldValidationResult[];
  /** Overall integrity score (0-100%) */
  integrity_score: number;
  /** Whether knowledge graph was used to guide validation */
  graph_metadata_used: boolean;
  /** Validation timestamp (ISO format) */
  validated_at: string;
  /** Validation duration in milliseconds */
  duration_ms: number;
}

/**
 * Extended RelationshipPayload with validation metadata
 *
 * Additional fields stored in graph edges after validation.
 * These fields are optional and only populated when --store-orphans is used.
 */
export interface ValidationMetadata {
  /** When this edge was last validated (ISO timestamp) */
  last_validation?: string;
  /** Number of orphan FK references found */
  orphan_count?: number;
  /** Integrity score for this specific FK relationship (0-100%) */
  integrity_score?: number;
  /** Sample orphan records for debugging (limited to 10) */
  validation_samples?: OrphanInfo[];
}

// =============================================================================
// BIDIRECTIONAL CONSISTENCY TYPES (Phase 2)
// =============================================================================

/**
 * Result of bidirectional consistency check for a single FK relationship
 *
 * Checks both directions:
 * - Forward: Do data points' FK counts match graph edge's edge_count?
 * - Reverse: Do all FK targets exist (no orphans)?
 */
export interface ConsistencyResult {
  /** Graph edge UUID */
  edge_id: string;
  /** Source model (e.g., "account.move.line") */
  source_model: string;
  /** Target model (e.g., "res.partner") */
  target_model: string;
  /** FK field name (e.g., "partner_id") */
  field_name: string;

  // Forward check: Data → Graph
  /** Actual FK reference count from data points */
  actual_fk_count: number;
  /** Edge count stored in graph edge */
  graph_edge_count: number;
  /** Forward is consistent if actual ≈ graph (within 5% tolerance) */
  forward_consistent: boolean;

  // Reverse check: Graph → Data (orphan detection)
  /** Number of orphan FK references (missing targets) */
  orphan_count: number;
  /** Reverse is consistent if orphan_count == 0 */
  reverse_consistent: boolean;

  // Summary
  /** Overall consistency (both directions pass) */
  is_consistent: boolean;
  /** Type of discrepancy if not consistent */
  discrepancy_type?: 'stale_graph' | 'orphan_fks' | 'both';
}

/**
 * Summary of bidirectional consistency check for a model
 */
export interface ConsistencyReport {
  /** Model that was checked */
  model_name: string;
  /** Model ID in Odoo */
  model_id: number;
  /** Total FK relationships checked */
  total_relationships: number;
  /** Relationships that are fully consistent */
  consistent_count: number;
  /** Relationships with forward discrepancies (stale graph) */
  stale_graph_count: number;
  /** Relationships with reverse discrepancies (orphans) */
  orphan_count: number;
  /** Detailed results per FK field */
  field_results: ConsistencyResult[];
  /** Check timestamp */
  checked_at: string;
  /** Check duration in milliseconds */
  duration_ms: number;
}

// =============================================================================
// PATTERN EXTRACTION TYPES (Phase 3)
// =============================================================================

/**
 * Cardinality classification for FK relationships
 * Calculated from: ratio = unique_targets / edge_count
 */
export type CardinalityClass =
  | 'one_to_one'   // ratio >= 0.95 (almost unique references)
  | 'one_to_few'   // ratio 0.2-0.95 (1-5 refs per target on average)
  | 'one_to_many'; // ratio < 0.2 (many refs per target)

/**
 * Model role classification in the relationship graph
 * Determined by incoming/outgoing degree thresholds
 */
export type ModelRole =
  | 'hub'       // High in + out (>10 both): central entity like res.partner
  | 'source'    // High out (>5), low in (<3): data originators like crm.lead
  | 'sink'      // High in (>5), low out (<3): aggregation points like account.account
  | 'leaf'      // Zero outgoing FKs: terminal nodes like crm.stage
  | 'bridge'    // Moderate both (3-10): connects clusters
  | 'isolated'; // Few total connections (<3): standalone entities

/**
 * Validation history entry for tracking integrity over time
 * Used for trend analysis (improving/stable/degrading)
 */
export interface ValidationHistoryEntry {
  /** ISO timestamp of validation */
  timestamp: string;
  /** Integrity score (0-100%) at this validation */
  integrity_score: number;
  /** Orphan count at this validation */
  orphan_count: number;
  /** Edge count at this validation */
  edge_count: number;
  /** Change from previous entry (positive = improvement) */
  delta_from_previous: number;
}

/**
 * Pattern metadata stored in graph edges (extends RelationshipPayload)
 */
export interface EdgePatternMetadata {
  /** Cardinality classification */
  cardinality_class: CardinalityClass;
  /** Ratio of unique_targets / edge_count */
  cardinality_ratio: number;
  /** Average references per target (edge_count / unique_targets) */
  avg_refs_per_target: number;
  /** Rolling window of last 10 validation entries */
  validation_history?: ValidationHistoryEntry[];
  /** Computed trend from validation history */
  integrity_trend?: 'improving' | 'stable' | 'degrading';
}

/**
 * Model-level pattern metadata (aggregated from edges)
 */
export interface ModelPatternMetadata {
  /** Model technical name */
  model_name: string;
  /** Model ID in Odoo */
  model_id: number;
  /** Model role in the graph */
  role: ModelRole;
  /** Number of incoming FK relationships */
  incoming_degree: number;
  /** Number of outgoing FK relationships */
  outgoing_degree: number;
  /** Total degree (in + out) */
  total_degree: number;
  /** Average integrity score across all outgoing FK fields */
  avg_integrity_score: number;
  /** FK field with lowest integrity */
  worst_fk_field?: string;
  /** Integrity score of worst FK field */
  worst_integrity_score?: number;
  /** Number of times this model has been validated */
  validation_count: number;
  /** First time this model was discovered */
  first_discovered?: string;
  /** Last time this model was validated */
  last_validated?: string;
}

/**
 * Complete pattern export for ML training
 */
export interface PatternExport {
  /** Export timestamp */
  export_timestamp: string;
  /** Export format version */
  version: string;
  /** Model-level pattern metadata */
  models: ModelPatternMetadata[];
  /** Edge-level patterns (extended with pattern metadata) */
  edges: Array<RelationshipPayload & Partial<EdgePatternMetadata>>;
  /** Summary statistics */
  summary: {
    total_models: number;
    total_edges: number;
    /** Models classified as hubs */
    hubs: string[];
    /** Models classified as sources */
    sources: string[];
    /** Models classified as sinks */
    sinks: string[];
    /** Models classified as leaves */
    leaves: string[];
    /** Average global integrity score */
    avg_global_integrity: number;
  };
}

// =============================================================================
// SIMILARITY SEARCH TYPES (Phase 4 - Same-Model Similarity)
// =============================================================================

/**
 * A similar record found within the same model
 *
 * Represents a record that is semantically similar to a reference record.
 * Similarity is calculated using cosine similarity on existing vector embeddings.
 */
export interface SimilarRecord {
  /** Qdrant UUID of the similar record */
  point_id: string;
  /** Odoo record ID */
  record_id: number;
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Cosine similarity score (0-1, higher = more similar) */
  similarity_score: number;
  /** Key payload fields for comparison (name, key identifiers) */
  payload_summary: Record<string, unknown>;
  /** Optional: Graph connection count (if graph_boost applied) */
  connection_count?: number;
}

/**
 * Result of find_similar tool
 *
 * Contains similar records found within the same model as the reference record.
 * Uses existing vector embeddings - no re-embedding required.
 */
export interface SimilaritySearchResult {
  /** Reference record that was searched from */
  reference_point_id: string;
  /** Reference record's Odoo ID */
  reference_record_id: number;
  /** Model name (e.g., "crm.lead") */
  model_name: string;
  /** Similar records found (ordered by similarity score) */
  similar_records: SimilarRecord[];
  /** Total records in model (for context) */
  total_model_records: number;
  /** Search parameters used */
  search_params: {
    /** Maximum results requested */
    limit: number;
    /** Minimum similarity threshold used */
    min_similarity: number;
    /** Whether graph boost was applied */
    graph_boost_applied: boolean;
  };
  /** Search duration in milliseconds */
  search_time_ms: number;
}

// =============================================================================
// UNIFIED DATA GRID TYPES (Phase 5)
// =============================================================================

/**
 * Enrichment options for data grid queries
 *
 * All flags default to false - base search path remains unchanged when
 * no enrichment is requested (zero performance impact on existing usage).
 */
export interface DataGridEnrichment {
  /** Include FK relationship context from knowledge graph */
  include_graph_context?: boolean;
  /** Include validation status (orphan FKs, integrity score) */
  include_validation_status?: boolean;
  /** Include similar records within same model */
  include_similar?: boolean;
  /** Number of similar records to include per result (default: 3, max: 5) */
  similar_limit?: number;
}

/**
 * Graph context for a record - FK relationships and connection counts
 */
export interface RecordGraphContext {
  /** Outgoing FK relationships from this record */
  outgoing_fks: Array<{
    field_name: string;
    target_model: string;
    target_record_id: number | null;
    target_qdrant_id: string | null;
  }>;
  /** Count of incoming references TO this record */
  incoming_reference_count: number;
  /** Models that reference this record */
  referencing_models: string[];
  /** Total connection count (for ranking) */
  total_connections: number;
}

/**
 * Validation status for a record - orphan FK detection
 */
export interface RecordValidationStatus {
  /** Does this record have orphan FK references? */
  has_orphan_fks: boolean;
  /** List of orphan FK fields */
  orphan_fk_fields: string[];
  /** Integrity score (100 = all FKs valid, 0 = all FKs orphan, -1 = error) */
  integrity_score: number;
  /** Last validation timestamp (if available from graph edge) */
  last_validated?: string;
  /** Diagnostic message explaining why validation may be incomplete */
  diagnostic?: string;
}

/**
 * Similar record summary - lightweight version for data grid
 */
export interface SimilarRecordSummary {
  /** Odoo record ID */
  record_id: number;
  /** Similarity score (0-1) */
  similarity_score: number;
  /** Display name (if available) */
  name?: string;
}

/**
 * Enriched record in data grid result
 */
export interface EnrichedRecord {
  /** Original record data */
  record: Record<string, unknown>;
  /** Qdrant point ID */
  point_id: string;
  /** Semantic similarity score (if from semantic search) */
  semantic_score?: number;
  /** Graph context (if include_graph_context=true) */
  graph_context?: RecordGraphContext;
  /** Validation status (if include_validation_status=true) */
  validation_status?: RecordValidationStatus;
  /** Similar records (if include_similar=true) */
  similar_records?: SimilarRecordSummary[];
}

/**
 * Data grid query result with optional intelligence layers
 */
export interface DataGridResult {
  /** Model being queried */
  model_name: string;
  /** Enriched records */
  records: EnrichedRecord[];
  /** Aggregation results (if requested) */
  aggregations?: Record<string, number>;
  /** Total matching records (before limit) */
  total_records: number;
  /** Query execution time in ms */
  query_time_ms: number;
  /** Which intelligence layers were used */
  intelligence_used: {
    semantic: boolean;
    graph: boolean;
    validation: boolean;
    similarity: boolean;
  };
  /** Performance breakdown (when enrichment enabled) */
  timing_breakdown?: {
    search_ms: number;
    graph_enrichment_ms: number;
    validation_enrichment_ms: number;
    similarity_enrichment_ms: number;
  };
}

/** Performance safeguards for data grid enrichment */
export const DATA_GRID_LIMITS = {
  /** Maximum records to enrich (prevents runaway queries) */
  MAX_ENRICHED_RECORDS: 10,
  /** Maximum similar records per result */
  MAX_SIMILAR_PER_RECORD: 3,
  /** Default similar records if not specified */
  DEFAULT_SIMILAR_LIMIT: 3,
} as const;

// =============================================================================
// JSON FK TYPES (Issue 2 - Analytic Distribution Resolution)
// =============================================================================

/**
 * JSON FK mapping configuration from json_fk_mappings.json
 *
 * Maps JSON fields (like analytic_distribution) to their target models.
 * The keys in these JSON fields are record IDs of the target model.
 */
export interface JsonFkMapping {
  /** Source model containing the JSON field */
  source_model: string;
  /** JSON field name (e.g., "analytic_distribution") */
  field_name: string;
  /** Target model for JSON keys (e.g., "account.analytic.account") */
  key_target_model: string;
  /** Target model ID in Odoo */
  key_target_model_id: number;
  /** How to interpret JSON keys: 'record_id' for numeric IDs */
  key_type: 'record_id' | 'code';
  /** How to interpret JSON values: 'percentage', 'amount', 'count' */
  value_type: 'percentage' | 'amount' | 'count';
  /** Optional description */
  description?: string;
}

/**
 * Complete JSON FK configuration loaded from file
 */
export interface JsonFkConfig {
  /** Configuration version */
  version: number;
  /** Description of the configuration */
  description?: string;
  /** List of JSON FK mappings */
  mappings: JsonFkMapping[];
}

/**
 * Resolved JSON FK entry - a single key-value pair with resolved name
 */
export interface ResolvedJsonFkEntry {
  /** Record ID (the JSON key) */
  record_id: number;
  /** Resolved display name from target model */
  name: string;
  /** Original value (percentage, amount, etc.) */
  value: number;
  /** Qdrant UUID of the target record */
  qdrant_id?: string;
}

/**
 * Result of JSON FK resolution for a field
 */
export interface JsonFkResolutionResult {
  /** Map of field_name -> Map of record_id -> ResolvedJsonFkEntry */
  resolved: Map<string, Map<number, ResolvedJsonFkEntry>>;
  /** Resolution statistics */
  stats: {
    /** Total keys to resolve */
    total: number;
    /** Keys successfully resolved */
    resolved: number;
    /** Keys that couldn't be resolved (orphans) */
    missing: number;
  };
}

// =============================================================================
// FILE EXPORT TYPES (Token Limitation - Stage 4)
// =============================================================================

/**
 * Result of file export operation
 *
 * Returned when export_to_file is true in nexsus_search.
 * Contains file location, metadata, and success status.
 *
 * Extended for R2 cloud storage:
 * - Local export: file_path is set, storage_type = 'local'
 * - R2 export: download_url is set, storage_type = 'r2'
 */
export interface FileExportResult {
  /** Whether export was successful */
  success: boolean;
  /** Full path to exported file (local exports only) */
  file_path: string;
  /** Filename only (for display) */
  filename: string;
  /** File size in bytes */
  file_size_bytes: number;
  /** Number of data rows exported */
  data_rows: number;
  /** Number of sheets created */
  sheet_count: number;
  /** Export duration in milliseconds */
  export_time_ms: number;
  /** Query that generated the export (for reference) */
  query_summary: string;
  /** Error message if export failed */
  error?: string;

  // R2 Cloud Storage Fields (added for Cloudflare R2 integration)
  /** Signed download URL (R2 exports only) */
  download_url?: string;
  /** URL expiration time (ISO timestamp, R2 exports only) */
  url_expires_at?: string;
  /** Storage type: 'local' for filesystem, 'r2' for Cloudflare R2 */
  storage_type?: 'local' | 'r2';
  /** R2 object key (R2 exports only) */
  r2_key?: string;
}

// =============================================================================
// CLOUDFLARE R2 TYPES (Excel Export with R2)
// =============================================================================

/**
 * Result of R2 upload operation
 *
 * Returned by uploadToR2() in r2-client.ts.
 * Contains signed URL for downloading the uploaded file.
 */
export interface R2UploadResult {
  /** Whether upload was successful */
  success: boolean;
  /** R2 object key (e.g., "exports/nexsus_export_20250103_142533.xlsx") */
  key: string;
  /** Signed download URL (valid for URL_EXPIRY_SECONDS) */
  download_url: string;
  /** URL expiration time (ISO timestamp) */
  expires_at: string;
  /** File size in bytes */
  size_bytes: number;
  /** Content type (e.g., "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") */
  content_type: string;
  /** Error message if upload failed */
  error?: string;
}

/**
 * Sheet data for Excel export
 *
 * Each sheet contains a name and array of row data.
 */
export interface ExcelSheetData {
  /** Sheet name (max 31 chars per Excel spec) */
  name: string;
  /** Array of row objects (first row becomes headers) */
  rows: Array<Record<string, unknown>>;
  /** Optional column widths (auto-calculated if not provided) */
  column_widths?: Record<string, number>;
}

/**
 * Excel export request
 *
 * Used internally by file-export service.
 */
export interface ExcelExportRequest {
  /** Sheets to include in the workbook */
  sheets: ExcelSheetData[];
  /** Filename without extension (auto-adds .xlsx) */
  filename: string;
  /** Query metadata for reconciliation sheet */
  metadata: {
    model_name: string;
    filters_summary: string;
    query_time_ms: number;
    reconciliation?: ReconciliationChecksum;
  };
}

// =============================================================================
// BLENDTHINK TYPES (Console Orchestration Layer)
// =============================================================================

/**
 * Question types that blendthink can route
 *
 * Each type maps to specific sections and personas for optimal handling.
 */
export type QuestionType =
  | 'precise_query'              // "What is the balance of account 123?"
  | 'discovery'                  // "Find hospital projects"
  | 'aggregation'                // "Total revenue by partner"
  | 'aggregation_with_discovery' // "Total revenue for hospital projects"
  | 'relationship'               // "How is this partner connected to...?"
  | 'explanation'                // "Why did this variance occur?"
  | 'comparison'                 // "Compare Q1 vs Q2 performance"
  | 'unknown';                   // Needs clarification

/**
 * Persona types for adaptive thinking
 *
 * Each persona has a distinct thinking style that shapes how
 * blendthink synthesizes and presents information.
 */
export type PersonaType =
  | 'forensic_analyst'   // Evidence-first, "the data shows..."
  | 'systems_thinker'    // Connection-finder, patterns
  | 'socratic_guide'     // Question-asker, leads through discovery
  | 'neutral';           // Default balanced response

/**
 * Sections that blendthink can route to
 */
export type BlendSection = 'exact' | 'semantic' | 'knowledge' | 'common';

/**
 * Result of question analysis
 *
 * Produced by QuestionAnalyzer to classify user queries
 * and extract actionable information for routing.
 */
export interface QuestionAnalysis {
  /** Original query text */
  query: string;

  /** Classified question type */
  type: QuestionType;

  /** Confidence in classification (0-1) */
  confidence: number;

  /** Extracted entities (names, IDs, keywords) */
  entities: string[];

  /** Detected operation (sum, count, list, etc.) */
  operation?: string;

  /** Field hints extracted from query */
  fieldHints?: string[];

  /** Model hints extracted from query */
  modelHints?: string[];

  /** Whether the query needs clarification */
  needsClarification?: boolean;

  /** Suggested clarification questions */
  clarificationQuestions?: string[];

  /**
   * Query complexity score (0-1) for simple mode bypass:
   * - < 0.3: Simple (single tool, direct lookup)
   * - 0.3-0.7: Medium (multiple tools, some synthesis)
   * - > 0.7: Complex (multi-section, explanation needed)
   */
  complexity?: number;

  /**
   * Whether this query can use simple mode (bypass inner Claude)
   * True for: exact ID lookups, single model scans, simple counts
   */
  canBypassSynthesis?: boolean;

  /**
   * GROUP BY hints extracted from "by <field>" patterns
   * Examples: "revenue by partner" → ['partner_id']
   *           "expenses by account by month" → ['account_id', 'date']
   */
  groupByHints?: string[];

  /**
   * Whether this is a drilldown of previous results
   * Detected from patterns like "show me by X", "break down by", "export this"
   */
  isDrilldown?: boolean;

  /**
   * Type of drilldown operation requested
   * - regroup: Change GROUP BY dimension
   * - expand: Show underlying records
   * - export: Export to Excel
   * - filter: Add additional filter
   * - sort: Re-sort results
   */
  drilldownOperation?: 'regroup' | 'expand' | 'export' | 'filter' | 'sort';

  /**
   * New grouping dimension for regroup drilldown
   * e.g., "show by customer" → ['partner_id_id']
   */
  drilldownGroupBy?: string[];

  /**
   * Group key to expand (for expand drilldown)
   */
  drilldownExpandKey?: string;
}

/**
 * Routing decision for a section
 *
 * Specifies what tool to call in which section
 * as part of a multi-step routing plan.
 */
export interface RouteStep {
  /** Target section */
  section: BlendSection;

  /** Tool to call in that section */
  tool: string;

  /** Parameters for the tool call */
  params: Record<string, unknown>;

  /** Order in execution sequence (1 = first) */
  order: number;

  /** Why this section was chosen */
  reason: string;

  /** Whether this step depends on previous step results */
  dependsOnPrevious: boolean;

  /**
   * Dependency level for parallel execution grouping:
   * - Level 0: No dependencies, can run immediately (parallel group 1)
   * - Level 1: Depends on level 0 results
   * - Level 2: Depends on chain context from level 0+1
   */
  dependencyLevel?: number;
}

/**
 * Complete routing plan
 *
 * The full execution strategy for answering a query,
 * including which sections to query and which to skip.
 */
export interface RoutePlan {
  /** Steps to execute */
  steps: RouteStep[];

  /** Sections explicitly skipped and why */
  skipped: Array<{ section: BlendSection; reason: string }>;

  /** Estimated token budget for this plan */
  estimatedTokens: number;

  /** Whether steps can be executed in parallel */
  canParallelize: boolean;
}

/**
 * A single turn in a conversation
 *
 * Represents one user query or assistant response
 * in a multi-turn blendthink session.
 */
export interface ConversationTurn {
  /** Unique turn ID */
  id: string;

  /** Role: user or assistant */
  role: 'user' | 'assistant';

  /** Content of the turn */
  content: string;

  /** Timestamp */
  timestamp: Date;

  /** Question analysis (for user turns) */
  analysis?: QuestionAnalysis;

  /** Route plan (for user turns) */
  routePlan?: RoutePlan;

  /** Sections that contributed (for assistant turns) */
  sources?: Array<{
    section: BlendSection;
    tool: string;
    contribution: string;
    dataPoints?: number;
  }>;

  /** Confidence in response (for assistant turns) */
  confidence?: number;

  /** Token usage for this turn */
  tokenUsage?: {
    input: number;
    output: number;
  };
}

/**
 * Conversation session with memory
 *
 * Manages the full state of a multi-turn blendthink session,
 * including history, persona, and token tracking.
 */
export interface BlendthinkSession {
  /** Unique session ID */
  sessionId: string;

  /** All turns in this session */
  turns: ConversationTurn[];

  /** Current persona being used */
  activePersona: PersonaType;

  /** Token usage so far */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    budget: number;
  };

  /** Session start time */
  startedAt: Date;

  /** Last activity time */
  lastActivityAt: Date;

  /** Whether session is still active */
  active: boolean;

  /** Number of refinement turns used */
  refinementTurnsUsed: number;
}

/**
 * Blend result with full attribution
 *
 * The final synthesized answer from blendthink,
 * including sources, reasoning, and confidence.
 */
export interface BlendResult {
  /** The synthesized response */
  response: string;

  /** Source attribution */
  sources: Array<{
    section: BlendSection;
    tool: string;
    contribution: string;
    dataPoints?: number;
  }>;

  /** Confidence score (0-1) */
  confidence: number;

  /** Question type that was detected */
  questionType: QuestionType | string;

  /** Persona used for synthesis */
  persona: string;

  /** Session information */
  session: {
    sessionId: string;
    turnsUsed: number;
    turnsRemaining: number;
    tokenUsage: {
      input: number;
      output: number;
      total: number;
      budget: number;
    };
  };

  /** Results from each section */
  sectionResults: Array<{
    section: BlendSection;
    tool: string;
    success: boolean;
    recordCount?: number;
    error?: string;
  }>;

  /** Timing information */
  timing: {
    totalMs: number;
    analysisMs: number;
    sectionMs: number;
    synthesisMs: number;
  };

  /** Error message if failed */
  error?: string;

  /** Whether clarification is needed */
  needsClarification?: boolean;

  /** Suggested clarification questions */
  clarificationQuestions?: string[];
}

/**
 * Blendthink configuration
 *
 * Controls behavior of the blendthink engine,
 * including limits, thresholds, and feature flags.
 */
export interface BlendthinkConfig {
  /** Maximum turns before forcing synthesis */
  maxTurns: number;

  /** Maximum tokens per session */
  tokenBudget: number;

  /** Minimum confidence to return answer (vs admit uncertainty) */
  confidenceThreshold: number;

  /** Whether to require source attribution */
  requireAttribution: boolean;

  /** Claude API model to use */
  claudeModel: string;

  /** Whether to persist conversations to Qdrant */
  persistConversations: boolean;
}

/**
 * Conversation memory point (for Qdrant storage)
 *
 * Stored in nexsus_unified with point_type='conversation'
 * to enable semantic recall across sessions.
 */
export interface ConversationPayload {
  /** Point type discriminator */
  point_type: 'conversation';

  /** Session ID this turn belongs to */
  session_id: string;

  /** Turn number within session */
  turn_number: number;

  /** Role */
  role: 'user' | 'assistant';

  /** Raw content */
  content: string;

  /** Question type (for user turns) */
  question_type?: QuestionType;

  /** Sections queried (for assistant turns) */
  sections_queried?: BlendSection[];

  /** Confidence score (for assistant turns) */
  confidence?: number;

  /** Timestamp ISO string */
  timestamp: string;

  /** Vector text that was embedded */
  vector_text: string;
}

/**
 * Persona definition
 *
 * Defines a thinking style with its system prompt
 * and behavioral characteristics.
 */
export interface PersonaDefinition {
  /** Persona type identifier */
  type: PersonaType;

  /** Display name */
  name: string;

  /** Short description */
  description: string;

  /** System prompt for Claude API */
  systemPrompt: string;

  /** Question types this persona handles best */
  bestFor: QuestionType[];

  /** Behavioral traits */
  traits: {
    /** How to frame claims (e.g., "the data shows...") */
    claimPrefix?: string;
    /** Emphasis on evidence vs exploration */
    evidenceEmphasis: 'high' | 'medium' | 'low';
    /** Whether to ask follow-up questions */
    asksFollowUps: boolean;
  };
}

// =============================================================================
// EXTENDED KNOWLEDGE TYPES (4-Level Knowledge Template)
// =============================================================================

/**
 * Knowledge level discriminator for 4-level knowledge template
 *
 * - universal: Level 1 - Static knowledge for all Nexsus (markdown files)
 * - instance: Level 2 - MCP instance configuration (from Excel)
 * - model: Level 3 - Table/model metadata (from Excel)
 * - field: Level 4 - Field-level knowledge (from Excel)
 */
export type KnowledgeLevel = 'universal' | 'instance' | 'model' | 'field';

/**
 * Extended Knowledge Payload - Union type for all knowledge levels
 *
 * Stored in Qdrant with:
 * - point_type: 'knowledge'
 * - knowledge_level: one of KnowledgeLevel values
 *
 * UUID Format: 00000005-LLLL-MMMM-0000-IIIIIIIIIIII
 * Where:
 * - 00000005 = Extended knowledge namespace
 * - LLLL = Level (0002=instance, 0003=model, 0004=field)
 * - MMMM = Model_ID (0000 for instance level)
 * - IIIIIIIIIIII = Item index or Field_ID
 */
export interface ExtendedKnowledgePayload {
  // Common (all levels)
  point_type: 'knowledge';
  knowledge_level: KnowledgeLevel;
  vector_text: string;
  sync_timestamp: string;

  // Level 2 (Instance) - MCP instance configuration
  config_key?: string;
  config_value?: string;
  config_category?: string;
  description?: string;
  applies_to?: string;
  llm_instruction?: string;

  // Level 3 (Model) - Table/model metadata
  model_id?: number;
  model_name?: string;
  business_name?: string;
  business_purpose?: string;
  data_grain?: string;
  record_count?: number;
  is_payload_enabled?: boolean;
  primary_use_cases?: string;
  key_relationships?: string;
  llm_query_guidance?: string;
  known_issues?: string;

  // Level 4 (Field) - Field-level knowledge
  field_id?: number;
  field_name?: string;
  field_label?: string;
  field_type?: string;
  field_knowledge?: string;
  valid_values?: string[];
  data_format?: string;
  calculation_formula?: string;
  validation_rules?: string;
  llm_usage_notes?: string;

  // Common optional fields
  last_updated?: string;
}

/**
 * Type guard to check if payload is ExtendedKnowledgePayload
 */
export function isKnowledgePayload(payload: unknown): payload is ExtendedKnowledgePayload {
  if (!payload || typeof payload !== 'object') return false;
  return (payload as ExtendedKnowledgePayload).point_type === 'knowledge';
}

/**
 * Get knowledge level from payload
 */
export function getKnowledgeLevel(payload: ExtendedKnowledgePayload): KnowledgeLevel {
  return payload.knowledge_level;
}

// =============================================================================
// SECTION ADAPTER TYPES (Shared by all section adapters)
// =============================================================================

/**
 * Result from executing a section adapter
 *
 * Used by all section adapters (exact, semantic, knowledge, graph)
 * to return data to the blendthink engine.
 */
export interface SectionResult {
  /** Which section this result came from */
  section: BlendSection;

  /** Which tool was called */
  tool: string;

  /** Whether the execution succeeded */
  success: boolean;

  /** The data returned (format varies by section) */
  data: unknown;

  /** Number of records found/processed */
  recordCount?: number;

  /** Estimated token count for this result */
  tokenEstimate: number;

  /** Error message if success=false */
  error?: string;

  /** Execution time in milliseconds */
  executionTimeMs?: number;
}

/**
 * Shared context passed to all adapters
 *
 * Provides configuration and limits for adapter execution.
 */
export interface AdapterContext {
  /** Maximum records to return (default: 100) */
  maxRecords: number;

  /** Token budget remaining */
  tokenBudgetRemaining: number;

  /** Whether to include detailed payloads */
  includePayloads: boolean;

  /** Session ID for logging */
  sessionId?: string;
}

/**
 * Default adapter context values
 */
export const DEFAULT_ADAPTER_CONTEXT: AdapterContext = {
  maxRecords: 100,
  tokenBudgetRemaining: 50000,
  includePayloads: true,
};

/**
 * Base interface for all section adapters
 *
 * Implemented by adapters in each section (exact, semantic, knowledge, graph)
 * to execute route plan steps and return results.
 */
export interface SectionAdapter {
  /** Section this adapter handles */
  readonly section: BlendSection;

  /**
   * Execute a route step and return results
   *
   * @param step - The route step to execute
   * @param analysis - Question analysis with entities/hints
   * @returns Section result with data or error
   */
  execute(step: RouteStep, analysis: QuestionAnalysis): Promise<SectionResult>;
}
