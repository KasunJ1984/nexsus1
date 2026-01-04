/**
 * FK Dependency Discovery Service
 *
 * Analyzes synced records to discover FK dependencies for cascade sync.
 *
 * Key functions:
 * - getFkFieldsForModel() - Get all FK fields (many2one, many2many, one2many)
 * - extractFkDependencies() - Extract unique FK IDs from records
 * - checkSyncedFkTargets() - Check which FK targets already exist in Qdrant
 *
 * Used by cascade-sync to:
 * 1. Discover which FK fields exist on a model
 * 2. Extract unique IDs referenced by those FKs
 * 3. Check which target records need to be synced
 */

import {
  getModelFieldsFromSchema,
  getModelIdFromSchema,
  getFkFieldsFromSchema,
} from './schema-query-service.js';
import { getQdrantClient, isVectorClientAvailable } from './vector-client.js';
import { buildDataUuidV2 } from '../utils/uuid-v2.js';
import { UNIFIED_CONFIG } from '../constants.js';
import type { PipelineField, RelationshipType } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * FK field information from schema
 */
export interface FkFieldInfo {
  /** Field ID from ir.model.fields (needed for V2 Graph UUID) */
  field_id: number;
  /** Field name (e.g., "partner_id") */
  field_name: string;
  /** Human-readable label (e.g., "Partner") */
  field_label: string;
  /** Relationship type */
  field_type: RelationshipType;
  /** Target model name (e.g., "res.partner") */
  target_model: string;
  /** Target model ID */
  target_model_id: number;
  /** Whether field is stored in database */
  stored: boolean;
}

/**
 * FK dependency extracted from records
 */
export interface FkDependency {
  /** Field ID from ir.model.fields (needed for V2 Graph UUID) */
  field_id: number;
  /** Field name (e.g., "partner_id" or "tag_ids") */
  field_name: string;
  /** Human-readable label */
  field_label: string;
  /** Relationship type */
  field_type: RelationshipType;
  /** Target model name (e.g., "res.partner") */
  target_model: string;
  /** Target model ID */
  target_model_id: number;
  /** Unique IDs referenced (deduplicated) */
  unique_ids: number[];
  /** Total references (may exceed unique_ids for many2many) */
  total_references: number;
}

/**
 * Result of checking synced FK targets
 */
export interface SyncedTargetsResult {
  /** IDs that already exist in Qdrant */
  synced: number[];
  /** IDs that need to be synced */
  missing: number[];
}

// =============================================================================
// FK FIELD DISCOVERY
// =============================================================================

/**
 * Relationship field types that represent FK relationships
 */
const FK_FIELD_TYPES = ['many2one', 'many2many', 'one2many'];

/**
 * Get all FK fields for a model
 *
 * Returns fields that represent foreign key relationships:
 * - many2one: Single ID reference (e.g., partner_id)
 * - many2many: Array of IDs (e.g., tag_ids)
 * - one2many: Array of IDs (e.g., line_ids)
 *
 * Only returns fields that have fk_location_model defined (target is known).
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 *
 * @param modelName - Source model name (e.g., "account.move.line")
 * @returns Array of FK field info
 */
export async function getFkFieldsForModel(modelName: string): Promise<FkFieldInfo[]> {
  // Use schema query service to get FK fields from Qdrant
  const allFkFields = await getFkFieldsFromSchema(modelName);

  if (allFkFields.length === 0) {
    console.error(`[FkDiscovery] No FK fields found for model: ${modelName}`);
    return [];
  }

  const fkFields: FkFieldInfo[] = [];

  for (const field of allFkFields) {
    // Check if this is a FK type
    if (!FK_FIELD_TYPES.includes(field.field_type)) {
      continue;
    }

    // Check if target model is known
    if (!field.fk_location_model || !field.fk_location_model_id) {
      continue;
    }

    // Only include stored fields (we can't fetch non-stored from Odoo)
    if (!field.stored) {
      continue;
    }

    fkFields.push({
      field_id: field.field_id,
      field_name: field.field_name,
      field_label: field.field_label,
      field_type: field.field_type as RelationshipType,
      target_model: field.fk_location_model,
      target_model_id: field.fk_location_model_id,
      stored: field.stored,
    });
  }

  console.error(`[FkDiscovery] Found ${fkFields.length} FK fields for ${modelName}`);
  return fkFields;
}

/**
 * Get FK field names only (for Odoo field list)
 *
 * NOTE: This function is now async because it queries Qdrant schema.
 *
 * @param modelName - Source model name
 * @returns Array of FK field names
 */
export async function getFkFieldNames(modelName: string): Promise<string[]> {
  const fkFields = await getFkFieldsForModel(modelName);
  return fkFields.map(f => f.field_name);
}

// =============================================================================
// FK ID EXTRACTION
// =============================================================================

/**
 * Extract FK dependencies from a set of records
 *
 * Analyzes records to find all unique FK IDs referenced.
 * Handles both single IDs (many2one) and ID arrays (many2many, one2many).
 *
 * @param records - Array of Odoo records
 * @param fkFields - FK fields to extract (from getFkFieldsForModel)
 * @returns Array of FK dependencies with unique IDs
 */
