// We're not using drizzle to push schema — Postgres is already provisioned
// by infra/postgres/01_schema.sql. This config exists only to enable
// `drizzle-kit introspect` (rare) and to satisfy the toolchain.
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
