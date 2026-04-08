import { describe, it, expect } from 'vitest';
import { routeRequest, NoEligibleModelsError } from '../../../src/router/smartRouter.js';
import type { RoutingRequest } from '../../../src/types/api.js';

/** Helper to build a minimal valid routing request */
function makeRequest(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    messages: [{ role: 'user', content: 'Hello, how are you?' }],
    requiredCapabilities: [],
    tenantTier: 'growth',
    options: {},
    ...overrides,
  };
}

describe('smartRouter — routeRequest', () => {
  it('returns a routing decision for a simple request', async () => {
    const decision = await routeRequest(makeRequest());

    expect(decision.selectedModel).toBeDefined();
    expect(decision.selectedModel.id).toBeTruthy();
    expect(decision.complexityScore).toBeGreaterThanOrEqual(0);
    expect(decision.complexityScore).toBeLessThanOrEqual(1);
    expect(decision.fallbackChain).toBeDefined();
    expect(Array.isArray(decision.fallbackChain)).toBe(true);
    expect(decision.reasoning).toBeTruthy();
    expect(decision.features).toBeDefined();
    expect(decision.estimatedCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('selects a cheap model for trivial requests', async () => {
    const decision = await routeRequest(
      makeRequest({
        messages: [{ role: 'user', content: 'What is 1+1?' }],
        tenantTier: 'growth',
      })
    );

    // For a trivial request, should pick one of the cheap models
    const cheapModels = ['gpt-4o-mini', 'claude-3-haiku', 'gemini-1.5-flash', 'command-r', 'llama-3.1-8b-instant', 'Meta-Llama-3.1-8B-Instruct'];
    expect(cheapModels).toContain(decision.selectedModel.id);
  });

  it('provides fallback models in the chain', async () => {
    const decision = await routeRequest(
      makeRequest({ tenantTier: 'enterprise' })
    );

    // Enterprise has access to all models, so fallback chain should be populated
    expect(decision.fallbackChain.length).toBeGreaterThan(0);
  });

  it('respects tenant tier — free tier gets economy models only', async () => {
    const decision = await routeRequest(
      makeRequest({
        messages: [{ role: 'user', content: 'Tell me a joke' }],
        tenantTier: 'free',
      })
    );

    // Free tier should not get premium models (gpt-4o, claude-3.5-sonnet, etc.)
    const premiumModels = ['gpt-4o', 'claude-3.5-sonnet', 'gemini-1.5-pro'];
    expect(premiumModels).not.toContain(decision.selectedModel.id);

    // All models in the decision (primary + fallbacks) should be free-tier eligible
    for (const model of [decision.selectedModel, ...decision.fallbackChain]) {
      expect(model.allowedTiers.has('free')).toBe(true);
    }
  });

  it('respects required capabilities', async () => {
    const decision = await routeRequest(
      makeRequest({
        requiredCapabilities: ['vision'],
        tenantTier: 'growth',
      })
    );

    // Selected model must support vision
    expect(decision.selectedModel.capabilities.has('vision')).toBe(true);
  });

  it('handles forceModel option', async () => {
    const decision = await routeRequest(
      makeRequest({
        options: { forceModel: 'claude-3.5-sonnet' },
        tenantTier: 'growth',
      })
    );

    expect(decision.selectedModel.id).toBe('claude-3.5-sonnet');
    expect(decision.fallbackChain).toEqual([]);
  });

  it('throws for unknown forceModel', async () => {
    await expect(
      routeRequest(
        makeRequest({
          options: { forceModel: 'nonexistent-model' },
        })
      )
    ).rejects.toThrow(NoEligibleModelsError);
  });

  it('respects circuit breaker status — skips OPEN providers', async () => {
    const decision = await routeRequest(
      makeRequest({
        tenantTier: 'enterprise',
        options: {
          circuitBreakerStatus: {
            openai: 'open',
            anthropic: 'open',
          },
        },
      })
    );

    // Should not select an OpenAI or Anthropic model
    expect(decision.selectedModel.provider).not.toBe('openai');
    expect(decision.selectedModel.provider).not.toBe('anthropic');

    // Fallbacks should also not include open providers
    for (const fallback of decision.fallbackChain) {
      expect(fallback.provider).not.toBe('openai');
      expect(fallback.provider).not.toBe('anthropic');
    }
  });

  it('throws when all providers are OPEN', async () => {
    await expect(
      routeRequest(
        makeRequest({
          tenantTier: 'free',
          options: {
            circuitBreakerStatus: {
              openai: 'open',
              anthropic: 'open',
              google: 'open',
              cohere: 'open',
              groq: 'open',
              sambanova: 'open',
            },
          },
        })
      )
    ).rejects.toThrow(NoEligibleModelsError);
  });

  it('includes complexity features in the decision', async () => {
    const decision = await routeRequest(
      makeRequest({
        messages: [
          {
            role: 'user',
            content:
              'Analyze the trade-offs between ```python\ndef quicksort(arr):``` and mergesort',
          },
        ],
      })
    );

    expect(decision.features.hasCode).toBe(true);
    expect(decision.features.hasReasoningKeywords).toBe(true);
    expect(decision.features.estimatedTokens).toBeGreaterThan(0);
  });

  it('validates input with Zod — rejects invalid messages', async () => {
    await expect(
      routeRequest({
        messages: [],
        requiredCapabilities: [],
        tenantTier: 'growth',
        options: {},
      })
    ).rejects.toThrow(); // Zod validation: messages must have at least 1
  });

  it('scores complex requests higher than simple ones', async () => {
    const simple = await routeRequest(
      makeRequest({
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      })
    );
    const complex = await routeRequest(
      makeRequest({
        messages: [
          {
            role: 'user',
            content:
              'Analyze the comprehensive trade-offs of microservices vs monoliths. ' +
              'Evaluate scalability, explain the implications step-by-step. ' +
              'Consider ```go\nfunc main() { ... }``` deployment patterns.',
          },
        ],
      })
    );

    expect(complex.complexityScore).toBeGreaterThan(simple.complexityScore);
  });

  it('respects latencyWeight option', async () => {
    const costOptimized = await routeRequest(
      makeRequest({
        tenantTier: 'enterprise',
        options: { latencyWeight: 0 },
      })
    );
    const latencyOptimized = await routeRequest(
      makeRequest({
        tenantTier: 'enterprise',
        options: { latencyWeight: 1.0 },
      })
    );

    // Both should succeed; with high latency weight, the router may prefer a faster model
    expect(costOptimized.selectedModel).toBeDefined();
    expect(latencyOptimized.selectedModel).toBeDefined();
  });

  it('generates human-readable reasoning', async () => {
    const decision = await routeRequest(makeRequest());

    expect(decision.reasoning).toContain(decision.selectedModel.displayName);
    expect(decision.reasoning).toContain('score:');
    expect(decision.reasoning).toContain('Tier:');
  });
});
