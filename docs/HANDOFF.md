# Pulse — Session Handoff

> This file exists so you (Sujal) can resume work from a fresh Claude session
> rooted at `/home/sujal/pulse` without losing context. Open this in VS Code,
> then tell Claude: **"Read `docs/HANDOFF.md` and let's continue from where
> we left off."**

---

## What this project is

A lightweight LLM inference logging + ingestion platform — the take-home for
Ollive's Founding Fullstack Engineer role. Apply via the Binary form at
http://binary.so/9M0tvNM. Rolling deadline; Ollive promises a result within
48 hours of submission.

## Tech stack (already decided)

- **Language:** TypeScript everywhere, npm workspaces (no pnpm)
- **Chat app:** Next.js (App Router) + Tailwind + shadcn/ui — in `apps/chat`
- **Ingestion service:** Fastify + Zod — in `apps/ingestion`
- **SDK:** unified TS wrapper around Gemini + Groq + Anthropic — in `packages/sdk`
- **Operational DB:** Postgres 16 (conversations, messages)
- **Analytics DB:** ClickHouse 24.8 (inference logs + 1m materialized rollup)
- **Queue:** Redis Streams (server-side, not in the SDK)
- **Dashboards:** Grafana 11 with grafana-clickhouse-datasource (auto-provisioned)
- **Demo:** Loom video over Docker Compose locally; skip hosting/k8s unless trivial

## Working mode

**Explain-as-we-go.** Claude scaffolds boilerplate + explains; user writes the
core thinking parts (SDK API design choices, README "Tradeoffs", README
"What I'd improve"). Every line of code must pass the *explain-it-cold* test
because the interview will probe deeply. **Do not bulk-generate code without
walking through it first.**

---

## Progress so far

### ✅ Milestone 1 — Foundation scaffolded
- `package.json` (root) with `apps/*` + `packages/*` npm workspaces
- `.gitignore`, `.env.example`, `tsconfig.base.json`
- `README.md` skeleton with `TODO (Sujal)` markers for the thinking sections
- Folder structure: `apps/{chat,ingestion}`, `packages/sdk`, `infra/{postgres,clickhouse,grafana}`, `docs/`
- `git init -b main` done; no commits yet

### ✅ Milestone 2 — Docker Compose
- `docker-compose.yml` brings up: Postgres 16, ClickHouse 24.8, Redis 7, Grafana 11
- Health checks on all services
- Persistent volumes (`pgdata`, `chdata`, `redisdata`, `grafanadata`)
- Grafana datasource auto-provisioned from `infra/grafana/provisioning/datasources/datasources.yml`
- Grafana dashboard provider configured (dashboards JSON to be added in M7)
- All 4 images pulled (Docker engine confirmed running)
- Ports: Postgres 5432, ClickHouse 8123, Redis 6379, Grafana 3001 (3001 to avoid clashing with Next.js on 3000)

### ✅ Milestone 3 — Database schemas
**Decisions taken (Sujal approved all recommendations):**
- D1: UUIDs (v4 via `gen_random_uuid()`) over serial ints
- D2: `model`/`provider` denormalized on `messages` AND `inference_logs`
- D3: ClickHouse `ORDER BY (provider, model, timestamp)`, `PARTITION BY toYYYYMM(timestamp)`, 90-day TTL
- D4: PII redaction happens in the ingestion service, not the SDK

**Files written:**
- [`infra/postgres/01_schema.sql`](../infra/postgres/01_schema.sql) — `conversations`, `messages`, enums (`conversation_status`, `message_role`), updated-at trigger, two indexes
- [`infra/clickhouse/01_schema.sql`](../infra/clickhouse/01_schema.sql) — `inference_logs` table + `inference_logs_1m` materialized view rollup with `quantileTDigestState` for p50/p95/p99

