/**
 * Excel Pipeline Loader Service
 *
 * Loads and parses Excel files for the data pipeline:
 * - feilds_to_add_payload.xlsx - Defines which fields go in payload (payload=1)
 * - nexsus_schema_v2_generated.xlsx - Schema with FK metadata (via loadNexsusSchema)
 *
 * Key Functions:
 * - loadPayloadConfig() - Load payload=1 field configuration
 * - loadPipelineSchema() - Load schema from V2 Excel file
 * - getModelFieldsForPipeline() - Get all fields for a model with FK metadata
 * - getPayloadFields() - Get only fields with payload=1
 * - getModelId() - Look up model_id by model name
 * - getPrimaryKeyFieldId() - Find the 'id' field for a model
 */

import XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { PIPELINE_CONFIG } from '../constants.js';
import type { PayloadFieldConfig, PipelineField, PipelineModelConfig } from '../types.js';
import { loadNexsusSchema } from './excel-schema-loader.js';

// =============================================================================
// CACHES (for performance)
// =============================================================================

/** Cache for payload configuration: key = "model_name.field_name" */
let payloadConfigCache: Map<string, PayloadFieldConfig> | null = null;

/** Cache for pipeline schema: key = "model_name" -> fields[] */
let pipelineSchemaCache: Map<string, PipelineField[]> | null = null;

/** Cache for model_id lookup: model_name -> model_id */
let modelIdCache: Map<string, number> | null = null;

// =============================================================================
// PAYLOAD CONFIGURATION LOADER (feilds_to_add_payload.xlsx)
// =============================================================================

/**
 * Load payload configuration from Excel
 *
 * Reads feilds_to_add_payload.xlsx to determine which fields should be
 * included in the Qdrant payload. Only fields with payload=1 are included.
 *
 * @returns Map of "model_name.field_name" -> PayloadFieldConfig
 */
