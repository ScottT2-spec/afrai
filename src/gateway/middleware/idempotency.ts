import type { Redis } from 'ioredis';

/**
 * Idempotency middleware — prevents duplicate processing of the same request.
 *
 * When a client sends an X-Idempotency-Key header, we:
 * 1. Check if we've already processed a request with this key for this tenant
 * 2. If yes → return the cached response immediately (no re-processing, no double billing)
 * 3. If no → process normally, then store the response keyed by idempotency key
 *
 * Keys are scoped per-tenant to prevent cross-tenant collisions.
 * Stored responses expire after 24 hours (configurable).
 */

/** The stored response for an idempotent request */
export interface IdempotentEntry {
  /** HTTP status code of the original response */
  readonly statusCode: number;
  /** The original response body (JSON-serialized) */
  readonly body: string;
  /** When this entry was created (ISO timestamp) */
  readonly createdAt: string;
}

/** Result of checking an idempotency key */
export type IdempotencyCheckResult =
  | { readonly hit: true; readonly entry: IdempotentEntry }
  | { readonly hit: false };

const DEFAULT_TTL_SECONDS = 86_400; // 24 hours

export class IdempotencyService {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Build the Redis key for an idempotency entry.
   * Scoped per tenant to prevent collisions.
   */
  private key(tenantId: string, idempotencyKey: string): string {
    return `idempotency:${tenantId}:${idempotencyKey}`;
  }

  /**
   * Check if a response already exists for this idempotency key.
   * Returns the cached response if found.
   */
  async check(tenantId: string, idempotencyKey: string): Promise<IdempotencyCheckResult> {
    try {
      const raw = await this.redis.get(this.key(tenantId, idempotencyKey));
      if (!raw) return { hit: false };

      const entry = JSON.parse(raw) as IdempotentEntry;
      return { hit: true, entry };
    } catch {
      // If Redis is down, skip idempotency (fail-open)
      return { hit: false };
    }
  }

  /**
   * Store the response for an idempotency key.
   * Fire-and-forget — errors are swallowed (logging only).
   */
  store(tenantId: string, idempotencyKey: string, statusCode: number, body: unknown): void {
    const entry: IdempotentEntry = {
      statusCode,
      body: JSON.stringify(body),
      createdAt: new Date().toISOString(),
    };

    this.redis
      .set(
        this.key(tenantId, idempotencyKey),
        JSON.stringify(entry),
        'EX',
        this.ttlSeconds,
      )
      .catch((err) => {
        console.error('[Idempotency] Failed to store entry:', err);
      });
  }

  /**
   * Manually delete an idempotency entry (e.g. on processing error
   * where the client should be allowed to retry).
   */
  async clear(tenantId: string, idempotencyKey: string): Promise<void> {
    try {
      await this.redis.del(this.key(tenantId, idempotencyKey));
    } catch {
      // Best-effort
    }
  }
}
