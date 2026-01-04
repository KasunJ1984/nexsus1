/**
 * Vector Client
 *
 * Manages the Qdrant odoo_schema collection for semantic schema search.
 * Simplified for Phase 1 - schema search only.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { QDRANT_CONFIG, SIMILARITY_THRESHOLDS, UNIFIED_CONFIG } from '../constants.js';
import type { SchemaPoint, SchemaPayload, SchemaFilter, VectorSearchResult, AnyPayload, SimilarRecord, SimilaritySearchResult } from '../types.js';

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

let qdrantClient: QdrantClient | null = null;

/**
 * Initialize the Qdrant client
 */
export function initializeVectorClient(): boolean {
  try {
    const config: { url: string; apiKey?: string; checkCompatibility?: boolean } = {
      url: QDRANT_CONFIG.HOST,
      checkCompatibility: false, // Skip version check for cloud compatibility
    };

    if (QDRANT_CONFIG.API_KEY) {
      config.apiKey = QDRANT_CONFIG.API_KEY;
    }

    qdrantClient = new QdrantClient(config);
    console.error('[Vector] Qdrant client initialized:', QDRANT_CONFIG.HOST);
    return true;
  } catch (error) {
    console.error('[Vector] Failed to initialize Qdrant client:', error);
    return false;
  }
}

/**
 * Check if vector client is available
 */
export function isVectorClientAvailable(): boolean {
  return qdrantClient !== null;
}

/**
 * Get the raw Qdrant client (for advanced operations)
 */
export function getQdrantClient(): QdrantClient {
  if (!qdrantClient) {
    throw new Error('Vector client not initialized');
  }
  return qdrantClient;
}

// =============================================================================
// COLLECTION MANAGEMENT
// =============================================================================

/**
 * Check if a collection exists
 */
export async function collectionExists(collectionName: string): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const collections = await qdrantClient.getCollections();
    return collections.collections.some(c => c.name === collectionName);
  } catch {
    return false;
  }
}

/**
 * Create the schema collection
 *
 * Supports scalar quantization for 75% memory reduction:
 * - float32 vectors (4 bytes/dim) → int8 (1 byte/dim)
 * - Configurable via ENABLE_SCALAR_QUANTIZATION env var
 */
export async function createSchemaCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const exists = await collectionExists(QDRANT_CONFIG.COLLECTION);
  if (exists) {
    console.error(`[Vector] Collection '${QDRANT_CONFIG.COLLECTION}' already exists`);
    return false;
  }

  // Build base collection config
  const vectorsConfig = {
    size: QDRANT_CONFIG.VECTOR_SIZE,
    distance: QDRANT_CONFIG.DISTANCE_METRIC,
  };

  // Build HNSW config (tuned for 150K+ vectors in single collection)
  // m=32: More connections per node for better recall at scale
  // ef_construct=200: Higher build quality (one-time cost)
  const hnswConfig = {
    m: QDRANT_CONFIG.HNSW_M,
    ef_construct: QDRANT_CONFIG.HNSW_EF_CONSTRUCT,
  };

  // Add scalar quantization if enabled (default: true)
  // This reduces memory by 75% with minimal accuracy loss
  if (QDRANT_CONFIG.ENABLE_SCALAR_QUANTIZATION) {
    await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
      vectors: vectorsConfig,
      hnsw_config: hnswConfig,
      quantization_config: {
        scalar: {
          type: 'int8' as const,
          quantile: QDRANT_CONFIG.SCALAR_QUANTILE, // Exclude outliers (default 0.99)
          always_ram: true, // Keep quantized vectors in RAM for speed
        },
      },
    });
    console.error('[Vector] Scalar quantization ENABLED (75% memory reduction)');
    console.error(`[Vector] HNSW config: m=${hnswConfig.m}, ef_construct=${hnswConfig.ef_construct}`);
  } else {
    await qdrantClient.createCollection(QDRANT_CONFIG.COLLECTION, {
      vectors: vectorsConfig,
      hnsw_config: hnswConfig,
    });
    console.error('[Vector] Scalar quantization DISABLED');
    console.error(`[Vector] HNSW config: m=${hnswConfig.m}, ef_construct=${hnswConfig.ef_construct}`);
  }

  // Create payload indexes for efficient filtering
  const indexFields = [
    { field: 'model_name', type: 'keyword' as const },
    { field: 'field_name', type: 'keyword' as const },
    { field: 'field_type', type: 'keyword' as const },
    { field: 'stored', type: 'bool' as const },
    { field: 'model_id', type: 'integer' as const },
    { field: 'field_id', type: 'integer' as const },
    { field: 'primary_data_location', type: 'keyword' as const },  // For references_in mode
  ];

  for (const { field, type } of indexFields) {
    try {
      await qdrantClient.createPayloadIndex(QDRANT_CONFIG.COLLECTION, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist
    }
  }

  console.error(`[Vector] Created collection '${QDRANT_CONFIG.COLLECTION}'`);
  return true;
}

/**
 * Delete a collection
 */
export async function deleteCollection(collectionName: string): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    await qdrantClient.deleteCollection(collectionName);
    console.error(`[Vector] Deleted collection '${collectionName}'`);
    return true;
  } catch {
    console.error(`[Vector] Collection '${collectionName}' does not exist`);
    return false;
  }
}

/**
 * Get collection info
 */
export async function getCollectionInfo(collectionName: string): Promise<{
  exists: boolean;
  vectorCount: number;
}> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const info = await qdrantClient.getCollection(collectionName);
    return {
      exists: true,
      vectorCount: info.points_count ?? 0,
    };
  } catch {
    return { exists: false, vectorCount: 0 };
  }
}

// =============================================================================
// SCHEMA OPERATIONS
// =============================================================================

/**
 * Upsert schema points to collection
 */
