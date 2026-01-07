/**
 * Extended Knowledge Sync
 *
 * CLI command to sync all knowledge levels from Excel to Qdrant.
 *
 * Syncs:
 * - Level 2: Instance Config (from Instance_Config sheet)
 * - Level 3: Model Metadata (from Model_Metadata sheet)
 * - Level 4: Field Knowledge (from Schema sheet columns L-Q)
 *
 * Usage:
 * ```bash
 * # Sync all knowledge from Excel
 * npm run sync -- sync knowledge --all
 *
 * # Sync specific levels
 * npm run sync -- sync knowledge --levels instance,model,field
 *
 * # Validate without syncing
 * npm run sync -- sync knowledge --validate-only
 *
 * # Force rebuild (delete existing first)
 * npm run sync -- sync knowledge --force --all
 * ```
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient } from '../../../common/services/vector-client.js';
import { embed, initializeEmbeddingService } from '../../../common/services/embedding-service.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';
import {
  loadInstanceConfig,
  loadModelMetadata,
  loadFieldKnowledge,
  loadAllKnowledge,
  validateCrossLevelConsistency,
} from './excel-knowledge-loader.js';
import {
  buildInstanceKnowledgePoints,
  buildModelKnowledgePoints,
  buildFieldKnowledgePoints,
  type KnowledgePointPreEmbed,
} from './knowledge-point-builder.js';
import type { InstanceConfigPayload, ModelMetadataPayload, FieldKnowledgePayload } from '../schemas/index.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ExtendedKnowledgeSyncOptions {
  /** Levels to sync: 'instance', 'model', 'field', or 'all' */
  levels: ('instance' | 'model' | 'field' | 'all')[];
  /** Validate only, don't sync */
  validateOnly?: boolean;
  /** Force delete existing knowledge before sync */
  force?: boolean;
  /** Path to Excel file (optional, defaults to NEXSUS_CONFIG.EXCEL_FILE) */
  excelPath?: string;
  /** Include all fields in Level 4, not just those with knowledge */
  includeAllFields?: boolean;
}

export interface SyncLevelResult {
  level: string;
  synced: number;
  skipped: number;
  errors: number;
  duration: number;
}

export interface ExtendedKnowledgeSyncResult {
  success: boolean;
  results: SyncLevelResult[];
  totalSynced: number;
  totalErrors: number;
  duration: number;
  validationErrors: string[];
  validationWarnings: string[];
}

// =============================================================================
// BATCH EMBEDDING
// =============================================================================

const EMBEDDING_BATCH_SIZE = 50;

/**
 * Embed points in batches using Voyage AI
 *
 * Returns Qdrant-compatible points with payload cast to Record<string, unknown>
 * to satisfy Qdrant client type requirements.
 */
async function embedPointsBatch(
  points: KnowledgePointPreEmbed[],
  spinner: ReturnType<typeof ora>
): Promise<Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>> {
  const embeddedPoints: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < points.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = points.slice(i, i + EMBEDDING_BATCH_SIZE);
    spinner.text = `Embedding ${i + 1}-${Math.min(i + EMBEDDING_BATCH_SIZE, points.length)} of ${points.length}...`;

    for (const point of batch) {
      const vector = await embed(point.text, 'document');
      if (vector) {
        embeddedPoints.push({
          id: point.id,
          vector,
          // Cast typed payload to Record<string, unknown> for Qdrant compatibility
          payload: point.payload as unknown as Record<string, unknown>,
        });
      }
    }
  }

  return embeddedPoints;
}

// =============================================================================
// SYNC FUNCTIONS
// =============================================================================

/**
 * Sync Level 2 (Instance Config) knowledge
 */
