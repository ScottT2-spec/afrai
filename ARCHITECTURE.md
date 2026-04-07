# AfrAI — Architecture Document

> Africa's AI Infrastructure Layer. The operating system between African businesses and AI.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                             │
│  Any business, any stack, any language — HTTP/REST + SDKs       │
│  POST https://api.afrai.dev/v1/completion                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API GATEWAY (Fastify)                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────────┐  │
│  │   Auth    │ │  Rate    │ │  Request  │ │   Idempotency    │  │
│  │ (API Key) │ │ Limiter  │ │ Validator │ │   (Dedup Keys)   │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SEMANTIC CACHE LAYER                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Embedding Generator → pgvector Similarity Search        │   │
│  │  Cache Hit? → Return instantly (cost = $0)               │   │
│  │  Cache Miss? → Continue to Router                        │   │
│  │  Namespace isolation per tenant                          │   │
│  │  TTL + LRU eviction                                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ (cache miss)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SMART ROUTER ENGINE                          │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────────────┐  │
│  │  Complexity   │ │   Cost       │ │   Provider Health      │  │
│  │  Analyzer     │ │   Optimizer  │ │   Monitor              │  │
│  │              │ │              │ │   (Circuit Breaker)    │  │
│  │  Classifies   │ │  Picks the   │ │   Tracks uptime,      │  │
│  │  request as   │ │  cheapest    │ │   latency, errors     │  │
│  │  simple/med/  │ │  capable     │ │   per provider        │  │
│  │  complex      │ │  model       │ │                        │  │
│  └──────┬───────┘ └──────┬───────┘ └───────────┬────────────┘  │
│         └────────────────┴─────────────────────┘               │
│                          │                                      │
│                    Model Selected                                │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  REQUEST COALESCER                               │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  If 10 tenants ask the same thing within 2s window:      │   │
│  │  → Make ONE API call, serve all 10                       │   │
│  │  → Massive cost savings at scale                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                 PROVIDER ABSTRACTION LAYER                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │  OpenAI  │ │ Anthropic│ │  Google  │ │  Cohere  │  ...     │
│  │  Adapter │ │  Adapter │ │  Adapter │ │  Adapter │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  Unified interface: sendCompletion(model, messages, options)    │
│  Each adapter handles provider-specific quirks                  │
│  API key rotation per provider                                  │
│  Automatic retry with exponential backoff                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   RESILIENCE LAYER                              │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐  │
│  │  Circuit Breaker │ │  Fallback Chain │ │  Offline Queue  │  │
│  │                  │ │                  │ │                  │  │
│  │  CLOSED → OPEN   │ │  Premium Model  │ │  BullMQ + Redis │  │
│  │  after 5 fails   │ │  → Cheap Model  │ │  Persists when  │  │
│  │  HALF_OPEN to    │ │  → Cache        │ │  all providers  │  │
│  │  test recovery   │ │  → Degraded     │ │  are down       │  │
│  │                  │ │  → Error        │ │  Retries on     │  │
│  │                  │ │                  │ │  recovery       │  │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   POST-PROCESSING                               │
│  ┌──────────┐ ┌──────────────┐ ┌────────────────────────────┐  │
│  │  Cache    │ │   Billing    │ │    Observability           │  │
│  │  Store    │ │   Track      │ │    (Logs, Metrics, Trace)  │  │
│  └──────────┘ └──────────────┘ └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

                           │
                           ▼
                    Response to Client
