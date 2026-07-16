/**
 * Calculate total hours and budget-day equivalents for a resource booking,
 * supporting both flat hoursPerDay mode and per-weekday hour overrides.
 *
 * weekdayHours maps ISO weekday string ("1"=Mon … "5"=Fri) to hours.
 * Pass null to use flat mode (bookableDays × hoursPerDay).
 *
 * Budget days are always in 8h equivalents: totalHours / 8.
 */

export type WeekdayHoursMap = Record<string, number>;

/**
 * Compute the hours to credit for a single calendar day.
 *
 * Returns 0 for weekends, holidays, vacation days, comp days, and any
 * weekday that has an explicit zero in weekdayHours.  Otherwise returns
 * the per-weekday override (when weekdayHours is provided) or hoursPerDay.
 *
 * This is the single authoritative rule for "how many hours does one working
 * day contribute?".  Both calcBookingHours and assignBookingToBuckets
 * delegate here so that adding a new exclusion only requires one change.
 *
 * @param dow             UTC day-of-week (0 = Sun, 6 = Sat)
 * @param dateStr         YYYY-MM-DD string for the day
 * @param hoursPerDay     flat-rate hours used when weekdayHours is null
 * @param weekdayHours    per-weekday map keyed by String(dow), or null for flat mode
 * @param holidaySet      set of YYYY-MM-DD strings that are public holidays
 * @param vacationDateSet set of YYYY-MM-DD strings that are employee vacation days
 * @param compDayDateSet  set of YYYY-MM-DD strings that are compensatory leave days
 */
export function calcDayHours(
  dow: number,
  dateStr: string,
  hoursPerDay: number,
  weekdayHours: WeekdayHoursMap | null,
  holidaySet: Set<string> = new Set(),
  vacationDateSet: Set<string> = new Set(),
  compDayDateSet: Set<string> = new Set(),
): number {
  if (dow === 0 || dow === 6) return 0;
  if (holidaySet.has(dateStr)) return 0;
  if (vacationDateSet.has(dateStr)) return 0;
  if (compDayDateSet.has(dateStr)) return 0;
  return weekdayHours != null ? (weekdayHours[String(dow)] ?? 0) : hoursPerDay;
}

export function calcBookingHours(
  startStr: string,
  endStr: string,
  hoursPerDay: number,
  weekdayHours: WeekdayHoursMap | null,
  holidayDates: string[] = [],
  vacationDateSet: Set<string> = new Set(),
  compDayDateSet: Set<string> = new Set(),
): { totalHours: number; budgetDays: number } {
  const holidaySet = new Set(holidayDates);
  let totalHours = 0;

  const d = new Date(startStr + "T00:00:00Z");
  const e = new Date(endStr   + "T00:00:00Z");

  while (d <= e) {
    const dow     = d.getUTCDay();
    const dateStr = d.toISOString().slice(0, 10);
    totalHours += calcDayHours(dow, dateStr, hoursPerDay, weekdayHours, holidaySet, vacationDateSet, compDayDateSet);
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return { totalHours, budgetDays: totalHours / 8 };
}
