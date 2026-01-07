/**
 * Excel Knowledge Loader
 *
 * Loads extended knowledge from Excel file for the 4-level knowledge template:
 * - Level 2: Instance Config (Sheet: Instance_Config)
 * - Level 3: Model Metadata (Sheet: Model_Metadata)
 * - Level 4: Field Knowledge (Extended columns in Schema sheet)
 *
 * Usage:
 * ```typescript
 * const excelPath = 'samples/Nexsus1_schema.xlsx';
 *
 * // Load Level 2 - Instance Config
 * const instanceConfigs = loadInstanceConfig(excelPath);
 *
 * // Load Level 3 - Model Metadata
 * const modelMetadata = loadModelMetadata(excelPath);
 *
 * // Load Level 4 - Field Knowledge (from extended schema columns)
 * const fieldKnowledge = loadFieldKnowledge(excelPath);
 * ```
 *
 * Excel File Structure:
 * - Sheet 1: Schema (existing + 6 new columns L-Q for Level 4)
 * - Sheet 2: Model_Metadata (Level 3)
 * - Sheet 3: Instance_Config (Level 2)
 */

import XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { NEXSUS_CONFIG } from '../../../common/constants.js';
import type { SimpleSchemaRow } from '../../../common/types.js';
import {
  InstanceConfigRowSchema,
  ModelMetadataRowSchema,
  ExtendedSchemaRowSchema,
  validateInstanceConfigBatch,
  validateModelMetadataBatch,
  checkRequiredInstanceConfigs,
  validateModelMetadataReferences,
  hasFieldKnowledge,
  type InstanceConfigRow,
  type ModelMetadataRow,
  type ExtendedSchemaRow,
} from '../schemas/index.js';

// =============================================================================
// SHEET NAMES
// =============================================================================

/**
 * Expected sheet names in the Excel file
 */
export const KNOWLEDGE_SHEET_NAMES = {
  SCHEMA: 'Schema',           // Sheet 1 - existing + Level 4 columns
  MODEL_METADATA: 'Model_Metadata',  // Sheet 2 - Level 3
  INSTANCE_CONFIG: 'Instance_Config', // Sheet 3 - Level 2
} as const;

// =============================================================================
// LOADER RESULT TYPES
// =============================================================================

/**
 * Result of loading instance config from Excel
 */
export interface InstanceConfigLoadResult {
  success: boolean;
  rows: InstanceConfigRow[];
  errors: string[];
  warnings: string[];
  sheetFound: boolean;
  completeness: {
    complete: boolean;
    missing: Record<string, string[]>;
  };
}

/**
 * Result of loading model metadata from Excel
 */
export interface ModelMetadataLoadResult {
  success: boolean;
  rows: ModelMetadataRow[];
  errors: string[];
  warnings: string[];
  sheetFound: boolean;
}

/**
 * Result of loading field knowledge from Excel
 */
export interface FieldKnowledgeLoadResult {
  success: boolean;
  rows: ExtendedSchemaRow[];
  totalFields: number;
  fieldsWithKnowledge: number;
  errors: string[];
  warnings: string[];
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Find sheet by name (case-insensitive)
 */
function findSheet(workbook: XLSX.WorkBook, sheetName: string): string | undefined {
  return workbook.SheetNames.find(
    name => name.toLowerCase() === sheetName.toLowerCase()
  );
}

/**
 * Normalize header names (trim, handle leading spaces)
 */
function normalizeHeader(header: string): string {
  return header.trim().replace(/^\s+/, '');
}

/**
 * Parse boolean from Excel value
 */
function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return lower === 'yes' || lower === 'true' || lower === '1';
  }
  return false;
}

/**
 * Parse number from Excel value
 */
function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

// =============================================================================
// LEVEL 2: INSTANCE CONFIG LOADER
// =============================================================================

/**
 * Load Instance Config (Level 2) from Excel
 *
 * Reads the Instance_Config sheet and validates against the schema.
 * Returns all configuration rows with validation results.
 *
 * @param excelPath - Path to Excel file (defaults to NEXSUS_CONFIG.EXCEL_FILE)
 * @returns Load result with rows, errors, and completeness check
 */
