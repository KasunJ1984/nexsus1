/**
 * Knowledge Graph Service
 *
 * Manages FK relationship discovery in the nexsus_unified collection.
 * Graph points use point_type='graph' and V2 Graph UUIDs (00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF).
 * Stores relationships discovered during cascade sync operations.
 *
 * Key features:
 * - Semantic search over relationships
 * - Track edge counts and cascade sources
 * - Identify leaf models (no outgoing FKs)
 * - Query outgoing relationships for any model
 */

import { createHash } from 'crypto';
import { UNIFIED_CONFIG, QDRANT_CONFIG } from '../constants.js';
import { getQdrantClient, isVectorClientAvailable, collectionExists } from './vector-client.js';
import { embed } from './embedding-service.js';
import { buildGraphUuidV2, getRelationshipTypeCode } from '../utils/uuid-v2.js';
import type {
  RelationshipPayload,
  RelationshipPoint,
  UpsertRelationshipInput,
  RelationshipInfo,
  OrphanInfo,
  CardinalityClass,
  ModelRole,
  ValidationHistoryEntry,
  ModelPatternMetadata,
  PatternExport,
  EdgePatternMetadata,
} from '../types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum number of cascade source models to track per graph edge.
 * Prevents payload bloat from unbounded array growth.
 * Keeps most recent sources (FIFO - oldest dropped when limit exceeded).
 */
const MAX_CASCADE_SOURCES = 100;

// =============================================================================
// COLLECTION MANAGEMENT
// =============================================================================

/**
 * Create the unified collection for storing FK relationships
 *
 * Collection schema:
 * - String IDs (V2 UUID format)
 * - 1024-dimensional vectors (Voyage AI)
 * - Scalar quantization enabled
 * - Payload indexes for efficient filtering
 *
 * @returns true if collection was created, false if already exists
 */
export async function createGraphCollection(): Promise<boolean> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Check if collection already exists
  const exists = await collectionExists(collectionName);
  if (exists) {
    console.error(`[Graph] Collection '${collectionName}' already exists`);
    return false;
  }

  // Vector configuration
  const vectorsConfig = {
    size: UNIFIED_CONFIG.VECTOR_SIZE,
    distance: UNIFIED_CONFIG.DISTANCE_METRIC,
  };

  // HNSW configuration (same as other collections)
  const hnswConfig = {
    m: QDRANT_CONFIG.HNSW_M,
    ef_construct: QDRANT_CONFIG.HNSW_EF_CONSTRUCT,
  };

  // Create collection with scalar quantization
  await client.createCollection(collectionName, {
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

  console.error(`[Graph] Created collection '${collectionName}' with ${UNIFIED_CONFIG.VECTOR_SIZE} dimensions`);

  // Create payload indexes for efficient filtering
  const indexFields = [
    { field: 'source_model', type: 'keyword' as const },
    { field: 'target_model', type: 'keyword' as const },
    { field: 'field_name', type: 'keyword' as const },
    { field: 'field_type', type: 'keyword' as const },
    { field: 'is_leaf', type: 'bool' as const },
    { field: 'point_type', type: 'keyword' as const },
  ];

  for (const { field, type } of indexFields) {
    try {
      await client.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist
    }
  }

  console.error(`[Graph] Created payload indexes for '${collectionName}'`);
  return true;
}

/**
 * Check if graph collection exists
 */
export async function graphCollectionExists(): Promise<boolean> {
  return collectionExists(UNIFIED_CONFIG.COLLECTION_NAME);
}

/**
 * Get graph collection statistics
 */
export async function getGraphCollectionInfo(): Promise<{
  exists: boolean;
  pointCount: number;
  collectionName: string;
}> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const info = await client.getCollection(collectionName);
    return {
      exists: true,
      pointCount: info.points_count ?? 0,
      collectionName,
    };
  } catch {
    return { exists: false, pointCount: 0, collectionName };
  }
}

// =============================================================================
// RELATIONSHIP ID GENERATION
// =============================================================================

/**
 * Generate deterministic UUID for a relationship (LEGACY - hash-based)
 *
 * @deprecated Use buildGraphUuidV2() for new code. This function uses SHA256 hash
 * which doesn't match the V2 Graph UUID format (00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF).
 * Kept for backward compatibility with getRelationship() lookups.
 *
 * Creates a unique ID from "source_model|field_name|target_model".
 * Same relationship always gets same ID (for upsert behavior).
 *
 * @param sourceModel - Source model name (e.g., "account.move.line")
 * @param fieldName - FK field name (e.g., "partner_id")
 * @param targetModel - Target model name (e.g., "res.partner")
 * @returns UUID string (hash-based, NOT V2 format)
 */
