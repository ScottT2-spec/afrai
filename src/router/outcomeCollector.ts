/**
 * Outcome Collector — captures training signals from completed requests.
 *
 * Every request generates a feedback signal that feeds into the
 * adaptive learning router. This is the data pipeline:
 *
 *   Request features + outcome → stored in memory buffer → flushed to DB
 *
 * The training script reads from the DB to train the XGBoost model.
 */

export interface OutcomeSignal {
  // ── Request features (inputs) ─────────────────────
  /** Estimated input token count */
  readonly inputTokens: number;
  /** Complexity score from the analyzer (0.0–1.0) */
  readonly complexityScore: number;
  /** Whether the request contained code */
  readonly hasCode: boolean;
  /** Whether the request contained math */
  readonly hasMath: boolean;
  /** Whether reasoning keywords were detected */
  readonly hasReasoning: boolean;
  /** Whether it matched simple Q&A patterns */
  readonly isSimpleQA: boolean;
  /** Number of conversation turns */
  readonly turnCount: number;
  /** Detected language (ISO 639-1) */
  readonly language: string;
  /** Tenant tier */
  readonly tenantTier: string;
  /** Hour of day (0–23 UTC) — captures time-of-day patterns */
  readonly hourOfDay: number;

  // ── Decision (what the router chose) ──────────────
  /** Model ID that was selected */
  readonly modelId: string;
  /** Provider ID */
  readonly providerId: string;
  /** Whether this was the primary choice or a fallback */
  readonly wasFallback: boolean;

  // ── Outcome (what happened) ───────────────────────
  /** Whether the request succeeded */
  readonly success: boolean;
  /** Actual latency in ms */
  readonly latencyMs: number;
  /** Actual cost in USD */
  readonly costUsd: number;
  /** Output token count */
  readonly outputTokens: number;
  /** Finish reason */
  readonly finishReason: string;
  /** Timestamp */
  readonly timestamp: number;
}

/**
 * Collects outcome signals in an in-memory ring buffer.
 *
 * - Fast writes (no I/O on the hot path)
 * - Ring buffer prevents unbounded memory growth
 * - Periodic flush to persistent storage for training
 */
export class OutcomeCollector {
  private readonly buffer: OutcomeSignal[] = [];
  private readonly maxBufferSize: number;

  constructor(maxBufferSize: number = 100_000) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Record an outcome signal. O(1), no I/O.
   */
  record(signal: OutcomeSignal): void {
    if (this.buffer.length >= this.maxBufferSize) {
      // Ring buffer: drop oldest
      this.buffer.shift();
    }
    this.buffer.push(signal);
  }

  /**
   * Get all collected signals (for training / export).
   */
  getAll(): readonly OutcomeSignal[] {
    return this.buffer;
  }

  /**
   * Get signals within a time window (e.g. last 7 days).
   */
  getWindow(windowMs: number): readonly OutcomeSignal[] {
    const cutoff = Date.now() - windowMs;
    return this.buffer.filter((s) => s.timestamp >= cutoff);
  }

  /**
   * Get the total number of collected signals.
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Drain the buffer (returns all signals and clears).
   * Used when flushing to persistent storage.
   */
  drain(): OutcomeSignal[] {
    return this.buffer.splice(0);
  }

  /**
   * Export signals as CSV for XGBoost training.
   */
  toCSV(): string {
    const headers = [
      'input_tokens', 'complexity_score', 'has_code', 'has_math',
      'has_reasoning', 'is_simple_qa', 'turn_count', 'language',
      'tenant_tier', 'hour_of_day', 'model_id', 'provider_id',
      'was_fallback', 'success', 'latency_ms', 'cost_usd',
      'output_tokens', 'finish_reason', 'timestamp',
    ].join(',');

    const rows = this.buffer.map((s) => [
      s.inputTokens, s.complexityScore, s.hasCode ? 1 : 0, s.hasMath ? 1 : 0,
      s.hasReasoning ? 1 : 0, s.isSimpleQA ? 1 : 0, s.turnCount, s.language,
      s.tenantTier, s.hourOfDay, s.modelId, s.providerId,
      s.wasFallback ? 1 : 0, s.success ? 1 : 0, s.latencyMs, s.costUsd,
      s.outputTokens, s.finishReason, s.timestamp,
    ].join(','));

    return [headers, ...rows].join('\n');
  }
}
