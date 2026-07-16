/**
 * Budget reconciliation: Logged | Re-plannable | Unplanned bucket model.
 *
 * Core identity: B = Logged + Reserved + Unplanned
 *
 * - Logged (C)   = ALL delivered work, invoiced or not. Invoicing is a billing
 *                  overlay and never moves capacity figures.
 * - Reserved (R) = undelivered planned days from TODAY onwards only — real
 *                  future commitments, netted per day against logged hours.
 * - Stale (S)    = undelivered planned days strictly BEFORE today. A
 *                  data-quality flag ("release or re-plan"), never counted as
 *                  consumption — this removes the double count where past
 *                  ghost plans stacked on top of already-delivered work.
 * - Unplanned (U)= B − C − R. Negative only on genuine over-commitment.
 *
 * Release semantics: `pastReleasedAt` freezes the write-off at the RELEASE
 * DATE. Days missed after a release resurface as stale instead of being
 * rolling-forgiven by "today".
 *
 * Per-day reconciliation avoids double-counting overlapping bookings.
 */

import { calcDayHours, calcBookingHours, type WeekdayHoursMap } from "./booking-hours";

export interface ReconciliationBooking {
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  weekdayHours: WeekdayHoursMap | null;
  employeeId: number;
  /** When set, past undelivered planned hours are excluded (released). */
  pastReleasedAt?: Date | null;
  avail: {
    holidayDates: string[];
    vacationDateSet: Set<string>;
    compDayDateSet: Set<string>;
  };
}

export interface ReconciliationTimeEntry {
  entryDate: string;
  hours: number;
  isInvoiced: boolean;
}

