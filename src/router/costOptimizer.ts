import type { ModelDefinition, RankedModel } from '../types/provider.js';

/**
 * Options for the cost optimizer ranking algorithm.
 */
export interface CostOptimizerOptions {
  /** Weight given to latency in the ranking formula (0.0–1.0). Default: 0.0 */
  readonly latencyWeight?: number;
  /** Maximum acceptable cost in USD. Models exceeding this are excluded. */
  readonly maxCostUsd?: number;
  /** Estimated input tokens for cost estimation */
  readonly estimatedInputTokens?: number;
  /** Estimated output tokens for cost estimation (defaults to 256) */
  readonly estimatedOutputTokens?: number;
}

/**
 * Estimates the cost of a single request for a given model.
 *
 * @param model - The model definition with pricing info
 * @param inputTokens - Estimated input token count
 * @param outputTokens - Estimated output token count
 * @returns Estimated cost in USD
 */
export function estimateRequestCost(
  model: ModelDefinition,
  inputTokens: number,
  outputTokens: number
): number {
  const inputCost = (inputTokens / 1000) * model.cost.inputPer1k;
  const outputCost = (outputTokens / 1000) * model.cost.outputPer1k;
  return inputCost + outputCost;
}

/**
 * Ranks eligible models by cost-effectiveness for a given request.
 *
 * Algorithm (from architecture spec):
 * 1. For each model, estimate cost
 * 2. Compute ranking score: cost × (1 + latency_weight × normalized_latency)
 * 3. Prefer cheapest model that meets the complexity threshold
 * 4. Return ranked list: primary model + fallback chain
 *
 * Models whose complexity threshold exceeds the request's complexity score
 * are de-prioritized (pushed to the end) rather than excluded, so they
 * remain available as fallbacks.
 *
 * @param eligibleModels - Models that passed capability/tier/circuit-breaker filtering
 * @param complexityScore - The request's complexity score (0.0–1.0)
 * @param options - Cost optimization options
 * @returns Ranked models, best first. Empty array if no models eligible.
 */
export function rankModels(
  eligibleModels: readonly ModelDefinition[],
  complexityScore: number,
  options: CostOptimizerOptions = {}
): readonly RankedModel[] {
  const {
    latencyWeight = 0,
    maxCostUsd,
    estimatedInputTokens = 500,
    estimatedOutputTokens = 256,
  } = options;

  if (eligibleModels.length === 0) {
    return [];
  }

  // Find max latency for normalization (avoid division by zero)
  const maxLatency = Math.max(...eligibleModels.map((m) => m.avgLatencyMs), 1);

  const scored: RankedModel[] = eligibleModels
    .map((model) => {
      const estimatedCost = estimateRequestCost(
        model,
        estimatedInputTokens,
        estimatedOutputTokens
      );

      // Normalized latency: 0.0 (fastest) → 1.0 (slowest)
      const normalizedLatency = model.avgLatencyMs / maxLatency;

      // Core ranking formula from architecture:
      // score = cost × (1 + latency_weight × normalized_latency)
      // Lower score = better (cheaper and/or faster)
      let score = estimatedCost * (1 + latencyWeight * normalizedLatency);

      // ── Complexity-aware scoring ──────────────────────────────
      //
      // The goal: cheap models win for simple stuff, big models win
      // for complex stuff, and there's a smooth crossover in between.

      if (model.complexityThreshold > complexityScore) {
        // Model is overqualified — penalty so it stays as fallback
        score *= 3;
      } else if (complexityScore >= 0.3) {
        // Request is non-trivial. Boost models that are DESIGNED
        // for this complexity range (their threshold is close to
        // the request's score). This makes 70B models competitive
        // with 8B models on medium+ requests.
        //
        // A model with threshold 0.3 handling a 0.5 request gets a
        // moderate boost. A model with threshold 0.0 gets no boost
        // (it CAN handle it, but isn't specialized for it).
        const fit = model.complexityThreshold / Math.max(complexityScore, 0.01);
        // fit ranges from 0 (generic cheap model) to ~1 (perfect match)
        // Discount up to 70% for well-matched models
        const discount = 1 - (fit * 0.7);
        score *= discount;
      }

      return { model, score, estimatedCost };
    })
    // Filter by max cost if specified
    .filter((ranked) => {
      if (maxCostUsd !== undefined && ranked.estimatedCost > maxCostUsd) {
        return false;
      }
      return true;
    });

  // Sort by score ascending (lowest = best)
  scored.sort((a, b) => a.score - b.score);

  return scored;
}

/**
 * Selects the primary model and builds a fallback chain from ranked models.
 *
 * @param rankedModels - Models ranked by the cost optimizer
 * @returns Object with the primary model and remaining models as fallbacks.
 *          Returns `null` if no models are available.
 */
export function selectWithFallbacks(
  rankedModels: readonly RankedModel[]
): { primary: RankedModel; fallbacks: readonly RankedModel[] } | null {
  if (rankedModels.length === 0) {
    return null;
  }

  const [primary, ...fallbacks] = rankedModels;
  return { primary: primary!, fallbacks };
}
