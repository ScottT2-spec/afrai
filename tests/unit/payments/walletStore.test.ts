import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresWalletStore, type DbClient } from '../../../src/payments/walletStore.js';

/**
 * Tests for atomic wallet operations.
 *
 * These verify the SQL logic and transaction flow.
 * Integration tests against a real PostgreSQL instance would test
 * the actual row-locking behavior under concurrency.
 */

function createMockDb(): DbClient & { queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let balance = 0;

  return {
    queries,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });

      // Simulate wallet queries
      if (sql.includes('SELECT') && sql.includes('wallets') && sql.includes('FOR UPDATE')) {
        return { rows: [{ balance_usd: balance.toFixed(6) }] };
      }
      if (sql.includes('SELECT') && sql.includes('wallets') && !sql.includes('FOR UPDATE')) {
        return {
          rows: [{
            tenant_id: params[0],
            balance_usd: balance.toFixed(6),
            total_purchased_usd: '0.000000',
            total_spent_usd: '0.000000',
          }],
        };
      }
      if (sql.includes('UPDATE wallets') && sql.includes('total_purchased_usd')) {
        balance = parseFloat(params[0] as string);
      }
      if (sql.includes('UPDATE wallets') && sql.includes('total_spent_usd')) {
        balance = parseFloat(params[0] as string);
      }
      // No duplicate transactions
      if (sql.includes('SELECT') && sql.includes('wallet_transactions')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

describe('PostgresWalletStore', () => {
  let store: PostgresWalletStore;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    store = new PostgresWalletStore(mockDb);
  });

  describe('createWallet', () => {
    it('should execute INSERT with ON CONFLICT DO NOTHING', async () => {
      await store.createWallet('tenant-1');

      const insertQuery = mockDb.queries.find((q) =>
        q.sql.includes('INSERT INTO wallets') && q.sql.includes('ON CONFLICT')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params[0]).toBe('tenant-1');
    });
  });

  describe('creditWallet', () => {
    it('should wrap credit in a transaction', async () => {
      await store.creditWallet('tenant-1', 5.0, 'payment-1');

      const sqls = mockDb.queries.map((q) => q.sql.trim());
      expect(sqls[0]).toBe('BEGIN');
      expect(sqls[sqls.length - 1]).toBe('COMMIT');
    });

    it('should check for duplicate credit (idempotency)', async () => {
      await store.creditWallet('tenant-1', 5.0, 'payment-1');

      const idempotencyCheck = mockDb.queries.find((q) =>
        q.sql.includes('wallet_transactions') && q.sql.includes('reference_id')
      );
      expect(idempotencyCheck).toBeDefined();
    });

    it('should lock wallet row with FOR UPDATE', async () => {
      await store.creditWallet('tenant-1', 5.0, 'payment-1');

      const lockQuery = mockDb.queries.find((q) =>
        q.sql.includes('FOR UPDATE')
      );
      expect(lockQuery).toBeDefined();
    });

    it('should insert audit trail transaction', async () => {
      await store.creditWallet('tenant-1', 5.0, 'payment-1');

      const auditInsert = mockDb.queries.find((q) =>
        q.sql.includes('INSERT INTO wallet_transactions')
      );
      expect(auditInsert).toBeDefined();
      expect(auditInsert!.params).toContain('tenant-1');
      expect(auditInsert!.params).toContain('payment-1');
    });

    it('should rollback on error', async () => {
      // Make the UPDATE fail
      mockDb.query = vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('wallet_transactions') && sql.includes('SELECT')) return { rows: [] };
        if (sql.includes('INSERT INTO wallets')) return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [{ balance_usd: '0.000000' }] };
        if (sql.includes('UPDATE')) throw new Error('DB error');
        return { rows: [] };
      }) as DbClient['query'];

      await expect(store.creditWallet('tenant-1', 5.0, 'pay-1')).rejects.toThrow('DB error');
    });
  });

  describe('debitWallet', () => {
    it('should return false for non-existent wallet', async () => {
      mockDb.query = vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('wallet_transactions')) return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [] }; // no wallet
        return { rows: [] };
      }) as DbClient['query'];

      const result = await store.debitWallet('unknown-tenant', 1.0, 'req-1');
      expect(result).toBe(false);
    });

    it('should return false for insufficient balance', async () => {
      mockDb.query = vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('wallet_transactions')) return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [{ balance_usd: '0.50' }] };
        return { rows: [] };
      }) as DbClient['query'];

      const result = await store.debitWallet('tenant-1', 5.0, 'req-1');
      expect(result).toBe(false);
    });

    it('should return true for successful debit with sufficient balance', async () => {
      mockDb.query = vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT') return { rows: [] };
        if (sql.includes('wallet_transactions') && sql.includes('SELECT')) return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [{ balance_usd: '10.000000' }] };
        if (sql.includes('UPDATE wallets')) return { rows: [] };
        if (sql.includes('INSERT INTO wallet_transactions')) return { rows: [] };
        return { rows: [] };
      }) as DbClient['query'];

      const result = await store.debitWallet('tenant-1', 1.0, 'req-1');
      expect(result).toBe(true);
    });

    it('should be idempotent (duplicate debit returns true)', async () => {
      mockDb.query = vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT') return { rows: [] };
        // Simulate existing debit transaction
        if (sql.includes('wallet_transactions') && sql.includes('SELECT')) {
          return { rows: [{ id: 'existing-txn' }] };
        }
        return { rows: [] };
      }) as DbClient['query'];

      const result = await store.debitWallet('tenant-1', 1.0, 'req-1');
      expect(result).toBe(true);
    });
  });

  describe('getBalance', () => {
    it('should return null for unknown tenant', async () => {
      mockDb.query = vi.fn(async () => ({ rows: [] })) as DbClient['query'];

      const balance = await store.getBalance('unknown');
      expect(balance).toBeNull();
    });

    it('should return balance for known tenant', async () => {
      const balance = await store.getBalance('tenant-1');
      expect(balance).not.toBeNull();
      expect(balance!.tenantId).toBe('tenant-1');
    });
  });
});
