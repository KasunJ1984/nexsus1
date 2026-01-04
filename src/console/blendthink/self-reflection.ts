/**
 * Self-Reflection Layer
 *
 * Claude questions its own conclusions before finalizing the response.
 * Implements "gut check" that humans naturally do before speaking.
 *
 * Reflection Types:
 * 1. Logical Check: Does this make sense given the data?
 * 2. Confidence Check: How sure am I of each claim?
 * 3. Completeness Check: Did I fully address the question?
 *
 * Human Parallel: "Wait, does this actually make sense?"
 */

import type { BlendSection, SectionResult } from '../../common/types.js';
import { getClaudeClient, isClaudeAvailable } from './claude-client.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Reflection check result
 */
export interface ReflectionResult {
  /** Whether the reflection passed all checks */
  passed: boolean;

  /** Overall confidence after reflection (0-1) */
  confidence: number;

  /** Issues identified */
  concerns: string[];

  /** Adjusted response (if confidence language applied) */
  adjustedResponse?: string;

  /** Whether verification is needed */
  needsVerification: boolean;

  /** Section to verify with (if needsVerification) */
  verificationSection?: BlendSection;

  /** What to verify */
  verificationQuery?: string;

  /** Confidence levels for individual claims */
  claimConfidence: Array<{
    claim: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    reason: string;
  }>;

  /** Gaps identified in the response */
  gaps: string[];
}

/**
 * Reflection options
 */
export interface ReflectionOptions {
  /** Maximum reflection iterations */
  maxIterations?: number;

  /** Minimum confidence to pass */
  minConfidence?: number;

  /** Which checks to run */
  checks?: Array<'logical' | 'confidence' | 'completeness'>;
}

// =============================================================================
// REFLECTION PROMPTS
// =============================================================================

const REFLECTION_PROMPTS = {
  logical_check: `Review your conclusion carefully.

HYPOTHESIS/CONCLUSION:
"{hypothesis}"

EVIDENCE SOURCES:
{evidence}

Ask yourself:
1. Does this conclusion logically follow from the data?
2. Are there any contradictions between sources?
3. Have I made any assumptions that should be stated?
4. What might I be missing or overlooking?
5. Is there any data that contradicts my conclusion?

Respond in JSON format:
{
  "passed": true/false,
  "concerns": ["list of concerns if any"],
  "contradictions": ["any contradictions found"],
  "assumptions": ["unstated assumptions"],
  "needsVerification": true/false,
  "verificationSection": "section_name (if needed)",
  "verificationQuery": "what to check"
}`,

  confidence_check: `Rate your confidence in each claim in this response.

RESPONSE:
"{hypothesis}"

For each significant claim:
1. Identify the claim
2. Rate confidence: HIGH (>90%), MEDIUM (70-90%), LOW (<70%)
3. Explain why

Respond in JSON format:
{
  "claims": [
    {
      "claim": "the specific claim",
      "confidence": "HIGH/MEDIUM/LOW",
      "reason": "why this confidence level"
    }
  ],
  "overallConfidence": 0.0-1.0,
  "lowConfidenceClaims": ["claims that should be rephrased with uncertainty"]
}`,

  completeness_check: `Check if this response fully addresses the question.

ORIGINAL QUESTION:
"{query}"

YOUR RESPONSE:
"{hypothesis}"

EVIDENCE USED:
{evidence}

Check:
1. Does the response directly answer what was asked?
2. Are there aspects of the question not addressed?
3. Would the user need to ask follow-up questions?
4. Is important context missing?

Respond in JSON format:
{
  "fullyAddressed": true/false,
  "addressedAspects": ["what was covered"],
  "missingAspects": ["what was not covered"],
  "suggestedAdditions": ["what could improve the answer"],
  "followUpQuestions": ["likely follow-up questions"]
}`,
};

// =============================================================================
// SELF-REFLECTION ENGINE
// =============================================================================

export class SelfReflection {
  private readonly DEFAULT_MAX_ITERATIONS = 2;
  private readonly DEFAULT_MIN_CONFIDENCE = 0.6;

