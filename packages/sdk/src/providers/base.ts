// =====================================================================
// Provider contract
//
// Every adapter under src/providers/ implements this interface. The
// client (client.ts) holds a registry { gemini: GeminiAdapter, ... } and
// dispatches based on req.provider.
//
// Keeping the contract narrow (chat + chatStream) means new providers
// are cheap: implement two methods, return token counts, done.
// =====================================================================

import type { ChatRequest, ChatResponse, ChatStreamChunk } from "../types.js";

/** What the client passes to an adapter. Strips the bits the adapter
 *  doesn't need (logging context lives in the client), keeps everything
 *  the upstream provider call requires. */
export interface AdapterCall {
  model: string;
  messages: ChatRequest["messages"];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Minimal return shape the adapter reports back. The client wraps this
 *  with trace_id / latency / tags before returning to the caller and
 *  before logging. */
export interface AdapterResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderAdapter {
  /** Non-streaming completion. Throws on upstream error; the client
   *  turns thrown errors into log events with status: "error". */
  chat(call: AdapterCall): Promise<AdapterResult>;

  /** Streaming completion. Yields text deltas, then a final result with
   *  total token counts. The client measures TTFT from the first delta. */
  chatStream(call: AdapterCall): AsyncIterable<
    | { kind: "delta"; text: string }
    | { kind: "final"; result: AdapterResult }
  >;
}
