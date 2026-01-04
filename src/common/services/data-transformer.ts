/**
 * Data Transformer Service
 *
 * Transforms Odoo table data into coordinate-encoded format for embedding.
 * Encoding format: [model_id]^[field_id]*VALUE
 *
 * Example encoded record:
 * 344^6327*12345|344^6299*450000|78^956*201|345^6237*4
 *
 * Key features:
 * - Schema validation: Every Odoo field must have a schema entry
 * - FK prefix rule: Foreign keys use TARGET model's prefix
 * - Type-aware encoding: Boolean → TRUE/FALSE, many2one → ID only, etc.
 */

import { getSchemasByModel, loadSchema } from './schema-loader.js';
import type {
  OdooSchemaRow,
  FieldEncodingMap,
  EncodedRecord,
  ValidationResult,
  DataTransformConfig,
  CoordinateLookupMap,
  CoordinateMetadata,
  ParsedField,
  DecodedField,
  EncodingContext,
} from '../types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Marker value for fields that could not be read due to API restrictions
 *
 * When a field is restricted by Odoo security rules (e.g., eLearning fields
 * on res.partner), we encode it with this marker instead of failing the sync.
 *
 * Encoded format: prefix*Restricted_from_API
 * Display format: [API Restricted]
 */
export const RESTRICTED_FIELD_MARKER = 'Restricted_from_API';

/**
 * Marker value for fields that fail due to Odoo-side bugs
 *
 * When a field causes an Odoo error (e.g., singleton error in computed field),
 * we encode it with this marker instead of failing the sync.
 *
 * Encoded format: prefix*Restricted_odoo_error
 * Display format: [Odoo Error]
 */
export const ODOO_ERROR_MARKER = 'Restricted_odoo_error';

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

/**
 * Validate that all Odoo fields have corresponding schema entries
 *
 * This is a CRITICAL control to ensure the "connected structure and map".
 * Sync will FAIL if any Odoo field is not defined in the schema.
 *
 * @param odooFields - Field names from Odoo record
 * @param schemaFields - Schema rows for the model
 * @returns ValidationResult with matched/missing field lists
 */
export function validateSchemaDataAlignment(
  odooFields: string[],
  schemaFields: OdooSchemaRow[]
): ValidationResult {
  const schemaFieldNames = new Set(schemaFields.map(f => f.field_name));
  const odooFieldSet = new Set(odooFields);

  const missing_in_schema = odooFields.filter(f => !schemaFieldNames.has(f));
  const missing_in_odoo = schemaFields
    .filter(f => !odooFieldSet.has(f.field_name))
    .map(f => f.field_name);
  const matched_fields = odooFields.filter(f => schemaFieldNames.has(f));

  return {
    valid: missing_in_schema.length === 0, // FAIL if any Odoo field not in schema
    matched_fields,
    missing_in_schema,
    missing_in_odoo,
  };
}

// =============================================================================
// FIELD ENCODING MAP
// =============================================================================

/**
 * Build encoding map: field_name → encoding prefix
 *
 * CRITICAL RULE for foreign keys:
 * - many2one fields use the TARGET model's id field prefix
 * - Example: partner_id (many2one to res.partner) → uses "78^956" (res.partner.id prefix)
 * - NOT "344^XXX" (crm.lead's own prefix)
 *
 * For native fields:
 * - Use the model's own model_id^field_id
 * - Example: expected_revenue → "344^6299"
 *
 * @param modelFields - Schema rows for the model
 * @returns FieldEncodingMap
 */
export function buildFieldEncodingMap(modelFields: OdooSchemaRow[]): FieldEncodingMap {
  const map: FieldEncodingMap = {};

  for (const field of modelFields) {
    if (field.field_type === 'many2one') {
      // FK: Use TARGET model's id field prefix (primary_model_id^primary_field_id)
      map[field.field_name] = {
        prefix: `${field.primary_model_id}^${field.primary_field_id}`,
        field_type: field.field_type,
        is_foreign_key: true,
        target_model: field.primary_data_location.replace('.id', ''),
      };
    } else if (field.field_type === 'many2many' || field.field_type === 'one2many') {
      // For many2many/one2many, use the model's own prefix
      map[field.field_name] = {
        prefix: `${field.model_id}^${field.field_id}`,
        field_type: field.field_type,
        is_foreign_key: true,
        target_model: field.primary_data_location.replace('.id', ''),
      };
    } else {
      // Native field: Use model's own model_id^field_id
      map[field.field_name] = {
        prefix: `${field.model_id}^${field.field_id}`,
        field_type: field.field_type,
        is_foreign_key: false,
      };
    }
  }

  return map;
}

