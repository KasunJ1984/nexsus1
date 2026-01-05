/**
 * Excel Schema Loader Service
 *
 * Parses nexsus_schema_v2_generated.xlsx and extracts schema data.
 * Uses the xlsx package for Excel file reading.
 *
 * Excel format (3 columns):
 * - Column A: Qdrant ID (V2 UUID format, e.g., "00000003-0004-0000-0000-000000028105")
 * - Column B: Vector (semantic text for embedding)
 * - Column C: Payload fields (structured metadata string)
 *
 * V2 UUID Structure:
 * - 00000003: Schema namespace
 * - 0004: Reserved (ir.model.fields model_id)
 * - Last 12 digits: Field ID (unique record in ir.model.fields)
 *
 * Payload fields format:
 * "Field_ID - 28105 ,Model_ID - 292 ,Field_Name - account_type ,..."
 *
 * For FK fields includes:
 * "...,FK location field model - calendar.event ,FK location field model id - 184 ,
 *  FK location record Id - 2675 ,Qdrant ID for FK - 00000002-0184-0000-0000-000000002675"
 */

import XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { NEXSUS_CONFIG } from '../constants.js';
import type { NexsusSchemaRow, SimpleSchemaRow } from '../types.js';
import { convertSimpleSchemaToNexsus } from './simple-schema-converter.js';

// Cache for loaded schema
let schemaCache: NexsusSchemaRow[] | null = null;

/**
 * Parse payload fields string into structured data
 *
 * Input format examples:
 * "Field_ID - 28105, Model_ID - 292, Field_Name - account_type, Field_Label - Type,
 *  Field_Type - selection, Model_Name - account.account, Stored - Yes"
 *
 * FK format includes additional fields:
 * "Field_ID - 123, ..., FK location field model - res.partner,
 *  FK location field model id - 78, FK location record Id - 956,
 *  Vector_Id for FK - 78^956"
 *
 * @param payloadStr - Raw payload string from Excel Column C
 * @returns Parsed fields object
 */
function parsePayloadFields(payloadStr: string): Partial<NexsusSchemaRow> {
  const result: Partial<NexsusSchemaRow> = {};

  // Split by comma and parse key-value pairs
  // Handle cases where values might contain commas by using regex
  const pairs = payloadStr.split(/\s*,\s*/).map(s => s.trim());

  for (const pair of pairs) {
    // Find the separator " - " (note: space-dash-space)
    const separatorIndex = pair.indexOf(' - ');
    if (separatorIndex === -1) continue;

    const key = pair.substring(0, separatorIndex).trim();
    const value = pair.substring(separatorIndex + 3).trim();

    switch (key) {
      case 'Field_ID':
        result.field_id = parseInt(value, 10);
        break;
      case 'Model_ID':
        result.model_id = parseInt(value, 10);
        break;
      case 'Field_Name':
        result.field_name = value;
        break;
      case 'Field_Label':
        result.field_label = value;
        break;
      case 'Field_Type':
        result.field_type = value;
        break;
      case 'Model_Name':
        result.model_name = value;
        break;
      case 'Stored':
        result.stored = value.toLowerCase() === 'yes';
        break;
      case 'FK location field model':
        result.fk_location_model = value;
        break;
      case 'FK location field model id':
        result.fk_location_model_id = parseInt(value, 10);
        break;
      case 'FK location record Id':
        result.fk_location_record_id = parseInt(value, 10);
        break;
      case 'Vector_Id for FK':
      case 'Qdrant ID for FK':
        // FK Qdrant ID (already UUID format in v1, e.g., "00000184-0000-0000-0000-000000002675")
        result.fk_qdrant_id = value;
        break;
    }
  }

  return result;
}

/**
 * Detect schema format from Excel workbook
 *
 * Supports two formats:
 * - V2 Format: 3 columns (Qdrant ID, Vector, Payload) with UUID in A2
 * - Simple Format: 11 columns (Field_ID, Model_ID, Field_Name, etc.)
 *
 * @param workbook - XLSX workbook object
 * @returns 'v2' or 'simple'
 * @throws Error if format cannot be detected
 */
