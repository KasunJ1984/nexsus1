/**
 * Inspect Graph Edge Tool
 *
 * Allows inspection of Knowledge Graph edges including cascade_sources.
 * Use this to see FK relationship details, edge statistics, and validation metadata.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InspectGraphEdgeSchema } from '../schemas/index.js';
import { getRelationshipByFields } from '../services/knowledge-graph.js';

/**
 * Register the inspect_graph_edge tool
 *
 * @param server - MCP server instance to register the tool on
 */
export function registerInspectGraphEdgeTool(server: McpServer): void {
  server.tool(
    'inspect_graph_edge',
    `Inspect a Knowledge Graph edge to see FK relationship details.

**What it shows:**
- Edge statistics (edge_count, unique_targets)
- cascade_sources array (models that triggered discovery)
- Validation metadata (if FK validation has run)
- Full edge payload for debugging

**Examples:**
- { "source_model": "crm.lead", "target_model": "res.partner", "field_name": "partner_id" }
- { "source_model": "account.move.line", "target_model": "account.account", "field_name": "account_id" }

**Use cases:**
- Verify Stage 2 100-entry cascade limit is working
- Debug FK cascade chain issues
- Check validation timestamps and integrity scores`,
    InspectGraphEdgeSchema.shape,
    async ({ source_model, target_model, field_name }) => {
      const result = await getRelationshipByFields(source_model, target_model, field_name);

      if (!result.found) {
        return {
          content: [{
            type: 'text' as const,
            text: `**Graph Edge Not Found**\n\n${result.error}\n\n` +
              `**Possible causes:**\n` +
              `- The FK relationship doesn't exist in this Odoo instance\n` +
              `- The source model hasn't been synced yet\n` +
              `- The field name is incorrect (check with semantic_search)\n\n` +
              `**Try:**\n` +
              `- Run: \`npm run sync -- sync model ${source_model}\``
          }]
        };
      }

      const edge = result.edge!;
      const lines: string[] = [];

      // Header
      lines.push(`# Graph Edge: ${source_model}.${field_name} → ${target_model}`);
      lines.push('');
      lines.push(`**Point ID:** \`${result.pointId}\``);
      lines.push('');

      // Statistics
      lines.push('## Statistics');
      lines.push(`- **Edge Count:** ${edge.edge_count ?? 'N/A'}`);
      lines.push(`- **Unique Targets:** ${edge.unique_targets ?? 'N/A'}`);
      lines.push(`- **Is Leaf:** ${edge.is_leaf ? 'Yes' : 'No'}`);
      lines.push(`- **Depth from Origin:** ${edge.depth_from_origin ?? 0}`);
      lines.push(`- **Field Type:** ${edge.field_type ?? 'N/A'}`);
      lines.push(`- **Field Label:** ${edge.field_label ?? 'N/A'}`);
      lines.push('');

      // Cascade Sources
      lines.push('## Cascade Sources');
      const cascadeSources = edge.cascade_sources || [];
      if (cascadeSources.length > 0) {
        lines.push(`Last ${cascadeSources.length} model(s) that triggered discovery of this edge:`);
        lines.push('');
        for (const source of cascadeSources) {
          lines.push(`- ${source}`);
        }
      } else {
        lines.push('*No cascade sources recorded.*');
      }
      lines.push('');

      // Validation
      lines.push('## Validation');
      lines.push(`- **Last Validated:** ${edge.last_validation || 'Never'}`);
      if (edge.validation_integrity_score !== undefined) {
        lines.push(`- **Integrity Score:** ${edge.validation_integrity_score}%`);
      }
      if (edge.orphan_count !== undefined) {
        lines.push(`- **Orphan Count:** ${edge.orphan_count}`);
      }
      lines.push('');

      // Timestamps
      lines.push('## Timestamps');
      lines.push(`- **Last Cascade:** ${edge.last_cascade || 'Never'}`);
      lines.push('');

      // Raw Payload
      lines.push('## Raw Payload');
      lines.push('```json');
      lines.push(JSON.stringify(edge, null, 2));
      lines.push('```');

      return {
        content: [{
          type: 'text' as const,
          text: lines.join('\n')
        }]
      };
    }
  );
}
