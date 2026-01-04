/**
 * Analytics Service - Self-Improving Field Learning
 *
 * NEXUS Stage 5: Tracks field usage to improve decode display over time
 *
 * **Key capabilities:**
 * - Track which fields are decoded most often
 * - Track which fields appear in search results
 * - Calculate field importance scores (0-100)
 * - Automatically suggest field promotions to key fields
 * - Persist analytics to disk (survives restarts)
 * - Clear analytics when schema changes
 *
 * **Self-improvement flow:**
 * ```
 * User searches → Results decoded
 *       ↓
 * Analytics tracks fields shown
 *       ↓
 * Over time: field "x_sector" decoded 500 times
 *       ↓
 * Analytics calculates importance score > 50
 *       ↓
 * Field promoted to "suggested key fields"
 *       ↓
 * Next search: x_sector shown in key fields
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { ANALYTICS_CONFIG, KEY_FIELDS_CONFIG, TRAINING_CONFIG } from '../../common/constants.js';
import type {
  AnalyticsData,
  FieldUsageRecord,
  FieldImportanceScore,
  AnalyticsSummary,
  TrainingPair,
  TrainingStats,
} from '../../common/types.js';

// =============================================================================
// STATE
// =============================================================================

/** In-memory analytics data (persisted periodically) */
let analyticsData: AnalyticsData | null = null;

/** Timer for periodic persistence */
let persistTimer: NodeJS.Timeout | null = null;

/** Flag to track if data has changed since last persist */
let isDirty = false;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the analytics service
 *
 * Loads existing analytics data from file if available.
 * If schema has changed (detected by hash), clears old analytics.
 *
 * @param schemaHash - Hash of current schema (used to detect changes)
 */
export function initializeAnalytics(schemaHash: string): void {
  const filePath = path.resolve(process.cwd(), ANALYTICS_CONFIG.DATA_FILE);

  // Try to load existing analytics
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const loaded = JSON.parse(raw) as AnalyticsData;

      // Check if schema has changed
      if (ANALYTICS_CONFIG.CLEAR_ON_SCHEMA_CHANGE &&
          loaded.schema_hash !== schemaHash) {
        console.error('[Analytics] Schema changed, clearing old analytics data');
        analyticsData = null;
      } else {
        analyticsData = loaded;
        console.error(`[Analytics] Loaded ${Object.keys(analyticsData.field_usage).length} field usage records`);
      }
    } catch (error) {
      console.error('[Analytics] Failed to load analytics file, starting fresh:', error);
      analyticsData = null;
    }
  }

  // Initialize fresh if needed
  if (!analyticsData) {
    analyticsData = createEmptyAnalytics(schemaHash);
    console.error('[Analytics] Initialized empty analytics store');
  }

  // Start periodic persistence timer
  if (!persistTimer) {
    persistTimer = setInterval(() => {
      persistAnalytics();
    }, ANALYTICS_CONFIG.PERSIST_INTERVAL_MS);
    console.error(`[Analytics] Persistence timer started (${ANALYTICS_CONFIG.PERSIST_INTERVAL_MS}ms interval)`);
  }
}

/**
 * Create empty analytics data structure
 */
function createEmptyAnalytics(schemaHash: string): AnalyticsData {
  return {
    version: 1,
    schema_hash: schemaHash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    field_usage: {},
    total_decodes: 0,
    total_searches: 0,
  };
}

// =============================================================================
// TRACKING FUNCTIONS
// =============================================================================

/**
 * Track field usage (non-blocking, fire-and-forget)
 *
 * Called automatically during decode operations to track which fields
 * are being shown to users. This data drives the self-improvement.
 *
 * @param modelName - Model name (e.g., "crm.lead")
 * @param fieldName - Field name (e.g., "expected_revenue")
 * @param context - 'decode' for decoded fields, 'search' for search results
 */
