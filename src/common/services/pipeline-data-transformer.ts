/**
 * Pipeline Data Transformer Service
 *
 * Transforms Odoo records into the new pipeline format:
 * - Vector_Id: model_id^record_id (e.g., "344^12345")
 * - Vector text: Human-readable format for embedding
 * - Payload: Only fields with payload=1, skip empty values
 *
 * Key Features:
 * - Empty/null field skipping
 * - Human-readable vector text generation
 * - FK value extraction (many2one returns [id, name])
 * - Payload filtering based on Excel configuration
 */

import { PIPELINE_CONFIG } from '../constants.js';
import {
  getModelFieldsFromSchema,
  getPayloadFieldsFromSchema,
  getModelIdFromSchema,
  getPrimaryKeyFieldIdFromSchema,
  modelExistsInSchema,
} from './schema-query-service.js';
import { buildDataUuidV2 } from '../utils/uuid-v2.js';
import { getJsonFkMapping } from './json-fk-config.js';
import { extractFkValueBySchema } from '../utils/fk-value-extractor.js';
import type {
  PipelineField,
  EncodedPipelineRecord,
  PipelineModelConfig,
} from '../types.js';

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if a value is empty (null, undefined, empty string, empty array)
 *
 * Empty values are SKIPPED during transformation.
 *
 * @param value - Value to check
 * @returns true if value is considered empty
 */
export function isEmptyValue(value: unknown): boolean {
  // Null or undefined
  if (value === null || value === undefined) return true;

  // False boolean is NOT empty (it's a valid value)
  if (typeof value === 'boolean') return false;

  // Empty string
  if (typeof value === 'string' && value.trim() === '') return true;

  // Empty array
  if (Array.isArray(value) && value.length === 0) return true;

  // Odoo returns "false" for empty relation fields
  if (value === false) return true;

  // Zero is a valid value (e.g., expected_revenue = 0)
  if (typeof value === 'number') return false;

  return false;
}

/**
 * Extract display value from Odoo field value
 *
 * Handles different Odoo field types:
 * - many2one: [id, name] -> returns name
 * - boolean: true/false -> returns "Yes"/"No"
 * - other: returns string representation
 *
 * @param value - Raw Odoo field value
 * @param fieldType - Field type (many2one, boolean, etc.)
 * @returns Display string
 */
