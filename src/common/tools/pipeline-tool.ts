/**
 * Pipeline Tool
 *
 * MCP tool interface for the Excel-based data pipeline.
 *
 * Tools:
 * - pipeline_preview: Preview transformation for a model
 * - inspect_record: Retrieve and inspect a single record from Qdrant
 *
 * NOTE: pipeline_sync has been moved to CLI (nexsus-sync sync model <model_name>)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PipelinePreviewSchema,
  InspectRecordSchema,
} from '../schemas/index.js';
import {
  previewPipelineTransform,
} from '../services/pipeline-data-sync.js';
import {
  getAllModelNamesFromSchema,
  getModelIdFromSchema,
  getModelIdFromData,
} from '../services/schema-query-service.js';
import { isValidModelAsync, getModelNotFoundError, getValidModelsAsync } from '../services/model-registry.js';
import {
  retrievePointById,
  initializeVectorClient,
  isVectorClientAvailable,
} from '../services/vector-client.js';
import { UNIFIED_CONFIG, AUTO_EXPORT_CONFIG } from '../constants.js';
import { buildDataUuidV2, buildSchemaUuidV2 } from '../utils/uuid-v2.js';
import {
  orchestrateExport,
  formatOrchestratorResponse,
  type ExportableResult,
} from '../services/export-orchestrator.js';

/**
 * Register pipeline tools with the MCP server
 */