export interface ReconciliationResult {
  loggedDays: number;
  invoicedDays: number;
  reservedDays: number;
  /** Undelivered planned days strictly before today (never consumption). */
  stalePlanDays: number;
  unplannedDays: number | null;
  freeDays: number | null;
  remainingBudgetDays: number | null;
  loggedNotInvoicedDays: number;
  plannedDays: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Return the effective budget-days for a single booking, honoring release state.
 *
 * When a booking's past plan has been released (`pastReleasedAt` is set),
 * only future days (>= today) are counted. This keeps the per-employee
 * planned-days figures in budget-status and allocations consistent with
 * the reconciliation output.
 */
export function calcEffectiveBookingBudgetDays(
  booking: {
    startDate: string;
    endDate: string;
    hoursPerDay: number;
    weekdayHours: WeekdayHoursMap | null;
    pastReleasedAt?: Date | null;
  },
  avail: {
    holidayDates?: string[];
    vacationDateSet?: Set<string>;
    compDayDateSet?: Set<string>;
  } | undefined,
  today?: string,
): number {
  if (!booking.pastReleasedAt) {
    return calcBookingHours(
      booking.startDate, booking.endDate,
      booking.hoursPerDay, booking.weekdayHours,
      avail?.holidayDates, avail?.vacationDateSet, avail?.compDayDateSet,
    ).budgetDays;
  }

  // Release-date cutoff: the write-off is frozen at the release date, so
  // only days strictly before it are excluded. (`today` kept for signature
  // compatibility; no longer used here.)
  void today;
  const releasedUpTo = booking.pastReleasedAt.toISOString().slice(0, 10);
  if (booking.endDate < releasedUpTo) return 0; // entirely written off
  const effectiveStart = booking.startDate >= releasedUpTo ? booking.startDate : releasedUpTo;
  return calcBookingHours(
    effectiveStart, booking.endDate,
    booking.hoursPerDay, booking.weekdayHours,
    avail?.holidayDates, avail?.vacationDateSet, avail?.compDayDateSet,
  ).budgetDays;
}

/**
 * Calculate the four canonical budget buckets for a single role.
 *
 * @param budgetedDays  Role's budgeted days (null = no budget set).
 * @param bookings      All resource bookings for this role, each with avail data.
 * @param timeEntries   All time entries for this role with invoiced status.
 * @param today         Override for "today" — used in tests and bulk-release. Defaults to server date.
 */
export function calcRoleBudgetReconciliation(
  budgetedDays: number | null,
  bookings: ReconciliationBooking[],
  timeEntries: ReconciliationTimeEntry[],
  today?: Date,
): ReconciliationResult {
  const todayStr = (today ?? new Date()).toISOString().slice(0, 10);

  // ── Step 1: build per-day planned-hours map ─────────────────────────────────
  // key: YYYY-MM-DD, value: total planned hours on that day (across all bookings)
  const plannedByDay = new Map<string, number>();

  for (const booking of bookings) {
    const holidaySet = new Set(booking.avail.holidayDates);
    // Release-date cutoff: only days strictly before the release date stay
    // written off — misses after the release resurface (edge-case fix).
    const releasedUpTo = booking.pastReleasedAt
      ? booking.pastReleasedAt.toISOString().slice(0, 10)
      : null;
    const d = new Date(booking.startDate + "T00:00:00Z");
    const end = new Date(booking.endDate + "T00:00:00Z");
    while (d <= end) {
      const dateStr = d.toISOString().slice(0, 10);

      if (releasedUpTo && dateStr < releasedUpTo) {
        d.setUTCDate(d.getUTCDate() + 1);
        continue;
      }

      const dow = d.getUTCDay();
      const h = calcDayHours(
        dow,
        dateStr,
        booking.hoursPerDay,
        booking.weekdayHours,
        holidaySet,
        booking.avail.vacationDateSet,
        booking.avail.compDayDateSet,
      );
      if (h > 0) {
        plannedByDay.set(dateStr, (plannedByDay.get(dateStr) ?? 0) + h);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }

  // ── Step 2: build per-day logged-hours map ──────────────────────────────────
  const loggedByDay = new Map<string, { total: number; invoiced: number }>();
  for (const entry of timeEntries) {
    const existing = loggedByDay.get(entry.entryDate);
    if (existing) {
      existing.total += entry.hours;
      if (entry.isInvoiced) existing.invoiced += entry.hours;
    } else {
      loggedByDay.set(entry.entryDate, {
        total: entry.hours,
        invoiced: entry.isInvoiced ? entry.hours : 0,
      });
    }
  }

  // ── Step 3: aggregate totals ────────────────────────────────────────────────
  let totalLoggedHours = 0;
  let totalInvoicedHours = 0;
  for (const { total, invoiced } of loggedByDay.values()) {
    totalLoggedHours += total;
    totalInvoicedHours += invoiced;
  }

  // ── Step 4: split undelivered planned into committed (future) vs stale ─────
  // For each day with any planned hours, compute how much was not delivered.
  // Days from today onwards are real commitments (Reserved); days before
  // today are stale plan — flagged, never counted as consumption.
  let totalReservedHours = 0;
  let totalStaleHours = 0;
  for (const [dateStr, plannedHours] of plannedByDay.entries()) {
    const loggedHours = loggedByDay.get(dateStr)?.total ?? 0;
    const undelivered = Math.max(plannedHours - loggedHours, 0);
    if (dateStr >= todayStr) totalReservedHours += undelivered;
    else totalStaleHours += undelivered;
  }

  // ── Step 5: derive canonical bucket values (B = Logged + Reserved + Unplanned)
  const loggedDays = round2(totalLoggedHours / 8);
  const invoicedDays = round2(totalInvoicedHours / 8);
  const reservedDays = round2(totalReservedHours / 8);
  const stalePlanDays = round2(totalStaleHours / 8);
  const loggedNotInvoicedDays = round2(loggedDays - invoicedDays);

  // plannedDays = total booking days (sum over all bookings; kept for reference)
  let totalPlannedHours = 0;
  for (const h of plannedByDay.values()) totalPlannedHours += h;
  const plannedDays = round2(totalPlannedHours / 8);

  // Unplanned subtracts LOGGED (all delivered work), never invoiced — billing
  // state must not move capacity. Negative ⇔ genuine over-commitment.
  const unplannedDays = budgetedDays != null
    ? round2(budgetedDays - loggedDays - reservedDays)
    : null;
  const freeDays = budgetedDays != null
    ? round2(budgetedDays - loggedDays)
    : null;
  const remainingBudgetDays = budgetedDays != null
    ? round2(budgetedDays - invoicedDays)
    : null;

  return {
    loggedDays,
    invoicedDays,
    reservedDays,
    stalePlanDays,
    unplannedDays,
    freeDays,
    remainingBudgetDays,
    loggedNotInvoicedDays,
    plannedDays,
  };
}
