/**
 * Jest Unit Tests for PersonaSelector
 *
 * Tests persona selection based on question type
 * and system prompt generation.
 */

import { PersonaSelector, selectPersona, buildSystemPrompt, PERSONAS } from '../persona-selector.js';
import type { QuestionAnalysis, QuestionType, PersonaType } from '../../../common/types.js';

describe('PersonaSelector', () => {
  let selector: PersonaSelector;

  beforeEach(() => {
    selector = new PersonaSelector();
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
  // PERSONA DEFINITIONS
  // ==========================================================================

  describe('Persona Definitions', () => {
    test('PERSONAS constant contains all persona types', () => {
      const personaTypes: PersonaType[] = [
        'forensic_analyst',
        'systems_thinker',
        'socratic_guide',
        'neutral',
      ];

      for (const type of personaTypes) {
        expect(PERSONAS[type]).toBeDefined();
        expect(PERSONAS[type].name).toBeDefined();
        expect(PERSONAS[type].type).toBe(type);
      }
    });

    test('each persona has required properties', () => {
      for (const [type, persona] of Object.entries(PERSONAS)) {
        expect(persona.name).toBeTruthy();
        expect(persona.description).toBeTruthy();
        expect(persona.type).toBe(type);
        expect(persona.traits).toBeDefined();
        expect(persona.systemPrompt).toBeTruthy();
      }
    });

    test('personas have trait definitions', () => {
      for (const persona of Object.values(PERSONAS)) {
        expect(persona.traits.evidenceEmphasis).toBeDefined();
        expect(typeof persona.traits.asksFollowUps).toBe('boolean');
      }
    });
  });

  // ==========================================================================
  // PERSONA SELECTION BY QUESTION TYPE
  // ==========================================================================

  describe('Persona Selection by Question Type', () => {
    describe('forensic_analyst persona', () => {
      const forensicTypes: QuestionType[] = ['precise_query', 'aggregation'];

      test.each(forensicTypes)('selects forensic_analyst for %s', (type) => {
        const analysis = createAnalysis(type);
        const persona = selector.selectPersona(analysis);

        expect(persona.type).toBe('forensic_analyst');
        expect(persona.name).toBe('Forensic Analyst');
      });

      test('forensic_analyst traits', () => {
        const analysis = createAnalysis('precise_query');
        const persona = selector.selectPersona(analysis);

        expect(persona.traits.evidenceEmphasis).toBe('high');
        expect(persona.traits.asksFollowUps).toBe(false);
        expect(persona.traits.claimPrefix).toBe('The data shows');
      });
    });

    describe('systems_thinker persona', () => {
      const systemsTypes: QuestionType[] = ['discovery', 'relationship'];

      test.each(systemsTypes)('selects systems_thinker for %s', (type) => {
        const analysis = createAnalysis(type);
        const persona = selector.selectPersona(analysis);

        expect(persona.type).toBe('systems_thinker');
        expect(persona.name).toBe('Systems Thinker');
      });

      test('systems_thinker traits', () => {
        const analysis = createAnalysis('discovery');
        const persona = selector.selectPersona(analysis);

        expect(persona.traits.evidenceEmphasis).toBe('medium');
        expect(persona.traits.asksFollowUps).toBe(true);
      });
    });

    describe('socratic_guide persona', () => {
      const socraticTypes: QuestionType[] = ['explanation'];

      test.each(socraticTypes)('selects socratic_guide for %s', (type) => {
        const analysis = createAnalysis(type);
        const persona = selector.selectPersona(analysis);

        expect(persona.type).toBe('socratic_guide');
        expect(persona.name).toBe('Socratic Guide');
      });

      test('socratic_guide asks follow-ups', () => {
        const analysis = createAnalysis('explanation');
        const persona = selector.selectPersona(analysis);

        expect(persona.traits.asksFollowUps).toBe(true);
      });
    });

    describe('unknown type handling', () => {
      test('selects socratic_guide for unknown type (asks clarifying questions)', () => {
        const analysis = createAnalysis('unknown');
        const persona = selector.selectPersona(analysis);

        // Unknown queries get socratic_guide to ask clarifying questions
        expect(persona.type).toBe('socratic_guide');
        expect(persona.name).toBe('Socratic Guide');
      });

      test('socratic_guide asks follow-ups for clarification', () => {
        const analysis = createAnalysis('unknown');
        const persona = selector.selectPersona(analysis);

        expect(persona.traits.asksFollowUps).toBe(true);
      });
    });

    describe('hybrid types', () => {
      test('aggregation_with_discovery gets forensic_analyst', () => {
        const analysis = createAnalysis('aggregation_with_discovery');
        const persona = selector.selectPersona(analysis);

        // Aggregation is primary, so forensic_analyst should be selected
        expect(persona.type).toBe('forensic_analyst');
      });

      test('comparison gets forensic_analyst', () => {
        const analysis = createAnalysis('comparison');
        const persona = selector.selectPersona(analysis);

        expect(persona.type).toBe('forensic_analyst');
      });
    });
  });

  // ==========================================================================
  // SYSTEM PROMPT GENERATION
  // ==========================================================================

  describe('System Prompt Generation', () => {
    test('generates system prompt with persona context', () => {
      const analysis = createAnalysis('precise_query');
      const persona = selector.selectPersona(analysis);
      const prompt = selector.buildSystemPrompt(persona, analysis);

      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(100);
    });

    test('includes persona traits in prompt', () => {
      const analysis = createAnalysis('precise_query');
      const persona = selector.selectPersona(analysis);
      const prompt = selector.buildSystemPrompt(persona, analysis);

      expect(prompt.toLowerCase()).toContain('data');
      expect(prompt.toLowerCase()).toContain('evidence');
    });

    test('includes conversation context if provided', () => {
      const analysis = createAnalysis('discovery');
      const persona = selector.selectPersona(analysis);
      const context = 'Previous conversation about hospital projects';
      const prompt = selector.buildSystemPrompt(persona, analysis, context);

      expect(prompt).toContain(context);
    });

    test('system prompt varies by persona', () => {
      const forensicAnalysis = createAnalysis('precise_query');
      const forensicPersona = selector.selectPersona(forensicAnalysis);
      const forensicPrompt = selector.buildSystemPrompt(forensicPersona, forensicAnalysis);

      const discoveryAnalysis = createAnalysis('discovery');
      const systemsPersona = selector.selectPersona(discoveryAnalysis);
      const systemsPrompt = selector.buildSystemPrompt(systemsPersona, discoveryAnalysis);

      expect(forensicPrompt).not.toBe(systemsPrompt);
    });
  });

  // ==========================================================================
  // PERSONA PROPERTIES
  // ==========================================================================

  describe('Persona Properties', () => {
    test('forensic_analyst has claim prefix', () => {
      const persona = PERSONAS.forensic_analyst;
      expect(persona.traits.claimPrefix).toBe('The data shows');
    });

    test('all personas have description', () => {
      for (const persona of Object.values(PERSONAS)) {
        expect(persona.description.length).toBeGreaterThan(10);
      }
    });

    test('all personas have evidence emphasis level', () => {
      const validLevels = ['high', 'medium', 'low'];
      for (const persona of Object.values(PERSONAS)) {
        expect(validLevels).toContain(persona.traits.evidenceEmphasis);
      }
    });
  });

  // ==========================================================================
  // SINGLETON FUNCTIONS
  // ==========================================================================

  describe('Singleton Functions', () => {
    test('selectPersona returns same result as class method', () => {
      const analysis = createAnalysis('discovery');
      const classResult = selector.selectPersona(analysis);
      const singletonResult = selectPersona(analysis);

      expect(singletonResult.type).toBe(classResult.type);
      expect(singletonResult.name).toBe(classResult.name);
    });

    test('buildSystemPrompt returns system prompt string', () => {
      const analysis = createAnalysis('precise_query');

      // The singleton buildSystemPrompt takes (analysis, additionalContext?)
      const singletonPrompt = buildSystemPrompt(analysis);

      expect(singletonPrompt).toBeTruthy();
      expect(typeof singletonPrompt).toBe('string');
      expect(singletonPrompt.length).toBeGreaterThan(100);
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    test('handles low confidence analysis', () => {
      const analysis = createAnalysis('discovery', { confidence: 0.3 });
      const persona = selector.selectPersona(analysis);

      expect(persona).toBeDefined();
      // Might select neutral for low confidence
      expect(persona.type).toBeDefined();
    });

    test('handles analysis with no entities', () => {
      const analysis = createAnalysis('aggregation', { entities: [] });
      const persona = selector.selectPersona(analysis);

      expect(persona).toBeDefined();
      expect(persona.type).toBe('forensic_analyst');
    });

    test('handles needsClarification flag', () => {
      const analysis = createAnalysis('unknown', {
        needsClarification: true,
        clarificationQuestions: ['What would you like to know?'],
      });
      const persona = selector.selectPersona(analysis);

      expect(persona.traits.asksFollowUps).toBe(true);
    });
  });
});
