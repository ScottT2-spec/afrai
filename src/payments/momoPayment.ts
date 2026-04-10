/**
 * MoMo Payment Service — Business logic for MoMo-powered API credit purchases.
 *
 * The world's first AI API platform that accepts Mobile Money.
 * No credit card? No problem. MoMo is all you need.
 *
 * Architecture:
 *   1. Tenant requests a top-up (amount + phone number)
 *   2. We validate, create a payment record, and call MTN Collections API
 *   3. Customer confirms on their phone (USSD prompt)
 *   4. We poll status (or receive callback) and credit their wallet
 *   5. Wallet balance is deducted per API call in the billing engine
 *
 * Pricing tiers convert GHS → USD API credits with a small spread.
 * The spread covers MoMo fees (~1%) and provides margin.
 */

import { randomUUID } from 'node:crypto';
import { MomoClient, normalizeGhanaPhone, isMtnGhanaNumber } from './momoClient.js';
import type {
  MomoConfig,
  TopUpRequest,
  PaymentRecord,
  WalletBalance,
  CreditTier,
  RequestToPayResult,
  MomoPaymentStatus,
} from './momoTypes.js';
import { MomoApiError } from './momoTypes.js';

// ── Credit Tiers ────────────────────────────────────────────────

/**
 * GHS → USD credit conversion tiers.
 *
 * Exchange rate: ~15.5 GHS = 1 USD (as of 2026, adjusted periodically).
 * We apply a ~5% spread to cover MoMo fees + margin.
 *
 * Higher tiers get better rates (volume discount).
 */
const GHS_TO_USD_RATE = 15.5;
const BASE_SPREAD = 0.05; // 5% spread on small amounts

export const CREDIT_TIERS: readonly CreditTier[] = [
  { amountLocal: 5,    creditsUsd: 0.30,  label: 'Starter — 5 GHS' },
  { amountLocal: 10,   creditsUsd: 0.62,  label: 'Basic — 10 GHS' },
  { amountLocal: 20,   creditsUsd: 1.26,  label: 'Builder — 20 GHS' },
  { amountLocal: 50,   creditsUsd: 3.20,  label: 'Pro — 50 GHS' },
  { amountLocal: 100,  creditsUsd: 6.50,  label: 'Scale — 100 GHS' },
  { amountLocal: 200,  creditsUsd: 13.20, label: 'Growth — 200 GHS' },
  { amountLocal: 500,  creditsUsd: 33.50, label: 'Enterprise — 500 GHS' },
];

/** Minimum top-up amount in GHS */
const MIN_TOPUP_GHS = 5;

/** Maximum top-up amount in GHS (MoMo daily limit consideration) */
const MAX_TOPUP_GHS = 5000;

/** How long before a pending payment expires (minutes) */
const PAYMENT_EXPIRY_MINUTES = 10;

/** Maximum poll attempts for payment status */
const MAX_POLL_ATTEMPTS = 20;

/** Delay between status polls (ms) */
const POLL_INTERVAL_MS = 3000;

// ── Conversion ──────────────────────────────────────────────────

/**
 * Convert GHS amount to USD credits.
 * Uses tiered pricing — finds the best matching tier or interpolates.
 */
export function ghsToCredits(amountGhs: number): number {
  // Check if it exactly matches a tier
  const exactTier = CREDIT_TIERS.find((t) => t.amountLocal === amountGhs);
  if (exactTier) return exactTier.creditsUsd;

  // Interpolate: apply spread that decreases with amount
  const spreadMultiplier = Math.max(0.02, BASE_SPREAD - (amountGhs / 50000));
  const rawUsd = amountGhs / GHS_TO_USD_RATE;
  return Math.round((rawUsd * (1 - spreadMultiplier)) * 100) / 100;
}

/**
 * Estimate how many API calls a credit amount buys.
 * Based on average cost per call across different models.
 */
export function estimateApiCalls(creditsUsd: number): {
  cheapModel: number;    // e.g., Llama 3.1 8B via Groq
  midModel: number;      // e.g., GPT-4o-mini
  premiumModel: number;  // e.g., Claude 3.5 Sonnet
} {
  return {
    cheapModel: Math.floor(creditsUsd / 0.0002),    // ~$0.0002 per call
    midModel: Math.floor(creditsUsd / 0.002),        // ~$0.002 per call
    premiumModel: Math.floor(creditsUsd / 0.015),    // ~$0.015 per call
  };
}

// ── Payment Service ─────────────────────────────────────────────

/** Database interface for payment persistence */
export interface PaymentStore {
  /** Create a new payment record */
  createPayment(record: Omit<PaymentRecord, 'createdAt' | 'updatedAt'>): Promise<void>;
  /** Update payment status */
  updatePaymentStatus(
    momoReferenceId: string,
    status: PaymentRecord['status'],
    momoTransactionId?: string,
    failureReason?: string,
  ): Promise<void>;
  /** Get a payment by reference ID */
  getPaymentByReference(momoReferenceId: string): Promise<PaymentRecord | null>;
  /** Get payment history for a tenant */
  getPaymentHistory(tenantId: string, limit?: number): Promise<PaymentRecord[]>;
  /** Get pending payments older than the given minutes (for expiry) */
  getPendingPayments(olderThanMinutes: number): Promise<PaymentRecord[]>;
}

