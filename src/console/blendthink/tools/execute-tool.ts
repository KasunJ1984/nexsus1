/**
 * Blendthink Execute MCP Tool
 *
 * Exposes blendthink's full execution pipeline as an MCP tool
 * for testing in claude.ai.
 *
 * Usage:
 *   blendthink_execute({ query: "Find hospital projects in Victoria" })
 *
 * Returns:
 *   - Synthesized response from Claude
 *   - Source attributions
 *   - Section results summary
 *   - Session information
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BlendthinkEngine } from '../engine.js';
import { isClaudeAvailable } from '../claude-client.js';
import type { BlendResult } from '../../../common/types.js';

// =============================================================================
// SCHEMA
// =============================================================================

const ExecuteSchema = z.object({
  query: z.string().min(1).describe('The query to execute through blendthink'),
  session_id: z.string().optional().describe('Optional session ID to continue a conversation'),
});

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

let engineInstance: BlendthinkEngine | null = null;
let engineCreateCount = 0;

/**
 * Get or create the BlendthinkEngine instance
 */
function getEngine(): BlendthinkEngine {
  if (!engineInstance) {
    engineCreateCount++;
    console.error(`[execute-tool] Creating BlendthinkEngine instance #${engineCreateCount}`);
    engineInstance = new BlendthinkEngine();
  }
  return engineInstance;
}

/**
 * Get engine stats for debugging
 */
function getEngineStats(engine: BlendthinkEngine, sessionId?: string): string {
  const sessionCount = (engine as unknown as { sessions: Map<string, unknown> }).sessions?.size || 0;
  const hasSession = sessionId ? (engine as unknown as { sessions: Map<string, unknown> }).sessions?.has(sessionId) : false;
  return `[DEBUG] Engine #${engineCreateCount}, Sessions: ${sessionCount}, SessionId provided: ${sessionId ? 'yes' : 'no'}, Session found: ${hasSession}`;
}

/**
 * Register the blendthink_execute tool with the MCP server
 */
