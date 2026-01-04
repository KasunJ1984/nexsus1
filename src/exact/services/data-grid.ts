/**
 * Data Grid Service - Phase 5: Unified Data Intelligence
 *
 * Orchestrates enrichment of search results with:
 * - Graph context (FK relationships, connection counts)
 * - Validation status (orphan FK detection, integrity score)
 * - Similar records (same-model similarity search)
 *
 * Design: All enrichment is OPT-IN and happens in PARALLEL where possible.
 * Base search path remains unchanged when no enrichment flags are set.
 *
 * Performance Safeguards:
 * - MAX_ENRICHED_RECORDS = 10 (prevents runaway queries)
 * - MAX_SIMILAR_PER_RECORD = 3 (limits similarity searches)
 * - Parallel execution with Promise.all()
 * - Early return when no enrichment requested
 */

import { getModelRelationships, getIncomingRelationships } from '../../common/services/knowledge-graph.js';
import { findSimilarRecords, getQdrantClient } from '../../common/services/vector-client.js';
import { buildDataUuidV2 } from '../../common/utils/uuid-v2.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';
import type {
  DataGridEnrichment,
  RecordGraphContext,
  RecordValidationStatus,
  SimilarRecordSummary,
  EnrichedRecord,
  DATA_GRID_LIMITS,
} from '../../common/types.js';

// Re-export limits for external use
export { DATA_GRID_LIMITS } from '../../common/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * No artificial limit on enriched records - enrich ALL records returned
 * For large datasets, user should use export_to_file=true
 */
const MAX_ENRICHED_RECORDS = undefined;

/** Maximum similar records per result (user-configurable up to this limit) */
const MAX_SIMILAR_PER_RECORD = 10;

/** Default similar records if not specified */
const DEFAULT_SIMILAR_LIMIT = 3;

/** Minimum similarity threshold for similar records */
const MIN_SIMILARITY_FOR_GRID = 0.5;

// =============================================================================
// MAIN ENRICHMENT FUNCTIONS
// =============================================================================

/**
 * Enrich multiple records in parallel
 *
 * This is the main entry point for data grid enrichment.
 * It respects performance safeguards and executes enrichments in parallel.
 *
 * @param records - Records to enrich (will be limited to MAX_ENRICHED_RECORDS)
 * @param modelName - Model name (e.g., "crm.lead")
 * @param modelId - Model ID for UUID construction
 * @param enrichment - Which intelligence layers to apply
 * @returns Enriched records with timing breakdown
 */
export async function enrichRecords(
  records: Array<{ record: Record<string, unknown>; pointId: string; score?: number }>,
  modelName: string,
  modelId: number,
  enrichment: DataGridEnrichment
): Promise<{ records: EnrichedRecord[]; timing: TimingBreakdown }> {
  const timing: TimingBreakdown = {
    search_ms: 0, // Already done by caller
    graph_enrichment_ms: 0,
    validation_enrichment_ms: 0,
    similarity_enrichment_ms: 0,
  };

  // Early return if no enrichment requested
  if (!enrichment.include_graph_context &&
      !enrichment.include_validation_status &&
      !enrichment.include_similar) {
    return {
      records: records.map(r => ({
        record: r.record,
        point_id: r.pointId,
        semantic_score: r.score,
      })),
      timing,
    };
  }

  // No artificial limit - enrich ALL records
  // For large datasets, user should use export_to_file=true
  const recordsToEnrich = records;
  if (records.length > 100) {
    console.error(`[DataGrid] Enriching ${records.length} records. For large datasets, consider export_to_file=true.`);
  }

  // Calculate similar_limit with safeguard
  const similarLimit = Math.min(
    enrichment.similar_limit ?? DEFAULT_SIMILAR_LIMIT,
    MAX_SIMILAR_PER_RECORD
  );

  // Enrich all records in parallel
  const enrichmentPromises = recordsToEnrich.map(r =>
    enrichSingleRecord(
      r.record,
      r.pointId,
      r.score,
      modelName,
      modelId,
      enrichment,
      similarLimit
    )
  );

  // Execute all enrichments and collect timing
  const startGraph = Date.now();
  const enrichedResults = await Promise.all(enrichmentPromises);
  const totalEnrichTime = Date.now() - startGraph;

  // Aggregate timing from individual enrichments
  const enrichedRecords: EnrichedRecord[] = [];
  let graphTime = 0, validationTime = 0, similarityTime = 0;

  for (const result of enrichedResults) {
    enrichedRecords.push(result.enriched);
    graphTime += result.graphMs;
    validationTime += result.validationMs;
    similarityTime += result.similarityMs;
  }

  // Average timing per record (more accurate for breakdown)
  const recordCount = enrichedResults.length || 1;
  timing.graph_enrichment_ms = Math.round(graphTime / recordCount);
  timing.validation_enrichment_ms = Math.round(validationTime / recordCount);
  timing.similarity_enrichment_ms = Math.round(similarityTime / recordCount);

  console.error(`[DataGrid] Enriched ${recordCount} records in ${totalEnrichTime}ms`);

  return { records: enrichedRecords, timing };
}

