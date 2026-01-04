/**
 * Data Sync Service
 *
 * @deprecated This service uses the legacy coordinate-encoding format.
 * Use pipeline-data-sync.ts instead for new data synchronization.
 * The pipeline format stores flat payload fields which work better with
 * nexsus_search and graph_traverse tools.
 *
 * This file is kept for backwards compatibility with existing functions
 * like getDataSyncStatus, discoverModelConfig, and cleanupDeletedRecords.
 *
 * Orchestrates the sync of Odoo table data to the vector database.
 * Handles: schema validation, data fetching, encoding, embedding, and upsert.
 *
 * Key features:
 * - Full table sync (all records including archived)
 * - Schema validation before sync
 * - Batch processing for embedding and upsert
 * - Progress reporting
 */

import { getOdooClient } from './odoo-client.js';
import { embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import { getQdrantClient, isVectorClientAvailable } from './vector-client.js';
import {
  getModelFields,
  buildFieldEncodingMap,
  validateSchemaDataAlignment,
  transformRecords,
  getFieldsToFetch,
} from './data-transformer.js';
import { getSchemasByModel, getAllModelNames } from './schema-loader.js';
import {
  getLastDataSyncTimestamp,
  saveDataSyncMetadata,
  findMaxWriteDate,
} from './sync-metadata.js';
import { addToDLQ } from './dlq.js';
import { logInfo, logWarn, logError, generateSyncId } from './logger.js';
import {
  odooCircuitBreaker,
  qdrantCircuitBreaker,
  voyageCircuitBreaker,
  CircuitBreakerOpenError,
} from './circuit-breaker.js';
import { recordSyncComplete } from './metrics.js';
import { DATA_TRANSFORM_CONFIG, QDRANT_CONFIG } from '../constants.js';
import type {
  DataTransformConfig,
  DataSyncResult,
  DataSyncResultWithRestrictions,
  DataPoint,
  DataPayload,
  ValidationResult,
  FieldRestriction,
  FieldRestrictionReason,
  EncodingContext,
} from '../types.js';

// =============================================================================
// CONCURRENT SYNC PREVENTION
// =============================================================================

/**
 * Active sync tracking
 *
 * Prevents multiple syncs of the same model from running simultaneously.
 * Key: model_name, Value: sync progress info
 */
const activeSyncs = new Map<string, { startTime: number; progress: number; totalRecords: number }>();

/**
 * Check if a sync is currently in progress for a model
 */
export function isSyncInProgress(modelName: string): boolean {
  return activeSyncs.has(modelName);
}

/**
 * Get all currently active syncs
 */
export function getActiveSyncs(): Map<string, { startTime: number; progress: number; totalRecords: number }> {
  return new Map(activeSyncs);
}

// =============================================================================
// MEMORY MONITORING (Stage 0 - P0 CRITICAL)
// =============================================================================

/**
 * Memory usage thresholds for logging
 */
const MEMORY_LOG_INTERVAL_BATCHES = 10; // Log memory every N batches
const MEMORY_WARNING_THRESHOLD_MB = 512; // Warn if heap used exceeds this
const MEMORY_CRITICAL_THRESHOLD_MB = 768; // Critical warning threshold

/**
 * Log current memory usage with heap statistics
 *
 * Uses Node.js process.memoryUsage() to get:
 * - heapUsed: Actual memory used by JS objects
 * - heapTotal: Total heap size allocated
 * - external: Memory used by C++ objects bound to JS
 * - rss: Resident Set Size (total memory allocated for process)
 *
 * @param syncId - Unique sync ID for log correlation
 * @param modelName - Model being synced
 * @param phase - Current phase (e.g., 'start', 'complete')
 * @param batchNumber - Optional batch number
 */
function logMemoryUsage(syncId: string, modelName: string, phase: string, batchNumber?: number): void {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);

  // Determine log level based on heap usage
  const isWarning = heapUsedMB >= MEMORY_WARNING_THRESHOLD_MB;
  const isCritical = heapUsedMB >= MEMORY_CRITICAL_THRESHOLD_MB;

  const logFn = isWarning ? logWarn : logInfo;
  logFn('Memory check', {
    sync_id: syncId,
    model_name: modelName,
    phase,
    batch: batchNumber,
    heap_mb: heapUsedMB,
    heap_total_mb: heapTotalMB,
    rss_mb: rssMB,
    critical: isCritical || undefined,
  });
}

/**
 * Check if memory logging should occur for this batch
 */
function shouldLogMemory(batchNumber: number): boolean {
  return batchNumber % MEMORY_LOG_INTERVAL_BATCHES === 0;
}

// =============================================================================
// DYNAMIC MODEL CONFIGURATION DISCOVERY
// =============================================================================

/**
 * Discovered model configuration from schema
 */