export function registerBlendthinkExecuteTool(server: McpServer): void {
  server.tool(
    'blendthink_execute',
    `Execute a query through the full blendthink pipeline. Analyzes the query, routes to relevant sections, retrieves data, and synthesizes a response using Claude API. Requires ANTHROPIC_API_KEY.`,
    ExecuteSchema.shape,
    async ({ query, session_id }) => {
      try {
        // Check Claude availability
        if (!isClaudeAvailable()) {
          return {
            content: [{
              type: 'text',
              text: formatUnavailable(),
            }],
            isError: true,
          };
        }

        const engine = getEngine();

        // Get debug stats BEFORE execution
        const debugStats = getEngineStats(engine, session_id);
        console.error(debugStats);

        const result = await engine.execute(query, session_id);

        // Get debug info AFTER execution
        const drilldownDebug = engine.getLastDrilldownDebug();
        const enrichmentDebug = engine.getLastEnrichmentDebug();

        // Format the response with debug info
        const debugSection = `\n\n---\n**Debug (before):** ${debugStats}\n**Enrichment:** ${enrichmentDebug || 'N/A'}\n**Drilldown trace:** ${drilldownDebug || 'N/A'}`;
        const response = formatResult(query, result) + debugSection;

        return {
          content: [{ type: 'text', text: response }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error executing query: ${message}` }],
          isError: true,
        };
      }
    }
  );

  console.error('[Blendthink] Registered blendthink_execute tool');
}

// =============================================================================
// FORMATTING
// =============================================================================

/**
 * Format unavailable message
 */
function formatUnavailable(): string {
  return `# Blendthink Unavailable

The Claude API is required for blendthink execution.

**To enable:**
1. Set the \`ANTHROPIC_API_KEY\` environment variable
2. Restart the MCP server

**Alternative:**
Use \`blendthink_diagnose\` to test query analysis without Claude API.`;
}

/**
 * Sanitize response by removing internal tags that shouldn't be user-facing
 *
 * Claude's synthesis may sometimes include XML-like tags for internal organization.
 * These should be stripped before presenting to the user.
 */
function sanitizeResponse(response: string): string {
  // Remove any XML-like tags that might leak (e.g., <blendthink>, <thinking>, <internal>)
  // Pattern: <tagname>content</tagname> or <tagname/>
  const xmlTagPattern = /<\/?(?:blendthink|thinking|internal|reasoning|analysis|debug|metadata|context)[^>]*>/gi;
  let sanitized = response.replace(xmlTagPattern, '');

  // Also remove JSON blocks wrapped in these tags (content between opening and closing)
  // Pattern: <blendthink>...json...</blendthink>
  const wrappedContentPattern = /<(blendthink|thinking|internal|reasoning|analysis|debug|metadata|context)>[\s\S]*?<\/\1>/gi;
  sanitized = sanitized.replace(wrappedContentPattern, '');

  // Clean up any resulting multiple newlines
  sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

  // Trim leading/trailing whitespace
  return sanitized.trim();
}

/**
 * Format execution result for display
 */
function formatResult(query: string, result: BlendResult): string {
  const lines: string[] = [];

  // Header
  lines.push('# Blendthink Response');
  lines.push('');
  lines.push(`**Query:** "${query}"`);
  lines.push(`**Persona:** ${result.persona}`);
  lines.push(`**Confidence:** ${(result.confidence * 100).toFixed(0)}%`);
  lines.push('');

  // Check for clarification needed
  if (result.needsClarification) {
    lines.push('## Clarification Needed');
    lines.push('');
    lines.push(sanitizeResponse(result.response));
    lines.push('');
    return lines.join('\n');
  }

  // Check for error
  if (result.error) {
    lines.push('## Error');
    lines.push('');
    lines.push(`⚠️ ${result.error}`);
    lines.push('');
    return lines.join('\n');
  }

  // Response (sanitize to remove any internal tags from Claude synthesis)
  lines.push('## Response');
  lines.push('');
  lines.push(sanitizeResponse(result.response));
  lines.push('');

  // Sources
  if (result.sources.length > 0) {
    lines.push('## Sources');
    lines.push('');
    lines.push('| Section | Tool | Contribution | Data Points |');
    lines.push('|---------|------|--------------|-------------|');
    for (const source of result.sources) {
      const dataPoints = source.dataPoints ? source.dataPoints.toString() : '-';
      lines.push(`| ${source.section} | ${source.tool} | ${source.contribution} | ${dataPoints} |`);
    }
    lines.push('');
  }

  // Section Results
  if (result.sectionResults.length > 0) {
    lines.push('## Section Execution');
    lines.push('');
    for (const sr of result.sectionResults) {
      const status = sr.success ? '✅' : '❌';
      const records = sr.recordCount ? `(${sr.recordCount} records)` : '';
      const error = sr.error ? ` - ${sr.error}` : '';
      lines.push(`- ${status} **${sr.section}/${sr.tool}** ${records}${error}`);
    }
    lines.push('');
  }

  // Session Info
  lines.push('## Session');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| **Session ID** | \`${result.session.sessionId.substring(0, 8)}...\` |`);
  lines.push(`| **Turns Used** | ${result.session.turnsUsed} |`);
  lines.push(`| **Turns Remaining** | ${result.session.turnsRemaining} |`);
  lines.push(`| **Tokens Used** | ${result.session.tokenUsage.total.toLocaleString()} / ${result.session.tokenUsage.budget.toLocaleString()} |`);
  lines.push('');

  // Timing
  lines.push('## Performance');
  lines.push('');
  lines.push(`Total execution time: **${result.timing.totalMs}ms**`);
  lines.push('');

  // Continue conversation hint
  lines.push('---');
  lines.push('');
  lines.push(`To continue this conversation, use session_id: \`${result.session.sessionId}\``);

  return lines.join('\n');
}
