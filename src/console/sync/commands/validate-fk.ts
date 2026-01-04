/**
 * Validate FK Command (Graph-Enhanced)
 *
 * Validates FK integrity across all models using knowledge graph edges.
 * Phase 1 & 2 of the Nexsus Data Intelligence System.
 *
 * Key improvements:
 * - Uses knowledge graph to discover FK fields (faster than scanning payloads)
 * - Stores validation results back to graph edges (--store-orphans)
 * - Returns detailed OrphanInfo with target model information
 * - Bidirectional consistency checking (--bidirectional)
 * - Fix discrepancies by updating graph edges (--fix)
 */

import ora from 'ora';
import chalk from 'chalk';
import { initializeVectorClient, getQdrantClient } from '../../../common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../../../common/constants.js';
import {
  getModelRelationships,
  updateGraphValidation,
  updateGraphEdgeCount,
  getRelationshipsWithOrphans,
  classifyCardinality,
  updateEdgePatternMetadata,
  appendValidationHistory,
} from '../../../common/services/knowledge-graph.js';
import type {
  OrphanInfo,
  ValidationReport,
  FkFieldValidationResult,
  RelationshipInfo,
  ConsistencyResult,
  ConsistencyReport,
} from '../../../common/types.js';
import { syncMissingOrphans } from './fix-orphans.js';
import { parseDataUuidV2 } from '../../../common/utils/uuid-v2.js';

// =============================================================================
// TYPES
// =============================================================================

interface ValidateFkOptions {
  model?: string;
  fix: boolean;
  limit: string;
  storeOrphans: boolean;
  bidirectional: boolean;  // Phase 2: --bidirectional flag
  extractPatterns: boolean;  // Phase 3: --extract-patterns flag
  trackHistory: boolean;     // Phase 3: --track-history flag
  autoSync: boolean;         // Stage 2: --auto-sync flag
}

/**
 * Per-field FK statistics (for bidirectional consistency)
 */
interface FieldFkStats {
  field_name: string;
  target_model: string;
  actual_fk_count: number;      // Count of FK references in data
  unique_target_count: number;  // Count of unique target UUIDs
  orphan_count: number;         // Count of missing targets
  graph_edge_count: number;     // edge_count from graph
  qdrant_id: string;            // Graph edge UUID for updates
}

/**
 * Result format with per-field stats for bidirectional checking
 */
interface FkValidationResult {
  model_name: string;
  model_id: number;
  total_records: number;
  fk_fields_checked: number;
  total_fk_references: number;
  missing_references: number;
  orphan_details: OrphanInfo[];
  graph_metadata_used: boolean;
  field_stats: FieldFkStats[];  // Per-field statistics for bidirectional
}

// =============================================================================
// MAIN COMMAND
// =============================================================================

