/**
 * Excel Data Sync Service
 *
 * Syncs data from Excel files to Qdrant vector database.
 * Adapted from Nexsus cascade-sync.ts but uses Excel files instead of Odoo.
 *
 * Data File Convention:
 * - Files: samples/SAMPLE_{model_name}_data.xlsx
 * - Each file contains records for one model
 * - Columns must match schema field names
 *
 * Process Flow:
 * 1. Load schema to get model_id and field definitions
 * 2. Read Excel data file
 * 3. Transform records (generate semantic text)
 * 4. Generate embeddings
 * 5. Upload to Qdrant with V2 UUIDs
 * 6. Optionally cascade to FK targets
 */

import * as path from 'path';
import * as fs from 'fs';
import XLSX from 'xlsx';
import chalk from 'chalk';
import { embedBatch } from './embedding-service.js';
import {
  upsertToUnifiedCollection,
  isVectorClientAvailable,
} from './vector-client.js';
import {
  getModelIdFromSchema,
  getModelFieldsFromSchema,
  modelExistsInSchema,
  getFkFieldsFromSchema,
} from './schema-query-service.js';
import { buildDataUuidV2 } from '../utils/uuid-v2.js';
import { extractFkValueBySchema } from '../utils/fk-value-extractor.js';
import { upsertRelationship } from './knowledge-graph.js';
import { ensureModelIndexes } from './index-service.js';
import type { PipelineDataPoint, PipelineField, RelationshipType } from '../types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default data directory */
const DATA_DIR = process.env.DATA_DIR || 'samples';

/** Batch size for embedding */
const EMBEDDING_BATCH_SIZE = 50;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for Excel data sync
 */
export interface ExcelDataSyncOptions {
  /** Custom file path (overrides default naming convention) */
  filePath?: string;
  /** Skip FK cascade (default: false) */
  skipCascade?: boolean;
  /** Dry run - show plan without executing */
  dryRun?: boolean;
  /** Force re-sync even if records exist */
  force?: boolean;
}

/**
 * Result of Excel data sync
 */
export interface ExcelDataSyncResult {
  success: boolean;
  model_name: string;
  model_id: number;
  file_path: string;
  records_read: number;
  records_synced: number;
  records_failed: number;
  duration_ms: number;
  errors: string[];
  cascaded_models?: Array<{
    model_name: string;
    records_synced: number;
  }>;
}

/**
 * Transformed record ready for embedding
 */
interface TransformedRecord {
  record_id: number;
  model_name: string;
  model_id: number;
  vector_text: string;
  payload: Record<string, unknown>;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get default file path for a model's data file
 */
function getDefaultDataFilePath(modelName: string): string {
  return path.join(DATA_DIR, `SAMPLE_${modelName}_data.xlsx`);
}

/**
 * Read Excel data file
 */
function readExcelData(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Data file not found: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet);

  return data as Array<Record<string, unknown>>;
}

/**
 * Generate semantic text for a data record
 *
 * Creates human-readable text for vector embedding.
 * Format: "In {model}, record {id}: {field}={value}, {field}={value}, ..."
 */
function generateSemanticText(
  record: Record<string, unknown>,
  modelName: string,
  schemaFields: Array<{ field_name: string; field_label: string; field_type: string }>
): string {
  const parts: string[] = [];

  // Add model context
  parts.push(`In model ${modelName}`);

  // Add record ID
  const recordId = record['id'] as number;
  parts.push(`record ${recordId}`);

  // Add field values (skip id, skip null/undefined)
  for (const field of schemaFields) {
    if (field.field_name === 'id') continue;

    const value = record[field.field_name];
    if (value === null || value === undefined || value === '') continue;

    // Format based on field type
    let displayValue: string;
    if (field.field_type === 'many2one') {
      // Use schema-driven FK extraction (supports scalar, tuple, and expanded formats)
      const fkResult = extractFkValueBySchema(record, {
        field_id: (field as { field_id?: number }).field_id || 0,
        field_name: field.field_name,
        field_type: field.field_type,
      });

      if (fkResult.fkId !== undefined) {
        if (fkResult.displayName) {
          displayValue = `${fkResult.displayName} (id: ${fkResult.fkId})`;
        } else {
          // For scalar format (Excel), value might be just the ID
          displayValue = `id: ${fkResult.fkId}`;
        }
      } else {
        displayValue = String(value);
      }
    } else {
      displayValue = String(value);
    }

    parts.push(`${field.field_label || field.field_name} - ${displayValue}`);
  }

  return parts.join(', ');
}

/**
 * Transform Excel records to Qdrant format
 */
