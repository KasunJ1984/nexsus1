/**
 * Schema Query Service
 *
 * Queries field definitions from Qdrant schema (point_type='schema')
 * and merges with payload config from Excel.
 *
 * Architecture:
 * - Field definitions (what fields EXIST) -> Qdrant schema (synced once)
 * - Payload config (which fields to INCLUDE) -> Excel (user configurable anytime)
 *
 * This is the "self-describing" approach - the pipeline queries Qdrant
 * for schema instead of reading Excel files at runtime.
 *
 * Key Functions:
 * - getModelFieldsFromSchema() - Query Qdrant + merge Excel payload config
 * - getStoredFieldsFromSchema() - Filter stored fields
 * - getPayloadFieldsFromSchema() - Filter payload fields
 * - getOdooFieldNamesFromSchema() - Get field names for Odoo search_read
 * - getModelIdFromSchema() - Get model_id
 * - modelExistsInSchema() - Check if model exists
 * - updateModelPayload() - Update payload without re-embedding
 */

import { getQdrantClient, isVectorClientAvailable } from './vector-client.js';
import { loadPayloadConfig } from './excel-pipeline-loader.js';
import { UNIFIED_CONFIG } from '../constants.js';
import type { PipelineField, PayloadFieldConfig } from '../types.js';

// =============================================================================
// CACHE (invalidated on server restart or manual clear)
// =============================================================================

/**
 * Cache for schema queries: model_name -> PipelineField[]
 * This avoids repeated Qdrant queries for the same model
 */
const schemaCache = new Map<string, PipelineField[]>();

/**
 * Cache for payload config from Excel
 * Reloaded when clearSchemaCache() is called
 */
let payloadConfigCache: Map<string, PayloadFieldConfig> | null = null;

// =============================================================================
// PAYLOAD CONFIG (from Excel - user configurable)
// =============================================================================

/**
 * Get payload config from Excel
 *
 * Uses cached value if available. This small file is read from Excel
 * because user can modify which fields to include anytime.
 *
 * @returns Map of "model_name.field_name" -> PayloadFieldConfig
 */
function getPayloadConfig(): Map<string, PayloadFieldConfig> {
  if (payloadConfigCache !== null) {
    return payloadConfigCache;
  }

  payloadConfigCache = loadPayloadConfig();
  return payloadConfigCache;
}

// =============================================================================
// SCHEMA QUERIES (from Qdrant)
// =============================================================================

/**
 * Get all fields for a model from Qdrant schema
 *
 * Queries Qdrant for field definitions (point_type='schema')
 * and merges with payload config from Excel.
 *
 * @param modelName - Model name (e.g., "crm.lead", "res.partner")
 * @returns Array of PipelineField with merged payload config
 */
