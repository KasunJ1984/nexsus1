/**
 * Learning Layer
 *
 * Stores successful patterns for future System 1 use.
 * Learns from user feedback and corrections.
 *
 * Learning Triggers:
 * - Explicit feedback: User says "that's not what I meant"
 * - Implicit success: User accepts answer and moves on
 * - Implicit failure: User asks follow-up clarifying question
 * - Correction tracking: User provides correct interpretation
 *
 * Human Parallel: You get better at your job over time by remembering what worked.
 */

import type { QuestionType, BlendSection, RouteStep } from '../../common/types.js';
import { getQueryPatternMemory } from './memory/index.js';
import { isR2Enabled, appendToFile, getJson } from '../../common/services/r2-client.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Learning event representing a query outcome
 */
export interface LearningEvent {
  /** Unique event ID */
  eventId: string;

  /** When this event occurred */
  timestamp: string;

  /** Original query text */
  query: string;

  /** Question type detected */
  questionType: QuestionType;

  /** Route that was used */
  routeUsed: Array<{ section: BlendSection; tool: string }>;

  /** Outcome quality (0-1) */
  outcomeQuality: number;

  /** Type of feedback */
  feedbackType: FeedbackType;

  /** User correction if provided */
  userCorrection?: string;

  /** Token usage */
  tokenUsage: {
    input: number;
    output: number;
  };

  /** Latency in milliseconds */
  latencyMs: number;

  /** Session ID */
  sessionId?: string;
}

/**
 * Feedback type
 */
export type FeedbackType =
  | 'explicit_positive'
  | 'explicit_negative'
  | 'implicit_success'
  | 'implicit_failure'
  | 'correction';

/**
 * User preference learned from interactions
 */
export interface UserPreference {
  /** User ID */
  userId: string;

  /** Preferred output format */
  preferredFormat: 'table' | 'narrative' | 'bullets' | 'mixed';

  /** Preferred detail level */
  detailLevel: 'concise' | 'detailed' | 'comprehensive';

  /** Field terminology mappings (what user means → Odoo field) */
  terminology: Record<string, string>;

  /** Sections the user typically needs */
  frequentSections: BlendSection[];

  /** Last updated */
  lastUpdated: string;
}

/**
 * Learning feedback to process
 */
export interface Feedback {
  /** The query this feedback is for */
  query: string;

  /** Session ID for context */
  sessionId: string;

  /** Type of feedback */
  type: FeedbackType;

  /** Explicit feedback text (if provided) */
  feedbackText?: string;

  /** Correction text (if correction type) */
  correction?: string;
}

// =============================================================================
// FEEDBACK DETECTOR
// =============================================================================

/**
 * Detects feedback signals from user messages
 */
export class FeedbackDetector {
  private readonly NEGATIVE_PATTERNS = [
    /that's not what i (meant|asked|wanted)/i,
    /no,?\s*(i\s+)?(meant|want|need)/i,
    /wrong/i,
    /incorrect/i,
    /not correct/i,
    /try again/i,
    /that doesn't (make sense|help)/i,
    /i was asking about/i,
    /not what i'm looking for/i,
  ];

