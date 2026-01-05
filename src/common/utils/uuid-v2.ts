/**
 * V2 UUID Generation and Parsing
 *
 * All UUIDs use deterministic field_id from Odoo - NO HASHING.
 * This provides direct Odoo lookup capability and guaranteed uniqueness.
 *
 * V2 UUID Formats:
 * - Data:   00000002-MMMM-0000-RRRRRRRRRRRR (model_id + record_id)
 * - Schema: 00000003-0004-0000-0000-FFFFFFFFFFFF (constant 0004 + field_id)
 * - Graph:  00000001-SSSS-TTTT-RRFFFFFFFFFF (source + target + type + field_id)
 *
 * Relationship Type Codes:
 * - 11 = One to One (rare in Odoo)
 * - 21 = One to Many
 * - 31 = Many to One (most common FK)
 * - 41 = Many to Many
 */

import { UUID_NAMESPACES, TTYPE_TO_RELATIONSHIP_CODE } from '../constants.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Pad a number to the specified number of digits with leading zeros
 * @param num - The number to pad
 * @param digits - Target number of digits
 * @returns Zero-padded string
 */
function pad(num: number, digits: number): string {
  return num.toString().padStart(digits, '0');
}

// ============================================================================
// DATA UUID (00000002)
// Format: 00000002-MMMM-0000-0000-RRRRRRRRRRRR (valid UUID: 8-4-4-4-12)
// ============================================================================

/**
 * Build V2 Data Point UUID
 *
 * Creates a unique identifier for a data record in Qdrant.
 * The UUID encodes the model and record IDs for direct lookup.
 *
 * Format: 00000002-MMMM-0000-0000-RRRRRRRRRRRR (valid UUID: 8-4-4-4-12)
 *
 * @param modelId - Model ID from ir.model (e.g., 312 for account.move.line)
 * @param recordId - Record ID from Odoo (e.g., 691174)
 * @returns UUID like "00000002-0312-0000-0000-000000691174"
 *
 * @example
 * buildDataUuidV2(312, 691174)
 * // Returns: "00000002-0312-0000-0000-000000691174"
 *
 * @example
 * buildDataUuidV2(344, 12345)  // crm.lead record
 * // Returns: "00000002-0344-0000-0000-000000012345"
 */
export function buildDataUuidV2(modelId: number, recordId: number): string {
  if (modelId === undefined || isNaN(modelId)) {
    throw new Error(`Invalid modelId: ${modelId}`);
  }
  if (recordId === undefined || isNaN(recordId)) {
    throw new Error(`Invalid recordId: ${recordId}`);
  }
  // Format: 8-4-4-4-12 (valid UUID format for Qdrant)
  return `${UUID_NAMESPACES.DATA}-${pad(modelId, 4)}-0000-0000-${pad(recordId, 12)}`;
}

/**
 * Parse V2 Data UUID to extract modelId and recordId
 *
 * @param uuid - Data UUID to parse (e.g., "00000002-0312-0000-0000-000000691174")
 * @returns Object with modelId and recordId, or null if invalid format
 *
 * @example
 * parseDataUuidV2("00000002-0312-0000-0000-000000691174")
 * // Returns: { modelId: 312, recordId: 691174 }
 */
export function parseDataUuidV2(uuid: string): { modelId: number; recordId: number } | null {
  const match = uuid.match(/^00000002-(\d{4})-0000-0000-(\d{12})$/);
  if (!match) return null;
  return {
    modelId: parseInt(match[1], 10),
    recordId: parseInt(match[2], 10),
  };
}

/**
 * Validate V2 Data UUID format
 *
 * @param uuid - UUID string to validate
 * @returns true if valid V2 Data UUID format
 *
 * @example
 * isValidDataUuidV2("00000002-0312-0000-0000-000000691174") // true
 * isValidDataUuidV2("00000003-0004-0000-0000-000000005012") // false (schema UUID)
 */
export function isValidDataUuidV2(uuid: string): boolean {
  return /^00000002-\d{4}-0000-0000-\d{12}$/.test(uuid);
}

// ============================================================================
// SCHEMA UUID (00000003)
// Format: 00000003-0004-0000-0000-FFFFFFFFFFFF
// Note: Segment 2 is ALWAYS 0004 (ir.model.fields model_id)
// ============================================================================

