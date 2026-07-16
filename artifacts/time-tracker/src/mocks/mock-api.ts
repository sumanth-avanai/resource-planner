/**
 * Mock API — dev-only, in-browser fake of the AvaTrack REST API.
 *
 * Activated ONLY when VITE_MOCK === "1" (see main.tsx + `pnpm dev:mock`).
 * Patches window.fetch and answers every `/api/*` request from an in-memory
 * store seeded from ./db.json. No server, no database, no route changes.
 *
 * Mutations (create booking, log time, …) work within the session and reset
 * on reload. Response shapes mirror artifacts/api-server/src/routes/*.
 */

import seed from "./db.json";

/* ────────────────────────── types (shape-only, loose) ───────────────────── */

type Json = Record<string, unknown>;
type Handler = (m: RegExpMatchArray, url: URL, body: Json | null) => Response | Promise<Response>;

interface TimeEntry {
  id: number;
  employeeId: number;
  projectId: number;
  projectRoleId: number | null;
  entryDate: string;
  hours: number;
  note: string | null;
  invoicedAt: string | null;
  invoiceReference: string | null;
  billingStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Client { id: number; name: string; active: boolean; notes: string | null; createdAt: string }
interface Employee {
  id: number; name: string; email: string | null; weeklyCapacityHours: number;
  workingDaysMask: number[]; holidayCalendarCode: string | null;
  contractStartDate: string | null; contractEndDate: string | null;
  utilizationTarget: number | null; personalAccessToken: string; active: boolean; createdAt: string;
}
interface Project {
  id: number; clientId: number; name: string; code: string | null; active: boolean;
  isBillable: boolean; budgetHours: number | null; startDate: string | null; endDate: string | null;
  color: string | null; pmName: string | null; generalStatus: string | null; budgetStatus: string | null;
  riskLevel: string | null; clientSatisfaction: string | null;
  nextSteps: Array<{ id: string; text: string; done: boolean }> | null; createdAt: string;
}
interface Role {
  id: number; projectId: number; name: string; dayRate: number;
  budgetedDays: number | null; budgetedHours: number | null; createdAt: string; updatedAt: string;
}
interface Booking {
  id: number; employeeId: number; projectId: number; projectRoleId: number | null;
  startDate: string; endDate: string; hoursPerDay: number;
  weekdayHours: Record<string, number> | null; notes: string | null; status: string | null;
  pastReleasedAt: string | null; createdAt: string; updatedAt: string;
  /** Demo flag: don't auto-generate time entries from this booking. */
  skipAutoLog?: boolean;
}
/** Compact seed for explicit logged work (expanded to daily entries, Mon–Fri). */
interface ManualEntryRange {
  employeeId: number; projectId: number; projectRoleId: number | null;
  startDate: string; endDate: string; hoursPerDay: number;
  billingStatus: string | null; invoiceReference: string | null;
}
interface Vacation {
  id: number; employeeId: number; startDate: string; endDate: string;
  vacationType: string; note: string | null; createdAt: string;
}
interface HolidayCalendar { id: number; code: string; name: string; createdAt: string }
interface Holiday { id: number; calendarId: number; date: string; name: string }
interface HealthUpdate {
  id: number; projectId: number; generalStatus: string; budgetStatus: string | null;
  riskLevel: string; clientSatisfaction: string | null; comment: string | null; createdAt: string;
}
interface Invoice {
  id: number; projectId: number; createdAt: string; periodStart: string; periodEnd: string;
  totalAmount: number; reference: string | null; roleIds: number[]; employeeIds: number[];
}
interface SavedReport { id: string; name: string; config: string; createdAt: string; updatedAt: string }

interface MockDb {
  clients: Client[];
  employees: Employee[];
  projects: Project[];
  projectRoles: Role[];
  roleAssignments: Array<{ roleId: number; employeeId: number }>;
  resourceBookings: Booking[];
  vacations: Vacation[];
  holidayCalendars: HolidayCalendar[];
  holidays: Holiday[];
  healthUpdates: HealthUpdate[];
  invoices: Invoice[];
  savedReports: SavedReport[];
  timeEntries: TimeEntry[];
  manualTimeEntries?: ManualEntryRange[];
}

/* ────────────────────────────── date helpers ────────────────────────────── */

const DAY = 86_400_000;
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => fmt(new Date(parse(s).getTime() + n * DAY));
/** ISO weekday 1 (Mon) … 7 (Sun) */
const isoDow = (s: string) => ((parse(s).getUTCDay() + 6) % 7) + 1;
const todayStr = () => fmt(new Date());
const monthOf = (s: string) => s.slice(0, 7);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function* eachDay(start: string, end: string) {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

function mondayOf(dateStr: string): string {
  return addDays(dateStr, -(isoDow(dateStr) - 1));
}

/* ─────────────────────────── in-memory database ─────────────────────────── */

const db = JSON.parse(JSON.stringify(seed)) as unknown as MockDb;
db.timeEntries = [];

const state = { authenticated: true, nextId: 10_000 };
const nid = () => state.nextId++;
const now = () => new Date().toISOString();

const holidayDates = new Set(db.holidays.map((h) => h.date));

const empById = (id: number) => db.employees.find((e) => e.id === id);
const projById = (id: number) => db.projects.find((p) => p.id === id);
const clientById = (id: number) => db.clients.find((c) => c.id === id);
const roleById = (id: number | null) => (id == null ? undefined : db.projectRoles.find((r) => r.id === id));

/** Hours a booking contributes on a given date (0 on weekends / outside range). */
function bookingHoursOn(b: (typeof db.resourceBookings)[number], date: string): number {
  if (date < b.startDate || date > b.endDate) return 0;
  const dow = isoDow(date);
  if (dow > 5) return 0;
  if (b.weekdayHours) return (b.weekdayHours as Record<string, number>)[String(dow)] ?? 0;
  return b.hoursPerDay;
}

function isWorkingDay(empId: number, date: string): boolean {
  const emp = empById(empId);
  if (!emp) return false;
  const mask = emp.workingDaysMask as number[];
  if (!mask[isoDow(date) - 1]) return false;
  if (emp.holidayCalendarCode && holidayDates.has(date)) return false;
  if (emp.contractStartDate && date < emp.contractStartDate) return false;
  if (emp.contractEndDate && date > emp.contractEndDate) return false;
  return true;
}

function onVacation(empId: number, date: string): boolean {
  return db.vacations.some((v) => v.employeeId === empId && date >= v.startDate && date <= v.endDate);
}

/* Generate past time entries from bookings so Timesheet/Reports/Billing have data. */
function generateTimeEntries() {
  const today = todayStr();
  const curMonth = monthOf(today);
  // explicit logged work (used e.g. by the budget-reconciliation demo project)
  for (const m of db.manualTimeEntries ?? []) {
    for (const d of eachDay(m.startDate, m.endDate)) {
      if (isoDow(d) > 5) continue;
      db.timeEntries.push({
        id: nid(),
        employeeId: m.employeeId,
        projectId: m.projectId,
        projectRoleId: m.projectRoleId,
        entryDate: d,
        hours: m.hoursPerDay,
        note: null,
        invoicedAt: m.billingStatus === "invoiced" ? `${d}T18:00:00.000Z` : null,
        invoiceReference: m.invoiceReference,
        billingStatus: m.billingStatus,
        createdAt: `${d}T18:00:00.000Z`,
        updatedAt: `${d}T18:00:00.000Z`,
      });
    }
  }
  for (const b of db.resourceBookings) {
    if (b.status === "tentative" || b.skipAutoLog) continue;
    for (const d of eachDay(b.startDate, b.endDate)) {
      if (d >= today) break;
      const h = bookingHoursOn(b, d);
      if (h <= 0 || !isWorkingDay(b.employeeId, d) || onVacation(b.employeeId, d)) continue;
      const invoiced = b.projectId === 1 && monthOf(d) < curMonth;
      const inv = db.invoices.find((i) => i.projectId === b.projectId && d >= i.periodStart && d <= i.periodEnd);
      db.timeEntries.push({
        id: nid(),
        employeeId: b.employeeId,
        projectId: b.projectId,
        projectRoleId: b.projectRoleId,
        entryDate: d,
        hours: h,
        note: null,
        invoicedAt: invoiced ? (inv?.createdAt ?? now()) : null,
        invoiceReference: invoiced ? (inv?.reference ?? null) : null,
        billingStatus: invoiced ? "invoiced" : null,
        createdAt: `${d}T18:00:00.000Z`,
        updatedAt: `${d}T18:00:00.000Z`,
      });
    }
  }
}
generateTimeEntries();

/* ───────────────────────────── enrichment ───────────────────────────────── */

function enrichBooking(b: (typeof db.resourceBookings)[number]) {
  const emp = empById(b.employeeId);
  const proj = projById(b.projectId);
  const role = roleById(b.projectRoleId);
  const client = proj ? clientById(proj.clientId) : undefined;
  return {
    ...b,
    employeeName: emp?.name ?? "",
    weeklyCapacityHours: emp?.weeklyCapacityHours ?? 40,
    projectName: proj?.name ?? "",
    projectColor: proj?.color ?? "#8A93A3",
    clientName: client?.name ?? null,
    projectRoleName: role?.name ?? null,
    dayRate: role?.dayRate ?? null,
  };
}

function enrichEntry(e: TimeEntry) {
  const emp = empById(e.employeeId);
  const proj = projById(e.projectId);
  const role = roleById(e.projectRoleId);
  const client = proj ? clientById(proj.clientId) : undefined;
  return {
    ...e,
    employeeName: emp?.name ?? null,
    projectName: proj?.name ?? null,
    clientName: client?.name ?? null,
    isBillable: proj?.isBillable ?? null,
    roleName: role?.name ?? null,
    roleDayRate: role?.dayRate ?? null,
  };
}

function roleWithAssignees(r: (typeof db.projectRoles)[number]) {
  return {
    ...r,
    assignedEmployees: db.roleAssignments
      .filter((a) => a.roleId === r.id)
      .map((a) => ({ employeeId: a.employeeId, employeeName: empById(a.employeeId)?.name ?? null })),
  };
}

/* ─────────────────────────── computed figures ───────────────────────────── */

function bookedDaysForRole(roleId: number, opts: { tentative?: boolean; from?: string; to?: string } = {}) {
  let days = 0;
  for (const b of db.resourceBookings.filter((b) => b.projectRoleId === roleId)) {
    const isTentative = b.status === "tentative";
    if (opts.tentative !== undefined && isTentative !== opts.tentative) continue;
    for (const d of eachDay(b.startDate, b.endDate)) {
      if (opts.from && d < opts.from) continue;
      if (opts.to && d > opts.to) continue;
      days += bookingHoursOn(b, d) / 8;
    }
  }
  return days;
}

/**
 * Budget reconciliation — CORRECTED model (proposed fix for the negative-days
 * problem; mirrors what api-server/src/lib/budget-reconciliation.ts should do).
 *
 * Identity: B = C + R + U
 *   C (loggedDays)    = all delivered work, invoiced or not. Invoicing is a
 *                       billing overlay and never moves capacity figures.
 *   R (reservedDays)  = undelivered planned days from TODAY onwards, netted
 *                       per day against logged hours (no double counting).
 *   S (stalePlanDays) = undelivered planned days strictly BEFORE today —
 *                       a data-quality flag ("release or re-plan"), never
 *                       counted as consumption.
 *   U (unplannedDays) = B − C − R. Negative only on genuine over-commitment.
 */
function roleBudgetFigures(r: Role) {
  const budgetedDays = r.budgetedDays;
  const today = todayStr();

  // per-day planned hours (non-tentative). Released bookings: the write-off
  // is FROZEN at the release date — days missed AFTER the release resurface
  // as stale instead of being rolling-forgiven by "today" (edge-case-4 fix).
  const plannedByDay = new Map<string, number>();
  for (const b of db.resourceBookings.filter((b) => b.projectRoleId === r.id && b.status !== "tentative")) {
    const releasedUpTo = b.pastReleasedAt ? b.pastReleasedAt.slice(0, 10) : null;
    for (const d of eachDay(b.startDate, b.endDate)) {
      if (releasedUpTo && d < releasedUpTo) continue;
      const h = bookingHoursOn(b, d);
      if (h > 0) plannedByDay.set(d, (plannedByDay.get(d) ?? 0) + h);
    }
  }
  // per-day logged hours
  const loggedByDay = new Map<string, number>();
  let loggedHours = 0;
  let invoicedHours = 0;
  for (const e of db.timeEntries.filter((e) => e.projectRoleId === r.id)) {
    loggedByDay.set(e.entryDate, (loggedByDay.get(e.entryDate) ?? 0) + e.hours);
    loggedHours += e.hours;
    if (e.billingStatus === "invoiced") invoicedHours += e.hours;
  }
  let reservedHours = 0; // committed future, undelivered
  let staleHours = 0; // past plan never delivered (and never released)
  let plannedHours = 0;
  for (const [d, planned] of plannedByDay) {
    plannedHours += planned;
    const undelivered = Math.max(planned - (loggedByDay.get(d) ?? 0), 0);
    if (d >= today) reservedHours += undelivered;
    else staleHours += undelivered;
  }

  const loggedDays = round1(loggedHours / 8);
  const invoicedDays = round1(invoicedHours / 8);
  const reservedDays = round1(reservedHours / 8);
  return {
    budgetedDays,
    plannedDays: round1(plannedHours / 8),
    loggedDays,
    invoicedDays,
    reservedDays,
    stalePlanDays: round1(staleHours / 8),
    unplannedDays: budgetedDays == null ? null : round1(budgetedDays - loggedDays - reservedDays),
    freeDays: budgetedDays == null ? null : round1(budgetedDays - loggedDays),
    remainingBudgetDays: budgetedDays == null ? null : round1(budgetedDays - invoicedDays),
    loggedNotInvoicedDays: round1((loggedHours - invoicedHours) / 8),
  };
}

/* ───────────────────────────── router core ──────────────────────────────── */

const routes: Array<{ method: string; re: RegExp; fn: Handler }> = [];
const on = (method: string, pattern: string, fn: Handler) => {
  const re = new RegExp(`^${pattern.replace(/:\w+/g, "([^/]+)")}$`);
  routes.push({ method, re, fn });
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const noContent = () => new Response(null, { status: 204 });
const notFound = (what: string) => json({ error: `${what} not found` }, 404);

/* ────────────────────────────── auth ────────────────────────────────────── */

on("GET", "/api/healthz", () => json({ ok: true }));
on("GET", "/api/auth/app/me", () =>
  state.authenticated ? json({ authenticated: true }) : json({ authenticated: false }, 401),
);
on("POST", "/api/auth/app/login", (_m, _u, body) => {
  if (!body?.password) return json({ error: "Invalid password" }, 401);
  state.authenticated = true;
  return json({ authenticated: true });
});
on("POST", "/api/auth/app/logout", () => {
  state.authenticated = false;
  return json({ authenticated: false });
});

/* ──────────────────────────── employees ─────────────────────────────────── */

on("GET", "/api/employees", (_m, url) => {
  const inactive = url.searchParams.get("includeInactive") === "true";
  const list = db.employees
    .filter((e) => inactive || e.active)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  return json(list);
});
on("GET", "/api/employees/:id", (m) => {
  const emp = empById(Number(m[1]));
  return emp ? json(emp) : notFound("Employee");
});
on("POST", "/api/employees", (_m, _u, body) => {
  const emp = {
    id: nid(),
    name: String(body?.name ?? "New employee"),
    email: (body?.email as string) ?? null,
    weeklyCapacityHours: Number(body?.weeklyCapacityHours ?? 40),
    workingDaysMask: (body?.workingDaysMask as number[]) ?? [1, 1, 1, 1, 1, 0, 0],
    holidayCalendarCode: (body?.holidayCalendarCode as string) ?? null,
    contractStartDate: (body?.contractStartDate as string) ?? todayStr(),
    contractEndDate: (body?.contractEndDate as string) ?? null,
    utilizationTarget: (body?.utilizationTarget as number) ?? null,
    personalAccessToken: `tok-${Math.random().toString(36).slice(2, 8)}`,
    active: body?.active !== false,
    createdAt: now(),
  };
  db.employees.push(emp);
  return json(emp, 201);
});
on("PATCH", "/api/employees/:id", (m, _u, body) => {
  const emp = empById(Number(m[1]));
  if (!emp) return notFound("Employee");
  Object.assign(emp, body ?? {});
  return json(emp);
});
on("DELETE", "/api/employees/:id", (m) => {
  const i = db.employees.findIndex((e) => e.id === Number(m[1]));
  if (i < 0) return notFound("Employee");
  db.employees.splice(i, 1);
  return noContent();
});
on("POST", "/api/employees/:id/reset-pin", (m) => {
  const emp = empById(Number(m[1]));
  if (!emp) return notFound("Employee");
  emp.personalAccessToken = `tok-${Math.random().toString(36).slice(2, 8)}`;
  return json(emp);
});

/* ───────────────────────────── clients ──────────────────────────────────── */

on("GET", "/api/clients", (_m, url) => {
  const inactive = url.searchParams.get("includeInactive") === "true";
  return json(db.clients.filter((c) => inactive || c.active).slice().sort((a, b) => a.name.localeCompare(b.name)));
});
on("GET", "/api/clients/:id", (m) => {
  const c = clientById(Number(m[1]));
  return c ? json(c) : notFound("Client");
});
on("POST", "/api/clients", (_m, _u, body) => {
  const c = { id: nid(), name: String(body?.name ?? "New client"), active: true, notes: (body?.notes as string) ?? null, createdAt: now() };
  db.clients.push(c);
  return json(c, 201);
});
on("PATCH", "/api/clients/:id", (m, _u, body) => {
  const c = clientById(Number(m[1]));
  if (!c) return notFound("Client");
  Object.assign(c, body ?? {});
  return json(c);
});
on("DELETE", "/api/clients/:id", (m) => {
  const i = db.clients.findIndex((c) => c.id === Number(m[1]));
  if (i < 0) return notFound("Client");
  db.clients.splice(i, 1);
  return noContent();
});

/* ───────────────────────────── projects ─────────────────────────────────── */

function projectListItem(p: (typeof db.projects)[number]) {
  const roles = db.projectRoles.filter((r) => r.projectId === p.id);
  const budgeted = roles.filter((r) => r.budgetedDays != null);
  // "booked" on the projects list = logged/delivered days (matches real API)
  const bookedDays = db.timeEntries
    .filter((e) => e.projectId === p.id)
    .reduce((s, e) => s + e.hours / 8, 0);
  const { clientSatisfaction: _cs, nextSteps: _ns, ...rest } = p;
  return {
    ...rest,
    clientName: clientById(p.clientId)?.name ?? null,
    roleCount: roles.length,
    budgetDays: budgeted.length ? budgeted.reduce((s, r) => s + (r.budgetedDays ?? 0), 0) : null,
    bookedDays: round1(bookedDays),
  };
}

on("GET", "/api/projects", (_m, url) => {
  const inactive = url.searchParams.get("includeInactive") === "true";
  const clientId = url.searchParams.get("clientId");
  let list = db.projects.filter((p) => inactive || p.active);
  if (clientId) list = list.filter((p) => p.clientId === Number(clientId));
  return json(list.slice().sort((a, b) => a.name.localeCompare(b.name)).map(projectListItem));
});
on("GET", "/api/projects/:id", (m) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const { clientSatisfaction: _cs, nextSteps: _ns, roleCount: _rc, ...rest } = projectListItem(p) as Json;
  delete rest.budgetDays;
  delete rest.bookedDays;
  return json(rest);
});
on("POST", "/api/projects", (_m, _u, body) => {
  const p = {
    id: nid(),
    clientId: Number(body?.clientId ?? db.clients[0].id),
    name: String(body?.name ?? "New project"),
    code: (body?.code as string) ?? null,
    active: true,
    isBillable: body?.isBillable !== false,
    budgetHours: (body?.budgetHours as number) ?? null,
    startDate: (body?.startDate as string) ?? null,
    endDate: (body?.endDate as string) ?? null,
    color: (body?.color as string) ?? "#25B2F9",
    pmName: (body?.pmName as string) ?? null,
    generalStatus: "planned",
    budgetStatus: null,
    riskLevel: "low",
    clientSatisfaction: null,
    nextSteps: null,
    createdAt: now(),
  };
  db.projects.push(p as (typeof db.projects)[number]);
  return json({ ...p, clientName: clientById(p.clientId)?.name ?? null }, 201);
});
on("PATCH", "/api/projects/:id", (m, _u, body) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  Object.assign(p, body ?? {});
  return json({ ...p, clientName: clientById(p.clientId)?.name ?? null });
});
on("DELETE", "/api/projects/:id", (m) => {
  const i = db.projects.findIndex((p) => p.id === Number(m[1]));
  if (i < 0) return notFound("Project");
  db.projects.splice(i, 1);
  return noContent();
});

/* ─────────────────────────── project roles ──────────────────────────────── */

on("GET", "/api/projects/:id/roles", (m) =>
  json(db.projectRoles.filter((r) => r.projectId === Number(m[1])).map(roleWithAssignees)),
);
on("POST", "/api/projects/:id/roles", (m, _u, body) => {
  const r = {
    id: nid(),
    projectId: Number(m[1]),
    name: String(body?.name ?? "New role"),
    dayRate: Number(body?.dayRate ?? 0),
    budgetedDays: (body?.budgetedDays as number) ?? null,
    budgetedHours: (body?.budgetedHours as number) ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.projectRoles.push(r);
  const ids = (body?.assignedEmployeeIds as number[]) ?? [];
  for (const employeeId of ids) db.roleAssignments.push({ roleId: r.id, employeeId });
  return json(roleWithAssignees(r), 201);
});
on("PUT", "/api/project-roles/:id", (m, _u, body) => {
  const r = db.projectRoles.find((r) => r.id === Number(m[1]));
  if (!r) return notFound("Role");
  const { assignedEmployeeIds, ...rest } = (body ?? {}) as Json & { assignedEmployeeIds?: number[] };
  Object.assign(r, rest, { updatedAt: now() });
  if (assignedEmployeeIds) {
    db.roleAssignments = db.roleAssignments.filter((a) => a.roleId !== r.id);
    for (const employeeId of assignedEmployeeIds) db.roleAssignments.push({ roleId: r.id, employeeId });
  }
  return json(roleWithAssignees(r));
});
on("DELETE", "/api/project-roles/:id", (m) => {
  const i = db.projectRoles.findIndex((r) => r.id === Number(m[1]));
  if (i < 0) return notFound("Role");
  db.projectRoles.splice(i, 1);
  return noContent();
});

on("GET", "/api/project-roles/:id/budget-status", (m, url) => {
  const r = db.projectRoles.find((r) => r.id === Number(m[1]));
  if (!r) return notFound("Role");
  const fig = roleBudgetFigures(r);
  const employeeId = url.searchParams.get("employeeId");
  const perEmployee = new Map<number, { days: number; loggedDays: number; invoicedDays: number }>();
  for (const b of db.resourceBookings.filter((b) => b.projectRoleId === r.id && b.status !== "tentative")) {
    const cur = perEmployee.get(b.employeeId) ?? { days: 0, loggedDays: 0, invoicedDays: 0 };
    for (const d of eachDay(b.startDate, b.endDate)) cur.days += bookingHoursOn(b, d) / 8;
    perEmployee.set(b.employeeId, cur);
  }
  for (const e of db.timeEntries.filter((e) => e.projectRoleId === r.id)) {
    const cur = perEmployee.get(e.employeeId) ?? { days: 0, loggedDays: 0, invoicedDays: 0 };
    cur.loggedDays += e.hours / 8;
    if (e.billingStatus === "invoiced") cur.invoicedDays += e.hours / 8;
    perEmployee.set(e.employeeId, cur);
  }
  const empId = employeeId ? Number(employeeId) : null;
  return json({
    ...fig,
    employeeLoggedDays: empId ? round1(perEmployee.get(empId)?.loggedDays ?? 0) : null,
    employeeInvoicedDays: empId ? round1(perEmployee.get(empId)?.invoicedDays ?? 0) : null,
    bookings: [...perEmployee.entries()]
      .map(([employeeId, v]) => ({
        employeeId,
        employeeName: empById(employeeId)?.name ?? "",
        days: round1(v.days),
        loggedDays: round1(v.loggedDays),
        invoicedDays: round1(v.invoicedDays),
      }))
      .sort((a, b) => b.days + b.loggedDays - (a.days + a.loggedDays)),
  });
});

on("GET", "/api/projects/:id/budget", (m) => {
  const roles = db.projectRoles.filter((r) => r.projectId === Number(m[1]));
  const out = roles.map((r) => {
    const fig = roleBudgetFigures(r);
    // "booked" in the budget sheet = delivered/logged work (matches real API)
    const bookedDays = fig.loggedDays;
    const budgetedHours = r.budgetedHours ?? (r.budgetedDays != null ? r.budgetedDays * 8 : null);
    return {
      ...roleWithAssignees(r),
      bookedHours: round1(bookedDays * 8),
      bookedDays,
      plannedHours: round1(fig.plannedDays * 8),
      plannedDays: fig.plannedDays,
      budgetedDays: r.budgetedDays,
      budgetedHours,
      budgetValue: r.budgetedDays != null ? round2(r.budgetedDays * r.dayRate) : null,
      bookedValue: round2(bookedDays * r.dayRate),
      utilization: r.budgetedDays ? round2(bookedDays / r.budgetedDays) : null,
      invoicedDays: fig.invoicedDays,
      reservedDays: fig.reservedDays,
      stalePlanDays: fig.stalePlanDays,
      unplannedDays: fig.unplannedDays,
      freeDays: fig.freeDays,
      remainingBudgetDays: fig.remainingBudgetDays,
      loggedNotInvoicedDays: fig.loggedNotInvoicedDays,
    };
  });
  const sum = (k: keyof (typeof out)[number]) => round1(out.reduce((s, r) => s + ((r[k] as number) ?? 0), 0));
  return json({
    roles: out,
    totals: {
      budgetedDays: sum("budgetedDays"),
      budgetedHours: sum("budgetedHours"),
      budgetValue: round2(out.reduce((s, r) => s + (r.budgetValue ?? 0), 0)),
      bookedHours: sum("bookedHours"),
      bookedValue: round2(out.reduce((s, r) => s + r.bookedValue, 0)),
      invoicedDays: sum("invoicedDays"),
      reservedDays: sum("reservedDays"),
      stalePlanDays: sum("stalePlanDays"),
      unplannedDays: sum("unplannedDays"),
      freeDays: sum("freeDays"),
      remainingBudgetDays: sum("remainingBudgetDays"),
      loggedNotInvoicedDays: sum("loggedNotInvoicedDays"),
    },
  });
});

on("GET", "/api/projects/:id/allocations", (m) => {
  const projectId = Number(m[1]);
  const roles = db.projectRoles.filter((r) => r.projectId === projectId);
  const out = roles.map((r) => {
    const fig = roleBudgetFigures(r);
    const bookedDays = round1(bookedDaysForRole(r.id, { tentative: false }));
    const byEmp = new Map<number, { allocatedDays: number; start: string | null; end: string | null }>();
    for (const b of db.resourceBookings.filter((b) => b.projectRoleId === r.id && b.status !== "tentative")) {
      const cur = byEmp.get(b.employeeId) ?? { allocatedDays: 0, start: null, end: null };
      for (const d of eachDay(b.startDate, b.endDate)) cur.allocatedDays += bookingHoursOn(b, d) / 8;
      cur.start = cur.start == null || b.startDate < cur.start ? b.startDate : cur.start;
      cur.end = cur.end == null || b.endDate > cur.end ? b.endDate : cur.end;
      byEmp.set(b.employeeId, cur);
    }
    return {
      roleId: r.id,
      roleName: r.name,
      dayRate: r.dayRate,
      budgetedDays: r.budgetedDays,
      plannedDays: fig.plannedDays,
      bookedDays,
      invoicedDays: fig.invoicedDays,
      reservedDays: fig.reservedDays,
      stalePlanDays: fig.stalePlanDays,
      unplannedDays: fig.unplannedDays,
      freeDays: fig.freeDays,
      remainingBudgetDays: fig.remainingBudgetDays,
      budgetValue: r.budgetedDays != null ? round2(r.budgetedDays * r.dayRate) : null,
      bookedValue: round2(bookedDays * r.dayRate),
      allocations: [...byEmp.entries()]
        .map(([employeeId, v]) => ({
          employeeId,
          employeeName: empById(employeeId)?.name ?? "",
          allocatedDays: round1(v.allocatedDays),
          period: v.start && v.end ? { start: v.start, end: v.end } : null,
          bookedDays: round1(v.allocatedDays),
          percentage: bookedDays ? Math.round((v.allocatedDays / bookedDays) * 100) : 0,
        }))
        .sort((a, b) => b.allocatedDays - a.allocatedDays),
    };
  });
  const sum = (f: (r: (typeof out)[number]) => number | null) => round1(out.reduce((s, r) => s + (f(r) ?? 0), 0));
  return json({
    projectId,
    roles: out,
    totals: {
      budgetedDays: sum((r) => r.budgetedDays),
      plannedDays: sum((r) => r.plannedDays),
      bookedDays: sum((r) => r.bookedDays),
      invoicedDays: sum((r) => r.invoicedDays),
      reservedDays: sum((r) => r.reservedDays),
      unplannedDays: sum((r) => r.unplannedDays),
      freeDays: sum((r) => r.freeDays),
      remainingBudgetDays: sum((r) => r.remainingBudgetDays),
      budgetValue: sum((r) => r.budgetValue),
      bookedValue: sum((r) => r.bookedValue),
    },
  });
});

/* ────────────────────────── resource bookings ───────────────────────────── */

on("GET", "/api/resource-bookings", (_m, url) => {
  const employeeId = url.searchParams.get("employeeId");
  const start = url.searchParams.get("startDate");
  const end = url.searchParams.get("endDate");
  let list = db.resourceBookings.slice();
  if (employeeId && !Number.isNaN(Number(employeeId))) list = list.filter((b) => b.employeeId === Number(employeeId));
  if (start) list = list.filter((b) => b.endDate >= start);
  if (end) list = list.filter((b) => b.startDate <= end);
  list.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return json(list.map(enrichBooking));
});
on("POST", "/api/resource-bookings", (_m, _u, body) => {
  if (!body) return json({ error: "Invalid request body" }, 400);
  if (body.hoursPerDay == null && body.weekdayHours == null)
    return json({ error: "Either hoursPerDay or weekdayHours must be provided" }, 400);
  const wh = (body.weekdayHours as Record<string, number> | null) ?? null;
  const b = {
    id: nid(),
    employeeId: Number(body.employeeId),
    projectId: Number(body.projectId),
    projectRoleId: body.projectRoleId != null ? Number(body.projectRoleId) : null,
    startDate: String(body.startDate),
    endDate: String(body.endDate),
    hoursPerDay: wh ? Object.values(wh).reduce((s, v) => s + v, 0) / 5 : Number(body.hoursPerDay ?? 8),
    weekdayHours: wh,
    notes: (body.notes as string) ?? null,
    status: (body.status as string) ?? "confirmed",
    pastReleasedAt: null as string | null,
    createdAt: now(),
    updatedAt: now(),
  };
  if (b.startDate > b.endDate) return json({ error: "startDate must be before endDate" }, 400);
  db.resourceBookings.push(b as (typeof db.resourceBookings)[number]);
  return json(enrichBooking(b as (typeof db.resourceBookings)[number]), 201);
});
on("PUT", "/api/resource-bookings/:id", (m, _u, body) => {
  const b = db.resourceBookings.find((b) => b.id === Number(m[1]));
  if (!b) return notFound("Booking");
  const wh = (body?.weekdayHours as Record<string, number> | null) ?? null;
  Object.assign(b, body ?? {}, {
    hoursPerDay: wh ? Object.values(wh).reduce((s, v) => s + v, 0) / 5 : Number(body?.hoursPerDay ?? b.hoursPerDay),
    weekdayHours: wh,
    updatedAt: now(),
  });
  return json(enrichBooking(b));
});
on("DELETE", "/api/resource-bookings/:id", (m) => {
  const i = db.resourceBookings.findIndex((b) => b.id === Number(m[1]));
  if (i < 0) return notFound("Booking");
  db.resourceBookings.splice(i, 1);
  return json({ success: true });
});
on("POST", "/api/resource-bookings/:id/release-past", (m) => {
  const b = db.resourceBookings.find((b) => b.id === Number(m[1]));
  if (!b) return notFound("Booking");
  b.pastReleasedAt = now();
  return json(enrichBooking(b));
});
on("POST", "/api/resource-bookings/:id/unrelease", (m) => {
  const b = db.resourceBookings.find((b) => b.id === Number(m[1]));
  if (!b) return notFound("Booking");
  b.pastReleasedAt = null;
  return json(enrichBooking(b));
});
on("GET", "/api/resource-bookings/:id/past-undelivered", (m) => {
  const b = db.resourceBookings.find((b) => b.id === Number(m[1]));
  if (!b) return notFound("Booking");
  let days = 0;
  const today = todayStr();
  // release-date cutoff (edge-case-4 fix): only days before the release date
  // stay written off; later misses count as undelivered again
  const releasedUpTo = b.pastReleasedAt ? b.pastReleasedAt.slice(0, 10) : null;
  if (b.status !== "tentative") {
    for (const d of eachDay(b.startDate, b.endDate)) {
      if (d >= today) break;
      if (releasedUpTo && d < releasedUpTo) continue;
      const planned = bookingHoursOn(b, d);
      const logged = db.timeEntries
        .filter((e) => e.employeeId === b.employeeId && e.projectId === b.projectId && e.entryDate === d)
        .reduce((s, e) => s + e.hours, 0);
      if (planned > logged) days += (planned - logged) / 8;
    }
  }
  return json({ pastUndeliveredDays: round1(days) });
});
on("POST", "/api/resource-bookings/release-past-bulk", (_m, _u, body) => {
  const today = todayStr();
  const dryRun = body?.dryRun === true;
  const released = db.resourceBookings
    .filter(
      (b) =>
        !b.pastReleasedAt &&
        b.startDate < today &&
        (!body?.projectId || b.projectId === Number(body.projectId)) &&
        (!body?.employeeId || b.employeeId === Number(body.employeeId)),
    )
    .map((b) => {
      if (!dryRun) b.pastReleasedAt = now();
      return {
        id: b.id,
        employeeId: b.employeeId,
        employeeName: empById(b.employeeId)?.name ?? "",
        projectId: b.projectId,
        projectName: projById(b.projectId)?.name ?? "",
        projectRoleId: b.projectRoleId,
        projectRoleName: roleById(b.projectRoleId)?.name ?? null,
        startDate: b.startDate,
        endDate: b.endDate,
        pastReleasedAt: dryRun ? null : b.pastReleasedAt,
        pastUndeliveredDays: 0,
      };
    });
  return json({ released });
});

/* ────────────────────────────── vacations ───────────────────────────────── */

on("GET", "/api/vacations", (_m, url) => {
  const employeeId = url.searchParams.get("employeeId");
  let list = db.vacations.slice();
  if (employeeId && !Number.isNaN(Number(employeeId))) list = list.filter((v) => v.employeeId === Number(employeeId));
  list.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return json(list);
});
on("POST", "/api/vacations", (_m, _u, body) => {
  if (!body || !empById(Number(body.employeeId))) return notFound("Employee");
  const v = {
    id: nid(),
    employeeId: Number(body.employeeId),
    startDate: String(body.startDate),
    endDate: String(body.endDate),
    vacationType: ["vacation", "sick", "unpaid_leave", "other"].includes(String(body.vacationType))
      ? String(body.vacationType)
      : "vacation",
    note: (body.note as string) ?? null,
    createdAt: now(),
  };
  db.vacations.push(v);
  return json(v, 201);
});
on("PATCH", "/api/vacations/:id", (m, _u, body) => {
  const v = db.vacations.find((v) => v.id === Number(m[1]));
  if (!v) return notFound("Vacation");
  Object.assign(v, body ?? {});
  return json(v);
});
on("DELETE", "/api/vacations/:id", (m) => {
  const i = db.vacations.findIndex((v) => v.id === Number(m[1]));
  if (i < 0) return notFound("Vacation");
  db.vacations.splice(i, 1);
  return noContent();
});

/* ────────────────────────────── holidays ────────────────────────────────── */

on("GET", "/api/holiday-calendars", () => json(db.holidayCalendars));
on("POST", "/api/holiday-calendars", (_m, _u, body) => {
  const c = { id: nid(), code: String(body?.code ?? "XX"), name: String(body?.name ?? "Calendar"), createdAt: now() };
  db.holidayCalendars.push(c);
  return json(c, 201);
});
on("GET", "/api/holiday-calendars/:id/holidays", (m, url) => {
  const year = url.searchParams.get("year");
  let list = db.holidays.filter((h) => h.calendarId === Number(m[1]));
  if (year) list = list.filter((h) => h.date.startsWith(year));
  return json(list.slice().sort((a, b) => a.date.localeCompare(b.date)));
});
on("POST", "/api/holiday-calendars/:id/holidays", (m, _u, body) => {
  const h = {
    id: nid(),
    calendarId: Number(m[1]),
    date: String(body?.date ?? todayStr()).slice(0, 10),
    name: String(body?.name ?? "Holiday"),
  };
  db.holidays.push(h);
  holidayDates.add(h.date);
  return json(h, 201);
});
on("DELETE", "/api/holidays/:id", (m) => {
  const i = db.holidays.findIndex((h) => h.id === Number(m[1]));
  if (i < 0) return notFound("Holiday");
  db.holidays.splice(i, 1);
  return noContent();
});

/* ───────────────────────────── time entries ─────────────────────────────── */

on("GET", "/api/time-entries", (_m, url) => {
  const q = url.searchParams;
  let list = db.timeEntries.slice();
  if (q.get("employeeId")) list = list.filter((e) => e.employeeId === Number(q.get("employeeId")));
  if (q.get("projectId")) list = list.filter((e) => e.projectId === Number(q.get("projectId")));
  const s = q.get("startDate");
  const en = q.get("endDate");
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) list = list.filter((e) => e.entryDate >= s);
  if (en && /^\d{4}-\d{2}-\d{2}$/.test(en)) list = list.filter((e) => e.entryDate <= en);
  list.sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  return json(list.map(enrichEntry));
});
on("POST", "/api/time-entries", (_m, _u, body) => {
  const hours = Number(body?.hours ?? 0);
  if (hours < 0 || hours > 24) return json({ error: "Invalid hours" }, 400);
  const e: TimeEntry = {
    id: nid(),
    employeeId: Number(body?.employeeId),
    projectId: Number(body?.projectId),
    projectRoleId: body?.projectRoleId != null ? Number(body.projectRoleId) : null,
    entryDate: String(body?.entryDate ?? todayStr()),
    hours,
    note: (body?.note as string) ?? null,
    invoicedAt: null,
    invoiceReference: null,
    billingStatus: null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.timeEntries.push(e);
  return json(enrichEntry(e), 201);
});
on("POST", "/api/time-entries/bulk", (_m, _u, body) => {
  const entries = (body?.entries as Json[]) ?? [];
  const result: TimeEntry[] = [];
  for (const item of entries) {
    const employeeId = Number(item.employeeId);
    const entryDate = String(item.entryDate);
    const hours = Number(item.hours ?? 0);
    const existing = db.timeEntries.find(
      (e) =>
        e.employeeId === employeeId &&
        e.projectId === Number(item.projectId) &&
        (e.projectRoleId ?? null) === (item.projectRoleId != null ? Number(item.projectRoleId) : null) &&
        e.entryDate === entryDate,
    );
    if (hours === 0) {
      if (existing) db.timeEntries.splice(db.timeEntries.indexOf(existing), 1);
      continue;
    }
    if (existing) {
      existing.hours = hours;
      existing.note = (item.note as string) ?? existing.note;
      existing.updatedAt = now();
      result.push(existing);
    } else {
      const e: TimeEntry = {
        id: nid(),
        employeeId,
        projectId: Number(item.projectId),
        projectRoleId: item.projectRoleId != null ? Number(item.projectRoleId) : null,
        entryDate,
        hours,
        note: (item.note as string) ?? null,
        invoicedAt: null,
        invoiceReference: null,
        billingStatus: null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.timeEntries.push(e);
      result.push(e);
    }
  }
  return json(result.map(enrichEntry));
});
on("GET", "/api/time-entries/:id", (m) => {
  const e = db.timeEntries.find((e) => e.id === Number(m[1]));
  return e ? json(enrichEntry(e)) : notFound("Time entry");
});
on("PATCH", "/api/time-entries/:id", (m, _u, body) => {
  const e = db.timeEntries.find((e) => e.id === Number(m[1]));
  if (!e) return notFound("Time entry");
  Object.assign(e, body ?? {}, { updatedAt: now() });
  return json(enrichEntry(e));
});
on("DELETE", "/api/time-entries/:id", (m) => {
  const i = db.timeEntries.findIndex((e) => e.id === Number(m[1]));
  if (i < 0) return notFound("Time entry");
  db.timeEntries.splice(i, 1);
  return noContent();
});

/* ──────────────────────────── dashboard ─────────────────────────────────── */

on("GET", "/api/dashboard/summary", () => {
  const weekStart = mondayOf(todayStr());
  const weekEnd = addDays(weekStart, 6);
  const summaries = db.employees
    .filter((e) => e.active)
    .map((emp) => {
      let available = 0;
      for (const d of eachDay(weekStart, weekEnd)) {
        if (isWorkingDay(emp.id, d) && !onVacation(emp.id, d)) available += emp.weeklyCapacityHours / 5;
      }
      let booked = 0;
      let billable = 0;
      for (const b of db.resourceBookings.filter((b) => b.employeeId === emp.id && b.status !== "tentative")) {
        for (const d of eachDay(weekStart, weekEnd)) {
          const h = bookingHoursOn(b, d);
          booked += h;
          if (projById(b.projectId)?.isBillable) billable += h;
        }
      }
      return {
        employeeId: emp.id,
        employeeName: emp.name,
        availableHours: round2(available),
        bookedHours: round2(booked),
        billableHours: round2(billable),
        utilization: available ? round1((booked / available) * 100) : 0,
      };
    });
  return json({
    weekStartDate: weekStart,
    weekEndDate: weekEnd,
    totalBookedHours: round2(summaries.reduce((s, e) => s + e.bookedHours, 0)),
    billableBookedHours: round2(summaries.reduce((s, e) => s + e.billableHours, 0)),
    employeeSummaries: summaries,
  });
});

/* ─────────────────────────── project status ─────────────────────────────── */

function projectBudgetTotals(projectId: number) {
  const roles = db.projectRoles.filter((r) => r.projectId === projectId);
  const budgetTotal = roles.reduce((s, r) => s + (r.budgetedDays ?? 0) * r.dayRate, 0) || null;
  let logged = 0;
  let invoiced = 0;
  for (const e of db.timeEntries.filter((e) => e.projectId === projectId)) {
    const rate = roleById(e.projectRoleId)?.dayRate ?? 0;
    logged += (e.hours / 8) * rate;
    if (e.billingStatus === "invoiced") invoiced += (e.hours / 8) * rate;
  }
  return { budgetTotal, logged: round2(logged), invoiced: round2(invoiced) };
}

function trendFor(projectId: number): "up" | "down" | "stable" | null {
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const hist = db.healthUpdates
    .filter((h) => h.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (hist.length < 2) return null;
  const [a, b] = [rank[hist[0].riskLevel] ?? 0, rank[hist[1].riskLevel] ?? 0];
  return a > b ? "down" : a < b ? "up" : "stable";
}

on("GET", "/api/project-status", () => {
  const out = db.projects
    .filter((p) => p.active)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const { budgetTotal, logged } = projectBudgetTotals(p.id);
      const latest = db.healthUpdates
        .filter((h) => h.projectId === p.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const age = latest ? Math.floor((Date.now() - new Date(latest.createdAt).getTime()) / DAY) : null;
      const pct = budgetTotal ? logged / budgetTotal : null;
      const budgetAlert = pct != null && pct >= 0.9;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        clientName: clientById(p.clientId)?.name ?? null,
        pmName: p.pmName,
        generalStatus: p.generalStatus,
        riskLevel: p.riskLevel,
        clientSatisfaction: p.clientSatisfaction,
        latestUpdateAt: latest ? latest.createdAt.replace(/\.\d{3}Z$/, "Z") : null,
        latestComment: latest?.comment ?? null,
        budgetTotal,
        budgetConsumed: budgetTotal != null ? logged : null,
        budgetProgress: pct != null ? round1(pct * 100) : null,
        trendDirection: trendFor(p.id),
        updateOverdue: age == null || age >= 14,
        lastUpdateAge: age,
        budgetAlert,
        needsAttention: p.riskLevel === "high" || budgetAlert,
      };
    });
  return json(out);
});

on("GET", "/api/project-status/:id", (m) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const { budgetTotal, logged, invoiced } = projectBudgetTotals(p.id);
  const history = db.healthUpdates
    .filter((h) => h.projectId === p.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = history[0];
  const age = latest ? Math.floor((Date.now() - new Date(latest.createdAt).getTime()) / DAY) : null;
  const pct = budgetTotal ? logged / budgetTotal : null;
  const months = new Map<string, { loggedRevenue: number; invoicedRevenue: number }>();
  for (const e of db.timeEntries.filter((e) => e.projectId === p.id)) {
    const rate = roleById(e.projectRoleId)?.dayRate ?? 0;
    const mo = monthOf(e.entryDate);
    const cur = months.get(mo) ?? { loggedRevenue: 0, invoicedRevenue: 0 };
    cur.loggedRevenue += (e.hours / 8) * rate;
    if (e.billingStatus === "invoiced") cur.invoicedRevenue += (e.hours / 8) * rate;
    months.set(mo, cur);
  }
  const today = todayStr();
  return json({
    project: {
      id: p.id,
      name: p.name,
      color: p.color,
      clientId: p.clientId,
      clientName: clientById(p.clientId)?.name ?? null,
      pmName: p.pmName,
      startDate: p.startDate,
      endDate: p.endDate,
      generalStatus: p.generalStatus,
      riskLevel: p.riskLevel,
      clientSatisfaction: p.clientSatisfaction,
      nextSteps: p.nextSteps ?? null,
      budgetTotal,
      loggedTotal: logged,
      invoicedTotal: invoiced,
      trendDirection: trendFor(p.id),
      nextUpdateDue: latest ? addDays(latest.createdAt.slice(0, 10), 14) : null,
      updateOverdue: age == null || age >= 14,
      lastUpdateAge: age,
      lastCommentAt: history.find((h) => h.comment)?.createdAt ?? null,
      budgetAlert: pct != null && pct >= 0.9,
      budgetProgress: pct != null ? round1(pct * 100) : null,
    },
    history,
    monthlyData: [...months.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, loggedRevenue: round2(v.loggedRevenue), invoicedRevenue: round2(v.invoicedRevenue) })),
    futureBookings: db.resourceBookings
      .filter((b) => b.projectId === p.id && b.endDate >= today)
      .map((b) => ({
        id: b.id,
        employeeId: b.employeeId,
        employeeName: empById(b.employeeId)?.name ?? "",
        startDate: b.startDate,
        endDate: b.endDate,
        hoursPerDay: b.hoursPerDay,
        weekdayHours: b.weekdayHours ?? null,
        projectRoleId: b.projectRoleId,
        roleName: roleById(b.projectRoleId)?.name ?? null,
        dayRate: roleById(b.projectRoleId)?.dayRate ?? null,
      })),
    updateCadenceDays: 14,
    budgetAlertThreshold: 0.9,
  });
});

