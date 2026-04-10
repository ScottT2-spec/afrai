import { describe, it, expect, beforeEach } from 'vitest';
import { ModelScorer } from '../../../src/router/modelScorer.js';

describe('ModelScorer', () => {
  let scorer: ModelScorer;

  beforeEach(() => {
    scorer = new ModelScorer(30, 0.10);
  });

  describe('recordOutcome', () => {
    it('should track outcomes for a model', () => {
      scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.01);
      scorer.recordOutcome('gpt-4o', 0.5, true, 600, 0.012);
      scorer.recordOutcome('gpt-4o', 0.5, false, 2000, 0.015);

      const stats = scorer.getStats('gpt-4o', 0.5);
      expect(stats).not.toBeNull();
      expect(stats!.requestCount).toBe(3);
      expect(stats!.successes).toBe(2);
      expect(stats!.failures).toBe(1);
    });

    it('should compute running average latency', () => {
      scorer.recordOutcome('gpt-4o', 0.5, true, 400, 0.01);
      scorer.recordOutcome('gpt-4o', 0.5, true, 600, 0.01);

      const stats = scorer.getStats('gpt-4o', 0.5);
      expect(stats!.avgLatencyMs).toBe(500);
    });

    it('should compute running average cost', () => {
      scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.010);
      scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.030);

      const stats = scorer.getStats('gpt-4o', 0.5);
      expect(stats!.avgCostUsd).toBeCloseTo(0.020, 6);
    });

    it('should bucket by complexity', () => {
      // trivial (<0.15) and expert (>=0.75) should be different buckets
      scorer.recordOutcome('gpt-4o', 0.1, true, 200, 0.005);
      scorer.recordOutcome('gpt-4o', 0.9, true, 3000, 0.05);

      const trivial = scorer.getStats('gpt-4o', 0.1);
      const expert = scorer.getStats('gpt-4o', 0.9);

      expect(trivial!.requestCount).toBe(1);
      expect(expert!.requestCount).toBe(1);
      expect(trivial!.avgLatencyMs).toBe(200);
      expect(expert!.avgLatencyMs).toBe(3000);
    });
  });

  describe('getStats', () => {
    it('should return null for unknown model', () => {
      expect(scorer.getStats('unknown-model', 0.5)).toBeNull();
    });

    it('should compute latency variance using Welford algorithm', () => {
      // Variance of [100, 200, 300] = 10000
      scorer.recordOutcome('gpt-4o', 0.5, true, 100, 0.01);
      scorer.recordOutcome('gpt-4o', 0.5, true, 200, 0.01);
      scorer.recordOutcome('gpt-4o', 0.5, true, 300, 0.01);

      const stats = scorer.getStats('gpt-4o', 0.5);
      expect(stats!.latencyVariance).toBeCloseTo(10000, 0);
    });
  });

  describe('scoreModel', () => {
    it('should return high score for unknown models (exploration)', () => {
      const { score, confident } = scorer.scoreModel('unknown-model', 0.5);
      expect(score).toBe(1.0);
      expect(confident).toBe(false);
    });

    it('should return non-zero score for models with data', () => {
      for (let i = 0; i < 10; i++) {
        scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.01);
      }

      const { score } = scorer.scoreModel('gpt-4o', 0.5);
      expect(score).toBeGreaterThan(0);
    });

    it('should mark as confident after minObservations', () => {
      for (let i = 0; i < 30; i++) {
        scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.01);
      }

      const { confident } = scorer.scoreModel('gpt-4o', 0.5);
      expect(confident).toBe(true);
    });

    it('should not be confident with few observations', () => {
      for (let i = 0; i < 5; i++) {
        scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.01);
      }

      const { confident } = scorer.scoreModel('gpt-4o', 0.5);
      expect(confident).toBe(false);
    });
  });

  describe('getTotalObservations', () => {
    it('should start at zero', () => {
      expect(scorer.getTotalObservations()).toBe(0);
    });

    it('should count all observations across models and buckets', () => {
      scorer.recordOutcome('gpt-4o', 0.1, true, 200, 0.005);
      scorer.recordOutcome('gpt-4o', 0.9, true, 3000, 0.05);
      scorer.recordOutcome('claude-3-5-sonnet', 0.5, true, 1000, 0.02);

      expect(scorer.getTotalObservations()).toBe(3);
    });
  });

  describe('getExplorationRate', () => {
    it('should start at base rate', () => {
      expect(scorer.getExplorationRate()).toBeCloseTo(0.10, 2);
    });

    it('should decay with more observations', () => {
      // Add lots of observations to decay the rate
      for (let i = 0; i < 10000; i++) {
        scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.01);
      }

      const rate = scorer.getExplorationRate();
      expect(rate).toBeLessThan(0.10);
      // After 10K observations, should be roughly half: 0.10 * 0.5 = 0.05
      expect(rate).toBeCloseTo(0.05, 1);
    });
  });

  describe('exportStats', () => {
    it('should export all tracked stats', () => {
      scorer.recordOutcome('gpt-4o', 0.5, true, 500, 0.01);
      scorer.recordOutcome('claude-3-5-sonnet', 0.3, false, 2000, 0.03);

      const exported = scorer.exportStats();
      const keys = Object.keys(exported);

      expect(keys.length).toBe(2);
      expect(keys.some((k) => k.startsWith('gpt-4o:'))).toBe(true);
      expect(keys.some((k) => k.startsWith('claude-3-5-sonnet:'))).toBe(true);
    });
  });
});
