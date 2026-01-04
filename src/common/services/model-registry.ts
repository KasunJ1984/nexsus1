/**
 * Model Registry - Unified validation for all model sources
 *
 * This service provides a single source of truth for model validation,
 * combining models from:
 * 1. Schema Excel file - Models with field definitions
 * 2. Pipeline sync metadata - Models synced as data points
 *
 * This fixes the issue where tools like semantic_search would reject
 * valid data models that weren't in the schema file.
 */

import { getAllModelNames as getSchemaFileModels } from './schema-loader.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Get models synced as data points (from pipeline_sync_metadata.json)
 *
 * This reads the metadata file that tracks which models have been
 * synced to Qdrant as data points via the CLI sync command.
 */
export function getSyncedDataModels(): string[] {
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
 * Get all valid models based on search context
 *
 * @param context.point_type - Which source to check:
 *   - 'schema': Only models in schema file
 *   - 'data': Only models synced as data points
 *   - 'all': Union of both sources
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
 * Check if model exists in appropriate source based on context
 *
 * @param modelName - The model to validate (e.g., "account.move.line")
 * @param context.point_type - Which source to check against
 */
export function isValidModel(
  modelName: string,
  context?: { point_type?: 'schema' | 'data' | 'all' }
): boolean {
  const validModels = getValidModels(context || { point_type: 'all' });
  return validModels.includes(modelName);
}

/**
 * Get which sources contain a model (for error messages)
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
