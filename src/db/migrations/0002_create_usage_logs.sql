-- Migration: 0002_create_usage_logs
-- Tracks every API request for billing and analytics

CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    model VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd VARCHAR(20) NOT NULL,
    latency_ms INTEGER NOT NULL,
    complexity_score VARCHAR(10),
    status VARCHAR(20) NOT NULL,  -- success, fallback, error
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_usage_logs_tenant_id ON usage_logs (tenant_id);
CREATE INDEX idx_usage_logs_created_at ON usage_logs (created_at);
CREATE INDEX idx_usage_logs_tenant_created ON usage_logs (tenant_id, created_at);
