import { pgTable, text, serial, timestamp, date, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const holidayCalendarsTable = pgTable("holiday_calendars", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const holidaysTable = pgTable("holidays", {
  id: serial("id").primaryKey(),
  calendarId: integer("calendar_id").notNull().references(() => holidayCalendarsTable.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  name: text("name").notNull(),
});

export const insertHolidayCalendarSchema = createInsertSchema(holidayCalendarsTable).omit({ id: true, createdAt: true });
export type InsertHolidayCalendar = z.infer<typeof insertHolidayCalendarSchema>;
export type HolidayCalendar = typeof holidayCalendarsTable.$inferSelect;

export const insertHolidaySchema = createInsertSchema(holidaysTable).omit({ id: true });
export type InsertHoliday = z.infer<typeof insertHolidaySchema>;
export type Holiday = typeof holidaysTable.$inferSelect;
