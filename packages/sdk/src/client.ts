// =====================================================================
// createPulse() — the public client
//
// This is the bit users actually touch. Everything else is plumbing.
// The client:
//   1. Holds the provider registry + the logger.
//   2. For each chat call: stamps trace_id, measures latency / TTFT,
//      dispatches to the right adapter, builds a LogEvent, pushes it
//      to the buffer.
//   3. Returns text to the caller. Logging is fire-and-forget from
//      the caller's perspective — it never blocks the LLM response.
// =====================================================================

import { randomUUID } from "node:crypto";
import { GeminiAdapter } from "./providers/gemini.js";
import { GroqAdapter } from "./providers/groq.js";
import { LogBuffer } from "./logger/buffer.js";
import { HttpTransport } from "./logger/transport.js";
import type { ProviderAdapter } from "./providers/base.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LogEvent,
  ProviderName,
  PulseConfig,
} from "./types.js";

const DEFAULT_INGEST_URL =
  process.env.PULSE_INGEST_URL ?? "http://localhost:4000/v1/logs";

const PREVIEW_LENGTH = 500;

function previewOf(messages: ChatRequest["messages"]): string {
  // We only preview the last user-turn — that's the actual prompt for
  // this call. Earlier context is in Postgres if we ever need it.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const raw = lastUser?.content ?? "";
  return raw.slice(0, PREVIEW_LENGTH);
}

export interface PulseClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(req: ChatRequest): AsyncIterable<ChatStreamChunk>;
  /** Force-flush buffered logs. Call on graceful shutdown. */
  flush(): Promise<void>;
  /** Stop the flush timer and drain. After close(), further calls
   *  still work but their logs may not ship before exit. */
  close(): Promise<void>;
}

