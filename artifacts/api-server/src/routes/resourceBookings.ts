import { Router, type IRouter } from "express";
import { eq, and, gte, lte, lt, sql, isNull, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  resourceBookingsTable,
  employeesTable,
  projectsTable,
  clientsTable,
  projectRolesTable,
  timeEntriesTable,
} from "@workspace/db";
import { resolveProjectColor } from "@workspace/api-zod";
import { fetchEmpAvailabilityMap } from "../lib/employee-availability";
import { calcDayHours } from "../lib/booking-hours";

const router: IRouter = Router();

// ── Shared SELECT query ───────────────────────────────────────────────────────
function buildSelect() {
  return db
    .select({
      id: resourceBookingsTable.id,
      employeeId: resourceBookingsTable.employeeId,
      projectId: resourceBookingsTable.projectId,
      projectRoleId: resourceBookingsTable.projectRoleId,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
      weekdayHours: resourceBookingsTable.weekdayHours,
      notes: resourceBookingsTable.notes,
      status: resourceBookingsTable.status,
      pastReleasedAt: resourceBookingsTable.pastReleasedAt,
      createdAt: resourceBookingsTable.createdAt,
      updatedAt: resourceBookingsTable.updatedAt,
      employeeName: employeesTable.name,
      employeeEmail: employeesTable.email,
      weeklyCapacityHours: employeesTable.weeklyCapacityHours,
      projectName: projectsTable.name,
      projectColor: projectsTable.color,
      clientName: clientsTable.name,
      projectRoleName: projectRolesTable.name,
      dayRate: projectRolesTable.dayRate,
    })
    .from(resourceBookingsTable)
    .innerJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .innerJoin(projectsTable, eq(resourceBookingsTable.projectId, projectsTable.id))
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .leftJoin(projectRolesTable, eq(resourceBookingsTable.projectRoleId, projectRolesTable.id));
}

function enrichRow(row: Awaited<ReturnType<typeof buildSelect>>[number]) {
  const { employeeEmail: _email, ...rest } = row;
  return {
    ...rest,
    pastReleasedAt: rest.pastReleasedAt ? rest.pastReleasedAt.toISOString() : null,
    projectColor: resolveProjectColor(row.projectId, row.projectColor),
  };
}

// ── GET /resource-bookings ────────────────────────────────────────────────────
router.get("/resource-bookings", async (req, res): Promise<void> => {
  const { employeeId, startDate, endDate } = req.query as Record<string, string | undefined>;

  const conditions = [];
  if (employeeId) {
    const empId = parseInt(employeeId, 10);
    if (!isNaN(empId)) conditions.push(eq(resourceBookingsTable.employeeId, empId));
  }
  if (startDate) conditions.push(gte(resourceBookingsTable.endDate, startDate));
  if (endDate) conditions.push(lte(resourceBookingsTable.startDate, endDate));

  const rows = await buildSelect()
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(resourceBookingsTable.startDate);

  res.json(rows.map(enrichRow));
});

// ── Validation schema ─────────────────────────────────────────────────────────
const WEEKDAY_KEYS = ["1", "2", "3", "4", "5"] as const;

const WeekdayHoursSchema = z
  .record(z.string(), z.number().min(0).max(24))
  .refine(
    (obj) => obj != null && Object.keys(obj).every((k) => WEEKDAY_KEYS.includes(k as typeof WEEKDAY_KEYS[number])),
    { message: "weekdayHours keys must be ISO weekday strings '1' (Mon) through '5' (Fri)" },
  )
  .nullable()
  .optional();

const BookingBodySchema = z.object({
  employeeId: z.number().int().positive(),
  projectId: z.number().int().positive(),
  projectRoleId: z.number().int().positive().nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hoursPerDay: z.number().min(0).optional(),
  weekdayHours: WeekdayHoursSchema,
  notes: z.string().optional().nullable(),
  status: z.enum(["tentative", "confirmed"]).nullable().optional(),
});

/** Resolve effective hoursPerDay from input: weekday sum÷5 or flat value. */
function resolveHoursPerDay(
  hoursPerDay: number | undefined,
  weekdayHours: Record<string, number> | null | undefined,
): number {
  if (weekdayHours != null) {
    const sum = Object.values(weekdayHours).reduce((a, b) => a + b, 0);
    return sum / 5;
  }
  return hoursPerDay ?? 0;
}

