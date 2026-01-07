/**
 * Instance Config Schema - Level 2 Knowledge
 *
 * Defines the schema for MCP instance configuration that will be stored in Qdrant
 * and retrieved via semantic search at runtime.
 *
 * Level 2 provides everything an LLM needs to understand THIS deployment:
 * - Business context (company, industry, users)
 * - Operational settings (fiscal year, currency, timezone)
 * - Technical configuration (synced models, embedding settings)
 * - Known limitations with workarounds (CRITICAL for LLM accuracy)
 * - Common query patterns
 *
 * Usage:
 * - User asks: "What company is this data for?"
 * - Knowledge adapter searches for Config_Key: "COMPANY_NAME"
 * - Returns: "DuraCube (The Almar Group)"
 *
 * - User asks: "What limitations should I know about?"
 * - Knowledge adapter searches for category: "limitation"
 * - Returns all limitation configs with workarounds
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

/**
 * Instance config category types
 *
 * Each category serves a specific purpose:
 * - operational: Company name, industry, timezone
 * - financial: Fiscal year, currency
 * - technical: Synced models, embedding settings
 * - limitation: Known issues with workarounds (CRITICAL)
 * - query: Common query patterns
 * - policy: Business rules, access policies
 */
export const InstanceConfigCategoryEnum = z.enum([
  'operational',  // Company name, industry, business unit, primary users
  'financial',    // Fiscal year, currency, date format
  'technical',    // Synced models, payload config, embedding model
  'limitation',   // Known issues with workarounds (CRITICAL for LLM accuracy)
  'query',        // Common query patterns with examples
  'policy',       // Business rules, access restrictions
]);

export type InstanceConfigCategory = z.infer<typeof InstanceConfigCategoryEnum>;

/**
 * Full Instance Config row schema
 *
 * Maps to Sheet 3: Instance_Config in Excel
 */
export const InstanceConfigRowSchema = z.object({
  // Unique identifier
  Config_Key: z.string()
    .min(1)
    .describe('Unique identifier (e.g., COMPANY_NAME, LIMITATION_NO_ACTUAL)'),

  // The configuration value
  Config_Value: z.string()
    .describe('The configuration value (e.g., "DuraCube (The Almar Group)")'),

  // Category for filtering
  Config_Category: InstanceConfigCategoryEnum
    .describe('Category: operational, financial, technical, limitation, query, policy'),

  // Human-readable description
  Description: z.string()
    .describe('What this config means (e.g., "Legal entity name used in reports")'),

  // Scope of application
  Applies_To: z.string()
    .default('all')
    .describe('Which models/tools this affects (e.g., "all", "actual", "nexsus_search")'),

  // LLM instruction for this config
  LLM_Instruction: z.string()
    .describe('How LLM should use this (e.g., "Always use this name when referencing the company")'),

  // Last update timestamp
  Last_Updated: z.string()
    .optional()
    .describe('When this config was last modified (ISO date or Excel serial)'),
});

export type InstanceConfigRow = z.infer<typeof InstanceConfigRowSchema>;

/**
 * Validation schema for limitation configs (requires LLM_Instruction)
 */
export const LimitationConfigSchema = InstanceConfigRowSchema.extend({
  Config_Category: z.literal('limitation'),
  // Limitations MUST have an LLM instruction explaining the workaround
  LLM_Instruction: z.string()
    .min(10, 'Limitation configs must have a detailed LLM_Instruction with workaround'),
});

export type LimitationConfig = z.infer<typeof LimitationConfigSchema>;

// =============================================================================
// CATEGORY CODES
// =============================================================================

/**
 * Category code for UUID generation
 * Format: 00000005-0002-0000-0000-IIIIIIIIIIII
 *
 * Where:
 * - 00000005 = Extended knowledge namespace
 * - 0002 = Level 2 (Instance)
 * - MMMM = 0000 (no model context)
 * - IIIIIIIIIIII = Config index (sequential)
 */
export const INSTANCE_CONFIG_LEVEL_CODE = '0002';

// =============================================================================
// REQUIRED CONFIG KEYS
// =============================================================================

/**
 * Required configuration keys for a complete Level 2 setup
 *
 * These keys provide minimum context for LLM-agnostic operation.
 */
