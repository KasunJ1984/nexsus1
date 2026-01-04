/**
 * Nexsus Link Service
 *
 * Resolves FK relationships for cross-model queries.
 * Uses batch retrieval for performance (8-15x faster than sequential).
 *
 * Key Features:
 * - Collects unique FK Qdrant IDs from records
 * - Batch fetches all targets in one call
 * - Returns structured map for result enrichment
 *
 * @example
 * const result = await resolveLinks(records, {
 *   linkFields: ['partner_id', 'account_id'],
 *   returnFields: ['name', 'display_name'],
 *   limit: 100,
 *   modelName: 'account.move.line'
 * });
 */

import { batchRetrievePoints } from './vector-client.js';
import { getFieldInfo, isSchemaLookupInitialized, isSchemaEmpty, getModelIdByName } from './schema-lookup.js';
import { isValidDataUuidV2, buildDataUuidV2 } from '../utils/uuid-v2.js';
import { UNIFIED_CONFIG } from '../constants.js';
import { getJsonFkMapping } from './json-fk-config.js';
import type { LinkedRecord, LinkResolutionResult, JsonFkResolutionResult, ResolvedJsonFkEntry } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for Nexsus Link resolution
 */
export interface LinkResolverOptions {
  /** FK field names to link (without _qdrant suffix) */
  linkFields: string[];
  /** Fields to extract from linked records */
  returnFields: string[];
  /** Maximum unique targets per FK field */
  limit: number;
  /** Model name for schema validation */
  modelName: string;
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Validate link fields against schema
 *
 * Checks that each field:
 * 1. Exists in the model
 * 2. Is a many2one FK field
 * 3. Has a corresponding *_qdrant field in payload
 *
 * @param modelName - Source model name
 * @param linkFields - Fields to validate
 * @returns Object with valid and invalid field lists
 */
export function validateLinkFields(
  modelName: string,
  linkFields: string[]
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];

  if (!isSchemaLookupInitialized() || isSchemaEmpty()) {
    // If schema not initialized or empty, assume all fields are valid
    console.error('[NexsusLink] Schema not available, skipping validation');
    return { valid: linkFields, invalid: [] };
  }

  for (const field of linkFields) {
    // Try the field as-is first
    let fieldInfo = getFieldInfo(modelName, field);

    if (!fieldInfo) {
      // Try without _id suffix (partner_id_id -> partner_id)
      const baseField = field.replace(/_id$/, '');
      fieldInfo = getFieldInfo(modelName, baseField);

      if (fieldInfo && fieldInfo.is_fk) {
        valid.push(baseField);
        continue;
      }
    } else if (fieldInfo.is_fk) {
      valid.push(field);
      continue;
    }

    // Field not found or not FK
    invalid.push(field);
  }

  return { valid, invalid };
}

// =============================================================================
// FK ID COLLECTION
// =============================================================================

/**
 * Collect unique FK Qdrant IDs from records
 *
 * Scans records for *_qdrant fields and collects unique UUIDs.
 *
 * @param records - Records to scan
 * @param linkFields - FK fields to collect IDs for
 * @param limit - Max unique IDs per field
 * @returns Map of field -> Set of Qdrant UUIDs
 */
export function collectFkQdrantIds(
  records: Array<Record<string, unknown>>,
  linkFields: string[],
  limit: number
): Map<string, Set<string>> {
  const fkIds = new Map<string, Set<string>>();

  // Initialize sets for each field
  for (const field of linkFields) {
    fkIds.set(field, new Set());
  }

  // Scan records for FK Qdrant IDs
  for (const record of records) {
    for (const field of linkFields) {
      const qdrantField = `${field}_qdrant`;
      const qdrantId = record[qdrantField] as string | undefined;

      if (qdrantId && isValidDataUuidV2(qdrantId)) {
        const fieldSet = fkIds.get(field)!;
        if (fieldSet.size < limit) {
          fieldSet.add(qdrantId);
        }
      }
    }
  }

  return fkIds;
}

/**
 * Collect FK Qdrant IDs from aggregation group keys
 *
 * For GROUP BY queries, we need to resolve FK IDs from group keys.
 * This requires building UUIDs from the FK ID values.
 *
 * @param groups - Aggregation groups with keys
 * @param groupByFields - Fields used in GROUP BY
 * @param linkFields - FK fields requested for linking
 * @param modelName - Source model for FK metadata lookup
 * @returns Map of field -> Set of Qdrant UUIDs
 */
