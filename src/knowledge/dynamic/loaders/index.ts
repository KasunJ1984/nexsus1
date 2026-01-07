/**
 * Dynamic Knowledge Loaders - Index
 *
 * Exports all knowledge loaders for CLI commands.
 */

// Original knowledge sync (KPIs, Patterns, Reports)
export { syncKnowledgeCommand } from './knowledge-sync.js';

// Extended knowledge sync (Instance Config, Model Metadata, Field Knowledge)
export {
  syncExtendedKnowledgeCommand,
  createKnowledgePayloadIndexes,
  type ExtendedKnowledgeSyncOptions,
  type ExtendedKnowledgeSyncResult,
} from './extended-knowledge-sync.js';

// Excel knowledge loaders
export {
  loadInstanceConfig,
  loadModelMetadata,
  loadFieldKnowledge,
  loadAllKnowledge,
  validateCrossLevelConsistency,
  // Aggregation field detection (auto-detected from schema)
  getAggregationSafeFields,
  getAggregationSafeFieldsForModel,
  isFieldAggregationSafe,
  type AggregationFieldInfo,
} from './excel-knowledge-loader.js';

// Knowledge point builder
export {
  buildKnowledgeUuidV2,
  buildInstanceConfigUuid,
  buildModelMetadataUuid,
  buildFieldKnowledgeUuid,
  buildInstanceKnowledgePoints,
  buildModelKnowledgePoints,
  buildFieldKnowledgePoints,
} from './knowledge-point-builder.js';
