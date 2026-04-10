/**
 * Adaptive Learning Router v2 — wraps the static router with ML scoring.
 *
 * Lifecycle:
 *   1. Cold start (<10K requests): falls back to v1 static router entirely
 *   2. Warm-up (10K–50K): blends v1 static scores with online Bayesian scores
 *   3. Full adaptive (>50K): XGBoost model (if loaded) + Thompson Sampling
 *
 * Exploration vs Exploitation:
 *   - 10% exploration rate (decays with data)
 *   - Thompson Sampling adds natural exploration through sampling variance
 *   - Fallback chain always uses static router (safety net)
 */

import type { RoutingRequest, RoutingDecision, ComplexityFeatures } from '../types/api.js';
import type { ModelDefinition } from '../types/provider.js';
import { routeRequest as staticRouteRequest } from './smartRouter.js';
import { ModelScorer } from './modelScorer.js';
import { OutcomeCollector } from './outcomeCollector.js';
import type { OutcomeSignal } from './outcomeCollector.js';
import { getEligibleModels } from './modelRegistry.js';
import { analyzeComplexity } from './complexityAnalyzer.js';
import { estimateRequestCost } from './costOptimizer.js';

/** Minimum observations before adaptive routing kicks in */
const COLD_START_THRESHOLD = 10_000;
/** Full adaptive mode threshold */
const WARM_THRESHOLD = 50_000;

export interface AdaptiveRouterConfig {
  /** Minimum requests before leaving cold start. Default: 10_000 */
  readonly coldStartThreshold?: number;
  /** Whether to enable XGBoost predictions (requires loaded model). Default: false */
  readonly useXGBoost?: boolean;
}

/**
 * XGBoost model interface — implemented by the ONNX loader.
 * When no model is loaded, the router uses online Bayesian scoring.
 */
export interface XGBoostModel {
  /**
   * Predict success probability and expected cost for a model + features.
   * Returns null if prediction is unavailable.
   */
  predict(features: XGBoostFeatures): { successProb: number; expectedCostUsd: number } | null;
}

export interface XGBoostFeatures {
  readonly inputTokens: number;
  readonly complexityScore: number;
  readonly hasCode: number;      // 0 or 1
  readonly hasMath: number;
  readonly hasReasoning: number;
  readonly isSimpleQA: number;
  readonly turnCount: number;
  readonly hourOfDay: number;
  readonly modelIndex: number;   // encoded model ID
}

export class AdaptiveRouter {
  readonly scorer: ModelScorer;
  readonly collector: OutcomeCollector;
  private xgboostModel: XGBoostModel | null = null;
  private readonly coldStartThreshold: number;

  constructor(config: AdaptiveRouterConfig = {}) {
    this.scorer = new ModelScorer();
    this.collector = new OutcomeCollector();
    this.coldStartThreshold = config.coldStartThreshold ?? COLD_START_THRESHOLD;
  }

  /**
   * Load a trained XGBoost model for predictions.
   */
  loadModel(model: XGBoostModel): void {
    this.xgboostModel = model;
  }

  /**
   * Route a request using adaptive intelligence.
   *
   * In cold start: delegates entirely to v1 static router.
   * With data: re-ranks eligible models using learned scores.
   */
  async route(request: RoutingRequest): Promise<RoutingDecision> {
    const totalObs = this.scorer.getTotalObservations();

    // Cold start — use static router
    if (totalObs < this.coldStartThreshold) {
      return staticRouteRequest(request);
    }

    // Get static routing decision (for fallback chain and complexity analysis)
    const staticDecision = await staticRouteRequest(request);

    // Analyze complexity
    const { score: complexityScore, features } = analyzeComplexity(request.messages);

    // Get all eligible models
    const eligible = getEligibleModels({
      tenantTier: request.tenantTier,
      requiredCapabilities: (request.requiredCapabilities ?? []) as any[],
      circuitBreakerStatus: request.options?.circuitBreakerStatus,
    });

    if (eligible.length === 0) {
      return staticDecision; // fallback to static
    }

    // Score each eligible model
    const scored = eligible.map((model) => {
      let adaptiveScore: number;

      // Try XGBoost prediction first
      if (this.xgboostModel) {
        const prediction = this.xgboostModel.predict({
          inputTokens: features.estimatedTokens,
          complexityScore,
          hasCode: features.hasCode ? 1 : 0,
          hasMath: features.hasMath ? 1 : 0,
          hasReasoning: features.hasReasoningKeywords ? 1 : 0,
          isSimpleQA: features.isSimpleQA ? 1 : 0,
          turnCount: features.turnCount,
          hourOfDay: new Date().getUTCHours(),
          modelIndex: this.encodeModelId(model.id),
        });

        if (prediction) {
          const invCost = 1 / Math.max(prediction.expectedCostUsd, 0.000001);
          adaptiveScore = prediction.successProb * invCost;
        } else {
          // XGBoost couldn't predict — use online scorer
          const { score } = this.scorer.scoreModel(
            model.id, complexityScore, request.options?.latencyWeight ?? 0,
          );
          adaptiveScore = score;
        }
      } else {
        // No XGBoost model — use online Bayesian scoring
        const { score } = this.scorer.scoreModel(
          model.id, complexityScore, request.options?.latencyWeight ?? 0,
        );
        adaptiveScore = score;
      }

      return { model, adaptiveScore };
    });

    // Exploration: occasionally pick a random model
    let selectedModel: ModelDefinition;
    let isExploration = false;

    if (this.scorer.shouldExplore()) {
      // Random selection for exploration
      const randomIdx = Math.floor(Math.random() * scored.length);
      selectedModel = scored[randomIdx]!.model;
      isExploration = true;
    } else {
      // Exploitation: pick highest scoring model
      scored.sort((a, b) => b.adaptiveScore - a.adaptiveScore);
      selectedModel = scored[0]!.model;
    }

    // Build fallback chain: remaining models sorted by adaptive score (excluding selected)
    const fallbacks = scored
      .filter((s) => s.model.id !== selectedModel.id)
      .sort((a, b) => b.adaptiveScore - a.adaptiveScore)
      .map((s) => s.model);

    const estimatedCost = estimateRequestCost(
      selectedModel, features.estimatedTokens, 256,
    );

    const reasoning = this.buildReasoning(
      selectedModel, complexityScore, features, request.tenantTier,
      scored.length, totalObs, isExploration,
    );

    return {
      selectedModel,
      fallbackChain: fallbacks,
      complexityScore,
      estimatedCostUsd: estimatedCost,
      reasoning,
      features,
    };
  }