async function transformRecords(
  records: Array<Record<string, unknown>>,
  modelName: string,
  modelId: number
): Promise<TransformedRecord[]> {
  // Get schema fields for this model
  const schemaFields = await getModelFieldsFromSchema(modelName);

  if (!schemaFields || schemaFields.length === 0) {
    throw new Error(`No schema fields found for model: ${modelName}`);
  }

  const transformed: TransformedRecord[] = [];

  for (const record of records) {
    const recordId = record['id'] as number;
    if (!recordId) {
      console.error(`[ExcelDataSync] Skipping record without id`);
      continue;
    }

    // Generate semantic text for embedding
    const vectorText = generateSemanticText(record, modelName, schemaFields);

    // Build payload (include all record fields)
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && value !== undefined) {
        payload[key] = value;
      }
    }

    // Add FK Qdrant UUIDs for many2one fields (using schema-driven extraction)
    for (const field of schemaFields) {
      if (field.field_type === 'many2one' && field.fk_location_model_id) {
        // Use schema-driven FK extraction (supports scalar, tuple, and expanded formats)
        const fkResult = extractFkValueBySchema(record, {
          field_id: field.field_id || 0,
          field_name: field.field_name,
          field_type: field.field_type,
        });

        if (fkResult.fkId !== undefined) {
          // Build FK Qdrant UUID for graph traversal
          const fkQdrantId = buildDataUuidV2(field.fk_location_model_id, fkResult.fkId);
          payload[`${field.field_name}_qdrant`] = fkQdrantId;

          // Normalize: always store FK ID in _id field for consistent querying
          if (fkResult.source === 'scalar') {
            payload[`${field.field_name}_id`] = fkResult.fkId;
          }
        }
      }
    }

    transformed.push({
      record_id: recordId,
      model_name: modelName,
      model_id: modelId,
      vector_text: vectorText,
      payload,
    });
  }

  return transformed;
}

/**
 * Extract FK targets from records
 *
 * Returns a map of target_model -> Set of record IDs to sync
 */
async function extractFkTargets(
  records: Array<Record<string, unknown>>,
  modelName: string
): Promise<Map<string, Set<number>>> {
  const fkTargets = new Map<string, Set<number>>();

  // Get FK fields for this model from schema
  const fkFields = await getFkFieldsFromSchema(modelName);

  if (!fkFields || fkFields.length === 0) {
    return fkTargets;
  }

  for (const fkField of fkFields) {
    const targetModel = fkField.fk_location_model;
    if (!targetModel) continue;

    // Collect FK IDs from all records
    const targetIds = new Set<number>();

    for (const record of records) {
      // Use schema-driven FK extraction (supports scalar, tuple, and expanded formats)
      const fkResult = extractFkValueBySchema(record, {
        field_id: fkField.field_id || 0,
        field_name: fkField.field_name,
        field_type: fkField.field_type,
      });

      if (fkResult.fkId !== undefined) {
        targetIds.add(fkResult.fkId);
      }
    }

    if (targetIds.size > 0) {
      const existing = fkTargets.get(targetModel) || new Set();
      for (const id of targetIds) {
        existing.add(id);
      }
      fkTargets.set(targetModel, existing);
    }
  }

  return fkTargets;
}

/**
 * Update Knowledge Graph with FK relationships
 *
 * Creates graph edges (point_type='graph') for FK relationships.
 */
async function updateKnowledgeGraph(
  modelName: string,
  modelId: number,
  records: Array<Record<string, unknown>>,
  schemaFields: PipelineField[]
): Promise<{ edges_created: number }> {
  let edgesCreated = 0;

  // Find FK fields (many2one with target model)
  const fkFields = schemaFields.filter(f =>
    f.field_type === 'many2one' && f.fk_location_model && f.fk_location_model_id
  );

  for (const fkField of fkFields) {
    // Collect unique FK IDs from all records (using schema-driven extraction)
    const fkIds = new Set<number>();
    for (const record of records) {
      const fkResult = extractFkValueBySchema(record, {
        field_id: fkField.field_id || 0,
        field_name: fkField.field_name,
        field_type: fkField.field_type,
      });
      if (fkResult.fkId !== undefined) {
        fkIds.add(fkResult.fkId);
      }
    }

    if (fkIds.size > 0) {
      try {
        await upsertRelationship({
          source_model: modelName,
          source_model_id: modelId,
          field_id: fkField.field_id,
          field_name: fkField.field_name,
          field_label: fkField.field_label,
          field_type: fkField.field_type as RelationshipType,
          target_model: fkField.fk_location_model!,
          target_model_id: fkField.fk_location_model_id!,
          edge_count: records.length,
          unique_targets: fkIds.size,
          cascade_source: modelName,
        });
        edgesCreated++;
        console.error(chalk.gray(`[ExcelDataSync] Graph edge: ${modelName}.${fkField.field_name} → ${fkField.fk_location_model}`));
      } catch (error) {
        console.error(chalk.yellow(`[ExcelDataSync] Warning: Failed to create graph edge for ${fkField.field_name}`));
      }
    }
  }

  return { edges_created: edgesCreated };
}

