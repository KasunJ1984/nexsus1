/**
 * Blendthink Configuration
 *
 * Default configuration values for the blendthink engine.
 * Can be overridden via environment variables or per-session.
 */

import type { BlendthinkConfig } from '../../common/types.js';

/**
 * Default blendthink configuration
 */
export const DEFAULT_BLENDTHINK_CONFIG: BlendthinkConfig = {
  // Maximum refinement turns before forcing synthesis
  maxTurns: 5,

  // Maximum tokens per session (input + output combined)
  tokenBudget: 50000,

  // Minimum confidence to return answer (0-1)
  // Below this, blendthink will admit uncertainty
  confidenceThreshold: 0.8,

  // Require source attribution for every claim
  requireAttribution: true,

  // Claude API model to use
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',

  // Whether to persist conversations to Qdrant
  persistConversations: true,
};

/**
 * Load configuration from environment variables
 */
export function loadBlendthinkConfig(
  overrides?: Partial<BlendthinkConfig>
): BlendthinkConfig {
  const envConfig: Partial<BlendthinkConfig> = {};

  // Parse environment overrides
  if (process.env.BLENDTHINK_MAX_TURNS) {
    envConfig.maxTurns = parseInt(process.env.BLENDTHINK_MAX_TURNS, 10);
  }

  if (process.env.BLENDTHINK_TOKEN_BUDGET) {
    envConfig.tokenBudget = parseInt(process.env.BLENDTHINK_TOKEN_BUDGET, 10);
  }

  if (process.env.BLENDTHINK_CONFIDENCE_THRESHOLD) {
    envConfig.confidenceThreshold = parseFloat(
      process.env.BLENDTHINK_CONFIDENCE_THRESHOLD
    );
  }

  if (process.env.BLENDTHINK_REQUIRE_ATTRIBUTION) {
    envConfig.requireAttribution =
      process.env.BLENDTHINK_REQUIRE_ATTRIBUTION === 'true';
  }

  if (process.env.CLAUDE_MODEL) {
    envConfig.claudeModel = process.env.CLAUDE_MODEL;
  }

  if (process.env.BLENDTHINK_PERSIST_CONVERSATIONS) {
    envConfig.persistConversations =
      process.env.BLENDTHINK_PERSIST_CONVERSATIONS === 'true';
  }

  // Merge: defaults < env < overrides
  return {
    ...DEFAULT_BLENDTHINK_CONFIG,
    ...envConfig,
    ...overrides,
  };
}

// Singleton config instance
let configInstance: BlendthinkConfig | null = null;

/**
 * Get the current blendthink configuration (singleton)
 */
export function getBlendthinkConfig(): BlendthinkConfig {
  if (!configInstance) {
    configInstance = loadBlendthinkConfig();
  }
  return configInstance;
}

/**
 * Validate configuration values
 */
export function validateConfig(config: BlendthinkConfig): string[] {
  const errors: string[] = [];

  if (config.maxTurns < 1 || config.maxTurns > 20) {
    errors.push('maxTurns must be between 1 and 20');
  }

  if (config.tokenBudget < 1000 || config.tokenBudget > 200000) {
    errors.push('tokenBudget must be between 1,000 and 200,000');
  }

  if (config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
    errors.push('confidenceThreshold must be between 0 and 1');
  }

  return errors;
}
