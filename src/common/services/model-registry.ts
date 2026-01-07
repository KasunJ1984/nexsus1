/**
 * Model Registry - Unified validation for all model sources
 *
 * This service provides a single source of truth for model validation,
 * combining models from:
 * 1. Schema Excel file - Models with field definitions
 * 2. Qdrant data points - Models discovered dynamically from vector database
 * 3. Pipeline sync metadata (fallback) - JSON file for when Qdrant unavailable
 *
 * IMPORTANT: Use async functions (isValidModelAsync, getValidModelsAsync) for
 * accurate results. Sync functions use cache or JSON fallback only.
 */

import { getAllModelNames as getSchemaFileModels } from './schema-loader.js';
import { discoverModelsInQdrant, getQdrantClient } from './vector-client.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// =============================================================================
// CACHE FOR SYNCED MODELS (avoids repeated Qdrant queries)
// =============================================================================

/**
 * Cache for synced models discovered from Qdrant
 * - Populated on first call to getSyncedDataModelsAsync()
 * - TTL: 30 minutes
 * - Cleared by clearSyncedModelsCache()
 */
let syncedModelsCache: {
  models: string[];
  timestamp: number;
  source: 'qdrant' | 'json' | 'empty';
} | null = null;

const SYNCED_MODELS_CACHE_TTL = parseInt(
  process.env.SYNCED_MODELS_CACHE_TTL_MS || '1800000',
  10
); // 30 min default

/**
 * Clear the synced models cache
 *
 * Call this after sync operations to force re-discovery from Qdrant.
 */
export function clearSyncedModelsCache(): void {
  syncedModelsCache = null;
  console.error('[ModelRegistry] Synced models cache cleared');
}

/**
 * Check if cache is valid (not expired)
 */
function isCacheValid(): boolean {
  if (!syncedModelsCache) return false;
  const age = Date.now() - syncedModelsCache.timestamp;
  return age < SYNCED_MODELS_CACHE_TTL;
}

// =============================================================================
// ASYNC FUNCTIONS (Qdrant-based, with cache)
// =============================================================================

/**
 * Get models synced as data points (from Qdrant, with JSON fallback)
 *
 * ASYNC VERSION - Queries Qdrant directly for accurate, up-to-date model list.
 * Uses caching to avoid repeated Qdrant queries.
 *
 * Priority:
 * 1. Return cached value if valid
 * 2. Query Qdrant for unique model_name values from point_type='data'
 * 3. Fall back to JSON file if Qdrant unavailable
 *
 * @returns Promise<string[]> - Sorted array of synced model names
 */
export async function getSyncedDataModelsAsync(): Promise<string[]> {
  // Return cached value if valid
  if (isCacheValid()) {
    return syncedModelsCache!.models;
  }

  // Try Qdrant first (most accurate)
  const client = getQdrantClient();
  if (client) {
    try {
      const models = await discoverModelsInQdrant();
      const sortedModels = models.sort();

      // Cache the result
      syncedModelsCache = {
        models: sortedModels,
        timestamp: Date.now(),
        source: 'qdrant',
      };

      console.error(
        `[ModelRegistry] Discovered ${sortedModels.length} models from Qdrant: ${sortedModels.join(', ')}`
      );
      return sortedModels;
    } catch (err) {
      console.error('[ModelRegistry] Qdrant discovery failed, falling back to JSON:', err);
    }
  }

  // Fall back to JSON file
  const jsonModels = getSyncedDataModelsFromJson();

  // Cache even the fallback result
  syncedModelsCache = {
    models: jsonModels,
    timestamp: Date.now(),
    source: jsonModels.length > 0 ? 'json' : 'empty',
  };

  console.error(`[ModelRegistry] Using JSON fallback (${jsonModels.length} models)`);
  return jsonModels;
}

/**
 * Get models from JSON file (sync, used as fallback)
 */
function getSyncedDataModelsFromJson(): string[] {
  const metadataPath = join(process.cwd(), 'data', 'pipeline_sync_metadata.json');
  if (!existsSync(metadataPath)) {
    return [];
  }
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
    return Object.keys(metadata).sort();
  } catch {
    return [];
  }
}

/**
 * Get models synced as data points (SYNC version - uses cache or JSON)
 *
 * @deprecated Use getSyncedDataModelsAsync() for accurate results
 */
export function getSyncedDataModels(): string[] {
  // Return cached value if available
  if (syncedModelsCache && isCacheValid()) {
    return syncedModelsCache.models;
  }
  // Otherwise fall back to JSON
  return getSyncedDataModelsFromJson();
}

