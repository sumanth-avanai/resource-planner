/**
 * Shared helper: fetch all availability-related data for a set of employees.
 *
 * Returns a Map<employeeId, { holidayDates, vacationDateSet }>
 * so callers don't duplicate N+1 DB queries.
 */

import { eq, and, gte, lte, inArray } from "drizzle-orm";
import {
  db,
  employeesTable,
  holidayCalendarsTable,
  holidaysTable,
  employeeVacationsTable,
} from "@workspace/db";
import { buildVacationDateSet } from "./utilization";

export interface EmpAvailability {
  holidayDates:    string[];
  vacationDateSet: Set<string>;
  /**
   * Compensatory leave days (YYYY-MM-DD) that should be excluded from
   * planned and available hour calculations — same as vacation days.
   *
   * NOTE: No comp-day DB table exists yet. This field is wired into
   * calcDayHours so that once a `employeeCompDays` table is added and
   * queried here, the exclusion will automatically flow through to all
   * booking-hour and pivot-report computations without further changes.
   */
  compDayDateSet:  Set<string>;
}

export async function fetchEmpAvailabilityMap(
  employees: (typeof employeesTable.$inferSelect)[],
  periodStart: string,
  periodEnd:   string
): Promise<Map<number, EmpAvailability>> {
  if (employees.length === 0) return new Map();

  // ── 1. Holidays — group by calendar code to avoid redundant queries ──────
  const calCodeToHolidays = new Map<string, string[]>();

  for (const emp of employees) {
    if (!emp.holidayCalendarCode || calCodeToHolidays.has(emp.holidayCalendarCode)) continue;

    const [cal] = await db
      .select()
      .from(holidayCalendarsTable)
      .where(eq(holidayCalendarsTable.code, emp.holidayCalendarCode));

    if (cal) {
      const rows = await db
        .select({ date: holidaysTable.date })
        .from(holidaysTable)
        .where(eq(holidaysTable.calendarId, cal.id));
      calCodeToHolidays.set(emp.holidayCalendarCode, rows.map((r) => r.date));
    } else {
      calCodeToHolidays.set(emp.holidayCalendarCode, []);
    }
  }

  // ── 2. Vacations that overlap the period ──────────────────────────────────
  const empIds = employees.map((e) => e.id);

  const rawVacations = await db
    .select()
    .from(employeeVacationsTable)
    .where(
      and(
        inArray(employeeVacationsTable.employeeId, empIds),
        lte(employeeVacationsTable.startDate, periodEnd),
        gte(employeeVacationsTable.endDate,   periodStart)
      )
    );

  // Group vacations by employee id
  const vacByEmp = new Map<number, { startDate: string; endDate: string }[]>();
  for (const v of rawVacations) {
    if (!vacByEmp.has(v.employeeId)) vacByEmp.set(v.employeeId, []);
    vacByEmp.get(v.employeeId)!.push({ startDate: v.startDate, endDate: v.endDate });
  }

  // ── 3. Build result map ───────────────────────────────────────────────────
  const result = new Map<number, EmpAvailability>();

  for (const emp of employees) {
    const holidayDates =
      emp.holidayCalendarCode
        ? (calCodeToHolidays.get(emp.holidayCalendarCode) ?? [])
        : [];

    const vacationDateSet = buildVacationDateSet(vacByEmp.get(emp.id) ?? []);

    // compDayDateSet: placeholder empty set until an employeeCompDays table
    // is introduced. When that table exists, query it here (grouped by
    // employee, filtered to the period) and expand ranges into individual
    // YYYY-MM-DD strings — exactly as vacationDateSet is built above.
    const compDayDateSet = new Set<string>();

    result.set(emp.id, { holidayDates, vacationDateSet, compDayDateSet });
  }

  return result;
}
