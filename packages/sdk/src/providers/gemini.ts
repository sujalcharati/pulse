// =====================================================================
// Gemini adapter
//
// Translates the Pulse-shape (OpenAI-style role+content) into Gemini's
// `contents` array + `systemInstruction`, and unpacks usageMetadata.
//
// Quirks worth knowing:
//   - Gemini uses `model` as a role label, not `assistant`.
//   - System prompts are NOT in the contents array — they go on the
//     model handle as `systemInstruction`.
//   - Token counts come back on `usageMetadata` (promptTokenCount,
//     candidatesTokenCount). Older SDK versions sometimes omit this on
//     streamed calls until the final aggregate — we read from the
//     resolved `response`, which always has it.
// =====================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ChatMessage } from "../types.js";
import type {
  AdapterCall,
  AdapterResult,
  ProviderAdapter,
} from "./base.js";

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

/** Split a Pulse `messages[]` into Gemini's two shapes:
 *    - systemInstruction: the (optional) leading system message
 *    - contents: everything else, with role remapped
 *  Consecutive same-role messages get collapsed because Gemini errors
 *  if you alternate user→user without an assistant turn between them. */
function toGeminiInput(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // Concatenate multiple system messages with a blank line between.
      systemInstruction = systemInstruction
        ? `${systemInstruction}\n\n${msg.content}`
        : msg.content;
      continue;
    }
    const role = msg.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: msg.content });
    } else {
      contents.push({ role, parts: [{ text: msg.content }] });
    }
  }

  return { systemInstruction, contents };
}

export class GeminiAdapter implements ProviderAdapter {
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async chat(call: AdapterCall): Promise<AdapterResult> {
    const { systemInstruction, contents } = toGeminiInput(call.messages);
    const model = this.client.getGenerativeModel({
      model: call.model,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        ...(call.temperature !== undefined
          ? { temperature: call.temperature }
          : {}),
        ...(call.maxTokens !== undefined
          ? { maxOutputTokens: call.maxTokens }
          : {}),
      },
    });

    const text = result.response.text();
    const usage = result.response.usageMetadata;
    return {
      text,
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
    };
  }

  async *chatStream(
    call: AdapterCall,
  ): AsyncIterable<
    | { kind: "delta"; text: string }
    | { kind: "final"; result: AdapterResult }
  > {
    const { systemInstruction, contents } = toGeminiInput(call.messages);
    const model = this.client.getGenerativeModel({
      model: call.model,
      ...(systemInstruction ? { systemInstruction } : {}),
    });

    const stream = await model.generateContentStream({
      contents,
      generationConfig: {
        ...(call.temperature !== undefined
          ? { temperature: call.temperature }
          : {}),
        ...(call.maxTokens !== undefined
          ? { maxOutputTokens: call.maxTokens }
          : {}),
      },
    });

    let assembled = "";
    for await (const chunk of stream.stream) {
      // Abort cooperatively: if the caller aborted, stop reading. Gemini's
      // SDK doesn't accept an AbortSignal directly in this version, so we
      // break out of the loop instead. The HTTP connection will close
      // when the iterator is GC'd.
      if (call.signal?.aborted) break;
      const delta = chunk.text();
      if (delta) {
        assembled += delta;
        yield { kind: "delta", text: delta };
      }
    }

    // After the stream finishes, `stream.response` resolves with the
    // full aggregate, including usageMetadata.
    const final = await stream.response;
    const usage = final.usageMetadata;
    yield {
      kind: "final",
      result: {
        text: assembled,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }
}