export async function upsertSchemaPoints(points: SchemaPoint[]): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  await qdrantClient.upsert(QDRANT_CONFIG.COLLECTION, {
    wait: true,
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
}

/**
 * Search schema collection by vector with optional filters
 */
export async function searchSchemaCollection(
  vector: number[],
  options: {
    limit?: number;
    minScore?: number;
    filter?: SchemaFilter;
  } = {}
): Promise<VectorSearchResult[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const { limit = 10, minScore = SIMILARITY_THRESHOLDS.DEFAULT_MIN, filter } = options;

  const qdrantFilter = filter ? buildQdrantFilter(filter) : undefined;

  try {
    // Build search params - add HNSW ef and quantization rescore if enabled
    // hnsw_ef: Controls search-time exploration (higher = better recall, slower)
    // Rescoring re-ranks results using full vectors for accuracy
    const searchParams: {
      vector: number[];
      limit: number;
      score_threshold: number;
      filter?: object;
      with_payload: boolean;
      params?: { hnsw_ef?: number; quantization?: { rescore: boolean; oversampling: number } };
    } = {
      vector,
      limit,
      score_threshold: minScore,
      filter: qdrantFilter,
      with_payload: true,
    };

    // Add HNSW search param (ef=128 for better recall)
    searchParams.params = {
      hnsw_ef: QDRANT_CONFIG.HNSW_EF_SEARCH,
    };

    // Add quantization search params for rescoring (improves accuracy)
    if (QDRANT_CONFIG.ENABLE_SCALAR_QUANTIZATION && QDRANT_CONFIG.SEARCH_RESCORE) {
      searchParams.params.quantization = {
        rescore: true, // Re-rank using full float32 vectors
        oversampling: QDRANT_CONFIG.SEARCH_OVERSAMPLING, // Fetch extra, keep best (2.0x)
      };
    }

    // Search the unified collection for schema points
    const results = await qdrantClient.search(UNIFIED_CONFIG.COLLECTION_NAME, searchParams);

    return results.map(r => ({
      id: r.id as number, // VectorSearchResult uses number, but actual ID is UUID string
      score: r.score,
      payload: r.payload as unknown as SchemaPayload,
      qdrant_id: String(r.id), // Preserve the actual UUID for display
    }));
  } catch (error) {
    console.error('[Vector] Search failed:', {
      collection: UNIFIED_CONFIG.COLLECTION_NAME,
      vectorDimension: vector.length,
      expectedDimension: QDRANT_CONFIG.VECTOR_SIZE,
      filter: qdrantFilter ? JSON.stringify(qdrantFilter, null, 2) : 'none',
      limit,
      minScore,
      quantizationEnabled: QDRANT_CONFIG.ENABLE_SCALAR_QUANTIZATION,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get a single schema by field_id
 */
export async function getSchemaPoint(fieldId: number): Promise<VectorSearchResult | null> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const result = await qdrantClient.retrieve(QDRANT_CONFIG.COLLECTION, {
      ids: [fieldId],
      with_payload: true,
    });

    if (result.length === 0) return null;

    return {
      id: result[0].id as number,
      score: 1.0,
      payload: result[0].payload as unknown as SchemaPayload,
    };
  } catch {
    return null;
  }
}

/**
 * Count schemas matching filter
 */
export async function countSchemas(filter?: SchemaFilter): Promise<number> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const qdrantFilter = filter ? buildQdrantFilter(filter) : undefined;

  const result = await qdrantClient.count(QDRANT_CONFIG.COLLECTION, {
    filter: qdrantFilter,
    exact: true,
  });

  return result.count;
}

/**
 * Scroll schema collection with filters (no vector similarity)
 *
 * Used for list mode and reference searches where we want ALL matching
 * results, not just semantically similar ones.
 */
export async function scrollSchemaCollection(options: {
  filter: SchemaFilter;
  limit?: number;
}): Promise<VectorSearchResult[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const { filter, limit = 100 } = options;
  const qdrantFilter = buildQdrantFilter(filter);

  try {
    // Scroll the unified collection for schema points
    const results = await qdrantClient.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: qdrantFilter,
      limit,
      with_payload: true,
      with_vector: false,
    });

    return results.points.map(p => ({
      id: p.id as number, // VectorSearchResult uses number, but actual ID is UUID string
      score: 1.0, // No similarity score in scroll mode
      payload: p.payload as unknown as SchemaPayload,
      qdrant_id: String(p.id), // Preserve the actual UUID for display
    }));
  } catch (error) {
    console.error('[Vector] Scroll failed:', {
      collection: UNIFIED_CONFIG.COLLECTION_NAME,
      filter: JSON.stringify(qdrantFilter, null, 2),
      limit,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Delete schema points by field IDs
 *
 * Used by incremental sync to remove deleted fields.
 */
export async function deleteSchemaPoints(fieldIds: number[]): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  if (fieldIds.length === 0) {
    console.error('[Vector] No points to delete');
    return;
  }

  try {
    await qdrantClient.delete(QDRANT_CONFIG.COLLECTION, {
      wait: true,
      points: fieldIds,
    });
    console.error(`[Vector] Deleted ${fieldIds.length} points`);
  } catch (error) {
    console.error('[Vector] Delete failed:', error);
    throw error;
  }
}

/**
 * Build Qdrant filter from SchemaFilter
 *
 * Supports:
 * - Exact match on model_name
 * - Exact match or array of field_types
 * - Prefix match on primary_data_location (for references_in)
 * - Boolean match on stored
 * - point_type filter (schema, data, or all)
 */
function buildQdrantFilter(filter: SchemaFilter): { must?: object[]; must_not?: object[] } {
  const must: object[] = [];
  const must_not: object[] = [];

  if (filter.model_name) {
    must.push({ key: 'model_name', match: { value: filter.model_name } });
  }

  // Support single field type or array of field types
  if (filter.field_type) {
    if (Array.isArray(filter.field_type)) {
      // Match any of the field types
      must.push({
        key: 'field_type',
        match: { any: filter.field_type },
      });
    } else {
      must.push({ key: 'field_type', match: { value: filter.field_type } });
    }
  }

  // Exact match for primary_data_location (used in references_in mode)
  // many2one fields store target as "model.id" format, so append ".id" to model name
  // e.g., filter "res.partner" becomes match "res.partner.id"
  if (filter.primary_data_location_prefix) {
    const targetLocation = filter.primary_data_location_prefix + '.id';
    must.push({
      key: 'primary_data_location',
      match: { value: targetLocation },
    });
  }

  if (filter.stored_only === true) {
    must.push({ key: 'stored', match: { value: true } });
  }

  // Handle point_type filter for unified collection (V2 format)
  // - 'schema': point_type = 'schema' (field definitions from Excel)
  // - 'data': point_type = 'data' (synced Odoo records)
  // - 'graph': point_type = 'graph' (FK relationships)
  // - 'all' or undefined: No point_type filter (search everything)
  if (filter.point_type === 'data') {
    must.push({ key: 'point_type', match: { value: 'data' } });
  } else if (filter.point_type === 'schema') {
    must.push({ key: 'point_type', match: { value: 'schema' } });
  } else if (filter.point_type === 'graph') {
    must.push({ key: 'point_type', match: { value: 'graph' } });
  }
  // 'all' = no point_type filter needed

  const result: { must?: object[]; must_not?: object[] } = {};
  if (must.length > 0) result.must = must;
  if (must_not.length > 0) result.must_not = must_not;

  return result;
}

// =============================================================================
// PIPELINE DATA COLLECTION (Excel-Based Pipeline)
// =============================================================================

import type { PipelineDataPoint, PipelineDataPayload } from '../types.js';

/**
 * Create the pipeline data collection
 *
 * Creates a separate collection for pipeline data with:
 * - String IDs (format: model_id^record_id)
 * - 1024-dimensional vectors (Voyage AI)
 * - Scalar quantization enabled
 * - Payload indexes for filtering
 */
export async function createPipelineDataCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await collectionExists(collectionName);
  if (exists) {
    console.error(`[Vector] Pipeline collection '${collectionName}' already exists`);
    return false;
  }

  // Vector configuration
  const vectorsConfig = {
    size: UNIFIED_CONFIG.VECTOR_SIZE,
    distance: 'Cosine' as const,
  };

  // HNSW configuration (tuned for data)
  const hnswConfig = {
    m: QDRANT_CONFIG.HNSW_M,
    ef_construct: QDRANT_CONFIG.HNSW_EF_CONSTRUCT,
  };

  // Create collection with scalar quantization
  await qdrantClient.createCollection(collectionName, {
    vectors: vectorsConfig,
    hnsw_config: hnswConfig,
    quantization_config: {
      scalar: {
        type: 'int8' as const,
        quantile: QDRANT_CONFIG.SCALAR_QUANTILE,
        always_ram: true,
      },
    },
  });

  console.error(`[Vector] Created pipeline collection '${collectionName}' with ${UNIFIED_CONFIG.VECTOR_SIZE} dimensions`);

  // Create payload indexes for efficient filtering
  // Note: vector_id removed - Qdrant point ID (UUID) is the identifier
  const indexFields = [
    { field: 'model_name', type: 'keyword' as const },
    { field: 'model_id', type: 'integer' as const },
    { field: 'record_id', type: 'integer' as const },
    { field: 'point_type', type: 'keyword' as const },
  ];

  for (const { field, type } of indexFields) {
    try {
      await qdrantClient.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist
    }
  }

  console.error(`[Vector] Created payload indexes for pipeline collection`);
  return true;
}

/**
 * Convert vector_id string to UUID format for Qdrant
 *
 * Qdrant accepts UUID strings as IDs. We convert "model_id^record_id" to
 * a deterministic UUID format that preserves the original values:
 *
 * Format: MMMMMMMM-0000-0000-0000-RRRRRRRRRRRR
 * Where:
 *   - M = model_id padded to 8 digits
 *   - R = record_id padded to 12 digits
 *
 * Examples:
 *   - "292^103" → "00000292-0000-0000-0000-000000000103"
 *   - "344^12345" → "00000344-0000-0000-0000-000000012345"
 *
 * This format:
 *   - Is a valid UUID that Qdrant accepts
 *   - Is deterministic (same input = same output)
 *   - Is reversible (can extract model_id and record_id)
 *   - Allows FK lookups by converting FK vector_id to same UUID format
 *
 * @param vectorId - String in format "model_id^record_id" (e.g., "292^103")
 * @returns UUID string
 */
export function vectorIdToUuid(vectorId: string): string {
  // Input validation
  if (!vectorId || typeof vectorId !== 'string') {
    throw new Error(`Invalid vector_id: expected string, got ${typeof vectorId}`);
  }

  const trimmed = vectorId.trim();
  const parts = trimmed.split('^');

  if (parts.length !== 2) {
    throw new Error(`Invalid vector_id format: "${vectorId}". Expected "model_id^field_id" (e.g., "292^5014")`);
  }

  const modelId = parseInt(parts[0], 10);
  const recordId = parseInt(parts[1], 10);

  if (isNaN(modelId) || isNaN(recordId)) {
    throw new Error(`Invalid vector_id values: "${vectorId}". Both parts must be numbers.`);
  }

  // Validate ranges (catch data issues early)
  if (modelId < 0 || modelId > 99999999) {
    console.error(`[Vector] Warning: model_id ${modelId} out of expected range in "${vectorId}"`);
  }
  if (recordId < 0 || recordId > 999999999999) {
    console.error(`[Vector] Warning: record_id ${recordId} out of expected range in "${vectorId}"`);
  }

  // Pad model_id to 8 digits, record_id to 12 digits
  // Format: MMMMMMMM-0000-0000-0000-RRRRRRRRRRRR (8 + 12 digits)
  const modelPart = modelId.toString().padStart(8, '0');
  const recordPart = recordId.toString().padStart(12, '0');

  return `${modelPart}-0000-0000-0000-${recordPart}`;
}

/**
 * Convert UUID back to vector_id string
 *
 * Reverses the UUID conversion to get the original vector_id.
 *
 * @param uuid - UUID in format "MMMMMMMM-0000-0000-0000-RRRRRRRRRRRR"
 * @returns String in format "model_id^record_id"
 */
export function uuidToVectorId(uuid: string): string {
  const parts = uuid.split('-');
  if (parts.length !== 5) {
    throw new Error(`Invalid UUID format: ${uuid}`);
  }

  const modelId = parseInt(parts[0], 10);
  const recordId = parseInt(parts[4], 10);

  return `${modelId}^${recordId}`;
}

/**
 * Upsert pipeline data points
 *
 * Uploads transformed records to the pipeline collection.
 * Points use computed integer IDs (model_id * 100M + record_id).
 * The original vector_id string is stored in the payload for reference.
 *
 * @param points - Array of PipelineDataPoint
 */
export async function upsertPipelineDataPoints(points: PipelineDataPoint[]): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  if (points.length === 0) {
    console.error('[Vector] No pipeline points to upsert');
    return;
  }

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  await qdrantClient.upsert(collectionName, {
    wait: true,
    points: points.map(p => ({
      id: vectorIdToUuid(p.id), // Convert "292^103" to UUID "00000292-0000-0000-0000-000000000103"
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });

  console.error(`[Vector] Upserted ${points.length} pipeline points to '${collectionName}'`);
}

/**
 * Upsert data points to the UNIFIED collection (V2 UUID format)
 *
 * Points should already have V2 UUID format IDs (00000002-MMMM-0000-0000-RRRRRRRRRRRR).
 *
 * IMPORTANT: This function chunks uploads to prevent Qdrant HTTP body size limits.
 * Large models (5,000+ records) can exceed Qdrant's HTTP body limit (~100MB) when
 * uploading all points at once, causing "Bad Request" or "Invalid string length" errors.
 *
 * @param points - Array of PipelineDataPoint with V2 UUID IDs
 * @param chunkSize - Number of points per upload batch (default: 100)
 */
export async function upsertToUnifiedCollection(points: PipelineDataPoint[], chunkSize: number = 100): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  if (points.length === 0) {
    console.error('[Vector] No unified points to upsert');
    return;
  }

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const totalChunks = Math.ceil(points.length / chunkSize);

  // Log chunking strategy for large uploads
  if (points.length > chunkSize) {
    console.error(`[Vector] Uploading ${points.length} points in ${totalChunks} chunks (${chunkSize} per chunk)`);
  }

  // Process points in chunks to avoid Qdrant HTTP body size limits
  for (let i = 0; i < points.length; i += chunkSize) {
    const chunk = points.slice(i, i + chunkSize);
    const chunkNum = Math.floor(i / chunkSize) + 1;

    try {
      await qdrantClient.upsert(collectionName, {
        wait: true,
        points: chunk.map(p => ({
          id: p.id, // Already in V2 UUID format (00000002-MMMM-0000-0000-RRRRRRRRRRRR)
          vector: p.vector,
          payload: p.payload as unknown as Record<string, unknown>,
        })),
      });

      // Log progress for large uploads
      if (totalChunks > 1 && (chunkNum % 10 === 0 || chunkNum === totalChunks)) {
        console.error(`[Vector] Chunk ${chunkNum}/${totalChunks}: Uploaded ${Math.min((chunkNum) * chunkSize, points.length)}/${points.length} points`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Vector] Chunk ${chunkNum}/${totalChunks} failed: ${errorMsg}`);
      throw error; // Re-throw to let caller handle
    }
  }

  console.error(`[Vector] Upserted ${points.length} unified points to '${collectionName}'`);
}

/**
 * Get pipeline collection info
 */
export async function getPipelineCollectionInfo(): Promise<{
  exists: boolean;
  vectorCount: number;
  collectionName: string;
}> {
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const info = await getCollectionInfo(collectionName);

  return {
    exists: info.exists,
    vectorCount: info.vectorCount,
    collectionName,
  };
}

/**
 * Search pipeline data collection
 *
 * Semantic search over pipeline data records.
 *
 * @param vector - Query embedding vector
 * @param options - Search options
 * @returns Search results
 */
export async function searchPipelineCollection(
  vector: number[],
  options: {
    limit?: number;
    minScore?: number;
    modelName?: string;
  } = {}
): Promise<Array<{ id: string; score: number; payload: PipelineDataPayload }>> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const { limit = 10, minScore = 0.5, modelName } = options;

  // Build filter
  const must: object[] = [];
  if (modelName) {
    must.push({ key: 'model_name', match: { value: modelName } });
  }
  const filter = must.length > 0 ? { must } : undefined;

  const searchParams: {
    vector: number[];
    limit: number;
    score_threshold: number;
    filter?: object;
    with_payload: boolean;
    params?: { hnsw_ef?: number; quantization?: { rescore: boolean; oversampling: number } };
  } = {
    vector,
    limit,
    score_threshold: minScore,
    filter,
    with_payload: true,
    params: {
      hnsw_ef: QDRANT_CONFIG.HNSW_EF_SEARCH,
      quantization: {
        rescore: true,
        oversampling: QDRANT_CONFIG.SEARCH_OVERSAMPLING,
      },
    },
  };

  const results = await qdrantClient.search(collectionName, searchParams);

  return results.map(r => ({
    // Return the Qdrant ID directly (UUID format)
    id: String(r.id),
    score: r.score,
    payload: r.payload as unknown as PipelineDataPayload,
  }));
}

/**
 * Search unified collection with point_type discrimination
 *
 * Routes all point types through single nexsus_unified collection.
 *
 * @param vector - Query embedding vector
 * @param options - Search options including pointType filter
 * @returns Search results from unified collection
 */
export async function searchUnifiedCollection(
  vector: number[],
  options: {
    limit?: number;
    minScore?: number;
    filter?: SchemaFilter;
    pointType?: 'schema' | 'data' | 'graph' | 'all';
  } = {}
): Promise<VectorSearchResult[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const { pointType = 'schema', limit = 10, minScore, filter } = options;
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  console.error(`[Vector] searchUnifiedCollection: pointType=${pointType}, limit=${limit}, collection=${collectionName}`);

  // Build filter with point_type discrimination
  const must: Array<{ key: string; match: { value: string | number | boolean } }> = [];

  // Add point_type filter (unless 'all')
  if (pointType !== 'all') {
    must.push({ key: 'point_type', match: { value: pointType } });
  }

  // Add model_name filter if provided
  if (filter?.model_name) {
    must.push({ key: 'model_name', match: { value: filter.model_name } });
  }

  // Add field_type filter if provided (schema only)
  if (filter?.field_type) {
    // Handle both single string and array of strings
    if (Array.isArray(filter.field_type)) {
      // For multiple field types, use should (OR) clause
      if (filter.field_type.length > 0) {
        const fieldTypeConditions = filter.field_type.map(ft => ({
          key: 'field_type',
          match: { value: ft },
        }));
        // Add as a nested condition with should
        must.push({
          should: fieldTypeConditions,
        } as unknown as typeof must[0]);
      }
    } else {
      must.push({ key: 'field_type', match: { value: filter.field_type } });
    }
  }

  // Add stored_only filter if provided (schema only)
  if (filter?.stored_only !== undefined) {
    must.push({ key: 'stored', match: { value: filter.stored_only } });
  }

  const searchParams: {
    vector: number[];
    limit: number;
    filter?: { must: typeof must };
    score_threshold?: number;
    with_payload: boolean;
  } = {
    vector,
    limit,
    with_payload: true,
  };

  if (must.length > 0) {
    searchParams.filter = { must };
  }

  if (minScore !== undefined) {
    searchParams.score_threshold = minScore;
  }

  const results = await qdrantClient.search(collectionName, searchParams);

  console.error(`[Vector] searchUnifiedCollection found ${results.length} results`);

  return results.map(r => ({
    id: typeof r.id === 'number' ? r.id : 0,
    score: r.score,
    payload: r.payload as unknown as AnyPayload,
  }));
}

/**
 * Search unified collection based on point_type
 *
 * Routes to unified collection with point_type filter:
 * - 'schema' or undefined → schema definitions
 * - 'data' → data records
 * - 'all' → all point types
 *
 * @param vector - Query embedding vector
 * @param options - Search options including pointType
 * @returns Search results from the unified collection
 */
export async function searchByPointType(
  vector: number[],
  options: {
    limit?: number;
    minScore?: number;
    filter?: SchemaFilter;
    pointType?: 'schema' | 'data' | 'all';
  } = {}
): Promise<VectorSearchResult[]> {
  const { pointType = 'schema', limit = 10, minScore, filter } = options;

  console.error(`[Vector] searchByPointType: pointType=${pointType}, limit=${limit}`);

  return searchUnifiedCollection(vector, { limit, minScore, filter, pointType });
}

/**
 * Delete pipeline data points by IDs
 *
 * @param ids - Array of string IDs (format: model_id^record_id)
 */
export async function deletePipelineDataPoints(ids: string[]): Promise<void> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  if (ids.length === 0) {
    console.error('[Vector] No pipeline points to delete');
    return;
  }

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Convert string IDs to UUIDs
  const uuidIds = ids.map(id => vectorIdToUuid(id));

  await qdrantClient.delete(collectionName, {
    wait: true,
    points: uuidIds,
  });

  console.error(`[Vector] Deleted ${ids.length} pipeline points from '${collectionName}'`);
}

/**
 * Count pipeline data points
 *
 * @param modelName - Optional model name filter
 * @returns Count of matching points
 */
export async function countPipelineData(modelName?: string): Promise<number> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Build filter - always include point_type for data records
  const must: Array<{ key: string; match: { value: string } }> = [
    { key: 'point_type', match: { value: 'data' } },
  ];

  if (modelName) {
    must.push({ key: 'model_name', match: { value: modelName } });
  }

  const filter = { must };

  const result = await qdrantClient.count(collectionName, {
    filter,
    exact: true,
  });

  return result.count;
}

// =============================================================================
// SEARCH BY PAYLOAD FILTER (For Dot Notation Resolution)
// =============================================================================

/**
 * Search pipeline data by payload field filter
 *
 * Used for dot notation resolution without Odoo API calls.
 * Searches records of a specific model matching a field condition.
 *
 * @param modelName - Target model name (e.g., "res.partner")
 * @param field - Field to filter on (e.g., "name")
 * @param operator - Filter operator (eq, neq, contains, in, gt, gte, lt, lte)
 * @param value - Value to match
 * @param limit - Max results to return (default: 10000)
 * @returns Array of matching record_ids
 *
 * @example
 * // Find all res.partner records where name contains "Hansen"
 * const partnerIds = await searchByPayloadFilter(
 *   "res.partner", "name", "contains", "Hansen"
 * );
 * // Returns: [286798, 282161, ...]
 */
export async function searchByPayloadFilter(
  modelName: string,
  field: string,
  operator: string,
  value: unknown,
  limit: number = 10000
): Promise<number[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const recordIds: number[] = [];

  // Build Qdrant filter
  const must: object[] = [
    // Filter by model
    { key: 'model_name', match: { value: modelName } },
    // Filter by point_type (only data records, not schema)
    { key: 'point_type', match: { value: 'data' } },
  ];

  const mustNot: object[] = [];

  // Add field condition based on operator
  switch (operator) {
    case 'eq':
      must.push({ key: field, match: { value } });
      break;

    case 'neq':
      mustNot.push({ key: field, match: { value } });
      break;

    case 'contains':
      // Qdrant full-text match
      must.push({ key: field, match: { text: String(value) } });
      break;

    case 'in':
      if (Array.isArray(value)) {
        must.push({ key: field, match: { any: value } });
      } else {
        throw new Error(`'in' operator requires array value`);
      }
      break;

    case 'gt':
      must.push({ key: field, range: { gt: value } });
      break;

    case 'gte':
      must.push({ key: field, range: { gte: value } });
      break;

    case 'lt':
      must.push({ key: field, range: { lt: value } });
      break;

    case 'lte':
      must.push({ key: field, range: { lte: value } });
      break;

    default:
      throw new Error(`Unsupported operator for Qdrant search: ${operator}`);
  }

  // Build final filter
  const filter: { must: object[]; must_not?: object[] } = { must };
  if (mustNot.length > 0) {
    filter.must_not = mustNot;
  }

  console.error(`[Vector] searchByPayloadFilter: ${modelName}.${field} ${operator} "${value}"`);

  // Scroll through matching records
  let scrollOffset: string | number | null = null;
  const scrollLimit = 1000;

  try {
    do {
      const scrollResult = await qdrantClient.scroll(collectionName, {
        filter,
        limit: scrollLimit,
        offset: scrollOffset ?? undefined,
        with_payload: ['record_id'],
      });

      for (const point of scrollResult.points) {
        const recordId = point.payload?.record_id;
        if (typeof recordId === 'number') {
          recordIds.push(recordId);
        }
      }

      // Handle next_page_offset
      const nextOffset = scrollResult.next_page_offset;
      scrollOffset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
        ? nextOffset
        : null;

      // Stop if we've reached limit
      if (recordIds.length >= limit) {
        console.error(`[Vector] searchByPayloadFilter: Limit reached (${limit})`);
        break;
      }
    } while (scrollOffset !== null);

    console.error(`[Vector] searchByPayloadFilter: Found ${recordIds.length} matching records`);
    return recordIds;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Vector] searchByPayloadFilter failed: ${errorMsg}`);
    throw error;
  }
}

// =============================================================================
// RETRIEVE POINT BY ID
// =============================================================================

/**
 * Result from retrievePointById
 */
export interface RetrievePointResult {
  found: boolean;
  payload?: Record<string, unknown>;
  vector?: number[];
}

/**
 * Retrieve a single point by UUID from a collection
 *
 * @param collectionName - Collection to query
 * @param pointId - UUID of the point
 * @param withVector - Whether to include the embedding vector
 * @returns Point data if found
 */
export async function retrievePointById(
  collectionName: string,
  pointId: string,
  withVector: boolean = false
): Promise<RetrievePointResult> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  try {
    const points = await qdrantClient.retrieve(collectionName, {
      ids: [pointId],
      with_payload: true,
      with_vector: withVector,
    });

    if (points.length === 0) {
      return { found: false };
    }

    const point = points[0];
    return {
      found: true,
      payload: point.payload as Record<string, unknown>,
      vector: withVector ? (point.vector as number[]) : undefined,
    };
  } catch (error) {
    // Log and rethrow
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Vector] retrievePointById failed for ${pointId}: ${errorMsg}`);
    throw error;
  }
}

/**
 * Result from batchRetrievePoints
 */
export interface BatchRetrieveResult {
  payload: Record<string, unknown>;
}

/**
 * Batch retrieve multiple points by UUID
 *
 * Fetches multiple points in a single Qdrant call for better performance.
 * Missing points are silently excluded from the result map.
 *
 * @param collectionName - Qdrant collection name
 * @param pointIds - Array of UUIDs to retrieve
 * @returns Map of UUID -> point data (missing points not included)
 *
 * @example
 * const uuids = ['00000002-0090-...', '00000002-0078-...'];
 * const results = await batchRetrievePoints('nexsus_unified', uuids);
 * // results.get('00000002-0090-...') → { payload: { model_name: 'res.users', ... } }
 */
export async function batchRetrievePoints(
  collectionName: string,
  pointIds: string[]
): Promise<Map<string, BatchRetrieveResult>> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  // Return empty map for empty input
  if (pointIds.length === 0) {
    return new Map();
  }

  try {
    // Qdrant's retrieve() supports batch IDs natively
    const points = await qdrantClient.retrieve(collectionName, {
      ids: pointIds,
      with_payload: true,
      with_vector: false,  // No vectors needed for FK traversal
    });

    // Build result map
    const result = new Map<string, BatchRetrieveResult>();
    for (const point of points) {
      result.set(point.id as string, {
        payload: point.payload as Record<string, unknown>,
      });
    }

    console.error(`[Vector] Batch retrieved ${result.size}/${pointIds.length} points`);
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Vector] batchRetrievePoints failed: ${errorMsg}`);
    throw error;
  }
}

// =============================================================================
// DISCOVER MODELS FROM QDRANT (Fallback for missing metadata)
// =============================================================================

/**
 * Discover all unique model names from the pipeline data collection
 *
 * This function scrolls through the Qdrant collection to find all unique
 * model_name values. Used as a fallback when metadata files are missing
 * or incomplete.
 *
 * NOTE: This can be slow for large collections. Use sparingly.
 *
 * @returns Array of unique model names found in Qdrant
 */
export async function discoverModelsInQdrant(): Promise<string[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const modelNames = new Set<string>();
  const scrollLimit = 1000;
  let scrollOffset: string | number | null = null;

  console.error(`[Vector] Discovering models in Qdrant collection: ${collectionName}`);

  try {
    // Check if collection exists first
    const exists = await collectionExists(collectionName);
    if (!exists) {
      console.error(`[Vector] Collection ${collectionName} does not exist`);
      return [];
    }

    // Scroll through collection to find unique model names
    // Using a sampling approach - scroll until we have enough unique models
    // or we've scanned a reasonable portion of the collection
    let totalScanned = 0;
    const maxScan = 100000; // Don't scan more than 100K points

    do {
      const scrollResult = await qdrantClient.scroll(collectionName, {
        filter: {
          must: [{ key: 'point_type', match: { value: 'data' } }],
        },
        limit: scrollLimit,
        offset: scrollOffset ?? undefined,
        with_payload: ['model_name'],
      });

      for (const point of scrollResult.points) {
        const modelName = point.payload?.model_name;
        if (typeof modelName === 'string') {
          modelNames.add(modelName);
        }
      }

      totalScanned += scrollResult.points.length;

      // Handle next_page_offset
      const nextOffset = scrollResult.next_page_offset;
      scrollOffset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
        ? nextOffset
        : null;

      // Stop if we've scanned enough or no more results
      if (totalScanned >= maxScan || scrollResult.points.length < scrollLimit) {
        break;
      }
    } while (scrollOffset !== null);

    console.error(`[Vector] Discovered ${modelNames.size} unique models after scanning ${totalScanned} points`);
    return Array.from(modelNames);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Vector] discoverModelsInQdrant failed: ${errorMsg}`);
    return []; // Return empty on error, don't break status check
  }
}

// =============================================================================
// GET MODEL DATE RANGE (Oldest/Newest records by create_date)
// =============================================================================

/**
 * Result from getModelDateRange
 */
export interface ModelDateRangeResult {
  oldest: { create_date: string; record_id: number; uuid: string } | null;
  newest: { create_date: string; record_id: number; uuid: string } | null;
}

/**
 * Get the oldest and newest records for a model based on create_date
 *
 * Scrolls through the pipeline data collection to find MIN/MAX create_date
 * and returns the record details including Qdrant UUID.
 *
 * NOTE: This requires create_date to be in the payload (payload=1 in Excel config)
 *
 * @param modelName - Odoo model name (e.g., "account.move.line")
 * @param modelId - The numeric model_id for UUID generation
 * @returns Oldest and newest record info, or null if not found/no create_date
 */
export async function getModelDateRange(
  modelName: string,
  modelId: number
): Promise<ModelDateRangeResult> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Track oldest and newest
  let oldest: { create_date: string; record_id: number } | null = null;
  let newest: { create_date: string; record_id: number } | null = null;

  const scrollLimit = 1000;
  let scrollOffset: string | number | null = null;
  let totalScanned = 0;

  console.error(`[Vector] Getting date range for model: ${modelName}`);

  try {
    do {
      const scrollResult = await qdrantClient.scroll(collectionName, {
        filter: {
          must: [
            { key: 'model_name', match: { value: modelName } },
            { key: 'point_type', match: { value: 'data' } },
          ],
        },
        limit: scrollLimit,
        offset: scrollOffset ?? undefined,
        with_payload: ['create_date', 'record_id'],
      });

      for (const point of scrollResult.points) {
        const createDate = point.payload?.create_date;
        const recordId = point.payload?.record_id;

        // Skip records without create_date in payload
        if (typeof createDate !== 'string' || typeof recordId !== 'number') {
          continue;
        }

        // Check if this is the oldest
        if (!oldest || createDate < oldest.create_date) {
          oldest = { create_date: createDate, record_id: recordId };
        }

        // Check if this is the newest
        if (!newest || createDate > newest.create_date) {
          newest = { create_date: createDate, record_id: recordId };
        }
      }

      totalScanned += scrollResult.points.length;

      // Handle next_page_offset
      const nextOffset = scrollResult.next_page_offset;
      scrollOffset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
        ? nextOffset
        : null;

    } while (scrollOffset !== null);

    console.error(`[Vector] Date range for ${modelName}: scanned ${totalScanned} records`);

    // Build result with UUIDs
    const result: ModelDateRangeResult = {
      oldest: oldest ? {
        create_date: oldest.create_date,
        record_id: oldest.record_id,
        uuid: vectorIdToUuid(`${modelId}^${oldest.record_id}`),
      } : null,
      newest: newest ? {
        create_date: newest.create_date,
        record_id: newest.record_id,
        uuid: vectorIdToUuid(`${modelId}^${newest.record_id}`),
      } : null,
    };

    if (oldest && newest) {
      console.error(`[Vector] ${modelName} date range: ${oldest.create_date} to ${newest.create_date}`);
    } else {
      console.error(`[Vector] ${modelName}: No create_date found in payload (may need resync)`);
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Vector] getModelDateRange failed for ${modelName}: ${errorMsg}`);
    return { oldest: null, newest: null };
  }
}

