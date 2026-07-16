import { Router, type IRouter } from "express";
import { eq, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  projectRolesTable,
  projectRoleAssignmentsTable,
  timeEntriesTable,
  resourceBookingsTable,
  employeesTable,
} from "@workspace/db";
import { fetchEmpAvailabilityMap, type EmpAvailability } from "../lib/employee-availability";
import { calcBookingHours } from "../lib/booking-hours";
import { calcRoleBudgetReconciliation, calcEffectiveBookingBudgetDays, type ReconciliationBooking } from "../lib/budget-reconciliation";

const router: IRouter = Router();

/**
 * Fetch holiday + vacation availability for all employees referenced by a
 * list of bookings, covering the union of their date ranges.
 * Returns a Map<employeeId, EmpAvailability> (same shape as fetchEmpAvailabilityMap).
 */
async function getAvailMapForBookings(
  bookings: Array<{ employeeId: number; startDate: string; endDate: string }>,
): Promise<Map<number, EmpAvailability>> {
  if (bookings.length === 0) return new Map();
  const uniqueIds   = [...new Set(bookings.map((b) => b.employeeId))];
  const periodStart = bookings.reduce((m, b) => (b.startDate < m ? b.startDate : m), bookings[0].startDate);
  const periodEnd   = bookings.reduce((m, b) => (b.endDate   > m ? b.endDate   : m), bookings[0].endDate);
  const employees   = await db.select().from(employeesTable).where(inArray(employeesTable.id, uniqueIds));
  return fetchEmpAvailabilityMap(employees, periodStart, periodEnd);
}

// ── Validation schemas ────────────────────────────────────────────────────────
const RoleBodySchema = z.object({
  name: z.string().min(1),
  dayRate: z.number().min(0),
  budgetedDays: z.number().min(0).nullable().optional(),
  budgetedHours: z.number().min(0).nullable().optional(),
  assignedEmployeeIds: z.array(z.number().int()).optional(),
});

