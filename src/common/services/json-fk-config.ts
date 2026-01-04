/**
 * JSON FK Configuration Service
 *
 * Loads and provides access to JSON FK mappings from json_fk_mappings.json.
 * These mappings define how JSON fields with FK keys should be resolved.
 *
 * Example: analytic_distribution: {"5029": 100}
 * - Field "analytic_distribution" on model "account.move.line"
 * - Key "5029" is a record ID of "account.analytic.account"
 * - Value 100 is a percentage
 *
 * Usage:
 *   const mapping = getJsonFkMapping("account.move.line", "analytic_distribution");
 *   if (mapping) {
 *     // Key target model is "account.analytic.account"
 *     // Key "5029" should be resolved to that model's record
 *   }
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { JsonFkConfig, JsonFkMapping } from '../types.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// MODULE STATE
// =============================================================================

let config: JsonFkConfig | null = null;
let configLoadAttempted = false;

// Lookup map: "model:field" -> mapping
const mappingLookup = new Map<string, JsonFkMapping>();

// =============================================================================
// CONFIG LOADING
// =============================================================================

/**
 * Get the path to the JSON FK config file
 */
function getConfigPath(): string {
  // Try multiple paths to support different working directories
  const paths = [
    join(process.cwd(), 'data', 'json_fk_mappings.json'),
    join(process.cwd(), '..', 'data', 'json_fk_mappings.json'),
    join(__dirname, '..', '..', 'data', 'json_fk_mappings.json'),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }

  // Return default path even if it doesn't exist (for error messaging)
  return paths[0];
}

/**
 * Load the JSON FK configuration from file
 *
 * Lazily loaded on first access. Returns null if file doesn't exist
 * or is invalid (this is not a fatal error - just means no JSON FK
 * resolution will be available).
 */
export function loadJsonFkConfig(): JsonFkConfig | null {
  if (configLoadAttempted) {
    return config;
  }

  configLoadAttempted = true;
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    console.error(`[JsonFkConfig] Config file not found: ${configPath}`);
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    config = JSON.parse(content) as JsonFkConfig;

    // Build lookup map for fast access
    mappingLookup.clear();
    for (const mapping of config.mappings) {
      const key = `${mapping.source_model}:${mapping.field_name}`;
      mappingLookup.set(key, mapping);
    }

    console.error(`[JsonFkConfig] Loaded ${config.mappings.length} JSON FK mappings`);
    return config;
  } catch (error) {
    console.error(`[JsonFkConfig] Failed to load config: ${error}`);
    return null;
  }
}

/**
 * Force reload the configuration (useful after config changes)
 */
export function reloadJsonFkConfig(): JsonFkConfig | null {
  configLoadAttempted = false;
  config = null;
  mappingLookup.clear();
  return loadJsonFkConfig();
}

// =============================================================================
// CONFIG QUERIES
// =============================================================================

/**
 * Get JSON FK mapping for a specific model and field
 *
 * @param modelName - Source model (e.g., "account.move.line")
 * @param fieldName - JSON field name (e.g., "analytic_distribution")
 * @returns Mapping if found, undefined otherwise
 */
export function getJsonFkMapping(
  modelName: string,
  fieldName: string
): JsonFkMapping | undefined {
  // Ensure config is loaded
  if (!configLoadAttempted) {
    loadJsonFkConfig();
  }

  const key = `${modelName}:${fieldName}`;
  return mappingLookup.get(key);
}

/**
 * Check if a field is a JSON FK field
 *
 * @param modelName - Source model
 * @param fieldName - Field to check
 * @returns True if this is a JSON FK field
 */
export function isJsonFkField(modelName: string, fieldName: string): boolean {
  return getJsonFkMapping(modelName, fieldName) !== undefined;
}

/**
 * Get all JSON FK mappings for a model
 *
 * @param modelName - Source model
 * @returns Array of mappings for this model
 */
export function getJsonFkMappingsForModel(modelName: string): JsonFkMapping[] {
  // Ensure config is loaded
  if (!configLoadAttempted) {
    loadJsonFkConfig();
  }

  if (!config) {
    return [];
  }

  return config.mappings.filter((m) => m.source_model === modelName);
}

/**
 * Get all configured JSON FK field names for a model
 *
 * @param modelName - Source model
 * @returns Array of field names that are JSON FK fields
 */
export function getJsonFkFieldNames(modelName: string): string[] {
  return getJsonFkMappingsForModel(modelName).map((m) => m.field_name);
}

/**
 * Get complete loaded configuration (for debugging/status)
 */
export function getJsonFkConfigStatus(): {
  loaded: boolean;
  mappingCount: number;
  mappings: JsonFkMapping[];
} {
  // Ensure config is loaded
  if (!configLoadAttempted) {
    loadJsonFkConfig();
  }

  return {
    loaded: config !== null,
    mappingCount: config?.mappings.length ?? 0,
    mappings: config?.mappings ?? [],
  };
}