export async function getModelFieldsFromSchema(modelName: string): Promise<PipelineField[]> {
  // Check cache first
  if (schemaCache.has(modelName)) {
    return schemaCache.get(modelName)!;
  }

  // Validate vector client
  if (!isVectorClientAvailable()) {
    console.error('[SchemaQuery] Vector client not available');
    return [];
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Query Qdrant for field definitions
    // Schema points have point_type='schema' and model_name filter
    const result = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'schema' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: 500, // Most models have < 200 fields
      with_payload: true,
      with_vector: false, // Don't need vectors, just payload
    });

    if (result.points.length === 0) {
      console.error(`[SchemaQuery] No schema found for model '${modelName}'`);
      return [];
    }

    console.error(`[SchemaQuery] Found ${result.points.length} fields for '${modelName}'`);

    // Load payload config from Excel (small file, fast)
    const payloadConfig = getPayloadConfig();

    // Merge schema with payload config
    const fields: PipelineField[] = result.points.map(point => {
      const p = point.payload as Record<string, unknown>;
      const fieldName = p.field_name as string;

      // Look up payload config for this field
      const payloadKey = `${modelName}.${fieldName}`;
      const payloadFieldConfig = payloadConfig.get(payloadKey);
      const includeInPayload = payloadFieldConfig?.include_in_payload ?? false;

      // Build PipelineField from Qdrant payload
      const field: PipelineField = {
        field_id: p.field_id as number,
        model_id: p.model_id as number,
        field_name: fieldName,
        field_label: (p.field_label as string) || fieldName,
        field_type: (p.field_type as string) || 'char',
        model_name: p.model_name as string,
        stored: p.stored as boolean,
        include_in_payload: includeInPayload, // From Excel, not Qdrant!
      };

      // Add FK metadata if present
      if (p.fk_location_model) {
        field.fk_location_model = p.fk_location_model as string;
      }
      if (p.fk_location_model_id !== undefined) {
        field.fk_location_model_id = p.fk_location_model_id as number;
      }
      if (p.fk_location_record_id !== undefined) {
        field.fk_location_record_id = p.fk_location_record_id as number;
      }
      if (p.fk_qdrant_id) {
        field.fk_qdrant_id = p.fk_qdrant_id as string;
      }

      return field;
    });

    // Cache result
    schemaCache.set(modelName, fields);

    return fields;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[SchemaQuery] Error querying schema for '${modelName}':`, errorMsg);
    return [];
  }
}

/**
 * Get stored fields (fields that can be fetched from Odoo)
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of stored PipelineField
 */
export async function getStoredFieldsFromSchema(modelName: string): Promise<PipelineField[]> {
  const fields = await getModelFieldsFromSchema(modelName);
  return fields.filter(f => f.stored);
}

/**
 * Get payload fields (fields with include_in_payload=true from Excel)
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of PipelineField with include_in_payload=true
 */
export async function getPayloadFieldsFromSchema(modelName: string): Promise<PipelineField[]> {
  const fields = await getModelFieldsFromSchema(modelName);
  return fields.filter(f => f.include_in_payload);
}

/**
 * Get Odoo field names for search_read
 *
 * Returns only the technical field names that are stored in Odoo.
 * Used when building the Odoo API call.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of field names (e.g., ["id", "name", "partner_id"])
 */
export async function getOdooFieldNamesFromSchema(modelName: string): Promise<string[]> {
  const storedFields = await getStoredFieldsFromSchema(modelName);
  return storedFields.map(f => f.field_name);
}

/**
 * Get model_id from schema
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns model_id or undefined if not found
 */
export async function getModelIdFromSchema(modelName: string): Promise<number | undefined> {
  const fields = await getModelFieldsFromSchema(modelName);
  return fields.length > 0 ? fields[0].model_id : undefined;
}

/**
 * Get model_id from a DATA point in Qdrant
 *
 * Fallback for when model exists in data but not in schema.
 * Queries the first data point for the model and extracts model_id from payload.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns model_id or undefined if not found
 */
export async function getModelIdFromData(modelName: string): Promise<number | undefined> {
  if (!isVectorClientAvailable()) {
    console.error('[SchemaQuery] Vector client not available');
    return undefined;
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Query a single data point for this model
    const result = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: 1,
      with_payload: ['model_id'],
    });

    if (result.points.length === 0) {
      console.error(`[SchemaQuery] No data points found for model '${modelName}'`);
      return undefined;
    }

    const modelId = result.points[0].payload?.model_id as number | undefined;
    if (modelId !== undefined) {
      console.error(`[SchemaQuery] Got model_id ${modelId} from data point for ${modelName}`);
    }
    return modelId;
  } catch (error) {
    console.error(`[SchemaQuery] Failed to get model_id from data for ${modelName}:`, error);
    return undefined;
  }
}

/**
 * Get primary key field_id for a model
 *
 * Finds the field_id of the 'id' field for a model.
 * Used to build the Vector_Id: model_id^primary_key_value
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns field_id of the 'id' field, or undefined if not found
 */
export async function getPrimaryKeyFieldIdFromSchema(modelName: string): Promise<number | undefined> {
  const fields = await getModelFieldsFromSchema(modelName);
  const idField = fields.find(f => f.field_name === 'id');

  if (!idField) {
    console.error(`[SchemaQuery] No 'id' field found for model '${modelName}'`);
    return undefined;
  }

  return idField.field_id;
}

/**
 * Check if model exists in schema
 *
 * @param modelName - Model name to check
 * @returns true if model exists in Qdrant schema
 */
export async function modelExistsInSchema(modelName: string): Promise<boolean> {
  // Check cache first
  if (schemaCache.has(modelName)) {
    return schemaCache.get(modelName)!.length > 0;
  }

  // Validate vector client
  if (!isVectorClientAvailable()) {
    return false;
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    const result = await client.count(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'schema' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      exact: true,
    });

    return result.count > 0;
  } catch {
    return false;
  }
}

/**
 * Get all model names from Qdrant schema
 *
 * Replaces getAllModelNames() from excel-pipeline-loader.ts.
 * Queries Qdrant schema to get unique model names.
 *
 * @returns Sorted array of model names
 */
export async function getAllModelNamesFromSchema(): Promise<string[]> {
  // Validate vector client
  if (!isVectorClientAvailable()) {
    console.error('[SchemaQuery] Vector client not available');
    return [];
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Get all schema points (only need model_name field)
    // Use scroll to get all points (could be 17,000+)
    const modelNames = new Set<string>();
    let nextOffset: string | number | Record<string, unknown> | null | undefined = undefined;

    do {
      const result = await client.scroll(collectionName, {
        filter: {
          must: [{ key: 'point_type', match: { value: 'schema' } }],
        },
        limit: 1000, // Fetch in batches
        offset: nextOffset as string | number | undefined,
        with_payload: { include: ['model_name'] },
        with_vector: false,
      });

      for (const point of result.points) {
        const payload = point.payload as Record<string, unknown>;
        if (payload.model_name && typeof payload.model_name === 'string') {
          modelNames.add(payload.model_name);
        }
      }

      nextOffset = result.next_page_offset;
    } while (nextOffset);

    const sortedNames = Array.from(modelNames).sort();
    console.error(`[SchemaQuery] Found ${sortedNames.length} unique models in schema`);
    return sortedNames;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[SchemaQuery] Failed to get model names: ${errorMsg}`);
    return [];
  }
}