export function trackFieldUsage(
  modelName: string,
  fieldName: string,
  context: 'decode' | 'search'
): void {
  if (!analyticsData) {
    return; // Analytics not initialized
  }

  const key = `${modelName}.${fieldName}`;

  // Create or update usage record
  if (!analyticsData.field_usage[key]) {
    analyticsData.field_usage[key] = {
      model_name: modelName,
      field_name: fieldName,
      coordinate: '', // Could be filled if needed
      decode_count: 0,
      search_count: 0,
      last_used: new Date().toISOString(),
    };
  }

  const record = analyticsData.field_usage[key];

  if (context === 'decode') {
    record.decode_count++;
    analyticsData.total_decodes++;
  } else {
    record.search_count++;
    analyticsData.total_searches++;
  }

  record.last_used = new Date().toISOString();
  isDirty = true;

  // Prune if too many entries (keep most recent)
  if (Object.keys(analyticsData.field_usage).length > ANALYTICS_CONFIG.MAX_FIELD_ENTRIES) {
    pruneOldEntries();
  }
}

/**
 * Track multiple fields at once (batch tracking)
 *
 * Efficient for tracking all decoded fields from a single record.
 *
 * @param modelName - Model name
 * @param fieldNames - Array of field names
 * @param context - 'decode' or 'search'
 */
export function trackFieldUsageBatch(
  modelName: string,
  fieldNames: string[],
  context: 'decode' | 'search'
): void {
  for (const fieldName of fieldNames) {
    trackFieldUsage(modelName, fieldName, context);
  }
}

// =============================================================================
// FIELD IMPORTANCE CALCULATION
// =============================================================================

/**
 * Calculate field importance scores for a model
 *
 * Uses logarithmic scaling to prevent outliers from dominating.
 * Score formula:
 * - Decode score: min(50, log10(decode_count + 1) * 20)
 * - Search score: min(50, log10(search_count + 1) * 20)
 * - Total: decode_score + search_score (0-100)
 *
 * Fields with total_score >= PROMOTION_THRESHOLD are suggested for promotion.
 *
 * @param modelName - Model to calculate scores for
 * @returns Array of field importance scores, sorted by score descending
 */
export function calculateFieldImportance(modelName: string): FieldImportanceScore[] {
  if (!analyticsData) {
    return [];
  }

  const configuredKeyFields = KEY_FIELDS_CONFIG[modelName as keyof typeof KEY_FIELDS_CONFIG] || [];
  const scores: FieldImportanceScore[] = [];

  for (const [key, record] of Object.entries(analyticsData.field_usage)) {
    if (record.model_name !== modelName) {
      continue;
    }

    // Calculate score using logarithmic scaling
    // This prevents fields with 10,000 uses from completely overwhelming fields with 100 uses
    const decodeScore = Math.min(50, Math.log10(record.decode_count + 1) * 20);
    const searchScore = Math.min(50, Math.log10(record.search_count + 1) * 20);
    const totalScore = decodeScore + searchScore;

    // Check if this field should be promoted
    // A field is "promoted" if:
    // 1. It's NOT already in the configured key fields
    // 2. Its score is >= the promotion threshold
    const isPromoted = !configuredKeyFields.includes(record.field_name) &&
                       totalScore >= ANALYTICS_CONFIG.PROMOTION_THRESHOLD;

    scores.push({
      model_name: modelName,
      field_name: record.field_name,
      total_score: Math.round(totalScore * 10) / 10, // Round to 1 decimal
      decode_frequency: record.decode_count,
      search_frequency: record.search_count,
      is_promoted: isPromoted,
    });
  }

  // Sort by total score descending
  return scores.sort((a, b) => b.total_score - a.total_score);
}

/**
 * Get adaptive key fields (config + analytics-discovered)
 *
 * Returns the key fields for a model, enhanced with analytics discoveries.
 * Promoted fields are added after configured fields, up to MAX_KEY_FIELDS.
 *
 * @param modelName - Model name
 * @returns Array of field names (configured + promoted)
 */
export function getAdaptiveKeyFields(modelName: string): string[] {
  // Start with configured key fields
  const configFields = KEY_FIELDS_CONFIG[modelName as keyof typeof KEY_FIELDS_CONFIG];
  const result = configFields ? [...configFields] : [];

  // Add promoted fields from analytics
  const importance = calculateFieldImportance(modelName);

  for (const score of importance) {
    // Only add promoted fields that aren't already in the list
    if (score.is_promoted && !result.includes(score.field_name)) {
      result.push(score.field_name);
    }

    // Stop when we hit the max
    if (result.length >= ANALYTICS_CONFIG.MAX_KEY_FIELDS) {
      break;
    }
  }

  return result;
}

// =============================================================================
// SUMMARY & DISPLAY
// =============================================================================

/**
 * Get analytics summary for display
 *
 * Returns aggregated statistics for showing in sync status and dashboards.
 *
 * @returns AnalyticsSummary with totals, top fields, and suggestions
 */
