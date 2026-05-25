// =====================================================================
// POST /api/chat — stream a chat turn
//
// Request body:
//   {
//     conversationId?: string,   // omit to start a new conversation
//     provider: "gemini" | "groq",
//     model: string,
//     content: string            // the user's new message
//   }
//
// Response: ndjson stream (see lib/stream-protocol.ts).
//
// Lifecycle per request:
//   1. Validate body
//   2. Ensure conversation exists (create if needed)
//   3. INSERT user message → emit "meta" frame with IDs
//   4. Load full message history → pass to SDK chatStream
//   5. Forward each delta to the client as a "delta" frame
//   6. On stream completion: INSERT assistant message → emit "done"
//   7. On error or abort: emit "error" frame
//
// AbortSignal: the Web Request carries req.signal. If the client cancels
// the fetch (or the user closes the tab), Next aborts the signal; we
// forward it into the SDK so the upstream HTTP request closes promptly.
// =====================================================================

import { z } from "zod";
import type { ChatMessage } from "@pulse/sdk";
import { getPulse } from "@/lib/pulse";
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversation,
  deriveTitle,
  getConversation,
  loadMessages,
  touchConversation,
} from "@/lib/db/queries";
import { findModel } from "@/lib/models";
import { encodeFrame, STREAM_CONTENT_TYPE } from "@/lib/stream-protocol";

export const runtime = "nodejs";
// Streaming responses need dynamic; Next would otherwise try to cache.
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  provider: z.enum(["gemini", "groq"]),
  model: z.string().min(1),
  content: z.string().min(1).max(20_000),
});

export async function POST(req: Request): Promise<Response> {
  // ── 1. Validate ────────────────────────────────────────────────
  const json = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { conversationId: maybeId, provider, model, content } = parsed.data;

  // Make sure the (provider, model) pair is one we whitelisted.
  if (!findModel(provider, model)) {
    return Response.json({ error: "unknown_model" }, { status: 400 });
  }

  // ── 2. Ensure conversation ─────────────────────────────────────
  let conversationId: string;
  let isNewConversation = false;
  if (maybeId) {
    const existing = await getConversation(maybeId);
    if (!existing) {
      return Response.json({ error: "no_such_conversation" }, { status: 404 });
    }
    conversationId = existing.id;
  } else {
    const created = await createConversation({ title: deriveTitle(content) });
    conversationId = created.id;
    isNewConversation = true;
  }

  // ── 3. INSERT user message ─────────────────────────────────────
  const userMessage = await appendUserMessage({ conversationId, content });
  // Bump updated_at so the sidebar lists this conversation first. Title
  // gets set only on the first turn (when we created the conversation).
  await touchConversation({
    id: conversationId,
    ...(isNewConversation ? {} : {}),
  });

  // ── 4. Build history + call SDK ────────────────────────────────
  // We re-load from DB rather than appending in-memory because the
  // returned rows carry the same IDs the client may already have
  // rendered. Round-trip cost is one cheap indexed scan.
  const history = await loadMessages(conversationId);
  const sdkMessages: ChatMessage[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const pulse = getPulse();

  // ── 5. Build the response stream ───────────────────────────────
  // We construct a ReadableStream that writes frames as the SDK yields.
  // The stream owns the lifecycle: it knows when to write meta, deltas,
  // done, or error, and it owns the final DB insert for the assistant.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (frame: Parameters<typeof encodeFrame>[0]) =>
        controller.enqueue(encodeFrame(frame));

      // First frame: meta with the IDs the client needs to render the
      // user message bubble immediately.
      enqueue({
        type: "meta",
        conversationId,
        userMessageId: userMessage.id,
      });

      let assembled = "";
      try {
        const iter = pulse.chatStream({
          provider,
          model,
          messages: sdkMessages,
          conversationId,
          signal: req.signal,
          tags: { conversation_id: conversationId },
        });

        for await (const chunk of iter) {
          if (chunk.done) {
            // ── 6. Persist assistant message ─────────────────────
            const assistantMessage = await appendAssistantMessage({
              conversationId,
              content: chunk.response.text,
              provider: chunk.response.provider,
              model: chunk.response.model,
              traceId: chunk.response.traceId,
            });
            await touchConversation({ id: conversationId });

            enqueue({
              type: "done",
              assistantMessageId: assistantMessage.id,
              traceId: chunk.response.traceId,
              usage: {
                inputTokens: chunk.response.inputTokens,
                outputTokens: chunk.response.outputTokens,
                latencyMs: chunk.response.latencyMs,
                timeToFirstTokenMs: chunk.response.timeToFirstTokenMs,
              },
            });
          } else {
            assembled += chunk.delta;
            enqueue({ type: "delta", text: chunk.delta });
          }
        }
      } catch (err) {
        // If we already buffered any text, persist what we got so the
        // chat survives a mid-stream failure. The error frame lets the
        // UI mark the message as incomplete.
        if (assembled.length > 0) {
          await appendAssistantMessage({
            conversationId,
            content: assembled + "\n\n[interrupted]",
            provider,
            model,
            // No trace_id — the SDK call never reached "done", so the
            // log row will have status='error' under the same trace_id
            // it generated internally. We just don't have it here.
            traceId: "00000000-0000-0000-0000-000000000000",
          });
        }
        enqueue({
          type: "error",
          code: req.signal.aborted ? "aborted" : "upstream_error",
          message: err instanceof Error ? err.message : "stream failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": STREAM_CONTENT_TYPE,
      "cache-control": "no-store, no-cache, no-transform",
      // Tells reverse proxies (nginx) to not buffer the response.
      "x-accel-buffering": "no",
    },
  });
}
