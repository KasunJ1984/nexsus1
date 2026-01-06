/**
 * Type Converter Utility
 *
 * Schema-driven type conversion for Excel data sync.
 * Converts raw Excel values to proper Qdrant-compatible types based on field_type from schema.
 *
 * Type Mapping:
 * - date/datetime → Unix timestamp (milliseconds)
 * - integer → number (integer)
 * - float/monetary → number (float)
 * - boolean → true/false
 * - others → keep as-is
 *
 * Error Handling:
 * - Invalid values → null
 * - Null/empty values → null
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of a single value conversion
 */
export interface ConversionResult {
  /** The converted value (null if conversion failed or value is null-like) */
  value: unknown;
  /** Whether conversion succeeded */
  success: boolean;
  /** Original value for debugging */
  originalValue: unknown;
  /** Error message if conversion failed */
  error?: string;
}

/**
 * Statistics for tracking conversions during sync
 */
export interface ConversionStats {
  /** Total fields processed */
  totalFields: number;
  /** Successfully converted fields */
  successfulConversions: number;
  /** Failed conversions (invalid values) */
  failedConversions: number;
  /** Null values encountered */
  nullValues: number;
  /** Breakdown by field type */
  byType: Record<string, { success: number; failed: number; nulls: number }>;
  /** Sample errors for reporting (max 10) */
  errors: Array<{ field: string; value: unknown; error: string }>;
}

// =============================================================================
// NULL VALUE HANDLING
// =============================================================================

/**
 * Values that should be treated as null
 */
const NULL_VALUES = new Set([
  '',
  'null',
  'NULL',
  'n/a',
  'N/A',
  '#N/A',
  'undefined',
  'none',
  'None',
  'NONE',
  '-',
  '--',
]);

/**
 * Check if a value should be treated as null
 *
 * @param value - Value to check
 * @returns true if value is null-like
 */
export function isNullValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === 'string') {
    return NULL_VALUES.has(value.trim());
  }

  return false;
}

// =============================================================================
// DATE CONVERSION
// =============================================================================

/**
 * Excel epoch: January 1, 1900 (with the famous leap year bug)
 * Excel serial date 1 = January 1, 1900
 * We need to subtract 2 days: 1 for the epoch and 1 for the 1900 leap year bug
 */
const EXCEL_EPOCH = new Date(Date.UTC(1899, 11, 30)); // December 30, 1899

/**
 * Convert Excel serial date to JavaScript Date
 *
 * @param serial - Excel serial date number (e.g., 45658 for Jan 2025)
 * @returns JavaScript Date object
 */
function excelSerialToDate(serial: number): Date {
  // Excel serial is days since epoch
  const milliseconds = serial * 24 * 60 * 60 * 1000;
  return new Date(EXCEL_EPOCH.getTime() + milliseconds);
}

/**
 * Check if a number looks like an Excel serial date
 * Excel dates for years 2000-2100 are roughly 36526-73415
 */
function isExcelSerialDate(value: number): boolean {
  return value >= 1 && value <= 100000;
}

/**
 * Convert date value to Unix timestamp (milliseconds)
 *
 * Handles:
 * - Excel serial dates (e.g., 45658)
 * - ISO date strings (e.g., "2024-01-15")
 * - ISO datetime strings (e.g., "2024-01-15T10:30:00")
 * - Already timestamp numbers (pass through if > 100000)
 *
 * @param value - Value to convert
 * @returns ConversionResult with Unix timestamp in milliseconds
 */