// =============================================================================
// UNIFIED COLLECTION (Stage 2)
// =============================================================================

/**
 * Unified collection indexes
 *
 * Indexes for all point types in nexsus_unified:
 * - Schema: model_name, field_name, field_type, stored, model_id, field_id, etc.
 * - Data: record_id, account_id_id, date, debit, credit, balance, etc.
 * - Graph: source_model, target_model, is_leaf, etc.
 *
 * point_type is the primary discriminator:
 * - 'schema' for schema definitions (00000003-*)
 * - 'data' for Odoo records (00000002-*)
 * - 'graph' for FK graph edges (00000001-*)
 */
const UNIFIED_INDEXES: Array<{ field: string; type: 'keyword' | 'integer' | 'float' | 'bool' }> = [
  // === Common indexes (all point types) ===
  { field: 'point_type', type: 'keyword' },     // PRIMARY DISCRIMINATOR
  { field: 'model_name', type: 'keyword' },
  { field: 'model_id', type: 'integer' },

  // === Schema-specific indexes (point_type: 'schema') ===
  { field: 'field_name', type: 'keyword' },
  { field: 'field_type', type: 'keyword' },
  { field: 'stored', type: 'bool' },
  { field: 'field_id', type: 'integer' },
  { field: 'fk_location_model', type: 'keyword' },
  { field: 'fk_qdrant_id', type: 'keyword' },
  { field: 'primary_data_location', type: 'keyword' },

  // === Data-specific indexes (point_type: 'data') ===
  { field: 'record_id', type: 'integer' },

  // ir.actions.act_window fields (for build_odoo_url tool)
  { field: 'res_model', type: 'keyword' },

  // account.move.line fields
  { field: 'account_id_id', type: 'integer' },
  { field: 'date', type: 'keyword' },
  { field: 'parent_state', type: 'keyword' },
  { field: 'journal_id_id', type: 'integer' },
  { field: 'partner_id_id', type: 'integer' },
  { field: 'move_id_id', type: 'integer' },
  { field: 'debit', type: 'float' },
  { field: 'credit', type: 'float' },
  { field: 'balance', type: 'float' },

  // crm.lead fields
  { field: 'stage_id_id', type: 'integer' },
  { field: 'user_id_id', type: 'integer' },
  { field: 'team_id_id', type: 'integer' },
  { field: 'probability', type: 'float' },
  { field: 'expected_revenue', type: 'float' },
  { field: 'active', type: 'bool' },
  { field: 'name', type: 'keyword' },
  { field: 'opportunity_type', type: 'keyword' },
  { field: 'create_date', type: 'keyword' },

  // res.partner (contact) fields
  { field: 'is_company', type: 'bool' },
  { field: 'customer_rank', type: 'integer' },
  { field: 'supplier_rank', type: 'integer' },

  // === FK Qdrant reference indexes (for graph traversal) ===
  { field: 'partner_id_qdrant', type: 'keyword' },
  { field: 'user_id_qdrant', type: 'keyword' },
  { field: 'company_id_qdrant', type: 'keyword' },
  { field: 'move_id_qdrant', type: 'keyword' },
  { field: 'account_id_qdrant', type: 'keyword' },
  { field: 'journal_id_qdrant', type: 'keyword' },
  { field: 'stage_id_qdrant', type: 'keyword' },
  { field: 'team_id_qdrant', type: 'keyword' },
  { field: 'currency_id_qdrant', type: 'keyword' },

  // === Graph-specific indexes (point_type: 'relationship') ===
  { field: 'source_model', type: 'keyword' },
  { field: 'target_model', type: 'keyword' },
  { field: 'is_leaf', type: 'bool' },
];

