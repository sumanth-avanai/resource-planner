import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  projectsTable,
  clientsTable,
  employeesTable,
} from "@workspace/db";
import { calculateAvailableHours, wasEmployeeActiveDuring } from "../lib/utilization";
import { fetchEmpAvailabilityMap } from "../lib/employee-availability";

const router: IRouter = Router();

function parseDateParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

router.get("/reports/utilization", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate   = parseDateParam(req.query.endDate);

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const employeeIdRaw = req.query.employeeId;
  const employeeId = employeeIdRaw ? parseInt(String(employeeIdRaw), 10) : undefined;

  const employeeFilter =
    employeeId
      ? and(eq(employeesTable.id, employeeId), eq(employeesTable.active, true))
      : eq(employeesTable.active, true);

  const allFetchedEmployees = await db.select().from(employeesTable).where(employeeFilter);

  // Exclude employees whose contract has no overlap with the requested period.
  // wasEmployeeActiveDuring() returns true when contractStart/End are both null (no restriction).
  const employees = allFetchedEmployees.filter((emp) =>
    wasEmployeeActiveDuring(emp.contractStartDate, emp.contractEndDate, startDate, endDate)
  );

  const availMap = await fetchEmpAvailabilityMap(employees, startDate, endDate);

  const results = [];

  for (const emp of employees) {
    const { holidayDates, vacationDateSet } = availMap.get(emp.id)!;

    const availableHours = calculateAvailableHours(
      startDate,
      endDate,
      emp.workingDaysMask,
      emp.weeklyCapacityHours,
      holidayDates,
      vacationDateSet,
      emp.contractStartDate,
      emp.contractEndDate
    );

    const entries = await db
      .select({ hours: timeEntriesTable.hours, isBillable: projectsTable.isBillable })
      .from(timeEntriesTable)
      .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
      .where(
        and(
          eq(timeEntriesTable.employeeId, emp.id),
          gte(timeEntriesTable.entryDate, startDate),
          lte(timeEntriesTable.entryDate, endDate)
        )
      );

    const billableHours    = entries.filter((e) => e.isBillable).reduce((s, e) => s + e.hours, 0);
    const nonBillableHours = entries.filter((e) => !e.isBillable).reduce((s, e) => s + e.hours, 0);
    const totalBookedHours = billableHours + nonBillableHours;

    const billableUtilization = availableHours > 0 ? Math.round((billableHours    / availableHours) * 1000) / 10 : 0;
    const overallUtilization  = availableHours > 0 ? Math.round((totalBookedHours / availableHours) * 1000) / 10 : 0;

    results.push({
      employeeId:          emp.id,
      employeeName:        emp.name,
      availableHours:      Math.round(availableHours      * 100) / 100,
      billableHours:       Math.round(billableHours       * 100) / 100,
      nonBillableHours:    Math.round(nonBillableHours    * 100) / 100,
      totalBookedHours:    Math.round(totalBookedHours    * 100) / 100,
      billableUtilization,
      overallUtilization,
    });
  }

  res.json(results);
});

router.get("/reports/projects", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate   = parseDateParam(req.query.endDate);

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rows = await db
    .select({
      projectId:   projectsTable.id,
      projectName: projectsTable.name,
      clientName:  clientsTable.name,
      isBillable:  projectsTable.isBillable,
      hours:       timeEntriesTable.hours,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(
      and(
        gte(timeEntriesTable.entryDate, startDate),
        lte(timeEntriesTable.entryDate, endDate)
      )
    );

  const projectMap = new Map<
    number,
    { projectId: number; projectName: string; clientName: string; isBillable: boolean; totalHours: number; billableHours: number; nonBillableHours: number }
  >();

  for (const row of rows) {
    if (!projectMap.has(row.projectId)) {
      projectMap.set(row.projectId, {
        projectId:       row.projectId,
        projectName:     row.projectName,
        clientName:      row.clientName ?? "",
        isBillable:      row.isBillable,
        totalHours:      0,
        billableHours:   0,
        nonBillableHours: 0,
      });
    }
    const agg = projectMap.get(row.projectId)!;
    agg.totalHours += row.hours;
    if (row.isBillable) agg.billableHours    += row.hours;
    else                agg.nonBillableHours += row.hours;
  }

  res.json(
    Array.from(projectMap.values()).map((r) => ({
      ...r,
      totalHours:       Math.round(r.totalHours       * 100) / 100,
      billableHours:    Math.round(r.billableHours    * 100) / 100,
      nonBillableHours: Math.round(r.nonBillableHours * 100) / 100,
    }))
  );
});

router.get("/reports/clients", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate   = parseDateParam(req.query.endDate);

  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rows = await db
    .select({
      clientId:   clientsTable.id,
      clientName: clientsTable.name,
      isBillable: projectsTable.isBillable,
      hours:      timeEntriesTable.hours,
    })
    .from(timeEntriesTable)
    .innerJoin(projectsTable, eq(timeEntriesTable.projectId, projectsTable.id))
    .innerJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(
      and(
        gte(timeEntriesTable.entryDate, startDate),
        lte(timeEntriesTable.entryDate, endDate)
      )
    );

  const clientMap = new Map<number, { clientId: number; clientName: string; totalHours: number; billableHours: number; nonBillableHours: number }>();

  for (const row of rows) {
    if (!clientMap.has(row.clientId)) {
      clientMap.set(row.clientId, { clientId: row.clientId, clientName: row.clientName, totalHours: 0, billableHours: 0, nonBillableHours: 0 });
    }
    const agg = clientMap.get(row.clientId)!;
    agg.totalHours += row.hours;
    if (row.isBillable) agg.billableHours    += row.hours;
    else                agg.nonBillableHours += row.hours;
  }

  res.json(
    Array.from(clientMap.values()).map((r) => ({
      ...r,
      totalHours:       Math.round(r.totalHours       * 100) / 100,
      billableHours:    Math.round(r.billableHours    * 100) / 100,
      nonBillableHours: Math.round(r.nonBillableHours * 100) / 100,
    }))
  );
});

export default router;
