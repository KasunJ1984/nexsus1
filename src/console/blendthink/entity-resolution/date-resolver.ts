/**
 * Date Resolver
 *
 * Parses various date formats from natural language queries:
 * - "Jan-25", "Dec-24" (month-year abbreviation)
 * - "Q1 2025", "Q4-24" (quarter)
 * - "FY25", "FY2025" (fiscal year - Australian: July to June)
 * - "2025-01-15" (ISO date)
 * - "January 2025" (full month name)
 * - "last month", "this year" (relative dates)
 */

import type { DateResolution } from './types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Month abbreviations to month index (0-11)
 */
const MONTH_ABBREVS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Full month names to month index (0-11)
 */
const MONTH_FULL: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format a Date object to ISO date string (YYYY-MM-DD)
 */
function toISODateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Get the last day of a month
 */
function getLastDayOfMonth(year: number, month: number): Date {
  // Month is 0-indexed, so month+1 gives us next month, day 0 gives last day of previous
  return new Date(year, month + 1, 0);
}

/**
 * Parse a 2-digit year to full year
 * Assumes 00-49 = 2000-2049, 50-99 = 1950-1999
 */
function parseYear(yearStr: string): number {
  const year = parseInt(yearStr, 10);
  if (yearStr.length === 2) {
    return year < 50 ? 2000 + year : 1900 + year;
  }
  return year;
}

/**
 * Get current date for relative calculations
 */
function getCurrentDate(): Date {
  return new Date();
}

// =============================================================================
// PATTERN MATCHERS
// =============================================================================

/**
 * Pattern 1: Month-Year abbreviation
 * Examples: "Jan-25", "Dec 24", "Mar-2025", "feb25"
 */
function matchMonthYear(text: string): DateResolution[] {
  const results: DateResolution[] = [];

  // Pattern: 3-letter month + separator? + 2-4 digit year
  const pattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[- ]?(\d{2,4})\b/gi;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const monthName = match[1].toLowerCase();
    const month = MONTH_ABBREVS[monthName];
    const year = parseYear(match[2]);

    const startDate = new Date(year, month, 1);
    const endDate = getLastDayOfMonth(year, month);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.95,
      originalText: match[0],
      pattern: 'month-year',
    });
  }

  return results;
}

/**
 * Pattern 2: Full month name + year
 * Examples: "January 2025", "December 2024"
 */
function matchFullMonthYear(text: string): DateResolution[] {
  const results: DateResolution[] = [];

  const monthNames = Object.keys(MONTH_FULL).join('|');
  const pattern = new RegExp(`\\b(${monthNames})\\s+(\\d{4})\\b`, 'gi');

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const monthName = match[1].toLowerCase();
    const month = MONTH_FULL[monthName];
    const year = parseInt(match[2], 10);

    const startDate = new Date(year, month, 1);
    const endDate = getLastDayOfMonth(year, month);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.95,
      originalText: match[0],
      pattern: 'month-year',
    });
  }

  return results;
}

/**
 * Pattern 3: Quarter
 * Examples: "Q1 2025", "Q4-24", "q2 25", "Q3"
 */
function matchQuarter(text: string): DateResolution[] {
  const results: DateResolution[] = [];

  // Pattern with year
  const patternWithYear = /\bQ([1-4])[- ]?(\d{2,4})\b/gi;

  let match;
  while ((match = patternWithYear.exec(text)) !== null) {
    const quarter = parseInt(match[1], 10);
    const year = parseYear(match[2]);

    const startMonth = (quarter - 1) * 3; // Q1=0, Q2=3, Q3=6, Q4=9
    const endMonth = startMonth + 2;

    const startDate = new Date(year, startMonth, 1);
    const endDate = getLastDayOfMonth(year, endMonth);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.95,
      originalText: match[0],
      pattern: 'quarter',
    });
  }

  // Pattern without year (assume current year)
  const patternNoYear = /\bQ([1-4])\b(?![- ]?\d)/gi;

  while ((match = patternNoYear.exec(text)) !== null) {
    const quarter = parseInt(match[1], 10);
    const year = getCurrentDate().getFullYear();

    const startMonth = (quarter - 1) * 3;
    const endMonth = startMonth + 2;

    const startDate = new Date(year, startMonth, 1);
    const endDate = getLastDayOfMonth(year, endMonth);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.80, // Lower confidence without explicit year
      originalText: match[0],
      pattern: 'quarter',
    });
  }

  return results;
}

/**
 * Pattern 4: Fiscal Year (Australian: July 1 - June 30)
 * Examples: "FY25", "FY2025", "fy 25"
 */