// ── POST /resource-bookings ───────────────────────────────────────────────────
router.post("/resource-bookings", async (req, res): Promise<void> => {
  const parsed = BookingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const { employeeId, projectId, projectRoleId, startDate, endDate, notes, status } = parsed.data;
  const weekdayHours = parsed.data.weekdayHours ?? null;

  if (weekdayHours == null && parsed.data.hoursPerDay == null) {
    res.status(400).json({ error: "Either hoursPerDay or weekdayHours must be provided" });
    return;
  }

  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  const hoursPerDay = resolveHoursPerDay(parsed.data.hoursPerDay, weekdayHours);

  const [inserted] = await db
    .insert(resourceBookingsTable)
    .values({
      employeeId,
      projectId,
      projectRoleId: projectRoleId ?? null,
      startDate,
      endDate,
      hoursPerDay,
      weekdayHours: weekdayHours ?? undefined,
      notes: notes ?? null,
      status: status ?? null,
    })
    .returning({ id: resourceBookingsTable.id });

  const rows = await buildSelect().where(eq(resourceBookingsTable.id, inserted.id));
  if (rows.length === 0) { res.status(500).json({ error: "Failed to retrieve created booking" }); return; }

  const enriched = enrichRow(rows[0]);

  void (async () => {
    try {
      await db.execute(
        sql`INSERT INTO notification_queue
              (booking_id, employee_email, employee_name, project_name, role_name,
               start_date, end_date, hours_per_day, send_after, sent, updated_at)
            VALUES
              (${enriched.id}, ${rows[0].employeeEmail}, ${rows[0].employeeName}, ${rows[0].projectName},
               ${rows[0].projectRoleName ?? null},
               ${rows[0].startDate}, ${rows[0].endDate}, ${rows[0].hoursPerDay},
               NOW() + INTERVAL '30 minutes', FALSE, NOW())
            ON CONFLICT (employee_email, project_name, booking_id) DO UPDATE
              SET employee_name  = EXCLUDED.employee_name,
                  role_name      = EXCLUDED.role_name,
                  start_date     = EXCLUDED.start_date,
                  end_date       = EXCLUDED.end_date,
                  hours_per_day  = EXCLUDED.hours_per_day,
                  send_after     = NOW() + INTERVAL '30 minutes',
                  sent           = FALSE,
                  updated_at     = NOW()`
      );
    } catch (err) {
      req.log.error({ err }, "notification_queue upsert failed (create booking)");
    }
  })();

  res.status(201).json(enriched);
});

