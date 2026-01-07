/**
 * Simple Schema Converter
 *
 * Converts user's simplified schema format to internal NexsusSchemaRow format.
 *
 * Supports two schema formats:
 * 1. Simple Format (11 columns - backward compatible):
 *    - Field_ID, Model_ID, Field_Name, Field_Label, Field_Type, Model_Name,
 *      Stored, FK location field model, FK location field model id, FK location record Id,
 *      Qdrant ID for FK
 *
 * 2. Extended Format (17 columns - with Level 4 Knowledge):
 *    - All 11 Simple columns PLUS:
 *    - Field_Knowledge (L), Valid_Values (M), Data_Format (N),
 *      Calculation_Formula (O), Validation_Rules (P), LLM_Usage_Notes (Q)
 *
 * Internal Format (NexsusSchemaRow):
 * - 3 columns: Qdrant ID (UUID), Vector (semantic text), Payload (key-value string)
 * - Auto-generated semantic text for embedding (includes Level 4 knowledge if present)
 * - Auto-generated V2 UUIDs
 * - FK metadata preserved for knowledge graph construction
 *
 * CRITICAL: FK metadata (FK location field model id, FK location record Id) must be
 * preserved in both semantic_text and raw_payload to enable knowledge graph edge creation.
 *
 * BACKWARD COMPATIBILITY: New Level 4 columns are optional. Schema files without
 * these columns will continue to work exactly as before.
 */

import { buildSchemaUuidV2Simple, buildSchemaFkRefUuidV2 } from '../utils/uuid-v2.js';
import type { SimpleSchemaRow, NexsusSchemaRow } from '../types.js';

/**
 * Validation result for simple schema
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Helper function to get FK metadata field, handling column names with/without leading spaces
 *
 * Excel sometimes adds leading spaces to column headers. This function tries both versions.
 */
function getFkField<T>(row: any, fieldName: string): T | undefined {
  // Try exact match first
  if (row[fieldName] !== undefined) {
    return row[fieldName] as T;
  }
  // Try with leading space
  if (row[` ${fieldName}`] !== undefined) {
    return row[` ${fieldName}`] as T;
  }
  return undefined;
}

/**
 * Validate simple schema rows
 *
 * Checks:
 * - Field_ID is numeric and unique
 * - Model_ID is numeric
 * - Required fields present
 * - FK fields have complete FK metadata (warns if incomplete)
 *
 * @param rows - Simple schema rows to validate
 * @returns Validation result with errors and warnings
 */
export function validateSimpleSchema(rows: SimpleSchemaRow[]): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  if (!rows || rows.length === 0) {
    result.valid = false;
    result.errors.push('Schema is empty or undefined');
    return result;
  }

  // Track Field_ID uniqueness
  const fieldIdMap = new Map<number, number>();

  rows.forEach((row, index) => {
    const rowNum = index + 2; // Excel row (1-indexed header + data)

    // Skip completely empty rows (common at end of Excel files)
    // XLSX may return empty cells as undefined, null, empty string, or not present at all
    // Use type coercion to handle edge cases
    const hasFieldId =
      row.Field_ID !== undefined && row.Field_ID !== null && String(row.Field_ID).trim() !== '';
    const hasModelId =
      row.Model_ID !== undefined && row.Model_ID !== null && String(row.Model_ID).trim() !== '';
    const hasFieldName = row.Field_Name && String(row.Field_Name).trim() !== '';
    const hasModelName = row.Model_Name && String(row.Model_Name).trim() !== '';

    const isEmptyRow = !hasFieldId && !hasModelId && !hasFieldName && !hasModelName;

    if (isEmptyRow) {
      return; // Skip this row
    }

    // Check Field_ID
    if (row.Field_ID === undefined || row.Field_ID === null) {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Field_ID is missing`);
    } else if (isNaN(row.Field_ID)) {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Field_ID "${row.Field_ID}" is not a valid number`);
    } else {
      // Check uniqueness
      if (fieldIdMap.has(row.Field_ID)) {
        result.valid = false;
        result.errors.push(
          `Duplicate Field_ID ${row.Field_ID} found in rows ${fieldIdMap.get(row.Field_ID)} and ${rowNum}`,
        );
      } else {
        fieldIdMap.set(row.Field_ID, rowNum);
      }
    }

    // Check Model_ID
    if (row.Model_ID === undefined || row.Model_ID === null) {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Model_ID is missing`);
    } else if (isNaN(row.Model_ID)) {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Model_ID "${row.Model_ID}" is not a valid number`);
    }

    // Check required string fields
    if (!row.Field_Name || row.Field_Name.trim() === '') {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Field_Name is missing or empty`);
    }

    if (!row.Field_Type || row.Field_Type.trim() === '') {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Field_Type is missing or empty`);
    }

    if (!row.Model_Name || row.Model_Name.trim() === '') {
      result.valid = false;
      result.errors.push(`Row ${rowNum}: Model_Name is missing or empty`);
    }

    // Check FK field completeness (warn, don't error)
    const isFkField = ['many2one', 'many2many', 'one2many'].includes(
      row.Field_Type?.toLowerCase() || '',
    );

    if (isFkField) {
      const fkModel = getFkField<string>(row, 'FK location field model');
      const fkModelId = getFkField<number>(row, 'FK location field model id');
      const fkRecordId = getFkField<number>(row, 'FK location record Id');

      if (!fkModel) {
        result.warnings.push(
          `Row ${rowNum}: FK field "${row.Field_Name}" missing FK location field model`,
        );
      }
      if (fkModelId === undefined || fkModelId === null) {
        result.warnings.push(
          `Row ${rowNum}: FK field "${row.Field_Name}" missing FK location field model id`,
        );
      }
      if (fkRecordId === undefined || fkRecordId === null) {
        result.warnings.push(
          `Row ${rowNum}: FK field "${row.Field_Name}" missing FK location record Id`,
        );
      }
    }
  });

  return result;
}

