/**
 * Field Knowledge Schema - Level 4 Knowledge
 *
 * Defines the schema for field-level knowledge that extends the existing
 * SimpleSchemaRow with 6 additional columns for business meaning.
 *
 * Level 4 provides everything an LLM needs to understand EACH FIELD:
 * - Business meaning (what the field represents)
 * - Valid values (allowed values for coded fields)
 * - Data format (how to interpret the raw value)
 * - Calculation formula (for computed fields)
 * - Validation rules (constraints to be aware of)
 * - LLM usage notes (how to handle in responses)
 *
 * Usage:
 * - User asks: "What does the Month field mean?"
 * - Knowledge adapter searches for Field_Name: "Month"
 * - Returns: Field knowledge, valid values, data format, usage notes
 *
 * - User asks: "What are valid values for Entity?"
 * - Knowledge adapter searches for Field_Name: "Entity"
 * - Returns: Valid_Values with pipe-separated options
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

/**
 * Extended field knowledge columns (L-Q in Excel)
 *
 * These columns extend the existing SimpleSchemaRow with business meaning.
 */
export const FieldKnowledgeExtensionSchema = z.object({
  // Column L: Business meaning of the field
  Field_Knowledge: z.string()
    .optional()
    .describe('Business meaning of this field (e.g., "Outstanding balance after deductions")'),

  // Column M: Valid values (pipe-separated for coded fields)
  Valid_Values: z.string()
    .optional()
    .describe('Allowed values (pipe-separated: "draft|posted|cancel")'),

  // Column N: Data format/pattern
  Data_Format: z.string()
    .optional()
    .describe('Format or pattern (e.g., "Excel serial date (45658 = Jan 1, 2025)")'),

  // Column O: Calculation formula (for computed fields)
  Calculation_Formula: z.string()
    .optional()
    .describe('How this field is calculated (e.g., "debit - credit")'),

  // Column P: Validation rules
  Validation_Rules: z.string()
    .optional()
    .describe('Constraints (e.g., "amount >= 0, not null")'),

  // Column Q: LLM usage notes
  LLM_Usage_Notes: z.string()
    .optional()
    .describe('How LLM should handle this field (e.g., "Convert to human date before displaying")'),
});

export type FieldKnowledgeExtension = z.infer<typeof FieldKnowledgeExtensionSchema>;

/**
 * Complete Extended Schema Row (SimpleSchemaRow + Field Knowledge)
 *
 * This combines the existing 11-column SimpleSchemaRow with the 6 new knowledge columns.
 */
export const ExtendedSchemaRowSchema = z.object({
  // Existing SimpleSchemaRow columns (A-K)
  Field_ID: z.number().int().positive(),
  Model_ID: z.number().int().positive(),
  Field_Name: z.string().min(1),
  Field_Label: z.string(),
  Field_Type: z.string(),
  Model_Name: z.string().min(1),
  Stored: z.string(),

  // FK columns (optional)
  'FK location field model': z.string().optional(),
  'FK location field model id': z.number().optional(),
  'FK location record Id': z.number().optional(),
  'Qdrant ID for FK': z.string().optional(),

  // New Field Knowledge columns (L-Q)
  Field_Knowledge: z.string().optional(),
  Valid_Values: z.string().optional(),
  Data_Format: z.string().optional(),
  Calculation_Formula: z.string().optional(),
  Validation_Rules: z.string().optional(),
  LLM_Usage_Notes: z.string().optional(),
});

export type ExtendedSchemaRow = z.infer<typeof ExtendedSchemaRowSchema>;

// =============================================================================
// CATEGORY CODES
// =============================================================================

/**
 * Level code for UUID generation
 * Format: 00000005-0004-MMMM-0000-FFFFFFFFFFFF
 *
 * Where:
 * - 00000005 = Extended knowledge namespace
 * - 0004 = Level 4 (Field)
 * - MMMM = Model_ID
 * - FFFFFFFFFFFF = Field_ID
 */
export const FIELD_KNOWLEDGE_LEVEL_CODE = '0004';

// =============================================================================
// PAYLOAD STRUCTURE
// =============================================================================

/**
 * Payload structure for field knowledge points in Qdrant
 *
 * Stored with:
 * - point_type: 'knowledge'
 * - knowledge_level: 'field'
 */