// ── POST /resource-bookings/release-past-bulk ─────────────────────────────────
// Must be registered BEFORE /:id routes to avoid conflict.
router.post("/resource-bookings/release-past-bulk", async (req, res): Promise<void> => {
  const { projectId, employeeId, dryRun } = req.body as {
    projectId?: number;
    employeeId?: number;
    dryRun?: boolean;
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  // Find bookings with pastReleasedAt IS NULL that have at least one past day
  const conditions: ReturnType<typeof eq>[] = [
    isNull(resourceBookingsTable.pastReleasedAt),
  ];
  if (projectId) conditions.push(eq(resourceBookingsTable.projectId, projectId));
  if (employeeId) conditions.push(eq(resourceBookingsTable.employeeId, employeeId));

  const candidateRows = await db
    .select({
      id: resourceBookingsTable.id,
      employeeId: resourceBookingsTable.employeeId,
      projectId: resourceBookingsTable.projectId,
      projectRoleId: resourceBookingsTable.projectRoleId,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
      weekdayHours: resourceBookingsTable.weekdayHours,
      employeeName: employeesTable.name,
      projectName: projectsTable.name,
      projectRoleName: projectRolesTable.name,
    })
    .from(resourceBookingsTable)
    .innerJoin(employeesTable, eq(resourceBookingsTable.employeeId, employeesTable.id))
    .innerJoin(projectsTable, eq(resourceBookingsTable.projectId, projectsTable.id))
    .leftJoin(projectRolesTable, eq(resourceBookingsTable.projectRoleId, projectRolesTable.id))
    .where(and(...conditions));

  if (candidateRows.length === 0) {
    res.json({ released: [] });
    return;
  }

  // Fetch availability for all employees in the past period
  const uniqueEmpIds = [...new Set(candidateRows.map((r) => r.employeeId))];
  const periodStart = candidateRows.reduce((m, b) => (b.startDate < m ? b.startDate : m), candidateRows[0].startDate);
  const empRows = await db.select().from(employeesTable).where(inArray(employeesTable.id, uniqueEmpIds));
  const availMap = await fetchEmpAvailabilityMap(empRows, periodStart, todayStr);

  // Batch-fetch actual logged hours for past dates across all candidate bookings
  // Keyed by "employeeId:projectId:roleId:YYYY-MM-DD"
  const uniqueProjectIds = [...new Set(candidateRows.map((r) => r.projectId))];
  const loggedEntries = await db
    .select({
      employeeId: timeEntriesTable.employeeId,
      projectId: timeEntriesTable.projectId,
      projectRoleId: timeEntriesTable.projectRoleId,
      entryDate: timeEntriesTable.entryDate,
      hours: timeEntriesTable.hours,
    })
    .from(timeEntriesTable)
    .where(
      and(
        inArray(timeEntriesTable.employeeId, uniqueEmpIds),
        inArray(timeEntriesTable.projectId, uniqueProjectIds),
        gte(timeEntriesTable.entryDate, periodStart),
        lt(timeEntriesTable.entryDate, todayStr),
      )
    );

  // Build a lookup: "empId:projectId:roleId:date" → hours
  const loggedMap = new Map<string, number>();
  for (const e of loggedEntries) {
    const roleKey = e.projectRoleId == null ? "null" : String(e.projectRoleId);
    const key = `${e.employeeId}:${e.projectId}:${roleKey}:${e.entryDate}`;
    loggedMap.set(key, (loggedMap.get(key) ?? 0) + e.hours);
  }

  // Compute past undelivered hours per booking (planned - logged, clamped at 0 per day)
  const toRelease: Array<(typeof candidateRows)[number] & { pastUndeliveredDays: number }> = [];
  for (const b of candidateRows) {
    if (b.startDate >= todayStr) continue; // fully future booking — skip
    const avail = availMap.get(b.employeeId);
    const holidaySet = new Set(avail?.holidayDates ?? []);
    const vacationSet = avail?.vacationDateSet ?? new Set<string>();
    const compDaySet = avail?.compDayDateSet ?? new Set<string>();
    const wh = b.weekdayHours as Record<string, number> | null;
    const roleKey = b.projectRoleId == null ? "null" : String(b.projectRoleId);

    let pastUndeliveredHours = 0;
    const d = new Date(b.startDate + "T00:00:00Z");
    const end = new Date(Math.min(
      new Date(b.endDate + "T00:00:00Z").getTime(),
      new Date(todayStr + "T00:00:00Z").getTime() - 86400000, // strictly before today
    ));
    while (d <= end) {
      const dateStr = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      const plannedH = calcDayHours(dow, dateStr, b.hoursPerDay, wh, holidaySet, vacationSet, compDaySet);
      const loggedH = loggedMap.get(`${b.employeeId}:${b.projectId}:${roleKey}:${dateStr}`) ?? 0;
      const undeliveredH = Math.max(0, plannedH - loggedH);
      pastUndeliveredHours += undeliveredH;
      d.setUTCDate(d.getUTCDate() + 1);
    }

    if (pastUndeliveredHours > 0) {
      toRelease.push({ ...b, pastUndeliveredDays: Math.round((pastUndeliveredHours / 8) * 100) / 100 });
    }
  }

  if (toRelease.length === 0) {
    res.json({ released: [] });
    return;
  }

  // dryRun=true: return preview without writing to DB
  if (dryRun) {
    res.json({
      released: toRelease.map((b) => ({
        id: b.id,
        employeeId: b.employeeId,
        employeeName: b.employeeName,
        projectId: b.projectId,
        projectName: b.projectName,
        projectRoleId: b.projectRoleId,
        projectRoleName: b.projectRoleName,
        startDate: b.startDate,
        endDate: b.endDate,
        pastReleasedAt: null,
        pastUndeliveredDays: b.pastUndeliveredDays,
      })),
    });
    return;
  }

  const now = new Date();
  const ids = toRelease.map((r) => r.id);
  await db
    .update(resourceBookingsTable)
    .set({ pastReleasedAt: now })
    .where(inArray(resourceBookingsTable.id, ids));

  res.json({
    released: toRelease.map((b) => ({
      id: b.id,
      employeeId: b.employeeId,
      employeeName: b.employeeName,
      projectId: b.projectId,
      projectName: b.projectName,
      projectRoleId: b.projectRoleId,
      projectRoleName: b.projectRoleName,
      startDate: b.startDate,
      endDate: b.endDate,
      pastReleasedAt: now.toISOString(),
      pastUndeliveredDays: b.pastUndeliveredDays,
    })),
  });
});

// ── PUT /resource-bookings/:id ────────────────────────────────────────────────
router.put("/resource-bookings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const parsed = BookingBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const { employeeId, projectId, projectRoleId, startDate, endDate, notes, status } = parsed.data;
  const weekdayHours = parsed.data.weekdayHours ?? null;

  if (weekdayHours == null && parsed.data.hoursPerDay == null) {
    res.status(400).json({ error: "Either hoursPerDay or weekdayHours must be provided" });
    return;
  }

  if (startDate > endDate) {
    res.status(400).json({ error: "startDate must be on or before endDate" });
    return;
  }

  const hoursPerDay = resolveHoursPerDay(parsed.data.hoursPerDay, weekdayHours);

  const result = await db
    .update(resourceBookingsTable)
    .set({
      employeeId,
      projectId,
      projectRoleId: projectRoleId ?? null,
      startDate,
      endDate,
      hoursPerDay,
      weekdayHours: weekdayHours ?? null,
      notes: notes ?? null,
      status: status !== undefined ? (status ?? null) : undefined,
    })
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  const rows = await buildSelect().where(eq(resourceBookingsTable.id, id));
  if (rows.length === 0) { res.status(500).json({ error: "Failed to retrieve updated booking" }); return; }

  void (async () => {
    try {
      await db.execute(
        sql`INSERT INTO notification_queue
              (booking_id, employee_email, employee_name, project_name, role_name,
               start_date, end_date, hours_per_day, send_after, sent, updated_at)
            VALUES
              (${id}, ${rows[0].employeeEmail}, ${rows[0].employeeName}, ${rows[0].projectName},
               ${rows[0].projectRoleName ?? null},
               ${rows[0].startDate}, ${rows[0].endDate}, ${rows[0].hoursPerDay},
               NOW() + INTERVAL '30 minutes', FALSE, NOW())
            ON CONFLICT (employee_email, project_name, booking_id) DO UPDATE
              SET employee_name  = EXCLUDED.employee_name,
                  role_name      = EXCLUDED.role_name,
                  start_date     = EXCLUDED.start_date,
                  end_date       = EXCLUDED.end_date,
                  hours_per_day  = EXCLUDED.hours_per_day,
                  send_after     = NOW() + INTERVAL '30 minutes',
                  sent           = FALSE,
                  updated_at     = NOW()`
      );
    } catch (err) {
      req.log.error({ err }, "notification_queue upsert failed (update booking)");
    }
  })();

  res.json(enrichRow(rows[0]));
});