/**
 * Generate semantic text for embedding
 *
 * Creates natural language description of field for vector search.
 * Template matches existing V2 format for consistency.
 *
 * CRITICAL: FK metadata MUST be included in semantic text to enable
 * knowledge graph edge creation and traversal.
 *
 * ENHANCEMENT: If Level 4 knowledge columns are present (Field_Knowledge,
 * Valid_Values, etc.), they are appended to enrich the semantic embedding.
 *
 * @param row - Simple schema row (may include Level 4 knowledge columns)
 * @param fkUuid - Optional FK Qdrant UUID (for many2one fields)
 * @returns Semantic text string for embedding
 */
export function generateSemanticText(row: SimpleSchemaRow, fkUuid?: string): string {
  // Base semantic text
  let text =
    `In model ${row.Model_Name}, ` +
    `Field_ID - ${row.Field_ID}, ` +
    `Model_ID - ${row.Model_ID}, ` +
    `Field_Name - ${row.Field_Name}, ` +
    `Field_Label - ${row.Field_Label}, ` +
    `Field_Type - ${row.Field_Type}, ` +
    `Model_Name - ${row.Model_Name}, ` +
    `Stored - ${row.Stored}`;

  // CRITICAL: Append FK metadata for knowledge graph (handle leading spaces)
  const fkModel = getFkField<string>(row, 'FK location field model');
  const fkModelId = getFkField<number>(row, 'FK location field model id');
  const fkRecordId = getFkField<number>(row, 'FK location record Id');

  if (fkModel) {
    text += `, FK location field model - ${fkModel}`;
  }

  if (fkModelId !== undefined && fkModelId !== null) {
    text += `, FK location field model id - ${fkModelId}`;
  }

  if (fkRecordId !== undefined && fkRecordId !== null) {
    text += `, FK location record Id - ${fkRecordId}`;
  }

  // Add FK Qdrant UUID if available (CRITICAL for graph traversal)
  if (fkUuid) {
    text += `, Qdrant ID for FK - ${fkUuid}`;
  }

  // ENHANCEMENT: Append Level 4 Knowledge columns if present (backward compatible)
  // These columns are optional and enhance the semantic embedding for better search
  const rowAny = row as unknown as Record<string, unknown>;

  const fieldKnowledge = rowAny['Field_Knowledge'];
  if (fieldKnowledge && String(fieldKnowledge).trim()) {
    text += `. Field meaning: ${String(fieldKnowledge).trim()}`;
  }

  const validValues = rowAny['Valid_Values'];
  if (validValues && String(validValues).trim()) {
    text += `. Valid values: ${String(validValues).trim()}`;
  }

  const dataFormat = rowAny['Data_Format'];
  if (dataFormat && String(dataFormat).trim()) {
    text += `. Format: ${String(dataFormat).trim()}`;
  }

  const calculationFormula = rowAny['Calculation_Formula'];
  if (calculationFormula && String(calculationFormula).trim()) {
    text += `. Formula: ${String(calculationFormula).trim()}`;
  }

  const llmUsageNotes = rowAny['LLM_Usage_Notes'];
  if (llmUsageNotes && String(llmUsageNotes).trim()) {
    text += `. LLM guidance: ${String(llmUsageNotes).trim()}`;
  }

  return text;
}

/**
 * Generate payload string for Qdrant storage
 *
 * Creates key-value string matching V2 format that will be parsed
 * by existing payload parsing logic.
 *
 * CRITICAL: FK metadata MUST be included in payload to enable
 * knowledge graph edge creation during data sync.
 *
 * @param row - Simple schema row
 * @param uuid - Generated V2 UUID for this field
 * @returns Payload string for Qdrant storage
 */
