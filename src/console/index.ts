/**
 * odoo-vector-mcp - Odoo Schema Semantic Search MCP Server
 *
 * Redesigned for comprehensive Odoo schema search using semantic embeddings.
 * Searches 17,930 fields across 800+ models to find:
 * - Where data is stored
 * - Field relationships
 * - Data types and locations
 *
 * Phase 1: Schema semantic search
 * Phase 2: Will add data extraction using Odoo client
 *
 * Supports two transport modes:
 * - stdio: For Desktop Claude & Claude Code
 * - http: For Railway cloud deployment & Claude.ai browser
 */

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Request, Response } from 'express';
import { registerSearchTools } from '../semantic/tools/search-tool.js';
import { registerDataTools } from '../exact/tools/data-tool.js';
import { registerPipelineTools } from '../common/tools/pipeline-tool.js';
import { registerGraphTools } from '../common/tools/graph-tool.js';
import { registerNexsusSearchTool } from '../exact/tools/nexsus-search.js';
import { registerUrlBuilderTool } from '../common/tools/url-builder-tool.js';
import { registerInspectGraphEdgeTool } from '../common/tools/inspect-graph-edge.js';
import { registerBlendthinkDiagnoseTool } from './blendthink/tools/diagnose-tool.js';
import { registerBlendthinkExecuteTool } from './blendthink/tools/execute-tool.js';
import { initializeConversationMemory, shutdownConversationMemory } from './blendthink/conversation-memory.js';
import { initializeEmbeddingService } from '../common/services/embedding-service.js';
import { initializeVectorClient } from '../common/services/vector-client.js';
import { getSchemaStats } from '../common/services/schema-loader.js';
import { initializeSchemaLookup } from '../common/services/schema-lookup.js';
import {
  initializeAnalytics,
  initializeTrainingData,
  shutdownAnalytics,
  shutdownTrainingData,
  persistAnalytics,
  persistTrainingData,
} from '../semantic/services/analytics-service.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TRANSPORT = process.env.TRANSPORT || 'stdio';
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

// =============================================================================
// MCP SERVER INSTANCE
// =============================================================================

const server = new McpServer({
  name: 'odoo-vector-mcp',
  version: '0.2.0',
});

// Register search tools (semantic_search)
registerSearchTools(server);

// Register data tools (system_status, dlq_status, dlq_clear, update_model_payload)
registerDataTools(server);

// Register pipeline tools (pipeline_preview, inspect_record)
registerPipelineTools(server);

// Register graph traversal tools (graph_traverse)
registerGraphTools(server);

// Register graph edge inspection tool (inspect_graph_edge)
registerInspectGraphEdgeTool(server);

// Register nexsus search tool (nexsus_search) for precise data queries
registerNexsusSearchTool(server);

// Register URL builder tool (build_odoo_url) for generating Odoo web links
registerUrlBuilderTool(server);

// Register blendthink diagnostic tool (blendthink_diagnose) for testing query analysis
registerBlendthinkDiagnoseTool(server);

// Register blendthink execute tool (blendthink_execute) for full query execution
registerBlendthinkExecuteTool(server);

// =============================================================================
// STDIO TRANSPORT (for Desktop Claude & Claude Code)
// =============================================================================

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('odoo-vector-mcp running on stdio');

  // Initialize services asynchronously (non-blocking)
  initializeServices()
    .then(() => console.error('Services initialized successfully'))
    .catch(err => console.error('Service initialization error:', err instanceof Error ? err.message : err));
}

