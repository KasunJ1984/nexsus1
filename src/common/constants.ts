/**
 * Constants for Nexsus MCP Server
 *
 * V2 UUID Format:
 * - Data:   00000002-MMMM-0000-0000-RRRRRRRRRRRR
 * - Schema: 00000003-0004-0000-0000-FFFFFFFFFFFF
 * - Graph:  00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF
 */

// =============================================================================
// ENVIRONMENT CONFIGURATION
// =============================================================================

/**
 * Odoo configuration (KEPT FOR PHASE 2)
 */
export const ODOO_CONFIG = {
  URL: process.env.ODOO_URL || '',
  DB: process.env.ODOO_DB || '',
  USERNAME: process.env.ODOO_USERNAME || '',
  PASSWORD: process.env.ODOO_PASSWORD || '',
  /** Web URL for generating clickable Odoo links (falls back to URL if not set) */
  WEB_URL: process.env.ODOO_WEB_URL || process.env.ODOO_URL || '',
} as const;

/**
 * Qdrant vector database configuration
 */
export const QDRANT_CONFIG = {
  HOST: process.env.QDRANT_HOST || 'http://localhost:6333',
  API_KEY: process.env.QDRANT_API_KEY || '',
  COLLECTION: process.env.SCHEMA_COLLECTION_NAME || 'odoo_schema',
  VECTOR_SIZE: parseInt(process.env.VECTOR_SIZE || process.env.EMBEDDING_DIMENSIONS || '512', 10),
  DISTANCE_METRIC: 'Cosine' as const,
  // Scalar Quantization: Reduces memory by 75% (float32 → int8)
  // Set ENABLE_SCALAR_QUANTIZATION=false to disable
  ENABLE_SCALAR_QUANTIZATION: process.env.ENABLE_SCALAR_QUANTIZATION !== 'false',
  SCALAR_QUANTILE: parseFloat(process.env.SCALAR_QUANTILE || '0.99'),
  // Search optimization params for quantized vectors
  SEARCH_RESCORE: process.env.SEARCH_RESCORE !== 'false',
  SEARCH_OVERSAMPLING: parseFloat(process.env.SEARCH_OVERSAMPLING || '2.0'),
  // HNSW Configuration (tuned for 150K+ vectors in single collection)
  // m: connections per node - higher = better recall, more memory
  // ef_construct: build-time quality - one-time cost
  // ef_search: query-time exploration - higher = better recall, slower
  HNSW_M: parseInt(process.env.HNSW_M || '32', 10),
  HNSW_EF_CONSTRUCT: parseInt(process.env.HNSW_EF_CONSTRUCT || '200', 10),
  HNSW_EF_SEARCH: parseInt(process.env.HNSW_EF_SEARCH || '128', 10),
} as const;

/**
 * Nexsus Excel configuration
 *
 * Configuration for reading schema from Excel files.
 * Uses nexsus_schema_v2_generated.xlsx with FK metadata.
 * Note: Collection is now unified (nexsus_unified) - see UNIFIED_CONFIG.
 */
export const NEXSUS_CONFIG = {
  /** Path to Excel schema file (V2 format with FK metadata) */
  EXCEL_FILE: process.env.NEXSUS_EXCEL_FILE || 'nexsus_schema_v2_generated.xlsx',
  /** Vector dimensions (Voyage AI) */
  VECTOR_SIZE: parseInt(process.env.VECTOR_SIZE || '1024', 10),
} as const;

/**
 * Voyage AI embedding configuration
 */
export const VOYAGE_CONFIG = {
  API_KEY: process.env.VOYAGE_API_KEY || '',
  MODEL: process.env.EMBEDDING_MODEL || 'voyage-3.5-lite',
  DIMENSIONS: parseInt(process.env.VECTOR_SIZE || process.env.EMBEDDING_DIMENSIONS || '512', 10),
  MAX_BATCH_SIZE: 128,
  INPUT_TYPE_DOCUMENT: 'document' as const,
  INPUT_TYPE_QUERY: 'query' as const,
} as const;

// =============================================================================
// SCHEMA DATA CONFIGURATION
// =============================================================================

/**
 * Schema data file path
 */
export const SCHEMA_CONFIG = {
  DATA_FILE: process.env.SCHEMA_DATA_FILE || 'data/odoo_schema.txt',
  FIELD_DELIMITER: '|',    // Separates fields in encoded row
  VALUE_DELIMITER: '*',    // Separates prefix code from value
} as const;

/**
 * Schema prefix codes for internal parsing
 */