export function extractFkDependencies(
  records: Array<Record<string, unknown>>,
  fkFields: FkFieldInfo[]
): FkDependency[] {
  const dependencies: FkDependency[] = [];

  for (const fkField of fkFields) {
    const idSet = new Set<number>();
    let totalRefs = 0;

    for (const record of records) {
      const value = record[fkField.field_name];

      if (value === null || value === undefined || value === false) {
        continue;
      }

      if (fkField.field_type === 'many2one') {
        // many2one: Odoo returns [id, name] tuple or just id
        const id = extractManyToOneId(value);
        if (id !== null) {
          idSet.add(id);
          totalRefs++;
        }
      } else {
        // many2many or one2many: Odoo returns array of IDs
        const ids = extractManyToManyIds(value);
        for (const id of ids) {
          idSet.add(id);
          totalRefs++;
        }
      }
    }

    // Only add if we found any IDs
    if (idSet.size > 0) {
      dependencies.push({
        field_id: fkField.field_id,
        field_name: fkField.field_name,
        field_label: fkField.field_label,
        field_type: fkField.field_type,
        target_model: fkField.target_model,
        target_model_id: fkField.target_model_id,
        unique_ids: Array.from(idSet).sort((a, b) => a - b),
        total_references: totalRefs,
      });
    }
  }

  // Log summary
  const totalUnique = dependencies.reduce((sum, d) => sum + d.unique_ids.length, 0);
  const totalRefs = dependencies.reduce((sum, d) => sum + d.total_references, 0);
  console.error(`[FkDiscovery] Extracted ${totalUnique} unique IDs (${totalRefs} total refs) from ${dependencies.length} FK fields`);

  return dependencies;
}

/**
 * Extract ID from many2one field value
 *
 * Odoo returns many2one as:
 * - [id, name] tuple (e.g., [123, "Partner Name"])
 * - Just the id (number) in some cases
 * - false if not set
 *
 * @param value - Field value from Odoo
 * @returns ID or null if not valid
 */
function extractManyToOneId(value: unknown): number | null {
  // Array format: [id, name]
  if (Array.isArray(value) && value.length >= 1) {
    const id = value[0];
    if (typeof id === 'number' && id > 0) {
      return id;
    }
  }

  // Direct number
  if (typeof value === 'number' && value > 0) {
    return value;
  }

  return null;
}

/**
 * Extract IDs from many2many/one2many field value
 *
 * Odoo returns these as arrays of IDs: [1, 2, 3]
 *
 * @param value - Field value from Odoo
 * @returns Array of IDs (empty if not valid)
 */
function extractManyToManyIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((v): v is number => typeof v === 'number' && v > 0);
}

// =============================================================================
// SYNC STATUS CHECK
// =============================================================================

/**
 * Check which FK target IDs are already synced in Qdrant
 *
 * Performs a batch check to see which IDs exist in the nexsus_unified collection.
 * Returns separate lists of synced and missing IDs.
 *
 * @param targetModelName - Target model name (e.g., "res.partner")
 * @param targetModelId - Target model ID
 * @param ids - Array of record IDs to check
 * @returns Object with synced and missing ID arrays
 */
export async function checkSyncedFkTargets(
  targetModelName: string,
  targetModelId: number,
  ids: number[]
): Promise<SyncedTargetsResult> {
  if (!isVectorClientAvailable()) {
    throw new Error('Vector client not initialized');
  }

  if (ids.length === 0) {
    return { synced: [], missing: [] };
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Convert IDs to V2 UUIDs for unified collection
  const uuids = ids.map(id => buildDataUuidV2(targetModelId, id));

  // Check which UUIDs exist in Qdrant
  try {
    const points = await client.retrieve(collectionName, {
      ids: uuids,
      with_payload: false,
      with_vector: false,
    });

    // Build set of existing IDs
    const existingUuids = new Set(points.map(p => p.id as string));

    const synced: number[] = [];
    const missing: number[] = [];

    for (let i = 0; i < ids.length; i++) {
      if (existingUuids.has(uuids[i])) {
        synced.push(ids[i]);
      } else {
        missing.push(ids[i]);
      }
    }

    console.error(`[FkDiscovery] ${targetModelName}: ${synced.length} synced, ${missing.length} missing out of ${ids.length} checked`);
    return { synced, missing };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[FkDiscovery] checkSyncedFkTargets failed: ${errorMsg}`);
    throw error;
  }
}

/**
 * Check synced status for all FK dependencies
 *
 * Batch checks all FK targets and returns a map of field -> synced/missing.
 *
 * @param dependencies - FK dependencies from extractFkDependencies
 * @returns Map of field_name -> SyncedTargetsResult
 */
export async function checkAllSyncedTargets(
  dependencies: FkDependency[]
): Promise<Map<string, SyncedTargetsResult>> {
  const results = new Map<string, SyncedTargetsResult>();

  // Process each dependency
  for (const dep of dependencies) {
    const result = await checkSyncedFkTargets(
      dep.target_model,
      dep.target_model_id,
      dep.unique_ids
    );
    results.set(dep.field_name, result);
  }

  return results;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get summary of FK dependencies for logging
 *
 * @param dependencies - FK dependencies
 * @returns Summary string
 */
export function summarizeDependencies(dependencies: FkDependency[]): string {
  const lines: string[] = [];

  for (const dep of dependencies) {
    lines.push(`  ${dep.field_name} → ${dep.target_model}: ${dep.unique_ids.length} unique (${dep.total_references} total)`);
  }

  return lines.join('\n');
}

/**
 * Filter dependencies to only those with missing targets
 *
 * @param dependencies - FK dependencies
 * @param syncStatus - Map of field_name -> SyncedTargetsResult
 * @returns Dependencies with missing targets only
 */
export function filterMissingDependencies(
  dependencies: FkDependency[],
  syncStatus: Map<string, SyncedTargetsResult>
): FkDependency[] {
  return dependencies
    .map(dep => {
      const status = syncStatus.get(dep.field_name);
      if (!status || status.missing.length === 0) {
        return null;
      }

      // Return dependency with only missing IDs
      return {
        ...dep,
        unique_ids: status.missing,
        total_references: status.missing.length, // Reset since we don't track per-ID
      };
    })
    .filter((dep): dep is FkDependency => dep !== null);
}