export interface DiscoveredModelConfig {
  model_name: string;
  model_id: number;
  id_field_id: number;
  field_count: number;
}

/**
 * Extract model name from the transfer command
 *
 * Format: "transfer_[model.name]_1984"
 * Examples:
 * - "transfer_crm.lead_1984" → "crm.lead"
 * - "transfer_res.partner_1984" → "res.partner"
 * - "transfer_sale.order_1984" → "sale.order"
 *
 * @param command - The full transfer command
 * @returns Extracted model name
 */
export function extractModelNameFromCommand(command: string): string {
  // Pattern: transfer_[model.name]_1984
  // Remove "transfer_" prefix and "_1984" suffix
  const match = command.match(/^transfer_(.+)_1984$/);
  if (!match) {
    throw new Error(`Invalid command format: ${command}. Expected: transfer_[model.name]_1984`);
  }
  return match[1];
}

/**
 * Discover model configuration from schema
 *
 * Dynamically extracts model_id and id_field_id from the schema data.
 * This allows ANY model to be synced without hardcoding configurations.
 *
 * How it works:
 * 1. Get all schema fields for the model
 * 2. Extract model_id from any field (all fields in a model have the same model_id)
 * 3. Find the 'id' field and get its field_id
 *
 * @param modelName - Odoo model name (e.g., "res.partner")
 * @returns DiscoveredModelConfig with model_id and id_field_id
 * @throws Error if model not found in schema
 */
export function discoverModelConfig(modelName: string): DiscoveredModelConfig {
  console.error(`[DataSync] Discovering config for model: ${modelName}`);

  // Get all fields for this model from schema
  const modelFields = getSchemasByModel(modelName);

  if (modelFields.length === 0) {
    // Get list of available models to help user
    const availableModels = getAllModelNames();
    const similarModels = availableModels
      .filter(m => m.includes(modelName.split('.')[0]) || modelName.includes(m.split('.')[0]))
      .slice(0, 5);

    throw new Error(
      `Model "${modelName}" not found in schema.\n` +
      `Total models in schema: ${availableModels.length}\n` +
      (similarModels.length > 0
        ? `Similar models: ${similarModels.join(', ')}`
        : `Run schema sync first to populate the schema.`)
    );
  }

  // Extract model_id from first field (all fields in same model have same model_id)
  const model_id = modelFields[0].model_id;

  // Find the 'id' field to get its field_id
  const idField = modelFields.find(f => f.field_name === 'id');
  if (!idField) {
    throw new Error(
      `Model "${modelName}" does not have an 'id' field in schema.\n` +
      `Found ${modelFields.length} fields, but none named 'id'.\n` +
      `This may indicate incomplete schema data.`
    );
  }

  const config: DiscoveredModelConfig = {
    model_name: modelName,
    model_id: model_id,
    id_field_id: idField.field_id,
    field_count: modelFields.length,
  };

  console.error(`[DataSync] Discovered config for ${modelName}:`);
  console.error(`  - model_id: ${config.model_id}`);
  console.error(`  - id_field_id: ${config.id_field_id}`);
  console.error(`  - field_count: ${config.field_count}`);

  return config;
}

// =============================================================================
// POINT ID GENERATION
// =============================================================================

/**
 * Generate unique point ID for a data record
 *
 * Strategy: model_id * 10_000_000 + record_id
 * This ensures no collision with schema field_ids (which are < 100,000)
 *
 * Example: crm.lead (344) record 12345 = 3440012345
 */
export function generateDataPointId(modelId: number, recordId: number): number {
  return modelId * DATA_TRANSFORM_CONFIG.MODEL_ID_MULTIPLIER + recordId;
}

// =============================================================================
// DATA FETCHING
// =============================================================================

/**
 * Fetch all records from Odoo with pagination
 *
 * @param config - Transform configuration
 * @param fields - Fields to fetch
 * @param onProgress - Progress callback
 * @returns Array of raw Odoo records
 */
