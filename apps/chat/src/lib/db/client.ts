// =====================================================================
// Postgres client — one shared pool, Drizzle on top
//
// Singleton pattern so Next.js HMR doesn't open a new pool per reload.
// In dev, hot-reload re-runs module-level code; we stash the pool on
// globalThis so the second import finds it.
// =====================================================================

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getEnv } from "../env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __pulse_pg_pool: Pool | undefined;
}

function getPool(): Pool {
  if (globalThis.__pulse_pg_pool) return globalThis.__pulse_pg_pool;
  const pool = new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // We don't crash the process on stray pool errors — they're recovered
  // by reconnect. We DO log them so we notice if PG goes flaky.
  pool.on("error", (err) => {
    console.error("[pg pool error]", err);
  });
  globalThis.__pulse_pg_pool = pool;
  return pool;
}

export const db = drizzle(getPool(), { schema });