export async function validateFkCommand(options: ValidateFkOptions): Promise<void> {
  const startTime = Date.now();
  const orphanLimit = parseInt(options.limit, 10) || 100;

  console.log(chalk.bold('\n='.repeat(70)));
  console.log(chalk.bold.cyan('NEXSUS SYNC - FK Integrity Validation (Graph-Enhanced)'));
  console.log(chalk.dim('Using knowledge graph to guide validation'));
  console.log(chalk.bold('='.repeat(70)));
  console.log();

  if (options.model) {
    console.log(chalk.white('Model:'), chalk.yellow(options.model));
  } else {
    console.log(chalk.white('Scope:'), chalk.cyan('All models'));
  }
  if (options.storeOrphans) {
    console.log(chalk.bgBlue.white(' STORE MODE '), 'Will save validation results to graph edges');
  }
  if (options.fix) {
    console.log(chalk.bgYellow.black(' FIX MODE '), 'Will attempt to sync missing targets');
  }
  if (options.extractPatterns) {
    console.log(chalk.bgMagenta.white(' PATTERN MODE '), 'Will extract cardinality patterns to graph edges');
  }
  if (options.trackHistory) {
    console.log(chalk.bgCyan.black(' HISTORY MODE '), 'Will append to validation history for trend analysis');
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

  const client = getQdrantClient();

  // Step 1: Discover models from data points
  spinner.start('Discovering models in collection...');

  const models = new Map<string, { model_id: number; count: number }>();
  let offset: string | undefined = undefined;
  const BATCH_SIZE = 1000;

  while (true) {
    const result = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [{ key: 'point_type', match: { value: 'data' } }],
      },
      limit: BATCH_SIZE,
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
          models.set(modelName, {
            model_id: modelId || parseDataUuidV2(point.id as string)?.modelId || 0,
            count: 1,
          });
        }
      }
    }

    if (result.points.length < BATCH_SIZE || !result.next_page_offset) {
      break;
    }
    offset = result.next_page_offset as string;
  }

  spinner.succeed(`Found ${models.size} models`);

  // Filter to specific model if requested
  const modelsToCheck = options.model
    ? new Map([...models].filter(([name]) => name === options.model))
    : models;

  if (options.model && modelsToCheck.size === 0) {
    console.log(chalk.red(`Model '${options.model}' not found in collection.`));
    process.exit(1);
  }

  // Step 2: Validate each model using graph-enhanced approach
  console.log(chalk.bold('\n' + '-'.repeat(70)));
  console.log(chalk.bold.cyan('Validating FK integrity...'));
  console.log(chalk.bold('-'.repeat(70) + '\n'));

  const results: FkValidationResult[] = [];

  for (const [modelName, info] of modelsToCheck) {
    const result = await validateModelFkIntegrityGraphEnhanced(
      client,
      modelName,
      info.model_id,
      orphanLimit,
      models,
      options.storeOrphans
    );
    results.push(result);

    // Log progress
    const graphIndicator = result.graph_metadata_used ? chalk.blue('[G]') : chalk.dim('[S]');
    const status = result.missing_references === 0 ? chalk.green('OK') : chalk.yellow('WARN');
    console.log(
      `  ${status} ${graphIndicator} ${modelName}: ${result.missing_references} missing / ${result.total_fk_references} FK refs`
    );

    // Phase 3: Extract patterns if requested
    if (options.extractPatterns || options.trackHistory) {
      for (const fieldStat of result.field_stats) {
        try {
          // Extract cardinality patterns
          if (options.extractPatterns) {
            await updateEdgePatternMetadata(
              fieldStat.qdrant_id,
              fieldStat.actual_fk_count,
              fieldStat.unique_target_count
            );
          }

          // Track validation history for trend analysis
          if (options.trackHistory) {
            const integrityScore = fieldStat.actual_fk_count > 0
              ? ((fieldStat.actual_fk_count - fieldStat.orphan_count) / fieldStat.actual_fk_count) * 100
              : 100;

            await appendValidationHistory(fieldStat.qdrant_id, {
              timestamp: new Date().toISOString(),
              integrity_score: Math.round(integrityScore * 100) / 100,
              orphan_count: fieldStat.orphan_count,
              edge_count: fieldStat.actual_fk_count,
            });
          }
        } catch (patternError) {
          // Don't fail validation for pattern extraction errors
          console.error(chalk.dim(`  Pattern extraction failed for ${fieldStat.field_name}: ${patternError}`));
        }
      }
    }
  }

  // Build accurate breakdown from field_stats (FULL counts, not limited by orphan_details)
  const missingByTargetModel = new Map<string, number>();
  const missingByField = new Map<string, { target_model: string; orphan_count: number }>();
  const allMissingUuids = new Set<string>();

  for (const result of results) {
    for (const fieldStat of result.field_stats) {
      if (fieldStat.orphan_count > 0) {
        // Aggregate by target model (FULL counts)
        missingByTargetModel.set(
          fieldStat.target_model,
          (missingByTargetModel.get(fieldStat.target_model) || 0) + fieldStat.orphan_count
        );

        // Track per-field breakdown
        const fieldKey = `${result.model_name}.${fieldStat.field_name}`;
        missingByField.set(fieldKey, {
          target_model: fieldStat.target_model,
          orphan_count: fieldStat.orphan_count,
        });
      }
    }

    // Collect unique missing UUIDs for deduplication (from orphan_details which may be limited)
    for (const orphan of result.orphan_details) {
      allMissingUuids.add(orphan.missing_uuid);
    }
  }

  // Step 3: Summary
  const totalRecords = results.reduce((sum, r) => sum + r.total_records, 0);
  const totalFkRefs = results.reduce((sum, r) => sum + r.total_fk_references, 0);
  const totalMissing = results.reduce((sum, r) => sum + r.missing_references, 0);
  const modelsWithOrphans = results.filter(r => r.missing_references > 0).map(r => r.model_name);
  const modelsUsingGraph = results.filter(r => r.graph_metadata_used).length;
  const integrityPercentage = totalFkRefs > 0 ? ((totalFkRefs - totalMissing) / totalFkRefs * 100) : 100;

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.bold('\n' + '='.repeat(70)));
  console.log(chalk.bold.cyan('VALIDATION SUMMARY'));
  console.log(chalk.bold('='.repeat(70)));
  console.log();

  console.log(chalk.white('Total models checked:'), chalk.cyan(results.length.toString()));
  console.log(chalk.white('Models using graph:'), chalk.blue(`${modelsUsingGraph}/${results.length}`));
  console.log(chalk.white('Total records checked:'), chalk.cyan(totalRecords.toLocaleString()));
  console.log(chalk.white('Total FK references:'), chalk.cyan(totalFkRefs.toLocaleString()));
  console.log(chalk.white('Missing FK targets:'), totalMissing > 0
    ? chalk.red(totalMissing.toLocaleString())
    : chalk.green('0'));
  console.log(chalk.white('FK Integrity:'), integrityPercentage >= 99
    ? chalk.green(`${integrityPercentage.toFixed(2)}%`)
    : chalk.yellow(`${integrityPercentage.toFixed(2)}%`));
  console.log(chalk.white('Duration:'), chalk.cyan(`${duration}s`));
  console.log();

  if (options.storeOrphans && totalMissing > 0) {
    console.log(chalk.bgBlue.white(' STORED '), `Validation results saved to ${modelsWithOrphans.length} graph edges`);
    console.log();
  }

  if (totalMissing > 0) {
    console.log(chalk.bgYellow.black(' ORPHAN FK REFERENCES FOUND '));
    console.log();

    // Calculate breakdown total for verification
    const breakdownTotal = Array.from(missingByTargetModel.values()).reduce((a, b) => a + b, 0);

    console.log(chalk.white('Missing by target model:'));
    const sortedMissing = Array.from(missingByTargetModel.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    for (const [target, count] of sortedMissing) {
      console.log(chalk.dim(`  - ${target}: ${count.toLocaleString()} missing`));
    }

    if (missingByTargetModel.size > 20) {
      console.log(chalk.dim(`  ... and ${missingByTargetModel.size - 20} more target models`));
    }

    // Verification: Does breakdown sum match total?
    if (breakdownTotal !== totalMissing) {
      console.log(chalk.yellow(`\n  Note: Breakdown sums to ${breakdownTotal.toLocaleString()}, but missing_references is ${totalMissing.toLocaleString()}`));
      console.log(chalk.dim(`  This can occur when the same target is referenced by multiple FK fields.`));
    }

    // Per-field breakdown (always show for transparency)
    if (missingByField.size > 0) {
      console.log(chalk.white('\nMissing by FK field:'));
      const sortedFields = Array.from(missingByField.entries())
        .sort((a, b) => b[1].orphan_count - a[1].orphan_count)
        .slice(0, 30);

      for (const [fieldKey, info] of sortedFields) {
        console.log(chalk.dim(`  - ${fieldKey} -> ${info.target_model}: ${info.orphan_count.toLocaleString()}`));
      }

      if (missingByField.size > 30) {
        console.log(chalk.dim(`  ... and ${missingByField.size - 30} more FK fields`));
      }
    }

    if (modelsWithOrphans.length > 0) {
      console.log(chalk.white('\nModels with orphan references:'));
      for (const model of modelsWithOrphans.slice(0, 20)) {
        const result = results.find(r => r.model_name === model)!;
        console.log(chalk.dim(`  - ${model}: ${result.missing_references.toLocaleString()} orphans`));
      }
    }

    console.log(chalk.dim('\nLegend: [G] = Graph-guided, [S] = Payload-scanned'));
  } else {
    console.log(chalk.bgGreen.black(' ALL FK REFERENCES VALID '));
    console.log(chalk.dim('The full story is captured - no orphan FK references.'));
  }

  // Step 3.5: Auto-Sync Missing FK Targets (Stage 2)
  if (options.autoSync && totalMissing > 0) {
    console.log(chalk.bold('\n' + '-'.repeat(70)));
    console.log(chalk.bold.cyan('AUTO-SYNCING MISSING FK TARGETS'));
    console.log(chalk.dim('Syncing missing records detected during validation...'));
    console.log(chalk.bold('-'.repeat(70)));
    console.log();

    // Collect all orphan details from results
    const allOrphanDetails: OrphanInfo[] = [];
    for (const result of results) {
      allOrphanDetails.push(...result.orphan_details);
    }

    if (allOrphanDetails.length > 0) {
      const syncResult = await syncMissingOrphans(allOrphanDetails, {
        limit: 5000,
      });

      console.log();
      console.log(chalk.bold('Auto-Sync Summary:'));
      console.log(chalk.green(`  ✓ Synced: ${syncResult.synced.toLocaleString()} records`));
      if (syncResult.failed > 0) {
        console.log(chalk.red(`  ✗ Failed: ${syncResult.failed.toLocaleString()} records`));
      }
      if (syncResult.skipped > 0) {
        console.log(chalk.yellow(`  ⊘ Skipped: ${syncResult.skipped.toLocaleString()} records (not in schema)`));
      }
    } else {
      console.log(chalk.dim('No orphan details available for auto-sync.'));
      console.log(chalk.dim('Tip: Increase --limit to capture more orphan details.'));
    }
  }

  // Step 4: Bidirectional Consistency Check (Phase 2)
  if (options.bidirectional) {
    console.log(chalk.bold('\n' + '='.repeat(70)));
    console.log(chalk.bold.cyan('BIDIRECTIONAL CONSISTENCY CHECK'));
    console.log(chalk.dim('Comparing data FK counts with graph edge_count'));
    console.log(chalk.bold('='.repeat(70)));

    let totalConsistent = 0;
    let totalStaleGraph = 0;
    let totalOrphanFks = 0;
    let totalBothIssues = 0;
    const allConsistencyResults: Array<{ model: string; results: ConsistencyResult[] }> = [];

    for (const result of results) {
      // Only check models that used graph (have field_stats)
      if (!result.graph_metadata_used || result.field_stats.length === 0) {
        continue;
      }

      const consistencyResults = checkBidirectionalConsistency(result, options.fix);
      allConsistencyResults.push({ model: result.model_name, results: consistencyResults });

      // Count totals
      for (const cr of consistencyResults) {
        if (cr.is_consistent) {
          totalConsistent++;
        } else if (cr.discrepancy_type === 'both') {
          totalBothIssues++;
        } else if (cr.discrepancy_type === 'stale_graph') {
          totalStaleGraph++;
        } else if (cr.discrepancy_type === 'orphan_fks') {
          totalOrphanFks++;
        }
      }

      // Print per-model report
      printConsistencyReport(result.model_name, consistencyResults);
    }

    // Summary
    const totalChecked = totalConsistent + totalStaleGraph + totalOrphanFks + totalBothIssues;
    console.log(chalk.bold('\n' + '-'.repeat(70)));
    console.log(chalk.white('Consistency Summary:'));
    console.log(chalk.dim(`  Total FK relationships: ${totalChecked}`));
    console.log(chalk.green(`  Consistent: ${totalConsistent}`));
    if (totalStaleGraph > 0) console.log(chalk.yellow(`  Stale graph: ${totalStaleGraph}`));
    if (totalOrphanFks > 0) console.log(chalk.yellow(`  Orphan FKs: ${totalOrphanFks}`));
    if (totalBothIssues > 0) console.log(chalk.red(`  Both issues: ${totalBothIssues}`));

    // Fix discrepancies if --fix is set
    if (options.fix && (totalStaleGraph > 0 || totalBothIssues > 0)) {
      console.log(chalk.bold('\n' + '-'.repeat(70)));
      console.log(chalk.bgYellow.black(' FIXING DISCREPANCIES '));

      let totalFixed = 0;
      let totalFailed = 0;

      for (const { model, results: consistencyResults } of allConsistencyResults) {
        const result = results.find(r => r.model_name === model);
        if (!result) continue;

        const { fixed, failed } = await fixDiscrepancies(consistencyResults, result.field_stats);
        totalFixed += fixed;
        totalFailed += failed;
      }

      console.log(chalk.green(`  Fixed: ${totalFixed} graph edges`));
      if (totalFailed > 0) console.log(chalk.red(`  Failed: ${totalFailed}`));
    }
  }

  console.log();
}

