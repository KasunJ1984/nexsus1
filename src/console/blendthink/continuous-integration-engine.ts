/**
 * Continuous Integration Engine
 *
 * Unlike traditional "gather all → synthesize once" approach,
 * this engine updates understanding as each result arrives.
 *
 * Features:
 * - Running hypothesis that builds incrementally
 * - Claude can request more data if gaps detected
 * - Dynamic route modification based on findings
 * - Parallel execution where possible
 *
 * Human Parallel: As you read a report, understanding builds page-by-page,
 * not all-at-once at the end.
 */

import type {
  QuestionAnalysis,
  RoutePlan,
  RouteStep,
  BlendSection,
  SectionResult,
} from '../../common/types.js';
import { getAdapter } from './section-adapters/index.js';
import { getClaudeClient, isClaudeAvailable } from './claude-client.js';
import { recordSectionExecution } from './metrics.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Running hypothesis state
 */
export interface Hypothesis {
  /** Current understanding text */
  understanding: string;

  /** Confidence level (0-1) */
  confidence: number;

  /** Gaps identified that need more data */
  gaps: string[];

  /** Sections that have contributed */
  contributingSections: BlendSection[];

  /** Evidence collected so far */
  evidence: Array<{
    section: BlendSection;
    summary: string;
    recordCount: number;
  }>;
}

/**
 * Hypothesis update result from Claude
 */
export interface HypothesisUpdate {
  /** Updated hypothesis */
  newHypothesis: Hypothesis;

  /** Whether more data is needed */
  needsMoreData: boolean;

  /** Which section to query next (if needsMoreData) */
  requestedSection?: BlendSection;

  /** Query for the requested section */
  requestedQuery?: string;

  /** Reason for requesting more data */
  requestReason?: string;
}

/**
 * Continuous integration result
 */
export interface ContinuousIntegrationResult {
  /** Final synthesized response */
  response: string;

  /** Final hypothesis state */
  hypothesis: Hypothesis;

  /** All section results collected */
  sectionResults: SectionResult[];

  /** Total Claude API calls made */
  claudeCallCount: number;

  /** Total execution time */
  durationMs: number;

  /** Whether dynamic requests were made */
  hadDynamicRequests: boolean;
}

// =============================================================================
// CONTINUOUS INTEGRATION ENGINE
// =============================================================================

export class ContinuousIntegrationEngine {
  private readonly MAX_DYNAMIC_REQUESTS = 2;
  private readonly MAX_HYPOTHESIS_UPDATES = 6;

  private runningHypothesis: Hypothesis;
  private collectedEvidence: SectionResult[] = [];
  private requestedSections: Set<string> = new Set();
  private claudeCallCount = 0;

  constructor() {
    this.runningHypothesis = this.createInitialHypothesis();
  }

  /**
   * Execute with continuous integration
   *
   * Instead of gathering all results and synthesizing once,
   * we update understanding after each section result.
   */
  async execute(
    query: string,
    analysis: QuestionAnalysis,
    initialRoute: RoutePlan,
    systemPrompt: string
  ): Promise<ContinuousIntegrationResult> {
    const startTime = Date.now();
    let hadDynamicRequests = false;

    // Reset state for new execution
    this.runningHypothesis = this.createInitialHypothesis();
    this.collectedEvidence = [];
    this.requestedSections = new Set();
    this.claudeCallCount = 0;

    // Step 1: Initialize hypothesis with Claude
    console.error('[CIEngine] Initializing hypothesis...');
    await this.initializeHypothesis(query, analysis, systemPrompt);

    // Step 2: Execute initial route steps
    const allSteps = [...initialRoute.steps];

    for (let i = 0; i < allSteps.length && this.claudeCallCount < this.MAX_HYPOTHESIS_UPDATES; i++) {
      const step = allSteps[i];

      // Execute the section
      console.error(`[CIEngine] Executing: ${step.section}/${step.tool}`);
      const result = await this.executeSection(step, analysis);
      this.collectedEvidence.push(result);

      // Update hypothesis with this result
      const update = await this.updateHypothesis(result, query, systemPrompt);

      // Check if Claude wants more data
      if (update.needsMoreData && this.requestedSections.size < this.MAX_DYNAMIC_REQUESTS) {
        hadDynamicRequests = true;
        const additionalSection = update.requestedSection;

        if (additionalSection && !this.requestedSections.has(additionalSection)) {
          this.requestedSections.add(additionalSection);
          console.error(`[CIEngine] Dynamic request: ${additionalSection} (${update.requestReason})`);

          // Add dynamic step to route
          const dynamicStep = this.createDynamicStep(
            additionalSection,
            update.requestedQuery || query
          );
          allSteps.push(dynamicStep);
        }
      }
    }

    // Step 3: Build final response from hypothesis
    const response = this.buildFinalResponse();

    return {
      response,
      hypothesis: this.runningHypothesis,
      sectionResults: this.collectedEvidence,
      claudeCallCount: this.claudeCallCount,
      durationMs: Date.now() - startTime,
      hadDynamicRequests,
    };
  }