export function collectGroupFkIds(
  groups: Array<{ key: Record<string, unknown> }>,
  groupByFields: string[],
  linkFields: string[],
  modelName: string
): Map<string, Set<string>> {
  const fkIds = new Map<string, Set<string>>();

  // Find which group_by fields are FK fields and in link list
  for (const groupField of groupByFields) {
    // Check if this is an FK ID field (e.g., partner_id_id)
    const baseField = groupField.replace(/_id$/, ''); // partner_id_id -> partner_id

    if (linkFields.includes(baseField) || linkFields.includes(groupField)) {
      // Get FK metadata to find target model_id
      const fieldInfo = getFieldInfo(modelName, baseField);
      if (fieldInfo && fieldInfo.is_fk && fieldInfo.fk_target_model) {
        fkIds.set(baseField, new Set());
      }
    }
  }

  // Note: Building UUIDs from group keys requires model_id lookup
  // This is handled in the resolveGroupLinks function
  return fkIds;
}

/**
 * Resolve Nexsus Links from aggregation GROUP BY keys
 *
 * Instead of sampling records (which misses some FK targets), this function
 * extracts FK IDs directly from aggregation group keys and resolves ALL of them.
 *
 * Example:
 *   Groups: [{key: {partner_id_id: 275168}}, {key: {partner_id_id: 289614}}, ...]
 *   This extracts [275168, 289614, ...], builds UUIDs, and fetches all partners.
 *
 * @param groups - Aggregation groups with key values
 * @param groupByFields - Fields used in GROUP BY (e.g., ["partner_id_id"])
 * @param linkFields - FK fields to resolve (e.g., ["partner_id"])
 * @param modelName - Source model name for FK metadata lookup
 * @param returnFields - Fields to extract from linked records
 * @returns LinkResolutionResult with ALL linked records from group keys
 */
