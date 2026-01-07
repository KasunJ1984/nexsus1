/**
 * Knowledge Point Builder
 *
 * Converts Excel knowledge rows into Qdrant-ready knowledge points with embeddings.
 *
 * Builds points for:
 * - Level 2: Instance Config points
 * - Level 3: Model Metadata points
 * - Level 4: Field Knowledge points
 *
 * UUID Format: 00000005-LLLL-MMMM-0000-IIIIIIIIIIII
 * Where:
 * - 00000005 = Extended knowledge namespace
 * - LLLL = Level (0002=instance, 0003=model, 0004=field)
 * - MMMM = Model_ID (0000 for instance level)
 * - IIIIIIIIIIII = Item index or Field_ID
 */

import {
  generateInstanceConfigSemanticText,
  generateModelMetadataSemanticText,
  generateFieldKnowledgeSemanticText,
  parseValidValues,
  hasFieldKnowledge,
  EXTENDED_KNOWLEDGE_NAMESPACE,
  EXTENDED_KNOWLEDGE_LEVEL_CODES,
  type InstanceConfigRow,
  type ModelMetadataRow,
  type ExtendedSchemaRow,
  type InstanceConfigPayload,
  type ModelMetadataPayload,
  type FieldKnowledgePayload,
} from '../schemas/index.js';

// =============================================================================
// UUID GENERATION
// =============================================================================

/**
 * Pad a number to the specified number of digits with leading zeros
 */
function pad(num: number, digits: number): string {
  return num.toString().padStart(digits, '0');
}

/**
 * Build Extended Knowledge UUID
 *
 * Format: 00000005-LLLL-MMMM-0000-IIIIIIIIIIII
 *
 * @param level - Knowledge level code ('0002', '0003', '0004')
 * @param modelId - Model ID (0 for instance level)
 * @param itemId - Item index or Field_ID
 * @returns UUID string
 *
 * @example
 * buildKnowledgeUuidV2('0002', 0, 1)
 * // Returns: "00000005-0002-0000-0000-000000000001" (Instance config #1)
 *
 * @example
 * buildKnowledgeUuidV2('0003', 1, 0)
 * // Returns: "00000005-0003-0001-0000-000000000000" (Model 1 metadata)
 *
 * @example
 * buildKnowledgeUuidV2('0004', 2, 105)
 * // Returns: "00000005-0004-0002-0000-000000000105" (Field 105 in model 2)
 */
export function buildKnowledgeUuidV2(level: string, modelId: number, itemId: number): string {
  return `${EXTENDED_KNOWLEDGE_NAMESPACE}-${level}-${pad(modelId, 4)}-0000-${pad(itemId, 12)}`;
}

/**
 * Build Instance Config UUID (Level 2)
 *
 * @param itemIndex - Sequential index of the config item (1-based)
 * @returns UUID for instance config point
 */
export function buildInstanceConfigUuid(itemIndex: number): string {
  return buildKnowledgeUuidV2(EXTENDED_KNOWLEDGE_LEVEL_CODES.instance, 0, itemIndex);
}

/**
 * Build Model Metadata UUID (Level 3)
 *
 * @param modelId - Model ID from schema
 * @returns UUID for model metadata point
 */
export function buildModelMetadataUuid(modelId: number): string {
  return buildKnowledgeUuidV2(EXTENDED_KNOWLEDGE_LEVEL_CODES.model, modelId, 0);
}

/**
 * Build Field Knowledge UUID (Level 4)
 *
 * @param modelId - Model ID from schema
 * @param fieldId - Field ID from schema
 * @returns UUID for field knowledge point
 */
export function buildFieldKnowledgeUuid(modelId: number, fieldId: number): string {
  return buildKnowledgeUuidV2(EXTENDED_KNOWLEDGE_LEVEL_CODES.field, modelId, fieldId);
}

// =============================================================================
// POINT TYPES
// =============================================================================

/**
 * Knowledge point ready for Qdrant upsert
 */
