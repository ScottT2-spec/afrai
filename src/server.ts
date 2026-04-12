import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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
import { adminRoutes } from './gateway/routes/admin.js';
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

  // --- OpenAPI / Swagger ---
  await server.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AfrAI — AI Infrastructure for Africa',
        description:
          'Smart model routing, semantic caching, and offline-first AI gateway built for the African continent.\n\n' +
          '## Features\n' +
          '- **Smart Routing** — Complexity-aware model selection with adaptive ML learning\n' +
          '- **Multi-Provider** — OpenAI, Anthropic, Google, Groq, SambaNova with automatic fallback\n' +
          '- **Mobile Money Payments** — MTN MoMo integration (first AI API to accept Mobile Money)\n' +
          '- **Circuit Breaker** — Per-provider health tracking with automatic failover\n' +
          '- **Rate Limiting** — Token-aware sliding window with Redis\n' +
          '- **Idempotency** — Request deduplication with 24h TTL\n' +
          '- **Streaming** — Server-Sent Events (SSE) for real-time responses\n' +
          '- **Usage Tracking** — Per-request cost and token billing\n\n' +
          '## Authentication\n' +
          'All protected endpoints require an API key via the `Authorization` header:\n' +
          '```\nAuthorization: Bearer afr_your_api_key\n```\n\n' +
          '## Made in Ghana 🇬🇭 by Alpha Global Minds',
        version: '0.1.0',
        contact: {
          name: 'Scott Antwi',
          url: 'https://github.com/ScottT2-spec/afrai',
        },
        license: {
          name: 'MIT',
        },
      },
      servers: [
        { url: '/', description: 'Current server' },
      ],
      tags: [
        { name: 'Health', description: 'Server health and readiness checks' },
        { name: 'Completions', description: 'AI model inference — the core route' },
        { name: 'Payments', description: 'MTN Mobile Money top-ups and wallet management' },
        { name: 'Wallet', description: 'Credit balance and transaction history' },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'API Key',
            description: 'AfrAI API key (starts with afr_)',
          },
        },
      },
    },
  });

  await server.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: false,
    },
    staticCSP: false,
    theme: {
      title: 'AfrAI API Docs',
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

  // Track server start time for admin uptime
  const startedAt = Date.now();

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

  // Admin — router stats, provider health, system info
  await server.register(async (instance) => {
    await adminRoutes(instance, {
      apiKeyService,
      adaptiveRouter,
      circuitBreaker,
      providerRegistry,
      startedAt,
    });
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
