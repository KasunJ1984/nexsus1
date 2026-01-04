/**
 * Adaptive Router for Blendthink
 *
 * Decides which sections to query based on question type.
 * Creates a routing plan with ordered steps and skip reasons.
 *
 * Routing Philosophy:
 * - Only query sections that can contribute to the answer
 * - Minimize token usage by skipping irrelevant sections
 * - Order steps to maximize information gain
 */

import type {
  QuestionAnalysis,
  QuestionType,
  BlendSection,
  RoutePlan,
  RouteStep,
} from '../../common/types.js';

// =============================================================================
// ROUTING RULES
// =============================================================================

/**
 * Step dependency configuration
 * - 'none': No dependencies, can run immediately (level 0)
 * - 'primary': Depends on primary step output (level 1)
 * - 'chain': Depends on chain context from previous steps (level 2)
 */
type StepDependency = 'none' | 'primary' | 'chain';

/**
 * Secondary step configuration with explicit dependency
 */
interface SecondaryStepConfig {
  section: BlendSection;
  dependency: StepDependency;
}

/**
 * Routing rule for a question type
 */
interface RoutingRule {
  /** Primary section to query first */
  primary: BlendSection;
  /** Secondary sections with explicit dependencies */
  secondary: SecondaryStepConfig[];
  /** Sections to skip with reasons */
  skip: Array<{ section: BlendSection; reason: string }>;
  /** Whether any steps can run in parallel (optimization hint) */
  canParallelize: boolean;
  /** Estimated tokens for this route */
  estimatedTokens: number;
}

/**
 * Routing rules by question type
 *
 * Updated to include knowledge section for more query types:
 * - discovery: Add Odoo patterns and common pitfalls
 * - aggregation: Add KPI formulas and benchmarks
 * - aggregation_with_discovery: Both patterns and KPIs
 * - comparison: Add benchmark context
 */
const ROUTING_RULES: Record<QuestionType, RoutingRule> = {
  // Precise query: Go straight to exact/
  // Knowledge skipped - simple data lookup doesn't need domain rules
  precise_query: {
    primary: 'exact',
    secondary: [],
    skip: [
      { section: 'semantic', reason: 'Precise queries use exact filters, not semantic search' },
      { section: 'knowledge', reason: 'No domain rules needed for data lookup' },
    ],
    canParallelize: false,
    estimatedTokens: 2000,
  },

  // Discovery: Start with semantic/, knowledge can run in parallel (general context)
  // exact depends on semantic IDs (chain)
  // Knowledge provides: common pitfalls, data quality hints, model context
  discovery: {
    primary: 'semantic',
    secondary: [
      { section: 'knowledge', dependency: 'none' },  // Can run parallel with semantic
      { section: 'exact', dependency: 'chain' },     // Needs semantic IDs
    ],
    skip: [],
    canParallelize: true,  // semantic + knowledge can run in parallel
    estimatedTokens: 5000,
  },

  // Aggregation: Go straight to exact/, knowledge can run in parallel (KPI context)
  // Knowledge provides: KPI formulas, benchmarks, what good/bad looks like
  aggregation: {
    primary: 'exact',
    secondary: [
      { section: 'knowledge', dependency: 'none' },  // Can run parallel with exact
    ],
    skip: [
      { section: 'semantic', reason: 'Aggregation uses precise filters and GROUP BY' },
    ],
    canParallelize: true,  // exact + knowledge can run in parallel
    estimatedTokens: 4000,
  },

  // Aggregation with discovery: semantic → exact (needs IDs), knowledge parallel
  // Knowledge provides: both Odoo patterns and KPI interpretation
  aggregation_with_discovery: {
    primary: 'semantic',
    secondary: [
      { section: 'knowledge', dependency: 'none' },  // Can run parallel with semantic
      { section: 'exact', dependency: 'chain' },     // Needs semantic IDs
    ],
    skip: [],
    canParallelize: true,  // semantic + knowledge can run in parallel
    estimatedTokens: 6000,
  },

  // Relationship: Use graph traversal in common/
  // Knowledge skipped - relationship structure is in the graph itself
  relationship: {
    primary: 'common',
    secondary: [
      { section: 'semantic', dependency: 'primary' },  // Needs graph context
    ],
    skip: [
      { section: 'exact', reason: 'Relationships are navigated via graph, not filters' },
      { section: 'knowledge', reason: 'Relationship structure is in the graph' },
    ],
    canParallelize: false,
    estimatedTokens: 3000,
  },

  // Explanation: Knowledge is PRIMARY, exact and semantic can run parallel after
  // Knowledge provides: "why" and "how"
  explanation: {
    primary: 'knowledge',
    secondary: [
      { section: 'exact', dependency: 'none' },     // Can run parallel with each other
      { section: 'semantic', dependency: 'none' },  // Can run parallel with exact
    ],
    skip: [],
    canParallelize: true,  // exact + semantic can run in parallel
    estimatedTokens: 8000,
  },

  // Comparison: Query exact/ for both sides, add knowledge for benchmarks
  // Knowledge and semantic can run in parallel with exact
  comparison: {
    primary: 'exact',
    secondary: [
      { section: 'knowledge', dependency: 'none' },  // Can run parallel
      { section: 'semantic', dependency: 'none' },   // Can run parallel
    ],
    skip: [],
    canParallelize: true,  // All three can potentially run in parallel
    estimatedTokens: 7000,
  },

  // Unknown: Try semantic/ for discovery, then decide
  unknown: {
    primary: 'semantic',
    secondary: [
      { section: 'exact', dependency: 'chain' },  // May need semantic IDs
    ],
    skip: [
      { section: 'knowledge', reason: 'Starting with discovery to understand query' },
    ],
    canParallelize: false,
    estimatedTokens: 4000,
  },
};

