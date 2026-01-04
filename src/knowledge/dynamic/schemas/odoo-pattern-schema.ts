/**
 * Odoo Pattern Schema - Query Patterns for Common Tasks
 *
 * Defines common Odoo query patterns that help Claude understand
 * how to query specific data scenarios.
 *
 * Usage:
 * - User asks: "How do I find aged receivables?"
 * - Knowledge adapter returns the pattern with model/field/filter info
 * - Claude uses this to build the correct nexsus_search query
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

/**
 * Pattern category types
 */
export const OdooPatternCategoryEnum = z.enum([
  'financial',    // Financial reports and analysis
  'sales',        // Sales pipeline and CRM
  'inventory',    // Stock and product management
  'hr',           // Human resources
  'purchasing',   // Procurement and vendors
  'general',      // Cross-module patterns
]);

export type OdooPatternCategory = z.infer<typeof OdooPatternCategoryEnum>;

/**
 * Filter template for the pattern
 */
export const FilterTemplateSchema = z.object({
  field: z.string().describe('Field name in Qdrant payload'),
  op: z.string().describe('Filter operator (eq, gte, lte, in, contains)'),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.unknown()),
  ]).optional().describe('Static value if fixed'),
  placeholder: z.string().optional().describe('Placeholder for dynamic value (e.g., "{partner_id}")'),
  required: z.boolean().default(true),
});

export type FilterTemplate = z.infer<typeof FilterTemplateSchema>;

/**
 * Aggregation template
 */
export const AggregationTemplateSchema = z.object({
  field: z.string().describe('Field to aggregate'),
  op: z.enum(['sum', 'count', 'avg', 'min', 'max']),
  alias: z.string().describe('Result field name'),
});

export type AggregationTemplate = z.infer<typeof AggregationTemplateSchema>;

/**
 * Full Odoo query pattern schema
 */
export const OdooPatternSchema = z.object({
  // Unique identifier
  id: z.string().describe('Unique ID (e.g., "pattern_aged_receivables")'),

  // Human readable name
  name: z.string().describe('Display name (e.g., "Aged Receivables Report")'),

  // Detailed description for semantic search
  description: z.string().describe('When to use this pattern and what it returns'),

  // Category for filtering
  category: OdooPatternCategoryEnum,

  // Target Odoo model
  model: z.string().describe('Primary Odoo model (e.g., "account.move.line")'),

  // Required filter templates
  filters: z.array(FilterTemplateSchema).describe('Filter conditions'),

  // Optional aggregations
  aggregations: z.array(AggregationTemplateSchema).optional(),

  // Optional group by
  groupBy: z.array(z.string()).optional(),

  // Link fields for enrichment
  link: z.array(z.string()).optional(),

  // Common mistakes to avoid
  pitfalls: z.array(z.string()).optional(),

  // Tags for additional search
  tags: z.array(z.string()).optional(),
});

export type OdooPattern = z.infer<typeof OdooPatternSchema>;

// =============================================================================
// CATEGORY CODES
// =============================================================================

/**
 * Category code for UUID generation
 * Format: 00000004-0002-0000-0000-RRRRRRRRRRRR
 */
export const ODOO_PATTERN_CATEGORY_CODE = '0002';

// =============================================================================
// SAMPLE DATA
// =============================================================================

/**
 * Sample patterns for initial population
 */