```

## Tech Stack Decisions

| Choice | Winner | Why |
|--------|--------|-----|
| Language | **TypeScript** | Type safety for large codebase. Node.js is I/O-bound optimal — this is a proxy/gateway, not CPU-heavy. Every AI provider has first-class Node SDKs. |
| Runtime | **Node.js 20+ LTS** | Non-blocking event loop perfect for proxying thousands of concurrent API calls. Single-threaded simplicity, cluster for multi-core. |
| Framework | **Fastify** | 2-3x faster than Express. Built-in schema validation (Ajv), plugin architecture, TypeScript-first. Battle-tested at scale. |
| Database | **PostgreSQL 16 + pgvector** | Relational data (tenants, billing, keys) + vector similarity search (semantic cache) in ONE database. No separate vector DB needed. |
| Cache/Queue | **Redis 7+** | Rate limiting (sliding window), hot cache, pub/sub for coalescing, BullMQ job persistence. |
| Job Queue | **BullMQ** | Offline queue, retry logic, dead letter queue, priority queues. Redis-backed, survives restarts. |
| ORM | **Drizzle** | Type-safe, zero overhead, SQL-like. No magic, no hidden queries. You see exactly what hits the DB. |
| Validation | **Zod** | Runtime type validation for all API inputs. Shared types between validation and TypeScript. |
| Testing | **Vitest** | Fast, native TypeScript, compatible API with Jest. |
| Logging | **Pino** | Fastest Node.js logger. Structured JSON logs. Fastify uses it natively. |
| Metrics | **prom-client** | Prometheus-compatible. Industry standard for observability. |
| Containerization | **Docker** | Reproducible builds, easy deployment anywhere. |

## Core Engineering Principles

### 1. Multi-Tenant Isolation
Every tenant (business) is completely isolated:
- Separate cache namespaces
- Separate rate limit buckets
- Separate billing counters
- No data leakage between tenants, ever

### 2. Zero Trust on Inputs
Every request is validated at the boundary:
- Zod schema validation on all API inputs
- API key authentication on every request
- Rate limiting before any processing
- Idempotency keys prevent duplicate charges

### 3. Graceful Degradation (Never Hard Fail)
The degradation chain:
```
Premium Model → Fallback Model → Cached Response → Degraded Response → Queued for Later → Error
```
A business should almost NEVER get a hard error. There's always a fallback.

### 4. Cost Awareness at Every Layer
- Complexity analyzer routes to cheapest capable model
- Semantic cache eliminates redundant API calls
- Request coalescing deduplicates concurrent identical requests
- Token budget optimizer compresses prompts when possible
- Per-tenant cost tracking with alerts and limits

### 5. Offline-First (Africa Reality)
- All requests can be queued when providers are unreachable
- Local cache serves known answers without internet
- Queue persists through server restarts (Redis + BullMQ)
- Automatic drain when connectivity returns
- Webhook delivery for async results

### 6. Observable by Default
Every request generates:
- Structured log entry (Pino)
- Prometheus metrics (latency, cost, cache hit rate, provider health)
- Trace ID for end-to-end debugging
- Billing event

## Directory Structure

```
afrai/
├── src/
│   ├── server.ts                    # Fastify server bootstrap
│   ├── config/
│   │   └── index.ts                 # Environment config with validation
│   ├── gateway/
│   │   ├── routes/
│   │   │   ├── completions.ts       # POST /v1/completion
│   │   │   ├── embeddings.ts        # POST /v1/embedding
│   │   │   └── health.ts            # GET /health
│   │   ├── middleware/
│   │   │   ├── auth.ts              # API key authentication
│   │   │   ├── rateLimiter.ts       # Token-aware rate limiting
│   │   │   ├── idempotency.ts       # Idempotency key handling
│   │   │   └── requestId.ts         # Trace ID injection
│   │   └── plugins/
│   │       └── tenantContext.ts      # Tenant resolution from API key
│   ├── router/
│   │   ├── smartRouter.ts           # Main routing orchestrator
│   │   ├── complexityAnalyzer.ts    # Request complexity scoring
│   │   ├── costOptimizer.ts         # Model cost comparison
│   │   └── modelRegistry.ts         # Available models + capabilities
│   ├── cache/
│   │   ├── semanticCache.ts         # pgvector similarity cache
│   │   ├── embeddingService.ts      # Generate embeddings for queries
│   │   └── coalescer.ts             # Request deduplication
│   ├── providers/
│   │   ├── base.ts                  # Abstract provider interface
│   │   ├── openai.ts                # OpenAI adapter
│   │   ├── anthropic.ts             # Anthropic/Claude adapter
│   │   ├── google.ts                # Google Gemini adapter
│   │   ├── cohere.ts                # Cohere adapter
│   │   └── registry.ts              # Provider registry + key rotation
│   ├── resilience/
│   │   ├── circuitBreaker.ts        # Per-provider circuit breaker
│   │   ├── fallbackChain.ts         # Degradation chain
│   │   ├── offlineQueue.ts          # BullMQ offline queue
│   │   └── retryPolicy.ts          # Exponential backoff + jitter
│   ├── billing/
│   │   ├── tracker.ts               # Per-request cost tracking
│   │   ├── usageAggregator.ts       # Roll-up usage stats
│   │   └── limits.ts                # Spending limits + alerts
│   ├── observability/
│   │   ├── logger.ts                # Pino structured logging
│   │   ├── metrics.ts               # Prometheus metrics
│   │   └── tracing.ts               # Request tracing
│   ├── db/
│   │   ├── client.ts                # Drizzle client
│   │   ├── schema.ts                # All table definitions
│   │   └── migrations/              # SQL migrations
│   └── types/
│       ├── api.ts                   # API request/response types
│       ├── provider.ts              # Provider interface types
│       └── tenant.ts                # Tenant/billing types
├── tests/
│   ├── unit/
│   │   ├── router/
│   │   ├── cache/
│   │   ├── providers/
│   │   └── resilience/
│   └── integration/
│       ├── api.test.ts
│       └── billing.test.ts
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── drizzle.config.ts
├── tsconfig.json
├── package.json
├── vitest.config.ts
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

