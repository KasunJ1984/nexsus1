/**
 * Fix Orphans Command
 *
 * Scans a model for orphan FK references and syncs missing target records.
 * Orphan = FK reference (partner_id_qdrant) pointing to a record not in Qdrant.
 *
 * Algorithm:
 * 1. Scroll through source model records (e.g., account.move.line)
 * 2. Collect all *_qdrant FK UUIDs
 * 3. Check which UUIDs don't exist in Qdrant
 * 4. Extract model_id and record_id from missing UUIDs
 * 5. Group by target model
 * 6. Sync missing records from each target model
 * 7. Report results
 *
 * Usage:
 *   npm run sync -- fix-orphans account.move.line --dry-run
 *   npm run sync -- fix-orphans account.move.line --limit 5000
 *   npm run sync -- fix-orphans --all
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient } from '../../../common/services/vector-client.js';
import { initializeEmbeddingService } from '../../../common/services/embedding-service.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';
import { parseDataUuidV2, isValidDataUuidV2 } from '../../../common/utils/uuid-v2.js';
import { syncPipelineData } from '../../../common/services/pipeline-data-sync.js';
import { modelExistsInSchema } from '../../../common/services/schema-query-service.js';

// =============================================================================
// TYPES
// =============================================================================

interface FixOrphansOptions {
  dryRun: boolean;
  limit: string;
  all: boolean;
}

interface OrphansByModel {
  targetModel: string;
  targetModelId: number;
  recordIds: number[];
  sourceField: string;
}

interface FixOrphansResult {
  modelName: string;
  orphansFound: number;
  orphansSynced: number;
  orphansFailed: number;
  orphansSkipped: number;
  byTargetModel: Map<string, { found: number; synced: number; failed: number }>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const SCROLL_BATCH_SIZE = 1000;
const UUID_CHECK_BATCH_SIZE = 100;

// Model ID to name mapping (loaded dynamically)
let modelIdToName: Map<number, string> = new Map();

// =============================================================================
// MAIN COMMAND
// =============================================================================

export async function fixOrphansCommand(
  modelName: string | undefined,
  options: FixOrphansOptions
): Promise<void> {
  const startTime = Date.now();
  const syncLimit = parseInt(options.limit, 10) || 5000;

  console.log(chalk.bold('\n' + '='.repeat(70)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - Fix Orphan FK References'));
  console.log(chalk.dim('Detect and sync missing FK target records'));
  console.log(chalk.bold('='.repeat(70)));
  console.log();

  if (modelName) {
    console.log(chalk.white('Source Model:'), chalk.yellow(modelName));
  } else if (options.all) {
    console.log(chalk.white('Scope:'), chalk.cyan('All models'));
  } else {
    console.log(chalk.red('Error: Specify a model name or use --all'));
    process.exit(1);
  }

  if (options.dryRun) {
    console.log(chalk.bgBlue.white(' DRY RUN '), 'Will preview without syncing');
  }
  console.log(chalk.white('Sync limit per target:'), chalk.cyan(syncLimit.toString()));
  console.log();

  // Initialize services
  const spinner = ora('Initializing services...').start();

  try {
    await initializeVectorClient();
    const embeddingInit = initializeEmbeddingService();
    if (!embeddingInit) {
      spinner.fail('Failed to initialize embedding service. Check VOYAGE_API_KEY.');
      process.exit(1);
    }
    spinner.succeed('Services initialized');
  } catch (error) {
    spinner.fail(`Failed to initialize: ${error}`);
    process.exit(1);
  }

  const client = getQdrantClient();

  // Step 1: Discover models in collection
  spinner.start('Discovering models in collection...');

  const models = await discoverModels(client);
  spinner.succeed(`Found ${models.size} models`);

  // Build model ID to name mapping
  modelIdToName = new Map();
  for (const [name, info] of models) {
    modelIdToName.set(info.model_id, name);
  }

  // Filter to specific model or all
  const modelsToCheck = modelName
    ? new Map([...models].filter(([name]) => name === modelName))
    : options.all
      ? models
      : new Map();

  if (modelName && modelsToCheck.size === 0) {
    console.log(chalk.red(`Model '${modelName}' not found in collection.`));
    process.exit(1);
  }

  // Step 2: Find orphans for each model
  console.log(chalk.bold('\n' + '-'.repeat(70)));
  console.log(chalk.bold.cyan('Scanning for orphan FK references...'));
  console.log(chalk.bold('-'.repeat(70) + '\n'));

  const allOrphans: OrphansByModel[] = [];
  const results: FixOrphansResult[] = [];

  for (const [sourceModel, info] of modelsToCheck) {
    spinner.start(`Scanning ${sourceModel}...`);

    const orphans = await findOrphansForModel(client, sourceModel, info.model_id);

    if (orphans.length > 0) {
      const totalOrphans = orphans.reduce((sum, o) => sum + o.recordIds.length, 0);
      spinner.succeed(`${sourceModel}: Found ${totalOrphans} orphan references across ${orphans.length} target models`);
      allOrphans.push(...orphans);
    } else {
      spinner.succeed(`${sourceModel}: No orphans found`);
    }
  }

  // Consolidate orphans by target model
  const consolidatedOrphans = consolidateOrphans(allOrphans);

  // Step 3: Summary before sync
  console.log(chalk.bold('\n' + '-'.repeat(70)));
  console.log(chalk.bold.cyan('Orphan Summary'));
  console.log(chalk.bold('-'.repeat(70) + '\n'));

  let totalOrphanCount = 0;
  for (const [targetModel, orphan] of consolidatedOrphans) {
    const count = orphan.recordIds.length;
    totalOrphanCount += count;
    console.log(chalk.white(`  ${targetModel}:`), chalk.yellow(`${count} missing records`));
  }

  if (totalOrphanCount === 0) {
    console.log(chalk.bgGreen.black(' ALL FK REFERENCES VALID '));
    console.log(chalk.dim('No orphan FK references found.'));
    console.log();
    return;
  }

  console.log(chalk.bold('\n  Total:'), chalk.yellow(`${totalOrphanCount} orphan references`));

  // Step 4: Sync missing records (if not dry run)
  if (options.dryRun) {
    console.log(chalk.bold('\n' + '-'.repeat(70)));
    console.log(chalk.bgBlue.white(' DRY RUN COMPLETE '));
    console.log(chalk.dim('Run without --dry-run to sync missing records.'));
  } else {
    console.log(chalk.bold('\n' + '-'.repeat(70)));
    console.log(chalk.bold.cyan('Syncing missing records...'));
    console.log(chalk.bold('-'.repeat(70) + '\n'));

    for (const [targetModel, orphan] of consolidatedOrphans) {
      const recordsToSync = orphan.recordIds.slice(0, syncLimit);
      const skipped = orphan.recordIds.length - recordsToSync.length;

      spinner.start(`Syncing ${recordsToSync.length} missing ${targetModel} records...`);

      try {
        // Check if model exists in schema
        const exists = await modelExistsInSchema(targetModel);
        if (!exists) {
          spinner.warn(`${targetModel}: Not in schema, skipping`);
          results.push({
            modelName: targetModel,
            orphansFound: orphan.recordIds.length,
            orphansSynced: 0,
            orphansFailed: 0,
            orphansSkipped: orphan.recordIds.length,
            byTargetModel: new Map(),
          });
          continue;
        }

        // Sync the missing records
        const syncResult = await syncPipelineData(targetModel, {
          skipExisting: false,  // We want to sync these specific records
          specificIds: recordsToSync,
          updateGraph: true,
        });

        const synced = syncResult.records_uploaded;
        const failed = recordsToSync.length - synced;

        spinner.succeed(
          `${targetModel}: Synced ${synced}/${recordsToSync.length}` +
          (skipped > 0 ? chalk.dim(` (${skipped} skipped due to limit)`) : '') +
          (failed > 0 ? chalk.red(` (${failed} failed)`) : '')
        );

        results.push({
          modelName: targetModel,
          orphansFound: orphan.recordIds.length,
          orphansSynced: synced,
          orphansFailed: failed,
          orphansSkipped: skipped,
          byTargetModel: new Map(),
        });
      } catch (error) {
        spinner.fail(`${targetModel}: Sync failed - ${error}`);
        results.push({
          modelName: targetModel,
          orphansFound: orphan.recordIds.length,
          orphansSynced: 0,
          orphansFailed: orphan.recordIds.length,
          orphansSkipped: 0,
          byTargetModel: new Map(),
        });
      }
    }
  }

  // Step 5: Final summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.bold('\n' + '='.repeat(70)));
  console.log(chalk.bold.cyan('FIX ORPHANS SUMMARY'));
  console.log(chalk.bold('='.repeat(70)));
  console.log();

  const totalFound = results.reduce((sum, r) => sum + r.orphansFound, 0) || totalOrphanCount;
  const totalSynced = results.reduce((sum, r) => sum + r.orphansSynced, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.orphansFailed, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.orphansSkipped, 0);

  console.log(chalk.white('Orphans found:'), chalk.yellow(totalFound.toLocaleString()));
  if (!options.dryRun) {
    console.log(chalk.white('Orphans synced:'), chalk.green(totalSynced.toLocaleString()));
    if (totalFailed > 0) {
      console.log(chalk.white('Orphans failed:'), chalk.red(totalFailed.toLocaleString()));
    }
    if (totalSkipped > 0) {
      console.log(chalk.white('Orphans skipped:'), chalk.dim(totalSkipped.toLocaleString()));
    }
  }
  console.log(chalk.white('Duration:'), chalk.cyan(`${duration}s`));
  console.log();

  if (!options.dryRun && totalSynced > 0) {
    console.log(chalk.bgGreen.black(' ORPHANS FIXED '));
    console.log(chalk.dim('Re-run queries with link parameter - names should now resolve.'));
  }

  console.log();
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Discover all models in the collection
 */
