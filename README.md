# Pulse

> A lightweight LLM inference logging & observability platform.

Pulse wraps your LLM calls with a single TypeScript SDK and ships structured logs through a Redis-Streams ingestion pipeline into ClickHouse, where they fuel a Grafana dashboard with p50/p95/p99 latency, throughput, error rate, and token usage — sliced by provider and model.



---

## What it looks like

| | |
|---|---|
| **Chat app** — Next.js, streams tokens, multi-turn, mid-conversation provider switching | http://localhost:3000 |
| **Dashboard** — 8 panels over the live `inference_logs` table, refreshes every 10s | http://localhost:3001/d/pulse-overview |
| **Ingestion API** — Fastify, `POST /v1/logs`, `GET /healthz` | http://localhost:4000 |

---

## Quick start

> Requires Docker, Docker Compose, Node 20+.

```bash
git clone <repo>
cd pulse
cp .env.example .env
# 1. fill in GEMINI_API_KEY (https://aistudio.google.com/apikey)
# 2. fill in GROQ_API_KEY  (https://console.groq.com/keys)
# 3. set POSTGRES_PORT=5433 if you already have a Postgres on 5432

docker compose up -d           # Postgres, ClickHouse, Redis, Grafana
npm install                    # installs every workspace

# In two terminals:
npm run dev:ingestion          # :4000
npm run dev:chat               # :3000
```

Open http://localhost:3000, pick a model, send a message. Then open http://localhost:3001/d/pulse-overview — your call shows up on the dashboard within ~1 second.

To wipe state and start fresh: `docker compose down -v`.

---

## Repo layout

```
pulse/
├── apps/
│   ├── chat/                  Next.js 15 + React 19. Streaming chat UI.
│   │   ├── src/app/api/chat/  POST handler that streams ndjson frames
│   │   └── src/components/    Sidebar, chat shell, model picker
│   └── ingestion/             Fastify service
│       ├── src/http/          POST /v1/logs validator + producer
│       ├── src/consumer/      Redis Streams worker -> CH bulk insert
│       └── src/pii/           Regex-based redaction
├── packages/
│   └── sdk/                   @pulse/sdk — unified LLM client
│       ├── src/providers/     Gemini + Groq adapters
│       ├── src/logger/        Bounded buffer + HTTP transport
│       └── src/client.ts      createPulse() factory
├── infra/
│   ├── postgres/01_schema.sql conversations + messages
│   ├── clickhouse/01_schema.sql inference_logs + 1-min rollup MV
│   └── grafana/provisioning/  Datasource yaml + dashboard JSON
├── docs/
│   ├── ARCHITECTURE.md        Component map + data-flow walkthrough
│   └── HANDOFF.md             Session log used during development
└── docker-compose.yml
```

---