/**
 * Create the unified nexsus collection
 *
 * Creates a single collection to hold all vector types:
 * - Schema (00000003-*): Field definitions from ir.model.fields
 * - Data (00000002-*): Odoo records with payload fields
 * - Graph (00000001-*): FK relationships
 *
 * Features:
 * - 1024-dimensional vectors (Voyage AI voyage-3.5-lite)
 * - Cosine distance metric
 * - HNSW config: m=32, ef_construct=200 (tuned for 600K+ vectors)
 * - Scalar quantization: int8 for 75% memory reduction
 * - Superset of all indexes from 3 legacy collections
 *
 * Point type discriminator:
 * - point_type='schema' for schema definitions
 * - point_type='data' for Odoo records
 * - point_type='relationship' for FK graph edges
 *
 * @returns true if collection was created, false if already exists
 * @throws Error if vector client not initialized
 *
 * @example
 * const created = await createUnifiedCollection();
 * if (created) {
 *   console.log('Unified collection ready for migration');
 * }
 */
export async function createUnifiedCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Check if already exists
  const exists = await collectionExists(collectionName);
  if (exists) {
    console.error(`[Vector] Unified collection '${collectionName}' already exists`);
    return false;
  }

  console.error(`[Vector] Creating unified collection '${collectionName}'...`);

  // Vector configuration
  const vectorsConfig = {
    size: UNIFIED_CONFIG.VECTOR_SIZE,
    distance: UNIFIED_CONFIG.DISTANCE_METRIC,
  };

  // HNSW configuration (tuned for 600K+ vectors)
  const hnswConfig = {
    m: UNIFIED_CONFIG.HNSW_M,
    ef_construct: UNIFIED_CONFIG.HNSW_EF_CONSTRUCT,
  };

  // Create collection with scalar quantization
  await qdrantClient.createCollection(collectionName, {
    vectors: vectorsConfig,
    hnsw_config: hnswConfig,
    quantization_config: UNIFIED_CONFIG.ENABLE_SCALAR_QUANTIZATION
      ? {
          scalar: {
            type: 'int8' as const,
            quantile: UNIFIED_CONFIG.SCALAR_QUANTILE,
            always_ram: true,
          },
        }
      : undefined,
  });

  console.error(`[Vector] Created unified collection with ${UNIFIED_CONFIG.VECTOR_SIZE} dimensions`);

  // Create all payload indexes
  let indexCount = 0;
  for (const { field, type } of UNIFIED_INDEXES) {
    try {
      await qdrantClient.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: type,
      });
      indexCount++;
    } catch (error) {
      // Index might already exist or fail for some reason
      console.error(`[Vector] Warning: Could not create index for '${field}': ${error}`);
    }
  }

  console.error(`[Vector] Created ${indexCount}/${UNIFIED_INDEXES.length} payload indexes`);
  console.error(`[Vector] Unified collection '${collectionName}' ready for data migration`);

  return true;
}

