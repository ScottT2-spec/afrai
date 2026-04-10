import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MomoPaymentService,
  ghsToCredits,
  estimateApiCalls,
  CREDIT_TIERS,
  type PaymentStore,
  type WalletStore,
} from '../../../src/payments/momoPayment.js';
import type { MomoConfig, PaymentRecord, WalletBalance } from '../../../src/payments/momoTypes.js';

// ── ghsToCredits ────────────────────────────────────────────────

describe('ghsToCredits', () => {
  it('should return exact tier value for standard amounts', () => {
    expect(ghsToCredits(5)).toBe(0.30);
    expect(ghsToCredits(10)).toBe(0.62);
    expect(ghsToCredits(50)).toBe(3.20);
    expect(ghsToCredits(100)).toBe(6.50);
    expect(ghsToCredits(500)).toBe(33.50);
  });

  it('should interpolate for non-tier amounts', () => {
    const credits = ghsToCredits(15);
    expect(credits).toBeGreaterThan(0);
    expect(credits).toBeLessThan(2);
  });

  it('should give better rates for higher amounts', () => {
    const rate10 = ghsToCredits(10) / 10;
    const rate500 = ghsToCredits(500) / 500;
    // Higher amounts should get more credits per GHS
    expect(rate500).toBeGreaterThan(rate10);
  });
});

// ── estimateApiCalls ────────────────────────────────────────────

describe('estimateApiCalls', () => {
  it('should return positive numbers for all model tiers', () => {
    const estimate = estimateApiCalls(1.0);
    expect(estimate.cheapModel).toBeGreaterThan(0);
    expect(estimate.midModel).toBeGreaterThan(0);
    expect(estimate.premiumModel).toBeGreaterThan(0);
  });

  it('should scale linearly with credits', () => {
    const small = estimateApiCalls(1.0);
    const large = estimateApiCalls(10.0);
    expect(large.cheapModel).toBe(small.cheapModel * 10);
  });

  it('should show cheap > mid > premium call counts', () => {
    const estimate = estimateApiCalls(5.0);
    expect(estimate.cheapModel).toBeGreaterThan(estimate.midModel);
    expect(estimate.midModel).toBeGreaterThan(estimate.premiumModel);
  });
});

// ── CREDIT_TIERS ────────────────────────────────────────────────

describe('CREDIT_TIERS', () => {
  it('should have increasing amounts', () => {
    for (let i = 1; i < CREDIT_TIERS.length; i++) {
      expect(CREDIT_TIERS[i]!.amountLocal).toBeGreaterThan(CREDIT_TIERS[i - 1]!.amountLocal);
    }
  });

  it('should have increasing credits', () => {
    for (let i = 1; i < CREDIT_TIERS.length; i++) {
      expect(CREDIT_TIERS[i]!.creditsUsd).toBeGreaterThan(CREDIT_TIERS[i - 1]!.creditsUsd);
    }
  });

  it('should have labels for all tiers', () => {
    for (const tier of CREDIT_TIERS) {
      expect(tier.label).toBeTruthy();
      expect(tier.label.length).toBeGreaterThan(0);
    }
  });
});

// ── MomoPaymentService ──────────────────────────────────────────

