import { describe, it, expect } from "vitest";
import {
  calcRoleBudgetReconciliation,
  calcEffectiveBookingBudgetDays,
  type ReconciliationBooking,
  type ReconciliationTimeEntry,
} from "./budget-reconciliation";

// Model under test (B = Logged + Reserved + Unplanned):
// - Unplanned subtracts LOGGED (all delivered work)
// - Reserved = undelivered planned days from `today` onwards only
// - stalePlanDays = undelivered planned days before `today` (flag, not consumption)
// - release write-off is frozen at the release DATE, not rolling "today"
// A fixed `today` (2026-06-03, a Wednesday) makes every scenario deterministic.

const TODAY = new Date("2026-06-03T12:00:00Z");

const emptyAvail = {
  holidayDates: [] as string[],
  vacationDateSet: new Set<string>(),
  compDayDateSet: new Set<string>(),
};

function flatBooking(
  startDate: string,
  endDate: string,
  hoursPerDay = 8,
  pastReleasedAt: Date | null = null,
): ReconciliationBooking {
  return {
    startDate,
    endDate,
    hoursPerDay,
    weekdayHours: null,
    employeeId: 1,
    pastReleasedAt,
    avail: emptyAvail,
  };
}

function buildEntries(
  startDate: string,
  days: number,
): ReconciliationTimeEntry[] {
  const entries: ReconciliationTimeEntry[] = [];
  const d = new Date(startDate + "T00:00:00Z");
  let count = 0;
  while (count < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      entries.push({
        entryDate: d.toISOString().slice(0, 10),
        hours: 8,
      });
      count++;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return entries;
}

describe("Scenario 1 - May delivered, partial June delivery", () => {
  const bookings: ReconciliationBooking[] = [
    flatBooking("2026-05-04", "2026-05-15"),
    flatBooking("2026-06-01", "2026-06-12"),
  ];
  const timeEntries: ReconciliationTimeEntry[] = [
    ...buildEntries("2026-05-04", 10),
    ...buildEntries("2026-06-01", 2),
  ];
  const r = calcRoleBudgetReconciliation(20, bookings, timeEntries, TODAY);

  it("loggedDays = 12", () => expect(r.loggedDays).toBe(12));
  it("reservedDays = 8 (Jun 3-12 undelivered, all future)", () => expect(r.reservedDays).toBe(8));
  it("stalePlanDays = 0", () => expect(r.stalePlanDays).toBe(0));
  it("unplannedDays = 0 (20 - 12 logged - 8 reserved)", () => expect(r.unplannedDays).toBe(0));
  it("freeDays = 8 (B - logged)", () => expect(r.freeDays).toBe(8));
  it("identity: Logged + Reserved + Unplanned = B", () =>
    expect(r.loggedDays + r.reservedDays + r.unplannedDays!).toBeCloseTo(20));
});

describe("Scenario 2 - stale May days split out of reserved", () => {
  const bookings: ReconciliationBooking[] = [
    flatBooking("2026-05-04", "2026-05-15"),
    flatBooking("2026-06-01", "2026-06-12"),
  ];
  const timeEntries: ReconciliationTimeEntry[] = [
    ...buildEntries("2026-05-04", 8),
    ...buildEntries("2026-06-01", 2),
  ];
  const r = calcRoleBudgetReconciliation(20, bookings, timeEntries, TODAY);

  it("loggedDays = 10", () => expect(r.loggedDays).toBe(10));
  it("reservedDays = 8 (June only - future)", () => expect(r.reservedDays).toBe(8));
  it("stalePlanDays = 2 (May 14-15, never delivered)", () => expect(r.stalePlanDays).toBe(2));
  it("unplannedDays = 2 (20 - 10 - 8)", () => expect(r.unplannedDays).toBe(2));
  it("identity: Logged + Reserved + Unplanned = B", () =>
    expect(r.loggedDays + r.reservedDays + r.unplannedDays!).toBeCloseTo(20));
});

describe("Scenario 3 - over-delivered May, large unplanned buffer", () => {
  const bookings: ReconciliationBooking[] = [
    flatBooking("2026-05-04", "2026-05-15"),
    flatBooking("2026-06-01", "2026-06-12"),
  ];
  const timeEntries: ReconciliationTimeEntry[] = [
    ...buildEntries("2026-05-04", 10),
    ...buildEntries("2026-05-18", 5),
    ...buildEntries("2026-06-01", 2),
  ];
  const r = calcRoleBudgetReconciliation(50, bookings, timeEntries, TODAY);

  it("loggedDays = 17", () => expect(r.loggedDays).toBe(17));
  it("reservedDays = 8", () => expect(r.reservedDays).toBe(8));
  it("unplannedDays = 25 (50 - 17 - 8)", () => expect(r.unplannedDays).toBe(25));
  it("freeDays = 33", () => expect(r.freeDays).toBe(33));
  it("identity: Logged + Reserved + Unplanned = B", () =>
    expect(r.loggedDays + r.reservedDays + r.unplannedDays!).toBeCloseTo(50));
});

// The "phantom negative" fix: booked Jun 1-12 (10d) never delivered there;
// work actually happened May 4-15 (logged). today = Jul 1.
// OLD math: unplanned = 15 - 10 - 10 reserved = -5 (phantom).
// NEW math: unplanned = 15 - 10 logged - 0 reserved = +5, stale = 10 flagged.
describe("Scenario 4 - work delivered on other days than booked (stale, no double count)", () => {
  const r = calcRoleBudgetReconciliation(
    15,
    [flatBooking("2026-06-01", "2026-06-12")],
    buildEntries("2026-05-04", 10),
    new Date("2026-07-01T12:00:00Z"),
  );

  it("stalePlanDays = 10 (whole booking undelivered, in the past)", () =>
    expect(r.stalePlanDays).toBe(10));
  it("reservedDays = 0", () => expect(r.reservedDays).toBe(0));
  it("unplannedDays = +5 - not the phantom -5 of the old model", () =>
    expect(r.unplannedDays).toBe(5));
});

describe("Scenario 5 - genuine over-commitment yields negative unplanned", () => {
  const bookings = [flatBooking("2026-06-08", "2026-06-19")]; // 10d, all future
  const r = calcRoleBudgetReconciliation(
    20, bookings, buildEntries("2026-05-04", 12), TODAY);

  it("loggedDays = 12 (all in May)", () => expect(r.loggedDays).toBe(12));
  it("reservedDays = 10 (June booking, all future, undelivered)", () =>
    expect(r.reservedDays).toBe(10));
  it("unplanned = -2 (20 - 12 logged - 10 reserved) — real over-commitment", () =>
    expect(r.unplannedDays).toBe(-2));
});

// Booking May 4-15 (10d), nothing delivered, released May 11.
// today = Jun 3: May 4-8 written off; May 11-15 missed AFTER the release
// and must resurface as stale (old logic silently forgave them too).
describe("Scenario 6 - release-date cutoff", () => {
  const released = flatBooking("2026-05-04", "2026-05-15", 8, new Date("2026-05-11T09:00:00Z"));

  it("reconciliation: stalePlanDays = 5 (May 11-15 resurface)", () => {
    const r = calcRoleBudgetReconciliation(20, [released], [], TODAY);
    expect(r.stalePlanDays).toBe(5);
    expect(r.reservedDays).toBe(0);
    expect(r.plannedDays).toBe(5); // released days are out of plan entirely
  });

  it("calcEffectiveBookingBudgetDays counts days from the release date on", () => {
    expect(calcEffectiveBookingBudgetDays(released, emptyAvail)).toBe(5);
  });

  it("booking fully before the release date is entirely written off", () => {
    const fullyReleased = flatBooking("2026-05-04", "2026-05-08", 8, new Date("2026-05-11T09:00:00Z"));
    expect(calcEffectiveBookingBudgetDays(fullyReleased, emptyAvail)).toBe(0);
  });
});

describe("Edge cases", () => {
  it("null budget - budget-derived fields are null, buckets still computed", () => {
    const r = calcRoleBudgetReconciliation(
      null,
      [flatBooking("2026-06-08", "2026-06-12")],
      [{ entryDate: "2026-06-08", hours: 8 }],
      TODAY,
    );
    expect(r.unplannedDays).toBeNull();
    expect(r.freeDays).toBeNull();
    expect(r.loggedDays).toBe(1);
    expect(r.reservedDays).toBe(4); // 5d planned - 1d logged, all future
  });

  it("no bookings, no entries - all zeros (budget fields still computed)", () => {
    const r = calcRoleBudgetReconciliation(10, [], [], TODAY);
    expect(r.loggedDays).toBe(0);
    expect(r.reservedDays).toBe(0);
    expect(r.stalePlanDays).toBe(0);
    expect(r.unplannedDays).toBe(10);
    expect(r.freeDays).toBe(10);
    expect(r.plannedDays).toBe(0);
  });

  it("over-delivery on a booked day clamps undelivered to 0", () => {
    const bookings = [flatBooking("2026-06-08", "2026-06-08")];
    const entries = [{ entryDate: "2026-06-08", hours: 16 }];
    const r = calcRoleBudgetReconciliation(5, bookings, entries, TODAY);
    expect(r.reservedDays).toBe(0);
    expect(r.loggedDays).toBe(2);
    expect(r.unplannedDays).toBe(3); // 5 - 2 logged - 0 reserved
  });
});