export function registerPipelineTools(server: McpServer): void {
  // =========================================================================
  // PIPELINE_PREVIEW TOOL
  // =========================================================================
  server.tool(
    'pipeline_preview',
    `Preview pipeline transformation for a model (without syncing).

Shows:
- Model configuration (model_id, field counts)
- Which fields will go in payload (payload=1)
- Which fields will be fetched from Odoo

Use this to verify configuration before syncing.`,
    PipelinePreviewSchema.shape,
    async (args) => {
      try {
        const preview = await previewPipelineTransform(args.model_name);

        let output = `Pipeline Preview: ${args.model_name}\n`;
        output += `${'='.repeat(50)}\n\n`;

        if (!preview.valid) {
          output += `INVALID MODEL\n`;
          output += `Errors:\n`;
          for (const error of preview.errors) {
            output += `  - ${error}\n`;
          }

          // Show available models (from Qdrant schema)
          const availableModels = (await getAllModelNamesFromSchema()).slice(0, 20);
          output += `\nAvailable models (first 20):\n`;
          for (const model of availableModels) {
            output += `  - ${model}\n`;
          }

          return {
            content: [{ type: 'text' as const, text: output }],
          };
        }

        const config = preview.model_config!;

        output += `Model Configuration:\n`;
        output += `  Model Name: ${config.model_name}\n`;
        output += `  Model ID: ${config.model_id}\n`;
        output += `  Total Fields: ${config.total_fields}\n`;
        output += `  Payload Fields: ${config.payload_fields}\n\n`;

        output += `Payload Field Names (${config.payload_field_names.length}):\n`;
        for (const field of config.payload_field_names) {
          output += `  - ${field}\n`;
        }

        output += `\nOdoo Fields to Fetch (${config.odoo_fields.length}):\n`;
        // Show first 30 fields
        const displayFields = config.odoo_fields.slice(0, 30);
        for (const field of displayFields) {
          output += `  - ${field}\n`;
        }
        if (config.odoo_fields.length > 30) {
          output += `  ... and ${config.odoo_fields.length - 30} more\n`;
        }

        output += `\nQdrant ID Format:\n`;
        output += `  UUID: ${config.model_id.toString().padStart(8, '0')}-0000-0000-0000-[record_id padded to 12]\n`;
        output += `  Example: ${config.model_id.toString().padStart(8, '0')}-0000-0000-0000-000000012345\n`;

        output += `\nTo sync this model, use:\n`;
        output += `  pipeline_${config.model_name}_1984\n`;

        return {
          content: [{ type: 'text' as const, text: output }],
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Pipeline preview failed: ${errorMsg}` }],
        };
      }
    }
  );

  // =========================================================================
  // INSPECT_RECORD TOOL
  // =========================================================================
  server.tool(
    'inspect_record',
    `Inspect exact record stored in Qdrant vector database.

Retrieves complete point data including payload fields, metadata,
and optionally the embedding vector. Use for debugging and verification.

**Collection:** nexsus_unified (all point types with point_type discriminator)

**Provide EITHER:**
- model_name + record_id: e.g., "crm.lead" + 41085
- point_id: Direct V2 UUID e.g., "00000002-0344-0000-0000-000000041085"

**Examples:**
- Data record: { "model_name": "crm.lead", "record_id": 41085 }
- Schema record: { "record_id": 5012, "collection": "schema" } (field_id)
- By UUID: { "point_id": "00000002-0344-0000-0000-000000041085" }
- With vector: { "model_name": "crm.lead", "record_id": 41085, "with_vector": true }

**V2 UUID Format:**
- Data:   00000002-MMMM-0000-0000-RRRRRRRRRRRR (namespace + model_id + record_id)
- Schema: 00000003-0004-0000-0000-FFFFFFFFFFFF (namespace + 0004 + field_id)
- Graph:  00000001-SSSS-TTTT-00RR-FFFFFFFFFFFF (namespace + source + target + rel_type + field_id)`,
    InspectRecordSchema.shape,
    async (args) => {
      try {
        // ========== VALIDATION ==========
        if (!args.point_id && !(args.model_name && args.record_id)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Provide either 'point_id' OR both 'model_name' and 'record_id'

Examples:
  By model: { "model_name": "crm.lead", "record_id": 41085 }
  By UUID:  { "point_id": "00000344-0000-0000-0000-000000041085" }`,
            }],
          };
        }

        // ========== BUILD POINT ID ==========
        let pointId: string;
        let modelId: number | undefined;

        if (args.point_id) {
          // Use direct UUID
          pointId = args.point_id;
        } else {
          // Validate model exists in schema or data (async - queries Qdrant)
          const pointType = args.collection === 'schema' ? 'schema' : 'data';
          if (!await isValidModelAsync(args.model_name!, { point_type: pointType })) {
            // Get valid models for better error message
            const validModels = await getValidModelsAsync({ point_type: pointType });
            return {
              content: [{
                type: 'text' as const,
                text: `❌ Model "${args.model_name}" not found.

**Available models:** ${validModels.join(', ') || 'none'}

**Tip:** Use semantic_search to discover available models first.`,
              }],
            };
          }

          // Look up model_id from schema first, fallback to data
          modelId = await getModelIdFromSchema(args.model_name!);
          if (!modelId) {
            modelId = await getModelIdFromData(args.model_name!);
          }

          if (!modelId) {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: Could not determine model_id for '${args.model_name}'

The model exists but model_id couldn't be found.
Try using the 'point_id' parameter directly instead.`,
              }],
            };
          }

          // Build UUID with V2 format
          if (args.collection === 'schema') {
            // Schema: record_id is actually field_id
            pointId = buildSchemaUuidV2(args.record_id!);
          } else {
            // Data: use model_id + record_id
            pointId = buildDataUuidV2(modelId, args.record_id!);
          }
        }

        // ========== INITIALIZE VECTOR CLIENT ==========
        if (!isVectorClientAvailable()) {
          initializeVectorClient();
        }

        // ========== DETERMINE COLLECTION ==========
        const collectionName = UNIFIED_CONFIG.COLLECTION_NAME;

        const result = await retrievePointById(
          collectionName,
          pointId,
          args.with_vector ?? false
        );

        // ========== HANDLE NOT FOUND ==========
        if (!result.found) {
          let output = `Point Not Found\n`;
          output += `${'='.repeat(50)}\n\n`;
          output += `Point ID: ${pointId}\n`;
          output += `Collection: ${collectionName}\n`;

          if (args.model_name) {
            output += `\nLookup:\n`;
            output += `  Model Name: ${args.model_name}\n`;
            output += `  Model ID: ${modelId}\n`;
            output += `  Record ID: ${args.record_id}\n`;
          }

          output += `\nSuggestions:\n`;
          output += `  - Verify the record exists in Odoo\n`;
          output += `  - Check if the model has been synced (pipeline_sync)\n`;
          output += `  - Confirm model_id and record_id are correct\n`;
          output += `  - Try the other collection: collection="${args.collection === 'schema' ? 'data' : 'schema'}"\n`;

          return {
            content: [{ type: 'text' as const, text: output }],
          };
        }

        // ========== BUILD SUCCESS RESPONSE ==========
        const payload = result.payload || {};

        let output = `Record Found\n`;
        output += `${'='.repeat(50)}\n\n`;
        output += `Point ID: ${pointId}\n`;
        output += `Collection: ${collectionName}\n`;
        output += `Type: ${args.collection === 'schema' ? 'Schema (field definitions)' : 'Data (Odoo records)'}\n`;

        // Show lookup info if we resolved from model+record
        if (args.model_name) {
          output += `\nLookup:\n`;
          output += `  Model Name: ${args.model_name}\n`;
          output += `  Model ID: ${modelId}\n`;
          output += `  Record ID: ${args.record_id}\n`;
        }

        // Payload summary
        const payloadKeys = Object.keys(payload);
        output += `\nPayload (${payloadKeys.length} fields):\n`;
        output += `${'─'.repeat(40)}\n`;

        // Show all payload fields
        for (const key of payloadKeys) {
          const value = payload[key];
          let displayValue: string;

          if (value === null || value === undefined) {
            displayValue = '(null)';
          } else if (typeof value === 'object') {
            displayValue = JSON.stringify(value);
          } else {
            displayValue = String(value);
          }

          // Truncate long values
          if (displayValue.length > 100) {
            displayValue = displayValue.substring(0, 100) + '...';
          }

          output += `  ${key}: ${displayValue}\n`;
        }

        // Show raw encoded text if requested
        if (args.with_raw !== false) {
          const rawFields = ['encoded_text', 'raw_text', 'vector_text', 'text'];
          let foundRaw = false;

          for (const field of rawFields) {
            if (payload[field]) {
              output += `\nRaw Encoded Text (${field}):\n`;
              output += `${'─'.repeat(40)}\n`;
              const rawText = String(payload[field]);
              // Show full text but wrap it
              output += `${rawText}\n`;
              foundRaw = true;
              break;
            }
          }

          if (!foundRaw) {
            output += `\nRaw Encoded Text: (not found in payload)\n`;
          }
        }

        // Show vector if requested
        if (args.with_vector && result.vector) {
          output += `\nVector:\n`;
          output += `${'─'.repeat(40)}\n`;
          output += `  Dimensions: ${result.vector.length}\n`;
          output += `  Preview (first 10): [${result.vector.slice(0, 10).map(v => v.toFixed(4)).join(', ')}...]\n`;
        }

        // Auto-Export: Check if results exceed token threshold
        if (AUTO_EXPORT_CONFIG.ENABLED) {
          const exportable: ExportableResult = {
            type: 'inspect',
            data: { payload, vector: result.vector },
            metadata: {
              model_name: args.model_name || 'unknown',
              query_time_ms: 0,
              tool_name: 'inspect_record',
              filters_summary: `point_id=${pointId}`,
            },
          };

          const orchestratorResult = await orchestrateExport(exportable, undefined);

          if (orchestratorResult.exported && orchestratorResult.exportResult) {
            console.error(`[InspectRecord] Auto-exported to ${orchestratorResult.exportResult.storage_type || 'file'}`);
            return {
              content: [{ type: 'text' as const, text: formatOrchestratorResponse(orchestratorResult) }],
            };
          }
        }

        return {
          content: [{ type: 'text' as const, text: output }],
        };

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Inspect record failed: ${errorMsg}` }],
        };
      }
    }
  );

  console.error('[PipelineTool] Registered 2 pipeline tools: pipeline_preview, inspect_record');
}
