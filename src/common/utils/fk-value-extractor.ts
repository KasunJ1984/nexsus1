/**
 * FK Value Extractor - Schema-Driven FK Value Extraction
 *
 * This utility uses schema Field_ID to extract FK values from any data format.
 * The schema defines which columns are FK fields (via field_type = "many2one"),
 * and this utility reads the value directly from that column.
 *
 * Supports three data formats:
 * 1. Scalar: Account_id = 42000 (Excel format - value IS the FK ID)
 * 2. Tuple: partner_id = [123, "Partner Name"] (Odoo API format)
 * 3. Expanded: partner_id_id = 123 (legacy format with _id suffix)
 *
 * Key principle: Schema Field_ID defines the FK relationship,
 * this code just reads the value from whatever format the data is in.
 */

/**
 * Result of FK value extraction
 */
export interface FkExtractionResult {
  /** The FK ID value (points to target model's id) */
  fkId: number | undefined;

  /** Display name if available (from Odoo tuple format) */
  displayName: string | undefined;

  /** Source format detected */
  source: 'scalar' | 'tuple' | 'expanded' | 'none';

  /** Schema Field_ID for traceability */
  fieldId: number;
}

/**
 * Minimal schema field interface for FK extraction
 * Accepts both NexsusSchemaRow and PipelineField
 */
export interface SchemaFieldForFk {
  field_id: number;
  field_name: string;
  field_type: string;
}

/**
 * Extract FK value using schema definition (Field_ID based)
 *
 * Schema tells us:
 *   - field_id: Unique identifier (e.g., 301)
 *   - field_name: Column name to look for (e.g., "Account_id")
 *   - field_type: "many2one" confirms it's an FK
 *
 * Data can be:
 *   - Scalar: Account_id = 42000 (Excel format)
 *   - Tuple: partner_id = [123, "Name"] (Odoo format)
 *   - Expanded: partner_id_id = 123 (legacy format)
 *
 * @param record - Data record from Excel or Odoo
 * @param schemaField - Schema field definition with field_id, field_name, field_type
 * @returns FkExtractionResult with fkId, displayName, source, and fieldId
 */
export function extractFkValueBySchema(
  record: Record<string, unknown>,
  schemaField: SchemaFieldForFk
): FkExtractionResult {
  const { field_id, field_name, field_type } = schemaField;

  // Only process FK fields (many2one)
  if (field_type !== 'many2one') {
    return {
      fkId: undefined,
      displayName: undefined,
      source: 'none',
      fieldId: field_id,
    };
  }

  const value = record[field_name];

  // Priority 1: Odoo tuple format [id, name]
  // Example: partner_id = [123, "Partner Company"]
  if (Array.isArray(value) && value.length >= 2) {
    const id = value[0];
    const name = value[1];

    if (typeof id === 'number' && !isNaN(id)) {
      return {
        fkId: id,
        displayName: typeof name === 'string' ? name : String(name),
        source: 'tuple',
        fieldId: field_id,
      };
    }
  }

  // Priority 2: Excel scalar format (number directly in field_name column)
  // Example: Account_id = 42000
  if (typeof value === 'number' && !isNaN(value)) {
    return {
      fkId: value,
      displayName: undefined,
      source: 'scalar',
      fieldId: field_id,
    };
  }

  // Also handle string numbers (Excel might store as string)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) {
      return {
        fkId: parsed,
        displayName: undefined,
        source: 'scalar',
        fieldId: field_id,
      };
    }
  }

  // Priority 3: Legacy expanded format (field_name_id column)
  // Example: partner_id_id = 123, partner_id_name = "Partner Company"
  const expandedIdField = `${field_name}_id`;
  const expandedId = record[expandedIdField];

  if (typeof expandedId === 'number' && !isNaN(expandedId)) {
    const expandedNameField = `${field_name}_name`;
    const expandedName = record[expandedNameField];

    return {
      fkId: expandedId,
      displayName: typeof expandedName === 'string' ? expandedName : undefined,
      source: 'expanded',
      fieldId: field_id,
    };
  }

  // Also handle string numbers in expanded format
  if (typeof expandedId === 'string' && expandedId.trim() !== '') {
    const parsed = parseInt(expandedId, 10);
    if (!isNaN(parsed)) {
      const expandedNameField = `${field_name}_name`;
      const expandedName = record[expandedNameField];

      return {
        fkId: parsed,
        displayName: typeof expandedName === 'string' ? expandedName : undefined,
        source: 'expanded',
        fieldId: field_id,
      };
    }
  }

  // No FK value found
  return {
    fkId: undefined,
    displayName: undefined,
    source: 'none',
    fieldId: field_id,
  };
}

/**
 * Check if a schema field is an FK field
 */
export function isFkField(schemaField: SchemaFieldForFk): boolean {
  return schemaField.field_type === 'many2one';
}

/**
 * Check if a field type is a relational type (FK)
 */
export function isRelationalFieldType(fieldType: string): boolean {
  return ['many2one', 'one2many', 'many2many'].includes(fieldType);
}
