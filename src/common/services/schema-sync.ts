/**
 * Schema Sync Service
 *
 * Uploads Odoo schema data to Qdrant vector database.
 * Handles embedding generation and batch uploads.
 */

import * as path from 'path';
import { SYNC_CONFIG, QDRANT_CONFIG, SCHEMA_CONFIG } from '../constants.js';
import { loadSchema, buildSemanticText, clearSchemaCache } from './schema-loader.js';
import { embed, embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import { clearCache } from './cache-service.js';
import {
  createSchemaCollection,
  upsertSchemaPoints,
  getCollectionInfo,
  deleteCollection,
  deleteSchemaPoints,
  isVectorClientAvailable,
} from './vector-client.js';
import {
  loadSyncMetadata,
  saveSyncMetadata,
  detectChanges,
  hasSchemaFileChanged,
  buildChecksumMap,
  createSyncMetadata,
  formatChangesSummary,
  clearSyncMetadata,
} from './sync-metadata.js';
import type { OdooSchemaRow, SchemaPoint, SchemaPayload, SchemaSyncResult, SchemaSyncStatus, IncrementalSyncResult } from '../types.js';

// =============================================================================
// SYNC STATE
// =============================================================================

let lastSyncTime: string | null = null;
let isSyncing = false;

// =============================================================================
// SYNC FUNCTIONS
// =============================================================================

/**
 * Build schema payload for Qdrant
 */
function buildSchemaPayload(schema: OdooSchemaRow, semanticText: string): SchemaPayload {
  return {
    model_id: schema.model_id,
    field_id: schema.field_id,
    model_name: schema.model_name,
    field_name: schema.field_name,
    field_label: schema.field_label,
    field_type: schema.field_type,
    primary_data_location: schema.primary_data_location,
    primary_model_id: String(schema.primary_model_id),
    primary_field_id: String(schema.primary_field_id),
    stored: schema.stored,
    semantic_text: semanticText,
    raw_encoded: schema.raw_encoded,
    sync_timestamp: new Date().toISOString(),
  };
}

/**
 * Sync all schema to Qdrant
 *
 * @param forceRecreate - Delete and recreate collection first
 * @param onProgress - Progress callback
 * @returns Sync result
 */
export async function syncSchemaToQdrant(
  forceRecreate: boolean = false,
  onProgress?: (phase: string, current: number, total: number) => void
): Promise<SchemaSyncResult> {
  const startTime = Date.now();

  // Check prerequisites
  if (!isVectorClientAvailable()) {
    return {
      success: false,
      uploaded: 0,
      failed: 0,
      durationMs: Date.now() - startTime,
      errors: ['Vector client not available. Check QDRANT_HOST.'],
    };
  }

  if (!isEmbeddingServiceAvailable()) {
    return {
      success: false,
      uploaded: 0,
      failed: 0,
      durationMs: Date.now() - startTime,
      errors: ['Embedding service not available. Check VOYAGE_API_KEY.'],
    };
  }

  if (isSyncing) {
    return {
      success: false,
      uploaded: 0,
      failed: 0,
      durationMs: Date.now() - startTime,
      errors: ['Sync already in progress.'],
    };
  }

  isSyncing = true;
  const errors: string[] = [];
  let uploaded = 0;
  let failed = 0;

  try {
    // Phase 1: Prepare collection
    onProgress?.('preparing', 0, 1);
    console.error('[SchemaSync] Phase 1: Preparing collection...');

    if (forceRecreate) {
      console.error('[SchemaSync] Force recreate - deleting existing collection');
      await deleteCollection(QDRANT_CONFIG.COLLECTION);
    }

    const collectionCreated = await createSchemaCollection();
    if (collectionCreated) {
      console.error('[SchemaSync] Collection created');
    } else {
      console.error('[SchemaSync] Collection already exists');
    }

    // Phase 2: Load schema
    onProgress?.('loading', 0, 1);
    console.error('[SchemaSync] Phase 2: Loading schema...');

    clearSchemaCache(); // Ensure fresh load
    const schemas = loadSchema();

    if (schemas.length === 0) {
      throw new Error('No schema data found. Check data/odoo_schema.txt');
    }

    console.error(`[SchemaSync] Loaded ${schemas.length} schema rows`);

    // Phase 3: Generate embeddings and upload in batches
    const totalBatches = Math.ceil(schemas.length / SYNC_CONFIG.BATCH_SIZE);
    console.error(`[SchemaSync] Phase 3: Processing ${totalBatches} batches...`);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * SYNC_CONFIG.BATCH_SIZE;
      const batchEnd = Math.min(batchStart + SYNC_CONFIG.BATCH_SIZE, schemas.length);
      const batch = schemas.slice(batchStart, batchEnd);

      onProgress?.('embedding', batchStart, schemas.length);
      console.error(`[SchemaSync] Batch ${batchIndex + 1}/${totalBatches} (${batchStart}-${batchEnd})`);

      try {
        // Build semantic texts for batch
        const semanticTexts = batch.map(schema => buildSemanticText(schema));

        // Generate embeddings
        const embeddings = await embedBatch(semanticTexts, 'document');

        // Log embedding dimensions for first batch
        if (batchIndex === 0 && embeddings.length > 0) {
          console.error(`[SchemaSync] Embedding dimensions: ${embeddings[0].length}`);
        }

        // Build points for upsert
        const points: SchemaPoint[] = [];
        for (let i = 0; i < batch.length; i++) {
          const schema = batch[i];
          const embedding = embeddings[i];

          if (embedding) {
            points.push({
              id: schema.field_id, // Use field_id as unique identifier
              vector: embedding,
              payload: buildSchemaPayload(schema, semanticTexts[i]),
            });
          } else {
            failed++;
            errors.push(`Failed to embed: ${schema.model_name}.${schema.field_name}`);
          }
        }

        // Upsert to Qdrant
        if (points.length > 0) {
          onProgress?.('uploading', batchStart, schemas.length);
          await upsertSchemaPoints(points);
          uploaded += points.length;
        }
      } catch (batchError) {
        const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
        // Log full error for first batch to debug
        if (batchIndex === 0) {
          console.error(`[SchemaSync] First batch error details:`, JSON.stringify(batchError, null, 2));
        }
        console.error(`[SchemaSync] Batch ${batchIndex + 1} error:`, errorMsg);
        errors.push(`Batch ${batchIndex + 1} error: ${errorMsg}`);
        failed += batch.length;
      }
    }

    // Update last sync time
    lastSyncTime = new Date().toISOString();

    // Clear query cache to ensure fresh results with new data
    clearCache();

    console.error(`[SchemaSync] Sync complete: ${uploaded} uploaded, ${failed} failed`);

    return {
      success: errors.length === 0,
      uploaded,
      failed,
      durationMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[SchemaSync] Sync failed:', errorMsg);
    return {
      success: false,
      uploaded,
      failed,
      durationMs: Date.now() - startTime,
      errors: [errorMsg],
    };
  } finally {
    isSyncing = false;
  }
}

/**
 * Get current sync status
 */
export async function getSyncStatus(): Promise<SchemaSyncStatus> {
  const collectionInfo = await getCollectionInfo(QDRANT_CONFIG.COLLECTION);

  return {
    collection: QDRANT_CONFIG.COLLECTION,
    vectorCount: collectionInfo.vectorCount,
    lastSync: lastSyncTime,
  };
}

/**
 * Check if sync is currently running
 */
export function isSyncRunning(): boolean {
  return isSyncing;
}

/**
 * Sync a single schema row (for incremental updates)
 */
export async function syncSingleSchema(schema: OdooSchemaRow): Promise<boolean> {
  if (!isVectorClientAvailable() || !isEmbeddingServiceAvailable()) {
    console.error('[SchemaSync] Services not available');
    return false;
  }

  try {
    const semanticText = buildSemanticText(schema);
    const embedding = await embed(semanticText, 'document');

    const point: SchemaPoint = {
      id: schema.field_id,
      vector: embedding,
      payload: buildSchemaPayload(schema, semanticText),
    };

    await upsertSchemaPoints([point]);
    console.error(`[SchemaSync] Synced: ${schema.model_name}.${schema.field_name}`);
    return true;
  } catch (error) {
    console.error('[SchemaSync] Single sync failed:', error);
    return false;
  }
}

// =============================================================================
// INCREMENTAL SYNC
// =============================================================================

/**
 * Incremental sync - only process changed fields
 *
 * Key features:
 * 1. Compares current schema with previous sync metadata
 * 2. Only embeds added/modified fields (huge API cost savings)
 * 3. Deletes removed fields from Qdrant
 * 4. Preserves query cache if no changes detected
 *
 * Integration with Improvement #2 (Caching):
 * - If changes detected → clears cache (ensures freshness)
 * - If no changes → preserves cache (instant return)
 *
 * @param onProgress - Progress callback
 * @returns IncrementalSyncResult with counts of added/modified/deleted/unchanged
 */
export async function incrementalSyncSchema(
  onProgress?: (phase: string, current: number, total: number) => void
): Promise<IncrementalSyncResult> {
  const startTime = Date.now();

  // Check prerequisites
  if (!isVectorClientAvailable()) {
    return {
      success: false,
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      durationMs: Date.now() - startTime,
      cacheCleared: false,
      errors: ['Vector client not available. Check QDRANT_HOST.'],
    };
  }

  if (!isEmbeddingServiceAvailable()) {
    return {
      success: false,
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      durationMs: Date.now() - startTime,
      cacheCleared: false,
      errors: ['Embedding service not available. Check VOYAGE_API_KEY.'],
    };
  }

  if (isSyncing) {
    return {
      success: false,
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      durationMs: Date.now() - startTime,
      cacheCleared: false,
      errors: ['Sync already in progress.'],
    };
  }

  isSyncing = true;
  const errors: string[] = [];

  try {
    // Phase 1: Load previous metadata and current schema
    onProgress?.('loading', 0, 1);
    console.error('[IncrementalSync] Phase 1: Loading schema and metadata...');

    const schemaFilePath = path.resolve(process.cwd(), SCHEMA_CONFIG.DATA_FILE);
    const previousMetadata = loadSyncMetadata();

    // Quick check: has schema file changed at all?
    if (previousMetadata && !hasSchemaFileChanged(schemaFilePath, previousMetadata)) {
      console.error('[IncrementalSync] Schema file unchanged - no sync needed');
      return {
        success: true,
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: previousMetadata.totalFields,
        durationMs: Date.now() - startTime,
        cacheCleared: false, // Cache preserved!
      };
    }

    // Load current schema
    clearSchemaCache(); // Ensure fresh load
    const schemas = loadSchema();

    if (schemas.length === 0) {
      throw new Error('No schema data found. Check data/odoo_schema.txt');
    }

    console.error(`[IncrementalSync] Loaded ${schemas.length} current schema rows`);

    // Phase 2: Build checksums and detect changes
    onProgress?.('detecting', 0, 1);
    console.error('[IncrementalSync] Phase 2: Detecting changes...');

    // Build semantic texts and checksums for all current fields
    const schemaWithTexts = schemas.map(schema => ({
      field_id: schema.field_id,
      schema,
      semanticText: buildSemanticText(schema),
    }));

    const currentChecksums = buildChecksumMap(
      schemaWithTexts.map(s => ({ field_id: s.field_id, semanticText: s.semanticText }))
    );

    const changes = detectChanges(previousMetadata, currentChecksums);
    const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length;

    console.error(`[IncrementalSync] ${formatChangesSummary(changes)}`);

    // If no changes, return early (preserve cache)
    if (totalChanges === 0) {
      console.error('[IncrementalSync] No changes detected - updating metadata only');

      // Still save metadata (updates timestamp)
      saveSyncMetadata(createSyncMetadata(schemaFilePath, currentChecksums));
      lastSyncTime = new Date().toISOString();

      return {
        success: true,
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: schemas.length,
        durationMs: Date.now() - startTime,
        cacheCleared: false, // Cache preserved!
      };
    }

    // Phase 3: Process changes
    console.error('[IncrementalSync] Phase 3: Processing changes...');

    // Ensure collection exists
    const collectionInfo = await getCollectionInfo(QDRANT_CONFIG.COLLECTION);
    if (!collectionInfo.exists) {
      console.error('[IncrementalSync] Collection does not exist - creating...');
      await createSchemaCollection();
    }

    let addedCount = 0;
    let modifiedCount = 0;

    // Get schemas that need embedding (added + modified)
    const fieldsToEmbed = changes.added.concat(changes.modified);
    const schemasToEmbed = schemaWithTexts.filter(s => fieldsToEmbed.includes(s.field_id));

    if (schemasToEmbed.length > 0) {
      // Process in batches
      const totalBatches = Math.ceil(schemasToEmbed.length / SYNC_CONFIG.BATCH_SIZE);
      console.error(`[IncrementalSync] Embedding ${schemasToEmbed.length} fields in ${totalBatches} batch(es)...`);

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const batchStart = batchIndex * SYNC_CONFIG.BATCH_SIZE;
        const batchEnd = Math.min(batchStart + SYNC_CONFIG.BATCH_SIZE, schemasToEmbed.length);
        const batch = schemasToEmbed.slice(batchStart, batchEnd);

        onProgress?.('embedding', batchStart, schemasToEmbed.length);
        console.error(`[IncrementalSync] Batch ${batchIndex + 1}/${totalBatches} (${batch.length} fields)`);

        try {
          // Generate embeddings
          const semanticTexts = batch.map(s => s.semanticText);
          const embeddings = await embedBatch(semanticTexts, 'document');

          // Build points for upsert
          const points: SchemaPoint[] = [];
          for (let i = 0; i < batch.length; i++) {
            const { schema, semanticText, field_id } = batch[i];
            const embedding = embeddings[i];

            if (embedding) {
              points.push({
                id: field_id,
                vector: embedding,
                payload: buildSchemaPayload(schema, semanticText),
              });

              // Track added vs modified
              if (changes.added.includes(field_id)) {
                addedCount++;
              } else {
                modifiedCount++;
              }
            } else {
              errors.push(`Failed to embed: ${schema.model_name}.${schema.field_name}`);
            }
          }

          // Upsert to Qdrant
          if (points.length > 0) {
            onProgress?.('uploading', batchStart, schemasToEmbed.length);
            await upsertSchemaPoints(points);
          }
        } catch (batchError) {
          const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
          console.error(`[IncrementalSync] Batch ${batchIndex + 1} error:`, errorMsg);
          errors.push(`Batch ${batchIndex + 1} error: ${errorMsg}`);
        }
      }
    }

    // Delete removed fields
    if (changes.deleted.length > 0) {
      onProgress?.('deleting', 0, changes.deleted.length);
      console.error(`[IncrementalSync] Deleting ${changes.deleted.length} removed fields...`);
      try {
        await deleteSchemaPoints(changes.deleted);
      } catch (deleteError) {
        const errorMsg = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.error('[IncrementalSync] Delete error:', errorMsg);
        errors.push(`Delete error: ${errorMsg}`);
      }
    }

    // Phase 4: Save metadata and clear cache
    onProgress?.('finalizing', 0, 1);
    console.error('[IncrementalSync] Phase 4: Finalizing...');

    // Save metadata (only after successful processing)
    saveSyncMetadata(createSyncMetadata(schemaFilePath, currentChecksums));
    lastSyncTime = new Date().toISOString();

    // Clear cache since we have changes (Improvement #2 integration)
    clearCache();
    console.error('[IncrementalSync] Query cache cleared due to changes');

    const unchangedCount = schemas.length - addedCount - modifiedCount;

    console.error(`[IncrementalSync] Complete: ${addedCount} added, ${modifiedCount} modified, ${changes.deleted.length} deleted, ${unchangedCount} unchanged`);

    return {
      success: errors.length === 0,
      added: addedCount,
      modified: modifiedCount,
      deleted: changes.deleted.length,
      unchanged: unchangedCount,
      durationMs: Date.now() - startTime,
      cacheCleared: true, // Cache was cleared due to changes
      errors: errors.length > 0 ? errors : undefined,
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[IncrementalSync] Failed:', errorMsg);
    return {
      success: false,
      added: 0,
      modified: 0,
      deleted: 0,
      unchanged: 0,
      durationMs: Date.now() - startTime,
      cacheCleared: false,
      errors: [errorMsg],
    };
  } finally {
    isSyncing = false;
  }
}

/**
 * Reset incremental sync metadata
 *
 * Call this to force next incremental sync to behave like full sync.
 */
export function resetSyncMetadata(): void {
  clearSyncMetadata();
  console.error('[SchemaSync] Sync metadata reset - next incremental sync will be full');
}
