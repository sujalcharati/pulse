// =====================================================================
// PII redaction — runs on every preview before it hits ClickHouse
//
// Design philosophy: false positives are fine, false negatives are not.
// A redacted "name@company.com" → "[email]" is a tiny loss; a leaked
// customer email in a dashboard is a security incident.
//
// Scope: we redact previews only. The full conversation content lives
// in Postgres (operational store), where it stays gated by app-level
// access controls. Analytics in ClickHouse should never need full bodies.
//
// What we redact, in priority order (run cheapest/most-specific first):
//   1. API-key-like tokens (sk-..., ghp_..., AKIA..., Bearer ...)
//   2. Email addresses
//   3. Phone numbers (loose match — false positives acceptable)
//   4. Long digit sequences that look like card/SSN-ish
//
// What we do NOT do here:
//   - Named-entity recognition (names, addresses) — that needs a model.
//   - Provider-specific token shapes — a real prod build would have a
//     pluggable registry. README "What I'd improve" calls this out.
// =====================================================================

interface Rule {
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  // Bearer tokens (in case a caller pasted a curl command into a prompt)
  { pattern: /Bearer\s+[A-Za-z0-9._\-]{16,}/g, replacement: "[token]" },
  // OpenAI-style keys (sk-...) and similar prefixed secrets
  { pattern: /\b(?:sk|pk|rk|api)[_-][A-Za-z0-9]{16,}\b/g, replacement: "[token]" },
  // GitHub PATs
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: "[token]" },
  // AWS access key IDs
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[token]" },
  // Emails — RFC-imperfect on purpose. Good enough catches >99%.
  {
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[email]",
  },
  // Phone numbers: international and US-style. Permissive on grouping
  // (spaces, dashes, dots, parens). Requires 10+ digits to avoid
  // mangling things like "year 2024" or "model gpt-4o".
  {
    pattern: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
    replacement: "[phone]",
  },
  // Long runs of digits (13-19) → card/account-ish. Comes last so the
  // phone regex gets its specific shape first.
  { pattern: /\b\d{13,19}\b/g, replacement: "[number]" },
];

/** Apply all redaction rules to a string. Pure function — safe to call
 *  on hot paths since RegExp objects are reused. */
export function redactPii(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { pattern, replacement } of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
