// =====================================================================
// ClickHouse client — one shared connection, one insert helper
//
// We use the official @clickhouse/client over the HTTP interface.
// Why HTTP and not native TCP?
//   - The official Node client only ships HTTP.
//   - HTTP over the loopback is fast enough; native TCP wins only at
//     very high QPS, which the demo doesn't need.
//
// Insert strategy:
//   - format: 'JSONEachRow' lets us pass plain JS objects, CH parses.
//   - The consumer calls insertBatch() with whatever it pulled from
//     Redis in one tick. Batching is the whole reason for the Streams
//     buffer — CH ingest is 100x faster on batches of 100 than on
//     singletons.
// =====================================================================

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { LogEventInput } from "../schema.js";

/** ClickHouse's JSONEachRow parser accepts DateTime64 strings in the
 *  shape 'YYYY-MM-DD HH:MM:SS.fff' (no 'T', no 'Z'). The SDK ships
 *  ISO8601, so we normalize at the DB boundary. We don't shift
 *  timezones — the schema is declared as UTC and our input is UTC. */
function isoToClickHouseDateTime(iso: string): string {
  // "2026-05-24T14:39:14.000Z" → "2026-05-24 14:39:14.000"
  return iso.replace("T", " ").replace(/Z$/, "");
}

export interface ClickHouseDeps {
  url: string;
  username: string;
  password: string;
  database: string;
}

export class ClickHouseSink {
  private readonly client: ClickHouseClient;
  private readonly database: string;

  constructor(deps: ClickHouseDeps) {
    this.client = createClient({
      url: deps.url,
      username: deps.username,
      password: deps.password,
      database: deps.database,
      // keep_alive helps with the burst pattern of our consumer:
      // we drain a batch every couple seconds, all to the same host.
      keep_alive: { enabled: true },
    });
    this.database = deps.database;
  }

  /** Insert a batch of validated, redacted log events. Throws on failure;
   *  the consumer catches and decides whether to NACK (leave un-ACKed)
   *  vs. send to a dead-letter stream. */
  async insertBatch(events: LogEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await this.client.insert({
      table: `${this.database}.inference_logs`,
      values: events.map((e) => ({
        // Field order/names match the ClickHouse schema 1:1. The
        // snake_case LogEvent contract was designed for exactly this.
        // We DON'T set `total_tokens` (MATERIALIZED) or `ingested_at`
        // (DEFAULT now64(3)) — ClickHouse fills them.
        trace_id: e.trace_id,
        conversation_id: e.conversation_id,
        timestamp: isoToClickHouseDateTime(e.timestamp),
        provider: e.provider,
        model: e.model,
        streamed: e.streamed,
        status: e.status,
        latency_ms: e.latency_ms,
        time_to_first_token_ms: e.time_to_first_token_ms,
        input_tokens: e.input_tokens,
        output_tokens: e.output_tokens,
        cost_usd: 0, // priced server-side in a real build; demo leaves at 0
        error_code: e.error_code,
        error_message: e.error_message,
        input_preview: e.input_preview,
        output_preview: e.output_preview,
        environment: e.environment,
        app_id: e.app_id,
        tags: e.tags,
      })),
      format: "JSONEachRow",
    });
  }

  /** Liveness probe used by /healthz. */
  async ping(): Promise<boolean> {
    const r = await this.client.ping();
    return r.success;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
