import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdaptiveRouter, type XGBoostModel, type XGBoostFeatures } from '../../../src/router/adaptiveRouter.js';
import type { OutcomeSignal } from '../../../src/router/outcomeCollector.js';

// Mock static router
vi.mock('../../../src/router/smartRouter.js', () => ({
  routeRequest: vi.fn().mockResolvedValue({
    selectedModel: {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      provider: 'openai',
      costPer1kInput: 0.005,
      costPer1kOutput: 0.015,
      maxTokens: 128000,
      capabilities: ['chat', 'code', 'reasoning'],
      tiers: ['free', 'starter', 'growth', 'enterprise'],
      complexityThreshold: 0,
    },
    fallbackChain: [],
    complexityScore: 0.5,
    estimatedCostUsd: 0.01,
    reasoning: 'Static routing',
    features: {
      estimatedTokens: 100,
      hasCode: false,
      hasMath: false,
      hasReasoningKeywords: false,
      isSimpleQA: true,
      turnCount: 1,
      detectedLanguage: 'en',
    },
  }),
}));

// Mock model registry
vi.mock('../../../src/router/modelRegistry.js', () => ({
  getEligibleModels: vi.fn().mockReturnValue([
    {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      provider: 'openai',
      costPer1kInput: 0.005,
      costPer1kOutput: 0.015,
      maxTokens: 128000,
      capabilities: ['chat', 'code', 'reasoning'],
      tiers: ['free', 'starter', 'growth', 'enterprise'],
      complexityThreshold: 0,
    },
    {
      id: 'llama-3.3-70b-versatile',
      displayName: 'Llama 3.3 70B',
      provider: 'groq',
      costPer1kInput: 0.0007,
      costPer1kOutput: 0.0008,
      maxTokens: 131072,
      capabilities: ['chat', 'code'],
      tiers: ['free', 'starter', 'growth', 'enterprise'],
      complexityThreshold: 0,
    },
  ]),
}));

// Mock complexity analyzer
vi.mock('../../../src/router/complexityAnalyzer.js', () => ({
  analyzeComplexity: vi.fn().mockReturnValue({
    score: 0.5,
    features: {
      estimatedTokens: 100,
      hasCode: false,
      hasMath: false,
      hasReasoningKeywords: false,
      isSimpleQA: true,
      turnCount: 1,
      detectedLanguage: 'en',
    },
  }),
}));

// Mock cost optimizer
vi.mock('../../../src/router/costOptimizer.js', () => ({
  estimateRequestCost: vi.fn().mockReturnValue(0.01),
}));

function makeOutcome(overrides: Partial<OutcomeSignal> = {}): OutcomeSignal {
  return {
    inputTokens: 100,
    complexityScore: 0.5,
    hasCode: false,
    hasMath: false,
    hasReasoning: false,
    isSimpleQA: true,
    turnCount: 1,
    language: 'en',
    tenantTier: 'free',
    hourOfDay: 14,
    modelId: 'gpt-4o',
    providerId: 'openai',
    wasFallback: false,
    success: true,
    latencyMs: 500,
    costUsd: 0.01,
    outputTokens: 50,
    finishReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('AdaptiveRouter', () => {
  let router: AdaptiveRouter;

  beforeEach(() => {
    router = new AdaptiveRouter({ coldStartThreshold: 100 }); // low threshold for testing
  });

  describe('getMode', () => {
    it('should start in cold_start mode', () => {
      expect(router.getMode()).toBe('cold_start');
    });

    it('should transition to warm_up after cold start threshold', () => {
      for (let i = 0; i < 100; i++) {
        router.recordOutcome(makeOutcome());
      }
      expect(router.getMode()).toBe('warm_up');
    });
  });

  describe('route', () => {
    it('should use static router during cold start', async () => {
      const decision = await router.route({
        messages: [{ role: 'user', content: 'Hello' }],
        requiredCapabilities: [],
        tenantTier: 'free',
      });

      expect(decision.selectedModel.id).toBe('gpt-4o');
      expect(decision.reasoning).toContain('Static routing');
    });

    it('should use adaptive scoring after cold start', async () => {
      // Fill with enough outcomes to exit cold start
      for (let i = 0; i < 100; i++) {
        router.recordOutcome(makeOutcome({ modelId: 'gpt-4o' }));
      }

      const decision = await router.route({
        messages: [{ role: 'user', content: 'Hello' }],
        requiredCapabilities: [],
        tenantTier: 'free',
      });

      // Should have adaptive reasoning
      expect(decision.reasoning).toMatch(/warm-up|adaptive/);
      expect(decision.selectedModel).toBeDefined();
      expect(decision.fallbackChain).toBeDefined();
    });
  });

  describe('recordOutcome', () => {
    it('should feed both scorer and collector', () => {
      const signal = makeOutcome();
      router.recordOutcome(signal);

      expect(router.scorer.getTotalObservations()).toBe(1);
      expect(router.collector.size).toBe(1);
    });
  });

  describe('getInfo', () => {
    it('should return router status', () => {
      const info = router.getInfo();
      expect(info.mode).toBe('cold_start');
      expect(info.totalObservations).toBe(0);
      expect(info.explorationRate).toBeGreaterThan(0);
      expect(info.hasXGBoost).toBe(false);
    });

    it('should reflect loaded XGBoost model', () => {
      const mockModel: XGBoostModel = {
        predict: () => ({ successProb: 0.9, expectedCostUsd: 0.01 }),
      };
      router.loadModel(mockModel);

      expect(router.getInfo().hasXGBoost).toBe(true);
    });
  });

  describe('with XGBoost model', () => {
    it('should use XGBoost predictions when available', async () => {
      const mockModel: XGBoostModel = {
        predict: (features: XGBoostFeatures) => ({
          successProb: features.modelIndex === 0 ? 0.95 : 0.3,
          expectedCostUsd: features.modelIndex === 0 ? 0.01 : 0.001,
        }),
      };

      router.loadModel(mockModel);

      // Exit cold start
      for (let i = 0; i < 100; i++) {
        router.recordOutcome(makeOutcome());
      }

      const decision = await router.route({
        messages: [{ role: 'user', content: 'Write some code' }],
        requiredCapabilities: [],
        tenantTier: 'free',
      });

      expect(decision.selectedModel).toBeDefined();
      expect(decision.reasoning).toMatch(/warm-up|adaptive/);
    });
  });
});
