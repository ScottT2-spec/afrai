import { describe, it, expect } from 'vitest';
import {
  rankModels,
  selectWithFallbacks,
  estimateRequestCost,
} from '../../../src/router/costOptimizer.js';
import type { ModelDefinition, ModelCapability } from '../../../src/types/provider.js';

/** Helper to create a test model definition */
function createModel(overrides: Partial<ModelDefinition> & { id: string }): ModelDefinition {
  return {
    provider: 'openai',
    displayName: overrides.id,
    capabilities: new Set<ModelCapability>(['streaming']),
    cost: { inputPer1k: 0.001, outputPer1k: 0.002 },
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    complexityThreshold: 0.0,
    allowedTiers: new Set(['free', 'starter', 'growth', 'enterprise']),
    avgLatencyMs: 1_000,
    ...overrides,
  };
}

describe('estimateRequestCost', () => {
  it('calculates cost based on token counts and pricing', () => {
    const model = createModel({
      id: 'test',
      cost: { inputPer1k: 0.01, outputPer1k: 0.03 },
    });
    // 1000 input tokens × $0.01/1K + 500 output tokens × $0.03/1K
    // = $0.01 + $0.015 = $0.025
    const cost = estimateRequestCost(model, 1000, 500);
    expect(cost).toBeCloseTo(0.025, 6);
  });

  it('returns 0 for 0 tokens', () => {
    const model = createModel({ id: 'test' });
    expect(estimateRequestCost(model, 0, 0)).toBe(0);
  });
});

describe('rankModels', () => {
  it('ranks cheaper models first for low-complexity requests', () => {
    const cheap = createModel({
      id: 'cheap',
      cost: { inputPer1k: 0.0001, outputPer1k: 0.0004 },
      complexityThreshold: 0.0,
    });
    const expensive = createModel({
      id: 'expensive',
      cost: { inputPer1k: 0.005, outputPer1k: 0.015 },
      complexityThreshold: 0.5,
    });

    const ranked = rankModels([expensive, cheap], 0.1);
    expect(ranked[0]!.model.id).toBe('cheap');
  });

  it('penalizes models whose complexity threshold exceeds request complexity', () => {
    const suited = createModel({
      id: 'suited',
      cost: { inputPer1k: 0.001, outputPer1k: 0.003 },
      complexityThreshold: 0.0,
    });
    const overqualified = createModel({
      id: 'overqualified',
      cost: { inputPer1k: 0.0005, outputPer1k: 0.001 },
      complexityThreshold: 0.7,
    });

    // Even though overqualified is cheaper, it gets penalized for
    // simple requests (complexity 0.1 < threshold 0.7)
    const ranked = rankModels([overqualified, suited], 0.1);
    expect(ranked[0]!.model.id).toBe('suited');
  });

  it('respects latency weight in ranking', () => {
    const fast = createModel({
      id: 'fast',
      cost: { inputPer1k: 0.0012, outputPer1k: 0.0036 },
      avgLatencyMs: 100,
    });
    const slow = createModel({
      id: 'slow',
      cost: { inputPer1k: 0.001, outputPer1k: 0.003 },
      avgLatencyMs: 3_000,
    });

    // With no latency weight, slow (cheaper) wins
    const noLatency = rankModels([fast, slow], 0.5, { latencyWeight: 0 });
    expect(noLatency[0]!.model.id).toBe('slow');

    // With high latency weight, the slow model gets a heavy penalty
    // score = cost × (1 + latencyWeight × normalizedLatency)
    // fast: cost × (1 + 1.0 × 0.033) ≈ cost × 1.033
    // slow: cost × (1 + 1.0 × 1.0)   = cost × 2.0
    const highLatency = rankModels([fast, slow], 0.5, { latencyWeight: 1.0 });
    expect(highLatency[0]!.model.id).toBe('fast');
  });

  it('filters by maxCostUsd', () => {
    const cheap = createModel({
      id: 'cheap',
      cost: { inputPer1k: 0.0001, outputPer1k: 0.0004 },
    });
    const expensive = createModel({
      id: 'expensive',
      cost: { inputPer1k: 0.05, outputPer1k: 0.15 },
    });

    const ranked = rankModels([cheap, expensive], 0.5, {
      maxCostUsd: 0.01,
      estimatedInputTokens: 500,
      estimatedOutputTokens: 256,
    });

    // Expensive model should be filtered out
    expect(ranked.every((r) => r.model.id !== 'expensive')).toBe(true);
    expect(ranked.length).toBeGreaterThan(0);
  });

  it('returns empty array when no models provided', () => {
    const ranked = rankModels([], 0.5);
    expect(ranked).toEqual([]);
  });

  it('uses provided token estimates for cost calculation', () => {
    const model = createModel({
      id: 'test',
      cost: { inputPer1k: 0.01, outputPer1k: 0.03 },
    });

    const ranked = rankModels([model], 0.5, {
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 500,
    });

    expect(ranked[0]!.estimatedCost).toBeCloseTo(0.025, 6);
  });
});

describe('selectWithFallbacks', () => {
  it('returns primary model and fallbacks', () => {
    const models = [
      createModel({ id: 'first' }),
      createModel({ id: 'second' }),
      createModel({ id: 'third' }),
    ];

    const ranked = rankModels(models, 0.5);
    const result = selectWithFallbacks(ranked);

    expect(result).not.toBeNull();
    expect(result!.primary).toBeDefined();
    expect(result!.fallbacks.length).toBe(2);
  });

  it('returns null for empty ranked list', () => {
    const result = selectWithFallbacks([]);
    expect(result).toBeNull();
  });

  it('returns single model with empty fallback chain', () => {
    const models = [createModel({ id: 'only' })];
    const ranked = rankModels(models, 0.5);
    const result = selectWithFallbacks(ranked);

    expect(result).not.toBeNull();
    expect(result!.primary.model.id).toBe('only');
    expect(result!.fallbacks).toEqual([]);
  });
});