async function discoverModels(
  client: ReturnType<typeof getQdrantClient>
): Promise<Map<string, { model_id: number; count: number }>> {
  const models = new Map<string, { model_id: number; count: number }>();
  let offset: string | undefined = undefined;

  while (true) {
    const result = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'data' } }],
      },
      limit: SCROLL_BATCH_SIZE,
      offset,
      with_payload: { include: ['model_name', 'model_id'] },
      with_vector: false,
    });

    for (const point of result.points) {
      const modelName = point.payload?.model_name as string;
      const modelId = point.payload?.model_id as number;
      if (modelName) {
        const existing = models.get(modelName);
        if (existing) {
          existing.count++;
        } else {
          models.set(modelName, { model_id: modelId || 0, count: 1 });
        }
      }
    }

    if (result.points.length < SCROLL_BATCH_SIZE || !result.next_page_offset) {
      break;
    }
    offset = result.next_page_offset as string;
  }

  return models;
}

/**
 * Find orphan FK references for a model
 */
async function findOrphansForModel(
  client: ReturnType<typeof getQdrantClient>,
  modelName: string,
  modelId: number
): Promise<OrphansByModel[]> {
  // Collect all FK Qdrant UUIDs from this model
  const fkUuidsByField = new Map<string, Set<string>>();
  let offset: string | undefined = undefined;

  while (true) {
    const result = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: SCROLL_BATCH_SIZE,
      offset,
      with_payload: true,
      with_vector: false,
    });

    for (const point of result.points) {
      const payload = point.payload || {};

      // Find all *_qdrant fields
      for (const [key, value] of Object.entries(payload)) {
        if (key.endsWith('_qdrant') && value) {
          // Handle single UUID or array of UUIDs
          const uuids = Array.isArray(value) ? value : [value];
          for (const uuid of uuids) {
            if (typeof uuid === 'string' && isValidDataUuidV2(uuid)) {
              const fieldName = key.replace('_qdrant', '');
              if (!fkUuidsByField.has(fieldName)) {
                fkUuidsByField.set(fieldName, new Set());
              }
              fkUuidsByField.get(fieldName)!.add(uuid);
            }
          }
        }
      }
    }

    if (result.points.length < SCROLL_BATCH_SIZE || !result.next_page_offset) {
      break;
    }
    offset = result.next_page_offset as string;
  }

  // Check which UUIDs don't exist in Qdrant
  const orphansByField = new Map<string, OrphansByModel>();

  for (const [fieldName, uuids] of fkUuidsByField) {
    const uuidArray = Array.from(uuids);
    const missingUuids = await findMissingUuids(client, uuidArray);

    if (missingUuids.length > 0) {
      // Group missing UUIDs by target model
      const byTargetModel = new Map<number, number[]>();

      for (const uuid of missingUuids) {
        const parsed = parseDataUuidV2(uuid);
        if (parsed) {
          const targetModelId = parsed.modelId;
          if (!byTargetModel.has(targetModelId)) {
            byTargetModel.set(targetModelId, []);
          }
          byTargetModel.get(targetModelId)!.push(parsed.recordId);
        }
      }

      // Convert to OrphansByModel
      for (const [targetModelId, recordIds] of byTargetModel) {
        const targetModelName = modelIdToName.get(targetModelId) || `model_id:${targetModelId}`;
        const key = `${fieldName}:${targetModelName}`;

        if (!orphansByField.has(key)) {
          orphansByField.set(key, {
            targetModel: targetModelName,
            targetModelId,
            recordIds: [],
            sourceField: fieldName,
          });
        }
        orphansByField.get(key)!.recordIds.push(...recordIds);
      }
    }
  }

  return Array.from(orphansByField.values());
}

