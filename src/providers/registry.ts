import type { BaseProvider } from './base.js';
import { GroqProvider } from './groq.js';
import { SambaNovaProvider } from './sambanova.js';
import { AnthropicProvider } from './anthropic.js';

/**
 * Provider registry — manages all configured AI provider adapters.
 * Providers are registered at startup based on available API keys.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, BaseProvider>();

  /** Register a provider adapter */
  register(provider: BaseProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Get a provider by ID */
  get(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  /** Get all registered providers */
  getAll(): BaseProvider[] {
    return Array.from(this.providers.values());
  }

  /** Get all registered provider IDs */
  getIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Check if a provider is registered */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** Number of registered providers */
  get size(): number {
    return this.providers.size;
  }
}

/**
 * Initialize the provider registry from environment variables.
 * Only providers with valid API keys are registered.
 */
export function createProviderRegistry(env: Record<string, string | undefined> = process.env): ProviderRegistry {
  const registry = new ProviderRegistry();

  if (env.GROQ_API_KEY) {
    registry.register(new GroqProvider(env.GROQ_API_KEY));
  }

  if (env.SAMBANOVA_API_KEY) {
    registry.register(new SambaNovaProvider(env.SAMBANOVA_API_KEY));
  }

  if (env.ANTHROPIC_API_KEY) {
    registry.register(new AnthropicProvider(env.ANTHROPIC_API_KEY));
  }

  return registry;
}
