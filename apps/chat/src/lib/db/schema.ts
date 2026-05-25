// =====================================================================
// Drizzle schema — mirrors infra/postgres/01_schema.sql
//
// The SQL file is the source of truth for the actual DB; this file
// exists purely so queries are type-safe. We don't use drizzle-kit
// migrations against this DB — schema changes happen in the SQL file
// and are mirrored here by hand. That keeps a single source of truth
// readable as SQL while still giving us typed queries.
//
// Drift safety: if the SQL adds a column we don't have here, queries
// just won't see it (no error, but you lose the data). If we add a
// column here that's not in SQL, queries crash at runtime. Keep this
// file in lockstep with the SQL.
// =====================================================================

import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "archived",
  "cancelled",
]);

export const messageRoleEnum = pgEnum("message_role", [
  "user",
  "assistant",
  "system",
]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title"),
    status: conversationStatusEnum("status").notNull().default("active"),
    // Placeholder for future auth — left nullable per the SQL comment.
    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // The SQL index is partial (WHERE status != 'archived'); Drizzle's
  // ergonomic API doesn't model partial indexes, so we just declare the
  // base index here. The query planner will still use it.
  (t) => ({
    userUpdatedIdx: index("idx_conversations_user_updated")
      .on(t.userId, t.updatedAt),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    // Per-message provider/model so mid-conversation provider switching
    // is preserved on resume. Nullable for role='user' (the user doesn't
    // have a model).
    provider: text("provider"),
    model: text("model"),
    // Bridge to ClickHouse inference_logs.trace_id. Lets Grafana drill
    // back to the original chat row.
    traceId: uuid("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    convCreatedIdx: index("idx_messages_conversation_created").on(
      t.conversationId,
      t.createdAt,
    ),
  }),
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
