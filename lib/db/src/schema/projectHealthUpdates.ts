import { pgTable, serial, integer, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const projectHealthUpdatesTable = pgTable("project_health_updates", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  generalStatus: varchar("general_status", { length: 20 }).notNull(),
  budgetStatus: varchar("budget_status", { length: 20 }),
  riskLevel: varchar("risk_level", { length: 20 }).notNull(),
  clientSatisfaction: varchar("client_satisfaction", { length: 20 }),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectHealthUpdate = typeof projectHealthUpdatesTable.$inferSelect;
