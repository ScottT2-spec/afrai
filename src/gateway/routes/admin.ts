/**
 * Admin Routes — internal monitoring and management endpoints for AfrAI.
 *
 * GET  /v1/admin/router/stats     — Adaptive router mode, observations, model performance
 * GET  /v1/admin/router/models    — Per-model scoring breakdown by complexity bucket
 * GET  /v1/admin/providers        — Provider health + circuit breaker status
 * GET  /v1/admin/system           — System overview (uptime, version, config)
 * POST /v1/admin/router/reset     — Reset adaptive router stats (danger zone)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { AdaptiveRouter } from '../../router/adaptiveRouter.js';
import type { CircuitBreakerManager } from '../../resilience/circuitBreaker.js';
import type { ProviderRegistry } from '../../providers/registry.js';

// ── Route Options ───────────────────────────────────────────────

export interface AdminRouteOptions {
  apiKeyService: ApiKeyService;
  adaptiveRouter: AdaptiveRouter;
  circuitBreaker: CircuitBreakerManager;
  providerRegistry: ProviderRegistry;
  startedAt: number;
}

// ── Routes ──────────────────────────────────────────────────────

export async function adminRoutes(
  app: FastifyInstance,
  opts: AdminRouteOptions,
): Promise<void> {
  const { apiKeyService, adaptiveRouter, circuitBreaker, providerRegistry, startedAt } = opts;
  const authHook = createAuthMiddleware(apiKeyService, 'admin');

  // ── GET /v1/admin/router/stats ────────────────────────────────
  app.get(
    '/v1/admin/router/stats',
    {
      preHandler: authHook,
      schema: {
        tags: ['Admin'],
        summary: 'Adaptive router statistics',
        description:
          'Returns the current state of the adaptive ML router: mode (cold_start → warm_up → adaptive), ' +
          'total observations, exploration rate, and whether an XGBoost model is loaded.',
        security: [{ BearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['cold_start', 'warm_up', 'adaptive'],
                description: 'Current routing mode. cold_start (<10K obs) uses static rules. warm_up (10K-50K) blends Bayesian scores. adaptive (>50K) uses full ML.',
              },
              total_observations: {
                type: 'integer',
                description: 'Total requests processed and learned from',
              },
              exploration_rate: {
                type: 'number',
                description: 'Current probability of exploring a random model (decays over time)',
              },
              has_xgboost: {
                type: 'boolean',
                description: 'Whether a trained XGBoost model is loaded for inference',
              },
              thresholds: {
                type: 'object',
                properties: {
                  cold_to_warmup: { type: 'integer', description: 'Observations needed to enter warm-up mode' },
                  warmup_to_adaptive: { type: 'integer', description: 'Observations needed to enter adaptive mode' },
                },
              },
              progress: {
                type: 'object',
                description: 'Progress toward next mode',
                properties: {
                  next_mode: { type: 'string' },
                  observations_needed: { type: 'integer' },
                  percent_complete: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const info = adaptiveRouter.getInfo();
      const total = info.totalObservations;

      // Calculate progress toward next mode
      let nextMode: string;
      let observationsNeeded: number;
      let percentComplete: number;

      if (info.mode === 'cold_start') {
        nextMode = 'warm_up';
        observationsNeeded = 10_000 - total;
        percentComplete = Math.round((total / 10_000) * 100 * 100) / 100;
      } else if (info.mode === 'warm_up') {
        nextMode = 'adaptive';
        observationsNeeded = 50_000 - total;
        percentComplete = Math.round(((total - 10_000) / 40_000) * 100 * 100) / 100;
      } else {
        nextMode = 'fully_adaptive';
        observationsNeeded = 0;
        percentComplete = 100;
      }

      return reply.code(200).send({
        mode: info.mode,
        total_observations: total,
        exploration_rate: Math.round(info.explorationRate * 10000) / 10000,
        has_xgboost: info.hasXGBoost,
        thresholds: {
          cold_to_warmup: 10_000,
          warmup_to_adaptive: 50_000,
        },
        progress: {
          next_mode: nextMode,
          observations_needed: Math.max(0, observationsNeeded),
          percent_complete: percentComplete,
        },
      });
    },
  );

  // ── GET /v1/admin/router/models ───────────────────────────────
  app.get(
    '/v1/admin/router/models',
    {
      preHandler: authHook,
      schema: {
        tags: ['Admin'],
        summary: 'Per-model performance breakdown',
        description:
          'Returns detailed scoring statistics for every model tracked by the adaptive router, ' +
          'broken down by complexity bucket (trivial, simple, medium, complex, expert). ' +
          'Includes success rate, average latency, average cost, and request count.',
        security: [{ BearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              total_models_tracked: { type: 'integer' },
              models: {
                type: 'object',
                description: 'Map of "modelId:complexityBucket" → performance stats',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    request_count: { type: 'integer' },
                    successes: { type: 'integer' },
                    failures: { type: 'integer' },
                    success_rate: { type: 'number', description: 'Success rate (0.0–1.0)' },
                    avg_latency_ms: { type: 'number' },
                    avg_cost_usd: { type: 'number' },
                    latency_variance: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const info = adaptiveRouter.getInfo();
      const modelStats = info.modelStats as Record<string, {
        requestCount: number;
        successes: number;
        failures: number;
        avgLatencyMs: number;
        avgCostUsd: number;
        latencyVariance: number;
      }>;

      const formatted: Record<string, unknown> = {};
      for (const [key, stats] of Object.entries(modelStats)) {
        const total = stats.successes + stats.failures;
        formatted[key] = {
          request_count: stats.requestCount,
          successes: stats.successes,
          failures: stats.failures,
          success_rate: total > 0 ? Math.round((stats.successes / total) * 10000) / 10000 : 0,
          avg_latency_ms: Math.round(stats.avgLatencyMs * 100) / 100,
          avg_cost_usd: Math.round(stats.avgCostUsd * 1_000_000) / 1_000_000,
          latency_variance: Math.round(stats.latencyVariance * 100) / 100,
        };
      }

      return reply.code(200).send({
        total_models_tracked: Object.keys(modelStats).length,
        models: formatted,
      });
    },
  );

  // ── GET /v1/admin/providers ───────────────────────────────────
  app.get(
    '/v1/admin/providers',
    {
      preHandler: authHook,
      schema: {
        tags: ['Admin'],
        summary: 'Provider health and circuit breaker status',
        description:
          'Returns the health status of all registered AI providers, including circuit breaker state ' +
          '(closed = healthy, open = failing, half_open = testing recovery).',
        security: [{ BearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              providers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Provider identifier' },
                    circuit_breaker: {
                      type: 'string',
                      enum: ['closed', 'open', 'half_open'],
                      description: 'closed = healthy, open = failing (requests blocked), half_open = testing recovery',
                    },
                    can_receive_requests: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const allStatuses = circuitBreaker.getAllStatuses();
      const registeredProviders = providerRegistry.getIds();

      const providers = registeredProviders.map((providerId) => {
        const status = allStatuses[providerId];
        const canRequest = circuitBreaker.canRequest(providerId);

        return {
          id: providerId,
          circuit_breaker: status ?? 'closed',
          can_receive_requests: canRequest,
        };
      });

      return reply.code(200).send({ providers });
    },
  );

  // ── GET /v1/admin/system ──────────────────────────────────────
  app.get(
    '/v1/admin/system',
    {
      preHandler: authHook,
      schema: {
        tags: ['Admin'],
        summary: 'System overview',
        description: 'Returns server uptime, version, environment, and high-level configuration summary.',
        security: [{ BearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              version: { type: 'string' },
              environment: { type: 'string' },
              uptime_seconds: { type: 'integer' },
              uptime_human: { type: 'string' },
              started_at: { type: 'string', format: 'date-time' },
              node_version: { type: 'string' },
              memory_usage_mb: {
                type: 'object',
                properties: {
                  rss: { type: 'number' },
                  heap_total: { type: 'number' },
                  heap_used: { type: 'number' },
                },
              },
              features: {
                type: 'object',
                description: 'Enabled features',
                properties: {
                  adaptive_router: { type: 'boolean' },
                  xgboost_model: { type: 'boolean' },
                  momo_payments: { type: 'boolean' },
                  circuit_breaker: { type: 'boolean' },
                  rate_limiting: { type: 'boolean' },
                  idempotency: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;

      const mem = process.memoryUsage();

      return reply.code(200).send({
        version: '0.1.0',
        environment: process.env.NODE_ENV || 'development',
        uptime_seconds: uptimeSeconds,
        uptime_human: `${hours}h ${minutes}m ${seconds}s`,
        started_at: new Date(startedAt).toISOString(),
        node_version: process.version,
        memory_usage_mb: {
          rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
          heap_total: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
          heap_used: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        },
        features: {
          adaptive_router: true,
          xgboost_model: adaptiveRouter.getInfo().hasXGBoost,
          momo_payments: !!(process.env.MOMO_SUBSCRIPTION_KEY),
          circuit_breaker: true,
          rate_limiting: true,
          idempotency: true,
        },
      });
    },
  );

  // ── POST /v1/admin/router/reset ───────────────────────────────
  app.post(
    '/v1/admin/router/reset',
    {
      preHandler: authHook,
      schema: {
        tags: ['Admin'],
        summary: 'Reset adaptive router (danger zone)',
        description:
          '⚠️ Resets all learned model scores and observations. The router reverts to cold start mode. ' +
          'Use this only if the model stats are corrupted or you want to re-learn from scratch.',
        security: [{ BearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              reset: { type: 'boolean' },
              message: { type: 'string' },
              previous_observations: { type: 'integer' },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const prevObs = adaptiveRouter.getInfo().totalObservations;

      // Reset scorer and collector
      adaptiveRouter.scorer['stats'].clear();
      adaptiveRouter.collector['buffer'].length = 0;

      return reply.code(200).send({
        reset: true,
        message: 'Adaptive router has been reset to cold start mode. All learned stats cleared.',
        previous_observations: prevObs,
      });
    },
  );
}
