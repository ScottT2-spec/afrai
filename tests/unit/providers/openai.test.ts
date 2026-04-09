import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIProvider } from '../../../src/providers/openai.js';

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    provider = new OpenAIProvider('sk-test-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct id and displayName', () => {
    expect(provider.id).toBe('openai');
    expect(provider.displayName).toBe('OpenAI');
  });

  it('sends a completion request and parses the response', async () => {
    const mockResponse = {
      id: 'chatcmpl-123',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const result = await provider.complete({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.content).toBe('Hello!');
    expect(result.provider).toBe('openai');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.finishReason).toBe('stop');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('throws ProviderError on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    await expect(
      provider.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toThrow('OpenAI API error 401');
  });

  it('passes Authorization header correctly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        model: 'gpt-4o-mini',
      }), { status: 200 }),
    );

    await provider.complete({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'test' }] });

    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toContain('api.openai.com');
    expect((opts as RequestInit).headers).toHaveProperty('Authorization', 'Bearer sk-test-key');
  });

  it('healthCheck returns true on OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200 }),
    );
    expect(await provider.healthCheck()).toBe(true);
  });

  it('healthCheck returns false on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    expect(await provider.healthCheck()).toBe(false);
  });
});
