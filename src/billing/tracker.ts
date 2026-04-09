import type { Database } from '../db/client.js';
import { usageLogs } from '../db/schema.js';

/**
 * Usage event — everything we track per request.
 */
export interface UsageEvent {
  readonly tenantId: string;
  readonly requestId: string;
  readonly model: string;
  readonly provider: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly complexityScore: number;
  /** success = primary model worked, fallback = used fallback, error = all failed */
  readonly status: 'success' | 'fallback' | 'error';
}

/**
 * Usage tracker — logs every request for billing and analytics.
 *
 * Writes are fire-and-forget to avoid adding latency to responses.
 * In production, this would batch-write to PostgreSQL and maintain
 * real-time counters in Redis.
 */
export class UsageTracker {
  constructor(private readonly db: Database) {}

  /**
   * Record a usage event. Fire-and-forget — errors are logged, not thrown.
   */
  track(event: UsageEvent): void {
    this.db
      .insert(usageLogs)
      .values({
        tenantId: event.tenantId,
        requestId: event.requestId,
        model: event.model,
        provider: event.provider,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        costUsd: event.costUsd.toFixed(8),
        latencyMs: event.latencyMs,
        complexityScore: event.complexityScore.toFixed(3),
        status: event.status,
      })
      .catch((err) => {
        // Don't let logging failures affect the response
        console.error('[UsageTracker] Failed to log usage:', err);
      });
  }
}