export const SCHEMA_PREFIX_CODES = {
  NUMERIC_ID: '4^58',
  FIELD_NAME: '4^26',
  FIELD_LABEL: '4^33',
  FIELD_TYPE: '4^35',
  MODEL_NAME: '4^28',
  PRIMARY_LOCATION: '4^60000',
  STORED: '4^57',
  PRIMARY_REF: '4^60001',
} as const;

/**
 * Column positions in encoded schema row (0-indexed)
 */
export const SCHEMA_COLUMN_INDEX = {
  MODEL_ID: 0,
  FIELD_ID: 1,
  FIELD_NAME: 2,
  FIELD_LABEL: 3,
  FIELD_TYPE: 4,
  MODEL_NAME: 5,
  PRIMARY_LOCATION: 6,
  STORED: 7,
  PRIMARY_REF: 8,
} as const;

// =============================================================================
// SIMILARITY THRESHOLDS
// =============================================================================

/**
 * Similarity score thresholds for semantic search
 */
export const SIMILARITY_THRESHOLDS = {
  VERY_SIMILAR: 0.8,           // Near-duplicate
  MEANINGFULLY_SIMILAR: 0.6,   // Good match (default)
  LOOSELY_RELATED: 0.4,        // Weak match
  DEFAULT_MIN: 0.5,            // Default minimum score
} as const;

// =============================================================================
// SYNC CONFIGURATION
// =============================================================================

/**
 * Batch sizes for sync operations
 */
export const SYNC_CONFIG = {
  BATCH_SIZE: 100,             // Records per batch for embedding
  MAX_RECORDS: 20000,          // Maximum records to process (17,930 fields)
  TIMEOUT_MS: 30000,           // Timeout for API calls
} as const;

// =============================================================================
// SEARCH DEFAULTS
// =============================================================================

/**
 * Default search parameters
 */
export const SEARCH_DEFAULTS = {
  LIMIT: 10,                   // Default number of results
  MIN_SIMILARITY: 0.5,         // Default minimum similarity
} as const;

// =============================================================================
// CACHE CONFIGURATION
// =============================================================================

/**
 * LRU Query Cache configuration
 *
 * Caches search results to avoid redundant Qdrant queries.
 * Especially valuable with scalar quantization (rescore overhead).
 * Cleared automatically after schema sync.
 */
export const CACHE_CONFIG = {
  MAX_ENTRIES: parseInt(process.env.CACHE_MAX_ENTRIES || '500', 10),
  TTL_MS: parseInt(process.env.CACHE_TTL_MS || '1800000', 10), // 30 minutes
  ENABLED: process.env.CACHE_ENABLED !== 'false',
} as const;

/**
 * Graph search cache configuration
 *
 * Caches graph context (FK relationships) to avoid repeated Qdrant queries.
 * TTL is configurable via GRAPH_CACHE_TTL_MS environment variable.
 */
export const GRAPH_CACHE_CONFIG = {
  /** Cache TTL for graph context (milliseconds) - default 5 minutes */
  TTL_MS: parseInt(process.env.GRAPH_CACHE_TTL_MS || '300000', 10),
} as const;

// =============================================================================
// DATA TRANSFORMER CONFIGURATION (Phase 2 - Data Encoding)
// =============================================================================

/**
 * Data transformer configuration
 *
 * Model configurations are DYNAMIC - automatically discovered from schema.
 */
export const DATA_TRANSFORM_CONFIG = {
  /** Records per Odoo API call (increased from 200 to reduce API calls) */
  FETCH_BATCH_SIZE: 500,
  /** Records per embedding API call (reduced from 100 to avoid Voyage token limits with many fields) */
  EMBED_BATCH_SIZE: 50,
  /**
   * Point ID multiplier to ensure no clash with schema field_ids
   * Point ID = model_id * 10_000_000 + record_id
   * Example: crm.lead (344) record 12345 = 3440012345
   */
  MODEL_ID_MULTIPLIER: 10_000_000,
  /** Trigger code required to confirm data sync */
  SYNC_CODE: '1984',
} as const;

// =============================================================================
// NEXUS KEY FIELDS CONFIGURATION
// =============================================================================

/**
 * Key fields to display for each model in decoded NEXUS output
 *
 * These fields are shown first and always displayed in search results.
 * The analytics system will suggest additional fields based on usage.
 *
 * Field order determines display priority (first = most important).
 */