export function toUnixTimestamp(value: unknown): ConversionResult {
  const originalValue = value;

  // Handle null-like values
  if (isNullValue(value)) {
    return { value: null, success: true, originalValue };
  }

  // Handle numbers
  if (typeof value === 'number') {
    if (isNaN(value)) {
      return {
        value: null,
        success: false,
        originalValue,
        error: 'Value is NaN',
      };
    }

    // Excel serial date (small number like 45658)
    if (isExcelSerialDate(value)) {
      const date = excelSerialToDate(value);
      return { value: date.getTime(), success: true, originalValue };
    }

    // Already a timestamp (large number)
    return { value: value, success: true, originalValue };
  }

  // Handle strings
  if (typeof value === 'string') {
    const trimmed = value.trim();

    // Try parsing as date string
    const parsed = Date.parse(trimmed);
    if (!isNaN(parsed)) {
      return { value: parsed, success: true, originalValue };
    }

    // Try parsing as number (might be Excel serial as string)
    const asNumber = parseFloat(trimmed);
    if (!isNaN(asNumber) && isExcelSerialDate(asNumber)) {
      const date = excelSerialToDate(asNumber);
      return { value: date.getTime(), success: true, originalValue };
    }

    return {
      value: null,
      success: false,
      originalValue,
      error: `Invalid date format: "${trimmed}"`,
    };
  }

  // Handle Date objects
  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      return {
        value: null,
        success: false,
        originalValue,
        error: 'Invalid Date object',
      };
    }
    return { value: value.getTime(), success: true, originalValue };
  }

  return {
    value: null,
    success: false,
    originalValue,
    error: `Cannot convert ${typeof value} to timestamp`,
  };
}

// =============================================================================
// NUMBER CONVERSION
// =============================================================================

/**
 * Convert value to integer
 *
 * @param value - Value to convert
 * @returns ConversionResult with integer value
 */
export function toInteger(value: unknown): ConversionResult {
  const originalValue = value;

  // Handle null-like values
  if (isNullValue(value)) {
    return { value: null, success: true, originalValue };
  }

  // Already a number
  if (typeof value === 'number') {
    if (isNaN(value)) {
      return {
        value: null,
        success: false,
        originalValue,
        error: 'Value is NaN',
      };
    }
    return { value: Math.round(value), success: true, originalValue };
  }

  // String to number
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, ''); // Remove commas
    const parsed = parseInt(trimmed, 10);
    if (!isNaN(parsed)) {
      return { value: parsed, success: true, originalValue };
    }
    return {
      value: null,
      success: false,
      originalValue,
      error: `Cannot parse integer: "${trimmed}"`,
    };
  }

  return {
    value: null,
    success: false,
    originalValue,
    error: `Cannot convert ${typeof value} to integer`,
  };
}

/**
 * Convert value to float
 *
 * @param value - Value to convert
 * @returns ConversionResult with float value
 */
export function toFloat(value: unknown): ConversionResult {
  const originalValue = value;

  // Handle null-like values
  if (isNullValue(value)) {
    return { value: null, success: true, originalValue };
  }

  // Already a number
  if (typeof value === 'number') {
    if (isNaN(value)) {
      return {
        value: null,
        success: false,
        originalValue,
        error: 'Value is NaN',
      };
    }
    return { value: value, success: true, originalValue };
  }

  // String to number
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '').replace(/\$/g, ''); // Remove commas and $
    const parsed = parseFloat(trimmed);
    if (!isNaN(parsed)) {
      return { value: parsed, success: true, originalValue };
    }
    return {
      value: null,
      success: false,
      originalValue,
      error: `Cannot parse float: "${trimmed}"`,
    };
  }

  return {
    value: null,
    success: false,
    originalValue,
    error: `Cannot convert ${typeof value} to float`,
  };
}

// =============================================================================
// BOOLEAN CONVERSION
// =============================================================================

/**
 * Values that should be converted to true
 */
const TRUE_VALUES = new Set([
  'true',
  'TRUE',
  'True',
  'yes',
  'YES',
  'Yes',
  'y',
  'Y',
  '1',
  'on',
  'ON',
  'On',
]);

/**
 * Values that should be converted to false
 */
const FALSE_VALUES = new Set([
  'false',
  'FALSE',
  'False',
  'no',
  'NO',
  'No',
  'n',
  'N',
  '0',
  'off',
  'OFF',
  'Off',
]);

/**
 * Convert value to boolean
 *
 * @param value - Value to convert
 * @returns ConversionResult with boolean value
 */