const RoleUpdateSchema = RoleBodySchema.partial();

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getRolesForProject(projectId: number) {
  const roles = await db
    .select()
    .from(projectRolesTable)
    .where(eq(projectRolesTable.projectId, projectId))
    .orderBy(projectRolesTable.id);

  if (roles.length === 0) return [];

  const roleIds = roles.map((r) => r.id);

  // Fetch all assignments for these roles
  const assignments = await db
    .select({
      projectRoleId: projectRoleAssignmentsTable.projectRoleId,
      employeeId: projectRoleAssignmentsTable.employeeId,
      employeeName: employeesTable.name,
    })
    .from(projectRoleAssignmentsTable)
    .leftJoin(employeesTable, eq(projectRoleAssignmentsTable.employeeId, employeesTable.id))
    .where(
      sql`${projectRoleAssignmentsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
    );

  const assignmentMap = new Map<number, { employeeId: number; employeeName: string | null }[]>();
  for (const a of assignments) {
    if (!assignmentMap.has(a.projectRoleId)) assignmentMap.set(a.projectRoleId, []);
    assignmentMap.get(a.projectRoleId)!.push({ employeeId: a.employeeId, employeeName: a.employeeName ?? null });
  }

  return roles.map((r) => ({
    ...r,
    assignedEmployees: assignmentMap.get(r.id) ?? [],
  }));
}

// ── GET /projects/:projectId/roles ─────────────────────────────────────────
router.get("/projects/:projectId/roles", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const roles = await getRolesForProject(projectId);
  res.json(roles);
});

// ── POST /projects/:projectId/roles ────────────────────────────────────────
router.post("/projects/:projectId/roles", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const parsed = RoleBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { assignedEmployeeIds, ...roleData } = parsed.data;

  const [role] = await db
    .insert(projectRolesTable)
    .values({
      projectId,
      name: roleData.name,
      dayRate: roleData.dayRate,
      budgetedDays: roleData.budgetedDays ?? null,
      budgetedHours: roleData.budgetedHours ?? null,
    })
    .returning();

  // Insert assignments
  if (assignedEmployeeIds && assignedEmployeeIds.length > 0) {
    await db.insert(projectRoleAssignmentsTable).values(
      assignedEmployeeIds.map((employeeId) => ({ projectRoleId: role.id, employeeId }))
    );
  }

  const [enriched] = await getRolesForProject(projectId).then((roles) =>
    roles.filter((r) => r.id === role.id)
  );
  res.status(201).json(enriched);
});

// ── PUT /project-roles/:id ────────────────────────────────────────────────
router.put("/project-roles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = RoleUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { assignedEmployeeIds, ...roleData } = parsed.data;

  const updateData: Record<string, unknown> = {};
  if (roleData.name !== undefined) updateData.name = roleData.name;
  if (roleData.dayRate !== undefined) updateData.dayRate = roleData.dayRate;
  if ("budgetedDays" in roleData) updateData.budgetedDays = roleData.budgetedDays ?? null;
  if ("budgetedHours" in roleData) updateData.budgetedHours = roleData.budgetedHours ?? null;

  let role;
  if (Object.keys(updateData).length > 0) {
    const [updated] = await db
      .update(projectRolesTable)
      .set(updateData)
      .where(eq(projectRolesTable.id, id))
      .returning();
    if (!updated) { res.status(404).json({ error: "Role not found" }); return; }
    role = updated;
  } else {
    const [found] = await db.select().from(projectRolesTable).where(eq(projectRolesTable.id, id));
    if (!found) { res.status(404).json({ error: "Role not found" }); return; }
    role = found;
  }

  // Replace assignments if provided
  if (assignedEmployeeIds !== undefined) {
    await db.delete(projectRoleAssignmentsTable).where(eq(projectRoleAssignmentsTable.projectRoleId, id));
    if (assignedEmployeeIds.length > 0) {
      await db.insert(projectRoleAssignmentsTable).values(
        assignedEmployeeIds.map((employeeId) => ({ projectRoleId: id, employeeId }))
      );
    }
  }

  const [enriched] = await getRolesForProject(role.projectId).then((roles) =>
    roles.filter((r) => r.id === id)
  );
  res.json(enriched);
});

// ── DELETE /project-roles/:id ─────────────────────────────────────────────
router.delete("/project-roles/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [deleted] = await db
    .delete(projectRolesTable)
    .where(eq(projectRolesTable.id, id))
    .returning();

  if (!deleted) { res.status(404).json({ error: "Role not found" }); return; }
  res.sendStatus(204);
});

// ── GET /project-roles/:id/budget-status ───────────────────────────────────
router.get("/project-roles/:id/budget-status", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const excludeBookingId = req.query.excludeBookingId
    ? parseInt(req.query.excludeBookingId as string, 10)
    : null;

  const requestingEmployeeId = req.query.employeeId
    ? parseInt(req.query.employeeId as string, 10)
    : null;

  const [role] = await db.select().from(projectRolesTable).where(eq(projectRolesTable.id, id));
  if (!role) { res.status(404).json({ error: "Role not found" }); return; }

  const roleBookingRows = await db
    .select({
      id: resourceBookingsTable.id,
      employeeId: resourceBookingsTable.employeeId,
      employeeName: employeesTable.name,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
      weekdayHours: resourceBookingsTable.weekdayHours,
      pastReleasedAt: resourceBookingsTable.pastReleasedAt,
      status: resourceBookingsTable.status,
    })
    .from(resourceBookingsTable)
    .leftJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .where(eq(resourceBookingsTable.projectRoleId, id));

  // Exclude the booking being edited and tentative bookings (tentative = not counted against budget)
  const activeBookingRows = roleBookingRows.filter(
    (b) => (excludeBookingId == null || b.id !== excludeBookingId) && b.status !== "tentative"
  );

  const availMap = await getAvailMapForBookings(activeBookingRows);

  // Build per-employee planned-days map for the response bookings array
  const employeeMap = new Map<number, { employeeName: string; days: number }>();

  const reconciliationBookings: ReconciliationBooking[] = activeBookingRows.map((b) => {
    const avail = availMap.get(b.employeeId);
    return {
      startDate: b.startDate,
      endDate: b.endDate,
      hoursPerDay: b.hoursPerDay,
      weekdayHours: b.weekdayHours as Record<string, number> | null,
      employeeId: b.employeeId,
      pastReleasedAt: b.pastReleasedAt ?? null,
      avail: {
        holidayDates: avail?.holidayDates ?? [],
        vacationDateSet: avail?.vacationDateSet ?? new Set(),
        compDayDateSet: avail?.compDayDateSet ?? new Set(),
      },
    };
  });

  // Also populate employeeMap for per-employee day totals in the response.
  // Use release-aware calculation: released bookings only count future days.
  for (const b of activeBookingRows) {
    const avail = availMap.get(b.employeeId);
    const days = calcEffectiveBookingBudgetDays(
      {
        startDate: b.startDate,
        endDate: b.endDate,
        hoursPerDay: b.hoursPerDay,
        weekdayHours: b.weekdayHours as Record<string, number> | null,
        pastReleasedAt: b.pastReleasedAt,
      },
      avail,
    );
    const emp = employeeMap.get(b.employeeId);
    if (emp) {
      emp.days += days;
    } else {
      employeeMap.set(b.employeeId, { employeeName: b.employeeName ?? "Unknown", days });
    }
  }

  // ── Time entries: logged + invoiced hours ────────────────────────────────────
  const timeEntryRows = await db
    .select({
      employeeId: timeEntriesTable.employeeId,
      employeeName: employeesTable.name,
      entryDate: timeEntriesTable.entryDate,
      hours: timeEntriesTable.hours,
      billingStatus: timeEntriesTable.billingStatus,
      invoicedAt: timeEntriesTable.invoicedAt,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(eq(timeEntriesTable.projectRoleId, id));

  const loggedMap = new Map<number, { employeeName: string; hours: number; invoicedHours: number }>();
  let totalLoggedHours = 0;
  const reconciliationEntries = timeEntryRows.map((row) => {
    const hours = Number(row.hours);
    const isInvoiced =
      row.billingStatus === "invoiced" ||
      (row.billingStatus == null && row.invoicedAt != null);

    // Accumulate per-employee totals for the response
    const empEntry = loggedMap.get(row.employeeId);
    if (empEntry) {
      empEntry.hours += hours;
      if (isInvoiced) empEntry.invoicedHours += hours;
    } else {
      loggedMap.set(row.employeeId, {
        employeeName: row.employeeName ?? "Unknown",
        hours,
        invoicedHours: isInvoiced ? hours : 0,
      });
    }
    totalLoggedHours += hours;

    return {
      entryDate: typeof row.entryDate === "string" ? row.entryDate : (row.entryDate as Date).toISOString().slice(0, 10),
      hours,
      isInvoiced,
    };
  });

  const budgetedDays = role.budgetedDays ?? null;
  const reconciliation = calcRoleBudgetReconciliation(
    budgetedDays,
    reconciliationBookings,
    reconciliationEntries,
  );

  const round1 = (n: number) => Math.round(n * 10) / 10;

  // Merge all employee ids
  const allEmployeeIds = new Set([...employeeMap.keys(), ...loggedMap.keys()]);

  const bookings = Array.from(allEmployeeIds)
    .map((empId) => {
      const planned = employeeMap.get(empId);
      const logged = loggedMap.get(empId);
      return {
        employeeId: empId,
        employeeName: planned?.employeeName ?? logged?.employeeName ?? "Unknown",
        days: round1(planned?.days ?? 0),
        loggedDays: round1((logged?.hours ?? 0) / 8),
        invoicedDays: round1((logged?.invoicedHours ?? 0) / 8),
      };
    })
    .sort((a, b) => (b.days + b.loggedDays) - (a.days + a.loggedDays));

  const employeeLoggedDays = requestingEmployeeId != null
    ? round1((loggedMap.get(requestingEmployeeId)?.hours ?? 0) / 8)
    : null;

  const employeeInvoicedDays = requestingEmployeeId != null
    ? round1((loggedMap.get(requestingEmployeeId)?.invoicedHours ?? 0) / 8)
    : null;

  res.json({
    budgetedDays,
    plannedDays: reconciliation.plannedDays,
    loggedDays: reconciliation.loggedDays,
    invoicedDays: reconciliation.invoicedDays,
    reservedDays: reconciliation.reservedDays,
    stalePlanDays: reconciliation.stalePlanDays,
    unplannedDays: reconciliation.unplannedDays,
    freeDays: reconciliation.freeDays,
    remainingBudgetDays: reconciliation.remainingBudgetDays,
    loggedNotInvoicedDays: reconciliation.loggedNotInvoicedDays,
    employeeLoggedDays,
    employeeInvoicedDays,
    bookings,
  });
});

// ── GET /projects/:projectId/budget ────────────────────────────────────────
router.get("/projects/:projectId/budget", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const roles = await getRolesForProject(projectId);
  if (roles.length === 0) {
    res.json({ roles: [], totals: { budgetedDays: 0, budgetedHours: 0, budgetValue: 0, bookedHours: 0, bookedValue: 0, invoicedDays: 0, reservedDays: 0, stalePlanDays: 0, unplannedDays: 0, freeDays: 0, remainingBudgetDays: 0, loggedNotInvoicedDays: 0 } });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Fetch individual bookings to compute planned days using bookable-day formula
  const plannedBookings = await db
    .select({
      id:              resourceBookingsTable.id,
      projectRoleId:   resourceBookingsTable.projectRoleId,
      employeeId:      resourceBookingsTable.employeeId,
      startDate:       resourceBookingsTable.startDate,
      endDate:         resourceBookingsTable.endDate,
      hoursPerDay:     resourceBookingsTable.hoursPerDay,
      weekdayHours:    resourceBookingsTable.weekdayHours,
      pastReleasedAt:  resourceBookingsTable.pastReleasedAt,
    })
    .from(resourceBookingsTable)
    .where(
      and(
        eq(resourceBookingsTable.projectId, projectId),
        sql`${resourceBookingsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        sql`(${resourceBookingsTable.status} IS NULL OR ${resourceBookingsTable.status} != 'tentative')`
      )
    );

  // Fetch time entries with invoiced status for reconciliation
  const timeEntryRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      entryDate:     timeEntriesTable.entryDate,
      hours:         timeEntriesTable.hours,
      billingStatus: timeEntriesTable.billingStatus,
      invoicedAt:    timeEntriesTable.invoicedAt,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
      )
    );

  const plannedAvailMap = await getAvailMapForBookings(
    plannedBookings.filter((b) => b.projectRoleId != null)
  );

  // Group bookings and time entries by roleId
  const bookingsByRole = new Map<number, typeof plannedBookings>();
  for (const b of plannedBookings) {
    if (b.projectRoleId == null) continue;
    const arr = bookingsByRole.get(b.projectRoleId) ?? [];
    arr.push(b);
    bookingsByRole.set(b.projectRoleId, arr);
  }

  const entriesByRole = new Map<number, typeof timeEntryRows>();
  for (const e of timeEntryRows) {
    if (e.projectRoleId == null) continue;
    const arr = entriesByRole.get(e.projectRoleId) ?? [];
    arr.push(e);
    entriesByRole.set(e.projectRoleId, arr);
  }

  let totalBudgetedDays = 0;
  let totalBudgetedHours = 0;
  let totalBudgetValue = 0;
  let totalBookedHours = 0;
  let totalBookedValue = 0;
  let totalInvoicedDays = 0;
  let totalReservedDays = 0;
  let totalUnplannedDays = 0;
  let totalFreeDays = 0;
  let totalRemainingBudgetDays = 0;
  let totalLoggedNotInvoicedDays = 0;

  const rolesWithBudget = roles.map((role) => {
    const roleBookings = bookingsByRole.get(role.id) ?? [];
    const roleEntries = entriesByRole.get(role.id) ?? [];

    const reconciliationBookings: ReconciliationBooking[] = roleBookings.map((b) => {
      const avail = plannedAvailMap.get(b.employeeId);
      return {
        startDate: b.startDate,
        endDate: b.endDate,
        hoursPerDay: b.hoursPerDay,
        weekdayHours: b.weekdayHours as Record<string, number> | null,
        employeeId: b.employeeId,
        pastReleasedAt: b.pastReleasedAt ?? null,
        avail: {
          holidayDates: avail?.holidayDates ?? [],
          vacationDateSet: avail?.vacationDateSet ?? new Set(),
          compDayDateSet: avail?.compDayDateSet ?? new Set(),
        },
      };
    });

    const reconciliationEntries = roleEntries.map((e) => ({
      entryDate: typeof e.entryDate === "string" ? e.entryDate : (e.entryDate as Date).toISOString().slice(0, 10),
      hours: Number(e.hours),
      isInvoiced:
        e.billingStatus === "invoiced" ||
        (e.billingStatus == null && e.invoicedAt != null),
    }));

    const budgetedDays = role.budgetedDays ?? null;
    const recon = calcRoleBudgetReconciliation(budgetedDays, reconciliationBookings, reconciliationEntries);

    const bookedHours = recon.loggedDays * 8;
    const bookedDays = recon.loggedDays;
    const plannedHours = Math.round(recon.plannedDays * 8 * 10) / 10;
    const plannedDays = recon.plannedDays;
    const budgetedHours = role.budgetedHours ?? (budgetedDays != null ? budgetedDays * 8 : null);
    const budgetValue = budgetedDays != null ? budgetedDays * role.dayRate : null;
    const bookedValue = bookedDays * role.dayRate;
    const utilization = budgetedDays != null && budgetedDays > 0 ? bookedDays / budgetedDays : null;

    if (budgetedDays != null) totalBudgetedDays += budgetedDays;
    if (budgetedHours != null) totalBudgetedHours += budgetedHours;
    if (budgetValue != null) totalBudgetValue += budgetValue;
    totalBookedHours += bookedHours;
    totalBookedValue += bookedValue;
    totalInvoicedDays += recon.invoicedDays;
    totalReservedDays += recon.reservedDays;
    if (recon.unplannedDays != null) totalUnplannedDays += recon.unplannedDays;
    if (recon.freeDays != null) totalFreeDays += recon.freeDays;
    if (recon.remainingBudgetDays != null) totalRemainingBudgetDays += recon.remainingBudgetDays;
    totalLoggedNotInvoicedDays += recon.loggedNotInvoicedDays;

    return {
      ...role,
      bookedHours,
      bookedDays,
      plannedHours,
      plannedDays,
      budgetedDays,
      budgetedHours,
      budgetValue,
      bookedValue,
      utilization,
      invoicedDays: recon.invoicedDays,
      reservedDays: recon.reservedDays,
      stalePlanDays: recon.stalePlanDays,
      unplannedDays: recon.unplannedDays,
      freeDays: recon.freeDays,
      remainingBudgetDays: recon.remainingBudgetDays,
      loggedNotInvoicedDays: recon.loggedNotInvoicedDays,
    };
  });

  const round1 = (n: number) => Math.round(n * 10) / 10;
  const totalStalePlanDays = rolesWithBudget.reduce((s, r) => s + (r.stalePlanDays ?? 0), 0);

  res.json({
    roles: rolesWithBudget,
    totals: {
      budgetedDays: round1(totalBudgetedDays),
      budgetedHours: round1(totalBudgetedHours),
      budgetValue: Math.round(totalBudgetValue * 100) / 100,
      bookedHours: round1(totalBookedHours),
      bookedValue: Math.round(totalBookedValue * 100) / 100,
      invoicedDays: round1(totalInvoicedDays),
      reservedDays: round1(totalReservedDays),
      stalePlanDays: round1(totalStalePlanDays),
      unplannedDays: round1(totalUnplannedDays),
      freeDays: round1(totalFreeDays),
      remainingBudgetDays: round1(totalRemainingBudgetDays),
      loggedNotInvoicedDays: round1(totalLoggedNotInvoicedDays),
    },
  });
});