// =============================================================================
// GRAPH-ENHANCED VALIDATION
// =============================================================================

/**
 * Validate FK integrity for a model using knowledge graph
 *
 * This is the graph-enhanced version that:
 * 1. Queries knowledge graph for FK fields (faster than scanning payloads)
 * 2. Falls back to payload scanning if graph has no edges for this model
 * 3. Optionally stores validation results back to graph edges
 */
async function validateModelFkIntegrityGraphEnhanced(
  client: ReturnType<typeof getQdrantClient>,
  modelName: string,
  modelId: number,
  orphanLimit: number,
  allModels: Map<string, { model_id: number; count: number }>,
  storeOrphans: boolean
): Promise<FkValidationResult> {
  const result: FkValidationResult = {
    model_name: modelName,
    model_id: modelId,
    total_records: 0,
    fk_fields_checked: 0,
    total_fk_references: 0,
    missing_references: 0,
    orphan_details: [],
    graph_metadata_used: false,
    field_stats: [],
  };

  // Step 1: Try to get FK fields from knowledge graph
  const graphRelationships = await getModelRelationships(modelName);

  if (graphRelationships.length > 0) {
    // Graph-enhanced path: we know which FK fields to check
    result.graph_metadata_used = true;
    await validateUsingGraphRelationships(
      client,
      modelName,
      modelId,
      graphRelationships,
      orphanLimit,
      allModels,
      result,
      storeOrphans
    );
  } else {
    // Fallback: scan payloads to discover FK fields
    await validateByPayloadScan(
      client,
      modelName,
      modelId,
      orphanLimit,
      allModels,
      result
    );
  }

  return result;
}

