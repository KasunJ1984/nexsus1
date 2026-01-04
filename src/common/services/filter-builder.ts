/**
 * Filter Builder for Exact Queries
 *
 * Converts FilterCondition[] to Qdrant filter syntax.
 * Used by exact_query tool to build payload filters for precise data retrieval.
 *
 * @see https://qdrant.tech/documentation/concepts/filtering/
 */

import { FilterCondition } from '../types.js';
import { getFieldInfo, isDateField, isSchemaLookupInitialized, isFieldIndexed, SYSTEM_FIELDS } from './schema-lookup.js';

// =============================================================================
// DOT NOTATION TYPES
// =============================================================================

/**
 * Parsed dot notation components
 */
export interface DotNotationParts {
  /** FK field name in source model (e.g., "partner_id") */
  fkField: string;
  /** Target field in related model (e.g., "name") */
  targetField: string;
}

// =============================================================================
// DOT NOTATION PARSING
// =============================================================================

/**
 * Parse dot notation field into FK and target components
 *
 * @param field - Field name, possibly with dot notation (e.g., "partner_id.name")
 * @returns DotNotationParts if dot notation, null otherwise
 *
 * @example
 * parseDotNotation("partner_id.name") // { fkField: "partner_id", targetField: "name" }
 * parseDotNotation("debit") // null
 * parseDotNotation("partner_id.country_id.name") // null (multi-level not supported)
 */
export function parseDotNotation(field: string): DotNotationParts | null {
  if (!field || !field.includes('.')) {
    return null;
  }

  const parts = field.split('.');

  // Only support single-level dot notation (e.g., partner_id.name)
  // Multi-level (partner_id.country_id.name) is not supported yet
  if (parts.length !== 2) {
    return null;
  }

  const [fkField, targetField] = parts;

  // Validate parts are non-empty
  if (!fkField || !targetField) {
    return null;
  }

  return { fkField, targetField };
}

/**
 * Check if a filter uses dot notation
 */
export function isDotNotationFilter(condition: FilterCondition): boolean {
  return parseDotNotation(condition.field) !== null;
}

/**
 * Qdrant filter structure
 */
export interface QdrantFilter {
  must?: object[];
  must_not?: object[];
  should?: object[];
}

/**
 * Application-level filter for conditions that can't be handled by Qdrant indexes
 *
 * Used for:
 * - Date range filtering (Qdrant keyword index doesn't support range on dates)
 * - Unindexed boolean fields (fallback when field lacks payload index)
 */
export interface AppLevelFilter {
  field: string;
  op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq';  // Extended for boolean support
  value: string | boolean;  // Support both string (dates) and boolean values
  fieldType?: 'date' | 'boolean' | 'string';  // Type hint for comparison logic
}

/**
 * Fallback list for date fields (used when schema lookup not initialized)
 * These are common date field names that need app-level filtering
 */
const FALLBACK_DATE_FIELDS = ['date', 'date_maturity', 'invoice_date', 'create_date', 'write_date'];

/**
 * Check if a field should use app-level range filtering
 *
 * Uses schema lookup to detect date/datetime fields dynamically.
 * Falls back to name-based heuristic if schema not available.
 *
 * @param modelName - The model being queried
 * @param fieldName - The field name to check
 * @returns True if the field should use app-level filtering
 */
function isAppLevelRangeField(modelName: string, fieldName: string): boolean {
  // Try schema lookup first
  if (isSchemaLookupInitialized()) {
    const fieldInfo = getFieldInfo(modelName, fieldName);
    if (fieldInfo) {
      return isDateField(fieldInfo.field_type);
    }
  }

  // Fallback: check against known date field names or name patterns
  if (FALLBACK_DATE_FIELDS.includes(fieldName)) {
    return true;
  }

  // Additional heuristic: fields ending with _date or containing 'date'
  if (fieldName.endsWith('_date') || fieldName.includes('date')) {
    return true;
  }

  return false;
}

/**
 * Known boolean fields that may not have Qdrant indexes
 * Used for app-level filtering fallback
 */
const KNOWN_BOOLEAN_FIELDS = [
  'is_company', 'active', 'is_default', 'is_published',
  'is_internal', 'is_blacklisted', 'is_public', 'invoice_is_snailmail',
];

/**
 * Check if a field is a boolean that needs app-level filtering
 *
 * Returns true if:
 * - Field is in KNOWN_BOOLEAN_FIELDS list AND
 * - Field is NOT indexed in Qdrant
 *
 * @param fieldName - The field name to check
 * @returns True if the field should use app-level boolean filtering
 */
function shouldUseAppLevelBooleanFilter(fieldName: string): boolean {
  // Only apply to known boolean fields that aren't indexed
  if (KNOWN_BOOLEAN_FIELDS.includes(fieldName) && !isFieldIndexed(fieldName)) {
    console.error(`[FilterBuilder] Warning: Using app-level filtering for unindexed boolean field '${fieldName}'. Consider adding to UNIFIED_INDEXES.`);
    return true;
  }
  return false;
}

