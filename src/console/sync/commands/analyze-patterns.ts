/**
 * Analyze Patterns Command
 *
 * Analyzes and exports FK patterns for ML training.
 * Computes cardinality classification, model roles, and integrity trends.
 *
 * Usage:
 *   npm run sync -- analyze-patterns
 *   npm run sync -- analyze-patterns --model crm.lead
 *   npm run sync -- analyze-patterns --output data/ml_training.json --verbose
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { initializeVectorClient } from '../../../common/services/vector-client.js';
import {
  exportPatterns,
  getModelPattern,
  classifyCardinality,
  classifyModelRole,
} from '../../../common/services/knowledge-graph.js';
import type { PatternExport, ModelPatternMetadata } from '../../../common/types.js';

interface AnalyzePatternsOptions {
  model?: string;
  export: string;
  output: string;
  verbose: boolean;
}

/**
 * Main analyze-patterns command handler
 */
export async function analyzePatternsCommand(options: AnalyzePatternsOptions): Promise<void> {
  const startTime = Date.now();

  console.log('');
  console.log('='.repeat(70));
  console.log('NEXSUS SYNC - Pattern Analysis for ML Training');
  console.log('='.repeat(70));
  console.log('');

  // Initialize services
  console.log('- Initializing services...');
  try {
    await initializeVectorClient();
    console.log('\x1b[32m✔\x1b[39m Services initialized');
  } catch (error) {
    console.error('\x1b[31m✘\x1b[39m Failed to initialize services:', error);
    process.exit(1);
  }

  let patterns: PatternExport;

  if (options.model) {
    // Analyze single model
    console.log(`\n- Analyzing model: ${options.model}`);
    try {
      const modelPattern = await getModelPattern(options.model);

      // Create a minimal export for single model
      patterns = {
        export_timestamp: new Date().toISOString(),
        version: '1.0.0',
        models: [modelPattern],
        edges: [], // Would need to fetch edges for this model
        summary: {
          total_models: 1,
          total_edges: 0,
          hubs: modelPattern.role === 'hub' ? [modelPattern.model_name] : [],
          sources: modelPattern.role === 'source' ? [modelPattern.model_name] : [],
          sinks: modelPattern.role === 'sink' ? [modelPattern.model_name] : [],
          leaves: modelPattern.role === 'leaf' ? [modelPattern.model_name] : [],
          avg_global_integrity: modelPattern.avg_integrity_score,
        },
      };

      printModelPattern(modelPattern, options.verbose);
    } catch (error) {
      console.error(`\x1b[31m✘\x1b[39m Failed to analyze model: ${error}`);
      process.exit(1);
    }
  } else {
    // Full export
    console.log('\n- Exporting all patterns...');
    try {
      patterns = await exportPatterns();
    } catch (error) {
      console.error(`\x1b[31m✘\x1b[39m Failed to export patterns: ${error}`);
      process.exit(1);
    }
  }

  // Print summary
  console.log('');
  console.log('='.repeat(70));
  console.log('PATTERN ANALYSIS SUMMARY');
  console.log('='.repeat(70));
  console.log('');
  console.log(`Total Models: ${patterns.summary.total_models}`);
  console.log(`Total Edges: ${patterns.summary.total_edges}`);
  console.log(`Avg Global Integrity: ${patterns.summary.avg_global_integrity}%`);
  console.log('');
  console.log('Model Roles:');
  console.log(`  Hubs (${patterns.summary.hubs.length}): ${patterns.summary.hubs.slice(0, 5).join(', ')}${patterns.summary.hubs.length > 5 ? '...' : ''}`);
  console.log(`  Sources (${patterns.summary.sources.length}): ${patterns.summary.sources.slice(0, 5).join(', ')}${patterns.summary.sources.length > 5 ? '...' : ''}`);
  console.log(`  Sinks (${patterns.summary.sinks.length}): ${patterns.summary.sinks.slice(0, 5).join(', ')}${patterns.summary.sinks.length > 5 ? '...' : ''}`);
  console.log(`  Leaves (${patterns.summary.leaves.length}): ${patterns.summary.leaves.slice(0, 5).join(', ')}${patterns.summary.leaves.length > 5 ? '...' : ''}`);

  if (options.verbose && !options.model) {
    console.log('');
    console.log('-'.repeat(70));
    console.log('DETAILED MODEL PATTERNS');
    console.log('-'.repeat(70));

    for (const model of patterns.models.slice(0, 20)) {
      printModelPattern(model, false);
    }

    if (patterns.models.length > 20) {
      console.log(`\n... and ${patterns.models.length - 20} more models`);
    }

    // Print cardinality distribution
    const cardinalityCounts = { one_to_one: 0, one_to_few: 0, one_to_many: 0 };
    for (const edge of patterns.edges) {
      if (edge.cardinality_class) {
        cardinalityCounts[edge.cardinality_class]++;
      }
    }

    console.log('');
    console.log('-'.repeat(70));
    console.log('EDGE CARDINALITY DISTRIBUTION');
    console.log('-'.repeat(70));
    console.log(`  one_to_one: ${cardinalityCounts.one_to_one} edges`);
    console.log(`  one_to_few: ${cardinalityCounts.one_to_few} edges`);
    console.log(`  one_to_many: ${cardinalityCounts.one_to_many} edges`);
  }

  // Export to file
  if (options.export === 'json' || options.export === 'both') {
    const outputPath = options.output.endsWith('.json') ? options.output : `${options.output}.json`;

    try {
      // Ensure directory exists
      const dir = dirname(outputPath);
      if (dir !== '.') {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(outputPath, JSON.stringify(patterns, null, 2));
      console.log('');
      console.log(`\x1b[32m✔\x1b[39m Exported patterns to: ${outputPath}`);
    } catch (error) {
      console.error(`\x1b[31m✘\x1b[39m Failed to write output file: ${error}`);
    }
  }

  if (options.export === 'csv' || options.export === 'both') {
    const csvPath = options.output.replace('.json', '.csv');

    try {
      // Ensure directory exists
      const dir = dirname(csvPath);
      if (dir !== '.') {
        mkdirSync(dir, { recursive: true });
      }

      // Export models as CSV
      const modelsCsv = exportModelsAsCsv(patterns.models);
      writeFileSync(csvPath.replace('.csv', '_models.csv'), modelsCsv);
      console.log(`\x1b[32m✔\x1b[39m Exported models to: ${csvPath.replace('.csv', '_models.csv')}`);

      // Export edges as CSV
      const edgesCsv = exportEdgesAsCsv(patterns.edges);
      writeFileSync(csvPath.replace('.csv', '_edges.csv'), edgesCsv);
      console.log(`\x1b[32m✔\x1b[39m Exported edges to: ${csvPath.replace('.csv', '_edges.csv')}`);
    } catch (error) {
      console.error(`\x1b[31m✘\x1b[39m Failed to write CSV files: ${error}`);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`Duration: ${duration}s`);
  console.log('');
}

/**
 * Print model pattern details
 */
function printModelPattern(model: ModelPatternMetadata, verbose: boolean): void {
  const roleColor = {
    hub: '\x1b[33m',     // Yellow
    source: '\x1b[32m',  // Green
    sink: '\x1b[34m',    // Blue
    leaf: '\x1b[36m',    // Cyan
    bridge: '\x1b[35m',  // Magenta
    isolated: '\x1b[90m', // Gray
  };

  const color = roleColor[model.role] || '';
  const reset = '\x1b[39m';

  console.log(`\n  ${model.model_name}`);
  console.log(`    Role: ${color}${model.role}${reset}`);
  console.log(`    Degree: in=${model.incoming_degree}, out=${model.outgoing_degree}, total=${model.total_degree}`);
  console.log(`    Integrity: ${model.avg_integrity_score}%`);

  if (model.worst_fk_field) {
    console.log(`    Worst FK: ${model.worst_fk_field} (${model.worst_integrity_score}%)`);
  }

  if (verbose && model.validation_count > 0) {
    console.log(`    Validations: ${model.validation_count}`);
  }
}

/**
 * Export models as CSV
 */
function exportModelsAsCsv(models: ModelPatternMetadata[]): string {
  const headers = [
    'model_name',
    'model_id',
    'role',
    'incoming_degree',
    'outgoing_degree',
    'total_degree',
    'avg_integrity_score',
    'worst_fk_field',
    'worst_integrity_score',
    'validation_count',
  ];

  const rows = models.map(m => [
    m.model_name,
    m.model_id,
    m.role,
    m.incoming_degree,
    m.outgoing_degree,
    m.total_degree,
    m.avg_integrity_score,
    m.worst_fk_field || '',
    m.worst_integrity_score || '',
    m.validation_count,
  ].join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Export edges as CSV
 */
function exportEdgesAsCsv(edges: Array<{
  source_model?: string;
  target_model?: string;
  field_name?: string;
  edge_count?: number;
  unique_targets?: number;
  cardinality_class?: string;
  cardinality_ratio?: number;
  avg_refs_per_target?: number;
  validation_integrity_score?: number;
  integrity_trend?: string;
}>): string {
  const headers = [
    'source_model',
    'target_model',
    'field_name',
    'edge_count',
    'unique_targets',
    'cardinality_class',
    'cardinality_ratio',
    'avg_refs_per_target',
    'integrity_score',
    'integrity_trend',
  ];

  const rows = edges.map(e => [
    e.source_model || '',
    e.target_model || '',
    e.field_name || '',
    e.edge_count || 0,
    e.unique_targets || 0,
    e.cardinality_class || '',
    e.cardinality_ratio || '',
    e.avg_refs_per_target || '',
    e.validation_integrity_score || '',
    e.integrity_trend || '',
  ].join(','));

  return [headers.join(','), ...rows].join('\n');
}