// ── GET /resource-bookings/:id/past-undelivered ───────────────────────────────
// Returns the exact past undelivered days for a single booking (planned minus logged).
// Must be registered BEFORE the generic /:id GET to take priority.
router.get("/resource-bookings/:id/past-undelivered", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const rows = await db
    .select({
      employeeId: resourceBookingsTable.employeeId,
      projectId: resourceBookingsTable.projectId,
      projectRoleId: resourceBookingsTable.projectRoleId,
      startDate: resourceBookingsTable.startDate,
      endDate: resourceBookingsTable.endDate,
      hoursPerDay: resourceBookingsTable.hoursPerDay,
      weekdayHours: resourceBookingsTable.weekdayHours,
      pastReleasedAt: resourceBookingsTable.pastReleasedAt,
    })
    .from(resourceBookingsTable)
    .where(eq(resourceBookingsTable.id, id));

  if (rows.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }
  const b = rows[0];

  // Released — the write-off is frozen at the RELEASE DATE: only days before
  // it stay forgiven; misses after the release count as undelivered again.
  if (b.pastReleasedAt) {
    const releasedUpTo = b.pastReleasedAt.toISOString().slice(0, 10);
    if (b.endDate < releasedUpTo) {
      res.json({ pastUndeliveredDays: 0 });
      return;
    }
    if (b.startDate < releasedUpTo) b.startDate = releasedUpTo;
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (b.startDate >= todayStr) {
    // Fully future booking
    res.json({ pastUndeliveredDays: 0 });
    return;
  }

  // Fetch employee availability for the past range
  const empRows = await db.select().from(employeesTable).where(eq(employeesTable.id, b.employeeId));
  const pastEnd = b.endDate < todayStr ? b.endDate : todayStr;
  const availMap = await fetchEmpAvailabilityMap(empRows, b.startDate, pastEnd);
  const avail = availMap.get(b.employeeId);
  const holidaySet = new Set(avail?.holidayDates ?? []);
  const vacationSet = avail?.vacationDateSet ?? new Set<string>();
  const compDaySet = avail?.compDayDateSet ?? new Set<string>();

  // Fetch logged hours for this booking's employee+project+role within past range
  const loggedEntries = await db
    .select({
      entryDate: timeEntriesTable.entryDate,
      hours: timeEntriesTable.hours,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.employeeId, b.employeeId),
        eq(timeEntriesTable.projectId, b.projectId),
        b.projectRoleId != null
          ? eq(timeEntriesTable.projectRoleId, b.projectRoleId)
          : isNull(timeEntriesTable.projectRoleId),
        gte(timeEntriesTable.entryDate, b.startDate),
        lt(timeEntriesTable.entryDate, todayStr),
      )
    );

  const loggedByDate = new Map<string, number>();
  for (const e of loggedEntries) {
    const d = typeof e.entryDate === "string" ? e.entryDate : (e.entryDate as Date).toISOString().slice(0, 10);
    loggedByDate.set(d, (loggedByDate.get(d) ?? 0) + Number(e.hours));
  }

  // Sum past undelivered hours day by day
  const wh = b.weekdayHours as Record<string, number> | null;
  let pastUndeliveredHours = 0;
  const d = new Date(b.startDate + "T00:00:00Z");
  const end = new Date(Math.min(
    new Date(b.endDate + "T00:00:00Z").getTime(),
    new Date(todayStr + "T00:00:00Z").getTime() - 86400000,
  ));
  while (d <= end) {
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const plannedH = calcDayHours(dow, dateStr, b.hoursPerDay, wh, holidaySet, vacationSet, compDaySet);
    const loggedH = loggedByDate.get(dateStr) ?? 0;
    pastUndeliveredHours += Math.max(0, plannedH - loggedH);
    d.setUTCDate(d.getUTCDate() + 1);
  }

  res.json({ pastUndeliveredDays: Math.round((pastUndeliveredHours / 8) * 100) / 100 });
});

