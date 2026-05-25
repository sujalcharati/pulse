// =====================================================================
// Redis Streams — producer + consumer-group helpers
//
// Why Redis Streams (not Lists, not Pub/Sub, not BullMQ)?
//   - Streams give us consumer groups: multiple workers can scale-out
//     by sharing the load, with at-least-once delivery semantics.
//   - Each entry has a stable ID (e.g. "1700000000000-0") that we ACK
//     after a successful ClickHouse insert. Crash mid-insert → on
//     restart, the entry is still pending and another worker picks it up.
//   - MAXLEN trim keeps the stream bounded; old un-ACKed entries
//     eventually fall off, which is acceptable for analytics data.
//   - Lower op surface than BullMQ/Kafka; right-sized for this demo.
//
// Producer API: pushEvent(event) → XADD to the stream.
// Consumer API: ensureGroup() at boot, then the worker uses XREADGROUP.
// =====================================================================

import Redis from "ioredis";
import type { LogEventInput } from "../schema.js";

export interface StreamDeps {
  url: string;
  streamKey: string;
  consumerGroup: string;
  streamMaxLen: number;
}

export class StreamProducer {
  // ioredis auto-connects on first command; no need for explicit .connect().
  // We make this public-readonly so the consumer can borrow the same
  // connection for XREADGROUP (a blocking call needs its own client
  // though — see the worker).
  readonly redis: Redis;

  constructor(private readonly deps: StreamDeps) {
    this.redis = new Redis(deps.url, { maxRetriesPerRequest: null });
  }

  /** XADD one event to the stream. We store the full JSON under a single
   *  field "json" rather than splaying each property into its own field —
   *  the consumer always re-parses with the Zod schema anyway, so flat
   *  storage saves us from typed-field gymnastics. */
  async push(event: LogEventInput): Promise<string> {
    // MAXLEN ~ N tells Redis: "trim approximately to N entries". The
    // tilde lets it trim in whole node chunks, which is much cheaper
    // than exact trimming.
    const id = await this.redis.xadd(
      this.deps.streamKey,
      "MAXLEN",
      "~",
      this.deps.streamMaxLen,
      "*", // let Redis assign the ID
      "json",
      JSON.stringify(event),
    );
    if (!id) throw new Error("XADD returned null");
    return id;
  }

  /** Create the consumer group if it doesn't exist. Idempotent — the
   *  BUSYGROUP error means "already exists", which is fine. */
  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        "CREATE",
        this.deps.streamKey,
        this.deps.consumerGroup,
        "$", // start consuming new entries only on first boot
        "MKSTREAM", // create the stream if it doesn't exist yet
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("BUSYGROUP")) throw err;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