function detectSchemaFormat(workbook: XLSX.WorkBook): 'v2' | 'simple' {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Get the sheet range
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');

  // Get header row
  const headers: string[] = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
    const cell = sheet[cellAddress];
    if (cell) {
      headers.push(String(cell.v).trim());
    }
  }

  console.error(`[NexsusLoader] Detected ${headers.length} columns with headers:`, headers);

  // Check for V2 format (3 columns with UUID in A2)
  if (headers.length === 3) {
    const a2Cell = sheet['A2'];
    if (a2Cell) {
      const a2Value = String(a2Cell.v).trim();
      // Check if A2 contains a UUID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a2Value)) {
        console.error('[NexsusLoader] Detected V2 format (3 columns with UUID)');
        return 'v2';
      }
    }
  }

  // Check for Simple format (11 columns with specific headers)
  const simpleFormatColumns = [
    'Field_ID',
    'Model_ID',
    'Field_Name',
    'Field_Label',
    'Field_Type',
    'Model_Name',
    'Stored',
  ];

  // Check if all required Simple format columns are present (case-insensitive)
  const hasSimpleFormat = simpleFormatColumns.every((col) =>
    headers.some((h) => h.toLowerCase() === col.toLowerCase()),
  );

  if (hasSimpleFormat) {
    console.error('[NexsusLoader] Detected Simple format (11 columns with Field_ID, Model_ID, etc.)');
    return 'simple';
  }

  // Unable to detect format
  throw new Error(
    `Unable to detect schema format.\n` +
      `Expected either:\n` +
      `  - V2 format: 3 columns with UUID in A2\n` +
      `  - Simple format: 11 columns with headers: ${simpleFormatColumns.join(', ')}\n` +
      `Found ${headers.length} columns: ${headers.join(', ')}`,
  );
}

/**
 * Load schema from Simple format Excel file
 *
 * Parses user's simplified 11-column format and converts to NexsusSchemaRow format.
 *
 * @param workbook - XLSX workbook object
 * @returns Array of parsed schema rows
 */
function loadSimpleFormatSchema(workbook: XLSX.WorkBook): NexsusSchemaRow[] {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Parse Excel with headers
  const rawData: SimpleSchemaRow[] = XLSX.utils.sheet_to_json<SimpleSchemaRow>(sheet);

  console.error(`[NexsusLoader] Loaded ${rawData.length} rows from Simple format`);

  // Convert to NexsusSchemaRow format using converter
  const converted = convertSimpleSchemaToNexsus(rawData);

  console.error(`[NexsusLoader] Converted ${converted.length} schemas from Simple format`);

  return converted;
}

/**
 * Load schema from V2 format Excel file
 *
 * Parses the existing 3-column V2 format (Qdrant ID, Vector, Payload).
 *
 * @param workbook - XLSX workbook object
 * @returns Array of parsed schema rows
 */
function loadV2FormatSchema(workbook: XLSX.WorkBook): NexsusSchemaRow[] {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert to JSON (array of arrays, skip header row)
  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
  });

  console.error(`[NexsusLoader] Found ${rawData.length} rows in V2 format (including header)`);

  const schemas: NexsusSchemaRow[] = [];
  let parseErrors = 0;

  // Skip header row (index 0)
  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];

    // Skip empty rows
    if (!row || row.length < 3) continue;

    const qdrantId = String(row[0] || '').trim();
    const semanticText = String(row[1] || '').trim();
    const payloadFields = String(row[2] || '').trim();

    // Skip rows with missing data
    if (!qdrantId || !semanticText || !payloadFields) {
      parseErrors++;
      continue;
    }

    // Validate UUID format (e.g., "00000004-0000-0000-0000-000000028105")
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qdrantId)) {
      console.error(`[NexsusLoader] Row ${i + 1}: Invalid UUID format: "${qdrantId}"`);
      parseErrors++;
      continue;
    }

    try {
      const parsedPayload = parsePayloadFields(payloadFields);

      // Validate required fields
      if (!parsedPayload.field_id || !parsedPayload.model_id || !parsedPayload.field_name) {
        console.error(`[NexsusLoader] Row ${i + 1}: Missing required fields in payload`);
        parseErrors++;
        continue;
      }

      schemas.push({
        qdrant_id: qdrantId,
        semantic_text: semanticText,
        raw_payload: payloadFields,
        field_id: parsedPayload.field_id,
        model_id: parsedPayload.model_id,
        field_name: parsedPayload.field_name,
        field_label: parsedPayload.field_label || '',
        field_type: parsedPayload.field_type || '',
        model_name: parsedPayload.model_name || '',
        stored: parsedPayload.stored ?? true,
        fk_location_model: parsedPayload.fk_location_model,
        fk_location_model_id: parsedPayload.fk_location_model_id,
        fk_location_record_id: parsedPayload.fk_location_record_id,
        fk_qdrant_id: parsedPayload.fk_qdrant_id,
      });
    } catch (error) {
      console.error(`[NexsusLoader] Row ${i + 1} parse error:`, error);
      parseErrors++;
    }
  }

  console.error(`[NexsusLoader] Parsed ${schemas.length} schemas from V2 format (${parseErrors} errors)`);

  return schemas;
}

/**
 * Extract numeric ID from vector_id string
 *
 * @param vectorId - Full vector ID (e.g., "4^28105")
 * @returns Numeric part (e.g., 28105)
 */
export function extractNumericId(vectorId: string): number {
  // Format is "4^XXXXX" - extract the number after ^
  const parts = vectorId.split('^');
  if (parts.length >= 2) {
    return parseInt(parts[1], 10);
  }
  // Fallback: try to parse the whole string
  return parseInt(vectorId, 10);
}

