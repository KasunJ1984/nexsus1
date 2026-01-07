/**
 * Dynamic Knowledge Schemas - Index
 *
 * Exports all knowledge schemas for use by loaders and adapters.
 *
 * Knowledge Levels:
 * - Level 1: Universal (all Nexsus) - markdown files in src/knowledge/static/
 * - Level 2: Instance Config - MCP instance settings from Excel
 * - Level 3: Model Metadata - Table/model business meaning from Excel
 * - Level 4: Field Knowledge - Field-level meaning from Excel
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
// LEVEL 2: INSTANCE CONFIG SCHEMA
// =============================================================================

export {
  InstanceConfigRowSchema,
  InstanceConfigCategoryEnum,
  LimitationConfigSchema,
  INSTANCE_CONFIG_LEVEL_CODE,
  REQUIRED_INSTANCE_CONFIG_KEYS,
  SAMPLE_INSTANCE_CONFIGS,
  generateInstanceConfigSemanticText,
  validateInstanceConfigBatch,
  checkRequiredInstanceConfigs,
} from './instance-config-schema.js';
export type {
  InstanceConfigRow,
  InstanceConfigCategory,
  LimitationConfig,
  InstanceConfigPayload,
} from './instance-config-schema.js';

// =============================================================================
// LEVEL 3: MODEL METADATA SCHEMA
// =============================================================================

export {
  ModelMetadataRowSchema,
  MODEL_METADATA_LEVEL_CODE,
  SAMPLE_MODEL_METADATA,
  generateModelMetadataSemanticText,
  validateModelMetadataBatch,
  validateModelMetadataReferences,
  validatePayloadEnabledFlags,
} from './model-metadata-schema.js';
export type {
  ModelMetadataRow,
  ModelMetadataPayload,
} from './model-metadata-schema.js';

// =============================================================================
// LEVEL 4: FIELD KNOWLEDGE SCHEMA
// =============================================================================

export {
  FieldKnowledgeExtensionSchema,
  ExtendedSchemaRowSchema,
  FIELD_KNOWLEDGE_LEVEL_CODE,
  SAMPLE_FIELD_KNOWLEDGE,
  generateFieldKnowledgeSemanticText,
  parseValidValues,
  validateFieldKnowledgeExtension,
  hasFieldKnowledge,
  identifyFieldsNeedingKnowledge,
  mergeSchemaWithKnowledge,
} from './field-knowledge-schema.js';
export type {
  FieldKnowledgeExtension,
  ExtendedSchemaRow,
  FieldKnowledgePayload,
} from './field-knowledge-schema.js';

// =============================================================================
// KNOWLEDGE CATEGORY CODES
// =============================================================================

/**
 * All knowledge category codes for UUID generation
 *
 * Original knowledge categories (00000004 namespace):
 * - kpi: 0001
 * - odooPattern: 0002
 * - report: 0003
 *
 * Extended knowledge levels (00000005 namespace):
 * - instance: 0002 (Level 2)
 * - model: 0003 (Level 3)
 * - field: 0004 (Level 4)
 */
export const KNOWLEDGE_CATEGORY_CODES = {
  // Original categories
  kpi: '0001',
  odooPattern: '0002',
  report: '0003',
} as const;

/**
 * Extended knowledge level codes for UUID generation
 *
 * UUID Format: 00000005-LLLL-MMMM-0000-IIIIIIIIIIII
 * Where:
 * - LLLL = Level code (0002, 0003, 0004)
 * - MMMM = Model_ID (0000 for instance level)
 * - IIIIIIIIIIII = Item index or Field_ID
 */
export const EXTENDED_KNOWLEDGE_LEVEL_CODES = {
  instance: '0002',  // Level 2: MCP Instance Config
  model: '0003',     // Level 3: Table/Model Metadata
  field: '0004',     // Level 4: Field Knowledge
} as const;

/**
 * Knowledge namespace for UUID (00000004) - original knowledge
 */
export const KNOWLEDGE_NAMESPACE = '00000004';

/**
 * Extended knowledge namespace for UUID (00000005) - 4-level knowledge
 */
export const EXTENDED_KNOWLEDGE_NAMESPACE = '00000005';

/**
 * Knowledge level type
 */
export type KnowledgeLevel = 'universal' | 'instance' | 'model' | 'field';