export function loadInstanceConfig(excelPath?: string): InstanceConfigLoadResult {
  const result: InstanceConfigLoadResult = {
    success: false,
    rows: [],
    errors: [],
    warnings: [],
    sheetFound: false,
    completeness: {
      complete: false,
      missing: {},
    },
  };

  const filePath = excelPath || path.resolve(process.cwd(), NEXSUS_CONFIG.EXCEL_FILE);

  if (!fs.existsSync(filePath)) {
    result.errors.push(`Excel file not found: ${filePath}`);
    return result;
  }

  try {
    const workbook = XLSX.readFile(filePath);

    // Find Instance_Config sheet
    const sheetName = findSheet(workbook, KNOWLEDGE_SHEET_NAMES.INSTANCE_CONFIG);

    if (!sheetName) {
      result.warnings.push(
        `Sheet "${KNOWLEDGE_SHEET_NAMES.INSTANCE_CONFIG}" not found. ` +
        `Available sheets: ${workbook.SheetNames.join(', ')}`
      );
      result.success = true; // Not an error - sheet is optional
      return result;
    }

    result.sheetFound = true;
    const sheet = workbook.Sheets[sheetName];

    // Parse Excel to JSON
    const rawData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    console.error(`[KnowledgeLoader] Found ${rawData.length} rows in Instance_Config sheet`);

    // Transform raw data to match schema expectations
    const transformedRows = rawData.map((raw) => ({
      Config_Key: String(raw['Config_Key'] || '').trim(),
      Config_Value: String(raw['Config_Value'] || '').trim(),
      Config_Category: String(raw['Config_Category'] || '').trim(),
      Description: String(raw['Description'] || '').trim(),
      Applies_To: String(raw['Applies_To'] || 'all').trim(),
      LLM_Instruction: String(raw['LLM_Instruction'] || '').trim(),
      Last_Updated: raw['Last_Updated'] ? String(raw['Last_Updated']) : undefined,
    }));

    // Validate using Zod
    const validation = validateInstanceConfigBatch(transformedRows);

    if (!validation.valid) {
      result.errors = validation.errors.map(e => `Row ${e.index + 2}: ${e.error}`);
    }

    result.rows = validation.validRows;

    // Check completeness
    result.completeness = checkRequiredInstanceConfigs(result.rows);

    if (!result.completeness.complete) {
      for (const [category, missing] of Object.entries(result.completeness.missing)) {
        result.warnings.push(
          `Missing ${category} configs: ${missing.join(', ')}`
        );
      }
    }

    result.success = validation.valid;
    console.error(
      `[KnowledgeLoader] Loaded ${result.rows.length} instance configs ` +
      `(${result.errors.length} errors, ${result.warnings.length} warnings)`
    );

  } catch (error) {
    result.errors.push(`Failed to load Instance_Config: ${error}`);
  }

  return result;
}

// =============================================================================
// LEVEL 3: MODEL METADATA LOADER
// =============================================================================

/**
 * Load Model Metadata (Level 3) from Excel
 *
 * Reads the Model_Metadata sheet and validates against the schema.
 * Returns all model metadata rows with validation results.
 *
 * @param excelPath - Path to Excel file (defaults to NEXSUS_CONFIG.EXCEL_FILE)
 * @returns Load result with rows and errors
 */
