# Pulse

> A lightweight LLM inference logging & observability platform.

Pulse wraps your LLM calls with a single TypeScript SDK and ships structured logs through a Redis-Streams ingestion pipeline into ClickHouse, where they fuel a Grafana dashboard with p50/p95/p99 latency, throughput, error rate, and token usage — sliced by provider and model.

Built as a take-home for [Ollive](https://ollive.ai)'s Founding Fullstack Engineer assignment.

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

> **TODO (Sujal):** write this yourself.

Seeds — pick the ones worth defending:
- **Redis Streams over Kafka.** Single-binary, no JVM, no Zookeeper / KRaft. Real prod with multi-region durability requirements would graduate to Kafka, but for this scale Streams cover at-least-once + consumer groups + bounded retention.
- **At-least-once delivery, not exactly-once.** Redis + ClickHouse can't 2PC. We accept that a crash between insert and XACK can produce duplicates; `trace_id` makes dedup-on-query trivial.
- **PII redaction is regex-based.** Catches 95% of secrets and emails; misses names/addresses (NER would). False positives are cheap, false negatives are a security incident.
- **Drizzle mirrors the SQL by hand.** SQL stays the human-readable source of truth in `infra/postgres/`; we trade some friction (manual mirror) for clarity.
- **JSON-lines over SSE on the chat stream.** We control both ends. SSE's `data: ` framing buys nothing here.
- **No auth.** Single-user demo. Schema has `user_id TEXT` placeholders for the obvious extension.
- **Provider-side cancellation is cooperative on Gemini.** The current `@google/generative-ai` SDK doesn't accept an `AbortSignal`. We break out of the async iterator on abort; HTTP closes by GC.
- **Anthropic adapter not built.** Out of stack-decision scope; the `ProviderAdapter` contract is two methods — adding it is a half-day.

---

## What I'd improve with more time

> **TODO (Sujal):** be specific and honest.

Seeds — concrete, fair-game admissions:
- **`XAUTOCLAIM` reclaim loop.** If a consumer crashes mid-batch, the pending entries stay assigned to its (dead) consumer-name forever. Production needs a periodic claim-from-stale-consumers job.
- **Cost calculation.** `cost_usd` is stubbed at `0`. A real build wires a per-model price table in the ingestion service.
- **Dashboard template variables.** `$provider`, `$model`, `$conversation_id` selectors would let one dashboard serve every drill-down.
- **Schema migrations.** Right now `infra/postgres/01_schema.sql` runs once on first volume init. A migration runner (sqitch, golang-migrate, dbmate) belongs here.
- **SDK tests.** The provider adapters, buffer, and transport each deserve unit tests. The current evidence is end-to-end smoke; that's not a substitute.
- **Hot / cold storage tiering in ClickHouse.** S3 disk after 30 days; 90-day TTL today is a blunt instrument.
- **Drift detection on the Drizzle / SQL mirror.** A CI check that runs `drizzle-kit introspect` against the SQL and diffs would catch the case where someone edits one and forgets the other.
- **Observability for the observability platform.** The ingestion service should emit its own metrics (queue depth, insert latency, redaction count) so we know when *Pulse* itself degrades.

---

## License

MIT
