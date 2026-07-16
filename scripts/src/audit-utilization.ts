/**
 * Utilization Calculation Audit
 *
 * Verifies the calculateAvailableHours formula handles all specified edge cases:
 *   1. Standard full-time (40h/week, Mon-Fri)
 *   2. Part-time employee (20h/week, Mon-Fri → 4h/day)
 *   3. Mid-week contract start (contract starts Wednesday)
 *   4. Mixed holidays (employee A has holiday, employee B doesn't)
 *   5. Vacation deduction
 *   6. Combined: part-time + vacation + holiday
 */

// ── Inline the pure utility (mirrors artifacts/api-server/src/lib/utilization.ts) ──

function parseWorkingDaysMask(mask: string): boolean[] {
  return mask.split(",").map((v) => v.trim() === "1");
}

function getIsoDayIndex(date: Date): number {
  const d = date.getUTCDay();
  return d === 0 ? 6 : d - 1;
}

function buildVacationDateSet(vacations: { startDate: string; endDate: string }[]): Set<string> {
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

function calculateAvailableHours(
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
  const holidaySet = new Set(holidayDates);
  const vacationSet = vacationDates instanceof Set ? vacationDates : new Set(vacationDates);

  let availableHours = 0;
  const current = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (current <= end) {
    const isoDate = current.toISOString().slice(0, 10);
    if (contractStartDate && isoDate < contractStartDate) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    if (contractEndDate && isoDate > contractEndDate) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    const dayIndex = getIsoDayIndex(current);
    if (!mask[dayIndex]) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    if (holidaySet.has(isoDate)) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    if (vacationSet.has(isoDate)) {
      current.setUTCDate(current.getUTCDate() + 1);
      continue;
    }
    availableHours += dailyCapacity;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return availableHours;
}

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function expect(description: string, actual: number, expected: number, tolerance = 0.01) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✓  ${description}  (${actual}h)`);
    passed++;
  } else {
    console.error(`  ✗  ${description}  expected=${expected}h  got=${actual}h`);
    failed++;
  }
}

// ── Week under test: 2026-04-13 (Mon) → 2026-04-17 (Fri), 5 working days ────
const WEEK_START = "2026-04-13";
const WEEK_END   = "2026-04-17";
const MON_FRI    = "1,1,1,1,1,0,0";

console.log("\n=== CASE 1: Full-time employee, standard week (no holidays/vacations) ===");
{
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, [], new Set());
  expect("40h/week × 5 days = 40h", h, 40);
}

console.log("\n=== CASE 2: Part-time employee (20h/week, Mon–Fri) ===");
{
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 20, [], new Set());
  expect("20h/week × 5 days = 20h (4h/day)", h, 20);
  expect("Daily capacity = 4h", h / 5, 4);
}

console.log("\n=== CASE 3: Part-time (3 days/week: Mon, Wed, Fri) ===");
{
  const mask = "1,0,1,0,1,0,0"; // Mon, Wed, Fri
  const h = calculateAvailableHours(WEEK_START, WEEK_END, mask, 24, [], new Set());
  expect("24h/week × 3 days = 24h (8h/day)", h, 24);
}

console.log("\n=== CASE 4: Mid-week contract start (starts Wednesday 2026-04-15) ===");
{
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, [], new Set(), "2026-04-15");
  // Mon/Tue excluded → only Wed/Thu/Fri = 3 days × 8h = 24h
  expect("Contract starts Wed → 3 days × 8h = 24h", h, 24);
}

console.log("\n=== CASE 5: Contract ends mid-week (contract ends Tuesday 2026-04-14) ===");
{
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, [], new Set(), null, "2026-04-14");
  // Only Mon/Tue = 2 days × 8h = 16h
  expect("Contract ends Tue → 2 days × 8h = 16h", h, 16);
}

console.log("\n=== CASE 6: Holiday on Thursday (employee A has it, employee B doesn't) ===");
{
  const THURSDAY = "2026-04-16";
  const hWithHoliday    = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, [THURSDAY], new Set());
  const hWithoutHoliday = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, [],          new Set());
  expect("Employee A (has holiday Thu): 4 days × 8h = 32h", hWithHoliday, 32);
  expect("Employee B (no holiday):      5 days × 8h = 40h", hWithoutHoliday, 40);
  expect("Difference = 1 day (8h)",       hWithoutHoliday - hWithHoliday, 8);
}

console.log("\n=== CASE 7: Vacation deduction (off Mon–Wed) ===");
{
  const vacSet = buildVacationDateSet([{ startDate: "2026-04-13", endDate: "2026-04-15" }]);
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, [], vacSet);
  // Thu + Fri only = 2 days × 8h = 16h
  expect("Vacation Mon–Wed → 2 days × 8h = 16h", h, 16);
}

console.log("\n=== CASE 8: Combined — part-time (20h/wk) + holiday Fri + 2-day vacation Mon–Tue ===");
{
  // Part-time: Mon–Fri, 20h/week → 4h/day
  // Holiday on Friday
  // Vacation Mon–Tue
  // Remaining working days: Wed + Thu = 2 days × 4h = 8h
  const vacSet = buildVacationDateSet([{ startDate: "2026-04-13", endDate: "2026-04-14" }]);
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 20, ["2026-04-17"], vacSet);
  expect("Part-time + holiday Fri + vacation Mon–Tue → 2 days × 4h = 8h", h, 8);
}

console.log("\n=== CASE 9: Holiday on non-working day (should not deduct) ===");
{
  // Saturday holiday for Mon-Fri employee
  const h = calculateAvailableHours(WEEK_START, WEEK_END, MON_FRI, 40, ["2026-04-18"], new Set());
  expect("Holiday on Saturday (non-working) → full 40h still available", h, 40);
}

console.log("\n=== CASE 10: Utilization formula verification ===");
{
  const availableHours = 40;
  const billableHours  = 32;
  const totalHours     = 35;
  const billableUtil   = availableHours > 0 ? billableHours / availableHours : 0;
  const overallUtil    = availableHours > 0 ? totalHours    / availableHours : 0;
  expect("Billable utilization = 32/40 = 80%",   billableUtil * 100, 80);
  expect("Overall utilization  = 35/40 = 87.5%", overallUtil  * 100, 87.5);
}

console.log("\n=== CASE 11: Zero available hours (no working days in mask) ===");
{
  const h = calculateAvailableHours(WEEK_START, WEEK_END, "0,0,0,0,0,0,0", 40, [], new Set());
  expect("No working days → 0h available", h, 0);
}

console.log("\n=== CASE 12: Division by zero guard (available = 0) ===");
{
  const available = 0;
  const billable  = 5;
  const billableUtil = available > 0 ? billable / available : 0;
  expect("Available=0 → utilization=0 (no division by zero)", billableUtil, 0);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\nAudit FAILED — see ✗ entries above");
  process.exit(1);
} else {
  console.log("\nAudit PASSED — all edge cases verified ✓");
}