export function loadModelMetadata(excelPath?: string): ModelMetadataLoadResult {
  const result: ModelMetadataLoadResult = {
    success: false,
    rows: [],
    errors: [],
    warnings: [],
    sheetFound: false,
  };

  const filePath = excelPath || path.resolve(process.cwd(), NEXSUS_CONFIG.EXCEL_FILE);

  if (!fs.existsSync(filePath)) {
    result.errors.push(`Excel file not found: ${filePath}`);
    return result;
  }

  try {
    const workbook = XLSX.readFile(filePath);

    // Find Model_Metadata sheet
    const sheetName = findSheet(workbook, KNOWLEDGE_SHEET_NAMES.MODEL_METADATA);

    if (!sheetName) {
      result.warnings.push(
        `Sheet "${KNOWLEDGE_SHEET_NAMES.MODEL_METADATA}" not found. ` +
        `Available sheets: ${workbook.SheetNames.join(', ')}`
      );
      result.success = true; // Not an error - sheet is optional
      return result;
    }

    result.sheetFound = true;
    const sheet = workbook.Sheets[sheetName];

    // Parse Excel to JSON
    const rawData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    console.error(`[KnowledgeLoader] Found ${rawData.length} rows in Model_Metadata sheet`);

    // Transform raw data to match schema expectations
    const transformedRows = rawData.map((raw) => ({
      Model_ID: parseNumber(raw['Model_ID']) || 0,
      Model_Name: String(raw['Model_Name'] || '').trim(),
      Business_Name: String(raw['Business_Name'] || '').trim(),
      Business_Purpose: String(raw['Business_Purpose'] || '').trim(),
      Data_Grain: String(raw['Data_Grain'] || '').trim(),
      Record_Count: parseNumber(raw['Record_Count']),
      Is_Payload_Enabled: parseBoolean(raw['Is_Payload_Enabled']),
      Primary_Use_Cases: String(raw['Primary_Use_Cases'] || '').trim(),
      Key_Relationships: raw['Key_Relationships'] ? String(raw['Key_Relationships']).trim() : undefined,
      LLM_Query_Guidance: String(raw['LLM_Query_Guidance'] || '').trim(),
      Known_Issues: raw['Known_Issues'] ? String(raw['Known_Issues']).trim() : undefined,
      Last_Updated: raw['Last_Updated'] ? String(raw['Last_Updated']) : undefined,
    }));

    // Validate using Zod
    const validation = validateModelMetadataBatch(transformedRows);

    if (!validation.valid) {
      result.errors = validation.errors.map(e => `Row ${e.index + 2}: ${e.error}`);
    }

    result.rows = validation.validRows;
    result.success = validation.valid;

    console.error(
      `[KnowledgeLoader] Loaded ${result.rows.length} model metadata rows ` +
      `(${result.errors.length} errors)`
    );

  } catch (error) {
    result.errors.push(`Failed to load Model_Metadata: ${error}`);
  }

  return result;
}

// =============================================================================
// LEVEL 4: FIELD KNOWLEDGE LOADER
// =============================================================================

/**
 * Load Field Knowledge (Level 4) from Schema sheet
 *
 * Reads the Schema sheet including the 6 new knowledge columns (L-Q).
 * Returns all rows, marking which ones have knowledge defined.
 *
 * @param excelPath - Path to Excel file (defaults to NEXSUS_CONFIG.EXCEL_FILE)
 * @returns Load result with extended schema rows
 */