// =============================================================================
// MAIN SYNC FUNCTION
// =============================================================================

/**
 * Sync data from Excel file to Qdrant
 *
 * @param modelName - Model name (e.g., "customer", "country")
 * @param options - Sync options
 * @returns Sync result
 */
export async function syncExcelData(
  modelName: string,
  options: ExcelDataSyncOptions = {}
): Promise<ExcelDataSyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  const {
    filePath,
    skipCascade = false,
    dryRun = false,
    force = false,
  } = options;

  console.error(chalk.blue(`\n[ExcelDataSync] Starting sync for model: ${modelName}`));

  // Determine file path
  const dataFilePath = filePath || getDefaultDataFilePath(modelName);
  console.error(chalk.gray(`[ExcelDataSync] Data file: ${dataFilePath}`));

  // Check if model exists in schema
  const modelExists = await modelExistsInSchema(modelName);
  if (!modelExists) {
    const error = `Model '${modelName}' not found in schema. Run schema sync first.`;
    console.error(chalk.red(`[ExcelDataSync] Error: ${error}`));
    return {
      success: false,
      model_name: modelName,
      model_id: 0,
      file_path: dataFilePath,
      records_read: 0,
      records_synced: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [error],
    };
  }

  // Get model ID from schema
  const modelId = await getModelIdFromSchema(modelName);
  if (!modelId) {
    const error = `Could not get model ID for: ${modelName}`;
    return {
      success: false,
      model_name: modelName,
      model_id: 0,
      file_path: dataFilePath,
      records_read: 0,
      records_synced: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [error],
    };
  }

  console.error(chalk.gray(`[ExcelDataSync] Model ID: ${modelId}`));

  // Read Excel data
  let records: Array<Record<string, unknown>>;
  try {
    records = readExcelData(dataFilePath);
    console.error(chalk.green(`[ExcelDataSync] Read ${records.length} records from Excel`));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      model_name: modelName,
      model_id: modelId,
      file_path: dataFilePath,
      records_read: 0,
      records_synced: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [errorMsg],
    };
  }

  if (records.length === 0) {
    console.error(chalk.yellow(`[ExcelDataSync] No records found in ${dataFilePath}`));
    return {
      success: true,
      model_name: modelName,
      model_id: modelId,
      file_path: dataFilePath,
      records_read: 0,
      records_synced: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [],
    };
  }

  if (dryRun) {
    console.error(chalk.yellow(`[ExcelDataSync] DRY RUN - would sync ${records.length} records`));
    return {
      success: true,
      model_name: modelName,
      model_id: modelId,
      file_path: dataFilePath,
      records_read: records.length,
      records_synced: 0,
      records_failed: 0,
      duration_ms: Date.now() - startTime,
      errors: [],
    };
  }

  // Transform records
  const transformed = await transformRecords(records, modelName, modelId);
  console.error(chalk.gray(`[ExcelDataSync] Transformed ${transformed.length} records`));

  // Embed and upload in batches
  let recordsSynced = 0;
  let recordsFailed = 0;

  for (let i = 0; i < transformed.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = transformed.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(transformed.length / EMBEDDING_BATCH_SIZE);

    console.error(chalk.gray(`[ExcelDataSync] Processing batch ${batchNum}/${totalBatches}`));

    try {
      // Generate embeddings
      const texts = batch.map(r => r.vector_text);
      const embeddings = await embedBatch(texts, 'document');

      if (embeddings.length !== batch.length) {
        throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${batch.length}`);
      }

      // Build Qdrant points with V2 UUID format
      const points: PipelineDataPoint[] = batch.map((record, idx) => {
        const pointId = buildDataUuidV2(record.model_id, record.record_id);

        return {
          id: pointId,
          vector: embeddings[idx],
          payload: {
            point_id: pointId,
            point_type: 'data' as const,
            record_id: record.record_id,
            model_name: record.model_name,
            model_id: record.model_id,
            vector_text: record.vector_text,
            sync_timestamp: new Date().toISOString(),
            ...record.payload,
          },
        };
      });

      // Upsert to Qdrant
      await upsertToUnifiedCollection(points);
      recordsSynced += batch.length;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Batch ${batchNum} failed: ${errorMsg}`);
      recordsFailed += batch.length;
      console.error(chalk.red(`[ExcelDataSync] Batch ${batchNum} failed: ${errorMsg}`));
    }
  }

  console.error(chalk.green(`[ExcelDataSync] Synced ${recordsSynced} records to Qdrant`));

  // Update knowledge graph with FK relationships
  const schemaFields = await getModelFieldsFromSchema(modelName);
  if (schemaFields && schemaFields.length > 0) {
    const graphResult = await updateKnowledgeGraph(modelName, modelId, records, schemaFields);
    if (graphResult.edges_created > 0) {
      console.error(chalk.green(`[ExcelDataSync] Created ${graphResult.edges_created} graph edges`));
    }

    // Ensure payload indexes exist (automatic - no config needed)
    const indexResult = await ensureModelIndexes(modelName, schemaFields);
    if (indexResult.created > 0) {
      console.error(chalk.green(`[ExcelDataSync] Created ${indexResult.created} indexes`));
    }
  }

  // FK Cascade (if not skipped)
  const cascadedModels: Array<{ model_name: string; records_synced: number }> = [];

  if (!skipCascade) {
    const fkTargets = await extractFkTargets(records, modelName);

    if (fkTargets.size > 0) {
      console.error(chalk.blue(`\n[ExcelDataSync] FK Cascade - ${fkTargets.size} target models`));

      for (const [targetModel, targetIds] of fkTargets) {
        console.error(chalk.gray(`[ExcelDataSync] Cascading to ${targetModel} (${targetIds.size} records)`));

        try {
          // Recursively sync FK target (with skipCascade to prevent infinite loops)
          const cascadeResult = await syncExcelData(targetModel, {
            skipCascade: true, // Prevent infinite cascade
            dryRun,
            force,
          });

          if (cascadeResult.success) {
            cascadedModels.push({
              model_name: targetModel,
              records_synced: cascadeResult.records_synced,
            });
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(chalk.yellow(`[ExcelDataSync] Cascade to ${targetModel} failed: ${errorMsg}`));
        }
      }
    }
  }

  const result: ExcelDataSyncResult = {
    success: errors.length === 0,
    model_name: modelName,
    model_id: modelId,
    file_path: dataFilePath,
    records_read: records.length,
    records_synced: recordsSynced,
    records_failed: recordsFailed,
    duration_ms: Date.now() - startTime,
    errors,
    cascaded_models: cascadedModels.length > 0 ? cascadedModels : undefined,
  };

  // Summary
  console.error(chalk.blue(`\n[ExcelDataSync] Sync Complete`));
  console.error(chalk.white(`  Model: ${modelName} (id: ${modelId})`));
  console.error(chalk.white(`  File: ${dataFilePath}`));
  console.error(chalk.white(`  Records: ${recordsSynced} synced, ${recordsFailed} failed`));
  console.error(chalk.white(`  Duration: ${result.duration_ms}ms`));

  if (cascadedModels.length > 0) {
    console.error(chalk.white(`  Cascaded:`));
    for (const cm of cascadedModels) {
      console.error(chalk.gray(`    - ${cm.model_name}: ${cm.records_synced} records`));
    }
  }

  return result;
}