/**
 * Find a field by name within a model
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @param fieldName - Field name (e.g., "partner_id")
 * @returns PipelineField or undefined
 */
export async function findFieldFromSchema(
  modelName: string,
  fieldName: string
): Promise<PipelineField | undefined> {
  const fields = await getModelFieldsFromSchema(modelName);
  return fields.find(f => f.field_name === fieldName);
}

/**
 * Get FK metadata for a field
 *
 * Returns the FK location information if the field is a foreign key.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @param fieldName - Field name (e.g., "partner_id")
 * @returns FK metadata object or null
 */
export async function getFkMetadataFromSchema(
  modelName: string,
  fieldName: string
): Promise<{
  target_model: string;
  target_model_id: number;
  target_field_id: number;
  fk_qdrant_id: string;
} | null> {
  const field = await findFieldFromSchema(modelName, fieldName);

  if (!field || !field.fk_location_model) {
    return null;
  }

  return {
    target_model: field.fk_location_model,
    target_model_id: field.fk_location_model_id || 0,
    target_field_id: field.fk_location_record_id || 0,
    fk_qdrant_id: field.fk_qdrant_id || '',
  };
}

/**
 * Get list of FK fields for a model
 *
 * Returns fields that have FK metadata (many2one, one2many relationships).
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of PipelineField with FK metadata
 */