/**
 * Validate using knowledge graph relationships (faster path)
 */
async function validateUsingGraphRelationships(
  client: ReturnType<typeof getQdrantClient>,
  modelName: string,
  modelId: number,
  relationships: RelationshipInfo[],
  orphanLimit: number,
  allModels: Map<string, { model_id: number; count: number }>,
  result: FkValidationResult,
  storeOrphans: boolean
): Promise<void> {
  // Build a map of field names to check
  const fkFieldsToCheck = new Map<string, RelationshipInfo>();
  for (const rel of relationships) {
    fkFieldsToCheck.set(rel.field_name, rel);
  }

  // Scroll through data points, but only extract the FK fields we know about
  const fkReferences = new Map<string, Set<string>>();
  const sourceRecords = new Map<string, number[]>();

  let offset: string | undefined = undefined;
  const BATCH_SIZE = 500;

  while (true) {
    const scrollResult = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: BATCH_SIZE,
      offset,
      with_payload: true,
      with_vector: false,
    });

    for (const point of scrollResult.points) {
      result.total_records++;
      const payload = point.payload as Record<string, unknown>;
      const sourceRecordId = (payload.odoo_id as number) || (payload.record_id as number) || 0;

      // Only check FK fields we know about from graph
      for (const [fieldName] of fkFieldsToCheck) {
        const qdrantKey = `${fieldName}_qdrant`;
        const value = payload[qdrantKey];

        if (value === null || value === undefined) continue;

        if (!fkReferences.has(fieldName)) {
          fkReferences.set(fieldName, new Set());
        }

        const uuids = Array.isArray(value) ? value : [value];

        for (const uuid of uuids) {
          if (typeof uuid === 'string' && uuid.startsWith('00000002-')) {
            fkReferences.get(fieldName)!.add(uuid);
            result.total_fk_references++;

            if (!sourceRecords.has(uuid)) {
              sourceRecords.set(uuid, []);
            }
            sourceRecords.get(uuid)!.push(sourceRecordId);
          }
        }
      }
    }

    if (scrollResult.points.length < BATCH_SIZE || !scrollResult.next_page_offset) {
      break;
    }
    offset = scrollResult.next_page_offset as string;
  }

  result.fk_fields_checked = fkReferences.size;

  // Check which FK targets exist and build detailed orphan info
  for (const [fieldName, uuidSet] of fkReferences) {
    const relationship = fkFieldsToCheck.get(fieldName)!;
    const uuids = Array.from(uuidSet);
    const existingUuids = await checkUuidsExist(client, uuids);

    let fieldOrphanCount = 0;
    let actualFkCount = 0;
    const fieldOrphans: OrphanInfo[] = [];

    for (const uuid of uuids) {
      // Count FK references for this UUID
      const refs = sourceRecords.get(uuid) || [];
      actualFkCount += refs.length;

      if (!existingUuids.has(uuid)) {
        result.missing_references++;
        fieldOrphanCount++;

        if (result.orphan_details.length < orphanLimit) {
          const parsed = parseDataUuidV2(uuid);

          const orphanInfo: OrphanInfo = {
            source_model: modelName,
            source_record_id: refs[0] || 0,
            fk_field: fieldName,
            missing_target_model: relationship.target_model,
            missing_target_id: parsed?.recordId || 0,
            missing_uuid: uuid,
            detected_at: new Date().toISOString(),
          };

          result.orphan_details.push(orphanInfo);
          fieldOrphans.push(orphanInfo);
        }
      }
    }

    // Track per-field statistics for bidirectional consistency
    result.field_stats.push({
      field_name: fieldName,
      target_model: relationship.target_model,
      actual_fk_count: actualFkCount,
      unique_target_count: uuids.length,
      orphan_count: fieldOrphanCount,
      graph_edge_count: relationship.edge_count,
      qdrant_id: relationship.qdrant_id,
    });

    // Store validation results to graph edge if requested
    if (storeOrphans && relationship.qdrant_id) {
      const fieldIntegrity = uuids.length > 0
        ? ((uuids.length - fieldOrphanCount) / uuids.length) * 100
        : 100;

      try {
        await updateGraphValidation(
          relationship.qdrant_id,
          fieldOrphanCount,
          fieldIntegrity,
          fieldOrphans.slice(0, 10) // Limit samples stored in graph
        );
      } catch {
        // Continue even if graph update fails
      }
    }
  }
}