  private readonly POSITIVE_PATTERNS = [
    /^(thanks|thank you|great|perfect|excellent|good|nice|helpful)/i,
    /that('s| is)?\s*(exactly\s+)?(what i (wanted|needed|meant))/i,
    /^yes[,!.]?\s*(that's right|correct|exactly)/i,
  ];

  private readonly CLARIFICATION_PATTERNS = [
    /what do you mean by/i,
    /i don't understand/i,
    /can you (explain|clarify)/i,
    /what about/i,
    /but what if/i,
    /how does that relate to/i,
  ];

  private readonly CORRECTION_PATTERNS = [
    /i meant/i,
    /when i said.*i meant/i,
    /by.*i mean/i,
    /actually,?\s*i (want|need|meant)/i,
    /let me clarify/i,
  ];

  /**
   * Detect feedback type from user message
   */
  detect(message: string, previousQuery?: string): FeedbackType | null {
    // Check for explicit negative feedback
    for (const pattern of this.NEGATIVE_PATTERNS) {
      if (pattern.test(message)) {
        return 'explicit_negative';
      }
    }

    // Check for explicit positive feedback
    for (const pattern of this.POSITIVE_PATTERNS) {
      if (pattern.test(message)) {
        return 'explicit_positive';
      }
    }

    // Check for correction
    for (const pattern of this.CORRECTION_PATTERNS) {
      if (pattern.test(message)) {
        return 'correction';
      }
    }

    // Check for clarification (implicit failure)
    for (const pattern of this.CLARIFICATION_PATTERNS) {
      if (pattern.test(message)) {
        return 'implicit_failure';
      }
    }

    // If this is a new query (not a reaction), it's implicit success
    if (previousQuery && !this.isReactionToQuery(message, previousQuery)) {
      return 'implicit_success';
    }

    return null;
  }

  /**
   * Check if message is a direct reaction to previous query
   */
  private isReactionToQuery(message: string, previousQuery: string): boolean {
    // Short messages are likely reactions
    if (message.length < 50) {
      return true;
    }

    // Contains pronouns referring to previous content
    if (/\b(that|it|this|these|those)\b/i.test(message)) {
      return true;
    }

    return false;
  }

  /**
   * Extract correction from user message
   */
  extractCorrection(message: string): string | undefined {
    // Try to extract what the user actually meant
    const patterns = [
      /i meant\s+["']?(.+?)["']?(?:\.|$)/i,
      /actually,?\s*i\s+(?:want|need)\s+(.+?)(?:\.|$)/i,
      /by\s+.+?\s+i\s+mean\s+["']?(.+?)["']?(?:\.|$)/i,
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    return undefined;
  }
}

// =============================================================================
// LEARNING ENGINE
// =============================================================================

export class LearningEngine {
  private feedbackDetector: FeedbackDetector;
  private readonly LEARNING_ARCHIVE_PREFIX = 'learning/events/';
  private readonly CORRECTION_ARCHIVE = 'learning/feedback/corrections.jsonl';
  private readonly MIN_QUALITY_TO_LEARN = 0.7;

  constructor() {
    this.feedbackDetector = new FeedbackDetector();
  }

  /**
   * Learn from a completed query interaction
   */
  async learnFromInteraction(event: LearningEvent): Promise<void> {
    console.error(`[Learning] Processing event: ${event.feedbackType} (quality: ${event.outcomeQuality})`);

    // Only learn from successful interactions
    if (event.outcomeQuality >= this.MIN_QUALITY_TO_LEARN) {
      // Store pattern for future System 1 use
      await this.storeSuccessfulPattern(event);
    }

    // Archive the learning event (always, for analytics)
    await this.archiveEvent(event);

    // If it's a correction, store for future reference
    if (event.feedbackType === 'correction' && event.userCorrection) {
      await this.storeCorrection(event.query, event.userCorrection);
    }
  }

  /**
   * Process feedback from user
   */
  async processFeedback(feedback: Feedback, routeUsed: RouteStep[], latencyMs: number): Promise<void> {
    // Calculate outcome quality based on feedback type
    const outcomeQuality = this.calculateQualityFromFeedback(feedback.type);

    // Create learning event
    const event: LearningEvent = {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      query: feedback.query,
      questionType: 'unknown', // Would need to get from session context
      routeUsed: routeUsed.map(s => ({ section: s.section, tool: s.tool })),
      outcomeQuality,
      feedbackType: feedback.type,
      userCorrection: feedback.correction,
      tokenUsage: { input: 0, output: 0 },
      latencyMs,
      sessionId: feedback.sessionId,
    };

    await this.learnFromInteraction(event);
  }

  /**
   * Detect feedback from user message
   */
  detectFeedback(message: string, previousQuery?: string): FeedbackType | null {
    return this.feedbackDetector.detect(message, previousQuery);
  }

  /**
   * Extract correction from user message
   */
  extractCorrection(message: string): string | undefined {
    return this.feedbackDetector.extractCorrection(message);
  }

  /**
   * Store successful pattern for future System 1 use
   */
  private async storeSuccessfulPattern(event: LearningEvent): Promise<void> {
    const patternMemory = getQueryPatternMemory();

    await patternMemory.store(
      event.query,
      event.questionType,
      event.routeUsed,
      event.outcomeQuality,
      event.latencyMs
    );

    console.error(`[Learning] Stored pattern for: "${event.query.substring(0, 30)}..."`);
  }

  /**
   * Archive learning event to R2
   */
  private async archiveEvent(event: LearningEvent): Promise<void> {
    if (!isR2Enabled()) return;

    const date = new Date().toISOString().split('T')[0];
    const filename = `${this.LEARNING_ARCHIVE_PREFIX}${date}/events.jsonl`;

    try {
      await appendToFile(filename, JSON.stringify(event) + '\n');
    } catch (error) {
      console.error('[Learning] Failed to archive event:', error);
    }
  }

  /**
   * Store correction for future reference
   */
  private async storeCorrection(originalQuery: string, correction: string): Promise<void> {
    if (!isR2Enabled()) return;

    const correctionRecord = {
      timestamp: new Date().toISOString(),
      original_query: originalQuery,
      user_correction: correction,
    };

    try {
      await appendToFile(this.CORRECTION_ARCHIVE, JSON.stringify(correctionRecord) + '\n');
      console.error(`[Learning] Stored correction: "${correction.substring(0, 30)}..."`);
    } catch (error) {
      console.error('[Learning] Failed to store correction:', error);
    }
  }

  /**
   * Calculate outcome quality from feedback type
   */
  private calculateQualityFromFeedback(type: FeedbackType): number {
    switch (type) {
      case 'explicit_positive':
        return 0.95;
      case 'implicit_success':
        return 0.8;
      case 'implicit_failure':
        return 0.4;
      case 'explicit_negative':
        return 0.2;
      case 'correction':
        return 0.3;
      default:
        return 0.5;
    }
  }

  /**
   * Get learning statistics
   */
  async getStats(): Promise<{
    patternsStored: number;
    topPatterns: Array<{ pattern: string; hitCount: number }>;
  }> {
    const patternMemory = getQueryPatternMemory();
    const stats = patternMemory.getStats();

    return {
      patternsStored: stats.cacheSize,
      topPatterns: stats.topPatterns,
    };
  }
}

// =============================================================================
// USER PREFERENCE LEARNING
// =============================================================================

export class PreferenceEngine {
  private readonly PREFERENCE_PREFIX = 'memory/preferences/';

  /**
   * Update user preference based on interaction
   */
  async updatePreference(
    userId: string,
    update: Partial<UserPreference>
  ): Promise<void> {
    if (!isR2Enabled()) return;

    // Load existing preferences
    const existing = await this.loadPreference(userId);

    // Merge updates
    const updated: UserPreference = {
      userId,
      preferredFormat: update.preferredFormat || existing?.preferredFormat || 'mixed',
      detailLevel: update.detailLevel || existing?.detailLevel || 'detailed',
      terminology: { ...existing?.terminology, ...update.terminology },
      frequentSections: this.mergeFrequentSections(
        existing?.frequentSections || [],
        update.frequentSections || []
      ),
      lastUpdated: new Date().toISOString(),
    };

    // Save
    try {
      await appendToFile(
        `${this.PREFERENCE_PREFIX}${userId}.json`,
        JSON.stringify(updated)
      );
    } catch (error) {
      console.error('[PreferenceEngine] Failed to save preference:', error);
    }
  }

  /**
   * Load user preference
   */
  async loadPreference(userId: string): Promise<UserPreference | null> {
    if (!isR2Enabled()) return null;

    try {
      return await getJson<UserPreference>(`${this.PREFERENCE_PREFIX}${userId}.json`);
    } catch {
      return null;
    }
  }

  /**
   * Learn terminology from correction
   *
   * Example: User says "by revenue I meant expected_revenue"
   * Stores: { "revenue": "expected_revenue" }
   */
  async learnTerminology(
    userId: string,
    userTerm: string,
    actualField: string
  ): Promise<void> {
    await this.updatePreference(userId, {
      terminology: { [userTerm.toLowerCase()]: actualField },
    });

    console.error(`[PreferenceEngine] Learned: "${userTerm}" → "${actualField}"`);
  }

  /**
   * Merge frequent sections lists
   */
  private mergeFrequentSections(
    existing: BlendSection[],
    newSections: BlendSection[]
  ): BlendSection[] {
    const combined = new Set([...existing, ...newSections]);
    return Array.from(combined).slice(0, 4); // Keep top 4
  }
}

// =============================================================================
// SINGLETONS
// =============================================================================

let learningInstance: LearningEngine | null = null;
let preferenceInstance: PreferenceEngine | null = null;

/**
 * Get the learning engine singleton
 */
export function getLearningEngine(): LearningEngine {
  if (!learningInstance) {
    learningInstance = new LearningEngine();
  }
  return learningInstance;
}

/**
 * Get the preference engine singleton
 */
export function getPreferenceEngine(): PreferenceEngine {
  if (!preferenceInstance) {
    preferenceInstance = new PreferenceEngine();
  }
  return preferenceInstance;
}
