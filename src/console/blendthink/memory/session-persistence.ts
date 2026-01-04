/**
 * Session Persistence
 *
 * Persists blendthink session state to R2 for:
 * - Resume conversations after server restart
 * - Cross-device session continuity
 * - Discovered IDs persist for follow-up queries
 */

import { isR2Enabled, uploadJson, getJson } from '../../../common/services/r2-client.js';
import type { BlendthinkSession, ConversationTurn, PersonaType } from '../../../common/types.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Persisted session state (subset of BlendthinkSession)
 */
export interface PersistedSession {
  /** Session ID */
  sessionId: string;

  /** User ID (optional, for per-user features) */
  userId?: string;

  /** Active persona type */
  activePersona: PersonaType;

  /** Token usage */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
    budget: number;
  };

  /** When session was created */
  createdAt: string;

  /** Last activity timestamp */
  lastActivityAt: string;

  /** Whether session is active */
  active: boolean;

  /** Refinement turns used */
  refinementTurnsUsed: number;

  /** Conversation history (last N turns) */
  recentTurns: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;

  /** Discovered record IDs from semantic search */
  discoveredIds: number[];

  /** Discovered model name */
  discoveredModel?: string;
}

// =============================================================================
// SESSION PERSISTENCE
// =============================================================================

export class SessionPersistence {
  private readonly SESSION_PREFIX = 'sessions/';
  private readonly SESSION_TTL_SECONDS: number;
  private readonly MAX_TURNS_TO_PERSIST = 10;

  constructor(ttlSeconds: number = 86400) {
    // Default: 24 hours
    this.SESSION_TTL_SECONDS = ttlSeconds;
  }

  /**
   * Save session state to R2
   */
  async save(session: BlendthinkSession, discoveredIds?: number[], discoveredModel?: string): Promise<boolean> {
    if (!isR2Enabled()) return false;

    const persisted: PersistedSession = {
      sessionId: session.sessionId,
      activePersona: session.activePersona,
      tokenUsage: session.tokenUsage,
      createdAt: session.startedAt.toISOString(),
      lastActivityAt: new Date().toISOString(),
      active: session.active,
      refinementTurnsUsed: session.refinementTurnsUsed,
      recentTurns: this.extractRecentTurns(session.turns),
      discoveredIds: discoveredIds || [],
      discoveredModel,
    };

    const key = `${this.SESSION_PREFIX}${session.sessionId}.json`;
    const success = await uploadJson(key, persisted);

    if (success) {
      console.error(`[SessionPersistence] Saved session: ${session.sessionId.substring(0, 8)}...`);
    }

    return success;
  }

  /**
   * Load session state from R2
   */
  async load(sessionId: string): Promise<PersistedSession | null> {
    if (!isR2Enabled()) return null;

    try {
      const key = `${this.SESSION_PREFIX}${sessionId}.json`;
      const persisted = await getJson<PersistedSession>(key);

      if (!persisted) return null;

      // Check if session expired
      if (this.isExpired(persisted.lastActivityAt)) {
        console.error(`[SessionPersistence] Session expired: ${sessionId.substring(0, 8)}...`);
        return null;
      }

      console.error(`[SessionPersistence] Loaded session: ${sessionId.substring(0, 8)}...`);
      return persisted;
    } catch {
      return null;
    }
  }

  /**
   * Restore a BlendthinkSession from persisted state
   */
  restoreSession(persisted: PersistedSession): Partial<BlendthinkSession> {
    return {
      sessionId: persisted.sessionId,
      activePersona: persisted.activePersona,
      tokenUsage: persisted.tokenUsage,
      startedAt: new Date(persisted.createdAt),
      lastActivityAt: new Date(persisted.lastActivityAt),
      active: persisted.active,
      refinementTurnsUsed: persisted.refinementTurnsUsed,
      turns: persisted.recentTurns.map((t, i) => ({
        id: `restored-${i}`,
        role: t.role,
        content: t.content,
        timestamp: new Date(t.timestamp),
      })) as ConversationTurn[],
    };
  }

  /**
   * Extract recent turns for persistence (limited to avoid large payloads)
   */
  private extractRecentTurns(turns: ConversationTurn[]): PersistedSession['recentTurns'] {
    return turns.slice(-this.MAX_TURNS_TO_PERSIST).map(t => ({
      role: t.role,
      content: t.content.substring(0, 1000), // Truncate long messages
      timestamp: t.timestamp.toISOString(),
    }));
  }

  /**
   * Check if session has expired
   */
  private isExpired(lastActivityAt: string): boolean {
    const elapsed = Date.now() - new Date(lastActivityAt).getTime();
    return elapsed > this.SESSION_TTL_SECONDS * 1000;
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let persistenceInstance: SessionPersistence | null = null;

/**
 * Get the session persistence singleton
 */
export function getSessionPersistence(): SessionPersistence {
  if (!persistenceInstance) {
    persistenceInstance = new SessionPersistence();
  }
  return persistenceInstance;
}