/** Wallet interface for credit management */
export interface WalletStore {
  /** Get wallet balance for a tenant */
  getBalance(tenantId: string): Promise<WalletBalance | null>;
  /** Credit (add) funds to a tenant's wallet */
  creditWallet(tenantId: string, amountUsd: number, paymentId: string): Promise<void>;
  /** Debit (subtract) funds from a tenant's wallet */
  debitWallet(tenantId: string, amountUsd: number, requestId: string): Promise<boolean>;
  /** Create a wallet for a new tenant */
  createWallet(tenantId: string): Promise<void>;
}

export class MomoPaymentService {
  readonly client: MomoClient;
  private readonly paymentStore: PaymentStore;
  private readonly walletStore: WalletStore;
  private readonly currency: string;

  constructor(
    config: MomoConfig,
    paymentStore: PaymentStore,
    walletStore: WalletStore,
  ) {
    this.client = new MomoClient(config);
    this.paymentStore = paymentStore;
    this.walletStore = walletStore;
    this.currency = config.currency;
  }

  /**
   * Get available credit tiers with estimated API calls.
   */
  getCreditTiers(): Array<CreditTier & { estimatedCalls: ReturnType<typeof estimateApiCalls> }> {
    return CREDIT_TIERS.map((tier) => ({
      ...tier,
      estimatedCalls: estimateApiCalls(tier.creditsUsd),
    }));
  }

  /**
   * Initiate a wallet top-up via MoMo.
   *
   * @param request Top-up parameters
   * @returns Payment tracking info
   * @throws Error on validation failure or MoMo API error
   */
  async initiateTopUp(request: TopUpRequest): Promise<{
    paymentId: string;
    momoReferenceId: string;
    amountLocal: number;
    creditsUsd: number;
    currency: string;
    message: string;
  }> {
    const { amount, phoneNumber, tenantId } = request;

    // ── Validation ────────────────────────────────────────────

    if (amount < MIN_TOPUP_GHS) {
      throw new Error(`Minimum top-up is ${MIN_TOPUP_GHS} GHS`);
    }

    if (amount > MAX_TOPUP_GHS) {
      throw new Error(`Maximum top-up is ${MAX_TOPUP_GHS} GHS`);
    }

    // Normalize and validate phone number
    const normalizedPhone = normalizeGhanaPhone(phoneNumber);

    if (!isMtnGhanaNumber(phoneNumber)) {
      throw new Error(
        'Only MTN MoMo numbers are supported. ' +
        'The number must start with 024, 025, 053, 054, 055, or 059.'
      );
    }

    // Calculate credits
    const creditsUsd = ghsToCredits(amount);
    const paymentId = randomUUID();

    // ── Create payment record ─────────────────────────────────

    // Call MTN MoMo API
    const momoReferenceId = await this.client.requestToPay({
      amount,
      currency: this.currency,
      phoneNumber: normalizedPhone,
      externalId: paymentId,
      payerMessage: `AfrAI API credits — ${this.currency} ${amount.toFixed(2)} → $${creditsUsd.toFixed(2)} credits`,
      payeeNote: `Tenant ${tenantId} top-up`,
    });

    // Store the payment record
    await this.paymentStore.createPayment({
      id: paymentId,
      momoReferenceId,
      momoTransactionId: null,
      tenantId,
      phoneNumber: normalizedPhone,
      amountLocal: amount.toFixed(2),
      currency: this.currency,
      creditsUsd: creditsUsd.toFixed(6),
      status: 'pending',
      failureReason: null,
    });

    return {
      paymentId,
      momoReferenceId,
      amountLocal: amount,
      creditsUsd,
      currency: this.currency,
      message: `Payment request sent! Check your phone (${normalizedPhone}) and enter your MoMo PIN to confirm.`,
    };
  }

  /**
   * Check and process the status of a pending payment.
   *
   * If the payment is SUCCESSFUL, credits are added to the tenant's wallet.
   * If FAILED, the record is updated with the failure reason.
   *
   * @param momoReferenceId The reference ID from initiateTopUp
   * @returns Updated payment record
   */
  async checkAndProcessPayment(momoReferenceId: string): Promise<{
    status: PaymentRecord['status'];
    creditsUsd?: number;
    failureReason?: string;
    financialTransactionId?: string;
  }> {
    // Get the stored payment
    const payment = await this.paymentStore.getPaymentByReference(momoReferenceId);
    if (!payment) {
      throw new Error(`Payment not found: ${momoReferenceId}`);
    }

    // Don't re-process completed payments
    if (payment.status !== 'pending') {
      return {
        status: payment.status,
        creditsUsd: payment.status === 'successful' ? parseFloat(payment.creditsUsd) : undefined,
        failureReason: payment.failureReason ?? undefined,
      };
    }

    // Check status with MTN
    const momoResult = await this.client.getPaymentStatus(momoReferenceId);

    if (momoResult.status === 'SUCCESSFUL') {
      // Credit the wallet
      const creditsUsd = parseFloat(payment.creditsUsd);

      await this.walletStore.creditWallet(payment.tenantId, creditsUsd, payment.id);

      await this.paymentStore.updatePaymentStatus(
        momoReferenceId,
        'successful',
        momoResult.financialTransactionId,
      );

      return {
        status: 'successful',
        creditsUsd,
        financialTransactionId: momoResult.financialTransactionId,
      };
    }

    if (momoResult.status === 'FAILED') {
      const reason = momoResult.reason ?? 'UNKNOWN';

      await this.paymentStore.updatePaymentStatus(
        momoReferenceId,
        'failed',
        undefined,
        reason,
      );

      return {
        status: 'failed',
        failureReason: this.humanReadableFailureReason(reason),
      };
    }

    // Still PENDING
    return { status: 'pending' };
  }