/**
 * Tool mapping for each section
 */
const SECTION_TOOLS: Record<BlendSection, string[]> = {
  exact: ['nexsus_search'],
  semantic: ['semantic_search', 'find_similar'],
  knowledge: ['knowledge_lookup'], // Future
  common: ['graph_traverse', 'inspect_record', 'schema_lookup'],
};

// =============================================================================
// ADAPTIVE ROUTER CLASS
// =============================================================================

export class AdaptiveRouter {
  /**
   * Create a routing plan for a question analysis
   *
   * Steps are grouped by dependency level:
   * - Level 0: Primary step + any 'none' dependency secondaries
   * - Level 1: Steps depending on primary
   * - Level 2: Steps depending on chain context
   */
  createPlan(analysis: QuestionAnalysis): RoutePlan {
    const rule = ROUTING_RULES[analysis.type];

    // Build steps with dependency levels
    const steps: RouteStep[] = [];
    let order = 1;

    // Add primary step (always level 0)
    steps.push(this.createStep(
      rule.primary,
      analysis,
      order++,
      false,  // First step never depends on previous
      0       // Dependency level 0
    ));

    // Add secondary steps with their dependency levels
    for (const stepConfig of rule.secondary) {
      // Map dependency type to level and dependsOnPrevious
      let dependencyLevel: number;
      let dependsOnPrevious: boolean;

      switch (stepConfig.dependency) {
        case 'none':
          // Can run in parallel with primary
          dependencyLevel = 0;
          dependsOnPrevious = false;
          break;
        case 'primary':
          // Depends on primary step output
          dependencyLevel = 1;
          dependsOnPrevious = true;
          break;
        case 'chain':
          // Depends on chain context (accumulated data)
          dependencyLevel = 2;
          dependsOnPrevious = true;
          break;
      }

      steps.push(this.createStep(
        stepConfig.section,
        analysis,
        order++,
        dependsOnPrevious,
        dependencyLevel
      ));
    }

    return {
      steps,
      skipped: rule.skip,
      estimatedTokens: this.estimateTokens(analysis, rule),
      canParallelize: rule.canParallelize,
    };
  }

  /**
   * Create a single route step
   */
  private createStep(
    section: BlendSection,
    analysis: QuestionAnalysis,
    order: number,
    dependsOnPrevious: boolean,
    dependencyLevel: number = 0
  ): RouteStep {
    const tool = this.selectTool(section, analysis);
    const params = this.buildParams(section, tool, analysis);
    const reason = this.explainChoice(section, analysis);

    return {
      section,
      tool,
      params,
      order,
      reason,
      dependsOnPrevious,
      dependencyLevel,
    };
  }

  /**
   * Select the best tool for a section based on analysis
   */
  private selectTool(section: BlendSection, analysis: QuestionAnalysis): string {
    const tools = SECTION_TOOLS[section];

    switch (section) {
      case 'exact':
        // Always use nexsus_search for exact queries
        return 'nexsus_search';

      case 'semantic':
        // Use find_similar if we have an ID to compare against
        if (analysis.entities.some(e => e.startsWith('id:'))) {
          return 'find_similar';
        }
        return 'semantic_search';

      case 'common':
        // Use graph_traverse for relationship queries
        if (analysis.type === 'relationship') {
          return 'graph_traverse';
        }
        return 'inspect_record';

      case 'knowledge':
        return 'knowledge_lookup';

      default:
        return tools[0];
    }
  }

