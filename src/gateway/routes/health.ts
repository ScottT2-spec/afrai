import type { FastifyInstance } from 'fastify';

interface HealthDeps {
  /** Check if database is reachable */
  checkDb: () => Promise<boolean>;
  /** Check if Redis is reachable */
  checkRedis: () => Promise<boolean>;
}

/**
 * Register health check routes.
 *
 * GET /health       → basic liveness (always 200 if server is up)
 * GET /health/ready → readiness (checks DB + Redis connectivity)
 */
export async function healthRoutes(
  fastify: FastifyInstance,
  deps: HealthDeps,
): Promise<void> {
  /** Liveness — if you can hit this, the server is alive */
  fastify.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness check',
      description: 'Returns 200 if the server is alive. No dependency checks.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ok'] },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /** Readiness — checks downstream dependencies */
  fastify.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness check',
      description: 'Checks database and Redis connectivity. Returns 503 if any dependency is down.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ready'] },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'string', enum: ['ok', 'fail'] },
                redis: { type: 'string', enum: ['ok', 'fail'] },
              },
            },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['degraded'] },
            checks: { type: 'object' },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      const dbOk = await deps.checkDb();
      checks['database'] = dbOk ? 'ok' : 'fail';
      if (!dbOk) healthy = false;
    } catch {
      checks['database'] = 'fail';
      healthy = false;
    }

    try {
      const redisOk = await deps.checkRedis();
      checks['redis'] = redisOk ? 'ok' : 'fail';
      if (!redisOk) healthy = false;
    } catch {
      checks['redis'] = 'fail';
      healthy = false;
    }

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ready' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    });
  });
}