export async function resolveGroupLinks(
  groups: Array<{ key: Record<string, unknown> }>,
  groupByFields: string[],
  linkFields: string[],
  modelName: string,
  returnFields: string[]
): Promise<LinkResolutionResult> {
  // Initialize result
  const result: LinkResolutionResult = {
    linked: new Map(),
    invalidFields: [],
    missingTargets: [],
    stats: {
      totalTargets: 0,
      resolvedTargets: 0,
      batchCalls: 0,
    },
  };

  // Validate link fields
  const { valid, invalid } = validateLinkFields(modelName, linkFields);
  result.invalidFields = invalid;

  if (invalid.length > 0) {
    console.error(`[NexsusLink] Invalid fields for group resolution: ${invalid.join(', ')}`);
  }

  if (valid.length === 0) {
    return result;
  }

  // Map groupByField to baseField and collect target model info
  // e.g., partner_id_id -> partner_id, with target model_id = 78
  const fieldMapping = new Map<string, { baseField: string; targetModelId: number }>();

  for (const groupField of groupByFields) {
    // Check if this is an FK ID field (e.g., partner_id_id)
    const baseField = groupField.replace(/_id$/, ''); // partner_id_id -> partner_id

    if (valid.includes(baseField)) {
      const fieldInfo = getFieldInfo(modelName, baseField);
      if (fieldInfo && fieldInfo.is_fk && fieldInfo.fk_target_model) {
        // Get the target model_id from the model name
        const targetModelId = getModelIdByName(fieldInfo.fk_target_model);
        if (targetModelId) {
          fieldMapping.set(groupField, {
            baseField,
            targetModelId,
          });
          // Initialize the linked map for this field
          result.linked.set(baseField, new Map());
        }
      }
    }
  }

  if (fieldMapping.size === 0) {
    console.error('[NexsusLink] No valid FK fields found in GROUP BY keys');
    return result;
  }

  // Collect unique FK IDs from all group keys and build UUIDs
  const allUuids: string[] = [];
  const uuidToInfo = new Map<string, { field: string; recordId: number }>();

  for (const group of groups) {
    for (const [groupField, mapping] of fieldMapping) {
      const recordId = group.key[groupField] as number | undefined;

      if (recordId && typeof recordId === 'number' && recordId > 0) {
        const uuid = buildDataUuidV2(mapping.targetModelId, recordId);

        // Only add if not already seen
        if (!uuidToInfo.has(uuid)) {
          allUuids.push(uuid);
          uuidToInfo.set(uuid, { field: mapping.baseField, recordId });
        }
      }
    }
  }

  result.stats.totalTargets = allUuids.length;

  if (allUuids.length === 0) {
    console.error('[NexsusLink] No FK IDs found in group keys');
    return result;
  }

  // Batch fetch all targets from Qdrant
  console.error(`[NexsusLink] Resolving ${allUuids.length} linked records from group keys...`);
  result.stats.batchCalls = 1;

  const fetchedPoints = await batchRetrievePoints(
    UNIFIED_CONFIG.COLLECTION_NAME,
    allUuids
  );

  // Process fetched points
  for (const [uuid, point] of fetchedPoints) {
    const info = uuidToInfo.get(uuid);
    if (!info) continue;

    const { field, recordId } = info;
    const payload = point.payload;

    // Extract requested fields
    const data: Record<string, unknown> = {};
    if (returnFields.includes('*')) {
      Object.assign(data, payload);
    } else {
      for (const f of returnFields) {
        if (f in payload) {
          data[f] = payload[f];
        }
      }
      // Always include name/display_name if available
      if (!('name' in data) && 'name' in payload) {
        data.name = payload.name;
      }
      if (!('display_name' in data) && 'display_name' in payload) {
        data.display_name = payload.display_name;
      }
    }

    const linked: LinkedRecord = {
      model_name: payload.model_name as string,
      record_id: recordId,
      qdrant_id: uuid,
      data,
    };

    result.linked.get(field)!.set(recordId, linked);
    result.stats.resolvedTargets++;
  }

  // Track missing targets
  for (const uuid of allUuids) {
    if (!fetchedPoints.has(uuid)) {
      result.missingTargets.push(uuid);
    }
  }

  if (result.missingTargets.length > 0) {
    console.error(`[NexsusLink] Missing targets from group keys: ${result.missingTargets.length}`);
    console.error(`[NexsusLink] Tip: Run 'npm run sync -- validate-fk --auto-sync' to sync missing FK targets`);
  }

  console.error(`[NexsusLink] Resolved ${result.stats.resolvedTargets}/${result.stats.totalTargets} linked records from group keys`);

  return result;
}

// =============================================================================
// MAIN RESOLVER
// =============================================================================

/**
 * Resolve Nexsus Links for a set of records
 *
 * Main entry point for FK resolution. Uses batch retrieval for performance.
 *
 * @param records - Records containing FK Qdrant IDs
 * @param options - Resolution options
 * @returns LinkResolutionResult with linked records and stats
 */
