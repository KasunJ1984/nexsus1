/**
 * Conversation Memory Service
 *
 * Dual storage pattern for blendthink conversations:
 * - In-memory: Fast session access
 * - JSON file: Persistence across restarts
 * - Qdrant (future): Semantic search across conversation history
 *
 * Follows the analytics-service.ts pattern.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  BlendthinkSession,
  ConversationTurn,
  ConversationPayload,
} from '../../common/types.js';
import { embed } from '../../common/services/embedding-service.js';
import { getQdrantClient } from '../../common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../../common/constants.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const SESSIONS_FILE = join(process.cwd(), 'data', 'blendthink-sessions.json');
const PERSIST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS_IN_MEMORY = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// SERVICE STATE
// =============================================================================

interface SessionsData {
  version: string;
  lastUpdated: string;
  sessions: BlendthinkSession[];
}

let activeSessions: Map<string, BlendthinkSession> = new Map();
let sessionsDirty = false;
let persistTimer: NodeJS.Timeout | null = null;
let initialized = false;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize conversation memory service
 */
export function initializeConversationMemory(): void {
  if (initialized) return;

  // Load existing sessions from file
  loadSessionsFromFile();

  // Start periodic persistence
  persistTimer = setInterval(() => {
    persistSessions();
  }, PERSIST_INTERVAL_MS);

  initialized = true;
  console.error('[ConversationMemory] Initialized');
}

/**
 * Load sessions from JSON file
 */
function loadSessionsFromFile(): void {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const content = readFileSync(SESSIONS_FILE, 'utf-8');
      const data = JSON.parse(content) as SessionsData;

      // Convert to Map
      for (const session of data.sessions) {
        // Restore Date objects
        session.startedAt = new Date(session.startedAt);
        session.lastActivityAt = new Date(session.lastActivityAt);
        for (const turn of session.turns) {
          turn.timestamp = new Date(turn.timestamp);
        }

        // Skip expired sessions
        const age = Date.now() - session.lastActivityAt.getTime();
        if (age < SESSION_TTL_MS) {
          activeSessions.set(session.sessionId, session);
        }
      }

      console.error(`[ConversationMemory] Loaded ${activeSessions.size} sessions from file`);
    }
  } catch (error) {
    console.error('[ConversationMemory] Failed to load sessions:', error);
  }
}

// =============================================================================
// SESSION MANAGEMENT
// =============================================================================

/**
 * Get a session by ID
 */
export function getSession(sessionId: string): BlendthinkSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Store a session
 */
export function storeSession(session: BlendthinkSession): void {
  activeSessions.set(session.sessionId, session);
  sessionsDirty = true;

  // Evict oldest sessions if over limit
  if (activeSessions.size > MAX_SESSIONS_IN_MEMORY) {
    evictOldestSessions();
  }
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): void {
  activeSessions.delete(sessionId);
  sessionsDirty = true;
}

/**
 * Get all active sessions
 */
export function getAllSessions(): BlendthinkSession[] {
  return Array.from(activeSessions.values()).filter((s) => s.active);
}

// =============================================================================
// TURN MANAGEMENT
// =============================================================================

/**
 * Record a conversation turn
 *
 * This is fire-and-forget - doesn't block execution
 */
export async function recordTurn(
  sessionId: string,
  turn: ConversationTurn
): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.error(`[ConversationMemory] Session not found: ${sessionId}`);
    return;
  }

  // Update session
  session.lastActivityAt = new Date();
  sessionsDirty = true;

  // Embed turn for future semantic search (fire-and-forget)
  embedTurnAsync(sessionId, turn).catch((err) => {
    console.error('[ConversationMemory] Failed to embed turn:', err);
  });
}

/**
 * Embed a turn for semantic search (async, non-blocking)
 */