/**
 * Validate by scanning payloads (fallback path)
 */
async function validateByPayloadScan(
  client: ReturnType<typeof getQdrantClient>,
  modelName: string,
  modelId: number,
  orphanLimit: number,
  allModels: Map<string, { model_id: number; count: number }>,
  result: FkValidationResult
): Promise<void> {
  const fkReferences = new Map<string, Set<string>>();
  const sourceRecords = new Map<string, number[]>();

  let offset: string | undefined = undefined;
  const BATCH_SIZE = 500;

  while (true) {
    const scrollResult = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: modelName } },
        ],
      },
      limit: BATCH_SIZE,
      offset,
      with_payload: true,
      with_vector: false,
    });

    for (const point of scrollResult.points) {
      result.total_records++;
      const payload = point.payload as Record<string, unknown>;
      const sourceRecordId = (payload.odoo_id as number) || (payload.record_id as number) || 0;

      for (const [key, value] of Object.entries(payload)) {
        if (!key.endsWith('_qdrant')) continue;

        const fieldName = key.replace('_qdrant', '');

        if (!fkReferences.has(fieldName)) {
          fkReferences.set(fieldName, new Set());
        }

        const uuids = Array.isArray(value) ? value : [value];

        for (const uuid of uuids) {
          if (typeof uuid === 'string' && uuid.startsWith('00000002-')) {
            fkReferences.get(fieldName)!.add(uuid);
            result.total_fk_references++;

            if (!sourceRecords.has(uuid)) {
              sourceRecords.set(uuid, []);
            }
            sourceRecords.get(uuid)!.push(sourceRecordId);
          }
        }
      }
    }

    if (scrollResult.points.length < BATCH_SIZE || !scrollResult.next_page_offset) {
      break;
    }
    offset = scrollResult.next_page_offset as string;
  }

  result.fk_fields_checked = fkReferences.size;

  // Check which FK targets exist
  for (const [fieldName, uuidSet] of fkReferences) {
    const uuids = Array.from(uuidSet);
    const existingUuids = await checkUuidsExist(client, uuids);

    for (const uuid of uuids) {
      if (!existingUuids.has(uuid)) {
        result.missing_references++;

        if (result.orphan_details.length < orphanLimit) {
          const parsed = parseDataUuidV2(uuid);
          const sourceIds = sourceRecords.get(uuid) || [];

          // Try to find target model name
          let targetModel = `model_id:${parsed?.modelId}`;
          for (const [name, info] of allModels) {
            if (info.model_id === parsed?.modelId) {
              targetModel = name;
              break;
            }
          }

          result.orphan_details.push({
            source_model: modelName,
            source_record_id: sourceIds[0] || 0,
            fk_field: fieldName,
            missing_target_model: targetModel,
            missing_target_id: parsed?.recordId || 0,
            missing_uuid: uuid,
            detected_at: new Date().toISOString(),
          });
        }
      }
    }
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if UUIDs exist in the collection
 */
async function checkUuidsExist(
  client: ReturnType<typeof getQdrantClient>,
  uuids: string[]
): Promise<Set<string>> {
  if (uuids.length === 0) return new Set();

  const existing = new Set<string>();
  const BATCH_SIZE = 500;

  for (let i = 0; i < uuids.length; i += BATCH_SIZE) {
    const batch = uuids.slice(i, i + BATCH_SIZE);

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
      // Continue on error
    }
  }

  return existing;
}

