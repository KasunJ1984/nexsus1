/**
 * KPI Schema - Financial Key Performance Indicators
 *
 * Defines the schema for financial KPIs that will be stored in Qdrant
 * and retrieved via semantic search at runtime.
 *
 * Usage:
 * - User asks: "What KPIs measure profitability?"
 * - Knowledge adapter searches for category: "profitability"
 * - Returns relevant KPI definitions with formulas
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

/**
 * KPI category types
 */
export const KPICategoryEnum = z.enum([
  'profitability',  // Gross margin, net profit, EBITDA
  'liquidity',      // Current ratio, quick ratio, cash ratio
  'efficiency',     // Asset turnover, inventory turnover, DSO
  'leverage',       // Debt to equity, interest coverage
  'growth',         // Revenue growth, YoY comparison
  'custom',         // Company-specific KPIs
]);

export type KPICategory = z.infer<typeof KPICategoryEnum>;

/**
 * KPI formula component
 */
export const KPIFormulaSchema = z.object({
  // Human-readable formula
  formula: z.string().describe('Human-readable formula (e.g., "Revenue - COGS")'),

  // Odoo field mappings for calculation
  numerator: z.object({
    model: z.string().describe('Odoo model name'),
    field: z.string().describe('Field to aggregate'),
    filters: z.array(z.object({
      field: z.string(),
      op: z.string(),
      value: z.unknown(),
    })).optional().describe('Optional filters'),
  }).optional(),

  denominator: z.object({
    model: z.string().describe('Odoo model name'),
    field: z.string().describe('Field to aggregate'),
    filters: z.array(z.object({
      field: z.string(),
      op: z.string(),
      value: z.unknown(),
    })).optional().describe('Optional filters'),
  }).optional(),

  // Whether this is a calculated field (vs simple aggregation)
  isCalculated: z.boolean().default(false),
});

export type KPIFormula = z.infer<typeof KPIFormulaSchema>;

/**
 * Full KPI definition schema
 */
export const KPISchema = z.object({
  // Unique identifier
  id: z.string().describe('Unique ID (e.g., "kpi_gross_margin")'),

  // Human readable name
  name: z.string().describe('Display name (e.g., "Gross Profit Margin")'),

  // Detailed description for semantic search
  description: z.string().describe('Full description explaining what this KPI measures'),

  // Category for filtering
  category: KPICategoryEnum,

  // Optional formula definition
  formula: KPIFormulaSchema.optional(),

  // How to interpret the result
  interpretation: z.string().describe('How to interpret values (e.g., "Higher is better")'),

  // Related account types (for Odoo)
  relatedAccounts: z.array(z.string()).optional().describe('Account type codes'),

  // Benchmark values (optional)
  benchmarks: z.object({
    low: z.number().optional(),
    medium: z.number().optional(),
    high: z.number().optional(),
    unit: z.enum(['percent', 'ratio', 'days', 'currency']).optional(),
  }).optional(),

  // Tags for additional search
  tags: z.array(z.string()).optional(),
});

export type KPI = z.infer<typeof KPISchema>;

// =============================================================================
// CATEGORY CODES
// =============================================================================

/**
 * Category code for UUID generation
 * Format: 00000004-0001-0000-0000-RRRRRRRRRRRR
 */
export const KPI_CATEGORY_CODE = '0001';

// =============================================================================
// SAMPLE DATA
// =============================================================================

/**
 * Sample KPIs for initial population
 * These would typically come from a JSON or Excel file
 */
export const SAMPLE_KPIS: KPI[] = [
  {
    id: 'kpi_gross_margin',
    name: 'Gross Profit Margin',
    description: 'Measures the percentage of revenue retained after deducting cost of goods sold. Indicates pricing strategy effectiveness and production efficiency.',
    category: 'profitability',
    formula: {
      formula: '(Revenue - COGS) / Revenue * 100',
      isCalculated: true,
    },
    interpretation: 'Higher is better. Industry-dependent, typically 20-60% for healthy businesses.',
    benchmarks: {
      low: 20,
      medium: 35,
      high: 50,
      unit: 'percent',
    },
    tags: ['margin', 'profit', 'cogs', 'revenue'],
  },
  {
    id: 'kpi_current_ratio',
    name: 'Current Ratio',
    description: 'Measures ability to pay short-term obligations with current assets. Current Assets divided by Current Liabilities.',
    category: 'liquidity',
    formula: {
      formula: 'Current Assets / Current Liabilities',
      isCalculated: true,
    },
    interpretation: 'Higher indicates better liquidity. 1.5-2.0 is generally healthy. Below 1 may indicate liquidity problems.',
    benchmarks: {
      low: 1.0,
      medium: 1.5,
      high: 2.0,
      unit: 'ratio',
    },
    tags: ['liquidity', 'working capital', 'assets', 'liabilities'],
  },
  {
    id: 'kpi_dso',
    name: 'Days Sales Outstanding',
    description: 'Average number of days to collect payment after a sale. Measures accounts receivable efficiency.',
    category: 'efficiency',
    formula: {
      formula: '(Accounts Receivable / Credit Sales) * 365',
      isCalculated: true,
    },
    interpretation: 'Lower is better. High DSO indicates slow collection. Compare to payment terms.',
    benchmarks: {
      low: 45,
      medium: 60,
      high: 90,
      unit: 'days',
    },
    tags: ['receivables', 'collection', 'ar', 'cash flow'],
  },
];
