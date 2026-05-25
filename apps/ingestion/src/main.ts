// =====================================================================
// Ingestion service — process entry
//
// Boots in order:
//   1. Load + validate config (fails loud on bad env)
//   2. Connect to ClickHouse + Redis
//   3. Ensure the Redis consumer group exists
//   4. Start the HTTP server
//   5. Start the consumer worker
//
// On SIGTERM / SIGINT we reverse the order:
//   1. Stop accepting new HTTP requests (server.close())
//   2. Stop the consumer worker (lets in-flight inserts finish)
//   3. Close Redis + ClickHouse connections
// This minimizes data loss on a normal shutdown. A hard kill (-9) is
// still handled by the at-least-once delivery guarantee — un-ACKed
// entries are re-delivered on next boot.
// =====================================================================

import { loadConfig } from "./config.js";
import { ClickHouseSink } from "./clickhouse/client.js";
import { StreamProducer } from "./redis/stream.js";
import { ConsumerWorker } from "./consumer/worker.js";
import { buildServer } from "./http/server.js";

async function main() {
  const config = loadConfig();

  const sink = new ClickHouseSink({
    url: config.clickhouseUrl,
    username: config.CLICKHOUSE_USER,
    password: config.CLICKHOUSE_PASSWORD,
    database: config.CLICKHOUSE_DB,
  });

  const producer = new StreamProducer({
    url: config.REDIS_URL,
    streamKey: config.REDIS_STREAM_KEY,
    consumerGroup: config.REDIS_CONSUMER_GROUP,
    streamMaxLen: config.REDIS_STREAM_MAXLEN,
  });

  await producer.ensureGroup();

  const server = buildServer({ producer, sink });

  const worker = new ConsumerWorker({
    redisUrl: config.REDIS_URL,
    streamKey: config.REDIS_STREAM_KEY,
    consumerGroup: config.REDIS_CONSUMER_GROUP,
    consumerName: config.REDIS_CONSUMER_NAME,
    batchSize: config.CONSUMER_BATCH_SIZE,
    blockMs: config.CONSUMER_BLOCK_MS,
    sink,
    // Reuse Fastify's pino logger so all output is structured + uniform.
    logger: {
      info: (m) => server.log.info(m),
      warn: (m) => server.log.warn(m),
      error: (m, err) => server.log.error({ err }, m),
    },
  });

  await server.listen({
    port: config.INGESTION_PORT,
    host: config.INGESTION_HOST,
  });
  worker.start();

  // ── Graceful shutdown ───────────────────────────────────────────
  const shutdown = async (signal: string) => {
    server.log.info(`received ${signal}, shutting down`);
    try {
      await server.close();
      await worker.stop();
      await producer.close();
      await sink.close();
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("ingestion failed to start:", err);
  process.exit(1);
});