export async function resolveLinks(
  records: Array<Record<string, unknown>>,
  options: LinkResolverOptions
): Promise<LinkResolutionResult> {
  const { linkFields, returnFields, limit, modelName } = options;

  // Initialize result
  const result: LinkResolutionResult = {
    linked: new Map(),
    invalidFields: [],
    missingTargets: [],
    stats: {
      totalTargets: 0,
      resolvedTargets: 0,
      batchCalls: 0,
    },
  };

  // Validate link fields
  const { valid, invalid } = validateLinkFields(modelName, linkFields);
  result.invalidFields = invalid;

  if (invalid.length > 0) {
    console.error(`[NexsusLink] Invalid fields: ${invalid.join(', ')}`);
  }

  if (valid.length === 0) {
    return result;
  }

  // Collect unique FK Qdrant IDs
  const fkIds = collectFkQdrantIds(records, valid, limit);

  // Build list of all UUIDs to fetch and track which field each belongs to
  const allUuids: string[] = [];
  const uuidToField = new Map<string, string>();

  for (const [field, uuids] of fkIds) {
    for (const uuid of uuids) {
      allUuids.push(uuid);
      uuidToField.set(uuid, field);
    }
  }

  result.stats.totalTargets = allUuids.length;

  if (allUuids.length === 0) {
    // Initialize empty maps for each field
    for (const field of valid) {
      result.linked.set(field, new Map());
    }
    return result;
  }

  // Batch fetch all targets
  console.error(`[NexsusLink] Fetching ${allUuids.length} linked records...`);
  result.stats.batchCalls = 1;

  const fetchedPoints = await batchRetrievePoints(
    UNIFIED_CONFIG.COLLECTION_NAME,
    allUuids
  );

  // Initialize linked maps
  for (const field of valid) {
    result.linked.set(field, new Map());
  }

  // Process fetched points
  for (const [uuid, point] of fetchedPoints) {
    const field = uuidToField.get(uuid);
    if (!field) continue;

    const payload = point.payload;
    const recordId = payload.record_id as number;

    // Extract requested fields
    const data: Record<string, unknown> = {};
    if (returnFields.includes('*')) {
      // Return all payload fields
      Object.assign(data, payload);
    } else {
      for (const f of returnFields) {
        if (f in payload) {
          data[f] = payload[f];
        }
      }
      // Always include name/display_name if available and not already included
      if (!('name' in data) && 'name' in payload) {
        data.name = payload.name;
      }
      if (!('display_name' in data) && 'display_name' in payload) {
        data.display_name = payload.display_name;
      }
    }

    const linked: LinkedRecord = {
      model_name: payload.model_name as string,
      record_id: recordId,
      qdrant_id: uuid,
      data,
    };

    result.linked.get(field)!.set(recordId, linked);
    result.stats.resolvedTargets++;
  }

  // Track missing targets
  for (const uuid of allUuids) {
    if (!fetchedPoints.has(uuid)) {
      result.missingTargets.push(uuid);
    }
  }

  if (result.missingTargets.length > 0) {
    console.error(`[NexsusLink] Missing targets: ${result.missingTargets.length}`);
    console.error(`[NexsusLink] Tip: Run 'npm run sync -- validate-fk --auto-sync' to sync missing FK targets`);
  }

  console.error(`[NexsusLink] Resolved ${result.stats.resolvedTargets}/${result.stats.totalTargets} linked records`);

  return result;
}

// =============================================================================
// RECORD ENRICHMENT
// =============================================================================

/**
 * Enrich records with linked data
 *
 * Adds _linked object to each record with resolved FK data.
 *
 * @param records - Records to enrich
 * @param linkFields - FK fields that were linked
 * @param linkResult - Resolution result containing linked records
 * @returns Enriched records with _linked objects
 */
export function enrichRecordsWithLinks(
  records: Array<Record<string, unknown>>,
  linkFields: string[],
  linkResult: LinkResolutionResult
): Array<Record<string, unknown>> {
  return records.map(record => {
    const enriched: Record<string, unknown> = { ...record };
    const _linked: Record<string, LinkedRecord | null> = {};

    for (const field of linkFields) {
      // Get the FK ID from the record
      const idField = `${field}_id`;
      const recordId = record[idField] as number | undefined;

      if (recordId && linkResult.linked.get(field)?.has(recordId)) {
        _linked[field] = linkResult.linked.get(field)!.get(recordId)!;
      } else {
        _linked[field] = null;
      }
    }

    // Only add _linked if there's at least one resolved link
    if (Object.values(_linked).some(v => v !== null)) {
      enriched._linked = _linked;
    }

    return enriched;
  });
}

/**
 * Get display name for a group key value using linked data
 *
 * @param field - FK field name (e.g., "partner_id")
 * @param value - FK ID value from group key
 * @param linkResult - Resolution result containing linked records
 * @returns Display string (e.g., "Wadsworth Building (#282161)")
 */
export function getLinkedDisplayName(
  field: string,
  value: number,
  linkResult: LinkResolutionResult
): string | null {
  const linkedMap = linkResult.linked.get(field);
  if (!linkedMap) return null;

  const linked = linkedMap.get(value);
  if (!linked) return null;

  const name = linked.data.name ?? linked.data.display_name;
  if (name) {
    return `${name} (#${value})`;
  }

  return null;
}

// =============================================================================
// JSON FK RESOLUTION
// =============================================================================

/**
 * Options for JSON FK resolution
 */
export interface JsonFkResolverOptions {
  /** JSON FK field names to resolve (e.g., ["analytic_distribution"]) */
  jsonFkFields: string[];
  /** Source model name for mapping lookup */
  modelName: string;
  /** Maximum unique targets to resolve */
  limit: number;
}

