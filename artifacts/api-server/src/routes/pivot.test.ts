import { describe, it, expect } from "vitest";
import { assignBookingToBuckets } from "../lib/pivot-buckets";

// Helper to create a flat-rate booking shape
function flatBooking(startDate: string, endDate: string, hoursPerDay: number) {
  return { startDate, endDate, hoursPerDay, weekdayHours: null };
}

// Helper to create a weekday-hours booking shape
function wdBooking(
  startDate: string,
  endDate: string,
  hoursPerDay: number,
  wh: Record<string, number>,
) {
  return { startDate, endDate, hoursPerDay, weekdayHours: wh };
}

// ─── Date-range clipping ──────────────────────────────────────────────────────

describe("assignBookingToBuckets – date-range clipping", () => {
  it("booking fully inside range → no clipping, full hours in Total", () => {
    // Mon 27 Apr – Fri 1 May, 5 working days × 8h = 40h
    const result = assignBookingToBuckets(
      flatBooking("2026-04-27", "2026-05-01", 8),
      "2026-04-01", "2026-05-31", "none",
    );
    expect(result["Total"]).toBe(40);
  });

  it("booking starts before rangeStart → left boundary clipped", () => {
    // Booking 2026-03-01 – 2026-04-30, range 2026-04-27 – 2026-04-30
    // Effective: Mon 27 Apr – Thu 30 Apr = 4 days × 8h = 32h
    const result = assignBookingToBuckets(
      flatBooking("2026-03-01", "2026-04-30", 8),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).toBe(32);
  });

  it("booking ends after rangeEnd → right boundary clipped", () => {
    // Booking 2026-04-27 – 2026-06-30, range 2026-04-27 – 2026-04-30
    // Effective: Mon 27 Apr – Thu 30 Apr = 4 days × 8h = 32h
    const result = assignBookingToBuckets(
      flatBooking("2026-04-27", "2026-06-30", 8),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).toBe(32);
  });

  it("booking spans entire range → both sides clipped", () => {
    // Booking 2026-01-01 – 2026-12-31, range 2026-04-27 – 2026-04-30
    // Effective: Mon 27 Apr – Thu 30 Apr = 4 days × 8h = 32h
    const result = assignBookingToBuckets(
      flatBooking("2026-01-01", "2026-12-31", 8),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).toBe(32);
  });

  it("booking entirely before range → empty result", () => {
    const result = assignBookingToBuckets(
      flatBooking("2026-01-01", "2026-03-31", 8),
      "2026-04-01", "2026-04-30", "none",
    );
    expect(result).toEqual({});
  });

  it("booking entirely after range → empty result", () => {
    const result = assignBookingToBuckets(
      flatBooking("2026-07-01", "2026-12-31", 8),
      "2026-04-01", "2026-04-30", "none",
    );
    expect(result).toEqual({});
  });

  it("booking ends exactly on rangeStart (single day, weekday) → 1 day", () => {
    // 2026-04-27 is a Monday
    const result = assignBookingToBuckets(
      flatBooking("2026-04-20", "2026-04-27", 8),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).toBe(8);
  });

  it("booking starts exactly on rangeEnd (single day, weekday) → 1 day", () => {
    // 2026-04-30 is a Thursday
    const result = assignBookingToBuckets(
      flatBooking("2026-04-30", "2026-05-31", 8),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).toBe(8);
  });
});

// ─── Bucket splitting (colDim = "month") ─────────────────────────────────────