export function generateRelationshipId(
  sourceModel: string,
  fieldName: string,
  targetModel: string
): string {
  const key = `${sourceModel}|${fieldName}|${targetModel}`;
  const hash = createHash('sha256').update(key).digest('hex');
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// =============================================================================
// RELATIONSHIP CRUD OPERATIONS
// =============================================================================

/**
 * Upsert a relationship to the graph collection
 *
 * If the relationship already exists (same source+field+target), it updates:
 * - edge_count: Adds to existing count
 * - unique_targets: Updates if higher
 * - cascade_sources: Appends new source if not present
 * - last_cascade: Updates timestamp
 *
 * @param input - Relationship data to upsert
 * @returns The Qdrant point ID (UUID)
 */
export async function upsertRelationship(input: UpsertRelationshipInput): Promise<string> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Generate V2 Graph UUID: 00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF
  const relationshipCode = getRelationshipTypeCode(input.field_type);
  const pointId = buildGraphUuidV2(
    input.source_model_id,
    input.target_model_id,
    input.field_id,
    relationshipCode
  );

  // Check if relationship already exists
  const existing = await getRelationshipById(pointId);

  // Build semantic description for embedding
  const description = buildRelationshipDescription(input);

  // Generate embedding
  const vector = await embed(description, 'document');

  // Build payload
  const now = new Date().toISOString();
  let payload: RelationshipPayload;

  if (existing) {
    // Update existing relationship
    const existingSources = existing.payload.cascade_sources || [];
    let newSources = existingSources;

    if (input.cascade_source && !existingSources.includes(input.cascade_source)) {
      newSources = [...existingSources, input.cascade_source];

      // Bound cascade_sources to MAX_CASCADE_SOURCES (keeps most recent)
      if (newSources.length > MAX_CASCADE_SOURCES) {
        newSources = newSources.slice(-MAX_CASCADE_SOURCES);
      }
    }

    payload = {
      point_id: pointId,  // V2 UUID for querying/filtering
      point_type: 'graph',
      source_model: input.source_model,
      source_model_id: input.source_model_id,
      field_id: input.field_id,
      field_name: input.field_name,
      field_label: input.field_label,
      field_type: input.field_type,
      target_model: input.target_model,
      target_model_id: input.target_model_id,
      is_leaf: input.is_leaf ?? existing.payload.is_leaf,
      depth_from_origin: input.depth_from_origin ?? existing.payload.depth_from_origin,
      edge_count: existing.payload.edge_count + input.edge_count,
      unique_targets: Math.max(existing.payload.unique_targets, input.unique_targets),
      last_cascade: now,
      cascade_sources: newSources,
      description,
    };
  } else {
    // Create new relationship
    payload = {
      point_id: pointId,  // V2 UUID for querying/filtering
      point_type: 'graph',
      source_model: input.source_model,
      source_model_id: input.source_model_id,
      field_id: input.field_id,
      field_name: input.field_name,
      field_label: input.field_label,
      field_type: input.field_type,
      target_model: input.target_model,
      target_model_id: input.target_model_id,
      is_leaf: input.is_leaf ?? false,
      depth_from_origin: input.depth_from_origin ?? 0,
      edge_count: input.edge_count,
      unique_targets: input.unique_targets,
      last_cascade: now,
      cascade_sources: input.cascade_source ? [input.cascade_source] : [],
      description,
    };
  }

  // Upsert to Qdrant
  await client.upsert(collectionName, {
    wait: true,
    points: [{
      id: pointId,
      vector,
      payload: payload as unknown as Record<string, unknown>,
    }],
  });

  console.error(`[Graph] Upserted relationship: ${input.source_model}.${input.field_name} → ${input.target_model}`);
  return pointId;
}

/**
 * Build human-readable description for relationship embedding
 */
function buildRelationshipDescription(input: UpsertRelationshipInput): string {
  const typeDesc = input.field_type === 'many2one' ? 'references'
    : input.field_type === 'many2many' ? 'has many-to-many with'
    : 'has many';

  return `${input.source_model} ${input.field_name} (${input.field_label}) ${typeDesc} ${input.target_model}`;
}

/**
 * Get a relationship by its UUID
 *
 * @param pointId - Qdrant point UUID
 * @returns Relationship point if found, null otherwise
 */
export async function getRelationshipById(pointId: string): Promise<RelationshipPoint | null> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const points = await client.retrieve(collectionName, {
      ids: [pointId],
      with_payload: true,
      with_vector: false,
    });

    if (points.length === 0) {
      return null;
    }

    return {
      id: points[0].id as string,
      vector: [],
      payload: points[0].payload as unknown as RelationshipPayload,
    };
  } catch {
    return null;
  }
}

/**
 * Get a relationship by source model, field name, and target model
 *
 * @param sourceModel - Source model name
 * @param fieldName - FK field name
 * @param targetModel - Target model name
 * @returns Relationship point if found, null otherwise
 */
export async function getRelationship(
  sourceModel: string,
  fieldName: string,
  targetModel: string
): Promise<RelationshipPoint | null> {
  const pointId = generateRelationshipId(sourceModel, fieldName, targetModel);
  return getRelationshipById(pointId);
}

/**
 * Get all outgoing relationships for a model
 *
 * Returns all FK relationships where the given model is the source.
 *
 * @param modelName - Source model name (e.g., "account.move.line")
 * @returns Array of relationship info objects
 */
export async function getModelRelationships(modelName: string): Promise<RelationshipInfo[]> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Check if collection exists
  const exists = await graphCollectionExists();
  if (!exists) {
    console.error(`[Graph] Collection '${collectionName}' does not exist`);
    return [];
  }

  const results: RelationshipInfo[] = [];

  try {
    // Scroll through all relationships for this source model
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'source_model', match: { value: modelName } },
          { key: 'point_type', match: { value: 'graph' } },
        ],
      },
      limit: 100, // Most models have < 100 FK fields
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      results.push({
        field_name: payload.field_name,
        field_label: payload.field_label,
        field_type: payload.field_type,
        target_model: payload.target_model,
        target_model_id: payload.target_model_id,
        edge_count: payload.edge_count,
        unique_targets: payload.unique_targets,
        is_leaf: payload.is_leaf,
        qdrant_id: point.id as string,
      });
    }

    console.error(`[Graph] Found ${results.length} outgoing relationships for ${modelName}`);
    return results;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] getModelRelationships failed: ${errorMsg}`);
    return [];
  }
}

/**
 * Update a graph edge with validation metadata
 *
 * Called by FK validation to store orphan information in graph edges.
 * This enables querying for relationships with validation issues.
 *
 * @param pointId - Qdrant point UUID of the graph edge
 * @param orphanCount - Number of orphan FK references found
 * @param integrityScore - Integrity score (0-100%)
 * @param orphanSamples - Sample orphan records (max 10)
 */
export async function updateGraphValidation(
  pointId: string,
  orphanCount: number,
  integrityScore: number,
  orphanSamples: OrphanInfo[]
): Promise<void> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    await client.setPayload(collectionName, {
      points: [pointId],
      payload: {
        last_validation: new Date().toISOString(),
        orphan_count: orphanCount,
        validation_integrity_score: integrityScore,
        validation_samples: orphanSamples.slice(0, 10), // Limit to 10 samples
      },
    });

    console.error(`[Graph] Updated validation metadata for ${pointId}: ${orphanCount} orphans, ${integrityScore.toFixed(1)}% integrity`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] updateGraphValidation failed: ${errorMsg}`);
    throw error;
  }
}