on("POST", "/api/project-status/:id/health-updates", (m, _u, body) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const h = {
    id: nid(),
    projectId: p.id,
    generalStatus: String(body?.generalStatus ?? "in_progress"),
    budgetStatus: (body?.budgetStatus as string) ?? null,
    riskLevel: String(body?.riskLevel ?? "low"),
    clientSatisfaction: (body?.clientSatisfaction as string) ?? null,
    comment: (body?.comment as string) ?? null,
    createdAt: now(),
  };
  db.healthUpdates.push(h);
  Object.assign(p, {
    generalStatus: h.generalStatus,
    budgetStatus: h.budgetStatus,
    riskLevel: h.riskLevel,
    clientSatisfaction: h.clientSatisfaction,
  });
  return json(h, 201);
});
on("PATCH", "/api/project-status/:id/next-steps", (m, _u, body) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  p.nextSteps = (body?.nextSteps as Project["nextSteps"]) ?? [];
  return json({ ok: true });
});

/* ─────────────────────────────── billing ────────────────────────────────── */

interface BillingBucket {
  hours: number;
  invoicedHours: number;
  investHours: number;
}

function billingEntries(projectId: number | null, start: string | null, end: string | null) {
  return db.timeEntries.filter(
    (e) =>
      (projectId == null || e.projectId === projectId) &&
      (!start || e.entryDate >= start) &&
      (!end || e.entryDate <= end),
  );
}

