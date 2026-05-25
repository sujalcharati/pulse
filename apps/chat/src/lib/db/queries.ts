// =====================================================================
// Typed query helpers
//
// Centralizing every read/write here keeps the route handlers / RSCs
// readable and gives us one place to look when the schema changes.
// Each function has a clear name and a single SQL responsibility.
// =====================================================================

import { desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import {
  conversations,
  messages,
  type Conversation,
  type Message,
} from "./schema";

// ── Conversations ────────────────────────────────────────────────────

/** List conversations for the sidebar, most-recently-updated first.
 *  We don't paginate yet — see "What I'd improve" in the README. */
export async function listConversations(limit = 50): Promise<Conversation[]> {
  return db
    .select()
    .from(conversations)
    .where(sql`${conversations.status} <> 'archived'`)
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createConversation(args: {
  title: string | null;
}): Promise<Conversation> {
  const rows = await db
    .insert(conversations)
    .values({ title: args.title })
    .returning();
  // .returning() on a single insert always yields exactly one row.
  return rows[0]!;
}

/** Update updated_at + (optionally) title. We bump updated_at manually
 *  on message insert so the sidebar list sorts correctly even though
 *  the SQL trigger only fires on conversations updates. */
export async function touchConversation(args: {
  id: string;
  title?: string;
}): Promise<void> {
  await db
    .update(conversations)
    .set({
      updatedAt: new Date(),
      ...(args.title ? { title: args.title } : {}),
    })
    .where(eq(conversations.id, args.id));
}

export async function cancelConversation(id: string): Promise<void> {
  await db
    .update(conversations)
    .set({ status: "cancelled" })
    .where(eq(conversations.id, id));
}

// ── Messages ────────────────────────────────────────────────────────

/** Load every message for a conversation, in order. The chat UI calls
 *  this on resume; the API route calls it to assemble the prompt. */
export async function loadMessages(
  conversationId: string,
): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

export async function appendUserMessage(args: {
  conversationId: string;
  content: string;
}): Promise<Message> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId: args.conversationId,
      role: "user",
      content: args.content,
    })
    .returning();
  return rows[0]!;
}

export async function appendAssistantMessage(args: {
  conversationId: string;
  content: string;
  provider: string;
  model: string;
  traceId: string;
}): Promise<Message> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId: args.conversationId,
      role: "assistant",
      content: args.content,
      provider: args.provider,
      model: args.model,
      traceId: args.traceId,
    })
    .returning();
  return rows[0]!;
}

/** Derive a conversation title from the first user message.
 *  Trim to ~60 chars; first newline wins. Cheap heuristic — good enough
 *  for the sidebar. Real prod would use the LLM to summarize. */
export function deriveTitle(firstUserMessage: string): string {
  const oneLine = firstUserMessage.split("\n")[0]?.trim() ?? "";
  if (oneLine.length <= 60) return oneLine;
  return oneLine.slice(0, 57) + "...";
}

