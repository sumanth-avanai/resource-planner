import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray, isNull } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  projectsTable,
  clientsTable,
  employeesTable,
  holidayCalendarsTable,
  holidaysTable,
  employeeVacationsTable,
  projectRolesTable,
} from "@workspace/db";
import {
  ListTimeEntriesQueryParams,
  CreateTimeEntryBody,
  BulkUpsertTimeEntriesBody,
  GetTimeEntryParams,
  UpdateTimeEntryParams,
  UpdateTimeEntryBody,
  DeleteTimeEntryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function enrichEntries(entries: (typeof timeEntriesTable.$inferSelect)[]) {
  if (entries.length === 0) return [];

  const projectIds = [...new Set(entries.map((e) => e.projectId))];
  const employeeIds = [...new Set(entries.map((e) => e.employeeId))];

  const [projects, employees] = await Promise.all([
    db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        isBillable: projectsTable.isBillable,
        clientName: clientsTable.name,
      })
      .from(projectsTable)
      .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
      .where(inArray(projectsTable.id, projectIds)),
    db
      .select({ id: employeesTable.id, name: employeesTable.name })
      .from(employeesTable)
      .where(inArray(employeesTable.id, employeeIds)),
  ]);

  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const employeeMap = new Map(employees.map((e) => [e.id, e.name]));

  // Enrich role names if any entries have projectRoleId
  const roleIds = [...new Set(entries.map((e) => e.projectRoleId).filter((id): id is number => id != null))];
  const roleMap = new Map<number, { name: string; dayRate: number }>();
  if (roleIds.length > 0) {
    const roles = await db
      .select({ id: projectRolesTable.id, name: projectRolesTable.name, dayRate: projectRolesTable.dayRate })
      .from(projectRolesTable)
      .where(inArray(projectRolesTable.id, roleIds));
    for (const r of roles) roleMap.set(r.id, { name: r.name, dayRate: r.dayRate });
  }

  return entries.map((e) => {
    const project = projectMap.get(e.projectId);
    const role = e.projectRoleId != null ? roleMap.get(e.projectRoleId) : undefined;
    return {
      ...e,
      employeeName: employeeMap.get(e.employeeId) ?? null,
      projectName: project?.name ?? null,
      clientName: project?.clientName ?? null,
      isBillable: project?.isBillable ?? null,
      roleName: role?.name ?? null,
      roleDayRate: role?.dayRate ?? null,
    };
  });
}

router.get("/time-entries", async (req, res): Promise<void> => {
  // Parse date strings directly — zod.date() rejects plain "YYYY-MM-DD" strings from query params.
  const employeeId = req.query.employeeId ? parseInt(String(req.query.employeeId), 10) : undefined;
  const projectId  = req.query.projectId  ? parseInt(String(req.query.projectId),  10) : undefined;

  const startDateRaw = req.query.startDate;
  const endDateRaw   = req.query.endDate;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = typeof startDateRaw === "string" && dateRe.test(startDateRaw) ? startDateRaw : undefined;
  const endDate   = typeof endDateRaw   === "string" && dateRe.test(endDateRaw)   ? endDateRaw   : undefined;

  const conditions = [];
  if (employeeId && !isNaN(employeeId)) conditions.push(eq(timeEntriesTable.employeeId, employeeId));
  if (projectId  && !isNaN(projectId))  conditions.push(eq(timeEntriesTable.projectId,  projectId));
  if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

  const entries = await db
    .select()
    .from(timeEntriesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(timeEntriesTable.entryDate);

  const enriched = await enrichEntries(entries);
  res.json(enriched);
});

router.post("/time-entries", async (req, res): Promise<void> => {
  const parsed = CreateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.hours < 0 || parsed.data.hours > 24) {
    res.status(400).json({ error: "Hours must be between 0 and 24" });
    return;
  }

  const projectRoleId =
    typeof (req.body as Record<string, unknown>).projectRoleId === "number"
      ? ((req.body as Record<string, unknown>).projectRoleId as number)
      : null;

  const [entry] = await db
    .insert(timeEntriesTable)
    .values({
      employeeId: parsed.data.employeeId,
      projectId: parsed.data.projectId,
      projectRoleId,
      entryDate: parsed.data.entryDate.toISOString().split("T")[0],
      hours: parsed.data.hours,
      note: parsed.data.note ?? null,
    })
    .returning();

  const [enriched] = await enrichEntries([entry]);
  res.status(201).json(enriched);
});

