/**
 * Report Schema - Financial Report Format Definitions
 *
 * Defines the structure of standard financial reports to help
 * Claude format data correctly for user presentation.
 *
 * Usage:
 * - User asks: "Generate a P&L report"
 * - Knowledge adapter returns the P&L structure
 * - Claude uses this to organize query results appropriately
 */

import { z } from 'zod';

// =============================================================================
// SCHEMA DEFINITION
// =============================================================================

/**
 * Report category types
 */
export const ReportCategoryEnum = z.enum([
  'financial_statement',  // P&L, Balance Sheet, Cash Flow
  'management_report',    // Variance analysis, KPI dashboard
  'compliance_report',    // Tax, audit, regulatory
  'operational_report',   // Sales, inventory, HR
]);

export type ReportCategory = z.infer<typeof ReportCategoryEnum>;

/**
 * Report section definition (with nested children)
 */
export interface ReportSection {
  /** Section heading (e.g., "Revenue", "Operating Expenses") */
  name: string;
  /** Account types to aggregate */
  accountTypes?: string[];
  /** Specific account codes */
  accountCodes?: string[];
  /** Sign convention (positive/negative for display) */
  sign?: 'positive' | 'negative' | 'natural';
  /** Whether this is a subtotal */
  isSubtotal?: boolean;
  /** Child sections (for nested structure) */
  children?: ReportSection[];
}

/**
 * Zod schema for validation
 */
export const ReportSectionSchema: z.ZodType<ReportSection> = z.lazy(() =>
  z.object({
    name: z.string(),
    accountTypes: z.array(z.string()).optional(),
    accountCodes: z.array(z.string()).optional(),
    sign: z.enum(['positive', 'negative', 'natural']).optional(),
    isSubtotal: z.boolean().optional(),
    children: z.array(ReportSectionSchema).optional(),
  })
);

/**
 * Full report format schema
 */
export const ReportSchema = z.object({
  // Unique identifier
  id: z.string().describe('Unique ID (e.g., "report_pnl_standard")'),

  // Human readable name
  name: z.string().describe('Display name (e.g., "Profit & Loss Statement")'),

  // Detailed description for semantic search
  description: z.string().describe('When to use this report format'),

  // Category
  category: ReportCategoryEnum,

  // Required date parameters
  dateRange: z.object({
    type: z.enum(['period', 'ytd', 'comparative']),
    periods: z.number().default(1).describe('Number of periods to show'),
  }),

  // Report sections in display order
  sections: z.array(ReportSectionSchema),

  // Formatting preferences
  formatting: z.object({
    showPercentages: z.boolean().default(false),
    showVariance: z.boolean().default(false),
    currency: z.string().default('AUD'),
    decimals: z.number().default(2),
  }).optional(),

  // Tags for additional search
  tags: z.array(z.string()).optional(),
});

export type Report = z.infer<typeof ReportSchema>;

// =============================================================================
// CATEGORY CODES
// =============================================================================

/**
 * Category code for UUID generation
 * Format: 00000004-0003-0000-0000-RRRRRRRRRRRR
 */
export const REPORT_CATEGORY_CODE = '0003';

// =============================================================================
// SAMPLE DATA
// =============================================================================

/**
 * Sample reports for initial population
 */