  /**
   * Perform self-reflection on a synthesized response
   *
   * Runs logical, confidence, and completeness checks.
   * Returns adjusted response with appropriate confidence language.
   */
  async reflect(
    query: string,
    hypothesis: string,
    evidence: SectionResult[],
    options: ReflectionOptions = {}
  ): Promise<ReflectionResult> {
    const maxIterations = options.maxIterations || this.DEFAULT_MAX_ITERATIONS;
    const minConfidence = options.minConfidence || this.DEFAULT_MIN_CONFIDENCE;
    const checks = options.checks || ['logical', 'confidence', 'completeness'];

    console.error(`[SelfReflection] Starting reflection (checks: ${checks.join(', ')})`);

    // If Claude not available, return pass-through result
    if (!isClaudeAvailable()) {
      console.error('[SelfReflection] Claude unavailable, skipping reflection');
      return {
        passed: true,
        confidence: 0.5,
        concerns: [],
        needsVerification: false,
        claimConfidence: [],
        gaps: [],
      };
    }

    const claudeClient = getClaudeClient();
    const evidenceSummary = this.summarizeEvidence(evidence);

    let iteration = 0;
    let currentHypothesis = hypothesis;
    let logicalResult: LogicalCheckResult | null = null;
    let confidenceResult: ConfidenceCheckResult | null = null;
    let completenessResult: CompletenessCheckResult | null = null;

    // Run reflection checks (up to maxIterations)
    while (iteration < maxIterations) {
      iteration++;
      console.error(`[SelfReflection] Iteration ${iteration}/${maxIterations}`);

      // Run requested checks
      if (checks.includes('logical')) {
        logicalResult = await this.runLogicalCheck(
          claudeClient,
          currentHypothesis,
          evidenceSummary
        );

        if (!logicalResult.passed && logicalResult.needsVerification) {
          console.error(`[SelfReflection] Logical check needs verification`);
          break; // Exit to request verification
        }
      }

      if (checks.includes('confidence')) {
        confidenceResult = await this.runConfidenceCheck(claudeClient, currentHypothesis);
      }

      if (checks.includes('completeness')) {
        completenessResult = await this.runCompletenessCheck(
          claudeClient,
          query,
          currentHypothesis,
          evidenceSummary
        );
      }

      // Calculate overall confidence
      const overallConfidence = this.calculateOverallConfidence(
        logicalResult,
        confidenceResult,
        completenessResult
      );

      // If confidence is acceptable, we're done
      if (overallConfidence >= minConfidence) {
        console.error(`[SelfReflection] Passed with confidence: ${(overallConfidence * 100).toFixed(0)}%`);
        break;
      }

      // Otherwise, try to adjust the response
      if (confidenceResult?.lowConfidenceClaims.length) {
        currentHypothesis = this.applyConfidenceLanguage(
          currentHypothesis,
          confidenceResult.lowConfidenceClaims
        );
      }
    }

    // Build final result
    return this.buildReflectionResult(
      currentHypothesis,
      logicalResult,
      confidenceResult,
      completenessResult
    );
  }

  /**
   * Run logical check
   */
  private async runLogicalCheck(
    claudeClient: ReturnType<typeof getClaudeClient>,
    hypothesis: string,
    evidenceSummary: string
  ): Promise<LogicalCheckResult> {
    try {
      const prompt = REFLECTION_PROMPTS.logical_check
        .replace('{hypothesis}', hypothesis)
        .replace('{evidence}', evidenceSummary);

      const response = await claudeClient.complete(prompt, { maxTokens: 800 });

      const parsed = JSON.parse(response);
      return {
        passed: parsed.passed ?? true,
        concerns: parsed.concerns || [],
        contradictions: parsed.contradictions || [],
        assumptions: parsed.assumptions || [],
        needsVerification: parsed.needsVerification ?? false,
        verificationSection: parsed.verificationSection as BlendSection,
        verificationQuery: parsed.verificationQuery,
      };
    } catch (error) {
      console.error('[SelfReflection] Logical check failed:', error);
      return { passed: true, concerns: [], contradictions: [], assumptions: [], needsVerification: false };
    }
  }

  /**
   * Run confidence check
   */
  private async runConfidenceCheck(
    claudeClient: ReturnType<typeof getClaudeClient>,
    hypothesis: string
  ): Promise<ConfidenceCheckResult> {
    try {
      const prompt = REFLECTION_PROMPTS.confidence_check.replace('{hypothesis}', hypothesis);

      const response = await claudeClient.complete(prompt, { maxTokens: 1000 });

      const parsed = JSON.parse(response);
      return {
        claims: parsed.claims || [],
        overallConfidence: parsed.overallConfidence ?? 0.7,
        lowConfidenceClaims: parsed.lowConfidenceClaims || [],
      };
    } catch (error) {
      console.error('[SelfReflection] Confidence check failed:', error);
      return { claims: [], overallConfidence: 0.7, lowConfidenceClaims: [] };
    }
  }

  /**
   * Run completeness check
   */
  private async runCompletenessCheck(
    claudeClient: ReturnType<typeof getClaudeClient>,
    query: string,
    hypothesis: string,
    evidenceSummary: string
  ): Promise<CompletenessCheckResult> {
    try {
      const prompt = REFLECTION_PROMPTS.completeness_check
        .replace('{query}', query)
        .replace('{hypothesis}', hypothesis)
        .replace('{evidence}', evidenceSummary);

      const response = await claudeClient.complete(prompt, { maxTokens: 800 });

      const parsed = JSON.parse(response);
      return {
        fullyAddressed: parsed.fullyAddressed ?? true,
        addressedAspects: parsed.addressedAspects || [],
        missingAspects: parsed.missingAspects || [],
        suggestedAdditions: parsed.suggestedAdditions || [],
        followUpQuestions: parsed.followUpQuestions || [],
      };
    } catch (error) {
      console.error('[SelfReflection] Completeness check failed:', error);
      return { fullyAddressed: true, addressedAspects: [], missingAspects: [], suggestedAdditions: [], followUpQuestions: [] };
    }
  }

