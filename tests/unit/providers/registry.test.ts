import { describe, it, expect } from 'vitest';
import { createProviderRegistry, ProviderRegistry } from '../../../src/providers/registry.js';

describe('ProviderRegistry', () => {
  it('starts empty', () => {
    const registry = new ProviderRegistry();
    expect(registry.size).toBe(0);
    expect(registry.getAll()).toEqual([]);
  });

  it('registers and retrieves providers', () => {
    const registry = createProviderRegistry({
      GROQ_API_KEY: 'gsk_test123',
      SAMBANOVA_API_KEY: 'sn_test456',
      ANTHROPIC_API_KEY: 'sk-ant-test789',
    });

    expect(registry.size).toBe(3);
    expect(registry.has('groq')).toBe(true);
    expect(registry.has('sambanova')).toBe(true);
    expect(registry.has('anthropic')).toBe(true);
    expect(registry.has('openai')).toBe(false);
  });

  it('only registers providers with API keys', () => {
    const registry = createProviderRegistry({
      GROQ_API_KEY: 'gsk_test123',
      // No SAMBANOVA_API_KEY
      // No ANTHROPIC_API_KEY
    });

    expect(registry.size).toBe(1);
    expect(registry.has('groq')).toBe(true);
    expect(registry.has('sambanova')).toBe(false);
    expect(registry.has('anthropic')).toBe(false);
  });

  it('registers nothing when no keys provided', () => {
    const registry = createProviderRegistry({});
    expect(registry.size).toBe(0);
  });

  it('skips empty string API keys', () => {
    const registry = createProviderRegistry({
      GROQ_API_KEY: '',
      SAMBANOVA_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    });
    expect(registry.size).toBe(0);
  });

  it('get() returns undefined for unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getIds() returns registered provider IDs', () => {
    const registry = createProviderRegistry({
      GROQ_API_KEY: 'test',
      ANTHROPIC_API_KEY: 'test',
    });

    const ids = registry.getIds();
    expect(ids).toContain('groq');
    expect(ids).toContain('anthropic');
    expect(ids).not.toContain('sambanova');
  });

  it('providers have correct display names', () => {
    const registry = createProviderRegistry({
      GROQ_API_KEY: 'test',
      SAMBANOVA_API_KEY: 'test',
      ANTHROPIC_API_KEY: 'test',
    });

    expect(registry.get('groq')?.displayName).toBe('Groq');
    expect(registry.get('sambanova')?.displayName).toBe('SambaNova');
    expect(registry.get('anthropic')?.displayName).toBe('Anthropic (Claude)');
  });
});
