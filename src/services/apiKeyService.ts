import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { tenants, apiKeys } from '../db/schema.js';
import type { TenantContext, TenantTier } from '../types/tenant.js';

/** Base62 alphabet for key generation */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a cryptographically random base62 string of given length.
 */
function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62[bytes[i]! % 62];
  }
  return result;
}

/**
 * Hash an API key with SHA-256 + salt.
 * This is the only form we ever store.
 */
export function hashApiKey(rawKey: string, salt: string): string {
  return createHash('sha256').update(rawKey + salt).digest('hex');
}

/**
 * Generate a new raw API key in format: afr_live_ + 32 base62 chars.
 * Returns the raw key (shown to user ONCE) and the prefix (for display).
 */
export function generateRawApiKey(): { rawKey: string; prefix: string } {
  const random = randomBase62(32);
  const rawKey = `afr_live_${random}`;
  const prefix = rawKey.slice(0, 12);
  return { rawKey, prefix };
}

/**
 * Redis cache interface — injected for testability.
 */
export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * API Key Service — manages key lifecycle and tenant resolution.
 */
export class ApiKeyService {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheClient,
    private readonly salt: string,
  ) {}

  /**
   * Create a new tenant with their first API key.
   * Returns the raw key (show to user ONCE — never stored).
   */
  async createTenant(
    name: string,
    email: string,
    tier: TenantTier = 'free',
  ): Promise<{ tenantId: string; rawKey: string; keyPrefix: string }> {
    const { rawKey, prefix } = generateRawApiKey();
    const keyHash = hashApiKey(rawKey, this.salt);

    const [tenant] = await this.db
      .insert(tenants)
      .values({ name, email, tier })
      .returning({ id: tenants.id });

    if (!tenant) {
      throw new Error('Failed to create tenant');
    }

    await this.db.insert(apiKeys).values({
      tenantId: tenant.id,
      keyHash,
      keyPrefix: prefix,
      name: 'Default API Key',
      scopes: ['completions', 'embeddings'],
      rateLimitRpm: tier === 'free' ? 60 : tier === 'starter' ? 300 : tier === 'growth' ? 1000 : 5000,
    });

    return { tenantId: tenant.id, rawKey, keyPrefix: prefix };
  }

  /**
   * Validate an API key and resolve the tenant context.
   * Checks Redis cache first (5min TTL), falls back to DB.
   * Returns null if key is invalid or inactive.
   */
  async validateApiKey(rawKey: string): Promise<TenantContext | null> {
    const keyHash = hashApiKey(rawKey, this.salt);
    const cacheKey = `apikey:${keyHash}`;

    // Try cache first
    const cached = await this.cache.get(cacheKey).catch(() => null);
    if (cached) {
      return JSON.parse(cached) as TenantContext;
    }

    // DB fallback
    const rows = await this.db
      .select({
        keyId: apiKeys.id,
        tenantId: apiKeys.tenantId,
        isActive: apiKeys.isActive,
        scopes: apiKeys.scopes,
        rateLimitRpm: apiKeys.rateLimitRpm,
        tier: tenants.tier,
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    const row = rows[0];
    if (!row || !row.isActive) {
      return null;
    }

    const context: TenantContext = {
      id: row.tenantId,
      tier: row.tier as TenantTier,
      apiKeyId: row.keyId,
      scopes: row.scopes ?? ['completions', 'embeddings'],
      rateLimitRpm: row.rateLimitRpm ?? 60,
    };

    // Cache for 5 minutes
    await this.cache.set(cacheKey, JSON.stringify(context), 'EX', 300).catch(() => {});

    // Update last_used_at async (fire-and-forget)
    this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.keyId))
      .catch(() => {});

    return context;
  }

  /**
   * Deactivate an API key (soft delete).
   */
  async deactivateApiKey(keyId: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ isActive: false })
      .where(eq(apiKeys.id, keyId));

    // Invalidate any cached entries for this key
    // We'd need the hash to clear cache — in practice, TTL handles it
  }

  /**
   * Rotate: create a new key for the tenant. Old key remains active
   * (caller should deactivate it after grace period).
   */
  async rotateApiKey(
    tenantId: string,
  ): Promise<{ rawKey: string; keyPrefix: string; keyId: string }> {
    const { rawKey, prefix } = generateRawApiKey();
    const keyHash = hashApiKey(rawKey, this.salt);

    // Look up tenant tier for rate limit defaults
    const [tenant] = await this.db
      .select({ tier: tenants.tier })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      throw new Error(`Tenant not found: ${tenantId}`);
    }

    const tier = tenant.tier as TenantTier;

    const [newKey] = await this.db
      .insert(apiKeys)
      .values({
        tenantId,
        keyHash,
        keyPrefix: prefix,
        name: 'Rotated API Key',
        scopes: ['completions', 'embeddings'],
        rateLimitRpm: tier === 'free' ? 60 : tier === 'starter' ? 300 : tier === 'growth' ? 1000 : 5000,
      })
      .returning({ id: apiKeys.id });

    if (!newKey) {
      throw new Error('Failed to create rotated key');
    }

    return { rawKey, keyPrefix: prefix, keyId: newKey.id };
  }
}
