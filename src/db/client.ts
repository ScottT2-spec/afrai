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
    _pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
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
