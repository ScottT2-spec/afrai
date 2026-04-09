/**
 * Per-provider circuit breaker — prevents cascading failures.
 *
 * States:
 *   CLOSED (normal) ──[failures >= threshold in window]──→ OPEN (blocking)
 *                                                              │
 *                                                    [cooldown elapsed]
 *                                                              │
 *                                                              ▼
 *                                                        HALF_OPEN (test 1 req)
 *                                                       /              \
 *                                              [success]                [failure]
 *                                                 │                        │
 *                                                 ▼                        ▼
 *                                              CLOSED                    OPEN
 */

import type { CircuitBreakerState } from '../types/provider.js';

export interface CircuitBreakerConfig {
  /** Number of failures to trip the breaker. Default: 5 */
  readonly failureThreshold: number;
  /** Time window for counting failures in ms. Default: 60_000 (60s) */
  readonly failureWindowMs: number;
  /** Cooldown before transitioning from OPEN → HALF_OPEN in ms. Default: 30_000 (30s) */
  readonly cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
};

interface ProviderState {
  status: CircuitBreakerState;
  failures: number[];        // timestamps of recent failures
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;   // when the breaker tripped to OPEN
}

function createFreshState(): ProviderState {
  return {
    status: 'closed',
    failures: [],
    lastFailureAt: null,
    lastSuccessAt: null,
    openedAt: null,
  };
}

/**
 * In-memory circuit breaker manager.
 * Each provider has its own independent breaker.
 */
export class CircuitBreakerManager {
  private readonly states = new Map<string, ProviderState>();
  private readonly config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a request to this provider is allowed.
   * Also handles automatic OPEN → HALF_OPEN transition after cooldown.
   */
  canRequest(providerId: string): boolean {
    const state = this.getOrCreate(providerId);
    const now = Date.now();

    if (state.status === 'closed') {
      return true;
    }

    if (state.status === 'half_open') {
      // Only one test request allowed — we already let it through
      // when we transitioned. Block additional concurrent requests.
      return false;
    }

    // status === 'open'
    if (state.openedAt && now - state.openedAt >= this.config.cooldownMs) {
      // Cooldown elapsed — transition to HALF_OPEN, allow one test request
      state.status = 'half_open';
      return true;
    }

    return false;
  }

  /**
   * Record a successful request for a provider.
   * Resets the breaker to CLOSED if in HALF_OPEN.
   */
  recordSuccess(providerId: string): void {
    const state = this.getOrCreate(providerId);
    state.lastSuccessAt = Date.now();

    if (state.status === 'half_open') {
      // Test request succeeded — close the breaker
      state.status = 'closed';
      state.failures = [];
      state.openedAt = null;
    }
  }

  /**
   * Record a failed request for a provider.
   * May trip the breaker to OPEN if threshold is exceeded.
   */
  recordFailure(providerId: string): void {
    const state = this.getOrCreate(providerId);
    const now = Date.now();

    state.lastFailureAt = now;

    if (state.status === 'half_open') {
      // Test request failed — back to OPEN with fresh cooldown
      state.status = 'open';
      state.openedAt = now;
      return;
    }

    // In CLOSED state — track failures within the window
    state.failures.push(now);

    // Prune failures outside the time window
    const windowStart = now - this.config.failureWindowMs;
    state.failures = state.failures.filter((ts) => ts >= windowStart);

    if (state.failures.length >= this.config.failureThreshold) {
      state.status = 'open';
      state.openedAt = now;
    }
  }

  /**
   * Get the current state of a provider's circuit breaker.
   */
  getStatus(providerId: string): CircuitBreakerState {
    // Check for auto-transition before returning
    this.canRequest(providerId);
    return this.getOrCreate(providerId).status;
  }

  /**
   * Get all circuit breaker statuses — for feeding into the router.
   */
  getAllStatuses(): Record<string, CircuitBreakerState> {
    const result: Record<string, CircuitBreakerState> = {};
    for (const [id] of this.states) {
      result[id] = this.getStatus(id);
    }
    return result;
  }

  /**
   * Reset a provider's circuit breaker to CLOSED (manual override).
   */
  reset(providerId: string): void {
    this.states.set(providerId, createFreshState());
  }

  private getOrCreate(providerId: string): ProviderState {
    let state = this.states.get(providerId);
    if (!state) {
      state = createFreshState();
      this.states.set(providerId, state);
    }
    return state;
  }
}