  /**
   * Poll payment status until it resolves (successful or failed).
   *
   * Use this for synchronous flows where the client waits for confirmation.
   * For async flows, use the callback URL + checkAndProcessPayment().
   *
   * @param momoReferenceId The reference ID
   * @param maxAttempts Maximum poll attempts (default: 20)
   * @param intervalMs Delay between polls (default: 3000ms)
   */
  async pollUntilResolved(
    momoReferenceId: string,
    maxAttempts: number = MAX_POLL_ATTEMPTS,
    intervalMs: number = POLL_INTERVAL_MS,
  ): Promise<ReturnType<MomoPaymentService['checkAndProcessPayment']>> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.checkAndProcessPayment(momoReferenceId);

      if (result.status !== 'pending') {
        return result;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // Timed out — mark as expired
    await this.paymentStore.updatePaymentStatus(
      momoReferenceId,
      'expired',
      undefined,
      'Payment confirmation timed out. The customer did not respond in time.',
    );

    return {
      status: 'expired' as const,
      failureReason: 'Payment timed out. Please try again and confirm promptly when you receive the prompt.',
    };
  }

  /**
   * Process callback from MTN MoMo (webhook).
   *
   * MTN sends a POST to our callback URL when a payment is completed.
   * This is more efficient than polling.
   */
  async handleCallback(referenceId: string, result: RequestToPayResult): Promise<void> {
    await this.checkAndProcessPayment(referenceId);
  }

  /**
   * Get wallet balance for a tenant.
   */
  async getWalletBalance(tenantId: string): Promise<WalletBalance | null> {
    return this.walletStore.getBalance(tenantId);
  }

  /**
   * Get payment history for a tenant.
   */
  async getPaymentHistory(tenantId: string, limit: number = 20): Promise<PaymentRecord[]> {
    return this.paymentStore.getPaymentHistory(tenantId, limit);
  }

  /**
   * Expire stale pending payments.
   * Run this periodically (e.g., every minute via cron).
   */
  async expireStalePayments(): Promise<number> {
    const stalePayments = await this.paymentStore.getPendingPayments(PAYMENT_EXPIRY_MINUTES);
    let expiredCount = 0;

    for (const payment of stalePayments) {
      try {
        // Check with MTN one last time before expiring
        const result = await this.checkAndProcessPayment(payment.momoReferenceId);

        if (result.status === 'pending') {
          await this.paymentStore.updatePaymentStatus(
            payment.momoReferenceId,
            'expired',
            undefined,
            'Payment not confirmed within time limit',
          );
          expiredCount++;
        }
      } catch (err) {
        console.error(`[MoMo] Failed to expire payment ${payment.id}:`, err);
      }
    }

    return expiredCount;
  }

  // ── Internals ───────────────────────────────────────────────

  /**
   * Convert MTN failure codes to human-readable messages.
   */
  private humanReadableFailureReason(reason: string): string {
    const messages: Record<string, string> = {
      NOT_ENOUGH_FUNDS: 'Insufficient MoMo balance. Please top up your MoMo wallet and try again.',
      PAYER_LIMIT_REACHED: 'You\'ve reached your MoMo daily transaction limit. Try again tomorrow or contact MTN to increase your limit.',
      PAYMENT_NOT_APPROVED: 'Payment was not approved. You may have cancelled the request.',
      APPROVAL_REJECTED: 'Payment was rejected. Please try again.',
      EXPIRED: 'Payment request expired. Please try again and confirm promptly.',
      TRANSACTION_CANCELED: 'Payment was cancelled.',
      PAYER_NOT_FOUND: 'MoMo account not found for this number. Please check the number and try again.',
      SERVICE_UNAVAILABLE: 'MTN MoMo service is temporarily unavailable. Please try again in a few minutes.',
      INTERNAL_PROCESSING_ERROR: 'A processing error occurred at MTN. Please try again.',
      INVALID_CURRENCY: 'Currency not supported for this transaction.',
      NOT_ALLOWED: 'This transaction is not allowed. Please contact support.',
    };

    return messages[reason] ?? `Payment failed: ${reason}. Please try again or contact support.`;
  }
}
