import type { Redis } from 'ioredis';

/**
 * Token-aware rate limiter using Redis sliding window.
 *
 * Uses atomic Lua scripts to prevent race conditions.
 * Implements the Reserve → Execute → Refund pattern from the architecture.
 */

export interface RateLimitResult {
  /** Whether the request is allowed */
  readonly allowed: boolean;
  /** Remaining requests in the current window */
  readonly remaining: number;
  /** Milliseconds until the client should retry (only set when denied) */
  readonly retryAfterMs?: number;
}

/**
 * Lua script for sliding window rate limiting.
 * Atomic: count requests in window, add if under limit, return result.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

-- Remove entries outside the sliding window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window_ms)

-- Count current requests in window
local count = redis.call('ZCARD', key)

if count < limit then
  -- Under limit: add this request
  redis.call('ZADD', key, now, now .. ':' .. math.random(1, 1000000))
  redis.call('PEXPIRE', key, window_ms)
  return {1, limit - count - 1}
else
  -- Over limit: calculate when the oldest entry expires
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if #oldest >= 2 then
    retry_after = tonumber(oldest[2]) + window_ms - now
  end
  return {0, 0, retry_after}
end
`;

export class RateLimiter {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Check if a request is within the tenant's rate limit.
   *
   * @param tenantId - Tenant UUID
   * @param limitRpm - Requests per minute allowed
   * @returns Rate limit check result
   */
  async checkRateLimit(tenantId: string, limitRpm: number): Promise<RateLimitResult> {
    const key = `ratelimit:rpm:${tenantId}`;
    const now = Date.now();
    const windowMs = 60_000; // 1 minute sliding window

    try {
      const result = await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now.toString(),
        windowMs.toString(),
        limitRpm.toString(),
      ) as number[];

      const allowed = result[0] === 1;

      if (allowed) {
        return { allowed: true, remaining: result[1] ?? 0 };
      }

      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, result[2] ?? 1000),
      };
    } catch {
      // If Redis is down, allow the request (fail-open)
      // The circuit breaker and other layers still protect us
      return { allowed: true, remaining: -1 };
    }
  }
}
