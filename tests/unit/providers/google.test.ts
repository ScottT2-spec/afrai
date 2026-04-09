import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleProvider } from '../../../src/providers/google.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider('test-gemini-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct id and displayName', () => {
    expect(provider.id).toBe('google');
    expect(provider.displayName).toBe('Google (Gemini)');
  });

  it('converts messages to Gemini format and parses response', async () => {
    const geminiResponse = {
      candidates: [{
        content: { parts: [{ text: 'Hello from Gemini!' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(geminiResponse), { status: 200 }),
    );

    const result = await provider.complete({
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    expect(result.content).toBe('Hello from Gemini!');
    expect(result.provider).toBe('google');
    expect(result.usage.inputTokens).toBe(8);
    expect(result.usage.outputTokens).toBe(4);
    expect(result.finishReason).toBe('stop');

    // Verify Gemini format was sent
    const sentBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
    expect(sentBody.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] },
    ]);
  });

  it('maps assistant role to model role', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }), { status: 200 }),
    );

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await provider.complete({
      model: 'gemini-1.5-flash',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'How are you?' },
      ],
    });

    const sentBody = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(sentBody.contents[1].role).toBe('model'); // assistant → model
  });

  it('throws ProviderError on non-OK response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Bad Request', { status: 400 }),
    );

    await expect(
      provider.complete({ model: 'gemini-1.5-flash', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toThrow('Google Gemini API error 400');
  });

  it('maps SAFETY finish reason to content_filter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
      }), { status: 200 }),
    );

    const result = await provider.complete({
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.finishReason).toBe('content_filter');
  });

  it('maps MAX_TOKENS finish reason to length', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100, totalTokenCount: 105 },
      }), { status: 200 }),
    );

    const result = await provider.complete({
      model: 'gemini-1.5-flash',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.finishReason).toBe('length');
  });

  it('uses API key as query parameter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }), { status: 200 }),
    );

    await provider.complete({ model: 'gemini-1.5-flash', messages: [{ role: 'user', content: 'hi' }] });

    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('key=test-gemini-key');
  });

  it('healthCheck returns true on OK', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200 }),
    );
    expect(await provider.healthCheck()).toBe(true);
  });

  it('healthCheck returns false on error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timeout'));
    expect(await provider.healthCheck()).toBe(false);
  });
});
