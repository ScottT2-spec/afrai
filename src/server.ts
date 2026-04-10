import Fastify from 'fastify';
import { getConfig } from './config/index.js';
import tenantContextPlugin from './gateway/plugins/tenantContext.js';
import { requestIdMiddleware } from './gateway/middleware/requestId.js';
import { healthRoutes } from './gateway/routes/health.js';
import { completionsRoute } from './gateway/routes/completions.js';
import { getPool, closePool, getDb } from './db/client.js';
import { createProviderRegistry } from './providers/registry.js';
import { ApiKeyService } from './services/apiKeyService.js';
import { getRedis, checkRedisHealth, closeRedis, createRedisCacheClient } from './cache/redisClient.js';
import { CircuitBreakerManager } from './resilience/circuitBreaker.js';
import { RateLimiter } from './gateway/middleware/rateLimiter.js';
import { UsageTracker } from './billing/tracker.js';
import { IdempotencyService } from './gateway/middleware/idempotency.js';
import { AdaptiveRouter } from './router/adaptiveRouter.js';
import { loadBestAvailableModel } from './router/onnxLoader.js';
import { MomoPaymentService } from './payments/momoPayment.js';
import { PaymentProcessor } from './payments/paymentProcessor.js';
import { PostgresWalletStore } from './payments/walletStore.js';
import { PostgresPaymentStore } from './payments/paymentStore.js';
import { CachedWalletStore } from './payments/cachedWallet.js';
import { paymentRoutes } from './gateway/routes/payments.js';
import type { MomoConfig } from './payments/momoTypes.js';

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
  const redis = getRedis();

  // Redis-backed cache for API key lookups
  const cacheClient = createRedisCacheClient(redis);
  const apiKeyService = new ApiKeyService(db, cacheClient, config.API_KEY_SALT);

  // Circuit breaker — tracks provider health
  const circuitBreaker = new CircuitBreakerManager();

  // Rate limiter — Redis-backed sliding window
  const rateLimiter = new RateLimiter(redis);

  // Usage tracker — logs every request for billing
  const usageTracker = new UsageTracker(db);

  // Idempotency — prevents duplicate processing (24h TTL)
  const idempotencyService = new IdempotencyService(redis);

  // Adaptive router — learns from request outcomes
  const adaptiveRouter = new AdaptiveRouter();

  // Load trained ML model if available
  const xgboostModel = await loadBestAvailableModel('./models');
  if (xgboostModel) {
    adaptiveRouter.loadModel(xgboostModel);
    server.log.info('Adaptive router: XGBoost model loaded');
  } else {
    server.log.info('Adaptive router: using online Bayesian scoring (no trained model found)');
  }

  // --- MoMo Payment System (optional) ---
  let paymentProcessor: PaymentProcessor | null = null;

  const momoEnabled = !!(config.MOMO_SUBSCRIPTION_KEY && config.MOMO_API_USER_ID && config.MOMO_API_KEY);

  if (momoEnabled) {
    const momoConfig: MomoConfig = {
      subscriptionKey: config.MOMO_SUBSCRIPTION_KEY!,
      apiUserId: config.MOMO_API_USER_ID!,
      apiKey: config.MOMO_API_KEY!,
      environment: config.MOMO_ENVIRONMENT,
      currency: config.MOMO_CURRENCY,
      callbackUrl: config.MOMO_CALLBACK_URL,
    };

    // DB-backed stores
    const pool = getPool();
    const dbClient = {
      query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const result = await pool.query(sql, params);
        return { rows: result.rows as T[] };
      },
    };

    const walletStore = new PostgresWalletStore(dbClient);
    const paymentStore = new PostgresPaymentStore(dbClient);

    // Redis-cached wallet reads
    const cachedWallet = new CachedWalletStore(walletStore, redis);

    const momoPaymentService = new MomoPaymentService(momoConfig, paymentStore, cachedWallet);

    // Background payment processor
    paymentProcessor = new PaymentProcessor(momoPaymentService, {
      concurrency: 50,
      initialIntervalMs: 3000,
      maxIntervalMs: 15000,
      expiryMs: 10 * 60 * 1000,
    });
    paymentProcessor.start();

    // Register payment routes
    await server.register(async (instance) => {
      await paymentRoutes(instance, { apiKeyService, momoPaymentService });
    });

    server.log.info('MoMo payment system: ACTIVE (MTN Mobile Money)');
  } else {
    server.log.info('MoMo payment system: disabled (set MOMO_* env vars to enable)');
  }

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
      checkRedis: () => checkRedisHealth(),
    });
  });

  // Completions — the core route: auth → rate limit → router → provider → response
  await server.register(completionsRoute, {
    apiKeyService,
    providerRegistry,
    circuitBreaker,
    rateLimiter,
    usageTracker,
    idempotencyService,
    adaptiveRouter,
  });

  // --- Graceful shutdown ---
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'Shutting down...');
    if (paymentProcessor) paymentProcessor.stop();
    await server.close();
    await closeRedis();
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
