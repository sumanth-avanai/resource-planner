/**
 * Utilization calculation logic.
 *
 * Available hours = theoretical working hours in a period based on:
 *   - employee weekly_capacity_hours and working days mask
 *   - minus holidays from the assigned calendar that fall on employee working days
 *   - minus vacation/absence days that fall on employee working days
 *   - constrained to [contractStartDate, contractEndDate] if provided
 *
 * Daily capacity = weekly_capacity_hours / number_of_active_working_days
 */

/**
 * Parse the working_days_mask stored as "1,1,1,1,1,0,0" (Mon=index 0, Sun=index 6).
 * Returns an array of 7 booleans.
 */
export function parseWorkingDaysMask(mask: string): boolean[] {
  return mask.split(",").map((v) => v.trim() === "1");
}

/**
 * Get the ISO day index (0=Mon, 6=Sun) for a given Date.
 * MUST use getUTCDay() — dates are always created as UTC midnight.
 */
function getIsoDayIndex(date: Date): number {
  const d = date.getUTCDay(); // 0=Sun … 6=Sat
  return d === 0 ? 6 : d - 1; // convert to 0=Mon … 6=Sun
}

/**
 * Expand a list of vacation {startDate, endDate} ranges into a Set of ISO date strings.
 * Overlapping ranges are deduplicated automatically.
 */
export function buildVacationDateSet(
  vacations: { startDate: string; endDate: string }[]
): Set<string> {
  const dates = new Set<string>();
  for (const v of vacations) {
    const cur = new Date(v.startDate + "T00:00:00Z");
    const end = new Date(v.endDate + "T00:00:00Z");
    while (cur <= end) {
      dates.add(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return dates;
}

/**
 * Calculate available working hours for an employee between startDate and endDate (inclusive).
 *
 * @param startDate         - ISO date string "YYYY-MM-DD"
 * @param endDate           - ISO date string "YYYY-MM-DD"
 * @param workingDaysMask   - mask string e.g. "1,1,1,1,1,0,0"
 * @param weeklyCapacityHours
 * @param holidayDates      - array of holiday ISO date strings from the employee's calendar
 * @param vacationDates     - Set (or array) of ISO date strings covered by vacation/absence
 * @param contractStartDate - first day of employment (days before → 0 availability)
 * @param contractEndDate   - last day of employment (days after → 0 availability), or null
 */
export function calculateAvailableHours(
  startDate: string,
  endDate: string,
  workingDaysMask: string,
  weeklyCapacityHours: number,
  holidayDates: string[],
  vacationDates: Set<string> | string[] = [],
  contractStartDate?: string | null,
  contractEndDate?: string | null
): number {
  const mask = parseWorkingDaysMask(workingDaysMask);

  const activeDaysPerWeek = mask.filter(Boolean).length;
  if (activeDaysPerWeek === 0) return 0;

  const dailyCapacity = weeklyCapacityHours / activeDaysPerWeek;

  const holidaySet  = new Set(holidayDates);
  const vacationSet = vacationDates instanceof Set ? vacationDates : new Set(vacationDates);

  let availableHours = 0;
  const current = new Date(startDate + "T00:00:00Z");
  const end     = new Date(endDate   + "T00:00:00Z");

  while (current <= end) {
    const isoDate = current.toISOString().slice(0, 10);

    // 1. Contract start — days before contract do not count
    if (contractStartDate && isoDate < contractStartDate) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    // 2. Contract end — days after contract do not count
    if (contractEndDate && isoDate > contractEndDate) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }

    // 3. Non-working day
    const dayIndex = getIsoDayIndex(current);
    if (!mask[dayIndex]) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }

    // 4. Public holiday
    if (holidaySet.has(isoDate)) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }

    // 5. Vacation / absence
    if (vacationSet.has(isoDate)) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }

    // 6. Working day — add daily capacity
    availableHours += dailyCapacity;
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return Math.round(availableHours * 100) / 100;
}

/**
 * Returns true if an employee's contract overlaps with the given period.
 *
 * Overlap condition: contractStart <= periodEnd AND contractEnd >= periodStart.
 * A NULL contractStart/End means "no restriction" on that side (treated as always active).
 *
 * @param contractStartDate - first day of employment, or null/undefined for no restriction
 * @param contractEndDate   - last day of employment, or null/undefined for no restriction
 * @param periodStart       - ISO date string "YYYY-MM-DD" (period start, inclusive)
 * @param periodEnd         - ISO date string "YYYY-MM-DD" (period end, inclusive)
 */
export function wasEmployeeActiveDuring(
  contractStartDate: string | null | undefined,
  contractEndDate: string | null | undefined,
  periodStart: string,
  periodEnd: string,
): boolean {
  // Contract hadn't started yet during the period
  if (contractStartDate && contractStartDate > periodEnd) return false;
  // Contract had already ended before the period started
  if (contractEndDate && contractEndDate < periodStart) return false;
  return true;
}

/**
 * Returns the Monday of the week containing the given date (UTC).
 */
export function getWeekStart(date: Date): Date {
  const d   = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/**
 * Returns ISO date string "YYYY-MM-DD" for a Date object.
 */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
