/**
 * Schema Lookup Service
 *
 * Provides fast field lookups and query validation against the schema.
 * Used by exact_query to validate fields before execution.
 *
 * Key features:
 * - O(1) field lookup using two-level Map (model -> field -> FieldInfo)
 * - Field type checking (numeric, text, date, FK)
 * - "Did you mean?" suggestions using Levenshtein distance
 * - Query validation with helpful error messages
 */

import { loadNexsusSchema } from './excel-schema-loader.js';
import type { NexsusSchemaRow } from '../types.js';
import type { FilterCondition, Aggregation } from '../types.js';

// =============================================================================
// SYSTEM FIELDS (Present in ALL Qdrant payloads, not in Odoo schema)
// =============================================================================

/**
 * System fields that exist in every Qdrant payload
 * These bypass schema validation since they're not in the Odoo schema
 *
 * Key insight: point_id encodes semantic information:
 * - DATA:   00000002-MMMM-0000-0000-RRRRRRRRRRRR (model_id, record_id)
 * - SCHEMA: 00000003-0004-0000-0000-FFFFFFFFFFFF (field_id)
 * - GRAPH:  00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF (src, tgt, rel, field_id)
 *
 * This enables pattern matching on UUID segments for powerful queries!
 */
export const SYSTEM_FIELDS: Record<string, {
  type: 'string' | 'integer' | 'datetime';
  operators: string[];
  description: string;
}> = {
  point_id: {
    type: 'string',
    operators: ['eq', 'neq', 'contains', 'in'],
    description: 'V2 UUID of the Qdrant point. Use "contains" for segment matching (e.g., "00000002-0312" for model 312)'
  },
  point_type: {
    type: 'string',
    operators: ['eq', 'neq', 'in'],
    description: 'Point type: "data", "schema", or "graph"'
  },
  sync_timestamp: {
    type: 'datetime',
    operators: ['eq', 'gte', 'lte', 'gt', 'lt'],
    description: 'ISO datetime when the record was synced to Qdrant'
  },
  record_id: {
    type: 'integer',
    operators: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'],
    description: 'Odoo record ID (same as extracted from point_id)'
  },
  model_id: {
    type: 'integer',
    operators: ['eq', 'neq', 'in'],
    description: 'Odoo model ID (same as extracted from point_id)'
  },
  model_name: {
    type: 'string',
    operators: ['eq', 'neq', 'contains', 'in'],
    description: 'Odoo model name (e.g., "account.move.line")'
  },
  vector_text: {
    type: 'string',
    operators: ['contains'],
    description: 'The text used for generating the embedding vector'
  },
};

/**
 * Check if a field is a system field
 */
export function isSystemField(fieldName: string): boolean {
  return fieldName in SYSTEM_FIELDS;
}

/**
 * Validate system field operator
 * @returns Error message if invalid, null if valid
 */
