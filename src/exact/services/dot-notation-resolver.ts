/**
 * Dot Notation Resolver Service
 *
 * Resolves dot notation filters (e.g., "partner_id.name contains 'Wadsworth'")
 * by searching the vector database for matching FK IDs.
 *
 * Resolution is performed entirely within Qdrant - no external API calls.
 *
 * @example
 * // Input filter: partner_id.name contains "Wadsworth"
 * // Searches res.partner records in vector DB
 * // Returns IDs: [282161, 286798]
 * // Output filter: partner_id_id IN [282161, 286798]
 */

import { FilterCondition } from '../../common/types.js';
import { parseDotNotation, DotNotationParts } from '../../common/services/filter-builder.js';
import { validateDotNotationField, DotNotationValidation } from '../../common/services/schema-lookup.js';
import { searchByPayloadFilter, getQdrantClient } from '../../common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of resolving dot notation filters
 */
export interface DotNotationResolutionResult {
  /** Resolved filters (dot notation converted to IN filters) */
  resolvedFilters: FilterCondition[];
  /** Warnings to display to user */
  warnings: string[];
  /** Whether resolution was successful */
  success: boolean;
  /** Error message if resolution failed */
  error?: string;
}

// =============================================================================
// MAIN RESOLVER
// =============================================================================

/**
 * Resolve all dot notation filters in a filter array
 *
 * Searches the vector database to resolve FK relationships.
 * Supports parallel resolution for multiple dot notation filters.
 *
 * @param modelName - Source model name (e.g., "account.move.line")
 * @param filters - Array of filter conditions
 * @returns Resolved filters with dot notation converted to IN clauses
 */
export async function resolveDotNotationFilters(
  modelName: string,
  filters: FilterCondition[]
): Promise<DotNotationResolutionResult> {
  const resolvedFilters: FilterCondition[] = [];
  const warnings: string[] = [];

  // Separate dot notation filters from regular filters
  const dotFilters: { filter: FilterCondition; parts: DotNotationParts; validation: DotNotationValidation }[] = [];
  const regularFilters: FilterCondition[] = [];

  for (const filter of filters) {
    const dotParts = parseDotNotation(filter.field);

    if (!dotParts) {
      // Not a dot notation filter, pass through unchanged
      regularFilters.push(filter);
      continue;
    }

    // Validate dot notation structure
    const validation = validateDotNotationField(
      modelName,
      dotParts.fkField,
      dotParts.targetField
    );

    if (!validation.valid) {
      return {
        resolvedFilters: [],
        warnings: [],
        success: false,
        error: validation.error + (validation.suggestion ? ` ${validation.suggestion}` : '')
      };
    }

    dotFilters.push({ filter, parts: dotParts, validation });
  }

  // If no dot notation filters, return early
  if (dotFilters.length === 0) {
    return {
      resolvedFilters: filters,
      warnings: [],
      success: true
    };
  }

  console.error(`[DotNotation] Resolving ${dotFilters.length} dot notation filter(s)`);

  // Resolve all dot notation filters in parallel
  try {
    const resolutionPromises = dotFilters.map(({ filter, parts, validation }) =>
      resolveSingleDotNotation(filter, parts, validation)
    );

    const results = await Promise.all(resolutionPromises);

    // Process results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const originalFilter = dotFilters[i].filter;
      const targetModel = dotFilters[i].validation.targetModel;

      if (result.matchCount === 0) {
        warnings.push(
          `Dot notation filter '${originalFilter.field} ${originalFilter.op} ${JSON.stringify(originalFilter.value)}' ` +
          `matched 0 records in ${targetModel}. Query will return 0 results.`
        );
      } else if (result.matchCount > 5000) {
        warnings.push(
          `Dot notation filter '${originalFilter.field}' matched ${result.matchCount} records. ` +
          `Large IN clauses may impact performance. Consider more specific filters.`
        );
      }

      resolvedFilters.push(result.filter);
      console.error(`[DotNotation] Resolved ${originalFilter.field} to ${result.matchCount} IDs`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      resolvedFilters: [],
      warnings: [],
      success: false,
      error: `Failed to resolve dot notation filters: ${errorMsg}`
    };
  }

  // Combine regular filters with resolved dot notation filters
  return {
    resolvedFilters: [...regularFilters, ...resolvedFilters],
    warnings,
    success: true
  };
}