/**
 * Build V2 Schema UUID
 *
 * Creates a unique identifier for a schema field definition in Qdrant.
 * Segment 2 is always 0004 because all schema entries describe
 * fields in ir.model.fields (model_id = 4 in Odoo).
 *
 * Uses Field ID directly for:
 * - Direct Odoo lookup capability
 * - Guaranteed uniqueness (primary key)
 *
 * @param fieldId - Field ID from ir.model.fields (unique identifier)
 * @returns UUID like "00000003-0004-0000-0000-000000005012"
 *
 * @example
 * buildSchemaUuidV2(5012)
 * // Returns: "00000003-0004-0000-0000-000000005012"
 *
 * @example
 * buildSchemaUuidV2(28105)  // partner_id field
 * // Returns: "00000003-0004-0000-0000-000000028105"
 */
export function buildSchemaUuidV2(fieldId: number): string {
  if (fieldId === undefined || isNaN(fieldId)) {
    throw new Error(`Invalid fieldId: ${fieldId}`);
  }
  // 0004 = ir.model.fields model_id (constant for all schema entries)
  return `${UUID_NAMESPACES.SCHEMA}-0004-0000-0000-${pad(fieldId, 12)}`;
}

/**
 * Build Schema UUID V2 for Simple Schema Format
 *
 * Creates a schema UUID using the model_id from the simple schema format.
 * Unlike buildSchemaUuidV2() which hardcodes 0004, this function uses the
 * actual model_id from the user's schema.
 *
 * Format: 00000003-MMMM-0000-0000-FFFFFFFFFFFF
 * - Segment 1: 00000003 (schema namespace)
 * - Segment 2: MMMM (model_id from simple schema, 4 digits)
 * - Segment 3: 0000 (reserved)
 * - Segment 4: 0000 (reserved)
 * - Segment 5: FFFFFFFFFFFF (field_id, 12 digits)
 *
 * @param fieldId - Field ID from schema
 * @param modelId - Model ID from schema (not hardcoded)
 * @returns UUID string
 *
 * @example
 * buildSchemaUuidV2Simple(202, 2)  // country.name (field_id=202, model_id=2)
 * // Returns: "00000003-0002-0000-0000-000000000202"
 *
 * @example
 * buildSchemaUuidV2Simple(104, 1)  // customer.country_id (field_id=104, model_id=1)
 * // Returns: "00000003-0001-0000-0000-000000000104"
 */
export function buildSchemaUuidV2Simple(fieldId: number, modelId: number): string {
  if (fieldId === undefined || isNaN(fieldId)) {
    throw new Error(`Invalid fieldId: ${fieldId}`);
  }
  if (modelId === undefined || isNaN(modelId)) {
    throw new Error(`Invalid modelId: ${modelId}`);
  }
  return `${UUID_NAMESPACES.SCHEMA}-${pad(modelId, 4)}-0000-0000-${pad(fieldId, 12)}`;
}

/**
 * Build V2 Schema FK Reference UUID
 *
 * Creates a reference UUID pointing to a target schema entry.
 * Used in FK fields to reference the target model's schema.
 *
 * @param targetModelId - Target model's ir.model.id (4 digits)
 * @param targetFieldId - Target field's ir.model.fields.id
 * @returns UUID like "00000003-0078-0000-0000-000000001041"
 *
 * @example
 * buildSchemaFkRefUuidV2(78, 1041)  // Reference to res.partner.id field
 * // Returns: "00000003-0078-0000-0000-000000001041"
 */
export function buildSchemaFkRefUuidV2(targetModelId: number, targetFieldId: number): string {
  if (targetModelId === undefined || isNaN(targetModelId)) {
    throw new Error(`Invalid targetModelId: ${targetModelId}`);
  }
  if (targetFieldId === undefined || isNaN(targetFieldId)) {
    throw new Error(`Invalid targetFieldId: ${targetFieldId}`);
  }
  return `${UUID_NAMESPACES.SCHEMA}-${pad(targetModelId, 4)}-0000-0000-${pad(targetFieldId, 12)}`;
}

/**
 * Parse V2 Schema UUID to extract fieldId
 *
 * @param uuid - Schema UUID to parse
 * @returns Object with fieldId, or null if invalid format
 *
 * @example
 * parseSchemaUuidV2("00000003-0004-0000-0000-000000005012")
 * // Returns: { fieldId: 5012 }
 */
export function parseSchemaUuidV2(uuid: string): { fieldId: number } | null {
  // Match the standard schema UUID format (with constant 0004)
  const match = uuid.match(/^00000003-0004-0000-0000-(\d{12})$/);
  if (!match) return null;
  return { fieldId: parseInt(match[1], 10) };
}

