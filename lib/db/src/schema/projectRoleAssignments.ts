import { pgTable, serial, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectRolesTable } from "./projectRoles";
import { employeesTable } from "./employees";

export const projectRoleAssignmentsTable = pgTable("project_role_assignments", {
  id: serial("id").primaryKey(),
  projectRoleId: integer("project_role_id").notNull().references(() => projectRolesTable.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("project_role_assignments_unique").on(t.projectRoleId, t.employeeId),
]);

export const insertProjectRoleAssignmentSchema = createInsertSchema(projectRoleAssignmentsTable).omit({ id: true, createdAt: true });
export type InsertProjectRoleAssignment = z.infer<typeof insertProjectRoleAssignmentSchema>;
export type ProjectRoleAssignment = typeof projectRoleAssignmentsTable.$inferSelect;
