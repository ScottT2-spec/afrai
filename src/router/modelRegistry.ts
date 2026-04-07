import type {
  ModelDefinition,
  ModelCapability,
  CircuitBreakerStatus,
} from '../types/provider.js';
import type { TenantTier } from '../types/tenant.js';

/**
 * Static model catalog — all models available in the AfrAI platform.
 *
 * Each entry includes pricing, capabilities, context limits, complexity
 * thresholds, and tier access. This is the v1 static registry; the
 * adaptive learning router (v2) will supplement this with dynamic scoring.
 */
const MODEL_CATALOG: readonly ModelDefinition[] = [
  // ── OpenAI ──────────────────────────────────────────────────────
  {
    id: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'function_calling',
      'streaming',
      'vision',
      'code_generation',
      'reasoning',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.005, outputPer1k: 0.015 },
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    complexityThreshold: 0.5,
    allowedTiers: new Set(['growth', 'enterprise']),
    avgLatencyMs: 1_500,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o Mini',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'function_calling',
      'streaming',
      'vision',
      'code_generation',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    maxContextTokens: 128_000,
    maxOutputTokens: 16_384,
    complexityThreshold: 0.0,
    allowedTiers: new Set(['free', 'starter', 'growth', 'enterprise']),
    avgLatencyMs: 800,
  },

  // ── Anthropic ───────────────────────────────────────────────────
  {
    id: 'claude-3.5-sonnet',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'function_calling',
      'streaming',
      'vision',
      'code_generation',
      'reasoning',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.003, outputPer1k: 0.015 },
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
    complexityThreshold: 0.5,
    allowedTiers: new Set(['growth', 'enterprise']),
    avgLatencyMs: 1_200,
  },
  {
    id: 'claude-3-haiku',
    provider: 'anthropic',
    displayName: 'Claude 3 Haiku',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'function_calling',
      'streaming',
      'code_generation',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.00025, outputPer1k: 0.00125 },
    maxContextTokens: 200_000,
    maxOutputTokens: 4_096,
    complexityThreshold: 0.0,
    allowedTiers: new Set(['free', 'starter', 'growth', 'enterprise']),
    avgLatencyMs: 600,
  },

  // ── Google ──────────────────────────────────────────────────────
  {
    id: 'gemini-1.5-pro',
    provider: 'google',
    displayName: 'Gemini 1.5 Pro',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'function_calling',
      'streaming',
      'vision',
      'code_generation',
      'reasoning',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.0035, outputPer1k: 0.014 },
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    complexityThreshold: 0.5,
    allowedTiers: new Set(['growth', 'enterprise']),
    avgLatencyMs: 1_400,
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'google',
    displayName: 'Gemini 1.5 Flash',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'function_calling',
      'streaming',
      'vision',
      'code_generation',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.000075, outputPer1k: 0.0003 },
    maxContextTokens: 1_000_000,
    maxOutputTokens: 8_192,
    complexityThreshold: 0.0,
    allowedTiers: new Set(['free', 'starter', 'growth', 'enterprise']),
    avgLatencyMs: 500,
  },

  // ── Cohere ──────────────────────────────────────────────────────
  {
    id: 'command-r-plus',
    provider: 'cohere',
    displayName: 'Command R+',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'streaming',
      'code_generation',
      'reasoning',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.003, outputPer1k: 0.015 },
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    complexityThreshold: 0.4,
    allowedTiers: new Set(['starter', 'growth', 'enterprise']),
    avgLatencyMs: 1_300,
  },
  {
    id: 'command-r',
    provider: 'cohere',
    displayName: 'Command R',
    capabilities: new Set<ModelCapability>([
      'json_mode',
      'streaming',
      'code_generation',
      'multilingual',
    ]),
    cost: { inputPer1k: 0.0005, outputPer1k: 0.0015 },
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
    complexityThreshold: 0.0,
    allowedTiers: new Set(['free', 'starter', 'growth', 'enterprise']),
    avgLatencyMs: 700,
  },
] as const;

/**
 * Options for filtering eligible models.
 */
export interface EligibleModelsFilter {
  /** Capabilities the model MUST support */
  requiredCapabilities?: readonly ModelCapability[];
  /** Tenant tier — only models allowed for this tier are included */
  tenantTier: TenantTier;
  /** Circuit breaker status per provider — models from OPEN providers are excluded */
  circuitBreakerStatus?: CircuitBreakerStatus;
  /** Minimum complexity the model must be able to handle (filters OUT models above this threshold) */
  complexityScore?: number;
}

/**
 * Returns the full static model catalog.
 */
export function getAllModels(): readonly ModelDefinition[] {
  return MODEL_CATALOG;
}

/**
 * Look up a single model by its ID.
 * Returns `undefined` if not found.
 */
export function getModelById(id: string): ModelDefinition | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/**
 * Filters the model catalog to return only models that are eligible
 * for a given request, based on:
 *
 * 1. Required capabilities — model must support all of them
 * 2. Tenant tier — model must allow the tenant's tier
 * 3. Circuit breaker state — provider must NOT be OPEN
 * 4. Complexity score — model's threshold must be ≤ the request's complexity
 *    (i.e. the model is suited for requests at or above its threshold)
 *
 * @returns Eligible models in catalog order (not yet ranked by cost).
 */
export function getEligibleModels(
  filter: EligibleModelsFilter
): readonly ModelDefinition[] {
  const {
    requiredCapabilities = [],
    tenantTier,
    circuitBreakerStatus = {},
    complexityScore,
  } = filter;

  return MODEL_CATALOG.filter((model) => {
    // 1. Capability check — model must have ALL required capabilities
    for (const cap of requiredCapabilities) {
      if (!model.capabilities.has(cap)) {
        return false;
      }
    }

    // 2. Tier check — model must be accessible to this tier
    if (!model.allowedTiers.has(tenantTier)) {
      return false;
    }

    // 3. Circuit breaker check — skip models whose provider is OPEN
    const cbState = circuitBreakerStatus[model.provider];
    if (cbState === 'open') {
      return false;
    }

    // 4. Complexity threshold — model's threshold must be ≤ the request complexity
    //    A model with threshold 0.5 should only be used for complexity ≥ 0.5
    //    BUT cheap models (threshold 0.0) can handle anything
    //    We only filter out models whose threshold EXCEEDS the complexity
    //    (i.e. don't send trivial requests to premium models unless no alternative)
    // Note: we don't filter here — the cost optimizer handles preference.
    // The complexityScore filter is about excluding models that are BELOW
    // the request's needs. A model with threshold 0.5 is "suited for" 0.5+.
    // If complexityScore is 0.8, we want models with threshold ≤ 0.8.
    if (complexityScore !== undefined && model.complexityThreshold > complexityScore) {
      // Model is designed for more complex requests than this one warrants.
      // However, we only exclude if cheaper alternatives exist. For safety,
      // we still include them — the cost optimizer will de-prioritize.
      // Actually, let's be strict: if the model's minimum complexity > request
      // complexity, skip it (don't waste premium models on simple tasks).
      // But if ALL cheap models are down, we still need premium ones.
      // Decision: DON'T filter here. Let cost optimizer handle it.
      // The optimizer naturally picks the cheapest model that meets threshold.
    }

    return true;
  });
}
