/**
 * Index Service for Nexsus1
 *
 * SIMPLE Automatic Index Creation:
 * - ALL schema fields get indexed automatically during sync
 * - No Excel configuration needed (unlike Nexsus)
 * - For many2one fields: creates 3 indexes (field, field_id, field_qdrant)
 *
 * @example
 * // During data sync, indexes are created automatically:
 * const result = await ensureModelIndexes('customer', schemaFields);
 * // result: { created: 6, skipped: 0 }
 */

import { getQdrantClient, isVectorClientAvailable } from './vector-client.js';
import { UNIFIED_CONFIG } from '../constants.js';
import type { PipelineField } from '../types.js';
import chalk from 'chalk';

/**
 * Map field types to Qdrant index types
 *
 * Schema-driven type mapping:
 * - date/datetime → integer (stored as Unix timestamps in milliseconds)
 * - integer → integer
 * - float/monetary → float
 * - boolean → bool
 * - others (char, text, selection, many2one) → keyword
 *
 * @param fieldType - Field type from schema (char, integer, date, many2one, etc.)
 * @returns Qdrant index schema type
 */
function getQdrantIndexType(fieldType: string): 'keyword' | 'integer' | 'float' | 'bool' {
  switch (fieldType.toLowerCase()) {
    // Integer types
    case 'integer':
      return 'integer';

    // Date types stored as Unix timestamps (milliseconds)
    case 'date':
    case 'datetime':
      return 'integer';

    // Float types
    case 'float':
    case 'monetary':
      return 'float';

    // Boolean type
    case 'boolean':
      return 'bool';

    default:
      // char, text, selection, many2one, etc. → keyword
      return 'keyword';
  }
}

/**
 * Ensure payload indexes exist for a model's fields
 *
 * Creates Qdrant payload indexes for ALL schema fields.
 * For many2one fields, creates 3 indexes:
 * - field (e.g., "country_id") - keyword for the name value
 * - field_id (e.g., "country_id_id") - integer for FK ID
 * - field_qdrant (e.g., "country_id_qdrant") - keyword for Qdrant UUID
 *
 * @param modelName - Model name for logging
 * @param schemaFields - Fields from schema to create indexes for
 * @returns Object with counts of created and skipped indexes
 */
export async function ensureModelIndexes(
  modelName: string,
  schemaFields: PipelineField[]
): Promise<{ created: number; skipped: number }> {
  if (!isVectorClientAvailable()) {
    return { created: 0, skipped: 0 };
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  let created = 0;
  let skipped = 0;

  for (const field of schemaFields) {
    const indexType = getQdrantIndexType(field.field_type);

    try {
      // Create index for the base field
      await client.createPayloadIndex(collectionName, {
        field_name: field.field_name,
        field_schema: indexType,
      });
      created++;
    } catch {
      // Index likely already exists - this is expected and OK
      skipped++;
    }

    // For many2one fields, also create _id and _qdrant indexes
    if (field.field_type === 'many2one') {
      // Create _id index (integer)
      try {
        await client.createPayloadIndex(collectionName, {
          field_name: `${field.field_name}_id`,
          field_schema: 'integer',
        });
        created++;
      } catch {
        skipped++;
      }

      // Create _qdrant index (keyword for UUID)
      try {
        await client.createPayloadIndex(collectionName, {
          field_name: `${field.field_name}_qdrant`,
          field_schema: 'keyword',
        });
        created++;
      } catch {
        skipped++;
      }
    }
  }

  if (created > 0) {
    console.error(chalk.gray(`[IndexService] Created ${created} indexes for ${modelName}`));
  }

  return { created, skipped };
}

/**
 * Ensure base indexes exist (always needed for any model)
 *
 * These indexes are used by all point types (data, schema, graph):
 * - point_type: Discriminate between data/schema/graph
 * - model_name: Filter by model
 * - model_id: Filter by model ID
 * - record_id: Filter by record ID
 * - field_name: For schema queries
 * - field_type: For schema queries
 * - source_model/target_model: For graph queries
 *
 * @returns Object with counts of created and skipped indexes
 */
export async function ensureBaseIndexes(): Promise<{ created: number; skipped: number }> {
  if (!isVectorClientAvailable()) {
    return { created: 0, skipped: 0 };
  }

  const client = getQdrantClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  const BASE_INDEXES = [
    // Core discriminator
    { field: 'point_type', type: 'keyword' as const },
    // Model identification
    { field: 'model_name', type: 'keyword' as const },
    { field: 'model_id', type: 'integer' as const },
    { field: 'record_id', type: 'integer' as const },
    // Schema queries
    { field: 'field_name', type: 'keyword' as const },
    { field: 'field_type', type: 'keyword' as const },
    // Graph queries
    { field: 'source_model', type: 'keyword' as const },
    { field: 'target_model', type: 'keyword' as const },
  ];

  let created = 0;
  let skipped = 0;

  for (const { field, type } of BASE_INDEXES) {
    try {
      await client.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: type,
      });
      created++;
    } catch {
      // Index already exists
      skipped++;
    }
  }

  if (created > 0) {
    console.error(chalk.gray(`[IndexService] Created ${created} base indexes`));
  }

  return { created, skipped };
}