// =============================================================================
// VALUE ENCODING
// =============================================================================

/**
 * Encode a value based on its field type
 *
 * Type mappings:
 * - boolean: TRUE / FALSE
 * - many2one: Extract ID from [id, name] tuple
 * - many2many/one2many: [1,2,3] format
 * - char/text: As-is (escape | delimiter)
 * - integer/float/monetary: As string
 * - date/datetime: As string
 * - false/null: Empty string (will be included in encoded string)
 *
 * @param value - Raw value from Odoo
 * @param fieldType - Field type from schema
 * @returns Encoded string value
 */
export function encodeValue(value: unknown, fieldType: string): string {
  // Handle boolean FIRST - false is a valid boolean value
  if (fieldType === 'boolean') {
    // Odoo returns false for empty fields too, so only TRUE if explicitly true
    return value === true ? 'TRUE' : 'FALSE';
  }

  // Handle falsy values (Odoo returns false for empty fields)
  if (value === false || value === null || value === undefined) {
    return '';
  }

  switch (fieldType) {
    case 'many2one':
      // Odoo returns [id, name] tuple for many2one
      if (Array.isArray(value) && value.length === 2) {
        return String(value[0]); // Return just the ID
      }
      return '';

    case 'many2many':
    case 'one2many':
      // Return as array format [1,2,3]
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return '[]';
        }
        return `[${value.join(',')}]`;
      }
      return '[]';

    case 'integer':
    case 'float':
    case 'monetary':
      return String(value);

    case 'char':
    case 'text':
    case 'html':
      // Escape pipe characters that would break our delimiter
      return String(value).replace(/\|/g, '\\|');

    case 'date':
    case 'datetime':
      return String(value);

    case 'selection':
      return String(value);

    case 'binary':
      // Binary fields are typically base64 encoded - skip for now
      return value ? '[binary]' : '';

    default:
      return String(value);
  }
}

// =============================================================================
// RECORD ENCODING
// =============================================================================

/**
 * Encode a single Odoo record into coordinate format
 *
 * Format: 344^6327*12345|344^6299*450000|78^956*201|...
 *
 * **Restricted Field Handling:**
 * If an `EncodingContext` is provided and a field is in `restricted_fields`,
 * the value is encoded as `Restricted_from_API` instead of the actual value.
 * This allows syncs to continue when certain fields are blocked by API permissions.
 *
 * @param record - Raw Odoo record from searchRead
 * @param encodingMap - Field name to prefix mapping
 * @param context - Optional encoding context with restricted field information
 * @returns Encoded string
 */
export function encodeRecord(
  record: Record<string, unknown>,
  encodingMap: FieldEncodingMap,
  context?: EncodingContext
): string {
  const parts: string[] = [];

  for (const [fieldName, fieldInfo] of Object.entries(encodingMap)) {
    // Check if this field is restricted
    if (context?.restricted_fields.has(fieldName)) {
      // Encode restricted fields with the appropriate marker based on reason
      const reason = context.restricted_fields.get(fieldName);
      const marker = reason === 'odoo_error' ? ODOO_ERROR_MARKER : RESTRICTED_FIELD_MARKER;
      parts.push(`${fieldInfo.prefix}*${marker}`);
      continue;
    }

    const value = record[fieldName];
    const encodedValue = encodeValue(value, fieldInfo.field_type);

    // Include the field even if value is empty (preserves field structure)
    parts.push(`${fieldInfo.prefix}*${encodedValue}`);
  }

  return parts.join('|');
}

// =============================================================================
// BATCH TRANSFORMATION
// =============================================================================

/**
 * Get model fields from schema
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @returns Array of schema rows for the model
 */
