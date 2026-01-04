/**
 * Jest Unit Tests for Blendthink Metrics Service
 *
 * Tests metric recording, aggregation, and retrieval.
 */

import {
  recordQueryExecution,
  recordSectionExecution,
  recordSession,
  getBlendthinkMetrics,
  getMetricsSummary,
  resetBlendthinkMetrics,
} from '../metrics.js';
import type { QuestionType, PersonaType, BlendSection } from '../../../common/types.js';

describe('Blendthink Metrics', () => {
  // Reset metrics before each test
  beforeEach(() => {
    resetBlendthinkMetrics();
  });

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('Initial State', () => {
    test('starts with zero queries', () => {
      const metrics = getBlendthinkMetrics();
      expect(metrics.totalQueries).toBe(0);
    });

    test('starts with zero tokens', () => {
      const metrics = getBlendthinkMetrics();
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
    });

    test('starts with null timestamps', () => {
      const metrics = getBlendthinkMetrics();
      expect(metrics.firstQueryTimestamp).toBeNull();
      expect(metrics.lastQueryTimestamp).toBeNull();
    });

    test('starts with zero sessions', () => {
      const metrics = getBlendthinkMetrics();
      expect(metrics.totalSessions).toBe(0);
      expect(metrics.avgTurnsPerSession).toBe(0);
    });

    test('minDurationMs is 0 when no queries', () => {
      const metrics = getBlendthinkMetrics();
      expect(metrics.minDurationMs).toBe(0); // Converted from Infinity
    });
  });

  // ==========================================================================
  // QUERY EXECUTION RECORDING
  // ==========================================================================

  describe('Query Execution Recording', () => {
    test('increments totalQueries', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        500,
        200,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.totalQueries).toBe(1);
    });

    test('increments successfulQueries on success', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true, // success
        false,
        100,
        500,
        200,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.successfulQueries).toBe(1);
      expect(metrics.failedQueries).toBe(0);
    });

    test('increments failedQueries on failure', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        false, // failure
        false,
        100,
        0,
        0,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.successfulQueries).toBe(0);
      expect(metrics.failedQueries).toBe(1);
    });

    test('increments clarificationRequests when needsClarification', () => {
      recordQueryExecution(
        'unknown' as QuestionType,
        'socratic_guide' as PersonaType,
        true,
        true, // needsClarification
        50,
        0,
        0,
        0.4
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.clarificationRequests).toBe(1);
    });

    test('accumulates token usage', () => {
      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        100,
        500,
        200,
        0.95
      );

      recordQueryExecution(
        'precise_query' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        80,
        300,
        150,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.totalInputTokens).toBe(800);
      expect(metrics.totalOutputTokens).toBe(350);
    });

    test('calculates avgTokensPerQuery', () => {
      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        100,
        500,
        200, // 700 total
        0.95
      );

      recordQueryExecution(
        'precise_query' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        80,
        300,
        150, // 450 total
        0.9
      );

      const metrics = getBlendthinkMetrics();
      // (500+200+300+150) / 2 = 575
      expect(metrics.avgTokensPerQuery).toBe(575);
    });

    test('tracks timing statistics', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        150, // 150ms
        100,
        50,
        0.85
      );

      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        50, // 50ms
        200,
        100,
        0.95
      );

      recordQueryExecution(
        'relationship' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100, // 100ms
        150,
        75,
        0.8
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.minDurationMs).toBe(50);
      expect(metrics.maxDurationMs).toBe(150);
      expect(metrics.avgDurationMs).toBe(100); // (150+50+100)/3
    });

    test('sets firstQueryTimestamp on first query', () => {
      const beforeQuery = new Date().toISOString();

      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const afterQuery = new Date().toISOString();
      const metrics = getBlendthinkMetrics();

      expect(metrics.firstQueryTimestamp).not.toBeNull();
      expect(metrics.firstQueryTimestamp! >= beforeQuery).toBe(true);
      expect(metrics.firstQueryTimestamp! <= afterQuery).toBe(true);
    });

    test('updates lastQueryTimestamp on each query', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const firstTimestamp = getBlendthinkMetrics().lastQueryTimestamp;

      // Small delay to ensure different timestamp
      const laterTime = new Date(Date.now() + 100).toISOString();

      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const secondTimestamp = getBlendthinkMetrics().lastQueryTimestamp;
      expect(secondTimestamp! >= firstTimestamp!).toBe(true);
    });
  });

  // ==========================================================================
  // QUESTION TYPE TRACKING
  // ==========================================================================

  describe('Question Type Tracking', () => {
    test('tracks question type counts', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.85
      );

      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.95
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.byQuestionType['discovery'].count).toBe(2);
      expect(metrics.byQuestionType['aggregation'].count).toBe(1);
    });

    test('calculates average confidence per type', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.8
      );

      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.byQuestionType['discovery'].avgConfidence).toBeCloseTo(0.85, 5);
    });
  });

  // ==========================================================================
  // PERSONA TRACKING
  // ==========================================================================

  describe('Persona Tracking', () => {
    test('tracks persona usage counts', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.95
      );

      recordQueryExecution(
        'aggregation' as QuestionType,
        'forensic_analyst' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.byPersona['systems_thinker'].count).toBe(1);
      expect(metrics.byPersona['forensic_analyst'].count).toBe(2);
    });
  });

  // ==========================================================================
  // SECTION EXECUTION RECORDING
  // ==========================================================================

  describe('Section Execution Recording', () => {
    test('tracks section execution counts', () => {
      recordSectionExecution('semantic' as BlendSection, true, 100, 500);
      recordSectionExecution('semantic' as BlendSection, true, 150, 600);
      recordSectionExecution('exact' as BlendSection, true, 80, 400);

      const metrics = getBlendthinkMetrics();
      expect(metrics.bySection['semantic'].executions).toBe(2);
      expect(metrics.bySection['exact'].executions).toBe(1);
    });

    test('tracks section success/failure', () => {
      recordSectionExecution('semantic' as BlendSection, true, 100, 500);
      recordSectionExecution('semantic' as BlendSection, false, 50, 0);
      recordSectionExecution('semantic' as BlendSection, true, 120, 550);

      const metrics = getBlendthinkMetrics();
      expect(metrics.bySection['semantic'].successes).toBe(2);
      expect(metrics.bySection['semantic'].failures).toBe(1);
    });

    test('calculates average duration per section', () => {
      recordSectionExecution('semantic' as BlendSection, true, 100, 500);
      recordSectionExecution('semantic' as BlendSection, true, 200, 600);

      const metrics = getBlendthinkMetrics();
      expect(metrics.bySection['semantic'].avgDurationMs).toBe(150);
    });

    test('accumulates total tokens per section', () => {
      recordSectionExecution('exact' as BlendSection, true, 100, 500);
      recordSectionExecution('exact' as BlendSection, true, 120, 700);

      const metrics = getBlendthinkMetrics();
      expect(metrics.bySection['exact'].totalTokens).toBe(1200);
    });
  });

  // ==========================================================================
  // SESSION RECORDING
  // ==========================================================================

  describe('Session Recording', () => {
    test('increments totalSessions', () => {
      recordSession(5);
      recordSession(3);

      const metrics = getBlendthinkMetrics();
      expect(metrics.totalSessions).toBe(2);
    });

    test('calculates avgTurnsPerSession', () => {
      recordSession(4);
      recordSession(6);

      const metrics = getBlendthinkMetrics();
      expect(metrics.avgTurnsPerSession).toBe(5);
    });

    test('calculates running average correctly', () => {
      recordSession(10);
      recordSession(2);
      recordSession(6);

      const metrics = getBlendthinkMetrics();
      expect(metrics.avgTurnsPerSession).toBe(6); // (10+2+6)/3
    });
  });

  // ==========================================================================
  // METRICS SUMMARY
  // ==========================================================================

  describe('Metrics Summary', () => {
    test('returns markdown formatted summary', () => {
      const summary = getMetricsSummary();

      expect(summary).toContain('# Blendthink Metrics');
      expect(summary).toContain('## Overview');
      expect(summary).toContain('## Token Usage');
      expect(summary).toContain('## Timing');
      expect(summary).toContain('## Sessions');
    });

    test('includes success rate calculation', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        false,
        false,
        50,
        0,
        0,
        0.9
      );

      const summary = getMetricsSummary();
      expect(summary).toContain('Success Rate: 50.0%');
    });

    test('includes question type breakdown when present', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const summary = getMetricsSummary();
      expect(summary).toContain('## Question Types');
      expect(summary).toContain('discovery');
    });

    test('includes persona breakdown when present', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      const summary = getMetricsSummary();
      expect(summary).toContain('## Personas');
      expect(summary).toContain('systems_thinker');
    });

    test('includes section breakdown when present', () => {
      recordSectionExecution('semantic' as BlendSection, true, 100, 500);

      const summary = getMetricsSummary();
      expect(summary).toContain('## Section Execution');
      expect(summary).toContain('semantic');
    });
  });

  // ==========================================================================
  // RESET
  // ==========================================================================

  describe('Reset', () => {
    test('resets all counters to zero', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        500,
        200,
        0.9
      );

      recordSectionExecution('semantic' as BlendSection, true, 100, 500);
      recordSession(5);

      resetBlendthinkMetrics();

      const metrics = getBlendthinkMetrics();
      expect(metrics.totalQueries).toBe(0);
      expect(metrics.totalSessions).toBe(0);
      expect(Object.keys(metrics.byQuestionType).length).toBe(0);
      expect(Object.keys(metrics.byPersona).length).toBe(0);
      expect(Object.keys(metrics.bySection).length).toBe(0);
    });

    test('resets timestamps to null', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        100,
        100,
        50,
        0.9
      );

      resetBlendthinkMetrics();

      const metrics = getBlendthinkMetrics();
      expect(metrics.firstQueryTimestamp).toBeNull();
      expect(metrics.lastQueryTimestamp).toBeNull();
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    test('handles zero duration', () => {
      recordQueryExecution(
        'discovery' as QuestionType,
        'systems_thinker' as PersonaType,
        true,
        false,
        0, // zero duration
        100,
        50,
        0.9
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.minDurationMs).toBe(0);
      expect(metrics.maxDurationMs).toBe(0);
    });

    test('handles zero tokens', () => {
      recordQueryExecution(
        'unknown' as QuestionType,
        'neutral' as PersonaType,
        true,
        true,
        50,
        0,
        0,
        0.4
      );

      const metrics = getBlendthinkMetrics();
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
    });

    test('handles all question types', () => {
      const questionTypes: QuestionType[] = [
        'precise_query',
        'discovery',
        'aggregation',
        'aggregation_with_discovery',
        'relationship',
        'explanation',
        'comparison',
        'unknown',
      ];

      for (const type of questionTypes) {
        recordQueryExecution(
          type,
          'neutral' as PersonaType,
          true,
          false,
          100,
          100,
          50,
          0.9
        );
      }

      const metrics = getBlendthinkMetrics();
      expect(metrics.totalQueries).toBe(8);
      expect(Object.keys(metrics.byQuestionType).length).toBe(8);
    });

    test('handles all persona types', () => {
      const personaTypes: PersonaType[] = [
        'forensic_analyst',
        'systems_thinker',
        'socratic_guide',
        'neutral',
      ];

      for (const persona of personaTypes) {
        recordQueryExecution(
          'discovery' as QuestionType,
          persona,
          true,
          false,
          100,
          100,
          50,
          0.9
        );
      }

      const metrics = getBlendthinkMetrics();
      expect(Object.keys(metrics.byPersona).length).toBe(4);
    });

    test('handles all section types', () => {
      const sections: BlendSection[] = ['semantic', 'exact', 'knowledge', 'common'];

      for (const section of sections) {
        recordSectionExecution(section, true, 100, 500);
      }

      const metrics = getBlendthinkMetrics();
      expect(Object.keys(metrics.bySection).length).toBe(4);
    });
  });
});
