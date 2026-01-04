/**
 * Sync Model Command
 *
 * Syncs a model to vector database with FK cascade.
 * Replaces the pipeline_sync MCP tool.
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient, createDynamicPayloadIndexes } from '../../../common/services/vector-client.js';
import { initializeEmbeddingService } from '../../../common/services/embedding-service.js';
import { syncWithCascade, formatCascadeResult } from '../../../common/services/cascade-sync.js';
import { modelExistsInSchema, getPayloadFieldsFromSchema } from '../../../common/services/schema-query-service.js';
import { clearPipelineSyncMetadata } from '../../../common/services/pipeline-data-sync.js';
import { registerIndexedFields } from '../../../common/services/schema-lookup.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';

interface SyncModelOptions {
  dateFrom?: string;
  dateTo?: string;
  skipExisting: boolean;
  dryRun: boolean;
  cascade: boolean;
  batchSize: string;
  force: boolean;
}

export async function syncModelCommand(
  modelName: string,
  options: SyncModelOptions
): Promise<void> {
  const startTime = Date.now();

  console.log(chalk.bold('\n='.repeat(60)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - Model Sync'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  console.log(chalk.white('Model:'), chalk.yellow(modelName));
  console.log(chalk.white('Skip Existing:'), options.skipExisting ? chalk.green('Yes') : chalk.red('No'));
  console.log(chalk.white('FK Cascade:'), options.cascade ? chalk.green('Enabled') : chalk.yellow('Disabled'));
  if (options.force) {
    console.log(chalk.white('Force Full Sync:'), chalk.red('Yes - will re-fetch all records from Odoo'));
  }
  if (options.dateFrom || options.dateTo) {
    console.log(chalk.white('Date Range:'), chalk.cyan(`${options.dateFrom || 'any'} to ${options.dateTo || 'any'}`));
  }
  if (options.dryRun) {
    console.log(chalk.bgYellow.black(' DRY RUN '), 'No data will be modified');
  }
  console.log();

  // If force mode, clear sync metadata to force full sync
  if (options.force) {
    console.log(chalk.yellow('Force mode: Clearing sync metadata for'), chalk.cyan(modelName));
    clearPipelineSyncMetadata(modelName);
    console.log(chalk.dim('Sync will re-fetch all records from Odoo\n'));
  }

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

  // Verify model exists in schema
  spinner.start(`Checking schema for ${modelName}...`);
  const modelExists = await modelExistsInSchema(modelName);
  if (!modelExists) {
    spinner.fail(`Model '${modelName}' not found in schema. Run 'nexsus-sync sync schema' first.`);
    process.exit(1);
  }
  spinner.succeed(`Model '${modelName}' found in schema`);

  // Get current count
  const client = getQdrantClient();
  const beforeCount = await client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
    filter: {
      must: [
        { key: 'point_type', match: { value: 'data' } },
        { key: 'model_name', match: { value: modelName } },
      ],
    },
    exact: true,
  });
  console.log(chalk.white('\nCurrent records in Qdrant:'), chalk.cyan(beforeCount.count.toLocaleString()));

  if (options.dryRun) {
    console.log(chalk.bgYellow.black('\n DRY RUN COMPLETE '));
    console.log('Would sync model:', modelName);
    console.log('With options:', JSON.stringify(options, null, 2));
    return;
  }

  // Run sync
  console.log(chalk.bold('\n' + '-'.repeat(60)));
  console.log(chalk.bold.cyan('Starting Sync...'));
  console.log(chalk.dim('This may take several minutes for large models.'));
  console.log(chalk.bold('-'.repeat(60) + '\n'));

  try {
    const result = await syncWithCascade(modelName, {
      skipExisting: options.skipExisting,
      parallelTargets: 3,
      dryRun: false,
      updateGraph: options.cascade,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      includeArchived: true,
    });

    // Get final count
    const afterCount = await client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      exact: true,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Display results
    console.log(chalk.bold('\n' + '='.repeat(60)));
    console.log(chalk.bold.green('SYNC COMPLETE'));
    console.log(chalk.bold('='.repeat(60)));
    console.log();

    console.log(chalk.white('Duration:'), chalk.cyan(`${duration}s`));
    console.log(chalk.white('Primary records synced:'), chalk.green(result.primaryModel.records_synced.toLocaleString()));

    if (options.cascade && result.cascadedModels.length > 0) {
      console.log(chalk.white('Cascaded models:'), chalk.green(result.cascadedModels.length.toString()));
      const totalCascaded = result.cascadedModels.reduce((sum, m) => sum + m.records_synced, 0);
      console.log(chalk.white('Cascaded records:'), chalk.green(totalCascaded.toLocaleString()));
    }

    console.log(chalk.white(`\n${modelName} count:`), chalk.cyan(`${beforeCount.count} → ${afterCount.count}`));
    console.log(chalk.white('Net change:'), afterCount.count > beforeCount.count
      ? chalk.green(`+${(afterCount.count - beforeCount.count).toLocaleString()}`)
      : chalk.yellow((afterCount.count - beforeCount.count).toLocaleString()));

    if (result.graph.relationships_discovered > 0 || result.graph.relationships_updated > 0) {
      console.log(chalk.white('\nGraph updates:'));
      console.log(chalk.dim(`  Discovered: ${result.graph.relationships_discovered}`));
      console.log(chalk.dim(`  Updated: ${result.graph.relationships_updated}`));
    }

    if (result.cycles.detected > 0) {
      console.log(chalk.white('\nCycle detection:'));
      console.log(chalk.dim(`  Cycles detected: ${result.cycles.detected}`));
      console.log(chalk.dim(`  Records visited: ${result.cycles.records_visited}`));
    }

    // Phase: Create indexes for all synced models
    console.log(chalk.bold('\nCreating indexes for payload fields...'));
    
    // Collect all synced models (primary + cascaded)
    const modelsToIndex = [modelName];
    if (options.cascade && result.cascadedModels.length > 0) {
      for (const cm of result.cascadedModels) {
        if (cm.records_synced > 0 && !modelsToIndex.includes(cm.model_name)) {
          modelsToIndex.push(cm.model_name);
        }
      }
    }

    let totalIndexesCreated = 0;
    let totalIndexesSkipped = 0;
    const indexErrors: string[] = [];

    for (const model of modelsToIndex) {
      try {
        const payloadFields = await getPayloadFieldsFromSchema(model);
        if (payloadFields.length === 0) continue;

        const fieldsToIndex = payloadFields.map(f => ({
          field_name: f.field_name,
          field_type: f.field_type,
        }));

        const indexResult = await createDynamicPayloadIndexes(model, fieldsToIndex);
        totalIndexesCreated += indexResult.created;
        totalIndexesSkipped += indexResult.skipped;
        indexErrors.push(...indexResult.errors);

        // Register fields for immediate filtering
        const indexedFieldNames: string[] = [];
        for (const f of payloadFields) {
          indexedFieldNames.push(f.field_name);
          if (f.field_type === 'many2one') {
            indexedFieldNames.push(`${f.field_name}_id`);
            indexedFieldNames.push(`${f.field_name}_qdrant`);
          }
        }
        registerIndexedFields(indexedFieldNames);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        indexErrors.push(`${model}: ${errMsg}`);
      }
    }

    // Show indexing summary
    console.log(chalk.bold('\nIndexing:'));
    console.log(chalk.white('  Models indexed:'), chalk.cyan(modelsToIndex.length.toString()));
    console.log(chalk.white('  Indexes created:'), chalk.green(totalIndexesCreated.toString()));
    console.log(chalk.white('  Indexes skipped:'), chalk.dim(`${totalIndexesSkipped} (already exist)`));
    if (indexErrors.length > 0) {
      console.log(chalk.white('  Index errors:'), chalk.red(indexErrors.length.toString()));
      for (const err of indexErrors.slice(0, 3)) {
        console.log(chalk.dim(`    - ${err}`));
      }
      if (indexErrors.length > 3) {
        console.log(chalk.dim(`    ... and ${indexErrors.length - 3} more`));
      }
    }

    console.log();

  } catch (error) {
    console.error(chalk.red('\nSync failed:'), error);
    process.exit(1);
  }
}
