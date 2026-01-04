/**
 * Odoo Schema Fetcher Service
 *
 * Fetches schema metadata from Odoo's ir.model and ir.model.fields tables
 * and generates V2 UUID format schema rows for the unified collection.
 *
 * Part of Stage 0: Auto-Generate Schema from Odoo
 */

import { OdooClient } from './odoo-client.js';

// ============================================================================
// V2 UUID CONSTANTS
// ============================================================================

/** Namespace prefixes for V2 UUIDs */
export const UUID_NAMESPACES = {
  GRAPH: '00000001',   // Knowledge graph relationships
  DATA: '00000002',    // Data points (records)
  SCHEMA: '00000003',  // Schema definitions
} as const;

/** Relationship type codes
 * 11 = One to one
 * 21 = One to many
 * 31 = Many to one
 * 41 = Many to many
 */
export const TTYPE_TO_RELATIONSHIP: Record<string, string> = {
  'one2one': '11',    // One to one (rare in Odoo)
  'one2many': '21',   // One to many
  'many2one': '31',   // Many to one
  'many2many': '41',  // Many to many
};

// ============================================================================
// TYPES
// ============================================================================

/** Raw Odoo model from ir.model */
export interface OdooModel {
  id: number;
  model: string;     // Technical name (e.g., "account.move.line")
  name: string;      // Display name (e.g., "Journal Entry Line")
  state: string;     // 'manual' or 'base'
}

/** Raw Odoo field from ir.model.fields */
export interface OdooField {
  id: number;
  name: string;              // Technical name (e.g., "partner_id")
  field_description: string; // Display label (e.g., "Partner")
  ttype: string;             // Field type (many2one, char, etc.)
  relation: string | false;  // Target model for FK fields
  store: boolean;            // Is stored in database
  model_id: [number, string];// [model_id, model_name] tuple
  model: string;             // Model technical name
}

/** V2 Schema row for Excel output */
export interface V2SchemaRow {
  qdrant_id: string;      // V2 UUID: 00000003-MMMM-FFFF-HHHHHHHHHHHH
  semantic_text: string;  // 9-component text for embedding
  raw_payload: string;    // Key-value pairs

  // Parsed fields for reference
  field_id: number;
  model_id: number;
  field_name: string;
  field_label: string;
  field_type: string;
  model_name: string;
  stored: boolean;

  // FK metadata (optional)
  fk_target_model?: string;
  fk_target_model_id?: number;
  graph_ref?: string;
  relationship_type?: string;
}

// ============================================================================
// V2 UUID GENERATION
// ============================================================================

/**
 * Pad a number to the specified number of digits
 */
function pad(num: number, digits: number): string {
  return num.toString().padStart(digits, '0');
}

/**
 * Generate V2 Schema UUID
 * Format: 00000003-0004-0000-0000-FFFFFFFFFFFF
 *
 * Segment 2 is ALWAYS 0004 because all schema entries describe
 * fields in ir.model.fields (model_id = 4 in Odoo).
 *
 * Uses Field ID directly for:
 * - Direct Odoo lookup capability
 * - Guaranteed uniqueness (primary key)
 *
 * @param fieldId - ir.model.fields.id (unique field identifier)
 */
export function generateSchemaUuidV2(fieldId: number): string {
  // 0004 = ir.model.fields model_id (constant for all schema entries)
  return `${UUID_NAMESPACES.SCHEMA}-0004-0000-0000-${pad(fieldId, 12)}`;
}

/**
 * Generate V2 Schema FK Reference UUID
 * Format: 00000003-MMMM-0000-0000-FFFFFFFFFFFF
 *
 * Used for FK references pointing to target schema entries.
 *
 * @param targetModelId - Target model's ir.model.id (4 digits)
 * @param targetFieldId - Target field's ir.model.fields.id
 */
export function generateSchemaFkRefUuidV2(targetModelId: number, targetFieldId: number): string {
  return `${UUID_NAMESPACES.SCHEMA}-${pad(targetModelId, 4)}-0000-0000-${pad(targetFieldId, 12)}`;
}

/**
 * Generate V2 Graph UUID for FK relationships
 * Format: 00000001-SSSS-TTTT-RRFFFFFFFFFF
 *
 * Uses Field ID directly (last 10 digits) for consistency with Schema UUID.
 *
 * @param sourceModelId - Source model ID
 * @param targetModelId - Target model ID
 * @param fieldId - FK field's ir.model.fields.id
 * @param relationshipType - Relationship type code (21, 31, etc.)
 */
export function generateGraphUuidV2(
  sourceModelId: number,
  targetModelId: number,
  fieldId: number,
  relationshipType: string = '21'
): string {
  // Use field_id padded to 10 digits (2 digits for relationship type prefix)
  const fieldIdPadded = pad(fieldId, 10);
  return `${UUID_NAMESPACES.GRAPH}-${pad(sourceModelId, 4)}-${pad(targetModelId, 4)}-${relationshipType}${fieldIdPadded}`;
}

