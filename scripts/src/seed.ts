/**
 * Seed the Postgres database from the money-free demo dataset.
 *
 *   pnpm --filter @workspace/scripts run seed
 *
 * Source of truth for demo data is the SAME file the browser mock uses:
 *   artifacts/time-tracker/src/mocks/db.json
 * so local (mock) and deployed (Postgres) show identical data.
 *
 * Shape adaptations vs. db.json:
 *  - employees.workingDaysMask  array [1,1,..] -> comma string "1,1,.."
 *  - employees.personalAccessPin (plain)       -> personalAccessPinHash (sha256)
 *  - roleAssignments {roleId}                  -> {projectRoleId}
 *  - derived fields (pmNames) are NOT stored (computed at query time)
 *  - time entries are generated from resource bookings + manualTimeEntries
 *    (mirrors generateTimeEntries() in mock-api.ts)
 *
 * Requires DATABASE_URL. Run `pnpm --filter @workspace/db run push` first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  db,
  pool,
  clientsTable,
  employeesTable,
  projectsTable,
  projectRolesTable,
  projectRoleAssignmentsTable,
  resourceBookingsTable,
  employeeVacationsTable,
  holidayCalendarsTable,
  holidaysTable,
  savedReportsTable,
  timeEntriesTable,
} from "@workspace/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_JSON = resolve(__dirname, "../../artifacts/time-tracker/src/mocks/db.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seed: any = JSON.parse(readFileSync(DB_JSON, "utf8"));

const hashPin = (pin: string) => createHash("sha256").update(pin).digest("hex");

// ── date helpers (mirror mock-api generateTimeEntries) ──────────────────────
const DAY = 86_400_000;
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => fmt(new Date(parse(s).getTime() + n * DAY));
const isoDow = (s: string) => ((parse(s).getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
const todayStr = () => fmt(new Date());
function* eachDay(start: string, end: string) {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

async function main() {
  console.log(`Seeding from ${DB_JSON}`);

  // 1) Clear existing data (children first for FK safety)
  await db.delete(timeEntriesTable);
  await db.delete(projectRoleAssignmentsTable);
  await db.delete(resourceBookingsTable);
  await db.delete(employeeVacationsTable);
  await db.delete(projectRolesTable);
  await db.delete(projectsTable);
  await db.delete(holidaysTable);
  await db.delete(holidayCalendarsTable);
  await db.delete(savedReportsTable);
  await db.delete(clientsTable);
  await db.delete(employeesTable);

  // 2) Parents with explicit ids (preserve db.json relationships)
  await db.insert(clientsTable).values(
    seed.clients.map((c: any) => ({
      id: c.id, name: c.name, active: c.active ?? true, notes: c.notes ?? null,
      ...(c.createdAt ? { createdAt: new Date(c.createdAt) } : {}),
    })),
  );

  await db.insert(employeesTable).values(
    seed.employees.map((e: any) => ({
      id: e.id,
      name: e.name,
      email: e.email ?? null,
      weeklyCapacityHours: e.weeklyCapacityHours ?? 40,
      workingDaysMask: (Array.isArray(e.workingDaysMask) ? e.workingDaysMask : [1, 1, 1, 1, 1, 0, 0]).join(","),
      holidayCalendarCode: e.holidayCalendarCode ?? null,
      contractStartDate: e.contractStartDate ?? null,
      contractEndDate: e.contractEndDate ?? null,
      utilizationTarget: e.utilizationTarget ?? null,
      personalAccessToken: e.personalAccessToken,
      personalAccessPinHash: hashPin(String(e.personalAccessPin ?? "0000")),
      active: e.active ?? true,
      ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}),
    })),
  );

  await db.insert(holidayCalendarsTable).values(
    seed.holidayCalendars.map((h: any) => ({
      id: h.id, code: h.code, name: h.name,
      ...(h.createdAt ? { createdAt: new Date(h.createdAt) } : {}),
    })),
  );
  if (seed.holidays?.length) {
    await db.insert(holidaysTable).values(
      seed.holidays.map((h: any) => ({ id: h.id, calendarId: h.calendarId, date: h.date, name: h.name })),
    );
  }

  await db.insert(projectsTable).values(
    seed.projects.map((p: any) => ({
      id: p.id,
      clientId: p.clientId,
      name: p.name,
      code: p.code ?? null,
      active: p.active ?? true,
      budgetHours: p.budgetHours ?? null, // budget shown in DAYS in the UI (8h = 1 day)
      startDate: p.startDate ?? null,
      endDate: p.endDate ?? null,
      color: p.color ?? null,
      pmName: p.pmName ?? null,
      generalStatus: p.generalStatus ?? null,
      riskLevel: p.riskLevel ?? null,
      clientSatisfaction: p.clientSatisfaction ?? null,
      nextSteps: p.nextSteps ?? null,
      ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}),
    })),
  );

  await db.insert(projectRolesTable).values(
    seed.projectRoles.map((r: any) => ({
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      budgetedDays: r.budgetedDays ?? null,
      budgetedHours: r.budgetedHours ?? null,
      ...(r.createdAt ? { createdAt: new Date(r.createdAt) } : {}),
    })),
  );

  // 3) Children (serial ids)
  if (seed.roleAssignments?.length) {
    await db.insert(projectRoleAssignmentsTable).values(
      seed.roleAssignments.map((a: any) => ({ projectRoleId: a.roleId, employeeId: a.employeeId })),
    );
  }

  if (seed.resourceBookings?.length) {
    await db.insert(resourceBookingsTable).values(
      seed.resourceBookings.map((b: any) => ({
        employeeId: b.employeeId,
        projectId: b.projectId,
        projectRoleId: b.projectRoleId ?? null,
        startDate: b.startDate,
        endDate: b.endDate,
        hoursPerDay: b.hoursPerDay,
        weekdayHours: b.weekdayHours ?? null,
        notes: b.notes ?? null,
        status: b.status ?? null,
        pastReleasedAt: b.pastReleasedAt ? new Date(b.pastReleasedAt) : null,
      })),
    );
  }

  if (seed.vacations?.length) {
    await db.insert(employeeVacationsTable).values(
      seed.vacations.map((v: any) => ({
        employeeId: v.employeeId, startDate: v.startDate, endDate: v.endDate,
        vacationType: v.vacationType ?? "vacation", note: v.note ?? null,
        ...(v.createdAt ? { createdAt: new Date(v.createdAt) } : {}),
      })),
    );
  }

  // 4) Generate time entries from bookings + explicit manual ranges
  const empById = new Map<number, any>(seed.employees.map((e: any) => [e.id, e]));
  const holidayDates = new Set<string>((seed.holidays ?? []).map((h: any) => h.date));
  const vacationsByEmp = new Map<number, any[]>();
  for (const v of seed.vacations ?? []) {
    if (!vacationsByEmp.has(v.employeeId)) vacationsByEmp.set(v.employeeId, []);
    vacationsByEmp.get(v.employeeId)!.push(v);
  }
  const isWorkingDay = (empId: number, date: string) => {
    const e = empById.get(empId);
    if (!e) return false;
    const mask: number[] = Array.isArray(e.workingDaysMask) ? e.workingDaysMask : [1, 1, 1, 1, 1, 0, 0];
    if (!mask[isoDow(date) - 1]) return false;
    if (e.holidayCalendarCode && holidayDates.has(date)) return false;
    if (e.contractStartDate && date < e.contractStartDate) return false;
    if (e.contractEndDate && date > e.contractEndDate) return false;
    return true;
  };
  const onVacation = (empId: number, date: string) =>
    (vacationsByEmp.get(empId) ?? []).some((v) => date >= v.startDate && date <= v.endDate);
  const bookingHoursOn = (b: any, date: string) => {
    if (date < b.startDate || date > b.endDate) return 0;
    const dow = isoDow(date);
    if (dow > 5) return 0;
    if (b.weekdayHours) return (b.weekdayHours as Record<string, number>)[String(dow)] ?? 0;
    return b.hoursPerDay;
  };

  const today = todayStr();
  const entries: (typeof timeEntriesTable.$inferInsert)[] = [];
  for (const m of seed.manualTimeEntries ?? []) {
    for (const d of eachDay(m.startDate, m.endDate)) {
      if (isoDow(d) > 5) continue;
      entries.push({ employeeId: m.employeeId, projectId: m.projectId, projectRoleId: m.projectRoleId ?? null, entryDate: d, hours: m.hoursPerDay, note: null });
    }
  }
  for (const b of seed.resourceBookings ?? []) {
    if (b.status === "tentative" || b.skipAutoLog) continue;
    for (const d of eachDay(b.startDate, b.endDate)) {
      if (d >= today) break;
      const h = bookingHoursOn(b, d);
      if (h <= 0 || !isWorkingDay(b.employeeId, d) || onVacation(b.employeeId, d)) continue;
      entries.push({ employeeId: b.employeeId, projectId: b.projectId, projectRoleId: b.projectRoleId ?? null, entryDate: d, hours: h, note: null });
    }
  }
  if (entries.length) await db.insert(timeEntriesTable).values(entries);

  // 5) Reset id sequences for tables seeded with explicit ids
  for (const t of ["clients", "employees", "projects", "project_roles", "holiday_calendars", "holidays"]) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))`,
      [t],
    );
  }

  console.log(
    `Seeded: ${seed.clients.length} clients, ${seed.employees.length} employees, ` +
      `${seed.projects.length} projects, ${seed.projectRoles.length} roles, ` +
      `${(seed.resourceBookings ?? []).length} bookings, ${(seed.vacations ?? []).length} absences, ` +
      `${entries.length} time entries.`,
  );
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    return pool.end().finally(() => process.exit(1));
  });
