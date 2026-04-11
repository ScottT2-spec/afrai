/**
 * Lightweight docs-only server for AfrAI.
 * Serves the Swagger UI without requiring PostgreSQL or Redis.
 * Used for preview/demo deployments (e.g., HF Spaces).
 */
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

const PORT = parseInt(process.env.PORT || '7860', 10); // HF Spaces default

async function buildDocsServer() {
  const server = Fastify({ logger: true });

  await server.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AfrAI — AI Infrastructure for Africa',
        description:
          'Smart model routing, semantic caching, and offline-first AI gateway built for the African continent.\n\n' +
          '## Features\n' +
          '- **Smart Routing** — Complexity-aware model selection with adaptive ML learning (Thompson Sampling → XGBoost)\n' +
          '- **Multi-Provider** — OpenAI, Anthropic, Google, Groq, SambaNova with automatic fallback chains\n' +
          '- **Mobile Money Payments** — MTN MoMo integration (first AI API platform to accept Mobile Money 🇬🇭)\n' +
          '- **Circuit Breaker** — Per-provider health tracking with automatic failover\n' +
          '- **Rate Limiting** — Token-aware sliding window with Redis\n' +
          '- **Idempotency** — Request deduplication with 24h TTL\n' +
          '- **Streaming** — Server-Sent Events (SSE) for real-time responses\n' +
          '- **Usage Tracking** — Per-request cost and token billing\n' +
          '- **Adaptive Learning** — Online Bayesian scoring evolves into full XGBoost ML routing\n\n' +
          '## Authentication\n' +
          'All protected endpoints require an API key via the `Authorization` header:\n' +
          '```\nAuthorization: Bearer afr_your_api_key\n```\n\n' +
          '## Architecture\n' +
          '- **Cold Start (<10K requests):** Thompson Sampling with exploration decay\n' +
          '- **Warm-up (10K–50K):** Bayesian scoring with outcome signals\n' +
          '- **Full ML (>50K):** XGBoost model (success classifier + latency regressor)\n\n' +
          '## Tech Stack\n' +
          'TypeScript · Fastify · PostgreSQL · Redis · Drizzle ORM · Zod · ONNX Runtime\n\n' +
          '---\n' +
          'Made in Ghana 🇬🇭 by [Alpha Global Minds](https://github.com/ScottT2-spec/afrai)',
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

  // ─── Health ───────────────────────────────────────────────────

  server.get('/health', {
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
  }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  server.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness check',
      description: 'Checks database and Redis connectivity. Returns 503 if any dependency is down.',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ready', 'degraded'] },
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
      },
    },
  }, async () => ({
    status: 'ready',
    checks: { database: 'ok', redis: 'ok' },
    timestamp: new Date().toISOString(),
  }));

  // ─── Completions ──────────────────────────────────────────────

  server.post('/v1/completion', {
    schema: {
      tags: ['Completions'],
      summary: 'Create a chat completion',
      description:
        'Send messages to an AI model and receive a response. AfrAI automatically routes to the optimal model based on request complexity, cost, and provider health.\n\n' +
        '**Smart Routing:** If no model is specified, AfrAI analyzes the request complexity (code detection, math, reasoning, language, token count) and picks the best model for cost and quality.\n\n' +
        '**Fallback Chain:** If the primary model fails, AfrAI automatically tries fallback models.\n\n' +
        '**Streaming:** Set `stream: true` for Server-Sent Events.',
      security: [{ BearerAuth: [] }],
      headers: {
        type: 'object',
        properties: {
          'x-idempotency-key': {
            type: 'string',
            format: 'uuid',
            description: 'Optional idempotency key to prevent duplicate processing (24h TTL)',
          },
        },
      },
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            minItems: 1,
            description: 'Conversation messages (OpenAI-compatible format)',
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['system', 'user', 'assistant'], description: 'Message role' },
                content: { type: 'string', description: 'Message content' },
              },
            },
          },
          model: {
            type: 'string',
            description: 'Force a specific model — bypasses smart routing',
            examples: ['llama-3.3-70b-versatile', 'claude-3-5-sonnet-20241022', 'gpt-4o', 'gemini-1.5-pro'],
          },
          max_tokens: { type: 'integer', minimum: 1, description: 'Maximum tokens to generate' },
          temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Sampling temperature (0.0–2.0)' },
          stream: { type: 'boolean', default: false, description: 'Enable streaming (Server-Sent Events)' },
          required_capabilities: {
            type: 'array',
            items: { type: 'string', enum: ['code', 'reasoning', 'vision', 'multilingual', 'long_context'] },
            description: 'Required model capabilities for routing',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          description: 'Successful completion',
          properties: {
            id: { type: 'string', description: 'Request ID' },
            object: { type: 'string', enum: ['chat.completion'] },
            model: { type: 'string', description: 'Model used for inference' },
            provider: { type: 'string', description: 'Provider that served the request', examples: ['groq', 'anthropic', 'openai', 'google', 'sambanova'] },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: {
                    type: 'object',
                    properties: {
                      role: { type: 'string', enum: ['assistant'] },
                      content: { type: 'string' },
                    },
                  },
                  finish_reason: { type: 'string', enum: ['stop', 'length', 'error'] },
                },
              },
            },
            usage: {
              type: 'object',
              properties: {
                input_tokens: { type: 'integer' },
                output_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' },
                cost_usd: { type: 'number', description: 'Estimated cost in USD' },
              },
            },
            routing: {
              type: 'object',
              description: 'Smart routing metadata — see how AfrAI chose the model',
              properties: {
                complexity_score: { type: 'number', description: 'Request complexity (0.0–1.0)' },
                reasoning: { type: 'string', description: 'Human-readable routing explanation' },
                fallbacks_available: { type: 'integer', description: 'Number of fallback models available' },
              },
            },
            latency_ms: { type: 'integer', description: 'End-to-end latency in milliseconds' },
          },
        },
        400: { type: 'object', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } } } } },
        401: { type: 'object', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } } },
        422: { type: 'object', description: 'No eligible models for this request', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } } },
        429: {
          type: 'object',
          description: 'Rate limit exceeded',
          properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' }, retry_after_ms: { type: 'integer' } } } },
        },
        502: { type: 'object', description: 'All providers failed', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' }, detail: { type: 'string' } } } } },
      },
    },
  }, async () => ({
    id: 'demo-request-id',
    object: 'chat.completion',
    model: 'llama-3.3-70b-versatile',
    provider: 'groq',
    choices: [{ index: 0, message: { role: 'assistant', content: 'This is a demo response.' }, finish_reason: 'stop' }],
    usage: { input_tokens: 25, output_tokens: 8, total_tokens: 33, cost_usd: 0.000012 },
    routing: { complexity_score: 0.35, reasoning: 'Simple Q&A — routed to fast/cheap model', fallbacks_available: 3 },
    latency_ms: 142,
  }));

  // ─── Payments ─────────────────────────────────────────────────

  server.get('/v1/payments/tiers', {
    schema: {
      tags: ['Payments'],
      summary: 'List credit tiers',
      description: 'View available MoMo top-up tiers with pricing in GHS and estimated API calls per tier. No authentication required.',
      response: {
        200: {
          type: 'object',
          properties: {
            currency: { type: 'string' },
            payment_method: { type: 'string' },
            tiers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  amount_ghs: { type: 'number', description: 'Price in Ghana Cedis' },
                  credits_usd: { type: 'number', description: 'API credits in USD' },
                  label: { type: 'string' },
                  estimated_calls: {
                    type: 'object',
                    properties: {
                      cheap_model: { type: 'integer', description: 'e.g. Llama 3.3 70B' },
                      mid_model: { type: 'integer', description: 'e.g. GPT-4o' },
                      premium_model: { type: 'integer', description: 'e.g. Claude 3.5 Sonnet' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async () => ({
    currency: 'GHS',
    payment_method: 'MTN Mobile Money',
    tiers: [
      { amount_ghs: 5, credits_usd: 0.30, label: 'Starter', estimated_calls: { cheap_model: 1000, mid_model: 100, premium_model: 20 } },
      { amount_ghs: 20, credits_usd: 1.25, label: 'Builder', estimated_calls: { cheap_model: 4000, mid_model: 400, premium_model: 80 } },
      { amount_ghs: 50, credits_usd: 3.00, label: 'Pro', estimated_calls: { cheap_model: 10000, mid_model: 1000, premium_model: 200 } },
      { amount_ghs: 100, credits_usd: 6.50, label: 'Scale', estimated_calls: { cheap_model: 20000, mid_model: 2000, premium_model: 400 } },
    ],
  }));

  server.post('/v1/payments/topup', {
    schema: {
      tags: ['Payments'],
      summary: 'Initiate MoMo top-up',
      description: 'Start a Mobile Money payment to add API credits. The user receives an approval prompt on their phone.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        required: ['amount', 'phone_number'],
        properties: {
          amount: { type: 'number', minimum: 0.01, description: 'Amount in GHS' },
          phone_number: { type: 'string', description: 'MTN MoMo phone number', examples: ['0241234567'] },
        },
      },
      response: {
        202: {
          type: 'object',
          description: 'Payment initiated — awaiting MoMo approval on phone',
          properties: {
            payment_id: { type: 'string' },
            momo_reference_id: { type: 'string', format: 'uuid' },
            amount_ghs: { type: 'number' },
            credits_usd: { type: 'number' },
            currency: { type: 'string' },
            status: { type: 'string', enum: ['pending'] },
            message: { type: 'string' },
            status_url: { type: 'string' },
            poll_url: { type: 'string' },
          },
        },
      },
    },
  }, async (_req, reply) => reply.code(202).send({ demo: true }));

  server.get('/v1/payments/:id/status', {
    schema: {
      tags: ['Payments'],
      summary: 'Check payment status',
      description: 'Get the current status of a MoMo payment by reference ID.',
      security: [{ BearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            momo_reference_id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'successful', 'failed'] },
            credits_usd: { type: 'number' },
            failure_reason: { type: 'string', nullable: true },
            financial_transaction_id: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async () => ({ demo: true }));

  server.post('/v1/payments/:id/poll', {
    schema: {
      tags: ['Payments'],
      summary: 'Poll payment until resolved',
      description: 'Long-polls for up to ~60s until the MoMo payment succeeds or fails.',
      security: [{ BearerAuth: [] }],
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            momo_reference_id: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'successful', 'failed'] },
            credits_usd: { type: 'number' },
          },
        },
      },
    },
  }, async () => ({ demo: true }));

  server.post('/v1/payments/momo/callback', {
    schema: {
      tags: ['Payments'],
      summary: 'MoMo callback webhook',
      description: 'Receives payment confirmation from MTN servers. Not for API consumers.',
      body: {
        type: 'object',
        properties: {
          referenceId: { type: 'string', format: 'uuid' },
          status: { type: 'string' },
          financialTransactionId: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async () => ({ received: true }));

  // ─── Wallet ───────────────────────────────────────────────────

  server.get('/v1/wallet/balance', {
    schema: {
      tags: ['Wallet'],
      summary: 'Get wallet balance',
      description: 'Returns the current API credit balance for the authenticated tenant.',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            tenant_id: { type: 'string' },
            balance_usd: { type: 'string' },
            total_purchased_usd: { type: 'string' },
            total_spent_usd: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({ demo: true }));

  server.get('/v1/wallet/history', {
    schema: {
      tags: ['Wallet'],
      summary: 'Get payment history',
      description: 'Returns recent MoMo payment transactions for the authenticated tenant.',
      security: [{ BearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            payments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  momo_reference_id: { type: 'string' },
                  phone_number: { type: 'string' },
                  amount_ghs: { type: 'number' },
                  credits_usd: { type: 'number' },
                  currency: { type: 'string' },
                  status: { type: 'string' },
                  created_at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => ({ payments: [] }));

  // ─── Root redirect ────────────────────────────────────────────

  server.get('/', async (_req, reply) => {
    return reply.redirect('/docs');
  });

  return server;
}

// Start
buildDocsServer().then(async (server) => {
  await server.listen({ port: PORT, host: '0.0.0.0' });
  server.log.info(`AfrAI API Docs live at http://0.0.0.0:${PORT}/docs`);
}).catch((err) => {
  console.error('Failed to start docs server:', err);
  process.exit(1);
});
