/**
 * Data Tools
 *
 * MCP tools for data management and monitoring.
 * Provides tools:
 * 1. system_status - Unified status (data, pipeline, health, metrics)
 * 2. dlq_status - Check Dead Letter Queue status
 * 3. dlq_clear - Clear failed records from DLQ
 * 4. update_model_payload - Update payload without re-embedding
 *
 * NOTE: cleanup_deleted has been moved to CLI (nexsus-sync cleanup <model_name>)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SystemStatusSchema } from '../../common/schemas/index.js';
import type { SystemStatusInput } from '../../common/schemas/index.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';
import { getQdrantClient } from '../../common/services/vector-client.js';
import {
  getPipelineSyncStatus,
  previewPipelineTransform,
} from '../../common/services/pipeline-data-sync.js';
import { getDLQStats, clearDLQ } from '../../common/services/dlq.js';
import { getCircuitBreakerStates, resetAllCircuitBreakers } from '../../common/services/circuit-breaker.js';
import { getMetrics, resetMetrics, formatMetricsSummary } from '../../common/services/metrics.js';
import { isR2Enabled, getR2Status } from '../../common/services/r2-client.js';
import {
  orchestrateExport,
  formatOrchestratorResponse,
  type ExportableResult,
} from '../../common/services/export-orchestrator.js';
import { AUTO_EXPORT_CONFIG } from '../../common/constants.js';

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

/**
 * Register data tools with the MCP server
 */