export function getModelFields(modelName: string): OdooSchemaRow[] {
  return getSchemasByModel(modelName);
}

/**
 * Transform a batch of Odoo records into encoded records
 *
 * @param records - Raw Odoo records
 * @param encodingMap - Field encoding map
 * @param config - Transform configuration
 * @param context - Optional encoding context with restricted field information
 * @returns Array of encoded records
 */
export function transformRecords(
  records: Record<string, unknown>[],
  encodingMap: FieldEncodingMap,
  config: DataTransformConfig,
  context?: EncodingContext
): EncodedRecord[] {
  const encodedRecords: EncodedRecord[] = [];

  for (const record of records) {
    const encodedString = encodeRecord(record, encodingMap, context);
    encodedRecords.push({
      record_id: record.id as number,
      model_name: config.model_name,
      model_id: config.model_id,
      encoded_string: encodedString,
      field_count: encodedString.split('|').length,
    });
  }

  return encodedRecords;
}

/**
 * Get the list of field names to fetch from Odoo
 * Only fetches fields that exist in the schema
 *
 * @param encodingMap - Field encoding map
 * @returns Array of field names
 */
export function getFieldsToFetch(encodingMap: FieldEncodingMap): string[] {
  return Object.keys(encodingMap);
}

/**
 * Preview the encoding map for a model (for debugging/validation)
 *
 * @param modelName - Model name
 * @returns Object with encoding map and field count
 */
export function previewEncodingMap(modelName: string): {
  model_name: string;
  field_count: number;
  encoding_map: FieldEncodingMap;
  sample_prefixes: { field_name: string; prefix: string; type: string }[];
} {
  const schemaFields = getModelFields(modelName);

  if (schemaFields.length === 0) {
    throw new Error(`No schema found for model: ${modelName}`);
  }

  const encodingMap = buildFieldEncodingMap(schemaFields);

  // Get sample of prefixes for display
  const samplePrefixes = Object.entries(encodingMap)
    .slice(0, 20)
    .map(([fieldName, info]) => ({
      field_name: fieldName,
      prefix: info.prefix,
      type: info.field_type,
    }));

  return {
    model_name: modelName,
    field_count: schemaFields.length,
    encoding_map: encodingMap,
    sample_prefixes: samplePrefixes,
  };
}

// =============================================================================
// NEXUS COORDINATE LOOKUP (Reverse of encoding - Stage 2)
// =============================================================================

/**
 * Cached coordinate lookup map
 * Maps coordinate string → field metadata for decoding
 */
let coordinateLookupCache: CoordinateLookupMap | null = null;

/**
 * Build reverse coordinate lookup from schema
 *
 * Creates map: "344^6299" → {field_name: "expected_revenue", ...}
 *
 * **CRITICAL for NEXUS decoding:**
 * The encoding uses FK prefix rule (FKs use TARGET model's prefix).
 * During decode, we see "78^956*201" and need to know:
 * - This is res.partner.id (model 78, field 956)
 * - The value 201 is a partner ID
 *
 * We index BOTH:
 * 1. Native coordinates: model_id^field_id for all fields
 * 2. FK target coordinates: primary_model_id^primary_field_id for many2one fields
 *
 * @param schemas - All schema rows from schema-loader
 * @returns CoordinateLookupMap for decode operations
 */
export function buildCoordinateLookup(schemas: OdooSchemaRow[]): CoordinateLookupMap {
  const lookup: CoordinateLookupMap = new Map();

  for (const schema of schemas) {
    // Native coordinate: model_id^field_id (for non-FK fields)
    const nativeCoord = `${schema.model_id}^${schema.field_id}`;

    const metadata: CoordinateMetadata = {
      field_name: schema.field_name,
      field_label: schema.field_label,
      field_type: schema.field_type,
      model_name: schema.model_name,
      model_id: schema.model_id,
      field_id: schema.field_id,
      is_foreign_key: schema.field_type === 'many2one',
      target_model: schema.field_type === 'many2one'
        ? schema.primary_data_location.replace('.id', '')
        : undefined,
    };

    // Always add native coordinate
    lookup.set(nativeCoord, metadata);

    // For FK fields: ALSO index by target coordinate
    // This is how we find "78^956" → partner_id field from crm.lead
    // When encoding, partner_id becomes "78^956*201" (uses target prefix)
    // When decoding, we look up "78^956" to find field metadata
    if (schema.field_type === 'many2one' &&
        schema.primary_model_id &&
        schema.primary_field_id) {
      const fkCoord = `${schema.primary_model_id}^${schema.primary_field_id}`;

      // Only set if not already present (first FK to this target wins)
      // Multiple models might have FKs to same target (e.g., partner_id)
      if (!lookup.has(fkCoord)) {
        lookup.set(fkCoord, {
          ...metadata,
          // Mark as FK lookup - the coordinate IS the target model's id field
          is_foreign_key: true,
        });
      }
    }
  }

  return lookup;
}

