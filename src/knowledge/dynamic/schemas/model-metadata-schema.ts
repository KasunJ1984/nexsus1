/**
 * Model Metadata Schema - Level 3 Knowledge
 *
 * Defines the schema for model/table metadata that will be stored in Qdrant
 * and retrieved via semantic search at runtime.
 *
 * Level 3 provides everything an LLM needs to understand EACH MODEL:
 * - Business meaning (what the table contains, what one row represents)
 * - Usage guidance (when to query this model, how to query effectively)
 * - Relationships (FK connections to other models)
 * - Known issues (data quality notes, limitations)
 *
 * Usage:
 * - User asks: "What does the actual model contain?"
 * - Knowledge adapter searches for Model_Name: "actual"
 * - Returns: Business purpose, grain, query guidance
 *
 * - User asks: "How do I query the master model?"
 * - Knowledge adapter searches for Model_Name: "master"
 * - Returns: LLM_Query_Guidance with specific instructions
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

/**
 * Full Model Metadata row schema
 *
 * Maps to Sheet 2: Model_Metadata in Excel
 */
export const ModelMetadataRowSchema = z.object({
  // Model identifier (links to schema Model_ID)
  Model_ID: z.number()
    .int()
    .positive()
    .describe('Model ID that matches Schema sheet Model_ID'),

  // Technical model name
  Model_Name: z.string()
    .min(1)
    .describe('Technical model name (e.g., "master", "actual", "res.partner")'),

  // Human-friendly name
  Business_Name: z.string()
    .describe('Human-friendly name (e.g., "Chart of Accounts", "Monthly Actuals")'),

  // What this table contains
  Business_Purpose: z.string()
    .describe('What this table contains (e.g., "GL account definitions and classifications")'),

  // What one row represents
  Data_Grain: z.string()
    .describe('What one row represents (e.g., "One row per GL account", "One row per account/month")'),

  // Approximate record count
  Record_Count: z.number()
    .int()
    .nonnegative()
    .optional()
    .describe('Approximate number of records in this model'),

  // Whether nexsus_search is available
  Is_Payload_Enabled: z.boolean()
    .describe('Can use nexsus_search (payload fields configured)'),

  // When to use this model
  Primary_Use_Cases: z.string()
    .describe('When to query this model (e.g., "Account lookups, classification mapping")'),

  // FK relationships
  Key_Relationships: z.string()
    .optional()
    .describe('FK connections (e.g., "actual.Account_Id -> master.Id")'),

  // How to query effectively
  LLM_Query_Guidance: z.string()
    .describe('How to query this model effectively (e.g., "Use Id for exact lookup, Gllinkname for semantic search")'),

  // Data quality notes
  Known_Issues: z.string()
    .optional()
    .describe('Data quality notes (e.g., "Some DCFL fields are undocumented")'),

  // Last update timestamp
  Last_Updated: z.string()
    .optional()
    .describe('When this metadata was last modified (ISO date or Excel serial)'),
});

export type ModelMetadataRow = z.infer<typeof ModelMetadataRowSchema>;

// =============================================================================
// CATEGORY CODES
// =============================================================================

/**
 * Level code for UUID generation
 * Format: 00000005-0003-MMMM-0000-IIIIIIIIIIII
 *
 * Where:
 * - 00000005 = Extended knowledge namespace
 * - 0003 = Level 3 (Model)
 * - MMMM = Model_ID
 * - IIIIIIIIIIII = 000000000000 (single metadata per model)
 */
export const MODEL_METADATA_LEVEL_CODE = '0003';

// =============================================================================
// PAYLOAD STRUCTURE
// =============================================================================

/**
 * Payload structure for model metadata points in Qdrant
 *
 * Stored with:
 * - point_type: 'knowledge'
 * - knowledge_level: 'model'
 */
export interface ModelMetadataPayload {
  // Common knowledge fields
  point_type: 'knowledge';
  knowledge_level: 'model';
  vector_text: string;
  sync_timestamp: string;

  // Level 3 specific fields
  model_id: number;
  model_name: string;
  business_name: string;
  business_purpose: string;
  data_grain: string;
  record_count?: number;
  is_payload_enabled: boolean;
  primary_use_cases: string;
  key_relationships?: string;
  llm_query_guidance: string;
  known_issues?: string;
  last_updated?: string;
}

// =============================================================================
// SEMANTIC TEXT GENERATOR
// =============================================================================

/**
 * Generate semantic text for embedding from a model metadata row
 *
 * The generated text is designed for optimal vector search:
 * - Includes both technical and business names
 * - Includes purpose and grain
 * - Includes query guidance (CRITICAL for semantic matching)
 *
 * @param row - The model metadata row
 * @returns Semantic text for embedding
 */