// =============================================================================
// HTTP TRANSPORT (for Railway & Claude.ai browser)
// =============================================================================

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS headers for browser access
  app.use((_req: Request, res: Response, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'odoo-vector-mcp',
      version: '0.2.0',
      transport: 'http',
      description: 'Odoo Schema Semantic Search'
    });
  });

  // MCP endpoint - stateless, creates new transport per request
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
        enableJsonResponse: true
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // CORS preflight
  app.options('/mcp', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  // Initialize services before starting server
  await initializeServices();

  app.listen(PORT, HOST, () => {
    console.error(`odoo-vector-mcp running on http://${HOST}:${PORT}/mcp`);
    console.error('Endpoints:');
    console.error(`  GET  /health - Health check`);
    console.error(`  POST /mcp    - MCP endpoint`);
    console.error('');
    console.error('MCP Tools (Query-focused, fast):');
    console.error('  - semantic_search: Search Odoo schema/data semantically');
    console.error('  - nexsus_search: Execute precise data queries with filtering/aggregation');
    console.error('  - graph_traverse: Navigate FK relationships in knowledge graph');
    console.error('  - pipeline_preview: Preview pipeline transformation for a model');
    console.error('  - inspect_record: Retrieve and inspect a record from Qdrant');
    console.error('  - system_status: Check data, pipeline, health, metrics');
    console.error('  - dlq_status: Check Dead Letter Queue status');
    console.error('  - dlq_clear: Clear failed records from DLQ');
    console.error('  - update_model_payload: Update payload without re-embedding');
    console.error('  - build_odoo_url: Generate clickable Odoo web URLs');
    console.error('');
    console.error('CLI Commands (Sync-focused, long-running):');
    console.error('  Run: npm run sync -- <command>');
    console.error('  - sync model <model_name>: Sync model with FK cascade');
    console.error('  - sync schema: Sync schema from Excel');
    console.error('  - cleanup <model_name>: Remove deleted records');
    console.error('  - validate-fk: Validate FK integrity');
    console.error('  - status: Show system status');
  });
}

// =============================================================================
// SERVICE INITIALIZATION
// =============================================================================

async function initializeServices(): Promise<void> {
  console.error('[Init] Initializing services...');

  // 1. Initialize embedding service (Voyage AI)
  const embeddingReady = initializeEmbeddingService();
  if (!embeddingReady) {
    console.error('[Init] Warning: Embedding service not available. Set VOYAGE_API_KEY.');
  } else {
    console.error('[Init] Embedding service ready');
  }

  // 2. Initialize vector client (Qdrant)
  const vectorReady = initializeVectorClient();
  if (!vectorReady) {
    console.error('[Init] Warning: Vector client not available. Check QDRANT_HOST.');
  } else {
    console.error('[Init] Vector client ready');
  }

  // 3. Initialize schema lookup for query validation
  try {
    initializeSchemaLookup();
    console.error('[Init] Schema lookup initialized for query validation');
  } catch (err) {
    console.error('[Init] Schema lookup deferred - will initialize on first query');
  }

  // 4. Initialize NEXUS Analytics (Self-Improving System)
  // Creates a schema hash based on field count to detect changes
  try {
    const stats = getSchemaStats();
    const schemaHash = `v1-${stats.totalFields}-${stats.models}`;
    initializeAnalytics(schemaHash);
    console.error(`[Init] NEXUS Analytics initialized (schema hash: ${schemaHash})`);
  } catch (err) {
    console.error('[Init] Analytics init skipped - schema not loaded yet');
  }

  // 5. Initialize Training Data Collection (Phase 2 Preparation)
  initializeTrainingData();
  console.error('[Init] Training data collection initialized');

  // 6. Initialize Blendthink Conversation Memory
  try {
    initializeConversationMemory();
    console.error('[Init] Blendthink conversation memory initialized');
  } catch (err) {
    console.error('[Init] Conversation memory init failed:', err);
  }

  // Note: Schema collection is initialized via the 'sync' tool
  // Use sync with action="full_sync" to upload schema data
  console.error('[Init] Use sync tool with action="full_sync" to upload schema');
}

// =============================================================================
// SHUTDOWN HANDLERS
// =============================================================================

/**
 * Graceful shutdown handler
 * Persists analytics and training data before exit
 */
function setupShutdownHandlers(): void {
  const shutdown = () => {
    console.error('[Shutdown] Persisting analytics, training data, and conversations...');
    shutdownAnalytics();
    shutdownTrainingData();
    shutdownConversationMemory();
    process.exit(0);
  };

  // Handle various shutdown signals
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('beforeExit', () => {
    persistAnalytics();
    persistTrainingData();
  });
}

// =============================================================================
// ENTRY POINT
// =============================================================================

// Setup shutdown handlers for graceful persistence
setupShutdownHandlers();

if (TRANSPORT === 'http') {
  runHttp().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