function bucketBy<K>(entries: TimeEntry[], key: (e: TimeEntry) => K): Map<K, BillingBucket> {
  const map = new Map<K, BillingBucket>();
  for (const e of entries) {
    const k = key(e);
    const cur = map.get(k) ?? { hours: 0, invoicedHours: 0, investHours: 0 };
    cur.hours += e.hours;
    if (e.billingStatus === "invoiced" || (e.billingStatus == null && e.invoicedAt != null)) cur.invoicedHours += e.hours;
    if (e.billingStatus === "invest") cur.investHours += e.hours;
    map.set(k, cur);
  }
  return map;
}

const money = (hours: number, rate: number) => round2((hours / 8) * rate);

on("GET", "/api/billing", (_m, url) => {
  const start = url.searchParams.get("startDate");
  const end = url.searchParams.get("endDate");
  const zero = () => ({ budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 });
  const add = (t: ReturnType<typeof zero>, o: ReturnType<typeof zero>) => {
    t.budget += o.budget; t.logged += o.logged; t.invoiced += o.invoiced;
    t.invest += o.invest; t.unbilled += o.unbilled; t.remaining += o.remaining;
  };
  const grand = zero();
  const clients = db.clients
    .filter((c) => c.active)
    .map((c) => {
      const cTotals = zero();
      const projects = db.projects
        .filter((p) => p.clientId === c.id && p.active)
        .map((p) => {
          const pTotals = zero();
          const roles = db.projectRoles
            .filter((r) => r.projectId === p.id)
            .map((r) => {
              const entries = billingEntries(p.id, start, end).filter((e) => e.projectRoleId === r.id);
              const byEmp = bucketBy(entries, (e) => e.employeeId);
              const tot = { hours: 0, invoicedHours: 0, investHours: 0 };
              for (const v of byEmp.values()) {
                tot.hours += v.hours; tot.invoicedHours += v.invoicedHours; tot.investHours += v.investHours;
              }
              const budget = r.budgetedDays != null ? round2(r.budgetedDays * r.dayRate) : null;
              const logged = money(tot.hours, r.dayRate);
              const invoiced = money(tot.invoicedHours, r.dayRate);
              const invest = money(tot.investHours, r.dayRate);
              const unbilled = round2(logged - invoiced - invest);
              const roleOut = {
                id: r.id,
                name: r.name,
                dayrate: r.dayRate,
                budgetedDays: r.budgetedDays,
                budget,
                loggedDays: round1(tot.hours / 8),
                loggedHours: round2(tot.hours),
                logged,
                invoiced,
                invest,
                unbilled,
                remaining: budget != null ? round2(budget - logged) : null,
                employees: [...byEmp.entries()]
                  .map(([id, v]) => ({
                    id,
                    name: empById(id)?.name ?? "",
                    hours: round2(v.hours),
                    days: round1(v.hours / 8),
                    revenue: money(v.hours, r.dayRate),
                    invoiced: money(v.invoicedHours, r.dayRate),
                    invest: money(v.investHours, r.dayRate),
                    unbilled: round2(money(v.hours, r.dayRate) - money(v.invoicedHours, r.dayRate) - money(v.investHours, r.dayRate)),
                    billingStatus:
                      v.invoicedHours >= v.hours && v.hours > 0 ? "invoiced" : v.investHours > 0 ? "invest" : null,
                  }))
                  .sort((a, b) => b.revenue - a.revenue),
              };
              add(pTotals, { budget: budget ?? 0, logged, invoiced, invest, unbilled, remaining: roleOut.remaining ?? 0 });
              return roleOut;
            });
          add(cTotals, pTotals);
          return { id: p.id, name: p.name, totals: pTotals, roles };
        });
      add(grand, cTotals);
      return { id: c.id, name: c.name, totals: cTotals, projects };
    })
    .filter((c) => c.projects.length > 0);
  return json({ totals: grand, clients });
});