describe("assignBookingToBuckets – month bucket splitting", () => {
  it("booking spanning two months is split correctly across monthly buckets", () => {
    // Booking: Mon 27 Apr – Fri 8 May, flat 8h/day
    // April portion (27–30 Apr): Mon+Tue+Wed+Thu = 4 × 8h = 32h
    // May portion (1–8 May): Fri 1 May + Mon 4 + Tue 5 + Wed 6 + Thu 7 + Fri 8 = 6 × 8h = 48h
    const result = assignBookingToBuckets(
      flatBooking("2026-04-27", "2026-05-08", 8),
      "2026-04-01", "2026-05-31", "month",
    );
    expect(result["2026-04"]).toBe(32);
    expect(result["2026-05"]).toBe(48);
  });

  it("clipped booking only populates the buckets inside the range", () => {
    // Booking: Jan–Jun 2026, but range is only May 2026
    // May 2026: 21 working days × 8h = 168h
    const result = assignBookingToBuckets(
      flatBooking("2026-01-01", "2026-06-30", 8),
      "2026-05-01", "2026-05-31", "month",
    );
    expect(Object.keys(result)).toEqual(["2026-05"]);
    expect(result["2026-05"]).toBe(168); // 21 working days in May 2026
  });

  it("right-clipped booking stops at rangeEnd within the bucket month", () => {
    // Booking: 1 Apr – 31 Dec, range ends 30 Apr
    // April working days × 8h = 22 × 8 = 176h
    const result = assignBookingToBuckets(
      flatBooking("2026-04-01", "2026-12-31", 8),
      "2026-04-01", "2026-04-30", "month",
    );
    expect(Object.keys(result)).toEqual(["2026-04"]);
    expect(result["2026-04"]).toBe(176); // 22 working days in April 2026
  });
});

// ─── Holidays and vacations within clipped range ──────────────────────────────

describe("assignBookingToBuckets – holiday and vacation exclusion after clipping", () => {
  it("holiday within effective range is excluded", () => {
    // Booking 2026-04-27 – 2026-04-30 (4 working days), 1 holiday on Wed 29 Apr
    const holidays = new Set(["2026-04-29"]);
    const result = assignBookingToBuckets(
      flatBooking("2026-04-27", "2026-04-30", 8),
      "2026-04-01", "2026-04-30", "none",
      holidays,
    );
    expect(result["Total"]).toBe(24); // 3 days × 8h
  });

  it("holiday outside clipped range is not counted", () => {
    // Holiday on 2026-03-17 — before the range, should have no effect
    const holidays = new Set(["2026-03-17"]);
    const result = assignBookingToBuckets(
      flatBooking("2026-04-27", "2026-04-30", 8),
      "2026-04-27", "2026-04-30", "none",
      holidays,
    );
    expect(result["Total"]).toBe(32); // unaffected
  });

  it("vacation day within clipped range is excluded", () => {
    // Booking 2026-04-27 – 2026-04-30, vacation on Mon 27 Apr
    const vacations = new Set(["2026-04-27"]);
    const result = assignBookingToBuckets(
      flatBooking("2026-04-27", "2026-04-30", 8),
      "2026-04-01", "2026-04-30", "none",
      new Set(),
      vacations,
    );
    expect(result["Total"]).toBe(24); // 3 days × 8h
  });
});

// ─── Weekday-hours mode after clipping ───────────────────────────────────────

describe("assignBookingToBuckets – weekday-hour overrides with clipping", () => {
  it("per-weekday hours respected within clipped range", () => {
    // Booking: 2026-01-01 – 2026-12-31, range 2026-04-27 – 2026-04-30
    // Mon=2h, Tue=2h, Wed=2h, Thu=2h, Fri=0h
    // Effective days: Mon 27 Apr + Tue 28 + Wed 29 + Thu 30 = 4 × 2h = 8h
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 0 };
    const result = assignBookingToBuckets(
      wdBooking("2026-01-01", "2026-12-31", 8, wh),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).toBe(8);
  });

  it("Bug #93 regression: Apr 27–30 within 2026-01-01 – 2026-12-31 booking → 8h", () => {
    // This was the original bug where flat hoursPerDay was used instead of per-weekday
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 0 };
    const result = assignBookingToBuckets(
      wdBooking("2026-01-01", "2026-12-31", 8, wh),
      "2026-04-27", "2026-04-30", "none",
    );
    expect(result["Total"]).not.toBe(32); // was wrong before fix (4 × 8h flat)
    expect(result["Total"]).toBe(8);      // correct: 4 × 2h per-weekday
  });
});