export async function fetchAllRecords(
  config: DataTransformConfig,
  fields: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Record<string, unknown>[]> {
  const client = getOdooClient();
  const allRecords: Record<string, unknown>[] = [];
  const batchSize = DATA_TRANSFORM_CONFIG.FETCH_BATCH_SIZE;

  // Build domain filter
  const domain: unknown[] = [];

  // Context to include archived records
  const context: Record<string, unknown> = {};
  if (config.include_archived !== false) {
    context.active_test = false; // Include active=false records
  }

  // Get total count first
  const total = config.test_limit
    ? Math.min(config.test_limit, await client.searchCount(config.model_name, domain, context))
    : await client.searchCount(config.model_name, domain, context);

  console.error(`[DataSync] Fetching ${total} records from ${config.model_name}`);

  if (onProgress) {
    onProgress(0, total);
  }

  // Fetch in batches
  let offset = 0;
  const maxRecords = config.test_limit || total;

  while (offset < maxRecords) {
    const limit = Math.min(batchSize, maxRecords - offset);

    const batch = await client.searchRead<Record<string, unknown>>(
      config.model_name,
      domain,
      fields,
      { limit, offset, order: 'id', context }
    );

    allRecords.push(...batch);
    offset += batch.length;

    // Log progress every batch
    const pct = Math.round((allRecords.length / total) * 100);
    console.error(`[DataSync] Fetched ${allRecords.length}/${total} records (${pct}%)`);

    if (onProgress) {
      onProgress(allRecords.length, total);
    }

    // Break if no more records
    if (batch.length < limit) break;
  }

  return allRecords;
}

// =============================================================================
// DATA UPSERT
// =============================================================================

/**
 * Upsert data points to Qdrant
 */
async function upsertDataPoints(points: DataPoint[]): Promise<void> {
  const client = getQdrantClient();

  await client.upsert(QDRANT_CONFIG.COLLECTION, {
    wait: true,
    points: points.map(p => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
}

/**
 * Create payload indexes for data points (if not exists)
 */
async function ensureDataIndexes(): Promise<void> {
  const client = getQdrantClient();

  const indexFields = [
    { field: 'record_id', type: 'integer' as const },
    { field: 'point_type', type: 'keyword' as const },
  ];

  for (const { field, type } of indexFields) {
    try {
      await client.createPayloadIndex(QDRANT_CONFIG.COLLECTION, {
        field_name: field,
        field_schema: type,
      });
    } catch {
      // Index might already exist - ignore
    }
  }
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

/**
 * Progress callback type
 */
export type ProgressCallback = (phase: string, current: number, total: number) => void;

/**
 * Sync model data to Qdrant using STREAMING approach
 *
 * IMPORTANT: Uses streaming to avoid memory issues with large tables.
 * Each batch is: Fetch → Encode → Embed → Upsert → Clear
 * This keeps memory usage constant regardless of table size.
 *
 * **RESILIENT FIELD HANDLING:**
 * When API permissions restrict access to certain fields, the sync continues
 * gracefully by:
 * 1. Detecting restricted fields from error messages
 * 2. Removing them from the query
 * 3. Encoding them as "Restricted_from_API"
 * 4. Reporting which fields were restricted in the result
 *
 * @param config - Transform configuration
 * @param onProgress - Progress callback
 * @returns Sync result with restriction information
 */
export async function syncModelData(
  config: DataTransformConfig,
  onProgress?: ProgressCallback
): Promise<DataSyncResultWithRestrictions> {
  const startTime = Date.now();
  const syncId = generateSyncId();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Circuit breaker context for logging correlation
  const cbContext = { sync_id: syncId, model_name: config.model_name };

  // Structured log: Sync started
  logInfo('Sync started', {
    sync_id: syncId,
    model_name: config.model_name,
    incremental: config.incremental !== false,
    force_full: config.force_full || false,
  });

  // MEMORY OPTIMIZATION: Limit warnings array to prevent unbounded growth
  const MAX_WARNINGS = 100;
  const addWarning = (msg: string): void => {
    if (warnings.length < MAX_WARNINGS) {
      warnings.push(msg);
    } else if (warnings.length === MAX_WARNINGS) {
      warnings.push(`... and more warnings (truncated at ${MAX_WARNINGS})`);
    }
    // Silently ignore beyond MAX_WARNINGS to prevent memory growth
  };

  // Track restricted fields discovered during sync (Map: field → reason)
  const restrictedFieldsMap = new Map<string, FieldRestrictionReason>();

  // ==========================================================================
  // CONCURRENT SYNC PREVENTION - Check if sync already in progress
  // ==========================================================================
  if (activeSyncs.has(config.model_name)) {
    const existing = activeSyncs.get(config.model_name)!;
    const elapsed = Math.round((Date.now() - existing.startTime) / 1000);
    const progressRecords = Math.round(existing.totalRecords * existing.progress / 100);
    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: 0,
      errors: [
        `Sync already in progress for ${config.model_name}`,
        `Started: ${elapsed}s ago`,
        `Progress: ${existing.progress}% (${progressRecords}/${existing.totalRecords} records)`,
      ],
      restricted_fields: [],
      warnings: [],
    };
  }

  // Acquire sync lock
  activeSyncs.set(config.model_name, { startTime: Date.now(), progress: 0, totalRecords: 0 });
  console.error(`[DataSync] Acquired sync lock for ${config.model_name}`);

  // Validate services are available
  if (!isEmbeddingServiceAvailable()) {
    activeSyncs.delete(config.model_name); // Release lock before early return
    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: ['Embedding service not available. Set VOYAGE_API_KEY.'],
      restricted_fields: [],
      warnings: [],
    };
  }

  if (!isVectorClientAvailable()) {
    activeSyncs.delete(config.model_name); // Release lock before early return
    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: ['Vector client not available. Check QDRANT_HOST.'],
      restricted_fields: [],
      warnings: [],
    };
  }

  try {
    // Get Odoo client
    const client = getOdooClient();

    // Phase 1: Load schema and build encoding map
    onProgress?.('loading_schema', 0, 1);
    console.error(`[DataSync] Loading schema for ${config.model_name}`);

    const schemaFields = getModelFields(config.model_name);
    if (schemaFields.length === 0) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [`No schema found for model: ${config.model_name}`],
        restricted_fields: [],
        warnings: [],
      };
    }

    console.error(`[DataSync] Found ${schemaFields.length} schema fields for ${config.model_name}`);
    const encodingMap = buildFieldEncodingMap(schemaFields);
    const fieldsToFetch = getFieldsToFetch(encodingMap);

    // Phase 2: Fetch sample record with resilient handling and validate schema alignment
    onProgress?.('validating', 0, 1);
    console.error(`[DataSync] Validating schema-data alignment (with resilient field handling)`);

    // Track fields we'll actually fetch (may be reduced if some are restricted)
    let currentFieldsToFetch = [...fieldsToFetch];

    // Ensure write_date is fetched for incremental sync tracking
    if (!currentFieldsToFetch.includes('write_date')) {
      currentFieldsToFetch.push('write_date');
    }

    // Build domain and context for queries
    const domain: unknown[] = [];
    const context: Record<string, unknown> = {};
    if (config.include_archived !== false) {
      context.active_test = false;
    }

    // ==========================================================================
    // INCREMENTAL SYNC - Add write_date filter if previous sync exists
    // ==========================================================================
    let isIncremental = false;
    const incrementalEnabled = config.incremental !== false; // Default: true
    const forceFullSync = config.force_full === true;

    if (incrementalEnabled && !forceFullSync) {
      const lastSync = getLastDataSyncTimestamp(config.model_name);
      if (lastSync) {
        domain.push(['write_date', '>', lastSync]);
        isIncremental = true;
        console.error(`[DataSync] INCREMENTAL sync: fetching records modified after ${lastSync}`);
      } else {
        console.error(`[DataSync] No previous sync found, running FULL sync`);
      }
    } else if (forceFullSync) {
      console.error(`[DataSync] FULL sync requested (force_full=true)`);
    }

    // Use resilient fetch for sample record to discover any restricted fields
    // Wrapped with circuit breaker to fail fast if Odoo is unhealthy
    let sampleResult;
    try {
      sampleResult = await odooCircuitBreaker.execute(
        () => client.searchReadWithRetry<Record<string, unknown>>(
          config.model_name,
          domain,
          currentFieldsToFetch,
          { limit: 1, context },
          {
            maxRetries: 5,
            onFieldRestricted: (field, reason) => {
              restrictedFieldsMap.set(field, reason);
              const marker = reason === 'odoo_error' ? 'Restricted_odoo_error' : 'Restricted_from_API';
              addWarning(`Field '${field}' restricted (${reason}) - will be marked as ${marker}`);
            },
          }
        ),
        cbContext
      );
    } catch (error) {
      if (error instanceof CircuitBreakerOpenError) {
        activeSyncs.delete(config.model_name);
        return {
          success: false,
          model_name: config.model_name,
          records_processed: 0,
          records_embedded: 0,
          records_failed: 0,
          duration_ms: Date.now() - startTime,
          errors: [`Odoo API circuit breaker is OPEN - ${error.message}`],
          restricted_fields: [],
          warnings,
        };
      }
      throw error;
    }

    // Update field list with any restrictions found during sample fetch
    if (sampleResult.restrictedFields.length > 0) {
      currentFieldsToFetch = currentFieldsToFetch.filter(f => !restrictedFieldsMap.has(f));
      console.error(`[DataSync] Found ${sampleResult.restrictedFields.length} restricted fields during sample fetch`);
    }

    if (sampleResult.records.length === 0) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [`No records found for model: ${config.model_name}`],
        restricted_fields: [],
        warnings,
      };
    }

    // Validate schema-data alignment (with remaining fields)
    const odooFields = Object.keys(sampleResult.records[0]);
    const validation: ValidationResult = validateSchemaDataAlignment(odooFields, schemaFields);

    if (!validation.valid) {
      return {
        success: false,
        model_name: config.model_name,
        records_processed: 0,
        records_embedded: 0,
        records_failed: 0,
        duration_ms: Date.now() - startTime,
        errors: [
          `Schema-Data mismatch! ${validation.missing_in_schema.length} Odoo fields not in schema:`,
          ...validation.missing_in_schema.slice(0, 20),
          validation.missing_in_schema.length > 20
            ? `... and ${validation.missing_in_schema.length - 20} more`
            : '',
          '',
          'Please update schema first (sync schema), then retry data sync.',
        ].filter(Boolean),
        restricted_fields: [],
        warnings,
      };
    }

    console.error(`[DataSync] Schema validation passed: ${validation.matched_fields.length} fields matched`);

    // Build encoding context with restricted fields (Map: field → reason)
    const encodingContext: EncodingContext = {
      model_name: config.model_name,
      restricted_fields: restrictedFieldsMap,
    };

    // Ensure indexes exist for data points
    await ensureDataIndexes();

    // Phase 3: STREAMING - Fetch, encode, embed, upsert in batches
    // This avoids loading all records into memory at once
    const fetchBatchSize = DATA_TRANSFORM_CONFIG.FETCH_BATCH_SIZE;
    const embedBatchSize = DATA_TRANSFORM_CONFIG.EMBED_BATCH_SIZE;

    // Get total count
    const totalRecords = config.test_limit
      ? Math.min(config.test_limit, await client.searchCount(config.model_name, domain, context))
      : await client.searchCount(config.model_name, domain, context);

    console.error(`[DataSync] Starting streaming sync of ${totalRecords} records`);
    if (restrictedFieldsMap.size > 0) {
      console.error(`[DataSync] Excluding ${restrictedFieldsMap.size} restricted fields from fetch`);
    }
    onProgress?.('streaming', 0, totalRecords);

    // Update sync lock with totalRecords
    activeSyncs.set(config.model_name, { startTime, progress: 0, totalRecords });

    let offset = 0;
    let totalProcessed = 0;
    let totalEmbedded = 0;
    const maxRecords = config.test_limit || totalRecords;

    // Track max write_date incrementally (MEMORY OPTIMIZATION: don't store all records!)
    let maxWriteDate: string | null = null;

    // ==========================================================================
    // ASYNC PIPELINE: Fetch batch N+1 while embedding batch N
    // This hides network latency by overlapping fetch and embed operations
    // ==========================================================================

    // Helper function to fetch a batch with resilient field handling
    // Wrapped with circuit breaker to fail fast if Odoo is unhealthy
    const fetchBatchAsync = async (batchOffset: number) => {
      const limit = Math.min(fetchBatchSize, maxRecords - batchOffset);
      return odooCircuitBreaker.execute(
        () => client.searchReadWithRetry<Record<string, unknown>>(
          config.model_name,
          domain,
          currentFieldsToFetch,
          { limit, offset: batchOffset, order: 'id', context },
          {
            maxRetries: 5,
            onFieldRestricted: (field, reason) => {
              if (!restrictedFieldsMap.has(field)) {
                restrictedFieldsMap.set(field, reason);
                const marker = reason === 'odoo_error' ? 'Restricted_odoo_error' : 'Restricted_from_API';
                addWarning(`Field '${field}' restricted (${reason}) - discovered during batch at offset ${batchOffset}, marked as ${marker}`);
                console.error(`[DataSync] New restricted field discovered: ${field} (${reason})`);
              }
            },
          }
        ),
        cbContext
      );
    };

    // Start first fetch (don't await yet)
    let nextFetchPromise: ReturnType<typeof fetchBatchAsync> | null =
      offset < maxRecords ? fetchBatchAsync(offset) : null;

    // Memory monitoring - log at sync start
    let batchNumber = 0;
    logMemoryUsage(syncId, config.model_name, 'start');

    while (nextFetchPromise) {
      batchNumber++;
      // Wait for current batch to complete
      let batchResult;
      try {
        batchResult = await nextFetchPromise;
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          // Odoo circuit breaker opened - abort sync gracefully
          logError('Odoo circuit open - aborting sync', {
            sync_id: syncId,
            model_name: config.model_name,
            batch: batchNumber,
            records_processed: totalProcessed,
            records_embedded: totalEmbedded,
            service: 'odoo',
          });
          addWarning(`Odoo API circuit breaker opened at batch ${batchNumber} - sync aborted`);
          break; // Exit while loop, will return partial results
        }
        throw error;
      }
      const currentBatchOffset = offset;
      offset += fetchBatchSize;

      // Update field list if new restrictions found
      if (batchResult.restrictedFields.length > 0) {
        currentFieldsToFetch = currentFieldsToFetch.filter(f => !restrictedFieldsMap.has(f));
      }

      const batch = batchResult.records;
      if (batch.length === 0) {
        nextFetchPromise = null;
        break;
      }

      // Start fetching NEXT batch IMMEDIATELY (don't wait for embed)
      // This is the key optimization - fetch N+1 runs in parallel with embed N
      if (offset < maxRecords && batch.length === fetchBatchSize) {
        console.error(`[DataSync] Starting prefetch of batch at offset ${offset}`);
        nextFetchPromise = fetchBatchAsync(offset);
      } else {
        nextFetchPromise = null;
      }

      // Process current batch (encode, embed, upsert)
      totalProcessed += batch.length;
      const fetchPct = Math.round((totalProcessed / totalRecords) * 100);

      // Structured log: Batch fetched
      logInfo('Batch fetched', {
        sync_id: syncId,
        model_name: config.model_name,
        batch: batchNumber,
        records: totalProcessed,
        total: totalRecords,
        progress_pct: fetchPct,
      });

      // MEMORY OPTIMIZATION: Track max write_date incrementally instead of storing all records
      const batchMaxWriteDate = findMaxWriteDate(batch);
      if (batchMaxWriteDate) {
        if (!maxWriteDate || batchMaxWriteDate > maxWriteDate) {
          maxWriteDate = batchMaxWriteDate;
        }
      }

      // Memory monitoring - log every N batches to track heap growth
      if (shouldLogMemory(batchNumber)) {
        logMemoryUsage(syncId, config.model_name, 'batch', batchNumber);
      }

      // Step 2: Encode batch with restricted field markers
      const encodedBatch = transformRecords(batch, encodingMap, config, encodingContext);

      // Step 3: Embed and upsert in smaller chunks
      for (let i = 0; i < encodedBatch.length; i += embedBatchSize) {
        const embedChunk = encodedBatch.slice(i, i + embedBatchSize);

        try {
          // Generate embeddings (wrapped with Voyage circuit breaker)
          const texts = embedChunk.map(r => r.encoded_string);
          let embeddings: number[][];
          try {
            embeddings = await voyageCircuitBreaker.execute(
              () => embedBatch(texts, 'document'),
              cbContext
            );
          } catch (cbError) {
            if (cbError instanceof CircuitBreakerOpenError) {
              // Voyage circuit open - send to DLQ and skip this chunk
              for (const record of embedChunk) {
                addToDLQ({
                  record_id: record.record_id,
                  model_name: record.model_name,
                  model_id: record.model_id,
                  failure_stage: 'embedding',
                  error_message: cbError.message,
                  batch_number: batchNumber,
                  encoded_string: record.encoded_string,
                  failed_at: new Date().toISOString(),
                  retry_count: 0,
                });
              }
              logError('Voyage circuit open - batch to DLQ', {
                sync_id: syncId,
                model_name: config.model_name,
                batch: batchNumber,
                records_to_dlq: embedChunk.length,
                service: 'voyage',
              });
              continue; // Skip this chunk, try next
            }
            throw cbError;
          }

          // Build data points
          const points: DataPoint[] = embedChunk.map((record, idx) => ({
            id: generateDataPointId(record.model_id, record.record_id),
            vector: embeddings[idx],
            payload: {
              record_id: record.record_id,
              model_name: record.model_name,
              model_id: record.model_id,
              encoded_string: record.encoded_string,
              field_count: record.field_count,
              sync_timestamp: new Date().toISOString(),
              point_type: 'data' as const,
            } as DataPayload,
          }));

          // Upsert to Qdrant (wrapped with Qdrant circuit breaker)
          try {
            await qdrantCircuitBreaker.execute(
              () => upsertDataPoints(points),
              cbContext
            );
          } catch (cbError) {
            if (cbError instanceof CircuitBreakerOpenError) {
              // Qdrant circuit open - send to DLQ and skip this chunk
              for (const record of embedChunk) {
                addToDLQ({
                  record_id: record.record_id,
                  model_name: record.model_name,
                  model_id: record.model_id,
                  failure_stage: 'upsert',
                  error_message: cbError.message,
                  batch_number: batchNumber,
                  encoded_string: record.encoded_string,
                  failed_at: new Date().toISOString(),
                  retry_count: 0,
                });
              }
              logError('Qdrant circuit open - batch to DLQ', {
                sync_id: syncId,
                model_name: config.model_name,
                batch: batchNumber,
                records_to_dlq: embedChunk.length,
                service: 'qdrant',
              });
              continue; // Skip this chunk, try next
            }
            throw cbError;
          }
          totalEmbedded += embedChunk.length;

          const embedPct = Math.round((totalEmbedded / totalRecords) * 100);

          // Structured log: Batch embedded
          logInfo('Batch embedded', {
            sync_id: syncId,
            model_name: config.model_name,
            batch: batchNumber,
            records: totalEmbedded,
            total: totalRecords,
            progress_pct: embedPct,
          });

          // Update sync progress for concurrent sync tracking
          activeSyncs.set(config.model_name, { startTime, progress: embedPct, totalRecords });

          onProgress?.('embedding', totalEmbedded, totalRecords);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);

          // Send ALL records in this chunk to DLQ for later retry
          for (const record of embedChunk) {
            addToDLQ({
              record_id: record.record_id,
              model_name: record.model_name,
              model_id: record.model_id,
              failure_stage: 'embedding',
              error_message: errMsg,
              batch_number: batchNumber,
              encoded_string: record.encoded_string,
              failed_at: new Date().toISOString(),
              retry_count: 0,
            });
          }

          addWarning(`Embed batch at offset ${currentBatchOffset + i} failed: ${errMsg} (${embedChunk.length} records sent to DLQ)`);

          // Structured log: Embed failed
          logError('Embed failed', {
            sync_id: syncId,
            model_name: config.model_name,
            batch: batchNumber,
            error: errMsg,
            records_to_dlq: embedChunk.length,
          });
        }
      }
    }

    onProgress?.('complete', totalEmbedded, totalRecords);

    // Structured log: Sync complete
    logInfo('Sync complete', {
      sync_id: syncId,
      model_name: config.model_name,
      records: totalEmbedded,
      total: totalProcessed,
      duration_ms: Date.now() - startTime,
    });

    // Memory monitoring - log at sync end to verify no memory leak
    logMemoryUsage(syncId, config.model_name, 'complete', batchNumber);

    if (restrictedFieldsMap.size > 0) {
      console.error(`[DataSync] Restricted fields (${restrictedFieldsMap.size}): ${Array.from(restrictedFieldsMap.keys()).join(', ')}`);
    }

    // Build restricted fields array for result
    const restrictedFieldsResult: FieldRestriction[] = Array.from(restrictedFieldsMap.entries()).map(
      ([field_name, reason]) => ({
        field_name,
        reason,
        detected_at: new Date().toISOString(),
      })
    );

    // ==========================================================================
    // SAVE INCREMENTAL SYNC METADATA
    // ==========================================================================
    if (totalEmbedded > 0 && maxWriteDate) {
      // maxWriteDate was tracked incrementally during batch processing (memory efficient!)
      saveDataSyncMetadata(
        config.model_name,
        maxWriteDate,
        totalEmbedded,
        Date.now() - startTime
      );
    }

    // Record sync metrics (Stage 5)
    const durationMs = Date.now() - startTime;
    recordSyncComplete(
      config.model_name,
      errors.length === 0,
      totalProcessed,
      totalEmbedded,
      durationMs
    );

    return {
      success: errors.length === 0,
      model_name: config.model_name,
      records_processed: totalProcessed,
      records_embedded: totalEmbedded,
      records_failed: totalProcessed - totalEmbedded,
      duration_ms: durationMs,
      errors: errors.length > 0 ? errors : undefined,
      restricted_fields: restrictedFieldsResult,
      warnings,
      sync_type: isIncremental ? 'incremental' : 'full',
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);

    // Build restricted fields array even on error
    const restrictedFieldsResult: FieldRestriction[] = Array.from(restrictedFieldsMap.entries()).map(
      ([field_name, reason]) => ({
        field_name,
        reason,
        detected_at: new Date().toISOString(),
      })
    );

    // Record sync metrics for failed sync (Stage 5)
    const durationMs = Date.now() - startTime;
    recordSyncComplete(
      config.model_name,
      false,
      0,
      0,
      durationMs
    );

    return {
      success: false,
      model_name: config.model_name,
      records_processed: 0,
      records_embedded: 0,
      records_failed: 0,
      duration_ms: durationMs,
      errors: [errMsg],
      restricted_fields: restrictedFieldsResult,
      warnings,
    };
  } finally {
    // Always release sync lock, even on error
    activeSyncs.delete(config.model_name);
    console.error(`[DataSync] Released sync lock for ${config.model_name}`);
  }
}