async function embedTurnAsync(
  sessionId: string,
  turn: ConversationTurn
): Promise<void> {
  // Build vector text
  const vectorText = buildVectorText(turn);

  // Generate embedding
  const vector = await embed(vectorText, 'document');
  if (!vector) {
    console.error('[ConversationMemory] Failed to generate embedding');
    return;
  }

  // Build payload
  const payload: ConversationPayload = {
    point_type: 'conversation',
    session_id: sessionId,
    turn_number: 0, // TODO: track turn number
    role: turn.role,
    content: turn.content,
    question_type: turn.analysis?.type,
    sections_queried: turn.sources?.map((s) => s.section),
    confidence: turn.confidence,
    timestamp: turn.timestamp.toISOString(),
    vector_text: vectorText,
  };

  // Build UUID
  const pointId = `conv-${sessionId.substring(0, 8)}-${turn.id.substring(0, 8)}`;

  // Upsert to Qdrant using raw client (conversation payload is custom, not PipelineDataPayload)
  const qdrant = getQdrantClient();
  if (!qdrant) {
    console.error('[ConversationMemory] Qdrant client not available');
    return;
  }

  await qdrant.upsert(UNIFIED_CONFIG.COLLECTION_NAME, {
    points: [
      {
        id: pointId,
        vector,
        payload: payload as unknown as Record<string, unknown>,
      },
    ],
  });

  console.error(`[ConversationMemory] Embedded turn: ${pointId}`);
}

/**
 * Build vector text from turn content
 */
function buildVectorText(turn: ConversationTurn): string {
  const parts: string[] = [];

  // Add role
  parts.push(`[${turn.role}]`);

  // Add content summary
  const content = turn.content.substring(0, 500);
  parts.push(content);

  // Add analysis context if available
  if (turn.analysis) {
    parts.push(`[Type: ${turn.analysis.type}]`);
    if (turn.analysis.entities.length > 0) {
      parts.push(`[Entities: ${turn.analysis.entities.slice(0, 5).join(', ')}]`);
    }
  }

  // Add sources if available
  if (turn.sources && turn.sources.length > 0) {
    const sourcesSummary = turn.sources
      .map((s) => `${s.section}/${s.tool}`)
      .join(', ');
    parts.push(`[Sources: ${sourcesSummary}]`);
  }

  return parts.join(' ');
}

// =============================================================================
// PERSISTENCE
// =============================================================================

/**
 * Persist sessions to file
 */
export function persistSessions(): void {
  if (!sessionsDirty) return;

  try {
    const data: SessionsData = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      sessions: Array.from(activeSessions.values()),
    };

    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    sessionsDirty = false;
    console.error(`[ConversationMemory] Persisted ${data.sessions.length} sessions`);
  } catch (error) {
    console.error('[ConversationMemory] Failed to persist sessions:', error);
  }
}

/**
 * Evict oldest sessions when over limit
 */
function evictOldestSessions(): void {
  const sessions = Array.from(activeSessions.entries());

  // Sort by last activity (oldest first)
  sessions.sort((a, b) => {
    return a[1].lastActivityAt.getTime() - b[1].lastActivityAt.getTime();
  });

  // Evict oldest 20%
  const toEvict = Math.floor(sessions.length * 0.2);
  for (let i = 0; i < toEvict; i++) {
    activeSessions.delete(sessions[i][0]);
  }

  console.error(`[ConversationMemory] Evicted ${toEvict} oldest sessions`);
}

// =============================================================================
// SEARCH (Phase 3 - Semantic Search)
// =============================================================================

/**
 * Find similar conversations using semantic search
 *
 * Searches the Qdrant collection for conversation turns that are
 * semantically similar to the query. Uses the same embedding model
 * as the rest of the system for consistency.
 *
 * @param query - Natural language query to find similar conversations
 * @param limit - Maximum number of results (default: 5)
 * @param sessionId - Optional: filter to a specific session
 * @returns Array of similar conversation turns with similarity scores
 */
