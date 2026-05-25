// =====================================================================
// Env configuration — parsed once at boot
//
// We use Zod to validate env vars rather than spreading `process.env.X ?? "..."`
// across the codebase. Reasons:
//   - Bad/missing config fails loud at boot, not on the first request.
//   - One place to look for "what does this service need to run".
//   - Types flow through: `config.port` is `number`, not `string | undefined`.
// =====================================================================

import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // HTTP
  INGESTION_PORT: z.coerce.number().int().positive().default(4000),
  INGESTION_HOST: z.string().default("0.0.0.0"),

  // Redis (event-driven queue)
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_STREAM_KEY: z.string().default("pulse:inference-logs"),
  REDIS_CONSUMER_GROUP: z.string().default("ingestion-workers"),
  REDIS_CONSUMER_NAME: z.string().default(`ingestion-${process.pid}`),
  // Cap the stream so a misbehaving producer can't blow up memory.
  // ~ means approximate trim (cheap, allowed to overshoot slightly).
  REDIS_STREAM_MAXLEN: z.coerce.number().int().positive().default(100_000),

  // ClickHouse
  CLICKHOUSE_HOST: z.string().default("localhost"),
  CLICKHOUSE_PORT: z.coerce.number().int().positive().default(8123),
  CLICKHOUSE_USER: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DB: z.string().default("pulse"),

  // Consumer tuning
  CONSUMER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  CONSUMER_BLOCK_MS: z.coerce.number().int().nonnegative().default(2000),
});

export type Config = z.infer<typeof envSchema> & {
  clickhouseUrl: string;
};

export function loadConfig(): Config {
  const parsed = envSchema.parse(process.env);
  return {
    ...parsed,
    clickhouseUrl: `http://${parsed.CLICKHOUSE_HOST}:${parsed.CLICKHOUSE_PORT}`,
  };
}
