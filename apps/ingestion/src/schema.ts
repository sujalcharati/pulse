// =====================================================================
// Zod schema for incoming LogEvents
//
// This is the *trust boundary* of the system. Everything past this point
// assumes well-formed data; everything before it is untrusted client input.
//
// Why Zod and not (e.g.) JSON Schema?
//   - We already use Zod for env parsing — one fewer dependency.
//   - Inferred types are first-class TypeScript: `LogEventInput` below
//     mirrors the SDK's `LogEvent` automatically once we cross-check.
// =====================================================================

import { z } from "zod";
import type { LogEvent } from "@pulse/sdk";

const providerSchema = z.enum(["gemini", "groq"]);

export const logEventSchema = z.object({
  trace_id: z.string().uuid(),
  conversation_id: z.string().uuid().nullable(),
  timestamp: z.string().datetime(),
  provider: providerSchema,
  model: z.string().min(1).max(120),
  streamed: z.union([z.literal(0), z.literal(1)]),
  status: z.enum(["success", "error"]),
  latency_ms: z.number().int().nonnegative(),
  time_to_first_token_ms: z.number().int().nonnegative().nullable(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  // error_code is LowCardinality in ClickHouse — keep it short to avoid
  // dictionary bloat from a misbehaving client.
  error_code: z.string().max(64),
  // Cap raw error message to something reasonable; full stacks belong in
  // an APM, not in our analytics columns.
  error_message: z.string().max(2000),
  // We re-clip previews to PREVIEW_LENGTH in the SDK and again here,
  // because a forged client could send arbitrary lengths.
  input_preview: z.string().max(2000),
  output_preview: z.string().max(2000),
  environment: z.string().max(32).default("dev"),
  app_id: z.string().max(64).default("default"),
  tags: z.record(z.string(), z.string()).default({}),
});

export const logBatchSchema = z.object({
  events: z.array(logEventSchema).min(1).max(500),
});

// Compile-time guard: if the SDK's LogEvent shape drifts from the Zod
// schema's output, this assignment fails to typecheck. That's the
// canary — if it breaks, update one side to match the other.
type _SchemaMirrorsSDK = z.infer<typeof logEventSchema> extends LogEvent
  ? LogEvent extends z.infer<typeof logEventSchema>
    ? true
    : false
  : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _check: _SchemaMirrorsSDK = true;

export type LogEventInput = z.infer<typeof logEventSchema>;
export type LogBatchInput = z.infer<typeof logBatchSchema>;
