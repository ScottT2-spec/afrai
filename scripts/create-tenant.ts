#!/usr/bin/env npx tsx
/**
 * CLI: Create a tenant and generate their first AfrAI API key.
 *
 * Usage:
 *   npx tsx scripts/create-tenant.ts --name "Scott" --email "scott@afrai.dev" --tier free
 *
 * The API key is shown ONCE — save it immediately.
 */

import { getDb, closePool } from '../src/db/client.js';
import { getRedis, closeRedis, createRedisCacheClient } from '../src/cache/redisClient.js';
import { ApiKeyService } from '../src/services/apiKeyService.js';
import { getConfig } from '../src/config/index.js';

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  const name = getArg(args, '--name') ?? 'Default Tenant';
  const email = getArg(args, '--email') ?? 'dev@afrai.dev';
  const tier = (getArg(args, '--tier') ?? 'free') as 'free' | 'starter' | 'growth' | 'enterprise';

  console.log('\n🌍 AfrAI — Create Tenant\n');
  console.log(`  Name:  ${name}`);
  console.log(`  Email: ${email}`);
  console.log(`  Tier:  ${tier}`);
  console.log('');

  try {
    const config = getConfig();
    const db = getDb();
    const redis = getRedis();
    const cache = createRedisCacheClient(redis);
    const apiKeyService = new ApiKeyService(db, cache, config.API_KEY_SALT);

    const result = await apiKeyService.createTenant(name, email, tier);

    console.log('✅ Tenant created!\n');
    console.log('  Tenant ID: ', result.tenantId);
    console.log('  Key Prefix:', result.keyPrefix);
    console.log('');
    console.log('  ┌─────────────────────────────────────────────┐');
    console.log(`  │  API Key: ${result.rawKey}  │`);
    console.log('  └─────────────────────────────────────────────┘');
    console.log('');
    console.log('  ⚠️  Save this key NOW. It will never be shown again.');
    console.log('');
    console.log('  Usage:');
    console.log(`    curl -H "Authorization: Bearer ${result.rawKey}" \\`);
    console.log('      -H "Content-Type: application/json" \\');
    console.log('      -d \'{"messages":[{"role":"user","content":"Hello"}]}\' \\');
    console.log('      http://localhost:3000/v1/completion');
    console.log('');
  } catch (err) {
    console.error('❌ Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await closeRedis();
    await closePool();
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

main();
