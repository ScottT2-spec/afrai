import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter } from '../../../src/gateway/middleware/rateLimiter.js';

/** Minimal mock Redis that supports eval */
function createMockRedis(evalResult: number[] = [1, 59]) {
  return {
    eval: vi.fn().mockResolvedValue(evalResult),
  } as unknown as import('ioredis').default;
}

describe('RateLimiter', () => {
  it('allows request when under limit', async () => {
    const redis = createMockRedis([1, 59]); // allowed, 59 remaining
    const limiter = new RateLimiter(redis);

    const result = await limiter.checkRateLimit('tenant-1', 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
  });

  it('denies request when over limit', async () => {
    const redis = createMockRedis([0, 0, 5000]); // denied, retry in 5s
    const limiter = new RateLimiter(redis);

    const result = await limiter.checkRateLimit('tenant-1', 60);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBe(5000);
  });

  it('passes correct key format to Redis', async () => {
    const redis = createMockRedis();
    const limiter = new RateLimiter(redis);

    await limiter.checkRateLimit('tenant-abc', 100);

    const evalCall = (redis.eval as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // Key should include tenant ID
    expect(evalCall[2]).toBe('ratelimit:rpm:tenant-abc');
    // Limit should be passed
    expect(evalCall[5]).toBe('100');
  });

  it('fails open when Redis is down (allows request)', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as import('ioredis').default;

    const limiter = new RateLimiter(redis);
    const result = await limiter.checkRateLimit('tenant-1', 60);

    expect(result.allowed).toBe(true);
  });

  it('handles zero retryAfterMs gracefully', async () => {
    const redis = createMockRedis([0, 0, 0]);
    const limiter = new RateLimiter(redis);

    const result = await limiter.checkRateLimit('tenant-1', 60);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(0);
  });
});
