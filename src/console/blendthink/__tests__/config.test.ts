/**
 * Jest Unit Tests for Blendthink Configuration
 *
 * Tests configuration loading, validation, and defaults.
 */

import {
  DEFAULT_BLENDTHINK_CONFIG,
  loadBlendthinkConfig,
  validateConfig,
  getBlendthinkConfig,
} from '../config.js';
import type { BlendthinkConfig } from '../../../common/types.js';

describe('Blendthink Configuration', () => {
  // Save original env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.BLENDTHINK_MAX_TURNS;
    delete process.env.BLENDTHINK_TOKEN_BUDGET;
    delete process.env.BLENDTHINK_CONFIDENCE_THRESHOLD;
    delete process.env.BLENDTHINK_REQUIRE_ATTRIBUTION;
    delete process.env.BLENDTHINK_PERSIST_CONVERSATIONS;
    delete process.env.CLAUDE_MODEL;
  });

  afterAll(() => {
    // Restore env vars
    Object.assign(process.env, originalEnv);
  });

  // ==========================================================================
  // DEFAULT CONFIGURATION
  // ==========================================================================

  describe('Default Configuration', () => {
    test('has default maxTurns', () => {
      expect(DEFAULT_BLENDTHINK_CONFIG.maxTurns).toBe(5);
    });

    test('has default tokenBudget', () => {
      expect(DEFAULT_BLENDTHINK_CONFIG.tokenBudget).toBe(50000);
    });

    test('has default confidenceThreshold', () => {
      expect(DEFAULT_BLENDTHINK_CONFIG.confidenceThreshold).toBe(0.8);
    });

    test('has default requireAttribution', () => {
      expect(DEFAULT_BLENDTHINK_CONFIG.requireAttribution).toBe(true);
    });

    test('has default claudeModel', () => {
      expect(DEFAULT_BLENDTHINK_CONFIG.claudeModel).toBeDefined();
      expect(DEFAULT_BLENDTHINK_CONFIG.claudeModel).toContain('claude');
    });

    test('has default persistConversations', () => {
      expect(DEFAULT_BLENDTHINK_CONFIG.persistConversations).toBe(true);
    });
  });

  // ==========================================================================
  // LOADING CONFIGURATION
  // ==========================================================================

  describe('Loading Configuration', () => {
    test('returns default config when no overrides', () => {
      const config = loadBlendthinkConfig();

      expect(config.maxTurns).toBe(DEFAULT_BLENDTHINK_CONFIG.maxTurns);
      expect(config.tokenBudget).toBe(DEFAULT_BLENDTHINK_CONFIG.tokenBudget);
    });

    test('applies overrides correctly', () => {
      const overrides: Partial<BlendthinkConfig> = {
        maxTurns: 10,
        tokenBudget: 100000,
      };

      const config = loadBlendthinkConfig(overrides);

      expect(config.maxTurns).toBe(10);
      expect(config.tokenBudget).toBe(100000);
      // Non-overridden values should be defaults
      expect(config.confidenceThreshold).toBe(DEFAULT_BLENDTHINK_CONFIG.confidenceThreshold);
    });

    test('reads BLENDTHINK_MAX_TURNS from environment', () => {
      process.env.BLENDTHINK_MAX_TURNS = '15';

      const config = loadBlendthinkConfig();

      expect(config.maxTurns).toBe(15);
    });

    test('reads BLENDTHINK_TOKEN_BUDGET from environment', () => {
      process.env.BLENDTHINK_TOKEN_BUDGET = '75000';

      const config = loadBlendthinkConfig();

      expect(config.tokenBudget).toBe(75000);
    });

    test('reads BLENDTHINK_CONFIDENCE_THRESHOLD from environment', () => {
      process.env.BLENDTHINK_CONFIDENCE_THRESHOLD = '0.9';

      const config = loadBlendthinkConfig();

      expect(config.confidenceThreshold).toBe(0.9);
    });

    test('reads CLAUDE_MODEL from environment', () => {
      process.env.CLAUDE_MODEL = 'claude-opus-4-20250514';

      const config = loadBlendthinkConfig();

      expect(config.claudeModel).toBe('claude-opus-4-20250514');
    });

    test('reads BLENDTHINK_REQUIRE_ATTRIBUTION from environment', () => {
      process.env.BLENDTHINK_REQUIRE_ATTRIBUTION = 'false';

      const config = loadBlendthinkConfig();

      expect(config.requireAttribution).toBe(false);
    });

    test('reads BLENDTHINK_PERSIST_CONVERSATIONS from environment', () => {
      process.env.BLENDTHINK_PERSIST_CONVERSATIONS = 'false';

      const config = loadBlendthinkConfig();

      expect(config.persistConversations).toBe(false);
    });

    test('overrides take precedence over environment', () => {
      process.env.BLENDTHINK_MAX_TURNS = '15';

      const config = loadBlendthinkConfig({ maxTurns: 20 });

      expect(config.maxTurns).toBe(20);
    });

    test('environment takes precedence over defaults', () => {
      process.env.BLENDTHINK_MAX_TURNS = '12';

      const config = loadBlendthinkConfig();

      expect(config.maxTurns).toBe(12);
    });
  });

  // ==========================================================================
  // CONFIGURATION VALIDATION
  // ==========================================================================

  describe('Configuration Validation', () => {
    test('valid config returns no errors', () => {
      const errors = validateConfig(DEFAULT_BLENDTHINK_CONFIG);

      expect(errors).toEqual([]);
    });

    test('maxTurns below 1 is invalid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        maxTurns: 0,
      };

      const errors = validateConfig(config);

      expect(errors).toContain('maxTurns must be between 1 and 20');
    });

    test('maxTurns above 20 is invalid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        maxTurns: 25,
      };

      const errors = validateConfig(config);

      expect(errors).toContain('maxTurns must be between 1 and 20');
    });

    test('tokenBudget below 1000 is invalid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        tokenBudget: 500,
      };

      const errors = validateConfig(config);

      expect(errors).toContain('tokenBudget must be between 1,000 and 200,000');
    });

    test('tokenBudget above 200000 is invalid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        tokenBudget: 300000,
      };

      const errors = validateConfig(config);

      expect(errors).toContain('tokenBudget must be between 1,000 and 200,000');
    });

    test('confidenceThreshold below 0 is invalid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        confidenceThreshold: -0.1,
      };

      const errors = validateConfig(config);

      expect(errors).toContain('confidenceThreshold must be between 0 and 1');
    });

    test('confidenceThreshold above 1 is invalid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        confidenceThreshold: 1.5,
      };

      const errors = validateConfig(config);

      expect(errors).toContain('confidenceThreshold must be between 0 and 1');
    });

    test('multiple validation errors can occur', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        maxTurns: 0,
        tokenBudget: 500,
        confidenceThreshold: 2,
      };

      const errors = validateConfig(config);

      expect(errors.length).toBe(3);
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    test('boundary value maxTurns = 1 is valid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        maxTurns: 1,
      };

      const errors = validateConfig(config);

      expect(errors).toEqual([]);
    });

    test('boundary value maxTurns = 20 is valid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        maxTurns: 20,
      };

      const errors = validateConfig(config);

      expect(errors).toEqual([]);
    });

    test('boundary value tokenBudget = 1000 is valid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        tokenBudget: 1000,
      };

      const errors = validateConfig(config);

      expect(errors).toEqual([]);
    });

    test('boundary value tokenBudget = 200000 is valid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        tokenBudget: 200000,
      };

      const errors = validateConfig(config);

      expect(errors).toEqual([]);
    });

    test('boundary value confidenceThreshold = 0 is valid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        confidenceThreshold: 0,
      };

      const errors = validateConfig(config);

      expect(errors).toEqual([]);
    });

    test('boundary value confidenceThreshold = 1 is valid', () => {
      const config: BlendthinkConfig = {
        ...DEFAULT_BLENDTHINK_CONFIG,
        confidenceThreshold: 1,
      };

      const errors = validateConfig(config);

      expect(errors).toEqual([]);
    });
  });

  // ==========================================================================
  // SINGLETON
  // ==========================================================================

  describe('Singleton getBlendthinkConfig', () => {
    test('returns config object', () => {
      const config = getBlendthinkConfig();

      expect(config).toBeDefined();
      expect(config.maxTurns).toBeDefined();
      expect(config.tokenBudget).toBeDefined();
    });
  });
});
