/**
 * Payment Store — PostgreSQL-backed payment record persistence.
 *
 * Design for scale:
 *   - Idempotent payment creation (unique momo_reference_id)
 *   - Efficient queries via targeted indexes
 *   - Ready for table partitioning by created_at (for billions of rows)
 *   - Status updates are atomic (no lost updates)
 */

import type { PaymentRecord } from './momoTypes.js';
import type { PaymentStore } from './momoPayment.js';
import type { DbClient } from './walletStore.js';

/**
 * PostgreSQL-backed payment store.
 */
export class PostgresPaymentStore implements PaymentStore {
  constructor(private readonly db: DbClient) {}

  /**
   * Create a new payment record.
   * Idempotent via UNIQUE constraint on momo_reference_id.
   */
  async createPayment(record: Omit<PaymentRecord, 'createdAt' | 'updatedAt'>): Promise<void> {
    await this.db.query(
      `INSERT INTO payments (
        id, momo_reference_id, momo_transaction_id, tenant_id,
        phone_number, amount_local, currency, credits_usd,
        status, failure_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (momo_reference_id) DO NOTHING`,
      [
        record.id,
        record.momoReferenceId,
        record.momoTransactionId,
        record.tenantId,
        record.phoneNumber,
        record.amountLocal,
        record.currency,
        record.creditsUsd,
        record.status,
        record.failureReason,
      ],
    );
  }

  /**
   * Update payment status atomically.
   * Only updates if current status is 'pending' (prevents stale overwrites).
   */
  async updatePaymentStatus(
    momoReferenceId: string,
    status: PaymentRecord['status'],
    momoTransactionId?: string,
    failureReason?: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE payments
       SET status = $1,
           momo_transaction_id = COALESCE($2, momo_transaction_id),
           failure_reason = COALESCE($3, failure_reason)
       WHERE momo_reference_id = $4
         AND status = 'pending'`,
      [status, momoTransactionId ?? null, failureReason ?? null, momoReferenceId],
    );
  }

  /**
   * Get a payment by its MoMo reference ID.
   */
  async getPaymentByReference(momoReferenceId: string): Promise<PaymentRecord | null> {
    const result = await this.db.query<DbPaymentRow>(
      `SELECT * FROM payments WHERE momo_reference_id = $1 LIMIT 1`,
      [momoReferenceId],
    );

    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]!);
  }

  /**
   * Get payment history for a tenant, most recent first.
   */
  async getPaymentHistory(tenantId: string, limit: number = 20): Promise<PaymentRecord[]> {
    const result = await this.db.query<DbPaymentRow>(
      `SELECT * FROM payments
       WHERE tenant_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [tenantId, limit],
    );

    return result.rows.map(mapRow);
  }

  /**
   * Get pending payments older than N minutes.
   * Used by the expiry job to clean up abandoned payments.
   */
  async getPendingPayments(olderThanMinutes: number): Promise<PaymentRecord[]> {
    const result = await this.db.query<DbPaymentRow>(
      `SELECT * FROM payments
       WHERE status = 'pending'
         AND created_at < NOW() - INTERVAL '1 minute' * $1
       ORDER BY created_at ASC
       LIMIT 100`,
      [olderThanMinutes],
    );

    return result.rows.map(mapRow);
  }

  /**
   * Get aggregate payment stats (for admin dashboard).
   */
  async getStats(): Promise<{
    totalPayments: number;
    successfulPayments: number;
    totalVolumeGhs: number;
    totalCreditsUsd: number;
  }> {
    const result = await this.db.query<{
      total: string;
      successful: string;
      volume_ghs: string;
      credits_usd: string;
    }>(
      `SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'successful') as successful,
        COALESCE(SUM(amount_local) FILTER (WHERE status = 'successful'), 0) as volume_ghs,
        COALESCE(SUM(credits_usd) FILTER (WHERE status = 'successful'), 0) as credits_usd
       FROM payments`,
    );

    const row = result.rows[0]!;
    return {
      totalPayments: parseInt(row.total, 10),
      successfulPayments: parseInt(row.successful, 10),
      totalVolumeGhs: parseFloat(row.volume_ghs),
      totalCreditsUsd: parseFloat(row.credits_usd),
    };
  }
}

// ── Internal helpers ────────────────────────────────────────────

interface DbPaymentRow {
  id: string;
  momo_reference_id: string;
  momo_transaction_id: string | null;
  tenant_id: string;
  phone_number: string;
  amount_local: string;
  currency: string;
  credits_usd: string;
  status: string;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DbPaymentRow): PaymentRecord {
  return {
    id: row.id,
    momoReferenceId: row.momo_reference_id,
    momoTransactionId: row.momo_transaction_id,
    tenantId: row.tenant_id,
    phoneNumber: row.phone_number,
    amountLocal: row.amount_local,
    currency: row.currency,
    creditsUsd: row.credits_usd,
    status: row.status as PaymentRecord['status'],
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
