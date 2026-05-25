// =====================================================================
// HTTP server — Fastify
//
// Two routes:
//   POST /v1/logs   — Zod-validate the body, XADD each event to Redis.
//                     Returns 202 Accepted + count. Producer-side latency
//                     is "Redis ack time", not "ClickHouse ack time" —
//                     that's the whole point of the queue.
//   GET  /healthz   — liveness probe. Returns 200 if Redis + CH respond.
//
// Why Fastify and not Express?
//   - Native async/await + first-class TypeScript.
//   - JSON parsing + schema validation is faster (built on the same
//     fast-json-stringify family).
//   - Plugin model is cleaner. Less yak-shaving for the demo.
// =====================================================================

import Fastify, { type FastifyInstance } from "fastify";
import { logBatchSchema } from "../schema.js";
import type { StreamProducer } from "../redis/stream.js";
import type { ClickHouseSink } from "../clickhouse/client.js";

export interface ServerDeps {
  producer: StreamProducer;
  sink: ClickHouseSink;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // Avoid logging request bodies — they may contain unredacted PII
      // until the consumer touches them.
      transport: undefined,
    },
    // Cap body size: a single batch shouldn't exceed ~2 MB even at
    // max-batch=500 with maxed-out previews. 5 MB is generous headroom.
    bodyLimit: 5 * 1024 * 1024,
  });

  // ── POST /v1/logs ────────────────────────────────────────────────
  // The SDK posts { events: LogEvent[] } here on each flush tick.
  app.post("/v1/logs", async (req, reply) => {
    const parsed = logBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      // 400 surfaces Zod issues to the SDK; the SDK ignores the body
      // and counts this as a delivery failure, triggering backoff.
      // We give a terse summary, not the full Zod issue tree — the
      // client doesn't get to know our internal validation shape.
      reply.code(400);
      return {
        error: "invalid_payload",
        issues: parsed.error.issues.slice(0, 5).map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
      };
    }

    const { events } = parsed.data;

    // XADD each event. We could pipeline these for throughput, but
    // 50-event batches over loopback don't need it — keep the
    // straight-line code for now.
    try {
      for (const event of events) {
        await deps.producer.push(event);
      }
    } catch (err) {
      // Redis unreachable → 503; SDK backs off and retries.
      req.log.error({ err }, "redis xadd failed");
      reply.code(503);
      return { error: "queue_unavailable" };
    }

    reply.code(202);
    return { accepted: events.length };
  });

  // ── GET /healthz ─────────────────────────────────────────────────
  app.get("/healthz", async (_req, reply) => {
    const checks = {
      redis: false,
      clickhouse: false,
    };
    try {
      const pong = await deps.producer.redis.ping();
      checks.redis = pong === "PONG";
    } catch {
      /* leave false */
    }
    try {
      checks.clickhouse = await deps.sink.ping();
    } catch {
      /* leave false */
    }

    const healthy = checks.redis && checks.clickhouse;
    reply.code(healthy ? 200 : 503);
    return { ok: healthy, checks };
  });

  return app;
}