export function createPulse(config: PulseConfig): PulseClient {
  const ingestUrl =
    config.ingestUrl === null
      ? null
      : config.ingestUrl ?? DEFAULT_INGEST_URL;
  const environment = config.environment ?? "dev";
  const appId = config.appId ?? "default";
  const defaultTags = config.defaultTags ?? {};

  // ── Provider registry ──────────────────────────────────────────────
  // Adapters are lazily constructed so missing-key errors only fire
  // when you actually call that provider.
  const adapters = new Map<ProviderName, ProviderAdapter>();
  const adapterFor = (provider: ProviderName): ProviderAdapter => {
    const cached = adapters.get(provider);
    if (cached) return cached;
    const key = config.apiKeys[provider];
    if (!key) {
      throw new Error(
        `Pulse: no API key configured for provider "${provider}"`,
      );
    }
    const fresh: ProviderAdapter =
      provider === "gemini"
        ? new GeminiAdapter(key)
        : new GroqAdapter(key);
    adapters.set(provider, fresh);
    return fresh;
  };

  // ── Logger pipeline ────────────────────────────────────────────────
  const buffer = new LogBuffer(config.maxBufferSize ?? 100);
  const transport: HttpTransport | null =
    ingestUrl === null
      ? null
      : new HttpTransport(buffer, {
          url: ingestUrl,
          flushIntervalMs: config.flushIntervalMs ?? 1000,
        });
  transport?.start();

  // ── Helpers ────────────────────────────────────────────────────────
  function buildLogEvent(args: {
    traceId: string;
    req: ChatRequest;
    startedAtIso: string;
    streamed: boolean;
    status: "success" | "error";
    latencyMs: number;
    timeToFirstTokenMs: number | null;
    inputTokens: number;
    outputTokens: number;
    outputText: string;
    errorCode?: string;
    errorMessage?: string;
  }): LogEvent {
    return {
      trace_id: args.traceId,
      conversation_id: args.req.conversationId ?? null,
      timestamp: args.startedAtIso,
      provider: args.req.provider,
      model: args.req.model,
      streamed: args.streamed ? 1 : 0,
      status: args.status,
      latency_ms: args.latencyMs,
      time_to_first_token_ms: args.timeToFirstTokenMs,
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      error_code: args.errorCode ?? "",
      error_message: args.errorMessage ?? "",
      input_preview: previewOf(args.req.messages),
      output_preview: args.outputText.slice(0, PREVIEW_LENGTH),
      environment,
      app_id: appId,
      tags: { ...defaultTags, ...(args.req.tags ?? {}) },
    };
  }

  function logIt(event: LogEvent): void {
    // No transport configured (e.g. tests with ingestUrl: null) → no-op.
    if (!transport) return;
    buffer.push(event);
  }

  // ── Public methods ─────────────────────────────────────────────────
  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const traceId = randomUUID();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const adapter = adapterFor(req.provider);

    try {
      const result = await adapter.chat({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal: req.signal,
      });
      const latencyMs = Date.now() - startedAt;

      logIt(
        buildLogEvent({
          traceId,
          req,
          startedAtIso,
          streamed: false,
          status: "success",
          latencyMs,
          timeToFirstTokenMs: null,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          outputText: result.text,
        }),
      );

      return {
        traceId,
        text: result.text,
        model: req.model,
        provider: req.provider,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs,
        timeToFirstTokenMs: null,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      logIt(
        buildLogEvent({
          traceId,
          req,
          startedAtIso,
          streamed: false,
          status: "error",
          latencyMs,
          timeToFirstTokenMs: null,
          inputTokens: 0,
          outputTokens: 0,
          outputText: "",
          errorCode: classifyError(err),
          errorMessage: errorMessageOf(err),
        }),
      );
      throw err;
    }
  }

  async function* chatStream(
    req: ChatRequest,
  ): AsyncIterable<ChatStreamChunk> {
    const traceId = randomUUID();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const adapter = adapterFor(req.provider);
    let timeToFirstTokenMs: number | null = null;

    try {
      const iter = adapter.chatStream({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal: req.signal,
      });

      let finalResult = { text: "", inputTokens: 0, outputTokens: 0 };
      for await (const piece of iter) {
        if (piece.kind === "delta") {
          if (timeToFirstTokenMs === null) {
            timeToFirstTokenMs = Date.now() - startedAt;
          }
          yield { done: false, delta: piece.text };
        } else {
          finalResult = piece.result;
        }
      }

      const latencyMs = Date.now() - startedAt;
      const response: ChatResponse = {
        traceId,
        text: finalResult.text,
        model: req.model,
        provider: req.provider,
        inputTokens: finalResult.inputTokens,
        outputTokens: finalResult.outputTokens,
        latencyMs,
        timeToFirstTokenMs,
      };

      logIt(
        buildLogEvent({
          traceId,
          req,
          startedAtIso,
          streamed: true,
          status: "success",
          latencyMs,
          timeToFirstTokenMs,
          inputTokens: finalResult.inputTokens,
          outputTokens: finalResult.outputTokens,
          outputText: finalResult.text,
        }),
      );

      yield { done: true, response };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      logIt(
        buildLogEvent({
          traceId,
          req,
          startedAtIso,
          streamed: true,
          status: "error",
          latencyMs,
          timeToFirstTokenMs,
          inputTokens: 0,
          outputTokens: 0,
          outputText: "",
          errorCode: classifyError(err),
          errorMessage: errorMessageOf(err),
        }),
      );
      throw err;
    }
  }

  return {
    chat,
    chatStream,
    flush: () => transport?.flush() ?? Promise.resolve(),
    close: () => transport?.close() ?? Promise.resolve(),
  };
}

// ── Error classification ───────────────────────────────────────────────
// We bucket errors into a handful of LowCardinality codes so the
// ClickHouse `error_code` column stays small + the dashboards can
// group by it. The full provider message lives in error_message.
function classifyError(err: unknown): string {
  const msg = errorMessageOf(err).toLowerCase();
  if (msg.includes("rate") && msg.includes("limit")) return "rate_limit";
  if (msg.includes("context") && msg.includes("length")) return "context_length";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (msg.includes("auth") || msg.includes("api key") || msg.includes("401"))
    return "auth";
  if (msg.includes("abort")) return "aborted";
  if (msg.includes("5")) return "server_error";
  return "unknown";
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}