export const KEY_FIELDS_CONFIG: Record<string, readonly string[]> = {
  'crm.lead': [
    'name',              // Opportunity name (most important)
    'expected_revenue',  // Deal value
    'probability',       // Win probability %
    'partner_id',        // Customer (FK → res.partner)
    'stage_id',          // Pipeline stage (FK → crm.stage)
    'user_id',           // Salesperson (FK → res.users)
    'city',              // Location
    'active',            // Active/Archived status
  ],
  // Future models can be added:
  // 'res.partner': ['name', 'email', 'phone', 'city', 'is_company'],
  // 'crm.stage': ['name', 'sequence'],
} as const;

// =============================================================================
// NEXUS ANALYTICS CONFIGURATION
// =============================================================================

/**
 * Configuration for the self-improving analytics system
 *
 * The analytics service tracks field usage to discover which fields
 * are most important to users and automatically suggests promotions.
 */
export const ANALYTICS_CONFIG = {
  /** File path for persisted analytics data */
  DATA_FILE: 'data/analytics.json',
  /** Maximum number of field usage records to track */
  MAX_FIELD_ENTRIES: 5000,
  /** How often to persist analytics to disk (ms) */
  PERSIST_INTERVAL_MS: 60000, // 1 minute
  /** Clear analytics when schema changes */
  CLEAR_ON_SCHEMA_CHANGE: true,
  /** Minimum score (0-100) to promote a field to key fields */
  PROMOTION_THRESHOLD: 50,
  /** Maximum key fields per model */
  MAX_KEY_FIELDS: 12,
} as const;

// =============================================================================
// NEXUS TRAINING DATA CONFIGURATION
// =============================================================================

/**
 * Configuration for training data collection (Phase 2 preparation)
 *
 * Training pairs (NEXUS encoded → human readable) are collected
 * during decode operations for future model training.
 */
export const TRAINING_CONFIG = {
  /** Maximum number of training pairs to keep in memory */
  MAX_PAIRS: 10000,
  /** File path for persisted training data */
  DATA_FILE: 'data/training.json',
} as const;

// =============================================================================
// PIPELINE CONFIGURATION
// =============================================================================

/**
 * Data Pipeline Configuration
 *
 * Excel Files:
 * - feilds_to_add_payload.xlsx: Defines which fields go in payload (payload=1)
 * - nexsus_schema_v2_generated.xlsx: Schema with FK metadata (via loadNexsusSchema)
 *
 * Vector IDs use V2 UUID format: 00000002-MMMM-0000-0000-RRRRRRRRRRRR
 */
export const PIPELINE_CONFIG = {
  /** Excel file that defines which fields go in payload (payload=1) */
  PAYLOAD_FIELDS_FILE: process.env.PIPELINE_PAYLOAD_FILE || 'feilds_to_add_payload.xlsx',

  /** Vector dimensions (Voyage AI voyage-3.5-lite uses 1024) */
  VECTOR_SIZE: parseInt(process.env.PIPELINE_VECTOR_SIZE || '1024', 10),

  // Batch sizes
  /** Records per Odoo API call */
  FETCH_BATCH_SIZE: parseInt(process.env.PIPELINE_FETCH_BATCH || '500', 10),
  /** Records per embedding API call */
  EMBED_BATCH_SIZE: parseInt(process.env.PIPELINE_EMBED_BATCH || '50', 10),
  /** Points per Qdrant upsert */
  UPSERT_BATCH_SIZE: parseInt(process.env.PIPELINE_UPSERT_BATCH || '100', 10),

  // Sync configuration
  /** Trigger code to confirm sync operation */
  SYNC_CODE: '1984',
  /** File to store sync metadata */
  METADATA_FILE: 'data/pipeline_sync_metadata.json',

  // Vector text format prefix
  /** Prefix for human-readable vector text */
  VECTOR_TEXT_PREFIX: 'In model',
} as const;

// =============================================================================
// KNOWLEDGE GRAPH CONFIGURATION
// =============================================================================

/**
 * Configuration for knowledge graph (FK relationships)
 *
 * Note: Graph data now stored in unified collection (nexsus_unified)
 * with point_type='graph'. See UNIFIED_CONFIG.
 *
 * Schema:
 * - source_model: Model that contains the FK (e.g., "account.move.line")
 * - field_name: FK field name (e.g., "partner_id")
 * - target_model: Model referenced by FK (e.g., "res.partner")
 * - field_type: Relationship cardinality (many2one, many2many, one2many)
 * - edge_count: Total FK references discovered
 * - is_leaf: True if target model has no outgoing FKs
 */
export const GRAPH_CONFIG = {
  /** Vector dimensions (same as unified collection) */
  VECTOR_SIZE: parseInt(process.env.PIPELINE_VECTOR_SIZE || '1024', 10),
  /** Distance metric */
  DISTANCE_METRIC: 'Cosine' as const,
} as const;

