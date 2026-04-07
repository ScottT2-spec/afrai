import { RoutingRequestSchema } from '../types/api.js';
import type { RoutingRequest, RoutingDecision } from '../types/api.js';
import type { CircuitBreakerStatus, ModelCapability } from '../types/provider.js';
import { getEligibleModels, getModelById } from './modelRegistry.js';
import { analyzeComplexity } from './complexityAnalyzer.js';
import { rankModels, selectWithFallbacks } from './costOptimizer.js';

/**
 * Error thrown when no eligible models can be found for a routing request.
 */
export class NoEligibleModelsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoEligibleModelsError';
  }
}

/**
 * Smart Router v1 — Static rules-based routing engine.
 *
 * Orchestrates the full routing pipeline:
 * 1. Validate the incoming request (Zod)
 * 2. Extract features & score complexity (complexityAnalyzer)
 * 3. Filter eligible models (modelRegistry)
 * 4. Rank by cost × latency (costOptimizer)
 * 5. Select primary model + build fallback chain
 * 6. Return the routing decision with reasoning
 *
 * This is a pure function with no side effects — no database, no Redis,
 * no external state. Circuit breaker status is accepted as input.
 *
 * @param request - The routing request (validated with Zod)
 * @returns The routing decision with selected model, fallbacks, and reasoning
 * @throws {NoEligibleModelsError} When no models match the request constraints
 */
export async function routeRequest(
  request: RoutingRequest
): Promise<RoutingDecision> {
  // 1. Validate input with Zod
  const validated = RoutingRequestSchema.parse(request);

  const { messages, requiredCapabilities, tenantTier, options } = validated;
  const {
    latencyWeight = 0,
    forceModel,
    maxCostUsd,
    circuitBreakerStatus = {},
  } = options;

  // 2. Handle forced model override
  if (forceModel) {
    const model = getModelById(forceModel);
    if (!model) {
      throw new NoEligibleModelsError(
        `Forced model '${forceModel}' not found in registry`
      );
    }

    const { score, features } = analyzeComplexity(messages);

    return {
      selectedModel: model,
      fallbackChain: [],
      complexityScore: score,
      estimatedCostUsd: 0, // Not computed for forced models
      reasoning: `Model '${model.displayName}' was explicitly requested (forced).`,
      features,
    };
  }

  // 3. Analyze complexity
  const { score: complexityScore, features } = analyzeComplexity(messages);

  // 4. Filter eligible models
  const eligible = getEligibleModels({
    requiredCapabilities: requiredCapabilities as ModelCapability[],
    tenantTier,
    circuitBreakerStatus: circuitBreakerStatus as CircuitBreakerStatus,
    complexityScore,
  });

  if (eligible.length === 0) {
    throw new NoEligibleModelsError(
      `No eligible models for tier '${tenantTier}' with capabilities [${requiredCapabilities.join(', ')}]. ` +
        `Complexity: ${complexityScore}. Check circuit breaker states and tier access.`
    );
  }

  // 5. Rank models by cost-effectiveness
  const ranked = rankModels(eligible, complexityScore, {
    latencyWeight,
    maxCostUsd,
    estimatedInputTokens: features.estimatedTokens,
    estimatedOutputTokens: 256, // Default estimate
  });

  if (ranked.length === 0) {
    throw new NoEligibleModelsError(
      `All eligible models exceed the maximum cost of $${maxCostUsd}. ` +
        `Try increasing maxCostUsd or lowering required capabilities.`
    );
  }

  // 6. Select primary + fallback chain
  const selection = selectWithFallbacks(ranked);
  if (!selection) {
    throw new NoEligibleModelsError('No models available after ranking.');
  }

  const { primary, fallbacks } = selection;

  // 7. Build reasoning string
  const reasoning = buildReasoning(
    primary.model.displayName,
    complexityScore,
    features,
    tenantTier,
    ranked.length
  );

  return {
    selectedModel: primary.model,
    fallbackChain: fallbacks.map((f) => f.model),
    complexityScore,
    estimatedCostUsd: primary.estimatedCost,
    reasoning,
    features,
  };
}

/**
 * Builds a human-readable reasoning string for the routing decision.
 */
function buildReasoning(
  modelName: string,
  complexity: number,
  features: RoutingDecision['features'],
  tier: string,
  candidateCount: number
): string {
  const complexityLabel =
    complexity < 0.2
      ? 'trivial'
      : complexity < 0.4
        ? 'simple'
        : complexity < 0.6
          ? 'medium'
          : complexity < 0.8
            ? 'complex'
            : 'expert';

  const featureList: string[] = [];
  if (features.hasCode) featureList.push('code');
  if (features.hasMath) featureList.push('math');
  if (features.hasReasoningKeywords) featureList.push('reasoning');
  if (features.isSimpleQA) featureList.push('simple-Q&A');
  if (features.turnCount > 3) featureList.push(`${features.turnCount}-turn conversation`);

  const featureStr =
    featureList.length > 0
      ? ` Features detected: ${featureList.join(', ')}.`
      : '';

  return (
    `Selected '${modelName}' for ${complexityLabel} request (score: ${complexity}).${featureStr} ` +
    `Tier: ${tier}. Evaluated ${candidateCount} candidate model(s).`
  );
}