  /**
   * Build parameters for a tool call
   */
  private buildParams(
    section: BlendSection,
    tool: string,
    analysis: QuestionAnalysis
  ): Record<string, unknown> {
    switch (tool) {
      case 'semantic_search':
        return this.buildSemanticSearchParams(analysis);

      case 'nexsus_search':
        return this.buildNexsusSearchParams(analysis);

      case 'find_similar':
        return this.buildFindSimilarParams(analysis);

      case 'graph_traverse':
        return this.buildGraphTraverseParams(analysis);

      case 'inspect_record':
        return this.buildInspectRecordParams(analysis);

      default:
        return { query: analysis.query };
    }
  }

  /**
   * Build semantic_search parameters
   */
  private buildSemanticSearchParams(analysis: QuestionAnalysis): Record<string, unknown> {
    const params: Record<string, unknown> = {
      query: analysis.query,
      point_type: 'data',
      limit: 20,
    };

    // Add model filter if we have hints
    if (analysis.modelHints && analysis.modelHints.length > 0) {
      params.model_filter = analysis.modelHints[0];
    }

    // Enable graph boost for relationship queries
    if (analysis.type === 'relationship') {
      params.graph_boost = true;
    }

    return params;
  }

  /**
   * Build nexsus_search parameters
   */
  private buildNexsusSearchParams(analysis: QuestionAnalysis): Record<string, unknown> {
    const params: Record<string, unknown> = {
      filters: [],
    };

    // Add model filter
    if (analysis.modelHints && analysis.modelHints.length > 0) {
      params.model_name = analysis.modelHints[0];
    }

    // Build filters from entities
    const filters: Array<Record<string, unknown>> = [];

    // Entity types that contain record IDs (partner:286798, lead:41085, etc.)
    const idEntityTypes = ['id', 'partner', 'lead', 'invoice', 'account', 'product', 'user'];

    for (const entity of analysis.entities) {
      const colonIndex = entity.indexOf(':');
      if (colonIndex > 0) {
        const entityType = entity.substring(0, colonIndex).toLowerCase();
        const value = entity.substring(colonIndex + 1);

        // Check if this entity type contains a record ID
        if (idEntityTypes.includes(entityType)) {
          const id = parseInt(value, 10);
          if (!isNaN(id)) {
            filters.push({ field: 'record_id', op: 'eq', value: id });
          }
        }
      }
    }

    if (filters.length > 0) {
      params.filters = filters;
    }

    // Add aggregations for aggregation queries
    if (analysis.operation === 'aggregate' || analysis.type === 'aggregation') {
      params.aggregations = this.buildAggregations(analysis);
    }

    return params;
  }

  /**
   * Build aggregations from analysis
   */
  private buildAggregations(analysis: QuestionAnalysis): Array<Record<string, unknown>> {
    const aggregations: Array<Record<string, unknown>> = [];

    // Map operations to aggregation functions
    const opMap: Record<string, string> = {
      total: 'sum',
      sum: 'sum',
      count: 'count',
      average: 'avg',
      avg: 'avg',
      min: 'min',
      max: 'max',
    };

    // Find operation in query
    const queryLower = analysis.query.toLowerCase();
    for (const [keyword, op] of Object.entries(opMap)) {
      if (queryLower.includes(keyword)) {
        // Try to find a field hint
        const field = analysis.fieldHints?.[0] || 'record_id';
        aggregations.push({
          field,
          op,
          alias: `${op}_${field}`,
        });
        break;
      }
    }

    // Default to count if no aggregation found
    if (aggregations.length === 0) {
      aggregations.push({
        field: 'record_id',
        op: 'count',
        alias: 'total_count',
      });
    }

    return aggregations;
  }

  /**
   * Build find_similar parameters
   */
  private buildFindSimilarParams(analysis: QuestionAnalysis): Record<string, unknown> {
    const params: Record<string, unknown> = {
      limit: 10,
      min_similarity: 0.6,
    };

    // Find record ID from entities
    for (const entity of analysis.entities) {
      if (entity.startsWith('id:')) {
        params.record_id = parseInt(entity.split(':')[1], 10);
        break;
      }
    }

    // Add model if we have hints
    if (analysis.modelHints && analysis.modelHints.length > 0) {
      params.model_name = analysis.modelHints[0];
    }

    return params;
  }