// =============================================================================
// SINGLE FILTER RESOLUTION
// =============================================================================

interface SingleResolutionResult {
  filter: FilterCondition;
  matchCount: number;
}

/**
 * Resolve a single dot notation filter
 *
 * Searches the vector database to find matching FK IDs.
 */
async function resolveSingleDotNotation(
  originalFilter: FilterCondition,
  dotParts: DotNotationParts,
  validation: DotNotationValidation
): Promise<SingleResolutionResult> {
  const { fkField, targetField } = dotParts;
  const { targetModel } = validation;

  if (!targetModel) {
    throw new Error(`No target model found for FK field '${fkField}'`);
  }

  console.error(`[DotNotation] Searching ${targetModel}.${targetField} ${originalFilter.op} "${originalFilter.value}"`);

  let matchingIds: number[];

  // Handle 'contains' operator with app-level filtering
  // (searchByPayloadFilter uses match:{text:...} which requires TEXT index,
  // but most fields have KEYWORD index only)
  if (originalFilter.op === 'contains') {
    matchingIds = await resolveContainsFilter(
      targetModel,
      targetField,
      String(originalFilter.value)
    );
  } else {
    // Search vector database for matching FK IDs
    // No artificial limit - resolve ALL matching FK targets for accurate filtering
    matchingIds = await searchByPayloadFilter(
      targetModel,
      targetField,
      originalFilter.op,
      originalFilter.value,
      undefined  // No limit - get all matching IDs
    );
  }

  // Build resolved filter
  const resolvedFilter: FilterCondition = {
    field: `${fkField}_id`,
    op: 'in',
    value: matchingIds
  };

  return {
    filter: resolvedFilter,
    matchCount: matchingIds.length
  };
}

// =============================================================================
// CONTAINS OPERATOR HELPER (App-Level Filtering)
// =============================================================================

/**
 * Resolve 'contains' filter using app-level string matching
 *
 * Qdrant's match:{text:...} requires a TEXT index, but most fields
 * (like 'name') have KEYWORD indexes. This function scrolls through
 * all records of the target model and filters in JavaScript.
 *
 * @param modelName - Target model (e.g., "res.partner")
 * @param field - Field to search (e.g., "name")
 * @param searchValue - Value to search for (case-insensitive)
 * @returns Array of matching record_ids
 */
async function resolveContainsFilter(
  modelName: string,
  field: string,
  searchValue: string
): Promise<number[]> {
  const qdrantClient = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
  const searchStr = searchValue.toLowerCase();
  const matchingIds: number[] = [];

  // Build base filter (model + point_type only)
  const baseFilter = {
    must: [
      { key: 'model_name', match: { value: modelName } },
      { key: 'point_type', match: { value: 'data' } },
    ]
  };

  console.error(`[DotNotation] Using app-level filtering for 'contains' on ${modelName}.${field}`);

  let scrollOffset: string | number | null = null;
  const scrollLimit = 1000;

  do {
    const scrollResult = await qdrantClient.scroll(collectionName, {
      filter: baseFilter,
      limit: scrollLimit,
      offset: scrollOffset ?? undefined,
      with_payload: [field, 'record_id'],
    });

    for (const point of scrollResult.points) {
      const fieldValue = point.payload?.[field];
      const recordId = point.payload?.record_id;

      // Case-insensitive contains match
      if (typeof fieldValue === 'string' &&
          typeof recordId === 'number' &&
          fieldValue.toLowerCase().includes(searchStr)) {
        matchingIds.push(recordId);
      }
    }

    // Handle pagination
    const nextOffset = scrollResult.next_page_offset;
    scrollOffset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
      ? nextOffset
      : null;

  } while (scrollOffset !== null);

  console.error(`[DotNotation] App-level filter matched ${matchingIds.length} records in ${modelName}`);
  return matchingIds;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if any filters use dot notation
 */
export function hasDotNotationFilters(filters: FilterCondition[]): boolean {
  return filters.some(f => parseDotNotation(f.field) !== null);
}

/**
 * Count dot notation filters in array
 */
export function countDotNotationFilters(filters: FilterCondition[]): number {
  return filters.filter(f => parseDotNotation(f.field) !== null).length;
}