// ============================================================================
// SEMANTIC TEXT BUILDER
// ============================================================================

/**
 * Build semantic text for embedding
 *
 * Matches the format used in nexsus_schema_v2_generated.xlsx:
 * "In model ir.model.fields ,Field_ID - X, Model_ID - Y, Field_Name - Z, ..."
 *
 * For FK fields, includes FK metadata before Stored field.
 * This format is proven to work well with Voyage AI embeddings.
 */
export function buildSemanticText(
  fieldId: number,
  modelId: number,
  fieldName: string,
  fieldLabel: string,
  fieldType: string,
  modelName: string,
  stored: boolean,
  // FK parameters (optional)
  fkTargetModel?: string,
  fkTargetModelId?: number,
  fkTargetFieldId?: number,
  fkQdrantId?: string
): string {
  // Base text matching user's exact format
  let text = `In model ir.model.fields ,Field_ID - ${fieldId}, Model_ID - ${modelId}, ` +
    `Field_Name - ${fieldName}, Field_Label - ${fieldLabel}, ` +
    `Field_Type - ${fieldType}, Model_Name - ${modelName}`;

  // For FK fields, add FK metadata BEFORE Stored (matching user's format)
  if (fkTargetModel && fkTargetModelId) {
    text += `, FK location field model - ${fkTargetModel}`;
    text += `, FK location field model id - ${fkTargetModelId}`;
    if (fkTargetFieldId) {
      text += `, FK location record Id - ${fkTargetFieldId}`;
    }
    if (fkQdrantId) {
      text += `, Qdrant ID for FK - ${fkQdrantId}`;
    }
  }

  // Add Stored at the end
  text += `, Stored - ${stored ? 'Yes' : 'No'}`;

  return text;
}

// ============================================================================
// PAYLOAD STRING BUILDER
// ============================================================================

/**
 * Build V2 payload string for Excel Column C
 * Matches existing format with Data_type - 3 prefix
 */
export function buildPayloadString(
  pointId: string,
  fieldId: number,
  modelId: number,
  fieldName: string,
  fieldLabel: string,
  fieldType: string,
  modelName: string,
  stored: boolean,
  fkTargetModel?: string,
  fkTargetModelId?: number,
  fkTargetFieldId?: number,
  fkQdrantId?: string,
  graphRef?: string,
  relationshipType?: string
): string {
  // Start with point_id (V2 UUID), then Data_type - 3 (Schema)
  let payload = `point_id - ${pointId}, Data_type - 3, Field_ID - ${fieldId}, Model_ID - ${modelId}, ` +
    `Field_Name - ${fieldName}, Field_Label - ${fieldLabel}, ` +
    `Field_Type - ${fieldType}, Model_Name - ${modelName}, ` +
    `Stored - ${stored ? 'Yes' : 'No'}`;

  // For FK fields, add cross-references (matching existing Excel format)
  if (fkTargetModel && fkTargetModelId) {
    payload += `, FK location field model - ${fkTargetModel}`;
    payload += `, FK location field model id - ${fkTargetModelId}`;
    if (fkTargetFieldId) {
      payload += `, FK location record Id - ${fkTargetFieldId}`;
    }
    if (fkQdrantId) {
      payload += `, Qdrant ID for FK - ${fkQdrantId}`;
    }
  }

  return payload;
}

// ============================================================================
// ODOO FETCHER CLASS
// ============================================================================

export class OdooSchemaFetcher {
  private odooClient: OdooClient;
  private modelIdMap: Map<string, number> = new Map();
  private modelIdFieldMap: Map<number, number> = new Map();  // model_id -> 'id' field's field_id

  constructor(odooClient: OdooClient) {
    this.odooClient = odooClient;
  }

  /**
   * Fetch all models from ir.model
   */
  async fetchAllModels(): Promise<OdooModel[]> {
    console.error('[OdooSchemaFetcher] Fetching all models from ir.model...');

    const models = await this.odooClient.searchRead<OdooModel>(
      'ir.model',
      [],
      ['id', 'model', 'name', 'state'],
      { order: 'id asc' }
    );

    console.error(`[OdooSchemaFetcher] Found ${models.length} models`);

    // Build model name → ID map
    for (const model of models) {
      this.modelIdMap.set(model.model, model.id);
    }

    return models;
  }

  /**
   * Fetch all fields from ir.model.fields
   */
  async fetchAllFields(): Promise<OdooField[]> {
    console.error('[OdooSchemaFetcher] Fetching all fields from ir.model.fields...');

    const fields = await this.odooClient.searchRead<OdooField>(
      'ir.model.fields',
      [],
      ['id', 'name', 'field_description', 'ttype', 'relation', 'store', 'model_id', 'model'],
      { order: 'model_id asc, id asc' }
    );

    console.error(`[OdooSchemaFetcher] Found ${fields.length} fields`);
    return fields;
  }