// ============================================================================
// V2 UUID CONSTANTS (Stage 1)
// ============================================================================

/**
 * UUID Namespace Prefixes (V2 Format)
 *
 * Each namespace identifies the data type in an 8-digit prefix:
 * - 00000001 = Knowledge graph relationships
 * - 00000002 = Data points (records)
 * - 00000003 = Schema (field definitions)
 */
export const UUID_NAMESPACES = {
  GRAPH: '00000001',      // Knowledge graph relationships
  DATA: '00000002',       // Data points (records)
  SCHEMA: '00000003',     // Schema (field definitions)
} as const;

/**
 * Relationship Type Codes (V2 Format)
 *
 * Used in graph UUID: 00000001-SSSS-TTTT-RRFFFFFFFFFF
 * Where RR is the 2-digit relationship code.
 */
export const RELATIONSHIP_TYPES = {
  ONE_TO_ONE: '11',       // one2one (rare in Odoo)
  ONE_TO_MANY: '21',      // one2many
  MANY_TO_ONE: '31',      // many2one (most common FK)
  MANY_TO_MANY: '41',     // many2many
} as const;

/**
 * Mapping from Odoo ttype to relationship code
 */
export const TTYPE_TO_RELATIONSHIP_CODE: Record<string, string> = {
  'one2one': '11',
  'one2many': '21',
  'many2one': '31',
  'many2many': '41',
};

// ============================================================================
// UNIFIED COLLECTION CONFIGURATION (Stage 2)
// ============================================================================

/**
 * Configuration for the unified nexsus collection
 *
 * ALL data (Schema, Data, Graph) is stored in a single collection.
 * Uses V2 UUID format for all point IDs:
 * - 00000001-* = Graph (relationships, point_type='graph')
 * - 00000002-* = Data (records, point_type='data')
 * - 00000003-* = Schema (field definitions, point_type='schema')
 *
 * Benefits:
 * - Cross-type semantic search (query returns schema + data + relationships)
 * - Logical clustering via namespace prefixes
 * - Bidirectional navigation between data types
 * - Simplified architecture (one collection, one backup)
 */
export const UNIFIED_CONFIG = {
  /** Collection name - the ONLY collection used by Nexsus */
  COLLECTION_NAME: process.env.UNIFIED_COLLECTION_NAME || 'nexsus_unified',
  /** Vector dimensions (Voyage AI voyage-3.5-lite) */
  VECTOR_SIZE: 1024,
  /** Distance metric */
  DISTANCE_METRIC: 'Cosine' as const,
  /** Scalar quantization for 75% memory reduction */
  ENABLE_SCALAR_QUANTIZATION: true,
  SCALAR_QUANTILE: 0.99,
  /** HNSW config (tuned for 600K+ vectors) */
  HNSW_M: 32,
  HNSW_EF_CONSTRUCT: 200,
  HNSW_EF_SEARCH: 128,
} as const;

// ============================================================================
// TOKEN MANAGEMENT CONFIGURATION (Token Limitation - Stage 1)
// ============================================================================

/**
 * Token management for intelligent response sizing
 *
 * Prevents context window overflow by:
 * 1. Estimating token usage before returning large results
 * 2. Automatically routing to summary/export when threshold exceeded
 * 3. Providing reconciliation checksums for data verification
 *
 * Token estimation formulas (empirically derived):
 * - Aggregation (no GROUP BY): ~300 tokens
 * - Aggregation (N groups): ~300 + (N × 50) tokens
 * - Record retrieval (N records): ~250 + (N × 100) tokens
 */
export const TOKEN_MANAGEMENT = {
  // ==========================================================================
  // Thresholds
  // ==========================================================================

  /** Token threshold for auto-export (default: 10,000) */
  TOKEN_THRESHOLD: parseInt(process.env.TOKEN_THRESHOLD || '10000', 10),

  /** Default number of top groups to show in top_n mode */
  TOP_N_DEFAULT: parseInt(process.env.TOP_N_DEFAULT || '10', 10),

  /** Maximum top_n value allowed */
  TOP_N_MAX: 100,

  // ==========================================================================
  // Token Estimation Constants (empirically derived)
  // ==========================================================================

  /** Base tokens for aggregation result header/metadata */
  BASE_AGGREGATION_TOKENS: 300,

  /** Tokens per group in grouped aggregation (table row + values) */
  TOKENS_PER_GROUP: 50,

  /** Base tokens for record retrieval header/metadata */
  BASE_RECORD_TOKENS: 250,

  /** Tokens per record in retrieval results (JSON + field values) */
  TOKENS_PER_RECORD: 100,

  // ==========================================================================
  // Output Format Token Estimates
  // ==========================================================================

  /** Tokens for summary format output (grand total + metrics only) */
  SUMMARY_FORMAT_TOKENS: 400,

  /** Base tokens for top_n format (header + footer) */
  TOP_N_BASE_TOKENS: 300,

  /** Tokens per item in top_n format */
  TOP_N_PER_ITEM_TOKENS: 50,

  // ==========================================================================
  // Decision Thresholds (percentage of TOKEN_THRESHOLD)
  // ==========================================================================

  /** Below this percentage of threshold, show full results */
  FULL_THRESHOLD_PERCENT: 0.2,

  /** Above this percentage, recommend summary mode */
  SUMMARY_THRESHOLD_PERCENT: 1.0,
} as const;

