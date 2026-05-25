"use client";

// =====================================================================
// ChatShell — the client-side brain of the chat UI.
//
// Responsibilities:
//   - Render the running list of messages (initial server-rendered set
//     + any messages added in this client session).
//   - Own the composer state (current input value, send/cancel).
//   - POST to /api/chat and consume the ndjson stream:
//       meta  → push placeholders (user bubble + empty assistant bubble)
//       delta → append text to the in-flight assistant bubble
//       done  → finalize IDs + usage metadata
//       error → mark the in-flight bubble as failed
//   - Honor cancel: AbortController on the fetch, server tears down.
//
// Shape of state:
//   We mirror DB messages into a single `items` array. Streaming
//   appends to the *last* item if it's the in-flight assistant turn,
//   identified by the sentinel id "pending".
// =====================================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ModelPicker } from "@/components/model-picker";
import { DEFAULT_MODEL, findModel, type ModelChoice } from "@/lib/models";
import { readFrames } from "@/lib/stream-protocol";
import { cn } from "@/lib/utils";
import type { Message } from "@/lib/db/schema";

const PENDING_ID = "pending";

interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  provider?: string | null;
  model?: string | null;
  traceId?: string | null;
  // Set on the in-flight assistant bubble once streaming completes
  // or fails; drives the latency/usage footer.
  usage?: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    timeToFirstTokenMs: number | null;
  };
  errored?: boolean;
}

interface Props {
  conversationId?: string;
  initialMessages: Message[];
}

function dbToItem(m: Message): ChatItem {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    provider: m.provider,
    model: m.model,
    traceId: m.traceId,
  };
}

/** Best-guess initial model for the picker:
 *  use the most recent assistant message's model, else the default. */
function initialModel(initial: Message[]): ModelChoice {
  for (let i = initial.length - 1; i >= 0; i--) {
    const m = initial[i]!;
    if (m.role === "assistant" && m.provider && m.model) {
      const found = findModel(m.provider, m.model);
      if (found) return found;
    }
  }
  return DEFAULT_MODEL;
}

export function ChatShell({ conversationId, initialMessages }: Props) {
  const router = useRouter();
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialMessages.map(dbToItem),
  );
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelChoice>(() =>
    initialModel(initialMessages),
  );
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [, startTransition] = useTransition();

  // Autoscroll to bottom when items change. We compare scrollHeight to
  // scroll position so we don't yank the view if the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items]);

  async function send() {
    const content = input.trim();
    if (!content || streaming) return;
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Optimistic: drop in the user bubble + an empty assistant bubble.
    // The meta frame will reconcile the user bubble's id; the deltas
    // append to the assistant bubble; the done frame finalizes it.
    setItems((prev) => [
      ...prev,
      { id: "optimistic-user", role: "user", content },
      {
        id: PENDING_ID,
        role: "assistant",
        content: "",
        provider: model.provider,
        model: model.model,
      },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          provider: model.provider,
          model: model.model,
          content,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`server returned ${res.status}`);
      }

      let newConvId: string | undefined;
      for await (const frame of readFrames(res.body)) {
        if (frame.type === "meta") {
          newConvId = frame.conversationId;
          // Replace the optimistic user id with the real one.
          setItems((prev) =>
            prev.map((it) =>
              it.id === "optimistic-user"
                ? { ...it, id: frame.userMessageId }
                : it,
            ),
          );
        } else if (frame.type === "delta") {
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.id === PENDING_ID) {
              next[next.length - 1] = {
                ...last,
                content: last.content + frame.text,
              };
            }
            return next;
          });
        } else if (frame.type === "done") {
          setItems((prev) =>
            prev.map((it) =>
              it.id === PENDING_ID
                ? {
                    ...it,
                    id: frame.assistantMessageId,
                    traceId: frame.traceId,
                    usage: frame.usage,
                  }
                : it,
            ),
          );
        } else if (frame.type === "error") {
          setItems((prev) =>
            prev.map((it) =>
              it.id === PENDING_ID
                ? {
                    ...it,
                    content: it.content + (it.content ? "\n\n" : "") + `[${frame.code}: ${frame.message}]`,
                    errored: true,
                  }
                : it,
            ),
          );
        }
      }

      // If this was a brand-new conversation, push to /c/[id] so the
      // sidebar selection updates and the URL is shareable.
      if (!conversationId && newConvId) {
        startTransition(() => {
          router.push(`/c/${newConvId}`);
          router.refresh(); // re-render the server sidebar
        });
      } else {
        // Existing conversation: refresh server components (sidebar
        // updated_at order, etc.) without losing client state.
        startTransition(() => router.refresh());
      }
    } catch (err) {
      // AbortError is expected on cancel; other errors get surfaced.
      const isAbort = (err as Error).name === "AbortError";
      setItems((prev) =>
        prev.map((it) =>
          it.id === PENDING_ID
            ? {
                ...it,
                content:
                  it.content +
                  (it.content ? "\n\n" : "") +
                  (isAbort ? "[cancelled]" : `[${(err as Error).message}]`),
                errored: true,
              }
            : it,
        ),
      );
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar: model picker */}
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {conversationId ? "Conversation" : "New chat"}
        </h2>
        <ModelPicker value={model} onChange={setModel} disabled={streaming} />
      </header>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
          {items.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">
              Send a message to start. Pick a provider above.
            </p>
          )}
          {items.map((it, idx) => (
            <MessageBubble key={`${it.id}-${idx}`} item={it} />
          ))}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t bg-background p-4">
        <div className="mx-auto flex max-w-3xl gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="resize-none"
            disabled={streaming}
          />
          {streaming ? (
            <Button variant="destructive" onClick={cancel} className="self-end">
              <StopCircle className="mr-1 h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button onClick={send} disabled={!input.trim()} className="self-end">
              <Send className="mr-1 h-4 w-4" /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ item }: { item: ChatItem }) {
  const isUser = item.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap break-words",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
          item.errored && "ring-1 ring-destructive",
        )}
      >
        {item.content || (
          <span className="inline-block animate-pulse text-muted-foreground">
            …
          </span>
        )}
        {!isUser && item.usage && (
          <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            {item.model} • {item.usage.inputTokens}→{item.usage.outputTokens} tok • {item.usage.latencyMs}ms
            {item.usage.timeToFirstTokenMs !== null && (
              <> • ttft {item.usage.timeToFirstTokenMs}ms</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