on("GET", "/api/projects/:id/billing", (m, url) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const start = url.searchParams.get("startDate");
  const end = url.searchParams.get("endDate");
  const totals = { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 };
  const roles = db.projectRoles
    .filter((r) => r.projectId === p.id)
    .map((r) => {
      const entries = billingEntries(p.id, start, end).filter((e) => e.projectRoleId === r.id);
      const byEmp = bucketBy(entries, (e) => e.employeeId);
      const tot = { hours: 0, invoicedHours: 0, investHours: 0 };
      for (const v of byEmp.values()) {
        tot.hours += v.hours; tot.invoicedHours += v.invoicedHours; tot.investHours += v.investHours;
      }
      const budget = r.budgetedDays != null ? round2(r.budgetedDays * r.dayRate) : null;
      const logged = money(tot.hours, r.dayRate);
      const invoiced = money(tot.invoicedHours, r.dayRate);
      const invest = money(tot.investHours, r.dayRate);
      const unbilled = round2(logged - invoiced - invest);
      totals.budget += budget ?? 0;
      totals.logged += logged;
      totals.invoiced += invoiced;
      totals.invest += invest;
      totals.unbilled += unbilled;
      totals.remaining += budget != null ? budget - logged : 0;
      return {
        id: r.id,
        name: r.name,
        dayrate: r.dayRate,
        budgetedDays: r.budgetedDays,
        budget,
        loggedHours: round2(tot.hours),
        logged,
        invoicedHours: round2(tot.invoicedHours),
        invoiced,
        investHours: round2(tot.investHours),
        invest,
        unbilled,
        remaining: budget != null ? round2(budget - logged) : null,
        employees: [...byEmp.entries()]
          .map(([id, v]) => ({
            id,
            name: empById(id)?.name ?? "",
            loggedHours: round2(v.hours),
            logged: money(v.hours, r.dayRate),
            invoicedHours: round2(v.invoicedHours),
            invoiced: money(v.invoicedHours, r.dayRate),
            investHours: round2(v.investHours),
            invest: money(v.investHours, r.dayRate),
            unbilled: round2(money(v.hours, r.dayRate) - money(v.invoicedHours, r.dayRate) - money(v.investHours, r.dayRate)),
            billingStatus:
              v.invoicedHours >= v.hours && v.hours > 0 ? "invoiced" : v.investHours > 0 ? "invest" : null,
          }))
          .sort((a, b) => b.logged - a.logged),
      };
    });
  for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] = round2(totals[k]);
  return json({ project: { id: p.id, name: p.name }, totals, roles });
});

