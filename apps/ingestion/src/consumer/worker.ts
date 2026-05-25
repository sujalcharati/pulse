// =====================================================================
// Consumer worker — XREADGROUP loop, redact, batch-insert, XACK
//
// Lifecycle:
//   start() → loop:
//     1. XREADGROUP BLOCK <ms> COUNT <batchSize> from the stream
//     2. Parse JSON, validate with Zod (defense-in-depth; the HTTP
//        producer already validated, but a stale producer could XADD
//        a malformed entry)
//     3. Redact PII on input/output previews
//     4. Bulk-insert to ClickHouse
//     5. XACK each successful entry
//   stop() → set a flag, let the current iteration finish, close clients
//
// Failure modes:
//   - Zod parse fail on a single entry → log, XACK it anyway so it doesn't
//     get stuck in the PEL (pending entries list). The data is gone but
//     a poison message can't take down the consumer. This is the right
//     tradeoff for analytics (vs. a payments queue where you'd DLQ).
//   - ClickHouse insert fail → DON'T XACK. The entries stay pending,
//     XPENDING shows them, and on next loop iteration (or after the
//     pel-reclaim cron we'd add in prod) they get re-tried.
//
// Why a dedicated Redis client for XREADGROUP?
//   - XREADGROUP BLOCK holds the connection. If we shared the connection
//     with the producer (XADD), nothing else could XADD until the block
//     released. Two clients keeps the read loop independent.
// =====================================================================

import Redis from "ioredis";
import type { ClickHouseSink } from "../clickhouse/client.js";
import { logEventSchema, type LogEventInput } from "../schema.js";
import { redactPii } from "../pii/redact.js";

export interface WorkerDeps {
  redisUrl: string;
  streamKey: string;
  consumerGroup: string;
  consumerName: string;
  batchSize: number;
  blockMs: number;
  sink: ClickHouseSink;
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string, err?: unknown) => void };
}

export class ConsumerWorker {
  private readonly redis: Redis;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly deps: WorkerDeps) {
    // Dedicated client; BLOCK reads pin the connection while waiting.
    this.redis = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    // Disconnect interrupts the blocking XREADGROUP cleanly.
    await this.redis.quit().catch(() => {});
    if (this.loopPromise) await this.loopPromise.catch(() => {});
  }

  // ── main loop ──────────────────────────────────────────────────────
  private async loop(): Promise<void> {
    const { streamKey, consumerGroup, consumerName, batchSize, blockMs, logger } =
      this.deps;
    logger.info(
      `consumer ${consumerName} reading from ${streamKey} group=${consumerGroup}`,
    );

    while (this.running) {
      try {
        // XREADGROUP returns null on timeout (no new entries within blockMs).
        // Shape: [[streamKey, [[id, [field, val, field, val, ...]], ...]]]
        const res = (await this.redis.xreadgroup(
          "GROUP",
          consumerGroup,
          consumerName,
          "COUNT",
          batchSize,
          "BLOCK",
          blockMs,
          "STREAMS",
          streamKey,
          ">", // ">" = only new entries that haven't been delivered to anyone
        )) as [string, [string, string[]][]][] | null;

        if (!res || res.length === 0) continue;

        // We only listen to one stream, so res[0] is "ours".
        const entries = res[0]?.[1] ?? [];
        if (entries.length === 0) continue;

        const { valid, ids, dropped } = this.parseEntries(entries);

        if (valid.length > 0) {
          try {
            await this.deps.sink.insertBatch(valid);
            // XACK in one call — variadic, cheap.
            await this.redis.xack(streamKey, consumerGroup, ...ids);
          } catch (err) {
            // Insert failed → leave entries un-ACKed; they retry next loop.
            // We DO NOT XACK dropped here either; the dropped IDs would
            // need their own ACK pass, but on a CH outage that's the
            // least of our worries.
            logger.error(
              `clickhouse insert failed for ${valid.length} events; will retry`,
              err,
            );
            continue;
          }
        }

        if (dropped.length > 0) {
          // Poison messages: ACK and forget. They're already logged.
          await this.redis
            .xack(streamKey, consumerGroup, ...dropped)
            .catch(() => {});
        }
      } catch (err) {
        // ioredis throws when the connection is closed by stop(); that's
        // expected. For anything else, log and back off briefly.
        if (!this.running) return;
        logger.error("consumer loop error", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  // ── parse + redact ─────────────────────────────────────────────────
  private parseEntries(entries: [string, string[]][]): {
    valid: LogEventInput[];
    ids: string[];
    dropped: string[];
  } {
    const valid: LogEventInput[] = [];
    const ids: string[] = [];
    const dropped: string[] = [];

    for (const [id, fields] of entries) {
      // Fields come back as a flat [field, val, field, val, ...] array.
      // We stored just one field "json", so find its value.
      const jsonIdx = fields.indexOf("json");
      const raw = jsonIdx >= 0 ? fields[jsonIdx + 1] : undefined;
      if (!raw) {
        this.deps.logger.warn(`entry ${id} missing json field; dropping`);
        dropped.push(id);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.deps.logger.warn(`entry ${id} not JSON; dropping`);
        dropped.push(id);
        continue;
      }

      const result = logEventSchema.safeParse(parsed);
      if (!result.success) {
        this.deps.logger.warn(
          `entry ${id} failed schema validation; dropping`,
        );
        dropped.push(id);
        continue;
      }

      // PII redaction is the consumer's job (Decision D4). We mutate
      // the validated copy in place — it's about to be inserted.
      const event = result.data;
      event.input_preview = redactPii(event.input_preview);
      event.output_preview = redactPii(event.output_preview);

      valid.push(event);
      ids.push(id);
    }

    return { valid, ids, dropped };
  }
}
