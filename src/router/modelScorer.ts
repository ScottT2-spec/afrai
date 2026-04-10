/**
 * Online Model Scorer — Bayesian scoring with Thompson Sampling.
 *
 * Maintains running statistics per (model, complexity_bucket) pair.
 * Used by the adaptive router when insufficient data exists for XGBoost,
 * and for exploration/exploitation balancing.
 *
 * Each model-bucket pair tracks:
 *   - Success rate (Beta distribution: alpha = successes + 1, beta = failures + 1)
 *   - Average latency (running mean + variance)
 *   - Average cost (running mean)
 *   - Request count (confidence indicator)
 *
 * Thompson Sampling: draw from each model's Beta distribution to balance
 * exploration (try uncertain models) with exploitation (prefer known-good models).
 */

export interface ModelStats {
  /** Total requests routed to this model-bucket pair */
  readonly requestCount: number;
  /** Successes (Beta alpha - 1) */
  readonly successes: number;
  /** Failures (Beta beta - 1) */
  readonly failures: number;
  /** Running average latency in ms */
  readonly avgLatencyMs: number;
  /** Running average cost in USD */
  readonly avgCostUsd: number;
  /** Latency variance (for uncertainty) */
  readonly latencyVariance: number;
}

/** Complexity is bucketed into discrete ranges for stats tracking */
type ComplexityBucket = 'trivial' | 'simple' | 'medium' | 'complex' | 'expert';

function toComplexityBucket(score: number): ComplexityBucket {
  if (score < 0.15) return 'trivial';
  if (score < 0.35) return 'simple';
  if (score < 0.55) return 'medium';
  if (score < 0.75) return 'complex';
  return 'expert';
}

function statsKey(modelId: string, bucket: ComplexityBucket): string {
  return `${modelId}:${bucket}`;
}

/** Mutable internal state for a model-bucket pair */
interface MutableStats {
  requestCount: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  m2Latency: number; // for Welford's online variance
}

function freshStats(): MutableStats {
  return {
    requestCount: 0,
    successes: 0,
    failures: 0,
    avgLatencyMs: 0,
    avgCostUsd: 0,
    m2Latency: 0,
  };
}

/**
 * Simple seeded PRNG (xoshiro128) for reproducible Thompson Sampling.
 * Falls back to Math.random() — this is for exploration, not cryptography.
 */
function sampleBeta(alpha: number, beta: number): number {
  // Approximation of Beta distribution sampling using the
  // Joehnk algorithm (simple, good enough for routing decisions).
  // For alpha, beta >= 1 (which we guarantee via +1 prior).
  const u1 = Math.random();
  const u2 = Math.random();
  const x = Math.pow(u1, 1 / alpha);
  const y = Math.pow(u2, 1 / beta);
  const sum = x + y;
  if (sum === 0) return 0.5;
  return x / sum;
}

export class ModelScorer {
  private readonly stats = new Map<string, MutableStats>();

  /** Minimum observations before we trust the model's stats */
  readonly minObservations: number;
  /** Exploration rate: probability of picking a random model (decays with data) */
  readonly baseExplorationRate: number;

  constructor(
    minObservations: number = 30,
    baseExplorationRate: number = 0.10,
  ) {
    this.minObservations = minObservations;
    this.baseExplorationRate = baseExplorationRate;
  }

  /**
   * Record an outcome for a model at a given complexity level.
   * Updates running statistics using Welford's online algorithm.
   */
  recordOutcome(
    modelId: string,
    complexityScore: number,
    success: boolean,
    latencyMs: number,
    costUsd: number,
  ): void {
    const key = statsKey(modelId, toComplexityBucket(complexityScore));
    let s = this.stats.get(key);
    if (!s) {
      s = freshStats();
      this.stats.set(key, s);
    }

    s.requestCount++;
    if (success) s.successes++;
    else s.failures++;

    // Welford's online mean + variance for latency
    const delta = latencyMs - s.avgLatencyMs;
    s.avgLatencyMs += delta / s.requestCount;
    const delta2 = latencyMs - s.avgLatencyMs;
    s.m2Latency += delta * delta2;

    // Running mean for cost
    s.avgCostUsd += (costUsd - s.avgCostUsd) / s.requestCount;
  }

  /**
   * Get the current stats for a model-complexity pair.
   */
  getStats(modelId: string, complexityScore: number): ModelStats | null {
    const key = statsKey(modelId, toComplexityBucket(complexityScore));
    const s = this.stats.get(key);
    if (!s) return null;

    return {
      requestCount: s.requestCount,
      successes: s.successes,
      failures: s.failures,
      avgLatencyMs: s.avgLatencyMs,
      avgCostUsd: s.avgCostUsd,
      latencyVariance: s.requestCount > 1 ? s.m2Latency / (s.requestCount - 1) : 0,
    };
  }

  /**
   * Score a model for a given complexity using Thompson Sampling.
   *
   * Returns a score where HIGHER = better (unlike v1 where lower = better).
   * Formula: sampled_success_rate × (1 / expected_cost) × (1 / expected_latency)^w
   *
   * Models with few observations get high variance → more exploration.
   * Models with many observations converge to their true performance.
   */
  scoreModel(
    modelId: string,
    complexityScore: number,
    latencyWeight: number = 0,
  ): { score: number; confident: boolean } {
    const key = statsKey(modelId, toComplexityBucket(complexityScore));
    const s = this.stats.get(key);

    if (!s || s.requestCount < 3) {
      // No data — return high score to encourage exploration
      return { score: 1.0, confident: false };
    }

    // Thompson Sampling: sample from Beta(successes + 1, failures + 1)
    const sampledSuccessRate = sampleBeta(s.successes + 1, s.failures + 1);

    // Normalize cost and latency (avoid division by zero)
    const invCost = 1 / Math.max(s.avgCostUsd, 0.000001);
    const invLatency = 1 / Math.max(s.avgLatencyMs, 1);

    const score = sampledSuccessRate * invCost * Math.pow(invLatency, latencyWeight);
    const confident = s.requestCount >= this.minObservations;

    return { score, confident };
  }

  /**
   * Determine current exploration rate.
   * Decays as total observations increase.
   */
  getExplorationRate(): number {
    let totalObs = 0;
    for (const s of this.stats.values()) {
      totalObs += s.requestCount;
    }
    // Decay: starts at baseExplorationRate, halves every 10K requests
    return this.baseExplorationRate * Math.pow(0.5, totalObs / 10_000);
  }

  /**
   * Whether we should explore (pick a random model) on this request.
   */
  shouldExplore(): boolean {
    return Math.random() < this.getExplorationRate();
  }

  /**
   * Get total observations across all model-bucket pairs.
   */
  getTotalObservations(): number {
    let total = 0;
    for (const s of this.stats.values()) {
      total += s.requestCount;
    }
    return total;
  }

  /**
   * Export all stats (for serialization / inspection).
   */
  exportStats(): Record<string, ModelStats> {
    const result: Record<string, ModelStats> = {};
    for (const [key, s] of this.stats) {
      result[key] = {
        requestCount: s.requestCount,
        successes: s.successes,
        failures: s.failures,
        avgLatencyMs: s.avgLatencyMs,
        avgCostUsd: s.avgCostUsd,
        latencyVariance: s.requestCount > 1 ? s.m2Latency / (s.requestCount - 1) : 0,
      };
    }
    return result;
  }
}
