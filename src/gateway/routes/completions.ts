import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatMessageSchema } from '../../types/api.js';
import { routeRequest, NoEligibleModelsError } from '../../router/smartRouter.js';
import { estimateRequestCost } from '../../router/costOptimizer.js';
import { analyzeComplexity } from '../../router/complexityAnalyzer.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { CircuitBreakerManager } from '../../resilience/circuitBreaker.js';
import type { RateLimiter } from '../middleware/rateLimiter.js';
import type { UsageTracker } from '../../billing/tracker.js';
import type { IdempotencyService } from '../middleware/idempotency.js';
import { AdaptiveRouter } from '../../router/adaptiveRouter.js';
import type { CompletionResponse } from '../../providers/base.js';
import type { ModelDefinition } from '../../types/provider.js';

// ── Request schema ──────────────────────────────────────────────

const CompletionBodySchema = z.object({
  /** Conversation messages (OpenAI-compatible format) */
  messages: z.array(ChatMessageSchema).min(1),
  /** Force a specific model — bypasses smart routing */
  model: z.string().optional(),
  /** Maximum tokens to generate */
  max_tokens: z.number().int().positive().optional(),
  /** Sampling temperature (0.0–2.0) */
  temperature: z.number().min(0).max(2).optional(),
  /** Enable streaming (SSE) */
  stream: z.boolean().optional().default(false),
  /** Required model capabilities */
  required_capabilities: z.array(z.string()).optional(),
});

type CompletionBody = z.infer<typeof CompletionBodySchema>;

// ── Route options ───────────────────────────────────────────────

export interface CompletionsRouteOptions {
  apiKeyService: ApiKeyService;
  providerRegistry: ProviderRegistry;
  circuitBreaker: CircuitBreakerManager;
  rateLimiter: RateLimiter;
  usageTracker: UsageTracker;
  idempotencyService: IdempotencyService;
  adaptiveRouter: AdaptiveRouter;
}

// ── Route ───────────────────────────────────────────────────────

/**
 * POST /v1/completion
 *
 * The core route: auth → rate limit → router → provider → response.
 * Supports both regular and streaming (SSE) responses.
 */
