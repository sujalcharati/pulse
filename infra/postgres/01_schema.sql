-- =====================================================================
-- Pulse — Postgres operational schema
--
-- Stores conversational state. Anything you need to RENDER A CHAT UI lives
-- here. High-volume per-call telemetry (latency, tokens, errors) lives in
-- ClickHouse, NOT here. The split exists because the two have completely
-- different access patterns:
--
--   Postgres:    "give me the last 20 messages for conversation X"
--                random access, low cardinality of writes per conversation
--
--   ClickHouse:  "p95 latency across all calls in the last hour by provider"
--                analytical scans over millions of rows
--
-- Trying to do both in one DB means either slow chats or slow dashboards.
-- We pick the right tool for each.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
-- Status is finite + queryable. Using an enum (instead of a string) gives
-- us cheap storage, validation at the DB layer, and clean Prisma/Drizzle
-- types in TypeScript.

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('active', 'archived', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ---------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------
-- One row per chat. Lifecycle: 'active' (user can append) -> 'archived'
-- (read-only) or 'cancelled' (user hit cancel mid-generation).
--
-- user_id is intentionally just a TEXT field — we don't have auth in this
-- demo, but storing it keeps the schema multi-tenant-ready.

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT,                                     -- nullable; auto-derived from first user message
  status      conversation_status NOT NULL DEFAULT 'active',
  user_id     TEXT,                                     -- nullable; placeholder for future auth
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot query: "list this user's conversations, most-recently-updated first"
-- Covering index by (user_id, updated_at DESC) makes this an index-only scan.
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
  ON conversations (user_id, updated_at DESC)
  WHERE status != 'archived';


-- ---------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------
-- One row per chat message (both user and assistant). Stored in order of
-- creation. role tells us who said it; content is the raw text.
--
-- model / provider are denormalized here even though they also live in
-- ClickHouse inference_logs. WHY:
--   - The chat UI shows "Claude said:" or "GPT said:" on each bubble.
--     Hitting ClickHouse for every message render would be insane.
--   - We can switch providers mid-conversation (bonus requirement), so
--     putting them on conversations is wrong.
--
-- trace_id is the bridge to ClickHouse: every assistant message has a
-- corresponding inference_logs row with the same trace_id. We can join
-- across DBs in queries that need to.

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            message_role NOT NULL,
  content         TEXT NOT NULL,
  model           TEXT,                                 -- nullable for role='user'
  provider        TEXT,                                 -- nullable for role='user'
  trace_id        UUID,                                 -- joins to ClickHouse inference_logs.trace_id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot query: "get me the last N messages for this conversation, in order"
-- This is the single most common read in the app. Index covers it.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

-- Lookup an assistant message by its inference trace (rare but useful for
-- linking from Grafana drill-downs back to the actual chat).
CREATE INDEX IF NOT EXISTS idx_messages_trace_id
  ON messages (trace_id) WHERE trace_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- updated_at trigger for conversations
-- ---------------------------------------------------------------------
-- Whenever a conversation row changes, bump updated_at so the "list
-- conversations, most-recent-first" query sorts right. We also bump it
-- from application code when a NEW MESSAGE is inserted, since that's
-- semantically a conversation update.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_set_updated_at ON conversations;
CREATE TRIGGER conversations_set_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