export const SAMPLE_REPORTS: Report[] = [
  {
    id: 'report_pnl_standard',
    name: 'Profit & Loss Statement (Standard)',
    description: 'Standard income statement showing revenue, expenses, and net profit. Suitable for management reporting and basic financial analysis.',
    category: 'financial_statement',
    dateRange: {
      type: 'period',
      periods: 1,
    },
    sections: [
      {
        name: 'Revenue',
        accountTypes: ['income'],
        sign: 'positive',
        children: [
          { name: 'Operating Revenue', accountTypes: ['income_operating'], sign: 'positive' },
          { name: 'Other Revenue', accountTypes: ['income_other'], sign: 'positive' },
        ],
      },
      {
        name: 'Cost of Goods Sold',
        accountTypes: ['expense_direct_cost'],
        sign: 'negative',
      },
      {
        name: 'Gross Profit',
        isSubtotal: true,
        sign: 'natural',
      },
      {
        name: 'Operating Expenses',
        accountTypes: ['expense'],
        sign: 'negative',
        children: [
          { name: 'Salaries & Wages', accountTypes: ['expense_salary'], sign: 'negative' },
          { name: 'Rent & Occupancy', accountTypes: ['expense_rent'], sign: 'negative' },
          { name: 'Depreciation', accountTypes: ['expense_depreciation'], sign: 'negative' },
          { name: 'Other Operating', accountTypes: ['expense_other'], sign: 'negative' },
        ],
      },
      {
        name: 'Operating Profit (EBIT)',
        isSubtotal: true,
        sign: 'natural',
      },
      {
        name: 'Finance Costs',
        accountTypes: ['expense_finance'],
        sign: 'negative',
      },
      {
        name: 'Net Profit Before Tax',
        isSubtotal: true,
        sign: 'natural',
      },
    ],
    formatting: {
      showPercentages: true,
      showVariance: false,
      currency: 'AUD',
      decimals: 2,
    },
    tags: ['pnl', 'income statement', 'profit', 'loss', 'financial statement'],
  },
  {
    id: 'report_balance_sheet',
    name: 'Balance Sheet (Standard)',
    description: 'Statement of financial position showing assets, liabilities, and equity. Point-in-time snapshot of company financial position.',
    category: 'financial_statement',
    dateRange: {
      type: 'period',
      periods: 1,
    },
    sections: [
      {
        name: 'Assets',
        sign: 'positive',
        children: [
          {
            name: 'Current Assets',
            accountTypes: ['asset_current'],
            sign: 'positive',
            children: [
              { name: 'Cash & Equivalents', accountTypes: ['asset_cash'], sign: 'positive' },
              { name: 'Accounts Receivable', accountTypes: ['asset_receivable'], sign: 'positive' },
              { name: 'Inventory', accountTypes: ['asset_inventory'], sign: 'positive' },
              { name: 'Prepayments', accountTypes: ['asset_prepayments'], sign: 'positive' },
            ],
          },
          {
            name: 'Non-Current Assets',
            accountTypes: ['asset_non_current'],
            sign: 'positive',
            children: [
              { name: 'Property, Plant & Equipment', accountTypes: ['asset_fixed'], sign: 'positive' },
              { name: 'Intangible Assets', accountTypes: ['asset_intangible'], sign: 'positive' },
            ],
          },
        ],
      },
      {
        name: 'Total Assets',
        isSubtotal: true,
        sign: 'positive',
      },
      {
        name: 'Liabilities',
        sign: 'negative',
        children: [
          {
            name: 'Current Liabilities',
            accountTypes: ['liability_current'],
            sign: 'negative',
            children: [
              { name: 'Accounts Payable', accountTypes: ['liability_payable'], sign: 'negative' },
              { name: 'Accrued Expenses', accountTypes: ['liability_accrued'], sign: 'negative' },
              { name: 'Short-term Borrowings', accountTypes: ['liability_current_loan'], sign: 'negative' },
            ],
          },
          {
            name: 'Non-Current Liabilities',
            accountTypes: ['liability_non_current'],
            sign: 'negative',
            children: [
              { name: 'Long-term Borrowings', accountTypes: ['liability_non_current_loan'], sign: 'negative' },
            ],
          },
        ],
      },
      {
        name: 'Total Liabilities',
        isSubtotal: true,
        sign: 'negative',
      },
      {
        name: 'Equity',
        accountTypes: ['equity'],
        sign: 'positive',
        children: [
          { name: 'Share Capital', accountTypes: ['equity_share_capital'], sign: 'positive' },
          { name: 'Retained Earnings', accountTypes: ['equity_retained'], sign: 'natural' },
          { name: 'Current Year Earnings', isSubtotal: true, sign: 'natural' },
        ],
      },
      {
        name: 'Total Equity',
        isSubtotal: true,
        sign: 'positive',
      },
    ],
    formatting: {
      showPercentages: false,
      showVariance: false,
      currency: 'AUD',
      decimals: 2,
    },
    tags: ['balance sheet', 'statement of financial position', 'assets', 'liabilities', 'equity'],
  },
  {
    id: 'report_kpi_dashboard',
    name: 'Financial KPI Dashboard',
    description: 'Key financial metrics for executive reporting. Shows profitability, liquidity, and efficiency ratios.',
    category: 'management_report',
    dateRange: {
      type: 'comparative',
      periods: 3,
    },
    sections: [
      {
        name: 'Profitability',
        children: [
          { name: 'Gross Profit Margin', sign: 'natural' },
          { name: 'Operating Profit Margin', sign: 'natural' },
          { name: 'Net Profit Margin', sign: 'natural' },
        ],
      },
      {
        name: 'Liquidity',
        children: [
          { name: 'Current Ratio', sign: 'natural' },
          { name: 'Quick Ratio', sign: 'natural' },
        ],
      },
      {
        name: 'Efficiency',
        children: [
          { name: 'Days Sales Outstanding', sign: 'natural' },
          { name: 'Days Payables Outstanding', sign: 'natural' },
          { name: 'Inventory Turnover', sign: 'natural' },
        ],
      },
    ],
    formatting: {
      showPercentages: true,
      showVariance: true,
      currency: 'AUD',
      decimals: 1,
    },
    tags: ['kpi', 'dashboard', 'ratios', 'metrics', 'executive'],
  },
];
