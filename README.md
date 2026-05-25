# Pulse

> A lightweight LLM inference logging & ingestion platform.

Pulse instruments LLM calls in your app, ships structured logs to an ingestion pipeline in near real-time, stores them for analytics, and surfaces latency / throughput / error dashboards.

Built as a 4-day take-home for [Ollive](https://ollive.ai)'s Founding Fullstack Engineer assignment.

---

## What's in this repo

```
pulse/
├── apps/
│   ├── chat/          Next.js chatbot — multi-turn, streaming, multi-provider
│   └── ingestion/     Fastify service — Redis Streams consumer + HTTP fallback
├── packages/
│   └── sdk/           TypeScript SDK — wraps LLM calls, captures metadata
├── infra/
│   ├── postgres/      Init SQL for conversations + messages
│   ├── clickhouse/    Init SQL for inference_logs table
│   └── grafana/       Provisioned dashboards + datasources
├── docker-compose.yml One-command stack
└── docs/
    └── ARCHITECTURE.md
```

## Quick start

> Requires Docker, Docker Compose, and Node 20+.

```bash
git clone <repo>
cd pulse
cp .env.example .env          # fill in GEMINI_API_KEY and GROQ_API_KEY
docker compose up -d          # brings up Postgres, ClickHouse, Redis, Grafana
npm install                   # installs all workspace deps
npm run dev:ingestion         # ingestion API on :4000
npm run dev:chat              # chat UI on :3000
```

Open:
- **Chat:** http://localhost:3000
- **Grafana:** http://localhost:3001 (admin / admin)
- **ClickHouse Play:** http://localhost:8123/play

---

## Architecture

> **TODO (Sujal):** write this section yourself after the SDK + ingestion are working. Founding-engineer signal lives here.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.

---

## Schema design decisions

> **TODO (Sujal):** explain *why* the Postgres / ClickHouse split, *why* these indexes, *why* not normalize further.

---

## Tradeoffs made

> **TODO (Sujal):** write this yourself — this is the section reviewers read most closely.
> Candidate topics: Redis Streams vs Kafka, ClickHouse vs Postgres for logs, fire-and-forget SDK,
> regex PII vs ML-based, Loom demo vs hosted deploy.

---

## What I'd improve with more time

> **TODO (Sujal):** be specific and honest. Never write "nothing."

---

## License

MIT