// ============================================================================
// FILE EXPORT CONFIGURATION (Token Limitation - Stage 4)
// ============================================================================

/**
 * Configuration for local file export
 *
 * Excel files are saved to data/exports/ directory with timestamped filenames.
 * Supports both aggregation results and record retrieval exports.
 */
export const EXPORT_CONFIG = {
  /** Base directory for exports (relative to project root) */
  EXPORT_DIR: process.env.EXPORT_DIR || 'data/exports',

  /** Default filename prefix */
  DEFAULT_PREFIX: 'nexsus_export',

  /** Maximum filename length (excluding extension) */
  MAX_FILENAME_LENGTH: 50,

  /** Excel sheet name limits */
  SHEET_NAME: {
    /** Maximum sheet name length per Excel spec */
    MAX_LENGTH: 31,
    /** Data sheet name */
    DATA_SHEET: 'Data',
    /** Reconciliation sheet name */
    RECONCILIATION_SHEET: 'Reconciliation',
  },

  /** Column width defaults */
  COLUMN_WIDTHS: {
    /** Default width for unknown columns */
    DEFAULT: 15,
    /** Width for numeric columns */
    NUMERIC: 12,
    /** Width for date columns */
    DATE: 12,
    /** Width for text columns */
    TEXT: 25,
    /** Maximum column width */
    MAX: 50,
  },
} as const;

// ============================================================================
// CLOUDFLARE R2 CONFIGURATION (Excel Export with R2)
// ============================================================================

/**
 * Cloudflare R2 configuration for cloud-based Excel exports
 *
 * R2 is S3-compatible object storage with zero egress fees.
 * Used when exporting large result sets that can't be returned inline.
 *
 * Required environment variables (all 4 must be set to enable):
 * - R2_ACCOUNT_ID: Your Cloudflare account ID
 * - R2_ACCESS_KEY_ID: R2 API token access key
 * - R2_SECRET_ACCESS_KEY: R2 API token secret
 * - R2_BUCKET_NAME: R2 bucket name (e.g., "nexsus-exports")
 */
export const R2_CONFIG = {
  /** Cloudflare account ID */
  ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  /** R2 API token access key */
  ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
  /** R2 API token secret */
  SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  /** R2 bucket name */
  BUCKET_NAME: process.env.R2_BUCKET_NAME || 'nexsus-exports',
  /** Signed URL expiry in seconds (default: 1 hour) */
  URL_EXPIRY_SECONDS: parseInt(process.env.R2_URL_EXPIRY || '3600', 10),
  /** Key prefix for exported files */
  KEY_PREFIX: 'exports/',
  /**
   * Whether R2 is enabled (auto-detected from env vars)
   * All 4 required vars must be set for R2 to be enabled
   */
  get ENABLED(): boolean {
    return !!(
      this.ACCOUNT_ID &&
      this.ACCESS_KEY_ID &&
      this.SECRET_ACCESS_KEY &&
      this.BUCKET_NAME
    );
  },
} as const;

// ============================================================================
// AUTO-EXPORT CONFIGURATION (Token Threshold Export)
// ============================================================================

/**
 * Auto-export configuration for large result sets
 *
 * Automatically exports to Excel when results exceed the token threshold.
 * Routes to R2 (cloud) when enabled, otherwise falls back to local filesystem.
 */
export const AUTO_EXPORT_CONFIG = {
  /** Whether auto-export is enabled (can be disabled via env) */
  ENABLED: process.env.AUTO_EXPORT_ENABLED !== 'false',
  /** Token threshold for auto-export (default: 10,000) */
  TOKEN_THRESHOLD: parseInt(process.env.AUTO_EXPORT_THRESHOLD || '10000', 10),
  /** Prefer R2 upload when available */
  get PREFER_R2(): boolean {
    return R2_CONFIG.ENABLED;
  },
} as const;
