// =====================================================================
// Pulse SDK — public type contract
//
// Everything callers of the SDK touch lives here. Provider adapters and
// the logger pipeline are implementation details; these types are the
// stable surface.
// =====================================================================

/**
 * Supported providers. Adding a new one means:
 *   1. extend this union
 *   2. add a file under src/providers/
 *   3. register it in client.ts
 */
export type ProviderName = "gemini" | "groq";

/** A single turn in the chat. Mirrors the OpenAI-style role/content shape
 *  because every provider we wrap can map to/from it cheaply. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What the caller hands to pulse.chat(). Provider-agnostic on purpose —
 *  Decision A (unified API): one shape, switch providers via a string. */
export interface ChatRequest {
  provider: ProviderName;
  model: string;
  messages: ChatMessage[];

  // ── Generation knobs (optional; adapters map these onto provider params) ──
  temperature?: number;
  maxTokens?: number;

  // ── Pulse-specific extras ────────────────────────────────────────────
  /** Caller-supplied metadata. Ends up on the ClickHouse row as `tags`. */
  tags?: Record<string, string>;
  /** Links the log row back to a conversation in Postgres. */
  conversationId?: string;
  /** AbortSignal lets the chat app cancel an in-flight call. */
  signal?: AbortSignal;
}

/** What pulse.chat() resolves to. We always surface a trace_id so the
 *  caller can correlate this response with the dashboard row. */
export interface ChatResponse {
  traceId: string;
  text: string;
  model: string;
  provider: ProviderName;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Wall-clock time from request to first streamed token; null on non-streamed. */
  timeToFirstTokenMs: number | null;
}

/** Streaming variant: same shape, but text arrives in chunks first.
 *  The final ChatResponse is yielded as `{ done: true, response }`.
 *  We use a tagged stream rather than two parallel APIs to keep the
 *  caller's loop simple. */
export type ChatStreamChunk =
  | { done: false; delta: string }
  | { done: true; response: ChatResponse };

// =====================================================================
// Log event — what the SDK ships to the ingestion service
// =====================================================================
// This is the wire format. Ingestion validates it with Zod, redacts PII
// from previews, and inserts into ClickHouse. Keep field names snake_case
// to match the ClickHouse columns 1:1 so the ingestion mapping is trivial.

export interface LogEvent {
  trace_id: string;
  conversation_id: string | null;
  timestamp: string; // ISO8601, when the call was initiated
  provider: ProviderName;
  model: string;
  streamed: 0 | 1;
  status: "success" | "error";
  latency_ms: number;
  time_to_first_token_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  error_code: string;
  error_message: string;
  input_preview: string; // raw — ingestion redacts
  output_preview: string;
  environment: string;
  app_id: string;
  tags: Record<string, string>;
}

// =====================================================================
// SDK configuration
// =====================================================================

export interface PulseConfig {
  /** Provider API keys. Only keys for providers you'll call are required. */
  apiKeys: Partial<Record<ProviderName, string>>;

  /** Where to ship logs. Defaults to PULSE_INGEST_URL or
   *  http://localhost:4000/v1/logs. Set to null to disable logging
   *  entirely (useful for tests). */
  ingestUrl?: string | null;

  /** Tags merged onto every log event. Per-call `tags` override these. */
  defaultTags?: Record<string, string>;

  /** Free-form env label ("dev" | "staging" | "prod" | ...). */
  environment?: string;

  /** Logical app identifier — lets one dashboard slice multiple deploys. */
  appId?: string;

  // ── Buffer / flush behavior (Decision C) ─────────────────────────────
  /** Max events held in memory before drop-oldest. Default 100. */
  maxBufferSize?: number;
  /** Interval between flush attempts in ms. Default 1000. */
  flushIntervalMs?: number;
}