router.post("/time-entries/bulk", async (req, res): Promise<void> => {
  const parsed = BulkUpsertTimeEntriesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // ── Bookability validation ────────────────────────────────────────────────
  // Reject entries with hours > 0 on non-bookable days (0-hour entries are
  // deletions and are always allowed through).
  const empIds = [...new Set(parsed.data.entries.map((e) => e.employeeId))];

  const employees = await db
    .select()
    .from(employeesTable)
    .where(inArray(employeesTable.id, empIds));
  const empMap = new Map(employees.map((e) => [e.id, e]));

  // Fetch all holidays grouped by calendar code
  const calendarCodes = [
    ...new Set(employees.flatMap((e) => (e.holidayCalendarCode ? [e.holidayCalendarCode] : []))),
  ];
  const calendarCodeToHolidays = new Map<string, Set<string>>();

  if (calendarCodes.length > 0) {
    const rows = await db
      .select({
        calendarCode: holidayCalendarsTable.code,
        date: holidaysTable.date,
      })
      .from(holidaysTable)
      .innerJoin(holidayCalendarsTable, eq(holidaysTable.calendarId, holidayCalendarsTable.id))
      .where(inArray(holidayCalendarsTable.code, calendarCodes));

    for (const row of rows) {
      if (!calendarCodeToHolidays.has(row.calendarCode)) {
        calendarCodeToHolidays.set(row.calendarCode, new Set());
      }
      calendarCodeToHolidays.get(row.calendarCode)!.add(String(row.date).slice(0, 10));
    }
  }

  // Fetch vacations for all involved employees
  const vacations = await db
    .select()
    .from(employeeVacationsTable)
    .where(inArray(employeeVacationsTable.employeeId, empIds));
  const vacationsByEmp = new Map<number, { startDate: string; endDate: string }[]>();
  for (const v of vacations) {
    if (!vacationsByEmp.has(v.employeeId)) vacationsByEmp.set(v.employeeId, []);
    vacationsByEmp.get(v.employeeId)!.push({ startDate: v.startDate, endDate: v.endDate });
  }

  // Validate each entry
  const rejections: { employeeId: number; entryDate: string; reason: string }[] = [];

  for (const item of parsed.data.entries) {
    if (item.hours === 0) continue; // 0-hour = delete existing, always allowed

    // zod.coerce.date() turns "YYYY-MM-DD" into a Date object; use toISOString() to get
    // back the canonical ISO date string rather than the locale-dependent String() output.
    const dateStr = (item.entryDate instanceof Date
      ? item.entryDate.toISOString()
      : String(item.entryDate)
    ).slice(0, 10);
    const emp = empMap.get(item.employeeId);
    if (!emp) {
      rejections.push({ employeeId: item.employeeId, entryDate: dateStr, reason: "Employee not found" });
      continue;
    }

    // Working day mask: index 0=Mon … 6=Sun
    const mask = emp.workingDaysMask.split(",").map(Number);
    const utcDay = new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
    const maskIdx = utcDay === 0 ? 6 : utcDay - 1;
    if (!mask[maskIdx]) {
      rejections.push({ employeeId: item.employeeId, entryDate: dateStr, reason: "Non-working day" });
      continue;
    }

    if (emp.contractStartDate && dateStr < emp.contractStartDate) {
      rejections.push({ employeeId: item.employeeId, entryDate: dateStr, reason: "Before contract start date" });
      continue;
    }
    if (emp.contractEndDate && dateStr > emp.contractEndDate) {
      rejections.push({ employeeId: item.employeeId, entryDate: dateStr, reason: "After contract end date" });
      continue;
    }

    if (emp.holidayCalendarCode) {
      const holidayDates = calendarCodeToHolidays.get(emp.holidayCalendarCode);
      if (holidayDates?.has(dateStr)) {
        rejections.push({ employeeId: item.employeeId, entryDate: dateStr, reason: "Public holiday" });
        continue;
      }
    }

    const empVacations = vacationsByEmp.get(item.employeeId) ?? [];
    if (empVacations.some((v) => v.startDate <= dateStr && dateStr <= v.endDate)) {
      rejections.push({ employeeId: item.employeeId, entryDate: dateStr, reason: "Vacation / absence" });
      continue;
    }
  }

  if (rejections.length > 0) {
    res.status(422).json({ error: "Some entries are on non-bookable days", rejections });
    return;
  }
  // ── End validation ─────────────────────────────────────────────────────────

  // Extract raw projectRoleId values from the un-validated body entries (nullable integers)
  const rawEntries: unknown[] = Array.isArray((req.body as Record<string, unknown>).entries)
    ? ((req.body as Record<string, unknown>).entries as unknown[])
    : [];
  const rawRoleIds: (number | null)[] = rawEntries.map((e) => {
    const rid = (e as Record<string, unknown>).projectRoleId;
    return typeof rid === "number" ? rid : null;
  });

  const results: (typeof timeEntriesTable.$inferSelect)[] = [];

  for (let i = 0; i < parsed.data.entries.length; i++) {
    const item = parsed.data.entries[i];
    const projectRoleId = rawRoleIds[i] ?? null;
    if (item.hours < 0 || item.hours > 24) continue;

    // Normalize entry date to YYYY-MM-DD string (Zod coerce.date() produces a Date object)
    const isoDate = (item.entryDate instanceof Date
      ? item.entryDate.toISOString()
      : String(item.entryDate)
    ).slice(0, 10);

    // Find existing entry for same employee/project/role/date
    const roleCondition = projectRoleId != null
      ? eq(timeEntriesTable.projectRoleId, projectRoleId)
      : isNull(timeEntriesTable.projectRoleId);

    const [existing] = await db
      .select()
      .from(timeEntriesTable)
      .where(
        and(
          eq(timeEntriesTable.employeeId, item.employeeId),
          eq(timeEntriesTable.projectId, item.projectId),
          roleCondition,
          eq(timeEntriesTable.entryDate, isoDate)
        )
      );

    if (existing) {
      if (item.hours === 0) {
        // Delete zero-hour entries
        await db.delete(timeEntriesTable).where(eq(timeEntriesTable.id, existing.id));
      } else {
        const [updated] = await db
          .update(timeEntriesTable)
          .set({ hours: item.hours, note: item.note ?? existing.note })
          .where(eq(timeEntriesTable.id, existing.id))
          .returning();
        results.push(updated);
      }
    } else if (item.hours > 0) {
      const [created] = await db
        .insert(timeEntriesTable)
        .values({
          employeeId: item.employeeId,
          projectId: item.projectId,
          projectRoleId,
          entryDate: isoDate,
          hours: item.hours,
          note: item.note ?? null,
        })
        .returning();
      results.push(created);
    }
  }

  const enriched = await enrichEntries(results);
  res.json(enriched);
});