export interface KnowledgePoint {
  id: string;
  vector: number[];
  payload: InstanceConfigPayload | ModelMetadataPayload | FieldKnowledgePayload;
}

/**
 * Knowledge point without vector (before embedding)
 */
export interface KnowledgePointPreEmbed {
  id: string;
  text: string;
  payload: InstanceConfigPayload | ModelMetadataPayload | FieldKnowledgePayload;
}

// =============================================================================
// LEVEL 2: INSTANCE CONFIG POINTS
// =============================================================================

/**
 * Build Instance Config knowledge points (Level 2)
 *
 * Converts InstanceConfigRow[] to KnowledgePointPreEmbed[] ready for embedding.
 *
 * @param rows - Instance config rows from Excel
 * @returns Array of points ready for embedding
 */
export function buildInstanceKnowledgePoints(rows: InstanceConfigRow[]): KnowledgePointPreEmbed[] {
  const points: KnowledgePointPreEmbed[] = [];
  const timestamp = new Date().toISOString();

  rows.forEach((row, index) => {
    const itemIndex = index + 1; // 1-based
    const id = buildInstanceConfigUuid(itemIndex);
    const text = generateInstanceConfigSemanticText(row);

    const payload: InstanceConfigPayload = {
      point_type: 'knowledge',
      knowledge_level: 'instance',
      vector_text: text,
      sync_timestamp: timestamp,
      config_key: row.Config_Key,
      config_value: row.Config_Value,
      config_category: row.Config_Category,
      description: row.Description,
      applies_to: row.Applies_To,
      llm_instruction: row.LLM_Instruction,
      last_updated: row.Last_Updated,
    };

    points.push({ id, text, payload });
  });

  return points;
}

// =============================================================================
// LEVEL 3: MODEL METADATA POINTS
// =============================================================================

/**
 * Build Model Metadata knowledge points (Level 3)
 *
 * Converts ModelMetadataRow[] to KnowledgePointPreEmbed[] ready for embedding.
 *
 * @param rows - Model metadata rows from Excel
 * @returns Array of points ready for embedding
 */
export function buildModelKnowledgePoints(rows: ModelMetadataRow[]): KnowledgePointPreEmbed[] {
  const points: KnowledgePointPreEmbed[] = [];
  const timestamp = new Date().toISOString();

  for (const row of rows) {
    const id = buildModelMetadataUuid(row.Model_ID);
    const text = generateModelMetadataSemanticText(row);

    const payload: ModelMetadataPayload = {
      point_type: 'knowledge',
      knowledge_level: 'model',
      vector_text: text,
      sync_timestamp: timestamp,
      model_id: row.Model_ID,
      model_name: row.Model_Name,
      business_name: row.Business_Name,
      business_purpose: row.Business_Purpose,
      data_grain: row.Data_Grain,
      record_count: row.Record_Count,
      is_payload_enabled: row.Is_Payload_Enabled,
      primary_use_cases: row.Primary_Use_Cases,
      key_relationships: row.Key_Relationships,
      llm_query_guidance: row.LLM_Query_Guidance,
      known_issues: row.Known_Issues,
      last_updated: row.Last_Updated,
    };

    points.push({ id, text, payload });
  }

  return points;
}

// =============================================================================
// LEVEL 4: FIELD KNOWLEDGE POINTS
// =============================================================================

/**
 * Build Field Knowledge points (Level 4)
 *
 * Converts ExtendedSchemaRow[] to KnowledgePointPreEmbed[] ready for embedding.
 * Only builds points for fields that have knowledge defined.
 *
 * @param rows - Extended schema rows from Excel
 * @param includeAllFields - If true, build points for all fields (not just those with knowledge)
 * @returns Array of points ready for embedding
 */
