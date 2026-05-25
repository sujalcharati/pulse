// =====================================================================
// JSON-lines streaming protocol for /api/chat
//
// Wire shape: one JSON object per line, separated by '\n'.
// Content-Type: application/x-ndjson
//
// Why JSON-lines and not SSE?
//   - SSE wraps each message in 'data: ' + '\n\n' framing for no benefit
//     here — we control both ends and don't need EventSource semantics.
//   - JSON-lines is just objects + newlines. Parses with a split('\n').
//   - The fetch().body reader on the client decodes a chunk at a time.
//
// Frame sequence per request:
//   { type: "meta",  conversationId, userMessageId }           — exactly one, first
//   { type: "delta", text }                                    — zero or more
//   { type: "done",  assistantMessageId, traceId, usage }      — exactly one, last
//   { type: "error", code, message }                           — terminal alternative to "done"
// =====================================================================

export type StreamFrame =
  | {
      type: "meta";
      conversationId: string;
      userMessageId: string;
    }
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "done";
      assistantMessageId: string;
      traceId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        latencyMs: number;
        timeToFirstTokenMs: number | null;
      };
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export const STREAM_CONTENT_TYPE = "application/x-ndjson";

// ── server-side encoder ──────────────────────────────────────────────

/** Encode a single frame to a Uint8Array ready to write into a stream. */
export function encodeFrame(frame: StreamFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame) + "\n");
}

// ── client-side decoder ──────────────────────────────────────────────

/** Read a fetch Response body as a stream of typed frames.
 *  Handles partial chunks: a frame may arrive split across two reads;
 *  we buffer until we see a newline. */
export async function* readFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<StreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on '\n' — keep the trailing partial line (if any) in buffer.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as StreamFrame;
        } catch {
          // Malformed line — skip rather than abort the whole stream.
          // Real prod would surface this to logs.
        }
      }
    }
    // Flush any final partial line (shouldn't happen if server is well-behaved).
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as StreamFrame;
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock();
  }
}
