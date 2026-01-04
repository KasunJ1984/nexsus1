/**
 * Blendthink Diagnose MCP Tool
 *
 * Exposes blendthink's diagnostic capabilities as an MCP tool
 * for testing in claude.ai.
 *
 * Usage:
 *   blendthink_diagnose({ query: "Find hospital projects in Victoria" })
 *
 * Returns:
 *   - Question type classification
 *   - Confidence score
 *   - Extracted entities
 *   - Route plan (which sections to query)
 *   - Selected persona with traits
 *   - Warnings if any
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BlendthinkEngine } from '../engine.js';

// =============================================================================
// SCHEMA
// =============================================================================

const DiagnoseSchema = z.object({
  query: z.string().min(1).describe('The query to analyze and diagnose'),
});

// =============================================================================
// TOOL REGISTRATION
// =============================================================================

let engineInstance: BlendthinkEngine | null = null;

/**
 * Get or create the BlendthinkEngine instance
 */
function getEngine(): BlendthinkEngine {
  if (!engineInstance) {
    engineInstance = new BlendthinkEngine();
  }
  return engineInstance;
}

/**
 * Register the blendthink_diagnose tool with the MCP server
 */
export function registerBlendthinkDiagnoseTool(server: McpServer): void {
  server.tool(
    'blendthink_diagnose',
    'Analyze a query using the blendthink engine. Shows question classification, routing plan, and persona selection. Use this to understand how blendthink would process any query.',
    DiagnoseSchema.shape,
    async ({ query }) => {
      try {
        const engine = getEngine();
        const diagnosis = await engine.diagnose(query);

        // Format the response
        const response = formatDiagnosis(query, diagnosis);

        return {
          content: [{ type: 'text', text: response }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error diagnosing query: ${message}` }],
          isError: true,
        };
      }
    }
  );

  console.error('[Blendthink] Registered blendthink_diagnose tool');
}

// =============================================================================
// FORMATTING
// =============================================================================

interface DiagnosisResult {
  query: string;
  analysis: {
    type: string;
    confidence: number;
    entities: string[];
    operation?: string;
    fieldHints?: string[];
    modelHints?: string[];
    groupByHints?: string[];
    needsClarification?: boolean;
    clarificationQuestions?: string[];
    // Entity Resolution Layer enrichments
    wasEnriched?: boolean;
    resolvedModel?: { modelName: string; confidence: number; source: string };
    resolvedFilters?: Array<{ field: string; op: string; value: unknown }>;
    resolvedAggregations?: Array<{ field: string; op: string; alias: string }>;
    dateResolutions?: Array<{ type: string; from: string; to?: string; originalText: string }>;
    resolutionConfidence?: number;
    resolutionWarnings?: string[];
    // Drilldown detection
    isDrilldown?: boolean;
    drilldownOperation?: 'regroup' | 'expand' | 'export' | 'filter' | 'sort';
    drilldownGroupBy?: string[];
    drilldownExpandKey?: string;
  };
  routePlan: {
    steps: Array<{
      section: string;
      tool: string;
      reason: string;
      order: number;
      dependsOnPrevious: boolean;
    }>;
    skipped: Array<{ section: string; reason: string }>;
    estimatedTokens: number;
    canParallelize: boolean;
  };
  persona: {
    name: string;
    description: string;
    type: string;
    traits: {
      claimPrefix?: string;
      evidenceEmphasis: string;
      asksFollowUps: boolean;
    };
  };
  estimatedTokens: number;
  warnings: string[];
}

/**
 * Format diagnosis result for display
 */
function formatDiagnosis(query: string, diagnosis: DiagnosisResult): string {
  const lines: string[] = [];

  // Header
  lines.push('# Blendthink Diagnosis');
  lines.push('');
  lines.push(`**Query:** "${query}"`);
  lines.push('');

  // Question Analysis
  lines.push('## Question Analysis');
  lines.push('');
  lines.push(`| Aspect | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| **Type** | \`${diagnosis.analysis.type}\` |`);
  lines.push(`| **Confidence** | ${(diagnosis.analysis.confidence * 100).toFixed(0)}% |`);
  lines.push(`| **Entities** | ${diagnosis.analysis.entities.length > 0 ? diagnosis.analysis.entities.join(', ') : '_(none detected)_'} |`);

  if (diagnosis.analysis.operation) {
    lines.push(`| **Operation** | ${diagnosis.analysis.operation} |`);
  }
  if (diagnosis.analysis.modelHints && diagnosis.analysis.modelHints.length > 0) {
    lines.push(`| **Model Hints** | ${diagnosis.analysis.modelHints.join(', ')} |`);
  }
  if (diagnosis.analysis.fieldHints && diagnosis.analysis.fieldHints.length > 0) {
    lines.push(`| **Field Hints** | ${diagnosis.analysis.fieldHints.join(', ')} |`);
  }
  if (diagnosis.analysis.groupByHints && diagnosis.analysis.groupByHints.length > 0) {
    lines.push(`| **GROUP BY Hints** | ${diagnosis.analysis.groupByHints.join(', ')} |`);
  }
  // Drilldown detection
  if (diagnosis.analysis.isDrilldown) {
    lines.push(`| **Is Drilldown** | ✅ Yes |`);
    lines.push(`| **Drilldown Operation** | \`${diagnosis.analysis.drilldownOperation}\` |`);
    if (diagnosis.analysis.drilldownGroupBy && diagnosis.analysis.drilldownGroupBy.length > 0) {
      lines.push(`| **Drilldown GroupBy** | ${diagnosis.analysis.drilldownGroupBy.join(', ')} |`);
    }
    if (diagnosis.analysis.drilldownExpandKey) {
      lines.push(`| **Drilldown ExpandKey** | ${diagnosis.analysis.drilldownExpandKey} |`);
    }
  } else {
    lines.push(`| **Is Drilldown** | ❌ No |`);
  }
  lines.push('');

  // Entity Resolution Results (if enriched)
  if (diagnosis.analysis.wasEnriched) {
    lines.push('## Entity Resolution');
    lines.push('');
    lines.push(`| Aspect | Value |`);
    lines.push(`|--------|-------|`);

    if (diagnosis.analysis.resolvedModel) {
      lines.push(`| **Resolved Model** | \`${diagnosis.analysis.resolvedModel.modelName}\` (${(diagnosis.analysis.resolvedModel.confidence * 100).toFixed(0)}% confidence, ${diagnosis.analysis.resolvedModel.source}) |`);
    }

    if (diagnosis.analysis.dateResolutions && diagnosis.analysis.dateResolutions.length > 0) {
      const dateInfo = diagnosis.analysis.dateResolutions.map(d =>
        `"${d.originalText}" → ${d.from}${d.to ? ` to ${d.to}` : ''}`
      ).join(', ');
      lines.push(`| **Date Resolutions** | ${dateInfo} |`);
    }

    if (diagnosis.analysis.resolvedFilters && diagnosis.analysis.resolvedFilters.length > 0) {
      const filterCount = diagnosis.analysis.resolvedFilters.length;
      lines.push(`| **Resolved Filters** | ${filterCount} filter(s) |`);
    }

    if (diagnosis.analysis.resolvedAggregations && diagnosis.analysis.resolvedAggregations.length > 0) {
      const aggInfo = diagnosis.analysis.resolvedAggregations.map(a =>
        `${a.op.toUpperCase()}(${a.field})`
      ).join(', ');
      lines.push(`| **Resolved Aggregations** | ${aggInfo} |`);
    }

    if (diagnosis.analysis.resolutionConfidence !== undefined) {
      lines.push(`| **Resolution Confidence** | ${(diagnosis.analysis.resolutionConfidence * 100).toFixed(0)}% |`);
    }
    lines.push('');

    // Show filter details
    if (diagnosis.analysis.resolvedFilters && diagnosis.analysis.resolvedFilters.length > 0) {
      lines.push('### Resolved Filters');
      lines.push('');
      lines.push('```');
      for (const f of diagnosis.analysis.resolvedFilters) {
        const valueStr = Array.isArray(f.value)
          ? `[${(f.value as unknown[]).slice(0, 3).join(', ')}${(f.value as unknown[]).length > 3 ? '...' : ''}]`
          : String(f.value);
        lines.push(`${f.field} ${f.op} ${valueStr}`);
      }
      lines.push('```');
      lines.push('');
    }
  }

  // Route Plan
  lines.push('## Route Plan');
  lines.push('');
  lines.push('**Execution Order:**');
  for (const step of diagnosis.routePlan.steps) {
    const depends = step.dependsOnPrevious ? ' _(depends on previous)_' : '';
    lines.push(`${step.order}. **${step.section}/** → \`${step.tool}\`${depends}`);
    lines.push(`   - ${step.reason}`);
  }
  lines.push('');

  if (diagnosis.routePlan.skipped.length > 0) {
    lines.push('**Skipped Sections:**');
    for (const skip of diagnosis.routePlan.skipped) {
      lines.push(`- ~~${skip.section}/~~ - ${skip.reason}`);
    }
    lines.push('');
  }

  lines.push(`**Parallelizable:** ${diagnosis.routePlan.canParallelize ? 'Yes' : 'No'}`);
  lines.push(`**Estimated Tokens:** ${diagnosis.estimatedTokens.toLocaleString()}`);
  lines.push('');

  // Persona
  lines.push('## Selected Persona');
  lines.push('');
  lines.push(`| Trait | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Name** | ${diagnosis.persona.name} |`);
  lines.push(`| **Style** | ${diagnosis.persona.description} |`);
  lines.push(`| **Evidence Emphasis** | ${diagnosis.persona.traits.evidenceEmphasis} |`);
  lines.push(`| **Asks Follow-ups** | ${diagnosis.persona.traits.asksFollowUps ? 'Yes' : 'No'} |`);
  if (diagnosis.persona.traits.claimPrefix) {
    lines.push(`| **Claim Prefix** | "${diagnosis.persona.traits.claimPrefix}" |`);
  }
  lines.push('');

  // Warnings
  if (diagnosis.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of diagnosis.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  // Clarification
  if (diagnosis.analysis.needsClarification) {
    lines.push('## Clarification Needed');
    lines.push('');
    lines.push('The query is ambiguous. Suggested questions:');
    for (const question of diagnosis.analysis.clarificationQuestions || []) {
      lines.push(`- ${question}`);
    }
    lines.push('');
  }

  // Summary
  lines.push('---');
  lines.push('');
  lines.push('**Summary:** ');
  if (diagnosis.analysis.confidence >= 0.8) {
    lines.push(`High confidence \`${diagnosis.analysis.type}\` query. Would route through ${diagnosis.routePlan.steps.map(s => s.section).join(' → ')} using ${diagnosis.persona.name} persona.`);
  } else if (diagnosis.analysis.confidence >= 0.5) {
    lines.push(`Medium confidence classification. May need clarification before proceeding.`);
  } else {
    lines.push(`Low confidence - query needs clarification before blendthink can process effectively.`);
  }

  return lines.join('\n');
}
