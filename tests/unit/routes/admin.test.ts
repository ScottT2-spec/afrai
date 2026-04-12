import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveRouter } from '../../../src/router/adaptiveRouter.js';

describe('Admin Route Logic', () => {
  let router: AdaptiveRouter;

  beforeEach(() => {
    router = new AdaptiveRouter({ coldStartThreshold: 100 });
  });

  describe('Router Stats (getInfo)', () => {
    it('starts in cold_start mode with zero observations', () => {
      const info = router.getInfo();
      expect(info.mode).toBe('cold_start');
      expect(info.totalObservations).toBe(0);
      expect(info.hasXGBoost).toBe(false);
      expect(info.explorationRate).toBeGreaterThan(0);
    });

    it('reports XGBoost as loaded after loadModel', () => {
      const fakeModel = { predict: () => ({ successProb: 0.9, expectedCostUsd: 0.001 }) };
      router.loadModel(fakeModel);
      expect(router.getInfo().hasXGBoost).toBe(true);
    });

    it('tracks observations after recording outcomes', () => {
      for (let i = 0; i < 50; i++) {
        router.recordOutcome({
          inputTokens: 100,
          complexityScore: 0.3,
          hasCode: false,
          hasMath: false,
          hasReasoning: false,
          isSimpleQA: true,
          turnCount: 1,
          language: 'en',
          tenantTier: 'free',
          hourOfDay: 12,
          modelId: 'llama-3.3-70b-versatile',
          providerId: 'groq',
          wasFallback: false,
          success: true,
          latencyMs: 200,
          costUsd: 0.0001,
          outputTokens: 50,
          finishReason: 'stop',
          timestamp: Date.now(),
        });
      }

      const info = router.getInfo();
      expect(info.totalObservations).toBe(50);
    });

    it('transitions to warm_up mode after enough observations', () => {
      // Using low threshold (100) for testing
      for (let i = 0; i < 101; i++) {
        router.recordOutcome({
          inputTokens: 100,
          complexityScore: 0.3,
          hasCode: false,
          hasMath: false,
          hasReasoning: false,
          isSimpleQA: true,
          turnCount: 1,
          language: 'en',
          tenantTier: 'free',
          hourOfDay: 12,
          modelId: 'llama-3.3-70b-versatile',
          providerId: 'groq',
          wasFallback: false,
          success: true,
          latencyMs: 200,
          costUsd: 0.0001,
          outputTokens: 50,
          finishReason: 'stop',
          timestamp: Date.now(),
        });
      }

      expect(router.getMode()).toBe('warm_up');
    });
  });

  describe('Model Stats (exportStats)', () => {
    it('returns empty stats when no outcomes recorded', () => {
      const info = router.getInfo();
      expect(Object.keys(info.modelStats)).toHaveLength(0);
    });

    it('tracks per-model stats with complexity buckets', () => {
      // Record some successes and failures for different models
      router.recordOutcome({
        inputTokens: 100, complexityScore: 0.1, // trivial
        hasCode: false, hasMath: false, hasReasoning: false,
        isSimpleQA: true, turnCount: 1, language: 'en',
        tenantTier: 'free', hourOfDay: 12,
        modelId: 'llama-3.3-70b-versatile', providerId: 'groq',
        wasFallback: false, success: true, latencyMs: 150,
        costUsd: 0.00005, outputTokens: 30,
        finishReason: 'stop', timestamp: Date.now(),
      });

      router.recordOutcome({
        inputTokens: 500, complexityScore: 0.7, // complex
        hasCode: true, hasMath: false, hasReasoning: true,
        isSimpleQA: false, turnCount: 3, language: 'en',
        tenantTier: 'pro', hourOfDay: 14,
        modelId: 'claude-3-5-sonnet-20241022', providerId: 'anthropic',
        wasFallback: false, success: true, latencyMs: 800,
        costUsd: 0.003, outputTokens: 200,
        finishReason: 'stop', timestamp: Date.now(),
      });

      const info = router.getInfo();
      const stats = info.modelStats as Record<string, any>;

      // Should have 2 entries (different model:bucket combos)
      expect(Object.keys(stats).length).toBe(2);
      expect(stats['llama-3.3-70b-versatile:trivial']).toBeDefined();
      expect(stats['claude-3-5-sonnet-20241022:complex']).toBeDefined();

      const llamaStats = stats['llama-3.3-70b-versatile:trivial'];
      expect(llamaStats.requestCount).toBe(1);
      expect(llamaStats.successes).toBe(1);
      expect(llamaStats.failures).toBe(0);
    });

    it('calculates success rate correctly with mixed outcomes', () => {
      for (let i = 0; i < 8; i++) {
        router.recordOutcome({
          inputTokens: 100, complexityScore: 0.3,
          hasCode: false, hasMath: false, hasReasoning: false,
          isSimpleQA: true, turnCount: 1, language: 'en',
          tenantTier: 'free', hourOfDay: 12,
          modelId: 'gpt-4o', providerId: 'openai',
          wasFallback: false, success: true, latencyMs: 300,
          costUsd: 0.001, outputTokens: 50,
          finishReason: 'stop', timestamp: Date.now(),
        });
      }
      for (let i = 0; i < 2; i++) {
        router.recordOutcome({
          inputTokens: 100, complexityScore: 0.3,
          hasCode: false, hasMath: false, hasReasoning: false,
          isSimpleQA: true, turnCount: 1, language: 'en',
          tenantTier: 'free', hourOfDay: 12,
          modelId: 'gpt-4o', providerId: 'openai',
          wasFallback: false, success: false, latencyMs: 5000,
          costUsd: 0, outputTokens: 0,
          finishReason: 'error', timestamp: Date.now(),
        });
      }

      const stats = router.getInfo().modelStats as Record<string, any>;
      const gptStats = stats['gpt-4o:simple'];
      expect(gptStats.requestCount).toBe(10);
      expect(gptStats.successes).toBe(8);
      expect(gptStats.failures).toBe(2);
    });
  });

  describe('Router Reset', () => {
    it('clears all stats and returns to zero', () => {
      // Record some data
      for (let i = 0; i < 20; i++) {
        router.recordOutcome({
          inputTokens: 100, complexityScore: 0.3,
          hasCode: false, hasMath: false, hasReasoning: false,
          isSimpleQA: true, turnCount: 1, language: 'en',
          tenantTier: 'free', hourOfDay: 12,
          modelId: 'llama-3.3-70b-versatile', providerId: 'groq',
          wasFallback: false, success: true, latencyMs: 200,
          costUsd: 0.0001, outputTokens: 50,
          finishReason: 'stop', timestamp: Date.now(),
        });
      }

      expect(router.getInfo().totalObservations).toBe(20);

      // Simulate reset (same as admin route does)
      router.scorer['stats'].clear();
      router.collector['buffer'].length = 0;

      expect(router.getInfo().totalObservations).toBe(0);
      expect(Object.keys(router.getInfo().modelStats)).toHaveLength(0);
      expect(router.getMode()).toBe('cold_start');
    });
  });

  describe('Exploration Rate', () => {
    it('starts at base rate', () => {
      const rate = router.getInfo().explorationRate;
      expect(rate).toBeCloseTo(0.1, 1);
    });

    it('decays as observations increase', () => {
      const initialRate = router.getInfo().explorationRate;

      // Add a bunch of observations
      for (let i = 0; i < 1000; i++) {
        router.recordOutcome({
          inputTokens: 100, complexityScore: 0.3,
          hasCode: false, hasMath: false, hasReasoning: false,
          isSimpleQA: true, turnCount: 1, language: 'en',
          tenantTier: 'free', hourOfDay: 12,
          modelId: 'llama-3.3-70b-versatile', providerId: 'groq',
          wasFallback: false, success: true, latencyMs: 200,
          costUsd: 0.0001, outputTokens: 50,
          finishReason: 'stop', timestamp: Date.now(),
        });
      }

      const laterRate = router.getInfo().explorationRate;
      expect(laterRate).toBeLessThan(initialRate);
    });
  });
});
