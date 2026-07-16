/**
 * Seed script — run with:
 *   pnpm --filter @workspace/scripts run seed
 *
 * Idempotent (delete + re-insert strategy):
 *   - Time entries for seed employees Jan 1–Jun 18 2026 are deleted and recreated.
 *   - Resource bookings for seed employees are deleted and recreated.
 *   - All other entities (clients, projects, roles, employees, vacations, health
 *     updates) use insert-or-update semantics.
 *
 * Coherence guarantees:
 *   - Every project/role appearing in a time entry has a booking covering that
 *     same date range for that employee.
 *   - Per-day booking totals = employee daily capacity (no overbooking).
 *   - Part-time employees (Mon-Thu / Mon-Wed) have weekdayHours keys only on
 *     their actual working days, so Fri/Thu-Fri keys are never present.
 *   - Budget consumption 30–70% across active billable roles.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  clientsTable,
  projectsTable,
  employeesTable,
  holidayCalendarsTable,
  holidaysTable,
  timeEntriesTable,
  employeeVacationsTable,
  projectRolesTable,
  projectRoleAssignmentsTable,
  resourceBookingsTable,
  projectHealthUpdatesTable,
} from "@workspace/db";
import { createHash, randomBytes } from "crypto";
import { eq, and, gte, lte, inArray } from "drizzle-orm";

const { Pool } = pg;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db   = drizzle(pool);

function hashPin(pin: string)  { return createHash("sha256").update(pin).digest("hex"); }
function generateToken()        { return randomBytes(24).toString("base64url"); }
function toIsoDate(d: Date)     { return d.toISOString().slice(0, 10); }

function dateRange(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= last) {
    days.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function workingDays(start: Date, end: Date, mask: string, holidays: Set<string>, vacations: Set<string>): Date[] {
  const m = mask.split(",").map(Number);
  return dateRange(start, end).filter((d) => {
    const dow = d.getUTCDay();
    const idx = dow === 0 ? 6 : dow - 1; // Mon=0 … Sun=6
    const ds  = toIsoDate(d);
    return m[idx] === 1 && !holidays.has(ds) && !vacations.has(ds);
  });
}

function vacSet(startIso: string, endIso: string): Set<string> {
  const s = new Set<string>();
  for (const d of dateRange(new Date(startIso), new Date(endIso))) s.add(toIsoDate(d));
  return s;
}

function mergeSets(...sets: Set<string>[]): Set<string> {
  const result = new Set<string>();
  for (const s of sets) for (const v of s) result.add(v);
  return result;
}

function billingFor(date: string, billable: boolean): {
  billingStatus: "invoiced" | "invest" | null;
  invoiceReference: string | null;
  invoicedAt: Date | null;
} {
  if (!billable) {
    return { billingStatus: "invest", invoiceReference: null, invoicedAt: null };
  }
  if (date < "2026-05-01") {
    return { billingStatus: "invoiced", invoiceReference: "INV-2026-Q1", invoicedAt: new Date("2026-05-05T09:00:00Z") };
  }
  if (date >= "2026-05-01" && date < "2026-06-01") {
    const day = parseInt(date.slice(8, 10), 10);
    if (day <= 21) {
      return { billingStatus: "invoiced", invoiceReference: "INV-2026-05", invoicedAt: new Date("2026-06-03T09:00:00Z") };
    }
  }
  return { billingStatus: null, invoiceReference: null, invoicedAt: null };
}

// Weekday-mode booking helper.
// isoDays: ISO weekday numbers of the employee's working days (Mon=1 … Fri=5).
// hoursPerDay (derived) = Σ(weekdayHours values) / 5  — matches server resolveHoursPerDay.
function weekdayMode(isoDays: number[], hoursPerWorkingDay: number): {
  weekdayHours: Record<string, number>;
  hoursPerDay: number;
} {
  const weekdayHours: Record<string, number> = {};
  for (const d of isoDays) weekdayHours[String(d)] = hoursPerWorkingDay;
  const hoursPerDay = Object.values(weekdayHours).reduce((s, v) => s + v, 0) / 5;
  return { weekdayHours, hoursPerDay };
}

const MONFRI = [1, 2, 3, 4, 5]; // 40h / 5d employees
const MONTHU = [1, 2, 3, 4];     // 32h / 4d employees
const MONWED = [1, 2, 3];         // 24h / 3d employees

// ── Upsert helpers ─────────────────────────────────────────────────────────────

async function upsertClient(name: string, active: boolean, notes: string | null) {
  const [existing] = await db.select().from(clientsTable).where(eq(clientsTable.name, name));
  if (existing) return existing;
  const [row] = await db.insert(clientsTable).values({ name, active, notes }).returning();
  return row;
}

async function upsertEmployee(values: {
  name: string; email: string;
  weeklyCapacityHours: number; workingDaysMask: string;
  holidayCalendarCode: string;
  contractStartDate?: string; contractEndDate?: string;
  utilizationTarget?: number;
  personalAccessPinHash: string;
}) {
  const [existing] = await db.select().from(employeesTable).where(eq(employeesTable.name, values.name));
  if (existing) return existing;
  const [row] = await db.insert(employeesTable)
    .values({ ...values, personalAccessToken: generateToken(), active: true })
    .returning();
  return row;
}

async function upsertProject(values: {
  clientId: number; name: string; code: string; active: boolean;
  isBillable: boolean; budgetHours: number | null;
  startDate: string | null; endDate: string | null;
  color: string | null; pmName: string | null;
}) {
  const [existing] = await db.select().from(projectsTable).where(eq(projectsTable.code, values.code));
  if (existing) return existing;
  const [row] = await db.insert(projectsTable).values(values).returning();
  return row;
}

// Always updates budgetedDays so budget progress bars stay calibrated on re-runs.
async function upsertRole(projectId: number, name: string, dayRate: number, budgetedDays: number) {
  const [existing] = await db.select().from(projectRolesTable)
    .where(and(eq(projectRolesTable.projectId, projectId), eq(projectRolesTable.name, name)));
  if (existing) {
    const [updated] = await db.update(projectRolesTable)
      .set({ dayRate, budgetedDays, budgetedHours: budgetedDays * 8 })
      .where(eq(projectRolesTable.id, existing.id))
      .returning();
    return updated;
  }
  const [row] = await db.insert(projectRolesTable)
    .values({ projectId, name, dayRate, budgetedDays, budgetedHours: budgetedDays * 8 })
    .returning();
  return row;
}

async function upsertAssignment(projectRoleId: number, employeeId: number) {
  const [existing] = await db.select().from(projectRoleAssignmentsTable)
    .where(and(
      eq(projectRoleAssignmentsTable.projectRoleId, projectRoleId),
      eq(projectRoleAssignmentsTable.employeeId, employeeId),
    ));
  if (existing) return existing;
  const [row] = await db.insert(projectRoleAssignmentsTable).values({ projectRoleId, employeeId }).returning();
  return row;
}

async function upsertHealthUpdate(values: {
  projectId: number; generalStatus: string; budgetStatus?: string | null;
  riskLevel: string; clientSatisfaction?: string | null;
  comment: string; createdAt: Date;
}) {
  const [existing] = await db.select().from(projectHealthUpdatesTable)
    .where(and(
      eq(projectHealthUpdatesTable.projectId, values.projectId),
      eq(projectHealthUpdatesTable.comment,   values.comment),
    ));
  if (existing) return;
  await db.insert(projectHealthUpdatesTable).values({
    projectId:          values.projectId,
    generalStatus:      values.generalStatus,
    budgetStatus:       values.budgetStatus ?? null,
    riskLevel:          values.riskLevel,
    clientSatisfaction: values.clientSatisfaction ?? null,
    comment:            values.comment,
    createdAt:          values.createdAt,
  });
}

async function insertBooking(values: {
  employeeId: number; projectId: number; projectRoleId: number;
  startDate: string; endDate: string;
  isoDays: number[]; hpwd: number; // hours per working day
  notes?: string;
}) {
  const { isoDays, hpwd, ...rest } = values;
  const { weekdayHours, hoursPerDay } = weekdayMode(isoDays, hpwd);
  await db.insert(resourceBookingsTable).values({
    ...rest,
    weekdayHours,
    hoursPerDay,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding database…");

  // ── Holiday Calendar ─────────────────────────────────────────────────────────
  const [existingCal] = await db.select().from(holidayCalendarsTable)
    .where(eq(holidayCalendarsTable.code, "DE-BASE-2026"));

  let calendarId: number;
  if (existingCal) {
    calendarId = existingCal.id;
    console.log("  Holiday calendar already exists, skipping.");
  } else {
    const [cal] = await db.insert(holidayCalendarsTable)
      .values({ code: "DE-BASE-2026", name: "Germany Base Public Holidays 2026" })
      .returning();
    calendarId = cal.id;
    await db.insert(holidaysTable).values([
      { calendarId, date: "2026-01-01", name: "New Year's Day" },
      { calendarId, date: "2026-04-03", name: "Good Friday" },
      { calendarId, date: "2026-04-06", name: "Easter Monday" },
      { calendarId, date: "2026-05-01", name: "Labour Day" },
      { calendarId, date: "2026-05-14", name: "Ascension Day" },
      { calendarId, date: "2026-05-25", name: "Whit Monday" },
      { calendarId, date: "2026-10-03", name: "German Unity Day" },
      { calendarId, date: "2026-12-25", name: "Christmas Day" },
      { calendarId, date: "2026-12-26", name: "Second Day of Christmas" },
    ]);
    console.log("  Created DE-BASE-2026 calendar with 9 holidays.");
  }

  // Jan–Jun public holidays relevant to time entry generation
  const HOLIDAYS = new Set([
    "2026-01-01",
    "2026-04-03", "2026-04-06",
    "2026-05-01", "2026-05-14", "2026-05-25",
  ]);

  // ── Clients ──────────────────────────────────────────────────────────────────
  const acme    = await upsertClient("Acme Corp",     true,  "Main enterprise client");
  const bravo   = await upsertClient("Bravo Studios", true,  "Design retainer client");
  const delta   = await upsertClient("Delta Finance", true,  "Fintech ERP project");
  const echo    = await upsertClient("Echo Retail",   true,  "E-commerce & analytics");
  const foxtrot = await upsertClient("Foxtrot GmbH",  false, "Archived — migration project complete");
  console.log("  Clients: 5 ensured.");

  // ── Projects ─────────────────────────────────────────────────────────────────
  const pAcmeWeb   = await upsertProject({ clientId: acme.id,    name: "Website Redesign",     code: "ACME-WEB",   active: true,  isBillable: true,  budgetHours: 200,  startDate: "2026-01-01", endDate: "2026-06-30", color: "#6366f1", pmName: "Max Mustermann" });
  const pAcmeSup   = await upsertProject({ clientId: acme.id,    name: "Support & Maintenance", code: "ACME-SUP",   active: true,  isBillable: true,  budgetHours: null, startDate: "2026-01-01", endDate: null,         color: "#f59e0b", pmName: "Paul Teilzeit" });
  const pBravoId   = await upsertProject({ clientId: bravo.id,   name: "Brand Identity",        code: "BRAVO-ID",   active: true,  isBillable: false, budgetHours: 40,   startDate: "2026-03-01", endDate: "2026-05-31", color: "#ec4899", pmName: "Anna Beispiel" });
  const pAcmeApp   = await upsertProject({ clientId: acme.id,    name: "Mobile App Dev",        code: "ACME-APP",   active: true,  isBillable: true,  budgetHours: 320,  startDate: "2026-02-01", endDate: "2026-08-31", color: "#8b5cf6", pmName: "Max Mustermann" });
  const pDeltaErp  = await upsertProject({ clientId: delta.id,   name: "ERP Integration",       code: "DELTA-ERP",  active: true,  isBillable: true,  budgetHours: 480,  startDate: "2026-03-15", endDate: "2026-09-30", color: "#0ea5e9", pmName: "Sophie Wagner" });
  const pDeltaSec  = await upsertProject({ clientId: delta.id,   name: "Security Audit",        code: "DELTA-SEC",  active: true,  isBillable: true,  budgetHours: 80,   startDate: "2026-04-01", endDate: "2026-05-31", color: "#ef4444", pmName: "Sophie Wagner" });
  const pEchoShop  = await upsertProject({ clientId: echo.id,    name: "E-Commerce Platform",   code: "ECHO-SHOP",  active: true,  isBillable: true,  budgetHours: 560,  startDate: "2026-02-15", endDate: "2026-10-31", color: "#10b981", pmName: "Lars König" });
  const pEchoAna   = await upsertProject({ clientId: echo.id,    name: "Analytics Dashboard",   code: "ECHO-ANA",   active: true,  isBillable: true,  budgetHours: 240,  startDate: "2026-04-01", endDate: "2026-07-31", color: "#06b6d4", pmName: "Lars König" });
  const pFoxMigr   = await upsertProject({ clientId: foxtrot.id, name: "Data Migration",        code: "FOX-MIGR",   active: false, isBillable: true,  budgetHours: 160,  startDate: "2026-01-01", endDate: "2026-03-31", color: "#84cc16", pmName: "Mia Fischer" });
  const pBravoCamp = await upsertProject({ clientId: bravo.id,   name: "Campaign Creative",     code: "BRAVO-CAMP", active: true,  isBillable: false, budgetHours: 64,   startDate: "2026-04-01", endDate: "2026-06-30", color: "#f97316", pmName: "Anna Beispiel" });
  console.log("  Projects: 10 ensured.");

  // ── Project Roles ─────────────────────────────────────────────────────────────
  // budgetedDays ≈ expected logged days × 125–140% for realistic 30–70% consumption.
  const rAcmeWebFE   = await upsertRole(pAcmeWeb.id,   "Frontend Dev",       800,  130); // Max+Lars logged ~92d
  const rAcmeWebBE   = await upsertRole(pAcmeWeb.id,   "Backend Dev",        900,   50); // Paul logged ~22d
  const rAcmeWebUX   = await upsertRole(pAcmeWeb.id,   "UX Design",          750,   10);
  const rAcmeSupSup  = await upsertRole(pAcmeSup.id,   "Support Engineer",   700,  120); // Mia logged ~81d
  const rAcmeSupOps  = await upsertRole(pAcmeSup.id,   "DevOps",             850,   60); // Paul logged ~34d
  const rBravoIdDes  = await upsertRole(pBravoId.id,   "Brand Designer",     750,   28); // Anna logged ~21d
  const rBravoIdDir  = await upsertRole(pBravoId.id,   "Creative Director", 1000,    4);
  const rAcmeAppMob  = await upsertRole(pAcmeApp.id,   "Mobile Dev",         950,  100); // Max logged ~65d
  const rAcmeAppBE   = await upsertRole(pAcmeApp.id,   "Backend Dev",        900,   20);
  const rAcmeAppPM   = await upsertRole(pAcmeApp.id,   "Project Manager",    800,   45); // Max logged ~27d
  const rDeltaErpBE  = await upsertRole(pDeltaErp.id,  "Backend Dev",        900,   40);
  const rDeltaErpArch= await upsertRole(pDeltaErp.id,  "Solution Architect",1200,  100); // Sophie logged ~61d
  const rDeltaErpQA  = await upsertRole(pDeltaErp.id,  "QA Engineer",        650,   45); // Mia logged ~28d
  const rDeltaSecAna = await upsertRole(pDeltaSec.id,  "Security Analyst",  1100,   22); // Sophie logged ~14d
  const rDeltaSecPen = await upsertRole(pDeltaSec.id,  "Penetration Tester",1300,    5);
  const rEchoShopFE  = await upsertRole(pEchoShop.id,  "Frontend Dev",       800,   80); // Lars logged ~50d
  const rEchoShopBE  = await upsertRole(pEchoShop.id,  "Backend Dev",        900,   25); // Sophie logged ~10d
  const rEchoShopQA  = await upsertRole(pEchoShop.id,  "QA Engineer",        650,   50); // Mia logged ~37d
  const rEchoShopOps = await upsertRole(pEchoShop.id,  "DevOps",             850,   60); // Paul logged ~38d
  const rEchoAnaDE   = await upsertRole(pEchoAna.id,   "Data Engineer",      950,   35); // Lars logged ~24d
  const rEchoAnaViz  = await upsertRole(pEchoAna.id,   "Visualization Spec", 850,   28); // Anna logged ~17d
  const rEchoAnaBE   = await upsertRole(pEchoAna.id,   "Backend Dev",        900,   12);
  const rFoxMigrDA   = await upsertRole(pFoxMigr.id,   "Data Analyst",       850,   20);
  const rFoxMigrBE   = await upsertRole(pFoxMigr.id,   "Backend Dev",        900,   15);
  const rBravoCampCS = await upsertRole(pBravoCamp.id,  "Creative Strategist",800,   18); // Anna logged ~13d
  const rBravoCampCW = await upsertRole(pBravoCamp.id,  "Copywriter",         600,    8);
  console.log("  Project roles: 26 ensured (budgetedDays calibrated to ~30–70% consumed).");

  // ── Employees ─────────────────────────────────────────────────────────────────
  const max    = await upsertEmployee({ name: "Max Mustermann", email: "max@example.com",    weeklyCapacityHours: 40, workingDaysMask: "1,1,1,1,1,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2024-01-01",              utilizationTarget: 80, personalAccessPinHash: hashPin("1234") });
  const anna   = await upsertEmployee({ name: "Anna Beispiel",  email: "anna@example.com",   weeklyCapacityHours: 20, workingDaysMask: "1,1,1,1,1,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2025-06-01",              utilizationTarget: 75, personalAccessPinHash: hashPin("5678") });
  const paul   = await upsertEmployee({ name: "Paul Teilzeit",  email: "paul@example.com",   weeklyCapacityHours: 32, workingDaysMask: "1,1,1,1,0,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2026-01-15", contractEndDate: "2026-12-31", utilizationTarget: 80, personalAccessPinHash: hashPin("9999") });
  const sophie = await upsertEmployee({ name: "Sophie Wagner",  email: "sophie@example.com", weeklyCapacityHours: 40, workingDaysMask: "1,1,1,1,1,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2025-09-01",              utilizationTarget: 85, personalAccessPinHash: hashPin("2222") });
  const lars   = await upsertEmployee({ name: "Lars König",     email: "lars@example.com",   weeklyCapacityHours: 32, workingDaysMask: "1,1,1,1,0,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2026-01-01",              utilizationTarget: 80, personalAccessPinHash: hashPin("3333") });
  const mia    = await upsertEmployee({ name: "Mia Fischer",    email: "mia@example.com",    weeklyCapacityHours: 24, workingDaysMask: "1,1,1,0,0,0,0", holidayCalendarCode: "DE-BASE-2026", contractStartDate: "2025-11-01",              utilizationTarget: 75, personalAccessPinHash: hashPin("4444") });
  console.log("  Employees: 6 ensured.");

  // ── Role Assignments ──────────────────────────────────────────────────────────
  await upsertAssignment(rAcmeWebFE.id,    max.id);
  await upsertAssignment(rAcmeAppMob.id,   max.id);
  await upsertAssignment(rAcmeAppPM.id,    max.id);

  await upsertAssignment(rBravoIdDes.id,   anna.id);
  await upsertAssignment(rEchoAnaViz.id,   anna.id);
  await upsertAssignment(rBravoCampCS.id,  anna.id);

  await upsertAssignment(rAcmeSupOps.id,   paul.id);
  await upsertAssignment(rAcmeWebBE.id,    paul.id);
  await upsertAssignment(rEchoShopOps.id,  paul.id);

  await upsertAssignment(rDeltaErpArch.id, sophie.id);
  await upsertAssignment(rDeltaSecAna.id,  sophie.id);
  await upsertAssignment(rEchoShopBE.id,   sophie.id);

  await upsertAssignment(rEchoShopFE.id,   lars.id);
  await upsertAssignment(rAcmeWebFE.id,    lars.id);
  await upsertAssignment(rEchoAnaDE.id,    lars.id);

  await upsertAssignment(rAcmeSupSup.id,   mia.id);
  await upsertAssignment(rEchoShopQA.id,   mia.id);
  await upsertAssignment(rDeltaErpQA.id,   mia.id);

  void rAcmeWebUX; void rAcmeAppBE; void rDeltaErpBE; void rDeltaSecPen;
  void rEchoAnaBE; void rFoxMigrDA; void rFoxMigrBE; void rBravoCampCW; void rBravoIdDir;
  console.log("  Role assignments: 18 ensured.");

  // ── Vacations ─────────────────────────────────────────────────────────────────
  const vacInsert = async (employeeId: number, start: string, end: string, type: string, note: string | null) => {
    const [existing] = await db.select().from(employeeVacationsTable)
      .where(and(
        eq(employeeVacationsTable.employeeId, employeeId),
        eq(employeeVacationsTable.startDate, start),
        eq(employeeVacationsTable.endDate, end),
        eq(employeeVacationsTable.vacationType, type),
      ));
    if (existing) return false;
    await db.insert(employeeVacationsTable)
      .values({ employeeId, startDate: start, endDate: end, vacationType: type, note });
    return true;
  };

  let vacCount = 0;
  const vac = async (...args: Parameters<typeof vacInsert>) => { if (await vacInsert(...args)) vacCount++; };
  await vac(max.id,    "2026-04-21", "2026-04-24", "vacation",     "Easter week break");
  await vac(anna.id,   "2026-05-05", "2026-05-06", "sick",         null);
  await vac(paul.id,   "2026-05-18", "2026-05-22", "vacation",     "Family holiday");
  await vac(sophie.id, "2026-04-07", "2026-04-08", "unpaid_leave", null);
  await vac(lars.id,   "2026-02-02", "2026-02-02", "sick",         null);
  await vac(mia.id,    "2026-02-09", "2026-02-13", "vacation",     "Winter break");
  await vac(mia.id,    "2026-06-01", "2026-06-03", "vacation",     "Short break");
  console.log(`  Vacation entries: ${vacCount} new inserted.`);

  const vacMax    = vacSet("2026-04-21", "2026-04-24");
  const vacAnna   = vacSet("2026-05-05", "2026-05-06");
  const vacPaul   = vacSet("2026-05-18", "2026-05-22");
  const vacSophie = vacSet("2026-04-07", "2026-04-08");
  const vacLars   = vacSet("2026-02-02", "2026-02-02");
  const vacMia    = mergeSets(vacSet("2026-02-09", "2026-02-13"), vacSet("2026-06-01", "2026-06-03"));

  const empIds = [max.id, anna.id, paul.id, sophie.id, lars.id, mia.id];

  // ── Time Entries ──────────────────────────────────────────────────────────────
  // Clean-slate: delete all seed employee entries in range before re-inserting.
  await db.delete(timeEntriesTable).where(and(
    inArray(timeEntriesTable.employeeId, empIds),
    gte(timeEntriesTable.entryDate, "2026-01-01"),
    lte(timeEntriesTable.entryDate, "2026-06-18"),
  ));

  const SEED_END = new Date("2026-06-18T00:00:00Z");
  const D        = (s: string) => new Date(s + "T00:00:00Z");

  type Slot = { pid: number; rid: number; hours: number; note?: string; billable: boolean };
  const allEntries: {
    employeeId: number; projectId: number; projectRoleId: number;
    entryDate: string; hours: number; note: string | null;
    billingStatus: "invoiced" | "invest" | null;
    invoiceReference: string | null; invoicedAt: Date | null;
  }[] = [];

  const addEntries = (wd: Date[], employeeId: number, patterns: Slot[][]) => {
    wd.forEach((d, i) => {
      const ds = toIsoDate(d);
      for (const slot of patterns[i % patterns.length]) {
        const b = billingFor(ds, slot.billable);
        allEntries.push({
          employeeId,
          projectId:     slot.pid,
          projectRoleId: slot.rid,
          entryDate:     ds,
          hours:         slot.hours,
          note:          slot.note ?? null,
          billingStatus: b.billingStatus,
          invoiceReference: b.invoiceReference,
          invoicedAt:    b.invoicedAt,
        });
      }
    });
  };

  // ── Max (40h/5d = 8h/day, Mon–Fri) ──────────────────────────────────────────
  // Jan: ACME-WEB only. Feb–Jun: ACME-WEB + ACME-APP (Mob + PM). All days = 8h.
  addEntries(
    workingDays(D("2026-01-01"), D("2026-01-31"), "1,1,1,1,1,0,0", HOLIDAYS, new Set()),
    max.id,
    [[{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id,  hours: 8, note: "Frontend foundations", billable: true }]],
  );
  addEntries(
    workingDays(D("2026-02-01"), SEED_END, "1,1,1,1,1,0,0", HOLIDAYS, vacMax),
    max.id,
    [
      [{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id,  hours: 5, note: "Frontend components", billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 2, billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 1, note: "Sprint prep", billable: true }],
      [{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id,  hours: 2, billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 5, note: "iOS screens", billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 1, note: "Stakeholder sync", billable: true }],
      [{ pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 6, note: "Android build", billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 2, note: "Sprint planning", billable: true }],
      [{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id,  hours: 4, note: "Design handoff", billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 3, billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 1, billable: true }],
      [{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id,  hours: 1, billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppMob.id, hours: 5, note: "Release prep", billable: true },
       { pid: pAcmeApp.id, rid: rAcmeAppPM.id,  hours: 2, note: "Roadmap review", billable: true }],
    ],
  );

  // ── Anna (20h/5d = 4h/day, Mon–Fri) ─────────────────────────────────────────
  // Mar: BRAVO-ID only. Apr–May: BRAVO-ID + ECHO-ANA + BRAVO-CAMP. Jun: ECHO-ANA + BRAVO-CAMP.
  addEntries(
    workingDays(D("2026-03-01"), D("2026-03-31"), "1,1,1,1,1,0,0", HOLIDAYS, new Set()),
    anna.id,
    [[{ pid: pBravoId.id, rid: rBravoIdDes.id, hours: 4, note: "Brand research", billable: false }]],
  );
  addEntries(
    workingDays(D("2026-04-01"), D("2026-05-31"), "1,1,1,1,1,0,0", HOLIDAYS, vacAnna),
    anna.id,
    [
      [{ pid: pBravoId.id,   rid: rBravoIdDes.id,  hours: 2, note: "Logo concepts", billable: false },
       { pid: pEchoAna.id,   rid: rEchoAnaViz.id,  hours: 2, note: "Dashboard mockups", billable: true }],
      [{ pid: pBravoId.id,   rid: rBravoIdDes.id,  hours: 1, billable: false },
       { pid: pEchoAna.id,   rid: rEchoAnaViz.id,  hours: 1, billable: true },
       { pid: pBravoCamp.id, rid: rBravoCampCS.id,  hours: 2, note: "Campaign brief", billable: false }],
      [{ pid: pBravoId.id,   rid: rBravoIdDes.id,  hours: 3, note: "Color palette", billable: false },
       { pid: pBravoCamp.id, rid: rBravoCampCS.id,  hours: 1, billable: false }],
      [{ pid: pEchoAna.id,   rid: rEchoAnaViz.id,  hours: 3, note: "Chart library", billable: true },
       { pid: pBravoCamp.id, rid: rBravoCampCS.id,  hours: 1, billable: false }],
      [{ pid: pBravoId.id,   rid: rBravoIdDes.id,  hours: 4, note: "Identity delivery", billable: false }],
    ],
  );
  addEntries(
    workingDays(D("2026-06-01"), SEED_END, "1,1,1,1,1,0,0", HOLIDAYS, new Set()),
    anna.id,
    [
      [{ pid: pEchoAna.id,   rid: rEchoAnaViz.id,  hours: 2, note: "Viz refinement", billable: true },
       { pid: pBravoCamp.id, rid: rBravoCampCS.id,  hours: 2, note: "Final campaign", billable: false }],
      [{ pid: pEchoAna.id,   rid: rEchoAnaViz.id,  hours: 4, note: "Data viz delivery", billable: true }],
    ],
  );

  // ── Paul (32h/4d = 8h/day, Mon–Thu, starts Jan 15) ───────────────────────────
  // Jan15–Feb14: ACME-SUP + ACME-WEB. Feb15–Mar31: add ECHO-SHOP. Apr+: ACME-SUP + ECHO-SHOP (WEB done).
  addEntries(
    workingDays(D("2026-01-15"), D("2026-02-14"), "1,1,1,1,0,0,0", HOLIDAYS, new Set()),
    paul.id,
    [
      [{ pid: pAcmeSup.id, rid: rAcmeSupOps.id, hours: 5, note: "Monitoring setup", billable: true },
       { pid: pAcmeWeb.id, rid: rAcmeWebBE.id,  hours: 3, note: "API scaffolding", billable: true }],
      [{ pid: pAcmeWeb.id, rid: rAcmeWebBE.id,  hours: 8, note: "DB schema & migrations", billable: true }],
      [{ pid: pAcmeSup.id, rid: rAcmeSupOps.id, hours: 4, billable: true },
       { pid: pAcmeWeb.id, rid: rAcmeWebBE.id,  hours: 4, note: "Auth endpoints", billable: true }],
      [{ pid: pAcmeSup.id, rid: rAcmeSupOps.id, hours: 6, note: "Alerting rules", billable: true },
       { pid: pAcmeWeb.id, rid: rAcmeWebBE.id,  hours: 2, billable: true }],
    ],
  );
  addEntries(
    workingDays(D("2026-02-15"), D("2026-03-31"), "1,1,1,1,0,0,0", HOLIDAYS, new Set()),
    paul.id,
    [
      [{ pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 3, note: "Monitoring", billable: true },
       { pid: pAcmeWeb.id,  rid: rAcmeWebBE.id,   hours: 3, note: "REST endpoints", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 2, note: "Infra setup", billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 5, note: "CI/CD pipeline", billable: true },
       { pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 3, billable: true }],
      [{ pid: pAcmeWeb.id,  rid: rAcmeWebBE.id,   hours: 8, note: "Backend refactor", billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 4, note: "Deploy pipeline", billable: true },
       { pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 4, billable: true }],
    ],
  );
  // Apr+: ACME-WEB BE done — Paul focuses on ACME-SUP + ECHO-SHOP (no ACME-WEB entries)
  addEntries(
    workingDays(D("2026-04-01"), SEED_END, "1,1,1,1,0,0,0", HOLIDAYS, vacPaul),
    paul.id,
    [
      [{ pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 4, note: "Monitoring", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 4, note: "Platform ops", billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 6, note: "CI/CD refinement", billable: true },
       { pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 2, billable: true }],
      [{ pid: pAcmeSup.id,  rid: rAcmeSupOps.id,  hours: 5, note: "Incident response", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 3, billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopOps.id, hours: 8, note: "Platform upgrade", billable: true }],
    ],
  );

  // ── Sophie (40h/5d = 8h/day, Mon–Fri) ────────────────────────────────────────
  // Mar15–Mar31: DELTA-ERP only. Apr–May: DELTA-ERP + DELTA-SEC. Jun: DELTA-ERP + ECHO-SHOP.
  addEntries(
    workingDays(D("2026-03-15"), D("2026-03-31"), "1,1,1,1,1,0,0", HOLIDAYS, new Set()),
    sophie.id,
    [[{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 8, note: "Architecture kickoff", billable: true }]],
  );
  addEntries(
    workingDays(D("2026-04-01"), D("2026-05-31"), "1,1,1,1,1,0,0", HOLIDAYS, vacSophie),
    sophie.id,
    [
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 6, note: "Architecture design", billable: true },
       { pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 2, note: "Threat modelling", billable: true }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 8, note: "Integration layer", billable: true }],
      [{ pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 5, note: "Security review", billable: true },
       { pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 3, billable: true }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 5, billable: true },
       { pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 3, note: "Findings report", billable: true }],
      [{ pid: pDeltaSec.id, rid: rDeltaSecAna.id,  hours: 4, note: "Pen-test coordination", billable: true },
       { pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 4, billable: true }],
    ],
  );
  // Jun: DELTA-SEC ended; DELTA-ERP + ECHO-SHOP (booking covers from Jun 1)
  addEntries(
    workingDays(D("2026-06-01"), SEED_END, "1,1,1,1,1,0,0", HOLIDAYS, new Set()),
    sophie.id,
    [
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 6, note: "Phase 2 architecture", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopBE.id,   hours: 2, note: "Checkout API", billable: true }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpArch.id, hours: 8, note: "Integration testing", billable: true }],
    ],
  );

  // ── Lars (32h/4d = 8h/day, Mon–Thu) ──────────────────────────────────────────
  // Jan1–Feb14: ACME-WEB only. Feb15–Mar31: ECHO-SHOP + ACME-WEB. Apr+: ECHO-SHOP + ECHO-ANA (WEB done).
  addEntries(
    workingDays(D("2026-01-01"), D("2026-02-14"), "1,1,1,1,0,0,0", HOLIDAYS, vacLars),
    lars.id,
    [[{ pid: pAcmeWeb.id, rid: rAcmeWebFE.id, hours: 8, note: "Component library", billable: true }]],
  );
  addEntries(
    workingDays(D("2026-02-15"), D("2026-03-31"), "1,1,1,1,0,0,0", HOLIDAYS, new Set()),
    lars.id,
    [
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 5, note: "Product listing UI", billable: true },
       { pid: pAcmeWeb.id,  rid: rAcmeWebFE.id,  hours: 3, note: "Nav redesign", billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 8, note: "Cart & checkout", billable: true }],
      [{ pid: pAcmeWeb.id,  rid: rAcmeWebFE.id,  hours: 5, note: "Responsive fixes", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 3, billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 6, note: "Search & filter", billable: true },
       { pid: pAcmeWeb.id,  rid: rAcmeWebFE.id,  hours: 2, billable: true }],
    ],
  );
  // Apr+: ACME-WEB done — Lars on ECHO-SHOP + ECHO-ANA
  addEntries(
    workingDays(D("2026-04-01"), SEED_END, "1,1,1,1,0,0,0", HOLIDAYS, new Set()),
    lars.id,
    [
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 5, note: "Product UI", billable: true },
       { pid: pEchoAna.id,  rid: rEchoAnaDE.id,  hours: 3, note: "ETL pipeline", billable: true }],
      [{ pid: pEchoAna.id,  rid: rEchoAnaDE.id,  hours: 6, note: "Analytics API", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 2, billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 8, note: "Mobile responsive", billable: true }],
      [{ pid: pEchoAna.id,  rid: rEchoAnaDE.id,  hours: 4, note: "Data pipeline", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopFE.id, hours: 4, billable: true }],
    ],
  );

  // ── Mia (24h/3d = 8h/day, Mon–Tue–Wed) ───────────────────────────────────────
  // Jan1–Feb14: ACME-SUP only. Feb15–Mar14: ACME-SUP + ECHO-SHOP. Mar15+: all 3 roles.
  addEntries(
    workingDays(D("2026-01-01"), D("2026-02-14"), "1,1,1,0,0,0,0", HOLIDAYS, vacMia),
    mia.id,
    [[{ pid: pAcmeSup.id, rid: rAcmeSupSup.id, hours: 8, note: "Support tickets", billable: true }]],
  );
  addEntries(
    workingDays(D("2026-02-15"), D("2026-03-14"), "1,1,1,0,0,0,0", HOLIDAYS, new Set()),
    mia.id,
    [
      [{ pid: pAcmeSup.id,  rid: rAcmeSupSup.id, hours: 5, note: "Support tickets", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopQA.id, hours: 3, note: "Test planning", billable: true }],
      [{ pid: pEchoShop.id, rid: rEchoShopQA.id, hours: 8, note: "Feature testing", billable: true }],
      [{ pid: pAcmeSup.id,  rid: rAcmeSupSup.id, hours: 4, billable: true },
       { pid: pEchoShop.id, rid: rEchoShopQA.id, hours: 4, note: "Bug regression", billable: true }],
    ],
  );
  addEntries(
    workingDays(D("2026-03-15"), SEED_END, "1,1,1,0,0,0,0", HOLIDAYS, vacMia),
    mia.id,
    [
      [{ pid: pAcmeSup.id,  rid: rAcmeSupSup.id, hours: 4, note: "Support tickets", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopQA.id, hours: 4, note: "Test scenarios", billable: true }],
      [{ pid: pDeltaErp.id, rid: rDeltaErpQA.id, hours: 5, note: "Integration tests", billable: true },
       { pid: pEchoShop.id, rid: rEchoShopQA.id, hours: 3, billable: true }],
      [{ pid: pAcmeSup.id,  rid: rAcmeSupSup.id, hours: 3, billable: true },
       { pid: pDeltaErp.id, rid: rDeltaErpQA.id, hours: 5, note: "Regression suite", billable: true }],
    ],
  );

  // Bulk insert all time entries
  const CHUNK = 500;
  for (let i = 0; i < allEntries.length; i += CHUNK) {
    await db.insert(timeEntriesTable).values(allEntries.slice(i, i + CHUNK));
  }
  console.log(`  Time entries: ${allEntries.length} inserted (clean slate each run).`);

  // ── Resource Bookings ─────────────────────────────────────────────────────────
  // Clean-slate: delete all seed employee bookings and re-insert with weekday-mode.
  // Coherence guarantee: per-day booking total = employee daily capacity for each period.
  await db.delete(resourceBookingsTable)
    .where(inArray(resourceBookingsTable.employeeId, empIds));

  const B = insertBooking; // shorthand

  // ── Max (8h/day Mon–Fri) ─────────────────────────────────────────────────────
  // Jan: ACME-WEB 8h. Feb–Jun30: ACME-WEB 3h + Mob 3h + PM 2h = 8h. Jul–Aug: Mob 6h + PM 2h = 8h.
  await B({ employeeId: max.id, projectId: pAcmeWeb.id, projectRoleId: rAcmeWebFE.id,
    startDate: "2026-01-01", endDate: "2026-01-31", isoDays: MONFRI, hpwd: 8,
    notes: "Website Redesign — sole project Jan" });
  await B({ employeeId: max.id, projectId: pAcmeWeb.id, projectRoleId: rAcmeWebFE.id,
    startDate: "2026-02-01", endDate: "2026-06-30", isoDays: MONFRI, hpwd: 3,
    notes: "Website Redesign — winding down from Feb" });
  await B({ employeeId: max.id, projectId: pAcmeApp.id, projectRoleId: rAcmeAppMob.id,
    startDate: "2026-02-01", endDate: "2026-06-30", isoDays: MONFRI, hpwd: 3,
    notes: "Mobile App — core dev" });
  await B({ employeeId: max.id, projectId: pAcmeApp.id, projectRoleId: rAcmeAppPM.id,
    startDate: "2026-02-01", endDate: "2026-06-30", isoDays: MONFRI, hpwd: 2,
    notes: "Mobile App — PM overhead" });
  await B({ employeeId: max.id, projectId: pAcmeApp.id, projectRoleId: rAcmeAppMob.id,
    startDate: "2026-07-01", endDate: "2026-08-31", isoDays: MONFRI, hpwd: 6,
    notes: "Mobile App — full focus Jul–Aug" });
  await B({ employeeId: max.id, projectId: pAcmeApp.id, projectRoleId: rAcmeAppPM.id,
    startDate: "2026-07-01", endDate: "2026-08-31", isoDays: MONFRI, hpwd: 2,
    notes: "Mobile App — PM" });

  // ── Anna (4h/day Mon–Fri) ─────────────────────────────────────────────────────
  // Mar: BRAVO-ID 4h. Apr–May: BRAVO-ID 1.5h + ECHO-ANA 1.5h + BRAVO-CAMP 1h = 4h.
  // Jun–Jul: ECHO-ANA 2h + BRAVO-CAMP 2h = 4h.
  await B({ employeeId: anna.id, projectId: pBravoId.id,   projectRoleId: rBravoIdDes.id,
    startDate: "2026-03-01", endDate: "2026-03-31", isoDays: MONFRI, hpwd: 4,
    notes: "Brand Identity — research phase" });
  // Apr–May: BRAVO-ID 1.5h + ECHO-ANA 1.5h + BRAVO-CAMP 1h = 4h ✓
  await B({ employeeId: anna.id, projectId: pBravoId.id,   projectRoleId: rBravoIdDes.id,
    startDate: "2026-04-01", endDate: "2026-05-31", isoDays: MONFRI, hpwd: 1.5,
    notes: "Brand Identity — delivery" });
  await B({ employeeId: anna.id, projectId: pEchoAna.id,   projectRoleId: rEchoAnaViz.id,
    startDate: "2026-04-01", endDate: "2026-05-31", isoDays: MONFRI, hpwd: 1.5,
    notes: "Analytics Dashboard — viz design (Apr–May)" });
  await B({ employeeId: anna.id, projectId: pBravoCamp.id, projectRoleId: rBravoCampCS.id,
    startDate: "2026-04-01", endDate: "2026-05-31", isoDays: MONFRI, hpwd: 1,
    notes: "Campaign Creative — strategy (Apr–May)" });
  // Jun–Jul: BRAVO-ID ended; ECHO-ANA 2h + BRAVO-CAMP 2h = 4h ✓ (matches Jun time entries)
  await B({ employeeId: anna.id, projectId: pEchoAna.id,   projectRoleId: rEchoAnaViz.id,
    startDate: "2026-06-01", endDate: "2026-07-31", isoDays: MONFRI, hpwd: 2,
    notes: "Analytics Dashboard — full focus Jun–Jul" });
  await B({ employeeId: anna.id, projectId: pBravoCamp.id, projectRoleId: rBravoCampCS.id,
    startDate: "2026-06-01", endDate: "2026-06-30", isoDays: MONFRI, hpwd: 2,
    notes: "Campaign Creative — final delivery Jun" });

  // ── Paul (8h/day Mon–Thu) ─────────────────────────────────────────────────────
  // Jan15–Feb14: ACME-SUP 4h + ACME-WEB 4h = 8h.
  // Feb15–Mar31: ACME-SUP 3h + ACME-WEB 3h + ECHO-SHOP 2h = 8h.
  // Apr–Aug: ACME-SUP 3h + ECHO-SHOP 5h = 8h (ACME-WEB done).
  await B({ employeeId: paul.id, projectId: pAcmeSup.id,  projectRoleId: rAcmeSupOps.id,
    startDate: "2026-01-15", endDate: "2026-02-14", isoDays: MONTHU, hpwd: 4,
    notes: "Support ops — ramp-up" });
  await B({ employeeId: paul.id, projectId: pAcmeWeb.id,  projectRoleId: rAcmeWebBE.id,
    startDate: "2026-01-15", endDate: "2026-02-14", isoDays: MONTHU, hpwd: 4,
    notes: "Backend — initial build" });
  await B({ employeeId: paul.id, projectId: pAcmeSup.id,  projectRoleId: rAcmeSupOps.id,
    startDate: "2026-02-15", endDate: "2026-03-31", isoDays: MONTHU, hpwd: 3,
    notes: "Support ops" });
  await B({ employeeId: paul.id, projectId: pAcmeWeb.id,  projectRoleId: rAcmeWebBE.id,
    startDate: "2026-02-15", endDate: "2026-03-31", isoDays: MONTHU, hpwd: 3,
    notes: "Backend — finishing up" });
  await B({ employeeId: paul.id, projectId: pEchoShop.id, projectRoleId: rEchoShopOps.id,
    startDate: "2026-02-15", endDate: "2026-03-31", isoDays: MONTHU, hpwd: 2,
    notes: "E-Commerce infra — initial setup" });
  await B({ employeeId: paul.id, projectId: pAcmeSup.id,  projectRoleId: rAcmeSupOps.id,
    startDate: "2026-04-01", endDate: "2026-08-31", isoDays: MONTHU, hpwd: 3,
    notes: "Support ops — ongoing" });
  await B({ employeeId: paul.id, projectId: pEchoShop.id, projectRoleId: rEchoShopOps.id,
    startDate: "2026-04-01", endDate: "2026-08-31", isoDays: MONTHU, hpwd: 5,
    notes: "E-Commerce platform ops" });

  // ── Sophie (8h/day Mon–Fri) ───────────────────────────────────────────────────
  // Mar15–31: DELTA-ERP 8h. Apr–May: DELTA-ERP 5h + DELTA-SEC 3h = 8h.
  // Jun–Aug: DELTA-ERP 6h + ECHO-SHOP 2h = 8h.
  await B({ employeeId: sophie.id, projectId: pDeltaErp.id, projectRoleId: rDeltaErpArch.id,
    startDate: "2026-03-15", endDate: "2026-03-31", isoDays: MONFRI, hpwd: 8,
    notes: "ERP — architecture kickoff" });
  await B({ employeeId: sophie.id, projectId: pDeltaErp.id, projectRoleId: rDeltaErpArch.id,
    startDate: "2026-04-01", endDate: "2026-05-31", isoDays: MONFRI, hpwd: 5,
    notes: "ERP — integration design" });
  await B({ employeeId: sophie.id, projectId: pDeltaSec.id, projectRoleId: rDeltaSecAna.id,
    startDate: "2026-04-01", endDate: "2026-05-31", isoDays: MONFRI, hpwd: 3,
    notes: "Security audit" });
  await B({ employeeId: sophie.id, projectId: pDeltaErp.id, projectRoleId: rDeltaErpArch.id,
    startDate: "2026-06-01", endDate: "2026-08-31", isoDays: MONFRI, hpwd: 6,
    notes: "ERP — Phase 2" });
  await B({ employeeId: sophie.id, projectId: pEchoShop.id, projectRoleId: rEchoShopBE.id,
    startDate: "2026-06-01", endDate: "2026-08-31", isoDays: MONFRI, hpwd: 2,
    notes: "E-Commerce backend support" });

  // ── Lars (8h/day Mon–Thu) ─────────────────────────────────────────────────────
  // Jan1–Feb14: ACME-WEB 8h. Feb15–Mar31: ECHO-SHOP 5h + ACME-WEB 3h = 8h.
  // Apr–Jul: ECHO-SHOP 5h + ECHO-ANA 3h = 8h (ACME-WEB done).
  await B({ employeeId: lars.id, projectId: pAcmeWeb.id,  projectRoleId: rAcmeWebFE.id,
    startDate: "2026-01-01", endDate: "2026-02-14", isoDays: MONTHU, hpwd: 8,
    notes: "Website — component library" });
  await B({ employeeId: lars.id, projectId: pEchoShop.id, projectRoleId: rEchoShopFE.id,
    startDate: "2026-02-15", endDate: "2026-03-31", isoDays: MONTHU, hpwd: 5,
    notes: "E-Commerce frontend — phase 1" });
  await B({ employeeId: lars.id, projectId: pAcmeWeb.id,  projectRoleId: rAcmeWebFE.id,
    startDate: "2026-02-15", endDate: "2026-03-31", isoDays: MONTHU, hpwd: 3,
    notes: "Website — finishing up" });
  await B({ employeeId: lars.id, projectId: pEchoShop.id, projectRoleId: rEchoShopFE.id,
    startDate: "2026-04-01", endDate: "2026-08-31", isoDays: MONTHU, hpwd: 5,
    notes: "E-Commerce frontend — main delivery" });
  await B({ employeeId: lars.id, projectId: pEchoAna.id,  projectRoleId: rEchoAnaDE.id,
    startDate: "2026-04-01", endDate: "2026-07-31", isoDays: MONTHU, hpwd: 3,
    notes: "Analytics — data pipeline" });

  // ── Mia (8h/day Mon–Wed) ──────────────────────────────────────────────────────
  // Jan1–Feb14: ACME-SUP 8h. Feb15–Mar14: ACME-SUP 4h + ECHO-SHOP 4h = 8h.
  // Mar15–Aug: ACME-SUP 2.5h + ECHO-SHOP 2.5h + DELTA-ERP 3h = 8h.
  await B({ employeeId: mia.id, projectId: pAcmeSup.id,  projectRoleId: rAcmeSupSup.id,
    startDate: "2026-01-01", endDate: "2026-02-14", isoDays: MONWED, hpwd: 8,
    notes: "Support — sole focus" });
  await B({ employeeId: mia.id, projectId: pAcmeSup.id,  projectRoleId: rAcmeSupSup.id,
    startDate: "2026-02-15", endDate: "2026-03-14", isoDays: MONWED, hpwd: 4,
    notes: "Support — split with QA" });
  await B({ employeeId: mia.id, projectId: pEchoShop.id, projectRoleId: rEchoShopQA.id,
    startDate: "2026-02-15", endDate: "2026-03-14", isoDays: MONWED, hpwd: 4,
    notes: "E-Commerce QA — onboarding" });
  await B({ employeeId: mia.id, projectId: pAcmeSup.id,  projectRoleId: rAcmeSupSup.id,
    startDate: "2026-03-15", endDate: "2026-08-31", isoDays: MONWED, hpwd: 2.5,
    notes: "Support — reduced (3 projects)" });
  await B({ employeeId: mia.id, projectId: pEchoShop.id, projectRoleId: rEchoShopQA.id,
    startDate: "2026-03-15", endDate: "2026-08-31", isoDays: MONWED, hpwd: 2.5,
    notes: "E-Commerce QA" });
  await B({ employeeId: mia.id, projectId: pDeltaErp.id, projectRoleId: rDeltaErpQA.id,
    startDate: "2026-03-15", endDate: "2026-08-31", isoDays: MONWED, hpwd: 3,
    notes: "ERP QA" });

  console.log("  Resource bookings: rebuilt in weekday-mode (capacity-consistent per employee per day).");

  // ── Project Health Updates ─────────────────────────────────────────────────────
  let huCount = 0;
  const hu = async (v: Parameters<typeof upsertHealthUpdate>[0]) => { await upsertHealthUpdate(v); huCount++; };

  await hu({ projectId: pAcmeWeb.id, generalStatus: "in_progress", budgetStatus: "on_track",
    riskLevel: "low", clientSatisfaction: "happy",
    comment: "Phase 1 complete. Frontend components delivered on schedule. Client very satisfied.",
    createdAt: new Date("2026-04-15T10:00:00Z") });
  await hu({ projectId: pAcmeWeb.id, generalStatus: "in_progress", budgetStatus: "on_track",
    riskLevel: "low", clientSatisfaction: "happy",
    comment: "Final sprint underway. All milestones on track. Budget at 78% consumed.",
    createdAt: new Date("2026-06-02T09:30:00Z") });

  await hu({ projectId: pDeltaErp.id, generalStatus: "in_progress", budgetStatus: "at_risk",
    riskLevel: "medium", clientSatisfaction: "neutral",
    comment: "Integration layer design complete. Third-party API delays flagged. Mitigation plan in place.",
    createdAt: new Date("2026-04-20T14:00:00Z") });
  await hu({ projectId: pDeltaErp.id, generalStatus: "in_progress", budgetStatus: "at_risk",
    riskLevel: "medium", clientSatisfaction: "neutral",
    comment: "Phase 1 delivered. Legacy system migration more complex than estimated. Timeline extended 3 weeks.",
    createdAt: new Date("2026-06-10T11:00:00Z") });

  await hu({ projectId: pEchoShop.id, generalStatus: "in_progress", budgetStatus: "over_budget",
    riskLevel: "high", clientSatisfaction: "critical",
    comment: "Performance issues discovered in checkout flow. Emergency QA sprint added. Client escalation received.",
    createdAt: new Date("2026-05-05T16:00:00Z") });
  await hu({ projectId: pEchoShop.id, generalStatus: "in_progress", budgetStatus: "over_budget",
    riskLevel: "high", clientSatisfaction: "critical",
    comment: "Performance resolved. Budget overrun 15%. Client partially appeased. Plan to recover by July.",
    createdAt: new Date("2026-06-15T10:00:00Z") });

  await hu({ projectId: pDeltaSec.id, generalStatus: "completed", budgetStatus: "under_budget",
    riskLevel: "low", clientSatisfaction: "happy",
    comment: "Security audit delivered. Final report accepted. All critical findings remediated. 5% under budget.",
    createdAt: new Date("2026-06-05T09:00:00Z") });

  await hu({ projectId: pBravoCamp.id, generalStatus: "on_hold", budgetStatus: "on_track",
    riskLevel: "medium", clientSatisfaction: "neutral",
    comment: "Campaign on hold pending client brand strategy decision. Expected to resume by end of May.",
    createdAt: new Date("2026-05-20T13:00:00Z") });
  await hu({ projectId: pBravoCamp.id, generalStatus: "in_progress", budgetStatus: "on_track",
    riskLevel: "low", clientSatisfaction: "neutral",
    comment: "Campaign resumed. Strategy approved. Deliverables on track for June 30 deadline.",
    createdAt: new Date("2026-06-08T10:00:00Z") });

  await hu({ projectId: pEchoAna.id, generalStatus: "in_progress", budgetStatus: "on_track",
    riskLevel: "low", clientSatisfaction: "happy",
    comment: "Project kicked off smoothly. Data pipeline design approved. First dashboard mockups well-received.",
    createdAt: new Date("2026-05-01T11:00:00Z") });

  console.log(`  Project health updates: ${huCount} total processed.`);

  // ── Sync project status fields to match latest health update ──────────────────
  // projectsTable.generalStatus/riskLevel/clientSatisfaction are what the Project Status
  // overview page reads directly — health-updates log is append-only audit only.
  const projectStatusMap = [
    { id: pAcmeWeb.id,   generalStatus: "in_progress", riskLevel: "low",    clientSatisfaction: "happy"    },
    { id: pAcmeApp.id,   generalStatus: "in_progress", riskLevel: "low",    clientSatisfaction: null        },
    { id: pAcmeSup.id,   generalStatus: "in_progress", riskLevel: "low",    clientSatisfaction: "happy"    },
    { id: pBravoId.id,   generalStatus: "completed",   riskLevel: "low",    clientSatisfaction: "happy"    },
    { id: pDeltaErp.id,  generalStatus: "in_progress", riskLevel: "medium", clientSatisfaction: "neutral"  },
    { id: pDeltaSec.id,  generalStatus: "completed",   riskLevel: "low",    clientSatisfaction: "happy"    },
    { id: pEchoShop.id,  generalStatus: "in_progress", riskLevel: "high",   clientSatisfaction: "critical" },
    { id: pEchoAna.id,   generalStatus: "in_progress", riskLevel: "low",    clientSatisfaction: "happy"    },
    { id: pBravoCamp.id, generalStatus: "in_progress", riskLevel: "low",    clientSatisfaction: "neutral"  },
  ];
  for (const s of projectStatusMap) {
    await db.update(projectsTable)
      .set({ generalStatus: s.generalStatus, riskLevel: s.riskLevel, clientSatisfaction: s.clientSatisfaction })
      .where(eq(projectsTable.id, s.id));
  }
  console.log("  Project status fields synced (varied statuses/risk/satisfaction for Project Status page).");

  await pool.end();

  console.log("\nSeed complete ✓");
  console.log("  Demo PINs — Max: 1234 | Anna: 5678 | Paul: 9999 | Sophie: 2222 | Lars: 3333 | Mia: 4444");
  console.log("  Coverage:");
  console.log("    Jan–Jun 2026 time entries with invoiced/invest/unbilled billing mix");
  console.log("    Weekday-mode bookings Jan–Aug, capacity-consistent (8h Max/Sophie/Lars, 4h Anna, 8h Mon-Thu Paul, 8h Mon-Wed Mia)");
  console.log("    All booked roles covered by matching bookings (no unbooked project-role combos)");
  console.log("    10 health updates across 6 projects | varied project statuses on Project Status page");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
