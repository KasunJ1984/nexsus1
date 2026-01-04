/**
 * Pipeline Data Sync Service
 *
 * Orchestrates the sync of Odoo records to Qdrant using the new Excel-based pipeline.
 *
 * Key differences from data-sync.ts:
 * - Schema loaded from Excel files (not odoo_schema.txt)
 * - Vector_Id format: model_id^record_id (string)
 * - Payload includes only fields with payload=1
 * - Vector text is human-readable format
 * - Empty/null fields are skipped
 *
 * Process Flow:
 * 1. Load schema from Excel files
 * 2. Validate model configuration
 * 3. Fetch records from Odoo
 * 4. Transform records (skip empty fields)
 * 5. Generate embeddings
 * 6. Upload to Qdrant
 */

import * as fs from 'fs';
import * as path from 'path';
import { getOdooClient } from './odoo-client.js';
import { embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import {
  initializeVectorClient,
  isVectorClientAvailable,
  createPipelineDataCollection,
  upsertToUnifiedCollection,
  getPipelineCollectionInfo,
  collectionExists,
  countPipelineData,
  discoverModelsInQdrant,
  getModelDateRange,
  type ModelDateRangeResult,
} from './vector-client.js';
import {
  getModelFieldsFromSchema,
  getPayloadFieldsFromSchema,
  getOdooFieldNamesFromSchema,
  getModelIdFromSchema,
  modelExistsInSchema,
  getPrimaryKeyFieldIdFromSchema,
  getSchemaStats,
  getFkFieldsFromSchema,
  isQdrantSchemaEmpty,
} from './schema-query-service.js';
import { buildGraphUuidV2, buildDataUuidV2, getRelationshipTypeCode } from '../utils/uuid-v2.js';
import {
  transformPipelineRecords,
} from './pipeline-data-transformer.js';
import { PIPELINE_CONFIG, UNIFIED_CONFIG } from '../constants.js';
import { getAllDataSyncMetadata } from './sync-metadata.js';
import type {
  PipelineSyncOptions,
  PipelineSyncResult,
  PipelineDataPoint,
  PipelineDataPayload,
  EncodedPipelineRecord,
  SyncFkDependency,
} from '../types.js';
import {
  getFkFieldsForModel,
  type FkFieldInfo,
} from './fk-dependency-discovery.js';

// =============================================================================
// FK DEPENDENCY ACCUMULATOR
// =============================================================================

/**
 * Accumulator for collecting FK IDs during streaming sync
 *
 * Designed for memory-efficient accumulation across all batches.
 * Uses Sets to deduplicate IDs automatically.
 */
interface FkIdAccumulator {
  /** FK field info from schema */
  fieldInfo: FkFieldInfo;
  /** Set of unique FK IDs found */
  ids: Set<number>;
  /** Total reference count (for statistics) */
  totalRefs: number;
}

/**
 * Extract many2one ID from Odoo field value
 *
 * Handles both [id, name] tuple format and direct number format.
 */
function extractMany2OneId(value: unknown): number | null {
  if (value === null || value === undefined || value === false) {
    return null;
  }
  // Array format: [id, name]
  if (Array.isArray(value) && value.length >= 1) {
    const id = value[0];
    if (typeof id === 'number' && id > 0) {
      return id;
    }
  }
  // Direct number
  if (typeof value === 'number' && value > 0) {
    return value;
  }
  return null;
}

/**
 * Extract IDs from many2many/one2many field value
 */
function extractMany2ManyIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is number => typeof v === 'number' && v > 0);
}

/**
 * Accumulate FK IDs from a batch of records
 *
 * This function is called after each batch is fetched from Odoo.
 * It extracts FK IDs and adds them to the accumulators.
 *
 * @param records - Batch of raw Odoo records
 * @param accumulators - Map of field_name -> FkIdAccumulator
 */
function accumulateFkIds(
  records: Array<Record<string, unknown>>,
  accumulators: Map<string, FkIdAccumulator>
): void {
  for (const record of records) {
    for (const [fieldName, accumulator] of accumulators) {
      const value = record[fieldName];

      if (value === null || value === undefined || value === false) {
        continue;
      }

      if (accumulator.fieldInfo.field_type === 'many2one') {
        const id = extractMany2OneId(value);
        if (id !== null) {
          accumulator.ids.add(id);
          accumulator.totalRefs++;
        }
      } else {
        // many2many or one2many
        const ids = extractMany2ManyIds(value);
        for (const id of ids) {
          accumulator.ids.add(id);
          accumulator.totalRefs++;
        }
      }
    }
  }
}

