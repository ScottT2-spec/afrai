/**
 * Wallet Store — Atomic, race-condition-proof wallet operations.
 *
 * Every credit/debit uses PostgreSQL row-level locking (SELECT FOR UPDATE)
 * to prevent double-spends and overdrafts under concurrent load.
 *
 * Design for billions:
 *   - Atomic balance updates via DB transactions (no read-then-write races)
 *   - Idempotent operations via unique reference_id constraints
 *   - Audit trail in wallet_transactions (append-only, partitionable)
 *   - Balance cached in wallets table (no SUM() over transactions)
 *   - Prepared for table partitioning by created_at
 */

import type { WalletBalance } from './momoTypes.js';
import type { WalletStore } from './momoPayment.js';

/** Database client interface (matches Drizzle/pg patterns) */
export interface DbClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * PostgreSQL-backed wallet store with atomic operations.
 *
 * All balance mutations happen inside transactions with row locks.
 * This is the layer that ensures you never overdraw a wallet,
 * even under 10,000 concurrent API requests.
 */
export class PostgresWalletStore implements WalletStore {
  constructor(private readonly db: DbClient) {}

  /**
   * Get current wallet balance.
   */
  async getBalance(tenantId: string): Promise<WalletBalance | null> {
    const result = await this.db.query<{
      tenant_id: string;
      balance_usd: string;
      total_purchased_usd: string;
      total_spent_usd: string;
    }>(
      'SELECT tenant_id, balance_usd::TEXT, total_purchased_usd::TEXT, total_spent_usd::TEXT FROM wallets WHERE tenant_id = $1',
      [tenantId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0]!;
    return {
      tenantId: row.tenant_id,
      balanceUsd: row.balance_usd,
      totalPurchasedUsd: row.total_purchased_usd,
      totalSpentUsd: row.total_spent_usd,
    };
  }

  /**
   * Create a wallet for a new tenant.
   * Idempotent — silently succeeds if wallet already exists.
   */
  async createWallet(tenantId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO wallets (tenant_id, balance_usd, total_purchased_usd, total_spent_usd)
       VALUES ($1, 0, 0, 0)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }

  /**
   * Credit (add) funds to a wallet. Atomic + idempotent.
   *
   * Uses SELECT FOR UPDATE to lock the wallet row during the transaction.
   * The paymentId serves as an idempotency key — duplicate credits are ignored.
   *
   * @param tenantId Tenant to credit
   * @param amountUsd Amount in USD to add
   * @param paymentId Payment reference (idempotency key)
   */
  async creditWallet(tenantId: string, amountUsd: number, paymentId: string): Promise<void> {
    await this.db.query('BEGIN', []);

    try {
      // Check for duplicate credit (idempotency)
      const existing = await this.db.query(
        `SELECT id FROM wallet_transactions
         WHERE reference_id = $1 AND type = 'credit'
         LIMIT 1`,
        [paymentId],
      );

      if (existing.rows.length > 0) {
        // Already credited — idempotent success
        await this.db.query('COMMIT', []);
        return;
      }

      // Lock the wallet row (or create if it doesn't exist)
      await this.db.query(
        `INSERT INTO wallets (tenant_id, balance_usd, total_purchased_usd, total_spent_usd)
         VALUES ($1, 0, 0, 0)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId],
      );

      const walletResult = await this.db.query<{
        balance_usd: string;
      }>(
        'SELECT balance_usd FROM wallets WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );

      const currentBalance = parseFloat(walletResult.rows[0]!.balance_usd);
      const newBalance = currentBalance + amountUsd;

      // Update wallet balance
      await this.db.query(
        `UPDATE wallets
         SET balance_usd = $1,
             total_purchased_usd = total_purchased_usd + $2
         WHERE tenant_id = $3`,
        [newBalance.toFixed(6), amountUsd.toFixed(6), tenantId],
      );

      // Record transaction in audit trail
      await this.db.query(
        `INSERT INTO wallet_transactions (tenant_id, type, amount_usd, balance_after_usd, reference_id, description)
         VALUES ($1, 'credit', $2, $3, $4, $5)`,
        [
          tenantId,
          amountUsd.toFixed(6),
          newBalance.toFixed(6),
          paymentId,
          `MoMo top-up: +$${amountUsd.toFixed(2)}`,
        ],
      );

      await this.db.query('COMMIT', []);
    } catch (err) {
      await this.db.query('ROLLBACK', []).catch(() => {});
      throw err;
    }
  }

  /**
   * Debit (subtract) funds from a wallet. Atomic + overdraft-safe.
   *
   * Returns false if insufficient balance (never goes negative).
   * The requestId serves as an idempotency key for the debit.
   *
   * @param tenantId Tenant to debit
   * @param amountUsd Amount in USD to deduct
   * @param requestId API request reference (idempotency key)
   * @returns true if debit succeeded, false if insufficient funds
   */
  async debitWallet(tenantId: string, amountUsd: number, requestId: string): Promise<boolean> {
    await this.db.query('BEGIN', []);

    try {
      // Check for duplicate debit (idempotency)
      const existing = await this.db.query(
        `SELECT id FROM wallet_transactions
         WHERE reference_id = $1 AND type = 'debit'
         LIMIT 1`,
        [requestId],
      );

      if (existing.rows.length > 0) {
        // Already debited — idempotent success
        await this.db.query('COMMIT', []);
        return true;
      }

      // Lock the wallet row
      const walletResult = await this.db.query<{
        balance_usd: string;
      }>(
        'SELECT balance_usd FROM wallets WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );

      if (walletResult.rows.length === 0) {
        await this.db.query('ROLLBACK', []);
        return false; // No wallet = no funds
      }

      const currentBalance = parseFloat(walletResult.rows[0]!.balance_usd);

      if (currentBalance < amountUsd) {
        await this.db.query('ROLLBACK', []);
        return false; // Insufficient funds
      }

      const newBalance = currentBalance - amountUsd;

      // Update wallet balance
      await this.db.query(
        `UPDATE wallets
         SET balance_usd = $1,
             total_spent_usd = total_spent_usd + $2
         WHERE tenant_id = $3`,
        [newBalance.toFixed(6), amountUsd.toFixed(6), tenantId],
      );

      // Record transaction in audit trail
      await this.db.query(
        `INSERT INTO wallet_transactions (tenant_id, type, amount_usd, balance_after_usd, reference_id, description)
         VALUES ($1, 'debit', $2, $3, $4, $5)`,
        [
          tenantId,
          amountUsd.toFixed(6),
          newBalance.toFixed(6),
          requestId,
          `API usage: -$${amountUsd.toFixed(6)}`,
        ],
      );

      await this.db.query('COMMIT', []);
      return true;
    } catch (err) {
      await this.db.query('ROLLBACK', []).catch(() => {});
      throw err;
    }
  }

  /**
   * Refund a previous debit. Atomic + idempotent.
   */
  async refundDebit(tenantId: string, amountUsd: number, originalRequestId: string): Promise<void> {
    const refundRef = `refund:${originalRequestId}`;

    await this.db.query('BEGIN', []);

    try {
      // Idempotency check
      const existing = await this.db.query(
        `SELECT id FROM wallet_transactions
         WHERE reference_id = $1 AND type = 'refund'
         LIMIT 1`,
        [refundRef],
      );

      if (existing.rows.length > 0) {
        await this.db.query('COMMIT', []);
        return;
      }

      // Lock and update
      const walletResult = await this.db.query<{ balance_usd: string }>(
        'SELECT balance_usd FROM wallets WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );

      if (walletResult.rows.length === 0) {
        await this.db.query('ROLLBACK', []);
        return;
      }

      const newBalance = parseFloat(walletResult.rows[0]!.balance_usd) + amountUsd;

      await this.db.query(
        `UPDATE wallets
         SET balance_usd = $1,
             total_spent_usd = total_spent_usd - $2
         WHERE tenant_id = $3`,
        [newBalance.toFixed(6), amountUsd.toFixed(6), tenantId],
      );

      await this.db.query(
        `INSERT INTO wallet_transactions (tenant_id, type, amount_usd, balance_after_usd, reference_id, description)
         VALUES ($1, 'refund', $2, $3, $4, $5)`,
        [
          tenantId,
          amountUsd.toFixed(6),
          newBalance.toFixed(6),
          refundRef,
          `Refund for request ${originalRequestId}`,
        ],
      );

      await this.db.query('COMMIT', []);
    } catch (err) {
      await this.db.query('ROLLBACK', []).catch(() => {});
      throw err;
    }
  }
}
