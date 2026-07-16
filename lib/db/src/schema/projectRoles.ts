import { pgTable, text, serial, timestamp, real, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const projectRolesTable = pgTable("project_roles", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  dayRate: real("day_rate").notNull().default(0),
  budgetedDays: real("budgeted_days"),
  budgetedHours: real("budgeted_hours"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("project_roles_project_idx").on(t.projectId),
]);

export const insertProjectRoleSchema = createInsertSchema(projectRolesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProjectRole = z.infer<typeof insertProjectRoleSchema>;
export type ProjectRole = typeof projectRolesTable.$inferSelect;