async function syncInstanceKnowledge(
  excelPath: string | undefined,
  options: { dryRun: boolean; force: boolean }
): Promise<SyncLevelResult> {
  const startTime = Date.now();
  const result: SyncLevelResult = {
    level: 'Instance Config (Level 2)',
    synced: 0,
    skipped: 0,
    errors: 0,
    duration: 0,
  };

  const spinner = ora('Loading Instance Config...').start();

  try {
    // Load from Excel
    const loadResult = loadInstanceConfig(excelPath);

    if (!loadResult.sheetFound) {
      spinner.info('Instance_Config sheet not found - skipping Level 2');
      result.skipped = 1;
      result.duration = Date.now() - startTime;
      return result;
    }

    if (loadResult.rows.length === 0) {
      spinner.info('No Instance Config rows found');
      result.duration = Date.now() - startTime;
      return result;
    }

    spinner.text = `Building ${loadResult.rows.length} Instance Config points...`;

    // Build points
    const points = buildInstanceKnowledgePoints(loadResult.rows);

    if (options.dryRun) {
      spinner.succeed(`Would sync ${points.length} Instance Config points (dry run)`);
      result.skipped = points.length;
      result.duration = Date.now() - startTime;
      return result;
    }

    // Embed and upsert
    const embeddedPoints = await embedPointsBatch(points, spinner);

    spinner.text = `Upserting ${embeddedPoints.length} Instance Config points to Qdrant...`;

    const client = getQdrantClient();
    await client.upsert(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      points: embeddedPoints,
    });

    spinner.succeed(`Synced ${embeddedPoints.length} Instance Config points`);
    result.synced = embeddedPoints.length;

  } catch (error) {
    spinner.fail(`Instance Config sync failed: ${error}`);
    result.errors = 1;
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Sync Level 3 (Model Metadata) knowledge
 */
async function syncModelKnowledge(
  excelPath: string | undefined,
  options: { dryRun: boolean; force: boolean }
): Promise<SyncLevelResult> {
  const startTime = Date.now();
  const result: SyncLevelResult = {
    level: 'Model Metadata (Level 3)',
    synced: 0,
    skipped: 0,
    errors: 0,
    duration: 0,
  };

  const spinner = ora('Loading Model Metadata...').start();

  try {
    // Load from Excel
    const loadResult = loadModelMetadata(excelPath);

    if (!loadResult.sheetFound) {
      spinner.info('Model_Metadata sheet not found - skipping Level 3');
      result.skipped = 1;
      result.duration = Date.now() - startTime;
      return result;
    }

    if (loadResult.rows.length === 0) {
      spinner.info('No Model Metadata rows found');
      result.duration = Date.now() - startTime;
      return result;
    }

    spinner.text = `Building ${loadResult.rows.length} Model Metadata points...`;

    // Build points
    const points = buildModelKnowledgePoints(loadResult.rows);

    if (options.dryRun) {
      spinner.succeed(`Would sync ${points.length} Model Metadata points (dry run)`);
      result.skipped = points.length;
      result.duration = Date.now() - startTime;
      return result;
    }

    // Embed and upsert
    const embeddedPoints = await embedPointsBatch(points, spinner);

    spinner.text = `Upserting ${embeddedPoints.length} Model Metadata points to Qdrant...`;

    const client = getQdrantClient();
    await client.upsert(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      points: embeddedPoints,
    });

    spinner.succeed(`Synced ${embeddedPoints.length} Model Metadata points`);
    result.synced = embeddedPoints.length;

  } catch (error) {
    spinner.fail(`Model Metadata sync failed: ${error}`);
    result.errors = 1;
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Sync Level 4 (Field Knowledge) knowledge
 */
async function syncFieldKnowledge(
  excelPath: string | undefined,
  options: { dryRun: boolean; force: boolean; includeAllFields: boolean }
): Promise<SyncLevelResult> {
  const startTime = Date.now();
  const result: SyncLevelResult = {
    level: 'Field Knowledge (Level 4)',
    synced: 0,
    skipped: 0,
    errors: 0,
    duration: 0,
  };

  const spinner = ora('Loading Field Knowledge...').start();

  try {
    // Load from Excel
    const loadResult = loadFieldKnowledge(excelPath);

    if (loadResult.rows.length === 0) {
      spinner.info('No schema rows found');
      result.duration = Date.now() - startTime;
      return result;
    }

    const fieldsWithKnowledge = loadResult.fieldsWithKnowledge;
    spinner.text = `Found ${fieldsWithKnowledge} fields with knowledge (of ${loadResult.totalFields} total)...`;

    // Build points
    const points = buildFieldKnowledgePoints(loadResult.rows, options.includeAllFields);

    if (points.length === 0) {
      spinner.info('No fields with knowledge defined - nothing to sync');
      result.duration = Date.now() - startTime;
      return result;
    }

    if (options.dryRun) {
      spinner.succeed(`Would sync ${points.length} Field Knowledge points (dry run)`);
      result.skipped = points.length;
      result.duration = Date.now() - startTime;
      return result;
    }

    // Embed and upsert
    const embeddedPoints = await embedPointsBatch(points, spinner);

    spinner.text = `Upserting ${embeddedPoints.length} Field Knowledge points to Qdrant...`;

    const client = getQdrantClient();
    await client.upsert(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      points: embeddedPoints,
    });

    spinner.succeed(`Synced ${embeddedPoints.length} Field Knowledge points`);
    result.synced = embeddedPoints.length;

  } catch (error) {
    spinner.fail(`Field Knowledge sync failed: ${error}`);
    result.errors = 1;
  }

  result.duration = Date.now() - startTime;
  return result;
}

// =============================================================================
// MAIN SYNC COMMAND
// =============================================================================

/**
 * Main extended knowledge sync command
 *
 * Syncs all knowledge levels from Excel to Qdrant.
 */
export async function syncExtendedKnowledgeCommand(
  options: ExtendedKnowledgeSyncOptions
): Promise<ExtendedKnowledgeSyncResult> {
  const startTime = Date.now();
  const results: SyncLevelResult[] = [];
  const validationErrors: string[] = [];
  const validationWarnings: string[] = [];

  // Determine which levels to sync
  const levels = options.levels.includes('all')
    ? ['instance', 'model', 'field']
    : options.levels;

  console.log(chalk.bold('\n' + '='.repeat(60)));
  console.log(chalk.bold.magenta('NEXSUS SYNC - Extended Knowledge Sync'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  console.log(chalk.white('Levels:'), chalk.cyan(levels.join(', ')));
  console.log(chalk.white('Validate only:'), options.validateOnly ? chalk.yellow('Yes') : chalk.green('No'));
  console.log(chalk.white('Force rebuild:'), options.force ? chalk.red('Yes') : chalk.green('No'));
  console.log();

  // Initialize services
  const initSpinner = ora('Initializing services...').start();

  try {
    await initializeVectorClient();
    const embeddingInit = initializeEmbeddingService();
    if (!embeddingInit) {
      initSpinner.fail('Failed to initialize embedding service. Check VOYAGE_API_KEY.');
      return {
        success: false,
        results: [],
        totalSynced: 0,
        totalErrors: 1,
        duration: Date.now() - startTime,
        validationErrors: ['Embedding service initialization failed'],
        validationWarnings: [],
      };
    }
    initSpinner.succeed('Services initialized');
  } catch (error) {
    initSpinner.fail(`Failed to initialize: ${error}`);
    return {
      success: false,
      results: [],
      totalSynced: 0,
      totalErrors: 1,
      duration: Date.now() - startTime,
      validationErrors: [`Initialization failed: ${error}`],
      validationWarnings: [],
    };
  }

  // Cross-level validation
  if (levels.length > 1 || options.validateOnly) {
    const validationSpinner = ora('Validating knowledge consistency...').start();

    const allKnowledge = loadAllKnowledge(options.excelPath);
    const crossValidation = validateCrossLevelConsistency(allKnowledge);

    validationErrors.push(...crossValidation.errors);
    validationWarnings.push(...crossValidation.warnings);

    if (crossValidation.errors.length > 0) {
      validationSpinner.warn(`Validation completed with ${crossValidation.errors.length} errors`);
      for (const error of crossValidation.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
    } else if (crossValidation.warnings.length > 0) {
      validationSpinner.warn(`Validation completed with ${crossValidation.warnings.length} warnings`);
      for (const warning of crossValidation.warnings) {
        console.log(chalk.yellow(`  - ${warning}`));
      }
    } else {
      validationSpinner.succeed('Cross-level validation passed');
    }

    // If validate-only, stop here
    if (options.validateOnly) {
      console.log(chalk.bold('\n' + '='.repeat(60)));
      console.log(chalk.bold.blue('Validation Complete (--validate-only mode)'));
      console.log(chalk.bold('='.repeat(60)));

      return {
        success: validationErrors.length === 0,
        results: [],
        totalSynced: 0,
        totalErrors: validationErrors.length,
        duration: Date.now() - startTime,
        validationErrors,
        validationWarnings,
      };
    }
  }

  // Delete existing knowledge if force
  if (options.force) {
    const deleteSpinner = ora('Deleting existing extended knowledge points...').start();

    try {
      const client = getQdrantClient();

      // Count existing extended knowledge points (00000005 namespace)
      const countResult = await client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'point_type', match: { value: 'knowledge' } },
            { key: 'knowledge_level', match: { any: ['instance', 'model', 'field'] } },
          ],
        },
        exact: true,
      });

      if (countResult.count > 0) {
        await client.delete(UNIFIED_CONFIG.COLLECTION_NAME, {
          wait: true,
          filter: {
            must: [
              { key: 'point_type', match: { value: 'knowledge' } },
              { key: 'knowledge_level', match: { any: ['instance', 'model', 'field'] } },
            ],
          },
        });
        deleteSpinner.succeed(`Deleted ${countResult.count} existing extended knowledge points`);
      } else {
        deleteSpinner.info('No existing extended knowledge points to delete');
      }
    } catch (error) {
      deleteSpinner.warn(`Failed to delete existing points: ${error}`);
    }
  }

  console.log(chalk.bold('\n' + '-'.repeat(60)));
  console.log(chalk.bold.magenta('Syncing Knowledge Levels...'));
  console.log(chalk.bold('-'.repeat(60) + '\n'));

  const dryRun = options.validateOnly ?? false;

  // Sync each level
  if (levels.includes('instance')) {
    const instanceResult = await syncInstanceKnowledge(options.excelPath, {
      dryRun,
      force: options.force ?? false,
    });
    results.push(instanceResult);
  }

  if (levels.includes('model')) {
    const modelResult = await syncModelKnowledge(options.excelPath, {
      dryRun,
      force: options.force ?? false,
    });
    results.push(modelResult);
  }

  if (levels.includes('field')) {
    const fieldResult = await syncFieldKnowledge(options.excelPath, {
      dryRun,
      force: options.force ?? false,
      includeAllFields: options.includeAllFields ?? false,
    });
    results.push(fieldResult);
  }

  // Summary
  console.log(chalk.bold('\n' + '='.repeat(60)));
  console.log(chalk.bold.green('Extended Knowledge Sync Complete'));
  console.log(chalk.bold('='.repeat(60) + '\n'));

  const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

  console.log(chalk.white('Summary:'));
  for (const r of results) {
    const duration = (r.duration / 1000).toFixed(1);
    console.log(
      chalk.gray(`  ${r.level}:`),
      chalk.green(`${r.synced} synced`),
      r.skipped > 0 ? chalk.yellow(`, ${r.skipped} skipped`) : '',
      r.errors > 0 ? chalk.red(`, ${r.errors} errors`) : '',
      chalk.gray(`(${duration}s)`)
    );
  }

  console.log();
  console.log(chalk.white('Total synced:'), chalk.green(totalSynced));
  if (totalSkipped > 0) console.log(chalk.white('Total skipped:'), chalk.yellow(totalSkipped));
  if (totalErrors > 0) console.log(chalk.white('Total errors:'), chalk.red(totalErrors));

  const duration = Date.now() - startTime;
  console.log(chalk.white('\nDuration:'), chalk.cyan(`${(duration / 1000).toFixed(1)}s`));
  console.log();

  return {
    success: totalErrors === 0,
    results,
    totalSynced,
    totalErrors,
    duration,
    validationErrors,
    validationWarnings,
  };
}