export async function findSimilarConversations(
  query: string,
  limit: number = 5,
  sessionId?: string
): Promise<Array<ConversationTurn & { similarityScore: number }>> {
  try {
    // Generate query embedding
    const queryVector = await embed(query, 'query');
    if (!queryVector) {
      console.error('[ConversationMemory] Failed to embed query');
      return [];
    }

    // Get Qdrant client
    const qdrant = getQdrantClient();
    if (!qdrant) {
      console.error('[ConversationMemory] Qdrant client not available');
      return [];
    }

    // Build filter for conversation points
    const mustConditions: Array<{
      key: string;
      match: { value: string };
    }> = [
      { key: 'point_type', match: { value: 'conversation' } },
    ];

    // Add session filter if specified
    if (sessionId) {
      mustConditions.push({ key: 'session_id', match: { value: sessionId } });
    }

    // Search Qdrant
    const searchResults = await qdrant.search(UNIFIED_CONFIG.COLLECTION_NAME, {
      vector: queryVector,
      limit,
      filter: {
        must: mustConditions,
      },
      with_payload: true,
      score_threshold: 0.5, // Only return reasonably similar results
    });

    // Convert to ConversationTurn format
    const results: Array<ConversationTurn & { similarityScore: number }> = [];

    for (const result of searchResults) {
      const payload = result.payload as unknown as ConversationPayload;
      if (!payload) continue;

      // Reconstruct ConversationTurn from payload
      const turn: ConversationTurn & { similarityScore: number } = {
        id: typeof result.id === 'string' ? result.id : String(result.id),
        role: payload.role,
        content: payload.content,
        timestamp: new Date(payload.timestamp),
        similarityScore: result.score,
      };

      // Add analysis if available
      if (payload.question_type) {
        turn.analysis = {
          query: payload.content,
          type: payload.question_type,
          confidence: payload.confidence || 0,
          entities: [],
        };
      }

      // Add sources if available
      if (payload.sections_queried) {
        turn.sources = payload.sections_queried.map((section) => ({
          section,
          tool: 'unknown',
          contribution: 'retrieved from memory',
        }));
      }

      results.push(turn);
    }

    console.error(`[ConversationMemory] Found ${results.length} similar conversations`);
    return results;

  } catch (error) {
    console.error('[ConversationMemory] Error searching conversations:', error);
    return [];
  }
}

/**
 * Recall relevant context from past conversations
 *
 * Searches for similar past conversations and formats them
 * as context for Claude to use in synthesis.
 *
 * @param query - Current user query
 * @param limit - Maximum past turns to include
 * @returns Formatted context string for Claude
 */
export async function recallConversationContext(
  query: string,
  limit: number = 3
): Promise<string> {
  const similar = await findSimilarConversations(query, limit);

  if (similar.length === 0) {
    return '';
  }

  const contextParts: string[] = ['## Related Past Conversations', ''];

  for (const turn of similar) {
    const scorePercent = (turn.similarityScore * 100).toFixed(0);
    const role = turn.role === 'user' ? 'User' : 'Assistant';
    const content = turn.content.substring(0, 300);
    const truncated = turn.content.length > 300 ? '...' : '';

    contextParts.push(`**${role}** (${scorePercent}% similar):`);
    contextParts.push(`> ${content}${truncated}`);
    contextParts.push('');
  }

  return contextParts.join('\n');
}

/**
 * Get session context summary for Claude
 */
export function getSessionContext(sessionId: string): string {
  const session = activeSessions.get(sessionId);
  if (!session || session.turns.length === 0) {
    return '';
  }

  // Build context from recent turns
  const recentTurns = session.turns.slice(-6); // Last 3 exchanges
  const context = recentTurns
    .map((turn) => {
      const role = turn.role === 'user' ? 'User' : 'Assistant';
      const content = turn.content.substring(0, 300);
      return `**${role}:** ${content}${turn.content.length > 300 ? '...' : ''}`;
    })
    .join('\n\n');

  return context;
}

// =============================================================================
// SHUTDOWN
// =============================================================================

/**
 * Shutdown conversation memory service
 */
export function shutdownConversationMemory(): void {
  if (persistTimer) {
    clearInterval(persistTimer);
    persistTimer = null;
  }

  // Final persist
  persistSessions();

  initialized = false;
  console.error('[ConversationMemory] Shutdown complete');
}

// =============================================================================
// SINGLETON ACCESSOR
// =============================================================================

/**
 * Get conversation memory service (auto-initializes)
 */
export function getConversationMemory(): {
  getSession: typeof getSession;
  storeSession: typeof storeSession;
  deleteSession: typeof deleteSession;
  recordTurn: typeof recordTurn;
  getSessionContext: typeof getSessionContext;
  findSimilarConversations: typeof findSimilarConversations;
  recallConversationContext: typeof recallConversationContext;
} {
  if (!initialized) {
    initializeConversationMemory();
  }

  return {
    getSession,
    storeSession,
    deleteSession,
    recordTurn,
    getSessionContext,
    findSimilarConversations,
    recallConversationContext,
  };
}