/**
 * Convert accumulators to SyncFkDependency array
 *
 * Includes full field metadata for knowledge graph updates.
 */
function finalizeFkDependencies(
  accumulators: Map<string, FkIdAccumulator>
): SyncFkDependency[] {
  const dependencies: SyncFkDependency[] = [];

  for (const [fieldName, accumulator] of accumulators) {
    // Only include fields that have actual FK IDs
    if (accumulator.ids.size > 0) {
      dependencies.push({
        field_id: accumulator.fieldInfo.field_id,
        field_name: fieldName,
        field_label: accumulator.fieldInfo.field_label,
        field_type: accumulator.fieldInfo.field_type,
        target_model: accumulator.fieldInfo.target_model,
        target_model_id: accumulator.fieldInfo.target_model_id,
        unique_ids: Array.from(accumulator.ids).sort((a, b) => a - b),
        total_references: accumulator.totalRefs,
      });
    }
  }

  return dependencies;
}

// =============================================================================
// SYNC METADATA
// =============================================================================

interface PipelineSyncMetadata {
  [modelName: string]: {
    last_sync_timestamp: string;
    record_count: number;
    field_count: number;
    /** Oldest record by create_date (if available in payload) */
    oldest_record?: { create_date: string; record_id: number; uuid: string } | null;
    /** Newest record by create_date (if available in payload) */
    newest_record?: { create_date: string; record_id: number; uuid: string } | null;
  };
}

/**
 * Load sync metadata from file
 */