/**
 * Get the coordinate lookup map (cached)
 *
 * Builds the lookup on first call and caches it.
 * Uses the schema-loader to get all 17,930 schema entries.
 *
 * @returns CoordinateLookupMap for decode operations
 */
export function getCoordinateLookup(): CoordinateLookupMap {
  if (coordinateLookupCache !== null) {
    return coordinateLookupCache;
  }

  // Load all schemas and build lookup
  const schemas = loadSchema();
  coordinateLookupCache = buildCoordinateLookup(schemas);

  console.error(`[NEXUS Decode] Built coordinate lookup with ${coordinateLookupCache.size} entries`);
  return coordinateLookupCache;
}

/**
 * Clear the coordinate lookup cache
 *
 * Call this after schema sync to rebuild the lookup with new schema data.
 * The next getCoordinateLookup() call will rebuild from fresh schema.
 */
export function clearCoordinateLookup(): void {
  coordinateLookupCache = null;
  console.error('[NEXUS Decode] Coordinate lookup cache cleared');
}

// =============================================================================
// NEXUS STRING PARSING (Stage 3)
// =============================================================================

/**
 * Parse an encoded NEXUS string into field/value pairs
 *
 * Takes a coordinate-encoded string and breaks it into individual fields
 * that can then be decoded using the coordinate lookup.
 *
 * **Input format:** "344^6299*450000|78^956*201|345^6237*4"
 *
 * **Output:**
 * ```
 * [
 *   { coordinate: "344^6299", model_id: 344, field_id: 6299, raw_value: "450000" },
 *   { coordinate: "78^956", model_id: 78, field_id: 956, raw_value: "201" },
 *   { coordinate: "345^6237", model_id: 345, field_id: 6237, raw_value: "4" }
 * ]
 * ```
 *
 * **Handles:**
 * - Escaped pipe characters (\|) in text values
 * - Empty values (e.g., "344^6299*" → raw_value = "")
 * - Invalid segments are skipped with warning
 *
 * @param encoded - The NEXUS encoded string
 * @returns Array of parsed fields
 */
export function parseEncodedString(encoded: string): ParsedField[] {
  const fields: ParsedField[] = [];

  if (!encoded || encoded.trim() === '') {
    return fields;
  }

  // Split by | but NOT escaped \|
  // Use negative lookbehind: split on | not preceded by \
  const segments = encoded.split(/(?<!\\)\|/);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Match pattern: model_id^field_id*value
    // model_id and field_id are numbers, value can be anything (including empty)
    const match = trimmed.match(/^(\d+)\^(\d+)\*(.*)$/);

    if (match) {
      const modelId = parseInt(match[1], 10);
      const fieldId = parseInt(match[2], 10);
      // Unescape pipe characters in the value
      const rawValue = match[3].replace(/\\\|/g, '|');

      fields.push({
        coordinate: `${modelId}^${fieldId}`,
        model_id: modelId,
        field_id: fieldId,
        raw_value: rawValue,
      });
    } else {
      // Log warning for malformed segment but continue parsing
      console.error(`[NEXUS Parse] Skipping malformed segment: ${trimmed.substring(0, 50)}`);
    }
  }

  return fields;
}

// =============================================================================
// NEXUS VALUE FORMATTING (Stage 3)
// =============================================================================