/**
 * Update a graph edge's edge_count to match actual data
 *
 * Called by FK validation with --fix to repair stale graph edges.
 * This is a lightweight update - no re-embedding, just payload update.
 *
 * @param pointId - Qdrant point UUID of the graph edge
 * @param actualEdgeCount - The actual FK reference count from data points
 * @param actualUniqueTargets - The actual unique target count
 */
export async function updateGraphEdgeCount(
  pointId: string,
  actualEdgeCount: number,
  actualUniqueTargets: number
): Promise<void> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    await client.setPayload(collectionName, {
      points: [pointId],
      payload: {
        edge_count: actualEdgeCount,
        unique_targets: actualUniqueTargets,
        last_cascade: new Date().toISOString(), // Mark as updated
      },
    });

    console.error(`[Graph] Updated edge_count for ${pointId}: ${actualEdgeCount} edges, ${actualUniqueTargets} unique targets`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] updateGraphEdgeCount failed: ${errorMsg}`);
    throw error;
  }
}

/**
 * Get all graph edges with validation issues (orphan_count > 0)
 *
 * Useful for finding relationships that need attention.
 *
 * @returns Array of relationships with orphans
 */
export async function getRelationshipsWithOrphans(): Promise<Array<RelationshipInfo & {
  orphan_count: number;
  validation_integrity_score: number;
  last_validation: string;
}>> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return [];
  }

  const results: Array<RelationshipInfo & {
    orphan_count: number;
    validation_integrity_score: number;
    last_validation: string;
  }> = [];

  let offset: string | number | null = null;

  do {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'graph' } },
          { key: 'orphan_count', range: { gt: 0 } },
        ],
      },
      limit: 100,
      offset: offset ?? undefined,
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      results.push({
        field_name: payload.field_name,
        field_label: payload.field_label,
        field_type: payload.field_type,
        target_model: payload.target_model,
        target_model_id: payload.target_model_id,
        edge_count: payload.edge_count,
        unique_targets: payload.unique_targets,
        is_leaf: payload.is_leaf,
        qdrant_id: point.id as string,
        orphan_count: payload.orphan_count ?? 0,
        validation_integrity_score: payload.validation_integrity_score ?? 100,
        last_validation: payload.last_validation ?? '',
      });
    }

    offset = (scrollResult.next_page_offset as string | number | null) ?? null;
  } while (offset !== null);

  // Sort by orphan count (descending)
  results.sort((a, b) => b.orphan_count - a.orphan_count);

  console.error(`[Graph] Found ${results.length} relationships with orphans`);
  return results;
}

/**
 * Get all incoming relationships for a model
 *
 * Returns all FK relationships where the given model is the target.
 * Useful for finding "what references this model".
 *
 * @param modelName - Target model name (e.g., "res.partner")
 * @returns Array of relationship info objects
 */
export async function getIncomingRelationships(modelName: string): Promise<RelationshipInfo[]> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return [];
  }

  const results: RelationshipInfo[] = [];

  try {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'target_model', match: { value: modelName } },
          { key: 'point_type', match: { value: 'graph' } },
        ],
      },
      limit: 100,
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      results.push({
        field_name: payload.field_name,
        field_label: payload.field_label,
        field_type: payload.field_type,
        target_model: payload.source_model, // Swap for incoming perspective
        target_model_id: payload.source_model_id,
        edge_count: payload.edge_count,
        unique_targets: payload.unique_targets,
        is_leaf: payload.is_leaf,
        qdrant_id: point.id as string,
      });
    }

    console.error(`[Graph] Found ${results.length} incoming relationships for ${modelName}`);
    return results;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] getIncomingRelationships failed: ${errorMsg}`);
    return [];
  }
}

/**
 * Check if a model is a leaf (no outgoing FK relationships)
 *
 * @param modelName - Model name to check
 * @returns true if model has no outgoing FKs discovered
 */
export async function isLeafModel(modelName: string): Promise<boolean> {
  const relationships = await getModelRelationships(modelName);
  return relationships.length === 0;
}

/**
 * Mark a model as leaf in all relationships that reference it
 *
 * Called when we discover a model has no outgoing FKs during cascade.
 *
 * @param modelName - Model name to mark as leaf
 */