on("GET", "/api/projects/:id/billing/history", (m) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const history = db.invoices
    .filter((i) => i.projectId === p.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((i) => ({
      reference: i.reference,
      invoicedAt: i.createdAt,
      totalAmount: i.totalAmount,
      roleCount: i.roleIds.length,
      employeeCount: i.employeeIds.length,
      roles: i.roleIds.map((id) => ({ id, name: roleById(id)?.name ?? "" })),
      employees: i.employeeIds.map((id) => ({ id, name: empById(id)?.name ?? "" })),
    }));
  return json({ project: { id: p.id, name: p.name }, history });
});

on("GET", "/api/projects/:id/billing/lifetime", (m) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const roles = db.projectRoles.filter((r) => r.projectId === p.id);
  const budget = round2(roles.reduce((s, r) => s + (r.budgetedDays ?? 0) * r.dayRate, 0));
  const entries = db.timeEntries.filter((e) => e.projectId === p.id).sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  if (!entries.length) return json({ project: { id: p.id, name: p.name }, budget, totalLogged: 0, totalInvoiced: 0, remaining: budget, monthlyData: [] });
  const firstMonth = monthOf(entries[0].entryDate);
  const curMonth = monthOf(todayStr());
  const perMonth = new Map<string, { logged: number; invoiced: number }>();
  for (const e of entries) {
    const rate = roleById(e.projectRoleId)?.dayRate ?? 0;
    const mo = monthOf(e.entryDate);
    const cur = perMonth.get(mo) ?? { logged: 0, invoiced: 0 };
    cur.logged += (e.hours / 8) * rate;
    if (e.billingStatus === "invoiced") cur.invoiced += (e.hours / 8) * rate;
    perMonth.set(mo, cur);
  }
  const monthlyData: Array<{ month: string; loggedCumulative: number; invoicedCumulative: number }> = [];
  let cl = 0;
  let ci = 0;
  let mo = firstMonth;
  while (mo <= curMonth) {
    const v = perMonth.get(mo);
    cl += v?.logged ?? 0;
    ci += v?.invoiced ?? 0;
    monthlyData.push({ month: mo, loggedCumulative: round2(cl), invoicedCumulative: round2(ci) });
    const [y, mm] = mo.split("-").map(Number);
    mo = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
  }
  return json({
    project: { id: p.id, name: p.name },
    budget,
    totalLogged: round2(cl),
    totalInvoiced: round2(ci),
    remaining: round2(budget - cl),
    monthlyData,
  });
});

