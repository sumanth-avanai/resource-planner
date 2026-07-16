/**
 * Vacation / Absence CRUD routes.
 *
 * GET    /api/vacations?employeeId=X
 * POST   /api/vacations
 * PATCH  /api/vacations/:id
 * DELETE /api/vacations/:id
 */

import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, employeeVacationsTable, employeesTable } from "@workspace/db";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TYPES = ["vacation", "sick", "unpaid_leave", "other"] as const;
type VacationType = typeof VALID_TYPES[number];

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s);
}

function isValidType(t: unknown): t is VacationType {
  return typeof t === "string" && (VALID_TYPES as readonly string[]).includes(t);
}

router.get("/vacations", async (req, res): Promise<void> => {
  const empIdRaw = req.query.employeeId;
  const employeeId = empIdRaw ? parseInt(String(empIdRaw), 10) : undefined;

  const rows = await db
    .select()
    .from(employeeVacationsTable)
    .where(
      employeeId && !isNaN(employeeId)
        ? eq(employeeVacationsTable.employeeId, employeeId)
        : undefined
    )
    .orderBy(desc(employeeVacationsTable.startDate));

  res.json(rows);
});

router.post("/vacations", async (req, res): Promise<void> => {
  const { employeeId, startDate, endDate, vacationType, note } = req.body ?? {};

  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(400).json({ error: "employeeId must be a positive integer" });
    return;
  }
  if (!isValidDate(startDate)) {
    res.status(400).json({ error: "startDate must be YYYY-MM-DD" });
    return;
  }
  if (!isValidDate(endDate)) {
    res.status(400).json({ error: "endDate must be YYYY-MM-DD" });
    return;
  }
  if (endDate < startDate) {
    res.status(400).json({ error: "endDate must be >= startDate" });
    return;
  }
  const type: VacationType = isValidType(vacationType) ? vacationType : "vacation";

  const [emp] = await db
    .select({ id: employeesTable.id })
    .from(employeesTable)
    .where(eq(employeesTable.id, employeeId));

  if (!emp) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }

  const [row] = await db
    .insert(employeeVacationsTable)
    .values({
      employeeId,
      startDate,
      endDate,
      vacationType: type,
      note: typeof note === "string" ? note || null : null,
    })
    .returning();

  res.status(201).json(row);
});

router.patch("/vacations/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(employeeVacationsTable)
    .where(eq(employeeVacationsTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Vacation entry not found" });
    return;
  }

  const { startDate, endDate, vacationType, note } = req.body ?? {};

  const patch: Partial<typeof existing> = {};

  if (startDate !== undefined) {
    if (!isValidDate(startDate)) { res.status(400).json({ error: "startDate must be YYYY-MM-DD" }); return; }
    (patch as any).startDate = startDate;
  }
  if (endDate !== undefined) {
    if (!isValidDate(endDate)) { res.status(400).json({ error: "endDate must be YYYY-MM-DD" }); return; }
    (patch as any).endDate = endDate;
  }
  if (vacationType !== undefined) {
    if (!isValidType(vacationType)) { res.status(400).json({ error: "Invalid vacationType" }); return; }
    (patch as any).vacationType = vacationType;
  }
  if (note !== undefined) {
    (patch as any).note = typeof note === "string" ? note || null : null;
  }

  const merged = { ...existing, ...patch };
  if (merged.endDate < merged.startDate) {
    res.status(400).json({ error: "endDate must be >= startDate" });
    return;
  }

  const [updated] = await db
    .update(employeeVacationsTable)
    .set(patch)
    .where(eq(employeeVacationsTable.id, id))
    .returning();

  res.json(updated);
});

router.delete("/vacations/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [deleted] = await db
    .delete(employeeVacationsTable)
    .where(eq(employeeVacationsTable.id, id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Vacation entry not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