/**
 * Get all valid models based on search context (ASYNC version)
 *
 * @param context.point_type - Which source to check:
 *   - 'schema': Only models in schema file
 *   - 'data': Only models synced as data points (from Qdrant)
 *   - 'all': Union of both sources
 */
export async function getValidModelsAsync(context: {
  point_type?: 'schema' | 'data' | 'all';
}): Promise<string[]> {
  const schemaModels = new Set(getSchemaFileModels());
  const syncedModels = new Set(await getSyncedDataModelsAsync());

  switch (context.point_type) {
    case 'schema':
      return [...schemaModels].sort();
    case 'data':
      return [...syncedModels].sort();
    case 'all':
    default:
      return [...new Set([...schemaModels, ...syncedModels])].sort();
  }
}

/**
 * Get all valid models based on search context (SYNC version)
 *
 * @deprecated Use getValidModelsAsync() for accurate results
 */
export function getValidModels(context: {
  point_type?: 'schema' | 'data' | 'all';
}): string[] {
  const schemaModels = new Set(getSchemaFileModels());
  const syncedModels = new Set(getSyncedDataModels());

  switch (context.point_type) {
    case 'schema':
      return [...schemaModels].sort();
    case 'data':
      return [...syncedModels].sort();
    case 'all':
    default:
      return [...new Set([...schemaModels, ...syncedModels])].sort();
  }
}

/**
 * Check if model exists in appropriate source (ASYNC version)
 *
 * @param modelName - The model to validate (e.g., "master", "actual")
 * @param context.point_type - Which source to check against
 */
export async function isValidModelAsync(
  modelName: string,
  context?: { point_type?: 'schema' | 'data' | 'all' }
): Promise<boolean> {
  const validModels = await getValidModelsAsync(context || { point_type: 'all' });
  return validModels.includes(modelName);
}

/**
 * Check if model exists in appropriate source (SYNC version)
 *
 * @deprecated Use isValidModelAsync() for accurate results
 */
export function isValidModel(
  modelName: string,
  context?: { point_type?: 'schema' | 'data' | 'all' }
): boolean {
  const validModels = getValidModels(context || { point_type: 'all' });
  return validModels.includes(modelName);
}

/**
 * Get which sources contain a model (ASYNC version)
 */
export async function getModelSourcesAsync(modelName: string): Promise<{
  inSchemaFile: boolean;
  inSyncedData: boolean;
}> {
  const schemaModels = new Set(getSchemaFileModels());
  const syncedModels = new Set(await getSyncedDataModelsAsync());

  return {
    inSchemaFile: schemaModels.has(modelName),
    inSyncedData: syncedModels.has(modelName),
  };
}

/**
 * Get which sources contain a model (SYNC version)
 *
 * @deprecated Use getModelSourcesAsync() for accurate results
 */
export function getModelSources(modelName: string): {
  inSchemaFile: boolean;
  inSyncedData: boolean;
} {
  const schemaModels = new Set(getSchemaFileModels());
  const syncedModels = new Set(getSyncedDataModels());

  return {
    inSchemaFile: schemaModels.has(modelName),
    inSyncedData: syncedModels.has(modelName),
  };
}

/**
 * Get helpful error message for invalid model
 *
 * This provides context-aware error messages:
 * - If model exists in schema but not synced, suggests sync command
 * - If model exists in data but searching schema, suggests point_type change
 * - If model not found anywhere, suggests similar models
 */
export function getModelNotFoundError(
  modelName: string,
  context: {
    point_type?: 'schema' | 'data' | 'all';
    toolName: string;
  }
): string {
  const sources = getModelSources(modelName);
  const validModels = getValidModels(context);

  // Check if model exists in OTHER source
  if (sources.inSchemaFile && context.point_type === 'data') {
    return `❌ Model "${modelName}" exists in schema but hasn't been synced as data.

**To fix:** Run this command to sync the model:
\`\`\`
npm run sync -- sync model ${modelName}
\`\`\``;
  }

  if (sources.inSyncedData && context.point_type === 'schema') {
    return `❌ Model "${modelName}" exists in data but not in schema file.

**Tip:** Try searching with \`point_type: "data"\` instead.`;
  }

  // Model not found anywhere - suggest similar
  const searchTerm = modelName.toLowerCase();
  const suggestions = validModels
    .filter(
      (m) =>
        m.toLowerCase().includes(searchTerm) ||
        searchTerm.split('.').some((part) => m.toLowerCase().includes(part))
    )
    .slice(0, 5);

  return `❌ Model "${modelName}" not found.

${suggestions.length > 0 ? `**Did you mean:**\n${suggestions.map((s) => `- ${s}`).join('\n')}` : ''}

**Available models:** ${validModels.length}`;
}