export function loadPayloadConfig(): Map<string, PayloadFieldConfig> {
  // Return cached if available
  if (payloadConfigCache !== null) {
    console.error(`[PipelineLoader] Using cached payload config (${payloadConfigCache.size} entries)`);
    return payloadConfigCache;
  }

  const filePath = path.resolve(process.cwd(), PIPELINE_CONFIG.PAYLOAD_FIELDS_FILE);
  console.error(`[PipelineLoader] Loading payload config from: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.error(`[PipelineLoader] Payload config file not found: ${filePath}`);
    return new Map();
  }

  // Read Excel file
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert to JSON (array of objects with headers)
  // Note: XLSX may read numeric 1 as boolean true
  const rawData = XLSX.utils.sheet_to_json<{
    Field_ID: number;
    Model_ID: number;
    Model_Name: string;
    Field_Name: string;
    payload: number | boolean | null | undefined;
  }>(sheet);

  console.error(`[PipelineLoader] Found ${rawData.length} rows in payload config`);

  const config = new Map<string, PayloadFieldConfig>();
  let payloadCount = 0;

  for (const row of rawData) {
    // Skip rows with missing required fields
    if (!row.Field_ID || !row.Model_ID || !row.Model_Name || !row.Field_Name) {
      continue;
    }

    // Check if payload=1 (numeric 1, 1.0, or boolean true - XLSX reads 1 as true)
    const includeInPayload = row.payload === 1 || row.payload === true;

    const key = `${row.Model_Name}.${row.Field_Name}`;
    config.set(key, {
      field_id: row.Field_ID,
      model_id: row.Model_ID,
      model_name: row.Model_Name,
      field_name: row.Field_Name,
      include_in_payload: includeInPayload,
    });

    if (includeInPayload) {
      payloadCount++;
    }
  }

  console.error(`[PipelineLoader] Loaded ${config.size} field configs (${payloadCount} with payload=1)`);

  // Cache results
  payloadConfigCache = config;

  return config;
}

// =============================================================================
// PIPELINE SCHEMA LOADER (nexsus_schema_v2_generated.xlsx)
// =============================================================================

/**
 * Load pipeline schema with FK metadata from V2 Excel file
 *
 * Uses nexsus_schema_v2_generated.xlsx via loadNexsusSchema() for schema data.
 * Merges with feilds_to_add_payload.xlsx for payload configuration.
 *
 * @returns Map of model_name -> PipelineField[]
 */
export function loadPipelineSchema(): Map<string, PipelineField[]> {
  // Return cached if available
  if (pipelineSchemaCache !== null) {
    console.error(`[PipelineLoader] Using cached pipeline schema (${pipelineSchemaCache.size} models)`);
    return pipelineSchemaCache;
  }

  console.error(`[PipelineLoader] Loading pipeline schema from nexsus_schema_v2_generated.xlsx`);

  // Load schema from V2 Excel file
  const schemas = loadNexsusSchema('nexsus_schema_v2_generated.xlsx');

  if (schemas.length === 0) {
    console.error(`[PipelineLoader] No schema data found in nexsus_schema_v2_generated.xlsx`);
    return new Map();
  }

  console.error(`[PipelineLoader] Found ${schemas.length} rows in V2 schema`);

  // Load payload config to merge
  const payloadConfig = loadPayloadConfig();

  const schemaMap = new Map<string, PipelineField[]>();
  const modelIdMap = new Map<string, number>();

  for (const row of schemas) {
    // Skip rows with missing required fields
    if (!row.field_id || !row.model_id || !row.field_name || !row.model_name) {
      continue;
    }

    // Look up payload config for this field
    const payloadKey = `${row.model_name}.${row.field_name}`;
    const payloadFieldConfig = payloadConfig.get(payloadKey);
    const includeInPayload = payloadFieldConfig?.include_in_payload ?? false;

    const field: PipelineField = {
      field_id: row.field_id,
      model_id: row.model_id,
      field_name: row.field_name,
      field_label: row.field_label || row.field_name,
      field_type: row.field_type || 'char',
      model_name: row.model_name,
      stored: row.stored ?? true,
      include_in_payload: includeInPayload,
    };

    // Add FK metadata if present (from V2 schema)
    if (row.fk_location_model) {
      field.fk_location_model = row.fk_location_model;
    }
    if (row.fk_location_model_id) {
      field.fk_location_model_id = row.fk_location_model_id;
    }
    if (row.fk_location_record_id) {
      field.fk_location_record_id = row.fk_location_record_id;
    }
    if (row.fk_qdrant_id) {
      field.fk_qdrant_id = row.fk_qdrant_id;
    }

    // Add to model's field list
    if (!schemaMap.has(row.model_name)) {
      schemaMap.set(row.model_name, []);
    }
    schemaMap.get(row.model_name)!.push(field);

    // Track model_id
    if (!modelIdMap.has(row.model_name)) {
      modelIdMap.set(row.model_name, row.model_id);
    }
  }

  console.error(`[PipelineLoader] Parsed ${schemaMap.size} models from V2 schema`);

  // Cache results
  pipelineSchemaCache = schemaMap;
  modelIdCache = modelIdMap;

  return schemaMap;
}

// =============================================================================
// FIELD GETTERS
// =============================================================================

/**
 * Get all fields for a model from pipeline schema
 *
 * Returns all field definitions for the specified model,
 * including FK metadata and payload flags.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of PipelineField or empty array if model not found
 */
export function getModelFieldsForPipeline(modelName: string): PipelineField[] {
  const schema = loadPipelineSchema();
  const fields = schema.get(modelName);

  if (!fields) {
    console.error(`[PipelineLoader] Model '${modelName}' not found in pipeline schema`);
    return [];
  }

  return fields;
}

/**
 * Get only payload=1 fields for a model
 *
 * Returns fields that should be included in the Qdrant payload.
 * These are fields marked with payload=1 in feilds_to_add_payload.xlsx.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of PipelineField with include_in_payload=true
 */
export function getPayloadFields(modelName: string): PipelineField[] {
  const allFields = getModelFieldsForPipeline(modelName);
  return allFields.filter(f => f.include_in_payload);
}

/**
 * Get stored fields for a model (fields that exist in Odoo database)
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of stored PipelineField
 */
export function getStoredFields(modelName: string): PipelineField[] {
  const allFields = getModelFieldsForPipeline(modelName);
  return allFields.filter(f => f.stored);
}

/**
 * Get field names that can be fetched from Odoo
 *
 * Returns only the technical field names that are stored in Odoo.
 * Used when building the Odoo API call.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of field names
 */
export function getOdooFieldNames(modelName: string): string[] {
  const storedFields = getStoredFields(modelName);
  return storedFields.map(f => f.field_name);
}

// =============================================================================
// MODEL LOOKUPS
// =============================================================================

/**
 * Get model_id by model name
 *
 * Looks up the numeric model_id for a given model name.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns model_id or undefined if not found
 */
export function getModelId(modelName: string): number | undefined {
  // Ensure schema is loaded (which populates modelIdCache)
  loadPipelineSchema();

  if (modelIdCache === null) {
    return undefined;
  }

  return modelIdCache.get(modelName);
}

/**
 * Get primary key field_id for a model
 *
 * Finds the field_id of the 'id' field for a model.
 * This is used to build the Vector_Id: model_id^primary_key_value
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns field_id of the 'id' field, or undefined if not found
 */
export function getPrimaryKeyFieldId(modelName: string): number | undefined {
  const fields = getModelFieldsForPipeline(modelName);
  const idField = fields.find(f => f.field_name === 'id');

  if (!idField) {
    console.error(`[PipelineLoader] No 'id' field found for model '${modelName}'`);
    return undefined;
  }

  return idField.field_id;
}

/**
 * Get full model configuration
 *
 * Returns all configuration needed to sync a model:
 * - model_name, model_id, primary_key_field_id
 * - Field counts
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns PipelineModelConfig or null if model not found
 */
export function getModelConfig(modelName: string): PipelineModelConfig | null {
  const modelId = getModelId(modelName);
  if (!modelId) {
    console.error(`[PipelineLoader] Model '${modelName}' not found`);
    return null;
  }

  const primaryKeyFieldId = getPrimaryKeyFieldId(modelName);
  if (!primaryKeyFieldId) {
    console.error(`[PipelineLoader] No primary key found for '${modelName}'`);
    return null;
  }

  const allFields = getModelFieldsForPipeline(modelName);
  const payloadFields = getPayloadFields(modelName);

  return {
    model_name: modelName,
    model_id: modelId,
    primary_key_field_id: primaryKeyFieldId,
    total_fields: allFields.length,
    payload_field_count: payloadFields.length,
  };
}

// =============================================================================
// FIELD LOOKUPS
// =============================================================================

/**
 * Find a field by name within a model
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @param fieldName - Field name (e.g., "partner_id")
 * @returns PipelineField or undefined
 */
export function findField(modelName: string, fieldName: string): PipelineField | undefined {
  const fields = getModelFieldsForPipeline(modelName);
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
export function getFkMetadata(
  modelName: string,
  fieldName: string
): {
  target_model: string;
  target_model_id: number;
  target_field_id: number;
  fk_qdrant_id: string;
} | null {
  const field = findField(modelName, fieldName);

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

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get list of all model names in the schema
 *
 * @returns Array of model names
 */
export function getAllModelNames(): string[] {
  const schema = loadPipelineSchema();
  return Array.from(schema.keys()).sort();
}

/**
 * Get statistics about the pipeline schema
 *
 * @returns Statistics object
 */
export function getPipelineStats(): {
  totalModels: number;
  totalFields: number;
  payloadFields: number;
  storedFields: number;
  fkFields: number;
} {
  const schema = loadPipelineSchema();

  let totalFields = 0;
  let payloadFields = 0;
  let storedFields = 0;
  let fkFields = 0;

  for (const fields of schema.values()) {
    totalFields += fields.length;
    payloadFields += fields.filter(f => f.include_in_payload).length;
    storedFields += fields.filter(f => f.stored).length;
    fkFields += fields.filter(f => f.fk_location_model).length;
  }

  return {
    totalModels: schema.size,
    totalFields,
    payloadFields,
    storedFields,
    fkFields,
  };
}

/**
 * Clear all caches
 *
 * Call this to force reload from Excel files.
 */
export function clearPipelineCache(): void {
  payloadConfigCache = null;
  pipelineSchemaCache = null;
  modelIdCache = null;
  console.error('[PipelineLoader] All caches cleared');
}

/**
 * Check if a model exists in the pipeline schema
 *
 * @param modelName - Model name to check
 * @returns true if model exists
 */
export function modelExists(modelName: string): boolean {
  const schema = loadPipelineSchema();
  return schema.has(modelName);
}