/**
 * Parse V2 Schema FK Reference UUID
 *
 * @param uuid - Schema FK reference UUID to parse
 * @returns Object with targetModelId and targetFieldId, or null if invalid
 *
 * @example
 * parseSchemaFkRefUuidV2("00000003-0078-0000-0000-000000001041")
 * // Returns: { targetModelId: 78, targetFieldId: 1041 }
 */
export function parseSchemaFkRefUuidV2(uuid: string): { targetModelId: number; targetFieldId: number } | null {
  const match = uuid.match(/^00000003-(\d{4})-0000-0000-(\d{12})$/);
  if (!match) return null;
  return {
    targetModelId: parseInt(match[1], 10),
    targetFieldId: parseInt(match[2], 10),
  };
}

/**
 * Validate V2 Schema UUID format
 *
 * Accepts both standard schema UUIDs (0004) and FK reference UUIDs (variable model_id)
 *
 * @param uuid - UUID string to validate
 * @returns true if valid V2 Schema UUID format
 *
 * @example
 * isValidSchemaUuidV2("00000003-0004-0000-0000-000000005012") // true
 * isValidSchemaUuidV2("00000003-0078-0000-0000-000000001041") // true (FK ref)
 * isValidSchemaUuidV2("00000002-0312-0000-000000691174") // false (data UUID)
 */
export function isValidSchemaUuidV2(uuid: string): boolean {
  return /^00000003-\d{4}-0000-0000-\d{12}$/.test(uuid);
}

// ============================================================================
// GRAPH UUID (00000001)
// Format: 00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF (valid UUID: 8-4-4-4-12)
// Where: SSSS = source model, TTTT = target model, RR = relationship code, F = field_id
// ============================================================================

/**
 * Build V2 Graph UUID for FK relationship
 *
 * Creates a unique identifier for a relationship edge in the knowledge graph.
 * Encodes source model, target model, relationship type, and field ID.
 *
 * Format: 00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF (valid UUID: 8-4-4-4-12)
 *
 * Relationship Type Codes:
 * - '11' = One to One (rare in Odoo)
 * - '21' = One to Many
 * - '31' = Many to One (most common FK)
 * - '41' = Many to Many
 *
 * @param sourceModelId - Source model ID (model containing the FK)
 * @param targetModelId - Target model ID (model being referenced)
 * @param fieldId - FK field's ir.model.fields.id
 * @param relationshipType - Type code: '11'|'21'|'31'|'41' (default: '31')
 * @returns UUID like "00000001-0312-0078-0031-000000005012"
 *
 * @example
 * buildGraphUuidV2(312, 78, 5012, '31')  // account.move.line.partner_id → res.partner
 * // Returns: "00000001-0312-0078-0031-000000005012"
 *
 * @example
 * buildGraphUuidV2(344, 103, 6327, '31')  // crm.lead.stage_id → crm.stage
 * // Returns: "00000001-0344-0103-0031-000000006327"
 */
export function buildGraphUuidV2(
  sourceModelId: number,
  targetModelId: number,
  fieldId: number,
  relationshipType: string = '31'
): string {
  if (sourceModelId === undefined || isNaN(sourceModelId)) {
    throw new Error(`Invalid sourceModelId: ${sourceModelId}`);
  }
  if (targetModelId === undefined || isNaN(targetModelId)) {
    throw new Error(`Invalid targetModelId: ${targetModelId}`);
  }
  if (fieldId === undefined || isNaN(fieldId)) {
    throw new Error(`Invalid fieldId: ${fieldId}`);
  }

  // Validate relationship type
  const validTypes = ['11', '21', '31', '41'];
  if (!validTypes.includes(relationshipType)) {
    throw new Error(`Invalid relationshipType: ${relationshipType}. Must be one of: ${validTypes.join(', ')}`);
  }

  // Format: 8-4-4-4-12 (valid UUID format for Qdrant)
  // 00RR = relationship type with 00 prefix to make 4 chars
  return `${UUID_NAMESPACES.GRAPH}-${pad(sourceModelId, 4)}-${pad(targetModelId, 4)}-00${relationshipType}-${pad(fieldId, 12)}`;
}

/**
 * Parse V2 Graph UUID to extract all components
 *
 * @param uuid - Graph UUID to parse
 * @returns Object with sourceModelId, targetModelId, relationshipType, fieldId, or null if invalid
 *
 * @example
 * parseGraphUuidV2("00000001-0312-0078-0031-000000005012")
 * // Returns: { sourceModelId: 312, targetModelId: 78, relationshipType: '31', fieldId: 5012 }
 */
