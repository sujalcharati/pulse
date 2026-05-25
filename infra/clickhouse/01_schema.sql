-- =====================================================================
-- Pulse — ClickHouse analytics schema
--
-- One row per LLM inference call. Optimized for:
--   - very high write throughput (thousands of inserts/sec)
--   - time-series aggregations grouped by provider/model
--   - drill-down by conversation_id when reviewing a specific trace
--
-- We use ClickHouse instead of Postgres for this because:
--   - MergeTree compresses columnar data ~10-50x for our access pattern
--   - GROUP BY across 10M+ rows runs in milliseconds (Postgres would die)
--   - LowCardinality columns are tiny + fast for our handful of providers
-- =====================================================================

CREATE DATABASE IF NOT EXISTS pulse;

CREATE TABLE IF NOT EXISTS pulse.inference_logs (
  -- ── Identity ─────────────────────────────────────────────────────
  -- trace_id: unique per LLM call. The SDK generates it before calling
  -- the provider and the same id flows through the chat message in
  -- Postgres, the Redis Streams event, and this row.
  trace_id                UUID,
  conversation_id         UUID,
  message_id              Nullable(UUID),                -- the resulting assistant message in Postgres

  -- ── Time ─────────────────────────────────────────────────────────
  -- timestamp = when the LLM call was initiated by the SDK (the event time)
  -- ingested_at = when this row was written to ClickHouse (system time)
  -- Keeping both lets us compute ingest lag, which is a real prod metric.
  timestamp               DateTime64(3, 'UTC'),
  ingested_at             DateTime64(3, 'UTC') DEFAULT now64(3),

  -- ── What was called ──────────────────────────────────────────────
  -- LowCardinality is critical here: with maybe 5 providers and 30 models
  -- across millions of rows, the column is stored as a dictionary +
  -- tiny integer IDs. Compression is dramatic.
  provider                LowCardinality(String),         -- 'openai' | 'anthropic' | 'gemini' | 'groq'
  model                   LowCardinality(String),         -- e.g. 'gpt-4o-mini'
  streamed                UInt8 DEFAULT 0,                -- 1 if response was streamed

  -- ── Outcome ──────────────────────────────────────────────────────
  status                  LowCardinality(String),         -- 'success' | 'error'
  latency_ms              UInt32,                         -- wall-clock end-to-end
  time_to_first_token_ms  Nullable(UInt32),               -- only meaningful when streamed=1

  -- ── Tokens & cost ────────────────────────────────────────────────
  -- total_tokens is computed via MATERIALIZED so it's stored on disk
  -- (cheap to query, no per-row math at SELECT time).
  -- cost_usd is computed by the ingestion service from a per-model price
  -- table. We store the result so dashboards don't have to recompute.
  input_tokens            UInt32 DEFAULT 0,
  output_tokens           UInt32 DEFAULT 0,
  total_tokens            UInt32 MATERIALIZED input_tokens + output_tokens,
  cost_usd                Float64 DEFAULT 0.0,

  -- ── Errors ───────────────────────────────────────────────────────
  -- LowCardinality on error_code because most errors fall into ~10 buckets
  -- ('rate_limit', 'context_length', 'timeout', 'auth', 'server_error'...).
  error_code              LowCardinality(String) DEFAULT '',
  error_message           String DEFAULT '',

  -- ── Content (PII-redacted by ingestion service) ──────────────────
  -- We store previews, not full prompts/completions. Two reasons:
  --   1. Storage cost: full chat history can be huge; ClickHouse isn't
  --      where you store the source of truth for messages (Postgres is).
  --   2. PII: the ingestion service redacts emails/phones/keys before
  --      writing. Full bodies live in Postgres only.
  input_preview           String DEFAULT '',              -- first ~500 chars, PII-scrubbed
  output_preview          String DEFAULT '',              -- first ~500 chars, PII-scrubbed

  -- ── Context ──────────────────────────────────────────────────────
  -- environment + app_id let us slice dashboards in multi-tenant /
  -- multi-deploy setups. Even in this demo it's useful: 'dev' vs 'prod'.
  environment             LowCardinality(String) DEFAULT 'dev',
  app_id                  LowCardinality(String) DEFAULT 'default',

  -- ── Arbitrary user-defined metadata ──────────────────────────────
  -- The SDK lets callers attach tags like {feature: 'summarizer', tier: 'free'}.
  -- Map(String, String) is queryable in ClickHouse via tags['feature'].
  tags                    Map(LowCardinality(String), String) DEFAULT map()
)
ENGINE = MergeTree
-- ── Partitioning ─────────────────────────────────────────────────────
-- One partition per month. Big wins:
--   - "Drop data older than 90 days" = ALTER TABLE ... DROP PARTITION, O(1).
--   - Queries for "last 24h" only touch the current month's parts.
PARTITION BY toYYYYMM(timestamp)
-- ── Sort key ─────────────────────────────────────────────────────────
-- ORDER BY determines on-disk sort order, which dictates compression
-- ratio and query speed. We picked (provider, model, timestamp) because:
--   1. Most dashboards filter by provider/model (the WHERE clause)
--   2. LowCardinality columns first → exceptional compression
--   3. timestamp last → time-range queries still use the primary index
-- Tradeoff: queries that ONLY filter by time (no provider) scan more
-- granules. Acceptable for our use case; revisit if dashboards change.
ORDER BY (provider, model, timestamp)
-- ── Retention ────────────────────────────────────────────────────────
-- 90-day TTL. Real prod would have hot/cold tiers (e.g. S3 after 30d).
-- See README "What I'd improve" for the cold-storage proposal.
TTL toDateTime(timestamp) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;


-- =====================================================================
-- Pre-aggregated views for fast dashboards
-- =====================================================================
-- Grafana could query the raw table for every panel, but at scale you
-- want pre-aggregated minute/hour rollups. We use a Materialized View
-- so inserts to inference_logs automatically populate the rollup.
--
-- This is a "scaling consideration" answer for the interview: even at
-- 1k req/s, we don't want Grafana scanning the raw table every refresh.

CREATE TABLE IF NOT EXISTS pulse.inference_logs_1m (
  bucket          DateTime,                    -- minute bucket
  provider        LowCardinality(String),
  model           LowCardinality(String),
  status          LowCardinality(String),
  request_count   UInt64,
  total_latency_ms UInt64,                     -- sum, lets us compute avg
  total_input_tokens  UInt64,
  total_output_tokens UInt64,
  total_cost_usd      Float64,
  -- Quantile state — multi-level t-digest stored as a single column.
  -- Read it back via quantilesTDigestMerge(0.5, 0.95, 0.99)(state),
  -- which returns an Array(Float64) of [p50, p95, p99].
  -- Note: quantilesTDigest (plural) takes multiple levels;
  -- quantileTDigest (singular) takes exactly one.
  latency_quantile_state AggregateFunction(quantilesTDigest(0.5, 0.95, 0.99), Float64)
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (provider, model, status, bucket);

CREATE MATERIALIZED VIEW IF NOT EXISTS pulse.inference_logs_1m_mv
TO pulse.inference_logs_1m
AS SELECT
  toStartOfMinute(timestamp) AS bucket,
  provider,
  model,
  status,
  count() AS request_count,
  sum(latency_ms) AS total_latency_ms,
  sum(input_tokens) AS total_input_tokens,
  sum(output_tokens) AS total_output_tokens,
  sum(cost_usd) AS total_cost_usd,
  quantilesTDigestState(0.5, 0.95, 0.99)(toFloat64(latency_ms)) AS latency_quantile_state
FROM pulse.inference_logs
GROUP BY bucket, provider, model, status;