export function generatePayloadString(row: SimpleSchemaRow, uuid: string): string {
  // Base payload
  let payload =
    `point_id - ${uuid}, ` +
    `Data_type - 3, ` +
    `Field_ID - ${row.Field_ID}, ` +
    `Model_ID - ${row.Model_ID}, ` +
    `Field_Name - ${row.Field_Name}, ` +
    `Field_Label - ${row.Field_Label}, ` +
    `Field_Type - ${row.Field_Type}, ` +
    `Model_Name - ${row.Model_Name}, ` +
    `Stored - ${row.Stored}`;

  // CRITICAL: Append FK metadata for knowledge graph (handle leading spaces)
  const fkModel = getFkField<string>(row, 'FK location field model');
  const fkModelId = getFkField<number>(row, 'FK location field model id');
  const fkRecordId = getFkField<number>(row, 'FK location record Id');

  if (fkModel) {
    payload += `, FK location field model - ${fkModel}`;
  }

  if (fkModelId !== undefined && fkModelId !== null) {
    payload += `, FK location field model id - ${fkModelId}`;
  }

  if (fkRecordId !== undefined && fkRecordId !== null) {
    payload += `, FK location record Id - ${fkRecordId}`;
  }

  return payload;
}

/**
 * Convert simple schema rows to NexsusSchemaRow format
 *
 * Main conversion function that:
 * 1. Validates input rows
 * 2. Generates V2 UUIDs for each field
 * 3. Generates FK reference UUIDs if FK field
 * 4. Generates semantic text for embedding
 * 5. Generates payload string for storage
 * 6. Returns converted NexsusSchemaRow[] format
 *
 * @param rows - Simple schema rows from user's Excel file
 * @returns Converted NexsusSchemaRow[] ready for sync
 * @throws Error if validation fails
 */
export function convertSimpleSchemaToNexsus(rows: SimpleSchemaRow[]): NexsusSchemaRow[] {
  // Validate input
  const validation = validateSimpleSchema(rows);

  if (!validation.valid) {
    const errorMessage =
      '❌ Schema validation failed:\n' + validation.errors.map((e) => `  - ${e}`).join('\n');
    throw new Error(errorMessage);
  }

  // Log warnings if any
  if (validation.warnings.length > 0) {
    console.error('⚠️  Schema validation warnings:');
    validation.warnings.forEach((w) => console.error(`  - ${w}`));
  }

  // Filter out empty rows before conversion (same logic as validation)
  const validRows = rows.filter((row) => {
    const hasFieldId =
      row.Field_ID !== undefined && row.Field_ID !== null && String(row.Field_ID).trim() !== '';
    const hasModelId =
      row.Model_ID !== undefined && row.Model_ID !== null && String(row.Model_ID).trim() !== '';
    const hasFieldName = row.Field_Name && String(row.Field_Name).trim() !== '';
    const hasModelName = row.Model_Name && String(row.Model_Name).trim() !== '';
    return hasFieldId || hasModelId || hasFieldName || hasModelName;
  });

  // Convert each valid row
  const converted: NexsusSchemaRow[] = validRows.map((row) => {
    // Generate V2 UUID for this field using actual model_id (not hardcoded 0004)
    const uuid = buildSchemaUuidV2Simple(row.Field_ID, row.Model_ID);

    // Generate FK reference UUID if FK field (handle leading spaces)
    const fkModelId = getFkField<number>(row, 'FK location field model id');
    const fkRecordId = getFkField<number>(row, 'FK location record Id');

    let fkUuid: string | undefined;
    if (fkModelId !== undefined && fkRecordId !== undefined) {
      fkUuid = buildSchemaFkRefUuidV2(fkModelId, fkRecordId);
    }

    // Generate semantic text (auto) - pass FK UUID for graph traversal
    const semanticText = generateSemanticText(row, fkUuid);

    // Generate payload string (auto)
    const payloadString = generatePayloadString(row, uuid);

    // Create NexsusSchemaRow
    const nexsusRow: NexsusSchemaRow = {
      qdrant_id: uuid,
      semantic_text: semanticText,
      raw_payload: payloadString,
      field_id: row.Field_ID,
      model_id: row.Model_ID,
      field_name: row.Field_Name,
      field_label: row.Field_Label,
      field_type: row.Field_Type,
      model_name: row.Model_Name,
      stored: row.Stored?.toLowerCase() === 'yes',
    };

    // Add FK metadata if present (handle leading spaces)
    const fkModel = getFkField<string>(row, 'FK location field model');
    if (fkModel) {
      nexsusRow.fk_location_model = fkModel;
    }

    if (fkModelId !== undefined) {
      nexsusRow.fk_location_model_id = fkModelId;
    }

    if (fkRecordId !== undefined) {
      nexsusRow.fk_location_record_id = fkRecordId;
    }

    if (fkUuid) {
      nexsusRow.fk_qdrant_id = fkUuid;
    }

    return nexsusRow;
  });

  return converted;
}