on("GET", "/api/projects/:id/invoices", (m) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  return json({
    project: { id: p.id, name: p.name },
    invoices: db.invoices
      .filter((i) => i.projectId === p.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((i) => ({
        id: i.id,
        createdAt: i.createdAt,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        totalAmount: i.totalAmount,
        reference: i.reference,
        roleCount: i.roleIds.length,
        employeeCount: i.employeeIds.length,
        roles: i.roleIds.map((id) => ({ id, name: roleById(id)?.name ?? "" })),
        employees: i.employeeIds.map((id) => ({ id, name: empById(id)?.name ?? "" })),
      })),
  });
});

on("POST", "/api/projects/:id/invoices", (m, _u, body) => {
  const p = projById(Number(m[1]));
  if (!p) return notFound("Project");
  const items = (body?.items as Array<{ roleId: number; employeeId: number }>) ?? [];
  const periodStart = String(body?.periodStart ?? todayStr());
  const periodEnd = String(body?.periodEnd ?? todayStr());
  let total = 0;
  let updated = 0;
  for (const e of db.timeEntries) {
    if (e.projectId !== p.id || e.entryDate < periodStart || e.entryDate > periodEnd) continue;
    if (!items.some((it) => it.roleId === (e.projectRoleId ?? -1) && (it.employeeId == null || it.employeeId === e.employeeId))) continue;
    if (e.billingStatus === "invoiced") continue;
    e.billingStatus = "invoiced";
    e.invoicedAt = now();
    e.invoiceReference = (body?.reference as string) ?? null;
    total += (e.hours / 8) * (roleById(e.projectRoleId)?.dayRate ?? 0);
    updated++;
  }
  const inv = {
    id: nid(),
    projectId: p.id,
    createdAt: now(),
    periodStart,
    periodEnd,
    totalAmount: round2(total),
    reference: (body?.reference as string) ?? null,
    roleIds: [...new Set(items.map((i) => i.roleId))],
    employeeIds: [...new Set(items.map((i) => i.employeeId).filter((x) => x != null))],
  };
  db.invoices.push(inv);
  return json({ invoiceId: inv.id, updatedCount: updated, totalAmount: inv.totalAmount });
});

