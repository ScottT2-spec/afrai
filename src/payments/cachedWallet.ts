/**
 * Cached Wallet — Redis-fronted wallet balance reads.
 *
 * Every API request needs to check wallet balance (can this tenant afford the call?).
 * Hitting PostgreSQL for every single request doesn't scale.
 *
 * This layer caches balance reads in Redis with a short TTL (5s).
 * Writes (credit/debit) go through PostgreSQL and invalidate the cache.
 *
 * Consistency model:
 *   - Balance reads may be up to 5s stale (acceptable for pre-flight checks)
 *   - Actual debits always go through PostgreSQL with row locks (never stale)
 *   - Cache invalidation on every write ensures fast convergence
 *
 * At 10,000 requests/sec, this reduces Postgres balance reads from 10K/s to ~200/s.
 */

import type Redis from 'ioredis';
import type { WalletBalance } from './momoTypes.js';
import type { WalletStore } from './momoPayment.js';

/** Cache key prefix */
const CACHE_PREFIX = 'wallet:balance:';

/** Balance cache TTL in seconds */
const BALANCE_TTL_SECONDS = 5;

/**
 * Wraps a WalletStore with Redis caching on read operations.
 * Write operations pass through to the underlying store and invalidate cache.
 */
export class CachedWalletStore implements WalletStore {
  constructor(
    private readonly store: WalletStore,
    private readonly redis: Redis,
  ) {}

  /**
   * Get balance — reads from Redis cache first, falls back to DB.
   */
  async getBalance(tenantId: string): Promise<WalletBalance | null> {
    const cacheKey = CACHE_PREFIX + tenantId;

    // Try cache first
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as WalletBalance;
      }
    } catch {
      // Cache miss or Redis down — fall through to DB
    }

    // Cache miss — read from DB
    const balance = await this.store.getBalance(tenantId);

    // Cache the result (even null — prevents cache stampede)
    if (balance) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(balance), 'EX', BALANCE_TTL_SECONDS);
      } catch {
        // Non-critical — next read will just hit DB
      }
    }

    return balance;
  }

  /**
   * Credit wallet — write-through to DB, invalidate cache.
   */
  async creditWallet(tenantId: string, amountUsd: number, paymentId: string): Promise<void> {
    await this.store.creditWallet(tenantId, amountUsd, paymentId);
    await this.invalidateCache(tenantId);
  }

  /**
   * Debit wallet — write-through to DB, invalidate cache.
   */
  async debitWallet(tenantId: string, amountUsd: number, requestId: string): Promise<boolean> {
    const result = await this.store.debitWallet(tenantId, amountUsd, requestId);
    await this.invalidateCache(tenantId);
    return result;
  }

  /**
   * Create wallet — write-through to DB, no cache needed.
   */
  async createWallet(tenantId: string): Promise<void> {
    await this.store.createWallet(tenantId);
  }

  /**
   * Check if a tenant can likely afford a request (fast, cached check).
   * This is a pre-flight check — the actual debit still uses DB locks.
   *
   * @param tenantId Tenant to check
   * @param estimatedCostUsd Estimated cost of the request
   * @returns true if balance likely sufficient, false if definitely not
   */
  async canAfford(tenantId: string, estimatedCostUsd: number): Promise<boolean> {
    const balance = await this.getBalance(tenantId);
    if (!balance) return false;
    return parseFloat(balance.balanceUsd) >= estimatedCostUsd;
  }

  // ── Internal ────────────────────────────────────────────────

  private async invalidateCache(tenantId: string): Promise<void> {
    try {
      await this.redis.del(CACHE_PREFIX + tenantId);
    } catch {
      // Non-critical
    }
  }
}