/**
 * Resolve JSON FK fields to their target names
 *
 * JSON FK fields like analytic_distribution store keys that are record IDs
 * of a target model. This function resolves those IDs to display names.
 *
 * Example:
 *   Input: analytic_distribution = {"5029": 100, "5030": 50}
 *   Output: resolved map with {5029: {name: "Job A", value: 100}, ...}
 *
 * @param records - Records containing JSON FK fields
 * @param options - Resolution options
 * @returns JsonFkResolutionResult with resolved entries
 */
export async function resolveJsonFkLinks(
  records: Array<Record<string, unknown>>,
  options: JsonFkResolverOptions
): Promise<JsonFkResolutionResult> {
  const { jsonFkFields, modelName, limit } = options;

  // Initialize result
  const result: JsonFkResolutionResult = {
    resolved: new Map(),
    stats: {
      total: 0,
      resolved: 0,
      missing: 0,
    },
  };

  // Collect unique JSON keys (record IDs) per field
  const keysToResolve = new Map<string, Map<number, number>>(); // field -> (recordId -> value)
  const uuidToField = new Map<string, { field: string; recordId: number }>();
  const allUuids: string[] = [];

  for (const field of jsonFkFields) {
    // Get JSON FK mapping for this field
    const mapping = getJsonFkMapping(modelName, field);
    if (!mapping) {
      console.error(`[NexsusLink] No JSON FK mapping for ${modelName}.${field}`);
      continue;
    }

    // Initialize map for this field
    keysToResolve.set(field, new Map());
    result.resolved.set(field, new Map());

    // Collect keys from all records
    for (const record of records) {
      const jsonValue = record[field] as Record<string, unknown> | undefined;
      if (!jsonValue || typeof jsonValue !== 'object' || Array.isArray(jsonValue)) {
        continue;
      }

      for (const [keyStr, value] of Object.entries(jsonValue)) {
        const recordId = parseInt(keyStr, 10);
        if (isNaN(recordId) || recordId <= 0) continue;

        const fieldKeys = keysToResolve.get(field)!;
        if (fieldKeys.size >= limit) break;

        // Store the value (percentage/amount) along with the key
        if (!fieldKeys.has(recordId)) {
          fieldKeys.set(recordId, value as number);
          result.stats.total++;

          // Build Qdrant UUID for batch retrieval
          const uuid = buildDataUuidV2(mapping.key_target_model_id, recordId);
          allUuids.push(uuid);
          uuidToField.set(uuid, { field, recordId });
        }
      }
    }
  }

  if (allUuids.length === 0) {
    return result;
  }

  // Batch fetch all target records
  console.error(`[NexsusLink] Fetching ${allUuids.length} JSON FK targets...`);

  const fetchedPoints = await batchRetrievePoints(
    UNIFIED_CONFIG.COLLECTION_NAME,
    allUuids
  );

  // Process fetched points
  for (const [uuid, point] of fetchedPoints) {
    const info = uuidToField.get(uuid);
    if (!info) continue;

    const { field, recordId } = info;
    const payload = point.payload;
    const name = (payload.name ?? payload.display_name ?? `ID:${recordId}`) as string;
    const value = keysToResolve.get(field)?.get(recordId) ?? 0;

    const entry: ResolvedJsonFkEntry = {
      record_id: recordId,
      name,
      value,
      qdrant_id: uuid,
    };

    result.resolved.get(field)!.set(recordId, entry);
    result.stats.resolved++;
  }

  // Count missing
  result.stats.missing = result.stats.total - result.stats.resolved;

  if (result.stats.missing > 0) {
    console.error(`[NexsusLink] Missing JSON FK targets: ${result.stats.missing}`);
  }

  console.error(`[NexsusLink] Resolved ${result.stats.resolved}/${result.stats.total} JSON FK targets`);

  return result;
}

/**
 * Enrich records with resolved JSON FK data
 *
 * Adds *_resolved field for each JSON FK field with resolved names.
 *
 * @param records - Records to enrich
 * @param jsonFkFields - JSON FK fields that were resolved
 * @param jsonFkResult - Resolution result
 * @returns Enriched records with *_resolved fields
 */
