/**
 * Sync Data Command
 *
 * CLI command to sync data from Excel files to Qdrant.
 *
 * Usage:
 *   npm run sync -- sync data customer
 *   npm run sync -- sync data customer --file samples/SAMPLE_customer_data.xlsx
 *   npm run sync -- sync data all
 *   npm run sync -- sync data customer --dry-run
 *   npm run sync -- sync data customer --skip-cascade
 */

import chalk from 'chalk';
import ora from 'ora';
import { initializeVectorClient, isVectorClientAvailable } from '../../../common/services/vector-client.js';
import { initializeEmbeddingService, isEmbeddingServiceAvailable } from '../../../common/services/embedding-service.js';
import { syncExcelData, syncAllExcelData } from '../../../common/services/excel-data-sync.js';

interface SyncDataOptions {
  file?: string;
  dryRun?: boolean;
  skipCascade?: boolean;
  force?: boolean;
}

/**
 * Sync data command handler
 */
export async function syncDataCommand(
  modelName: string,
  options: SyncDataOptions
): Promise<void> {
  const spinner = ora();

  console.log(chalk.blue('\n' + '='.repeat(60)));
  console.log(chalk.blue('NEXSUS SYNC - Excel Data Sync'));
  console.log(chalk.blue('='.repeat(60)));
  console.log('');

  console.log(`Model: ${chalk.bold(modelName)}`);
  if (options.file) {
    console.log(`File: ${options.file}`);
  }
  console.log(`Dry run: ${options.dryRun ? 'Yes' : 'No'}`);
  console.log(`Skip cascade: ${options.skipCascade ? 'Yes' : 'No'}`);
  console.log('');

  // Initialize services
  spinner.start('Initializing services...');

  try {
    await initializeVectorClient();

    if (!isVectorClientAvailable()) {
      spinner.fail('Qdrant client not available');
      process.exit(1);
    }

    // Initialize embedding service
    const embeddingInit = initializeEmbeddingService();
    if (!embeddingInit) {
      spinner.fail('Embedding service not available (check VOYAGE_API_KEY)');
      process.exit(1);
    }

    spinner.succeed('Services initialized');
  } catch (error) {
    spinner.fail(`Failed to initialize: ${error}`);
    process.exit(1);
  }

  console.log(chalk.gray('-'.repeat(60)));
  console.log(chalk.blue('Syncing Data...'));
  console.log(chalk.gray('-'.repeat(60)));
  console.log('');

  try {
    if (modelName === 'all') {
      // Sync all data files
      const results = await syncAllExcelData({
        dryRun: options.dryRun,
        skipCascade: true, // Each file synced independently
        force: options.force,
      });

      console.log('');
      console.log(chalk.blue('='.repeat(60)));
      console.log(chalk.blue('DATA SYNC COMPLETE - ALL MODELS'));
      console.log(chalk.blue('='.repeat(60)));
      console.log('');

      let totalSynced = 0;
      let totalFailed = 0;

      for (const result of results) {
        const status = result.success ? chalk.green('✓') : chalk.red('✗');
        console.log(`${status} ${result.model_name}: ${result.records_synced} synced, ${result.records_failed} failed`);
        totalSynced += result.records_synced;
        totalFailed += result.records_failed;
      }

      console.log('');
      console.log(`Total: ${totalSynced} synced, ${totalFailed} failed`);

    } else {
      // Sync single model
      const result = await syncExcelData(modelName, {
        filePath: options.file,
        dryRun: options.dryRun,
        skipCascade: options.skipCascade,
        force: options.force,
      });

      console.log('');
      console.log(chalk.blue('='.repeat(60)));
      console.log(chalk.blue('DATA SYNC COMPLETE'));
      console.log(chalk.blue('='.repeat(60)));
      console.log('');

      if (result.success) {
        console.log(chalk.green(`✓ ${result.model_name}: ${result.records_synced} records synced`));
      } else {
        console.log(chalk.red(`✗ ${result.model_name}: Failed`));
        for (const error of result.errors) {
          console.log(chalk.red(`  - ${error}`));
        }
      }

      if (result.cascaded_models && result.cascaded_models.length > 0) {
        console.log('');
        console.log('Cascaded models:');
        for (const cm of result.cascaded_models) {
          console.log(chalk.gray(`  - ${cm.model_name}: ${cm.records_synced} records`));
        }
      }

      console.log('');
      console.log(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);

      if (!result.success) {
        process.exit(1);
      }
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`\nError: ${errorMsg}`));
    process.exit(1);
  }
}