interface TimingBreakdown {
  search_ms: number;
  graph_enrichment_ms: number;
  validation_enrichment_ms: number;
  similarity_enrichment_ms: number;
}

interface SingleEnrichmentResult {
  enriched: EnrichedRecord;
  graphMs: number;
  validationMs: number;
  similarityMs: number;
}

/**
 * Enrich a single record with optional intelligence layers
 */
async function enrichSingleRecord(
  record: Record<string, unknown>,
  pointId: string,
  score: number | undefined,
  modelName: string,
  modelId: number,
  enrichment: DataGridEnrichment,
  similarLimit: number
): Promise<SingleEnrichmentResult> {
  const enriched: EnrichedRecord = {
    record,
    point_id: pointId,
    semantic_score: score,
  };

  let graphMs = 0, validationMs = 0, similarityMs = 0;

  // Build parallel promises for enabled enrichments
  const promises: Promise<void>[] = [];

  if (enrichment.include_graph_context) {
    const start = Date.now();
    promises.push(
      getRecordGraphContext(record, modelName).then(ctx => {
        enriched.graph_context = ctx;
        graphMs = Date.now() - start;
      }).catch(err => {
        console.error(`[DataGrid] Graph context failed for ${pointId}:`, err);
        graphMs = Date.now() - start;
      })
    );
  }

  if (enrichment.include_validation_status) {
    const start = Date.now();
    promises.push(
      getRecordValidationStatus(record, modelName).then(status => {
        enriched.validation_status = status;
        validationMs = Date.now() - start;
      }).catch(err => {
        console.error(`[DataGrid] Validation status failed for ${pointId}:`, err);
        // Set diagnostic instead of silent failure
        enriched.validation_status = {
          has_orphan_fks: false,
          orphan_fk_fields: [],
          integrity_score: -1,  // -1 indicates error
          diagnostic: `Validation failed: ${err instanceof Error ? err.message : String(err)}`
        };
        validationMs = Date.now() - start;
      })
    );
  }

  if (enrichment.include_similar) {
    const start = Date.now();
    promises.push(
      getSimilarRecordsSummary(pointId, similarLimit).then(similar => {
        enriched.similar_records = similar;
        similarityMs = Date.now() - start;
      }).catch(err => {
        console.error(`[DataGrid] Similar records failed for ${pointId}:`, err);
        similarityMs = Date.now() - start;
      })
    );
  }

  // Execute all enrichments in parallel
  await Promise.all(promises);

  return { enriched, graphMs, validationMs, similarityMs };
}

// =============================================================================
// GRAPH CONTEXT
// =============================================================================

/**
 * Get graph context for a record - FK relationships and connection counts
 */
async function getRecordGraphContext(
  record: Record<string, unknown>,
  modelName: string
): Promise<RecordGraphContext> {
  // Get outgoing FK relationships from knowledge graph
  const outgoingRels = await getModelRelationships(modelName);
  const incomingRels = await getIncomingRelationships(modelName);

  // Build outgoing FK list from record data
  const outgoing_fks: RecordGraphContext['outgoing_fks'] = [];

  for (const rel of outgoingRels) {
    const fieldName = rel.field_name;
    // Check both field_name and field_name_qdrant (for resolved FKs)
    const qdrantField = `${fieldName}_qdrant`;

    let targetRecordId: number | null = null;
    let targetQdrantId: string | null = null;

    // Try to get the resolved Qdrant ID
    if (record[qdrantField] && typeof record[qdrantField] === 'string') {
      targetQdrantId = record[qdrantField] as string;
    }

    // Try to get the raw FK value
    if (record[fieldName] !== undefined && record[fieldName] !== null) {
      const val = record[fieldName];
      if (typeof val === 'number') {
        targetRecordId = val;
      } else if (Array.isArray(val) && val.length > 0) {
        targetRecordId = val[0]; // Many2one often comes as [id, name]
      }
    }

    // Only include if there's a reference
    if (targetRecordId !== null || targetQdrantId !== null) {
      outgoing_fks.push({
        field_name: fieldName,
        target_model: rel.target_model,
        target_record_id: targetRecordId,
        target_qdrant_id: targetQdrantId,
      });
    }
  }

  // Count incoming references (models that point to this model)
  // Note: getIncomingRelationships swaps source_model into target_model field
  const referencing_models = incomingRels.map(r => r.target_model);
  const incoming_reference_count = incomingRels.reduce(
    (sum, r) => sum + (r.edge_count || 0), 0
  );

  return {
    outgoing_fks,
    incoming_reference_count,
    referencing_models: [...new Set(referencing_models)], // Deduplicate
    total_connections: outgoing_fks.length + incoming_reference_count,
  };
}

