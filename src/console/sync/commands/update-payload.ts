/**
 * Update Payload Command
 *
 * Updates payload fields for all records of a model WITHOUT re-embedding.
 * Use after changing feilds_to_add_payload.xlsx to update existing records
 * with new payload field configuration.
 *
 * What this does:
 * - Reads new payload config from Excel
 * - Fetches ONLY the payload fields from Odoo
 * - Updates payload in Qdrant using setPayload API (keeps existing vectors!)
 *
 * What this does NOT do:
 * - Does NOT re-sync data (no new records)
 * - Does NOT re-generate embeddings (keeps existing vectors)
 * - Does NOT call Voyage AI (no embedding API calls = $0 cost)
 *
 * Performance: ~30 seconds for 1000 records (vs ~5 minutes for full re-sync)
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient, createDynamicPayloadIndexes } from '../../../common/services/vector-client.js';
import { getOdooClient } from '../../../common/services/odoo-client.js';
import {
  getPayloadFieldsFromSchema,
  clearSchemaCache,
  getModelIdFromSchema,
} from '../../../common/services/schema-query-service.js';
import { registerIndexedFields } from '../../../common/services/schema-lookup.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';

interface UpdatePayloadOptions {
  dryRun: boolean;
  batchSize: string;
}

export async function updatePayloadCommand(
  modelName: string,
  options: UpdatePayloadOptions
): Promise<void> {
  const startTime = Date.now();
  const batchSize = parseInt(options.batchSize, 10) || 100;

  console.log(chalk.bold('\n' + '='.repeat(60)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - Update Payload Fields'));
  console.log(chalk.dim('Updates payload without re-embedding (keeps vectors)'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  console.log(chalk.white('Model:'), chalk.yellow(modelName));
  console.log(chalk.white('Batch Size:'), chalk.cyan(batchSize.toString()));
  if (options.dryRun) {
    console.log(chalk.bgYellow.black(' DRY RUN '), 'No data will be updated');
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

  // Clear cache and get payload fields
  clearSchemaCache();
  spinner.start('Loading payload field configuration...');

  const payloadFields = await getPayloadFieldsFromSchema(modelName);
  if (payloadFields.length === 0) {
    spinner.fail(`No payload fields configured for model '${modelName}'`);
    console.log(chalk.dim('Check feilds_to_add_payload.xlsx to configure payload fields.'));
    process.exit(1);
  }

  spinner.succeed(`Loaded ${payloadFields.length} payload fields`);
  console.log(chalk.dim('Fields:'), chalk.dim(payloadFields.map(f => f.field_name).slice(0, 10).join(', ')));
  if (payloadFields.length > 10) {
    console.log(chalk.dim(`... and ${payloadFields.length - 10} more`));
  }
  console.log();

  const client = getQdrantClient();
  const odooClient = getOdooClient();
  const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

  // Phase 1: Scan existing records
  spinner.start('Scanning existing records in Qdrant...');

  interface PointToUpdate {
    pointId: string;
    recordId: number;
  }
  const pointsToUpdate: PointToUpdate[] = [];
  let offset: string | number | undefined;

  do {
    const result = await client.scroll(collectionName, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: 100,
      offset: offset,
      with_payload: ['record_id'],
      with_vector: false,
    });

    if (result.points.length === 0) break;

    for (const point of result.points) {
      const recordId = (point.payload as Record<string, unknown>).record_id as number;
      pointsToUpdate.push({
        pointId: point.id as string,
        recordId,
      });
    }

    const nextOffset = result.next_page_offset;
    offset = (typeof nextOffset === 'string' || typeof nextOffset === 'number')
      ? nextOffset
      : undefined;
  } while (offset);

  spinner.succeed(`Found ${pointsToUpdate.length.toLocaleString()} records to update`);

  if (pointsToUpdate.length === 0) {
    console.log(chalk.yellow('\nNo records found for this model.'));
    return;
  }

  if (options.dryRun) {
    console.log(chalk.bgYellow.black('\n DRY RUN COMPLETE '));
    console.log(`Would update ${pointsToUpdate.length.toLocaleString()} records.`);
    return;
  }

  // Phase 2: Update payloads in batches
  console.log();
  console.log(chalk.bold('Updating payloads...'));
  console.log();

  const totalBatches = Math.ceil(pointsToUpdate.length / batchSize);
  let payloadFieldNames = payloadFields.map(f => f.field_name);
  const restrictedPayloadFields = new Set<string>();

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  // Indexing tracking
  let indexesCreated = 0;
  let indexesSkipped = 0;
  const indexErrors: string[] = [];

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, pointsToUpdate.length);
    const batch = pointsToUpdate.slice(batchStart, batchEnd);

    // Calculate progress
    const progress = ((batchEnd / pointsToUpdate.length) * 100).toFixed(1);
    const progressBar = createProgressBar(batchEnd, pointsToUpdate.length, 30);

    // Update spinner with progress
    process.stdout.write(`\r${progressBar} ${progress}% | ${batchEnd.toLocaleString()}/${pointsToUpdate.length.toLocaleString()} records | Updated: ${updated.toLocaleString()}`);

    try {
      // Get record IDs for this batch
      const recordIds = batch.map(p => p.recordId);

      // Fetch fresh data from Odoo
      const fetchResult = await odooClient.searchReadWithRetry(
        modelName,
        [['id', 'in', recordIds]],
        payloadFieldNames,
        {},
        { maxRetries: 5 }
      );
      const freshRecords = fetchResult.records as Record<string, unknown>[];

      // Track restricted fields
      if (fetchResult.restrictedFields.length > 0) {
        for (const field of fetchResult.restrictedFields) {
          if (!restrictedPayloadFields.has(field)) {
            restrictedPayloadFields.add(field);
          }
        }
        // Remove restricted fields for subsequent batches
        payloadFieldNames = payloadFieldNames.filter(f => !restrictedPayloadFields.has(f));
      }

      // Build map of record_id -> fresh data
      const recordMap = new Map(
        freshRecords.map((r: Record<string, unknown>) => [r.id as number, r])
      );

      // Update payloads in Qdrant
      for (const point of batch) {
        const freshData = recordMap.get(point.recordId) as Record<string, unknown> | undefined;

        if (freshData) {
          // Build new payload from fresh Odoo data
          const newPayload: Record<string, unknown> = {
            payload_updated: new Date().toISOString(),
          };

          // Add all payload fields from fresh data
          for (const fieldName of payloadFieldNames) {
            const value = freshData[fieldName] as unknown;
            if (value !== null && value !== undefined && value !== '') {
              // Handle many2one fields (Odoo returns [id, name] tuple)
              if (Array.isArray(value) && value.length === 2) {
                newPayload[fieldName] = value;
                newPayload[`${fieldName}_id`] = value[0];
                newPayload[`${fieldName}_name`] = value[1];
              } else {
                newPayload[fieldName] = value;
              }
            }
          }

          // Update payload in Qdrant
          await client.setPayload(collectionName, {
            points: [point.pointId],
            payload: newPayload,
          });
          updated++;
        } else {
          skipped++;
        }
      }
    } catch (batchError) {
      const errorMsg = batchError instanceof Error ? batchError.message : String(batchError);
      errors.push(`Batch ${batchIndex + 1} error: ${errorMsg}`);
      failed += batch.length;
    }
  }

  // Clear the progress line
  process.stdout.write('\r' + ' '.repeat(100) + '\r');

  // Phase 3: Create indexes for all payload fields
  console.log();
  const indexSpinner = ora('Creating indexes for payload fields...').start();

  try {
    // Build field list with types for indexing
    const fieldsToIndex = payloadFields.map(f => ({
      field_name: f.field_name,
      field_type: f.field_type,
    }));

    const indexResult = await createDynamicPayloadIndexes(modelName, fieldsToIndex);

    // Register fields so filtering works immediately (in current session)
    const indexedFieldNames: string[] = [];
    for (const f of payloadFields) {
      indexedFieldNames.push(f.field_name);
      // Add _id and _qdrant variants for many2one fields
      if (f.field_type === 'many2one') {
        indexedFieldNames.push(`${f.field_name}_id`);
        indexedFieldNames.push(`${f.field_name}_qdrant`);
      }
    }
    registerIndexedFields(indexedFieldNames);

    indexesCreated = indexResult.created;
    indexesSkipped = indexResult.skipped;
    indexErrors.push(...indexResult.errors);

    if (indexResult.created > 0) {
      indexSpinner.succeed(`Created ${indexResult.created} new index(es), ${indexResult.skipped} already exist`);
    } else {
      indexSpinner.succeed(`All ${indexResult.skipped} indexes already exist`);
    }
  } catch (indexError) {
    indexSpinner.warn('Index creation failed (payload update succeeded)');
    const errMsg = indexError instanceof Error ? indexError.message : String(indexError);
    indexErrors.push(errMsg);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log(chalk.bold('\n' + '='.repeat(60)));
  console.log(chalk.bold.green('PAYLOAD UPDATE COMPLETE'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();
  console.log(chalk.white('Model:'), chalk.yellow(modelName));
  console.log(chalk.white('Duration:'), chalk.cyan(`${duration}s`));
  console.log(chalk.white('Records Updated:'), chalk.green(updated.toLocaleString()));
  console.log(chalk.white('Records Skipped:'), chalk.yellow(skipped.toLocaleString()));
  if (failed > 0) {
    console.log(chalk.white('Records Failed:'), chalk.red(failed.toLocaleString()));
  }

  // Show indexing results
  console.log();
  console.log(chalk.bold('Indexing:'));
  console.log(chalk.white('  Indexes Created:'), chalk.green(indexesCreated.toString()));
  console.log(chalk.white('  Indexes Skipped:'), chalk.dim(`${indexesSkipped} (already exist)`));
  if (indexErrors.length > 0) {
    console.log(chalk.white('  Index Errors:'), chalk.red(indexErrors.length.toString()));
    for (const err of indexErrors.slice(0, 3)) {
      console.log(chalk.dim(`    - ${err}`));
    }
    if (indexErrors.length > 3) {
      console.log(chalk.dim(`    ... and ${indexErrors.length - 3} more`));
    }
  }

  // Show restricted fields
  if (restrictedPayloadFields.size > 0) {
    console.log();
    console.log(chalk.yellow(`Restricted Fields (${restrictedPayloadFields.size}):`));
    console.log(chalk.dim('-'.repeat(40)));
    for (const field of restrictedPayloadFields) {
      console.log(chalk.dim(`  - ${field}`));
    }
    console.log();
    console.log(chalk.dim('NOTE: These fields were excluded from payload due to'));
    console.log(chalk.dim('Odoo data issues (orphan FK references or restrictions).'));
  }

  // Show errors
  if (errors.length > 0) {
    console.log();
    console.log(chalk.red('Errors:'));
    for (const error of errors.slice(0, 5)) {
      console.log(chalk.dim(`  - ${error}`));
    }
    if (errors.length > 5) {
      console.log(chalk.dim(`  ... and ${errors.length - 5} more errors`));
    }
  }

  console.log();
}

/**
 * Create a simple ASCII progress bar
 */
function createProgressBar(current: number, total: number, width: number): string {
  const percentage = current / total;
  const filled = Math.round(width * percentage);
  const empty = width - filled;

  const filledBar = chalk.green('\u2588'.repeat(filled));
  const emptyBar = chalk.dim('\u2591'.repeat(empty));

  return `[${filledBar}${emptyBar}]`;
}