export function loadFieldKnowledge(excelPath?: string): FieldKnowledgeLoadResult {
  const result: FieldKnowledgeLoadResult = {
    success: false,
    rows: [],
    totalFields: 0,
    fieldsWithKnowledge: 0,
    errors: [],
    warnings: [],
  };

  const filePath = excelPath || path.resolve(process.cwd(), NEXSUS_CONFIG.EXCEL_FILE);

  if (!fs.existsSync(filePath)) {
    result.errors.push(`Excel file not found: ${filePath}`);
    return result;
  }

  try {
    const workbook = XLSX.readFile(filePath);

    // Find Schema sheet (try multiple names)
    let sheetName = findSheet(workbook, KNOWLEDGE_SHEET_NAMES.SCHEMA);
    if (!sheetName) {
      // Fallback to first sheet (often the schema sheet)
      sheetName = workbook.SheetNames[0];
      result.warnings.push(
        `Sheet "${KNOWLEDGE_SHEET_NAMES.SCHEMA}" not found. Using first sheet: ${sheetName}`
      );
    }

    const sheet = workbook.Sheets[sheetName];

    // Parse Excel to JSON
    const rawData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    console.error(`[KnowledgeLoader] Found ${rawData.length} rows in Schema sheet`);

    // Filter out empty rows
    const validRows = rawData.filter((raw) => {
      const hasFieldId = raw['Field_ID'] !== undefined && raw['Field_ID'] !== '';
      const hasModelId = raw['Model_ID'] !== undefined && raw['Model_ID'] !== '';
      return hasFieldId || hasModelId;
    });

    result.totalFields = validRows.length;

    // Transform to ExtendedSchemaRow format
    const extendedRows: ExtendedSchemaRow[] = [];

    for (let i = 0; i < validRows.length; i++) {
      const raw = validRows[i] as Record<string, unknown>;

      try {
        // Get FK metadata (handle column names with/without leading spaces)
        const getFkField = <T>(fieldName: string): T | undefined => {
          if (raw[fieldName] !== undefined && raw[fieldName] !== '') {
            return raw[fieldName] as T;
          }
          if (raw[` ${fieldName}`] !== undefined && raw[` ${fieldName}`] !== '') {
            return raw[` ${fieldName}`] as T;
          }
          return undefined;
        };

        const row: ExtendedSchemaRow = {
          // Core schema fields
          Field_ID: parseNumber(raw['Field_ID']) || 0,
          Model_ID: parseNumber(raw['Model_ID']) || 0,
          Field_Name: String(raw['Field_Name'] || '').trim(),
          Field_Label: String(raw['Field_Label'] || '').trim(),
          Field_Type: String(raw['Field_Type'] || '').trim(),
          Model_Name: String(raw['Model_Name'] || '').trim(),
          Stored: String(raw['Stored'] || 'No').trim(),

          // FK fields (optional)
          'FK location field model': getFkField<string>('FK location field model'),
          'FK location field model id': getFkField<number>('FK location field model id'),
          'FK location record Id': getFkField<number>('FK location record Id'),
          'Qdrant ID for FK': getFkField<string>('Qdrant ID for FK'),

          // New Level 4 knowledge fields (columns L-Q)
          Field_Knowledge: raw['Field_Knowledge'] ? String(raw['Field_Knowledge']).trim() : undefined,
          Valid_Values: raw['Valid_Values'] ? String(raw['Valid_Values']).trim() : undefined,
          Data_Format: raw['Data_Format'] ? String(raw['Data_Format']).trim() : undefined,
          Calculation_Formula: raw['Calculation_Formula'] ? String(raw['Calculation_Formula']).trim() : undefined,
          Validation_Rules: raw['Validation_Rules'] ? String(raw['Validation_Rules']).trim() : undefined,
          LLM_Usage_Notes: raw['LLM_Usage_Notes'] ? String(raw['LLM_Usage_Notes']).trim() : undefined,
        };

        // Validate row
        const validated = ExtendedSchemaRowSchema.safeParse(row);

        if (validated.success) {
          extendedRows.push(validated.data);

          // Count fields with knowledge
          if (hasFieldKnowledge(validated.data)) {
            result.fieldsWithKnowledge++;
          }
        } else {
          result.warnings.push(
            `Row ${i + 2}: Validation warning - ${validated.error.message}`
          );
          // Still add the row even with validation warnings (backward compatibility)
          extendedRows.push(row);
        }

      } catch (error) {
        result.errors.push(`Row ${i + 2}: Parse error - ${error}`);
      }
    }

    result.rows = extendedRows;
    result.success = result.errors.length === 0;

    console.error(
      `[KnowledgeLoader] Loaded ${result.rows.length} fields, ` +
      `${result.fieldsWithKnowledge} with knowledge defined`
    );

  } catch (error) {
    result.errors.push(`Failed to load Field Knowledge: ${error}`);
  }

  return result;
}

// =============================================================================
// COMBINED LOADER
// =============================================================================

/**
 * Complete knowledge load result from all levels
 */