// =============================================================================
// CREATE PAYLOAD INDEXES
// =============================================================================

/**
 * Create payload indexes for knowledge points
 *
 * Creates indexes on:
 * - knowledge_level (for level filtering)
 * - config_key (for instance config lookup)
 * - model_name (for model/field lookup)
 */
export async function createKnowledgePayloadIndexes(): Promise<void> {
  const spinner = ora('Creating knowledge payload indexes...').start();

  try {
    const client = getQdrantClient();

    // Create indexes
    const indexes = [
      { name: 'knowledge_level', type: 'keyword' as const },
      { name: 'config_key', type: 'keyword' as const },
      { name: 'config_category', type: 'keyword' as const },
      { name: 'model_name', type: 'keyword' as const },
      { name: 'field_name', type: 'keyword' as const },
    ];

    for (const index of indexes) {
      try {
        await client.createPayloadIndex(UNIFIED_CONFIG.COLLECTION_NAME, {
          field_name: index.name,
          field_schema: index.type,
        });
        console.error(`  Created index: ${index.name}`);
      } catch (e) {
        // Index may already exist
        console.error(`  Index ${index.name} may already exist`);
      }
    }

    spinner.succeed('Knowledge payload indexes created');
  } catch (error) {
    spinner.fail(`Failed to create indexes: ${error}`);
  }
}
