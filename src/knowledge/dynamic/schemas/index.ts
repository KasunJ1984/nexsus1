/**
 * Dynamic Knowledge Schemas - Index
 *
 * Exports all knowledge schemas for use by loaders and adapters.
 */

// KPI Schema
export {
  KPISchema,
  KPICategoryEnum,
  KPIFormulaSchema,
  KPI_CATEGORY_CODE,
  SAMPLE_KPIS,
} from './kpi-schema.js';
export type { KPI, KPICategory, KPIFormula } from './kpi-schema.js';

// Odoo Pattern Schema
export {
  OdooPatternSchema,
  OdooPatternCategoryEnum,
  FilterTemplateSchema,
  AggregationTemplateSchema,
  ODOO_PATTERN_CATEGORY_CODE,
  SAMPLE_PATTERNS,
} from './odoo-pattern-schema.js';
export type {
  OdooPattern,
  OdooPatternCategory,
  FilterTemplate,
  AggregationTemplate,
} from './odoo-pattern-schema.js';

// Report Schema
export {
  ReportSchema,
  ReportCategoryEnum,
  ReportSectionSchema,
  REPORT_CATEGORY_CODE,
  SAMPLE_REPORTS,
} from './report-schema.js';
export type { Report, ReportCategory, ReportSection } from './report-schema.js';

// =============================================================================
// KNOWLEDGE CATEGORY CODES
// =============================================================================

/**
 * All knowledge category codes for UUID generation
 */
export const KNOWLEDGE_CATEGORY_CODES = {
  kpi: '0001',
  odooPattern: '0002',
  report: '0003',
} as const;

/**
 * Knowledge namespace for UUID (00000004)
 */
export const KNOWLEDGE_NAMESPACE = '00000004';
