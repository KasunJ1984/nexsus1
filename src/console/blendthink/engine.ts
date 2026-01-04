/**
 * Blendthink Engine
 *
 * Main orchestration engine that coordinates all blendthink components:
 * - QuestionAnalyzer: Classifies user queries
 * - AdaptiveRouter: Creates routing plans
 * - PersonaSelector: Chooses thinking styles
 *
 * This is the primary entry point for blendthink functionality.
 * Phase 1: Analysis, routing, and persona selection
 * Phase 2+: Claude orchestration and conversation management
 */

import { randomUUID } from 'crypto';
import type {
  QuestionAnalysis,
  RoutePlan,
  RouteStep,
  PersonaDefinition,
  BlendthinkSession,
  BlendthinkConfig,
  ConversationTurn,
  PersonaType,
  BlendResult,
  BlendSection,
  SectionResult,
} from '../../common/types.js';
import { QuestionAnalyzer, getQuestionAnalyzer } from './question-analyzer.js';
import { AdaptiveRouter, getAdaptiveRouter } from './adaptive-router.js';
import { PersonaSelector, getPersonaSelector } from './persona-selector.js';
import { resolveEntities, type EnrichedAnalysis } from './entity-resolution/index.js';
import { loadBlendthinkConfig, validateConfig } from './config.js';
import { getAdapter } from './section-adapters/index.js';
import { getClaudeClient, isClaudeAvailable } from './claude-client.js';
import { recordQueryExecution, recordSectionExecution, recordSession } from './metrics.js';
import {
  getSynthesisCache,
  getSessionPersistence,
  getQueryPatternMemory,
  getSessionDataCache,
  getDrilldownHandler,
  type SectionDataUnion,
  type AggregationCacheData,
  type RecordsCacheData,
  type SemanticCacheData,
  type DrilldownRequest,
} from './memory/index.js';
import { decidePath, createFastPathRoute, type PathDecision } from './path-decision.js';

// =============================================================================
// BLENDTHINK ENGINE CLASS
// =============================================================================

/**
 * BlendthinkEngine - Main orchestration class
 *
 * Coordinates question analysis, routing, and persona selection.
 * In Phase 2+, will also handle Claude API calls and conversation management.
 */
export class BlendthinkEngine {
  private config: BlendthinkConfig;
  private analyzer: QuestionAnalyzer;
  private router: AdaptiveRouter;
  private personaSelector: PersonaSelector;
  private sessions: Map<string, BlendthinkSession>;

  constructor(configOverrides?: Partial<BlendthinkConfig>) {
    // Load and validate configuration
    this.config = loadBlendthinkConfig(configOverrides);
    const configErrors = validateConfig(this.config);
    if (configErrors.length > 0) {
      console.error('[BlendthinkEngine] Config validation errors:', configErrors);
    }

    // Initialize components
    this.analyzer = getQuestionAnalyzer(this.config.claudeModel);
    this.router = getAdaptiveRouter();
    this.personaSelector = getPersonaSelector();
    this.sessions = new Map();

    console.error('[BlendthinkEngine] Initialized with config:', {
      maxTurns: this.config.maxTurns,
      tokenBudget: this.config.tokenBudget,
      confidenceThreshold: this.config.confidenceThreshold,
      claudeModel: this.config.claudeModel,
    });
  }

  // ===========================================================================
  // SESSION MANAGEMENT
  // ===========================================================================

  /**
   * Create a new blendthink session
   */
  createSession(): BlendthinkSession {
    const sessionId = randomUUID();
    const now = new Date();

    const session: BlendthinkSession = {
      sessionId,
      turns: [],
      activePersona: 'neutral',
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
        budget: this.config.tokenBudget,
      },
      startedAt: now,
      lastActivityAt: now,
      active: true,
      refinementTurnsUsed: 0,
    };

    this.sessions.set(sessionId, session);
    console.error(`[BlendthinkEngine] Created session: ${sessionId}`);