on("POST", "/api/time-entries/update-billing-status", (_m, _u, body) => {
  const projectId = Number(body?.projectId);
  const items = (body?.items as Array<{ roleId: number; employeeId?: number }>) ?? [];
  const start = (body?.startDate as string) ?? null;
  const end = (body?.endDate as string) ?? null;
  const status = (body?.status as string | null) ?? null;
  let updated = 0;
  for (const e of db.timeEntries) {
    if (e.projectId !== projectId) continue;
    if (start && e.entryDate < start) continue;
    if (end && e.entryDate > end) continue;
    if (!items.some((it) => it.roleId === (e.projectRoleId ?? -1) && (it.employeeId == null || it.employeeId === e.employeeId))) continue;
    e.billingStatus = status;
    if (status === "invoiced") {
      e.invoicedAt = now();
      e.invoiceReference = (body?.invoiceReference as string) ?? e.invoiceReference;
    }
    e.updatedAt = now();
    updated++;
  }
  return json({ updatedCount: updated });
});

on("POST", "/api/time-entries/mark-invoiced", (_m, _u, body) => {
  const projectId = Number(body?.projectId);
  let updated = 0;
  for (const e of db.timeEntries) {
    if (e.projectId !== projectId || e.billingStatus === "invoiced") continue;
    e.billingStatus = "invoiced";
    e.invoicedAt = now();
    e.invoiceReference = (body?.invoiceReference as string) ?? null;
    updated++;
  }
  return json({ updatedCount: updated });
});

/* ─────────────────────────────── reports ────────────────────────────────── */

function requireDates(url: URL): [string, string] | Response {
  const s = url.searchParams.get("startDate");
  const e = url.searchParams.get("endDate");
  if (!s || !e) return json({ error: "startDate and endDate (YYYY-MM-DD) are required" }, 400);
  return [s, e];
}

on("GET", "/api/reports/utilization", (_m, url) => {
  const dates = requireDates(url);
  if (dates instanceof Response) return dates;
  const [start, end] = dates;
  const empFilter = url.searchParams.get("employeeId");
  const out = db.employees
    .filter((e) => e.active && (!empFilter || e.id === Number(empFilter)))
    .map((emp) => {
      let available = 0;
      for (const d of eachDay(start, end)) if (isWorkingDay(emp.id, d) && !onVacation(emp.id, d)) available += emp.weeklyCapacityHours / 5;
      let billable = 0;
      let nonBillable = 0;
      for (const b of db.resourceBookings.filter((b) => b.employeeId === emp.id && b.status !== "tentative")) {
        for (const d of eachDay(start > b.startDate ? start : b.startDate, end < b.endDate ? end : b.endDate)) {
          const h = bookingHoursOn(b, d);
          if (projById(b.projectId)?.isBillable) billable += h;
          else nonBillable += h;
        }
      }
      const total = billable + nonBillable;
      return {
        employeeId: emp.id,
        employeeName: emp.name,
        availableHours: round2(available),
        billableHours: round2(billable),
        nonBillableHours: round2(nonBillable),
        totalBookedHours: round2(total),
        billableUtilization: available ? round1((billable / available) * 100) : 0,
        overallUtilization: available ? round1((total / available) * 100) : 0,
      };
    });
  return json(out);
});

on("GET", "/api/reports/projects", (_m, url) => {
  const dates = requireDates(url);
  if (dates instanceof Response) return dates;
  const [start, end] = dates;
  const byProj = bucketBy(billingEntries(null, start, end), (e) => e.projectId);
  return json(
    [...byProj.entries()].map(([projectId, v]) => {
      const p = projById(projectId);
      return {
        projectId,
        projectName: p?.name ?? "",
        clientName: (p && clientById(p.clientId)?.name) || "",
        isBillable: p?.isBillable ?? false,
        totalHours: round2(v.hours),
        billableHours: p?.isBillable ? round2(v.hours) : 0,
        nonBillableHours: p?.isBillable ? 0 : round2(v.hours),
      };
    }),
  );
});

on("GET", "/api/reports/clients", (_m, url) => {
  const dates = requireDates(url);
  if (dates instanceof Response) return dates;
  const [start, end] = dates;
  const byClient = bucketBy(billingEntries(null, start, end), (e) => projById(e.projectId)?.clientId ?? 0);
  return json(
    [...byClient.entries()].map(([clientId, v]) => {
      const billable = db.timeEntries
        .filter((e) => projById(e.projectId)?.clientId === clientId && e.entryDate >= start && e.entryDate <= end && projById(e.projectId)?.isBillable)
        .reduce((s, e) => s + e.hours, 0);
      return {
        clientId,
        clientName: clientById(clientId)?.name ?? "",
        totalHours: round2(v.hours),
        billableHours: round2(billable),
        nonBillableHours: round2(v.hours - billable),
      };
    }),
  );
});

/* ── pivot (Reports drill-down) ── */

interface Fact {
  employeeId: number;
  projectId: number;
  clientId: number;
  roleId: number | null;
  date: string;
  booked: number;
  billableBooked: number;
  planned: number;
}

function buildFacts(start: string, end: string): Fact[] {
  const facts: Fact[] = [];
  for (const e of db.timeEntries) {
    if (e.entryDate < start || e.entryDate > end) continue;
    const p = projById(e.projectId);
    facts.push({
      employeeId: e.employeeId,
      projectId: e.projectId,
      clientId: p?.clientId ?? 0,
      roleId: e.projectRoleId,
      date: e.entryDate,
      booked: e.hours,
      billableBooked: p?.isBillable ? e.hours : 0,
      planned: 0,
    });
  }
  for (const b of db.resourceBookings.filter((b) => b.status !== "tentative")) {
    const p = projById(b.projectId);
    for (const d of eachDay(start > b.startDate ? start : b.startDate, end < b.endDate ? end : b.endDate)) {
      const h = bookingHoursOn(b, d);
      if (h > 0)
        facts.push({
          employeeId: b.employeeId,
          projectId: b.projectId,
          clientId: p?.clientId ?? 0,
          roleId: b.projectRoleId,
          date: d,
          booked: 0,
          billableBooked: 0,
          planned: h,
        });
    }
  }
  return facts;
}

function bucketKey(date: string, col: string): string {
  if (col === "month") return monthOf(date);
  if (col === "quarter") {
    const [y, m] = date.split("-").map(Number);
    return `${y}-Q${Math.ceil(m / 3)}`;
  }
  if (col === "week") {
    const monday = mondayOf(date);
    const jan4 = `${monday.slice(0, 4)}-01-04`;
    const week = Math.floor((parse(monday).getTime() - parse(mondayOf(jan4)).getTime()) / (7 * DAY)) + 1;
    return `${monday.slice(0, 4)}-W${String(week).padStart(2, "0")}`;
  }
  return "Total";
}

on("GET", "/api/reports/pivot", (_m, url) => {
  const dates = requireDates(url);
  if (dates instanceof Response) return dates;
  const [start, end] = dates;
  const rowDim = url.searchParams.get("rowDimension") ?? "employees";
  const colDim = url.searchParams.get("colDimension") ?? "none";
  const rawMetrics = url.searchParams.getAll("metrics").flatMap((m) => m.split(",")).filter(Boolean);
  const metrics = rawMetrics.length ? [...new Set(rawMetrics)] : ["booked"];
  const idFilter = (key: "employeeIds" | "projectIds" | "clientIds") => {
    const v = url.searchParams.get(key);
    return v ? new Set(v.split(",").map(Number)) : null;
  };
  const empSet = idFilter("employeeIds");
  const projSet = idFilter("projectIds");
  const clientSet = idFilter("clientIds");
  let facts = buildFacts(start, end);
  if (empSet) facts = facts.filter((f) => empSet.has(f.employeeId));
  if (projSet) facts = facts.filter((f) => projSet.has(f.projectId));
  if (clientSet) facts = facts.filter((f) => clientSet.has(f.clientId));

  const buckets = colDim === "none" ? [] : [...new Set(facts.map((f) => bucketKey(f.date, colDim)))].sort();
  const columns = [...buckets, "Total"];

  function availableFor(empIds: Set<number>, bucket: string | null): number {
    let sum = 0;
    for (const id of empIds) {
      const emp = empById(id);
      if (!emp) continue;
      for (const d of eachDay(start, end)) {
        if (bucket && bucketKey(d, colDim) !== bucket) continue;
        if (isWorkingDay(id, d) && !onVacation(id, d)) sum += emp.weeklyCapacityHours / 5;
      }
    }
    return sum;
  }

  function metricsFor(fs: Fact[], bucket: string | null): Record<string, number> {
    const inBucket = bucket == null || bucket === "Total" ? fs : fs.filter((f) => bucketKey(f.date, colDim) === bucket);
    const booked = inBucket.reduce((s, f) => s + f.booked, 0);
    const billable = inBucket.reduce((s, f) => s + f.billableBooked, 0);
    const planned = inBucket.reduce((s, f) => s + f.planned, 0);
    const empIds = new Set(inBucket.map((f) => f.employeeId));
    const available = availableFor(empIds, bucket === "Total" ? null : bucket);
    const roleIds = new Set(inBucket.map((f) => f.roleId).filter((r): r is number => r != null));
    const budgeted = [...roleIds].reduce((s, id) => {
      const r = roleById(id);
      return s + (r?.budgetedHours ?? (r?.budgetedDays != null ? r.budgetedDays * 8 : 0));
    }, 0);
    const all: Record<string, number> = {
      booked: round2(booked),
      billable_booked: round2(billable),
      planned: round2(planned),
      available: round2(available),
      budgeted: round2(budgeted),
      remaining_unbooked: round2(available - booked),
      remaining_unplanned: round2(available - planned),
      utilization_pct: available ? round2((booked / available) * 100) : 0,
      billable_utilization_pct: available ? round2((billable / available) * 100) : 0,
      plan_completion_pct: planned ? round2((booked / planned) * 100) : 0,
      budget_used_pct: budgeted ? round2((booked / budgeted) * 100) : 0,
    };
    const out: Record<string, number> = {};
    for (const mKey of metrics) out[mKey] = all[mKey] ?? 0;
    return out;
  }

  type Dim = "employee" | "project" | "client" | "role";
  const nesting: Record<string, Dim[]> = {
    employees: ["employee", "project", "role"],
    projects: ["project", "role", "employee"],
    clients: ["client", "project", "role", "employee"],
    roles: ["role", "employee"],
  };

  const keyOf = (f: Fact, dim: Dim) =>
    dim === "employee" ? f.employeeId : dim === "project" ? f.projectId : dim === "client" ? f.clientId : (f.roleId ?? "null");
  const nameOf = (dim: Dim, key: number | string): string => {
    if (key === "null") return "No role";
    const id = Number(key);
    if (dim === "employee") return empById(id)?.name ?? `#${id}`;
    if (dim === "project") return projById(id)?.name ?? `#${id}`;
    if (dim === "client") return clientById(id)?.name ?? `#${id}`;
    return roleById(id)?.name ?? `#${id}`;
  };
  const prefix: Record<Dim, string> = { employee: "emp", project: "proj", client: "client", role: "role" };

  function buildRows(fs: Fact[], dims: Dim[], idPrefix: string): Json[] {
    if (!dims.length) return [];
    const [dim, ...rest] = dims;
    const groups = new Map<number | string, Fact[]>();
    for (const f of fs) {
      const k = keyOf(f, dim);
      const arr = groups.get(k) ?? [];
      arr.push(f);
      groups.set(k, arr);
    }
    return [...groups.entries()]
      .sort((a, b) => nameOf(dim, a[0]).localeCompare(nameOf(dim, b[0])))
      .map(([k, groupFacts]) => {
        const id = `${idPrefix}${idPrefix ? "-" : ""}${prefix[dim]}-${k}`;
        const data: Record<string, Record<string, number>> = {};
        for (const c of columns) data[c] = metricsFor(groupFacts, c);
        const children = buildRows(groupFacts, rest, id);
        return { id, name: nameOf(dim, k), type: dim, expandable: children.length > 0, data, children };
      });
  }

  const rows = buildRows(facts, nesting[rowDim] ?? nesting.employees, "");
  const totals: Record<string, Record<string, number>> = {};
  for (const c of columns) totals[c] = metricsFor(facts, c);
  const columnLabels = columns.map((c) => (c === "Total" ? "Total" : c));
  return json({ type: "drill", rowDimension: rowDim, colDimension: colDim, metrics, columns, columnLabels, rows, totals });
});