// ── POST /resource-bookings/:id/release-past ──────────────────────────────────
router.post("/resource-bookings/:id/release-past", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const now = new Date();
  const result = await db
    .update(resourceBookingsTable)
    .set({ pastReleasedAt: now })
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  const rows = await buildSelect().where(eq(resourceBookingsTable.id, id));
  if (rows.length === 0) { res.status(500).json({ error: "Failed to retrieve booking" }); return; }

  res.json(enrichRow(rows[0]));
});

// ── POST /resource-bookings/:id/unrelease ─────────────────────────────────────
router.post("/resource-bookings/:id/unrelease", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const result = await db
    .update(resourceBookingsTable)
    .set({ pastReleasedAt: null })
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  const rows = await buildSelect().where(eq(resourceBookingsTable.id, id));
  if (rows.length === 0) { res.status(500).json({ error: "Failed to retrieve booking" }); return; }

  res.json(enrichRow(rows[0]));
});

// ── DELETE /resource-bookings/:id ─────────────────────────────────────────────
router.delete("/resource-bookings/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid booking id" }); return; }

  const preRows = await buildSelect().where(eq(resourceBookingsTable.id, id));
  if (preRows.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  const { employeeEmail, projectName } = preRows[0];

  const result = await db
    .delete(resourceBookingsTable)
    .where(eq(resourceBookingsTable.id, id))
    .returning({ id: resourceBookingsTable.id });

  if (result.length === 0) { res.status(404).json({ error: "Booking not found" }); return; }

  void (async () => {
    try {
      const deleted = await db.execute(
        sql`DELETE FROM notification_queue
            WHERE booking_id     = ${id}
              AND employee_email = ${employeeEmail}
              AND project_name   = ${projectName}
              AND sent           = FALSE`
      );
      const count = (deleted as { rowCount?: number }).rowCount ?? 0;
      if (count === 0) {
        req.log.info(
          { employeeEmail, projectName, bookingId: id },
          "notification_queue: row already sent or not found — no cleanup needed"
        );
      }
    } catch (err) {
      req.log.error({ err }, "notification_queue cleanup failed (delete booking)");
    }
  })();

  res.json({ success: true });
});

export default router;
