import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatMessageSchema } from '../../types/api.js';
import { routeRequest, NoEligibleModelsError } from '../../router/smartRouter.js';
import { estimateRequestCost } from '../../router/costOptimizer.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { CircuitBreakerManager } from '../../resilience/circuitBreaker.js';
import type { RateLimiter } from '../middleware/rateLimiter.js';
import type { UsageTracker } from '../../billing/tracker.js';
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
  const { apiKeyService, providerRegistry, circuitBreaker, rateLimiter, usageTracker } = opts;
  const authHook = createAuthMiddleware(apiKeyService, 'completions');

  app.post(
    '/v1/completion',
    { preHandler: authHook },
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

      // ── 3. Route the request ────────────────────────────────────
      let decision;
      try {
        decision = await routeRequest({
          messages: body.messages,
          requiredCapabilities: body.required_capabilities ?? [],
          tenantTier: tenant.tier,
          options: {
            forceModel: body.model,
            latencyWeight: 0,
            circuitBreakerStatus: circuitBreaker.getAllStatuses(),
          },
        });
      } catch (err) {
        if (err instanceof NoEligibleModelsError) {
          return reply.code(422).send({
            error: { type: 'routing_error', message: err.message },
          });
        }
        throw err;
      }

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

      return reply.code(200).send({
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
      });
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