export function toBoolean(value: unknown): ConversionResult {
  const originalValue = value;

  // Handle null-like values
  if (isNullValue(value)) {
    return { value: null, success: true, originalValue };
  }

  // Already a boolean
  if (typeof value === 'boolean') {
    return { value: value, success: true, originalValue };
  }

  // Number to boolean
  if (typeof value === 'number') {
    return { value: value !== 0, success: true, originalValue };
  }

  // String to boolean
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (TRUE_VALUES.has(trimmed)) {
      return { value: true, success: true, originalValue };
    }
    if (FALSE_VALUES.has(trimmed)) {
      return { value: false, success: true, originalValue };
    }
    return {
      value: null,
      success: false,
      originalValue,
      error: `Cannot parse boolean: "${trimmed}"`,
    };
  }

  return {
    value: null,
    success: false,
    originalValue,
    error: `Cannot convert ${typeof value} to boolean`,
  };
}

// =============================================================================
// MAIN CONVERSION FUNCTION
// =============================================================================

/**
 * Convert a value based on field type from schema
 *
 * @param value - Raw value from Excel
 * @param fieldType - Field type from schema (date, integer, float, boolean, etc.)
 * @param fieldName - Field name for error messages
 * @returns ConversionResult
 */
export function convertValue(
  value: unknown,
  fieldType: string,
  fieldName: string
): ConversionResult {
  // Normalize field type
  const normalizedType = fieldType.toLowerCase();

  switch (normalizedType) {
    case 'date':
    case 'datetime':
      return toUnixTimestamp(value);

    case 'integer':
      return toInteger(value);

    case 'float':
    case 'monetary':
      return toFloat(value);

    case 'boolean':
      return toBoolean(value);

    default:
      // For other types (char, text, selection, many2one, etc.), keep as-is
      // But still handle null-like values
      if (isNullValue(value)) {
        return { value: null, success: true, originalValue: value };
      }
      return { value: value, success: true, originalValue: value };
  }
}

// =============================================================================
// STATS TRACKING
// =============================================================================

/**
 * Create a new ConversionStats tracker
 */
export function createConversionStats(): ConversionStats {
  return {
    totalFields: 0,
    successfulConversions: 0,
    failedConversions: 0,
    nullValues: 0,
    byType: {},
    errors: [],
  };
}

/**
 * Record a conversion result in stats
 *
 * @param stats - Stats object to update
 * @param fieldType - Field type being converted
 * @param result - Conversion result
 * @param fieldName - Field name for error tracking
 */
export function recordConversion(
  stats: ConversionStats,
  fieldType: string,
  result: ConversionResult,
  fieldName: string
): void {
  stats.totalFields++;

  // Initialize type stats if needed
  if (!stats.byType[fieldType]) {
    stats.byType[fieldType] = { success: 0, failed: 0, nulls: 0 };
  }

  if (result.value === null) {
    stats.nullValues++;
    stats.byType[fieldType].nulls++;

    if (!result.success) {
      // Failed conversion (invalid value)
      stats.failedConversions++;
      stats.byType[fieldType].failed++;

      // Track error (max 10)
      if (stats.errors.length < 10 && result.error) {
        stats.errors.push({
          field: fieldName,
          value: result.originalValue,
          error: result.error,
        });
      }
    } else {
      // Successful null (null-like value correctly converted to null)
      stats.successfulConversions++;
      stats.byType[fieldType].success++;
    }
  } else {
    // Successful conversion with value
    stats.successfulConversions++;
    stats.byType[fieldType].success++;
  }
}

/**
 * Format stats for console output
 *
 * @param stats - Stats to format
 * @returns Formatted string for logging
 */
export function formatConversionStats(stats: ConversionStats): string {
  const lines: string[] = [];

  lines.push(`Type Conversion Report:`);
  lines.push(`  Total fields: ${stats.totalFields}`);
  lines.push(`  Successful: ${stats.successfulConversions}`);
  lines.push(`  Failed: ${stats.failedConversions}`);
  lines.push(`  Null values: ${stats.nullValues}`);

  if (Object.keys(stats.byType).length > 0) {
    lines.push(`  By type:`);
    for (const [type, counts] of Object.entries(stats.byType)) {
      lines.push(`    ${type}: ${counts.success} ok, ${counts.failed} failed, ${counts.nulls} nulls`);
    }
  }

  if (stats.errors.length > 0) {
    lines.push(`  Sample errors:`);
    for (const err of stats.errors) {
      lines.push(`    - ${err.field}: "${err.value}" → ${err.error}`);
    }
  }

  return lines.join('\n');
}