**Interview talking points already baked into the SQL comments:**
- Why split Postgres + ClickHouse (different access patterns)
- Why `LowCardinality(String)` for provider/model/status
- Why `ORDER BY (provider, model, timestamp)` (compression + dashboard query shape)
- Why `total_tokens` is `MATERIALIZED` (free at SELECT time)
- Why the 1-minute materialized view exists (Grafana shouldn't scan raw)
- Why the `tags Map(String, String)` field (extensibility without schema changes)

---

### ✅ Milestone 4 — SDK (`packages/sdk`)

**Decisions taken (recommendations accepted):**
- A: Unified API — `pulse.chat({ provider, model, messages })` + `pulse.chatStream(...)`
- B: SDK → HTTP → ingestion → Redis Streams (server-side). SDK has no Redis dep.
- C: In-memory buffer (cap 100, drop-oldest) + periodic flush (1s) with exponential backoff (1s → 30s cap)

**Files written:**
- [`packages/sdk/package.json`](../packages/sdk/package.json) — ESM, `@pulse/sdk`, deps: `@google/generative-ai@^0.24.1`, `groq-sdk@^1.2.0`, `@types/node`
- [`packages/sdk/tsconfig.json`](../packages/sdk/tsconfig.json) — extends base, `composite: true`, emits to `dist/`
- [`packages/sdk/src/types.ts`](../packages/sdk/src/types.ts) — `ChatRequest`, `ChatResponse`, `ChatStreamChunk`, `LogEvent` (snake_case wire format, 1:1 with ClickHouse cols), `PulseConfig`
- [`packages/sdk/src/providers/base.ts`](../packages/sdk/src/providers/base.ts) — narrow `ProviderAdapter` contract (chat + chatStream only)
- [`packages/sdk/src/providers/gemini.ts`](../packages/sdk/src/providers/gemini.ts) — Gemini adapter; pulls system msgs out into `systemInstruction`, remaps `assistant`→`model`, collapses consecutive same-role turns
- [`packages/sdk/src/providers/groq.ts`](../packages/sdk/src/providers/groq.ts) — Groq adapter; reads streaming usage from `chunk.x_groq.usage` (Groq's OpenAI-compatible extension)
- [`packages/sdk/src/logger/buffer.ts`](../packages/sdk/src/logger/buffer.ts) — bounded array, drop-oldest on overflow, `unshift()` for retry-on-failure
- [`packages/sdk/src/logger/transport.ts`](../packages/sdk/src/logger/transport.ts) — `setInterval` flusher with `flushing` guard + `nextAllowedFlushAt` backoff window; `timer.unref()` so CLIs can still exit
- [`packages/sdk/src/client.ts`](../packages/sdk/src/client.ts) — `createPulse()` factory; generates UUID trace_id before the call, measures latency / TTFT, buckets errors into LowCardinality codes (`rate_limit`, `context_length`, `timeout`, `auth`, `aborted`, `server_error`, `unknown`)
- [`packages/sdk/src/index.ts`](../packages/sdk/src/index.ts) — public surface: `createPulse`, all types

**Verified:**
- `npx tsc -p packages/sdk/tsconfig.json --noEmit` passes
- `npx tsc -p packages/sdk/tsconfig.json` emits a clean `dist/`
- Both provider SDKs installed at expected versions

**Interview talking points baked into comments:**
- Why drop-oldest (freshest events most useful during outages)
- Why batch HTTP (network RTT dominates per-event cost)
- Why `flushing` guard + `nextAllowedFlushAt` (no double-send, no separate timers)
- Why `timer.unref()` (don't pin the Node event loop)
- Why narrow `ProviderAdapter` contract (cheap to add Anthropic later)
- Why snake_case LogEvent (1:1 ClickHouse mapping, no rename step in ingestion)
- Why error classification is heuristic (LowCardinality compression vs. per-provider classifiers — README "What I'd improve")
- Why TTFT measured at first non-empty delta (some providers emit empty deltas for tool-call kickoffs)

**Not yet done (deferred to later milestones):**
- No unit tests on the SDK yet (smoke-test via the chat app in M6 will exercise it end-to-end; consider adding `vitest` tests on `buffer.ts` + `transport.ts` if time allows)
- No live test against real Gemini/Groq API keys yet — needs `GEMINI_API_KEY` / `GROQ_API_KEY` in `.env`
- Anthropic adapter not built (out of scope per stack decision; `@anthropic-ai/sdk` not installed)

---

### ✅ Milestone 5 — Ingestion service (`apps/ingestion`)

**Data flow:** SDK → `POST /v1/logs` → Zod validate → `XADD pulse:inference-logs` → consumer `XREADGROUP` (batch up to 100, BLOCK 2s) → redact PII → ClickHouse `INSERT` → `XACK`.

**Files written:**
- [`apps/ingestion/package.json`](../apps/ingestion/package.json) — Fastify 5 (ESM), ioredis, @clickhouse/client, zod, dotenv, tsx for dev
- [`apps/ingestion/tsconfig.json`](../apps/ingestion/tsconfig.json)
- [`apps/ingestion/src/config.ts`](../apps/ingestion/src/config.ts) — Zod-parsed env; fails loud at boot
- [`apps/ingestion/src/schema.ts`](../apps/ingestion/src/schema.ts) — `logEventSchema` + `logBatchSchema`; includes a **compile-time drift guard** asserting `z.infer<typeof logEventSchema> ≡ LogEvent` (from SDK)
- [`apps/ingestion/src/pii/redact.ts`](../apps/ingestion/src/pii/redact.ts) — regex rules for emails, phones, AWS keys, GitHub PATs, Bearer tokens, OpenAI-style `sk-*` keys, long digit runs
- [`apps/ingestion/src/clickhouse/client.ts`](../apps/ingestion/src/clickhouse/client.ts) — wraps official client, `insertBatch()` via JSONEachRow, normalizes ISO8601 → `'YYYY-MM-DD HH:MM:SS.fff'` for `DateTime64`
- [`apps/ingestion/src/redis/stream.ts`](../apps/ingestion/src/redis/stream.ts) — `StreamProducer` (XADD with `MAXLEN ~ 100k`), `ensureGroup()` idempotent on BUSYGROUP
- [`apps/ingestion/src/consumer/worker.ts`](../apps/ingestion/src/consumer/worker.ts) — dedicated Redis client for blocking XREADGROUP; poison-message policy: ACK and drop on Zod fail; insert fail: leave un-ACKed for retry
- [`apps/ingestion/src/http/server.ts`](../apps/ingestion/src/http/server.ts) — `POST /v1/logs` returns 202, body limit 5MB, `GET /healthz` pings Redis + CH
- [`apps/ingestion/src/main.ts`](../apps/ingestion/src/main.ts) — boots in dependency order, reverses on SIGTERM/SIGINT (server → worker → producer → sink)

**Fixed during build:**
- ClickHouse schema used `quantileTDigest(0.5, 0.95, 0.99)` (singular) which only accepts one level. Switched to `quantilesTDigest(0.5, 0.95, 0.99)` (plural) — returns Array(Float64) of [p50,p95,p99] via `quantilesTDigestMerge`. Schema file updated.

**Smoke tested end-to-end:**
- POST a synthetic event with emails, phones, and an AWS key in previews
- Verified row landed in `inference_logs` with `[email]` / `[phone]` / `[token]` redactions
- Verified `total_tokens` MATERIALIZED column = `input_tokens + output_tokens`
- Verified `inference_logs_1m` rollup populated (count + total_latency_ms)
- Verified `tags` Map round-trips correctly
- `GET /healthz` returns `{"ok":true,"checks":{"redis":true,"clickhouse":true}}`

**Interview talking points baked into comments:**
- Why a Redis Streams hop and not direct CH writes (batching, crash safety, fan-out)
- Why `MAXLEN ~` over exact trim (cheap, amortized)
- Why `">"` consumer token vs explicit ID (new-only; recovery is separate concern)
- Why dedicated Redis client for the consumer (BLOCK pins the connection)
- Why poison messages get ACKed (analytics use case; for payments you'd DLQ)
- Why at-least-once not exactly-once (Redis+CH can't 2PC; trace_id makes dedup cheap)
- The compile-time SDK↔schema drift guard

**Known follow-ups (acceptable for demo; cite in README "What I'd improve"):**
- No `XAUTOCLAIM` loop for orphaned PEL entries (consumer crashes leave their pending entries stranded). One left over from this session's testing.
- Cost calculation stubbed at `cost_usd: 0`. Wire up a per-model price table.
- Postgres host port 5432 conflicts with system Postgres. Either remap to 5433 in `.env` or stop the system PG before M6.

---

### ✅ Milestone 6 — Chat app (`apps/chat`)

**Decisions taken (recommendations accepted):**
- D: Drizzle ORM (typed queries; SQL stays source of truth in `infra/postgres/`)
- E: JSON-lines streaming on `/api/chat` (frames: `meta`, `delta`, `done`, `error`)
- F: Skip auth — single-user demo
- Postgres remapped to host port 5433 to coexist with system PG

**Files written:**
- [`apps/chat/package.json`](../apps/chat/package.json) — Next.js 15 + React 19 RC, drizzle-orm, pg, shadcn primitives
- [`apps/chat/next.config.mjs`](../apps/chat/next.config.mjs) — `transpilePackages: ["@pulse/sdk"]`, `serverExternalPackages: ["pg"]`
- [`apps/chat/.env.local`](../apps/chat/.env.local) — symlink to root `.env` (single source of truth)
- [`apps/chat/src/lib/env.ts`](../apps/chat/src/lib/env.ts) — Zod-parsed env, cached
- [`apps/chat/src/lib/models.ts`](../apps/chat/src/lib/models.ts) — provider→model whitelist (Gemini 2.5/2.0, Llama 3.x via Groq)
- [`apps/chat/src/lib/db/schema.ts`](../apps/chat/src/lib/db/schema.ts) — Drizzle mirror of `infra/postgres/01_schema.sql`
- [`apps/chat/src/lib/db/client.ts`](../apps/chat/src/lib/db/client.ts) — pg Pool + Drizzle, singleton via `globalThis` for HMR safety
- [`apps/chat/src/lib/db/queries.ts`](../apps/chat/src/lib/db/queries.ts) — typed query helpers (`listConversations`, `loadMessages`, `appendUserMessage`, etc.)
- [`apps/chat/src/lib/stream-protocol.ts`](../apps/chat/src/lib/stream-protocol.ts) — ndjson encoder + async-generator decoder
- [`apps/chat/src/lib/pulse.ts`](../apps/chat/src/lib/pulse.ts) — `getPulse()` SDK singleton with default tags `{source: "chat-app"}`
- [`apps/chat/src/app/api/chat/route.ts`](../apps/chat/src/app/api/chat/route.ts) — POST handler; builds ReadableStream, forwards SDK chatStream, persists messages, handles abort + mid-stream-failure recovery
- [`apps/chat/src/components/ui/*`](../apps/chat/src/components/ui/) — shadcn primitives (button, textarea, scroll-area, select) inlined
- [`apps/chat/src/components/sidebar.tsx`](../apps/chat/src/components/sidebar.tsx) — server-rendered conversation list
- [`apps/chat/src/components/model-picker.tsx`](../apps/chat/src/components/model-picker.tsx) — provider+model Select (encoded as `provider:model`)
- [`apps/chat/src/components/chat-shell.tsx`](../apps/chat/src/components/chat-shell.tsx) — client component; owns streaming state, optimistic bubbles, AbortController cancel, auto-scroll, per-message usage footer
- [`apps/chat/src/app/page.tsx`](../apps/chat/src/app/page.tsx), [`apps/chat/src/app/c/[id]/page.tsx`](../apps/chat/src/app/c/[id]/page.tsx) — root + conversation pages
- [`.npmrc`](../.npmrc) — `legacy-peer-deps=true` (drizzle's optional expo peers vs React 19 RC)

**Smoke tested end-to-end:**
- Single Gemini call: meta → delta → done frames; full audit chain through Postgres + ClickHouse with `total_tokens` MATERIALIZED, `tags` merging `{source:"chat-app", conversation_id:"..."}` ✓
- Multi-turn with provider switch: turn 1 Gemini 2.5 Flash, turn 2 Groq Llama 3.1 8B on same conversation; Groq's 72 input tokens prove full context was sent; response correctly recalls turn 1 ✓
- TTFT contrast: Groq 475ms vs Gemini 3232ms (the whole point of an observability platform) ✓
- Cross-DB join via `tags['conversation_id']` works in ClickHouse ✓
- `/c/[bogus-uuid]` returns 404 ✓

**Fixed during build:**
- Next.js bundler doesn't resolve `.js → .ts` like `tsc` does under `moduleResolution: "Bundler"`; stripped `.js` extensions from internal chat-app imports
- `.env.local` symlink so root `.env` is single source of truth
- Gemini 1.5 models retired from v1beta endpoint; bumped whitelist to 2.5/2.0
- `legacy-peer-deps=true` to resolve drizzle's optional peer (expo-sqlite, op-sqlite) vs React 19 RC conflict

**Interview talking points baked into comments:**
- Why JSON-lines over SSE (no `data:` framing overhead; we control both ends)
- Why send `meta` frame *before* the LLM call starts (lets the UI render the user bubble immediately)
- Why reload history from DB instead of in-memory concat (single source of truth)
- Why `req.signal` flows all the way to the provider (no zombie LLM calls on tab close)
- Why mid-stream-failure persists `assembled + "[interrupted]"` (durability under failure)
- Why `x-accel-buffering: no` (defeats nginx chunk buffering)
- Why Drizzle mirrors SQL by hand (SQL stays the source of truth + human-readable; types still safe)
- Why per-message `provider`/`model` denorm (mid-conversation provider switch is a bonus requirement)
- Why `assistantMessageId` only known after stream finishes (sequencing the frames is intentional)

**Known follow-ups (cite in README "What I'd improve"):**
- No pagination on the sidebar; all conversations load
- No "delete conversation" UI yet
- Title derivation is a string truncate; could use the LLM for a smart title
- The `model-picker.tsx` exposes only 5 models; should be auto-populated from a `/api/models` endpoint that hits the provider

---

### ✅ Milestone 7 — Grafana dashboards (`infra/grafana/`)

**Files written:**
- [`infra/grafana/provisioning/datasources/datasources.yml`](../infra/grafana/provisioning/datasources/datasources.yml) — pinned `uid: pulse-clickhouse` so dashboards reference the datasource deterministically across re-provisions
- [`infra/grafana/provisioning/dashboards/pulse-overview.json`](../infra/grafana/provisioning/dashboards/pulse-overview.json) — 8-panel dashboard, auto-loaded by the file provider

**Dashboard panels (each picks a specific schema decision to demonstrate):**
| # | Panel | Source | Demonstrates |
|---|-------|--------|--------------|
| 1 | Requests (window) — stat | `inference_logs` | `count()` on raw table |
| 2 | p95 latency — stat | `inference_logs` | `quantile(0.95)(latency_ms)` |
| 3 | Error rate — stat | `inference_logs` | `status='error'` filter + LowCardinality `error_code` |
| 4 | Total tokens — stat | `inference_logs` | MATERIALIZED `total_tokens` column |
| 5 | Request rate by provider — timeseries | `inference_logs_1m` | The MV pre-aggregation pays off |
| 6 | Latency p50 / p95 / p99 — timeseries | `inference_logs_1m` | `quantilesTDigestMerge` + `arrayElement` to unpack 3 series |
| 7 | Token usage by model — barchart | `inference_logs` | model column is LowCardinality |
| 8 | Recent calls — table | `inference_logs` | trace_id links to Postgres assistant messages |

**Fixed during build:**
- ClickHouse healthcheck used `wget http://localhost:8123/ping`, which resolves to IPv6 `[::1]` inside the alpine image — CH only binds IPv4. Switched to `127.0.0.1`. Grafana's `depends_on: condition: service_healthy` now actually works.
- The latency-quantile time-series panel originally selected the raw `Array(Float32)` column; the Grafana time-series visualizer requires scalar fields. Split into `p50`/`p95`/`p99` via `arrayElement`.

**Smoke tested:**
- Generated 10 mixed Gemini + Groq calls
- Verified via `POST /api/ds/query` (Grafana's datasource proxy) that all panels return data
- TTFT spread (Groq 129-356ms vs Gemini 1237-3875ms) makes the streaming-latency story visible
- Dashboard URL: http://localhost:3001/d/pulse-overview (admin/admin or anonymous viewer)

**Interview talking points baked into the dashboard JSON's `description` fields:**
- Why panels 5 & 6 read the MV (pre-aggregated, no raw scan per refresh)
- Why panel 4 highlights `total_tokens` MATERIALIZED (free on SELECT)
- Why panel 3 emphasizes the `LowCardinality(String) error_code` bucketing
- Why panel 8 mentions `trace_id` as the cross-DB join key

**Known follow-ups (cite in README "What I'd improve"):**
- No dashboard variables yet (e.g. `$provider` template var to slice all panels by one provider)
- No drill-down link from the Recent Calls table to a per-trace detail view
- No cost panel (cost_usd is stubbed at 0 in ingestion; would need a price table)
- No alerting rules (Grafana 11 supports them via provisioning, but out of scope here)

---

## Remaining milestones

8. **README + ARCHITECTURE.md + Loom demo** — *Sujal writes Tradeoffs + Improvements sections*

---

## Open items / things to do soon

- [ ] Apply on Binary now (basic info + resume) so you're in their pipeline before submitting code
- [ ] Get GEMINI_API_KEY at https://aistudio.google.com/apikey
- [ ] Get GROQ_API_KEY at https://console.groq.com/keys
- [ ] First `git add . && git commit -m "initial scaffold + schemas"` once milestone 3 feels done
- [ ] Create GitHub repo (public) — name it `pulse`
- [ ] Confirm Docker Desktop stays running between sessions

## Environment

- Working directory: `/home/sujal/pulse`
- Tools installed: Node 20.20.0, npm 10.8.2, Docker 29.4.3, Docker Compose v2.39.4, Git 2.43.0
- Missing (not needed): pnpm, gh CLI
- Docker images pulled: postgres:16-alpine, clickhouse/clickhouse-server:24.8-alpine, redis:7-alpine, grafana/grafana:11.3.0

## How to resume in a fresh session

1. Open `/home/sujal/pulse` in VS Code (`code /home/sujal/pulse`)
2. Open Claude Code in that window
3. Say: **"Read `docs/HANDOFF.md` — I want to decide A/B/C and continue from milestone 4."**
4. Pick A/B/C per the recommendations (or override), and the SDK build begins.