export async function markModelAsLeaf(modelName: string): Promise<void> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return;
  }

  try {
    // Find all relationships where this model is the target
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'target_model', match: { value: modelName } },
          { key: 'point_type', match: { value: 'graph' } },
        ],
      },
      limit: 100,
      with_payload: true,
    });

    // Update each relationship to mark target as leaf
    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      if (!payload.is_leaf) {
        await client.setPayload(collectionName, {
          points: [point.id as string],
          payload: { is_leaf: true },
        });
      }
    }

    console.error(`[Graph] Marked ${modelName} as leaf in ${scrollResult.points.length} relationships`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] markModelAsLeaf failed: ${errorMsg}`);
  }
}

/**
 * Semantic search for relationships
 *
 * Find relationships matching a natural language query.
 *
 * @param query - Natural language query (e.g., "partner references")
 * @param limit - Max results to return
 * @returns Matching relationship info with scores
 */
export async function searchRelationships(
  query: string,
  limit: number = 10
): Promise<Array<RelationshipInfo & { score: number }>> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return [];
  }

  // Generate query embedding
  const vector = await embed(query, 'query');

  try {
    const results = await client.search(collectionName, {
      vector,
      limit,
      score_threshold: 0.5,
      filter: {
        must: [{ key: 'point_type', match: { value: 'graph' } }],
      },
      with_payload: true,
    });

    return results.map(r => {
      const payload = r.payload as unknown as RelationshipPayload;
      return {
        field_name: payload.field_name,
        field_label: payload.field_label,
        field_type: payload.field_type,
        target_model: payload.target_model,
        target_model_id: payload.target_model_id,
        edge_count: payload.edge_count,
        unique_targets: payload.unique_targets,
        is_leaf: payload.is_leaf,
        qdrant_id: r.id as string,
        score: r.score,
      };
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] searchRelationships failed: ${errorMsg}`);
    return [];
  }
}

// =============================================================================
// GRAPH TRAVERSAL & STATISTICS
// =============================================================================

/**
 * Graph node for visualization
 */
export interface GraphNode {
  model_name: string;
  model_id: number;
  is_leaf: boolean;
  depth: number;
}

/**
 * Graph edge for visualization
 */
export interface GraphEdge {
  source_model: string;
  target_model: string;
  field_name: string;
  field_label: string;
  field_type: string;
  edge_count: number;
}

/**
 * Full relationship graph structure
 */
export interface RelationshipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  start_model: string;
  max_depth: number;
  total_relationships: number;
}

/**
 * Get full relationship graph from a starting model
 *
 * BFS traversal through outgoing FK relationships to build a graph.
 *
 * @param startModel - Starting model name
 * @param maxDepth - Maximum depth to traverse (default: 5)
 * @returns Full relationship graph
 */
export async function getRelationshipGraph(
  startModel: string,
  maxDepth: number = 5
): Promise<RelationshipGraph> {
  const nodes: Map<string, GraphNode> = new Map();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();
  const queue: Array<{ model: string; depth: number }> = [{ model: startModel, depth: 0 }];

  // Get model ID for start model (use 0 if unknown)
  nodes.set(startModel, {
    model_name: startModel,
    model_id: 0,
    is_leaf: false,
    depth: 0,
  });

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (visited.has(current.model) || current.depth >= maxDepth) {
      continue;
    }
    visited.add(current.model);

    // Get outgoing relationships
    const relationships = await getModelRelationships(current.model);

    if (relationships.length === 0) {
      // Mark as leaf
      const node = nodes.get(current.model);
      if (node) {
        node.is_leaf = true;
      }
      continue;
    }

    for (const rel of relationships) {
      // Add edge
      edges.push({
        source_model: current.model,
        target_model: rel.target_model,
        field_name: rel.field_name,
        field_label: rel.field_label,
        field_type: rel.field_type,
        edge_count: rel.edge_count,
      });

      // Add target node if not seen
      if (!nodes.has(rel.target_model)) {
        nodes.set(rel.target_model, {
          model_name: rel.target_model,
          model_id: rel.target_model_id,
          is_leaf: rel.is_leaf,
          depth: current.depth + 1,
        });

        // Queue for traversal
        if (!visited.has(rel.target_model)) {
          queue.push({ model: rel.target_model, depth: current.depth + 1 });
        }
      }
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
    start_model: startModel,
    max_depth: maxDepth,
    total_relationships: edges.length,
  };
}

/**
 * Graph statistics
 */
export interface GraphStats {
  total_relationships: number;
  unique_source_models: number;
  unique_target_models: number;
  leaf_models: number;
  cascade_sources: string[];
  most_connected_models: Array<{ model: string; outgoing: number; incoming: number }>;
}

/**
 * Get statistics about the knowledge graph
 *
 * @returns Graph statistics
 */
export async function getGraphStats(): Promise<GraphStats> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return {
      total_relationships: 0,
      unique_source_models: 0,
      unique_target_models: 0,
      leaf_models: 0,
      cascade_sources: [],
      most_connected_models: [],
    };
  }

  const sourceModels = new Set<string>();
  const targetModels = new Set<string>();
  const leafModels = new Set<string>();
  const cascadeSources = new Set<string>();
  const modelConnections = new Map<string, { outgoing: number; incoming: number }>();

  let totalRelationships = 0;
  let offset: string | number | null = null;

  // Scroll through all relationships
  do {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'graph' } }],
      },
      limit: 100,
      offset: offset ?? undefined,
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      totalRelationships++;

      sourceModels.add(payload.source_model);
      targetModels.add(payload.target_model);

      if (payload.is_leaf) {
        leafModels.add(payload.target_model);
      }

      for (const source of payload.cascade_sources || []) {
        cascadeSources.add(source);
      }

      // Track connections
      const srcConn = modelConnections.get(payload.source_model) || { outgoing: 0, incoming: 0 };
      srcConn.outgoing++;
      modelConnections.set(payload.source_model, srcConn);

      const tgtConn = modelConnections.get(payload.target_model) || { outgoing: 0, incoming: 0 };
      tgtConn.incoming++;
      modelConnections.set(payload.target_model, tgtConn);
    }

    offset = (scrollResult.next_page_offset as string | number | null) ?? null;
  } while (offset !== null);

  // Find most connected models
  const sortedModels = Array.from(modelConnections.entries())
    .map(([model, conn]) => ({ model, ...conn }))
    .sort((a, b) => (b.outgoing + b.incoming) - (a.outgoing + a.incoming))
    .slice(0, 10);

  return {
    total_relationships: totalRelationships,
    unique_source_models: sourceModels.size,
    unique_target_models: targetModels.size,
    leaf_models: leafModels.size,
    cascade_sources: Array.from(cascadeSources),
    most_connected_models: sortedModels,
  };
}