/**
 * Load schema from Excel file
 *
 * Reads nexsus_schema_v2_generated.xlsx and parses all rows into
 * NexsusSchemaRow objects. Results are cached for performance.
 *
 * @param filePath - Optional path to Excel file (defaults to NEXSUS_CONFIG.EXCEL_FILE)
 * @returns Array of parsed schema rows
 */
export function loadNexsusSchema(filePath?: string): NexsusSchemaRow[] {
  // Return cached if available
  if (schemaCache !== null) {
    console.error(`[NexsusLoader] Using cached schema (${schemaCache.length} rows)`);
    return schemaCache;
  }

  const excelPath = filePath || path.resolve(process.cwd(), NEXSUS_CONFIG.EXCEL_FILE);
  console.error(`[NexsusLoader] Loading schema from: ${excelPath}`);

  if (!fs.existsSync(excelPath)) {
    console.error(`[NexsusLoader] Excel file not found: ${excelPath}`);
    return [];
  }

  // Read Excel file
  const workbook = XLSX.readFile(excelPath);

  // Detect format and route to appropriate loader
  const format = detectSchemaFormat(workbook);

  let schemas: NexsusSchemaRow[];

  if (format === 'v2') {
    schemas = loadV2FormatSchema(workbook);
  } else {
    schemas = loadSimpleFormatSchema(workbook);
  }

  // Cache results
  schemaCache = schemas;

  return schemas;
}

/**
 * Clear the schema cache
 *
 * Call this before re-loading the Excel file to get fresh data.
 */
export function clearNexsusSchemaCache(): void {
  schemaCache = null;
  console.error('[NexsusLoader] Schema cache cleared');
}

/**
 * Get schema statistics
 *
 * Provides summary statistics about the loaded schema data.
 * Useful for status reporting.
 *
 * @returns Statistics object
 */
export function getNexsusSchemaStats(): {
  totalFields: number;
  models: number;
  modelNames: string[];
  fieldTypes: Record<string, number>;
  storedCount: number;
  computedCount: number;
  fkCount: number;
} {
  const schemas = loadNexsusSchema();

  const models = new Set<string>();
  const fieldTypes: Record<string, number> = {};
  let storedCount = 0;
  let computedCount = 0;
  let fkCount = 0;

  for (const schema of schemas) {
    models.add(schema.model_name);
    fieldTypes[schema.field_type] = (fieldTypes[schema.field_type] || 0) + 1;

    if (schema.stored) {
      storedCount++;
    } else {
      computedCount++;
    }

    if (schema.fk_location_model) {
      fkCount++;
    }
  }

  return {
    totalFields: schemas.length,
    models: models.size,
    modelNames: Array.from(models).sort(),
    fieldTypes,
    storedCount,
    computedCount,
    fkCount,
  };
}

/**
 * Find schema by Qdrant ID (UUID)
 *
 * @param qdrantId - The Qdrant UUID to search for (e.g., "00000004-0000-0000-0000-000000028105")
 * @returns The matching schema row or undefined
 */
export function findSchemaByQdrantId(qdrantId: string): NexsusSchemaRow | undefined {
  const schemas = loadNexsusSchema();
  return schemas.find(s => s.qdrant_id === qdrantId);
}

/**
 * @deprecated Use findSchemaByQdrantId instead
 */
export function findSchemaByVectorId(vectorId: string): NexsusSchemaRow | undefined {
  return findSchemaByQdrantId(vectorId);
}

/**
 * Find schemas by model name
 *
 * @param modelName - The model name to filter by (e.g., "account.account")
 * @returns Array of matching schema rows
 */
export function findSchemasByModel(modelName: string): NexsusSchemaRow[] {
  const schemas = loadNexsusSchema();
  return schemas.filter(s => s.model_name === modelName);
}

/**
 * Find schemas by field type
 *
 * @param fieldType - The field type to filter by (e.g., "many2one")
 * @returns Array of matching schema rows
 */
export function findSchemasByFieldType(fieldType: string): NexsusSchemaRow[] {
  const schemas = loadNexsusSchema();
  return schemas.filter(s => s.field_type === fieldType);
}

/**
 * Find a specific field by model and field name
 *
 * @param modelName - The model name (e.g., "account.move.line")
 * @param fieldName - The field name (e.g., "debit", "partner_id")
 * @returns The matching schema row or undefined
 */
export function findFieldByModelAndName(
  modelName: string,
  fieldName: string
): NexsusSchemaRow | undefined {
  const schemas = loadNexsusSchema();
  return schemas.find(s => s.model_name === modelName && s.field_name === fieldName);
}

/**
 * Get all unique model names from the schema
 *
 * @returns Array of unique model names
 */
export function getAllModelNames(): string[] {
  const schemas = loadNexsusSchema();
  return [...new Set(schemas.map(s => s.model_name))];
}