export interface AllKnowledgeLoadResult {
  success: boolean;
  instanceConfig: InstanceConfigLoadResult;
  modelMetadata: ModelMetadataLoadResult;
  fieldKnowledge: FieldKnowledgeLoadResult;
  summary: {
    totalLevel2Configs: number;
    totalLevel3Models: number;
    totalLevel4Fields: number;
    fieldsWithKnowledge: number;
    allSheetsFound: boolean;
    errors: string[];
    warnings: string[];
  };
}

/**
 * Load all knowledge levels from Excel file
 *
 * Convenience function to load all three knowledge levels at once.
 *
 * @param excelPath - Path to Excel file (defaults to NEXSUS_CONFIG.EXCEL_FILE)
 * @returns Combined load result for all levels
 */
export function loadAllKnowledge(excelPath?: string): AllKnowledgeLoadResult {
  const instanceConfig = loadInstanceConfig(excelPath);
  const modelMetadata = loadModelMetadata(excelPath);
  const fieldKnowledge = loadFieldKnowledge(excelPath);

  const allErrors = [
    ...instanceConfig.errors,
    ...modelMetadata.errors,
    ...fieldKnowledge.errors,
  ];

  const allWarnings = [
    ...instanceConfig.warnings,
    ...modelMetadata.warnings,
    ...fieldKnowledge.warnings,
  ];

  return {
    success: instanceConfig.success && modelMetadata.success && fieldKnowledge.success,
    instanceConfig,
    modelMetadata,
    fieldKnowledge,
    summary: {
      totalLevel2Configs: instanceConfig.rows.length,
      totalLevel3Models: modelMetadata.rows.length,
      totalLevel4Fields: fieldKnowledge.totalFields,
      fieldsWithKnowledge: fieldKnowledge.fieldsWithKnowledge,
      allSheetsFound: instanceConfig.sheetFound && modelMetadata.sheetFound,
      errors: allErrors,
      warnings: allWarnings,
    },
  };
}

// =============================================================================
// CROSS-LEVEL VALIDATION
// =============================================================================

/**
 * Validate cross-level consistency
 *
 * Checks that:
 * 1. Model_IDs in Model_Metadata exist in Schema
 * 2. Model names in Instance_Config SYNCED_MODELS match Model_Metadata
 * 3. Field knowledge Model_IDs exist
 *
 * @param knowledge - Result from loadAllKnowledge
 * @returns Validation result with any inconsistencies
 */