/**
 * Sync all data files in the samples directory
 *
 * Finds all SAMPLE_*_data.xlsx files and syncs them.
 */
export async function syncAllExcelData(
  options: ExcelDataSyncOptions = {}
): Promise<ExcelDataSyncResult[]> {
  const results: ExcelDataSyncResult[] = [];

  // Find all data files
  const dataDir = DATA_DIR;
  if (!fs.existsSync(dataDir)) {
    console.error(chalk.red(`[ExcelDataSync] Data directory not found: ${dataDir}`));
    return results;
  }

  const files = fs.readdirSync(dataDir);
  const dataFiles = files.filter(f => f.match(/^SAMPLE_.*_data\.xlsx$/));

  console.error(chalk.blue(`[ExcelDataSync] Found ${dataFiles.length} data files`));

  for (const file of dataFiles) {
    // Extract model name from file name (SAMPLE_{model}_data.xlsx)
    const match = file.match(/^SAMPLE_(.+)_data\.xlsx$/);
    if (!match) continue;

    const modelName = match[1];
    console.error(chalk.blue(`\n${'='.repeat(60)}`));
    console.error(chalk.blue(`Syncing: ${modelName}`));
    console.error(chalk.blue(`${'='.repeat(60)}`));

    const result = await syncExcelData(modelName, {
      ...options,
      skipCascade: true, // Sync each file independently
    });

    results.push(result);
  }

  return results;
}
