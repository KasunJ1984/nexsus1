/**
 * Unified Schema Sync Service
 *
 * Syncs schema from Excel to nexsus_unified collection.
 * Uses V2 UUID format and adds point_type discriminator.
 *
 * Features:
 * - V2 UUID format via buildSchemaUuidV2(field_id)
 * - point_type: 'schema' for all schema payloads
 * - FK references use V2 format
 *
 * Run with: npx tsx scripts/test-stage3-schema-sync.ts
 */

import chalk from 'chalk';
import { UNIFIED_CONFIG, SYNC_CONFIG } from '../constants.js';
import {
  loadNexsusSchema,
  clearNexsusSchemaCache,
} from './excel-schema-loader.js';
import { embedBatch, isEmbeddingServiceAvailable } from './embedding-service.js';
import { getQdrantClient, isVectorClientAvailable, collectionExists } from './vector-client.js';
import { buildSchemaUuidV2, buildSchemaFkRefUuidV2 } from '../utils/uuid-v2.js';
import { getOdooClient } from './odoo-client.js';
import { clearSchemaCache } from './schema-query-service.js';
import type { NexsusSchemaRow, NexsusSyncResult } from '../types.js';

// Sync state
let isSyncing = false;
let lastSyncTime: string | null = null;

// ============================================================================
// PAYLOAD BUILDER
// ============================================================================

/**
 * Build V2 payload for unified schema point
 *
 * Key differences from legacy buildNexsusPayload:
 * - Adds point_type: 'schema' (CRITICAL discriminator)
 * - Converts fk_qdrant_id to V2 format
 *
 * @param schema - Schema row from Excel
 * @returns Payload object for Qdrant
 */
function buildUnifiedSchemaPayload(schema: NexsusSchemaRow, pointId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    // ========================================
    // DISCRIMINATOR - CRITICAL FOR UNIFIED
    // ========================================
    point_id: pointId,    // V2 UUID for querying/filtering
    point_type: 'schema',

    // ========================================
    // CORE FIELDS
    // ========================================
    field_id: schema.field_id,
    model_id: schema.model_id,
    field_name: schema.field_name,
    field_label: schema.field_label,
    field_type: schema.field_type,
    model_name: schema.model_name,
    stored: schema.stored,

    // Embedding source
    semantic_text: schema.semantic_text,
    raw_payload: schema.raw_payload,

    // Sync metadata
    sync_timestamp: new Date().toISOString(),
  };

  // ========================================
  // FK FIELDS (OPTIONAL) - V2 FORMAT
  // ========================================
  if (schema.fk_location_model) {
    payload.fk_location_model = schema.fk_location_model;
    // Format: "model.name.id" for references_in mode
    payload.primary_data_location = schema.fk_location_model + '.id';
  }

  if (schema.fk_location_model_id !== undefined) {
    payload.fk_location_model_id = schema.fk_location_model_id;
  }

  if (schema.fk_location_record_id !== undefined) {
    payload.fk_location_record_id = schema.fk_location_record_id;

    // Convert FK Qdrant ID to V2 format
    // Old format: 00000184-0000-0000-0000-000000002675 (V1)
    // New format: 00000003-0184-0000-0000-000000002675 (V2)
    if (schema.fk_location_model_id !== undefined && schema.fk_location_record_id !== undefined) {
      payload.fk_qdrant_id = buildSchemaFkRefUuidV2(
        schema.fk_location_model_id,
        schema.fk_location_record_id
      );
    }
  }

  return payload;
}

// ============================================================================
// SYNC FUNCTIONS
// ============================================================================

/**
 * Sync Options
 */
export interface SyncSchemaToUnifiedOptions {
  /** Clear existing schema points before syncing */
  forceRecreate?: boolean;
  /** Progress callback */
  onProgress?: (phase: string, current: number, total: number) => void;
}

/**
 * Sync schema to unified collection using V2 UUIDs
 *
 * This function:
 * 1. Validates prerequisites (Qdrant, Voyage AI)
 * 2. Optionally clears existing schema points
 * 3. Loads schema from nexsus_schema_v2_generated.xlsx
 * 4. Generates V2 UUIDs for each field
 * 5. Batches embeddings and uploads with point_type='schema'
 *
 * @param options - Sync options
 * @returns Sync result with statistics
 *
 * @example
 * // Basic sync
 * const result = await syncSchemaToUnified();
 *
 * @example
 * // Force recreate (clears existing schema points first)
 * const result = await syncSchemaToUnified({
 *   forceRecreate: true,
 * });
 */
