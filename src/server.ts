import Fastify from 'fastify';
import { getConfig, config } from './config/index.js';
import tenantContextPlugin from './gateway/plugins/tenantContext.js';
import { requestIdMiddleware } from './gateway/middleware/requestId.js';
import { healthRoutes } from './gateway/routes/health.js';
import { completionsRoute } from './gateway/routes/completions.js';
import { getPool, closePool } from './db/client.js';
import { createProviderRegistry } from './providers/registry.js';
import { ApiKeyService } from './services/apiKeyService.js';
import { getDb } from './db/client.js';

/**
 * Bootstrap the AfrAI Fastify server.
 */
export async function buildServer() {
  const config = getConfig();

  const server = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  // --- Plugins ---
  await server.register(tenantContextPlugin);

  // --- Global hooks ---
  server.addHook('onRequest', requestIdMiddleware);

  // --- Services ---
  const providerRegistry = createProviderRegistry();
  const db = getDb();

  // Lightweight in-memory cache stub (swap for Redis when available)
  const cacheStub = {
    async get(_key: string) { return null; },
    async set(_key: string, _value: string, _mode: string, _ttl: number) {},
    async del(_key: string) {},
  };

  const apiKeyService = new ApiKeyService(db, cacheStub, config.API_KEY_SALT);

  // --- Routes ---
  await server.register(async (instance) => {
    await healthRoutes(instance, {
      checkDb: async () => {
        try {
          const pool = getPool();
          const result = await pool.query('SELECT 1');
          return result.rowCount === 1;
        } catch {
          return false;
        }
      },
      checkRedis: async () => {
        // Redis check — will be wired when Redis client is set up
        // For now, return true in development
        return true;
      },
    });
  });

  // Completions — the core route: auth → router → provider → response
  await server.register(completionsRoute, { apiKeyService, providerRegistry });

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'Shutting down...');
    await server.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return server;
}

/**
 * Start the server (entry point).
 */
export async function startServer(): Promise<void> {
  const config = getConfig();
  const server = await buildServer();

  await server.listen({ port: config.PORT, host: '0.0.0.0' });
  server.log.info(`AfrAI Gateway listening on port ${config.PORT}`);
}

// Auto-start when run directly
startServer().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