/* ─────────────────────────── saved reports ──────────────────────────────── */

on("GET", "/api/saved-reports", () =>
  json(db.savedReports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
);
on("POST", "/api/saved-reports", (_m, _u, body) => {
  if (!body?.name || !body?.config) return json({ error: "name and config are required" }, 400);
  const r: SavedReport = { id: crypto.randomUUID(), name: String(body.name), config: String(body.config), createdAt: now(), updatedAt: now() };
  db.savedReports.push(r);
  return json(r, 201);
});
on("DELETE", "/api/saved-reports/:id", (m) => {
  const i = db.savedReports.findIndex((r) => r.id === m[1]);
  if (i < 0) return json({ error: "Not found" }, 404);
  db.savedReports.splice(i, 1);
  return noContent();
});

/* ─────────────────────── employee timesheet + portal ────────────────────── */

on("GET", "/api/auth/employee/token/:token", (m) => {
  const emp = db.employees.find((e) => e.personalAccessToken === m[1]);
  return emp ? json(emp) : notFound("Employee");
});
on("POST", "/api/auth/employee/verify", (_m, _u, body) => {
  const emp = db.employees.find((e) => e.personalAccessToken === body?.token);
  if (!emp || !body?.pin) return json({ error: "Invalid token or PIN" }, 401);
  const { contractStartDate: _c1, contractEndDate: _c2, utilizationTarget: _u3, ...rest } = emp;
  return json(rest);
});

on("GET", "/api/employee-timesheet/:employeeId/week/:weekStart", (m) => {
  const emp = empById(Number(m[1]));
  if (!emp) return notFound("Employee");
  const weekStart = m[2];
  const weekEnd = addDays(weekStart, 6);
  const roleIds = db.roleAssignments.filter((a) => a.employeeId === emp.id).map((a) => a.roleId);
  const assignedRoles = db.projectRoles.filter((r) => roleIds.includes(r.id));
  const byProject = new Map<number, typeof assignedRoles>();
  for (const r of assignedRoles) {
    const arr = byProject.get(r.projectId) ?? [];
    arr.push(r);
    byProject.set(r.projectId, arr);
  }
  const weekEntries = db.timeEntries.filter((e) => e.employeeId === emp.id && e.entryDate >= weekStart && e.entryDate <= weekEnd);
  const prefKeys = new Set<string>();
  const prefilled: Json[] = [];
  const pushPrefilled = (projectId: number, roleId: number | null, isLegacy: boolean) => {
    const key = `${projectId}:${roleId}`;
    if (prefKeys.has(key)) return;
    prefKeys.add(key);
    const p = projById(projectId);
    const role = roleById(roleId);
    let planned = 0;
    for (const b of db.resourceBookings.filter(
      (b) => b.employeeId === emp.id && b.projectId === projectId && (b.projectRoleId ?? null) === roleId && b.status !== "tentative",
    )) {
      for (const d of eachDay(weekStart, weekEnd)) planned += bookingHoursOn(b, d);
    }
    const entries: Record<string, number> = {};
    const notes: Record<string, string | null> = {};
    for (const e of weekEntries.filter((e) => e.projectId === projectId && (e.projectRoleId ?? null) === roleId)) {
      entries[e.entryDate] = e.hours;
      notes[e.entryDate] = e.note;
    }
    prefilled.push({
      projectId,
      projectName: p?.name ?? "",
      clientName: (p && clientById(p.clientId)?.name) ?? null,
      roleId,
      roleName: role?.name ?? null,
      plannedHours: planned || null,
      entries,
      notes,
      isLegacy,
    });
  };
  for (const r of assignedRoles) pushPrefilled(r.projectId, r.id, false);
  for (const e of weekEntries) pushPrefilled(e.projectId, e.projectRoleId ?? null, true);
  return json({
    employee: {
      id: emp.id,
      name: emp.name,
      weeklyCapacityHours: emp.weeklyCapacityHours,
      holidayCalendarCode: emp.holidayCalendarCode,
      workingDaysMask: (emp.workingDaysMask as number[]).join(","),
    },
    week: { start: weekStart, end: weekEnd },
    availableProjects: [...byProject.entries()].map(([projectId, roles]) => {
      const p = projById(projectId);
      return {
        projectId,
        projectName: p?.name ?? "",
        clientName: (p && clientById(p.clientId)?.name) ?? null,
        roles: roles.map((r) => ({ roleId: r.id, roleName: r.name })),
      };
    }),
    prefilled: prefilled.sort((a, b) =>
      String(a.projectName).localeCompare(String(b.projectName)) || String(a.roleName).localeCompare(String(b.roleName)),
    ),
    vacations: db.vacations
      .filter((v) => v.employeeId === emp.id && v.endDate >= weekStart && v.startDate <= weekEnd)
      .map((v) => ({ id: v.id, startDate: v.startDate, endDate: v.endDate, vacationType: v.vacationType, note: v.note })),
    holidays: db.holidays.filter((h) => h.date >= weekStart && h.date <= weekEnd),
  });
});

on("POST", "/api/employee-timesheet/:employeeId/week/:weekStart", (m, _u, body) => {
  const emp = empById(Number(m[1]));
  if (!emp) return notFound("Employee");
  const entries = (body?.entries as Json[]) ?? [];
  const result: TimeEntry[] = [];
  for (const item of entries) {
    const entryDate = String(item.entryDate);
    const hours = Number(item.hours ?? 0);
    const projectId = Number(item.projectId);
    const roleId = item.projectRoleId != null ? Number(item.projectRoleId) : null;
    const existing = db.timeEntries.find(
      (e) => e.employeeId === emp.id && e.projectId === projectId && (e.projectRoleId ?? null) === roleId && e.entryDate === entryDate,
    );
    if (hours === 0) {
      if (existing) db.timeEntries.splice(db.timeEntries.indexOf(existing), 1);
      continue;
    }
    if (existing) {
      existing.hours = hours;
      existing.note = (item.note as string) ?? existing.note;
      existing.updatedAt = now();
      result.push(existing);
    } else {
      const e: TimeEntry = {
        id: nid(),
        employeeId: emp.id,
        projectId,
        projectRoleId: roleId,
        entryDate,
        hours,
        note: (item.note as string) ?? null,
        invoicedAt: null,
        invoiceReference: null,
        billingStatus: null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.timeEntries.push(e);
      result.push(e);
    }
  }
  return json(result);
});

/* ───────────────────────────── installer ────────────────────────────────── */

export function installMockApi() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: Json | null = null;
    try {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
      if (typeof raw === "string" && raw.trim()) body = JSON.parse(raw) as Json;
    } catch {
      body = null;
    }

    for (const r of routes) {
      if (r.method !== method) continue;
      const match = url.pathname.match(r.re);
      if (!match) continue;
      // tiny latency so loading states are visible but snappy
      await new Promise((res) => setTimeout(res, 60 + Math.random() * 90));
      try {
        return await r.fn(match, url, body);
      } catch (err) {
        console.error(`[mock-api] handler error for ${method} ${url.pathname}`, err);
        return json({ error: "Mock handler error" }, 500);
      }
    }
    console.warn(`[mock-api] no handler for ${method} ${url.pathname} — returning 404`);
    return json({ error: `No mock handler for ${method} ${url.pathname}` }, 404);
  };
  console.info("%c[mock-api] Mock data mode active — all /api/* requests served from src/mocks/db.json", "color:#7857F2;font-weight:bold");
}
