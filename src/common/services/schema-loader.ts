/**
 * Schema Loader Service
 *
 * Parses the 4^XX* encoded schema format and loads schema data from file.
 * Builds semantic text for embedding.
 *
 * Encoded format:
 * 4^58*[Model_ID]|4^58*[Field_ID]|4^26*[Field_Name]|4^33*[Field_Label]|
 * 4^35*[Field_Type]|4^28*[Model_Name]|4^60000*[Primary_Location]|
 * 4^57*[Stored]|4^60001*[PrimaryModelID^PrimaryFieldID]*
 */

import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_CONFIG, SCHEMA_COLUMN_INDEX } from '../constants.js';
import type { OdooSchemaRow } from '../types.js';

// =============================================================================
// SCHEMA CACHE
// =============================================================================

let schemaCache: OdooSchemaRow[] | null = null;

// =============================================================================
// PARSING FUNCTIONS
// =============================================================================

/**
 * Extract value from an encoded field
 *
 * Example: "4^58*292" → "292"
 * Example: "4^60001*292^28105*" → "292^28105"
 */
function extractValue(encodedField: string): string {
  const delimiterIndex = encodedField.indexOf(SCHEMA_CONFIG.VALUE_DELIMITER);
  if (delimiterIndex === -1) {
    return encodedField;
  }
  let value = encodedField.substring(delimiterIndex + 1);
  // Remove trailing * if present
  if (value.endsWith('*')) {
    value = value.slice(0, -1);
  }
  return value;
}

/**
 * Parse a single encoded schema row
 *
 * @param encodedRow - Full encoded row string
 * @returns Parsed OdooSchemaRow or null if invalid
 */
export function parseSchemaRow(encodedRow: string): OdooSchemaRow | null {
  try {
    const fields = encodedRow.split(SCHEMA_CONFIG.FIELD_DELIMITER);

    if (fields.length < 9) {
      console.error('[SchemaLoader] Invalid row - not enough fields:', encodedRow.substring(0, 50));
      return null;
    }

    // Extract values from each column
    const modelIdStr = extractValue(fields[SCHEMA_COLUMN_INDEX.MODEL_ID]);
    const fieldIdStr = extractValue(fields[SCHEMA_COLUMN_INDEX.FIELD_ID]);
    const fieldName = extractValue(fields[SCHEMA_COLUMN_INDEX.FIELD_NAME]);
    const fieldLabel = extractValue(fields[SCHEMA_COLUMN_INDEX.FIELD_LABEL]);
    const fieldType = extractValue(fields[SCHEMA_COLUMN_INDEX.FIELD_TYPE]);
    const modelName = extractValue(fields[SCHEMA_COLUMN_INDEX.MODEL_NAME]);
    const primaryDataLocation = extractValue(fields[SCHEMA_COLUMN_INDEX.PRIMARY_LOCATION]);
    const storedStr = extractValue(fields[SCHEMA_COLUMN_INDEX.STORED]);
    const primaryRef = extractValue(fields[SCHEMA_COLUMN_INDEX.PRIMARY_REF]);

    // Parse IDs
    const modelId = parseInt(modelIdStr, 10);
    const fieldId = parseInt(fieldIdStr, 10);

    if (isNaN(modelId) || isNaN(fieldId)) {
      console.error('[SchemaLoader] Invalid IDs:', { modelIdStr, fieldIdStr });
      return null;
    }

    // Parse primary reference (format: "ModelID^FieldID")
    let primaryModelId: number | string = '';
    let primaryFieldId: number | string = '';

    if (primaryRef && primaryRef.includes('^')) {
      const [pmId, pfId] = primaryRef.split('^');
      primaryModelId = pmId || '';
      primaryFieldId = pfId || '';
    } else {
      primaryModelId = primaryRef || '';
      primaryFieldId = '';
    }

    return {
      model_id: modelId,
      field_id: fieldId,
      field_name: fieldName,
      field_label: fieldLabel,
      field_type: fieldType,
      model_name: modelName,
      primary_data_location: primaryDataLocation,
      stored: storedStr.toLowerCase() === 'yes',
      primary_model_id: primaryModelId,
      primary_field_id: primaryFieldId,
      raw_encoded: encodedRow,
    };
  } catch (error) {
    console.error('[SchemaLoader] Error parsing row:', error);
    return null;
  }
}

/**
 * Build semantic text for embedding (Hybrid Approach)
 *
 * Creates a coordinate-aware description that captures both:
 * 1. Semantic meaning for natural language search
 * 2. Coordinate patterns for structural queries
 *
 * The 4^XX* encoding is a memory block coordinate system:
 * - 4 = ir.model.fields table
 * - 58 = model_id column, 26 = field_name column, 28 = model_name column
 * - VALUE = the actual data (model ID, field name, etc.)
 *
 * @param schema - Parsed schema row
 * @returns Semantic text string with coordinate awareness
 */
