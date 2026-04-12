import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config/index.js';
import * as schema from './schema.js';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/**
 * Get or create the PostgreSQL connection pool.
 */
export function getPool(): pg.Pool {
  if (!_pool) {
    const config = getConfig();
    // Strip sslmode from URL (we handle SSL manually via the ssl option)
    const cleanUrl = config.DATABASE_URL.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
    const needsSsl = config.DATABASE_URL.includes('supabase') || config.DATABASE_URL.includes('sslmode=require') || config.NODE_ENV === 'production';

    _pool = new Pool({
      connectionString: cleanUrl,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: 5000,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return _pool;
}

/**
 * Get the Drizzle ORM database client.
 */
export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Database = ReturnType<typeof getDb>;

/**
 * Close the pool (for graceful shutdown).
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
