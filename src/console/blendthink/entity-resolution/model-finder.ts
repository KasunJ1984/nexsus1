/**
 * Model Finder
 *
 * Discovers the correct Odoo model for a query using semantic search
 * on schema points instead of hardcoded MODEL_HINTS dictionary.
 *
 * Process:
 * 1. Identify domain from keywords (financial, crm, hr, inventory)
 * 2. Expand search terms with domain-specific vocabulary
 * 3. Search schema for matching field definitions
 * 4. Aggregate by model and score by field match count
 * 5. Return best model with confidence
 */

import { embed } from '../../../common/services/embedding-service.js';
import { searchByPointType } from '../../../common/services/vector-client.js';
import type { ModelResolution } from './types.js';

// =============================================================================
// DOMAIN DETECTION
// =============================================================================

/**
 * Domain types that can be detected from query keywords
 */
export type Domain = 'financial' | 'crm' | 'hr' | 'inventory' | 'general';

/**
 * Keywords that indicate a specific domain
 * These are NOT hardcoded model mappings - they're search expansion hints
 */
const DOMAIN_INDICATORS: Record<Domain, string[]> = {
  financial: [
    'expense',
    'expenses',
    'revenue',
    'income',
    'profit',
    'loss',
    'gl',
    'journal',
    'debit',
    'credit',
    'balance',
    'account',
    'invoice',
    'bill',
    'payment',
    'tax',
    'vat',
    'gst',
    'ledger',
    'fiscal',
    'budget',
    'cost',
    'welfare',
    'salary',
    'wage',
  ],
  crm: [
    'lead',
    'leads',
    'opportunity',
    'opportunities',
    'deal',
    'deals',
    'prospect',
    'sales',
    'pipeline',
    'won',
    'lost',
    'customer',
    'client',
    'contact',
    'campaign',
  ],
  hr: [
    'employee',
    'employees',
    'staff',
    'payroll',
    'leave',
    'attendance',
    'timesheet',
    'department',
    'job',
    'position',
    'recruitment',
    'applicant',
  ],
  inventory: [
    'product',
    'products',
    'stock',
    'warehouse',
    'inventory',
    'quantity',
    'lot',
    'serial',
    'barcode',
    'category',
    'variant',
  ],
  general: [],
};

/**
 * Search terms to expand when a domain is detected
 * These help find the right schema fields
 */
const DOMAIN_EXPANSIONS: Record<Domain, string[]> = {
  financial: ['journal', 'entry', 'transaction', 'move', 'line', 'account'],
  crm: ['lead', 'opportunity', 'pipeline', 'stage'],
  hr: ['employee', 'contract', 'leave', 'attendance'],
  inventory: ['product', 'stock', 'quant', 'move'],
  general: [],
};

/**
 * Identify the domain from query entities and text
 */
export function identifyDomain(entities: string[], queryText: string): Domain {
  const combined = [...entities, queryText].join(' ').toLowerCase();

  let bestDomain: Domain = 'general';
  let bestCount = 0;

  for (const [domain, indicators] of Object.entries(DOMAIN_INDICATORS)) {
    if (domain === 'general') continue;

    const count = indicators.filter((ind) => combined.includes(ind)).length;
    if (count > bestCount) {
      bestCount = count;
      bestDomain = domain as Domain;
    }
  }

  // Require at least one indicator match
  return bestCount >= 1 ? bestDomain : 'general';
}

// =============================================================================
// MODEL FINDER
// =============================================================================

/**
 * Default models for each domain when schema search fails
 * These are fallbacks, not primary resolution
 */
const DOMAIN_DEFAULT_MODELS: Record<Domain, string> = {
  financial: 'account.move.line',
  crm: 'crm.lead',
  hr: 'hr.employee',
  inventory: 'product.product',
  general: 'res.partner',
};

/**
 * Find the best matching Odoo model for a query
 *
 * @param entities - Entities extracted from query
 * @param queryText - Original query text
 * @returns ModelResolution or null if no good match found
 *
 * @example
 * findModel(['expenses', 'Jan-25'], 'Jan-25 staff welfare expenses')
 * // Returns: { modelName: 'account.move.line', confidence: 0.85, ... }
 */
