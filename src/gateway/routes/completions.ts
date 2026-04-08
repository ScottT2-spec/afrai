import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChatMessageSchema } from '../../types/api.js';
import { routeRequest, NoEligibleModelsError } from '../../router/smartRouter.js';
import { estimateRequestCost } from '../../router/costOptimizer.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { ProviderRegistry } from '../../providers/registry.js';
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
}

// ── Route ───────────────────────────────────────────────────────

/**
 * POST /v1/completion
 *
 * The core route that ties auth → router → provider → response.
 *
 * Flow:
 * 1. Auth middleware resolves tenant from API key
 * 2. Validate + parse request body (Zod)
 * 3. Smart router selects the best model + fallback chain
 * 4. Call provider adapter for the selected model
 * 5. Walk the fallback chain on failure
 * 6. Return unified response
 */
export async function completionsRoute(
  app: FastifyInstance,
  opts: CompletionsRouteOptions
): Promise<void> {
  const { apiKeyService, providerRegistry } = opts;
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

      // Streaming not wired yet — reject early with a clear message
      if (body.stream) {
        return reply.code(501).send({
          error: {
            type: 'not_implemented',
            message: 'Streaming is not yet available. Set stream: false or omit it.',
          },
        });
      }

      // ── 2. Route the request ────────────────────────────────────
      let decision;
      try {
        decision = await routeRequest({
          messages: body.messages,
          requiredCapabilities: body.required_capabilities ?? [],
          tenantTier: tenant.tier,
          options: {
            forceModel: body.model,
            latencyWeight: 0,
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

      // ── 3. Call provider (with fallback chain) ──────────────────
      const modelsToTry: ModelDefinition[] = [
        decision.selectedModel,
        ...decision.fallbackChain,
      ];

      let result: CompletionResponse | undefined;
      let lastError: Error | undefined;
      let usedModel: ModelDefinition | undefined;

      for (const model of modelsToTry) {
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
          usedModel = model;
          break; // success — stop trying fallbacks
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          request.log.warn(
            { model: model.id, provider: model.provider, error: lastError.message },
            'Provider call failed, trying fallback'
          );
        }
      }

      // ── 4. All providers failed ─────────────────────────────────
      if (!result) {
        return reply.code(502).send({
          error: {
            type: 'provider_error',
            message: 'All providers failed. The request could not be completed.',
            detail: lastError?.message,
          },
        });
      }

      // ── 5. Build response ───────────────────────────────────────
      const totalLatencyMs = Math.round(performance.now() - requestStart);
      const costModel = usedModel ?? decision.selectedModel;
      const costUsd = estimateRequestCost(
        costModel,
        result.usage.inputTokens,
        result.usage.outputTokens
      );

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
        cache_hit: false, // Cache layer not wired yet
      });
    }
  );
}
