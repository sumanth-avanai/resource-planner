import { pgTable, text, serial, timestamp, boolean, real, integer, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const employeesTable = pgTable("employees", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  weeklyCapacityHours: real("weekly_capacity_hours").notNull().default(40),
  // Stored as comma-separated "1,1,1,1,1,0,0" (Mon-Sun)
  workingDaysMask: text("working_days_mask").notNull().default("1,1,1,1,1,0,0"),
  holidayCalendarCode: text("holiday_calendar_code"),
  contractStartDate: date("contract_start_date"),
  contractEndDate: date("contract_end_date"),
  utilizationTarget: integer("utilization_target"),
  personalAccessToken: text("personal_access_token").notNull(),
  personalAccessPinHash: text("personal_access_pin_hash").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEmployeeSchema = createInsertSchema(employeesTable).omit({ id: true, createdAt: true });
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employeesTable.$inferSelect;
