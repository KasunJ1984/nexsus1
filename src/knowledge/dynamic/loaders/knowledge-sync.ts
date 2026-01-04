/**
 * Knowledge Sync - Sync dynamic knowledge to Qdrant
 *
 * Syncs KPIs, Odoo patterns, and report formats to Qdrant
 * with point_type: 'knowledge' for semantic retrieval.
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient } from '../../../common/services/vector-client.js';
import { embed, initializeEmbeddingService } from '../../../common/services/embedding-service.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';
import {
  SAMPLE_KPIS,
  SAMPLE_PATTERNS,
  SAMPLE_REPORTS,
  KPI_CATEGORY_CODE,
  ODOO_PATTERN_CATEGORY_CODE,
  REPORT_CATEGORY_CODE,
  KNOWLEDGE_NAMESPACE,
} from '../schemas/index.js';
import type { KPI, OdooPattern, Report } from '../schemas/index.js';

// =============================================================================
// UUID GENERATION
// =============================================================================

/**
 * Build knowledge point UUID
 * Format: 00000004-KKKK-0000-0000-RRRRRRRRRRRR
 */
function buildKnowledgeUuid(categoryCode: string, itemIndex: number): string {
  const paddedIndex = itemIndex.toString().padStart(12, '0');
  return `${KNOWLEDGE_NAMESPACE}-${categoryCode}-0000-0000-${paddedIndex}`;
}

// =============================================================================
// ENCODING
// =============================================================================

/**
 * Encode KPI for embedding
 */
function encodeKpi(kpi: KPI): string {
  const parts = [
    `KPI: ${kpi.name}`,
    kpi.description,
    `Category: ${kpi.category}`,
    kpi.interpretation,
    kpi.tags?.join(', ') || '',
  ];
  return parts.filter(Boolean).join(' | ');
}

/**
 * Encode Odoo pattern for embedding
 */
function encodePattern(pattern: OdooPattern): string {
  const parts = [
    `Pattern: ${pattern.name}`,
    pattern.description,
    `Model: ${pattern.model}`,
    `Category: ${pattern.category}`,
    pattern.tags?.join(', ') || '',
  ];
  return parts.filter(Boolean).join(' | ');
}

/**
 * Encode report format for embedding
 */
function encodeReport(report: Report): string {
  const sectionNames = report.sections.map((s) => s.name).join(', ');
  const parts = [
    `Report: ${report.name}`,
    report.description,
    `Category: ${report.category}`,
    `Sections: ${sectionNames}`,
    report.tags?.join(', ') || '',
  ];
  return parts.filter(Boolean).join(' | ');
}

// =============================================================================
// SYNC FUNCTIONS
// =============================================================================

interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
}

interface SyncResult {
  category: string;
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Sync a batch of knowledge items
 */
async function syncBatch<T>(
  items: T[],
  categoryCode: string,
  categoryName: string,
  encoder: (item: T) => string,
  getPayload: (item: T, index: number) => Record<string, unknown>,
  options: SyncOptions
): Promise<SyncResult> {
  const result: SyncResult = {
    category: categoryName,
    synced: 0,
    skipped: 0,
    errors: 0,
  };

  if (items.length === 0) {
    return result;
  }

  const spinner = ora(`Syncing ${categoryName}...`).start();

  try {
    // Build points
    const points: Array<{
      id: string;
      vector: number[];
      payload: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = encoder(item);

      // Embed the text
      const vector = await embed(text, 'document');
      if (!vector) {
        spinner.text = `${categoryName}: Failed to embed item ${i}`;
        result.errors++;
        continue;
      }

      const uuid = buildKnowledgeUuid(categoryCode, i + 1);
      const payload = {
        point_type: 'knowledge',
        knowledge_category: categoryName,
        category_code: categoryCode,
        item_index: i + 1,
        vector_text: text,
        ...getPayload(item, i),
      };

      points.push({
        id: uuid,
        vector,
        payload,
      });
    }

    if (options.dryRun) {
      spinner.succeed(`${categoryName}: Would sync ${points.length} items (dry run)`);
      result.skipped = points.length;
      return result;
    }

    // Upsert to Qdrant
    const client = getQdrantClient();
    await client.upsert(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      points,
    });

    spinner.succeed(`${categoryName}: Synced ${points.length} items`);
    result.synced = points.length;
    return result;
  } catch (error) {
    spinner.fail(`${categoryName}: Error - ${error}`);
    result.errors = items.length;
    return result;
  }
}