router.get("/time-entries/:id", async (req, res): Promise<void> => {
  const params = GetTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [entry] = await db
    .select()
    .from(timeEntriesTable)
    .where(eq(timeEntriesTable.id, params.data.id));

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const [enriched] = await enrichEntries([entry]);
  res.json(enriched);
});

router.patch("/time-entries/:id", async (req, res): Promise<void> => {
  const params = UpdateTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateTimeEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.hours !== undefined && (parsed.data.hours < 0 || parsed.data.hours > 24)) {
    res.status(400).json({ error: "Hours must be between 0 and 24" });
    return;
  }

  const rawBody = req.body as Record<string, unknown>;
  const projectRoleIdPatch = "projectRoleId" in rawBody
    ? (typeof rawBody.projectRoleId === "number" ? rawBody.projectRoleId : null)
    : undefined;

  const { entryDate, projectRoleId: _prid, ...rest } = parsed.data;
  const [entry] = await db
    .update(timeEntriesTable)
    .set({
      ...rest,
      ...(entryDate ? { entryDate: entryDate.toISOString().split("T")[0] } : {}),
      ...(projectRoleIdPatch !== undefined ? { projectRoleId: projectRoleIdPatch } : {}),
    })
    .where(eq(timeEntriesTable.id, params.data.id))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  const [enriched] = await enrichEntries([entry]);
  res.json(enriched);
});

router.delete("/time-entries/:id", async (req, res): Promise<void> => {
  const params = DeleteTimeEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [entry] = await db
    .delete(timeEntriesTable)
    .where(eq(timeEntriesTable.id, params.data.id))
    .returning();

  if (!entry) {
    res.status(404).json({ error: "Time entry not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