  /**
   * Build graph_traverse parameters
   */
  private buildGraphTraverseParams(analysis: QuestionAnalysis): Record<string, unknown> {
    const params: Record<string, unknown> = {
      direction: 'both',
      depth: 1,
      incoming_limit: 20,
    };

    // Find record ID and model from entities
    for (const entity of analysis.entities) {
      if (entity.startsWith('id:')) {
        params.record_id = parseInt(entity.split(':')[1], 10);
      } else if (entity.startsWith('model:')) {
        params.model_name = entity.split(':')[1];
      }
    }

    // Use model hints if no model in entities
    if (!params.model_name && analysis.modelHints && analysis.modelHints.length > 0) {
      params.model_name = analysis.modelHints[0];
    }

    return params;
  }

  /**
   * Build inspect_record parameters
   */
  private buildInspectRecordParams(analysis: QuestionAnalysis): Record<string, unknown> {
    const params: Record<string, unknown> = {};

    // Find record ID and model from entities
    for (const entity of analysis.entities) {
      if (entity.startsWith('id:')) {
        params.record_id = parseInt(entity.split(':')[1], 10);
      } else if (entity.startsWith('model:')) {
        params.model_name = entity.split(':')[1];
      }
    }

    // Use model hints if no model in entities
    if (!params.model_name && analysis.modelHints && analysis.modelHints.length > 0) {
      params.model_name = analysis.modelHints[0];
    }

    return params;
  }

  /**
   * Explain why a section was chosen
   */
  private explainChoice(section: BlendSection, analysis: QuestionAnalysis): string {
    switch (section) {
      case 'exact':
        if (analysis.type === 'aggregation') {
          return 'Using exact/ for precise aggregation with filters';
        }
        if (analysis.type === 'precise_query') {
          return 'Using exact/ for direct record lookup';
        }
        return 'Using exact/ for precise data retrieval';

      case 'semantic':
        if (analysis.type === 'discovery') {
          return 'Using semantic/ for fuzzy search and discovery';
        }
        if (analysis.type === 'aggregation_with_discovery') {
          return 'Using semantic/ first to find matching records';
        }
        return 'Using semantic/ for pattern matching';

      case 'common':
        if (analysis.type === 'relationship') {
          return 'Using common/graph for FK relationship navigation';
        }
        return 'Using common/ for infrastructure lookup';

      case 'knowledge':
        return 'Using knowledge/ for domain expertise and rules';

      default:
        return `Using ${section}/ section`;
    }
  }

  /**
   * Estimate token usage for a route
   */
  private estimateTokens(analysis: QuestionAnalysis, rule: RoutingRule): number {
    let estimate = rule.estimatedTokens;

    // Add tokens for complex queries
    if (analysis.entities.length > 5) {
      estimate += 500;
    }

    // Add tokens for explanation queries (need more context)
    if (analysis.type === 'explanation') {
      estimate += 2000;
    }

    // Add tokens for comparison (multiple data points)
    if (analysis.type === 'comparison') {
      estimate += 1500;
    }

    return estimate;
  }

  /**
   * Validate a routing plan
   */
  validatePlan(plan: RoutePlan): string[] {
    const errors: string[] = [];

    // Must have at least one step
    if (plan.steps.length === 0) {
      errors.push('Routing plan must have at least one step');
    }

    // Check for valid sections
    const validSections: BlendSection[] = ['exact', 'semantic', 'knowledge', 'common'];
    for (const step of plan.steps) {
      if (!validSections.includes(step.section)) {
        errors.push(`Invalid section: ${step.section}`);
      }
    }

    // Check order sequence
    const orders = plan.steps.map(s => s.order);
    const uniqueOrders = new Set(orders);
    if (orders.length !== uniqueOrders.size) {
      errors.push('Duplicate order values in routing steps');
    }

    return errors;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let routerInstance: AdaptiveRouter | null = null;

/**
 * Get or create the singleton AdaptiveRouter instance
 */
export function getAdaptiveRouter(): AdaptiveRouter {
  if (!routerInstance) {
    routerInstance = new AdaptiveRouter();
  }
  return routerInstance;
}

/**
 * Create a routing plan for a question analysis
 */
export function createRoutePlan(analysis: QuestionAnalysis): RoutePlan {
  const router = getAdaptiveRouter();
  return router.createPlan(analysis);
}