// =============================================================================
// MAIN SYNC COMMAND
// =============================================================================

export async function syncKnowledgeCommand(options: SyncOptions): Promise<void> {
  const startTime = Date.now();

  console.log(chalk.bold('\n='.repeat(60)));
  console.log(chalk.bold.magenta('NEXSUS SYNC - Knowledge Sync'));
  console.log(chalk.bold('='.repeat(60)));
  console.log();

  console.log(chalk.white('Dry run:'), options.dryRun ? chalk.yellow('Yes') : chalk.green('No'));
  console.log(chalk.white('Force:'), options.force ? chalk.red('Yes') : chalk.green('No'));
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

  // Get current knowledge count
  const client = getQdrantClient();
  const beforeCount = await client.count(UNIFIED_CONFIG.COLLECTION_NAME, {
    filter: {
      must: [{ key: 'point_type', match: { value: 'knowledge' } }],
    },
    exact: true,
  });
  console.log(chalk.white('Current knowledge points:'), chalk.cyan(beforeCount.count.toLocaleString()));

  // Delete existing knowledge if force
  if (options.force && beforeCount.count > 0 && !options.dryRun) {
    const deleteSpinner = ora('Deleting existing knowledge points...').start();
    await client.delete(UNIFIED_CONFIG.COLLECTION_NAME, {
      wait: true,
      filter: {
        must: [{ key: 'point_type', match: { value: 'knowledge' } }],
      },
    });
    deleteSpinner.succeed(`Deleted ${beforeCount.count} existing knowledge points`);
  }

  console.log(chalk.bold('\n' + '-'.repeat(60)));
  console.log(chalk.bold.magenta('Syncing Knowledge Categories...'));
  console.log(chalk.bold('-'.repeat(60) + '\n'));

  const results: SyncResult[] = [];

  // Sync KPIs
  const kpiResult = await syncBatch(
    SAMPLE_KPIS,
    KPI_CATEGORY_CODE,
    'KPIs',
    encodeKpi,
    (kpi) => ({
      id: kpi.id,
      name: kpi.name,
      description: kpi.description,
      category: kpi.category,
      formula: kpi.formula,
      interpretation: kpi.interpretation,
      benchmarks: kpi.benchmarks,
      tags: kpi.tags,
    }),
    options
  );
  results.push(kpiResult);

  // Sync Odoo Patterns
  const patternResult = await syncBatch(
    SAMPLE_PATTERNS,
    ODOO_PATTERN_CATEGORY_CODE,
    'Odoo Patterns',
    encodePattern,
    (pattern) => ({
      id: pattern.id,
      name: pattern.name,
      description: pattern.description,
      category: pattern.category,
      model: pattern.model,
      filters: pattern.filters,
      aggregations: pattern.aggregations,
      groupBy: pattern.groupBy,
      link: pattern.link,
      pitfalls: pattern.pitfalls,
      tags: pattern.tags,
    }),
    options
  );
  results.push(patternResult);

  // Sync Report Formats
  const reportResult = await syncBatch(
    SAMPLE_REPORTS,
    REPORT_CATEGORY_CODE,
    'Reports',
    encodeReport,
    (report) => ({
      id: report.id,
      name: report.name,
      description: report.description,
      category: report.category,
      dateRange: report.dateRange,
      sections: report.sections,
      formatting: report.formatting,
      tags: report.tags,
    }),
    options
  );
  results.push(reportResult);

  // Summary
  console.log(chalk.bold('\n' + '='.repeat(60)));
  console.log(chalk.bold.green('Knowledge Sync Complete'));
  console.log(chalk.bold('='.repeat(60) + '\n'));

  const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

  console.log(chalk.white('Summary:'));
  for (const r of results) {
    console.log(
      chalk.gray(`  ${r.category}:`),
      chalk.green(`${r.synced} synced`),
      r.skipped > 0 ? chalk.yellow(`, ${r.skipped} skipped`) : '',
      r.errors > 0 ? chalk.red(`, ${r.errors} errors`) : ''
    );
  }

  console.log();
  console.log(chalk.white('Total:'), chalk.green(`${totalSynced} synced`));
  if (totalSkipped > 0) console.log(chalk.white('Skipped:'), chalk.yellow(totalSkipped));
  if (totalErrors > 0) console.log(chalk.white('Errors:'), chalk.red(totalErrors));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(chalk.white('\nDuration:'), chalk.cyan(`${duration}s`));
  console.log();
}
