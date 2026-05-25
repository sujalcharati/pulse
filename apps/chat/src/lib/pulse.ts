// =====================================================================
// Pulse SDK — process-singleton client
//
// One client per Node process means one buffer + one flush timer for
// the entire app. Survives HMR reloads via globalThis (same trick
// as the pg pool).
//
// Default tags get stamped on every log event so dashboards can slice
// by app source ("chat-app") vs other clients later.
// =====================================================================

import { createPulse, type PulseClient } from "@pulse/sdk";
import { getEnv } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __pulse_sdk_client: PulseClient | undefined;
}

export function getPulse(): PulseClient {
  if (globalThis.__pulse_sdk_client) return globalThis.__pulse_sdk_client;
  const env = getEnv();
  const client = createPulse({
    apiKeys: {
      gemini: env.GEMINI_API_KEY,
      groq: env.GROQ_API_KEY,
    },
    ingestUrl: env.PULSE_INGEST_URL,
    environment: process.env.NODE_ENV ?? "dev",
    appId: "chat-app",
    defaultTags: { source: "chat-app" },
  });
  globalThis.__pulse_sdk_client = client;
  return client;
}
