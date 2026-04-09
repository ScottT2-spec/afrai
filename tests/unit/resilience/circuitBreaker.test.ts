import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreakerManager } from '../../../src/resilience/circuitBreaker.js';

describe('CircuitBreakerManager', () => {
  let cb: CircuitBreakerManager;

  beforeEach(() => {
    cb = new CircuitBreakerManager({
      failureThreshold: 3,
      failureWindowMs: 10_000,
      cooldownMs: 5_000,
    });
  });

  it('starts in CLOSED state (all requests allowed)', () => {
    expect(cb.canRequest('groq')).toBe(true);
    expect(cb.getStatus('groq')).toBe('closed');
  });

  it('stays CLOSED when failures are below threshold', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    expect(cb.canRequest('groq')).toBe(true);
    expect(cb.getStatus('groq')).toBe('closed');
  });

  it('transitions to OPEN after reaching failure threshold', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq'); // 3rd failure = threshold
    expect(cb.canRequest('groq')).toBe(false);
    expect(cb.getStatus('groq')).toBe('open');
  });

  it('keeps different providers independent', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    expect(cb.canRequest('groq')).toBe(false);
    expect(cb.canRequest('anthropic')).toBe(true);
  });

  it('transitions OPEN → HALF_OPEN after cooldown', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    expect(cb.getStatus('groq')).toBe('open');

    // Simulate cooldown elapsed
    vi.useFakeTimers();
    vi.advanceTimersByTime(5_001);

    expect(cb.canRequest('groq')).toBe(true); // first test request allowed
    expect(cb.getStatus('groq')).toBe('half_open');

    vi.useRealTimers();
  });

  it('transitions HALF_OPEN → CLOSED on success', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq');

    vi.useFakeTimers();
    vi.advanceTimersByTime(5_001);
    cb.canRequest('groq'); // triggers HALF_OPEN

    cb.recordSuccess('groq');
    expect(cb.getStatus('groq')).toBe('closed');
    expect(cb.canRequest('groq')).toBe(true);

    vi.useRealTimers();
  });

  it('transitions HALF_OPEN → OPEN on failure', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq');

    vi.useFakeTimers();
    vi.advanceTimersByTime(5_001);
    cb.canRequest('groq'); // triggers HALF_OPEN

    cb.recordFailure('groq');
    expect(cb.getStatus('groq')).toBe('open');
    expect(cb.canRequest('groq')).toBe(false);

    vi.useRealTimers();
  });

  it('does not count old failures outside the time window', () => {
    vi.useFakeTimers();

    cb.recordFailure('groq');
    cb.recordFailure('groq');

    // Advance past the failure window
    vi.advanceTimersByTime(11_000);

    // These old failures are now outside the window
    cb.recordFailure('groq'); // only 1 failure in current window
    expect(cb.getStatus('groq')).toBe('closed');

    vi.useRealTimers();
  });

  it('reset() brings provider back to CLOSED', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    expect(cb.getStatus('groq')).toBe('open');

    cb.reset('groq');
    expect(cb.getStatus('groq')).toBe('closed');
    expect(cb.canRequest('groq')).toBe(true);
  });

  it('getAllStatuses() returns all tracked providers', () => {
    cb.recordSuccess('groq');
    cb.recordSuccess('anthropic');
    cb.recordFailure('sambanova');
    cb.recordFailure('sambanova');
    cb.recordFailure('sambanova');

    const statuses = cb.getAllStatuses();
    expect(statuses['groq']).toBe('closed');
    expect(statuses['anthropic']).toBe('closed');
    expect(statuses['sambanova']).toBe('open');
  });

  it('blocks concurrent HALF_OPEN requests (only 1 test allowed)', () => {
    cb.recordFailure('groq');
    cb.recordFailure('groq');
    cb.recordFailure('groq');

    vi.useFakeTimers();
    vi.advanceTimersByTime(5_001);

    expect(cb.canRequest('groq')).toBe(true);  // first request → transitions to HALF_OPEN
    expect(cb.canRequest('groq')).toBe(false); // second request blocked

    vi.useRealTimers();
  });

  it('recordSuccess in CLOSED state has no adverse effect', () => {
    cb.recordSuccess('groq');
    cb.recordSuccess('groq');
    expect(cb.getStatus('groq')).toBe('closed');
    expect(cb.canRequest('groq')).toBe(true);
  });
});
