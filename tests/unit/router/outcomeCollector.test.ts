import { describe, it, expect, beforeEach } from 'vitest';
import { OutcomeCollector, type OutcomeSignal } from '../../../src/router/outcomeCollector.js';

function makeSignal(overrides: Partial<OutcomeSignal> = {}): OutcomeSignal {
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

describe('OutcomeCollector', () => {
  let collector: OutcomeCollector;

  beforeEach(() => {
    collector = new OutcomeCollector(100); // small buffer for testing
  });

  describe('record', () => {
    it('should store a signal', () => {
      collector.record(makeSignal());
      expect(collector.size).toBe(1);
    });

    it('should enforce ring buffer max size', () => {
      for (let i = 0; i < 150; i++) {
        collector.record(makeSignal({ inputTokens: i }));
      }

      expect(collector.size).toBe(100);
      // First signal should have been dropped, latest kept
      const all = collector.getAll();
      expect(all[0]!.inputTokens).toBe(50); // first 50 were dropped
      expect(all[all.length - 1]!.inputTokens).toBe(149);
    });
  });

  describe('getAll', () => {
    it('should return empty array when no signals', () => {
      expect(collector.getAll()).toHaveLength(0);
    });

    it('should return all signals in order', () => {
      collector.record(makeSignal({ modelId: 'a' }));
      collector.record(makeSignal({ modelId: 'b' }));
      collector.record(makeSignal({ modelId: 'c' }));

      const all = collector.getAll();
      expect(all).toHaveLength(3);
      expect(all[0]!.modelId).toBe('a');
      expect(all[2]!.modelId).toBe('c');
    });
  });

  describe('getWindow', () => {
    it('should filter signals by time window', () => {
      const now = Date.now();
      collector.record(makeSignal({ timestamp: now - 60_000 })); // 1 min ago
      collector.record(makeSignal({ timestamp: now - 3_600_000 })); // 1 hour ago
      collector.record(makeSignal({ timestamp: now - 100_000 })); // ~2 min ago

      const last5min = collector.getWindow(5 * 60_000);
      expect(last5min).toHaveLength(2); // 1 min ago + 2 min ago
    });
  });

  describe('drain', () => {
    it('should return all signals and clear the buffer', () => {
      collector.record(makeSignal());
      collector.record(makeSignal());

      const drained = collector.drain();
      expect(drained).toHaveLength(2);
      expect(collector.size).toBe(0);
    });
  });

  describe('toCSV', () => {
    it('should produce valid CSV with headers', () => {
      collector.record(makeSignal({
        inputTokens: 200,
        modelId: 'claude-3-5-sonnet-20241022',
        success: true,
        latencyMs: 750,
      }));

      const csv = collector.toCSV();
      const lines = csv.split('\n');

      expect(lines).toHaveLength(2); // header + 1 data row
      expect(lines[0]).toContain('input_tokens');
      expect(lines[0]).toContain('model_id');
      expect(lines[1]).toContain('200');
      expect(lines[1]).toContain('claude-3-5-sonnet-20241022');
    });

    it('should encode booleans as 0/1', () => {
      collector.record(makeSignal({ hasCode: true, hasMath: false }));

      const csv = collector.toCSV();
      const dataRow = csv.split('\n')[1]!;
      const columns = dataRow.split(',');

      // has_code is column index 2, has_math is column index 3
      expect(columns[2]).toBe('1'); // hasCode = true → 1
      expect(columns[3]).toBe('0'); // hasMath = false → 0
    });
  });
});