export const SAMPLE_PATTERNS: OdooPattern[] = [
  {
    id: 'pattern_aged_receivables',
    name: 'Aged Receivables Analysis',
    description: 'Find outstanding customer invoices grouped by aging buckets (0-30, 31-60, 61-90, 90+ days). Used for credit management and collection prioritization.',
    category: 'financial',
    model: 'account.move.line',
    filters: [
      { field: 'account_id_account_type', op: 'eq', value: 'asset_receivable', required: true },
      { field: 'reconciled', op: 'eq', value: false, required: true },
      { field: 'parent_state', op: 'eq', value: 'posted', required: true },
    ],
    aggregations: [
      { field: 'amount_residual', op: 'sum', alias: 'outstanding_balance' },
    ],
    groupBy: ['partner_id_id'],
    link: ['partner_id'],
    pitfalls: [
      'Must filter for receivable account type, not account ID',
      'Use reconciled=false to exclude paid invoices',
      'Always include parent_state=posted to exclude drafts',
    ],
    tags: ['ar', 'receivables', 'aging', 'collection', 'credit'],
  },
  {
    id: 'pattern_aged_payables',
    name: 'Aged Payables Analysis',
    description: 'Find outstanding vendor bills grouped by aging. Used for cash flow planning and vendor relationship management.',
    category: 'financial',
    model: 'account.move.line',
    filters: [
      { field: 'account_id_account_type', op: 'eq', value: 'liability_payable', required: true },
      { field: 'reconciled', op: 'eq', value: false, required: true },
      { field: 'parent_state', op: 'eq', value: 'posted', required: true },
    ],
    aggregations: [
      { field: 'amount_residual', op: 'sum', alias: 'outstanding_balance' },
    ],
    groupBy: ['partner_id_id'],
    link: ['partner_id'],
    pitfalls: [
      'Use liability_payable account type, not payable account ID',
      'Negative amounts in payables - check sign conventions',
    ],
    tags: ['ap', 'payables', 'aging', 'vendors', 'bills'],
  },
  {
    id: 'pattern_gl_account_balance',
    name: 'GL Account Balance',
    description: 'Get the balance of a specific GL account for a date range. Used for financial reporting and reconciliation.',
    category: 'financial',
    model: 'account.move.line',
    filters: [
      { field: 'account_id_id', op: 'eq', placeholder: '{account_id}', required: true },
      { field: 'date', op: 'gte', placeholder: '{date_from}', required: true },
      { field: 'date', op: 'lte', placeholder: '{date_to}', required: true },
      { field: 'parent_state', op: 'eq', value: 'posted', required: true },
    ],
    aggregations: [
      { field: 'debit', op: 'sum', alias: 'total_debit' },
      { field: 'credit', op: 'sum', alias: 'total_credit' },
      { field: 'balance', op: 'sum', alias: 'net_balance' },
    ],
    link: ['account_id'],
    pitfalls: [
      'Always include date range to avoid scanning all history',
      'Balance = Debit - Credit (follow Odoo convention)',
    ],
    tags: ['gl', 'ledger', 'balance', 'trial balance'],
  },
  {
    id: 'pattern_sales_pipeline',
    name: 'Sales Pipeline by Stage',
    description: 'Analyze sales opportunities grouped by stage. Shows pipeline value and deal count per stage.',
    category: 'sales',
    model: 'crm.lead',
    filters: [
      { field: 'active', op: 'eq', value: true, required: true },
      { field: 'type', op: 'eq', value: 'opportunity', required: false },
    ],
    aggregations: [
      { field: 'expected_revenue', op: 'sum', alias: 'total_pipeline' },
      { field: 'record_id', op: 'count', alias: 'deal_count' },
    ],
    groupBy: ['stage_id_id'],
    link: ['stage_id'],
    pitfalls: [
      'Filter active=true to exclude archived leads',
      'expected_revenue may be null for unqualified leads',
    ],
    tags: ['crm', 'pipeline', 'opportunities', 'funnel'],
  },
  {
    id: 'pattern_partner_transactions',
    name: 'Partner Transaction History',
    description: 'Get all GL transactions for a specific partner within a date range. Useful for account reconciliation.',
    category: 'financial',
    model: 'account.move.line',
    filters: [
      { field: 'partner_id_id', op: 'eq', placeholder: '{partner_id}', required: true },
      { field: 'date', op: 'gte', placeholder: '{date_from}', required: true },
      { field: 'date', op: 'lte', placeholder: '{date_to}', required: true },
      { field: 'parent_state', op: 'eq', value: 'posted', required: true },
    ],
    aggregations: [
      { field: 'debit', op: 'sum', alias: 'total_debit' },
      { field: 'credit', op: 'sum', alias: 'total_credit' },
    ],
    link: ['partner_id', 'account_id', 'move_id'],
    pitfalls: [
      'Use partner_id_id (with _id suffix) not partner_id for filtering',
      'Include move_id link to see invoice numbers',
    ],
    tags: ['partner', 'transactions', 'history', 'reconciliation'],
  },
];