export function validateSystemFieldOperator(fieldName: string, op: string): string | null {
  const sysField = SYSTEM_FIELDS[fieldName];
  if (!sysField) {
    return null; // Not a system field
  }

  if (!sysField.operators.includes(op)) {
    return `Operator '${op}' not allowed for system field '${fieldName}'. Allowed: ${sysField.operators.join(', ')}`;
  }

  return null; // Valid
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Simplified field info for lookups
 */
export interface FieldInfo {
  field_name: string;
  field_type: string;
  field_label: string;
  model_name: string;
  model_id: number;
  field_id: number;
  stored: boolean;
  is_fk: boolean;
  fk_target_model?: string;
}

/**
 * Validation error with suggestion
 */
export interface ValidationError {
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Validation warning (query proceeds but user is alerted)
 */
export interface ValidationWarning {
  field: string;
  message: string;
}

/**
 * Result of query validation
 */
export interface QueryValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

// =============================================================================
// FIELD TYPE CATEGORIES
// =============================================================================

/** Field types that support numeric aggregations (SUM, AVG, MIN, MAX) */
const NUMERIC_TYPES = new Set(['integer', 'float', 'monetary']);

/** Field types that support text operations (contains) */
const TEXT_TYPES = new Set(['char', 'text', 'html']);

/** Field types that are date/datetime (for app-level filtering) */
const DATE_TYPES = new Set(['date', 'datetime']);

/** Field types that are foreign keys */
const FK_TYPES = new Set(['many2one', 'one2many', 'many2many']);

// =============================================================================
// SCHEMA CACHE
// =============================================================================

/**
 * Two-level Map for O(1) lookup: model_name -> field_name -> FieldInfo
 */
let schemaLookup: Map<string, Map<string, FieldInfo>> | null = null;

/**
 * Set of valid model names
 */
let validModels: Set<string> | null = null;

/**
 * Flag indicating schema is empty (file missing or no data)
 * When true, validation is skipped to allow graceful operation
 */
let schemaEmpty = false;

/**
 * Map from model_id to model_name for UUID-based lookups
 * Enables Tier 3 feature: extract model from point_id UUID segment
 */
let modelIdToName: Map<number, string> | null = null;

/**
 * Flag to indicate if schema lookup is initialized
 */
let initialized = false;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the schema lookup from Excel schema
 *
 * Builds the two-level Map for fast lookups.
 * Call this once at startup or on first query.
 */
export function initializeSchemaLookup(): void {
  if (initialized) {
    return; // Already initialized
  }

  console.error('[SchemaLookup] Initializing from Excel schema...');

  const schemas = loadNexsusSchema();
  if (schemas.length === 0) {
    console.error('[SchemaLookup] Warning: No schema data loaded - validation will be skipped');
    initialized = true;
    schemaEmpty = true; // Skip validation when schema is empty
    schemaLookup = new Map();
    validModels = new Set();
    modelIdToName = new Map();
    return;
  }

  schemaLookup = new Map();
  validModels = new Set();
  modelIdToName = new Map();

  for (const row of schemas) {
    const modelName = row.model_name;
    const fieldName = row.field_name;

    // Add to valid models
    validModels.add(modelName);

    // Build model_id → model_name mapping (only once per model)
    if (row.model_id && !modelIdToName.has(row.model_id)) {
      modelIdToName.set(row.model_id, modelName);
    }

    // Get or create model map
    if (!schemaLookup.has(modelName)) {
      schemaLookup.set(modelName, new Map());
    }
    const modelMap = schemaLookup.get(modelName)!;

    // Create FieldInfo
    const fieldInfo: FieldInfo = {
      field_name: fieldName,
      field_type: row.field_type,
      field_label: row.field_label || fieldName,
      model_name: modelName,
      model_id: row.model_id,
      field_id: row.field_id,
      stored: row.stored,
      is_fk: FK_TYPES.has(row.field_type),
      fk_target_model: row.fk_location_model
    };

    modelMap.set(fieldName, fieldInfo);

    // Also add *_id variant for FK fields (partner_id -> partner_id_id)
    if (fieldInfo.is_fk && row.field_type === 'many2one') {
      const idFieldName = `${fieldName}_id`;
      const idFieldInfo: FieldInfo = {
        ...fieldInfo,
        field_name: idFieldName,
        field_type: 'integer', // The _id variant is an integer
        field_label: `${fieldInfo.field_label} ID`,
        is_fk: false // The _id variant is not treated as FK for validation
      };
      modelMap.set(idFieldName, idFieldInfo);

      // Also add *_qdrant variant for FK traversal
      const qdrantFieldName = `${fieldName}_qdrant`;
      const qdrantFieldInfo: FieldInfo = {
        ...fieldInfo,
        field_name: qdrantFieldName,
        field_type: 'char', // UUID string
        field_label: `${fieldInfo.field_label} Qdrant ID`,
        is_fk: false
      };
      modelMap.set(qdrantFieldName, qdrantFieldInfo);
    }
  }

  const modelCount = validModels.size;
  const totalFields = Array.from(schemaLookup.values()).reduce((sum, m) => sum + m.size, 0);
  console.error(`[SchemaLookup] Initialized: ${modelCount} models, ${totalFields} fields (including FK variants)`);

  initialized = true;
}

/**
 * Check if schema lookup is initialized
 */
export function isSchemaLookupInitialized(): boolean {
  return initialized;
}

/**
 * Check if schema is empty (file missing or no data)
 * When true, validation should be skipped for graceful degradation
 */
export function isSchemaEmpty(): boolean {
  return schemaEmpty;
}

/**
 * Clear schema lookup cache (for testing or re-initialization)
 */
export function clearSchemaLookup(): void {
  schemaLookup = null;
  validModels = null;
  modelIdToName = null;
  schemaEmpty = false;
  initialized = false;
}

// =============================================================================
// FIELD LOOKUPS
// =============================================================================

/**
 * Get field info for a specific model.field
 *
 * @param modelName - Odoo model name (e.g., "account.move.line")
 * @param fieldName - Field name (e.g., "debit", "partner_id_id")
 * @returns FieldInfo or undefined if not found
 */
export function getFieldInfo(modelName: string, fieldName: string): FieldInfo | undefined {
  if (!initialized || !schemaLookup) {
    return undefined;
  }

  const modelMap = schemaLookup.get(modelName);
  if (!modelMap) {
    return undefined;
  }

  return modelMap.get(fieldName);
}

/**
 * Get all fields for a model
 *
 * @param modelName - Odoo model name
 * @returns Array of FieldInfo or empty array if model not found
 */
export function getModelFields(modelName: string): FieldInfo[] {
  if (!initialized || !schemaLookup) {
    return [];
  }

  const modelMap = schemaLookup.get(modelName);
  if (!modelMap) {
    return [];
  }

  return Array.from(modelMap.values());
}

/**
 * Check if a model exists in the schema
 */
export function isValidModel(modelName: string): boolean {
  if (!initialized || !validModels) {
    return true; // Assume valid if not initialized
  }
  if (schemaEmpty) {
    return true; // Skip validation when schema is empty (file missing)
  }
  return validModels.has(modelName);
}

/**
 * Get all valid model names
 */
export function getAllModelNames(): string[] {
  if (!initialized || !validModels) {
    return [];
  }
  return Array.from(validModels);
}

/**
 * Get model name from model_id
 *
 * Used for Tier 3 feature: When querying by point_id, we can extract
 * the model_id from the UUID and look up the model_name automatically.
 *
 * @param modelId - Odoo model ID (e.g., 312 for account.move.line)
 * @returns Model name (e.g., "account.move.line") or undefined if not found
 *
 * @example
 * getModelNameById(312)  // Returns: "account.move.line"
 * getModelNameById(78)   // Returns: "res.partner"
 * getModelNameById(9999) // Returns: undefined
 */
export function getModelNameById(modelId: number): string | undefined {
  if (!initialized || !modelIdToName) {
    return undefined;
  }
  return modelIdToName.get(modelId);
}

/**
 * Get model_id from model_name
 *
 * Reverse lookup: find the Odoo model ID from a model name.
 *
 * @param modelName - Odoo model name (e.g., "account.move.line")
 * @returns Model ID (e.g., 312) or undefined if not found
 */
export function getModelIdByName(modelName: string): number | undefined {
  if (!initialized || !schemaLookup) {
    return undefined;
  }

  const modelMap = schemaLookup.get(modelName);
  if (!modelMap || modelMap.size === 0) {
    return undefined;
  }

  // Get any field from the model to extract model_id
  const firstField = modelMap.values().next().value;
  return firstField?.model_id;
}

// =============================================================================
// TYPE CHECKING HELPERS
// =============================================================================

/**
 * Check if a field type is numeric (can use SUM, AVG, MIN, MAX)
 */
export function isNumericField(fieldType: string): boolean {
  return NUMERIC_TYPES.has(fieldType);
}

/**
 * Check if a field type is text (can use 'contains')
 */
export function isTextField(fieldType: string): boolean {
  return TEXT_TYPES.has(fieldType);
}

/**
 * Check if a field type is date/datetime (for app-level filtering)
 */
export function isDateField(fieldType: string): boolean {
  return DATE_TYPES.has(fieldType);
}

/**
 * Check if a field type is a foreign key
 */
export function isFKField(fieldType: string): boolean {
  return FK_TYPES.has(fieldType);
}

// =============================================================================
// SIMILAR FIELD SUGGESTIONS
// =============================================================================

/**
 * Calculate Levenshtein distance between two strings
 * Used for "did you mean?" suggestions
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // Deletion
        matrix[i][j - 1] + 1,      // Insertion
        matrix[i - 1][j - 1] + cost // Substitution
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 * Find similar field names for typo suggestions
 *
 * @param modelName - Model to search in
 * @param typoField - Field name with potential typo
 * @param limit - Max suggestions to return (default: 3)
 * @returns Array of similar field names
 */
export function findSimilarFields(modelName: string, typoField: string, limit: number = 3): string[] {
  if (!initialized || !schemaLookup) {
    return [];
  }

  const modelMap = schemaLookup.get(modelName);
  if (!modelMap) {
    return [];
  }

  const typoLower = typoField.toLowerCase();

  return Array.from(modelMap.keys())
    .map(field => ({
      field,
      distance: levenshteinDistance(typoLower, field.toLowerCase())
    }))
    .filter(x => x.distance <= 3) // Max 3 edits
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(x => x.field);
}

/**
 * Find similar model names for typo suggestions
 */
export function findSimilarModels(typoModel: string, limit: number = 3): string[] {
  if (!initialized || !validModels) {
    return [];
  }

  const typoLower = typoModel.toLowerCase();

  return Array.from(validModels)
    .map(model => ({
      model,
      distance: levenshteinDistance(typoLower, model.toLowerCase())
    }))
    .filter(x => x.distance <= 4) // Max 4 edits for model names
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(x => x.model);
}

// =============================================================================
// QUERY VALIDATION
// =============================================================================

/**
 * Validate an exact_query against the schema
 *
 * Checks:
 * - Model exists
 * - All filter fields exist
 * - Filter operators are valid for field types
 * - Aggregation fields exist and are numeric (for SUM/AVG/MIN/MAX)
 * - GROUP BY fields exist
 *
 * @returns QueryValidationResult with errors and warnings
 */
export function validateExactQuery(
  modelName: string,
  filters: FilterCondition[],
  aggregations?: Aggregation[],
  groupBy?: string[]
): QueryValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // If not initialized or schema is empty, skip validation (graceful degradation)
  if (!initialized || !schemaLookup || schemaEmpty) {
    return { isValid: true, errors: [], warnings: [] };
  }

  // Check model exists
  if (!isValidModel(modelName)) {
    const suggestions = findSimilarModels(modelName);
    errors.push({
      field: 'model_name',
      message: `Model '${modelName}' not found in schema`,
      suggestion: suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}?`
        : undefined
    });
    // Can't validate fields if model doesn't exist
    return { isValid: false, errors, warnings };
  }

  // Validate filter fields
  for (const filter of filters) {
    // =========================================================================
    // SYSTEM FIELD CHECK (bypasses schema lookup)
    // =========================================================================
    // System fields like point_id, point_type, sync_timestamp exist in ALL
    // Qdrant payloads but are not in the Odoo schema. Check these first.
    if (isSystemField(filter.field)) {
      const sysFieldError = validateSystemFieldOperator(filter.field, filter.op);
      if (sysFieldError) {
        errors.push({
          field: filter.field,
          message: sysFieldError,
          suggestion: `System field '${filter.field}' supports: ${SYSTEM_FIELDS[filter.field].operators.join(', ')}`
        });
      }
      // System field validated - skip schema lookup
      continue;
    }

    // =========================================================================
    // SCHEMA FIELD CHECK (normal validation)
    // =========================================================================
    const fieldInfo = getFieldInfo(modelName, filter.field);

    if (!fieldInfo) {
      const suggestions = findSimilarFields(modelName, filter.field);
      errors.push({
        field: filter.field,
        message: `Field '${filter.field}' not found in model '${modelName}'`,
        suggestion: suggestions.length > 0
          ? `Did you mean: ${suggestions.join(', ')}?`
          : undefined
      });
      continue;
    }

    // Warn about computed fields
    if (!fieldInfo.stored) {
      warnings.push({
        field: filter.field,
        message: `Field '${filter.field}' is computed (not stored in database)`
      });
    }

    // Validate operator for field type
    const opError = validateOperatorForType(filter.field, filter.op, fieldInfo.field_type);
    if (opError) {
      errors.push(opError);
    }
  }

  // Validate aggregation fields
  if (aggregations && aggregations.length > 0) {
    for (const agg of aggregations) {
      // COUNT doesn't need a valid field (counts records)
      if (agg.op === 'count') {
        continue;
      }

      const fieldInfo = getFieldInfo(modelName, agg.field);

      if (!fieldInfo) {
        const suggestions = findSimilarFields(modelName, agg.field);
        errors.push({
          field: agg.field,
          message: `Aggregation field '${agg.field}' not found in model '${modelName}'`,
          suggestion: suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}?`
            : undefined
        });
        continue;
      }

      // Validate aggregation type for field type
      const aggError = validateAggregationForType(agg.field, agg.op, fieldInfo.field_type);
      if (aggError) {
        if (aggError.isWarning) {
          warnings.push({ field: agg.field, message: aggError.message });
        } else {
          errors.push({ field: agg.field, message: aggError.message, suggestion: aggError.suggestion });
        }
      }
    }
  }

  // Validate GROUP BY fields
  if (groupBy && groupBy.length > 0) {
    for (const field of groupBy) {
      const fieldInfo = getFieldInfo(modelName, field);

      if (!fieldInfo) {
        const suggestions = findSimilarFields(modelName, field);
        errors.push({
          field: field,
          message: `GROUP BY field '${field}' not found in model '${modelName}'`,
          suggestion: suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}?`
            : undefined
        });
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate filter operator for field type
 */
function validateOperatorForType(
  fieldName: string,
  op: string,
  fieldType: string
): ValidationError | null {
  // 'contains' only works on text fields
  if (op === 'contains' && !isTextField(fieldType)) {
    return {
      field: fieldName,
      message: `Cannot use 'contains' on field '${fieldName}' (type: ${fieldType})`,
      suggestion: `'contains' only works with text fields (char, text, html). Use 'eq' for exact match.`
    };
  }

  // Range operators on boolean don't make sense
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && fieldType === 'boolean') {
    return {
      field: fieldName,
      message: `Cannot use range operator '${op}' on boolean field '${fieldName}'`,
      suggestion: `Use 'eq' with true or false for boolean fields.`
    };
  }

  return null;
}

/**
 * Validate aggregation operation for field type
 */
function validateAggregationForType(
  fieldName: string,
  op: string,
  fieldType: string
): { message: string; suggestion?: string; isWarning?: boolean } | null {
  // SUM, AVG require numeric fields
  if (['sum', 'avg'].includes(op)) {
    if (!isNumericField(fieldType)) {
      // Check if it's an FK ID field (ends with _id)
      if (fieldName.endsWith('_id') && fieldType === 'integer') {
        return {
          message: `SUM/AVG on '${fieldName}' sums FK IDs - this is usually not meaningful`,
          isWarning: true
        };
      }

      return {
        message: `Cannot use ${op.toUpperCase()} on field '${fieldName}' (type: ${fieldType})`,
        suggestion: `${op.toUpperCase()} only works with numeric fields: integer, float, monetary`
      };
    }
  }

  // MIN, MAX work on numeric and date fields
  if (['min', 'max'].includes(op)) {
    if (!isNumericField(fieldType) && !isDateField(fieldType)) {
      return {
        message: `Cannot use ${op.toUpperCase()} on field '${fieldName}' (type: ${fieldType})`,
        suggestion: `${op.toUpperCase()} works with numeric (integer, float, monetary) or date fields`
      };
    }
  }

  return null;
}

// =============================================================================
// DOT NOTATION VALIDATION
// =============================================================================

/**
 * Result of dot notation validation
 */
export interface DotNotationValidation {
  valid: boolean;
  /** FK field info in source model */
  fkInfo?: FieldInfo;
  /** Target field info in related model */
  targetFieldInfo?: FieldInfo;
  /** Target model name (e.g., "res.partner") */
  targetModel?: string;
  /** Error message if invalid */
  error?: string;
  /** Suggestion for fixing the error */
  suggestion?: string;
}

/**
 * Validate a dot notation field reference
 *
 * Checks:
 * 1. FK field exists in source model
 * 2. FK field is actually a many2one FK
 * 3. Target model is known
 * 4. Target field exists in target model
 *
 * @param modelName - Source model (e.g., "account.move.line")
 * @param fkField - FK field name (e.g., "partner_id")
 * @param targetField - Target field in related model (e.g., "name")
 * @returns Validation result with field info or error
 *
 * @example
 * validateDotNotationField("account.move.line", "partner_id", "name")
 * // { valid: true, fkInfo: {...}, targetModel: "res.partner", targetFieldInfo: {...} }
 */
export function validateDotNotationField(
  modelName: string,
  fkField: string,
  targetField: string
): DotNotationValidation {
  // If schema not initialized, assume valid (graceful degradation)
  if (!initialized || !schemaLookup) {
    console.error('[SchemaLookup] Not initialized, skipping dot notation validation');
    return { valid: true };
  }

  // Step 1: Check FK field exists in source model
  const fkInfo = getFieldInfo(modelName, fkField);
  if (!fkInfo) {
    const suggestions = findSimilarFields(modelName, fkField);
    return {
      valid: false,
      error: `Field '${fkField}' not found in model '${modelName}'`,
      suggestion: suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}?`
        : undefined
    };
  }

  // Step 2: Check FK field is actually a many2one FK
  if (!fkInfo.is_fk) {
    return {
      valid: false,
      error: `Field '${fkField}' is not a FK field (type: ${fkInfo.field_type})`,
      suggestion: `Dot notation only works with many2one FK fields. Use regular filter for '${fkField}'.`
    };
  }

  // Step 3: Check target model is known
  const targetModel = fkInfo.fk_target_model;
  if (!targetModel) {
    return {
      valid: false,
      error: `FK field '${fkField}' does not have a known target model`,
      suggestion: `The schema doesn't have FK relationship info for this field.`
    };
  }

  // Step 4: Check target field exists in target model
  const targetFieldInfo = getFieldInfo(targetModel, targetField);
  if (!targetFieldInfo) {
    const suggestions = findSimilarFields(targetModel, targetField);
    return {
      valid: false,
      error: `Field '${targetField}' not found in target model '${targetModel}'`,
      suggestion: suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}? (in ${targetModel})`
        : `Check available fields in ${targetModel}`
    };
  }

  // All checks passed
  return {
    valid: true,
    fkInfo,
    targetModel,
    targetFieldInfo
  };
}

/**
 * Get the target model for an FK field
 *
 * @param modelName - Source model
 * @param fkField - FK field name
 * @returns Target model name or undefined
 */
export function getFKTargetModel(modelName: string, fkField: string): string | undefined {
  const fkInfo = getFieldInfo(modelName, fkField);
  if (!fkInfo || !fkInfo.is_fk) {
    return undefined;
  }
  return fkInfo.fk_target_model;
}

// =============================================================================
// ERROR FORMATTING
// =============================================================================

/**
 * Format validation errors for display
 */
export function formatValidationErrors(errors: ValidationError[], warnings: ValidationWarning[] = []): string {
  const lines: string[] = [];

  lines.push('# Query Validation Failed\n');

  for (const error of errors) {
    lines.push(`**Error:** ${error.message}`);
    if (error.suggestion) {
      lines.push(`**Suggestion:** ${error.suggestion}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('## Warnings\n');
    for (const warning of warnings) {
      lines.push(`- ${warning.message}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Use semantic_search to discover available fields for a model.*');

  return lines.join('\n');
}

// =============================================================================
// PAYLOAD INDEX VALIDATION
// =============================================================================

/**
 * Set of fields that have Qdrant payload indexes
 *
 * These fields can be efficiently filtered in Qdrant.
 * Fields NOT in this set will cause slow scans or errors.
 *
 * IMPORTANT: Keep in sync with UNIFIED_INDEXES in vector-client.ts
 */
export const INDEXED_FIELDS = new Set([
  // Common indexes (all point types)
  'point_type', 'model_name', 'model_id',

  // Schema-specific indexes
  'field_name', 'field_type', 'stored', 'field_id',
  'fk_location_model', 'fk_qdrant_id', 'primary_data_location',

  // Data-specific indexes
  'record_id',

  // account.move.line fields
  'account_id_id', 'date', 'parent_state', 'journal_id_id',
  'partner_id_id', 'move_id_id', 'debit', 'credit', 'balance',

  // crm.lead fields
  'stage_id_id', 'user_id_id', 'team_id_id', 'probability',
  'expected_revenue', 'active', 'name', 'opportunity_type', 'create_date',

  // res.partner (contact) fields
  'is_company', 'customer_rank', 'supplier_rank',

  // FK Qdrant reference indexes (for graph traversal)
  'partner_id_qdrant', 'user_id_qdrant', 'company_id_qdrant',
  'move_id_qdrant', 'account_id_qdrant', 'journal_id_qdrant',
  'stage_id_qdrant', 'team_id_qdrant', 'currency_id_qdrant',

  // Graph-specific indexes
  'source_model', 'target_model', 'is_leaf',

  // === Excel data fields (actual model - DuraCube financial data) ===
  // IMPORTANT: Keep in sync with UNIFIED_INDEXES in vector-client.ts
  'Month',                  // Excel serial date as Unix timestamp (ms)
  'Amount',                 // Transaction amount (debit positive, credit negative)
  'Entity',                 // Business segment: Product, Installation, Freight, Other
  'F1',                     // Level 1 classification: REV, VCOS, FCOS, OH
  'Classification',         // Full account type (if present in schema)
  'Account_id',             // FK to master model (account ID)
  'Account_id_qdrant',      // FK Qdrant reference for graph traversal

  // === Excel data fields (master model - Chart of Accounts) ===
  'Id',                     // Primary key in master model
  'Gllinkname',             // GL account name/link
  'EBITA',                  // EBITDA flag (Y/N)
  'Type2',                  // Statement type: BS (Balance Sheet) or PL (Profit & Loss)
  'F1_des',                 // F1 description
  'DCFL_6',                 // DCFL classification

  // === Additional Excel fields (for complete coverage) ===
  'Account_id_id',          // FK reference to master (integer ID)
  'id',                     // Generic ID field (lowercase)
  // NOTE: Fields with special characters cannot be indexed in Qdrant:
  // - 'Master[EBITA]' - brackets not allowed in index names
  // - 'Account Name' - spaces not allowed in index names
  // These fields ARE in payload but validation will reject filter queries on them.
  // Users should use semantic_search for these fields instead.
]);

/**
 * Check if a field has a Qdrant payload index
 *
 * @param fieldName - The payload field name to check
 * @returns true if the field is indexed, false otherwise
 */
export function isFieldIndexed(fieldName: string): boolean {
  return INDEXED_FIELDS.has(fieldName);
}

/**
 * Register fields as indexed dynamically.
 * Called after creating indexes to enable filtering in the current session.
 *
 * This allows the update-payload command to create indexes and immediately
 * use them for filtering without requiring a server restart.
 *
 * @param fields - Array of field names to register as indexed
 */
export function registerIndexedFields(fields: string[]): void {
  for (const field of fields) {
    INDEXED_FIELDS.add(field);
  }
  console.error(`[SchemaLookup] Registered ${fields.length} fields as indexed`);
}