/**
 * Check which UUIDs don't exist in Qdrant
 */
async function findMissingUuids(
  client: ReturnType<typeof getQdrantClient>,
  uuids: string[]
): Promise<string[]> {
  const missing: string[] = [];
  const existing = new Set<string>();

  // Check in batches
  for (let i = 0; i < uuids.length; i += UUID_CHECK_BATCH_SIZE) {
    const batch = uuids.slice(i, i + UUID_CHECK_BATCH_SIZE);

    try {
      const points = await client.retrieve(UNIFIED_CONFIG.COLLECTION_NAME, {
        ids: batch,
        with_payload: false,
        with_vector: false,
      });

      for (const point of points) {
        existing.add(point.id as string);
      }
    } catch {
      // If batch fails, individual UUIDs might not exist
      // Continue anyway
    }
  }

  // Find which UUIDs are missing
  for (const uuid of uuids) {
    if (!existing.has(uuid)) {
      missing.push(uuid);
    }
  }

  return missing;
}

/**
 * Consolidate orphans by target model (merge duplicates)
 */
function consolidateOrphans(
  orphans: OrphansByModel[]
): Map<string, OrphansByModel> {
  const consolidated = new Map<string, OrphansByModel>();

  for (const orphan of orphans) {
    if (consolidated.has(orphan.targetModel)) {
      const existing = consolidated.get(orphan.targetModel)!;
      // Merge record IDs (dedupe)
      const mergedIds = new Set([...existing.recordIds, ...orphan.recordIds]);
      existing.recordIds = Array.from(mergedIds);
    } else {
      consolidated.set(orphan.targetModel, {
        ...orphan,
        recordIds: [...new Set(orphan.recordIds)],  // Dedupe
      });
    }
  }

  return consolidated;
}