// =============================================================================
// BIDIRECTIONAL CONSISTENCY (Phase 2)
// =============================================================================

/** Tolerance for forward consistency check (5%) */
const FORWARD_TOLERANCE = 0.05;

/**
 * Check bidirectional consistency for a model's validation results
 *
 * Forward check: Compare actual FK counts with graph edge_count
 * Reverse check: Check if orphan_count is 0
 */
function checkBidirectionalConsistency(
  result: FkValidationResult,
  fix: boolean
): ConsistencyResult[] {
  const consistencyResults: ConsistencyResult[] = [];

  for (const fieldStat of result.field_stats) {
    // Forward check: actual_fk_count vs graph_edge_count
    const diff = Math.abs(fieldStat.actual_fk_count - fieldStat.graph_edge_count);
    const tolerance = Math.max(fieldStat.graph_edge_count * FORWARD_TOLERANCE, 10); // At least 10
    const forwardConsistent = diff <= tolerance;

    // Reverse check: orphan_count should be 0
    const reverseConsistent = fieldStat.orphan_count === 0;

    // Determine discrepancy type
    let discrepancyType: 'stale_graph' | 'orphan_fks' | 'both' | undefined;
    if (!forwardConsistent && !reverseConsistent) {
      discrepancyType = 'both';
    } else if (!forwardConsistent) {
      discrepancyType = 'stale_graph';
    } else if (!reverseConsistent) {
      discrepancyType = 'orphan_fks';
    }

    consistencyResults.push({
      edge_id: fieldStat.qdrant_id,
      source_model: result.model_name,
      target_model: fieldStat.target_model,
      field_name: fieldStat.field_name,
      actual_fk_count: fieldStat.actual_fk_count,
      graph_edge_count: fieldStat.graph_edge_count,
      forward_consistent: forwardConsistent,
      orphan_count: fieldStat.orphan_count,
      reverse_consistent: reverseConsistent,
      is_consistent: forwardConsistent && reverseConsistent,
      discrepancy_type: discrepancyType,
    });
  }

  return consistencyResults;
}