/**
 * Get all leaf models (models with no outgoing FKs)
 *
 * @returns Array of model names marked as leaves
 */
export async function getAllLeafModels(): Promise<string[]> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return [];
  }

  const leafModels = new Set<string>();
  let offset: string | number | null = null;

  do {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'graph' } },
          { key: 'is_leaf', match: { value: true } },
        ],
      },
      limit: 100,
      offset: offset ?? undefined,
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      leafModels.add(payload.target_model);
    }

    offset = (scrollResult.next_page_offset as string | number | null) ?? null;
  } while (offset !== null);

  return Array.from(leafModels).sort();
}

/**
 * Get relationships by cascade source
 *
 * Find all relationships discovered during a specific cascade sync.
 *
 * @param cascadeSource - Model name that triggered the cascade
 * @returns Array of relationships discovered from that source
 */
export async function getRelationshipsByCascadeSource(
  cascadeSource: string
): Promise<RelationshipInfo[]> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const exists = await graphCollectionExists();
  if (!exists) {
    return [];
  }

  const results: RelationshipInfo[] = [];
  let offset: string | number | null = null;

  do {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'graph' } }],
      },
      limit: 100,
      offset: offset ?? undefined,
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;
      if (payload.cascade_sources?.includes(cascadeSource)) {
        results.push({
          field_name: payload.field_name,
          field_label: payload.field_label,
          field_type: payload.field_type,
          target_model: payload.target_model,
          target_model_id: payload.target_model_id,
          edge_count: payload.edge_count,
          unique_targets: payload.unique_targets,
          is_leaf: payload.is_leaf,
          qdrant_id: point.id as string,
        });
      }
    }

    offset = (scrollResult.next_page_offset as string | number | null) ?? null;
  } while (offset !== null);

  return results;
}

/**
 * Format relationship graph for display
 *
 * @param graph - Relationship graph
 * @returns Formatted string
 */
export function formatRelationshipGraph(graph: RelationshipGraph): string {
  const lines: string[] = [];

  lines.push(`# Relationship Graph: ${graph.start_model}`);
  lines.push(`Max Depth: ${graph.max_depth}`);
  lines.push(`Total Nodes: ${graph.nodes.length}`);
  lines.push(`Total Edges: ${graph.edges.length}`);
  lines.push('');

  // Group nodes by depth
  const nodesByDepth = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const depth = node.depth;
    if (!nodesByDepth.has(depth)) {
      nodesByDepth.set(depth, []);
    }
    nodesByDepth.get(depth)!.push(node);
  }

  lines.push('## Nodes by Depth');
  for (const [depth, nodes] of Array.from(nodesByDepth.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(`\n### Depth ${depth}`);
    for (const node of nodes) {
      const leafMarker = node.is_leaf ? ' [LEAF]' : '';
      lines.push(`- ${node.model_name}${leafMarker}`);
    }
  }

  lines.push('\n## Edges');
  for (const edge of graph.edges.slice(0, 50)) { // Limit for readability
    lines.push(`- ${edge.source_model} → ${edge.target_model} (${edge.field_name}: ${edge.edge_count} edges)`);
  }

  if (graph.edges.length > 50) {
    lines.push(`... and ${graph.edges.length - 50} more edges`);
  }

  return lines.join('\n');
}

// =============================================================================
// PATTERN EXTRACTION FUNCTIONS (Phase 3)
// =============================================================================

/**
 * Classify edge cardinality from edge_count and unique_targets
 *
 * Cardinality patterns help ML understand relationship density:
 * - one_to_one: Almost every FK reference points to a unique target
 * - one_to_few: Multiple sources share some targets (1-5 avg refs per target)
 * - one_to_many: Many sources point to the same targets (concentrated)
 *
 * @param edgeCount - Total FK references
 * @param uniqueTargets - Unique target records
 * @returns Classification result
 */
export function classifyCardinality(
  edgeCount: number,
  uniqueTargets: number
): { class: CardinalityClass; ratio: number; avgRefs: number } {
  // Avoid division by zero
  if (uniqueTargets === 0 || edgeCount === 0) {
    return { class: 'one_to_one', ratio: 1, avgRefs: 1 };
  }

  const ratio = uniqueTargets / edgeCount;
  const avgRefs = edgeCount / uniqueTargets;

  let cardinalityClass: CardinalityClass;
  if (ratio >= 0.95) {
    cardinalityClass = 'one_to_one';
  } else if (ratio >= 0.2) {
    cardinalityClass = 'one_to_few';
  } else {
    cardinalityClass = 'one_to_many';
  }

  return {
    class: cardinalityClass,
    ratio: Math.round(ratio * 1000) / 1000, // Round to 3 decimal places
    avgRefs: Math.round(avgRefs * 100) / 100, // Round to 2 decimal places
  };
}

/**
 * Classify model role based on in/out degree
 *
 * Model roles help ML understand data flow patterns:
 * - hub: Central entities (res.partner) with many in + out connections
 * - source: Data originators (crm.lead) with high out, low in
 * - sink: Aggregation points (account.account) with high in, low out
 * - leaf: Terminal nodes (crm.stage) with zero outgoing FKs
 * - bridge: Connects different parts of the graph
 * - isolated: Few total connections
 *
 * @param incomingDegree - Number of edges where model is target
 * @param outgoingDegree - Number of edges where model is source
 * @returns Model role classification
 */
