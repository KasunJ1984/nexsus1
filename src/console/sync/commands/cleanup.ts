/**
 * Cleanup Command
 *
 * Removes records from vector database that were deleted in Odoo.
 * Replaces the cleanup_deleted MCP tool.
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient } from '../../../common/services/vector-client.js';
import { getOdooClient } from '../../../common/services/odoo-client.js';
import { getModelIdFromSchema } from '../../../common/services/schema-query-service.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';

interface CleanupOptions {
  dryRun: boolean;
}

export async function cleanupCommand(
  modelName: string,
  options: CleanupOptions
): Promise<void> {
  const startTime = Date.now();

  console.log(chalk.bold('\n='.repeat(60)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - Cleanup Deleted Records'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  console.log(chalk.white('Model:'), chalk.yellow(modelName));
  if (options.dryRun) {
    console.log(chalk.bgYellow.black(' DRY RUN '), 'No data will be deleted');
  }
  console.log();

  // Initialize services
  const spinner = ora('Initializing services...').start();

  try {
    await initializeVectorClient();
    spinner.succeed('Services initialized');
  } catch (error) {
    spinner.fail(`Failed to initialize: ${error}`);
    process.exit(1);
  }

  // Get model ID from schema
  const modelId = await getModelIdFromSchema(modelName);
  if (!modelId) {
    console.log(chalk.red(`Model '${modelName}' not found in schema.`));
    process.exit(1);
  }

  const client = getQdrantClient();
  const odooClient = getOdooClient();

  // Get all record IDs from Qdrant for this model
  spinner.start('Fetching record IDs from Qdrant...');

  const qdrantIds: number[] = [];
  let offset: string | undefined = undefined;
  const BATCH_SIZE = 1000;

  while (true) {
    const result = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: BATCH_SIZE,
      offset,
      with_payload: { include: ['odoo_id'] },
      with_vector: false,
    });

    for (const point of result.points) {
      const odooId = point.payload?.odoo_id as number;
      if (odooId) {
        qdrantIds.push(odooId);
      }
    }

    if (result.points.length < BATCH_SIZE || !result.next_page_offset) {
      break;
    }
    offset = result.next_page_offset as string;
  }

  spinner.succeed(`Found ${qdrantIds.length.toLocaleString()} records in Qdrant`);

  if (qdrantIds.length === 0) {
    console.log(chalk.yellow('\nNo records to check.'));
    return;
  }

  // Check which IDs still exist in Odoo
  spinner.start('Checking which records still exist in Odoo...');

  const ODOO_BATCH = 500;
  const existingIds = new Set<number>();

  for (let i = 0; i < qdrantIds.length; i += ODOO_BATCH) {
    const batch = qdrantIds.slice(i, i + ODOO_BATCH);
    try {
      const existing = await odooClient.searchRead<{ id: number }>(
        modelName,
        [['id', 'in', batch]],
        ['id'],
        { limit: batch.length }
      );
      for (const record of existing) {
        existingIds.add(record.id);
      }
    } catch (error) {
      // Continue on error (some records might be archived)
    }
  }

  spinner.succeed(`Found ${existingIds.size.toLocaleString()} records still in Odoo`);

  // Find deleted IDs
  const deletedIds = qdrantIds.filter(id => !existingIds.has(id));

  console.log(chalk.white('\nDeleted records:'), chalk.red(deletedIds.length.toLocaleString()));

  if (deletedIds.length === 0) {
    console.log(chalk.green('\nNo stale records to clean up.'));
    return;
  }

  // Show sample of deleted IDs
  console.log(chalk.dim('Sample deleted IDs:'), deletedIds.slice(0, 10).join(', '));
  if (deletedIds.length > 10) {
    console.log(chalk.dim(`... and ${deletedIds.length - 10} more`));
  }

  if (options.dryRun) {
    console.log(chalk.bgYellow.black('\n DRY RUN COMPLETE '));
    console.log(`Would delete ${deletedIds.length} stale records.`);
    return;
  }

  // Delete stale records from Qdrant
  spinner.start(`Deleting ${deletedIds.length} stale records...`);

  // Build point IDs (V2 UUID format)
  const pointIds = deletedIds.map(recordId => {
    const modelIdStr = modelId.toString().padStart(4, '0');
    const recordIdStr = recordId.toString().padStart(12, '0');
    return `00000002-${modelIdStr}-0000-0000-${recordIdStr}`;
  });

  // Delete in batches
  const DELETE_BATCH = 100;
  let deleted = 0;

  for (let i = 0; i < pointIds.length; i += DELETE_BATCH) {
    const batch = pointIds.slice(i, i + DELETE_BATCH);
    await client.delete(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      points: batch,
    });
    deleted += batch.length;
  }

  spinner.succeed(`Deleted ${deleted} stale records`);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.bold('\n' + '='.repeat(60)));
  console.log(chalk.bold.green('CLEANUP COMPLETE'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();
  console.log(chalk.white('Duration:'), chalk.cyan(`${duration}s`));
  console.log(chalk.white('Records deleted:'), chalk.green(deleted.toLocaleString()));
  console.log();
}