export interface FieldKnowledgePayload {
  // Common knowledge fields
  point_type: 'knowledge';
  knowledge_level: 'field';
  vector_text: string;
  sync_timestamp: string;

  // Field identifiers (from SimpleSchemaRow)
  field_id: number;
  model_id: number;
  field_name: string;
  field_label: string;
  field_type: string;
  model_name: string;

  // Level 4 specific fields
  field_knowledge?: string;
  valid_values?: string[];  // Parsed from pipe-separated string
  data_format?: string;
  calculation_formula?: string;
  validation_rules?: string;
  llm_usage_notes?: string;
}

// =============================================================================
// SEMANTIC TEXT GENERATOR
// =============================================================================

/**
 * Generate semantic text for embedding from an extended schema row
 *
 * The generated text is designed for optimal vector search:
 * - Includes field name and label
 * - Includes business meaning (Field_Knowledge)
 * - Includes valid values (for coded fields)
 * - Includes LLM usage notes (CRITICAL for semantic matching)
 *
 * @param row - The extended schema row
 * @returns Semantic text for embedding
 */
export function generateFieldKnowledgeSemanticText(row: ExtendedSchemaRow): string {
  const parts = [
    `Field ${row.Field_Name} (${row.Field_Label}) in ${row.Model_Name}`,
    `Type: ${row.Field_Type}`,
  ];

  // Add knowledge if present
  if (row.Field_Knowledge) {
    parts.push(`Meaning: ${row.Field_Knowledge}`);
  }

  // Add valid values if present
  if (row.Valid_Values) {
    parts.push(`Valid values: ${row.Valid_Values}`);
  }

  // Add data format if present
  if (row.Data_Format) {
    parts.push(`Format: ${row.Data_Format}`);
  }

  // Add calculation formula if present
  if (row.Calculation_Formula) {
    parts.push(`Formula: ${row.Calculation_Formula}`);
  }

  // Add LLM usage notes if present (CRITICAL)
  if (row.LLM_Usage_Notes) {
    parts.push(`LLM guidance: ${row.LLM_Usage_Notes}`);
  }

  return parts.filter(Boolean).join('. ');
}

/**
 * Parse pipe-separated valid values string into array
 *
 * @param validValuesStr - Pipe-separated string (e.g., "draft|posted|cancel")
 * @returns Array of valid values
 */
export function parseValidValues(validValuesStr: string | undefined): string[] {
  if (!validValuesStr) return [];
  return validValuesStr.split('|').map(v => v.trim()).filter(Boolean);
}

// =============================================================================
// SAMPLE DATA
// =============================================================================

/**
 * Sample Field Knowledge for DuraCube (Nexsus1 example)
 *
 * This demonstrates the expected data structure for a complete Level 4 setup.
 * Only fields that need explanation should have knowledge filled in.
 */
export const SAMPLE_FIELD_KNOWLEDGE: FieldKnowledgeExtension[] = [
  // Month field (actual model) - requires date conversion
  {
    Field_Knowledge: 'Accounting period represented as Excel serial date',
    Valid_Values: '45292-46023',  // Range: Jul 2023 to Jun 2025
    Data_Format: 'Excel serial date. 45292 = Jul 2023, 45658 = Jan 2025, 45689 = Feb 2025',
    LLM_Usage_Notes: 'ALWAYS convert to human-readable date before displaying. Users expect "January 2025" not "45658".',
  },

  // Amount field (actual model) - sign interpretation
  {
    Field_Knowledge: 'Net transaction amount for the period. Sign indicates debit vs credit.',
    Data_Format: 'Decimal with 2 decimal places',
    Calculation_Formula: 'Sourced directly from GL transaction totals',
    Validation_Rules: 'Can be positive or negative',
    LLM_Usage_Notes: 'Positive = debit, negative = credit. When summing, be aware of sign conventions for revenue vs expense accounts.',
  },

  // F1 field (master model) - classification code
  {
    Field_Knowledge: 'Level 1 financial classification code for P&L grouping',
    Valid_Values: 'REV|VCOS|FCOS|OH',
    Data_Format: 'Uppercase 2-4 character code',
    LLM_Usage_Notes: 'REV=Revenue, VCOS=Variable Cost of Sales, FCOS=Fixed Cost of Sales, OH=Overhead. Use for P&L section grouping.',
  },

  // Entity field (master/actual model) - business segment
  {
    Field_Knowledge: 'Business segment or product line for segment reporting',
    Valid_Values: 'Product|Installation|Freight|Other',
    Data_Format: 'Capitalized single word',
    LLM_Usage_Notes: 'Use for segment reports. "Product" is core manufacturing, "Installation" is service revenue.',
  },

  // Classification field (master model) - full account type
  {
    Field_Knowledge: 'Full account type classification for financial statement mapping',
    Valid_Values: 'REV|VCOS|FCOS|OH|ASSET|LIABILITY|EQUITY',
    Data_Format: 'Uppercase code, may have sub-classifications',
    LLM_Usage_Notes: 'Primary grouping for GL accounts. Use for building Income Statement and Balance Sheet.',
  },
];

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate field knowledge extension columns
 *
 * @param extension - Field knowledge extension data
 * @returns Validation result
 */