export function enrichRecordsWithJsonFkLinks(
  records: Array<Record<string, unknown>>,
  jsonFkFields: string[],
  jsonFkResult: JsonFkResolutionResult
): Array<Record<string, unknown>> {
  return records.map(record => {
    const enriched: Record<string, unknown> = { ...record };

    for (const field of jsonFkFields) {
      const jsonValue = record[field] as Record<string, unknown> | undefined;
      if (!jsonValue || typeof jsonValue !== 'object' || Array.isArray(jsonValue)) {
        continue;
      }

      const resolvedMap = jsonFkResult.resolved.get(field);
      if (!resolvedMap || resolvedMap.size === 0) continue;

      // Build resolved representation
      const resolved: Record<string, { name: string; value: number }> = {};

      for (const [keyStr, value] of Object.entries(jsonValue)) {
        const recordId = parseInt(keyStr, 10);
        if (isNaN(recordId)) continue;

        const entry = resolvedMap.get(recordId);
        if (entry) {
          resolved[keyStr] = {
            name: entry.name,
            value: entry.value,
          };
        } else {
          // Not resolved - keep original ID
          resolved[keyStr] = {
            name: `#${recordId}`,
            value: value as number,
          };
        }
      }

      if (Object.keys(resolved).length > 0) {
        enriched[`${field}_resolved`] = resolved;
      }
    }

    return enriched;
  });
}

/**
 * Format JSON FK value for display
 *
 * Converts resolved JSON FK to a human-readable string.
 * Example: {"5029": 100} with resolved name "Job A" -> "Job A: 100%"
 *
 * @param field - JSON FK field name
 * @param jsonValue - Original JSON value
 * @param jsonFkResult - Resolution result
 * @returns Formatted display string
 */
export function formatJsonFkDisplay(
  field: string,
  jsonValue: Record<string, unknown>,
  jsonFkResult: JsonFkResolutionResult
): string {
  const resolvedMap = jsonFkResult.resolved.get(field);
  if (!resolvedMap) return JSON.stringify(jsonValue);

  const parts: string[] = [];

  for (const [keyStr, value] of Object.entries(jsonValue)) {
    const recordId = parseInt(keyStr, 10);
    const entry = resolvedMap.get(recordId);
    const name = entry?.name ?? `#${recordId}`;
    const numValue = typeof value === 'number' ? value : 0;

    // Format based on value type (percentage for analytic_distribution)
    parts.push(`${name}: ${numValue}%`);
  }

  return parts.join(', ');
}

// =============================================================================
// JSON FK GROUP RESOLUTION (Bug #4 Fix)
// =============================================================================

/**
 * Resolve JSON FK fields from aggregation GROUP BY keys
 *
 * When grouping by a JSON FK field (like analytic_distribution), this function
 * extracts the FK IDs from the JSON group keys and resolves them to display names.
 *
 * Example:
 *   Groups: [{key: {analytic_distribution: {"5029": 100}}}, ...]
 *   This extracts [5029, ...], fetches the names, and returns a resolution result.
 *
 * @param groups - Aggregation groups with key values
 * @param groupByFields - Fields used in GROUP BY
 * @param linkJsonFields - JSON FK fields to resolve
 * @param modelName - Source model name for mapping lookup
 * @returns JsonFkResolutionResult with resolved entries
 */