/**
 * Result of building filters
 */
export interface BuildFilterResult {
  qdrantFilter: QdrantFilter;
  appFilters: AppLevelFilter[];
}

/**
 * Build a Qdrant filter from model name and conditions
 *
 * Always includes model_name filter + all user conditions.
 * All conditions are combined with AND logic (must array).
 *
 * @param modelName - Odoo model name (e.g., "account.move.line")
 * @param conditions - Array of filter conditions
 * @returns Qdrant filter object ready for scroll/search
 *
 * @example
 * ```typescript
 * const filter = buildQdrantFilter("account.move.line", [
 *   { field: "account_id_id", op: "eq", value: 319 },
 *   { field: "date", op: "gte", value: "2025-03-01" }
 * ]);
 * // Returns:
 * // {
 * //   must: [
 * //     { key: "model_name", match: { value: "account.move.line" } },
 * //     { key: "account_id_id", match: { value: 319 } },
 * //     { key: "date", range: { gte: "2025-03-01" } }
 * //   ]
 * // }
 * ```
 */
export function buildQdrantFilter(
  modelName: string,
  conditions: FilterCondition[]
): BuildFilterResult {
  const must: object[] = [];
  const mustNot: object[] = [];
  const appFilters: AppLevelFilter[] = [];

  // Always filter by model_name
  must.push({
    key: 'model_name',
    match: { value: modelName }
  });

  // Group range conditions by field to combine them
  // BUT separate out date fields that need app-level filtering
  const rangeConditions = new Map<string, { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }>();
  const otherConditions: FilterCondition[] = [];

  for (const condition of conditions) {
    const { field, op, value } = condition;

    // Check if this is a range operator
    if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
      // Check if this field needs app-level filtering (date fields)
      // Uses schema lookup for dynamic detection with fallback to name patterns
      if (isAppLevelRangeField(modelName, field)) {
        // Add to app-level filters instead of Qdrant filter
        appFilters.push({
          field,
          op: op as 'gt' | 'gte' | 'lt' | 'lte',
          value: String(value)
        });
      } else {
        // Add to Qdrant range filter
        if (!rangeConditions.has(field)) {
          rangeConditions.set(field, {});
        }
        const range = rangeConditions.get(field)!;
        range[op as 'gt' | 'gte' | 'lt' | 'lte'] = value;
      }
    } else {
      otherConditions.push(condition);
    }
  }

  // Add combined range conditions (non-date fields)
  for (const [field, range] of rangeConditions) {
    must.push({ key: field, range });
  }

  // Convert other conditions
  for (const condition of otherConditions) {
    const { field, op, value } = condition;

    // Check if this is an unindexed boolean field that needs app-level filtering
    if ((op === 'eq' || op === 'neq') && shouldUseAppLevelBooleanFilter(field)) {
      appFilters.push({
        field,
        op: op as 'eq' | 'neq',
        value: Boolean(value),
        fieldType: 'boolean'
      });
      continue; // Skip Qdrant filter for this condition
    }

    const converted = conditionToQdrant(condition);
    if (converted.mustNot) {
      mustNot.push(converted.filter);
    } else {
      must.push(converted.filter);
    }
  }

  // Build final filter
  const qdrantFilter: QdrantFilter = { must };
  if (mustNot.length > 0) {
    qdrantFilter.must_not = mustNot;
  }

  return { qdrantFilter, appFilters };
}

/**
 * Convert a single FilterCondition to Qdrant filter syntax
 *
 * @param condition - The filter condition to convert
 * @returns Object with filter and whether it should be in must_not
 */
function conditionToQdrant(condition: FilterCondition): { filter: object; mustNot: boolean } {
  const { field, op, value } = condition;

  switch (op) {
    case 'eq':
      // Exact match
      return {
        filter: { key: field, match: { value } },
        mustNot: false
      };

    case 'neq':
      // Not equal - use must_not with match
      return {
        filter: { key: field, match: { value } },
        mustNot: true
      };

    case 'gt':
      // Greater than (exclusive)
      return {
        filter: { key: field, range: { gt: value } },
        mustNot: false
      };

    case 'gte':
      // Greater than or equal
      return {
        filter: { key: field, range: { gte: value } },
        mustNot: false
      };

    case 'lt':
      // Less than (exclusive)
      return {
        filter: { key: field, range: { lt: value } },
        mustNot: false
      };

    case 'lte':
      // Less than or equal
      return {
        filter: { key: field, range: { lte: value } },
        mustNot: false
      };

    case 'in':
      // Value in array - use match.any
      if (!Array.isArray(value)) {
        throw new Error(`'in' operator requires array value, got: ${typeof value}`);
      }
      return {
        filter: { key: field, match: { any: value } },
        mustNot: false
      };

    case 'contains':
      // Text contains - use match.text for full-text search
      // NOTE: This requires a TEXT index on the field in Qdrant.
      // If the field only has a KEYWORD index, this will return "Bad Request".
      if (typeof value !== 'string') {
        throw new Error(`'contains' operator requires string value, got: ${typeof value}`);
      }
      console.error(`[FilterBuilder] Warning: 'contains' operator on field '${field}' requires TEXT index. May fail if field has only KEYWORD index.`);
      return {
        filter: { key: field, match: { text: value } },
        mustNot: false
      };

    default:
      throw new Error(`Unsupported filter operator: ${op}`);
  }
}