export function validateCrossLevelConsistency(
  knowledge: AllKnowledgeLoadResult
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Get all Model_IDs from schema
  const schemaModelIds = new Set(
    knowledge.fieldKnowledge.rows.map(r => r.Model_ID)
  );

  // 1. Check Model_Metadata references schema Model_IDs
  if (knowledge.modelMetadata.rows.length > 0) {
    const metadataValidation = validateModelMetadataReferences(
      knowledge.modelMetadata.rows,
      schemaModelIds
    );

    if (!metadataValidation.valid) {
      errors.push(
        `Model_Metadata has orphan Model_IDs not in schema: ${metadataValidation.orphanModels.join(', ')}`
      );
    }

    if (metadataValidation.missingMetadata.length > 0) {
      warnings.push(
        `Schema models without metadata: ${metadataValidation.missingMetadata.join(', ')}`
      );
    }
  }

  // 2. Check SYNCED_MODELS in Instance_Config matches Model_Metadata
  const syncedModelsConfig = knowledge.instanceConfig.rows.find(
    r => r.Config_Key === 'SYNCED_MODELS'
  );

  if (syncedModelsConfig && knowledge.modelMetadata.rows.length > 0) {
    const syncedModels = syncedModelsConfig.Config_Value.split(',').map(s => s.trim());
    const metadataModels = new Set(knowledge.modelMetadata.rows.map(r => r.Model_Name));

    for (const model of syncedModels) {
      if (!metadataModels.has(model)) {
        warnings.push(
          `SYNCED_MODELS includes "${model}" but no Model_Metadata entry exists`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// =============================================================================
// AGGREGATION FIELD DETECTION (AUTO-DETECTED FROM SCHEMA)
// =============================================================================

/**
 * Numeric types that support full aggregation (SUM, AVG, MIN, MAX, COUNT)
 */
const AGGREGATION_NUMERIC_TYPES = new Set(['integer', 'float', 'monetary']);

/**
 * Date types that support limited aggregation (MIN, MAX, COUNT only)
 */
const AGGREGATION_DATE_TYPES = new Set(['date', 'datetime']);

/**
 * Information about a field's aggregation capabilities
 */
export interface AggregationFieldInfo {
  fieldName: string;
  fieldType: string;
  supportedOps: ('sum' | 'avg' | 'min' | 'max' | 'count')[];
}

/**
 * Get aggregation-safe fields from schema based on Field_Type
 *
 * Automatically determines which fields can be aggregated based on their data type:
 * - integer, float, monetary → SUM, AVG, MIN, MAX, COUNT
 * - date, datetime → MIN, MAX, COUNT only
 *
 * This replaces manual AGGREGATION_SAFE_FIELDS configuration.
 *
 * @param schemaRows - Schema rows (can be ExtendedSchemaRow or SimpleSchemaRow)
 * @returns Map of model names to their aggregation-safe fields
 *
 * @example
 * const safeFields = getAggregationSafeFields(loadFieldKnowledge().rows);
 * // Returns: Map {
 * //   'actual' => [{ fieldName: 'Amount', fieldType: 'integer', supportedOps: ['sum', 'avg', 'min', 'max', 'count'] }],
 * //   'master' => [{ fieldName: 'id', fieldType: 'integer', supportedOps: ['sum', 'avg', 'min', 'max', 'count'] }]
 * // }
 */
export function getAggregationSafeFields(
  schemaRows: Array<{ Model_Name: string; Field_Name: string; Field_Type: string }>
): Map<string, AggregationFieldInfo[]> {
  const result = new Map<string, AggregationFieldInfo[]>();

  for (const row of schemaRows) {
    const fieldType = row.Field_Type.toLowerCase();
    let supportedOps: AggregationFieldInfo['supportedOps'] = [];

    if (AGGREGATION_NUMERIC_TYPES.has(fieldType)) {
      // Numeric types support all aggregation operations
      supportedOps = ['sum', 'avg', 'min', 'max', 'count'];
    } else if (AGGREGATION_DATE_TYPES.has(fieldType)) {
      // Date types only support MIN, MAX, COUNT (not SUM, AVG)
      supportedOps = ['min', 'max', 'count'];
    }

    if (supportedOps.length > 0) {
      if (!result.has(row.Model_Name)) {
        result.set(row.Model_Name, []);
      }
      result.get(row.Model_Name)!.push({
        fieldName: row.Field_Name,
        fieldType: row.Field_Type,
        supportedOps,
      });
    }
  }

  return result;
}

/**
 * Get aggregation-safe fields for a specific model
 *
 * @param modelName - The model to check
 * @param excelPath - Optional path to Excel file
 * @returns Array of aggregation-safe field info for the model
 */
export function getAggregationSafeFieldsForModel(
  modelName: string,
  excelPath?: string
): AggregationFieldInfo[] {
  const { rows } = loadFieldKnowledge(excelPath);
  const allFields = getAggregationSafeFields(rows);
  return allFields.get(modelName) || [];
}

/**
 * Check if a specific field supports a given aggregation operation
 *
 * @param modelName - The model name
 * @param fieldName - The field name
 * @param operation - The aggregation operation to check
 * @param excelPath - Optional path to Excel file
 * @returns true if the field supports the operation
 */
export function isFieldAggregationSafe(
  modelName: string,
  fieldName: string,
  operation: 'sum' | 'avg' | 'min' | 'max' | 'count',
  excelPath?: string
): boolean {
  const modelFields = getAggregationSafeFieldsForModel(modelName, excelPath);
  const fieldInfo = modelFields.find(f => f.fieldName === fieldName);

  if (!fieldInfo) {
    return false;
  }

  return fieldInfo.supportedOps.includes(operation);
}
