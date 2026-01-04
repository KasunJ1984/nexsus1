/**
 * Blendthink - Background Intelligence Layer
 *
 * Blendthink is a background intelligence layer that orchestrates
 * how the console synthesizes responses by blending all 5 sections
 * (exact, semantic, knowledge, common, values) using the Claude API.
 *
 * Key Features:
 * - Adaptive Routing: Routes queries to relevant sections only
 * - Adaptive Persona: Switches thinking style based on question type
 * - Multi-Turn Refinement: Progressive discovery with follow-ups
 * - Vector-Embedded Memory: Semantic recall across sessions
 *
 * Usage:
 * ```typescript
 * import { analyzeQuery, diagnoseQuery } from './blendthink';
 *
 * // Analyze a query
 * const result = await analyzeQuery("Find hospital projects in Victoria");
 * console.log(result.analysis.type); // 'discovery'
 * console.log(result.persona.name); // 'Systems Thinker'
 *
 * // Diagnose what blendthink would do
 * const diagnosis = await diagnoseQuery("Total revenue by partner");
 * console.log(diagnosis.routePlan.steps); // [{ section: 'exact', tool: 'nexsus_search' }]
 * ```
 *
 * @module blendthink
 */

// =============================================================================
// MAIN ENGINE
// =============================================================================

export {
  BlendthinkEngine,
  getBlendthinkEngine,
  analyzeQuery,
  diagnoseQuery,
} from './engine.js';

// =============================================================================
// COMPONENTS
// =============================================================================

export {
  QuestionAnalyzer,
  getQuestionAnalyzer,
  analyzeQuestion,
} from './question-analyzer.js';

export {
  AdaptiveRouter,
  getAdaptiveRouter,
  createRoutePlan,
} from './adaptive-router.js';

export {
  PersonaSelector,
  getPersonaSelector,
  selectPersona,
  buildSystemPrompt,
  PERSONAS,
} from './persona-selector.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export {
  DEFAULT_BLENDTHINK_CONFIG,
  loadBlendthinkConfig,
  validateConfig,
  getBlendthinkConfig,
} from './config.js';

// =============================================================================
// CLAUDE CLIENT (Phase 2)
// =============================================================================

export {
  BlendthinkClaudeClient,
  getClaudeClient,
  isClaudeAvailable,
} from './claude-client.js';

// =============================================================================
// SECTION ADAPTERS (Phase 2)
// =============================================================================

export {
  SemanticAdapter,
  ExactAdapter,
  GraphAdapter,
  getAdapter,
  clearAdapterCache,
  getAvailableAdapters,
} from './section-adapters/index.js';

export type {
  SectionResult,
  SectionAdapter,
  AdapterContext,
} from './section-adapters/types.js';

// =============================================================================
// CONVERSATION MEMORY (Phase 2)
// =============================================================================

export {
  initializeConversationMemory,
  getConversationMemory,
  shutdownConversationMemory,
  getSession,
  storeSession,
  recordTurn,
  getSessionContext,
  findSimilarConversations,
  recallConversationContext,
} from './conversation-memory.js';

// =============================================================================
// METRICS & OBSERVABILITY (Phase 4)
// =============================================================================

export {
  recordQueryExecution,
  recordSectionExecution,
  recordSession,
  getBlendthinkMetrics,
  getMetricsSummary,
  resetBlendthinkMetrics,
  blendthinkMetrics,
} from './metrics.js';

export type { BlendthinkMetrics } from './metrics.js';

// =============================================================================
// RE-EXPORT TYPES
// =============================================================================

export type {
  QuestionType,
  QuestionAnalysis,
  PersonaType,
  PersonaDefinition,
  BlendSection,
  RouteStep,
  RoutePlan,
  ConversationTurn,
  BlendthinkSession,
  BlendResult,
  BlendthinkConfig,
  ConversationPayload,
} from '../../common/types.js';