export async function getFkFieldsFromSchema(modelName: string): Promise<PipelineField[]> {
  const fields = await getModelFieldsFromSchema(modelName);
  return fields.filter(f => f.fk_location_model);
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

/**
 * Clear schema cache
 *
 * Call this to force reload from Qdrant and Excel.
 * Use when:
 * - Payload config Excel file is modified
 * - Schema is re-synced to Qdrant
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
  payloadConfigCache = null;
  console.error('[SchemaQuery] Cache cleared');
}

/**
 * Get cache statistics
 *
 * @returns Cache statistics object
 */
export function getSchemaCacheStats(): {
  cachedModels: number;
  modelNames: string[];
  payloadConfigLoaded: boolean;
} {
  return {
    cachedModels: schemaCache.size,
    modelNames: Array.from(schemaCache.keys()),
    payloadConfigLoaded: payloadConfigCache !== null,
  };
}

/**
 * Get schema statistics from Qdrant
 *
 * Queries Qdrant to get total counts of:
 * - Total models (unique model_name values)
 * - Total fields
 * - Payload fields (from Excel config)
 *
 * @returns Schema statistics object
 */
export async function getSchemaStats(): Promise<{
  totalModels: number;
  totalFields: number;
  payloadFields: number;
}> {
  // Validate vector client
  if (!isVectorClientAvailable()) {
    return { totalModels: 0, totalFields: 0, payloadFields: 0 };
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // Count total schema points
    const result = await client.count(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'schema' } }],
      },
      exact: true,
    });

    const totalFields = result.count;

    // Get unique model names by scrolling (limited sample for performance)
    const scrollResult = await client.scroll(collectionName, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'schema' } }],
      },
      limit: 10000, // Should be enough to get all unique models
      with_payload: ['model_name'],
      with_vector: false,
    });

    const modelNames = new Set<string>();
    for (const point of scrollResult.points) {
      const modelName = (point.payload as Record<string, unknown>).model_name as string;
      if (modelName) {
        modelNames.add(modelName);
      }
    }

    // Count payload fields from Excel config
    const payloadConfig = getPayloadConfig();
    let payloadFields = 0;
    for (const config of payloadConfig.values()) {
      if (config.include_in_payload) {
        payloadFields++;
      }
    }

    return {
      totalModels: modelNames.size,
      totalFields,
      payloadFields,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[SchemaQuery] Error getting schema stats:`, errorMsg);
    return { totalModels: 0, totalFields: 0, payloadFields: 0 };
  }
}

/**
 * Check if Qdrant schema collection is empty
 *
 * Use this for pre-flight checks before data sync operations.
 * An empty schema means `npm run sync -- sync schema` hasn't been run.
 *
 * @returns true if no schema points exist
 */
export async function isQdrantSchemaEmpty(): Promise<boolean> {
  const stats = await getSchemaStats();
  return stats.totalFields === 0;
}

// =============================================================================
// PAYLOAD UPDATE (without re-embedding)
// =============================================================================

/**
 * Update payload fields for all records of a model WITHOUT re-embedding
 *
 * Use this after changing feilds_to_add_payload.xlsx to update existing
 * records with new payload field configuration.
 *
 * What this does:
 * - Reads new payload config from Excel
 * - Fetches ONLY the payload fields from Odoo (not all fields)
 * - Updates payload in Qdrant using setPayload API
 *
 * What this does NOT do:
 * - Does NOT re-sync data (no new records)
 * - Does NOT re-generate embeddings (keeps existing vectors)
 * - Does NOT call Voyage AI (no embedding API calls)
 *
 * Performance: ~30 seconds for 1000 records (vs ~5 minutes for full re-sync)
 * Cost: $0 (no embedding API calls)
 *
 * @param modelName - Model name to update (e.g., "res.partner")
 * @param odooClient - Initialized Odoo client
 * @param onProgress - Optional progress callback
 * @returns Result with updated/failed counts and duration
 */
export async function updateModelPayload(
  modelName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  odooClient: any,
  onProgress?: (phase: string, current: number, total: number) => void
): Promise<{
  success: boolean;
  updated: number;
  failed: number;
  skipped: number;
  durationMs: number;
  errors: string[];
  restrictedFields: string[];
}> {
  const startTime = Date.now();
  const errors: string[] = [];
  let updated = 0;
  let failed = 0;
  let skipped = 0;

  // Validate vector client
  if (!isVectorClientAvailable()) {
    return {
      success: false,
      updated: 0,
      failed: 0,
      skipped: 0,
      durationMs: Date.now() - startTime,
      errors: ['Vector client not available'],
      restrictedFields: [],
    };
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  try {
    // 1. Clear cache to get fresh payload config
    clearSchemaCache();

    // 2. Get new payload field config from Excel
    const payloadFields = await getPayloadFieldsFromSchema(modelName);

    if (payloadFields.length === 0) {
      return {
        success: false,
        updated: 0,
        failed: 0,
        skipped: 0,
        durationMs: Date.now() - startTime,
        errors: [`No payload fields configured for model '${modelName}'`],
        restrictedFields: [],
      };
    }

    console.error(`[SchemaQuery] Updating payload for '${modelName}' (${payloadFields.length} fields)`);

    // 3. Get all existing data points for this model
    let offset: string | number | undefined;
    let totalPoints = 0;
    const pointsToUpdate: Array<{
      pointId: string;
      recordId: number;
    }> = [];

    // First pass: collect all point IDs and record IDs
    onProgress?.('scanning', 0, 100);
    do {
      const result = await client.scroll(collectionName, {
        filter: {
          must: [
            { key: 'point_type', match: { value: 'data' } },
            { key: 'model_name', match: { value: modelName } },
          ],
        },
        limit: 100,
        offset: offset,
        with_payload: ['record_id'], // Only need record_id
        with_vector: false,
      });

      if (result.points.length === 0) break;

      for (const point of result.points) {
        const recordId = (point.payload as Record<string, unknown>).record_id as number;
        pointsToUpdate.push({
          pointId: point.id as string,
          recordId,
        });
      }

      totalPoints += result.points.length;
      // Handle next_page_offset - only assign if it's a string or number
      const nextOffset = result.next_page_offset;
      offset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
        ? nextOffset
        : undefined;
    } while (offset);

    if (pointsToUpdate.length === 0) {
      return {
        success: true,
        updated: 0,
        failed: 0,
        skipped: 0,
        durationMs: Date.now() - startTime,
        errors: [`No data points found for model '${modelName}'`],
        restrictedFields: [],
      };
    }

    console.error(`[SchemaQuery] Found ${pointsToUpdate.length} points to update`);

    // 4. Process in batches
    const batchSize = 100;
    const totalBatches = Math.ceil(pointsToUpdate.length / batchSize);
    let payloadFieldNames = payloadFields.map(f => f.field_name);

    // Track restricted fields across all batches (for graceful error handling)
    const restrictedPayloadFields = new Set<string>();

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, pointsToUpdate.length);
      const batch = pointsToUpdate.slice(batchStart, batchEnd);

      onProgress?.('updating', batchStart, pointsToUpdate.length);

      try {
        // Get record IDs for this batch
        const recordIds = batch.map(p => p.recordId);

        // Fetch fresh data from Odoo for payload fields only (with graceful error handling)
        const fetchResult = await odooClient.searchReadWithRetry(
          modelName,
          [['id', 'in', recordIds]],
          payloadFieldNames,
          {},
          { maxRetries: 5 }
        );
        const freshRecords = fetchResult.records as Record<string, unknown>[];

        // Track restricted fields and update for subsequent batches
        if (fetchResult.restrictedFields.length > 0) {
          for (const field of fetchResult.restrictedFields) {
            if (!restrictedPayloadFields.has(field)) {
              restrictedPayloadFields.add(field);
              const reason = (fetchResult.warnings as string[]).find((w: string) => w.includes(field)) || 'unknown error';
              console.error(`[SchemaQuery] Field '${field}' excluded from payload: ${reason}`);
            }
          }
          // Remove restricted fields for subsequent batches (avoid re-testing)
          payloadFieldNames = payloadFieldNames.filter(f => !restrictedPayloadFields.has(f));
        }

        // Build map of record_id -> fresh data
        const recordMap = new Map(
          freshRecords.map((r: Record<string, unknown>) => [r.id as number, r])
        );

        // Update payloads in Qdrant
        for (const point of batch) {
          const freshData = recordMap.get(point.recordId) as Record<string, unknown> | undefined;

          if (freshData) {
            // Build new payload from fresh Odoo data
            const newPayload: Record<string, unknown> = {
              payload_updated: new Date().toISOString(),
            };

            // Add all payload fields from fresh data
            for (const fieldName of payloadFieldNames) {
              const value = freshData[fieldName] as unknown;
              // Skip null/undefined/empty values
              if (value !== null && value !== undefined && value !== '') {
                // Handle many2one fields (Odoo returns [id, name] tuple)
                if (Array.isArray(value) && value.length === 2) {
                  // Store as "id|name" format for easy parsing
                  newPayload[fieldName] = value;
                  newPayload[`${fieldName}_id`] = value[0];
                  newPayload[`${fieldName}_name`] = value[1];
                } else {
                  newPayload[fieldName] = value;
                }
              }
            }

            // Update payload in Qdrant (keeps existing vector!)
            await client.setPayload(collectionName, {
              points: [point.pointId],
              payload: newPayload,
            });
            updated++;
          } else {
            // Record not found in Odoo (might be deleted)
            skipped++;
          }
        }

        // Log progress every 5 batches
        if ((batchIndex + 1) % 5 === 0 || batchIndex === totalBatches - 1) {
          const progress = ((batchEnd / pointsToUpdate.length) * 100).toFixed(1);
          console.error(`[SchemaQuery] Progress: ${progress}% (${updated} updated, ${skipped} skipped)`);
        }
      } catch (batchError) {
        const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
        console.error(`[SchemaQuery] Batch ${batchIndex + 1} error:`, errorMsg);
        errors.push(`Batch ${batchIndex + 1} error: ${errorMsg}`);
        failed += batch.length;
      }
    }

    onProgress?.('complete', pointsToUpdate.length, pointsToUpdate.length);

    // Log summary including restricted fields
    console.error(`[SchemaQuery] Payload update complete: ${updated} updated, ${skipped} skipped, ${failed} failed`);
    if (restrictedPayloadFields.size > 0) {
      console.error(`[SchemaQuery] Restricted fields (${restrictedPayloadFields.size}): ${Array.from(restrictedPayloadFields).join(', ')}`);
    }

    return {
      success: errors.length === 0,
      updated,
      failed,
      skipped,
      durationMs: Date.now() - startTime,
      errors: errors.length > 0 ? errors : [],
      restrictedFields: Array.from(restrictedPayloadFields),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[SchemaQuery] Payload update failed:', errorMsg);
    return {
      success: false,
      updated,
      failed,
      skipped,
      durationMs: Date.now() - startTime,
      errors: [errorMsg],
      restrictedFields: [],
    };
  }
}