// =============================================================================
// REUSABLE SYNC FUNCTION (for validate-fk --auto-sync)
// =============================================================================

/**
 * Sync result from orphan auto-sync
 */
export interface SyncOrphansResult {
  synced: number;
  failed: number;
  skipped: number;
  byTargetModel: Map<string, { synced: number; failed: number; skipped: number }>;
}

/**
 * Sync missing FK targets from orphan info
 *
 * Reusable function called by validate-fk --auto-sync.
 * Groups orphans by target model and syncs missing records.
 *
 * @param orphanDetails - Array of OrphanInfo from validate-fk
 * @param options - Sync options (limit per model)
 * @returns Sync result with counts
 */
export async function syncMissingOrphans(
  orphanDetails: Array<{
    missing_target_model: string;
    missing_target_id: number;
  }>,
  options: { limit?: number } = {}
): Promise<SyncOrphansResult> {
  const limit = options.limit ?? 5000;

  // Group orphans by target model
  const byTargetModel = new Map<string, Set<number>>();
  for (const orphan of orphanDetails) {
    if (!byTargetModel.has(orphan.missing_target_model)) {
      byTargetModel.set(orphan.missing_target_model, new Set());
    }
    byTargetModel.get(orphan.missing_target_model)!.add(orphan.missing_target_id);
  }

  // Initialize result
  const result: SyncOrphansResult = {
    synced: 0,
    failed: 0,
    skipped: 0,
    byTargetModel: new Map(),
  };

  // Sync each target model
  for (const [targetModel, recordIdSet] of byTargetModel) {
    const recordIds = Array.from(recordIdSet).slice(0, limit);
    const modelResult = { synced: 0, failed: 0, skipped: 0 };

    // Check if model exists in schema
    const exists = await modelExistsInSchema(targetModel);
    if (!exists) {
      console.error(chalk.yellow(`  [AutoSync] ${targetModel}: Not in schema, skipping ${recordIds.length} records`));
      modelResult.skipped = recordIds.length;
      result.skipped += recordIds.length;
      result.byTargetModel.set(targetModel, modelResult);
      continue;
    }

    console.error(chalk.dim(`  [AutoSync] Syncing ${recordIds.length} missing ${targetModel} records...`));

    try {
      // Sync the missing records
      const syncResult = await syncPipelineData(targetModel, {
        skipExisting: false,
        specificIds: recordIds,
        updateGraph: true,
      });

      modelResult.synced = syncResult.records_uploaded;
      modelResult.failed = recordIds.length - syncResult.records_uploaded;
      result.synced += modelResult.synced;
      result.failed += modelResult.failed;

      if (modelResult.synced > 0) {
        console.error(chalk.green(`  [AutoSync] ${targetModel}: Synced ${modelResult.synced} records`));
      }
      if (modelResult.failed > 0) {
        console.error(chalk.red(`  [AutoSync] ${targetModel}: Failed ${modelResult.failed} records`));
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`  [AutoSync] ${targetModel}: Error - ${errorMsg}`));
      modelResult.failed = recordIds.length;
      result.failed += recordIds.length;
    }

    result.byTargetModel.set(targetModel, modelResult);
  }

  return result;
}