export function buildFieldKnowledgePoints(
  rows: ExtendedSchemaRow[],
  includeAllFields: boolean = false
): KnowledgePointPreEmbed[] {
  const points: KnowledgePointPreEmbed[] = [];
  const timestamp = new Date().toISOString();

  for (const row of rows) {
    // Skip fields without knowledge unless includeAllFields is true
    if (!includeAllFields && !hasFieldKnowledge(row)) {
      continue;
    }

    const id = buildFieldKnowledgeUuid(row.Model_ID, row.Field_ID);
    const text = generateFieldKnowledgeSemanticText(row);

    const payload: FieldKnowledgePayload = {
      point_type: 'knowledge',
      knowledge_level: 'field',
      vector_text: text,
      sync_timestamp: timestamp,
      field_id: row.Field_ID,
      model_id: row.Model_ID,
      field_name: row.Field_Name,
      field_label: row.Field_Label,
      field_type: row.Field_Type,
      model_name: row.Model_Name,
      field_knowledge: row.Field_Knowledge,
      valid_values: row.Valid_Values ? parseValidValues(row.Valid_Values) : undefined,
      data_format: row.Data_Format,
      calculation_formula: row.Calculation_Formula,
      validation_rules: row.Validation_Rules,
      llm_usage_notes: row.LLM_Usage_Notes,
    };

    points.push({ id, text, payload });
  }

  return points;
}

// =============================================================================
// COMBINED BUILDER
// =============================================================================

/**
 * Result of building all knowledge points
 */
export interface AllKnowledgePointsResult {
  instancePoints: KnowledgePointPreEmbed[];
  modelPoints: KnowledgePointPreEmbed[];
  fieldPoints: KnowledgePointPreEmbed[];
  totalPoints: number;
  summary: {
    level2Count: number;
    level3Count: number;
    level4Count: number;
  };
}

/**
 * Build all knowledge points from loaded knowledge data
 *
 * @param instanceConfigs - Instance config rows
 * @param modelMetadata - Model metadata rows
 * @param fieldKnowledge - Extended schema rows
 * @param includeAllFields - If true, include all fields in Level 4 (not just those with knowledge)
 * @returns All knowledge points ready for embedding
 */
export function buildAllKnowledgePoints(
  instanceConfigs: InstanceConfigRow[],
  modelMetadata: ModelMetadataRow[],
  fieldKnowledge: ExtendedSchemaRow[],
  includeAllFields: boolean = false
): AllKnowledgePointsResult {
  const instancePoints = buildInstanceKnowledgePoints(instanceConfigs);
  const modelPoints = buildModelKnowledgePoints(modelMetadata);
  const fieldPoints = buildFieldKnowledgePoints(fieldKnowledge, includeAllFields);

  return {
    instancePoints,
    modelPoints,
    fieldPoints,
    totalPoints: instancePoints.length + modelPoints.length + fieldPoints.length,
    summary: {
      level2Count: instancePoints.length,
      level3Count: modelPoints.length,
      level4Count: fieldPoints.length,
    },
  };
}

// =============================================================================
// UUID PARSING
// =============================================================================

/**
 * Parse Extended Knowledge UUID
 *
 * @param uuid - UUID to parse
 * @returns Parsed components or null if invalid
 */
export function parseKnowledgeUuidV2(uuid: string): {
  level: 'instance' | 'model' | 'field';
  modelId: number;
  itemId: number;
} | null {
  const match = uuid.match(/^00000005-(\d{4})-(\d{4})-0000-(\d{12})$/);
  if (!match) return null;

  const levelCode = match[1];
  const modelId = parseInt(match[2], 10);
  const itemId = parseInt(match[3], 10);

  let level: 'instance' | 'model' | 'field';
  switch (levelCode) {
    case '0002':
      level = 'instance';
      break;
    case '0003':
      level = 'model';
      break;
    case '0004':
      level = 'field';
      break;
    default:
      return null;
  }

  return { level, modelId, itemId };
}

/**
 * Check if UUID is a valid Extended Knowledge UUID
 */
export function isKnowledgeUuidV2(uuid: string): boolean {
  return /^00000005-000[234]-\d{4}-0000-\d{12}$/.test(uuid);
}