export const REQUIRED_INSTANCE_CONFIG_KEYS = {
  // Business Context
  business: [
    'COMPANY_NAME',
    'INDUSTRY',
    'BUSINESS_UNIT',
    'PRIMARY_USERS',
    'BUSINESS_PURPOSE',
  ],

  // Operational Settings
  operational: [
    'FISCAL_YEAR_START',
    'FISCAL_YEAR_END',
    'DEFAULT_CURRENCY',
    'TIME_ZONE',
    'DATE_FORMAT',
  ],

  // Technical Configuration
  technical: [
    'SYNCED_MODELS',
    'PAYLOAD_ENABLED_MODELS',
    'SYNC_FREQUENCY',
    'DATA_LATENCY',
  ],

  // At least one limitation should be documented if any exist
  // limitation: ['LIMITATION_*'], // Pattern - any key starting with LIMITATION_
} as const;

// =============================================================================
// PAYLOAD STRUCTURE
// =============================================================================

/**
 * Payload structure for instance config points in Qdrant
 *
 * Stored with:
 * - point_type: 'knowledge'
 * - knowledge_level: 'instance'
 */
export interface InstanceConfigPayload {
  // Common knowledge fields
  point_type: 'knowledge';
  knowledge_level: 'instance';
  vector_text: string;
  sync_timestamp: string;

  // Level 2 specific fields
  config_key: string;
  config_value: string;
  config_category: InstanceConfigCategory;
  description: string;
  applies_to: string;
  llm_instruction: string;
  last_updated?: string;
}

// =============================================================================
// SEMANTIC TEXT GENERATOR
// =============================================================================

/**
 * Generate semantic text for embedding from an instance config row
 *
 * The generated text is designed for optimal vector search:
 * - Includes the config key and value
 * - Includes the description
 * - Includes the LLM instruction (CRITICAL for semantic matching)
 *
 * @param row - The instance config row
 * @returns Semantic text for embedding
 */
export function generateInstanceConfigSemanticText(row: InstanceConfigRow): string {
  const parts = [
    `MCP Configuration: ${row.Config_Key} = ${row.Config_Value}`,
    row.Description,
    `Category: ${row.Config_Category}`,
    `Applies to: ${row.Applies_To}`,
    `LLM Instruction: ${row.LLM_Instruction}`,
  ];

  return parts.filter(Boolean).join('. ');
}

// =============================================================================
// SAMPLE DATA
// =============================================================================

/**
 * Sample Instance Config for DuraCube (Nexsus1 example)
 *
 * This demonstrates the expected data structure for a complete Level 2 setup.
 */
