/**
 * Circuit Breaker Service
 *
 * Implements the Circuit Breaker pattern to prevent cascading failures.
 * Uses structured logging (Stage 3) for observability.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failing fast, rejecting requests immediately
 * - HALF-OPEN: Testing if service recovered, limited requests allowed
 *
 * Integrates with:
 * - Stage 1: Wraps retry logic - CB opens before retries exhaust
 * - Stage 2: When CB opens, records can go to DLQ
 * - Stage 3: Structured JSON logging for state transitions
 */

import { logInfo, logWarn, logError } from './logger.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // Open after N consecutive failures
  resetTimeoutMs: number;      // Try half-open after this time
  halfOpenRequests: number;    // Allow N requests in half-open before deciding
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60000,  // 1 minute
  halfOpenRequests: 3,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;

  constructor(
    private name: string,
    private config: CircuitBreakerConfig = DEFAULT_CONFIG
  ) {}

  /**
   * Execute a function with circuit breaker protection
   *
   * @param fn - Async function to execute
   * @param context - Optional logging context (sync_id, model_name)
   * @returns Result of the function
   * @throws CircuitBreakerOpenError if circuit is OPEN
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: { sync_id?: string; model_name?: string }
  ): Promise<T> {
    const logCtx = {
      service: this.name,
      circuit_state: this.state,
      ...context,
    };

    // Check if circuit should transition from open to half-open
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure > this.config.resetTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenSuccesses = 0;
        logInfo('Circuit breaker half-open', {
          ...logCtx,
          circuit_state: 'half-open',
          reason: 'reset_timeout_elapsed',
          timeout_ms: this.config.resetTimeoutMs,
        });
      } else {
        // Fail fast - don't even try
        const remainingMs = this.config.resetTimeoutMs - timeSinceFailure;
        logWarn('Circuit breaker rejecting request', {
          ...logCtx,
          remaining_ms: remainingMs,
          consecutive_failures: this.consecutiveFailures,
        });
        throw new CircuitBreakerOpenError(this.name, remainingMs);
      }
    }

    try {
      const result = await fn();
      this.onSuccess(logCtx);
      return result;
    } catch (error) {
      this.onFailure(error, logCtx);
      throw error;
    }
  }

  private onSuccess(logCtx: Record<string, unknown>): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenRequests) {
        this.state = 'closed';
        this.consecutiveFailures = 0;
        logInfo('Circuit breaker closed', {
          ...logCtx,
          circuit_state: 'closed',
          reason: 'service_recovered',
          test_successes: this.halfOpenSuccesses,
        });
      }
    } else {
      // Reset failure counter on any success in closed state
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(error: unknown, logCtx: Record<string, unknown>): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    const errMsg = error instanceof Error ? error.message : String(error);

    if (this.state === 'half-open') {
      // Half-open failure: immediately re-open
      this.state = 'open';
      logWarn('Circuit breaker re-opened', {
        ...logCtx,
        circuit_state: 'open',
        reason: 'half_open_failure',
        error: errMsg,
      });
    } else if (this.consecutiveFailures >= this.config.failureThreshold) {
      // Threshold breached: open circuit
      this.state = 'open';
      logError('Circuit breaker opened', {
        ...logCtx,
        circuit_state: 'open',
        reason: 'failure_threshold_breached',
        consecutive_failures: this.consecutiveFailures,
        threshold: this.config.failureThreshold,
        error: errMsg,
      });
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureTime: number;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Manually reset circuit to closed state
   * Use with caution - typically for admin/testing
   */
  reset(): void {
    const prevState = this.state;
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    logInfo('Circuit breaker manually reset', {
      service: this.name,
      previous_state: prevState,
      circuit_state: 'closed',
    });
  }
}

/**
 * Custom error for circuit breaker open state
 * Allows callers to distinguish "didn't try" from "tried and failed"
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly service: string,
    public readonly remainingMs: number
  ) {
    super(`Circuit breaker [${service}] is OPEN - failing fast (retry in ${Math.round(remainingMs / 1000)}s)`);
    this.name = 'CircuitBreakerOpenError';
  }
}

// =============================================================================
// PRE-CONFIGURED BREAKERS (Per-Service)
// =============================================================================

/**
 * Odoo API Circuit Breaker
 * - Protects against Odoo server unavailable, timeouts
 * - Higher threshold (5) because field restrictions cause expected retries
 */
export const odooCircuitBreaker = new CircuitBreaker('odoo', {
  failureThreshold: 5,
  resetTimeoutMs: 60000,    // 1 minute
  halfOpenRequests: 3,
});

/**
 * Qdrant Vector DB Circuit Breaker
 * - Protects against Qdrant container down, network issues
 * - Lower threshold (3) because Qdrant should be stable
 */
export const qdrantCircuitBreaker = new CircuitBreaker('qdrant', {
  failureThreshold: 3,
  resetTimeoutMs: 30000,    // 30 seconds (faster recovery expected)
  halfOpenRequests: 2,
});

/**
 * Voyage AI Embedding Service Circuit Breaker
 * - Protects against API rate limits, service degradation
 * - Medium threshold (4) - API can have transient issues
 */
export const voyageCircuitBreaker = new CircuitBreaker('voyage', {
  failureThreshold: 4,
  resetTimeoutMs: 45000,    // 45 seconds
  halfOpenRequests: 2,
});

/**
 * Get all circuit breaker states for monitoring
 */
export function getCircuitBreakerStates(): Record<string, {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
}> {
  return {
    odoo: odooCircuitBreaker.getStats(),
    qdrant: qdrantCircuitBreaker.getStats(),
    voyage: voyageCircuitBreaker.getStats(),
  };
}

/**
 * Reset all circuit breakers (admin function)
 */
export function resetAllCircuitBreakers(): void {
  odooCircuitBreaker.reset();
  qdrantCircuitBreaker.reset();
  voyageCircuitBreaker.reset();
}