export async function resolveGroupJsonFkLinks(
  groups: Array<{ key: Record<string, unknown> }>,
  groupByFields: string[],
  linkJsonFields: string[],
  modelName: string
): Promise<JsonFkResolutionResult> {
  // Initialize result
  const result: JsonFkResolutionResult = {
    resolved: new Map(),
    stats: {
      total: 0,
      resolved: 0,
      missing: 0,
    },
  };

  // Find intersection of group_by fields and link_json fields
  const fieldsToResolve = groupByFields.filter(f => linkJsonFields.includes(f));

  if (fieldsToResolve.length === 0) {
    console.error('[NexsusLink] No overlap between group_by and link_json fields');
    return result;
  }

  // Collect unique JSON FK keys from group keys
  const uuidToField = new Map<string, { field: string; recordId: number }>();
  const allUuids: string[] = [];
  const keysToResolve = new Map<string, Map<number, number>>(); // field -> (recordId -> value)

  for (const field of fieldsToResolve) {
    // Get JSON FK mapping for this field
    const mapping = getJsonFkMapping(modelName, field);
    if (!mapping) {
      console.error(`[NexsusLink] No JSON FK mapping for ${modelName}.${field}`);
      continue;
    }

    keysToResolve.set(field, new Map());
    result.resolved.set(field, new Map());

    // Extract keys from each group's key value
    for (const group of groups) {
      let jsonValue = group.key[field] as Record<string, unknown> | string | undefined;

      // Handle both object and string (from JSON.stringify in buildGroupKey)
      if (typeof jsonValue === 'string') {
        try {
          jsonValue = JSON.parse(jsonValue) as Record<string, unknown>;
        } catch {
          continue; // Not valid JSON
        }
      }

      if (!jsonValue || typeof jsonValue !== 'object' || Array.isArray(jsonValue)) {
        continue;
      }

      for (const [keyStr, value] of Object.entries(jsonValue)) {
        const recordId = parseInt(keyStr, 10);
        if (isNaN(recordId) || recordId <= 0) continue;

        const fieldKeys = keysToResolve.get(field)!;
        if (!fieldKeys.has(recordId)) {
          fieldKeys.set(recordId, value as number);
          result.stats.total++;

          // Build Qdrant UUID for batch retrieval
          const uuid = buildDataUuidV2(mapping.key_target_model_id, recordId);
          allUuids.push(uuid);
          uuidToField.set(uuid, { field, recordId });
        }
      }
    }
  }

  if (allUuids.length === 0) {
    return result;
  }

  // Batch fetch all target records
  console.error(`[NexsusLink] Fetching ${allUuids.length} JSON FK targets from group keys...`);

  const fetchedPoints = await batchRetrievePoints(
    UNIFIED_CONFIG.COLLECTION_NAME,
    allUuids
  );

  // Process fetched points
  for (const [uuid, point] of fetchedPoints) {
    const info = uuidToField.get(uuid);
    if (!info) continue;

    const { field, recordId } = info;
    const payload = point.payload;
    const name = (payload.name ?? payload.display_name ?? `ID:${recordId}`) as string;
    const value = keysToResolve.get(field)?.get(recordId) ?? 0;

    const entry: ResolvedJsonFkEntry = {
      record_id: recordId,
      name,
      value,
      qdrant_id: uuid,
    };

    result.resolved.get(field)!.set(recordId, entry);
    result.stats.resolved++;
  }

  // Count missing
  result.stats.missing = result.stats.total - result.stats.resolved;

  if (result.stats.missing > 0) {
    console.error(`[NexsusLink] Missing JSON FK targets from groups: ${result.stats.missing}`);
  }

  console.error(`[NexsusLink] Resolved ${result.stats.resolved}/${result.stats.total} JSON FK targets from group keys`);

  return result;
}

/**
 * Format a JSON FK group key value for display
 *
 * Converts a JSON object group key to a human-readable string using resolved names.
 * Example: {"5029": 100} with resolved name "Job A" -> "Job A (100%)"
 *
 * @param field - JSON FK field name
 * @param jsonValue - JSON object value from group key (could be object or string)
 * @param jsonFkResult - Resolution result with resolved names
 * @returns Formatted display string, or original JSON string if not resolvable
 */
export function formatGroupJsonFkDisplay(
  field: string,
  jsonValue: Record<string, unknown> | string,
  jsonFkResult: JsonFkResolutionResult
): string {
  // Parse string if needed
  let parsed: Record<string, unknown>;
  if (typeof jsonValue === 'string') {
    try {
      parsed = JSON.parse(jsonValue) as Record<string, unknown>;
    } catch {
      return jsonValue; // Return original string if not parseable
    }
  } else {
    parsed = jsonValue;
  }

  const resolvedMap = jsonFkResult.resolved.get(field);
  if (!resolvedMap || resolvedMap.size === 0) {
    return JSON.stringify(parsed);
  }

  const parts: string[] = [];

  for (const [keyStr, value] of Object.entries(parsed)) {
    const recordId = parseInt(keyStr, 10);
    const entry = resolvedMap.get(recordId);
    const name = entry?.name ?? `#${recordId}`;
    const numValue = typeof value === 'number' ? value : 0;

    // Format as "Name (value%)" for clarity
    parts.push(`${name} (${numValue}%)`);
  }

  return parts.join(', ');
}
