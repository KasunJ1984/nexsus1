/**
 * Cascade Sync Service
 *
 * Orchestrates cascading FK sync operations.
 * When syncing a model, automatically discovers and syncs referenced FK targets.
 *
 * Key features:
 * - One-direction cascading (outgoing FKs only)
 * - Incremental sync (skip already-synced records)
 * - Cycle detection (prevent infinite loops on self-referencing FKs)
 * - Parallel cascading (3-4 concurrent FK target syncs)
 * - Knowledge graph updates during cascade
 *
 * Usage:
 *   const result = await syncWithCascade('account.move.line', { parallelTargets: 3 });
 */

import chalk from 'chalk';
import {
  getFkFieldsForModel,
  extractFkDependencies,
  checkSyncedFkTargets,
  checkAllSyncedTargets,
  filterMissingDependencies,
  summarizeDependencies,
  type FkDependency,
  type FkFieldInfo,
} from './fk-dependency-discovery.js';
import {
  upsertRelationship,
  getModelRelationships,
  markModelAsLeaf,
} from './knowledge-graph.js';
import {
  getModelIdFromSchema,
  getModelFieldsFromSchema,
  getPayloadFieldsFromSchema,
  getOdooFieldNamesFromSchema,
  getPrimaryKeyFieldIdFromSchema,
  modelExistsInSchema,
} from './schema-query-service.js';
import { getOdooClient } from './odoo-client.js';
import { embedBatch } from './embedding-service.js';
import {
  upsertToUnifiedCollection,
  getQdrantClient,
  isVectorClientAvailable,
} from './vector-client.js';
import {
  transformPipelineRecords,
} from './pipeline-data-transformer.js';
import { syncPipelineData } from './pipeline-data-sync.js';
import { UNIFIED_CONFIG } from '../constants.js';
import { buildDataUuidV2 } from '../utils/uuid-v2.js';
import type { RelationshipType, PipelineDataPoint, SyncFkDependency } from '../types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Maximum records to fetch from Odoo at once.
 * Prevents Odoo MemoryError on large models (70,000+ records).
 * Smaller batches = less memory usage on Odoo server.
 */
const FETCH_BATCH_SIZE = 500;

/**
 * Minimum batch size for retry attempts.
 * If batch size goes below this, we stop retrying and skip the records.
 */
const MIN_RETRY_BATCH_SIZE = 10;

/**
 * Maximum retry attempts with halved batch size
 */
const MAX_BATCH_RETRIES = 5;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Fetch records with retry and batch size reduction on error.
 *
 * When Odoo returns OverflowError, MemoryError, or other batch errors:
 * 1. Halve the batch size
 * 2. Retry with smaller batches
 * 3. Keep retrying until batch size reaches MIN_RETRY_BATCH_SIZE
 * 4. Then give up and skip remaining records
 *
 * @param odooClient - Odoo client instance
 * @param modelName - Model to fetch from
 * @param batchIds - Record IDs to fetch
 * @param odooFields - Fields to fetch
 * @param batchNum - Current batch number (for logging)
 * @param totalBatches - Total number of batches (for logging)
 * @returns Object with fetched records and skipped IDs
 */