export async function completionsRoute(
  app: FastifyInstance,
  opts: CompletionsRouteOptions
): Promise<void> {
  const { apiKeyService, providerRegistry, circuitBreaker, rateLimiter, usageTracker, idempotencyService } = opts;
  const authHook = createAuthMiddleware(apiKeyService, 'completions');

  app.post(
    '/v1/completion',
    {
      preHandler: authHook,
      schema: {
        tags: ['Completions'],
        summary: 'Create a chat completion',
        description:
          'Send messages to an AI model and receive a response. AfrAI automatically routes to the optimal model based on request complexity, cost, and provider health. Supports streaming via SSE.',
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
            model: { type: 'string', description: 'Force a specific model — bypasses smart routing', examples: ['llama-3.3-70b-versatile', 'claude-3-5-sonnet-20241022'] },
            max_tokens: { type: 'integer', minimum: 1, description: 'Maximum tokens to generate' },
            temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Sampling temperature (0.0–2.0)' },
            stream: { type: 'boolean', default: false, description: 'Enable streaming (SSE)' },
            required_capabilities: {
              type: 'array',
              items: { type: 'string' },
              description: 'Required model capabilities (e.g. code, reasoning, vision)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            description: 'Successful completion response',
            properties: {
              id: { type: 'string', description: 'Request ID' },
              object: { type: 'string', enum: ['chat.completion'] },
              model: { type: 'string', description: 'Model used for inference' },
              provider: { type: 'string', description: 'Provider that served the request' },
              choices: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    message: {
                      type: 'object',
                      properties: {
                        role: { type: 'string' },
                        content: { type: 'string' },
                      },
                    },
                    finish_reason: { type: 'string' },
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
                description: 'Smart routing metadata',
                properties: {
                  complexity_score: { type: 'number', description: 'Request complexity (0–1)' },
                  reasoning: { type: 'string', description: 'Why this model was chosen' },
                  fallbacks_available: { type: 'integer' },
                },
              },
              latency_ms: { type: 'integer' },
            },
          },
          400: { type: 'object', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } } },
          401: { type: 'object', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } } },
          422: { type: 'object', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } } },
          429: {
            type: 'object',
            description: 'Rate limit exceeded',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' }, retry_after_ms: { type: 'integer' } } } },
          },
          502: { type: 'object', properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } } },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = (request as unknown as Record<string, unknown>).requestId as string ?? crypto.randomUUID();
      const requestStart = performance.now();

      // ── 1. Validate body ────────────────────────────────────────
      const parsed = CompletionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            type: 'invalid_request_error',
            message: 'Invalid request body.',
            details: parsed.error.flatten().fieldErrors,
          },
        });
      }

      const body = parsed.data;
      const tenant = request.tenantContext;

      if (!tenant) {
        return reply.code(401).send({
          error: { type: 'authentication_error', message: 'Tenant context not resolved.' },
        });
      }

      // ── 2. Rate limit check ─────────────────────────────────────
      const rateResult = await rateLimiter.checkRateLimit(tenant.id, tenant.rateLimitRpm);
      if (!rateResult.allowed) {
        void reply.header('Retry-After', Math.ceil((rateResult.retryAfterMs ?? 1000) / 1000).toString());
        void reply.header('X-RateLimit-Limit', tenant.rateLimitRpm.toString());
        void reply.header('X-RateLimit-Remaining', '0');
        return reply.code(429).send({
          error: {
            type: 'rate_limit_error',
            message: 'Rate limit exceeded. Please retry later.',
            retry_after_ms: rateResult.retryAfterMs,
          },
        });
      }

      // Set rate limit headers
      void reply.header('X-RateLimit-Limit', tenant.rateLimitRpm.toString());
      void reply.header('X-RateLimit-Remaining', rateResult.remaining.toString());

      // ── 3. Idempotency check ────────────────────────────────────
      const idempotencyKey = request.headers['x-idempotency-key'];
      const hasIdempotencyKey = typeof idempotencyKey === 'string' && idempotencyKey.length > 0;

      if (hasIdempotencyKey) {
        const cached = await idempotencyService.check(tenant.id, idempotencyKey);
        if (cached.hit) {
          void reply.header('X-Idempotent-Replay', 'true');
          return reply.code(cached.entry.statusCode).send(JSON.parse(cached.entry.body));
        }
      }

      // ── 4. Route the request ────────────────────────────────────
      let decision;
      const routingRequest = {
        messages: body.messages,
        requiredCapabilities: body.required_capabilities ?? [],
        tenantTier: tenant.tier,
        options: {
          forceModel: body.model,
          latencyWeight: 0,
          circuitBreakerStatus: circuitBreaker.getAllStatuses(),
        },
      };
      try {
        // Use adaptive router when available, fall back to static
        decision = opts.adaptiveRouter
          ? await opts.adaptiveRouter.route(routingRequest)
          : await routeRequest(routingRequest);
      } catch (err) {
        if (err instanceof NoEligibleModelsError) {
          return reply.code(422).send({
            error: { type: 'routing_error', message: err.message },
          });
        }
        throw err;
      }

      // Analyze complexity features for outcome recording
      const { features: complexityFeatures } = analyzeComplexity(body.messages);

      // ── 4. Streaming path ───────────────────────────────────────
      if (body.stream) {
        return handleStreamingResponse(
          request, reply, body, decision, requestId, requestStart,
          tenant, providerRegistry, circuitBreaker, usageTracker,
        );
      }

      // ── 5. Non-streaming: call provider (with fallback chain) ──
      const modelsToTry: ModelDefinition[] = [
        decision.selectedModel,
        ...decision.fallbackChain,
      ];

      let result: CompletionResponse | undefined;
      let lastError: Error | undefined;
      let usedModel: ModelDefinition | undefined;
      let usedFallback = false;

      for (const model of modelsToTry) {
        // Check circuit breaker before calling
        if (!circuitBreaker.canRequest(model.provider)) {
          continue;
        }

        const adapter = providerRegistry.get(model.provider);
        if (!adapter) {
          lastError = new Error(
            `No adapter configured for provider '${model.provider}'. ` +
            `Set the ${model.provider.toUpperCase()}_API_KEY env var.`
          );
          continue;
        }

        try {
          result = await adapter.complete({
            model: model.id,
            messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
            maxTokens: body.max_tokens,
            temperature: body.temperature,
          });
          circuitBreaker.recordSuccess(model.provider);
          usedModel = model;
          if (model !== decision.selectedModel) usedFallback = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          circuitBreaker.recordFailure(model.provider);
          request.log.warn(
            { model: model.id, provider: model.provider, error: lastError.message },
            'Provider call failed, trying fallback'
          );
        }
      }

      // ── 6. All providers failed ─────────────────────────────────
      if (!result) {
        usageTracker.track({
          tenantId: tenant.id,
          requestId,
          model: decision.selectedModel.id,
          provider: decision.selectedModel.provider,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: Math.round(performance.now() - requestStart),
          complexityScore: decision.complexityScore,
          status: 'error',
        });

        // Record failure outcome for adaptive learning
        if (opts.adaptiveRouter) {
          opts.adaptiveRouter.recordOutcome({
            inputTokens: 0,
            complexityScore: decision.complexityScore,
            hasCode: complexityFeatures.hasCode,
            hasMath: complexityFeatures.hasMath,
            hasReasoning: complexityFeatures.hasReasoningKeywords,
            isSimpleQA: complexityFeatures.isSimpleQA,
            turnCount: complexityFeatures.turnCount,
            language: complexityFeatures.detectedLanguage,
            tenantTier: tenant.tier,
            hourOfDay: new Date().getUTCHours(),
            modelId: decision.selectedModel.id,
            providerId: decision.selectedModel.provider,
            wasFallback: false,
            success: false,
            latencyMs: Math.round(performance.now() - requestStart),
            costUsd: 0,
            outputTokens: 0,
            finishReason: 'error',
            timestamp: Date.now(),
          });
        }

        return reply.code(502).send({
          error: {
            type: 'provider_error',
            message: 'All providers failed. The request could not be completed.',
            detail: lastError?.message,
          },
        });
      }

      // ── 7. Build response ───────────────────────────────────────
      const totalLatencyMs = Math.round(performance.now() - requestStart);
      const costModel = usedModel ?? decision.selectedModel;
      const costUsd = estimateRequestCost(
        costModel,
        result.usage.inputTokens,
        result.usage.outputTokens
      );

      // Fire-and-forget usage logging
      usageTracker.track({
        tenantId: tenant.id,
        requestId,
        model: result.model,
        provider: result.provider,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd,
        latencyMs: totalLatencyMs,
        complexityScore: decision.complexityScore,
        status: usedFallback ? 'fallback' : 'success',
      });

      // Feed outcome signal to adaptive router for learning
      if (opts.adaptiveRouter) {
        opts.adaptiveRouter.recordOutcome({
          inputTokens: result.usage.inputTokens,
          complexityScore: decision.complexityScore,
          hasCode: complexityFeatures.hasCode,
          hasMath: complexityFeatures.hasMath,
          hasReasoning: complexityFeatures.hasReasoningKeywords,
          isSimpleQA: complexityFeatures.isSimpleQA,
          turnCount: complexityFeatures.turnCount,
          language: complexityFeatures.detectedLanguage,
          tenantTier: tenant.tier,
          hourOfDay: new Date().getUTCHours(),
          modelId: result.model,
          providerId: result.provider,
          wasFallback: usedFallback,
          success: true,
          latencyMs: totalLatencyMs,
          costUsd,
          outputTokens: result.usage.outputTokens,
          finishReason: result.finishReason ?? 'stop',
          timestamp: Date.now(),
        });
      }

      const responseBody = {
        id: requestId,
        object: 'chat.completion',
        model: result.model,
        provider: result.provider,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: result.finishReason,
          },
        ],
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
          cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
        },
        routing: {
          complexity_score: decision.complexityScore,
          reasoning: decision.reasoning,
          fallbacks_available: decision.fallbackChain.length,
        },
        latency_ms: totalLatencyMs,
      };

      // Store for idempotency replay
      if (hasIdempotencyKey) {
        idempotencyService.store(tenant.id, idempotencyKey!, 200, responseBody);
      }

      return reply.code(200).send(responseBody);
    }
  );
}

