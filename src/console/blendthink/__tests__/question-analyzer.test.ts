/**
 * Jest Unit Tests for QuestionAnalyzer
 *
 * Tests the question classification, entity extraction,
 * and clarification generation functionality.
 */

import { QuestionAnalyzer, analyzeQuestion } from '../question-analyzer.js';
import type { QuestionType } from '../../../common/types.js';

describe('QuestionAnalyzer', () => {
  let analyzer: QuestionAnalyzer;

  beforeEach(() => {
    analyzer = new QuestionAnalyzer();
  });

  // ==========================================================================
  // QUESTION TYPE CLASSIFICATION
  // ==========================================================================

  describe('Question Type Classification', () => {
    describe('precise_query', () => {
      const preciseQueries = [
        'What is the balance of account 123?',
        'Get me record id:45678',
        'Show me the details of partner ABC Corp',
        'crm.lead record 41085',
        'partner 286798',
        'Show me the balance for account 319',
        'lookup record 12345',
      ];

      test.each(preciseQueries)('classifies "%s" as precise_query', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('precise_query');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('discovery', () => {
      const discoveryQueries = [
        'Find hospital projects in Victoria',
        'Search for similar leads to Hansen Yuncken',
        'List all partners like Wadsworth',
        'Show me all contacts related to construction',
      ];

      test.each(discoveryQueries)('classifies "%s" as discovery', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('discovery');
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      });
    });

    describe('aggregation', () => {
      const aggregationQueries = [
        'What is the total revenue?',
        'Count all invoices this month',
        'Sum of all transactions',
        'Average order value by customer',
        'How many leads are there?',
      ];

      test.each(aggregationQueries)('classifies "%s" as aggregation', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('aggregation');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('aggregation_with_discovery', () => {
      const hybridQueries = [
        'Total revenue for hospital projects in Victoria',
        'Sum of invoices for clients similar to Hansen',
        'Count leads related to construction in Sydney',
      ];

      test.each(hybridQueries)('classifies "%s" as aggregation_with_discovery', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('aggregation_with_discovery');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('relationship', () => {
      const relationshipQueries = [
        'How is partner 286798 connected to other records?',
        'Show me the FK relationships for crm.lead',
        'What records reference this invoice?',
        'What items are linked to this partner?',
      ];

      test.each(relationshipQueries)('classifies "%s" as relationship', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('relationship');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('explanation', () => {
      const explanationQueries = [
        'Why did this variance occur?',
        'What caused the revenue drop?',
        'Explain why sales decreased',
        'Why is this account negative?',
      ];

      test.each(explanationQueries)('classifies "%s" as explanation', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('explanation');
        expect(result.confidence).toBeGreaterThanOrEqual(0.7);
      });
    });

    describe('comparison', () => {
      const comparisonQueries = [
        'Compare Q1 vs Q2 performance',
        'Difference between this year and last year',
        'Hansen Yuncken vs Wadsworth revenue',
        'This month versus last month',
      ];

      test.each(comparisonQueries)('classifies "%s" as comparison', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.type).toBe('comparison');
        expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      });
    });

    describe('unknown / needs clarification', () => {
      const unclearQueries = [
        'Help me',
        'What?',
        'Show me stuff',
        'Data',
      ];

      test.each(unclearQueries)('classifies "%s" as needing clarification', async (query) => {
        const result = await analyzer.analyze(query);
        expect(result.needsClarification).toBe(true);
        expect(result.clarificationQuestions).toBeDefined();
        expect(result.clarificationQuestions!.length).toBeGreaterThan(0);
      });
    });
  });

  // ==========================================================================
  // ENTITY EXTRACTION
  // ==========================================================================

  describe('Entity Extraction', () => {
    test('extracts record IDs (id:N format)', async () => {
      const result = await analyzer.analyze('Get record id:12345');
      expect(result.entities).toContain('id:12345');
    });

    test('extracts entity + number patterns', async () => {
      const result = await analyzer.analyze('Show me partner 286798');
      expect(result.entities).toContain('partner:286798');
    });

    test('extracts model + record patterns', async () => {
      const result = await analyzer.analyze('crm.lead record 41085');
      expect(result.entities).toContain('model:crm.lead');
      expect(result.entities).toContain('id:41085');
    });

    test('extracts quoted entities', async () => {
      const result = await analyzer.analyze('Find partners like "Hansen Yuncken"');
      expect(result.entities).toContain('Hansen Yuncken');
    });

    test('extracts location hints', async () => {
      const result = await analyzer.analyze('Hospital projects in Victoria');
      expect(result.entities).toContain('location:Victoria');
    });

    test('extracts capitalized names', async () => {
      const result = await analyzer.analyze('Find transactions for Hansen Yuncken Pty Ltd');
      expect(result.entities).toContain('Hansen Yuncken Pty Ltd');
    });

    test('extracts date patterns', async () => {
      const result = await analyzer.analyze('Invoices from 2025-01-01');
      expect(result.entities.some(e => e.startsWith('date:'))).toBe(true);
    });

    test('extracts month + year patterns', async () => {
      const result = await analyzer.analyze('Balance for March 2025');
      expect(result.entities).toContain('date:March 2025');
    });

    test('handles multiple entities', async () => {
      const result = await analyzer.analyze('Compare partner 286798 with partner 282161 in Victoria');
      expect(result.entities).toContain('partner:286798');
      expect(result.entities).toContain('partner:282161');
      expect(result.entities).toContain('location:Victoria');
    });
  });

  // ==========================================================================
  // FIELD HINTS
  // ==========================================================================

  describe('Field Hint Extraction', () => {
    test('extracts revenue field hints', async () => {
      const result = await analyzer.analyze('Total revenue for partners');
      expect(result.fieldHints).toContain('revenue');
      expect(result.fieldHints).toContain('expected_revenue');
    });

    test('extracts balance field hints', async () => {
      const result = await analyzer.analyze('Show me the balance');
      expect(result.fieldHints).toContain('balance');
      expect(result.fieldHints).toContain('debit');
      expect(result.fieldHints).toContain('credit');
    });

    test('extracts date field hints', async () => {
      const result = await analyzer.analyze('Filter by date');
      expect(result.fieldHints).toContain('date');
      expect(result.fieldHints).toContain('create_date');
    });
  });

  // ==========================================================================
  // MODEL HINTS
  // ==========================================================================

  describe('Model Hint Extraction', () => {
    test('hints crm.lead for lead/opportunity queries', async () => {
      const result = await analyzer.analyze('Find all leads');
      expect(result.modelHints).toContain('crm.lead');
    });

    test('hints res.partner for partner/customer queries', async () => {
      const result = await analyzer.analyze('List all customers');
      expect(result.modelHints).toContain('res.partner');
    });

    test('hints account.move.line for transaction queries', async () => {
      const result = await analyzer.analyze('Show transactions for this account');
      expect(result.modelHints).toContain('account.move.line');
    });

    test('hints account.move for invoice queries', async () => {
      const result = await analyzer.analyze('Find all invoices');
      expect(result.modelHints).toContain('account.move');
    });
  });

  // ==========================================================================
  // CLARIFICATION QUESTIONS
  // ==========================================================================

  describe('Clarification Question Generation', () => {
    test('generates questions for empty entity queries', async () => {
      const result = await analyzer.analyze('Show me data');
      expect(result.needsClarification).toBe(true);
      expect(result.clarificationQuestions?.some(q =>
        q.toLowerCase().includes('records') || q.toLowerCase().includes('entities')
      )).toBe(true);
    });

    test('generates questions for short ambiguous queries', async () => {
      const result = await analyzer.analyze('Help');
      expect(result.needsClarification).toBe(true);
      expect(result.clarificationQuestions?.length).toBeLessThanOrEqual(2);
    });

    test('limits clarification questions to 2', async () => {
      const result = await analyzer.analyze('?');
      expect(result.clarificationQuestions?.length).toBeLessThanOrEqual(2);
    });
  });

  // ==========================================================================
  // CONFIDENCE SCORING
  // ==========================================================================

  describe('Confidence Scoring', () => {
    test('high confidence for clear pattern matches', async () => {
      const result = await analyzer.analyze('What is the total revenue?');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    test('lower confidence for ambiguous queries', async () => {
      const result = await analyzer.analyze('stuff');
      expect(result.confidence).toBeLessThan(0.5);
    });

    test('medium confidence for partial matches', async () => {
      const result = await analyzer.analyze('data for partners');
      expect(result.confidence).toBeGreaterThanOrEqual(0.3);
      expect(result.confidence).toBeLessThanOrEqual(0.9);
    });
  });

  // ==========================================================================
  // SINGLETON FUNCTION
  // ==========================================================================

  describe('analyzeQuestion singleton', () => {
    test('returns same structure as class method', async () => {
      const query = 'Find hospital projects';
      const classResult = await analyzer.analyze(query);
      const singletonResult = await analyzeQuestion(query);

      expect(singletonResult.type).toBe(classResult.type);
      expect(singletonResult.query).toBe(classResult.query);
    });
  });
});
