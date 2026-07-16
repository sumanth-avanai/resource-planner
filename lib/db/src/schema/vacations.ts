import { pgTable, text, serial, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { employeesTable } from "./employees";

export const VACATION_TYPES = ["vacation", "sick", "unpaid_leave", "other"] as const;
export type VacationType = typeof VACATION_TYPES[number];

export const employeeVacationsTable = pgTable("employee_vacations", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employeesTable.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  vacationType: text("vacation_type").notNull().default("vacation"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVacationSchema = createInsertSchema(employeeVacationsTable).omit({ id: true, createdAt: true });
export type InsertVacation = z.infer<typeof insertVacationSchema>;
export type EmployeeVacation = typeof employeeVacationsTable.$inferSelect;