/**
 * Get unified collection info
 *
 * Returns information about the unified collection including
 * vector count and index count.
 *
 * @returns Collection info object
 */
export async function getUnifiedCollectionInfo(): Promise<{
  exists: boolean;
  vectorCount: number;
  indexCount: number;
  collectionName: string;
}> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const exists = await collectionExists(collectionName);
    if (!exists) {
      return {
        exists: false,
        vectorCount: 0,
        indexCount: 0,
        collectionName,
      };
    }

    const info = await qdrantClient.getCollection(collectionName);
    const indexCount = Object.keys(info.payload_schema || {}).length;

    return {
      exists: true,
      vectorCount: info.points_count ?? 0,
      indexCount,
      collectionName,
    };
  } catch (error) {
    console.error(`[Vector] Error getting unified collection info: ${error}`);
    return {
      exists: false,
      vectorCount: 0,
      indexCount: 0,
      collectionName,
    };
  }
}

/**
 * Add missing payload indexes to unified collection
 *
 * Adds any indexes from UNIFIED_INDEXES that don't already exist.
 * This is useful when new model fields need indexing without re-syncing.
 *
 * @returns Object with added and skipped index counts
 */
export async function addMissingPayloadIndexes(): Promise<{
  added: number;
  skipped: number;
  errors: string[];
}> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const result = { added: 0, skipped: 0, errors: [] as string[] };

  // Get existing indexes
  const info = await qdrantClient.getCollection(collectionName);
  const existingIndexes = new Set(Object.keys(info.payload_schema || {}));

  console.error(`[Vector] Existing indexes: ${existingIndexes.size}`);
  console.error(`[Vector] Target indexes: ${UNIFIED_INDEXES.length}`);

  for (const { field, type } of UNIFIED_INDEXES) {
    if (existingIndexes.has(field)) {
      result.skipped++;
      continue;
    }

    try {
      await qdrantClient.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: type,
      });
      console.error(`[Vector] Created index: ${field} (${type})`);
      result.added++;
    } catch (error) {
      const msg = `Failed to create index '${field}': ${error}`;
      console.error(`[Vector] ${msg}`);
      result.errors.push(msg);
    }
  }

  console.error(`[Vector] Index update complete: ${result.added} added, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}

/**
 * Odoo field type to Qdrant index type mapping
 */
function getQdrantIndexType(odooFieldType: string): 'keyword' | 'integer' | 'float' | 'bool' {
  switch (odooFieldType) {
    case 'integer':
    case 'bigint':
      return 'integer';

    case 'float':
    case 'monetary':
      return 'float';

    case 'boolean':
      return 'bool';

    // char, text, html, selection, date, datetime, many2one, many2many, one2many
    default:
      return 'keyword';
  }
}

/**
 * Create indexes for ALL payload fields of a model dynamically.
 * No need to add fields to UNIFIED_INDEXES - reads from Excel config.
 *
 * For many2one fields, creates 3 indexes:
 * - field_name (keyword) - the [id, name] tuple
 * - field_name_id (integer) - for numeric lookups
 * - field_name_qdrant (keyword) - for graph traversal
 *
 * @param modelName - Model name for logging
 * @param payloadFields - Array of fields with field_name and field_type
 * @returns Object with created, skipped, and errors counts
 */
export async function createDynamicPayloadIndexes(
  modelName: string,
  payloadFields: Array<{ field_name: string; field_type: string }>
): Promise<{
  created: number;
  skipped: number;
  errors: string[];
}> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const result = { created: 0, skipped: 0, errors: [] as string[] };

  // Get existing indexes to avoid duplicates
  const info = await qdrantClient.getCollection(collectionName);
  const existingIndexes = new Set(Object.keys(info.payload_schema || {}));

  console.error(`[Index] Creating indexes for ${payloadFields.length} payload fields in ${modelName}`);

  for (const field of payloadFields) {
    const indexType = getQdrantIndexType(field.field_type);

    // Index the base field
    if (!existingIndexes.has(field.field_name)) {
      try {
        await qdrantClient.createPayloadIndex(collectionName, {
          field_name: field.field_name,
          field_schema: indexType,
        });
        result.created++;
        existingIndexes.add(field.field_name);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        // Ignore "already exists" errors
        if (!errMsg.includes('already exists')) {
          result.errors.push(`${field.field_name}: ${errMsg}`);
        }
      }
    } else {
      result.skipped++;
    }

    // For many2one fields, also index _id (integer) and _qdrant (keyword)
    if (field.field_type === 'many2one') {
      const idField = `${field.field_name}_id`;
      const qdrantField = `${field.field_name}_qdrant`;

      if (!existingIndexes.has(idField)) {
        try {
          await qdrantClient.createPayloadIndex(collectionName, {
            field_name: idField,
            field_schema: 'integer',
          });
          result.created++;
          existingIndexes.add(idField);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (!errMsg.includes('already exists')) {
            result.errors.push(`${idField}: ${errMsg}`);
          }
        }
      } else {
        result.skipped++;
      }

      if (!existingIndexes.has(qdrantField)) {
        try {
          await qdrantClient.createPayloadIndex(collectionName, {
            field_name: qdrantField,
            field_schema: 'keyword',
          });
          result.created++;
          existingIndexes.add(qdrantField);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (!errMsg.includes('already exists')) {
            result.errors.push(`${qdrantField}: ${errMsg}`);
          }
        }
      } else {
        result.skipped++;
      }
    }
  }

  console.error(`[Index] Dynamic index creation complete: ${result.created} created, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}