export function generateModelMetadataSemanticText(row: ModelMetadataRow): string {
  const parts = [
    `Model ${row.Model_Name} (${row.Business_Name})`,
    `Purpose: ${row.Business_Purpose}`,
    `Grain: ${row.Data_Grain}`,
    `Use cases: ${row.Primary_Use_Cases}`,
    `Query guidance: ${row.LLM_Query_Guidance}`,
  ];

  // Add optional fields if present
  if (row.Key_Relationships) {
    parts.push(`Relationships: ${row.Key_Relationships}`);
  }
  if (row.Known_Issues) {
    parts.push(`Known issues: ${row.Known_Issues}`);
  }
  if (row.Is_Payload_Enabled) {
    parts.push('Supports nexsus_search with payload filtering.');
  } else {
    parts.push('Use semantic_search only (no payload filtering).');
  }

  return parts.filter(Boolean).join('. ');
}

// =============================================================================
// SAMPLE DATA
// =============================================================================

/**
 * Sample Model Metadata for DuraCube (Nexsus1 example)
 *
 * This demonstrates the expected data structure for a complete Level 3 setup.
 */
export const SAMPLE_MODEL_METADATA: ModelMetadataRow[] = [
  {
    Model_ID: 1,
    Model_Name: 'master',
    Business_Name: 'Chart of Accounts',
    Business_Purpose: 'GL account definitions and classifications. Contains the master list of all general ledger accounts with their hierarchies and reporting classifications.',
    Data_Grain: 'One row per GL account',
    Record_Count: 560,
    Is_Payload_Enabled: true,
    Primary_Use_Cases: 'Account lookups, classification mapping, building GL hierarchies for reports',
    Key_Relationships: 'actual.Account_Id -> master.Id',
    LLM_Query_Guidance: 'Use Id for exact account lookup. Use Gllinkname for semantic search. Filter by Classification or F1 for account type grouping (REV, VCOS, FCOS, OH).',
    Known_Issues: 'Some DCFL fields are undocumented legacy codes. Entity field uses abbreviations.',
  },
  {
    Model_ID: 2,
    Model_Name: 'actual',
    Business_Name: 'Monthly Actuals',
    Business_Purpose: 'Monthly actual financial figures by GL account. Contains debit, credit, and balance amounts for each account for each accounting period.',
    Data_Grain: 'One row per account per month',
    Record_Count: 15000,
    Is_Payload_Enabled: false,
    Primary_Use_Cases: 'Financial reporting, variance analysis, revenue/expense queries by period',
    Key_Relationships: 'actual.Account_Id -> master.Id (FK to Chart of Accounts)',
    LLM_Query_Guidance: 'SEMANTIC SEARCH ONLY - no payload filtering available. Query by account description or classification name. For aggregations, use semantic search to find relevant accounts first, then sum amounts.',
    Known_Issues: 'Month field is Excel serial date (45292 = Jul 2023, 45658 = Jan 2025). Balance may be net (debit - credit) or absolute depending on account type.',
  },
];

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate a batch of model metadata rows
 *
 * @param rows - Array of model metadata rows to validate
 * @returns Validation result with errors if any
 */
export function validateModelMetadataBatch(rows: unknown[]): {
  valid: boolean;
  validRows: ModelMetadataRow[];
  errors: Array<{ index: number; error: string }>;
} {
  const validRows: ModelMetadataRow[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  rows.forEach((row, index) => {
    try {
      validRows.push(ModelMetadataRowSchema.parse(row));
    } catch (e) {
      errors.push({
        index,
        error: e instanceof Error ? e.message : 'Unknown validation error',
      });
    }
  });

  return {
    valid: errors.length === 0,
    validRows,
    errors,
  };
}

/**
 * Check that all Model_IDs in metadata exist in schema
 *
 * @param metadataRows - Model metadata rows
 * @param schemaModelIds - Set of Model_IDs from schema
 * @returns Validation result
 */
export function validateModelMetadataReferences(
  metadataRows: ModelMetadataRow[],
  schemaModelIds: Set<number>
): {
  valid: boolean;
  orphanModels: number[];
  missingMetadata: number[];
} {
  const metadataModelIds = new Set(metadataRows.map(r => r.Model_ID));

  // Models in metadata but not in schema
  const orphanModels = [...metadataModelIds].filter(id => !schemaModelIds.has(id));

  // Models in schema but no metadata
  const missingMetadata = [...schemaModelIds].filter(id => !metadataModelIds.has(id));

  return {
    valid: orphanModels.length === 0,
    orphanModels,
    missingMetadata, // Warning only - not all models need metadata
  };
}

/**
 * Validate Is_Payload_Enabled matches actual configuration
 *
 * @param metadataRows - Model metadata rows
 * @param payloadEnabledModels - Set of model names with payload configured
 * @returns Validation result
 */
export function validatePayloadEnabledFlags(
  metadataRows: ModelMetadataRow[],
  payloadEnabledModels: Set<string>
): {
  valid: boolean;
  mismatches: Array<{ model_name: string; declared: boolean; actual: boolean }>;
} {
  const mismatches: Array<{ model_name: string; declared: boolean; actual: boolean }> = [];

  for (const row of metadataRows) {
    const actual = payloadEnabledModels.has(row.Model_Name);
    if (row.Is_Payload_Enabled !== actual) {
      mismatches.push({
        model_name: row.Model_Name,
        declared: row.Is_Payload_Enabled,
        actual,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}
