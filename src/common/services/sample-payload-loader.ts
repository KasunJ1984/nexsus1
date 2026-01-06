/**
 * Sample Payload Loader Service
 *
 * Loads payload configuration from samples/SAMPLE_payload_config.xlsx.
 * This determines which fields are included in the Qdrant payload during
 * Excel data sync (via excel-data-sync.ts).
 *
 * Format of SAMPLE_payload_config.xlsx:
 * - Field_ID: Numeric field identifier
 * - Model_ID: Numeric model identifier
 * - Model_Name: Model name (e.g., "customer")
 * - Field_Name: Field name (e.g., "name")
 * - Field_Label: Human-readable label (optional)
 * - payload: 1 or true = include in payload, 0 or false = exclude
 */

import XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import type { PayloadFieldConfig } from '../types.js';

/** Path to the sample payload config file */
const SAMPLE_PAYLOAD_CONFIG = 'samples/SAMPLE_payload_config.xlsx';

/** Cache for payload configuration */
let cache: Map<string, PayloadFieldConfig> | null = null;

/**
 * Load payload configuration from samples/SAMPLE_payload_config.xlsx
 *
 * Returns a Map where:
 * - Key: "model_name.field_name" (e.g., "customer.name")
 * - Value: PayloadFieldConfig with include_in_payload flag
 *
 * @returns Map of field configs, empty Map if file not found
 */
export function loadSamplePayloadConfig(): Map<string, PayloadFieldConfig> {
  // Return cached config if available
  if (cache !== null) {
    return cache;
  }

  const filePath = path.resolve(process.cwd(), SAMPLE_PAYLOAD_CONFIG);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`[SamplePayloadLoader] Config file not found: ${filePath}`);
    console.error(`[SamplePayloadLoader] Create this file to control which fields are stored in payload.`);
    return new Map();
  }

  // Read Excel file
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Parse rows
  const rows = XLSX.utils.sheet_to_json<{
    Field_ID: number;
    Model_ID: number;
    Model_Name: string;
    Field_Name: string;
    Field_Label?: string;
    payload: number | boolean | null | undefined;
  }>(sheet);

  console.error(`[SamplePayloadLoader] Found ${rows.length} rows in ${SAMPLE_PAYLOAD_CONFIG}`);

  // Build config map
  const config = new Map<string, PayloadFieldConfig>();
  let payloadCount = 0;

  for (const row of rows) {
    // Skip rows with missing required fields
    if (!row.Model_Name || !row.Field_Name) {
      continue;
    }

    // Check if payload=1 (numeric 1, 1.0, or boolean true)
    const includeInPayload = row.payload === 1 || row.payload === true;

    const key = `${row.Model_Name}.${row.Field_Name}`;
    config.set(key, {
      field_id: row.Field_ID || 0,
      model_id: row.Model_ID || 0,
      model_name: row.Model_Name,
      field_name: row.Field_Name,
      include_in_payload: includeInPayload,
    });

    if (includeInPayload) {
      payloadCount++;
    }
  }

  console.error(`[SamplePayloadLoader] Loaded ${config.size} field configs (${payloadCount} with payload=1)`);

  // Cache results
  cache = config;

  return config;
}

/**
 * Get payload fields for a specific model
 *
 * Returns only fields where include_in_payload is true.
 *
 * @param modelName - Model name (e.g., "customer")
 * @returns Array of field names that should be in payload
 */
export function getSamplePayloadFieldNames(modelName: string): string[] {
  const config = loadSamplePayloadConfig();
  const fieldNames: string[] = [];

  for (const [key, value] of config.entries()) {
    if (value.model_name === modelName && value.include_in_payload) {
      fieldNames.push(value.field_name);
    }
  }

  return fieldNames;
}

/**
 * Check if a specific field should be included in payload
 *
 * @param modelName - Model name (e.g., "customer")
 * @param fieldName - Field name (e.g., "name")
 * @returns true if field should be in payload, false otherwise
 */
export function isFieldInPayload(modelName: string, fieldName: string): boolean {
  const config = loadSamplePayloadConfig();
  const key = `${modelName}.${fieldName}`;
  return config.get(key)?.include_in_payload === true;
}

/**
 * Clear the payload config cache
 *
 * Call this to force reload from Excel file on next access.
 */
export function clearSamplePayloadCache(): void {
  cache = null;
  console.error('[SamplePayloadLoader] Cache cleared');
}

/**
 * Get statistics about the payload configuration
 *
 * @returns Object with model count and field counts
 */
export function getSamplePayloadStats(): {
  totalFields: number;
  payloadFields: number;
  models: string[];
} {
  const config = loadSamplePayloadConfig();

  const models = new Set<string>();
  let payloadFields = 0;

  for (const value of config.values()) {
    models.add(value.model_name);
    if (value.include_in_payload) {
      payloadFields++;
    }
  }

  return {
    totalFields: config.size,
    payloadFields,
    models: Array.from(models).sort(),
  };
}