export function parseGraphUuidV2(uuid: string): {
  sourceModelId: number;
  targetModelId: number;
  relationshipType: string;
  fieldId: number;
} | null {
  const match = uuid.match(/^00000001-(\d{4})-(\d{4})-00(\d{2})-(\d{12})$/);
  if (!match) return null;
  return {
    sourceModelId: parseInt(match[1], 10),
    targetModelId: parseInt(match[2], 10),
    relationshipType: match[3],
    fieldId: parseInt(match[4], 10),
  };
}

/**
 * Validate V2 Graph UUID format
 *
 * @param uuid - UUID string to validate
 * @returns true if valid V2 Graph UUID format
 *
 * @example
 * isValidGraphUuidV2("00000001-0312-0078-0031-000000005012") // true
 * isValidGraphUuidV2("00000002-0312-0000-0000-000000691174") // false (data UUID)
 */
export function isValidGraphUuidV2(uuid: string): boolean {
  return /^00000001-\d{4}-\d{4}-00\d{2}-\d{12}$/.test(uuid);
}

// ============================================================================
// UUID TYPE DETECTION
// ============================================================================

/**
 * Detect UUID type from namespace prefix
 *
 * Identifies whether a UUID is for graph, data, or schema based on its prefix.
 *
 * @param uuid - Any V2 UUID string
 * @returns 'graph' | 'data' | 'schema' | null
 *
 * @example
 * getUuidType("00000001-0312-0078-310000005012") // 'graph'
 * getUuidType("00000002-0312-0000-000000691174") // 'data'
 * getUuidType("00000003-0004-0000-0000-000000005012") // 'schema'
 * getUuidType("invalid-uuid") // null
 */
export function getUuidType(uuid: string): 'graph' | 'data' | 'schema' | null {
  if (!uuid || typeof uuid !== 'string') return null;
  if (uuid.startsWith(UUID_NAMESPACES.GRAPH)) return 'graph';
  if (uuid.startsWith(UUID_NAMESPACES.DATA)) return 'data';
  if (uuid.startsWith(UUID_NAMESPACES.SCHEMA)) return 'schema';
  return null;
}

/**
 * Check if a UUID is a V2 format UUID (any type)
 *
 * @param uuid - UUID string to check
 * @returns true if it's a valid V2 UUID (graph, data, or schema)
 */
export function isV2Uuid(uuid: string): boolean {
  return isValidGraphUuidV2(uuid) || isValidDataUuidV2(uuid) || isValidSchemaUuidV2(uuid);
}

// ============================================================================
// RELATIONSHIP TYPE HELPERS
// ============================================================================

/**
 * Get relationship type code from Odoo field type (ttype)
 *
 * Converts Odoo's field type string to the corresponding V2 relationship code.
 *
 * @param fieldType - Odoo field type (ttype): 'one2one', 'one2many', 'many2one', 'many2many'
 * @returns Relationship code: '11', '21', '31', or '41' (defaults to '11' for unknown)
 *
 * @example
 * getRelationshipTypeCode('many2one') // '31'
 * getRelationshipTypeCode('one2many') // '21'
 * getRelationshipTypeCode('many2many') // '41'
 */
export function getRelationshipTypeCode(fieldType: string): string {
  return TTYPE_TO_RELATIONSHIP_CODE[fieldType] || '11';
}

/**
 * Get human-readable relationship name from code
 *
 * @param code - Relationship code: '11', '21', '31', '41'
 * @returns Human-readable name
 *
 * @example
 * getRelationshipName('31') // 'Many to One'
 * getRelationshipName('21') // 'One to Many'
 */
export function getRelationshipName(code: string): string {
  const names: Record<string, string> = {
    '11': 'One to One',
    '21': 'One to Many',
    '31': 'Many to One',
    '41': 'Many to Many',
  };
  return names[code] || 'Unknown';
}

/**
 * Get Odoo ttype from relationship code
 *
 * Reverse lookup: converts V2 relationship code back to Odoo field type.
 *
 * @param code - Relationship code: '11', '21', '31', '41'
 * @returns Odoo ttype string
 *
 * @example
 * getOdooTtype('31') // 'many2one'
 * getOdooTtype('21') // 'one2many'
 */
export function getOdooTtype(code: string): string {
  const ttypes: Record<string, string> = {
    '11': 'one2one',
    '21': 'one2many',
    '31': 'many2one',
    '41': 'many2many',
  };
  return ttypes[code] || 'unknown';
}