export function registerDataTools(server: McpServer): void {
  // =========================================================================
  // SYSTEM STATUS TOOL (Unified)
  // =========================================================================

  server.tool(
    'system_status',
    `Unified system status - check data, pipeline, health, and metrics.

**SECTIONS:**
- all: Show everything (default)
- data: Collection vector counts
- pipeline: Sync history and model info
- health: Circuit breaker states for external services
- metrics: Sync performance statistics

**EXAMPLES:**
- Full status: { }
- Data only: { "section": "data" }
- Pipeline details: { "section": "pipeline", "model_name": "crm.lead" }
- Reset metrics: { "section": "metrics", "reset_metrics": true }
- Reset circuits: { "section": "health", "reset_circuits": true }`,
    SystemStatusSchema.shape,
    async (args) => {
      try {
        const input = SystemStatusSchema.parse(args) as SystemStatusInput;
        const section = input.section || 'all';
        const lines: string[] = [];

        lines.push(`System Status`);
        lines.push(`${'='.repeat(50)}`);

        // ===================== DATA SECTION =====================
        if (section === 'all' || section === 'data') {
          lines.push(``);
          lines.push(`## Data Collection`);
          lines.push(`${'─'.repeat(40)}`);

          try {
            // Unified collection - count by point_type
            const client = getQdrantClient();
            const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;
            const info = await client.getCollection(collectionName);
            const totalPoints = info.points_count ?? 0;

            // Count by point_type
            const schemaCount = await client.count(collectionName, {
              filter: { must: [{ key: 'point_type', match: { value: 'schema' } }] },
              exact: true,
            });
            const dataCount = await client.count(collectionName, {
              filter: { must: [{ key: 'point_type', match: { value: 'data' } }] },
              exact: true,
            });
            const graphCount = await client.count(collectionName, {
              filter: { must: [{ key: 'point_type', match: { value: 'graph' } }] },
              exact: true,
            });

            lines.push(`Collection: ${collectionName}`);
            lines.push(`Total Points: ${totalPoints.toLocaleString()}`);
            lines.push(``);
            lines.push(`By Point Type:`);
            lines.push(`  Schema: ${schemaCount.count.toLocaleString()}`);
            lines.push(`  Data: ${dataCount.count.toLocaleString()}`);
            lines.push(`  Graph: ${graphCount.count.toLocaleString()}`);
          } catch (err) {
            lines.push(`Error loading data status: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // ===================== PIPELINE SECTION =====================
        if (section === 'all' || section === 'pipeline') {
          lines.push(``);
          lines.push(`## Pipeline Sync`);
          lines.push(`${'─'.repeat(40)}`);

          try {
            const pipelineStatus = await getPipelineSyncStatus();

            lines.push(`Collection: ${pipelineStatus.collection.collectionName}`);
            lines.push(`Exists: ${pipelineStatus.collection.exists ? 'Yes' : 'No'}`);
            lines.push(`Vector Count: ${pipelineStatus.collection.vectorCount.toLocaleString()}`);
            lines.push(``);
            lines.push(`Schema Stats:`);
            lines.push(`  Total Models: ${pipelineStatus.schema.totalModels}`);
            lines.push(`  Total Fields: ${pipelineStatus.schema.totalFields.toLocaleString()}`);
            lines.push(`  Payload Fields: ${pipelineStatus.schema.payloadFields.toLocaleString()}`);

            const syncKeys = Object.keys(pipelineStatus.syncs);
            if (syncKeys.length > 0) {
              lines.push(``);
              lines.push(`Synced Models (${syncKeys.length}):`);
              // Show ALL synced models - no artificial truncation
              for (const modelName of syncKeys) {
                const sync = pipelineStatus.syncs[modelName];
                lines.push(`  ${modelName}: ${sync.record_count.toLocaleString()} records`);
              }
            }

            // Show specific model details if requested
            if (input.model_name) {
              lines.push(``);
              lines.push(`Details for: ${input.model_name}`);
              const preview = await previewPipelineTransform(input.model_name);
              if (preview.valid && preview.model_config) {
                lines.push(`  Model ID: ${preview.model_config.model_id}`);
                lines.push(`  Total Fields: ${preview.model_config.total_fields}`);
                lines.push(`  Payload Fields: ${preview.model_config.payload_fields}`);
              } else {
                lines.push(`  Model not found or invalid`);
              }
            }
          } catch (err) {
            lines.push(`Error loading pipeline status: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // ===================== HEALTH SECTION =====================
        if (section === 'all' || section === 'health') {
          lines.push(``);
          lines.push(`## Circuit Breakers`);
          lines.push(`${'─'.repeat(40)}`);

          if (input.reset_circuits) {
            resetAllCircuitBreakers();
            lines.push(`All circuit breakers reset to CLOSED state.`);
          }

          const states = getCircuitBreakerStates();
          for (const [service, stats] of Object.entries(states)) {
            const stateIcon = stats.state === 'closed' ? '[OK]' :
                             stats.state === 'open' ? '[OPEN]' : '[TEST]';
            const lastFail = stats.lastFailureTime
              ? `${Math.round((Date.now() - stats.lastFailureTime) / 1000)}s ago`
              : 'never';

            lines.push(`${stateIcon} ${service.toUpperCase()}: ${stats.state}`);
            lines.push(`    Failures: ${stats.consecutiveFailures}, Last: ${lastFail}`);
          }
        }

        // ===================== METRICS SECTION =====================
        if (section === 'all' || section === 'metrics') {
          lines.push(``);
          lines.push(`## Sync Metrics`);
          lines.push(`${'─'.repeat(40)}`);

          if (input.reset_metrics) {
            resetMetrics();
            lines.push(`All sync metrics have been reset.`);
          } else {
            const summary = formatMetricsSummary();
            lines.push(summary);
          }
        }

        // ===================== R2 STORAGE SECTION =====================
        if (section === 'all' || section === 'health') {
          lines.push(``);
          lines.push(`## R2 Cloud Storage`);
          lines.push(`${'─'.repeat(40)}`);

          try {
            const r2Status = getR2Status();
            const statusIcon = r2Status.enabled ? '[OK]' : '[OFF]';

            lines.push(`${statusIcon} R2 Status: ${r2Status.enabled ? 'ENABLED' : 'DISABLED'}`);
            if (r2Status.enabled) {
              lines.push(`    Bucket: ${r2Status.bucket}`);
              lines.push(`    URL Expiry: ${r2Status.urlExpirySeconds}s (${Math.round(r2Status.urlExpirySeconds / 60)} min)`);
              lines.push(`    Key Prefix: ${r2Status.keyPrefix}`);
            } else {
              lines.push(`    Missing env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,`);
              lines.push(`    R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME`);
            }
          } catch (err) {
            lines.push(`Error loading R2 status: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const output = lines.join('\n');

        // Auto-Export: Check if results exceed token threshold
        if (AUTO_EXPORT_CONFIG.ENABLED) {
          const exportable: ExportableResult = {
            type: 'status',
            data: { output },
            metadata: {
              model_name: input.model_name || 'system',
              query_time_ms: 0,
              tool_name: 'system_status',
              filters_summary: `section=${section}`,
            },
          };

          const orchestratorResult = await orchestrateExport(exportable, undefined);

          if (orchestratorResult.exported && orchestratorResult.exportResult) {
            console.error(`[SystemStatus] Auto-exported to ${orchestratorResult.exportResult.storage_type || 'file'}`);
            return {
              content: [{
                type: 'text' as const,
                text: formatOrchestratorResponse(orchestratorResult),
              }],
            };
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: output,
          }],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${errMsg}`,
          }],
        };
      }
    }
  );

  // =========================================================================
  // DLQ STATUS TOOL
  // =========================================================================

  server.tool(
    'dlq_status',
    `Check Dead Letter Queue status - shows failed records that need attention.

Shows:
- Total failed records
- Breakdown by model
- Breakdown by failure stage (encoding/embedding/upsert)

Use this to monitor sync health and identify records that failed.`,
    {},
    async () => {
      try {
        const stats = getDLQStats();
        const lines = [
          'Dead Letter Queue Status',
          '========================',
          `Total Failed Records: ${stats.total}`,
        ];

        if (stats.total === 0) {
          lines.push('', 'No failed records in DLQ.');
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (Object.keys(stats.by_model).length > 0) {
          lines.push('', 'By Model:');
          for (const [model, count] of Object.entries(stats.by_model)) {
            lines.push(`  ${model}: ${count}`);
          }
        }

        if (Object.keys(stats.by_stage).length > 0) {
          lines.push('', 'By Failure Stage:');
          for (const [stage, count] of Object.entries(stats.by_stage)) {
            lines.push(`  ${stage}: ${count}`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${errMsg}` }] };
      }
    }
  );

  // =========================================================================
  // DLQ CLEAR TOOL
  // =========================================================================

  server.tool(
    'dlq_clear',
    `Clear the Dead Letter Queue.

Can clear all records or just records for a specific model.

**EXAMPLES:**
- Clear all: \`{ }\`
- Clear specific model: \`{ "model_name": "crm.lead" }\``,
    {
      model_name: z.string().optional().describe('Model to clear (e.g., "crm.lead"). If not specified, clears ALL.'),
    },
    async (args) => {
      try {
        const modelName = args.model_name as string | undefined;
        const cleared = clearDLQ(modelName);

        const msg = modelName
          ? `Cleared ${cleared} failed records for ${modelName}`
          : `Cleared ${cleared} failed records from DLQ`;

        return { content: [{ type: 'text', text: msg }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${errMsg}` }] };
      }
    }
  );

  // =========================================================================
  // UPDATE MODEL PAYLOAD TOOL
  // =========================================================================

  server.tool(
    'update_model_payload',
    `Update payload fields for all records of a model WITHOUT re-embedding.

Use after changing feilds_to_add_payload.xlsx to update existing
records with new payload field configuration.

**WHAT IT DOES:**
- Reads new payload config from Excel
- Fetches ONLY the payload fields from Odoo
- Updates payload in Qdrant using setPayload API (keeps existing vectors!)

**WHAT IT DOES NOT DO:**
- Does NOT re-sync data (no new records)
- Does NOT re-generate embeddings (keeps existing vectors)
- Does NOT call Voyage AI (no embedding API calls = $0 cost)

**PERFORMANCE:**
- ~30 seconds for 1000 records (vs ~5 minutes for full re-sync)

**EXAMPLES:**
- Update res.partner: \`{ "model_name": "res.partner" }\`
- Update crm.lead: \`{ "model_name": "crm.lead" }\``,
    {
      model_name: z.string().describe('Odoo model name to update payload (e.g., "res.partner")'),
    },
    async (args) => {
      try {
        const modelName = args.model_name as string;
        if (!modelName) {
          return {
            content: [{
              type: 'text',
              text: 'Error: model_name is required',
            }],
          };
        }

        // Import dynamically to avoid circular dependencies
        const { updateModelPayload, clearSchemaCache } = await import('../../common/services/schema-query-service.js');
        const { getOdooClient } = await import('../../common/services/odoo-client.js');

        // Clear cache to get fresh payload config
        clearSchemaCache();

        // Get Odoo client
        const odooClient = getOdooClient();

        // Execute payload update
        const result = await updateModelPayload(modelName, odooClient);

        // Format result
        const lines: string[] = [];
        lines.push(`Payload Update ${result.success ? 'Complete' : 'Failed'}`);
        lines.push(`${'='.repeat(40)}`);
        lines.push(`Model: ${modelName}`);
        lines.push(`Records Updated: ${result.updated}`);
        lines.push(`Records Skipped: ${result.skipped}`);
        lines.push(`Records Failed: ${result.failed}`);
        lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);

        // Show restricted fields (fields excluded due to Odoo errors)
        if (result.restrictedFields && result.restrictedFields.length > 0) {
          lines.push(``);
          lines.push(`Restricted Fields (${result.restrictedFields.length}):`);
          lines.push(`${'─'.repeat(40)}`);
          for (const field of result.restrictedFields) {
            lines.push(`  - ${field}`);
          }
          lines.push(``);
          lines.push(`NOTE: These fields were excluded from payload due to`);
          lines.push(`Odoo data issues (orphan FK references or restrictions).`);
        }

        if (result.errors.length > 0) {
          lines.push(``);
          lines.push(`Errors:`);
          for (const error of result.errors) {
            lines.push(`  - ${error}`);
          }
        }

        return {
          content: [{
            type: 'text',
            text: lines.join('\n'),
          }],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: 'text',
            text: `Error: ${errMsg}`,
          }],
        };
      }
    }
  );

  console.error('[DataTool] Registered 4 data tools: system_status, dlq_status, dlq_clear, update_model_payload');
}