export function validateFieldKnowledgeExtension(extension: unknown): {
  valid: boolean;
  data?: FieldKnowledgeExtension;
  error?: string;
} {
  try {
    const data = FieldKnowledgeExtensionSchema.parse(extension);
    return { valid: true, data };
  } catch (e) {
    return {
      valid: false,
      error: e instanceof Error ? e.message : 'Unknown validation error',
    };
  }
}

/**
 * Check if a field has any knowledge defined
 *
 * @param row - Extended schema row
 * @returns True if any knowledge column is filled
 */
export function hasFieldKnowledge(row: ExtendedSchemaRow): boolean {
  return !!(
    row.Field_Knowledge ||
    row.Valid_Values ||
    row.Data_Format ||
    row.Calculation_Formula ||
    row.Validation_Rules ||
    row.LLM_Usage_Notes
  );
}

/**
 * Identify fields that should have knowledge but don't
 *
 * Fields that typically need explanation:
 * - Date fields (need format explanation)
 * - Selection/enum fields (need valid values)
 * - Calculated fields (need formula)
 * - Coded fields (need meaning)
 *
 * @param rows - Extended schema rows
 * @returns Fields that likely need knowledge added
 */
export function identifyFieldsNeedingKnowledge(rows: ExtendedSchemaRow[]): Array<{
  field_id: number;
  field_name: string;
  model_name: string;
  reason: string;
}> {
  const needsKnowledge: Array<{
    field_id: number;
    field_name: string;
    model_name: string;
    reason: string;
  }> = [];

  for (const row of rows) {
    // Skip if already has knowledge
    if (hasFieldKnowledge(row)) continue;

    // Date fields need format explanation
    if (['date', 'datetime'].includes(row.Field_Type.toLowerCase())) {
      needsKnowledge.push({
        field_id: row.Field_ID,
        field_name: row.Field_Name,
        model_name: row.Model_Name,
        reason: 'Date field - needs Data_Format explanation',
      });
    }

    // Selection fields need valid values
    if (row.Field_Type.toLowerCase() === 'selection') {
      needsKnowledge.push({
        field_id: row.Field_ID,
        field_name: row.Field_Name,
        model_name: row.Model_Name,
        reason: 'Selection field - needs Valid_Values',
      });
    }

    // Fields with coded names need explanation
    const codedPatterns = ['_id', '_code', '_type', 'status', 'state'];
    if (codedPatterns.some(p => row.Field_Name.toLowerCase().includes(p))) {
      needsKnowledge.push({
        field_id: row.Field_ID,
        field_name: row.Field_Name,
        model_name: row.Model_Name,
        reason: 'Likely coded field - needs Field_Knowledge',
      });
    }
  }

  return needsKnowledge;
}

/**
 * Merge base SimpleSchemaRow with knowledge extension
 *
 * @param baseRow - Original SimpleSchemaRow data
 * @param knowledge - Field knowledge extension data
 * @returns Complete ExtendedSchemaRow
 */
export function mergeSchemaWithKnowledge(
  baseRow: Record<string, unknown>,
  knowledge: FieldKnowledgeExtension
): ExtendedSchemaRow {
  return ExtendedSchemaRowSchema.parse({
    ...baseRow,
    ...knowledge,
  });
}