## Database Schema (Core Tables)

```sql
-- Tenants (businesses using AfrAI)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    tier VARCHAR(50) NOT NULL DEFAULT 'free',  -- free, starter, growth, enterprise
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API Keys (multiple per tenant)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_hash VARCHAR(64) NOT NULL UNIQUE,    -- SHA-256 of the key (never store raw)
    key_prefix VARCHAR(12) NOT NULL,          -- "afr_live_abc" for display
    name VARCHAR(255),
    scopes TEXT[] DEFAULT '{"completions","embeddings"}',
    rate_limit_rpm INTEGER DEFAULT 60,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Semantic Cache
CREATE TABLE semantic_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    query_embedding vector(1536),            -- pgvector embedding
    query_hash VARCHAR(64) NOT NULL,          -- Fast exact-match check
    query_text TEXT NOT NULL,
    response_text TEXT NOT NULL,
    model_used VARCHAR(100) NOT NULL,
    token_count INTEGER NOT NULL,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_cache_embedding ON semantic_cache 
    USING ivfflat (query_embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_cache_tenant_hash ON semantic_cache (tenant_id, query_hash);

-- Usage Logs (append-only, partitioned by month)
CREATE TABLE usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    request_id VARCHAR(36) NOT NULL,
    model VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd NUMERIC(12, 8) NOT NULL,        -- Precise to 8 decimal places
    latency_ms INTEGER NOT NULL,
    cache_hit BOOLEAN DEFAULT false,
    complexity_score REAL,
    status VARCHAR(20) NOT NULL,              -- success, fallback, cached, queued, error
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Provider Health (circuit breaker state)
CREATE TABLE provider_health (
    provider VARCHAR(50) PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'closed',  -- closed, open, half_open
    failure_count INTEGER DEFAULT 0,
    last_failure_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    avg_latency_ms INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Billing (monthly aggregates)
CREATE TABLE billing_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_requests INTEGER DEFAULT 0,
    cached_requests INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost_usd NUMERIC(12, 4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',     -- active, invoiced, paid
    UNIQUE(tenant_id, period_start)
);
```

## Rate Limiting Strategy

Token-bucket algorithm with Redis, per-tenant:
- **Free tier:** 60 req/min, 10K tokens/day
- **Starter:** 300 req/min, 100K tokens/day
- **Growth:** 1000 req/min, 1M tokens/day
- **Enterprise:** Custom limits

Rate limiting is **token-aware**: a request using 4K tokens costs more capacity than one using 100 tokens.

## Smart Routing Algorithm

```
1. Receive request
2. Extract features:
   - Message length (tokens)
   - Presence of: code, math, reasoning words, simple Q&A patterns
   - Requested capabilities (JSON mode, function calling, etc.)
   - Language detection
3. Score complexity: 0.0 (trivial) → 1.0 (expert)
4. Filter eligible models:
   - Supports required capabilities
   - Provider circuit breaker is CLOSED
   - Within tenant's tier allowance
5. Rank by: cost × (1 + latency_weight) 
   - Prefer cheapest model that meets complexity threshold
6. Select top model, with fallback chain ready
```

## Semantic Cache Algorithm

```
1. Receive query
2. Generate embedding (text-embedding-3-small, cached locally)
3. Fast path: exact hash match? → return cached response
4. Slow path: pgvector cosine similarity search
   - WHERE tenant_id = $1
   - AND expires_at > NOW()
   - ORDER BY query_embedding <=> $2
   - LIMIT 1
5. If similarity > 0.95 → cache HIT (return cached, log saving)
6. If similarity < 0.95 → cache MISS (continue to router)
7. After completion: store response + embedding in cache
```

## Circuit Breaker States

```
CLOSED (normal) ──[5 failures in 60s]──→ OPEN (blocking)
                                              │
                                    [30s cooldown]
                                              │
                                              ▼
                                        HALF_OPEN (testing)
                                       /              \
                              [success]                [failure]
                                 │                        │
                                 ▼                        ▼
                              CLOSED                    OPEN
```

Each provider has its own circuit breaker. When OPEN, requests skip that provider entirely and use the fallback chain.

## Request Coalescing

When multiple tenants send semantically identical requests within a 2-second window:
1. First request proceeds normally
2. Subsequent identical requests are "parked" (Promise waiting)
3. When the first response arrives, ALL parked requests receive the same response
4. Each tenant is billed individually (fair billing)
5. One API call serves N tenants

This is especially powerful for common queries across businesses.