export function getAnalyticsSummary(): AnalyticsSummary {
  if (!analyticsData) {
    return {
      total_decodes: 0,
      total_searches: 0,
      top_fields: [],
      suggested_promotions: [],
      data_age_hours: 0,
    };
  }

  // Get top decoded fields
  const topFields = Object.values(analyticsData.field_usage)
    .sort((a, b) => (b.decode_count + b.search_count) - (a.decode_count + a.search_count))
    .slice(0, 10)
    .map(record => ({
      field: `${record.model_name}.${record.field_name}`,
      count: record.decode_count + record.search_count,
    }));

  // Get suggested promotions (from all models)
  const suggestions: string[] = [];
  const modelNames = [...new Set(Object.values(analyticsData.field_usage).map(r => r.model_name))];

  for (const modelName of modelNames) {
    const importance = calculateFieldImportance(modelName);
    for (const score of importance) {
      if (score.is_promoted) {
        suggestions.push(`${modelName}.${score.field_name} (score: ${score.total_score})`);
      }
    }
  }

  // Calculate data age
  const ageMs = Date.now() - new Date(analyticsData.created_at).getTime();
  const ageHours = Math.round(ageMs / (1000 * 60 * 60));

  return {
    total_decodes: analyticsData.total_decodes,
    total_searches: analyticsData.total_searches,
    top_fields: topFields,
    suggested_promotions: suggestions.slice(0, 5), // Max 5 suggestions
    data_age_hours: ageHours,
  };
}

// =============================================================================
// PERSISTENCE
// =============================================================================

/**
 * Persist analytics data to file
 *
 * Called periodically by timer and on shutdown.
 * Only writes if data has changed (isDirty flag).
 */
export function persistAnalytics(): void {
  if (!analyticsData || !isDirty) {
    return; // Nothing to persist
  }

  try {
    const filePath = path.resolve(process.cwd(), ANALYTICS_CONFIG.DATA_FILE);

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Update timestamp and save
    analyticsData.updated_at = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(analyticsData, null, 2));

    isDirty = false;
    console.error(`[Analytics] Persisted to ${filePath}`);
  } catch (error) {
    console.error('[Analytics] Failed to persist:', error);
  }
}

/**
 * Clear all analytics data
 *
 * Call when schema changes or to reset analytics.
 * Also removes the persisted file.
 */
export function clearAnalytics(): void {
  analyticsData = null;
  isDirty = false;

  // Also remove persisted file
  try {
    const filePath = path.resolve(process.cwd(), ANALYTICS_CONFIG.DATA_FILE);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.error('[Analytics] Removed analytics file');
    }
  } catch (error) {
    console.error('[Analytics] Failed to remove file:', error);
  }

  console.error('[Analytics] Cleared all analytics data');
}

/**
 * Shutdown analytics service
 *
 * Persists data and stops the timer.
 * Call on application shutdown.
 */
export function shutdownAnalytics(): void {
  // Persist any pending changes
  persistAnalytics();

  // Stop timer
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
    console.error('[Analytics] Shutdown complete');
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Prune old entries to stay under MAX_FIELD_ENTRIES
 *
 * Keeps the most recently used entries.
 */
function pruneOldEntries(): void {
  if (!analyticsData) return;

  const entries = Object.entries(analyticsData.field_usage)
    .sort((a, b) => new Date(b[1].last_used).getTime() - new Date(a[1].last_used).getTime())
    .slice(0, ANALYTICS_CONFIG.MAX_FIELD_ENTRIES);

  analyticsData.field_usage = Object.fromEntries(entries);
  console.error(`[Analytics] Pruned to ${entries.length} entries`);
}

/**
 * Check if analytics is initialized
 */
export function isAnalyticsInitialized(): boolean {
  return analyticsData !== null;
}

/**
 * Get raw analytics data (for testing/debugging)
 */
export function getAnalyticsData(): AnalyticsData | null {
  return analyticsData;
}

// =============================================================================
// TRAINING DATA COLLECTION (Stage 6 - Phase 2 Preparation)
// =============================================================================

/**
 * Training Data Collection
 *
 * Collects decoded pairs for future model training:
 * - Input: NEXUS encoded string ("344^6271*Westfield|344^6299*450000")
 * - Output: Human readable decoded text ("Name: Westfield | Revenue: $450,000")
 *
 * These pairs can be used to train models that understand NEXUS natively,
 * enabling Phase 2: direct NL → NEXUS queries without the decoding layer.
 */

/** In-memory training data storage */
let trainingData: TrainingPair[] = [];

/** Training data dirty flag */
let trainingDirty = false;

/**
 * Initialize training data (load from file)
 *
 * Called during service initialization.
 */
export function initializeTrainingData(): void {
  const filePath = path.resolve(process.cwd(), TRAINING_CONFIG.DATA_FILE);

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      trainingData = JSON.parse(raw) as TrainingPair[];
      console.error(`[Training] Loaded ${trainingData.length} training pairs`);
    } catch (error) {
      console.error('[Training] Failed to load training data:', error);
      trainingData = [];
    }
  } else {
    console.error('[Training] No existing training data file');
    trainingData = [];
  }
}

