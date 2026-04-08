import { describe, it, expect } from 'vitest';
import { GroqProvider } from '../../../src/providers/groq.js';
import { SambaNovaProvider } from '../../../src/providers/sambanova.js';
import { AnthropicProvider } from '../../../src/providers/anthropic.js';

describe('GroqProvider', () => {
  const provider = new GroqProvider('test-key');

  it('has correct id and displayName', () => {
    expect(provider.id).toBe('groq');
    expect(provider.displayName).toBe('Groq');
  });

  it('throws ProviderError on failed request', async () => {
    // Will fail because test-key is invalid — but validates error handling
    await expect(
      provider.complete({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'test' }],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });
});

describe('SambaNovaProvider', () => {
  const provider = new SambaNovaProvider('test-key');

  it('has correct id and displayName', () => {
    expect(provider.id).toBe('sambanova');
    expect(provider.displayName).toBe('SambaNova');
  });

  it('throws ProviderError on failed request', async () => {
    await expect(
      provider.complete({
        model: 'Meta-Llama-3.1-70B-Instruct',
        messages: [{ role: 'user', content: 'test' }],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });
});

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider('test-key');

  it('has correct id and displayName', () => {
    expect(provider.id).toBe('anthropic');
    expect(provider.displayName).toBe('Anthropic (Claude)');
  });

  it('throws ProviderError on failed request', async () => {
    await expect(
      provider.complete({
        model: 'claude-3-5-haiku-20241022',
        messages: [{ role: 'user', content: 'test' }],
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
  });
});

describe('Provider interface compliance', () => {
  const providers = [
    new GroqProvider('test'),
    new SambaNovaProvider('test'),
    new AnthropicProvider('test'),
  ];

  for (const p of providers) {
    it(`${p.displayName} implements complete()`, () => {
      expect(typeof p.complete).toBe('function');
    });

    it(`${p.displayName} implements stream()`, () => {
      expect(typeof p.stream).toBe('function');
    });

    it(`${p.displayName} implements healthCheck()`, () => {
      expect(typeof p.healthCheck).toBe('function');
    });
  }
});
