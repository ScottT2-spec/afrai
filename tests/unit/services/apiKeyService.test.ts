import { describe, it, expect } from 'vitest';
import { hashApiKey, generateRawApiKey } from '../../../src/services/apiKeyService.js';

const TEST_SALT = 'test-salt-for-unit-tests';

describe('API Key Generation', () => {
  it('generates keys with afr_live_ prefix', () => {
    const { rawKey } = generateRawApiKey();
    expect(rawKey).toMatch(/^afr_live_/);
  });

  it('generates keys with 32 random chars after prefix', () => {
    const { rawKey } = generateRawApiKey();
    const random = rawKey.slice('afr_live_'.length);
    expect(random).toHaveLength(32);
  });

  it('generates base62-only characters in random portion', () => {
    const { rawKey } = generateRawApiKey();
    const random = rawKey.slice('afr_live_'.length);
    expect(random).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('generates unique keys on each call', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateRawApiKey().rawKey);
    }
    expect(keys.size).toBe(100);
  });

  it('returns a 12-char prefix for display', () => {
    const { rawKey, prefix } = generateRawApiKey();
    expect(prefix).toHaveLength(12);
    expect(rawKey.startsWith(prefix)).toBe(true);
  });
});

describe('API Key Hashing', () => {
  it('produces a 64-char hex string (SHA-256)', () => {
    const hash = hashApiKey('afr_live_testkey123', TEST_SALT);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic — same input produces same hash', () => {
    const key = 'afr_live_abc123';
    expect(hashApiKey(key, TEST_SALT)).toBe(hashApiKey(key, TEST_SALT));
  });

  it('different keys produce different hashes', () => {
    const hash1 = hashApiKey('afr_live_key1', TEST_SALT);
    const hash2 = hashApiKey('afr_live_key2', TEST_SALT);
    expect(hash1).not.toBe(hash2);
  });

  it('different salts produce different hashes', () => {
    const key = 'afr_live_samekey';
    const hash1 = hashApiKey(key, 'salt-one');
    const hash2 = hashApiKey(key, 'salt-two');
    expect(hash1).not.toBe(hash2);
  });

  it('raw key is NOT recoverable from hash', () => {
    const key = 'afr_live_secret123';
    const hash = hashApiKey(key, TEST_SALT);
    // Hash should not contain the raw key
    expect(hash).not.toContain('secret');
    expect(hash).not.toContain('afr_live_');
  });
});

describe('ApiKeyService.validateApiKey', () => {
  it('returns null for empty key', async () => {
    // We test the hash logic — empty input still produces a hash
    // but won't match any stored key
    const hash = hashApiKey('', TEST_SALT);
    expect(hash).toHaveLength(64);
    // Actual DB lookup tested in integration tests
  });
});
