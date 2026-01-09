/**
 * Sync Schema Command
 *
 * Syncs schema to vector database from Excel or Odoo.
 * Replaces the schema_sync MCP tool.
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient } from '../../../common/services/vector-client.js';
import { initializeEmbeddingService } from '../../../common/services/embedding-service.js';
import { syncSchemaToUnified } from '../../../common/services/unified-schema-sync.js';
import { clearSchemaCache } from '../../../common/services/schema-query-service.js';
import { clearSchemaLookup } from '../../../common/services/schema-lookup.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';

interface SyncSchemaOptions {
  source: 'excel' | 'odoo';
  force: boolean;
}

export async function syncSchemaCommand(options: SyncSchemaOptions): Promise<void> {
  const startTime = Date.now();

  console.log(chalk.bold('\n='.repeat(60)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - Schema Sync'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  console.log(chalk.white('Source:'), chalk.yellow(options.source));
  console.log(chalk.white('Force recreate:'), options.force ? chalk.red('Yes') : chalk.green('No'));
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

  // Get current schema count (handle collection not existing yet)
  const client = getQdrantClient();
  let beforeCount = { count: 0 };
  try {
    beforeCount = await client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'schema' } }],
      },
      exact: true,
    });
    console.log(chalk.white('Current schema points:'), chalk.cyan(beforeCount.count.toLocaleString()));
  } catch (error: any) {
    // Collection doesn't exist yet - that's okay, it will be created
    if (error.status === 404) {
      console.log(chalk.white('Current schema points:'), chalk.cyan('0 (collection will be created)'));
    } else {
      throw error; // Re-throw if it's a different error
    }
  }

  // Delete existing schema if force
  if (options.force && beforeCount.count > 0) {
    spinner.start('Deleting existing schema points...');
    await client.delete(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      filter: {
        must: [{ key: 'point_type', match: { value: 'schema' } }],
      },
    });
    spinner.succeed(`Deleted ${beforeCount.count} existing schema points`);
  }

  // Run schema sync
  console.log(chalk.bold('\n' + '-'.repeat(60)));
  console.log(chalk.bold.cyan('Syncing Schema...'));
  console.log(chalk.bold('-'.repeat(60) + '\n'));
  console.log(chalk.dim('Supported formats: V2 (3-column) or Simple (11-column) - auto-detected'));
  console.log(chalk.dim('  • V2: Qdrant ID, Vector, Payload'));
  console.log(chalk.dim('  • Simple: Field_ID, Model_ID, Field_Name, Field_Label, ...'));
  console.log('');

  try {
    if (options.source === 'excel') {
      // Use unified schema sync (from Excel)
      console.log(chalk.dim('Calling syncSchemaToUnified()...'));
      const result = await syncSchemaToUnified();

      if (!result.success) {
        console.log(chalk.red('\n❌ Schema sync failed!'));
        if (result.errors && result.errors.length > 0) {
          console.log(chalk.red('Errors:'));
          result.errors.forEach(err => console.log(chalk.red(`  - ${err}`)));
        }
        process.exit(1);
      }

      console.log(chalk.green(`✅ Synced ${result.uploaded} schema rows successfully`));

      // G13: Auto-clear schema cache so pipeline uses fresh schema
      clearSchemaCache();
      clearSchemaLookup();
      console.log(chalk.green('All schema caches cleared - pipeline will use fresh schema'));
    } else {
      // Odoo source - use schema-sync service
      // Note: This would need to be implemented or imported
      console.log(chalk.yellow('Odoo schema sync not yet implemented in CLI.'));
      console.log(chalk.dim('Use Excel source for now: --source excel'));
      process.exit(1);
    }

    // Get final count (handle collection not existing - means sync failed)
    let afterCount = { count: 0 };
    try {
      afterCount = await client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
        filter: {
          must: [{ key: 'point_type', match: { value: 'schema' } }],
        },
        exact: true,
      });
    } catch (error: any) {
      if (error.status === 404) {
        console.log(chalk.red('\n❌ Collection was not created during sync. Sync may have failed.'));
        afterCount = { count: 0 };
      } else {
        throw error;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Display results
    console.log(chalk.bold('\n' + '='.repeat(60)));
    console.log(chalk.bold.green('SCHEMA SYNC COMPLETE'));
    console.log(chalk.bold('='.repeat(60)));
    console.log();

    console.log(chalk.white('Duration:'), chalk.cyan(`${duration}s`));
    console.log(chalk.white('Schema points:'), chalk.cyan(`${beforeCount.count} → ${afterCount.count}`));
    console.log(chalk.white('Net change:'), afterCount.count > beforeCount.count
      ? chalk.green(`+${(afterCount.count - beforeCount.count).toLocaleString()}`)
      : chalk.yellow((afterCount.count - beforeCount.count).toLocaleString()));
    console.log();

  } catch (error) {
    console.error(chalk.red('\nSchema sync failed:'), error);
    process.exit(1);
  }
}
