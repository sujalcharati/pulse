// =====================================================================
// Provider → model whitelist
//
// We don't let the UI ship arbitrary model strings — both for safety
// (a typo would hit the provider and burn cents) and for UX (the
// dropdown should reflect what we've actually tested).
//
// If you want to add a model, add it here and it shows up in the picker.
// =====================================================================

import type { ProviderName } from "@pulse/sdk";

export interface ModelChoice {
  provider: ProviderName;
  model: string;
  label: string;
}

export const MODELS: ModelChoice[] = [
  // Gemini — free tier, fast, decent for chat.
  // Note: Google retired the 1.5 series from v1beta; we use 2.x+ here.
  { provider: "gemini", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "gemini", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { provider: "gemini", model: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  // Groq — extremely fast TTFT, good for the streaming demo
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)" },
  { provider: "groq", model: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Groq, instant)" },
];

// MODELS is a static literal — index 0 is statically known, but TS's
// noUncheckedIndexedAccess infers `| undefined`. Assert and document.
export const DEFAULT_MODEL: ModelChoice = MODELS[0]!;

export function findModel(provider: string, model: string): ModelChoice | undefined {
  return MODELS.find((m) => m.provider === provider && m.model === model);
}
