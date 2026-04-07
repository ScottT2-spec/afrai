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

-- Semantic Cache (with drift protection)
CREATE TABLE semantic_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    query_embedding vector(384),             -- Local ONNX model (all-MiniLM-L6-v2, 384 dims)
    query_hash VARCHAR(64) NOT NULL,          -- SHA-256 for fast exact-match
    query_text TEXT NOT NULL,
    response_text TEXT NOT NULL,
    model_used VARCHAR(100) NOT NULL,
    token_count INTEGER NOT NULL,
    hit_count INTEGER DEFAULT 0,
    intent_category VARCHAR(100),             -- Drift guard: query intent classification
    geo_context VARCHAR(100),                 -- Drift guard: geographic context (if detected)
    entities TEXT[],                           -- Drift guard: extracted named entities
    embedding_model_version VARCHAR(50) NOT NULL DEFAULT 'minilm-v2', -- For version migration
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_cache_embedding ON semantic_cache 
    USING ivfflat (query_embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_cache_tenant_hash ON semantic_cache (tenant_id, query_hash);
CREATE INDEX idx_cache_tenant_intent ON semantic_cache (tenant_id, intent_category, geo_context);

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

### Token-Aware Rate Limiting: The Reservation System

**The Problem:** You can't know `output_tokens` until the response finishes streaming.
But you need to enforce token limits BEFORE the request starts. Classic chicken-and-egg.

**The Fix — Reserve → Execute → Refund:**

```
1. REQUEST ARRIVES
   │
   ├─ Estimate max possible tokens:
   │   reserved_tokens = input_tokens + min(requested_max_tokens, model_max_output)
   │
   ├─ Check tenant's token bucket:
   │   IF bucket.available >= reserved_tokens → RESERVE (deduct from bucket)
   │   ELSE → 429 Too Many Requests (with Retry-After header)
   │
2. EXECUTE REQUEST (stream/complete)
   │
3. RESPONSE FINISHED
   │
   ├─ actual_tokens = input_tokens + output_tokens
   ├─ unused = reserved_tokens - actual_tokens
   │
   └─ REFUND unused tokens back to Redis bucket
       HINCRBY tenant:{id}:tokens:bucket {unused}
```

**Why this works:**
- Tenant never exceeds their limit (reservation guarantees it)
- Tenant isn't penalized unfairly (refund returns unused capacity)
- All operations are atomic Redis commands (no race conditions)
- Works with streaming (refund happens when stream closes)

**Edge case:** If the server crashes mid-request, reserved tokens are "lost" until the
bucket refills on its natural schedule. This is acceptable — it's a brief capacity
reduction, not data loss. A background job can reclaim orphaned reservations after 5min.

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
2. Fast path: exact SHA-256 hash match? → return cached response (zero latency cost)
3. Generate embedding via LOCAL ONNX model (not API call — see Cold Start fix below)
   - ~5-10ms local inference vs 50-200ms API round-trip
4. pgvector cosine similarity search with COMPOUND FILTERING:
   - WHERE tenant_id = $1
   - AND intent_category = $2        ← prevents cross-intent drift
   - AND geo_context = $3            ← prevents cross-geography drift (when present)
   - AND expires_at > NOW()
   - ORDER BY query_embedding <=> $4
   - LIMIT 1
5. If similarity > 0.97 → cache HIT (return cached, log saving)
   - Threshold raised from 0.95 → 0.97 to prevent semantic drift
   - Additional: entity extraction check (named entities in query must match cached query)
6. If similarity < 0.97 → cache MISS (continue to router)
7. After completion: store response + embedding + intent_category + geo_context in cache
```

### Cache Safety: Preventing Semantic Drift

**The Problem:** "How do I pay my tax in Accra?" and "How do I pay my tax in Lagos?" 
produce embeddings with >0.95 similarity — but the answers are completely different.

**The Fix — Multi-Layer Cache Matching:**

```
Layer 1: Exact Hash    → Instant match (identical queries)
Layer 2: Entity Guard  → Extract named entities (locations, currencies, names, dates)
                         If entities DON'T match → force cache MISS, even if embeddings match
Layer 3: Intent Tag    → Classify query intent (tax_payment, inventory, pricing, etc.)
                         Cache is partitioned by intent — tax queries never match inventory queries
Layer 4: Geo Context   → If query contains geographic signals, partition cache by region
                         "Accra tax" and "Lagos tax" live in separate cache partitions
Layer 5: Embedding     → Cosine similarity at 0.97 threshold (stricter than industry standard 0.95)
```

ALL layers must pass for a cache hit. This means:
- Semantically similar but factually different queries → MISS (correct)
- Truly identical intent with same entities and geography → HIT (correct)
- Cost of false misses (extra API calls) is far less than cost of false hits (wrong answers)

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

## Stress Test Mitigations

### 1. Cold Start: Embedding Latency

**The Problem:** Generating an embedding via API (OpenAI text-embedding-3-small) adds 
50-200ms latency. On a cache MISS, the request is now slower than calling OpenAI directly.
That kills the "Stripe-fast" feel.

**The Fix — Local ONNX Embedding Model:**

```
┌─────────────────────────────────────────────────┐
│            Embedding Strategy                    │
│                                                  │
│  PRIMARY: Local ONNX model (all-MiniLM-L6-v2)  │
│  ├─ Runs in-process via onnxruntime-node        │
│  ├─ ~5-10ms per embedding (vs 50-200ms API)     │
│  ├─ 384 dimensions (smaller, faster index)      │
│  ├─ Zero network dependency                     │
│  └─ Loaded once at startup, stays in memory     │
│                                                  │
│  FALLBACK: OpenAI text-embedding-3-small        │
│  ├─ Higher quality (1536 dimensions)            │
│  ├─ Used for re-indexing / batch operations     │
│  └─ Never on the hot path                       │
│                                                  │
│  The hot path (every request) uses LOCAL only.  │
│  API embeddings are for background tasks.        │
└─────────────────────────────────────────────────┘
```

**Latency budget for a cache HIT:**
- Receive request: ~1ms
- Auth + rate limit (Redis): ~2ms
- Exact hash check (Redis): ~1ms
- Local embedding generation: ~5-10ms
- pgvector similarity search: ~5-15ms
- **Total: ~15-30ms** (faster than any direct AI API call)

**Latency budget for a cache MISS:**
- All of the above: ~15-30ms
- Smart routing decision: ~1ms
- Provider API call: 500-5000ms (the actual AI inference)
- **Total: ~520-5030ms** (overhead is <30ms — negligible vs provider latency)

The embedding cost is invisible compared to the AI call itself. And on cache HITs,
the response is 10-100x faster than going to any provider.

### 2. Semantic Cache Drift (Solved Above)

See "Cache Safety: Preventing Semantic Drift" section.
Multi-layer matching (entity guard + intent tag + geo context + strict 0.97 threshold)
ensures "tax in Accra" never serves "tax in Lagos."

### 3. Token-Aware Rate Limiting (Solved Above)

See "Token-Aware Rate Limiting: The Reservation System" section.
Reserve → Execute → Refund pattern handles the unknown-output-tokens problem
with atomic Redis operations and automatic orphan reclamation.

### 4. Additional Stress Points Addressed

**Thundering Herd on Provider Recovery:**
When a circuit breaker transitions from OPEN → HALF_OPEN, ALL queued requests
could slam the provider simultaneously. Fix: HALF_OPEN allows only 1 test request.
On success, drain queued requests with rate limiting (BullMQ limiter: 50/min).

**Multi-Region Cache Consistency:**
When deployed across regions, cache entries are local to each region.
No cross-region cache sharing — avoids latency and consistency headaches.
Each region builds its own cache organically from its traffic patterns.

**Embedding Model Version Drift:**
If you upgrade the local ONNX model, all existing cache embeddings become
incompatible (different vector space). Fix: cache entries include `embedding_model_version`.
On model upgrade, old entries gracefully expire via TTL while new entries use the new model.
No manual migration needed.

---

## Adaptive Learning Router (Self-Optimizing Intelligence)

The static router is version 1. The real moat is a router that **learns from itself.**

### How It Learns

```
Every completed request generates a feedback signal:
┌─────────────────────────────────────────────────────────────────┐
│  REQUEST METADATA              │  OUTCOME SIGNAL                │
│  ─────────────────             │  ────────────────              │
│  • Input token count           │  • Latency (ms)               │
│  • Message complexity features │  • Output quality score       │
│  • Language detected           │  • Cost (USD)                 │
│  • Intent category             │  • Finish reason              │
│  • Tenant tier                 │  • User feedback (if provided)│
│  • Time of day                 │  • Error? Retry? Fallback?    │
│  • Model selected              │  • Cache hit on NEXT similar  │
│  • Provider used               │    request? (delayed signal)  │
└─────────────────────────────────────────────────────────────────┘

This data feeds into a lightweight online learning model:
  - Gradient Boosted Decision Tree (XGBoost, ~2MB model)
  - Retrained every 6 hours on rolling 7-day window
  - Predicts: P(success | model, complexity, features) and E[cost]
  - Deployed via ONNX alongside the embedding model (same runtime)
```

### Routing Decision v2 (Adaptive)

```
1. Extract features from request (same as v1)
2. For each eligible model, predict:
   a. P(success) — probability of successful completion
   b. E[latency] — expected latency in ms
   c. E[cost] — expected cost in USD
3. Score = P(success) × (1 / E[cost]) × (1 / E[latency])^latency_weight
4. Select highest-scoring model
5. Log the decision + outcome → feeds back into training data
```

### Cold Start (New Deployment)

Day 1 with no data: falls back to static rules (v1 router).
After ~10,000 requests: enough signal to train first model.
After ~100,000 requests: router is significantly outperforming static rules.
The system gets smarter every day without any manual tuning.

### Exploration vs. Exploitation

To avoid always picking the same model (and never discovering better options):
- **10% exploration rate:** randomly select a non-optimal model
- **Thompson Sampling:** Bayesian approach — models with uncertain performance get explored more
- Exploration rate decays as confidence increases per model-complexity pair
- New models added to the registry automatically get high exploration priority

---

## Multi-Region Architecture

AfrAI must run close to its users. A business in Nairobi shouldn't route through Europe.

### Regional Deployment

```
                    ┌──────────────────┐
                    │   GLOBAL LAYER   │
                    │  DNS (Cloudflare) │
                    │  GeoDNS routing   │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
   │  WEST AFRICA   │ │  EAST AFRICA   │ │  SOUTH AFRICA  │
   │  (Accra/Lagos) │ │  (Nairobi)     │ │  (Cape Town)   │
   │                │ │                │ │                │
   │  ┌──────────┐  │ │  ┌──────────┐  │ │  ┌──────────┐  │
   │  │ Gateway  │  │ │  │ Gateway  │  │ │  │ Gateway  │  │
   │  │ Instance │  │ │  │ Instance │  │ │  │ Instance │  │
   │  └────┬─────┘  │ │  └────┬─────┘  │ │  └────┬─────┘  │
   │       │        │ │       │        │ │       │        │
   │  ┌────┴─────┐  │ │  ┌────┴─────┐  │ │  ┌────┴─────┐  │
   │  │ Regional │  │ │  │ Regional │  │ │  │ Regional │  │
   │  │ Cache    │  │ │  │ Cache    │  │ │  │ Cache    │  │
   │  │ (PG+Vec) │  │ │  │ (PG+Vec) │  │ │  │ (PG+Vec) │  │
   │  └──────────┘  │ │  └──────────┘  │ │  └──────────┘  │
   │  ┌──────────┐  │ │  ┌──────────┐  │ │  ┌──────────┐  │
   │  │ Regional │  │ │  │ Regional │  │ │  │ Regional │  │
   │  │ Redis    │  │ │  │ Redis    │  │ │  │ Redis    │  │
   │  └──────────┘  │ │  └──────────┘  │ │  └──────────┘  │
   └────────────────┘ └────────────────┘ └────────────────┘
            │                │                │
            └────────────────┼────────────────┘
                             │
                    ┌────────┴─────────┐
                    │  CENTRAL CONTROL │
                    │  PLANE           │
                    │                  │
                    │  • Tenant DB     │
                    │    (primary)     │
                    │  • Billing       │
                    │    aggregation   │
                    │  • Router model  │
                    │    distribution  │
                    │  • Config sync   │
                    └──────────────────┘
```

### Data Sovereignty

Different African countries have different data laws.
- **Nigeria (NDPR):** Personal data must be stored in Nigeria or with adequate safeguards
- **Kenya (DPA 2019):** Requires data localization for certain categories
- **South Africa (POPIA):** Strict consent and purpose limitation

AfrAI handles this at the tenant level:
```sql
ALTER TABLE tenants ADD COLUMN data_region VARCHAR(20) NOT NULL DEFAULT 'auto';
-- 'auto' = route to nearest region
-- 'ng' = Nigeria only
-- 'ke' = Kenya only
-- 'za' = South Africa only
-- 'global' = any region (tenant opted in)
```

Requests from region-locked tenants NEVER leave their region.
Cache entries are region-local by default.
Billing data is replicated to central but anonymized (no PII in aggregates).

### Regional Failover

If West Africa region goes down entirely:
1. DNS health check detects failure (~30s)
2. Traffic reroutes to nearest healthy region
3. Tenant data_region='auto' → served by East/South Africa
4. Tenant data_region='ng' → requests queued in offline queue (data sovereignty preserved)
5. When West Africa recovers → queue drains automatically

---

## Streaming Architecture

Real-time token-by-token streaming is essential for chat-like UIs.

### SSE (Server-Sent Events) Protocol

```
Client                          AfrAI Gateway                    AI Provider
  │                                │                                │
  ├─ POST /v1/completion ──────────►                                │
  │  {stream: true}                │                                │
  │                                ├─ Auth, rate limit, cache check │
  │                                │  (cache MISS for streaming)    │
  │                                │                                │
  │                                ├─ Select model via router ──────►
  │                                │                                │
  │  ◄─── SSE: event: chunk ──────┤◄── stream chunk ───────────────┤
  │       data: {"token": "The"}   │                                │
  │                                │                                │
  │  ◄─── SSE: event: chunk ──────┤◄── stream chunk ───────────────┤
  │       data: {"token": " tax"}  │                                │
  │                                │                                │
  │       ... (continues) ...      │                                │
  │                                │                                │
  │  ◄─── SSE: event: done ───────┤◄── stream end ─────────────────┤
  │       data: {usage: {...},     │                                │
  │              cost_usd: 0.003}  │                                │
  │                                │                                │
  │                                ├─ Post-stream:                  │
  │                                │  • Cache full response         │
  │                                │  • Bill tenant                 │
  │                                │  • Refund reserved tokens      │
  │                                │  • Log usage                   │
  └────────────────────────────────┘────────────────────────────────┘
```

### Backpressure Handling

If the client can't consume tokens as fast as the provider sends them:
- Gateway buffers up to 64KB per connection
- If buffer exceeds limit → pause upstream provider stream
- When client drains buffer → resume upstream
- If client disconnects mid-stream:
  - Cancel upstream request (save cost)
  - Bill only for tokens already generated
  - Refund remaining reservation
  - Log partial completion

### Partial Cache Hits (Streaming)

For streaming requests, full semantic cache is less useful (user wants real-time feel).
Instead: **Predictive Prefetch**
- While streaming from provider, check cache for similar completed queries
- If found, use cached response to pre-warm the stream buffer
- Result: first tokens arrive faster, user perceives lower latency

---

## Tenant Compute Isolation

### The Noisy Neighbor Problem

Without isolation, one tenant sending 10,000 requests can starve all others.

```
┌─────────────────────────────────────────────────────────────────┐
│                    ISOLATION LAYERS                              │
│                                                                  │
│  Layer 1: Rate Limiting (Redis)                                 │
│  ├─ Per-tenant request rate cap                                 │
│  ├─ Per-tenant token budget (Reserve-Refund)                    │
│  └─ Global rate limit (protect AfrAI itself)                    │
│                                                                  │
│  Layer 2: Connection Pooling                                    │
│  ├─ Shared pool: 80% of DB connections                          │
│  ├─ Enterprise dedicated pool: 20% reserved                     │
│  └─ Per-tenant max connections (prevent monopolization)         │
│                                                                  │
│  Layer 3: Queue Priority                                        │
│  ├─ Enterprise: priority 1 (always first)                       │
│  ├─ Growth: priority 3                                          │
│  ├─ Starter: priority 5                                         │
│  ├─ Free: priority 10 (best effort)                             │
│  └─ Within same priority: FIFO                                  │
│                                                                  │
│  Layer 4: Concurrency Semaphore                                 │
│  ├─ Each tenant has max concurrent requests                     │
│  │  Free: 5 | Starter: 20 | Growth: 50 | Enterprise: 200      │
│  ├─ Implemented as Redis SETNX with TTL                         │
│  └─ Request blocked at gateway if semaphore full (429)          │
│                                                                  │
│  Layer 5: Provider Key Isolation (Enterprise)                   │
│  ├─ Enterprise tenants can bring their own API keys             │
│  ├─ Their requests use THEIR keys → zero interference           │
│  └─ AfrAI still provides routing, caching, resilience           │
│                                                                  │
│  Layer 6: Cost Circuit Breaker                                  │
│  ├─ Per-tenant daily/monthly cost cap                           │
│  ├─ At 80%: warning webhook to tenant                           │
│  ├─ At 100%: requests rejected (402 Payment Required)           │
│  └─ Prevents runaway costs from bugs or attacks                 │
└─────────────────────────────────────────────────────────────────┘
```

### Resource Accounting

Every tenant has a real-time resource account in Redis:
```
tenant:{id}:rpm          → sliding window request count
tenant:{id}:tokens       → token budget (reserve/refund)
tenant:{id}:concurrent   → active request count (semaphore)
tenant:{id}:cost:daily   → running daily cost in USD
tenant:{id}:cost:monthly → running monthly cost in USD
```

All operations are atomic Lua scripts in Redis — no race conditions even at 100K req/s.

---

## Security Architecture

### Defense in Depth

```
┌─────────────────────────────────────────────────────────────────┐
│                     SECURITY LAYERS                             │
│                                                                  │
│  Layer 1: Edge (Cloudflare/CDN)                                 │
│  ├─ DDoS protection                                             │
│  ├─ WAF (Web Application Firewall) rules                        │
│  ├─ TLS termination (TLS 1.3 only)                             │
│  ├─ Geographic blocking (if needed)                             │
│  └─ Bot detection                                               │
│                                                                  │
│  Layer 2: API Gateway                                           │
│  ├─ API key authentication (SHA-256 hashed, never stored raw)  │
│  ├─ Key scoping (per-key permission: completions, embeddings)  │
│  ├─ Request size limits (max 1MB body)                          │
│  ├─ Header validation                                           │
│  └─ IP allowlisting (optional, per-tenant)                     │
│                                                                  │
│  Layer 3: Application                                           │
│  ├─ Input sanitization (Zod validation on ALL inputs)          │
│  ├─ SQL injection prevention (parameterized queries via Drizzle)│
│  ├─ Prompt injection detection (scan for system prompt leaks)  │
│  ├─ PII detection + redaction in logs                          │
│  └─ Idempotency enforcement (prevent replay attacks)           │
│                                                                  │
│  Layer 4: Data                                                  │
│  ├─ Encryption at rest (AES-256 for cache, PostgreSQL TDE)     │
│  ├─ Encryption in transit (TLS everywhere, mTLS between svcs)  │
│  ├─ API keys: only SHA-256 hash stored, raw key shown once     │
│  ├─ Tenant data isolation (row-level security in Postgres)     │
│  └─ PII never stored in usage logs (only tenant_id + metrics)  │
│                                                                  │
│  Layer 5: Audit                                                 │
│  ├─ Every API key creation, deletion, rotation → audit log     │
│  ├─ Every admin action → immutable audit trail                 │
│  ├─ Failed auth attempts tracked (auto-block after 10 in 1min)│
│  ├─ Anomaly detection: sudden usage spike → alert + throttle   │
│  └─ All logs retained 90 days minimum (compliance)             │
│                                                                  │
│  Layer 6: Secrets Management                                    │
│  ├─ Provider API keys in HashiCorp Vault / AWS Secrets Manager │
│  ├─ Zero secrets in code, config files, or environment vars    │
│  ├─ Automatic key rotation on schedule                         │
│  └─ Principle of least privilege on all service accounts       │
└─────────────────────────────────────────────────────────────────┘
```

### API Key Lifecycle

```
1. CREATION
   ├─ Generate: afr_live_ + 32 random bytes (base62 encoded)
   ├─ Hash: SHA-256(key + salt) → stored in DB
   ├─ Show raw key to tenant ONCE (never again)
   └─ Tenant stores it securely (their responsibility)

2. USAGE
   ├─ Request arrives with key in header: X-API-Key: afr_live_xxx
   ├─ Hash the incoming key: SHA-256(key + salt)
   ├─ Lookup hash in DB → resolve tenant
   ├─ Check: is_active? scopes? rate_limit?
   └─ Update last_used_at (async, non-blocking)

3. ROTATION
   ├─ Tenant creates new key (old key still active)
   ├─ Tenant migrates their systems to new key
   ├─ Tenant deactivates old key
   └─ Grace period: old key works for 24h after deactivation

4. REVOCATION
   ├─ Immediate: set is_active = false
   ├─ All in-flight requests with this key complete normally
   ├─ Next request with this key → 401 Unauthorized
   └─ Audit log entry created
```

### Prompt Injection Detection

Tenants send user content through AfrAI to AI models. Malicious users could try
to inject system prompts. AfrAI scans for this:

```
1. Pattern matching: detect phrases like "ignore previous instructions",
   "you are now", "system:", "<<SYS>>" in user messages
2. Anomaly detection: sudden change in message structure/length from a user
3. Sandboxing: tenant's system prompt is injected by AfrAI, not passable
   by the end-user through the API (system messages are tenant-only scope)
4. Response filtering: scan AI output for leaked system prompts or PII
```

---

## Observability Deep Dive

### The Three Pillars

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│  LOGS (Pino → Loki/ELK)                                        │
│  ├─ Structured JSON, every entry has request_id + tenant_id    │
│  ├─ Log levels enforced: ERROR for failures, WARN for retries  │
│  │  INFO for completions, DEBUG for routing decisions           │
│  ├─ Sensitive data redacted (API keys, PII, prompt content)    │
│  ├─ Correlation: request_id links logs across all layers       │
│  └─ Retention: 30 days hot, 90 days cold, 1 year archive      │
│                                                                  │
│  METRICS (Prometheus → Grafana)                                 │
│  ├─ System: CPU, memory, event loop lag, GC pauses             │
│  ├─ Business: requests/sec, cost/hour, cache hit rate          │
│  ├─ Provider: latency p50/p95/p99, error rate, circuit state   │
│  ├─ Tenant: top consumers, fastest growing, approaching limits │
│  └─ SLA: availability %, latency SLA compliance per tier       │
│                                                                  │
│  TRACES (OpenTelemetry → Jaeger/Tempo)                          │
│  ├─ Full request lifecycle: gateway → cache → router →         │
│  │  provider → billing → response                              │
│  ├─ Span per layer with timing                                 │
│  ├─ Cross-service trace propagation (multi-region)             │
│  └─ Trace sampling: 100% for errors, 10% for success          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Distributed Tracing: Full Request Lifecycle

```
Trace: req_abc123
│
├─ [gateway] 0ms─────────────────────────────────────── 1250ms
│  ├─ [auth] 0ms──── 3ms
│  │   └─ Redis GET api_key_hash
│  ├─ [rate_limit] 3ms──── 5ms
│  │   └─ Redis EVALSHA token_bucket.lua
│  ├─ [cache_check] 5ms──────────── 25ms
│  │   ├─ [exact_hash] 5ms── 7ms (MISS)
│  │   ├─ [embedding] 7ms────── 15ms (local ONNX)
│  │   ├─ [entity_extract] 15ms── 16ms (regex)
│  │   └─ [pgvector_search] 16ms───── 25ms (MISS)
│  ├─ [router] 25ms──── 27ms
│  │   ├─ [complexity_score] 25ms── 26ms → 0.4 (medium)
│  │   └─ [model_select] 26ms── 27ms → gpt-4o-mini
│  ├─ [provider_call] 27ms──────────────────────── 1200ms
│  │   ├─ [openai.complete] 27ms────────────────── 1180ms
│  │   │   └─ HTTP POST https://api.openai.com/v1/chat/completions
│  │   └─ [retry] (none needed)
│  ├─ [post_process] 1200ms────────── 1250ms
│  │   ├─ [cache_store] 1200ms── 1215ms
│  │   ├─ [billing_track] 1215ms── 1225ms
│  │   ├─ [token_refund] 1225ms── 1230ms
│  │   └─ [usage_log] 1230ms── 1250ms
│  └─ [response] → 200 OK, 1250ms total
```

### Alerting Rules

```yaml
Critical (PagerDuty / SMS):
  - availability < 99.5% over 5 minutes
  - all providers circuit breaker OPEN simultaneously
  - database connection pool exhausted
  - Redis unreachable
  - error rate > 10% over 2 minutes

Warning (Slack / Email):
  - single provider circuit breaker OPEN
  - cache hit rate drops below 20%
  - p99 latency > 10s over 5 minutes
  - tenant approaching cost limit (80%)
  - offline queue depth > 1000
  - disk usage > 80%

Info (Dashboard):
  - new tenant registered
  - model added/removed from registry
  - router model retrained
  - region failover triggered
```

### SLA Monitoring Per Tenant Tier

```
Enterprise: 99.99% availability, p95 < 2s   (53 min downtime/year)
Growth:     99.9%  availability, p95 < 3s   (8.7 hours downtime/year)
Starter:    99.5%  availability, p95 < 5s   (1.8 days downtime/year)
Free:       Best effort, no SLA guarantee
```

Real-time SLA tracking per tenant with automated credit issuance on SLA breach.

---

## Auto-Scaling Strategy

### Horizontal Scaling

```
┌─────────────────────────────────────────────────────────────────┐
│                    SCALING DIMENSIONS                            │
│                                                                  │
│  1. GATEWAY INSTANCES (stateless — scale freely)                │
│     ├─ Kubernetes HPA: scale on CPU > 60% or req/s > threshold │
│     ├─ Min: 3 instances (high availability)                     │
│     ├─ Max: 100 instances                                       │
│     └─ Scale-up: 30s, Scale-down: 5min (avoid flapping)       │
│                                                                  │
│  2. POSTGRESQL                                                   │
│     ├─ Primary: writes (tenants, billing, cache store)          │
│     ├─ Read replicas: reads (cache lookups, usage queries)      │
│     ├─ pgvector search → dedicated read replica                 │
│     ├─ Connection pooling via PgBouncer (transaction mode)      │
│     └─ Partitioning: usage_logs by month, cache by tenant_id   │
│                                                                  │
│  3. REDIS                                                        │
│     ├─ Redis Cluster (6+ nodes for HA)                          │
│     ├─ Sharding: tenant data spread across slots               │
│     ├─ Separate clusters for:                                   │
│     │   • Rate limiting (high write)                            │
│     │   • Cache hot keys (high read)                            │
│     │   • Queue (BullMQ persistence)                            │
│     └─ Memory policy: allkeys-lru for cache, noeviction for Q  │
│                                                                  │
│  4. BULLMQ WORKERS                                               │
│     ├─ Separate worker pool from gateway (don't compete)        │
│     ├─ Scale on queue depth: >100 pending → add workers         │
│     ├─ Rate limited: don't overwhelm providers on drain         │
│     └─ Priority processing: enterprise jobs first               │
│                                                                  │
│  5. EMBEDDING INFERENCE                                          │
│     ├─ ONNX model loaded per gateway instance (no extra service)│
│     ├─ At extreme scale: separate embedding microservice        │
│     │   with GPU instances for batch operations                 │
│     └─ Batch embedding requests in 50ms windows for throughput  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Scaling Thresholds

```
100 req/s    → 3 gateway, 1 PG primary, 1 Redis, 1 worker
1,000 req/s  → 10 gateway, 1 PG primary + 2 replicas, Redis cluster (3), 3 workers
10,000 req/s → 30 gateway, 1 PG primary + 5 replicas, Redis cluster (6), 10 workers
100,000 req/s → 100 gateway, PG with Citus/sharding, Redis cluster (12), 30 workers
                + dedicated pgvector instances + embedding microservice
```

### Database Partitioning Strategy

```sql
-- Usage logs partitioned by month (billions of rows over time)
CREATE TABLE usage_logs (
    ...
) PARTITION BY RANGE (created_at);

CREATE TABLE usage_logs_2026_04 PARTITION OF usage_logs
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE usage_logs_2026_05 PARTITION OF usage_logs
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- Auto-created by cron job 30 days ahead

-- Semantic cache partitioned by tenant (fast lookups, easy cleanup)
CREATE TABLE semantic_cache (
    ...
) PARTITION BY HASH (tenant_id);

-- 32 hash partitions — each partition holds ~3% of tenants
CREATE TABLE semantic_cache_p0 PARTITION OF semantic_cache
    FOR VALUES WITH (modulus 32, remainder 0);
-- ... through p31
```

### Connection Pooling Architecture

```
Gateway Instances (N)
    │
    │ Each instance: max 5 direct connections
    │
    ▼
PgBouncer (connection pooler)
    │
    │ Pool size: 100 connections
    │ Mode: transaction (connection returned after each query)
    │ Reserve: 20 connections for enterprise tenants
    │
    ▼
PostgreSQL Primary / Replicas
    │
    │ max_connections = 200
    │ shared_buffers = 25% RAM
    │ effective_cache_size = 75% RAM
```

This means 100 gateway instances share 100 DB connections via PgBouncer,
instead of each opening 20 → 2000 connections → DB dies.

---

## African Language Pipeline

This is the deepest moat. The thing nobody else will build.

### The Language Gap

Major African languages with 10M+ speakers and near-zero quality AI support:

| Language | Speakers | Countries | Current AI Quality |
|----------|----------|-----------|-------------------|
| Swahili | 100M+ | Kenya, Tanzania, DRC, Uganda | Moderate |
| Hausa | 80M+ | Nigeria, Niger, Ghana | Poor |
| Yoruba | 45M+ | Nigeria, Benin | Poor |
| Igbo | 30M+ | Nigeria | Very Poor |
| Amharic | 30M+ | Ethiopia | Poor |
| Twi/Akan | 20M+ | Ghana | Very Poor |
| Zulu | 12M+ | South Africa | Poor |
| Pidgin | 75M+ | Nigeria, Cameroon, Ghana | Almost None |

### Strategy: Fine-Tune, Don't Train From Scratch

```
┌─────────────────────────────────────────────────────────────────┐
│               AFRICAN LANGUAGE PIPELINE                         │
│                                                                  │
│  Phase 1: Data Collection                                       │
│  ├─ Partner with African universities for text corpora          │
│  ├─ Scrape public African news sites, government docs           │
│  ├─ Crowdsource: pay native speakers to validate translations   │
│  ├─ Business-specific: collect domain terms from AfrAI tenants │
│  │   (with consent — anonymized, aggregated)                    │
│  └─ Target: 1M+ sentence pairs per language                     │
│                                                                  │
│  Phase 2: Fine-Tuning                                           │
│  ├─ Base model: Llama 3 8B (open source, fine-tune friendly)   │
│  ├─ Method: LoRA (Low-Rank Adaptation)                          │
│  │   • Only trains ~0.1% of parameters                         │
│  │   • Can run on a single A100 GPU (~$2/hour on cloud)       │
│  │   • Produces a small adapter file (~50MB per language)      │
│  ├─ Fine-tune on: business terminology, local idioms,           │
│  │   currency formats, address formats, cultural context        │
│  └─ Evaluation: BLEU score + human evaluation by native speakers│
│                                                                  │
│  Phase 3: Serving                                                │
│  ├─ Deploy fine-tuned models on regional GPU instances          │
│  │   (Nairobi serves Swahili, Lagos serves Yoruba/Hausa/Pidgin)│
│  ├─ Models registered in AfrAI model registry alongside        │
│  │   OpenAI/Anthropic/Google                                    │
│  ├─ Smart router auto-detects language → routes to local model  │
│  ├─ Cost: near-zero per request (self-hosted, no API fees)     │
│  └─ Latency: lower than cloud APIs (local to region)           │
│                                                                  │
│  Phase 4: Continuous Improvement                                 │
│  ├─ Collect feedback from tenants on African language quality   │
│  ├─ RLHF (Reinforcement Learning from Human Feedback)          │
│  │   with African native speakers                               │
│  ├─ Retrain quarterly with accumulated data                     │
│  └─ Community contribution: open-source the language datasets  │
│      (build goodwill + attract contributors)                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Language Detection in the Hot Path

```
1. Request arrives
2. Language detection (fasttext model, <1ms, local):
   - Detected: "tw" (Twi)
   - Confidence: 0.92
3. If African language detected with high confidence:
   - Route to self-hosted fine-tuned model (free, fast, accurate)
   - Fallback: GPT-4 with language instruction in system prompt
4. If English/French/Portuguese:
   - Route normally via smart router
5. If mixed language (code-switching, common in Africa):
   - Route to fine-tuned model (trained on code-switching patterns)
```

This pipeline means a Ghanaian shop owner can ask "Me inventory no dey finish?" (Pidgin)
and get an accurate, contextual answer. No other AI infrastructure can do this.

---

## SDK & Developer Experience

### SDK Design (Node.js Example)

```javascript
import { AfrAI } from 'afrai';

// Initialize — ONE line
const ai = new AfrAI('afr_live_abc123xyz');

// Simple completion — let AfrAI handle everything
const answer = await ai.complete('What products are running low?', {
  context: { store_id: 'store_001', location: 'Accra' }
});

// Streaming
const stream = await ai.stream('Summarize this month sales');
for await (const chunk of stream) {
  process.stdout.write(chunk.text);
}

// With specific model (override smart routing)
const analysis = await ai.complete('Analyze lending risk', {
  model: 'claude-sonnet',
  json: true
});

// African language
const twi = await ai.complete('Inventory biara a ɛresesa?', {
  language: 'tw'  // Optional — auto-detected anyway
});

// Embeddings
const vectors = await ai.embed(['product A', 'product B']);

// Usage stats
const usage = await ai.usage.today();
console.log(`Cost: $${usage.cost_usd}, Saved: $${usage.cache_savings_usd}`);
```

### SDKs to Build

| SDK | Priority | Why |
|-----|----------|-----|
| JavaScript/TypeScript | P0 (first) | Most web apps, Node.js backends |
| Python | P0 | Data science, ML teams, Django/Flask apps |
| REST API docs | P0 | Any language can use raw HTTP |
| PHP | P1 | Massive in Africa (WordPress, Laravel) |
| Java/Kotlin | P1 | Android apps, enterprise |
| Swift | P2 | iOS apps |
| Go | P2 | Infrastructure teams |
| cURL examples | P0 | Universal, documentation essential |

### API Documentation (OpenAPI 3.1)

Auto-generated from Fastify route schemas via @fastify/swagger.
Interactive docs at `https://api.afrai.dev/docs`.

Every endpoint includes:
- Request/response schema with examples
- Error codes and meanings
- Rate limit headers explanation
- Code examples in 5+ languages
- "Try it" interactive console

---

## Billing & Monetization Engine

### Pricing Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     PRICING TIERS                               │
│                                                                  │
│  FREE        │ $0/mo    │ 10K tokens/day, economy models only  │
│  STARTER     │ $29/mo   │ 100K tokens/day, standard models     │
│  GROWTH      │ $149/mo  │ 1M tokens/day, premium models, SLA   │
│  ENTERPRISE  │ Custom   │ Unlimited, dedicated, BYOK, 99.99%   │
│                                                                  │
│  Overage: billed per 1K tokens at tier rate                     │
│  African language models: same price (subsidized by cache savings)│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Real-Time Billing Pipeline

```
Request completes
    │
    ├─ Calculate cost:
    │   cost = (input_tokens × model.costPer1kInput / 1000)
    │        + (output_tokens × model.costPer1kOutput / 1000)
    │   If cache hit: cost = 0
    │
    ├─ Atomic Redis update:
    │   HINCRBY tenant:{id}:billing:daily cost_microdollars {cost_μ$}
    │   HINCRBY tenant:{id}:billing:monthly cost_microdollars {cost_μ$}
    │
    ├─ Check limits (async, non-blocking):
    │   IF daily_cost > tenant.daily_limit × 0.8 → send warning webhook
    │   IF daily_cost > tenant.daily_limit → reject next request (402)
    │
    └─ Batch flush to PostgreSQL every 60s:
        Aggregate Redis counters → INSERT into billing_periods
        (Don't hit PG on every request — batch for performance)
```

### Invoice Generation

Monthly cron job:
1. Aggregate all usage for the billing period
2. Calculate: base plan + overage charges - credits (SLA breaches)
3. Generate PDF invoice
4. Send via email + available in dashboard
5. Integration with payment providers:
   - Paystack (Ghana, Nigeria) — local cards + mobile money
   - Flutterwave (Pan-African)
   - Stripe (international cards)
   - USSD payment codes (for businesses without cards)

---

## Deployment Architecture

### Container Orchestration (Kubernetes)

```yaml
# Production deployment topology
Namespace: afrai-prod

Deployments:
  gateway:           # API Gateway (Fastify)
    replicas: 3-100 (HPA)
    resources:
      cpu: 500m-2000m
      memory: 512Mi-2Gi
    probes:
      liveness: /health
      readiness: /health/ready
    
  worker:            # BullMQ offline queue workers
    replicas: 1-30 (based on queue depth)
    resources:
      cpu: 250m-1000m
      memory: 256Mi-1Gi
    
  embedding:         # ONNX embedding service (at scale)
    replicas: 2-10
    resources:
      cpu: 1000m-4000m  # CPU-intensive inference
      memory: 1Gi-4Gi

StatefulSets:
  postgresql:
    replicas: 3 (1 primary + 2 replicas)
    storage: 100Gi-10Ti (auto-expand)
    
  redis:
    replicas: 6 (Redis Cluster)
    storage: 10Gi-500Gi

CronJobs:
  billing-aggregator:  every 1 hour
  cache-cleanup:       every 6 hours
  router-retrain:      every 6 hours
  partition-creator:   every 24 hours (create next month's partitions)
  usage-archiver:      every 24 hours (move old data to cold storage)

Ingress:
  api.afrai.dev → gateway service
  dashboard.afrai.dev → dashboard frontend
```

### CI/CD Pipeline

```
Developer pushes code
    │
    ├─ GitHub Actions triggers:
    │   ├─ TypeScript typecheck
    │   ├─ ESLint
    │   ├─ Unit tests (Vitest)
    │   ├─ Integration tests (Docker Compose: PG + Redis + Gateway)
    │   ├─ Load test (k6: 1000 req/s for 60s against staging)
    │   └─ Security scan (Snyk / Trivy)
    │
    ├─ All pass? → Build Docker image → Push to registry
    │
    ├─ Deploy to STAGING
    │   ├─ Automated smoke tests
    │   ├─ Canary: 5% traffic for 30 minutes
    │   └─ Monitor: error rate, latency, cost anomalies
    │
    ├─ Staging healthy? → Deploy to PRODUCTION
    │   ├─ Rolling update (zero downtime)
    │   ├─ Canary: 10% traffic for 1 hour
    │   ├─ Full rollout if healthy
    │   └─ Auto-rollback if error rate > 1%
    │
    └─ Post-deploy:
        ├─ Notify team (Slack)
        ├─ Update changelog
        └─ Tag release in Git
```

### Disaster Recovery

```
RPO (Recovery Point Objective): < 1 hour
RTO (Recovery Time Objective): < 15 minutes

Backups:
  PostgreSQL: continuous WAL archiving to S3 (point-in-time recovery)
  Redis: RDB snapshots every 15 minutes + AOF persistence
  Config: version-controlled in Git (infrastructure as code)

Recovery Procedure:
  1. Detect failure (automated health checks, <30s)
  2. Route traffic to healthy region (DNS failover, <60s)
  3. Restore from backup if data loss detected
  4. Validate data integrity
  5. Resume traffic
  
Total: service restored in < 5 minutes for regional failover,
       < 15 minutes for full disaster recovery
```

---

## Migration & Versioning Strategy

### API Versioning

```
https://api.afrai.dev/v1/completion   ← current
https://api.afrai.dev/v2/completion   ← future (breaking changes)

Rules:
  - v1 supported for minimum 2 years after v2 launch
  - Non-breaking additions (new fields, new optional params) → same version
  - Breaking changes (removed fields, changed behavior) → new version
  - Deprecation warnings in response headers 6 months before removal
  - SDK handles version negotiation automatically
```

### Database Migrations

```
All schema changes via Drizzle migrations:
  - Forward-only (no rollback migrations — too dangerous)
  - Every migration tested against production-size dataset in staging
  - Zero-downtime migrations:
    1. Add new column (nullable)
    2. Deploy code that writes to both old + new
    3. Backfill new column
    4. Deploy code that reads from new
    5. Drop old column (weeks later)
  - Never alter a column type in production — add new, migrate, drop old
```

---

## Complete System Flow: Request Lifecycle

```
                        A single request through AfrAI:
                        ════════════════════════════════

     ┌─── TENANT APP ───────────────────────────────────────────────┐
     │  POST /v1/completion                                         │
     │  Headers: X-API-Key: afr_live_xxx                           │
     │           X-Idempotency-Key: idem_abc123                    │
     │  Body: {messages: [...], cache: "auto", priority: "normal"} │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  1. EDGE (Cloudflare)                                       │
     │     ├─ DDoS check ✓                                         │
     │     ├─ TLS termination ✓                                    │
     │     ├─ GeoDNS → route to nearest region ✓                  │
     │     └─ Forward to gateway instance                          │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  2. GATEWAY                                                  │
     │     ├─ Generate request_id: req_xK9mP2...                   │
     │     ├─ Start trace span                                     │
     │     ├─ Validate body (Zod schema) ✓                         │
     │     └─ Inject request context                               │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  3. AUTHENTICATION                                           │
     │     ├─ Hash API key: SHA-256(key + salt)                    │
     │     ├─ Redis lookup: GET apikey:{hash} → tenant context     │
     │     │  (cached for 5min, DB fallback on miss)               │
     │     ├─ Check: is_active? correct scopes?                    │
     │     ├─ Update last_used_at (async)                          │
     │     └─ Attach TenantContext to request                      │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  4. IDEMPOTENCY CHECK                                        │
     │     ├─ Key provided? Check: GET idempotency:{tenant}:{key}  │
     │     ├─ Found? → Return cached response immediately (fast)   │
     │     └─ Not found? → Continue (will store response after)    │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  5. RATE LIMITING                                            │
     │     ├─ Check RPM: EVALSHA sliding_window.lua tenant:{id}    │
     │     ├─ Estimate tokens → Reserve from budget                │
     │     ├─ Check concurrency semaphore                          │
     │     ├─ Check daily cost limit                               │
     │     └─ Any limit hit? → 429 with Retry-After header        │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  6. SEMANTIC CACHE                                           │
     │     ├─ Fast path: SHA-256 exact hash → Redis lookup (~1ms) │
     │     │  HIT? → Return cached response (cost = $0) ──────►DONE│
     │     ├─ Generate embedding (local ONNX, ~5-10ms)            │
     │     ├─ Extract entities (regex, ~0.1ms)                     │
     │     ├─ Classify intent (lightweight model, ~1ms)            │
     │     ├─ pgvector search with compound filter:                │
     │     │  WHERE tenant + intent + geo + similarity > 0.97     │
     │     │  Entity guard: verify named entities match            │
     │     │  HIT? → Return cached response (cost = $0) ──────►DONE│
     │     └─ MISS → Continue to router                            │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  7. REQUEST COALESCING                                       │
     │     ├─ Hash request content                                 │
     │     ├─ Check: another identical request in-flight?          │
     │     │  YES → Park this request (await Promise) ──────►MERGE │
     │     └─ NO → Continue (this request becomes the "leader")   │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  8. SMART ROUTER                                             │
     │     ├─ Detect language (fasttext, <1ms)                     │
     │     │  African language? → prefer self-hosted fine-tuned    │
     │     ├─ Analyze complexity (features → XGBoost model)        │
     │     │  Score: 0.0 (trivial) → 1.0 (expert)                │
     │     ├─ Filter eligible models:                              │
     │     │  ├─ Supports required capabilities                   │
     │     │  ├─ Provider circuit breaker CLOSED or HALF_OPEN     │
     │     │  └─ Within tenant tier access                        │
     │     ├─ Rank by: P(success) × (1/cost) × (1/latency)       │
     │     ├─ Select primary model + build fallback chain          │
     │     └─ Decision logged for adaptive learning feedback       │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  9. PROVIDER CALL (via Fallback Chain)                       │
     │     ├─ Try primary: e.g., gpt-4o-mini via OpenAI adapter   │
     │     │  ├─ Circuit breaker check ✓                          │
     │     │  ├─ API key rotation (pick healthy key)              │
     │     │  ├─ HTTP call with timeout (30s)                     │
     │     │  ├─ Retry policy: 3 attempts, exponential + jitter   │
     │     │  └─ SUCCESS? → Continue to post-processing           │
     │     │                                                       │
     │     ├─ Primary FAILED? Try fallback model                   │
     │     │  ├─ e.g., claude-haiku via Anthropic adapter         │
     │     │  └─ Same retry + circuit breaker logic                │
     │     │                                                       │
     │     ├─ All providers FAILED? Try stale cache                │
     │     │  ├─ pgvector search with relaxed threshold (0.90)    │
     │     │  └─ Return with header: X-AfrAI-Stale: true         │
     │     │                                                       │
     │     └─ Everything FAILED? Queue for offline processing      │
     │        ├─ BullMQ: persist request to Redis queue           │
     │        ├─ Return 202 Accepted + estimated delivery time    │
     │        └─ Webhook delivery when eventually processed        │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  10. POST-PROCESSING (all async/parallel)                    │
     │     ├─ Store in semantic cache (embedding + metadata)       │
     │     ├─ Store idempotency key → response (TTL: 24h)         │
     │     ├─ Track billing: atomic Redis HINCRBY                  │
     │     ├─ Refund unused token reservation                     │
     │     ├─ Release concurrency semaphore                       │
     │     ├─ Log usage to PostgreSQL (batched)                   │
     │     ├─ Record provider metrics (latency, tokens, cost)     │
     │     ├─ Record router feedback (for adaptive learning)      │
     │     ├─ Resolve coalesced requests (wake parked Promises)   │
     │     └─ Complete trace span                                 │
     └──────────────────────────────┬──────────────────────────────┘
                                    │
     ┌──────────────────────────────▼──────────────────────────────┐
     │  11. RESPONSE                                                │
     │     {                                                        │
     │       "id": "req_xK9mP2...",                                │
     │       "model": "gpt-4o-mini",                               │
     │       "provider": "openai",                                 │
     │       "choices": [{"message": {"content": "..."}}],         │
     │       "usage": {                                             │
     │         "input_tokens": 150,                                │
     │         "output_tokens": 89,                                │
     │         "cost_usd": 0.000238                                │
     │       },                                                     │
     │       "cache_hit": false,                                   │
     │       "complexity_score": 0.4,                              │
     │       "latency_ms": 1250                                    │
     │     }                                                        │
     └─────────────────────────────────────────────────────────────┘
```

---

## Summary: Why This Takes Years to Build

| Component | Engineering Depth | Time Estimate |
|-----------|------------------|---------------|
| Core Gateway + Auth + Validation | Moderate | 2-4 weeks |
| Smart Router v1 (static rules) | Moderate | 2-3 weeks |
| Semantic Cache + Drift Protection | Deep | 4-6 weeks |
| Provider Abstraction + Adapters | Moderate | 3-4 weeks |
| Circuit Breaker + Fallback Chain | Deep | 3-4 weeks |
| Offline Queue + Recovery | Deep | 3-4 weeks |
| Request Coalescing | Deep | 2-3 weeks |
| Token-Aware Rate Limiting | Deep | 2-3 weeks |
| Billing Engine + Payment Integration | Deep | 6-8 weeks |
| Multi-Region Deployment | Very Deep | 8-12 weeks |
| Adaptive Learning Router (ML) | Very Deep | 8-12 weeks |
| African Language Pipeline | Extremely Deep | 6-12 months |
| Security Hardening (SOC2 level) | Deep | 4-8 weeks |
| Observability + Alerting | Deep | 4-6 weeks |
| SDK Development (5+ languages) | Moderate | 8-12 weeks |
| Dashboard + Admin UI | Moderate | 6-8 weeks |
| Auto-Scaling + Performance Tuning | Very Deep | 4-8 weeks |
| CI/CD + Testing Infrastructure | Moderate | 3-4 weeks |
| Documentation + Developer Portal | Moderate | 4-6 weeks |
| **TOTAL** | | **~2-3 years for a team of 5 engineers** |

For a single developer + AI assistant (you + Alpha), compressing this to ~8-12 months
is possible by building iteratively: launch the core, get real users, add depth over time.

This is not a weekend project. This is a company.
