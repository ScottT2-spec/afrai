import { z } from 'zod';

/**
 * Supported AI provider identifiers.
 */
export const ProviderIdSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'cohere',
  'groq',
  'sambanova',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * Capabilities a model may support.
 */
export const ModelCapabilitySchema = z.enum([
  'json_mode',
  'function_calling',
  'streaming',
  'vision',
  'code_generation',
  'reasoning',
  'multilingual',
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

/**
 * Circuit breaker states for a provider.
 * Accepted as input to the router — not managed internally.
 */
export const CircuitBreakerStateSchema = z.enum([
  'closed',
  'open',
  'half_open',
]);
export type CircuitBreakerState = z.infer<typeof CircuitBreakerStateSchema>;

/**
 * Per-provider circuit breaker status, passed into the router.
 */
export const CircuitBreakerStatusSchema = z.record(
  ProviderIdSchema,
  CircuitBreakerStateSchema
);
export type CircuitBreakerStatus = z.infer<typeof CircuitBreakerStatusSchema>;

/**
 * Token cost structure per model (cost per 1K tokens in USD).
 */
export interface ModelCost {
  /** Cost per 1K input tokens in USD */
  readonly inputPer1k: number;
  /** Cost per 1K output tokens in USD */
  readonly outputPer1k: number;
}

/**
 * Full model definition in the registry.
 */
export interface ModelDefinition {
  /** Unique model identifier (e.g. 'gpt-4o', 'claude-3-haiku') */
  readonly id: string;
  /** Provider that serves this model */
  readonly provider: ProviderId;
  /** Human-readable display name */
  readonly displayName: string;
  /** Set of capabilities this model supports */
  readonly capabilities: ReadonlySet<ModelCapability>;
  /** Cost per 1K input/output tokens */
  readonly cost: ModelCost;
  /** Maximum context window in tokens */
  readonly maxContextTokens: number;
  /** Maximum output tokens the model can generate */
  readonly maxOutputTokens: number;
  /**
   * Minimum complexity score (0.0–1.0) this model is suited for.
   * Lower = simpler requests. A model with threshold 0.0 handles anything;
   * a model with threshold 0.7 is only selected for complex requests.
   */
  readonly complexityThreshold: number;
  /** Tenant tiers that may access this model */
  readonly allowedTiers: ReadonlySet<string>;
  /** Approximate average latency in ms (used for ranking) */
  readonly avgLatencyMs: number;
}

/**
 * A scored/ranked model returned by the cost optimizer.
 */
export interface RankedModel {
  /** The model definition */
  readonly model: ModelDefinition;
  /** Composite score used for ranking (lower = better) */
  readonly score: number;
  /** Estimated cost for the request in USD */
  readonly estimatedCost: number;
}