/**
 * Record a training pair (NEXUS encoded → human readable)
 *
 * Called automatically during decode operations to build training data.
 * Each decoded record becomes a training example.
 *
 * @param encodedInput - The NEXUS encoded string
 * @param decodedOutput - The human-readable decoded output
 * @param modelName - The model name (e.g., "crm.lead")
 */
export function recordTrainingPair(
  encodedInput: string,
  decodedOutput: string,
  modelName: string
): void {
  // Skip empty or trivial pairs
  if (!encodedInput || !decodedOutput || decodedOutput === '_No decodable fields found_') {
    return;
  }

  trainingData.push({
    input: encodedInput,
    output: decodedOutput,
    model_name: modelName,
    timestamp: new Date().toISOString(),
  });

  trainingDirty = true;

  // Keep bounded to max pairs
  if (trainingData.length > TRAINING_CONFIG.MAX_PAIRS) {
    // Remove oldest entries (keep newest)
    trainingData = trainingData.slice(-TRAINING_CONFIG.MAX_PAIRS);
    console.error(`[Training] Pruned to ${trainingData.length} pairs`);
  }
}

/**
 * Export training data for Phase 2 model training
 *
 * Returns all collected training pairs. Format:
 * ```json
 * [
 *   {
 *     "input": "344^6271*Westfield School|344^6299*450000",
 *     "output": "- **Name:** Westfield School\n- **Expected Revenue:** $450,000",
 *     "model_name": "crm.lead",
 *     "timestamp": "2025-01-15T10:30:00Z"
 *   }
 * ]
 * ```
 *
 * @returns Array of training pairs
 */
export function exportTrainingData(): TrainingPair[] {
  return [...trainingData]; // Return copy to prevent mutation
}

/**
 * Get training data statistics
 *
 * @returns Statistics about collected training data
 */
export function getTrainingStats(): TrainingStats {
  const byModel: Record<string, number> = {};

  for (const pair of trainingData) {
    byModel[pair.model_name] = (byModel[pair.model_name] || 0) + 1;
  }

  return {
    total_pairs: trainingData.length,
    by_model: byModel,
    oldest: trainingData[0]?.timestamp || null,
    newest: trainingData[trainingData.length - 1]?.timestamp || null,
  };
}

/**
 * Persist training data to file
 *
 * Called periodically and on shutdown.
 */
export function persistTrainingData(): void {
  if (!trainingDirty || trainingData.length === 0) {
    return;
  }

  try {
    const filePath = path.resolve(process.cwd(), TRAINING_CONFIG.DATA_FILE);

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(trainingData, null, 2));
    trainingDirty = false;
    console.error(`[Training] Persisted ${trainingData.length} pairs to ${filePath}`);
  } catch (error) {
    console.error('[Training] Failed to persist:', error);
  }
}

/**
 * Clear all training data
 *
 * Use with caution - this removes all collected training pairs.
 */
export function clearTrainingData(): void {
  trainingData = [];
  trainingDirty = false;

  try {
    const filePath = path.resolve(process.cwd(), TRAINING_CONFIG.DATA_FILE);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.error('[Training] Removed training data file');
    }
  } catch (error) {
    console.error('[Training] Failed to remove file:', error);
  }

  console.error('[Training] Cleared all training data');
}

/**
 * Shutdown training data service
 *
 * Persists data on shutdown.
 */
export function shutdownTrainingData(): void {
  persistTrainingData();
  console.error('[Training] Shutdown complete');
}