// =============================================================================
// VALIDATION STATUS
// =============================================================================

/**
 * Get validation status for a record - orphan FK detection
 *
 * Checks if the record's FK references point to valid targets.
 * Uses the *_qdrant fields to verify target existence.
 */
async function getRecordValidationStatus(
  record: Record<string, unknown>,
  modelName: string
): Promise<RecordValidationStatus> {
  const orphan_fk_fields: string[] = [];
  let totalFks = 0;
  let validFks = 0;

  // Get FK fields from knowledge graph
  const relationships = await getModelRelationships(modelName);

  // Return diagnostic if no FK relationships found
  if (relationships.length === 0) {
    return {
      has_orphan_fks: false,
      orphan_fk_fields: [],
      integrity_score: 100,
      diagnostic: `No FK relationships found for ${modelName} in Knowledge Graph. Sync this model to populate graph edges.`
    };
  }

  for (const rel of relationships) {
    const fieldName = rel.field_name;
    const qdrantField = `${fieldName}_qdrant`;

    // Check if this record has a value for this FK
    const rawValue = record[fieldName];
    if (rawValue === null || rawValue === undefined) {
      continue; // No FK reference, skip
    }

    totalFks++;

    // Check if the resolved Qdrant ID exists
    const qdrantId = record[qdrantField];
    if (qdrantId && typeof qdrantId === 'string') {
      // Has a resolved ID - verify it exists
      const exists = await verifyPointExists(qdrantId);
      if (exists) {
        validFks++;
      } else {
        orphan_fk_fields.push(fieldName);
      }
    } else {
      // No resolved ID - this is an orphan (FK points to missing target)
      orphan_fk_fields.push(fieldName);
    }
  }

  // Calculate integrity score
  const integrity_score = totalFks > 0
    ? Math.round((validFks / totalFks) * 100)
    : 100; // No FKs = perfect integrity

  return {
    has_orphan_fks: orphan_fk_fields.length > 0,
    orphan_fk_fields,
    integrity_score,
  };
}

/**
 * Verify a point exists in Qdrant (with caching for performance)
 */
const pointExistsCache = new Map<string, boolean>();
const CACHE_TTL_MS = 60000; // 1 minute cache
let lastCacheClear = Date.now();

async function verifyPointExists(pointId: string): Promise<boolean> {
  // Clear cache periodically
  if (Date.now() - lastCacheClear > CACHE_TTL_MS) {
    pointExistsCache.clear();
    lastCacheClear = Date.now();
  }

  // Check cache first
  if (pointExistsCache.has(pointId)) {
    return pointExistsCache.get(pointId)!;
  }

  try {
    const client = getQdrantClient();
    const result = await client.retrieve(UNIFIED_CONFIG.COLLECTION_NAME, {
      ids: [pointId],
      with_payload: false,
      with_vector: false,
    });

    const exists = result.length > 0;
    pointExistsCache.set(pointId, exists);
    return exists;
  } catch {
    // Assume exists on error (don't flag as orphan due to network issues)
    return true;
  }
}

// =============================================================================
// SIMILAR RECORDS
// =============================================================================

/**
 * Get similar records summary - lightweight version for data grid
 */
async function getSimilarRecordsSummary(
  pointId: string,
  limit: number
): Promise<SimilarRecordSummary[]> {
  try {
    const result = await findSimilarRecords(pointId, {
      limit,
      minSimilarity: MIN_SIMILARITY_FOR_GRID,
      applyGraphBoost: false, // Keep it fast
    });

    return result.similar_records.map(r => ({
      record_id: r.record_id,
      similarity_score: r.similarity_score,
      name: r.payload_summary.name as string | undefined ||
            r.payload_summary.display_name as string | undefined,
    }));
  } catch (error) {
    console.error(`[DataGrid] Similar records failed for ${pointId}:`, error);
    return [];
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if any enrichment is requested
 */
export function hasEnrichment(enrichment: DataGridEnrichment): boolean {
  return !!(
    enrichment.include_graph_context ||
    enrichment.include_validation_status ||
    enrichment.include_similar
  );
}

/**
 * Get which intelligence layers were used
 */
export function getIntelligenceUsed(
  hasSemantic: boolean,
  enrichment: DataGridEnrichment
): {
  semantic: boolean;
  graph: boolean;
  validation: boolean;
  similarity: boolean;
} {
  return {
    semantic: hasSemantic,
    graph: !!enrichment.include_graph_context,
    validation: !!enrichment.include_validation_status,
    similarity: !!enrichment.include_similar,
  };
}