export function classifyModelRole(
  incomingDegree: number,
  outgoingDegree: number
): ModelRole {
  const totalDegree = incomingDegree + outgoingDegree;

  // Leaf: No outgoing FKs
  if (outgoingDegree === 0) {
    return 'leaf';
  }

  // Isolated: Few total connections
  if (totalDegree < 3) {
    return 'isolated';
  }

  // Hub: High in + out (both > 10)
  if (incomingDegree > 10 && outgoingDegree > 10) {
    return 'hub';
  }

  // Source: High out (>5), low in (<3)
  if (outgoingDegree > 5 && incomingDegree < 3) {
    return 'source';
  }

  // Sink: High in (>5), low out (<3)
  if (incomingDegree > 5 && outgoingDegree < 3) {
    return 'sink';
  }

  // Bridge: Moderate connections on both sides (3-10)
  return 'bridge';
}

/**
 * Compute integrity trend from validation history
 *
 * Analyzes the slope of integrity scores to determine trend:
 * - improving: Scores are getting better (positive slope)
 * - stable: Scores are relatively constant (slope near zero)
 * - degrading: Scores are getting worse (negative slope)
 *
 * @param history - Array of validation history entries
 * @returns Trend classification
 */
export function computeIntegrityTrend(
  history: ValidationHistoryEntry[]
): 'improving' | 'stable' | 'degrading' {
  if (!history || history.length < 2) {
    return 'stable'; // Not enough data
  }

  // Simple linear regression on integrity_score
  const n = history.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += history[i].integrity_score;
    sumXY += i * history[i].integrity_score;
    sumX2 += i * i;
  }

  // Calculate slope
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Thresholds for trend determination
  if (slope > 0.5) {
    return 'improving';
  } else if (slope < -0.5) {
    return 'degrading';
  } else {
    return 'stable';
  }
}

/**
 * Append validation entry to edge's validation history (rolling window of 10)
 *
 * @param pointId - Graph edge UUID
 * @param entry - Validation entry to append
 */