  /**
   * Get model ID for a model name
   */
  getModelId(modelName: string): number | undefined {
    return this.modelIdMap.get(modelName);
  }

  /**
   * Fetch complete schema from Odoo and transform to V2 format
   */
  async fetchAllSchemaV2(): Promise<V2SchemaRow[]> {
    // First fetch all models to build the ID map
    await this.fetchAllModels();

    // Then fetch all fields
    const fields = await this.fetchAllFields();

    // Build map of model_id -> 'id' field's field_id (for FK lookups)
    console.error('[OdooSchemaFetcher] Building id field lookup map...');
    for (const field of fields) {
      if (field.name === 'id' && field.ttype === 'integer') {
        const modelId = field.model_id[0];
        this.modelIdFieldMap.set(modelId, field.id);
      }
    }
    console.error(`[OdooSchemaFetcher] Found ${this.modelIdFieldMap.size} model id fields`);

    console.error('[OdooSchemaFetcher] Transforming to V2 format...');

    const v2Rows: V2SchemaRow[] = [];

    for (const field of fields) {
      const modelId = field.model_id[0];

      // Get FK target info if this is a relational field
      let fkTargetModel: string | undefined;
      let fkTargetModelId: number | undefined;
      let fkTargetFieldId: number | undefined;
      let fkQdrantId: string | undefined;
      let graphRef: string | undefined;
      let relationshipType: string | undefined;

      if (field.relation && typeof field.relation === 'string') {
        fkTargetModel = field.relation;
        fkTargetModelId = this.getModelId(field.relation);

        if (fkTargetModelId) {
          // Look up the 'id' field's field_id for the target model
          fkTargetFieldId = this.modelIdFieldMap.get(fkTargetModelId);
          if (!fkTargetFieldId) {
            console.error(`[OdooSchemaFetcher] Warning: Could not find 'id' field for model ${fkTargetModel} (id=${fkTargetModelId})`);
          }

          // Generate FK Qdrant ID pointing to target schema entry (only if we have the field_id)
          if (fkTargetFieldId) {
            fkQdrantId = generateSchemaFkRefUuidV2(fkTargetModelId, fkTargetFieldId);
          }

          relationshipType = TTYPE_TO_RELATIONSHIP[field.ttype] || '11';
          graphRef = generateGraphUuidV2(modelId, fkTargetModelId, field.id, relationshipType);
        }
      }

      // Generate V2 UUID: 00000003-0004-0000-0000-{field_id}
      const qdrantId = generateSchemaUuidV2(field.id);

      // Build semantic text (simple format matching existing Excel)
      const semanticText = buildSemanticText(
        field.id,
        modelId,
        field.name,
        field.field_description || field.name,
        field.ttype,
        field.model,
        field.store,
        fkTargetModel,
        fkTargetModelId,
        fkTargetFieldId,
        fkQdrantId
      );

      // Build payload string with point_id (V2 UUID) and Data_type - 3
      const rawPayload = buildPayloadString(
        qdrantId,  // point_id (V2 UUID)
        field.id,
        modelId,
        field.name,
        field.field_description || field.name,
        field.ttype,
        field.model,
        field.store,
        fkTargetModel,
        fkTargetModelId,
        fkTargetFieldId,
        fkQdrantId,
        graphRef,
        relationshipType
      );

      v2Rows.push({
        qdrant_id: qdrantId,
        semantic_text: semanticText,
        raw_payload: rawPayload,
        field_id: field.id,
        model_id: modelId,
        field_name: field.name,
        field_label: field.field_description || field.name,
        field_type: field.ttype,
        model_name: field.model,
        stored: field.store,
        fk_target_model: fkTargetModel,
        fk_target_model_id: fkTargetModelId,
        graph_ref: graphRef,
        relationship_type: relationshipType,
      });
    }

    console.error(`[OdooSchemaFetcher] Generated ${v2Rows.length} V2 schema rows`);
    return v2Rows;
  }
}

/**
 * Create an OdooSchemaFetcher instance with default configuration
 */
export function createOdooSchemaFetcher(): OdooSchemaFetcher {
  // Import env config
  const config = {
    url: process.env.ODOO_URL || '',
    db: process.env.ODOO_DB || '',
    username: process.env.ODOO_USERNAME || '',
    password: process.env.ODOO_PASSWORD || '',
  };

  if (!config.url || !config.db || !config.username || !config.password) {
    throw new Error('Missing Odoo configuration. Set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD');
  }

  const odooClient = new OdooClient(config);
  return new OdooSchemaFetcher(odooClient);
}
