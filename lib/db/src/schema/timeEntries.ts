import { pgTable, text, serial, timestamp, real, date, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { projectsTable } from "./projects";
import { projectRolesTable } from "./projectRoles";

export const timeEntriesTable = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id),
  projectId: integer("project_id").notNull().references(() => projectsTable.id),
  projectRoleId: integer("project_role_id").references(() => projectRolesTable.id, { onDelete: "set null" }),
  entryDate: date("entry_date").notNull(),
  hours: real("hours").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("time_entries_emp_date_idx").on(t.employeeId, t.entryDate),
]);

export const insertTimeEntrySchema = createInsertSchema(timeEntriesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type TimeEntry = typeof timeEntriesTable.$inferSelect;