export async function appendValidationHistory(
  pointId: string,
  entry: Omit<ValidationHistoryEntry, 'delta_from_previous'>
): Promise<void> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Get existing edge
    const points = await client.retrieve(collectionName, {
      ids: [pointId],
      with_payload: true,
    });

    if (points.length === 0) {
      console.error(`[Graph] Edge not found: ${pointId}`);
      return;
    }

    const payload = points[0].payload as unknown as RelationshipPayload;
    const existingHistory = payload.validation_history || [];

    // Calculate delta from previous
    const previousScore = existingHistory.length > 0
      ? existingHistory[existingHistory.length - 1].integrity_score
      : entry.integrity_score;
    const delta = entry.integrity_score - previousScore;

    // Create new entry with delta
    const newEntry: ValidationHistoryEntry = {
      ...entry,
      delta_from_previous: Math.round(delta * 100) / 100,
    };

    // Append to history, keep last 10 entries
    const updatedHistory = [...existingHistory, newEntry].slice(-10);

    // Compute trend from updated history
    const trend = computeIntegrityTrend(updatedHistory);

    // Update edge payload
    await client.setPayload(collectionName, {
      points: [pointId],
      payload: {
        validation_history: updatedHistory,
        integrity_trend: trend,
      },
    });

    console.error(`[Graph] Updated validation history for ${pointId}: ${updatedHistory.length} entries, trend=${trend}`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] appendValidationHistory failed: ${errorMsg}`);
    throw error;
  }
}

/**
 * Update edge pattern metadata (cardinality class, ratio, avgRefs)
 *
 * @param pointId - Graph edge UUID
 * @param edgeCount - Total edge count
 * @param uniqueTargets - Unique target count
 */
export async function updateEdgePatternMetadata(
  pointId: string,
  edgeCount: number,
  uniqueTargets: number
): Promise<void> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const { class: cardinalityClass, ratio, avgRefs } = classifyCardinality(edgeCount, uniqueTargets);

    await client.setPayload(collectionName, {
      points: [pointId],
      payload: {
        cardinality_class: cardinalityClass,
        cardinality_ratio: ratio,
        avg_refs_per_target: avgRefs,
      },
    });

    console.error(`[Graph] Updated pattern metadata for ${pointId}: ${cardinalityClass} (ratio=${ratio}, avgRefs=${avgRefs})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] updateEdgePatternMetadata failed: ${errorMsg}`);
    throw error;
  }
}

/**
 * Get model pattern metadata (aggregated from edges)
 *
 * @param modelName - Model name to analyze
 * @returns Model pattern metadata
 */
export async function getModelPattern(modelName: string): Promise<ModelPatternMetadata> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  // Get outgoing and incoming relationships
  const outgoing = await getModelRelationships(modelName);
  const incoming = await getIncomingRelationships(modelName);

  const outgoingDegree = outgoing.length;
  const incomingDegree = incoming.length;
  const role = classifyModelRole(incomingDegree, outgoingDegree);

  // Get source_model_id from the first outgoing relationship (if exists)
  let modelId = 0;
  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'source_model', match: { value: modelName } },
          { key: 'point_type', match: { value: 'graph' } },
        ],
      },
      limit: 1,
      with_payload: true,
    });

    if (scrollResult.points.length > 0) {
      const payload = scrollResult.points[0].payload as unknown as RelationshipPayload;
      modelId = payload.source_model_id;
    }
  } catch {
    // Ignore - modelId stays 0
  }

  // Calculate aggregate statistics from outgoing edges
  let totalIntegrity = 0;
  let validatedCount = 0;
  let worstField: string | undefined;
  let worstScore = 100;

  for (const rel of outgoing) {
    // Try to get validation score from full edge
    const client = getQdrantClient();
    const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

    try {
      const points = await client.retrieve(collectionName, {
        ids: [rel.qdrant_id],
        with_payload: true,
      });

      if (points.length > 0) {
        const payload = points[0].payload as unknown as RelationshipPayload;
        if (payload.validation_integrity_score !== undefined) {
          totalIntegrity += payload.validation_integrity_score;
          validatedCount++;

          if (payload.validation_integrity_score < worstScore) {
            worstScore = payload.validation_integrity_score;
            worstField = rel.field_name;
          }
        }
      }
    } catch {
      // Ignore individual edge errors
    }
  }

  const avgIntegrityScore = validatedCount > 0
    ? Math.round((totalIntegrity / validatedCount) * 100) / 100
    : 100;

  return {
    model_name: modelName,
    model_id: modelId,
    role,
    incoming_degree: incomingDegree,
    outgoing_degree: outgoingDegree,
    total_degree: incomingDegree + outgoingDegree,
    avg_integrity_score: avgIntegrityScore,
    worst_fk_field: worstField,
    worst_integrity_score: worstField ? worstScore : undefined,
    validation_count: validatedCount,
  };
}

/**
 * Get all model patterns for export
 *
 * @returns Array of model pattern metadata
 */
export async function getAllModelPatterns(): Promise<ModelPatternMetadata[]> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // First, get all unique source models from graph edges
  const sourceModels = new Set<string>();

  let offset: string | number | null = null;
  do {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'graph' } }],
      },
      limit: 100,
      offset: offset ?? undefined,
      with_payload: ['source_model'],
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as { source_model?: string };
      if (payload.source_model) {
        sourceModels.add(payload.source_model);
      }
    }

    offset = (scrollResult.next_page_offset as string | number | null) ?? null;
  } while (offset !== null);

  console.error(`[Graph] Found ${sourceModels.size} unique models for pattern analysis`);

  // Get pattern metadata for each model
  const patterns: ModelPatternMetadata[] = [];
  for (const modelName of sourceModels) {
    try {
      const pattern = await getModelPattern(modelName);
      patterns.push(pattern);
    } catch (error) {
      console.error(`[Graph] Failed to get pattern for ${modelName}: ${error}`);
    }
  }

  return patterns;
}

/**
 * Export all patterns for ML training
 *
 * @returns Complete pattern export
 */
export async function exportPatterns(): Promise<PatternExport> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  console.error('[Graph] Starting pattern export...');

  // Get all model patterns
  const models = await getAllModelPatterns();

  // Classify models by role
  const hubs: string[] = [];
  const sources: string[] = [];
  const sinks: string[] = [];
  const leaves: string[] = [];

  for (const model of models) {
    switch (model.role) {
      case 'hub':
        hubs.push(model.model_name);
        break;
      case 'source':
        sources.push(model.model_name);
        break;
      case 'sink':
        sinks.push(model.model_name);
        break;
      case 'leaf':
        leaves.push(model.model_name);
        break;
    }
  }

  // Get all edges with pattern metadata
  const edges: Array<RelationshipPayload & Partial<EdgePatternMetadata>> = [];
  let totalIntegrity = 0;
  let integrityCount = 0;

  let offset: string | number | null = null;
  do {
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'graph' } }],
      },
      limit: 100,
      offset: offset ?? undefined,
      with_payload: true,
    });

    for (const point of scrollResult.points) {
      const payload = point.payload as unknown as RelationshipPayload;

      // Compute cardinality if not already present
      let cardinalityClass = payload.cardinality_class;
      let cardinalityRatio = payload.cardinality_ratio;
      let avgRefsPerTarget = payload.avg_refs_per_target;

      if (!cardinalityClass) {
        const cardinality = classifyCardinality(payload.edge_count, payload.unique_targets);
        cardinalityClass = cardinality.class;
        cardinalityRatio = cardinality.ratio;
        avgRefsPerTarget = cardinality.avgRefs;
      }

      edges.push({
        ...payload,
        cardinality_class: cardinalityClass,
        cardinality_ratio: cardinalityRatio,
        avg_refs_per_target: avgRefsPerTarget,
      });

      // Accumulate integrity for average
      if (payload.validation_integrity_score !== undefined) {
        totalIntegrity += payload.validation_integrity_score;
        integrityCount++;
      }
    }

    offset = (scrollResult.next_page_offset as string | number | null) ?? null;
  } while (offset !== null);

  const avgGlobalIntegrity = integrityCount > 0
    ? Math.round((totalIntegrity / integrityCount) * 100) / 100
    : 100;

  console.error(`[Graph] Pattern export complete: ${models.length} models, ${edges.length} edges`);

  return {
    export_timestamp: new Date().toISOString(),
    version: '1.0.0',
    models,
    edges,
    summary: {
      total_models: models.length,
      total_edges: edges.length,
      hubs,
      sources,
      sinks,
      leaves,
      avg_global_integrity: avgGlobalIntegrity,
    },
  };
}

// =============================================================================
// GRAPH EDGE INSPECTION
// =============================================================================

/**
 * Result of graph edge lookup
 */
export interface GraphEdgeResult {
  /** Whether the edge was found */
  found: boolean;
  /** The edge payload (if found) */
  edge?: RelationshipPayload;
  /** Qdrant point ID (if found) */
  pointId?: string;
  /** Error message (if not found) */
  error?: string;
}

/**
 * Look up a graph edge by source model, target model, and field name
 *
 * Use this to inspect specific FK relationships including cascade_sources.
 *
 * @param sourceModel - Source model containing the FK (e.g., "crm.lead")
 * @param targetModel - Target model referenced by FK (e.g., "res.partner")
 * @param fieldName - FK field name (e.g., "partner_id")
 * @returns GraphEdgeResult with edge payload if found
 *
 * @example
 * const result = await getRelationshipByFields("crm.lead", "res.partner", "partner_id");
 * if (result.found) {
 *   console.log(result.edge.cascade_sources); // Models that discovered this edge
 * }
 */
export async function getRelationshipByFields(
  sourceModel: string,
  targetModel: string,
  fieldName: string
): Promise<GraphEdgeResult> {
  if (!isVectorClientAvailable()) {
    return {
      found: false,
      error: 'Vector client not initialized'
    };
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Check collection exists
    const exists = await collectionExists(collectionName);
    if (!exists) {
      return {
        found: false,
        error: `Collection '${collectionName}' does not exist`
      };
    }

    // Search for the specific graph edge
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'graph' } },
          { key: 'source_model', match: { value: sourceModel } },
          { key: 'target_model', match: { value: targetModel } },
          { key: 'field_name', match: { value: fieldName } },
        ]
      },
      limit: 1,
      with_payload: true,
    });

    if (scrollResult.points.length === 0) {
      return {
        found: false,
        error: `No graph edge found: ${sourceModel}.${fieldName} -> ${targetModel}`
      };
    }

    const point = scrollResult.points[0];
    const payload = point.payload as unknown as RelationshipPayload;

    return {
      found: true,
      edge: payload,
      pointId: point.id as string
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Graph] getRelationshipByFields failed: ${errorMsg}`);
    return {
      found: false,
      error: `Graph lookup failed: ${errorMsg}`
    };
  }
}

