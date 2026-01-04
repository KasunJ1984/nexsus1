/**
 * Status Command
 *
 * Shows system status - collection counts, pipeline history, health.
 */

import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient, getCollectionInfo } from '../../../common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';

interface StatusOptions {
  section: 'all' | 'data' | 'pipeline' | 'health';
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  console.log(chalk.bold('\n='.repeat(60)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - System Status'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  try {
    await initializeVectorClient();
  } catch (error) {
    console.log(chalk.red('Failed to initialize vector client:'), error);
    process.exit(1);
  }

  const client = getQdrantClient();
  const section = options.section;

  // Data section
  if (section === 'all' || section === 'data') {
    console.log(chalk.bold.cyan('Collection Status'));
    console.log(chalk.dim('-'.repeat(40)));

    const collectionInfo = await getCollectionInfo(UNIFIED_CONFIG.COLLECTION_NAME);

    if (!collectionInfo.exists) {
      console.log(chalk.yellow(`Collection '${UNIFIED_CONFIG.COLLECTION_NAME}' does not exist.`));
    } else {
      console.log(chalk.white('Collection:'), chalk.cyan(UNIFIED_CONFIG.COLLECTION_NAME));
      console.log(chalk.white('Total vectors:'), chalk.green(collectionInfo.vectorCount.toLocaleString()));

      // Get counts by point_type
      const [schemaCount, dataCount, graphCount] = await Promise.all([
        client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
          filter: { must: [{ key: 'point_type', match: { value: 'schema' } }] },
          exact: true,
        }),
        client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
          filter: { must: [{ key: 'point_type', match: { value: 'data' } }] },
          exact: true,
        }),
        client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
          filter: { must: [{ key: 'point_type', match: { value: 'graph' } }] },
          exact: true,
        }),
      ]);

      console.log();
      console.log(chalk.white('By Point Type:'));
      console.log(chalk.dim(`  Schema: ${schemaCount.count.toLocaleString()}`));
      console.log(chalk.dim(`  Data: ${dataCount.count.toLocaleString()}`));
      console.log(chalk.dim(`  Graph: ${graphCount.count.toLocaleString()}`));
    }

    console.log();
  }

  // Pipeline section - show top models by record count
  if (section === 'all' || section === 'pipeline') {
    console.log(chalk.bold.cyan('Data Models'));
    console.log(chalk.dim('-'.repeat(40)));

    // Get model counts
    const modelCounts = new Map<string, number>();
    let offset: string | undefined = undefined;
    const BATCH_SIZE = 1000;

    while (true) {
      const result = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
        filter: {
          must: [{ key: 'point_type', match: { value: 'data' } }],
        },
        limit: BATCH_SIZE,
        offset,
        with_payload: { include: ['model_name'] },
        with_vector: false,
      });

      for (const point of result.points) {
        const modelName = point.payload?.model_name as string;
        if (modelName) {
          modelCounts.set(modelName, (modelCounts.get(modelName) || 0) + 1);
        }
      }

      if (result.points.length < BATCH_SIZE || !result.next_page_offset) {
        break;
      }
      offset = result.next_page_offset as string;
    }

    console.log(chalk.white('Total models:'), chalk.cyan(modelCounts.size.toString()));
    console.log();

    // Show top 15 models by count
    const sortedModels = Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    console.log(chalk.white('Top models by record count:'));
    for (const [modelName, count] of sortedModels) {
      const countStr = count.toLocaleString().padStart(10);
      console.log(chalk.dim(`  ${countStr}  ${modelName}`));
    }

    if (modelCounts.size > 15) {
      console.log(chalk.dim(`  ... and ${modelCounts.size - 15} more models`));
    }

    console.log();
  }

  // Health section
  if (section === 'all' || section === 'health') {
    console.log(chalk.bold.cyan('Health Check'));
    console.log(chalk.dim('-'.repeat(40)));

    // Check Qdrant connection
    try {
      const collections = await client.getCollections();
      console.log(chalk.green('Qdrant:'), 'Connected');
      console.log(chalk.dim(`  Collections: ${collections.collections.length}`));
    } catch (error) {
      console.log(chalk.red('Qdrant:'), 'Error', error);
    }

    // Check environment variables
    const envVars = [
      { name: 'QDRANT_HOST', value: process.env.QDRANT_HOST },
      { name: 'QDRANT_API_KEY', value: process.env.QDRANT_API_KEY ? '***' : undefined },
      { name: 'VOYAGE_API_KEY', value: process.env.VOYAGE_API_KEY ? '***' : undefined },
      { name: 'ODOO_URL', value: process.env.ODOO_URL },
    ];

    console.log();
    console.log(chalk.white('Environment:'));
    for (const { name, value } of envVars) {
      const status = value ? chalk.green('Set') : chalk.red('Not set');
      console.log(chalk.dim(`  ${name}: ${status}`));
    }

    console.log();
  }

  console.log(chalk.bold('='.repeat(60)));
  console.log();
}
