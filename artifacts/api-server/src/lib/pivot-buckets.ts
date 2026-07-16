/**
 * Pure helpers for mapping calendar dates to pivot report buckets and
 * accumulating per-booking hours into those buckets.
 *
 * No DB or Express dependencies — safe to import in unit tests.
 */

import { calcDayHours } from "./booking-hours";

// ─── ISO-week helpers ─────────────────────────────────────────────────────────

export function getISOWeekInfo(dateStr: string): { year: number; week: number } {
  const d = new Date(dateStr + "T12:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return {
    year: d.getUTCFullYear(),
    week: Math.ceil(((d.getTime() - y0.getTime()) / 86400000 + 1) / 7),
  };
}

// ─── Date → bucket key ────────────────────────────────────────────────────────

export function dateToBucket(dateStr: string, colDim: string): string {
  if (colDim === "none")    return "Total";
  if (colDim === "month")   return dateStr.slice(0, 7);
  if (colDim === "quarter") {
    const mon = parseInt(dateStr.slice(5, 7));
    return `${dateStr.slice(0, 4)}-Q${Math.ceil(mon / 3)}`;
  }
  if (colDim === "week") {
    const { year, week } = getISOWeekInfo(dateStr);
    return `${year}-W${String(week).padStart(2, "0")}`;
  }
  return "Total";
}

// ─── Booking → bucket hours ───────────────────────────────────────────────────

/**
 * Walk every calendar day in the intersection of [booking.startDate,
 * booking.endDate] and [rangeStart, rangeEnd], accumulate hours per colDim
 * bucket, and return the resulting map.
 *
 * Returns {} when the booking has no overlap with the requested range.
 */
export function assignBookingToBuckets(
  booking: { startDate: string; endDate: string; hoursPerDay: number; weekdayHours: Record<string, number> | null },
  rangeStart: string,
  rangeEnd: string,
  colDim: string,
  holidayDateSet: Set<string> = new Set(),
  vacationDateSet: Set<string> = new Set(),
  compDayDateSet: Set<string> = new Set(),
): Record<string, number> {
  const oStart = booking.startDate > rangeStart ? booking.startDate : rangeStart;
  const oEnd   = booking.endDate   < rangeEnd   ? booking.endDate   : rangeEnd;
  if (oStart > oEnd) return {};

  const res: Record<string, number> = {};
  const d = new Date(oStart + "T00:00:00Z");
  const e = new Date(oEnd   + "T00:00:00Z");
  while (d <= e) {
    const dow     = d.getUTCDay();
    const dateStr = d.toISOString().slice(0, 10);
    const hours   = calcDayHours(dow, dateStr, booking.hoursPerDay, booking.weekdayHours, holidayDateSet, vacationDateSet, compDayDateSet);
    if (hours > 0) {
      const b = colDim === "none" ? "Total" : dateToBucket(dateStr, colDim);
      res[b] = (res[b] ?? 0) + hours;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return res;
}