describe('MomoPaymentService', () => {
  let service: MomoPaymentService;
  let mockPaymentStore: PaymentStore;
  let mockWalletStore: WalletStore;

  const testConfig: MomoConfig = {
    subscriptionKey: 'test-sub-key',
    apiUserId: 'test-api-user',
    apiKey: 'test-api-key',
    environment: 'sandbox',
    currency: 'GHS',
    callbackUrl: 'https://api.afrai.dev/v1/payments/momo/callback',
  };

  beforeEach(() => {
    mockPaymentStore = {
      createPayment: vi.fn().mockResolvedValue(undefined),
      updatePaymentStatus: vi.fn().mockResolvedValue(undefined),
      getPaymentByReference: vi.fn().mockResolvedValue(null),
      getPaymentHistory: vi.fn().mockResolvedValue([]),
      getPendingPayments: vi.fn().mockResolvedValue([]),
    };

    mockWalletStore = {
      getBalance: vi.fn().mockResolvedValue(null),
      creditWallet: vi.fn().mockResolvedValue(undefined),
      debitWallet: vi.fn().mockResolvedValue(true),
      createWallet: vi.fn().mockResolvedValue(undefined),
    };

    service = new MomoPaymentService(testConfig, mockPaymentStore, mockWalletStore);
  });

  describe('getCreditTiers', () => {
    it('should return all tiers with estimated calls', () => {
      const tiers = service.getCreditTiers();
      expect(tiers.length).toBe(CREDIT_TIERS.length);

      for (const tier of tiers) {
        expect(tier.estimatedCalls).toBeDefined();
        expect(tier.estimatedCalls.cheapModel).toBeGreaterThan(0);
      }
    });
  });

  describe('initiateTopUp', () => {
    it('should reject amounts below minimum', async () => {
      await expect(
        service.initiateTopUp({ amount: 2, phoneNumber: '0241234567', tenantId: 'tenant-1' })
      ).rejects.toThrow('Minimum top-up is 5 GHS');
    });

    it('should reject amounts above maximum', async () => {
      await expect(
        service.initiateTopUp({ amount: 6000, phoneNumber: '0241234567', tenantId: 'tenant-1' })
      ).rejects.toThrow('Maximum top-up is 5000 GHS');
    });

    it('should reject non-MTN numbers', async () => {
      await expect(
        service.initiateTopUp({ amount: 10, phoneNumber: '0201234567', tenantId: 'tenant-1' })
      ).rejects.toThrow('Only MTN MoMo numbers are supported');
    });

    it('should reject invalid phone numbers', async () => {
      await expect(
        service.initiateTopUp({ amount: 10, phoneNumber: '12345', tenantId: 'tenant-1' })
      ).rejects.toThrow();
    });
  });

  describe('checkAndProcessPayment', () => {
    it('should throw for unknown payment', async () => {
      await expect(
        service.checkAndProcessPayment('unknown-ref-id')
      ).rejects.toThrow('Payment not found');
    });

    it('should return existing status for completed payments', async () => {
      (mockPaymentStore.getPaymentByReference as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'pay-1',
        momoReferenceId: 'ref-1',
        tenantId: 'tenant-1',
        status: 'successful',
        creditsUsd: '3.20',
        failureReason: null,
      });

      const result = await service.checkAndProcessPayment('ref-1');
      expect(result.status).toBe('successful');
      expect(result.creditsUsd).toBe(3.20);
    });

    it('should return failure reason for failed payments', async () => {
      (mockPaymentStore.getPaymentByReference as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'pay-2',
        momoReferenceId: 'ref-2',
        tenantId: 'tenant-1',
        status: 'failed',
        creditsUsd: '0',
        failureReason: 'NOT_ENOUGH_FUNDS',
      });

      const result = await service.checkAndProcessPayment('ref-2');
      expect(result.status).toBe('failed');
      expect(result.failureReason).toBe('NOT_ENOUGH_FUNDS');
    });
  });

  describe('getWalletBalance', () => {
    it('should return null for unknown tenant', async () => {
      const balance = await service.getWalletBalance('unknown-tenant');
      expect(balance).toBeNull();
    });

    it('should return balance for existing tenant', async () => {
      const mockBalance: WalletBalance = {
        tenantId: 'tenant-1',
        balanceUsd: '5.00',
        totalPurchasedUsd: '10.00',
        totalSpentUsd: '5.00',
      };
      (mockWalletStore.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(mockBalance);

      const balance = await service.getWalletBalance('tenant-1');
      expect(balance).toEqual(mockBalance);
    });
  });
});