/**
 * Get data sync status
 */
export async function getDataSyncStatus(): Promise<{
  collection: string;
  total_points: number;
  schema_points: number;
  data_points: number;
}> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not available');
  }

  const client = getQdrantClient();

  try {
    const info = await client.getCollection(QDRANT_CONFIG.COLLECTION);
    const totalPoints = info.points_count ?? 0;

    // Count data points specifically
    const dataCount = await client.count(QDRANT_CONFIG.COLLECTION, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'data' } }],
      },
      exact: true,
    });

    return {
      collection: QDRANT_CONFIG.COLLECTION,
      total_points: totalPoints,
      schema_points: totalPoints - dataCount.count,
      data_points: dataCount.count,
    };
  } catch {
    return {
      collection: QDRANT_CONFIG.COLLECTION,
      total_points: 0,
      schema_points: 0,
      data_points: 0,
    };
  }
}

// =============================================================================
// DELETED RECORD CLEANUP
// =============================================================================

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
  /** Number of records deleted from vector DB */
  deleted: number;
  /** Model name that was cleaned */
  model_name: string;
  /** IDs that were in vector DB but not in Odoo */
  deleted_ids: number[];
  /** Errors encountered during cleanup */
  errors: string[];
  /** Duration of cleanup operation in ms */
  duration_ms: number;
}