export function buildSemanticText(schema: OdooSchemaRow): string {
  const parts: string[] = [];

  // 1. OWNERSHIP with coordinate - This field BELONGS TO this model
  parts.push(`FIELD IN ${schema.model_name} (model_id ${schema.model_id}):`);
  parts.push(`${schema.field_name} (field_id ${schema.field_id})`);

  // 2. Coordinate patterns for structural queries
  parts.push(`- model coordinate 4^58*${schema.model_id}`);
  parts.push(`- field coordinate 4^58*${schema.field_id}`);

  // 3. Synonyms for better natural language matching
  parts.push(`column attribute property of ${schema.model_name}`);

  // 4. Human-readable label
  if (schema.field_label && schema.field_label !== schema.field_name) {
    parts.push(`labeled "${schema.field_label}"`);
  }

  // 5. Field type
  parts.push(`- ${schema.field_type} type`);

  // 6. REFERENCE (for relational fields) - clearly marked as reference, not membership
  if (schema.field_type === 'many2one') {
    // Extract related model from primary_data_location (e.g., "res.users.id" → "res.users")
    const relatedModel = schema.primary_data_location.replace('.id', '');
    parts.push(`- REFERENCES ${relatedModel}`);
    parts.push(`- foreign key linking to ${relatedModel}`);
  } else if (schema.field_type === 'one2many') {
    parts.push(`- one2many related records in other model`);
  } else if (schema.field_type === 'many2many') {
    parts.push(`- many2many related records`);
  }

  // 7. Storage info
  parts.push(schema.stored ? `- stored in database` : `- computed field not stored`);

  // 8. Data location
  if (schema.primary_data_location && schema.primary_data_location !== 'Computed') {
    parts.push(`- data at ${schema.primary_data_location}`);
  }

  // 9. Primary reference IDs for direct access
  if (schema.primary_model_id && schema.primary_field_id) {
    parts.push(`- primary ref ${schema.primary_model_id}^${schema.primary_field_id}`);
  }

  return parts.join(' ');
}

// =============================================================================
// FILE LOADING
// =============================================================================

/**
 * Load schema from file
 *
 * @param filePath - Path to schema data file (optional, uses default from config)
 * @returns Array of parsed schema rows
 */
export function loadSchema(filePath?: string): OdooSchemaRow[] {
  // Return cached if available
  if (schemaCache !== null) {
    console.error(`[SchemaLoader] Using cached schema (${schemaCache.length} rows)`);
    return schemaCache;
  }

  const dataFile = filePath || path.resolve(process.cwd(), SCHEMA_CONFIG.DATA_FILE);
  console.error(`[SchemaLoader] Loading schema from: ${dataFile}`);

  if (!fs.existsSync(dataFile)) {
    console.error(`[SchemaLoader] Schema file not found: ${dataFile}`);
    return [];
  }

  const content = fs.readFileSync(dataFile, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim().length > 0);

  console.error(`[SchemaLoader] Found ${lines.length} rows in file`);

  const schemas: OdooSchemaRow[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    const schema = parseSchemaRow(line.trim());
    if (schema) {
      schemas.push(schema);
    } else {
      parseErrors++;
    }
  }

  console.error(`[SchemaLoader] Parsed ${schemas.length} schemas (${parseErrors} errors)`);

  // Cache the results
  schemaCache = schemas;

  return schemas;
}

/**
 * Clear the schema cache
 */
export function clearSchemaCache(): void {
  schemaCache = null;
  console.error('[SchemaLoader] Schema cache cleared');
}

/**
 * Get schema statistics
 */
export function getSchemaStats(): {
  totalFields: number;
  models: number;
  fieldTypes: Record<string, number>;
  storedCount: number;
  computedCount: number;
} {
  const schemas = loadSchema();

  const models = new Set<string>();
  const fieldTypes: Record<string, number> = {};
  let storedCount = 0;
  let computedCount = 0;

  for (const schema of schemas) {
    models.add(schema.model_name);

    fieldTypes[schema.field_type] = (fieldTypes[schema.field_type] || 0) + 1;

    if (schema.stored) {
      storedCount++;
    } else {
      computedCount++;
    }
  }

  return {
    totalFields: schemas.length,
    models: models.size,
    fieldTypes,
    storedCount,
    computedCount,
  };
}

/**
 * Get all schemas for a specific model
 */
export function getSchemasByModel(modelName: string): OdooSchemaRow[] {
  const schemas = loadSchema();
  return schemas.filter(s => s.model_name === modelName);
}

/**
 * Get a specific schema by field_id
 */
export function getSchemaByFieldId(fieldId: number): OdooSchemaRow | undefined {
  const schemas = loadSchema();
  return schemas.find(s => s.field_id === fieldId);
}

/**
 * Get all unique model names
 */
export function getAllModelNames(): string[] {
  const schemas = loadSchema();
  const models = new Set<string>();
  for (const schema of schemas) {
    models.add(schema.model_name);
  }
  return Array.from(models).sort();
}
