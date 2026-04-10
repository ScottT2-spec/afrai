-- Migration: 0003_create_payments_and_wallets
-- MoMo payment records and tenant wallet balances
-- First AI API platform in the world to accept Mobile Money 🇬🇭

-- ── Payments table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- MTN MoMo reference ID (UUID sent with requesttopay)
    momo_reference_id UUID NOT NULL UNIQUE,
    -- MTN financial transaction ID (received on success)
    momo_transaction_id VARCHAR(100),
    -- Tenant who initiated the payment
    tenant_id UUID NOT NULL,
    -- Phone number charged (international format: 233XXXXXXXXX)
    phone_number VARCHAR(15) NOT NULL,
    -- Amount in local currency
    amount_local DECIMAL(12, 2) NOT NULL,
    -- Currency code (GHS, UGX, etc.)
    currency VARCHAR(3) NOT NULL DEFAULT 'GHS',
    -- API credits granted in USD
    credits_usd DECIMAL(12, 6) NOT NULL,
    -- Payment status
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'successful', 'failed', 'expired')),
    -- Failure reason (from MTN or internal)
    failure_reason TEXT,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_payments_tenant_id ON payments (tenant_id);
CREATE INDEX idx_payments_momo_reference ON payments (momo_reference_id);
CREATE INDEX idx_payments_status ON payments (status);
CREATE INDEX idx_payments_created_at ON payments (created_at);
CREATE INDEX idx_payments_tenant_created ON payments (tenant_id, created_at DESC);
-- For expiry cleanup: find pending payments older than N minutes
CREATE INDEX idx_payments_pending_created ON payments (created_at)
    WHERE status = 'pending';

-- ── Wallets table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- One wallet per tenant
    tenant_id UUID NOT NULL UNIQUE,
    -- Current available balance in USD
    balance_usd DECIMAL(12, 6) NOT NULL DEFAULT 0,
    -- Lifetime total purchased
    total_purchased_usd DECIMAL(12, 6) NOT NULL DEFAULT 0,
    -- Lifetime total spent on API calls
    total_spent_usd DECIMAL(12, 6) NOT NULL DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Balance can never go negative
    CONSTRAINT wallet_balance_non_negative CHECK (balance_usd >= 0)
);

CREATE INDEX idx_wallets_tenant_id ON wallets (tenant_id);

-- ── Wallet transactions (audit trail) ───────────────────────────
-- This table is append-only and grows fast. Partition by month for billions.
-- To enable partitioning later:
--   ALTER TABLE wallet_transactions RENAME TO wallet_transactions_old;
--   CREATE TABLE wallet_transactions (...) PARTITION BY RANGE (created_at);
--   CREATE TABLE wallet_transactions_2026_01 PARTITION OF wallet_transactions
--     FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Wallet / tenant
    tenant_id UUID NOT NULL,
    -- Transaction type
    type VARCHAR(20) NOT NULL CHECK (type IN ('credit', 'debit', 'refund')),
    -- Amount in USD (always positive — type indicates direction)
    amount_usd DECIMAL(12, 6) NOT NULL,
    -- Balance after this transaction
    balance_after_usd DECIMAL(12, 6) NOT NULL,
    -- Reference: payment ID for credits, request ID for debits
    -- UNIQUE per type to prevent duplicate credits/debits (idempotency)
    reference_id VARCHAR(100) NOT NULL,
    -- Human-readable description
    description TEXT,
    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: prevent duplicate credit/debit for same reference
CREATE UNIQUE INDEX idx_wallet_txn_idempotent ON wallet_transactions (reference_id, type);
CREATE INDEX idx_wallet_txn_tenant ON wallet_transactions (tenant_id);
CREATE INDEX idx_wallet_txn_tenant_created ON wallet_transactions (tenant_id, created_at DESC);
CREATE INDEX idx_wallet_txn_reference ON wallet_transactions (reference_id);

-- ── Trigger: auto-update updated_at ─────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