async function fetchBatchWithRetry(
  odooClient: ReturnType<typeof getOdooClient>,
  modelName: string,
  batchIds: number[],
  odooFields: string[],
  batchNum: number,
  totalBatches: number
): Promise<{ records: Array<Record<string, unknown>>; skippedIds: number[] }> {
  let currentBatchSize = batchIds.length;
  let currentIds = batchIds;
  let retryCount = 0;
  const allRecords: Array<Record<string, unknown>> = [];
  const skippedIds: number[] = [];

  while (currentIds.length > 0 && retryCount < MAX_BATCH_RETRIES) {
    try {
      const records = await odooClient.searchRead<Record<string, unknown>>(
        modelName,
        [['id', 'in', currentIds]],
        odooFields,
        { limit: currentIds.length }
      );
      allRecords.push(...records);
      break; // Success, exit retry loop
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      retryCount++;

      // Check if it's a retryable error
      const isRetryable =
        errorMsg.includes('OverflowError') ||
        errorMsg.includes('exceeds XML-RPC limits') ||
        errorMsg.includes('MemoryError');

      if (!isRetryable) {
        // Non-retryable error (e.g., invalid field) - skip all IDs in this batch
        console.error(`[CascadeSync] Batch ${batchNum}/${totalBatches}: Non-retryable error - skipping ${currentIds.length} records`);
        console.error(`[CascadeSync] Error: ${errorMsg.substring(0, 200)}`);
        skippedIds.push(...currentIds);
        break;
      }

      // Calculate new batch size (halve it)
      currentBatchSize = Math.max(Math.floor(currentBatchSize / 2), MIN_RETRY_BATCH_SIZE);

      if (currentBatchSize <= MIN_RETRY_BATCH_SIZE && retryCount > 1) {
        // Reached minimum batch size and already retried - give up on remaining
        console.error(`[CascadeSync] Batch ${batchNum}/${totalBatches}: Min batch size reached after ${retryCount} retries - skipping ${currentIds.length} records`);
        skippedIds.push(...currentIds);
        break;
      }

      console.error(`[CascadeSync] Batch ${batchNum}/${totalBatches}: Error, retrying with batch size ${currentBatchSize} (attempt ${retryCount}/${MAX_BATCH_RETRIES})`);

      // Split remaining IDs into smaller batches and fetch sequentially
      const smallerBatches: number[][] = [];
      for (let i = 0; i < currentIds.length; i += currentBatchSize) {
        smallerBatches.push(currentIds.slice(i, i + currentBatchSize));
      }

      // Process smaller batches
      const successfulIds: number[] = [];
      for (const smallBatch of smallerBatches) {
        try {
          const records = await odooClient.searchRead<Record<string, unknown>>(
            modelName,
            [['id', 'in', smallBatch]],
            odooFields,
            { limit: smallBatch.length }
          );
          allRecords.push(...records);
          successfulIds.push(...smallBatch);
        } catch (subError) {
          // Small batch failed - add to skipped
          skippedIds.push(...smallBatch);
        }
      }

      // All smaller batches processed
      currentIds = []; // Exit the while loop
    }
  }

  return { records: allRecords, skippedIds };
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for cascade sync operation
 */
export interface CascadeSyncOptions {
  /** Skip records that already exist in Qdrant (default: true) */
  skipExisting?: boolean;
  /** Number of FK targets to sync in parallel (default: 3) */
  parallelTargets?: number;
  /** Dry run mode - show plan without executing (default: false) */
  dryRun?: boolean;
  /** Update knowledge graph during cascade (default: true) */
  updateGraph?: boolean;
  /** Start date filter for PRIMARY MODEL ONLY (FK targets sync regardless of date) */
  dateFrom?: string;
  /** End date filter for PRIMARY MODEL ONLY (FK targets sync regardless of date) */
  dateTo?: string;
  /** Include archived records (default: true) */
  includeArchived?: boolean;
}

/**
 * Result of cascade sync operation
 */
export interface CascadeSyncResult {
  /** Primary model that was synced */
  primaryModel: {
    model_name: string;
    model_id: number;
    records_synced: number;
    fk_dependencies: FkDependency[];
  };
  /** Models synced via FK cascade */
  cascadedModels: Array<{
    model_name: string;
    model_id: number;
    records_synced: number;
    records_skipped: number;
    cascade_depth: number;
    triggered_by: string;
  }>;
  /** Knowledge graph updates */
  graph: {
    relationships_discovered: number;
    relationships_updated: number;
  };
  /** Cycle detection stats */
  cycles: {
    detected: number;
    models_visited: number;
    records_visited: number;
  };
  /** Total duration in milliseconds */
  duration_ms: number;
}

/**
 * Item in the cascade queue
 */
export interface CascadeQueueItem {
  /** Model to sync */
  model_name: string;
  /** Model ID */
  model_id: number;
  /** Specific record IDs to sync (empty = all records) */
  record_ids: number[];
  /** How deep in the cascade chain */
  depth: number;
  /** Which model triggered this cascade */
  triggered_by: string;
  /** FK field that led to this model */
  triggered_by_field: string;
}

// =============================================================================
// CYCLE DETECTOR
// =============================================================================

/**
 * Tracks visited records to detect and prevent cycles
 *
 * Cycles can occur with self-referencing FKs like:
 * - res.partner → parent_id → res.partner
 * - account.account → parent_id → account.account
 *
 * The detector tracks visited model:record_id pairs and prevents
 * processing the same record twice in a cascade chain.
 */
export class CycleDetector {
  /** Set of visited "model_name:record_id" keys */
  private visited: Set<string> = new Set();

  /** Count of cycles detected */
  private cyclesDetected: number = 0;

  /**
   * Check if a record should be processed
   *
   * Returns true if this is the first time seeing this record.
   * Returns false if we've already visited it (cycle detected).
   *
   * @param modelName - Model name
   * @param recordId - Record ID
   * @returns true if should process, false if already visited
   */
  shouldProcess(modelName: string, recordId: number): boolean {
    const key = `${modelName}:${recordId}`;

    if (this.visited.has(key)) {
      this.cyclesDetected++;
      return false;
    }

    this.visited.add(key);
    return true;
  }

  /**
   * Check multiple records at once
   *
   * Filters out already-visited records and marks new ones as visited.
   *
   * @param modelName - Model name
   * @param recordIds - Array of record IDs
   * @returns Array of record IDs that should be processed
   */
  filterUnvisited(modelName: string, recordIds: number[]): number[] {
    const unvisited: number[] = [];

    for (const recordId of recordIds) {
      if (this.shouldProcess(modelName, recordId)) {
        unvisited.push(recordId);
      }
    }

    return unvisited;
  }

  /**
   * Check if a record has been visited (without marking it)
   *
   * @param modelName - Model name
   * @param recordId - Record ID
   * @returns true if visited
   */
  hasVisited(modelName: string, recordId: number): boolean {
    return this.visited.has(`${modelName}:${recordId}`);
  }

  /**
   * Mark a record as visited without checking
   *
   * @param modelName - Model name
   * @param recordId - Record ID
   */
  markVisited(modelName: string, recordId: number): void {
    this.visited.add(`${modelName}:${recordId}`);
  }

  /**
   * Mark multiple records as visited
   *
   * @param modelName - Model name
   * @param recordIds - Array of record IDs
   */
  markAllVisited(modelName: string, recordIds: number[]): void {
    for (const recordId of recordIds) {
      this.visited.add(`${modelName}:${recordId}`);
    }
  }

  /**
   * Get number of cycles detected
   */
  getCyclesDetected(): number {
    return this.cyclesDetected;
  }

  /**
   * Get count of unique models visited
   */
  getModelsVisited(): number {
    const models = new Set<string>();
    for (const key of this.visited) {
      const [modelName] = key.split(':');
      models.add(modelName);
    }
    return models.size;
  }

  /**
   * Get total records visited
   */
  getRecordsVisited(): number {
    return this.visited.size;
  }

  /**
   * Get all visited keys (for debugging)
   */
  getVisitedKeys(): string[] {
    return Array.from(this.visited);
  }

  /**
   * Clear the visited set (for reuse)
   */
  reset(): void {
    this.visited.clear();
    this.cyclesDetected = 0;
  }
}

// =============================================================================
// CASCADE QUEUE
// =============================================================================

/**
 * Queue manager for BFS-style cascade processing
 *
 * Manages the order of FK targets to sync, ensuring:
 * - Breadth-first processing (closer FKs first)
 * - No duplicate queue entries
 * - Parallel batch extraction
 */
export class CascadeQueue {
  /** Queue of items to process */
  private queue: CascadeQueueItem[] = [];

  /** Set of "model_name" keys already in queue (prevent duplicates) */
  private queued: Set<string> = new Set();

  /**
   * Add an item to the queue
   *
   * @param item - Queue item to add
   * @returns true if added, false if already queued
   */
  enqueue(item: CascadeQueueItem): boolean {
    const key = item.model_name;

    // If model already queued, merge record_ids instead of adding duplicate
    if (this.queued.has(key)) {
      const existing = this.queue.find(q => q.model_name === item.model_name);
      if (existing && item.record_ids.length > 0) {
        // Merge record IDs (deduplicated)
        const mergedIds = new Set([...existing.record_ids, ...item.record_ids]);
        existing.record_ids = Array.from(mergedIds);
      }
      return false;
    }

    this.queue.push(item);
    this.queued.add(key);
    return true;
  }

  /**
   * Add multiple items to the queue
   *
   * @param items - Array of queue items
   * @returns Number of items added (not duplicates)
   */
  enqueueAll(items: CascadeQueueItem[]): number {
    let added = 0;
    for (const item of items) {
      if (this.enqueue(item)) {
        added++;
      }
    }
    return added;
  }

  /**
   * Get next item from queue
   *
   * @returns Next item or undefined if empty
   */
  dequeue(): CascadeQueueItem | undefined {
    return this.queue.shift();
  }

  /**
   * Get next N items for parallel processing
   *
   * @param count - Max items to get
   * @returns Array of items
   */
  dequeueBatch(count: number): CascadeQueueItem[] {
    const batch: CascadeQueueItem[] = [];
    for (let i = 0; i < count && this.queue.length > 0; i++) {
      const item = this.queue.shift();
      if (item) {
        batch.push(item);
      }
    }
    return batch;
  }

  /**
   * Check if queue is empty
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Get current queue length
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Get all items in queue (for inspection)
   */
  getAll(): CascadeQueueItem[] {
    return [...this.queue];
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
    this.queued.clear();
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build cascade queue items from FK dependencies
 *
 * Converts discovered FK dependencies into queue items for processing.
 *
 * @param dependencies - FK dependencies with missing targets
 * @param depth - Current cascade depth
 * @param triggeredBy - Model that triggered this cascade
 * @returns Array of queue items
 */
export function buildQueueItems(
  dependencies: FkDependency[],
  depth: number,
  triggeredBy: string
): CascadeQueueItem[] {
  return dependencies.map(dep => ({
    model_name: dep.target_model,
    model_id: dep.target_model_id,
    record_ids: dep.unique_ids,
    depth: depth + 1,
    triggered_by: triggeredBy,
    triggered_by_field: dep.field_name,
  }));
}

/**
 * Update knowledge graph with discovered relationships
 *
 * Records FK relationships in the nexsus_unified collection (point_type='graph').
 *
 * @param sourceModel - Source model name
 * @param sourceModelId - Source model ID
 * @param dependencies - FK dependencies discovered
 * @param cascadeSource - Name of the cascade source model
 */
export async function updateGraphFromDependencies(
  sourceModel: string,
  sourceModelId: number,
  dependencies: FkDependency[],
  cascadeSource: string
): Promise<{ discovered: number; updated: number }> {
  let discovered = 0;
  let updated = 0;

  for (const dep of dependencies) {
    try {
      await upsertRelationship({
        source_model: sourceModel,
        source_model_id: sourceModelId,
        field_id: dep.field_id,
        field_name: dep.field_name,
        field_label: dep.field_label,
        field_type: dep.field_type,
        target_model: dep.target_model,
        target_model_id: dep.target_model_id,
        edge_count: dep.total_references,
        unique_targets: dep.unique_ids.length,
        cascade_source: cascadeSource,
      });

      // Check if this was a new relationship or update
      const existing = await getModelRelationships(sourceModel);
      if (existing.some(r => r.field_name === dep.field_name)) {
        updated++;
      } else {
        discovered++;
      }
    } catch (error) {
      console.error(`[CascadeSync] Failed to update graph for ${dep.field_name}: ${error}`);
    }
  }

  return { discovered, updated };
}

/**
 * Check if a model is a leaf (no outgoing FKs)
 *
 * A leaf model has no FK fields that reference other models.
 * The cascade stops at leaf models.
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 *
 * @param modelName - Model name to check
 * @returns true if model has no outgoing FKs
 */
export async function isLeafModel(modelName: string): Promise<boolean> {
  const fkFields = await getFkFieldsForModel(modelName);
  return fkFields.length === 0;
}

/**
 * Format cascade result for display
 *
 * @param result - Cascade sync result
 * @returns Formatted string
 */
export function formatCascadeResult(result: CascadeSyncResult): string {
  const lines: string[] = [];

  lines.push('# Cascade Sync Result\n');

  lines.push('## Primary Model');
  lines.push(`- Model: ${result.primaryModel.model_name}`);
  lines.push(`- Records synced: ${result.primaryModel.records_synced}`);
  lines.push(`- FK dependencies: ${result.primaryModel.fk_dependencies.length}`);
  lines.push('');

  if (result.cascadedModels.length > 0) {
    lines.push('## Cascaded Models');
    for (const m of result.cascadedModels) {
      lines.push(`- ${m.model_name}: ${m.records_synced} synced, ${m.records_skipped} skipped (depth ${m.cascade_depth})`);
    }
    lines.push('');
  }

  lines.push('## Statistics');
  lines.push(`- Duration: ${result.duration_ms}ms`);
  lines.push(`- Relationships discovered: ${result.graph.relationships_discovered}`);
  lines.push(`- Relationships updated: ${result.graph.relationships_updated}`);
  lines.push(`- Cycles detected: ${result.cycles.detected}`);
  lines.push(`- Models visited: ${result.cycles.models_visited}`);
  lines.push(`- Records visited: ${result.cycles.records_visited}`);

  return lines.join('\n');
}

// =============================================================================
// SPECIFIC RECORD SYNC
// =============================================================================

/**
 * Result of syncing specific records
 */
export interface SpecificSyncResult {
  model_name: string;
  model_id: number;
  records_requested: number;
  records_fetched: number;
  records_synced: number;
  records_skipped: number;
  records_failed: number;
  duration_ms: number;
  /** Raw records fetched from Odoo (for FK extraction) */
  records?: Array<Record<string, unknown>>;
}

/**
 * Sync specific record IDs from a model
 *
 * Unlike full sync, this only fetches and syncs the specified record IDs.
 * Used by cascade sync to sync FK targets.
 *
 * @param modelName - Model name to sync
 * @param recordIds - Specific record IDs to sync
 * @param options - Options (returnRecords to get raw records for FK extraction)
 * @returns Sync result
 */
export async function syncSpecificRecords(
  modelName: string,
  recordIds: number[],
  options: { returnRecords?: boolean } = {}
): Promise<SpecificSyncResult> {
  const startTime = Date.now();

  console.error(`[CascadeSync] Syncing ${recordIds.length} specific records from ${modelName}`);

  // Get model ID from schema
  const modelId = await getModelIdFromSchema(modelName);
  if (!modelId) {
    throw new Error(`Model '${modelName}' not found in schema. Run 'npm run sync -- sync schema' first.`);
  }

  // Get fields to fetch from Odoo (stored fields only)
  const odooFields = await getOdooFieldNamesFromSchema(modelName);

  // Fetch specific records from Odoo using batch fetching with retry logic
  // This prevents Odoo MemoryError on large models and recovers from transient errors
  const odooClient = getOdooClient();
  const allRecords: Array<Record<string, unknown>> = [];
  const skippedBatches: number[] = []; // Track batches skipped due to errors
  const totalBatches = Math.ceil(recordIds.length / FETCH_BATCH_SIZE);

  console.error(`[CascadeSync] Fetching ${recordIds.length} records in ${totalBatches} batches (${FETCH_BATCH_SIZE} per batch)`);

  for (let i = 0; i < recordIds.length; i += FETCH_BATCH_SIZE) {
    const batchIds = recordIds.slice(i, i + FETCH_BATCH_SIZE);
    const batchNum = Math.floor(i / FETCH_BATCH_SIZE) + 1;

    // Use retry helper with batch size reduction on error
    const { records: batchRecords, skippedIds } = await fetchBatchWithRetry(
      odooClient,
      modelName,
      batchIds,
      odooFields,
      batchNum,
      totalBatches
    );

    allRecords.push(...batchRecords);
    skippedBatches.push(...skippedIds);

    if (totalBatches > 1 && batchRecords.length > 0) {
      console.error(`[CascadeSync] Batch ${batchNum}/${totalBatches}: ${batchRecords.length} records`);
    }
  }

  // Log summary
  const records = allRecords;
  if (skippedBatches.length > 0) {
    console.error(`[CascadeSync] Fetched ${records.length} records, skipped ${skippedBatches.length} due to errors`);
  } else {
    console.error(`[CascadeSync] Fetched ${records.length} records from Odoo`);
  }

  if (records.length === 0) {
    return {
      model_name: modelName,
      model_id: modelId,
      records_requested: recordIds.length,
      records_fetched: 0,
      records_synced: 0,
      records_skipped: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
    };
  }

  // Transform records (async - queries Qdrant schema)
  const transformed = await transformPipelineRecords(records, modelName);
  console.error(`[CascadeSync] Transformed ${transformed.length} records`);

  // Embed and upload
  let recordsSynced = 0;
  let recordsFailed = 0;

  try {
    const texts = transformed.map(r => r.vector_text);
    const embeddings = await embedBatch(texts, 'document');

    if (embeddings.length !== transformed.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${transformed.length}`);
    }

    // Build points for Qdrant with V2 UUID format
    const points: PipelineDataPoint[] = transformed.map((record, idx) => {
      const pointId = buildDataUuidV2(record.model_id, record.record_id);

      return {
        id: pointId,
        vector: embeddings[idx],
        payload: {
          point_id: pointId,  // V2 UUID for querying/filtering
          record_id: record.record_id,
          model_name: record.model_name,
          model_id: record.model_id,
          sync_timestamp: new Date().toISOString(),
          point_type: 'data' as const,
          vector_text: record.vector_text,
          ...record.payload,
        },
      };
    });

    // Upsert to unified collection
    await upsertToUnifiedCollection(points);
    recordsSynced = transformed.length;
    console.error(`[CascadeSync] Uploaded ${recordsSynced} records to Qdrant`);

  } catch (error) {
    recordsFailed = transformed.length;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[CascadeSync] Failed to embed/upload: ${errorMsg}`);
  }

  const result: SpecificSyncResult = {
    model_name: modelName,
    model_id: modelId,
    records_requested: recordIds.length,
    records_fetched: records.length,
    records_synced: recordsSynced,
    records_skipped: skippedBatches.length, // Records skipped due to OverflowError, Invalid field, etc.
    records_failed: recordsFailed,
    duration_ms: Date.now() - startTime,
  };

  // Optionally return raw records for FK extraction
  if (options.returnRecords) {
    result.records = records;
  }

  return result;
}

// =============================================================================
// QUEUE PROCESSING
// =============================================================================

/**
 * Process cascade queue with parallel sync
 *
 * Takes items from the queue and syncs them in parallel batches.
 * Discovers FK dependencies for each synced model and adds to queue.
 *
 * @param queue - Cascade queue
 * @param cycleDetector - Cycle detector
 * @param options - Cascade options
 * @param result - Result object to update
 */
async function processCascadeQueue(
  queue: CascadeQueue,
  cycleDetector: CycleDetector,
  options: CascadeSyncOptions,
  result: CascadeSyncResult
): Promise<void> {
  const { parallelTargets = 3, updateGraph = true, dryRun = false } = options;

  while (!queue.isEmpty()) {
    // Get batch of items for parallel processing
    const batch = queue.dequeueBatch(parallelTargets);
    console.error(`[CascadeSync] Processing batch of ${batch.length} FK targets`);

    // Process batch in parallel
    const promises = batch.map(async (item) => {
      // Filter record IDs through cycle detector
      const unvisitedIds = cycleDetector.filterUnvisited(item.model_name, item.record_ids);

      if (unvisitedIds.length === 0) {
        console.error(`[CascadeSync] ${item.model_name}: All ${item.record_ids.length} records already visited (cycle)`);
        return {
          item,
          synced: 0,
          skipped: item.record_ids.length,
          dependencies: [] as FkDependency[],
        };
      }

      console.error(`[CascadeSync] ${item.model_name}: ${unvisitedIds.length} new records (${item.record_ids.length - unvisitedIds.length} cycles detected)`);

      if (dryRun) {
        return {
          item,
          synced: unvisitedIds.length,
          skipped: 0,
          dependencies: [] as FkDependency[],
        };
      }

      // Validate FK target model exists in schema
      const modelExists = await modelExistsInSchema(item.model_name);
      if (!modelExists) {
        // Detailed logging for developer debugging
        console.error('');
        console.error(chalk.yellow('='.repeat(60)));
        console.error(chalk.yellow('[CascadeSync] SCHEMA WARNING - FK Target Missing'));
        console.error(chalk.yellow('='.repeat(60)));
        console.error(chalk.white(`FK Target Model: ${chalk.bold(item.model_name)}`));
        console.error(chalk.white(`Triggered By:    ${item.triggered_by}.${item.triggered_by_field}`));
        console.error(chalk.white(`Record IDs:      ${unvisitedIds.length} records skipped`));
        console.error(chalk.white(`Sample IDs:      [${unvisitedIds.slice(0, 5).join(', ')}${unvisitedIds.length > 5 ? '...' : ''}]`));
        console.error(chalk.white(`Cascade Depth:   ${item.depth}`));
        console.error('');
        console.error(chalk.cyan(`FIX: Run 'npm run sync -- sync schema' to add this model to schema`));
        console.error(chalk.yellow('='.repeat(60)));
        console.error('');

        return {
          item,
          synced: 0,
          skipped: unvisitedIds.length,
          dependencies: [] as FkDependency[],
        };
      }

      // Sync the specific records
      const syncResult = await syncSpecificRecords(
        item.model_name,
        unvisitedIds,
        { returnRecords: true }
      );

      // Extract FK dependencies from synced records
      let dependencies: FkDependency[] = [];
      if (syncResult.records && syncResult.records.length > 0) {
        const fkFields = await getFkFieldsForModel(item.model_name);
        if (fkFields.length > 0) {
          dependencies = extractFkDependencies(syncResult.records, fkFields);
          console.error(`[CascadeSync] ${item.model_name}: Found ${dependencies.length} FK dependencies`);
        } else {
          console.error(`[CascadeSync] ${item.model_name}: No outgoing FKs (leaf model)`);
          if (updateGraph) {
            await markModelAsLeaf(item.model_name);
          }
        }
      }

      return {
        item,
        synced: syncResult.records_synced,
        skipped: syncResult.records_skipped,
        dependencies,
      };
    });

    // Wait for batch to complete
    const batchResults = await Promise.all(promises);

    // Process batch results
    for (const batchResult of batchResults) {
      const { item, synced, skipped, dependencies } = batchResult;

      // Add to cascaded models list
      result.cascadedModels.push({
        model_name: item.model_name,
        model_id: item.model_id,
        records_synced: synced,
        records_skipped: skipped,
        cascade_depth: item.depth,
        triggered_by: item.triggered_by,
      });

      // Update knowledge graph
      if (updateGraph && dependencies.length > 0) {
        const graphUpdate = await updateGraphFromDependencies(
          item.model_name,
          item.model_id,
          dependencies,
          result.primaryModel.model_name
        );
        result.graph.relationships_discovered += graphUpdate.discovered;
        result.graph.relationships_updated += graphUpdate.updated;
      }

      // Check which FK targets need syncing and queue them
      if (dependencies.length > 0) {
        const syncStatus = await checkAllSyncedTargets(dependencies);
        const missingDeps = filterMissingDependencies(dependencies, syncStatus);

        if (missingDeps.length > 0) {
          console.error(`[CascadeSync] ${item.model_name}: Queueing ${missingDeps.length} FK targets with missing records`);
          const queueItems = buildQueueItems(missingDeps, item.depth, item.model_name);
          queue.enqueueAll(queueItems);
        }
      }
    }
  }

  // Update cycle stats in result
  result.cycles.detected = cycleDetector.getCyclesDetected();
  result.cycles.models_visited = cycleDetector.getModelsVisited();
  result.cycles.records_visited = cycleDetector.getRecordsVisited();
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

/**
 * Execute cascade sync for a model
 *
 * This is the main entry point for cascade sync.
 * Syncs specified records and cascades to FK targets.
 *
 * @param modelName - Primary model to sync
 * @param options - Sync options
 * @param recordIds - Optional specific record IDs to sync (if not provided, syncs all records from Odoo)
 * @returns Cascade sync result
 */
export async function syncWithCascade(
  modelName: string,
  options: CascadeSyncOptions = {},
  recordIds?: number[]
): Promise<CascadeSyncResult> {
  const startTime = Date.now();

  const {
    skipExisting = true,
    parallelTargets = 3,
    dryRun = false,
    updateGraph = true,
    dateFrom,
    dateTo,
    includeArchived = true,
  } = options;

  console.error(`[CascadeSync] Starting cascade for ${modelName}`);
  console.error(`[CascadeSync] Options: skipExisting=${skipExisting}, parallel=${parallelTargets}, dryRun=${dryRun}`);
  if (dateFrom || dateTo) {
    console.error(`[CascadeSync] Date filter (PRIMARY MODEL ONLY): from=${dateFrom || 'none'}, to=${dateTo || 'none'}`);
  }

  // Initialize tracking
  const cycleDetector = new CycleDetector();
  const cascadeQueue = new CascadeQueue();

  // Get model ID from schema
  const modelId = await getModelIdFromSchema(modelName);
  if (!modelId) {
    throw new Error(`Model not found in schema: ${modelName}`);
  }

  // Get FK fields for the model (now async - queries Qdrant)
  const fkFields = await getFkFieldsForModel(modelName);
  console.error(`[CascadeSync] Found ${fkFields.length} FK fields for ${modelName}`);

  // Check if this is a leaf model
  if (fkFields.length === 0) {
    console.error(`[CascadeSync] ${modelName} is a leaf model (no outgoing FKs)`);
    if (updateGraph) {
      await markModelAsLeaf(modelName);
    }
  }

  // Build result structure
  const result: CascadeSyncResult = {
    primaryModel: {
      model_name: modelName,
      model_id: modelId,
      records_synced: 0,
      fk_dependencies: [],
    },
    cascadedModels: [],
    graph: {
      relationships_discovered: 0,
      relationships_updated: 0,
    },
    cycles: {
      detected: 0,
      models_visited: 0,
      records_visited: 0,
    },
    duration_ms: 0,
  };

  // Step 1: Sync primary model records
  console.error(`[CascadeSync] Step 1: Syncing primary model ${modelName}`);

  let primaryRecords: Array<Record<string, unknown>> = [];

  if (recordIds && recordIds.length > 0) {
    // Sync specific records
    if (!dryRun) {
      // Filter through cycle detector
      const unvisitedIds = cycleDetector.filterUnvisited(modelName, recordIds);

      if (unvisitedIds.length > 0) {
        const syncResult = await syncSpecificRecords(modelName, unvisitedIds, { returnRecords: true });
        result.primaryModel.records_synced = syncResult.records_synced;
        primaryRecords = syncResult.records || [];
      }
    } else {
      result.primaryModel.records_synced = recordIds.length;
      cycleDetector.markAllVisited(modelName, recordIds);
    }
  } else {
    // No specific records provided - sync all records with optional date filter
    console.error(`[CascadeSync] No specific record IDs provided. Running full sync for ${modelName}.`);

    if (!dryRun) {
      // =========================================================================
      // SOLUTION 2: Collect FK IDs during sync
      // =========================================================================
      // Instead of fetching from Qdrant with limit: 10000 (which missed FK targets),
      // we now collect FK IDs as records stream through syncPipelineData.
      // This ensures ALL FK IDs are captured from ALL records.
      // =========================================================================
      const syncResult = await syncPipelineData(modelName, {
        force_full: false,
        include_archived: includeArchived,
        date_from: dateFrom,
        date_to: dateTo,
        collect_fk_dependencies: true,  // Solution 2: Collect FK IDs during sync
      });

      result.primaryModel.records_synced = syncResult.records_uploaded;

      if (!syncResult.success) {
        console.error(`[CascadeSync] Primary sync failed: ${syncResult.errors?.join(', ')}`);
        result.duration_ms = Date.now() - startTime;
        return result;
      }

      // Use FK dependencies collected during sync (not from Qdrant scroll)
      if (syncResult.fk_dependencies && syncResult.fk_dependencies.length > 0) {
        // Convert SyncFkDependency to FkDependency (they're now compatible)
        const dependencies: FkDependency[] = syncResult.fk_dependencies.map(dep => ({
          field_id: dep.field_id,
          field_name: dep.field_name,
          field_label: dep.field_label,
          field_type: dep.field_type,
          target_model: dep.target_model,
          target_model_id: dep.target_model_id,
          unique_ids: dep.unique_ids,
          total_references: dep.total_references,
        }));

        result.primaryModel.fk_dependencies = dependencies;
        console.error(`[CascadeSync] Using FK dependencies collected during sync (${dependencies.length} FK fields)`);
        console.error(summarizeDependencies(dependencies));

        // Step 3: Check sync status of FK targets
        console.error(`[CascadeSync] Step 3: Checking sync status of FK targets`);

        if (skipExisting) {
          const syncStatus = await checkAllSyncedTargets(dependencies);
          const missingDeps = filterMissingDependencies(dependencies, syncStatus);

          console.error(`[CascadeSync] Dependencies with missing records: ${missingDeps.length}`);

          // Step 4: Queue missing FK targets
          if (missingDeps.length > 0) {
            const queueItems = buildQueueItems(missingDeps, 0, modelName);
            cascadeQueue.enqueueAll(queueItems);
            console.error(`[CascadeSync] Queued ${queueItems.length} FK targets for cascade`);
          }
        } else {
          // Queue all dependencies (no skip)
          const queueItems = buildQueueItems(dependencies, 0, modelName);
          cascadeQueue.enqueueAll(queueItems);
          console.error(`[CascadeSync] Queued ${queueItems.length} FK targets (skipExisting=false)`);
        }

        // Update knowledge graph with primary model relationships
        if (updateGraph) {
          const graphUpdate = await updateGraphFromDependencies(
            modelName,
            modelId,
            dependencies,
            modelName
          );
          result.graph.relationships_discovered += graphUpdate.discovered;
          result.graph.relationships_updated += graphUpdate.updated;
        }
      } else {
        console.error(`[CascadeSync] No FK dependencies found (leaf model or no FK fields in schema)`);
      }
    } else {
      result.primaryModel.records_synced = 0;
      console.error(`[CascadeSync] Dry run: would sync all ${modelName} records`);
    }
  }

  console.error(`[CascadeSync] Primary model: ${result.primaryModel.records_synced} records synced`);

  // Step 2: Extract FK dependencies from synced records (for specific record sync only)
  // NOTE: For full sync, FK dependencies are already extracted above via collect_fk_dependencies
  console.error(`[CascadeSync] Step 2: Extracting FK dependencies from specific records (if any)`);

  if (primaryRecords.length > 0 && fkFields.length > 0 && result.primaryModel.fk_dependencies.length === 0) {
    // This branch only runs for specific record syncs, not full syncs
    const dependencies = extractFkDependencies(primaryRecords, fkFields);
    result.primaryModel.fk_dependencies = dependencies;
    console.error(`[CascadeSync] Found ${dependencies.length} FK dependencies`);
    console.error(summarizeDependencies(dependencies));

    // Step 3: Check sync status of FK targets
    console.error(`[CascadeSync] Step 3: Checking sync status of FK targets`);

    if (skipExisting) {
      const syncStatus = await checkAllSyncedTargets(dependencies);
      const missingDeps = filterMissingDependencies(dependencies, syncStatus);

      console.error(`[CascadeSync] Dependencies with missing records: ${missingDeps.length}`);

      // Step 4: Queue missing FK targets
      if (missingDeps.length > 0) {
        const queueItems = buildQueueItems(missingDeps, 0, modelName);
        cascadeQueue.enqueueAll(queueItems);
        console.error(`[CascadeSync] Queued ${queueItems.length} FK targets for cascade`);
      }
    } else {
      // Queue all dependencies (no skip)
      const queueItems = buildQueueItems(dependencies, 0, modelName);
      cascadeQueue.enqueueAll(queueItems);
      console.error(`[CascadeSync] Queued ${queueItems.length} FK targets (skipExisting=false)`);
    }

    // Update knowledge graph with primary model relationships
    if (updateGraph) {
      const graphUpdate = await updateGraphFromDependencies(
        modelName,
        modelId,
        dependencies,
        modelName
      );
      result.graph.relationships_discovered += graphUpdate.discovered;
      result.graph.relationships_updated += graphUpdate.updated;
    }
  }

  // Step 5: Process cascade queue (BFS)
  console.error(`[CascadeSync] Step 5: Processing cascade queue (${cascadeQueue.size()} items)`);

  await processCascadeQueue(cascadeQueue, cycleDetector, options, result);

  // Final stats
  result.duration_ms = Date.now() - startTime;

  console.error(`[CascadeSync] Cascade complete in ${result.duration_ms}ms`);
  console.error(`[CascadeSync] Summary:`);
  console.error(`  - Primary: ${result.primaryModel.records_synced} records`);
  console.error(`  - Cascaded: ${result.cascadedModels.length} models`);
  console.error(`  - Graph: ${result.graph.relationships_discovered} discovered, ${result.graph.relationships_updated} updated`);
  console.error(`  - Cycles: ${result.cycles.detected} detected, ${result.cycles.records_visited} records visited`);

  return result;
}