/**
 * Delete unified collection (for rollback)
 *
 * Removes the unified collection. Use this for rollback if Stage 2
 * or later stages fail.
 *
 * @returns true if deleted, false if didn't exist
 */
export async function deleteUnifiedCollection(): Promise<boolean> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const exists = await collectionExists(collectionName);
    if (!exists) {
      console.error(`[Vector] Unified collection '${collectionName}' does not exist`);
      return false;
    }

    await qdrantClient.deleteCollection(collectionName);
    console.error(`[Vector] Deleted unified collection '${collectionName}'`);
    return true;
  } catch (error) {
    console.error(`[Vector] Error deleting unified collection: ${error}`);
    return false;
  }
}

/**
 * Get list of indexes in unified collection
 *
 * Returns the names of all payload indexes configured in the unified collection.
 * Useful for verification and debugging.
 *
 * @returns Array of index field names
 */
export async function getUnifiedCollectionIndexes(): Promise<string[]> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const exists = await collectionExists(collectionName);
    if (!exists) {
      return [];
    }

    const info = await qdrantClient.getCollection(collectionName);
    return Object.keys(info.payload_schema || {});
  } catch (error) {
    console.error(`[Vector] Error getting unified collection indexes: ${error}`);
    return [];
  }
}

// =============================================================================
// SIMILARITY SEARCH (Phase 4 - Same-Model Similarity)
// =============================================================================