export const SAMPLE_INSTANCE_CONFIGS: InstanceConfigRow[] = [
  // Business Context
  {
    Config_Key: 'COMPANY_NAME',
    Config_Value: 'DuraCube (The Almar Group)',
    Config_Category: 'operational',
    Description: 'Legal entity name for this MCP instance',
    Applies_To: 'all',
    LLM_Instruction: 'Always use this name when referencing the company. Do not guess or abbreviate.',
  },
  {
    Config_Key: 'INDUSTRY',
    Config_Value: 'Manufacturing - Toilet Partitions',
    Config_Category: 'operational',
    Description: 'Industry classification for business context',
    Applies_To: 'all',
    LLM_Instruction: 'Use this context when interpreting financial metrics and KPIs.',
  },
  {
    Config_Key: 'PRIMARY_USERS',
    Config_Value: 'Finance Team, Management',
    Config_Category: 'operational',
    Description: 'Who uses this MCP and for what purpose',
    Applies_To: 'all',
    LLM_Instruction: 'Tailor responses for finance professionals who understand accounting terms.',
  },
  {
    Config_Key: 'BUSINESS_PURPOSE',
    Config_Value: 'Financial analysis and reporting on GL actuals vs budget',
    Config_Category: 'operational',
    Description: 'Primary purpose of this Nexsus MCP instance',
    Applies_To: 'all',
    LLM_Instruction: 'Focus queries and analysis on financial data, GL accounts, and variance analysis.',
  },

  // Financial Settings
  {
    Config_Key: 'FISCAL_YEAR_START',
    Config_Value: '2024-07-01',
    Config_Category: 'financial',
    Description: 'Start of fiscal year (Australian FY)',
    Applies_To: 'all',
    LLM_Instruction: 'Use July 1 as fiscal year start. FY2025 = July 2024 to June 2025.',
  },
  {
    Config_Key: 'FISCAL_YEAR_END',
    Config_Value: '2025-06-30',
    Config_Category: 'financial',
    Description: 'End of fiscal year (Australian FY)',
    Applies_To: 'all',
    LLM_Instruction: 'Use June 30 as fiscal year end. When user says "this year", use current FY.',
  },
  {
    Config_Key: 'DEFAULT_CURRENCY',
    Config_Value: 'AUD',
    Config_Category: 'financial',
    Description: 'Default currency for all amounts',
    Applies_To: 'all',
    LLM_Instruction: 'All amounts are in AUD unless explicitly stated. Format as "$X,XXX" or "$X.XM".',
  },
  {
    Config_Key: 'DATE_FORMAT',
    Config_Value: 'Excel Serial',
    Config_Category: 'financial',
    Description: 'How dates are stored in the data',
    Applies_To: 'actual',
    LLM_Instruction: 'Convert Excel serial dates to human-readable format. 45658 = Jan 1, 2025.',
  },

  // Technical Configuration
  {
    Config_Key: 'SYNCED_MODELS',
    Config_Value: 'master,actual',
    Config_Category: 'technical',
    Description: 'Models available in this MCP instance',
    Applies_To: 'all',
    LLM_Instruction: 'Only these models are available for queries. Do not attempt to query other models.',
  },
  {
    Config_Key: 'PAYLOAD_ENABLED_MODELS',
    Config_Value: 'master',
    Config_Category: 'technical',
    Description: 'Models that support nexsus_search with payload filtering',
    Applies_To: 'nexsus_search',
    LLM_Instruction: 'Only master model supports nexsus_search. Use semantic_search for actual model.',
  },

  // Limitations (CRITICAL)
  {
    Config_Key: 'LIMITATION_NO_ACTUAL_PAYLOAD',
    Config_Value: 'actual model has no payload fields configured',
    Config_Category: 'limitation',
    Description: 'The actual model cannot be queried with nexsus_search',
    Applies_To: 'actual',
    LLM_Instruction: 'WORKAROUND: Use semantic_search for actual model queries. Results may be less precise.',
  },
  {
    Config_Key: 'LIMITATION_EXCEL_DATES',
    Config_Value: 'Months stored as Excel serial dates, not human-readable',
    Config_Category: 'limitation',
    Description: 'Date handling requires conversion',
    Applies_To: 'actual',
    LLM_Instruction: 'WORKAROUND: Always convert dates before displaying. Use date reference table if unsure.',
  },

  // Common Query Patterns
  {
    Config_Key: 'COMMON_QUERY_REVENUE',
    Config_Value: 'Classification="REV" or F1="REV"',
    Config_Category: 'query',
    Description: 'How to filter for revenue accounts',
    Applies_To: 'master',
    LLM_Instruction: 'Use this filter pattern when user asks about revenue, sales, or income.',
  },
  {
    Config_Key: 'COMMON_QUERY_EXPENSES',
    Config_Value: 'Classification IN ("VCOS", "FCOS", "OH")',
    Config_Category: 'query',
    Description: 'How to filter for expense accounts',
    Applies_To: 'master',
    LLM_Instruction: 'Use this filter pattern when user asks about expenses, costs, or COGS.',
  },
];

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate a batch of instance config rows
 *
 * @param rows - Array of instance config rows to validate
 * @returns Validation result with errors if any
 */
export function validateInstanceConfigBatch(rows: unknown[]): {
  valid: boolean;
  validRows: InstanceConfigRow[];
  errors: Array<{ index: number; error: string }>;
} {
  const validRows: InstanceConfigRow[] = [];
  const errors: Array<{ index: number; error: string }> = [];

  rows.forEach((row, index) => {
    try {
      // Use limitation schema for limitation category, regular for others
      const rawRow = row as Record<string, unknown>;
      if (rawRow.Config_Category === 'limitation') {
        validRows.push(LimitationConfigSchema.parse(row));
      } else {
        validRows.push(InstanceConfigRowSchema.parse(row));
      }
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
 * Check if required config keys are present
 *
 * @param rows - Array of instance config rows
 * @returns Missing required keys by category
 */
export function checkRequiredInstanceConfigs(rows: InstanceConfigRow[]): {
  complete: boolean;
  missing: Record<string, string[]>;
} {
  const presentKeys = new Set(rows.map(r => r.Config_Key));
  const missing: Record<string, string[]> = {};

  // Check each required category
  for (const [category, keys] of Object.entries(REQUIRED_INSTANCE_CONFIG_KEYS)) {
    const missingInCategory = keys.filter(key => !presentKeys.has(key));
    if (missingInCategory.length > 0) {
      missing[category] = missingInCategory;
    }
  }

  return {
    complete: Object.keys(missing).length === 0,
    missing,
  };
}