function matchFiscalYear(text: string): DateResolution[] {
  const results: DateResolution[] = [];

  const pattern = /\bFY[- ]?(\d{2,4})\b/gi;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const fyYear = parseYear(match[1]);

    // FY25 = July 1, 2024 to June 30, 2025
    const startDate = new Date(fyYear - 1, 6, 1); // July 1 of previous calendar year
    const endDate = new Date(fyYear, 5, 30); // June 30 of FY year

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: match[0],
      pattern: 'fiscal-year',
    });
  }

  return results;
}

/**
 * Pattern 5: ISO Date (full or partial)
 * Examples: "2025-01-15", "2025-01", "2025"
 */
function matchISODate(text: string): DateResolution[] {
  const results: DateResolution[] = [];

  // Full date: YYYY-MM-DD
  const fullPattern = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  let match;

  while ((match = fullPattern.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // 0-indexed
    const day = parseInt(match[3], 10);

    const date = new Date(year, month, day);

    results.push({
      type: 'point',
      from: toISODateString(date),
      confidence: 0.99,
      originalText: match[0],
      pattern: 'iso-date',
    });
  }

  // Year-Month: YYYY-MM
  const yearMonthPattern = /\b(\d{4})-(\d{2})(?!-\d{2})\b/g;

  while ((match = yearMonthPattern.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;

    const startDate = new Date(year, month, 1);
    const endDate = getLastDayOfMonth(year, month);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.95,
      originalText: match[0],
      pattern: 'iso-date',
    });
  }

  return results;
}

/**
 * Pattern 6: Bare year (standalone 4-digit year)
 * Examples: "2024", "in 2025", "deals 2024"
 *
 * IMPORTANT: Must run AFTER other patterns to avoid double-matching
 * years that are part of other date expressions (like "Q4 2024" or "FY25")
 */
function matchBareYear(text: string, alreadyMatchedRanges: Set<string>): DateResolution[] {
  const results: DateResolution[] = [];

  // Match standalone 4-digit years (2000-2099)
  // Negative lookbehind: not preceded by Q, FY, -, or month abbreviation
  // Negative lookahead: not followed by - (like 2024-01-15)
  const pattern = /(?<!Q\d?\s*)(?<!FY\s*)(?<![A-Za-z-])(?<!\/)\b(20\d{2})\b(?![-/]\d)/gi;

  let match;
  while ((match = pattern.exec(text)) !== null) {
    const year = parseInt(match[1], 10);
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const key = `${from}|${to}`;

    // Skip if this date range was already matched by another pattern
    if (alreadyMatchedRanges.has(key)) {
      continue;
    }

    // Additional check: skip if this year is part of a quarter pattern
    const contextBefore = text.substring(Math.max(0, match.index - 5), match.index);
    if (/Q[1-4]\s*$/i.test(contextBefore)) {
      continue;
    }

    // Skip if part of FY pattern
    if (/FY\s*$/i.test(contextBefore)) {
      continue;
    }

    results.push({
      type: 'range',
      from,
      to,
      confidence: 0.85, // Slightly lower than explicit patterns
      originalText: match[0],
      pattern: 'iso-date', // Using iso-date as pattern type for years
    });
  }

  return results;
}

/**
 * Pattern 7: Relative dates
 * Examples: "last month", "this year", "last quarter", "this month"
 */
function matchRelativeDates(text: string): DateResolution[] {
  const results: DateResolution[] = [];
  const now = getCurrentDate();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentQuarter = Math.floor(currentMonth / 3) + 1;

  const lowerText = text.toLowerCase();

  // "this month"
  if (/\bthis\s+month\b/.test(lowerText)) {
    const startDate = new Date(currentYear, currentMonth, 1);
    const endDate = getLastDayOfMonth(currentYear, currentMonth);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'this month',
      pattern: 'natural-language',
    });
  }

  // "last month"
  if (/\blast\s+month\b/.test(lowerText)) {
    const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;

    const startDate = new Date(lastMonthYear, lastMonth, 1);
    const endDate = getLastDayOfMonth(lastMonthYear, lastMonth);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'last month',
      pattern: 'natural-language',
    });
  }

  // "this year"
  if (/\bthis\s+year\b/.test(lowerText)) {
    const startDate = new Date(currentYear, 0, 1);
    const endDate = new Date(currentYear, 11, 31);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'this year',
      pattern: 'natural-language',
    });
  }

  // "last year"
  if (/\blast\s+year\b/.test(lowerText)) {
    const startDate = new Date(currentYear - 1, 0, 1);
    const endDate = new Date(currentYear - 1, 11, 31);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'last year',
      pattern: 'natural-language',
    });
  }

  // "this quarter"
  if (/\bthis\s+quarter\b/.test(lowerText)) {
    const startMonth = (currentQuarter - 1) * 3;
    const endMonth = startMonth + 2;

    const startDate = new Date(currentYear, startMonth, 1);
    const endDate = getLastDayOfMonth(currentYear, endMonth);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'this quarter',
      pattern: 'natural-language',
    });
  }

  // "last quarter"
  if (/\blast\s+quarter\b/.test(lowerText)) {
    const lastQuarter = currentQuarter === 1 ? 4 : currentQuarter - 1;
    const lastQuarterYear = currentQuarter === 1 ? currentYear - 1 : currentYear;

    const startMonth = (lastQuarter - 1) * 3;
    const endMonth = startMonth + 2;

    const startDate = new Date(lastQuarterYear, startMonth, 1);
    const endDate = getLastDayOfMonth(lastQuarterYear, endMonth);

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'last quarter',
      pattern: 'natural-language',
    });
  }

  // "YTD" or "year to date"
  if (/\b(ytd|year\s+to\s+date)\b/.test(lowerText)) {
    const startDate = new Date(currentYear, 0, 1);
    const endDate = now;

    results.push({
      type: 'range',
      from: toISODateString(startDate),
      to: toISODateString(endDate),
      confidence: 0.90,
      originalText: 'YTD',
      pattern: 'natural-language',
    });
  }

  return results;
}