export async function findModel(
  entities: string[],
  queryText: string
): Promise<ModelResolution | null> {
  try {
    // Step 1: Identify domain
    const domain = identifyDomain(entities, queryText);
    console.error(`[ModelFinder] Detected domain: ${domain}`);

    // Step 2: Build search query with domain expansions
    const expansions = DOMAIN_EXPANSIONS[domain] || [];
    const searchTerms = [...entities.filter((e) => e.length > 2), ...expansions];
    const searchQuery = searchTerms.join(' ');

    if (!searchQuery.trim()) {
      console.error('[ModelFinder] No search terms, using domain default');
      return createDomainDefault(domain);
    }

    console.error(`[ModelFinder] Search query: "${searchQuery}"`);

    // Step 3: Embed the search query
    const embedding = await embed(searchQuery, 'query');
    if (!embedding) {
      console.error('[ModelFinder] Failed to embed query, using domain default');
      return createDomainDefault(domain);
    }

    // Step 4: Search schema for matching fields
    const results = await searchByPointType(embedding, {
      limit: 20,
      minScore: 0.4,
      pointType: 'schema',
    });

    if (!results || results.length === 0) {
      console.error('[ModelFinder] No schema matches, using domain default');
      return createDomainDefault(domain);
    }

    console.error(`[ModelFinder] Found ${results.length} schema matches`);

    // Step 5: Aggregate by model and score
    const modelScores = new Map<
      string,
      {
        totalScore: number;
        count: number;
        keywords: string[];
        maxScore: number;
      }
    >();

    for (const result of results) {
      const payload = result.payload as Record<string, unknown>;
      const modelName = payload?.model_name as string;
      const fieldName = payload?.field_name as string;

      if (!modelName) continue;

      const existing = modelScores.get(modelName) || {
        totalScore: 0,
        count: 0,
        keywords: [],
        maxScore: 0,
      };

      existing.totalScore += result.score;
      existing.count += 1;
      existing.maxScore = Math.max(existing.maxScore, result.score);
      if (fieldName && !existing.keywords.includes(fieldName)) {
        existing.keywords.push(fieldName);
      }

      modelScores.set(modelName, existing);
    }

    // Step 6: Select best model with domain-specific preferences
    let bestModel: string | null = null;
    let bestScore = 0;
    let bestKeywords: string[] = [];

    // Domain-specific model preferences (prefer synced models over parent models)
    // For financial domain, we sync account.move.line (journal entries), not account.move (invoice headers)
    const MODEL_PREFERENCES: Partial<Record<Domain, Record<string, string>>> = {
      financial: {
        'account.move': 'account.move.line', // Prefer line items over headers
      },
    };

    for (const [model, data] of modelScores) {
      // Score formula: average score * log boost for field count
      const avgScore = data.totalScore / data.count;
      const fieldCountBoost = 1 + Math.log(data.count + 1) * 0.15;
      let finalScore = avgScore * fieldCountBoost;

      // Apply domain-specific model preference boost
      const preferences = MODEL_PREFERENCES[domain];
      const preferredModel = preferences?.[model];
      if (preferredModel && modelScores.has(preferredModel)) {
        // If this model should be replaced by a preferred model, penalize it
        finalScore *= 0.8; // 20% penalty for non-preferred models
        console.error(
          `[ModelFinder] Model ${model}: penalized (prefer ${preferredModel})`
        );
      }

      // Boost the preferred model if it exists in the results
      const isPreferred = Object.values(preferences || {}).includes(model);
      if (isPreferred) {
        finalScore *= 1.25; // 25% boost for preferred models
        console.error(`[ModelFinder] Model ${model}: boosted (domain preference)`);
      }

      console.error(
        `[ModelFinder] Model ${model}: avgScore=${avgScore.toFixed(3)}, ` +
          `fields=${data.count}, finalScore=${finalScore.toFixed(3)}`
      );

      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestModel = model;
        bestKeywords = data.keywords.slice(0, 5); // Top 5 matched fields
      }
    }

    // Step 7: Validate and return
    if (!bestModel) {
      console.error('[ModelFinder] No valid model found, using domain default');
      return createDomainDefault(domain);
    }

    // Confidence threshold
    const minConfidence = 0.5;
    if (bestScore < minConfidence) {
      console.error(
        `[ModelFinder] Best score ${bestScore.toFixed(3)} below threshold, using domain default`
      );
      return createDomainDefault(domain);
    }

    const resolution: ModelResolution = {
      modelName: bestModel,
      confidence: Math.min(bestScore, 1.0),
      matchedKeywords: bestKeywords,
      source: 'schema_search',
    };

    console.error(
      `[ModelFinder] Selected: ${bestModel} (confidence: ${resolution.confidence.toFixed(3)})`
    );

    return resolution;
  } catch (error) {
    console.error('[ModelFinder] Error:', error);
    return null;
  }
}

