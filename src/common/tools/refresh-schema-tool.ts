/**
 * Refresh Schema MCP Tool
 *
 * Allows on-demand schema cache refresh via Claude without server restart.
 * Essential for Railway users who can't run CLI commands.
 *
 * Created as part of Stage 3: Dynamic Schema Architecture
 * See docs/plans/dynamic-schema-architecture.md
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { refreshAllCaches, getCacheStatus, type RefreshResult } from '../services/schema-cache-manager.js';

/**
 * Schema for refresh_schema tool input
 */
export const RefreshSchemaSchema = z.object({
  /**
   * Whether to include detailed cache status in the response
   */
  include_status: z
    .boolean()
    .default(false)
    .describe('Include detailed cache status from all services'),
});

/**
 * Register the refresh_schema tool
 *
 * @param server - MCP server instance to register the tool on
 */
export function registerRefreshSchemaTool(server: McpServer): void {
  server.tool(
    'refresh_schema',
    `Refresh all schema caches to pick up changes from Excel files.

**When to use:**
- After modifying schema Excel files (Nexsus1_schema.xlsx)
- After modifying payload config (SAMPLE_payload_config.xlsx)
- When queries return stale/incorrect results
- After adding new models or fields

**What it does:**
- Clears all 10 schema-related caches in correct dependency order
- Reloads schema from Excel files
- Reports models added/removed since last refresh
- Returns timing and statistics

**Important:**
- This only refreshes IN-MEMORY caches on the running server
- It does NOT sync data to/from Qdrant (use CLI for that)
- Changes to Excel files must already be saved

**Example:**
\`{ "include_status": true }\``,
    RefreshSchemaSchema.shape,
    async ({ include_status }) => {
      const startTime = Date.now();

      try {
        // Perform the refresh
        const result: RefreshResult = refreshAllCaches();

        const lines: string[] = [];

        // Header with timing
        lines.push('# Schema Cache Refresh Complete');
        lines.push('');
        lines.push(`**Duration:** ${result.duration_ms}ms`);
        lines.push(`**Caches Cleared:** ${result.caches_cleared.length}`);
        lines.push('');

        // Model changes
        lines.push('## Models');
        lines.push(`- **Before:** ${result.models_before}`);
        lines.push(`- **After:** ${result.models_after}`);

        if (result.models_added.length > 0) {
          lines.push(`- **Added:** ${result.models_added.join(', ')}`);
        }
        if (result.models_removed.length > 0) {
          lines.push(`- **Removed:** ${result.models_removed.join(', ')}`);
        }
        lines.push('');

        // Field stats
        lines.push('## Fields Loaded');
        lines.push(`- **Total Fields:** ${result.fields_loaded}`);
        lines.push(`- **FK Fields:** ${result.fk_fields_loaded}`);
        lines.push('');

        // Caches cleared
        lines.push('## Caches Cleared');
        for (const cache of result.caches_cleared) {
          lines.push(`- ${cache}`);
        }
        lines.push('');

        // Optional detailed status
        if (include_status) {
          const status = getCacheStatus();
          lines.push('## Cache Status (After Refresh)');
          lines.push(`**Total Entries:** ${status.total_entries}`);
          lines.push(`**Timestamp:** ${status.timestamp}`);
          lines.push('');

          lines.push('### Services');
          for (const service of status.services) {
            lines.push(`**${service.name}:**`);
            lines.push('```json');
            lines.push(JSON.stringify(service.stats, null, 2));
            lines.push('```');
            lines.push('');
          }
        }

        // Usage hint
        lines.push('---');
        lines.push('*Schema caches refreshed. Queries will now use updated schema.*');

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n')
          }]
        };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const duration = Date.now() - startTime;

        return {
          content: [{
            type: 'text' as const,
            text: `# Schema Refresh Failed\n\n` +
              `**Error:** ${errorMessage}\n\n` +
              `**Duration:** ${duration}ms\n\n` +
              `**Troubleshooting:**\n` +
              `- Check that Excel files exist in samples/ directory\n` +
              `- Verify file permissions\n` +
              `- Check server logs for detailed error\n\n` +
              `If this persists, try restarting the server.`
          }]
        };
      }
    }
  );
}
