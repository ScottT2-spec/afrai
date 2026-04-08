import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/afrai';
const API_KEY_SALT = process.env.API_KEY_SALT ?? 'afrai-dev-salt-change-me-in-prod';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62[bytes[i]! % 62];
  }
  return result;
}

async function seed() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  const tenantName = process.argv[2] ?? 'Test Company';
  const tenantEmail = process.argv[3] ?? 'test@example.com';

  // Create tenant
  const { rows: [tenant] } = await pool.query(
    `INSERT INTO tenants (name, email, tier) VALUES ($1, $2, 'growth') RETURNING id`,
    [tenantName, tenantEmail]
  );

  // Generate API key
  const rawKey = `afr_live_${randomBase62(32)}`;
  const prefix = rawKey.slice(0, 12);
  const keyHash = createHash('sha256').update(rawKey + API_KEY_SALT).digest('hex');

  await pool.query(
    `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, name, scopes, rate_limit_rpm)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenant.id, keyHash, prefix, 'Default Key', ['completions', 'embeddings'], 1000]
  );

  console.log('\n🚀 Tenant created!');
  console.log(`   Name:    ${tenantName}`);
  console.log(`   Email:   ${tenantEmail}`);
  console.log(`   Tier:    growth`);
  console.log(`   API Key: ${rawKey}`);
  console.log('\n⚠️  Save this key — it won\'t be shown again.\n');

  await pool.end();
}

seed().catch((err) => { console.error(err); process.exit(1); });
