/**
 * Dynamic Knowledge Schema Template
 *
 * This file defines the Zod schema for a knowledge category that will be
 * stored in Qdrant and retrieved via semantic search at runtime.
 *
 * INSTRUCTIONS:
 * 1. Copy this file and rename (e.g., kpi-schema.ts)
 * 2. Define your schema with clear field descriptions
 * 3. Export the schema and types
 * 4. Add a loader in ../loaders/ to sync to Qdrant
 */

import { z } from 'zod';

/**
 * Example knowledge item schema
 */
export const ExampleKnowledgeSchema = z.object({
  // Unique identifier
  id: z.string().describe('Unique ID for this knowledge item'),

  // Human readable name
  name: z.string().describe('Display name'),

  // Detailed description (embedded for search)
  description: z.string().describe('Full description for semantic search'),

  // Category for filtering
  category: z.string().describe('Knowledge category'),

  // Additional metadata
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

/**
 * Type inference
 */
export type ExampleKnowledge = z.infer<typeof ExampleKnowledgeSchema>;

/**
 * Vector embedding format
 * This is what gets stored in Qdrant
 */
export interface KnowledgePoint {
  // Qdrant point ID (format: 00000004-KKKK-0000-0000-RRRRRRRRRRRR)
  point_id: string;

  // Category code (e.g., 0001 for KPI)
  category_code: string;

  // Original knowledge item ID
  item_id: string;

  // Text that was embedded
  embedded_text: string;

  // Full payload
  payload: ExampleKnowledge;
}