/**
 * Fix discrepancies by updating graph edges
 */
async function fixDiscrepancies(
  consistencyResults: ConsistencyResult[],
  fieldStats: FieldFkStats[]
): Promise<{ fixed: number; failed: number }> {
  let fixed = 0;
  let failed = 0;

  for (const cr of consistencyResults) {
    if (cr.is_consistent) continue;

    // Find the corresponding field stats
    const fieldStat = fieldStats.find(fs => fs.field_name === cr.field_name);
    if (!fieldStat || !fieldStat.qdrant_id) {
      failed++;
      continue;
    }

    try {
      // Fix stale graph (update edge_count)
      if (cr.discrepancy_type === 'stale_graph' || cr.discrepancy_type === 'both') {
        await updateGraphEdgeCount(
          fieldStat.qdrant_id,
          fieldStat.actual_fk_count,
          fieldStat.unique_target_count
        );
      }

      // For orphan_fks, we already store orphan info via --store-orphans
      // The fix is to sync the missing target records (not automatic)

      fixed++;
    } catch {
      failed++;
    }
  }

  return { fixed, failed };
}

/**
 * Print bidirectional consistency report
 */
function printConsistencyReport(
  modelName: string,
  consistencyResults: ConsistencyResult[]
): void {
  const consistent = consistencyResults.filter(r => r.is_consistent);
  const staleGraph = consistencyResults.filter(r => r.discrepancy_type === 'stale_graph');
  const orphanFks = consistencyResults.filter(r => r.discrepancy_type === 'orphan_fks');
  const both = consistencyResults.filter(r => r.discrepancy_type === 'both');

  console.log();
  console.log(chalk.bold(`  ${modelName}:`));
  console.log(chalk.dim(`    FK relationships: ${consistencyResults.length}`));
  console.log(chalk.green(`    Consistent: ${consistent.length}`));

  if (staleGraph.length > 0) {
    console.log(chalk.yellow(`    Stale graph: ${staleGraph.length}`));
    for (const r of staleGraph.slice(0, 3)) {
      console.log(chalk.dim(`      - ${r.field_name}: actual=${r.actual_fk_count}, graph=${r.graph_edge_count}`));
    }
  }

  if (orphanFks.length > 0) {
    console.log(chalk.yellow(`    Orphan FKs: ${orphanFks.length}`));
    for (const r of orphanFks.slice(0, 3)) {
      console.log(chalk.dim(`      - ${r.field_name}: ${r.orphan_count} orphans`));
    }
  }

  if (both.length > 0) {
    console.log(chalk.red(`    Both issues: ${both.length}`));
  }
}