  /**
   * Calculate overall confidence from check results
   */
  private calculateOverallConfidence(
    logical: LogicalCheckResult | null,
    confidence: ConfidenceCheckResult | null,
    completeness: CompletenessCheckResult | null
  ): number {
    let total = 0;
    let count = 0;

    if (logical) {
      total += logical.passed ? 0.9 : 0.4;
      total -= logical.concerns.length * 0.05;
      total -= logical.contradictions.length * 0.1;
      count++;
    }

    if (confidence) {
      total += confidence.overallConfidence;
      count++;
    }

    if (completeness) {
      total += completeness.fullyAddressed ? 0.9 : 0.5;
      total -= completeness.missingAspects.length * 0.1;
      count++;
    }

    return count > 0 ? Math.max(0, Math.min(1, total / count)) : 0.5;
  }

  /**
   * Apply confidence language to low-confidence claims
   */
  private applyConfidenceLanguage(hypothesis: string, lowConfidenceClaims: string[]): string {
    let adjusted = hypothesis;

    for (const claim of lowConfidenceClaims) {
      // Add hedging language
      const hedgePhrases = [
        'It appears that',
        'Based on available data,',
        'The evidence suggests',
        'Likely,',
      ];
      const hedge = hedgePhrases[Math.floor(Math.random() * hedgePhrases.length)];

      // Try to find and modify the claim (simple approach)
      if (adjusted.includes(claim)) {
        adjusted = adjusted.replace(claim, `${hedge} ${claim.toLowerCase()}`);
      }
    }

    return adjusted;
  }

  /**
   * Summarize evidence for reflection prompts
   */
  private summarizeEvidence(evidence: SectionResult[]): string {
    return evidence
      .filter(e => e.success)
      .map(e => {
        let summary = `${e.section}/${e.tool}`;
        if (e.recordCount) {
          summary += ` (${e.recordCount} records)`;
        }
        if (e.data && typeof e.data === 'object') {
          const data = e.data as Record<string, unknown>;
          if ('aggregations' in data) {
            summary += `: ${JSON.stringify(data.aggregations).substring(0, 100)}`;
          } else if ('matches' in data && Array.isArray(data.matches)) {
            summary += `: ${data.matches.length} matches`;
          }
        }
        return summary;
      })
      .join('\n');
  }

  /**
   * Build final reflection result
   */
  private buildReflectionResult(
    adjustedHypothesis: string,
    logical: LogicalCheckResult | null,
    confidence: ConfidenceCheckResult | null,
    completeness: CompletenessCheckResult | null
  ): ReflectionResult {
    const concerns: string[] = [];
    const gaps: string[] = [];

    if (logical) {
      concerns.push(...logical.concerns);
      if (logical.contradictions.length > 0) {
        concerns.push(`Contradictions: ${logical.contradictions.join('; ')}`);
      }
    }

    if (completeness) {
      gaps.push(...completeness.missingAspects);
    }

    const overallConfidence = this.calculateOverallConfidence(logical, confidence, completeness);
    const passed = overallConfidence >= this.DEFAULT_MIN_CONFIDENCE &&
                   (!logical || logical.passed) &&
                   (!completeness || completeness.fullyAddressed);

    return {
      passed,
      confidence: overallConfidence,
      concerns,
      adjustedResponse: adjustedHypothesis,
      needsVerification: logical?.needsVerification ?? false,
      verificationSection: logical?.verificationSection,
      verificationQuery: logical?.verificationQuery,
      claimConfidence: confidence?.claims || [],
      gaps,
    };
  }
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

interface LogicalCheckResult {
  passed: boolean;
  concerns: string[];
  contradictions: string[];
  assumptions: string[];
  needsVerification: boolean;
  verificationSection?: BlendSection;
  verificationQuery?: string;
}

interface ConfidenceCheckResult {
  claims: Array<{
    claim: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    reason: string;
  }>;
  overallConfidence: number;
  lowConfidenceClaims: string[];
}

interface CompletenessCheckResult {
  fullyAddressed: boolean;
  addressedAspects: string[];
  missingAspects: string[];
  suggestedAdditions: string[];
  followUpQuestions: string[];
}

// =============================================================================
// SINGLETON
// =============================================================================

let reflectionInstance: SelfReflection | null = null;

/**
 * Get the self-reflection singleton
 */
export function getSelfReflection(): SelfReflection {
  if (!reflectionInstance) {
    reflectionInstance = new SelfReflection();
  }
  return reflectionInstance;
}