export function extractDisplayValue(value: unknown, fieldType: string): string {
  // Handle many2one: [id, name] tuple
  if (fieldType === 'many2one' && Array.isArray(value) && value.length >= 2) {
    return String(value[1]); // Return the name part
  }

  // Handle one2many/many2many: array of IDs
  if ((fieldType === 'one2many' || fieldType === 'many2many') && Array.isArray(value)) {
    return `[${value.length} records]`;
  }

  // Handle boolean
  if (fieldType === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  // Handle numbers with formatting
  if (fieldType === 'monetary' || fieldType === 'float') {
    const num = Number(value);
    if (!isNaN(num)) {
      // Format with commas for readability
      return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
  }

  // Handle dates
  if (fieldType === 'date' || fieldType === 'datetime') {
    if (typeof value === 'string' && value) {
      // Try to format date nicely
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
        }
      } catch {
        // Fall through to default
      }
    }
  }

  // Handle JSON fields (objects that aren't arrays)
  // e.g., analytic_distribution: {"318": 100.0} → "318: 100%"
  if (fieldType === 'json' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return '(empty)';
    }
    // Format as "account_id: percentage, ..." for analytic_distribution
    return entries
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v + '%' : v}`)
      .join(', ');
  }

  // Handle other objects (fallback to JSON.stringify to avoid [object Object])
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }

  // Default: convert to string
  return String(value);
}

/**
 * Extract ID from Odoo many2one field value
 *
 * @param value - Odoo field value ([id, name] or false)
 * @returns ID number or undefined
 */
export function extractFkId(value: unknown): number | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    return Number(value[0]);
  }
  if (typeof value === 'number') {
    return value;
  }
  return undefined;
}

// =============================================================================
// VECTOR ID GENERATION
// =============================================================================

/**
 * Generate Vector_Id in the new format: model_id^record_id
 *
 * Example: generateDataVectorId(344, 12345) -> "344^12345"
 *
 * @param modelId - Model ID (e.g., 344 for crm.lead)
 * @param recordId - Record ID (Odoo's id field value)
 * @returns Vector_Id string
 */
export function generateDataVectorId(modelId: number, recordId: number): string {
  return `${modelId}^${recordId}`;
}

// =============================================================================
// VECTOR TEXT GENERATION
// =============================================================================

/**
 * Build human-readable vector text for embedding
 *
 * Creates a text description of the record for semantic search.
 * Format: "In model [model_name], [field_label] - [value], ..."
 *
 * Rules:
 * - Skip empty/null fields
 * - Use field_label for readability
 * - Extract names from FK relations
 *
 * @param record - Raw Odoo record
 * @param fields - Pipeline fields for the model
 * @param modelName - Model name for the prefix
 * @returns Human-readable text string
 */
export function buildVectorText(
  record: Record<string, unknown>,
  fields: PipelineField[],
  modelName: string
): string {
  const parts: string[] = [];

  // Start with model context
  const prefix = PIPELINE_CONFIG.VECTOR_TEXT_PREFIX;

  for (const field of fields) {
    const value = record[field.field_name];

    // Skip empty values
    if (isEmptyValue(value)) {
      continue;
    }

    // Get display value
    const displayValue = extractDisplayValue(value, field.field_type);

    // Add to parts: "field_label - value"
    parts.push(`${field.field_label} - ${displayValue}`);
  }

  // Join all parts
  if (parts.length === 0) {
    return `${prefix} ${modelName}, no data available`;
  }

  return `${prefix} ${modelName}, ${parts.join(', ')}`;
}

// =============================================================================
// PAYLOAD BUILDING
// =============================================================================

/**
 * Build payload with only payload=1 fields (skip empty)
 *
 * Creates a payload object containing only the fields marked with
 * payload=1 in feilds_to_add_payload.xlsx. Empty values are skipped.
 *
 * @param record - Raw Odoo record
 * @param payloadFields - Fields with include_in_payload=true
 * @returns Payload object
 */
export function buildPayload(
  record: Record<string, unknown>,
  payloadFields: PipelineField[],
  modelName?: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of payloadFields) {
    const value = record[field.field_name];

    // Skip empty values
    if (isEmptyValue(value)) {
      continue;
    }

    // For many2one, use schema-driven FK extraction (handles scalar, tuple, expanded formats)
    if (field.field_type === 'many2one') {
      const fkResult = extractFkValueBySchema(record, {
        field_id: field.field_id || 0,
        field_name: field.field_name,
        field_type: field.field_type,
      });

      if (fkResult.fkId !== undefined) {
        // Always store FK ID in _id field for consistent querying
        payload[`${field.field_name}_id`] = fkResult.fkId;

        // Store display name if available (from tuple format)
        if (fkResult.displayName) {
          payload[field.field_name] = fkResult.displayName;
        }

        // Build FK Qdrant UUID if FK metadata exists in schema
        // This enables graph traversal by direct UUID lookup
        if (field.fk_location_model_id) {
          const fkQdrantId = buildDataUuidV2(field.fk_location_model_id, fkResult.fkId);
          payload[`${field.field_name}_qdrant`] = fkQdrantId;
        }
      }
    }
    // For one2many/many2many, store the array of IDs AND build FK Qdrant UUIDs
    else if ((field.field_type === 'one2many' || field.field_type === 'many2many') && Array.isArray(value)) {
      // Store original array of IDs
      payload[field.field_name] = value;

      // Build FK Qdrant UUID array if FK metadata exists and array is not empty
      // This enables graph traversal for many2many/one2many relationships
      if (field.fk_location_model_id && value.length > 0) {
        const fkQdrantIds: string[] = [];
        for (const item of value) {
          // Handle both raw IDs [1, 2, 3] and tuples [[1, "name"], [2, "name"]]
          const recordId = Array.isArray(item) ? item[0] : item;
          if (typeof recordId === 'number' && !isNaN(recordId)) {
            const fkQdrantId = buildDataUuidV2(field.fk_location_model_id, recordId);
            fkQdrantIds.push(fkQdrantId);
          }
        }
        if (fkQdrantIds.length > 0) {
          payload[`${field.field_name}_qdrant`] = fkQdrantIds;
        }
      }
    }
    // For JSON fields, check if it's a JSON FK field and build Qdrant UUIDs
    else if (
      field.field_type === 'json' &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      modelName
    ) {
      // Store the original JSON value
      payload[field.field_name] = value;

      // Check if this is a JSON FK field
      const jsonFkMapping = getJsonFkMapping(modelName, field.field_name);
      if (jsonFkMapping) {
        // Build Qdrant UUIDs for JSON keys (which are record IDs)
        const jsonValue = value as Record<string, unknown>;
        const fkQdrantIds: string[] = [];

        for (const keyStr of Object.keys(jsonValue)) {
          // Parse key as record ID
          const recordId = parseInt(keyStr, 10);
          if (!isNaN(recordId) && recordId > 0) {
            const fkQdrantId = buildDataUuidV2(
              jsonFkMapping.key_target_model_id,
              recordId
            );
            fkQdrantIds.push(fkQdrantId);
          }
        }

        if (fkQdrantIds.length > 0) {
          payload[`${field.field_name}_qdrant`] = fkQdrantIds;
        }
      }
    }
    // For other types, store as-is
    else {
      payload[field.field_name] = value;
    }
  }

  return payload;
}

/**
 * Add FK Qdrant IDs for ALL FK fields with FK metadata
 *
 * This function adds *_qdrant UUIDs for graph traversal, regardless of
 * whether the field is marked as payload=1. This ensures FK relationships
 * can always be traversed in the knowledge graph.
 *
 * The function processes ALL fields (not just payload fields) and adds:
 * - field_qdrant: UUID pointing to the target record (many2one)
 * - field_qdrant: Array of UUIDs pointing to target records (many2many/one2many)
 *
 * This is called after buildPayload() to add missing FK Qdrant IDs.
 *
 * @param record - Raw Odoo record
 * @param allFields - ALL fields for the model (not just payload fields)
 * @param existingPayload - Payload object to add FK IDs to
 * @returns Number of FK Qdrant IDs added
 */
export function addFkQdrantIds(
  record: Record<string, unknown>,
  allFields: PipelineField[],
  existingPayload: Record<string, unknown>
): number {
  let fkCount = 0;

  for (const field of allFields) {
    // Only process FK fields with FK metadata
    const isFkField = field.field_type === 'many2one' ||
                      field.field_type === 'many2many' ||
                      field.field_type === 'one2many';
    if (!isFkField || !field.fk_location_model_id) {
      continue;
    }

    const value = record[field.field_name];

    // Skip empty values
    if (isEmptyValue(value)) {
      continue;
    }

    // Skip if already has FK Qdrant ID (added by buildPayload for payload=1 fields)
    const qdrantFieldName = `${field.field_name}_qdrant`;
    if (existingPayload[qdrantFieldName]) {
      continue;
    }

    // Handle many2one: single FK reference
    if (field.field_type === 'many2one') {
      // Odoo many2one returns [id, name] or just id
      let fkRecordId: number;
      if (Array.isArray(value) && value.length >= 2) {
        fkRecordId = value[0] as number;
        // Also add the name and ID if not present (for non-payload fields)
        if (!existingPayload[field.field_name]) {
          existingPayload[field.field_name] = value[1]; // Store name
        }
        if (!existingPayload[`${field.field_name}_id`]) {
          existingPayload[`${field.field_name}_id`] = value[0]; // Store ID
        }
      } else if (typeof value === 'number') {
        fkRecordId = value;
      } else {
        continue; // Unexpected format
      }

      // Build FK Qdrant UUID
      const fkQdrantId = buildDataUuidV2(field.fk_location_model_id, fkRecordId);
      existingPayload[qdrantFieldName] = fkQdrantId;
      fkCount++;
    }
    // Handle many2many/one2many: array of FK references
    else if ((field.field_type === 'many2many' || field.field_type === 'one2many') && Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }

      const fkQdrantIds: string[] = [];
      for (const item of value) {
        // Handle both raw IDs [1, 2, 3] and tuples [[1, "name"], [2, "name"]]
        const recordId = Array.isArray(item) ? item[0] : item;
        if (typeof recordId === 'number' && !isNaN(recordId)) {
          const fkQdrantId = buildDataUuidV2(field.fk_location_model_id, recordId);
          fkQdrantIds.push(fkQdrantId);
        }
      }

      if (fkQdrantIds.length > 0) {
        existingPayload[qdrantFieldName] = fkQdrantIds;
        fkCount++;
      }
    }
  }

  return fkCount;
}

// =============================================================================
// RECORD TRANSFORMATION
// =============================================================================

/**
 * Transform a single Odoo record to pipeline format
 *
 * Creates an EncodedPipelineRecord with:
 * - vector_text: human-readable for embedding
 * - payload: payload=1 fields + ALL FK Qdrant IDs for graph traversal
 *
 * Note: vector_id is no longer stored - Qdrant point ID (UUID) is calculated
 * from model_id^record_id and converted to UUID format.
 *
 * FK Qdrant IDs are added for ALL many2one fields with FK metadata,
 * regardless of whether they're marked as payload=1. This ensures
 * graph traversal always works.
 *
 * @param record - Raw Odoo record
 * @param modelConfig - Model configuration
 * @param allFields - All fields for the model
 * @param payloadFields - Fields with payload=1
 * @returns EncodedPipelineRecord
 */
export function transformPipelineRecord(
  record: Record<string, unknown>,
  modelConfig: PipelineModelConfig,
  allFields: PipelineField[],
  payloadFields: PipelineField[]
): EncodedPipelineRecord {
  // Get record ID
  const recordId = Number(record.id);
  if (isNaN(recordId)) {
    throw new Error(`Record missing valid 'id' field`);
  }

  // Build vector text (human-readable)
  const vectorText = buildVectorText(record, allFields, modelConfig.model_name);

  // Build payload (only payload=1 fields)
  // Pass modelName to enable JSON FK handling (e.g., analytic_distribution)
  const payload = buildPayload(record, payloadFields, modelConfig.model_name);

  // Add FK Qdrant IDs for ALL many2one fields with FK metadata
  // This ensures graph traversal works even if field is not in payload config
  const fkCount = addFkQdrantIds(record, allFields, payload);

  // Count non-empty fields included
  const fieldCount = Object.keys(payload).length;

  return {
    record_id: recordId,
    model_name: modelConfig.model_name,
    model_id: modelConfig.model_id,
    vector_text: vectorText,
    payload: payload,
    field_count: fieldCount,
  };
}

/**
 * Transform a batch of Odoo records
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 *
 * @param records - Array of raw Odoo records
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of EncodedPipelineRecord
 */
export async function transformPipelineRecords(
  records: Record<string, unknown>[],
  modelName: string
): Promise<EncodedPipelineRecord[]> {
  // Get model configuration from Qdrant schema
  const modelId = await getModelIdFromSchema(modelName);
  const primaryKeyFieldId = await getPrimaryKeyFieldIdFromSchema(modelName);

  if (!modelId) {
    throw new Error(`Model '${modelName}' not found in pipeline schema`);
  }

  // Get field lists from Qdrant schema
  const allFields = await getModelFieldsFromSchema(modelName);
  const payloadFields = await getPayloadFieldsFromSchema(modelName);

  // Build model config
  const modelConfig: PipelineModelConfig = {
    model_name: modelName,
    model_id: modelId,
    primary_key_field_id: primaryKeyFieldId || 0,
    total_fields: allFields.length,
    payload_field_count: payloadFields.length,
  };

  console.error(`[PipelineTransformer] Transforming ${records.length} records for ${modelName}`);
  console.error(`[PipelineTransformer] Total fields: ${allFields.length}, Payload fields: ${payloadFields.length}`);

  const results: EncodedPipelineRecord[] = [];
  let errorCount = 0;

  for (const record of records) {
    try {
      const encoded = transformPipelineRecord(record, modelConfig, allFields, payloadFields);
      results.push(encoded);
    } catch (error) {
      errorCount++;
      const recordId = record.id || 'unknown';
      console.error(`[PipelineTransformer] Error transforming record ${recordId}:`, error);
    }
  }

  if (errorCount > 0) {
    console.error(`[PipelineTransformer] ${errorCount} records failed to transform`);
  }

  return results;
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate that a model is ready for pipeline sync
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 *
 * Checks:
 * - Model exists in schema
 * - Has model_id
 * - Has primary key field
 * - Has at least one payload field
 *
 * @param modelName - Model name to validate
 * @returns Validation result
 */
export async function validateModelForPipeline(modelName: string): Promise<{
  valid: boolean;
  errors: string[];
  config?: PipelineModelConfig;
}> {
  const errors: string[] = [];

  // Get model ID from schema
  const modelId = await getModelIdFromSchema(modelName);
  if (!modelId) {
    errors.push(`Model '${modelName}' not found in pipeline schema`);
    return { valid: false, errors };
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

  // Build model config
  const modelConfig: PipelineModelConfig = {
    model_name: modelName,
    model_id: modelId,
    primary_key_field_id: primaryKeyFieldId || 0,
    total_fields: allFields.length,
    payload_field_count: payloadFields.length,
  };

  return {
    valid: errors.length === 0,
    errors,
    config: modelConfig,
  };
}

/**
 * Get transformation statistics for a model
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 *
 * @param modelName - Model name
 * @returns Statistics object
 */
export async function getTransformStats(modelName: string): Promise<{
  model_name: string;
  model_id: number | undefined;
  total_fields: number;
  stored_fields: number;
  payload_fields: number;
  fk_fields: number;
  payload_field_names: string[];
}> {
  const allFields = await getModelFieldsFromSchema(modelName);
  const payloadFields = await getPayloadFieldsFromSchema(modelName);
  const modelId = await getModelIdFromSchema(modelName);

  return {
    model_name: modelName,
    model_id: modelId,
    total_fields: allFields.length,
    stored_fields: allFields.filter(f => f.stored).length,
    payload_fields: payloadFields.length,
    fk_fields: allFields.filter(f => f.fk_location_model).length,
    payload_field_names: payloadFields.map(f => f.field_name),
  };
}