  /**
   * Initialize hypothesis with query understanding
   */
  private async initializeHypothesis(
    query: string,
    analysis: QuestionAnalysis,
    systemPrompt: string
  ): Promise<void> {
    if (!isClaudeAvailable()) {
      // Fallback: Create simple hypothesis without Claude
      this.runningHypothesis = {
        understanding: `Investigating: ${query}`,
        confidence: 0.3,
        gaps: ['Data not yet collected'],
        contributingSections: [],
        evidence: [],
      };
      return;
    }

    try {
      const claudeClient = getClaudeClient();
      this.claudeCallCount++;

      const initPrompt = `${systemPrompt}

You are starting a new investigation. The user asked:
"${query}"

Question type: ${analysis.type}
Entities detected: ${analysis.entities.join(', ') || 'none'}

Form an initial hypothesis about what the user needs. Keep it brief (1-2 sentences).
Identify what data gaps need to be filled to answer this question.

Respond in JSON format:
{
  "understanding": "Brief initial hypothesis",
  "confidence": 0.3,
  "gaps": ["gap 1", "gap 2"]
}`;

      const response = await claudeClient.complete(initPrompt, { maxTokens: 500 });

      // Parse response
      try {
        const parsed = JSON.parse(response);
        this.runningHypothesis = {
          understanding: parsed.understanding || `Investigating: ${query}`,
          confidence: parsed.confidence || 0.3,
          gaps: parsed.gaps || [],
          contributingSections: [],
          evidence: [],
        };
      } catch {
        this.runningHypothesis = {
          understanding: `Investigating: ${query}`,
          confidence: 0.3,
          gaps: [],
          contributingSections: [],
          evidence: [],
        };
      }

      console.error(`[CIEngine] Initial hypothesis: ${this.runningHypothesis.understanding.substring(0, 100)}...`);
    } catch (error) {
      console.error('[CIEngine] Hypothesis init failed:', error);
      this.runningHypothesis = {
        understanding: `Investigating: ${query}`,
        confidence: 0.3,
        gaps: [],
        contributingSections: [],
        evidence: [],
      };
    }
  }

  /**
   * Update hypothesis with new section result
   */
  private async updateHypothesis(
    result: SectionResult,
    originalQuery: string,
    systemPrompt: string
  ): Promise<HypothesisUpdate> {
    if (!isClaudeAvailable() || !result.success) {
      // No Claude or failed result - minimal update
      return {
        newHypothesis: this.runningHypothesis,
        needsMoreData: false,
      };
    }

    try {
      const claudeClient = getClaudeClient();
      this.claudeCallCount++;

      // Summarize the result data
      const resultSummary = this.summarizeResult(result);

      const updatePrompt = `${systemPrompt}

ORIGINAL QUERY: "${originalQuery}"

CURRENT HYPOTHESIS:
"${this.runningHypothesis.understanding}"
Confidence: ${(this.runningHypothesis.confidence * 100).toFixed(0)}%
Gaps: ${this.runningHypothesis.gaps.join(', ') || 'none identified'}

NEW EVIDENCE from ${result.section}/${result.tool}:
${resultSummary}

Update your hypothesis based on this new evidence.
Does this fill any gaps? Do you need more data from another section?

Available sections to request:
- semantic: Natural language search
- exact: Precise queries, aggregation
- knowledge: KPIs, benchmarks, domain rules
- common: Graph traversal, relationships

Respond in JSON:
{
  "understanding": "Updated hypothesis incorporating new evidence",
  "confidence": 0.0-1.0,
  "gaps": ["remaining gaps"],
  "needsMoreData": true/false,
  "requestedSection": "section_name (if needsMoreData)",
  "requestedQuery": "what to look for (if needsMoreData)",
  "requestReason": "why this data is needed"
}`;

      const response = await claudeClient.complete(updatePrompt, { maxTokens: 800 });

      // Parse response
      try {
        const parsed = JSON.parse(response);

        this.runningHypothesis = {
          understanding: parsed.understanding || this.runningHypothesis.understanding,
          confidence: parsed.confidence || this.runningHypothesis.confidence + 0.1,
          gaps: parsed.gaps || [],
          contributingSections: [
            ...this.runningHypothesis.contributingSections,
            result.section,
          ],
          evidence: [
            ...this.runningHypothesis.evidence,
            {
              section: result.section,
              summary: resultSummary.substring(0, 200),
              recordCount: result.recordCount || 0,
            },
          ],
        };

        console.error(`[CIEngine] Hypothesis updated: confidence=${(this.runningHypothesis.confidence * 100).toFixed(0)}%`);

        return {
          newHypothesis: this.runningHypothesis,
          needsMoreData: parsed.needsMoreData || false,
          requestedSection: parsed.requestedSection as BlendSection,
          requestedQuery: parsed.requestedQuery,
          requestReason: parsed.requestReason,
        };
      } catch {
        // JSON parse failed - minimal update
        this.runningHypothesis.contributingSections.push(result.section);
        return {
          newHypothesis: this.runningHypothesis,
          needsMoreData: false,
        };
      }
    } catch (error) {
      console.error('[CIEngine] Hypothesis update failed:', error);
      return {
        newHypothesis: this.runningHypothesis,
        needsMoreData: false,
      };
    }
  }

