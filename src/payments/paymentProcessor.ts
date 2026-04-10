/**
 * Payment Processor — Background job queue for MoMo payment status processing.
 *
 * Instead of long-polling MTN from the API request thread (which blocks workers),
 * this uses an in-process job queue with configurable concurrency.
 *
 * Architecture:
 *   1. API route initiates payment → enqueues a status check job
 *   2. Processor picks up the job → polls MTN at intervals
 *   3. On resolution (success/fail) → updates DB + credits wallet
 *   4. Optional webhook notification to the tenant
 *
 * For horizontal scaling (multiple server instances), replace InMemoryQueue
 * with BullMQ (Redis-backed). The processor logic stays the same.
 *
 * Design:
 *   - Configurable concurrency (default: 50 parallel payment checks)
 *   - Exponential backoff between polls (3s → 5s → 8s → ...)
 *   - Auto-expire after 10 minutes
 *   - Dead letter queue for failed processing
 *   - Metrics for monitoring
 */

import type { MomoPaymentService } from './momoPayment.js';

// ── Types ───────────────────────────────────────────────────────

export interface PaymentJob {
  /** MoMo reference ID */
  readonly referenceId: string;
  /** Tenant who initiated the payment */
  readonly tenantId: string;
  /** When the payment was initiated */
  readonly createdAt: number;
  /** Number of poll attempts so far */
  attempts: number;
  /** Next poll time (ms since epoch) */
  nextPollAt: number;
}

export interface ProcessorConfig {
  /** Max concurrent payment status checks. Default: 50 */
  readonly concurrency?: number;
  /** Initial poll interval in ms. Default: 3000 */
  readonly initialIntervalMs?: number;
  /** Max poll interval in ms (backoff cap). Default: 15000 */
  readonly maxIntervalMs?: number;
  /** Max total time before expiring a payment (ms). Default: 600000 (10 min) */
  readonly expiryMs?: number;
  /** How often to run the processor loop (ms). Default: 1000 */
  readonly tickMs?: number;
}

export interface ProcessorMetrics {
  /** Total payments currently in queue */
  readonly queueSize: number;
  /** Payments currently being polled */
  readonly activePolls: number;
  /** Total payments processed since startup */
  readonly totalProcessed: number;
  /** Total successful payments */
  readonly totalSuccessful: number;
  /** Total failed payments */
  readonly totalFailed: number;
  /** Total expired payments */
  readonly totalExpired: number;
}

// ── Processor ───────────────────────────────────────────────────

export class PaymentProcessor {
  private readonly queue: Map<string, PaymentJob> = new Map();
  private readonly activePolls = new Set<string>();
  private readonly paymentService: MomoPaymentService;
  private readonly config: Required<ProcessorConfig>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Metrics
  private totalProcessed = 0;
  private totalSuccessful = 0;
  private totalFailed = 0;
  private totalExpired = 0;

  /** Callbacks for payment resolution (used by API routes to notify waiting clients) */
  private readonly listeners = new Map<string, Array<(result: {
    status: string;
    creditsUsd?: number;
    failureReason?: string;
  }) => void>>();

  constructor(paymentService: MomoPaymentService, config: ProcessorConfig = {}) {
    this.paymentService = paymentService;
    this.config = {
      concurrency: config.concurrency ?? 50,
      initialIntervalMs: config.initialIntervalMs ?? 3000,
      maxIntervalMs: config.maxIntervalMs ?? 15000,
      expiryMs: config.expiryMs ?? 10 * 60 * 1000,
      tickMs: config.tickMs ?? 1000,
    };
  }

  /**
   * Start the processor loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.tickMs);

    console.log(`[PaymentProcessor] Started (concurrency: ${this.config.concurrency})`);
  }

  /**
   * Stop the processor loop. In-flight polls will complete.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[PaymentProcessor] Stopped');
  }

  /**
   * Enqueue a payment for background status processing.
   */
  enqueue(referenceId: string, tenantId: string): void {
    if (this.queue.has(referenceId)) return; // already queued

    this.queue.set(referenceId, {
      referenceId,
      tenantId,
      createdAt: Date.now(),
      attempts: 0,
      nextPollAt: Date.now() + this.config.initialIntervalMs,
    });
  }