// ── Streaming handler ─────────────────────────────────────────────

async function handleStreamingResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  body: CompletionBody,
  decision: Awaited<ReturnType<typeof routeRequest>>,
  requestId: string,
  requestStart: number,
  tenant: NonNullable<FastifyRequest['tenantContext']>,
  providerRegistry: ProviderRegistry,
  circuitBreaker: CircuitBreakerManager,
  usageTracker: UsageTracker,
): Promise<void> {
  const modelsToTry: ModelDefinition[] = [
    decision.selectedModel,
    ...decision.fallbackChain,
  ];

  let usedModel: ModelDefinition | undefined;
  let usedFallback = false;
  let lastError: Error | undefined;

  // Set SSE headers
  void reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Request-Id': requestId,
  });

  for (const model of modelsToTry) {
    if (!circuitBreaker.canRequest(model.provider)) continue;

    const adapter = providerRegistry.get(model.provider);
    if (!adapter) continue;

    try {
      const stream = adapter.stream({
        model: model.id,
        messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: body.max_tokens,
        temperature: body.temperature,
      });

      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream) {
        // Check if client disconnected
        if (request.raw.destroyed) {
          break;
        }

        if (chunk.done) {
          inputTokens = chunk.usage?.inputTokens ?? 0;
          outputTokens = chunk.usage?.outputTokens ?? 0;

          const totalLatencyMs = Math.round(performance.now() - requestStart);
          const costUsd = estimateRequestCost(model, inputTokens, outputTokens);

          // Send final event with usage info
          reply.raw.write(`data: ${JSON.stringify({
            done: true,
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
            },
            model: model.id,
            provider: model.provider,
            latency_ms: totalLatencyMs,
          })}\n\n`);
          reply.raw.write('data: [DONE]\n\n');

          // Log usage
          usageTracker.track({
            tenantId: tenant.id,
            requestId,
            model: model.id,
            provider: model.provider,
            inputTokens,
            outputTokens,
            costUsd,
            latencyMs: totalLatencyMs,
            complexityScore: decision.complexityScore,
            status: usedFallback ? 'fallback' : 'success',
          });
        } else {
          // Send text chunk
          reply.raw.write(`data: ${JSON.stringify({
            id: requestId,
            choices: [{
              index: 0,
              delta: { content: chunk.text },
            }],
          })}\n\n`);
        }
      }

      circuitBreaker.recordSuccess(model.provider);
      usedModel = model;
      reply.raw.end();
      return;

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      circuitBreaker.recordFailure(model.provider);
      if (model !== decision.selectedModel) usedFallback = true;
      request.log.warn(
        { model: model.id, provider: model.provider, error: lastError.message },
        'Streaming provider failed, trying fallback'
      );
    }
  }

  // All providers failed during streaming
  usageTracker.track({
    tenantId: tenant.id,
    requestId,
    model: decision.selectedModel.id,
    provider: decision.selectedModel.provider,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs: Math.round(performance.now() - requestStart),
    complexityScore: decision.complexityScore,
    status: 'error',
  });

  // If we haven't written anything yet, send error as SSE event
  reply.raw.write(`data: ${JSON.stringify({
    error: {
      type: 'provider_error',
      message: 'All providers failed.',
      detail: lastError?.message,
    },
  })}\n\n`);
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}
