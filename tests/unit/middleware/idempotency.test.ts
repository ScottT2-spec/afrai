import { describe, it, expect, vi } from 'vitest';
import { IdempotencyService } from '../../../src/gateway/middleware/idempotency.js';

function createMockRedis(getValue: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(getValue),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  } as unknown as import('ioredis').default;
}

describe('IdempotencyService', () => {
  it('returns miss when key does not exist', async () => {
    const redis = createMockRedis(null);
    const svc = new IdempotencyService(redis);

    const result = await svc.check('tenant-1', 'idem-abc');

    expect(result.hit).toBe(false);
    expect(redis.get).toHaveBeenCalledWith('idempotency:tenant-1:idem-abc');
  });

  it('returns hit with cached entry when key exists', async () => {
    const entry = { statusCode: 200, body: '{"id":"req_1"}', createdAt: '2026-04-09T00:00:00Z' };
    const redis = createMockRedis(JSON.stringify(entry));
    const svc = new IdempotencyService(redis);

    const result = await svc.check('tenant-1', 'idem-abc');

    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.entry.statusCode).toBe(200);
      expect(result.entry.body).toBe('{"id":"req_1"}');
    }
  });

  it('scopes keys per tenant', async () => {
    const redis = createMockRedis(null);
    const svc = new IdempotencyService(redis);

    await svc.check('tenant-A', 'key-1');
    await svc.check('tenant-B', 'key-1');

    const calls = (redis.get as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe('idempotency:tenant-A:key-1');
    expect(calls[1]![0]).toBe('idempotency:tenant-B:key-1');
  });

  it('stores entry with correct TTL', () => {
    const redis = createMockRedis();
    const svc = new IdempotencyService(redis, 3600); // 1 hour TTL

    svc.store('tenant-1', 'idem-xyz', 200, { id: 'req_1' });

    expect(redis.set).toHaveBeenCalledWith(
      'idempotency:tenant-1:idem-xyz',
      expect.any(String),
      'EX',
      3600,
    );

    // Verify the stored value is valid JSON with correct structure
    const storedValue = JSON.parse((redis.set as ReturnType<typeof vi.fn>).mock.calls[0]![1]);
    expect(storedValue.statusCode).toBe(200);
    expect(storedValue.body).toBe('{"id":"req_1"}');
    expect(storedValue.createdAt).toBeDefined();
  });

  it('clear deletes the key', async () => {
    const redis = createMockRedis();
    const svc = new IdempotencyService(redis);

    await svc.clear('tenant-1', 'idem-abc');

    expect(redis.del).toHaveBeenCalledWith('idempotency:tenant-1:idem-abc');
  });

  it('fails open when Redis is down (check returns miss)', async () => {
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('Connection refused')),
      set: vi.fn().mockRejectedValue(new Error('Connection refused')),
      del: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as import('ioredis').default;

    const svc = new IdempotencyService(redis);
    const result = await svc.check('tenant-1', 'idem-abc');

    expect(result.hit).toBe(false); // fail-open: process normally
  });

  it('store does not throw when Redis is down', () => {
    const redis = {
      set: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as import('ioredis').default;

    const svc = new IdempotencyService(redis);

    expect(() => {
      svc.store('tenant-1', 'idem-abc', 200, { ok: true });
    }).not.toThrow();
  });

  it('clear does not throw when Redis is down', async () => {
    const redis = {
      del: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as import('ioredis').default;

    const svc = new IdempotencyService(redis);
    await expect(svc.clear('tenant-1', 'idem-abc')).resolves.toBeUndefined();
  });

  it('uses default 24h TTL when not specified', () => {
    const redis = createMockRedis();
    const svc = new IdempotencyService(redis);

    svc.store('tenant-1', 'key', 200, {});

    const ttl = (redis.set as ReturnType<typeof vi.fn>).mock.calls[0]![3];
    expect(ttl).toBe(86_400);
  });
});
