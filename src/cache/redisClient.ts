import Redis from 'ioredis';
import { getConfig } from '../config/index.js';

let _redis: Redis | null = null;

/**
 * Get or create the Redis client singleton.
 */
export function getRedis(): Redis {
  if (!_redis) {
    const config = getConfig();
    _redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        // Exponential backoff capped at 2 seconds
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });
  }
  return _redis;
}

/**
 * Check if Redis is reachable.
 */
export async function checkRedisHealth(): Promise<boolean> {
  try {
    const redis = getRedis();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Close the Redis connection (for graceful shutdown).
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

/**
 * CacheClient adapter — wraps ioredis to match the interface
 * expected by ApiKeyService.
 */
export function createRedisCacheClient(redis: Redis) {
  return {
    async get(key: string): Promise<string | null> {
      return redis.get(key);
    },
    async set(key: string, value: string, _mode: string, ttlSeconds: number): Promise<unknown> {
      return redis.set(key, value, 'EX', ttlSeconds);
    },
    async del(key: string): Promise<unknown> {
      return redis.del(key);
    },
  };
}