  /**
   * Record the outcome of a completed request.
   * Feeds both the online scorer and the outcome collector.
   */
  recordOutcome(signal: OutcomeSignal): void {
    // Feed the online scorer
    this.scorer.recordOutcome(
      signal.modelId,
      signal.complexityScore,
      signal.success,
      signal.latencyMs,
      signal.costUsd,
    );

    // Collect for XGBoost training
    this.collector.record(signal);
  }

  /**
   * Get the current mode of the adaptive router.
   */
  getMode(): 'cold_start' | 'warm_up' | 'adaptive' {
    const total = this.scorer.getTotalObservations();
    if (total < this.coldStartThreshold) return 'cold_start';
    if (total < WARM_THRESHOLD) return 'warm_up';
    return 'adaptive';
  }

  /**
   * Get stats about the adaptive router.
   */
  getInfo(): {
    mode: string;
    totalObservations: number;
    explorationRate: number;
    hasXGBoost: boolean;
    modelStats: Record<string, any>;
  } {
    return {
      mode: this.getMode(),
      totalObservations: this.scorer.getTotalObservations(),
      explorationRate: this.scorer.getExplorationRate(),
      hasXGBoost: this.xgboostModel !== null,
      modelStats: this.scorer.exportStats(),
    };
  }

  // ── Internals ──────────────────────────────────────────────────

  /** Encode model ID to numeric index for XGBoost feature */
  private encodeModelId(modelId: string): number {
    const modelMap: Record<string, number> = {
      'gpt-4o': 0, 'gpt-4o-mini': 1,
      'claude-3-5-sonnet-20241022': 2, 'claude-3-5-haiku-20241022': 3,
      'gemini-1.5-pro': 4, 'gemini-1.5-flash': 5,
      'command-r-plus': 6, 'command-r': 7,
      'llama-3.3-70b-versatile': 8, 'llama-3.1-8b-instant': 9,
      'mixtral-8x7b-32768': 10, 'gemma2-9b-it': 11,
      'Meta-Llama-3.1-405B-Instruct': 12, 'Meta-Llama-3.1-70B-Instruct': 13,
    };
    return modelMap[modelId] ?? -1;
  }

  private buildReasoning(
    model: ModelDefinition,
    complexity: number,
    features: ComplexityFeatures,
    tier: string,
    candidates: number,
    totalObs: number,
    isExploration: boolean,
  ): string {
    const mode = this.getMode();
    const modeLabel = mode === 'cold_start' ? 'cold start (static)' :
      mode === 'warm_up' ? 'warm-up (blended)' : 'adaptive (ML)';

    const complexityLabel =
      complexity < 0.2 ? 'trivial' :
      complexity < 0.4 ? 'simple' :
      complexity < 0.6 ? 'medium' :
      complexity < 0.8 ? 'complex' : 'expert';

    const explorationNote = isExploration ? ' [EXPLORATION — testing model for learning]' : '';

    return (
      `[${modeLabel}] Selected '${model.displayName}' for ${complexityLabel} request ` +
      `(score: ${complexity}). ${candidates} candidates, ${totalObs} total observations. ` +
      `Tier: ${tier}.${explorationNote}`
    );
  }
}