function loadSyncMetadata(): PipelineSyncMetadata {
  const metadataPath = path.resolve(process.cwd(), PIPELINE_CONFIG.METADATA_FILE);

  if (!fs.existsSync(metadataPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(metadataPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    console.error('[PipelineSync] Failed to load sync metadata, starting fresh');
    return {};
  }
}

/**
 * Save sync metadata to file
 */
function saveSyncMetadata(metadata: PipelineSyncMetadata): void {
  const metadataPath = path.resolve(process.cwd(), PIPELINE_CONFIG.METADATA_FILE);
  const dir = path.dirname(metadataPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.error(`[PipelineSync] Saved sync metadata to ${metadataPath}`);
}

/**
 * Get last sync timestamp for a model
 */
export function getLastPipelineSyncTimestamp(modelName: string): string | null {
  const metadata = loadSyncMetadata();
  return metadata[modelName]?.last_sync_timestamp || null;
}

/**
 * Clear pipeline sync metadata for a model (forces full sync next time)
 *
 * @param modelName - Odoo model name
 */
export function clearPipelineSyncMetadata(modelName: string): void {
  const metadata = loadSyncMetadata();
  if (metadata[modelName]) {
    delete metadata[modelName];
    saveSyncMetadata(metadata);
    console.error(`[PipelineSync] Cleared sync metadata for ${modelName} - next sync will be full`);
  } else {
    console.error(`[PipelineSync] No metadata found for ${modelName}`);
  }
}

// =============================================================================
// CONCURRENT SYNC PREVENTION
// =============================================================================

const activePipelineSyncs = new Map<string, {
  startTime: number;
  progress: number;
  totalRecords: number;
}>();

/**
 * Check if a pipeline sync is in progress
 */
export function isPipelineSyncInProgress(modelName: string): boolean {
  return activePipelineSyncs.has(modelName);
}

/**
 * Async version of validateModelForPipeline using Qdrant schema
 *
 * Validates that a model exists in Qdrant schema and has:
 * - Valid model_id
 * - At least one payload field configured
 */
async function validateModelForPipelineAsync(modelName: string): Promise<{
  valid: boolean;
  errors: string[];
  config?: {
    model_name: string;
    model_id: number;
    total_fields: number;
    payload_field_count: number;
    primary_key_field_id: number;
  };
}> {
  const errors: string[] = [];

  // Pre-flight: Check if ANY schema exists
  const schemaEmpty = await isQdrantSchemaEmpty();
  if (schemaEmpty) {
    errors.push(`Schema is empty. Run 'npm run sync -- sync schema' first`);
    return { valid: false, errors };
  }

  // Check if model exists in schema
  const exists = await modelExistsInSchema(modelName);
  if (!exists) {
    errors.push(`Model '${modelName}' not found in Qdrant schema`);
    return { valid: false, errors };
  }

  // Get model ID
  const modelId = await getModelIdFromSchema(modelName);
  if (!modelId) {
    errors.push(`Model '${modelName}' has no model_id`);
  }

  // Get primary key field ID
  const primaryKeyFieldId = await getPrimaryKeyFieldIdFromSchema(modelName);
  if (!primaryKeyFieldId) {
    errors.push(`Model '${modelName}' has no primary key field`);
  }

  // Get all fields and payload fields
  const allFields = await getModelFieldsFromSchema(modelName);
  const payloadFields = await getPayloadFieldsFromSchema(modelName);

  if (payloadFields.length === 0) {
    errors.push(`Model '${modelName}' has no payload fields (no fields with payload=1)`);
  }

  return {
    valid: errors.length === 0,
    errors,
    config: errors.length === 0 ? {
      model_name: modelName,
      model_id: modelId!,
      total_fields: allFields.length,
      payload_field_count: payloadFields.length,
      primary_key_field_id: primaryKeyFieldId!,
    } : undefined,
  };
}

// =============================================================================
// COMMAND PARSING
// =============================================================================

/**
 * Extract model name from pipeline command
 *
 * Format: "pipeline_[model.name]_1984"
 * Examples:
 * - "pipeline_crm.lead_1984" → "crm.lead"
 * - "pipeline_res.partner_1984" → "res.partner"
 */
export function extractModelFromPipelineCommand(command: string): string {
  const match = command.match(/^pipeline_(.+)_1984$/);
  if (!match) {
    throw new Error(`Invalid command format: ${command}. Expected: pipeline_[model.name]_1984`);
  }
  return match[1];
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

/**
 * Sync Odoo model data using the new pipeline format
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @param options - Sync options
 * @returns Sync result
 */
export async function syncPipelineData(
  modelName: string,
  options: PipelineSyncOptions = {}
): Promise<PipelineSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  console.error(`[PipelineSync] Starting sync for model: ${modelName}`);

  // Check for concurrent sync
  if (isPipelineSyncInProgress(modelName)) {
    return {
      success: false,
      model_name: modelName,
      model_id: 0,
      records_fetched: 0,
      records_uploaded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      sync_type: 'full',
      errors: [`Sync already in progress for ${modelName}`],
    };
  }

  // Track active sync
  activePipelineSyncs.set(modelName, {
    startTime,
    progress: 0,
    totalRecords: 0,
  });

  try {
    // 1. Validate model (using async Qdrant schema query)
    const validation = await validateModelForPipelineAsync(modelName);
    if (!validation.valid) {
      throw new Error(`Model validation failed: ${validation.errors.join(', ')}`);
    }

    const modelConfig = validation.config!;
    console.error(`[PipelineSync] Model config: model_id=${modelConfig.model_id}, payload_fields=${modelConfig.payload_field_count}`);

    // 2. Initialize services
    if (!isEmbeddingServiceAvailable()) {
      throw new Error('Embedding service not available');
    }

    if (!isVectorClientAvailable()) {
      initializeVectorClient();
    }

    // 3. Ensure collection exists
    const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
    const exists = await collectionExists(collectionName);
    if (!exists) {
      console.error(`[PipelineSync] Creating collection: ${collectionName}`);
      await createPipelineDataCollection();
    }

    // 4. Get fields to fetch from Odoo (from Qdrant schema)
    // Using 'let' because some fields may be excluded due to errors during sync
    let odooFields = await getOdooFieldNamesFromSchema(modelName);
    console.error(`[PipelineSync] Fetching ${odooFields.length} stored fields from Odoo`);

    // 5. Determine sync type (full or incremental)
    const lastSync = getLastPipelineSyncTimestamp(modelName);
    const isIncremental = !options.force_full && lastSync !== null;
    const syncType = isIncremental ? 'incremental' : 'full';

    console.error(`[PipelineSync] Sync type: ${syncType}${isIncremental ? ` (since ${lastSync})` : ''}`);

    // 6. Build domain for Odoo query
    const domain: Array<[string, string, unknown]> = [];

    // Include archived records unless specified otherwise
    // Only add active filter if the model has an 'active' field
    const hasActiveField = odooFields.includes('active');
    if (options.include_archived !== false && hasActiveField) {
      domain.push(['active', 'in', [true, false]]);
      console.error(`[PipelineSync] Including archived records (active field exists)`);
    } else if (!hasActiveField) {
      console.error(`[PipelineSync] Model has no 'active' field, skipping archive filter`);
    }

    // Incremental sync: only records modified since last sync
    // IMPORTANT: Skip date filter when specificIds is provided (we want those exact records)
    const hasSpecificIds = options.specificIds && options.specificIds.length > 0;
    if (isIncremental && lastSync && !hasSpecificIds) {
      domain.push(['write_date', '>', lastSync]);
    } else if (hasSpecificIds) {
      console.error(`[PipelineSync] Skipping incremental date filter (specific IDs requested)`);
    }

    // =========================================================================
    // DATE FILTERING - Filter records by create_date period
    // =========================================================================
    // This allows importing large datasets in batches by date range
    // Example: date_from="2023-07-01", date_to="2024-06-30" for FY 2023-24
    //
    // The filter uses create_date (when record was created in Odoo)
    // Format must be YYYY-MM-DD (validated by schema)
    //
    // Note: Using >= and <= for inclusive date range
    // =========================================================================
    if (options.date_from) {
      // Convert YYYY-MM-DD to full datetime for Odoo (start of day)
      const dateFromWithTime = `${options.date_from} 00:00:00`;
      domain.push(['create_date', '>=', dateFromWithTime]);
      console.error(`[PipelineSync] Date filter FROM: ${options.date_from} (records created on or after)`);
    }

    if (options.date_to) {
      // Convert YYYY-MM-DD to full datetime for Odoo (end of day)
      const dateToWithTime = `${options.date_to} 23:59:59`;
      domain.push(['create_date', '<=', dateToWithTime]);
      console.error(`[PipelineSync] Date filter TO: ${options.date_to} (records created on or before)`);
    }

    // Log combined date filter if both are set
    if (options.date_from && options.date_to) {
      console.error(`[PipelineSync] Syncing records created between ${options.date_from} and ${options.date_to}`);
    }

    // =========================================================================
    // SPECIFIC IDS FILTER - For fix-orphans command
    // =========================================================================
    // When specificIds is provided, only sync those specific record IDs.
    // This is used by the fix-orphans command to sync missing FK target records.
    // =========================================================================
    if (options.specificIds && options.specificIds.length > 0) {
      domain.push(['id', 'in', options.specificIds]);
      console.error(`[PipelineSync] Filtering to ${options.specificIds.length} specific record IDs`);
    }

    // 7. Streaming batch processing - fetch, transform, embed, upload in batches
    // This prevents OOM by never holding all records in memory at once
    const odooClient = getOdooClient();
    const STREAM_BATCH_SIZE = options.fetch_batch_size || 500; // Process 500 records at a time
    const testLimit = options.test_limit;

    console.error(`[PipelineSync] Starting STREAMING sync (batch size: ${STREAM_BATCH_SIZE})`);

    // 8. Build graph_refs lookup for FK fields
    // This maps field_name -> Graph UUID for all FK fields in the model
    const fkFields = await getFkFieldsFromSchema(modelName);
    const graphRefsLookup = new Map<string, { graphUuid: string; targetModelId: number }>();

    for (const fkField of fkFields) {
      if (!fkField.fk_location_model_id) continue;

      const relationshipCode = getRelationshipTypeCode(fkField.field_type);
      const graphUuid = buildGraphUuidV2(
        modelConfig.model_id,        // source model ID
        fkField.fk_location_model_id, // target model ID
        fkField.field_id,             // field ID
        relationshipCode              // relationship type (31=many2one, etc.)
      );

      graphRefsLookup.set(fkField.field_name, {
        graphUuid,
        targetModelId: fkField.fk_location_model_id,
      });
    }

    console.error(`[PipelineSync] Built graph_refs lookup for ${graphRefsLookup.size} FK fields`);

    // =========================================================================
    // FK DEPENDENCY COLLECTION (Solution 2 for Cascade Sync)
    // =========================================================================
    // When collect_fk_dependencies=true, we accumulate ALL FK IDs from ALL
    // records as they stream through. This ensures cascade-sync gets the
    // complete picture, not limited by Qdrant scroll limits.
    // =========================================================================
    let fkAccumulators: Map<string, FkIdAccumulator> | null = null;

    if (options.collect_fk_dependencies) {
      console.error(`[PipelineSync] FK collection enabled - will track FK dependencies during sync`);

      // Get FK fields for this model
      const modelFkFields = await getFkFieldsForModel(modelName);

      if (modelFkFields.length > 0) {
        fkAccumulators = new Map();
        for (const fkField of modelFkFields) {
          fkAccumulators.set(fkField.field_name, {
            fieldInfo: fkField,
            ids: new Set(),
            totalRefs: 0,
          });
        }
        console.error(`[PipelineSync] Initialized accumulators for ${modelFkFields.length} FK fields`);
      } else {
        console.error(`[PipelineSync] No FK fields found for ${modelName} (leaf model)`);
      }
    }

    let offset = 0;
    let hasMore = true;
    let totalFetched = 0;
    let recordsUploaded = 0;
    let recordsFailed = 0;
    let batchNumber = 0;

    while (hasMore) {
      batchNumber++;

      // Calculate batch limit
      let batchLimit = STREAM_BATCH_SIZE;
      if (testLimit && totalFetched + batchLimit > testLimit) {
        batchLimit = testLimit - totalFetched;
      }
      if (batchLimit <= 0) break;

      // STEP 1: FETCH batch from Odoo (with resilient retry for field errors)
      console.error(`[PipelineSync] Batch ${batchNumber}: Fetching at offset ${offset}...`);
      const fetchResult = await odooClient.searchReadWithRetry<Record<string, unknown>>(
        modelName,
        domain,
        odooFields,
        { offset, limit: batchLimit }
      );
      const records = fetchResult.records;

      // Log any restricted fields found during this batch
      if (fetchResult.restrictedFields.length > 0 && batchNumber === 1) {
        console.error(`[PipelineSync] Fields excluded due to errors: ${fetchResult.restrictedFields.join(', ')}`);
        // Update odooFields for subsequent batches to avoid re-testing
        odooFields = odooFields.filter(f => !fetchResult.restrictedFields.includes(f));
      }

      if (records.length === 0) {
        hasMore = false;
        break;
      }

      totalFetched += records.length;
      offset += records.length;
      console.error(`[PipelineSync] Batch ${batchNumber}: Fetched ${records.length} records (total: ${totalFetched})`);

      // STEP 1.5: ACCUMULATE FK IDs (if FK collection is enabled)
      // This extracts FK IDs from the raw Odoo records BEFORE transformation
      if (fkAccumulators) {
        accumulateFkIds(records, fkAccumulators);
      }

      // Update progress tracking
      activePipelineSyncs.set(modelName, {
        startTime,
        progress: totalFetched,
        totalRecords: totalFetched,
      });

      // STEP 2: TRANSFORM batch (async - queries Qdrant schema)
      const transformedBatch = await transformPipelineRecords(records, modelName);
      console.error(`[PipelineSync] Batch ${batchNumber}: Transformed ${transformedBatch.length} records`);

      // STEP 3: EMBED and UPLOAD batch
      try {
        const texts = transformedBatch.map(r => r.vector_text);
        const embeddings = await embedBatch(texts, 'document');

        if (embeddings.length !== transformedBatch.length) {
          throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${transformedBatch.length}`);
        }

        // Build points for Qdrant
        const points: PipelineDataPoint[] = transformedBatch.map((record, idx) => {
          const vectorId = buildDataUuidV2(record.model_id, record.record_id);
          const rawRecord = records[idx];

          // Build graph_refs for FK fields that have values in this record
          const graphRefs: string[] = [];
          for (const [fieldName, { graphUuid }] of graphRefsLookup) {
            const rawValue = rawRecord[fieldName];
            // Check if FK field has a value (many2one returns [id, name] or false)
            if (rawValue && rawValue !== false) {
              if (Array.isArray(rawValue) && rawValue.length >= 1) {
                graphRefs.push(graphUuid);
              } else if (typeof rawValue === 'number') {
                graphRefs.push(graphUuid);
              }
            }
          }

          return {
            id: vectorId,
            vector: embeddings[idx],
            payload: {
              point_id: vectorId,               // V2 UUID for querying/filtering
              record_id: record.record_id,
              model_name: record.model_name,
              model_id: record.model_id,
              sync_timestamp: new Date().toISOString(),
              point_type: 'data' as const,
              vector_text: record.vector_text,  // Store the embedded text for debugging
              graph_refs: graphRefs,            // V2 Graph UUIDs for FK relationships
              ...record.payload,
            },
          };
        });

        await upsertToUnifiedCollection(points);
        recordsUploaded += transformedBatch.length;
        console.error(`[PipelineSync] Batch ${batchNumber}: Uploaded ${transformedBatch.length} records (total uploaded: ${recordsUploaded})`);

      } catch (error) {
        recordsFailed += transformedBatch.length;
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push(`Batch ${batchNumber} at offset ${offset} failed: ${errorMsg}`);
        console.error(`[PipelineSync] Batch ${batchNumber} failed:`, errorMsg);
      }

      // Check end conditions
      if (records.length < batchLimit) hasMore = false;
      if (testLimit && totalFetched >= testLimit) hasMore = false;
    }

    console.error(`[PipelineSync] Streaming complete: ${recordsUploaded} uploaded, ${recordsFailed} failed (${batchNumber} batches)`);

    // Finalize FK dependencies if collection was enabled
    let collectedFkDependencies: SyncFkDependency[] | undefined;

    if (fkAccumulators) {
      collectedFkDependencies = finalizeFkDependencies(fkAccumulators);

      // Log summary
      const totalUniqueIds = collectedFkDependencies.reduce((sum, dep) => sum + dep.unique_ids.length, 0);
      const totalRefs = collectedFkDependencies.reduce((sum, dep) => sum + dep.total_references, 0);
      console.error(`[PipelineSync] FK collection complete: ${totalUniqueIds} unique IDs (${totalRefs} refs) from ${collectedFkDependencies.length} FK fields`);

      for (const dep of collectedFkDependencies) {
        console.error(`  - ${dep.field_name} → ${dep.target_model}: ${dep.unique_ids.length} unique IDs`);
      }
    }

    // Handle case where no records were fetched
    if (totalFetched === 0) {
      return {
        success: true,
        model_name: modelName,
        model_id: modelConfig.model_id,
        records_fetched: 0,
        records_uploaded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        sync_type: syncType,
        fk_dependencies: collectedFkDependencies,
      };
    }

    // 10. Save sync metadata
    const metadata = loadSyncMetadata();
    metadata[modelName] = {
      last_sync_timestamp: new Date().toISOString(),
      record_count: recordsUploaded,
      field_count: modelConfig.payload_field_count,
    };
    saveSyncMetadata(metadata);

    const result: PipelineSyncResult = {
      success: recordsFailed === 0,
      model_name: modelName,
      model_id: modelConfig.model_id,
      records_fetched: totalFetched,
      records_uploaded: recordsUploaded,
      records_failed: recordsFailed,
      duration_ms: Date.now() - startTime,
      sync_type: syncType,
      errors: errors.length > 0 ? errors : undefined,
      fk_dependencies: collectedFkDependencies,
    };

    console.error(`[PipelineSync] Sync complete: ${recordsUploaded} uploaded, ${recordsFailed} failed`);
    return result;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[PipelineSync] Sync failed:`, error);

    return {
      success: false,
      model_name: modelName,
      model_id: 0,
      records_fetched: 0,
      records_uploaded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      sync_type: 'full',
      errors: [errorMsg],
    };

  } finally {
    // Clear active sync
    activePipelineSyncs.delete(modelName);
  }
}

// =============================================================================
// STATUS FUNCTIONS
// =============================================================================

/**
 * Get pipeline sync status
 *
 * IMPORTANT: This function now reads from BOTH metadata files:
 * 1. pipeline_sync_metadata.json (from pipeline_sync tool)
 * 2. data_sync_metadata.json (from transform_data tool)
 *
 * This ensures all synced models are shown regardless of which tool was used.
 */
export async function getPipelineSyncStatus(): Promise<{
  collection: {
    exists: boolean;
    vectorCount: number;
    collectionName: string;
  };
  schema: {
    totalModels: number;
    totalFields: number;
    payloadFields: number;
  };
  syncs: PipelineSyncMetadata;
}> {
  // Initialize vector client if needed
  if (!isVectorClientAvailable()) {
    initializeVectorClient();
  }

  const collectionInfo = await getPipelineCollectionInfo();
  const schemaStats = await getSchemaStats();

  // ==========================================================================
  // MERGE METADATA FROM ALL SOURCES (metadata files + Qdrant discovery)
  // ==========================================================================
  // Read from pipeline_sync tool metadata
  const pipelineSyncMetadata = loadSyncMetadata();

  // Read from transform_data tool metadata (data_sync_metadata.json)
  const transformDataMetadata = getAllDataSyncMetadata();

  // Discover models directly from Qdrant (fallback for missing metadata)
  // This catches models that were synced but whose metadata was lost
  const qdrantModels = await discoverModelsInQdrant();

  // Merge all sources: metadata takes precedence, then Qdrant discovery
  const mergedModels = new Set<string>([
    ...Object.keys(pipelineSyncMetadata),
    ...Object.keys(transformDataMetadata),
    ...qdrantModels,
  ]);

  console.error(`[PipelineStatus] Found ${Object.keys(pipelineSyncMetadata).length} models in pipeline_sync metadata`);
  console.error(`[PipelineStatus] Found ${Object.keys(transformDataMetadata).length} models in transform_data metadata`);
  console.error(`[PipelineStatus] Found ${qdrantModels.length} models in Qdrant (discovery)`);
  console.error(`[PipelineStatus] Total unique models: ${mergedModels.size}`);

  // Enrich sync metadata with actual counts from Qdrant and date ranges
  const enrichedSyncs: PipelineSyncMetadata = {};

  for (const modelName of mergedModels) {
    const actualCount = await countPipelineData(modelName);

    // Skip models with 0 records in Qdrant (might be metadata leftover from deleted data)
    if (actualCount === 0) {
      continue;
    }

    // Get model_id for date range lookup (needed to build UUIDs)
    const modelId = await getModelIdFromSchema(modelName);

    // Get date range (oldest/newest by create_date)
    let dateRange: ModelDateRangeResult = { oldest: null, newest: null };
    if (modelId) {
      dateRange = await getModelDateRange(modelName, modelId);
    }

    // Prefer pipeline_sync metadata if available, otherwise use transform_data metadata
    if (pipelineSyncMetadata[modelName]) {
      enrichedSyncs[modelName] = {
        ...pipelineSyncMetadata[modelName],
        record_count: actualCount,  // Use actual count from Qdrant
        oldest_record: dateRange.oldest,
        newest_record: dateRange.newest,
      };
    } else if (transformDataMetadata[modelName]) {
      // Convert transform_data format to pipeline format
      const transformMeta = transformDataMetadata[modelName];
      enrichedSyncs[modelName] = {
        last_sync_timestamp: transformMeta.last_sync_timestamp,
        record_count: actualCount,  // Use actual count from Qdrant
        field_count: 0,  // transform_data doesn't track field_count separately
        oldest_record: dateRange.oldest,
        newest_record: dateRange.newest,
      };
    } else {
      // Model discovered from Qdrant but has no metadata - show with unknown timestamp
      enrichedSyncs[modelName] = {
        last_sync_timestamp: 'Unknown (discovered from Qdrant)',
        record_count: actualCount,
        field_count: 0,
        oldest_record: dateRange.oldest,
        newest_record: dateRange.newest,
      };
      console.error(`[PipelineStatus] Model '${modelName}' discovered in Qdrant (${actualCount} records) but has no metadata`);
    }
  }

  return {
    collection: collectionInfo,
    schema: {
      totalModels: schemaStats.totalModels,
      totalFields: schemaStats.totalFields,
      payloadFields: schemaStats.payloadFields,
    },
    syncs: enrichedSyncs,
  };
}

/**
 * Preview transformation for a model (without syncing)
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 */
export async function previewPipelineTransform(modelName: string): Promise<{
  valid: boolean;
  model_config: {
    model_name: string;
    model_id: number;
    total_fields: number;
    payload_fields: number;
    payload_field_names: string[];
    odoo_fields: string[];
  } | null;
  errors: string[];
}> {
  const validation = await validateModelForPipelineAsync(modelName);

  if (!validation.valid) {
    return {
      valid: false,
      model_config: null,
      errors: validation.errors,
    };
  }

  const config = validation.config!;
  const payloadFields = await getPayloadFieldsFromSchema(modelName);
  const odooFields = await getOdooFieldNamesFromSchema(modelName);

  return {
    valid: true,
    model_config: {
      model_name: config.model_name,
      model_id: config.model_id,
      total_fields: config.total_fields,
      payload_fields: config.payload_field_count,
      payload_field_names: payloadFields.map(f => f.field_name),
      odoo_fields: odooFields,
    },
    errors: [],
  };
}