## Architecture

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                      │
   │   ┌──────────┐    ┌────────────────┐                                 │
   │   │ Browser  │ ⇄  │  Next.js chat  │                                 │
   │   │  (user)  │ndj │   apps/chat    │                                 │
   │   └──────────┘    └────────┬───────┘                                 │
   │                            │ reads/writes                            │
   │                            ▼                                         │
   │                     ┌─────────────┐                                  │
   │                     │  Postgres   │  conversations + messages        │
   │                     │ (operational│  (chat history; trace_id bridge) │
   │                     └─────────────┘                                  │
   │                                                                      │
   │   chat-shell ──── pulse.chatStream(...) ──── @pulse/sdk              │
   │                            │                                         │
   │                            │ provider call (Gemini / Groq)           │
   │                            ▼                                         │
   │                    ┌───────────────┐                                 │
   │                    │  LLM provider │                                 │
   │                    └───────┬───────┘                                 │
   │                            │ stream text deltas                      │
   │                            ▼                                         │
   │                    SDK builds LogEvent ── HTTP POST ──┐              │
   │                                                       │              │
   │                                                       ▼              │
   │                                          ┌────────────────────────┐  │
   │                                          │ Fastify ingestion API  │  │
   │                                          │   apps/ingestion       │  │
   │                                          └────────┬───────────────┘  │
   │                                                   │ XADD             │
   │                                                   ▼                  │
   │                                          ┌────────────────────────┐  │
   │                                          │ Redis Streams          │  │
   │                                          │  pulse:inference-logs  │  │
   │                                          └────────┬───────────────┘  │
   │                                                   │ XREADGROUP       │
   │                                                   ▼                  │
   │                                          ┌────────────────────────┐  │
   │                                          │ Consumer (same proc)   │  │
   │                                          │  redact PII -> batch   │  │
   │                                          └────────┬───────────────┘  │
   │                                                   │ INSERT           │
   │                                                   ▼                  │
   │                                          ┌────────────────────────┐  │
   │                                          │  ClickHouse            │  │
   │                                          │  inference_logs +      │  │
   │                                          │  inference_logs_1m MV  │  │
   │                                          └────────┬───────────────┘  │
   │                                                   │ SQL              │
   │                                                   ▼                  │
   │                                          ┌────────────────────────┐  │
   │                                          │ Grafana (8 panels)     │  │
   │                                          └────────────────────────┘  │
   │                                                                      │
   └──────────────────────────────────────────────────────────────────────┘
```

**Why the two-database split (Postgres + ClickHouse)?** The two reads have opposite shapes:
- *"Give me the last 20 messages for conversation X"* — random access, low cardinality of writes per row. Postgres territory.
- *"What's p95 latency across all calls in the last hour by provider"* — analytical scan over millions of rows. ClickHouse territory.

Trying to do both in one DB means either slow chat or slow dashboards. We use `trace_id` as the bridge: every assistant message in Postgres carries the same UUID as one row in ClickHouse.

Full walkthrough in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Architecture notes

Quick brief on the four things a reviewer usually wants up front. For full detail, follow the links into [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Ingestion flow

A chat turn produces exactly one `LogEvent`. The SDK never POSTs it inline — it pushes onto an in-memory buffer and returns the response to the caller immediately. A 1-second flush tick drains up to 50 events per batch and POSTs them as `{ events: [...] }` to `apps/ingestion`'s Fastify endpoint. Ingestion Zod-validates the batch, then `XADD`s each event onto the Redis Stream `pulse:inference-logs` and responds `202 Accepted`. A consumer worker in the same Node process reads via `XREADGROUP` (consumer group `ingestion-workers`), redacts PII from `input_preview`/`output_preview`, bulk-inserts the batch into ClickHouse `inference_logs` via JSONEachRow, and `XACK`s only on insert success. The materialized view `inference_logs_1m_mv` fires synchronously on insert and updates the 1-minute rollup. End-to-end latency from chat turn to dashboard: typically <2 seconds.

### Logging strategy

One row per LLM call, keyed by a UUID `trace_id` generated by the SDK **before** the upstream provider request. Every assistant message in Postgres carries the same `trace_id`, so a Grafana row links back to the chat that produced it. Telemetry lives in ClickHouse (analytical), conversation state in Postgres (operational) — they're never mixed. Previews (first 500 chars of input and output) are persisted for forensics but redacted of emails / phones / API-keys / Bearer tokens before they hit disk; full chat content stays in Postgres behind app-level access. The SDK is fire-and-forget by design: a logging-pipeline failure must never block or crash the caller's chat request, so the buffer drops oldest on overflow and the HTTP transport swallows every error after backoff.

### Scaling considerations

The schema is designed to behave well as the table grows:
- **Compression.** `ORDER BY (provider, model, timestamp)` with `LowCardinality(String)` on provider / model / status / error_code dictionary-encodes those columns; on 10M rows you'd see ~10-50× compression vs. plain strings.
- **Pre-aggregation.** Grafana never scans the raw table for time-series panels — it reads `inference_logs_1m`, populated by an MV with `quantilesTDigestState(0.5, 0.95, 0.99)`. Latency quantiles cost milliseconds at any row count.
- **Bounded retention.** `PARTITION BY toYYYYMM(timestamp)` + a 90-day TTL means dropping old data is `ALTER TABLE ... DROP PARTITION`, O(1).
- **Horizontal scale.** The SDK is stateless. Adding ingestion workers is `docker compose scale ingestion=N` — Redis Streams' consumer-group semantics share the load automatically. ClickHouse insert throughput is the real ceiling; native batching via the `@clickhouse/client` is what makes the demo's 1-thread consumer plenty for ~50k events/sec on a laptop. Beyond that you'd shard by `app_id` or move to a Distributed table.
- **Storage.** ClickHouse's MergeTree handles billions of rows on a single node; the demo's bottleneck is ingestion's single-process consumer, not the database.

### Failure handling assumptions

| Failure | Behavior | Why it's acceptable |
|---|---|---|
| Provider returns 5xx / aborts | SDK throws → route emits `error` frame → log row written with `status='error'` and a bucketed `error_code` | Errors are first-class data; dashboards surface them |
| User closes the tab mid-stream | `req.signal.aborted=true` flows into the SDK → upstream request torn down → log row written with `error_code='aborted'` | No zombie LLM calls |
| Ingestion API is down | SDK's buffer holds up to 100 events; oldest start dropping. Per-call latency unaffected. | Logging never breaks the user's chat |
| ClickHouse is down | Ingestion still XADDs to Redis; consumer's INSERT fails; entries stay un-ACKed for retry | When CH recovers, the consumer drains the backlog. Redis retains `MAXLEN ~ 100k` |
| Redis is down | Ingestion's XADD throws → 503 to SDK → SDK backs off | Some events may be dropped past buffer cap; visible via dropped-counter |
| Consumer crashes mid-batch | Batch's entries remain in the PEL assigned to the dead consumer name | **Known gap**: no `XAUTOCLAIM` reclaim loop yet (see "What I'd improve") |

We assume **at-least-once delivery**, not exactly-once: a crash between `INSERT` and `XACK` can produce a duplicate row. `trace_id` makes dedup a single `GROUP BY trace_id`; cross-engine two-phase commit doesn't exist anyway.

---

## Schema design decisions

### Postgres ([infra/postgres/01_schema.sql](infra/postgres/01_schema.sql))

| Choice | Why |
|---|---|
| UUIDv4 PKs via `gen_random_uuid()` | Trace-id collision impossible across services; no per-table sequence to coordinate |
| `conversation_status` and `message_role` as enums | Validation at the DB layer; tiny on-disk size; clean Drizzle types in TS |
| `model` / `provider` denormalized on `messages` | The chat UI labels each bubble; hitting ClickHouse per render would be insane. Also supports mid-conversation provider switching. |
| `trace_id` on assistant messages | Cross-DB bridge to ClickHouse `inference_logs` |
| Partial index `WHERE status != 'archived'` | Sidebar list query is the hot path; partial keeps the index tiny |

### ClickHouse ([infra/clickhouse/01_schema.sql](infra/clickhouse/01_schema.sql))

| Choice | Why |
|---|---|
| `ORDER BY (provider, model, timestamp)` | LowCardinality columns first → massive compression; time last so range scans still use the primary index |
| `LowCardinality(String)` on provider/model/status/error_code | Dictionary-encoded; ~5 providers and ~30 models compress to tiny integer IDs |
| `total_tokens` MATERIALIZED = input + output | Stored on disk, free at SELECT |
| `tags Map(LowCardinality(String), String)` | Extensibility without schema migrations; queryable as `tags['feature']` |
| `PARTITION BY toYYYYMM(timestamp)` | Drop 90-day-old data with one O(1) `DROP PARTITION` |
| `inference_logs_1m` materialized view with `quantilesTDigestState(0.5, 0.95, 0.99)` | Pre-aggregated minute buckets so Grafana never scans the raw table |
| `TTL toDateTime(timestamp) + INTERVAL 90 DAY DELETE` | Bounded storage |

---

## The SDK

`@pulse/sdk` exposes a single factory. Drop it into any TypeScript service and every call gets logged.

```ts
import { createPulse } from "@pulse/sdk";

const pulse = createPulse({
  apiKeys: {
    gemini: process.env.GEMINI_API_KEY,
    groq:   process.env.GROQ_API_KEY,
  },
  defaultTags: { source: "my-service", env: "prod" },
});

// Non-streaming
const res = await pulse.chat({
  provider: "gemini",
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Summarize this PR" }],
  tags: { feature: "code-review" },
});
console.log(res.text, res.latencyMs, res.traceId);

// Streaming
for await (const chunk of pulse.chatStream({
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  messages: [...],
})) {
  if (chunk.done) console.log("usage:", chunk.response);
  else            process.stdout.write(chunk.delta);
}
```

The SDK never blocks the LLM call on log delivery:
- Writes are batched into a 100-event bounded buffer (drop-oldest on overflow).
- A 1s flush timer ships batches to the ingestion HTTP endpoint with exponential backoff (1s → 30s cap) on failure.
- Errors in the logging path **never propagate** into the caller's await. A logging SDK that crashes user code is worse than one that silently drops events.

---

## The dashboard

Eight panels on `http://localhost:3001/d/pulse-overview`:

| | | What it shows |
|---|---|---|
| 1 | Requests (window) | Total LLM calls in the time range |
| 2 | p95 latency | 95th-percentile end-to-end latency |
| 3 | Error rate | % of calls with `status='error'` |
| 4 | Total tokens | Sum of `total_tokens` (MATERIALIZED column) |
| 5 | Request rate by provider | Time-series, stacked bars (reads the MV) |
| 6 | Latency p50 / p95 / p99 | Time-series (reads the MV's tDigest state) |
| 7 | Token usage by model | Horizontal stacked bars (input + output) |
| 8 | Recent calls | Tail of `inference_logs` with trace_id |

Refreshes every 10s. Default range is last hour.

---

## Tradeoffs made

- **Two databases instead of one.** Postgres for chat state, ClickHouse for telemetry. Adds operational surface (two engines, two clients, two schemas to keep coherent), but the alternative — putting analytical scans on Postgres or chat random-access on ClickHouse — would have made one of them painfully slow as soon as the table grew past a few thousand rows. The split pays for itself the moment the demo has 10k inference logs.

- **Redis Streams instead of Kafka.** Streams gives us consumer groups, at-least-once delivery, and bounded retention (`MAXLEN ~`) without running a JVM, a Zookeeper / KRaft quorum, or a schema registry. The cost is no infinite replay history and no real multi-broker durability — fine for a demo and probably fine until ~50k events/sec, beyond which Kafka starts to win on raw throughput and ecosystem.

- **At-least-once delivery, not exactly-once.** A crash between the ClickHouse `INSERT` and the Redis `XACK` will cause one duplicate row on the next consumer boot. We accept this because `trace_id` is a unique UUID per call — dedup-on-query is one `GROUP BY` — and because exactly-once would require a two-phase commit across Redis and ClickHouse, which doesn't exist. For analytics data the rare duplicate is invisible; for a payments queue I'd have built this differently.

- **In-memory buffer + drop-oldest in the SDK.** A logging SDK that ever blocks or crashes the user's LLM call is worse than one that silently drops events. So: 100-event bounded buffer, oldest-out on overflow, exponential backoff on transport failure, all errors swallowed before they reach the caller. The visible cost is that a sustained ingestion outage > a couple seconds of buffer headroom means data loss with no on-disk fallback. A disk-backed queue (BadgerDB, SQLite WAL) would close that gap; for this scope it's overkill.

- **PII redaction on the ingestion side, not in the SDK.** Two reasons: (1) the SDK should stay tiny and dependency-free — bundling a regex catalog of every secret format is the wrong shape of growth; (2) ingestion is the trust boundary that decides what's safe to persist, so one place to update rules. The downside is that raw previews fly over the network to ingestion before redaction — fine for localhost, would need mTLS in production.

- **Regex PII rules instead of NER.** Catches the high-impact stuff (emails, API keys, Bearer tokens, AWS keys, phones) cheaply. Misses named entities (people, addresses) that need a model. False positives are tolerable (`[email]` is a graceful degradation); false negatives are a security incident, so the rules err toward over-redacting.

- **Drizzle schema mirrored from the SQL file by hand.** The Postgres schema lives in `infra/postgres/01_schema.sql` as the source of truth — human-readable, version-controlled, runs as the container's init script. Drizzle's TS schema exists only for typed queries. The friction is that any column change has to be applied in both places. The win is that the database schema isn't hidden behind a code generator.

- **JSON-lines streaming protocol instead of SSE.** SSE adds `data: ` framing and `event:` types for capabilities we don't use (we control both ends, don't need browser EventSource). One JSON object per line + `application/x-ndjson` is the minimum that lets us multiplex text deltas with a final `done` payload carrying `assistantMessageId`, `traceId`, and usage stats.

- **No auth.** Single-user demo; the schema has nullable `user_id TEXT` columns so adding auth is "set the column on insert + filter queries by `WHERE user_id = $1`." Building proper auth (sessions, password hashing, CSRF) would have eaten a day for zero observability signal.

- **Anthropic adapter intentionally not implemented.** The `ProviderAdapter` interface is two methods (`chat`, `chatStream`); adding Anthropic is a half-day's work. Gemini (free) + Groq (free, fast TTFT) cover the demo's "multi-provider" requirement without burning credits.

- **`gemini` abort is cooperative, not transport-level.** The current `@google/generative-ai` SDK doesn't accept an `AbortSignal`. We poll `signal.aborted` between chunks and break the async iterator — the HTTP connection closes when GC reaps the iterator, which is "eventually" not "immediately." Switching to the lower-level Vertex AI SDK would fix this but increases per-call overhead.

---

## What I'd improve with more time

- **`XAUTOCLAIM` reclaim loop on the consumer.** Today, if a consumer process crashes mid-batch, its pending entries stay assigned to its (dead) consumer name and never get re-delivered. A periodic `XAUTOCLAIM` against entries idle for more than 60s would reassign them to a live consumer. Five-line addition, but I haven't built it.

- **Real cost calculation.** `cost_usd` is stubbed at `0` in the ingestion writer. A per-model price table (inputs and outputs priced separately) would let the dashboard answer "what's this conversation costing us" — arguably the most useful metric for an LLM observability platform. The hard part isn't computing the number, it's keeping the price table fresh.

- **Dashboard template variables.** Right now every panel queries the full dataset. Adding `$provider`, `$model`, `$environment`, and `$conversation_id` Grafana template variables would let one dashboard serve every drill-down — "show me only Groq calls in prod for the last 24h" with no SQL editing.

- **A migration runner.** `infra/postgres/01_schema.sql` runs once on first volume init. There's no story for evolving the schema after first boot — production needs `sqitch`, `dbmate`, or `golang-migrate` so changes are versioned, idempotent, and rollback-able.

- **SDK unit tests.** The buffer's drop-oldest behavior, the transport's backoff window, and the provider adapters' message-shape translation each deserve isolated tests. Today the only evidence the SDK works is the end-to-end smoke run in this repo — that proves *behavior*, but a refactor would have nothing to catch a regression.

- **Hot / cold storage tiering in ClickHouse.** 90-day TTL is a blunt instrument. Real prod would mark older partitions as moved to an S3-backed disk: queries on cold data get slower but storage cost drops 10×. ClickHouse supports this via `storage_policy`; I just haven't configured it.

- **CI check for Drizzle / SQL drift.** A GitHub Action that runs `drizzle-kit introspect` against the SQL schema and diffs the result against `src/lib/db/schema.ts` would catch the failure mode where someone edits one and forgets the other. Right now we trust the developer; in a team of more than one person that's not enough.

- **Self-observability.** Pulse watches *other* services; nothing watches Pulse. The ingestion service should emit its own metrics — Redis stream length, consumer lag, ClickHouse insert latency, redaction match counts — so when the platform itself degrades you find out from a dashboard, not from "no new rows appearing." Ideally these emit to a separate `pulse.ingestion_metrics` table so we don't recursively log into the table we're trying to monitor.

- **Anthropic adapter + tool-call support.** The current adapter contract only handles text in / text out. Wiring tool calls (function calling, structured outputs) means extending `ChatMessage` with `tool_calls` and `tool_results` shapes — straightforward but a real expansion of the SDK surface.

- **Web of latency, not just LLM latency.** The dashboard shows `latency_ms` as wall-clock around the provider call. It doesn't break that into "DNS + TLS handshake," "TTFT," "tokens-per-second after first token." For real prod debugging those would each be their own column / panel.

- **Token-rate (tokens/sec) panel.** Total tokens / latency gives an effective throughput number that lets you compare models on the same axis. Trivially derived from existing columns, just didn't make the cut.

---

## License

MIT