// ── GET /projects/:projectId/allocations ───────────────────────────────────
router.get("/projects/:projectId/allocations", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const roles = await getRolesForProject(projectId);
  if (roles.length === 0) {
    res.json({ projectId, roles: [], totals: { budgetedDays: 0, plannedDays: 0, bookedDays: 0, invoicedDays: 0, reservedDays: 0, unplannedDays: 0, freeDays: 0, remainingBudgetDays: 0, budgetValue: 0, bookedValue: 0 } });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Fetch individual resource bookings for planned-day calculation (per employee per role)
  const bookingRows = await db
    .select({
      projectRoleId:  resourceBookingsTable.projectRoleId,
      employeeId:     resourceBookingsTable.employeeId,
      employeeName:   employeesTable.name,
      startDate:      resourceBookingsTable.startDate,
      endDate:        resourceBookingsTable.endDate,
      hoursPerDay:    resourceBookingsTable.hoursPerDay,
      weekdayHours:   resourceBookingsTable.weekdayHours,
      pastReleasedAt: resourceBookingsTable.pastReleasedAt,
    })
    .from(resourceBookingsTable)
    .leftJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .where(
      and(
        sql`${resourceBookingsTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        sql`(${resourceBookingsTable.status} IS NULL OR ${resourceBookingsTable.status} != 'tentative')`
      )
    );

  // Fetch time entries with invoiced status for reconciliation + per-employee booked days
  const timeEntryRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId: timeEntriesTable.employeeId,
      employeeName: employeesTable.name,
      entryDate:     timeEntriesTable.entryDate,
      hours:         timeEntriesTable.hours,
      billingStatus: timeEntriesTable.billingStatus,
      invoicedAt:    timeEntriesTable.invoicedAt,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`
      )
    );

  const round1 = (n: number) => Math.round(n * 10) / 10;

  interface AllocationAccum {
    employeeId: number;
    employeeName: string;
    allocatedDays: number;
    startDate: string;
    endDate: string;
  }
  const allocMap = new Map<string, AllocationAccum>();

  const allocAvailMap = await getAvailMapForBookings(bookingRows.filter((b) => b.projectRoleId != null));

  for (const b of bookingRows) {
    if (b.projectRoleId == null) continue;
    const key   = `${b.projectRoleId}:${b.employeeId}`;
    const avail = allocAvailMap.get(b.employeeId);
    // Use release-aware calculation: released bookings only count future days.
    const days = calcEffectiveBookingBudgetDays(
      {
        startDate: b.startDate,
        endDate: b.endDate,
        hoursPerDay: b.hoursPerDay,
        weekdayHours: b.weekdayHours as Record<string, number> | null,
        pastReleasedAt: b.pastReleasedAt,
      },
      avail,
    );

    const existing = allocMap.get(key);
    if (existing) {
      existing.allocatedDays += days;
      if (b.startDate < existing.startDate) existing.startDate = b.startDate;
      if (b.endDate > existing.endDate) existing.endDate = b.endDate;
    } else {
      allocMap.set(key, {
        employeeId: b.employeeId,
        employeeName: b.employeeName ?? "Unknown",
        allocatedDays: days,
        startDate: b.startDate,
        endDate: b.endDate,
      });
    }
  }

  // Build per-role, per-employee booked-days map from time entries
  const bookedEmpMap = new Map<string, { employeeId: number; employeeName: string; bookedDays: number }>();
  for (const t of timeEntryRows) {
    if (t.projectRoleId == null) continue;
    const key = `${t.projectRoleId}:${t.employeeId}`;
    const hours = Number(t.hours);
    const ex = bookedEmpMap.get(key);
    if (ex) {
      ex.bookedDays += hours / 8;
    } else {
      bookedEmpMap.set(key, {
        employeeId: t.employeeId,
        employeeName: t.employeeName ?? "Unknown",
        bookedDays: hours / 8,
      });
    }
  }

  // Group bookings and time entries by roleId for reconciliation
  const bookingsByRole = new Map<number, typeof bookingRows>();
  for (const b of bookingRows) {
    if (b.projectRoleId == null) continue;
    const arr = bookingsByRole.get(b.projectRoleId) ?? [];
    arr.push(b);
    bookingsByRole.set(b.projectRoleId, arr);
  }

  const entriesByRole = new Map<number, typeof timeEntryRows>();
  for (const e of timeEntryRows) {
    if (e.projectRoleId == null) continue;
    const arr = entriesByRole.get(e.projectRoleId) ?? [];
    arr.push(e);
    entriesByRole.set(e.projectRoleId, arr);
  }

  let totalBudgetedDays = 0;
  let totalPlannedDays = 0;
  let totalBookedDays = 0;
  let totalBudgetValue = 0;
  let totalBookedValue = 0;
  let totalInvoicedDays = 0;
  let totalReservedDays = 0;
  let totalUnplannedDays = 0;
  let totalFreeDays = 0;
  let totalRemainingBudgetDays = 0;

  const rolesOut = roles.map((role) => {
    // Build reconciliation inputs for this role
    const roleBookings = bookingsByRole.get(role.id) ?? [];
    const roleEntries = entriesByRole.get(role.id) ?? [];

    const reconciliationBookings: ReconciliationBooking[] = roleBookings.map((b) => {
      const avail = allocAvailMap.get(b.employeeId);
      return {
        startDate: b.startDate,
        endDate: b.endDate,
        hoursPerDay: b.hoursPerDay,
        weekdayHours: b.weekdayHours as Record<string, number> | null,
        employeeId: b.employeeId,
        pastReleasedAt: b.pastReleasedAt ?? null,
        avail: {
          holidayDates: avail?.holidayDates ?? [],
          vacationDateSet: avail?.vacationDateSet ?? new Set(),
          compDayDateSet: avail?.compDayDateSet ?? new Set(),
        },
      };
    });

    const reconciliationEntries = roleEntries.map((e) => ({
      entryDate: typeof e.entryDate === "string" ? e.entryDate : (e.entryDate as Date).toISOString().slice(0, 10),
      hours: Number(e.hours),
      isInvoiced:
        e.billingStatus === "invoiced" ||
        (e.billingStatus == null && e.invoicedAt != null),
    }));

    const budgetedDays = role.budgetedDays ?? null;
    const recon = calcRoleBudgetReconciliation(budgetedDays, reconciliationBookings, reconciliationEntries);

    // Collect all employees for this role
    const empIds = new Set<number>();
    for (const [key] of allocMap) {
      const [rId] = key.split(":");
      if (parseInt(rId, 10) === role.id) empIds.add(parseInt(key.split(":")[1], 10));
    }
    for (const [key] of bookedEmpMap) {
      const [rId] = key.split(":");
      if (parseInt(rId, 10) === role.id) empIds.add(parseInt(key.split(":")[1], 10));
    }

    let rolePlannedDays = 0;
    let roleBookedDays = 0;

    const allocations = Array.from(empIds).map((empId) => {
      const aKey = `${role.id}:${empId}`;
      const alloc = allocMap.get(aKey);
      const booked = bookedEmpMap.get(aKey);
      const allocatedDays = round1(alloc?.allocatedDays ?? 0);
      const bookedDays = round1(booked?.bookedDays ?? 0);
      rolePlannedDays += allocatedDays;
      roleBookedDays += bookedDays;
      const percentage = allocatedDays > 0 ? Math.round((bookedDays / allocatedDays) * 100) : 0;
      const employeeName = alloc?.employeeName ?? booked?.employeeName ?? `#${empId}`;
      return {
        employeeId: empId,
        employeeName,
        allocatedDays,
        period: alloc
          ? { start: alloc.startDate, end: alloc.endDate }
          : null,
        bookedDays,
        percentage,
      };
    }).sort((a, b) => b.allocatedDays - a.allocatedDays);

    rolePlannedDays = round1(rolePlannedDays);
    roleBookedDays = round1(roleBookedDays);
    const budgetValue = budgetedDays != null ? budgetedDays * role.dayRate : null;
    const bookedValue = round1(roleBookedDays * role.dayRate);

    if (budgetedDays != null) totalBudgetedDays += budgetedDays;
    totalPlannedDays += rolePlannedDays;
    totalBookedDays += roleBookedDays;
    if (budgetValue != null) totalBudgetValue += budgetValue;
    totalBookedValue += bookedValue;
    totalInvoicedDays += recon.invoicedDays;
    totalReservedDays += recon.reservedDays;
    if (recon.unplannedDays != null) totalUnplannedDays += recon.unplannedDays;
    if (recon.freeDays != null) totalFreeDays += recon.freeDays;
    if (recon.remainingBudgetDays != null) totalRemainingBudgetDays += recon.remainingBudgetDays;

    return {
      roleId: role.id,
      roleName: role.name,
      dayRate: role.dayRate,
      budgetedDays,
      plannedDays: rolePlannedDays,
      bookedDays: roleBookedDays,
      invoicedDays: recon.invoicedDays,
      reservedDays: recon.reservedDays,
      stalePlanDays: recon.stalePlanDays,
      unplannedDays: recon.unplannedDays,
      freeDays: recon.freeDays,
      remainingBudgetDays: recon.remainingBudgetDays,
      budgetValue,
      bookedValue,
      allocations,
    };
  });

  res.json({
    projectId,
    roles: rolesOut,
    totals: {
      budgetedDays: round1(totalBudgetedDays),
      plannedDays: round1(totalPlannedDays),
      bookedDays: round1(totalBookedDays),
      invoicedDays: round1(totalInvoicedDays),
      reservedDays: round1(totalReservedDays),
      unplannedDays: round1(totalUnplannedDays),
      freeDays: round1(totalFreeDays),
      remainingBudgetDays: round1(totalRemainingBudgetDays),
      budgetValue: round1(totalBudgetValue),
      bookedValue: round1(totalBookedValue),
    },
  });
});

export default router;
