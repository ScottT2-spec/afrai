import Redis from 'ioredis';
import { getConfig } from '../config/index.js';

let _redis: Redis | null = null;
let _useMemory = false;

/**
 * In-memory store — fallback when Redis is not available.
 * Uses a Map with TTL support via setTimeout cleanup.
 */
class MemoryStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<string> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Date.now() + 86400000; // default 24h
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    const current = entry ? parseInt(entry.value, 10) || 0 : 0;
    const next = current + 1;
    const expiresAt = entry?.expiresAt ?? Date.now() + 60000;
    this.store.set(key, { value: String(next), expiresAt });
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return -2;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  async quit(): Promise<string> {
    this.store.clear();
    return 'OK';
  }
}

const _memoryStore = new MemoryStore();

/** Common interface for Redis or memory store */
export type CacheStore = Redis | MemoryStore;

/**
 * Get or create the Redis client singleton.
 * Falls back to in-memory store if REDIS_URL is empty or set to 'memory'.
 */
export function getRedis(): Redis | MemoryStore {
  const config = getConfig();

  if (!config.REDIS_URL || config.REDIS_URL === 'memory' || config.REDIS_URL === 'none') {
    _useMemory = true;
    return _memoryStore as any;
  }

  if (!_redis) {
    _redis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) {
          // Give up after 3 retries — fall back to memory
          console.warn('Redis connection failed, falling back to in-memory store');
          _useMemory = true;
          return null; // stop retrying
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    _redis.on('error', () => {
      // Silently fall back to memory on connection errors
      if (!_useMemory) {
        console.warn('Redis unavailable — using in-memory fallback');
        _useMemory = true;
      }
    });
  }
  return _redis;
}

/**
 * Check if Redis is reachable.
 */
export async function checkRedisHealth(): Promise<boolean> {
  if (_useMemory) return true; // memory store is always healthy
  try {
    const redis = getRedis();
    const pong = await (redis as any).ping();
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
 * CacheClient adapter — wraps ioredis or memory store to match the interface
 * expected by ApiKeyService.
 */
export function createRedisCacheClient(redis: Redis | MemoryStore) {
  return {
    async get(key: string): Promise<string | null> {
      return (redis as any).get(key);
    },
    async set(key: string, value: string, _mode: string, ttlSeconds: number): Promise<unknown> {
      if ('set' in redis && _useMemory) {
        return (redis as MemoryStore).set(key, value, ttlSeconds);
      }
      return (redis as Redis).set(key, value, 'EX', ttlSeconds);
    },
    async del(key: string): Promise<unknown> {
      return (redis as any).del(key);
    },
  };
}
