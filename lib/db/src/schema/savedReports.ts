import { pgTable, text, varchar, timestamp } from "drizzle-orm/pg-core";

export const savedReportsTable = pgTable("saved_reports", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  config: text("config").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SavedReport = typeof savedReportsTable.$inferSelect;
