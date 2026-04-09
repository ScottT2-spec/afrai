import { describe, it, expect, vi } from 'vitest';
import { UsageTracker } from '../../../src/billing/tracker.js';

function createMockDb() {
  const insertChain = {
    values: vi.fn().mockReturnValue(Promise.resolve()),
  };

  return {
    insert: vi.fn().mockReturnValue(insertChain),
    _insertChain: insertChain,
  } as unknown as import('../../../src/db/client.js').Database & { _insertChain: typeof insertChain };
}

describe('UsageTracker', () => {
  it('calls db.insert with correct usage data', () => {
    const db = createMockDb();
    const tracker = new UsageTracker(db);

    tracker.track({
      tenantId: 'tenant-1',
      requestId: 'req_abc',
      model: 'gpt-4o-mini',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.00012,
      latencyMs: 500,
      complexityScore: 0.3,
      status: 'success',
    });

    expect(db.insert).toHaveBeenCalled();
    const valuesCall = db._insertChain.values.mock.calls[0]![0];
    expect(valuesCall.tenantId).toBe('tenant-1');
    expect(valuesCall.model).toBe('gpt-4o-mini');
    expect(valuesCall.status).toBe('success');
    expect(valuesCall.costUsd).toBe('0.00012000');
  });

  it('does not throw when db.insert fails', () => {
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue(Promise.reject(new Error('DB down'))),
      }),
    } as unknown as import('../../../src/db/client.js').Database;

    const tracker = new UsageTracker(db);

    // Should not throw
    expect(() => {
      tracker.track({
        tenantId: 'tenant-1',
        requestId: 'req_abc',
        model: 'gpt-4o-mini',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
        latencyMs: 200,
        complexityScore: 0.5,
        status: 'error',
      });
    }).not.toThrow();
  });

  it('tracks fallback status correctly', () => {
    const db = createMockDb();
    const tracker = new UsageTracker(db);

    tracker.track({
      tenantId: 'tenant-2',
      requestId: 'req_def',
      model: 'llama-3.1-8b-instant',
      provider: 'groq',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.00001,
      latencyMs: 150,
      complexityScore: 0.1,
      status: 'fallback',
    });

    const valuesCall = db._insertChain.values.mock.calls[0]![0];
    expect(valuesCall.status).toBe('fallback');
    expect(valuesCall.provider).toBe('groq');
  });
});