/**
 * Create a default model resolution based on domain
 */
function createDomainDefault(domain: Domain): ModelResolution {
  return {
    modelName: DOMAIN_DEFAULT_MODELS[domain],
    confidence: 0.6, // Lower confidence for defaults
    matchedKeywords: [],
    source: 'default',
  };
}

/**
 * Quick check if model finder should be used
 * Returns false for queries with explicit model mentions
 */
export function shouldFindModel(queryText: string, entities: string[]): boolean {
  // Skip if query already mentions a specific model
  const modelPattern = /\b(crm\.lead|res\.partner|account\.move|product\.product)\b/i;
  if (modelPattern.test(queryText)) {
    return false;
  }

  // Skip if we have a direct ID lookup
  const idPattern = /\b(id|record)\s*[:=]\s*\d+\b/i;
  if (idPattern.test(queryText)) {
    return false;
  }

  return true;
}

/**
 * Get model suggestions for ambiguous queries
 * Returns multiple possible models with their confidence
 */
export async function suggestModels(
  entities: string[],
  queryText: string,
  limit: number = 3
): Promise<ModelResolution[]> {
  try {
    const domain = identifyDomain(entities, queryText);
    const expansions = DOMAIN_EXPANSIONS[domain] || [];
    const searchTerms = [...entities.filter((e) => e.length > 2), ...expansions];
    const searchQuery = searchTerms.join(' ');

    if (!searchQuery.trim()) {
      return [createDomainDefault(domain)];
    }

    const embedding = await embed(searchQuery, 'query');
    if (!embedding) {
      return [createDomainDefault(domain)];
    }

    const results = await searchByPointType(embedding, {
      limit: 30,
      minScore: 0.35,
      pointType: 'schema',
    });

    if (!results || results.length === 0) {
      return [createDomainDefault(domain)];
    }

    // Aggregate by model
    const modelScores = new Map<string, { totalScore: number; count: number; keywords: string[] }>();

    for (const result of results) {
      const payload = result.payload as Record<string, unknown>;
      const modelName = payload?.model_name as string;
      const fieldName = payload?.field_name as string;

      if (!modelName) continue;

      const existing = modelScores.get(modelName) || { totalScore: 0, count: 0, keywords: [] };
      existing.totalScore += result.score;
      existing.count += 1;
      if (fieldName) existing.keywords.push(fieldName);
      modelScores.set(modelName, existing);
    }

    // Sort by score and return top N
    const suggestions: ModelResolution[] = [];

    const sorted = Array.from(modelScores.entries())
      .map(([model, data]) => ({
        model,
        score: (data.totalScore / data.count) * (1 + Math.log(data.count + 1) * 0.15),
        keywords: data.keywords.slice(0, 3),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    for (const item of sorted) {
      suggestions.push({
        modelName: item.model,
        confidence: Math.min(item.score, 1.0),
        matchedKeywords: item.keywords,
        source: 'schema_search',
      });
    }

    return suggestions.length > 0 ? suggestions : [createDomainDefault(domain)];
  } catch (error) {
    console.error('[ModelFinder] suggestModels error:', error);
    return [];
  }
}
