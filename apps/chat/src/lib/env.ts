// =====================================================================
// Env config for the chat app — server-side only.
//
// Next.js loads .env automatically from the package root. We also fall
// back to the repo-root .env (which is where keys actually live in this
// monorepo) via dotenv-style hierarchy: Next loads apps/chat/.env first,
// then we don't bother with the root because deploy-time you'd put env
// where Next expects it. For dev, we mirror via a symlink.
// =====================================================================

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  GEMINI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  PULSE_INGEST_URL: z.string().url().default("http://localhost:4000/v1/logs"),
});

let cached: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (cached) return cached;
  cached = envSchema.parse(process.env);
  return cached;
}
