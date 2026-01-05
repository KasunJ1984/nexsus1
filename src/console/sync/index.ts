#!/usr/bin/env node
/**
 * Nexsus CLI - Data Sync Operations
 *
 * Provides command-line interface for data synchronization operations
 * that are too long-running for MCP tool calls.
 *
 * Usage:
 *   npx nexsus-sync sync model account.move.line --date-from 2024-01-01
 *   npx nexsus-sync sync schema --source excel
 *   npx nexsus-sync cleanup account.move.line
 *   npx nexsus-sync validate-fk
 *   npx nexsus-sync status
 */

import 'dotenv/config';
import { Command } from 'commander';
import { syncModelCommand } from './commands/sync-model.js';
import { syncSchemaCommand } from './commands/sync-schema.js';
import { syncDataCommand } from './commands/sync-data.js';
import { cleanupCommand } from './commands/cleanup.js';
import { validateFkCommand } from './commands/validate-fk.js';
import { analyzePatternsCommand } from './commands/analyze-patterns.js';
import { statusCommand } from './commands/status.js';
import { fixOrphansCommand } from './commands/fix-orphans.js';
import { updatePayloadCommand } from './commands/update-payload.js';
import { syncKnowledgeCommand } from '../../knowledge/dynamic/loaders/index.js';

const program = new Command();

program
  .name('nexsus-sync')
  .description('Nexsus CLI - Data Sync Operations')
  .version('1.0.0');

// Sync command group
const syncCmd = program
  .command('sync')
  .description('Sync data to vector database');

// sync model <model_name>
syncCmd
  .command('model <model_name>')
  .description('Sync a model with FK cascade')
  .option('--date-from <date>', 'Filter primary model from date (YYYY-MM-DD)')
  .option('--date-to <date>', 'Filter primary model to date (YYYY-MM-DD)')
  .option('--skip-existing', 'Skip records that already exist in Qdrant', true)
  .option('--no-skip-existing', 'Re-sync all records even if they exist')
  .option('--dry-run', 'Preview without syncing', false)
  .option('--no-cascade', 'Disable FK cascade (sync only primary model)')
  .option('--batch-size <size>', 'Records per batch', '500')
  .option('--force', 'Force full sync (re-fetch all records from Odoo)', false)
  .action(syncModelCommand);

// sync schema
syncCmd
  .command('schema')
  .description('Sync schema to vector database')
  .option('--source <source>', 'Schema source: excel or odoo', 'excel')
  .option('--force', 'Force recreate schema (delete existing)', false)
  .action(syncSchemaCommand);

// sync data <model_name> - Sync data from Excel files
syncCmd
  .command('data <model_name>')
  .description('Sync data from Excel file (use "all" to sync all data files)')
  .option('--file <path>', 'Custom Excel file path')
  .option('--dry-run', 'Preview without syncing', false)
  .option('--skip-cascade', 'Skip FK cascade to related models', false)
  .option('--force', 'Force re-sync even if records exist', false)
  .action(syncDataCommand);

// sync knowledge
syncCmd
  .command('knowledge')
  .description('Sync dynamic knowledge (KPIs, patterns, reports) to vector database')
  .option('--dry-run', 'Preview without syncing', false)
  .option('--force', 'Force recreate knowledge (delete existing)', false)
  .action(syncKnowledgeCommand);

// cleanup <model_name>
program
  .command('cleanup <model_name>')
  .description('Remove deleted records from vector database')
  .option('--dry-run', 'Preview without deleting', false)
  .action(cleanupCommand);

// validate-fk (Graph-Enhanced with Bidirectional Consistency)
program
  .command('validate-fk')
  .description('Validate FK integrity using knowledge graph')
  .option('--model <model_name>', 'Validate specific model only')
  .option('--fix', 'Fix discrepancies by updating graph edges', false)
  .option('--limit <count>', 'Limit orphan details per model', '100')
  .option('--store-orphans', 'Store validation results in graph edges', false)
  .option('--bidirectional', 'Check consistency between data and graph', false)
  .option('--extract-patterns', 'Extract cardinality patterns during validation', false)
  .option('--track-history', 'Append to validation history for trend analysis', false)
  .option('--auto-sync', 'Automatically sync missing FK targets after validation', false)
  .action(validateFkCommand);

// analyze-patterns (Phase 3 - Pattern Extraction for ML Training)
program
  .command('analyze-patterns')
  .description('Analyze and export FK patterns for ML training')
  .option('--model <model_name>', 'Analyze specific model only')
  .option('--export <format>', 'Export format: json, csv, or both', 'json')
  .option('--output <path>', 'Output file path', 'data/patterns_export.json')
  .option('--verbose', 'Show detailed pattern analysis', false)
  .action(analyzePatternsCommand);

// status
program
  .command('status')
  .description('Show system status')
  .option('--section <section>', 'Section: all, data, pipeline, health', 'all')
  .action(statusCommand);

// fix-orphans - Find and sync missing FK target records
program
  .command('fix-orphans [model_name]')
  .description('Find and sync missing FK target records (fixes orphan references)')
  .option('--dry-run', 'Preview orphans without syncing', false)
  .option('--limit <count>', 'Max records to sync per target model', '5000')
  .option('--all', 'Fix orphans across all synced models', false)
  .action(fixOrphansCommand);

// update-payload - Update payload fields without re-embedding
program
  .command('update-payload <model_name>')
  .description('Update payload fields without re-embedding (after changing feilds_to_add_payload.xlsx)')
  .option('--dry-run', 'Preview without updating', false)
  .option('--batch-size <size>', 'Records per batch', '100')
  .action(updatePayloadCommand);

// Parse and execute
program.parse();