/**
 * Format a raw value for human-readable display based on field type
 *
 * Transforms encoded values into user-friendly formats:
 * - monetary: 450000 → "$450,000"
 * - boolean: TRUE → "Yes", FALSE → "No"
 * - date: "2025-01-15" → "Jan 15, 2025"
 * - many2one: 201 → "#201 (res.partner)"
 * - Restricted_from_API → "[API Restricted]"
 *
 * @param rawValue - The raw value from the encoded string
 * @param fieldType - The field type from schema (e.g., "monetary", "boolean")
 * @param targetModel - For FK fields, the target model name
 * @returns Formatted display string
 */
export function formatDisplayValue(
  rawValue: string,
  fieldType: string,
  targetModel?: string
): string {
  // Handle restricted field marker
  if (rawValue === RESTRICTED_FIELD_MARKER) {
    return '[API Restricted]';
  }

  // Handle Odoo error marker
  if (rawValue === ODOO_ERROR_MARKER) {
    return '[Odoo Error]';
  }

  // Handle empty/false values
  if (rawValue === '' || rawValue === 'false' || rawValue === 'FALSE') {
    // Special case: boolean FALSE is a valid value, not empty
    if (fieldType === 'boolean' && (rawValue === 'FALSE' || rawValue === 'false')) {
      return 'No';
    }
    return '-';
  }

  switch (fieldType) {
    case 'monetary': {
      const num = parseFloat(rawValue);
      if (isNaN(num)) return rawValue;
      // Format with currency symbol and thousands separator
      return `$${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }

    case 'float': {
      const floatVal = parseFloat(rawValue);
      if (isNaN(floatVal)) return rawValue;
      // Show 2 decimal places for floats
      return floatVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    case 'integer': {
      const intVal = parseInt(rawValue, 10);
      if (isNaN(intVal)) return rawValue;
      return intVal.toLocaleString('en-US');
    }

    case 'boolean':
      // TRUE/FALSE → Yes/No (uppercase from encoding)
      return rawValue === 'TRUE' || rawValue === 'true' ? 'Yes' : 'No';

    case 'date': {
      // Format: YYYY-MM-DD → "Jan 15, 2025"
      try {
        const date = new Date(rawValue);
        if (isNaN(date.getTime())) return rawValue;
        return date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });
      } catch {
        return rawValue;
      }
    }

    case 'datetime': {
      // Format: ISO datetime → "Jan 15, 2025, 2:30 PM"
      try {
        const dt = new Date(rawValue);
        if (isNaN(dt.getTime())) return rawValue;
        return dt.toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return rawValue;
      }
    }

    case 'many2one':
      // Show ID with target model reference: "#201 (res.partner)"
      // This is the FK display format requested by user
      return `#${rawValue}${targetModel ? ` (${targetModel})` : ''}`;

    case 'many2many':
    case 'one2many':
      // Array format [1,2,3] → show as-is or count
      if (rawValue === '[]') return '-';
      // Extract count from array
      const match = rawValue.match(/^\[(.+)\]$/);
      if (match) {
        const ids = match[1].split(',').filter(id => id.trim());
        return `[${ids.length} items]`;
      }
      return rawValue;

    case 'selection':
      // Selection values are typically codes - show as-is
      // Could enhance with selection option labels later
      return rawValue;

    case 'char':
    case 'text':
    case 'html':
      // Truncate long text for display
      if (rawValue.length > 100) {
        return rawValue.substring(0, 100) + '...';
      }
      return rawValue;

    case 'binary':
      // Binary fields show placeholder
      return rawValue === '[binary]' ? '[binary data]' : rawValue;

    default:
      // Unknown types: return as-is, truncated if long
      if (rawValue.length > 100) {
        return rawValue.substring(0, 100) + '...';
      }
      return rawValue;
  }
}

// =============================================================================
// NEXUS DECODE RECORD (Stage 4)
// =============================================================================

/**
 * Decode a NEXUS encoded string into human-readable fields
 *
 * This is the main entry point for NEXUS decoding. It:
 * 1. Parses the encoded string into coordinate/value pairs
 * 2. Looks up each coordinate to get field metadata
 * 3. Formats values for human-readable display
 * 4. Optionally filters to show only key fields
 *
 * **Example Input:**
 * ```
 * "344^6271*Westfield School|344^6299*450000|78^956*201|345^6237*4"
 * ```
 *
 * **Example Output:**
 * ```
 * [
 *   { field_name: "name", field_label: "Name", display_value: "Westfield School", ... },
 *   { field_name: "expected_revenue", field_label: "Expected Revenue", display_value: "$450,000", ... },
 *   { field_name: "partner_id", field_label: "Customer", display_value: "#201 (res.partner)", ... },
 *   { field_name: "stage_id", field_label: "Stage", display_value: "#4 (crm.stage)", ... }
 * ]
 * ```
 *
 * @param encoded - The NEXUS encoded string
 * @param keyFieldNames - Optional list of field names to filter (shows only these)
 * @returns Array of decoded fields with human-readable display values
 */
export function decodeRecord(
  encoded: string,
  keyFieldNames?: readonly string[]
): DecodedField[] {
  // Get the coordinate lookup (cached, built on first call)
  const lookup = getCoordinateLookup();

  // Parse the encoded string into field/value pairs
  const parsedFields = parseEncodedString(encoded);

  // Build decoded fields
  const decodedFields: DecodedField[] = [];

  for (const parsed of parsedFields) {
    // Look up metadata for this coordinate
    const metadata = lookup.get(parsed.coordinate);

    if (!metadata) {
      // Unknown coordinate - skip (could be from newer schema)
      // Don't log here as it would spam for every unknown field
      continue;
    }

    // Filter by key fields if specified
    if (keyFieldNames && keyFieldNames.length > 0) {
      if (!keyFieldNames.includes(metadata.field_name)) {
        continue; // Skip non-key fields
      }
    }

    // Format the display value based on field type
    const displayValue = formatDisplayValue(
      parsed.raw_value,
      metadata.field_type,
      metadata.target_model
    );

    decodedFields.push({
      field_name: metadata.field_name,
      field_label: metadata.field_label,
      field_type: metadata.field_type,
      raw_value: parsed.raw_value,
      display_value: displayValue,
      is_foreign_key: metadata.is_foreign_key,
      target_model: metadata.target_model,
    });
  }

  return decodedFields;
}

/**
 * Decode a record and return formatted text output
 *
 * Convenience function for getting a human-readable text representation.
 * Useful for display in search results.
 *
 * **Example Output:**
 * ```
 * - **Name:** Westfield School
 * - **Expected Revenue:** $450,000
 * - **Customer:** #201 (res.partner)
 * - **Stage:** #4 (crm.stage)
 * ```
 *
 * @param encoded - The NEXUS encoded string
 * @param keyFieldNames - Optional list of field names to filter
 * @returns Formatted markdown text
 */
export function decodeRecordToText(
  encoded: string,
  keyFieldNames?: readonly string[]
): string {
  const decoded = decodeRecord(encoded, keyFieldNames);

  if (decoded.length === 0) {
    return '_No decodable fields found_';
  }

  const lines: string[] = [];
  for (const field of decoded) {
    lines.push(`- **${field.field_label}:** ${field.display_value}`);
  }

  return lines.join('\n');
}

/**
 * Get decode statistics for an encoded string
 *
 * Useful for understanding what was decoded vs what couldn't be.
 *
 * @param encoded - The NEXUS encoded string
 * @returns Statistics about the decode operation
 */
export function getDecodeStats(encoded: string): {
  total_segments: number;
  decoded_fields: number;
  unknown_coordinates: number;
  field_types: Record<string, number>;
} {
  const lookup = getCoordinateLookup();
  const parsed = parseEncodedString(encoded);

  let decoded = 0;
  let unknown = 0;
  const fieldTypes: Record<string, number> = {};

  for (const field of parsed) {
    const meta = lookup.get(field.coordinate);
    if (meta) {
      decoded++;
      fieldTypes[meta.field_type] = (fieldTypes[meta.field_type] || 0) + 1;
    } else {
      unknown++;
    }
  }

  return {
    total_segments: parsed.length,
    decoded_fields: decoded,
    unknown_coordinates: unknown,
    field_types: fieldTypes,
  };
}