// =============================================================================
// GRAPH CONTEXT (moved from semantic/services/graph-search-engine.ts)
// =============================================================================

import { GRAPH_CACHE_CONFIG } from '../constants.js';

/**
 * Direction for graph context queries
 */
export type GraphDirection = 'outgoing' | 'incoming' | 'both';

/**
 * Options for getGraphContext
 */
export interface GraphContextOptions {
  direction?: GraphDirection;
  limit?: number;
}

/**
 * Graph context result
 */
export interface GraphContext {
  modelName: string;
  outgoing: RelationshipInfo[];
  incoming: RelationshipInfo[];
  totalEdges: number;
  fromCache: boolean;
}

/**
 * Cache for graph context by model
 * Key: modelName
 * Value: { data, timestamp }
 */
const graphContextCache = new Map<string, {
  data: GraphContext;
  timestamp: number;
}>();

/**
 * Cache TTL in milliseconds (configurable via GRAPH_CACHE_TTL_MS env var)
 */
const CACHE_TTL_MS = GRAPH_CACHE_CONFIG.TTL_MS;

/**
 * Clear expired cache entries
 */
function clearExpiredCache(): void {
  const now = Date.now();
  for (const [key, value] of graphContextCache.entries()) {
    if (now - value.timestamp > CACHE_TTL_MS) {
      graphContextCache.delete(key);
    }
  }
}

/**
 * Clear all cache entries (for testing)
 */
export function clearGraphCache(): void {
  graphContextCache.clear();
  console.error('[GraphContext] Cache cleared');
}

/**
 * Get cache statistics
 */
export function getGraphCacheStats(): { size: number; models: string[] } {
  return {
    size: graphContextCache.size,
    models: Array.from(graphContextCache.keys()),
  };
}

/**
 * Fetch graph edges for a model
 *
 * Retrieves both outgoing and incoming FK relationships from the
 * knowledge graph. Results are cached for 5 minutes.
 *
 * @param modelName - Odoo model name (e.g., "account.move.line")
 * @param options - Query options
 * @returns Graph context with relationships
 *
 * @example
 * const context = await getGraphContext('crm.lead');
 * console.log(`Outgoing: ${context.outgoing.length}, Incoming: ${context.incoming.length}`);
 */
export async function getGraphContext(
  modelName: string,
  options: GraphContextOptions = {}
): Promise<GraphContext> {
  const { direction = 'both', limit } = options;

  // Check cache first
  clearExpiredCache();
  const cacheKey = modelName;
  const cached = graphContextCache.get(cacheKey);

  if (cached) {
    console.error(`[GraphContext] Cache hit for ${modelName}`);

    // Apply direction filter to cached data
    let outgoing = cached.data.outgoing;
    let incoming = cached.data.incoming;

    if (direction === 'outgoing') {
      incoming = [];
    } else if (direction === 'incoming') {
      outgoing = [];
    }

    if (limit) {
      outgoing = outgoing.slice(0, limit);
      incoming = incoming.slice(0, limit);
    }

    return {
      ...cached.data,
      outgoing,
      incoming,
      totalEdges: outgoing.length + incoming.length,
      fromCache: true,
    };
  }

  console.error(`[GraphContext] Fetching graph context for ${modelName}`);

  // Fetch from knowledge graph
  let outgoing: RelationshipInfo[] = [];
  let incoming: RelationshipInfo[] = [];

  if (direction === 'outgoing' || direction === 'both') {
    outgoing = await getModelRelationships(modelName);
  }

  if (direction === 'incoming' || direction === 'both') {
    incoming = await getIncomingRelationships(modelName);
  }

  // Build result
  const result: GraphContext = {
    modelName,
    outgoing,
    incoming,
    totalEdges: outgoing.length + incoming.length,
    fromCache: false,
  };

  // Cache the full result (both directions)
  if (direction === 'both') {
    graphContextCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });
    console.error(`[GraphContext] Cached context for ${modelName}: ${result.totalEdges} edges`);
  }

  // Apply limit if specified
  if (limit) {
    result.outgoing = result.outgoing.slice(0, limit);
    result.incoming = result.incoming.slice(0, limit);
    result.totalEdges = result.outgoing.length + result.incoming.length;
  }

  return result;
}