// =============================================================================
// MAIN RESOLVER FUNCTION
// =============================================================================

/**
 * Resolve all date expressions in a text string
 *
 * @param text - The text to search for date expressions
 * @returns Array of resolved date ranges/points
 *
 * @example
 * resolveDates("Show me Jan-25 expenses")
 * // Returns: [{ type: 'range', from: '2025-01-01', to: '2025-01-31', confidence: 0.95 }]
 *
 * @example
 * resolveDates("Q4 2024 revenue")
 * // Returns: [{ type: 'range', from: '2024-10-01', to: '2024-12-31', confidence: 0.95 }]
 *
 * @example
 * resolveDates("FY25 budget")
 * // Returns: [{ type: 'range', from: '2024-07-01', to: '2025-06-30', confidence: 0.90 }]
 */
export function resolveDates(text: string): DateResolution[] {
  // Run pattern matchers in priority order
  // More specific patterns first, then general patterns
  const results: DateResolution[] = [
    ...matchISODate(text), // Highest priority - explicit dates
    ...matchMonthYear(text),
    ...matchFullMonthYear(text),
    ...matchQuarter(text),
    ...matchFiscalYear(text),
    ...matchRelativeDates(text),
  ];

  // Collect already matched date ranges to avoid double-matching with bare year
  const alreadyMatchedRanges = new Set<string>();
  for (const result of results) {
    alreadyMatchedRanges.add(`${result.from}|${result.to || ''}`);
  }

  // Add bare year matches (runs last to avoid double-matching)
  const bareYearResults = matchBareYear(text, alreadyMatchedRanges);
  results.push(...bareYearResults);

  // Remove duplicates based on from/to dates
  const seen = new Set<string>();
  const uniqueResults: DateResolution[] = [];

  for (const result of results) {
    const key = `${result.from}|${result.to || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueResults.push(result);
    }
  }

  // Sort by confidence (highest first)
  uniqueResults.sort((a, b) => b.confidence - a.confidence);

  return uniqueResults;
}

/**
 * Convert date resolutions to filter conditions
 *
 * @param resolutions - Array of date resolutions
 * @param fieldName - Name of the date field to filter (default: "date")
 * @returns Array of filter conditions
 */
export function dateResolutionsToFilters(
  resolutions: DateResolution[],
  fieldName: string = 'date'
): Array<{ field: string; op: 'gte' | 'lte' | 'eq'; value: string }> {
  const filters: Array<{ field: string; op: 'gte' | 'lte' | 'eq'; value: string }> = [];

  // Use the highest confidence resolution
  const bestResolution = resolutions[0];
  if (!bestResolution) return filters;

  if (bestResolution.type === 'range') {
    filters.push({
      field: fieldName,
      op: 'gte',
      value: bestResolution.from,
    });
    if (bestResolution.to) {
      filters.push({
        field: fieldName,
        op: 'lte',
        value: bestResolution.to,
      });
    }
  } else {
    // Point date - exact match
    filters.push({
      field: fieldName,
      op: 'eq',
      value: bestResolution.from,
    });
  }

  return filters;
}

/**
 * Check if text contains any date expressions
 */
export function containsDateExpression(text: string): boolean {
  return resolveDates(text).length > 0;
}

/**
 * Get the primary date resolution from text (highest confidence)
 */
export function getPrimaryDateResolution(text: string): DateResolution | null {
  const resolutions = resolveDates(text);
  return resolutions.length > 0 ? resolutions[0] : null;
}
