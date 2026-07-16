import { pgTable, text, varchar, serial, timestamp, real, date, integer, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";
import { projectsTable } from "./projects";
import { projectRolesTable } from "./projectRoles";

export const resourceBookingsTable = pgTable("resource_bookings", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  projectRoleId: integer("project_role_id").references(() => projectRolesTable.id, { onDelete: "set null" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  hoursPerDay: real("hours_per_day").notNull(),
  weekdayHours: jsonb("weekday_hours").$type<Record<string, number>>(),
  notes: text("notes"),
  status: varchar("status", { length: 20 }),
  pastReleasedAt: timestamp("past_released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("resource_bookings_employee_idx").on(t.employeeId),
  index("resource_bookings_dates_idx").on(t.startDate, t.endDate),
]);

export const insertResourceBookingSchema = createInsertSchema(resourceBookingsTable).omit({
  id: true, createdAt: true, updatedAt: true,
}).extend({
  status: z.enum(["tentative", "confirmed"]).nullable().optional(),
});
export type InsertResourceBooking = z.infer<typeof insertResourceBookingSchema>;
export type ResourceBooking = typeof resourceBookingsTable.$inferSelect;