/**
 * Clean up deleted records from vector database
 *
 * Compares record IDs in vector DB against Odoo to find and remove
 * records that were deleted in Odoo but still exist in vector DB.
 *
 * @param modelName - Odoo model name (e.g., 'res.partner')
 * @param modelId - Model ID for generating point IDs
 * @param onProgress - Optional progress callback
 * @returns CleanupResult with deleted count and any errors
 */
export async function cleanupDeletedRecords(
  modelName: string,
  modelId: number,
  onProgress?: (phase: string, current: number, total: number) => void
): Promise<CleanupResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  console.error(`[Cleanup] Starting cleanup for ${modelName} (model_id=${modelId})`);

  if (!isVectorClientAvailable()) {
    return {
      deleted: 0,
      model_name: modelName,
      deleted_ids: [],
      errors: ['Vector client not available'],
      duration_ms: Date.now() - startTime,
    };
  }

  try {
    const odooClient = getOdooClient();
    const qdrantClient = getQdrantClient();

    // Step 1: Get all record IDs from Odoo (including archived)
    onProgress?.('fetching_odoo', 0, 1);
    console.error(`[Cleanup] Fetching all record IDs from Odoo...`);

    const context = { active_test: false }; // Include archived records
    const odooRecords = await odooClient.searchRead<{ id: number }>(
      modelName,
      [],
      ['id'],
      { context }
    );
    const odooIds = new Set(odooRecords.map(r => r.id));
    console.error(`[Cleanup] Found ${odooIds.size} records in Odoo`);

    // Step 2: Get all point IDs from Qdrant for this model
    onProgress?.('fetching_qdrant', 0, 1);
    console.error(`[Cleanup] Fetching all record IDs from vector DB...`);

    // Scroll through all points for this model
    const vectorIds = new Set<number>();
    let scrollOffset: string | number | null = null;
    const scrollLimit = 1000;

    do {
      const scrollResult = await qdrantClient.scroll(QDRANT_CONFIG.COLLECTION, {
        filter: {
          must: [
            { key: 'model_name', match: { value: modelName } },
            { key: 'point_type', match: { value: 'data' } },
          ],
        },
        limit: scrollLimit,
        offset: scrollOffset ?? undefined,
        with_payload: ['record_id'],
      });

      for (const point of scrollResult.points) {
        const recordId = point.payload?.record_id;
        if (typeof recordId === 'number') {
          vectorIds.add(recordId);
        }
      }

      // Handle next_page_offset which can be string, number, or Record
      const nextOffset = scrollResult.next_page_offset;
      scrollOffset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
        ? nextOffset
        : null;
    } while (scrollOffset !== null);

    console.error(`[Cleanup] Found ${vectorIds.size} records in vector DB`);

    // Step 3: Find IDs in vector DB but not in Odoo (deleted)
    onProgress?.('comparing', 0, 1);
    const deletedIds: number[] = [];
    for (const vectorId of vectorIds) {
      if (!odooIds.has(vectorId)) {
        deletedIds.push(vectorId);
      }
    }

    console.error(`[Cleanup] Found ${deletedIds.length} deleted records to remove`);

    if (deletedIds.length === 0) {
      return {
        deleted: 0,
        model_name: modelName,
        deleted_ids: [],
        errors: [],
        duration_ms: Date.now() - startTime,
      };
    }

    // Step 4: Delete from Qdrant
    onProgress?.('deleting', 0, deletedIds.length);
    console.error(`[Cleanup] Deleting ${deletedIds.length} stale records from vector DB...`);

    // Generate point IDs for deletion
    const pointIdsToDelete = deletedIds.map(rid => generateDataPointId(modelId, rid));

    try {
      // Delete in batches if there are many
      const deleteBatchSize = 1000;
      for (let i = 0; i < pointIdsToDelete.length; i += deleteBatchSize) {
        const batch = pointIdsToDelete.slice(i, i + deleteBatchSize);
        await qdrantClient.delete(QDRANT_CONFIG.COLLECTION, {
          points: batch,
        });
        onProgress?.('deleting', Math.min(i + deleteBatchSize, pointIdsToDelete.length), pointIdsToDelete.length);
      }
      console.error(`[Cleanup] Successfully deleted ${deletedIds.length} stale records`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to delete from Qdrant: ${errMsg}`);
      console.error(`[Cleanup] Delete error: ${errMsg}`);
    }

    return {
      deleted: errors.length === 0 ? deletedIds.length : 0,
      model_name: modelName,
      deleted_ids: deletedIds,
      errors,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      deleted: 0,
      model_name: modelName,
      deleted_ids: [],
      errors: [errMsg],
      duration_ms: Date.now() - startTime,
    };
  }
}
