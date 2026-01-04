/**
 * Dynamic Knowledge Loader Template
 *
 * This file loads knowledge from a source (JSON, YAML, Excel) and syncs
 * it to Qdrant as vector embeddings.
 *
 * INSTRUCTIONS:
 * 1. Copy this file and rename (e.g., kpi-loader.ts)
 * 2. Implement loadFromSource() to read your knowledge data
 * 3. Implement encodeForEmbedding() to create searchable text
 * 4. Register in the sync CLI command
 */

import type { ExampleKnowledge } from '../schemas/_template.js';

/**
 * Knowledge category code
 * Used in UUID format: 00000004-KKKK-0000-0000-RRRRRRRRRRRR
 */
export const CATEGORY_CODE = '0000'; // Replace with actual code

/**
 * Load knowledge items from source
 */
export async function loadFromSource(): Promise<ExampleKnowledge[]> {
  // TODO: Implement actual loading logic
  // Could read from:
  // - JSON file
  // - YAML file
  // - Excel spreadsheet
  // - API endpoint

  return [];
}

/**
 * Encode a knowledge item for vector embedding
 *
 * @param item - The knowledge item to encode
 * @returns Text string to be embedded
 */
export function encodeForEmbedding(item: ExampleKnowledge): string {
  // Combine relevant fields into searchable text
  const parts: string[] = [
    item.name,
    item.description,
    item.category,
  ];

  return parts.filter(Boolean).join(' | ');
}

/**
 * Build Qdrant point ID for a knowledge item
 *
 * @param itemId - The item's unique ID
 * @returns UUID in format 00000004-KKKK-0000-0000-RRRRRRRRRRRR
 */
export function buildPointId(itemId: string | number): string {
  const paddedId = String(itemId).padStart(12, '0');
  return `00000004-${CATEGORY_CODE}-0000-0000-${paddedId}`;
}
