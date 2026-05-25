// =====================================================================
// Groq adapter
//
// Groq's SDK is OpenAI-shape (chat.completions.create with role/content
// messages). So the mapping is almost a pass-through. Things to know:
//   - Groq is OpenAI-compatible enough that the same code would run
//     against Together, Fireworks, etc. if we swapped the client.
//   - Streaming chunks expose `choices[0].delta.content` (could be
//     empty/undefined on tool-call deltas — we just skip those).
//   - Streaming usage stats arrive on a final chunk's `x_groq.usage`
//     field (Groq-specific extension). No `stream_options` needed.
// =====================================================================

import Groq from "groq-sdk";
import type {
  AdapterCall,
  AdapterResult,
  ProviderAdapter,
} from "./base.js";

export class GroqAdapter implements ProviderAdapter {
  private readonly client: Groq;

  constructor(apiKey: string) {
    this.client = new Groq({ apiKey });
  }

  async chat(call: AdapterCall): Promise<AdapterResult> {
    const completion = await this.client.chat.completions.create(
      {
        model: call.model,
        messages: call.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...(call.temperature !== undefined
          ? { temperature: call.temperature }
          : {}),
        ...(call.maxTokens !== undefined
          ? { max_tokens: call.maxTokens }
          : {}),
        stream: false,
      },
      { signal: call.signal },
    );

    const text = completion.choices[0]?.message?.content ?? "";
    const usage = completion.usage;
    return {
      text,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    };
  }

  async *chatStream(
    call: AdapterCall,
  ): AsyncIterable<
    | { kind: "delta"; text: string }
    | { kind: "final"; result: AdapterResult }
  > {
    const stream = await this.client.chat.completions.create(
      {
        model: call.model,
        messages: call.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...(call.temperature !== undefined
          ? { temperature: call.temperature }
          : {}),
        ...(call.maxTokens !== undefined
          ? { max_tokens: call.maxTokens }
          : {}),
        stream: true,
      },
      { signal: call.signal },
    );

    let assembled = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      // Groq emits usage on a final chunk via the x_groq extension
      // (their OpenAI-compatible analogue of OpenAI's stream_options).
      // Earlier chunks carry text deltas; the final chunk has empty
      // choices and `x_groq.usage`.
      const usage = chunk.x_groq?.usage;
      if (usage) {
        inputTokens = usage.prompt_tokens ?? inputTokens;
        outputTokens = usage.completion_tokens ?? outputTokens;
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        assembled += delta;
        yield { kind: "delta", text: delta };
      }
    }

    yield {
      kind: "final",
      result: { text: assembled, inputTokens, outputTokens },
    };
  }
}