  /**
   * Execute a section step
   */
  private async executeSection(
    step: RouteStep,
    analysis: QuestionAnalysis
  ): Promise<SectionResult> {
    const stepStartTime = Date.now();

    try {
      const adapter = getAdapter(step.section as BlendSection);
      const result = await adapter.execute(step, analysis);

      recordSectionExecution(
        step.section as BlendSection,
        result.success,
        Date.now() - stepStartTime,
        result.tokenEstimate
      );

      return result;
    } catch (error) {
      console.error(`[CIEngine] Section error:`, error);

      recordSectionExecution(
        step.section as BlendSection,
        false,
        Date.now() - stepStartTime,
        0
      );

      return {
        section: step.section as BlendSection,
        tool: step.tool,
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error),
        tokenEstimate: 0,
      };
    }
  }

  /**
   * Summarize a section result for hypothesis update
   */
  private summarizeResult(result: SectionResult): string {
    if (!result.success) {
      return `Failed: ${result.error}`;
    }

    if (!result.data) {
      return 'No data returned';
    }

    const data = result.data as Record<string, unknown>;
    const lines: string[] = [];

    // Record count
    if (result.recordCount) {
      lines.push(`Found ${result.recordCount} records`);
    }

    // Handle common response patterns
    if ('matches' in data && Array.isArray(data.matches)) {
      lines.push(`Semantic matches: ${data.matches.length}`);
      if (data.matches.length > 0 && data.matches.length <= 3) {
        for (const match of data.matches.slice(0, 3)) {
          const m = match as Record<string, unknown>;
          lines.push(`  - ${m.name || m.display_name || m.record_id}`);
        }
      }
    }

    if ('results' in data && Array.isArray(data.results)) {
      lines.push(`Query results: ${data.results.length}`);
    }

    if ('aggregations' in data) {
      lines.push(`Aggregations: ${JSON.stringify(data.aggregations).substring(0, 200)}`);
    }

    if ('content' in data && typeof data.content === 'string') {
      lines.push(`Knowledge: ${data.content.substring(0, 200)}...`);
    }

    return lines.join('\n') || JSON.stringify(data).substring(0, 500);
  }

  /**
   * Create a dynamic step for additional data request
   */
  private createDynamicStep(
    section: BlendSection,
    query: string
  ): RouteStep {
    const tool = this.getPrimaryTool(section);

    return {
      section,
      tool,
      params: { query },
      order: 99, // Execute last
      reason: `Dynamic request based on gap analysis`,
      dependsOnPrevious: false,
      dependencyLevel: 2,
    };
  }

  /**
   * Get primary tool for a section
   */
  private getPrimaryTool(section: BlendSection): string {
    switch (section) {
      case 'exact':
        return 'nexsus_search';
      case 'semantic':
        return 'semantic_search';
      case 'knowledge':
        return 'knowledge_search';
      case 'common':
        return 'graph_traverse';
      default:
        return 'semantic_search';
    }
  }

  /**
   * Build final response from hypothesis
   */
  private buildFinalResponse(): string {
    const lines: string[] = [];

    lines.push(this.runningHypothesis.understanding);
    lines.push('');

    // Add evidence citations
    if (this.runningHypothesis.evidence.length > 0) {
      lines.push('**Sources:**');
      for (const evidence of this.runningHypothesis.evidence) {
        lines.push(`- ${evidence.section}: ${evidence.summary.substring(0, 100)}${evidence.summary.length > 100 ? '...' : ''}`);
      }
    }

    // Add confidence level
    const confidence = this.runningHypothesis.confidence;
    if (confidence < 0.5) {
      lines.push('');
      lines.push('*Note: Confidence is moderate. Additional verification may be needed.*');
    }

    // Add remaining gaps if any
    if (this.runningHypothesis.gaps.length > 0) {
      lines.push('');
      lines.push('**Remaining questions:**');
      for (const gap of this.runningHypothesis.gaps) {
        lines.push(`- ${gap}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Create initial hypothesis
   */
  private createInitialHypothesis(): Hypothesis {
    return {
      understanding: '',
      confidence: 0,
      gaps: [],
      contributingSections: [],
      evidence: [],
    };
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let engineInstance: ContinuousIntegrationEngine | null = null;

/**
 * Get the continuous integration engine singleton
 */
export function getContinuousIntegrationEngine(): ContinuousIntegrationEngine {
  if (!engineInstance) {
    engineInstance = new ContinuousIntegrationEngine();
  }
  return engineInstance;
}
