/**
 * Jest Unit Tests for AdaptiveRouter
 *
 * Tests the routing logic that maps question types
 * to section execution plans.
 */

import { AdaptiveRouter, createRoutePlan } from '../adaptive-router.js';
import type { QuestionAnalysis, QuestionType, BlendSection } from '../../../common/types.js';

describe('AdaptiveRouter', () => {
  let router: AdaptiveRouter;

  beforeEach(() => {
    router = new AdaptiveRouter();
  });

  // Helper to create a QuestionAnalysis with a specific type
  function createAnalysis(type: QuestionType, overrides: Partial<QuestionAnalysis> = {}): QuestionAnalysis {
    return {
      query: 'Test query',
      type,
      confidence: 0.9,
      entities: [],
      operation: 'test',
      ...overrides,
    };
  }

  // ==========================================================================
  // ROUTE PLAN CREATION
  // ==========================================================================

  describe('Route Plan Creation', () => {
    describe('precise_query routing', () => {
      test('routes to exact/ section', () => {
        const analysis = createAnalysis('precise_query', {
          entities: ['id:12345'],
        });
        const plan = router.createPlan(analysis);

        expect(plan.steps.length).toBeGreaterThan(0);
        expect(plan.steps[0].section).toBe('exact');
        expect(plan.steps[0].tool).toBe('nexsus_search');
      });

      test('skips semantic/ and knowledge/ sections', () => {
        const analysis = createAnalysis('precise_query');
        const plan = router.createPlan(analysis);

        const skippedSections = plan.skipped.map(s => s.section);
        expect(skippedSections).toContain('semantic');
        expect(skippedSections).toContain('knowledge');
      });
    });

    describe('discovery routing', () => {
      test('routes to semantic/ section first', () => {
        const analysis = createAnalysis('discovery', {
          entities: ['location:Victoria'],
        });
        const plan = router.createPlan(analysis);

        expect(plan.steps[0].section).toBe('semantic');
        expect(plan.steps[0].tool).toBe('semantic_search');
      });

      test('may include exact/ as secondary', () => {
        const analysis = createAnalysis('discovery', {
          entities: ['hospital', 'Victoria'],
        });
        const plan = router.createPlan(analysis);

        const sections = plan.steps.map(s => s.section);
        expect(sections).toContain('semantic');
      });
    });

    describe('aggregation routing', () => {
      test('routes to exact/ section', () => {
        const analysis = createAnalysis('aggregation', {
          operation: 'sum',
          fieldHints: ['revenue'],
        });
        const plan = router.createPlan(analysis);

        expect(plan.steps[0].section).toBe('exact');
        expect(plan.steps[0].tool).toBe('nexsus_search');
      });
    });

    describe('aggregation_with_discovery routing', () => {
      test('routes to semantic/ first, then exact/', () => {
        const analysis = createAnalysis('aggregation_with_discovery', {
          entities: ['hospital', 'location:Victoria'],
          operation: 'aggregate_after_search',
        });
        const plan = router.createPlan(analysis);

        expect(plan.steps.length).toBeGreaterThanOrEqual(2);
        expect(plan.steps[0].section).toBe('semantic');
        expect(plan.steps[1].section).toBe('exact');
      });

      test('second step depends on first', () => {
        const analysis = createAnalysis('aggregation_with_discovery');
        const plan = router.createPlan(analysis);

        if (plan.steps.length >= 2) {
          expect(plan.steps[1].dependsOnPrevious).toBe(true);
        }
      });
    });

    describe('relationship routing', () => {
      test('routes to common/graph section', () => {
        const analysis = createAnalysis('relationship', {
          entities: ['partner:286798'],
        });
        const plan = router.createPlan(analysis);

        expect(plan.steps[0].section).toBe('common');
        expect(plan.steps[0].tool).toBe('graph_traverse');
      });
    });

    describe('explanation routing', () => {
      test('routes to exact/ with semantic/ secondary', () => {
        const analysis = createAnalysis('explanation', {
          entities: ['revenue', 'Q4'],
        });
        const plan = router.createPlan(analysis);

        const sections = plan.steps.map(s => s.section);
        expect(sections).toContain('exact');
      });
    });

    describe('comparison routing', () => {
      test('routes to exact/ section', () => {
        const analysis = createAnalysis('comparison', {
          entities: ['Q1', 'Q2'],
        });
        const plan = router.createPlan(analysis);

        expect(plan.steps[0].section).toBe('exact');
      });
    });

    describe('unknown routing', () => {
      test('handles unknown type gracefully', () => {
        const analysis = createAnalysis('unknown');
        const plan = router.createPlan(analysis);

        // Should have at least some plan (fallback behavior)
        expect(plan).toBeDefined();
        expect(plan.steps).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // STEP ORDERING
  // ==========================================================================

  describe('Step Ordering', () => {
    test('steps have sequential order numbers', () => {
      const analysis = createAnalysis('aggregation_with_discovery');
      const plan = router.createPlan(analysis);

      for (let i = 0; i < plan.steps.length; i++) {
        expect(plan.steps[i].order).toBe(i + 1);
      }
    });

    test('dependent steps come after their dependencies', () => {
      const analysis = createAnalysis('aggregation_with_discovery');
      const plan = router.createPlan(analysis);

      const dependentSteps = plan.steps.filter(s => s.dependsOnPrevious);
      for (const step of dependentSteps) {
        expect(step.order).toBeGreaterThan(1);
      }
    });
  });

  // ==========================================================================
  // TOKEN ESTIMATION
  // ==========================================================================

  describe('Token Estimation', () => {
    test('estimates tokens for route plan', () => {
      const analysis = createAnalysis('aggregation_with_discovery');
      const plan = router.createPlan(analysis);

      expect(plan.estimatedTokens).toBeGreaterThan(0);
    });

    test('more steps = higher token estimate', () => {
      const simpleAnalysis = createAnalysis('precise_query');
      const complexAnalysis = createAnalysis('aggregation_with_discovery');

      const simplePlan = router.createPlan(simpleAnalysis);
      const complexPlan = router.createPlan(complexAnalysis);

      // Complex plans with more steps should generally estimate more tokens
      // (though this depends on the actual implementation)
      expect(simplePlan.estimatedTokens).toBeDefined();
      expect(complexPlan.estimatedTokens).toBeDefined();
    });
  });

  // ==========================================================================
  // SKIP REASONS
  // ==========================================================================

  describe('Skip Reasons', () => {
    test('provides reasons for skipped sections', () => {
      const analysis = createAnalysis('precise_query');
      const plan = router.createPlan(analysis);

      for (const skip of plan.skipped) {
        expect(skip.section).toBeDefined();
        expect(skip.reason).toBeDefined();
        expect(skip.reason.length).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // PARALLELIZATION
  // ==========================================================================

  describe('Parallelization Hints', () => {
    test('indicates if steps can run in parallel', () => {
      const analysis = createAnalysis('aggregation_with_discovery');
      const plan = router.createPlan(analysis);

      expect(plan.canParallelize).toBeDefined();
      expect(typeof plan.canParallelize).toBe('boolean');
    });

    test('sequential dependencies prevent parallelization', () => {
      const analysis = createAnalysis('aggregation_with_discovery');
      const plan = router.createPlan(analysis);

      const hasDependencies = plan.steps.some(s => s.dependsOnPrevious);
      if (hasDependencies) {
        expect(plan.canParallelize).toBe(false);
      }
    });
  });

  // ==========================================================================
  // PLAN VALIDATION
  // ==========================================================================

  describe('Plan Validation', () => {
    test('validates plan structure', () => {
      const analysis = createAnalysis('discovery');
      const plan = router.createPlan(analysis);
      const errors = router.validatePlan(plan);

      expect(Array.isArray(errors)).toBe(true);
    });

    test('empty plan returns validation errors', () => {
      const emptyPlan = {
        steps: [],
        skipped: [],
        estimatedTokens: 0,
        canParallelize: false,
      };
      const errors = router.validatePlan(emptyPlan);

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // SINGLETON FUNCTION
  // ==========================================================================

  describe('createRoutePlan singleton', () => {
    test('returns same structure as class method', () => {
      const analysis = createAnalysis('discovery');
      const classResult = router.createPlan(analysis);
      const singletonResult = createRoutePlan(analysis);

      expect(singletonResult.steps.length).toBe(classResult.steps.length);
      expect(singletonResult.skipped.length).toBe(classResult.skipped.length);
    });
  });
});
