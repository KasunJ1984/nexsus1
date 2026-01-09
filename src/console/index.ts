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
import { registerRefreshSchemaTool } from '../common/tools/refresh-schema-tool.js';
import { initializeConversationMemory, shutdownConversationMemory } from './blendthink/conversation-memory.js';
import { initializeEmbeddingService, isEmbeddingServiceAvailable } from '../common/services/embedding-service.js';
import { initializeVectorClient, validateQdrantConnection, isVectorClientAvailable } from '../common/services/vector-client.js';
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

// Register refresh schema tool (refresh_schema) for on-demand cache refresh
registerRefreshSchemaTool(server);

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

/**
 * Service initialization status for health reporting
 */
interface ServiceStatus {
  embedding: { ready: boolean; error?: string };
  qdrant: { ready: boolean; canConnect: boolean; collectionExists: boolean; error?: string };
  schema: { ready: boolean; error?: string };
}

// Global service status for health check tool
let serviceStatus: ServiceStatus = {
  embedding: { ready: false },
  qdrant: { ready: false, canConnect: false, collectionExists: false },
  schema: { ready: false },
};

/**
 * Get current service status for health checks
 */
export function getServiceStatus(): ServiceStatus {
  return serviceStatus;
}

async function initializeServices(): Promise<void> {
  console.error('[Init] Initializing services...');
  console.error('[Init] ========================================');

  // Check critical environment variables upfront
  const envWarnings: string[] = [];
  if (!process.env.VOYAGE_API_KEY) {
    envWarnings.push('VOYAGE_API_KEY not set - embedding/search will fail');
  }
  if (!process.env.QDRANT_HOST) {
    envWarnings.push('QDRANT_HOST not set - using default localhost:6333');
  }

  if (envWarnings.length > 0) {
    console.error('[Init] ⚠️  ENVIRONMENT WARNINGS:');
    envWarnings.forEach(w => console.error(`[Init]    - ${w}`));
    console.error('[Init] ----------------------------------------');
  }

  // 1. Initialize embedding service (Voyage AI)
  const embeddingReady = initializeEmbeddingService();
  serviceStatus.embedding.ready = embeddingReady;
  if (!embeddingReady) {
    serviceStatus.embedding.error = 'VOYAGE_API_KEY not set or invalid';
    console.error('[Init] ❌ Embedding service FAILED - Set VOYAGE_API_KEY');
  } else {
    console.error('[Init] ✓ Embedding service ready (Voyage AI)');
  }

  // 2. Initialize vector client (Qdrant)
  const vectorReady = initializeVectorClient();
  if (!vectorReady) {
    serviceStatus.qdrant.error = 'Failed to create Qdrant client - check QDRANT_HOST';
    console.error('[Init] ❌ Vector client FAILED - Check QDRANT_HOST');
  } else {
    console.error('[Init] ✓ Vector client initialized');

    // 2b. Validate Qdrant connection (actually try to connect)
    const qdrantValidation = await validateQdrantConnection();
    serviceStatus.qdrant = {
      ready: qdrantValidation.healthy,
      canConnect: qdrantValidation.canConnect,
      collectionExists: qdrantValidation.collectionExists,
      error: qdrantValidation.error,
    };

    if (qdrantValidation.healthy) {
      console.error(`[Init] ✓ Qdrant connection healthy (${qdrantValidation.host})`);
      console.error(`[Init] ✓ Collection '${qdrantValidation.collectionName}' exists`);
    } else if (qdrantValidation.canConnect && !qdrantValidation.collectionExists) {
      console.error(`[Init] ⚠️  Qdrant connected but collection not found`);
      console.error(`[Init]    Run: npm run sync -- sync schema`);
    } else {
      console.error(`[Init] ❌ Qdrant connection FAILED: ${qdrantValidation.error}`);
    }
  }

  // 3. Initialize schema lookup for query validation
  try {
    initializeSchemaLookup();
    serviceStatus.schema.ready = true;
    console.error('[Init] ✓ Schema lookup initialized');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    serviceStatus.schema.error = errMsg;
    console.error('[Init] ⚠️  Schema lookup deferred - will initialize on first query');
  }

  // 4. Initialize NEXUS Analytics (Self-Improving System)
  try {
    const stats = getSchemaStats();
    const schemaHash = `v1-${stats.totalFields}-${stats.models}`;
    initializeAnalytics(schemaHash);
    console.error(`[Init] ✓ Analytics initialized (schema: ${schemaHash})`);
  } catch (err) {
    console.error('[Init] ⚠️  Analytics deferred - schema not loaded');
  }

  // 5. Initialize Training Data Collection
  initializeTrainingData();
  console.error('[Init] ✓ Training data collection ready');

  // 6. Initialize Blendthink Conversation Memory
  try {
    initializeConversationMemory();
    console.error('[Init] ✓ Conversation memory ready');
  } catch (err) {
    console.error('[Init] ⚠️  Conversation memory init failed:', err);
  }

  // Summary
  console.error('[Init] ========================================');
  const criticalOk = serviceStatus.embedding.ready && serviceStatus.qdrant.ready;
  if (criticalOk) {
    console.error('[Init] ✓ All critical services ready');
  } else {
    console.error('[Init] ⚠️  SOME SERVICES NOT READY - Tools may fail!');
    if (!serviceStatus.embedding.ready) {
      console.error('[Init]    → Fix: Set VOYAGE_API_KEY environment variable');
    }
    if (!serviceStatus.qdrant.ready) {
      if (!serviceStatus.qdrant.canConnect) {
        console.error('[Init]    → Fix: Check QDRANT_HOST is reachable');
      } else if (!serviceStatus.qdrant.collectionExists) {
        console.error('[Init]    → Fix: Run "npm run sync -- sync schema" to create collection');
      }
    }
  }
  console.error('[Init] ========================================');
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