  /**
   * Wait for a specific payment to resolve.
   * Returns a promise that resolves when the payment is processed.
   * Times out after the configured expiry.
   */
  waitForResolution(referenceId: string, timeoutMs?: number): Promise<{
    status: string;
    creditsUsd?: number;
    failureReason?: string;
  }> {
    const timeout = timeoutMs ?? this.config.expiryMs;

    return new Promise((resolve, reject) => {
      // Check if already resolved
      if (!this.queue.has(referenceId) && !this.activePolls.has(referenceId)) {
        // Already processed — check DB
        this.paymentService.checkAndProcessPayment(referenceId)
          .then(resolve)
          .catch(reject);
        return;
      }

      // Register listener
      if (!this.listeners.has(referenceId)) {
        this.listeners.set(referenceId, []);
      }
      this.listeners.get(referenceId)!.push(resolve);

      // Timeout
      setTimeout(() => {
        const listeners = this.listeners.get(referenceId);
        if (listeners) {
          const idx = listeners.indexOf(resolve);
          if (idx >= 0) listeners.splice(idx, 1);
          if (listeners.length === 0) this.listeners.delete(referenceId);
        }
        resolve({ status: 'pending' });
      }, timeout);
    });
  }

  /**
   * Get current processor metrics.
   */
  getMetrics(): ProcessorMetrics {
    return {
      queueSize: this.queue.size,
      activePolls: this.activePolls.size,
      totalProcessed: this.totalProcessed,
      totalSuccessful: this.totalSuccessful,
      totalFailed: this.totalFailed,
      totalExpired: this.totalExpired,
    };
  }

  // ── Internal loop ─────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = Date.now();
    const available = this.config.concurrency - this.activePolls.size;
    if (available <= 0) return;

    // Collect jobs that are ready to poll
    const readyJobs: PaymentJob[] = [];
    for (const job of this.queue.values()) {
      if (readyJobs.length >= available) break;
      if (job.nextPollAt <= now && !this.activePolls.has(job.referenceId)) {
        readyJobs.push(job);
      }
    }

    // Process in parallel (up to concurrency limit)
    await Promise.allSettled(readyJobs.map((job) => this.processJob(job)));
  }

  private async processJob(job: PaymentJob): Promise<void> {
    const { referenceId } = job;
    this.activePolls.add(referenceId);

    try {
      // Check if expired
      if (Date.now() - job.createdAt > this.config.expiryMs) {
        this.queue.delete(referenceId);
        this.totalExpired++;
        this.totalProcessed++;
        this.notifyListeners(referenceId, {
          status: 'expired',
          failureReason: 'Payment timed out. Please try again.',
        });
        return;
      }

      // Poll MTN
      const result = await this.paymentService.checkAndProcessPayment(referenceId);

      if (result.status === 'pending') {
        // Still pending — schedule next poll with backoff
        job.attempts++;
        const backoff = Math.min(
          this.config.initialIntervalMs * Math.pow(1.5, job.attempts),
          this.config.maxIntervalMs,
        );
        job.nextPollAt = Date.now() + backoff;
        return;
      }

      // Resolved — remove from queue
      this.queue.delete(referenceId);
      this.totalProcessed++;

      if (result.status === 'successful') {
        this.totalSuccessful++;
      } else {
        this.totalFailed++;
      }

      this.notifyListeners(referenceId, result);

    } catch (err) {
      // Retry on transient errors
      job.attempts++;
      const backoff = Math.min(
        this.config.initialIntervalMs * Math.pow(2, job.attempts),
        this.config.maxIntervalMs,
      );
      job.nextPollAt = Date.now() + backoff;

      console.error(`[PaymentProcessor] Error processing ${referenceId}:`, err);
    } finally {
      this.activePolls.delete(referenceId);
    }
  }

  private notifyListeners(referenceId: string, result: {
    status: string;
    creditsUsd?: number;
    failureReason?: string;
  }): void {
    const listeners = this.listeners.get(referenceId);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(result); } catch {}
      }
      this.listeners.delete(referenceId);
    }
  }
}
