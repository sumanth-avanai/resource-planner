import { Router, type IRouter } from "express";
import { eq, and, gte, lte } from "drizzle-orm";
import { db, timeEntriesTable, projectsTable, employeesTable } from "@workspace/db";
import { calculateAvailableHours, getWeekStart, toIsoDate } from "../lib/utilization";
import { fetchEmpAvailabilityMap } from "../lib/employee-availability";

const router: IRouter = Router();

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const today     = new Date();
  const weekStart = getWeekStart(today);
  const weekEnd   = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

  const startDate = toIsoDate(weekStart);
  const endDate   = toIsoDate(weekEnd);

  const employees = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.active, true));

  // Fetch holidays + vacations for all employees in one pass
  const availMap = await fetchEmpAvailabilityMap(employees, startDate, endDate);

  let totalBookedHours   = 0;
  let billableBookedHours = 0;
  const employeeSummaries = [];

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

    const bookedHours   = entries.reduce((sum, e) => sum + e.hours, 0);
    const billableHours = entries.filter((e) => e.isBillable).reduce((sum, e) => sum + e.hours, 0);
    const utilization   = availableHours > 0 ? Math.round((bookedHours / availableHours) * 1000) / 10 : 0;

    totalBookedHours    += bookedHours;
    billableBookedHours += billableHours;

    employeeSummaries.push({
      employeeId:     emp.id,
      employeeName:   emp.name,
      availableHours: Math.round(availableHours * 100) / 100,
      bookedHours:    Math.round(bookedHours    * 100) / 100,
      billableHours:  Math.round(billableHours  * 100) / 100,
      utilization,
    });
  }

  res.json({
    weekStartDate:       startDate,
    weekEndDate:         endDate,
    totalBookedHours:    Math.round(totalBookedHours    * 100) / 100,
    billableBookedHours: Math.round(billableBookedHours * 100) / 100,
    employeeSummaries,
  });
});

export default router;
