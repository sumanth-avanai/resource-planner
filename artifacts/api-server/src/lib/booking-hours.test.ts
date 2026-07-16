import { describe, it, expect } from "vitest";
import { calcDayHours, calcBookingHours } from "./booking-hours";

// ─── calcDayHours ─────────────────────────────────────────────────────────────

describe("calcDayHours", () => {
  it("returns 0 for Sunday (dow=0)", () => {
    expect(calcDayHours(0, "2026-04-26", 8, null)).toBe(0);
  });

  it("returns 0 for Saturday (dow=6)", () => {
    expect(calcDayHours(6, "2026-04-25", 8, null)).toBe(0);
  });

  it("returns 0 for a public holiday", () => {
    const holidays = new Set(["2026-04-17"]);
    expect(calcDayHours(5, "2026-04-17", 8, null, holidays)).toBe(0);
  });

  it("returns 0 for a vacation day", () => {
    const vacations = new Set(["2026-04-22"]);
    expect(calcDayHours(3, "2026-04-22", 8, null, new Set(), vacations)).toBe(0);
  });

  it("flat mode: returns hoursPerDay on a normal weekday", () => {
    expect(calcDayHours(1, "2026-04-27", 6, null)).toBe(6);
  });

  it("weekday mode: returns mapped hours for a scheduled day", () => {
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 0 };
    expect(calcDayHours(1, "2026-04-27", 8, wh)).toBe(2);
  });

  it("weekday mode: returns 0 for an explicitly zeroed day (Friday)", () => {
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 0 };
    expect(calcDayHours(5, "2026-04-24", 8, wh)).toBe(0);
  });

  it("weekday mode: returns 0 for a day not present in the map", () => {
    const wh = { "1": 2 };
    expect(calcDayHours(3, "2026-04-29", 8, wh)).toBe(0);
  });

  it("holiday takes priority over weekday schedule", () => {
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 2 };
    const holidays = new Set(["2026-04-27"]);
    expect(calcDayHours(1, "2026-04-27", 8, wh, holidays)).toBe(0);
  });
});

// ─── calcBookingHours ─────────────────────────────────────────────────────────

describe("calcBookingHours", () => {
  it("full week flat-rate: Mon-Fri 8h = 40h", () => {
    // 2026-04-27 = Mon, 2026-05-01 = Fri
    const { totalHours, budgetDays } = calcBookingHours("2026-04-27", "2026-05-01", 8, null);
    expect(totalHours).toBe(40);
    expect(budgetDays).toBe(5);
  });

  it("weekend days are excluded from flat-rate total", () => {
    // Full week including Sat/Sun: 5 working days
    const { totalHours } = calcBookingHours("2026-04-27", "2026-05-03", 8, null);
    expect(totalHours).toBe(40);
  });

  it("Bug #93 example: Mon-Thu 2h, Fri 0h for 27-30 April → 8h", () => {
    // 27 Apr = Mon, 28 = Tue, 29 = Wed, 30 = Thu
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 0 };
    const { totalHours } = calcBookingHours("2026-04-27", "2026-04-30", 8, wh);
    expect(totalHours).toBe(8);
  });

  it("Mon-Thu 2h, Fri 0h for a full April 2026 → 36h", () => {
    // April 2026 starts on Wednesday:
    // 4× Mon, 4× Tue, 5× Wed, 5× Thu = 18 Mon-Thu days × 2h = 36h
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 0 };
    const { totalHours } = calcBookingHours("2026-04-01", "2026-04-30", 8, wh);
    expect(totalHours).toBe(36);
  });

  it("holiday excluded from flat-rate total", () => {
    // Mon-Fri 8h, with 1 holiday on Wednesday
    const { totalHours } = calcBookingHours(
      "2026-04-27", "2026-05-01", 8, null,
      ["2026-04-29"],
    );
    expect(totalHours).toBe(32); // 4 days × 8h
  });

  it("holiday excluded from weekday-mode total", () => {
    const wh = { "1": 2, "2": 2, "3": 2, "4": 2, "5": 2 };
    const { totalHours } = calcBookingHours(
      "2026-04-27", "2026-05-01", 8, wh,
      ["2026-04-29"],
    );
    expect(totalHours).toBe(8); // 4 days × 2h
  });

  it("vacation days excluded from flat-rate total", () => {
    const vacations = new Set(["2026-04-28", "2026-04-29"]);
    const { totalHours } = calcBookingHours(
      "2026-04-27", "2026-05-01", 8, null,
      [], vacations,
    );
    expect(totalHours).toBe(24); // 3 days × 8h
  });

  it("partial period: single day booking", () => {
    const { totalHours, budgetDays } = calcBookingHours("2026-04-27", "2026-04-27", 8, null);
    expect(totalHours).toBe(8);
    expect(budgetDays).toBe(1);
  });

  it("single day on weekend returns 0h", () => {
    // 2026-04-26 = Sunday
    const { totalHours } = calcBookingHours("2026-04-26", "2026-04-26", 8, null);
    expect(totalHours).toBe(0);
  });

  it("budgetDays = totalHours / 8", () => {
    const { totalHours, budgetDays } = calcBookingHours("2026-04-27", "2026-05-01", 4, null);
    expect(totalHours).toBe(20);
    expect(budgetDays).toBeCloseTo(2.5);
  });

  it("returns 0 if range is entirely weekend/holiday", () => {
    // Sat + Sun
    const { totalHours } = calcBookingHours("2026-04-25", "2026-04-26", 8, null);
    expect(totalHours).toBe(0);
  });

  it("holiday on Saturday doesn't double-count (already excluded as weekend)", () => {
    const { totalHours } = calcBookingHours(
      "2026-04-25", "2026-05-01", 8, null,
      ["2026-04-25"],
    );
    expect(totalHours).toBe(40); // 5 working days unchanged
  });
});