export async function syncSchemaToUnified(
  options?: SyncSchemaToUnifiedOptions
): Promise<NexsusSyncResult> {
  const startTime = Date.now();
  const { forceRecreate = false, onProgress } = options || {};

  // ========================================
  // PREREQUISITES CHECK
  // ========================================
  if (!isVectorClientAvailable()) {
    return {
      success: false,
      uploaded: 0,
      failed: 0,
      durationMs: Date.now() - startTime,
      errors: ['Vector client not available. Check QDRANT_HOST and QDRANT_API_KEY.'],
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
      errors: ['Unified schema sync already in progress. Please wait for it to complete.'],
    };
  }

  // Check unified collection exists (created in Stage 2)
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const exists = await collectionExists(collectionName);
  if (!exists) {
    return {
      success: false,
      uploaded: 0,
      failed: 0,
      durationMs: Date.now() - startTime,
      errors: [`Unified collection '${collectionName}' does not exist. Run Stage 2 first.`],
    };
  }

  isSyncing = true;
  const errors: string[] = [];
  let uploaded = 0;
  let failed = 0;

  try {
    const client = getQdrantClient();

    // ========================================
    // PHASE 1: OPTIONAL CLEANUP
    // ========================================
    if (forceRecreate) {
      onProgress?.('clearing', 0, 1);
      console.error('[UnifiedSchemaSync] Clearing existing schema points...');

      try {
        await client.delete(collectionName, {
          wait: true,
          filter: {
            must: [{ key: 'point_type', match: { value: 'schema' } }],
          },
        });
        console.error('[UnifiedSchemaSync] Cleared existing schema points');
      } catch (deleteError) {
        // Collection might be empty, that's okay
        console.error('[UnifiedSchemaSync] No existing schema points to clear');
      }
    }

    // ========================================
    // PHASE 2: LOAD EXCEL SCHEMA
    // ========================================
    onProgress?.('loading', 0, 1);
    console.error(`[UnifiedSchemaSync] Loading Excel schema...`);

    clearNexsusSchemaCache();

    // Load from nexsus_schema_v2_generated.xlsx (default in NEXSUS_CONFIG)
    const schemas = loadNexsusSchema();

    if (schemas.length === 0) {
      throw new Error('No schema data found in Excel file');
    }

    console.error(`[UnifiedSchemaSync] Loaded ${schemas.length} schema rows from Excel`);

    // ========================================
    // PHASE 2.5: FIELD_ID COLLISION DETECTION (G3)
    // ========================================
    // Critical: If field_ids collide, Schema UUIDs will overwrite each other
    console.error('[UnifiedSchemaSync] Checking for field_id collisions...');

    const fieldIdMap = new Map<number, NexsusSchemaRow[]>();
    for (const schema of schemas) {
      if (!fieldIdMap.has(schema.field_id)) {
        fieldIdMap.set(schema.field_id, []);
      }
      fieldIdMap.get(schema.field_id)!.push(schema);
    }

    // Log warnings for collisions
    let collisionCount = 0;
    for (const [fieldId, rows] of fieldIdMap) {
      if (rows.length > 1) {
        collisionCount++;
        console.error(chalk.red(`[UnifiedSchemaSync] COLLISION: field_id ${fieldId} appears ${rows.length} times:`));
        for (const row of rows) {
          console.error(chalk.yellow(`  - ${row.model_name}.${row.field_name} (model_id=${row.model_id})`));
        }
      }
    }

    if (collisionCount > 0) {
      console.error(chalk.red(`[UnifiedSchemaSync] WARNING: ${collisionCount} field_id collisions detected!`));
      console.error(chalk.yellow(`[UnifiedSchemaSync] Fix: Check Excel schema for duplicate field_id values`));
    } else {
      console.error(chalk.green(`[UnifiedSchemaSync] ✓ No field_id collisions (${schemas.length} unique fields)`));
    }

    // ========================================
    // PHASE 2.6: OPTIONAL ODOO MODEL_ID VALIDATION (G2)
    // ========================================
    // Validate Excel model_ids match Odoo's ir.model (enabled via VALIDATE_ODOO_MODELS=true)
    if (process.env.VALIDATE_ODOO_MODELS === 'true') {
      console.error('[UnifiedSchemaSync] Validating model_ids against Odoo...');

      try {
        const odooClient = getOdooClient();
        const odooModels = await odooClient.searchRead<{ id: number; model: string }>(
          'ir.model',
          [],
          ['id', 'model'],
          { limit: 1000 }
        );

        const odooModelMap = new Map<string, number>();
        for (const m of odooModels) {
          odooModelMap.set(m.model, m.id);
        }

        // Check Excel models against Odoo
        const uniqueModels = new Map<string, number>();
        for (const schema of schemas) {
          uniqueModels.set(schema.model_name, schema.model_id);
        }

        let discrepancies = 0;
        for (const [modelName, excelModelId] of uniqueModels) {
          const odooModelId = odooModelMap.get(modelName);
          if (odooModelId !== undefined && odooModelId !== excelModelId) {
            discrepancies++;
            console.error(chalk.yellow(`[UnifiedSchemaSync] DISCREPANCY: ${modelName}`));
            console.error(`  Excel model_id: ${excelModelId}`);
            console.error(`  Odoo model_id:  ${odooModelId}`);
          }
        }

        if (discrepancies > 0) {
          console.error(chalk.yellow(`[UnifiedSchemaSync] ${discrepancies} model_id discrepancies found`));
        } else {
          console.error(chalk.green(`[UnifiedSchemaSync] ✓ All model_ids match Odoo (${uniqueModels.size} models)`));
        }
      } catch (odooError) {
        console.error('[UnifiedSchemaSync] Could not validate against Odoo:', odooError);
      }
    }

    // ========================================
    // PHASE 3: EMBED AND UPLOAD IN BATCHES
    // ========================================
    const batchSize = SYNC_CONFIG.BATCH_SIZE;
    const totalBatches = Math.ceil(schemas.length / batchSize);
    console.error(`[UnifiedSchemaSync] Processing ${totalBatches} batches (batch size: ${batchSize})...`);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, schemas.length);
      const batch = schemas.slice(batchStart, batchEnd);

      onProgress?.('embedding', batchStart, schemas.length);

      try {
        // Use pre-built semantic text from Excel Column B for embeddings
        const semanticTexts = batch.map(s => s.semantic_text);

        // Generate embeddings via Voyage AI
        const embeddings = await embedBatch(semanticTexts, 'document');

        // Log embedding dimensions for first batch
        if (batchIndex === 0 && embeddings.length > 0) {
          console.error(`[UnifiedSchemaSync] Embedding dimensions: ${embeddings[0].length}`);
        }

        // Build points with V2 UUIDs
        const points: Array<{
          id: string;
          vector: number[];
          payload: Record<string, unknown>;
        }> = [];

        for (let i = 0; i < batch.length; i++) {
          const schema = batch[i];
          const embedding = embeddings[i];

          if (embedding && embedding.length > 0) {
            // ========================================
            // V2 UUID GENERATION - KEY CHANGE
            // ========================================
            // Use field_id directly (no hash)
            // Format: 00000003-0004-0000-0000-FFFFFFFFFFFF
            const pointId = buildSchemaUuidV2(schema.field_id);

            points.push({
              id: pointId,
              vector: embedding,
              payload: buildUnifiedSchemaPayload(schema, pointId),
            });
          } else {
            failed++;
            errors.push(`Failed to embed: ${schema.model_name}.${schema.field_name} (field_id: ${schema.field_id})`);
          }
        }

        // Upsert to unified collection
        if (points.length > 0) {
          onProgress?.('uploading', batchStart, schemas.length);
          await client.upsert(collectionName, {
            wait: true,
            points,
          });
          uploaded += points.length;
        }

        // Log progress every 5 batches
        if ((batchIndex + 1) % 5 === 0 || batchIndex === totalBatches - 1) {
          const progress = ((batchEnd / schemas.length) * 100).toFixed(1);
          console.error(`[UnifiedSchemaSync] Progress: ${progress}% (${uploaded} uploaded, ${failed} failed)`);
        }
      } catch (batchError) {
        const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
        console.error(`[UnifiedSchemaSync] Batch ${batchIndex + 1} error:`, errorMsg);
        errors.push(`Batch ${batchIndex + 1} error: ${errorMsg}`);
        failed += batch.length;
      }
    }

    lastSyncTime = new Date().toISOString();
    console.error(`[UnifiedSchemaSync] Sync complete: ${uploaded} uploaded, ${failed} failed`);

    // G13: Clear schema query cache so pipeline uses fresh data
    clearSchemaCache();
    console.error('[UnifiedSchemaSync] Schema cache cleared');

    return {
      success: errors.length === 0,
      uploaded,
      failed,
      durationMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[UnifiedSchemaSync] Sync failed:', errorMsg);
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

// ============================================================================
// STATUS FUNCTIONS
// ============================================================================

/**
 * Get unified schema sync status
 *
 * Returns count of schema points in unified collection
 * by filtering on point_type='schema'
 *
 * @returns Status object with collection name, schema count, and last sync time
 */
export async function getUnifiedSchemaSyncStatus(): Promise<{
  collection: string;
  schemaCount: number;
  lastSync: string | null;
}> {
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const client = getQdrantClient();

    // Count points where point_type='schema'
    const result = await client.count(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'schema' } }],
      },
      exact: true,
    });

    return {
      collection: collectionName,
      schemaCount: result.count,
      lastSync: lastSyncTime,
    };
  } catch {
    return {
      collection: collectionName,
      schemaCount: 0,
      lastSync: lastSyncTime,
    };
  }
}

/**
 * Check if unified schema sync is running
 *
 * @returns true if sync is in progress
 */
export function isUnifiedSchemaSyncRunning(): boolean {
  return isSyncing;
}

/**
 * Clear schema points from unified collection
 *
 * Removes only schema points (point_type='schema'),
 * preserving data and graph points.
 *
 * @returns Number of points deleted
 */
export async function clearUnifiedSchemaPoints(): Promise<number> {
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const client = getQdrantClient();

  // Get count before deletion
  const beforeResult = await client.count(collectionName, {
    filter: {
      must: [{ key: 'point_type', match: { value: 'schema' } }],
    },
    exact: true,
  });

  // Delete schema points
  await client.delete(collectionName, {
    wait: true,
    filter: {
      must: [{ key: 'point_type', match: { value: 'schema' } }],
    },
  });

  console.error(`[UnifiedSchemaSync] Cleared ${beforeResult.count} schema points`);
  return beforeResult.count;
}