/**
 * Validate filter conditions before building
 *
 * Checks for common issues like empty field names or invalid operators.
 *
 * @param conditions - Array of filter conditions to validate
 * @returns Object with isValid flag and error messages
 */
export function validateFilters(conditions: FilterCondition[]): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!conditions || conditions.length === 0) {
    errors.push('At least one filter condition is required');
    return { isValid: false, errors };
  }

  const validOps = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'];

  for (let i = 0; i < conditions.length; i++) {
    const cond = conditions[i];

    // Check field name
    if (!cond.field || typeof cond.field !== 'string' || cond.field.trim() === '') {
      errors.push(`Condition ${i + 1}: field name is required`);
    }

    // Check operator
    if (!cond.op || !validOps.includes(cond.op)) {
      errors.push(`Condition ${i + 1}: invalid operator "${cond.op}". Valid: ${validOps.join(', ')}`);
    }

    // Check value based on operator
    if (cond.value === undefined) {
      errors.push(`Condition ${i + 1}: value is required`);
    } else if (cond.op === 'in' && !Array.isArray(cond.value)) {
      errors.push(`Condition ${i + 1}: 'in' operator requires array value`);
    } else if (cond.op === 'contains' && typeof cond.value !== 'string') {
      errors.push(`Condition ${i + 1}: 'contains' operator requires string value`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Format filter conditions for display in results
 *
 * @param conditions - Array of filter conditions
 * @returns Human-readable string representation
 */
export function formatFiltersForDisplay(conditions: FilterCondition[]): string[] {
  return conditions.map(cond => {
    const valueStr = typeof cond.value === 'string'
      ? `"${cond.value}"`
      : Array.isArray(cond.value)
        ? `[${cond.value.map(v => typeof v === 'string' ? `"${v}"` : v).join(', ')}]`
        : String(cond.value);

    return `${cond.field} ${opToSymbol(cond.op)} ${valueStr}`;
  });
}

/**
 * Convert operator to symbol for display
 */
function opToSymbol(op: string): string {
  switch (op) {
    case 'eq': return '=';
    case 'neq': return '≠';
    case 'gt': return '>';
    case 'gte': return '≥';
    case 'lt': return '<';
    case 'lte': return '≤';
    case 'in': return 'IN';
    case 'contains': return 'CONTAINS';
    default: return op;
  }
}

// =============================================================================
// INDEX VALIDATION
// =============================================================================

/**
 * Result of index validation
 */
export interface IndexValidationResult {
  /** Whether all filtered fields are indexed */
  valid: boolean;
  /** List of fields without indexes */
  unindexedFields: string[];
  /** Error message if validation failed */
  errorMessage?: string;
}

/**
 * Validate that all filter fields have Qdrant payload indexes
 *
 * Fields without indexes will cause "Bad Request" errors from Qdrant.
 * This provides a helpful error message before the query is executed.
 *
 * @param filters - Array of filter conditions to validate
 * @returns Validation result with error message if invalid
 *
 * @example
 * const result = validateIndexedFields([{ field: 'is_company', op: 'eq', value: true }]);
 * if (!result.valid) {
 *   console.error(result.errorMessage);
 * }
 */
export function validateIndexedFields(filters: FilterCondition[]): IndexValidationResult {
  const unindexedFields: string[] = [];

  for (const filter of filters) {
    const field = filter.field;

    // Skip dot-notation fields (handled by Nexsus Link)
    if (field.includes('.')) continue;

    // Skip system fields (always available)
    if (field in SYSTEM_FIELDS) continue;

    // Check if field is indexed
    if (!isFieldIndexed(field)) {
      unindexedFields.push(field);
    }
  }

  if (unindexedFields.length > 0) {
    return {
      valid: false,
      unindexedFields,
      errorMessage: `**Index Validation Error**\n\n` +
        `Field(s) not indexed: \`${unindexedFields.join('`, `')}\`\n\n` +
        `**How to fix:**\n` +
        `1. Add the field(s) to UNIFIED_INDEXES in \`src/services/vector-client.ts\`\n` +
        `2. Run: \`npx tsx scripts/add-missing-indexes.ts\`\n\n` +
        `*Note: Only indexed fields can be used for filtering in Qdrant.*`
    };
  }

  return { valid: true, unindexedFields: [] };
}