/**
 * Find records similar to a reference record within the same model
 *
 * Uses the reference record's EXISTING vector embedding (no re-embedding needed).
 * This is the core function for Phase 4: Same-Model Similarity.
 *
 * How it works:
 * 1. Retrieve the reference point WITH its vector from Qdrant
 * 2. Use that vector to search for similar points in the same model
 * 3. Filter out the reference point itself from results
 * 4. Return ranked results by similarity score
 *
 * Performance:
 * - Vector retrieval: ~10ms (single point)
 * - Similarity search: ~50ms (HNSW with ef=128)
 * - Total response: <100ms for 10 results
 *
 * @param referencePointId - Qdrant UUID of the reference record (e.g., "00000002-0312-0000-0000-000000123456")
 * @param options - Search configuration options
 * @returns SimilaritySearchResult with similar records and metadata
 *
 * @example
 * // Find records similar to a specific CRM lead
 * const result = await findSimilarRecords('00000002-0312-0000-0000-000000012345', {
 *   limit: 10,
 *   minSimilarity: 0.7,
 * });
 * console.log(`Found ${result.similar_records.length} similar leads`);
 */
export async function findSimilarRecords(
  referencePointId: string,
  options: {
    /** Maximum number of similar records to return (default: 10) */
    limit?: number;
    /** Minimum similarity score threshold (0-1, default: 0.5) */
    minSimilarity?: number;
    /** Model name - auto-extracted from reference if not provided */
    modelName?: string;
    /** Apply graph boost to rank by FK connection count (default: false) */
    applyGraphBoost?: boolean;
  } = {}
): Promise<SimilaritySearchResult> {
  if (!qdrantClient) throw new Error('Vector client not initialized');

  const startTime = Date.now();
  const { limit = 10, minSimilarity = 0.5, applyGraphBoost = false } = options;
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  console.error(`[Vector] findSimilarRecords: reference=${referencePointId}, limit=${limit}, minScore=${minSimilarity}`);

  // Step 1: Retrieve reference point WITH its vector
  let refPoints;
  try {
    refPoints = await qdrantClient.retrieve(collectionName, {
      ids: [referencePointId],
      with_payload: true,
      with_vector: true, // CRITICAL: Get the embedding vector
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve reference point: ${errorMsg}`);
  }

  if (refPoints.length === 0) {
    throw new Error(`Reference point not found: ${referencePointId}`);
  }

  const refPoint = refPoints[0];
  const refVector = refPoint.vector as number[];

  if (!refVector || refVector.length === 0) {
    throw new Error(`Reference point has no vector: ${referencePointId}`);
  }

  const refPayload = refPoint.payload as Record<string, unknown>;
  const modelName = options.modelName || (refPayload.model_name as string);
  const refRecordId = refPayload.record_id as number;

  if (!modelName) {
    throw new Error(`Could not determine model_name from reference point`);
  }

  console.error(`[Vector] Reference point: model=${modelName}, record_id=${refRecordId}, vector_dim=${refVector.length}`);

  // Step 2: Search for similar vectors within the same model
  const searchResults = await qdrantClient.search(collectionName, {
    vector: refVector,
    limit: limit + 1, // +1 to account for self (reference point)
    score_threshold: minSimilarity,
    filter: {
      must: [
        { key: 'point_type', match: { value: 'data' } },
        { key: 'model_name', match: { value: modelName } },
      ],
    },
    with_payload: true,
    params: {
      hnsw_ef: QDRANT_CONFIG.HNSW_EF_SEARCH, // Better recall
      quantization: QDRANT_CONFIG.ENABLE_SCALAR_QUANTIZATION && QDRANT_CONFIG.SEARCH_RESCORE
        ? {
            rescore: true,
            oversampling: QDRANT_CONFIG.SEARCH_OVERSAMPLING,
          }
        : undefined,
    },
  });

  // Step 3: Filter out self and format results
  const similarRecords: SimilarRecord[] = searchResults
    .filter(r => String(r.id) !== referencePointId) // Exclude reference point
    .slice(0, limit) // Apply limit after filtering
    .map(r => {
      const payload = r.payload as Record<string, unknown>;
      return {
        point_id: String(r.id),
        record_id: payload.record_id as number,
        model_name: payload.model_name as string,
        similarity_score: r.score,
        payload_summary: extractPayloadSummary(payload),
      };
    });

  // Step 4: Optional graph boost (count FK connections)
  if (applyGraphBoost && similarRecords.length > 0) {
    await applyGraphBoostToResults(similarRecords, collectionName);
  }

  // Step 5: Get total model records for context
  let totalModelRecords = 0;
  try {
    const countResult = await qdrantClient.count(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      exact: true,
    });
    totalModelRecords = countResult.count;
  } catch {
    // Non-critical - just for context
    console.error('[Vector] Warning: Could not get total model count');
  }

  const searchTimeMs = Date.now() - startTime;

  console.error(`[Vector] Found ${similarRecords.length} similar records in ${searchTimeMs}ms`);

  return {
    reference_point_id: referencePointId,
    reference_record_id: refRecordId,
    model_name: modelName,
    similar_records: similarRecords,
    total_model_records: totalModelRecords,
    search_params: {
      limit,
      min_similarity: minSimilarity,
      graph_boost_applied: applyGraphBoost,
    },
    search_time_ms: searchTimeMs,
  };
}

/**
 * Extract key payload fields for display in similarity results
 *
 * Returns a summary object with the most important identifiers
 * and descriptive fields for human comparison.
 */
function extractPayloadSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};

  // Priority fields to include in summary (if present)
  const priorityFields = [
    'name',           // Most common identifier
    'display_name',   // Alternative name field
    'ref',            // Reference/code field
    'code',           // Code field
    'email',          // For contacts
    'phone',          // For contacts
    'create_date',    // When created
    'expected_revenue', // For CRM leads
    'amount_total',   // For invoices/orders
    'partner_id_name', // Partner name
    'user_id_name',    // Assigned user
    'stage_id_name',   // Pipeline stage
  ];

  for (const field of priorityFields) {
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== '') {
      summary[field] = payload[field];
    }
  }

  // Always include record_id if not already
  if (!summary.record_id && payload.record_id) {
    summary.record_id = payload.record_id;
  }

  return summary;
}

/**
 * Apply graph boost to similarity results
 *
 * Queries the knowledge graph to count FK connections for each similar record.
 * Records with more connections are considered more "important" in the data model.
 *
 * This modifies the input array in place, adding connection_count to each record.
 */
async function applyGraphBoostToResults(
  records: SimilarRecord[],
  collectionName: string
): Promise<void> {
  if (!qdrantClient) return;

  // For each similar record, count incoming FK references from graph edges
  for (const record of records) {
    try {
      // Count graph edges where this record's model is the target
      const countResult = await qdrantClient.count(collectionName, {
        filter: {
          must: [
            { key: 'point_type', match: { value: 'graph' } },
            { key: 'target_model', match: { value: record.model_name } },
          ],
        },
        exact: false, // Approximate is fine for boost
      });
      record.connection_count = countResult.count;
    } catch {
      // Non-critical - skip on error
      record.connection_count = 0;
    }
  }

  // Re-sort by: similarity_score * (1 + log(1 + connection_count) / 10)
  // This gives a slight boost to more connected records without overwhelming similarity
  records.sort((a, b) => {
    const boostA = a.similarity_score * (1 + Math.log(1 + (a.connection_count || 0)) / 10);
    const boostB = b.similarity_score * (1 + Math.log(1 + (b.connection_count || 0)) / 10);
    return boostB - boostA; // Descending
  });

  console.error('[Vector] Applied graph boost to similarity results');
}