    return session;
  }

  /**
   * Get an existing session
   */
  getSession(sessionId: string): BlendthinkSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get the last drilldown debug info
   */
  getLastDrilldownDebug(): string {
    return this.lastDrilldownDebug;
  }

  /**
   * End a session
   */
  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.active = false;
      // Record session metrics
      recordSession(session.turns.length);
      console.error(`[BlendthinkEngine] Ended session: ${sessionId} (${session.turns.length} turns)`);
    }
  }

  /**
   * Clean up inactive sessions (older than 1 hour)
   */
  cleanupSessions(): number {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt < oneHourAgo) {
        // Record session metrics before cleanup
        if (session.turns.length > 0) {
          recordSession(session.turns.length);
        }
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.error(`[BlendthinkEngine] Cleaned up ${cleaned} inactive sessions`);
    }

    return cleaned;
  }

  // ===========================================================================
  // CORE ANALYSIS PIPELINE
  // ===========================================================================

  /**
   * Analyze a user query
   *
   * This is the main entry point for Phase 1.
   * Returns question analysis, routing plan, and selected persona.
   */
  async analyze(query: string, sessionId?: string): Promise<{
    analysis: QuestionAnalysis;
    routePlan: RoutePlan;
    persona: PersonaDefinition;
    systemPrompt: string;
    session: BlendthinkSession;
  }> {
    // Get or create session
    let session: BlendthinkSession;
    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      session = this.createSession();
    }

    // Update session activity
    session.lastActivityAt = new Date();

    // Step 1: Analyze the question
    console.error(`[BlendthinkEngine] Analyzing query: "${query.substring(0, 50)}..."`);
    const rawAnalysis = await this.analyzer.analyze(query);
    console.error(`[BlendthinkEngine] Question type: ${rawAnalysis.type} (confidence: ${(rawAnalysis.confidence * 100).toFixed(0)}%)`);

    // Step 1.5: Entity Resolution - enrich analysis with resolved entities
    console.error(`[BlendthinkEngine] Resolving entities...`);
    const analysis: EnrichedAnalysis = await resolveEntities(rawAnalysis, query);
    console.error(`[BlendthinkEngine] Entity resolution: model=${analysis.resolvedModel?.modelName || 'none'}, ` +
      `filters=${analysis.resolvedFilters?.length || 0}, entities=${analysis.resolvedEntities?.length || 0}`);

    // Track enrichment debug for response
    this.lastEnrichmentDebug = `wasEnriched=${analysis.wasEnriched}, ` +
      `model=${analysis.resolvedModel?.modelName || 'none'}(${analysis.resolvedModel ? Math.round(analysis.resolvedModel.confidence * 100) + '%' : ''}), ` +
      `filters=${analysis.resolvedFilters?.length || 0}` +
      (analysis.resolvedFilters?.length > 0 ? `: [${analysis.resolvedFilters.map(f => `${f.field} ${f.op} ${f.value}`).join(', ')}]` : '');

    // Step 1.6: Confidence Boosting - if entity resolution succeeded, boost overall confidence
    // This prevents unnecessary clarification requests when we have a resolved model and filters
    if (analysis.wasEnriched && analysis.resolutionConfidence > analysis.confidence) {
      const originalConfidence = analysis.confidence;
      // Blend the confidences: give more weight to entity resolution if it succeeded
      // Formula: 60% entity resolution + 40% original analyzer (minimum of the higher)
      const boostedConfidence = Math.max(
        analysis.confidence,
        analysis.resolutionConfidence * 0.6 + analysis.confidence * 0.4
      );
      (analysis as { confidence: number }).confidence = boostedConfidence;
      console.error(`[BlendthinkEngine] Boosted confidence: ${(originalConfidence * 100).toFixed(0)}% → ${(boostedConfidence * 100).toFixed(0)}% (resolution: ${(analysis.resolutionConfidence * 100).toFixed(0)}%)`);

      // CRITICAL: Also update needsClarification if boosted confidence is now acceptable
      // The original flag was set BEFORE boosting, so we need to re-evaluate
      if (boostedConfidence >= 0.5 && analysis.needsClarification) {
        (analysis as { needsClarification: boolean }).needsClarification = false;
        console.error(`[BlendthinkEngine] Cleared needsClarification flag (boosted confidence ${(boostedConfidence * 100).toFixed(0)}% >= 50%)`);
      }
    }

    // Step 2: Create routing plan (now uses enriched analysis)
    const routePlan = this.router.createPlan(analysis);
    console.error(`[BlendthinkEngine] Route plan: ${routePlan.steps.map(s => s.section).join(' → ')}`);

    // Step 3: Select persona
    const persona = this.personaSelector.selectPersona(analysis);
    console.error(`[BlendthinkEngine] Selected persona: ${persona.name}`);

    // Update session persona
    session.activePersona = persona.type;

    // Step 4: Build system prompt
    const conversationContext = this.buildConversationContext(session);
    const systemPrompt = this.personaSelector.buildSystemPrompt(
      persona,
      analysis,
      conversationContext
    );

    // Step 5: Record user turn
    const userTurn: ConversationTurn = {
      id: randomUUID(),
      role: 'user',
      content: query,
      timestamp: new Date(),
      analysis,
      routePlan,
    };
    session.turns.push(userTurn);

    return {
      analysis,
      routePlan,
      persona,
      systemPrompt,
      session,
    };
  }

  /**
   * Build conversation context from session history
   */
  private buildConversationContext(session: BlendthinkSession): string {
    if (session.turns.length === 0) {
      return '';
    }

    const recentTurns = session.turns.slice(-6); // Last 3 exchanges
    const context = recentTurns.map(turn => {
      const role = turn.role === 'user' ? 'User' : 'Assistant';
      const content = turn.content.substring(0, 200);
      return `${role}: ${content}${turn.content.length > 200 ? '...' : ''}`;
    }).join('\n\n');

    return `## Conversation History

${context}

Note: Continue this conversation naturally, building on previous context.`;
  }

  // ===========================================================================
  // DIAGNOSTIC METHODS
  // ===========================================================================

  /**
   * Get a summary of the current analysis pipeline
   *
   * Useful for debugging and understanding what blendthink would do.
   */
  async diagnose(query: string): Promise<{
    query: string;
    analysis: EnrichedAnalysis;
    routePlan: RoutePlan;
    persona: PersonaDefinition;
    estimatedTokens: number;
    warnings: string[];
  }> {
    const rawAnalysis = await this.analyzer.analyze(query);
    const analysis = await resolveEntities(rawAnalysis, query);

    // Apply confidence boosting (same as in analyze())
    if (analysis.wasEnriched && analysis.resolutionConfidence > analysis.confidence) {
      const boostedConfidence = Math.max(
        analysis.confidence,
        analysis.resolutionConfidence * 0.6 + analysis.confidence * 0.4
      );
      (analysis as { confidence: number }).confidence = boostedConfidence;

      // CRITICAL: Also update needsClarification if boosted confidence is now acceptable
      if (boostedConfidence >= 0.5 && analysis.needsClarification) {
        (analysis as { needsClarification: boolean }).needsClarification = false;
      }
    }

    const routePlan = this.router.createPlan(analysis);
    const persona = this.personaSelector.selectPersona(analysis);

    const warnings: string[] = [];

    // Check for potential issues
    if (analysis.confidence < 0.5) {
      warnings.push(`Low confidence classification (${(analysis.confidence * 100).toFixed(0)}%)`);
    }

    if (analysis.needsClarification) {
      warnings.push('Query may need clarification');
    }

    if (analysis.entities.length === 0) {
      warnings.push('No entities extracted from query');
    }

    if (routePlan.estimatedTokens > this.config.tokenBudget * 0.5) {
      warnings.push(`High estimated token usage (${routePlan.estimatedTokens})`);
    }

    const validationErrors = this.router.validatePlan(routePlan);
    if (validationErrors.length > 0) {
      warnings.push(...validationErrors);
    }

    return {
      query,
      analysis,
      routePlan,
      persona,
      estimatedTokens: routePlan.estimatedTokens,
      warnings,
    };
  }

  /**
   * Get engine statistics
   */
  getStats(): {
    activeSessions: number;
    totalSessions: number;
    config: BlendthinkConfig;
  } {
    const activeSessions = Array.from(this.sessions.values()).filter(s => s.active).length;

    return {
      activeSessions,
      totalSessions: this.sessions.size,
      config: this.config,
    };
  }

  // ===========================================================================
  // EXECUTE - FULL ORCHESTRATION (Phase 2)
  // ===========================================================================

  /**
   * Execute a blendthink query end-to-end
   *
   * This is the main entry point for Phase 2.
   * - Analyzes query
   * - Executes route plan against sections with chaining
   * - Passes results between dependent steps (e.g., semantic IDs → exact filters)
   * - Calls Claude API with persona prompt (unless simple mode)
   * - Handles token budget
   * - Returns BlendResult with sources
   *
   * @param mode - Execution mode:
   *   - 'auto': Check canBypassSynthesis (default)
   *   - 'simple': Always bypass Claude synthesis
   *   - 'full': Always use Claude synthesis
   */
  async execute(
    query: string,
    sessionId?: string,
    mode: 'auto' | 'simple' | 'full' = 'auto'
  ): Promise<BlendResult> {
    const startTime = Date.now();

    // Step 0: Check for drilldown operation (short-circuit for cached data)
    // This runs BEFORE the main analysis to enable fast drilldown response
    const drilldownResult = await this.tryDrilldown(query, sessionId, startTime);
    if (drilldownResult) {
      console.error(`[BlendthinkEngine] Drilldown hit - returning cached result`);
      return drilldownResult;
    }

    // Step 1: Analyze query (reuses Phase 1 logic)
    console.error(`[BlendthinkEngine] Executing query: "${query.substring(0, 50)}..." (mode: ${mode})`);
    const { analysis, routePlan, persona, systemPrompt, session } =
      await this.analyze(query, sessionId);

    // Determine if we should use simple mode
    const useSimpleMode = this.shouldUseSimpleMode(mode, analysis);
    console.error(`[BlendthinkEngine] Complexity: ${analysis.complexity}, Simple mode: ${useSimpleMode}`);

    // Check Claude availability only if not using simple mode
    if (!useSimpleMode && !isClaudeAvailable()) {
      console.error('[BlendthinkEngine] Claude unavailable, falling back to simple mode');
      return this.executeSimpleMode(query, analysis, routePlan, persona, session, startTime);
    }

    // Check turn limit
    if (session.refinementTurnsUsed >= this.config.maxTurns) {
      return this.buildErrorResult(
        'Maximum refinement turns reached. Please start a new session.',
        session,
        startTime
      );
    }

    // Check confidence - if too low, ask for clarification
    // BUT proceed if we have usable entities (like partner:286798) to work with
    const hasUsableEntities = analysis.entities.length > 0 &&
      analysis.entities.some(e => e.includes(':'));

    if (analysis.confidence < this.config.confidenceThreshold &&
        analysis.needsClarification &&
        !hasUsableEntities) {
      return this.buildClarificationResult(analysis, persona, session, startTime);
    }

    // Step 1.5: System 1/System 2 Path Decision
    // System 1 = Fast path for familiar patterns
    // System 2 = Deep analysis for novel/complex queries
    const pathDecision = await decidePath(query, analysis, routePlan);
    console.error(`[BlendthinkEngine] Path: ${pathDecision.path} (${pathDecision.reason})`);

    // System 1: Fast path - use cached route, skip inner Claude synthesis
    if (pathDecision.path === 'system1' && mode !== 'full') {
      console.error('[BlendthinkEngine] SYSTEM 1: Fast path execution');
      const fastRoute = createFastPathRoute(analysis, pathDecision.cachedRoute);

      // Execute fast path (single adapter)
      const fastResults: SectionResult[] = [];
      for (const step of fastRoute) {
        const result = await this.executeStep(step, { discoveredIds: [], fkTargets: [] }, analysis);
        fastResults.push(result);
        // Store in cache for drilldown even in fast path
        this.storeSectionResultInCache(session, result, query, analysis);
      }

      // Return simple mode result (no inner Claude)
      return this.buildSimpleModeResult(query, analysis, fastResults, persona, session, startTime);
    }

    // System 2: Deep analysis - full pipeline with inner Claude
    console.error('[BlendthinkEngine] SYSTEM 2: Deep analysis execution');

    // Step 2: Execute route plan steps with parallel execution
    const sectionResults: SectionResult[] = [];
    let tokensUsed = 0;

    // Chain context: accumulates data from previous steps for chaining
    interface ChainContext {
      /** Record IDs discovered from semantic search */
      discoveredIds: number[];
      /** Model name from discovery */
      discoveredModel?: string;
      /** FK targets from graph traversal */
      fkTargets: Array<{ model: string; id: number; field: string }>;
      /** Knowledge context retrieved */
      knowledgeContext?: string;
    }

    const chainContext: ChainContext = {
      discoveredIds: [],
      fkTargets: [],
    };

    // Group steps by dependency level for parallel execution
    const stepsByLevel = this.groupStepsByDependencyLevel(routePlan.steps);
    const levels = Object.keys(stepsByLevel).map(Number).sort((a, b) => a - b);

    console.error(`[BlendthinkEngine] Parallel execution: ${levels.length} dependency levels`);

    // Execute each level, with parallel execution within levels
    for (const level of levels) {
      const levelSteps = stepsByLevel[level];

      // Check token budget before executing level
      const estimatedLevelTokens = levelSteps.length * 2000;
      if (tokensUsed + estimatedLevelTokens > this.config.tokenBudget * 0.8) {
        console.error(`[BlendthinkEngine] Stopping early - approaching token budget`);
        break;
      }

      // Execute steps at this level in parallel
      if (levelSteps.length > 1 && routePlan.canParallelize) {
        console.error(`[BlendthinkEngine] Level ${level}: Executing ${levelSteps.length} steps in PARALLEL`);
        const levelResults = await this.executeStepsInParallel(levelSteps, chainContext, analysis);
        sectionResults.push(...levelResults);
        tokensUsed += levelResults.reduce((sum, r) => sum + r.tokenEstimate, 0);

        // Update chain context and store in cache from all parallel results
        for (const result of levelResults) {
          this.updateChainContext(chainContext, result);
          this.storeSectionResultInCache(session, result, query, analysis);
        }
      } else {
        // Execute sequentially
        console.error(`[BlendthinkEngine] Level ${level}: Executing ${levelSteps.length} steps SEQUENTIALLY`);
        for (const step of levelSteps) {
          const result = await this.executeStep(step, chainContext, analysis);
          sectionResults.push(result);
          tokensUsed += result.tokenEstimate;

          // Update chain context after each step
          this.updateChainContext(chainContext, result);

          // Store result in session data cache for drilldown
          this.storeSectionResultInCache(session, result, query, analysis);

          // Stop on failure for dependent steps
          if (step.dependsOnPrevious && !result.success) {
            console.error(`[BlendthinkEngine] Dependent step failed, stopping route`);
            break;
          }
        }
      }
    }

    // Step 3: Synthesize results (simple or full mode)
    if (useSimpleMode) {
      // Simple mode: Format results directly without Claude
      console.error(`[BlendthinkEngine] SIMPLE MODE: Bypassing Claude synthesis`);
      return this.buildSimpleModeResult(
        query,
        analysis,
        sectionResults,
        persona,
        session,
        startTime
      );
    }

    // Full mode: Check cache first, then call Claude to synthesize
    console.error(`[BlendthinkEngine] FULL MODE: Checking synthesis cache...`);

    // Check synthesis cache
    const synthesisCache = getSynthesisCache();
    const cachedSynthesis = await synthesisCache.get(
      query,
      sectionResults.map(r => ({
        section: r.section,
        tool: r.tool,
        recordCount: r.recordCount,
        success: r.success,
      }))
    );

    if (cachedSynthesis) {
      console.error(`[BlendthinkEngine] CACHE HIT - Using cached synthesis`);

      // Store successful pattern
      getQueryPatternMemory().store(
        query,
        analysis.type,
        routePlan.steps.map(s => ({ section: s.section, tool: s.tool })),
        1.0, // Assume cached responses are high quality
        Date.now() - startTime
      ).catch(() => {});

      return this.buildCachedResult(
        cachedSynthesis,
        analysis,
        persona,
        session,
        sectionResults,
        startTime
      );
    }

    // No cache hit - call Claude
    console.error(`[BlendthinkEngine] CACHE MISS - Calling Claude (${sectionResults.length} results)`);
    const claudeClient = getClaudeClient();

    try {
      const synthesis = await claudeClient.synthesize(
        systemPrompt,
        sectionResults,
        session.turns,
        { maxTokens: Math.min(2000, this.config.tokenBudget - tokensUsed) }
      );

      // Cache the synthesis result (fire and forget)
      synthesisCache.set(
        query,
        sectionResults.map(r => ({
          section: r.section,
          tool: r.tool,
          recordCount: r.recordCount,
          success: r.success,
        })),
        synthesis.response,
        synthesis.sources
      ).catch(() => {});

      // Step 4: Record assistant turn
      const assistantTurn: ConversationTurn = {
        id: randomUUID(),
        role: 'assistant',
        content: synthesis.response,
        timestamp: new Date(),
        sources: synthesis.sources,
        confidence: analysis.confidence,
        tokenUsage: synthesis.tokenUsage,
      };
      session.turns.push(assistantTurn);

      // Update session token usage
      session.tokenUsage.input += synthesis.tokenUsage.input;
      session.tokenUsage.output += synthesis.tokenUsage.output;
      session.tokenUsage.total += synthesis.tokenUsage.input + synthesis.tokenUsage.output;
      session.refinementTurnsUsed++;

      // Build result
      const result: BlendResult = {
        response: synthesis.response,
        sources: synthesis.sources,
        confidence: analysis.confidence,
        questionType: analysis.type,
        persona: persona.name,
        session: {
          sessionId: session.sessionId,
          turnsUsed: session.refinementTurnsUsed,
          turnsRemaining: this.config.maxTurns - session.refinementTurnsUsed,
          tokenUsage: session.tokenUsage,
        },
        sectionResults: sectionResults.map(r => ({
          section: r.section,
          tool: r.tool,
          success: r.success,
          recordCount: r.recordCount,
          error: r.error,
        })),
        timing: {
          totalMs: Date.now() - startTime,
          analysisMs: 0, // Could track individually
          sectionMs: 0,
          synthesisMs: 0,
        },
      };

      // Record query execution metrics
      recordQueryExecution(
        analysis.type,
        persona.type,
        true, // success
        false, // needsClarification
        Date.now() - startTime,
        synthesis.tokenUsage.input,
        synthesis.tokenUsage.output,
        analysis.confidence
      );

      // Store successful pattern for future fast path
      getQueryPatternMemory().store(
        query,
        analysis.type,
        routePlan.steps.map(s => ({ section: s.section, tool: s.tool })),
        analysis.confidence,
        Date.now() - startTime
      ).catch(() => {});

      // Persist session state (fire and forget)
      getSessionPersistence().save(session, chainContext.discoveredIds, chainContext.discoveredModel).catch(() => {});

      console.error(`[BlendthinkEngine] Execution complete (${result.timing.totalMs}ms)`);
      return result;

    } catch (error) {
      console.error(`[BlendthinkEngine] Claude synthesis failed:`, error);
      return this.buildErrorResult(
        `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
        session,
        startTime
      );
    }
  }

  /**
   * Build an error result
   */
  private buildErrorResult(
    error: string,
    session: BlendthinkSession,
    startTime: number
  ): BlendResult {
    return {
      response: `Error: ${error}`,
      sources: [],
      confidence: 0,
      questionType: 'unknown',
      persona: 'neutral',
      session: {
        sessionId: session.sessionId,
        turnsUsed: session.refinementTurnsUsed,
        turnsRemaining: this.config.maxTurns - session.refinementTurnsUsed,
        tokenUsage: session.tokenUsage,
      },
      sectionResults: [],
      timing: {
        totalMs: Date.now() - startTime,
        analysisMs: 0,
        sectionMs: 0,
        synthesisMs: 0,
      },
      error,
    };
  }

  // ===========================================================================
  // PARALLEL EXECUTION HELPERS
  // ===========================================================================

  /**
   * Group steps by their dependency level for parallel execution
   *
   * Steps at the same level can run in parallel.
   * Level 0: No dependencies (run first)
   * Level 1+: Depend on lower levels
   */
  private groupStepsByDependencyLevel(steps: RouteStep[]): Record<number, RouteStep[]> {
    const groups: Record<number, RouteStep[]> = {};

    for (const step of steps) {
      const level = step.dependencyLevel ?? (step.dependsOnPrevious ? 1 : 0);
      if (!groups[level]) {
        groups[level] = [];
      }
      groups[level].push(step);
    }

    return groups;
  }

  /**
   * Execute multiple steps in parallel using Promise.all
   *
   * All steps receive the same chain context (snapshot from previous level)
   * Results are collected and returned together.
   */
  private async executeStepsInParallel(
    steps: RouteStep[],
    chainContext: { discoveredIds: number[]; discoveredModel?: string; fkTargets: Array<{ model: string; id: number; field: string }>; knowledgeContext?: string },
    analysis: QuestionAnalysis
  ): Promise<SectionResult[]> {
    const startTime = Date.now();

    // Create promises for all steps
    const stepPromises = steps.map(step => this.executeStep(step, chainContext, analysis));

    // Execute all in parallel
    const results = await Promise.all(stepPromises);

    const duration = Date.now() - startTime;
    console.error(`[BlendthinkEngine] Parallel execution completed: ${steps.length} steps in ${duration}ms`);

    return results;
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: RouteStep,
    chainContext: { discoveredIds: number[]; discoveredModel?: string; fkTargets: Array<{ model: string; id: number; field: string }>; knowledgeContext?: string },
    analysis: QuestionAnalysis
  ): Promise<SectionResult> {
    const stepStartTime = Date.now();

    try {
      // Enrich step params with chain context when needed
      const enrichedStep = this.enrichStepWithChainContext(step, chainContext, analysis);

      console.error(`[BlendthinkEngine] Executing: ${enrichedStep.section}/${enrichedStep.tool}`);

      // DEBUG: Log analysis enrichment state before passing to adapter
      const enrichedAnalysis = analysis as import('./entity-resolution/index.js').EnrichedAnalysis;
      console.error(`[BlendthinkEngine] Passing to adapter: wasEnriched=${enrichedAnalysis.wasEnriched}, resolvedFilters=${enrichedAnalysis.resolvedFilters?.length || 0}`);

      const adapter = getAdapter(enrichedStep.section as BlendSection);
      const result = await adapter.execute(enrichedStep, analysis);

      // Record section metrics
      recordSectionExecution(
        step.section as BlendSection,
        result.success,
        Date.now() - stepStartTime,
        result.tokenEstimate
      );

      if (!result.success) {
        console.error(`[BlendthinkEngine] Step failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      console.error(`[BlendthinkEngine] Adapter error:`, error);

      // Record failed section execution
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

  // ===========================================================================
  // CHAINING HELPERS
  // ===========================================================================

  /**
   * Enrich a step's params with data from previous steps
   *
   * Enables multi-section chaining:
   * - semantic → exact: Pass discovered IDs as filter
   * - graph → exact: Pass FK target IDs as filter
   * - knowledge → synthesis: Pass domain context
   */
  private enrichStepWithChainContext(
    step: RouteStep,
    chainContext: { discoveredIds: number[]; discoveredModel?: string; fkTargets: Array<{ model: string; id: number; field: string }>; knowledgeContext?: string },
    _analysis: QuestionAnalysis
  ): RouteStep {
    // If step depends on previous and we have discovered IDs, inject them
    if (step.dependsOnPrevious && chainContext.discoveredIds.length > 0) {
      // For exact section with nexsus_search, inject ID filter
      if (step.section === 'exact' && step.tool === 'nexsus_search') {
        const enrichedParams = { ...step.params };

        // If no filters exist, create them
        if (!enrichedParams.filters) {
          enrichedParams.filters = [];
        }

        // Add record_id filter from discovered IDs
        const existingFilters = enrichedParams.filters as Array<{ field: string; op: string; value: unknown }>;
        const hasRecordIdFilter = existingFilters.some(f => f.field === 'record_id');

        if (!hasRecordIdFilter && chainContext.discoveredIds.length > 0) {
          // Limit to first 100 IDs to avoid query explosion
          const idsToUse = chainContext.discoveredIds.slice(0, 100);

          existingFilters.push({
            field: 'record_id',
            op: 'in',
            value: idsToUse,
          });

          // Set model name if we have it
          if (chainContext.discoveredModel && !enrichedParams.model_name) {
            enrichedParams.model_name = chainContext.discoveredModel;
          }

          console.error(`[BlendthinkEngine] Chaining: Injected ${idsToUse.length} IDs from semantic → exact`);
        }

        return { ...step, params: enrichedParams };
      }
    }

    // For knowledge section, pass any accumulated context
    if (step.section === 'knowledge' && chainContext.knowledgeContext) {
      const enrichedParams = { ...step.params };
      enrichedParams.priorContext = chainContext.knowledgeContext;
      return { ...step, params: enrichedParams };
    }

    return step;
  }

  /**
   * Update chain context with results from a completed step
   *
   * Extracts data from step results for use by subsequent steps.
   */
  private updateChainContext(
    chainContext: { discoveredIds: number[]; discoveredModel?: string; fkTargets: Array<{ model: string; id: number; field: string }>; knowledgeContext?: string },
    result: SectionResult
  ): void {
    if (!result.success || !result.data) return;

    const data = result.data as Record<string, unknown>;

    // Extract IDs from semantic search results
    if (result.section === 'semantic' && result.tool === 'semantic_search') {
      // Semantic adapter returns: { matches: [...], totalMatches, hasMore }
      const matches = data.matches as Array<{ record_id?: number; model_name?: string }> | undefined;
      if (Array.isArray(matches)) {
        for (const match of matches) {
          if (match.record_id && typeof match.record_id === 'number') {
            chainContext.discoveredIds.push(match.record_id);
          }
          // Capture model name from first match
          if (!chainContext.discoveredModel && match.model_name) {
            chainContext.discoveredModel = match.model_name;
          }
        }
        console.error(`[BlendthinkEngine] Chain: Extracted ${chainContext.discoveredIds.length} IDs from semantic results`);
      }
    }

    // Extract FK targets from graph traversal
    if (result.section === 'common' && result.tool === 'graph_traverse') {
      const outgoing = data.outgoing as Array<{ target_model: string; target_id: number; fk_field: string }> | undefined;
      if (Array.isArray(outgoing)) {
        for (const fk of outgoing) {
          chainContext.fkTargets.push({
            model: fk.target_model,
            id: fk.target_id,
            field: fk.fk_field,
          });
        }
        console.error(`[BlendthinkEngine] Chain: Extracted ${chainContext.fkTargets.length} FK targets from graph`);
      }
    }

    // Capture knowledge context for synthesis
    if (result.section === 'knowledge') {
      const content = data.content as string | undefined;
      if (content) {
        chainContext.knowledgeContext = content;
        console.error(`[BlendthinkEngine] Chain: Captured knowledge context (${content.length} chars)`);
      }
    }
  }

  /**
   * Store section result in session data cache for drilldown
   */
  private storeSectionResultInCache(
    session: BlendthinkSession,
    result: SectionResult,
    query: string,
    analysis: QuestionAnalysis
  ): void {
    if (!result.success || !result.data) return;

    // Convert SectionResult to cacheable format
    const cacheData = this.convertToSectionDataUnion(result);
    if (!cacheData) return;

    // Get model name from analysis or result
    const modelName = this.extractModelNameFromResult(result, analysis);

    // Get filters and groupBy from enriched analysis
    const enriched = analysis as EnrichedAnalysis;

    getSessionDataCache().store(
      session.sessionId,
      session.turns.length, // current turn number
      result.section,
      result.tool,
      cacheData,
      {
        query,
        modelName,
        recordCount: result.recordCount || 0,
        filters: enriched.resolvedFilters,
        groupBy: enriched.groupByHints || analysis.groupByHints,
        aggregations: enriched.resolvedAggregations,
      }
    );
  }

  /**
   * Convert SectionResult to cacheable SectionDataUnion
   */
  private convertToSectionDataUnion(result: SectionResult): SectionDataUnion | null {
    if (!result.data) return null;

    const data = result.data as Record<string, unknown>;

    if (result.section === 'exact') {
      // Check if aggregation or records
      if ('results' in data && 'totalRecords' in data) {
        return {
          type: 'aggregation',
          results: data.results as Record<string, unknown>[],
          groupBy: data.groupBy as string[] | undefined,
          totalRecords: data.totalRecords as number,
          underlyingRecords: data.underlyingRecords as Record<string, unknown>[] | undefined,
          reconciliation: data.reconciliation as AggregationCacheData['reconciliation'],
        };
      } else if ('records' in data) {
        return {
          type: 'records',
          records: data.records as Record<string, unknown>[],
          totalMatched: (data.totalMatched as number) || (data.records as unknown[]).length,
          hasMore: (data.hasMore as boolean) || false,
        };
      }
    }

    if (result.section === 'semantic') {
      if ('matches' in data) {
        return {
          type: 'semantic',
          matches: data.matches as SemanticCacheData['matches'],
          totalMatches: (data.totalMatches as number) || (data.matches as unknown[]).length,
          hasMore: (data.hasMore as boolean) || false,
        };
      }
    }

    // Default fallback for records
    if (Array.isArray(data)) {
      return {
        type: 'records',
        records: data as Record<string, unknown>[],
        totalMatched: data.length,
        hasMore: false,
      };
    }

    return null;
  }

  /**
   * Extract model name from result or analysis
   */
  private extractModelNameFromResult(result: SectionResult, analysis: QuestionAnalysis): string {
    const data = result.data as Record<string, unknown>;

    // Check matches for model_name
    if (data.matches && Array.isArray(data.matches)) {
      const firstMatch = data.matches[0] as Record<string, unknown>;
      if (firstMatch?.model_name) return firstMatch.model_name as string;
    }

    // Check records for model_name
    if (data.records && Array.isArray(data.records)) {
      const firstRecord = data.records[0] as Record<string, unknown>;
      if (firstRecord?.model_name) return firstRecord.model_name as string;
    }

    // Fall back to enriched analysis
    const enriched = analysis as EnrichedAnalysis;
    if (enriched.resolvedModel?.modelName) {
      return enriched.resolvedModel.modelName;
    }

    // Fall back to analysis hints
    return analysis.modelHints?.[0] || 'unknown';
  }

  /**
   * Build a clarification result
   */
  private buildClarificationResult(
    analysis: QuestionAnalysis,
    persona: PersonaDefinition,
    session: BlendthinkSession,
    startTime: number
  ): BlendResult {
    const questions = analysis.clarificationQuestions || [
      'Could you provide more details about what you are looking for?',
    ];

    const response = `I need a bit more information to help you accurately.

${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Please provide additional context so I can give you the best answer.`;

    // Record clarification request in metrics
    recordQueryExecution(
      analysis.type,
      persona.type,
      true, // technically success, but needs clarification
      true, // needsClarification
      Date.now() - startTime,
      0, // no tokens used
      0,
      analysis.confidence
    );

    return {
      response,
      sources: [],
      confidence: analysis.confidence,
      questionType: analysis.type,
      persona: persona.name,
      session: {
        sessionId: session.sessionId,
        turnsUsed: session.refinementTurnsUsed,
        turnsRemaining: this.config.maxTurns - session.refinementTurnsUsed,
        tokenUsage: session.tokenUsage,
      },
      sectionResults: [],
      timing: {
        totalMs: Date.now() - startTime,
        analysisMs: 0,
        sectionMs: 0,
        synthesisMs: 0,
      },
      needsClarification: true,
      clarificationQuestions: questions,
    };
  }

  // ===========================================================================
  // CACHE HELPERS
  // ===========================================================================

  /**
   * Build result from cached synthesis
   *
   * Restores a BlendResult from a cache hit, updating session state appropriately.
   */
  private buildCachedResult(
    cachedSynthesis: import('./memory/synthesis-cache.js').CachedSynthesis,
    analysis: QuestionAnalysis,
    persona: PersonaDefinition,
    session: BlendthinkSession,
    sectionResults: SectionResult[],
    startTime: number
  ): BlendResult {
    // Record assistant turn (from cache)
    const assistantTurn: ConversationTurn = {
      id: randomUUID(),
      role: 'assistant',
      content: cachedSynthesis.response,
      timestamp: new Date(),
      sources: cachedSynthesis.sources,
      confidence: analysis.confidence,
      tokenUsage: { input: 0, output: 0 }, // No API call
    };
    session.turns.push(assistantTurn);

    // Record metrics (mark as cached)
    recordQueryExecution(
      analysis.type,
      persona.type,
      true, // success
      false, // needsClarification
      Date.now() - startTime,
      0, // No tokens used (cached)
      0,
      analysis.confidence
    );

    return {
      response: cachedSynthesis.response,
      sources: cachedSynthesis.sources,
      confidence: analysis.confidence,
      questionType: analysis.type,
      persona: persona.name,
      session: {
        sessionId: session.sessionId,
        turnsUsed: session.refinementTurnsUsed,
        turnsRemaining: this.config.maxTurns - session.refinementTurnsUsed,
        tokenUsage: session.tokenUsage,
      },
      sectionResults: sectionResults.map(r => ({
        section: r.section,
        tool: r.tool,
        success: r.success,
        recordCount: r.recordCount,
        error: r.error,
      })),
      timing: {
        totalMs: Date.now() - startTime,
        analysisMs: 0,
        sectionMs: 0,
        synthesisMs: 0, // Cached - no synthesis time
      },
    };
  }

  // ===========================================================================
  // DRILLDOWN HELPERS
  // ===========================================================================

  /**
   * Try to handle query as a drilldown operation on cached data
   *
   * Returns BlendResult if drilldown succeeds, null to fall through to normal execution.
   * This enables instant responses for "show by customer", "export this", etc.
   */
  // Track drilldown debug info for response
  private lastDrilldownDebug: string = '';

  // Track enrichment debug info for response
  private lastEnrichmentDebug: string = '';

  /**
   * Get the last enrichment debug info
   */
  getLastEnrichmentDebug(): string {
    return this.lastEnrichmentDebug;
  }

  private async tryDrilldown(
    query: string,
    sessionId: string | undefined,
    startTime: number
  ): Promise<BlendResult | null> {
    const debugParts: string[] = [];
    debugParts.push(`query="${query.substring(0, 30)}..."`);

    console.error(`[BlendthinkEngine] tryDrilldown called: query="${query.substring(0, 30)}...", sessionId=${sessionId?.substring(0, 8) || 'none'}`);

    // Need a session to check for cached data
    if (!sessionId) {
      this.lastDrilldownDebug = 'No sessionId provided';
      console.error(`[BlendthinkEngine] tryDrilldown: No sessionId provided`);
      return null;
    }
    debugParts.push(`sessionId=${sessionId.substring(0, 8)}`);

    const session = this.getSession(sessionId);
    if (!session) {
      this.lastDrilldownDebug = `Session not found (map size=${this.sessions.size})`;
      console.error(`[BlendthinkEngine] tryDrilldown: Session not found in engine.sessions Map (size=${this.sessions.size})`);
      return null;
    }
    debugParts.push(`session found (turns=${session.turns.length})`);

    // Quick pattern check for drilldown intent (before full analysis)
    // Uses lightweight regex check instead of full analysis
    const drilldownPatterns = [
      /^show\s+(me\s+)?(this\s+|that\s+)?by\s+\w+/i,    // "show me by customer"
      /^(break\s*down|breakdown)\s+/i,                   // "breakdown by..."
      /^group\s+(this\s+|that\s+)?by\s+/i,               // "group by..."
      /^regroup\s+/i,                                     // "regroup by..."
      /^export\s+(this|that|these|it)?/i,                // "export this"
      /^download\s+(this|that|these|it)?/i,              // "download this"
      /^(show|what)\s+(me\s+)?(the\s+)?(detail|details)/i, // "show the details"
      /^drill\s*(down|into)/i,                           // "drill down"
      /^expand\s+/i,                                      // "expand this"
      /^sort\s+(this\s+|that\s+)?by\s+/i,                // "sort by..."
      /^(only|just)\s+/i,                                 // "only for partner X"
      /^filter\s+/i,                                      // "filter to..."
    ];

    const isDrilldownIntent = drilldownPatterns.some(p => p.test(query.trim()));
    debugParts.push(`patternMatch=${isDrilldownIntent}`);
    console.error(`[BlendthinkEngine] Drilldown check: query="${query}", sessionId=${sessionId?.substring(0, 8)}..., patternMatch=${isDrilldownIntent}`);

    if (!isDrilldownIntent) {
      this.lastDrilldownDebug = debugParts.join(', ') + ' → FAIL: No pattern matched';
      console.error(`[BlendthinkEngine] No drilldown pattern matched`);
      return null;
    }

    console.error(`[BlendthinkEngine] Detected drilldown intent: "${query.substring(0, 40)}..."`);

    // Do a quick analysis to get the drilldown operation details
    const analysis = await this.analyzer.analyze(query);
    debugParts.push(`isDrilldown=${analysis.isDrilldown}`);
    debugParts.push(`operation=${analysis.drilldownOperation || 'none'}`);
    console.error(`[BlendthinkEngine] Analysis isDrilldown=${analysis.isDrilldown}, operation=${analysis.drilldownOperation}`);

    if (!analysis.isDrilldown) {
      this.lastDrilldownDebug = debugParts.join(', ') + ' → FAIL: isDrilldown=false';
      console.error(`[BlendthinkEngine] Not a drilldown after analysis, proceeding normally`);
      return null;
    }

    // Build drilldown request
    const request: DrilldownRequest = {
      operation: analysis.drilldownOperation || 'regroup',
      sessionId,
    };

    // Add operation-specific parameters
    if (analysis.drilldownGroupBy && analysis.drilldownGroupBy.length > 0) {
      request.newGroupBy = analysis.drilldownGroupBy;
    }
    if (analysis.drilldownExpandKey) {
      request.expandGroupKey = { key: analysis.drilldownExpandKey };
    }

    // Check if we have cached data for this session
    const cachedData = getSessionDataCache().get(sessionId);
    const cacheStats = getSessionDataCache().getStats();
    debugParts.push(`cacheEntries=${cacheStats.entries}`);
    debugParts.push(`hasData=${!!cachedData}`);
    console.error(`[BlendthinkEngine] Cache check: sessionId=${sessionId.substring(0, 8)}..., hasCachedData=${!!cachedData}, cacheStats=${JSON.stringify(cacheStats)}`);

    if (!cachedData) {
      this.lastDrilldownDebug = debugParts.join(', ') + ' → FAIL: No cached data';
      console.error(`[BlendthinkEngine] No cached data for session, falling through to normal execution`);
      return null;
    }

    // Execute drilldown
    const handler = getDrilldownHandler();
    const result = await handler.execute(request);

    if (!result.success || !result.data) {
      this.lastDrilldownDebug = debugParts.join(', ') + ` → HANDLER_FAIL: ${result.error || 'no data'}`;
      console.error(`[BlendthinkEngine] Drilldown failed: ${result.error}`);
      // Return null to fall through to normal execution
      // The user might be asking for something not in cache
      return null;
    }

    this.lastDrilldownDebug = debugParts.join(', ') + ` → DRILLDOWN_OK (${result.data.type})`;

    // Build BlendResult from drilldown result
    const elapsed = Date.now() - startTime;
    console.error(`[BlendthinkEngine] Drilldown completed in ${elapsed}ms (from cache)`);

    // Format the response based on data type
    const response = this.formatDrilldownResponse(result.data, analysis, result.cacheStats);

    // Get persona for this query
    const persona = this.personaSelector.selectPersona(analysis);

    // Record the turn in session
    const turn: ConversationTurn = {
      id: randomUUID(),
      role: 'assistant' as const,
      content: response,
      timestamp: new Date(),
      analysis,
      sources: [{
        section: 'exact' as BlendSection,
        tool: 'drilldown_cache',
        contribution: `Drilldown (${analysis.drilldownOperation}) from session cache`,
        dataPoints: result.data.type === 'aggregation'
          ? (result.data as AggregationCacheData).totalRecords
          : result.data.type === 'records'
            ? (result.data as RecordsCacheData).records.length
            : (result.data as SemanticCacheData).totalMatches,
      }],
    };

    session.turns.push(turn);
    session.lastActivityAt = new Date();

    // Build the BlendResult
    const blendResult: BlendResult = {
      response,
      sources: [{
        section: 'exact' as BlendSection,
        tool: 'drilldown_cache',
        contribution: `Drilldown (${analysis.drilldownOperation}) from session cache`,
        dataPoints: result.data.type === 'aggregation'
          ? (result.data as AggregationCacheData).totalRecords
          : result.data.type === 'records'
            ? (result.data as RecordsCacheData).records.length
            : (result.data as SemanticCacheData).totalMatches,
      }],
      confidence: 1.0, // From verified cache
      questionType: analysis.type,
      persona: persona.name,
      session: {
        sessionId: session.sessionId,
        turnsUsed: session.refinementTurnsUsed,
        turnsRemaining: this.config.maxTurns - session.refinementTurnsUsed,
        tokenUsage: session.tokenUsage,
      },
      sectionResults: [{
        section: 'exact' as BlendSection,
        tool: 'drilldown_cache',
        success: true,
        recordCount: result.data.type === 'aggregation'
          ? (result.data as AggregationCacheData).totalRecords
          : result.data.type === 'records'
            ? (result.data as RecordsCacheData).records.length
            : (result.data as SemanticCacheData).totalMatches,
      }],
      timing: {
        totalMs: elapsed,
        analysisMs: 0,
        sectionMs: elapsed,
        synthesisMs: 0, // No Claude synthesis for drilldown
      },
    };

    return blendResult;
  }

  /**
   * Format drilldown result data into a human-readable response
   */
  private formatDrilldownResponse(
    data: SectionDataUnion,
    analysis: QuestionAnalysis,
    cacheStats?: { hitTurn: number; ageMs: number; originalQuery: string }
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(`## Drilldown Result (${analysis.drilldownOperation || 'regroup'})`);
    lines.push('');

    if (cacheStats) {
      const ageSeconds = Math.round(cacheStats.ageMs / 1000);
      lines.push(`*From session cache (turn ${cacheStats.hitTurn}, ${ageSeconds}s ago)*`);
      lines.push('');
    }

    // Format based on data type
    if (data.type === 'aggregation') {
      const aggData = data as AggregationCacheData;
      if (aggData.groupBy && aggData.groupBy.length > 0) {
        lines.push(`**Grouped by:** ${aggData.groupBy.join(', ')}`);
      }
      lines.push(`**Groups:** ${aggData.results.length}`);
      lines.push(`**Total records:** ${aggData.totalRecords.toLocaleString()}`);
      lines.push('');

      // Show results (limit to first 20)
      const displayResults = aggData.results.slice(0, 20);
      if (displayResults.length > 0) {
        lines.push('| ' + Object.keys(displayResults[0]).join(' | ') + ' |');
        lines.push('| ' + Object.keys(displayResults[0]).map(() => '---').join(' | ') + ' |');
        for (const row of displayResults) {
          const values = Object.values(row).map(v => {
            if (typeof v === 'number') return v.toLocaleString();
            return String(v ?? '');
          });
          lines.push('| ' + values.join(' | ') + ' |');
        }
        if (aggData.results.length > 20) {
          lines.push('');
          lines.push(`*... and ${aggData.results.length - 20} more groups*`);
        }
      }
    } else if (data.type === 'records') {
      const recData = data as RecordsCacheData;
      lines.push(`**Records:** ${recData.records.length.toLocaleString()}`);
      if (recData.hasMore) {
        lines.push('*(More records available)*');
      }
      lines.push('');

      // Show first few records
      const displayRecords = recData.records.slice(0, 10);
      if (displayRecords.length > 0) {
        lines.push('```json');
        lines.push(JSON.stringify(displayRecords, null, 2));
        lines.push('```');
      }
    } else if (data.type === 'semantic') {
      const semData = data as SemanticCacheData;
      lines.push(`**Matches:** ${semData.totalMatches}`);
      lines.push('');

      for (const match of semData.matches.slice(0, 10)) {
        lines.push(`- **${match.display_name || match.id}** (score: ${match.score.toFixed(3)})`);
      }
    }

    return lines.join('\n');
  }

  // ===========================================================================
  // SIMPLE MODE HELPERS
  // ===========================================================================

  /**
   * Determine if simple mode should be used based on mode and analysis
   */
  private shouldUseSimpleMode(
    mode: 'auto' | 'simple' | 'full',
    analysis: QuestionAnalysis
  ): boolean {
    if (mode === 'simple') return true;
    if (mode === 'full') return false;

    // Auto mode: Check analysis
    return analysis.canBypassSynthesis === true;
  }

  /**
   * Execute in simple mode (fallback when Claude unavailable)
   */
  private async executeSimpleMode(
    query: string,
    analysis: QuestionAnalysis,
    routePlan: RoutePlan,
    persona: PersonaDefinition,
    session: BlendthinkSession,
    startTime: number
  ): Promise<BlendResult> {
    // Execute section steps (same as full mode)
    const sectionResults: SectionResult[] = [];

    interface ChainContext {
      discoveredIds: number[];
      discoveredModel?: string;
      fkTargets: Array<{ model: string; id: number; field: string }>;
      knowledgeContext?: string;
    }

    const chainContext: ChainContext = {
      discoveredIds: [],
      fkTargets: [],
    };

    // Only execute first step for simple mode (usually sufficient)
    const primaryStep = routePlan.steps[0];
    if (primaryStep) {
      const result = await this.executeStep(primaryStep, chainContext, analysis);
      sectionResults.push(result);
    }

    return this.buildSimpleModeResult(query, analysis, sectionResults, persona, session, startTime);
  }

  /**
   * Build result for simple mode (no Claude synthesis)
   *
   * Formats raw tool results into a readable response
   */
  private buildSimpleModeResult(
    query: string,
    analysis: QuestionAnalysis,
    sectionResults: SectionResult[],
    persona: PersonaDefinition,
    session: BlendthinkSession,
    startTime: number
  ): BlendResult {
    // Build response from section results
    const lines: string[] = [];
    const sources: BlendResult['sources'] = [];

    lines.push(`**Query:** ${query}`);
    lines.push(`**Type:** ${analysis.type} (complexity: ${analysis.complexity})`);
    lines.push('');

    for (const result of sectionResults) {
      if (result.success) {
        lines.push(`### ${result.section}/${result.tool}`);

        // Format data based on type
        if (result.data) {
          if (typeof result.data === 'string') {
            lines.push(result.data);
          } else {
            // Summarize object data
            const data = result.data as Record<string, unknown>;

            // Handle common response patterns
            if ('results' in data && Array.isArray(data.results)) {
              lines.push(`Found **${data.results.length}** results`);
              if (data.results.length <= 5) {
                lines.push('```json');
                lines.push(JSON.stringify(data.results, null, 2).substring(0, 2000));
                lines.push('```');
              }
            } else if ('aggregations' in data) {
              lines.push('**Aggregations:**');
              lines.push('```json');
              lines.push(JSON.stringify(data.aggregations, null, 2));
              lines.push('```');
            } else if ('matches' in data && Array.isArray(data.matches)) {
              lines.push(`Found **${data.matches.length}** matches`);
            } else {
              // Generic JSON output (truncated)
              const jsonStr = JSON.stringify(data, null, 2);
              if (jsonStr.length > 2000) {
                lines.push('```json');
                lines.push(jsonStr.substring(0, 2000) + '\n... (truncated)');
                lines.push('```');
              } else {
                lines.push('```json');
                lines.push(jsonStr);
                lines.push('```');
              }
            }
          }
        }

        sources.push({
          section: result.section,
          tool: result.tool,
          contribution: 'provided data',
          dataPoints: result.recordCount,
        });
      } else {
        lines.push(`### ${result.section}/${result.tool} (FAILED)`);
        lines.push(`Error: ${result.error}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('*Simple mode: Raw tool results (no Claude synthesis)*');

    // Record metrics
    recordQueryExecution(
      analysis.type,
      persona.type,
      sectionResults.some(r => r.success),
      false,
      Date.now() - startTime,
      0, // No tokens for simple mode
      0,
      analysis.confidence
    );

    return {
      response: lines.join('\n'),
      sources,
      confidence: analysis.confidence,
      questionType: analysis.type,
      persona: persona.name,
      session: {
        sessionId: session.sessionId,
        turnsUsed: session.refinementTurnsUsed,
        turnsRemaining: this.config.maxTurns - session.refinementTurnsUsed,
        tokenUsage: session.tokenUsage,
      },
      sectionResults: sectionResults.map(r => ({
        section: r.section,
        tool: r.tool,
        success: r.success,
        recordCount: r.recordCount,
        error: r.error,
      })),
      timing: {
        totalMs: Date.now() - startTime,
        analysisMs: 0,
        sectionMs: Date.now() - startTime,
        synthesisMs: 0, // No synthesis in simple mode
      },
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let engineInstance: BlendthinkEngine | null = null;

/**
 * Get or create the singleton BlendthinkEngine instance
 */
export function getBlendthinkEngine(configOverrides?: Partial<BlendthinkConfig>): BlendthinkEngine {
  if (!engineInstance) {
    engineInstance = new BlendthinkEngine(configOverrides);
  }
  return engineInstance;
}

/**
 * Analyze a query using the singleton engine
 */
export async function analyzeQuery(query: string, sessionId?: string) {
  const engine = getBlendthinkEngine();
  return engine.analyze(query, sessionId);
}

/**
 * Diagnose a query using the singleton engine
 */
export async function diagnoseQuery(query: string) {
  const engine = getBlendthinkEngine();
  return engine.diagnose(query);
}
