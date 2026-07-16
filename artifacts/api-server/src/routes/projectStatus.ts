/**
 * GET   /api/project-status                                — overview list
 * GET   /api/project-status/:projectId                    — detail
 * POST  /api/project-status/:projectId/health-updates     — create health update
 * PATCH /api/project-status/:projectId/next-steps         — persist checklist state
 */

import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  projectsTable,
  clientsTable,
  projectHealthUpdatesTable,
  timeEntriesTable,
  projectRolesTable,
  resourceBookingsTable,
} from "@workspace/db";

const router: IRouter = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Global update cadence in days. A project whose last health update is older
 * than this is flagged as "update overdue".
 * TODO: make this configurable per-project or as an app-wide setting (#235).
 */
const UPDATE_CADENCE_DAYS = 14;

/**
 * Budget alert threshold: flag a project when loggedTotal / budgetTotal
 * reaches this ratio (Invoiced + Logged combined).
 * TODO: make this configurable per-project (#236).
 */
const BUDGET_ALERT_THRESHOLD = 0.9;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Days between two dates (a - b), rounded down. */
function daysBetween(a: Date, b: Date) {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

// ── GET /api/project-status ───────────────────────────────────────────────────

router.get("/project-status", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id:                 projectsTable.id,
      name:               projectsTable.name,
      color:              projectsTable.color,
      clientName:         clientsTable.name,
      pmName:             projectsTable.pmName,
      generalStatus:      projectsTable.generalStatus,
      riskLevel:          projectsTable.riskLevel,
      clientSatisfaction: projectsTable.clientSatisfaction,
      latestUpdateAt: sql<string | null>`(
        SELECT to_char(phu.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        FROM project_health_updates phu
        WHERE phu.project_id = ${projectsTable.id}
        ORDER BY phu.created_at DESC
        LIMIT 1
      )`,
      // backward-compat: most recent comment text
      latestComment: sql<string | null>`(
        SELECT phu.comment
        FROM project_health_updates phu
        WHERE phu.project_id = ${projectsTable.id}
          AND phu.comment IS NOT NULL
          AND phu.comment <> ''
        ORDER BY phu.created_at DESC
        LIMIT 1
      )`,
      latestRisk: sql<string | null>`(
        SELECT phu.risk_level
        FROM project_health_updates phu
        WHERE phu.project_id = ${projectsTable.id}
        ORDER BY phu.created_at DESC
        LIMIT 1
      )`,
      prevRisk: sql<string | null>`(
        SELECT phu.risk_level
        FROM project_health_updates phu
        WHERE phu.project_id = ${projectsTable.id}
        ORDER BY phu.created_at DESC
        LIMIT 1 OFFSET 1
      )`,
      budgetTotal: sql<number | null>`(
        SELECT SUM(pr.budgeted_days * pr.day_rate)
        FROM project_roles pr
        WHERE pr.project_id = ${projectsTable.id}
          AND pr.budgeted_days IS NOT NULL
          AND pr.day_rate IS NOT NULL
      )`,
      budgetConsumed: sql<number | null>`(
        SELECT SUM((te.hours / 8.0) * pr.day_rate)
        FROM time_entries te
        JOIN project_roles pr ON pr.id = te.project_role_id
        WHERE te.project_id = ${projectsTable.id}
          AND pr.day_rate IS NOT NULL
      )`,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .orderBy(projectsTable.name);

  const now = new Date();

  const result = rows.map((r) => {
    const budgetPct =
      r.budgetTotal && r.budgetTotal > 0 && r.budgetConsumed != null
        ? r.budgetConsumed / r.budgetTotal
        : null;
    const budgetAlert   = budgetPct != null && budgetPct >= BUDGET_ALERT_THRESHOLD;
    const budgetProgress = budgetPct != null ? Math.round(budgetPct * 1000) / 10 : null;

    const lastUpdate    = r.latestUpdateAt ? new Date(r.latestUpdateAt) : null;
    const lastUpdateAge = lastUpdate ? daysBetween(now, lastUpdate) : null;
    const updateOverdue = !lastUpdate || lastUpdateAge! >= UPDATE_CADENCE_DAYS;

    const needsAttention = r.riskLevel === "high" || budgetAlert;

    const RISK_NUM: Record<string, number> = { low: 0, medium: 1, high: 2 };
    let trendDirection: "up" | "down" | "stable" | null = null;
    if (r.latestRisk && r.prevRisk) {
      const diff = (RISK_NUM[r.latestRisk] ?? 0) - (RISK_NUM[r.prevRisk] ?? 0);
      trendDirection = diff > 0 ? "up" : diff < 0 ? "down" : "stable";
    }

    return {
      id:                 r.id,
      name:               r.name,
      color:              r.color,
      clientName:         r.clientName,
      pmName:             r.pmName,
      generalStatus:      r.generalStatus,
      riskLevel:          r.riskLevel,
      clientSatisfaction: r.clientSatisfaction,
      latestUpdateAt:     r.latestUpdateAt,
      latestComment:      r.latestComment,     // backward-compat
      budgetTotal:        r.budgetTotal,
      budgetConsumed:     r.budgetConsumed,
      budgetProgress,
      trendDirection,
      updateOverdue,
      lastUpdateAge,
      budgetAlert,
      needsAttention,
    };
  });

  res.json(result);
});

// ── GET /api/project-status/:projectId ───────────────────────────────────────

router.get("/project-status/:projectId", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db
    .select({
      id:                 projectsTable.id,
      name:               projectsTable.name,
      color:              projectsTable.color,
      clientId:           projectsTable.clientId,
      clientName:         clientsTable.name,
      pmName:             projectsTable.pmName,
      startDate:          projectsTable.startDate,
      endDate:            projectsTable.endDate,
      generalStatus:      projectsTable.generalStatus,
      riskLevel:          projectsTable.riskLevel,
      clientSatisfaction: projectsTable.clientSatisfaction,
      nextSteps:          projectsTable.nextSteps,
      budgetTotal: sql<number | null>`(
        SELECT SUM(pr.budgeted_days * pr.day_rate)
        FROM project_roles pr
        WHERE pr.project_id = ${projectsTable.id}
          AND pr.budgeted_days IS NOT NULL
          AND pr.day_rate IS NOT NULL
      )`,
      loggedTotal: sql<number | null>`(
        SELECT SUM((te.hours / 8.0) * pr.day_rate)
        FROM time_entries te
        JOIN project_roles pr ON pr.id = te.project_role_id
        WHERE te.project_id = ${projectsTable.id}
          AND pr.day_rate IS NOT NULL
      )`,
      invoicedTotal: sql<number | null>`(
        SELECT SUM((te.hours / 8.0) * pr.day_rate)
        FROM time_entries te
        JOIN project_roles pr ON pr.id = te.project_role_id
        WHERE te.project_id = ${projectsTable.id}
          AND pr.day_rate IS NOT NULL
          AND (
            te.billing_status = 'invoiced'
            OR (te.billing_status IS NULL AND te.invoiced_at IS NOT NULL)
          )
      )`,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const history = await db
    .select()
    .from(projectHealthUpdatesTable)
    .where(eq(projectHealthUpdatesTable.projectId, projectId))
    .orderBy(desc(projectHealthUpdatesTable.createdAt));

  // ── Trend direction ────────────────────────────────────────────────────────
  const RISK_NUM: Record<string, number> = { low: 0, medium: 1, high: 2 };
  let trendDirection: "up" | "down" | "stable" | null = null;
  if (history.length >= 2) {
    const latest = RISK_NUM[history[0].riskLevel] ?? 0;
    const prev   = RISK_NUM[history[1].riskLevel] ?? 0;
    const diff = latest - prev;
    trendDirection = diff > 0 ? "up" : diff < 0 ? "down" : "stable";
  }

  // ── Monthly historical revenue ─────────────────────────────────────────────
  // NOTE: Monthly invoiced history IS available — each time_entry records its
  // billing_status individually. This is NOT a flat snapshot — it's per-entry.
  const monthlyRows = await db.execute(sql`
    SELECT
      to_char(date_trunc('month', te.entry_date::timestamp), 'YYYY-MM') AS month,
      ROUND(SUM((te.hours / 8.0) * pr.day_rate)::numeric, 2)            AS logged_revenue,
      ROUND(SUM(CASE
        WHEN te.billing_status = 'invoiced' THEN (te.hours / 8.0) * pr.day_rate
        WHEN te.billing_status IS NULL AND te.invoiced_at IS NOT NULL THEN (te.hours / 8.0) * pr.day_rate
        ELSE 0
      END)::numeric, 2)                                                  AS invoiced_revenue
    FROM time_entries te
    JOIN project_roles pr ON pr.id = te.project_role_id
    WHERE te.project_id = ${projectId}
      AND pr.day_rate IS NOT NULL
    GROUP BY date_trunc('month', te.entry_date::timestamp)
    ORDER BY 1
  `);

  const monthlyData = (monthlyRows.rows as {
    month: string; logged_revenue: string; invoiced_revenue: string;
  }[]).map((r) => ({
    month:           r.month,
    loggedRevenue:   parseFloat(r.logged_revenue) || 0,
    invoicedRevenue: parseFloat(r.invoiced_revenue) || 0,
  }));

  // ── Future bookings (raw — client computes monthly projections) ────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  const futureBookingRows = await db.execute(sql`
    SELECT
      rb.id,
      rb.employee_id,
      e.name AS employee_name,
      rb.start_date,
      rb.end_date,
      rb.hours_per_day,
      rb.weekday_hours,
      rb.project_role_id,
      pr.name AS role_name,
      pr.day_rate
    FROM resource_bookings rb
    JOIN employees e ON e.id = rb.employee_id
    LEFT JOIN project_roles pr ON pr.id = rb.project_role_id
    WHERE rb.project_id = ${projectId}
      AND rb.end_date >= ${todayStr}
    ORDER BY rb.start_date
  `);

  const futureBookings = (futureBookingRows.rows as {
    id: number;
    employee_id: number;
    employee_name: string;
    start_date: string;
    end_date: string;
    hours_per_day: number;
    weekday_hours: Record<string, number> | null;
    project_role_id: number | null;
    role_name: string | null;
    day_rate: number | null;
  }[]).map((r) => ({
    id:           r.id,
    employeeId:   r.employee_id,
    employeeName: r.employee_name,
    startDate:    r.start_date,
    endDate:      r.end_date,
    hoursPerDay:  r.hours_per_day,
    weekdayHours: r.weekday_hours,
    projectRoleId: r.project_role_id,
    roleName:     r.role_name,
    dayRate:      r.day_rate,
  }));

  // ── Derived flags ──────────────────────────────────────────────────────────
  const now = new Date();
  const lastUpdateAt = history[0]?.createdAt ?? null;
  const lastUpdateAge = lastUpdateAt ? daysBetween(now, new Date(lastUpdateAt)) : null;
  const updateOverdue = !lastUpdateAt || lastUpdateAge! >= UPDATE_CADENCE_DAYS;

  let nextUpdateDue: string | null = null;
  if (lastUpdateAt) {
    const dueDate = new Date(lastUpdateAt);
    dueDate.setUTCDate(dueDate.getUTCDate() + UPDATE_CADENCE_DAYS);
    nextUpdateDue = dueDate.toISOString().slice(0, 10);
  }

  const lastCommentEntry = history.find((h) => h.comment && h.comment.trim() !== "");
  const lastCommentAt = lastCommentEntry?.createdAt?.toISOString() ?? null;

  const budgetPct =
    project.budgetTotal && project.budgetTotal > 0 && project.loggedTotal != null
      ? project.loggedTotal / project.budgetTotal
      : null;
  const budgetAlert    = budgetPct != null && budgetPct >= BUDGET_ALERT_THRESHOLD;
  const budgetProgress = budgetPct != null ? Math.round(budgetPct * 1000) / 10 : null;

  res.json({
    project: {
      ...project,
      trendDirection,
      nextUpdateDue,
      updateOverdue,
      lastUpdateAge,
      lastCommentAt,
      budgetAlert,
      budgetProgress,
    },
    history,
    monthlyData,
    futureBookings,
    updateCadenceDays:    UPDATE_CADENCE_DAYS,
    budgetAlertThreshold: BUDGET_ALERT_THRESHOLD,
  });
});

// ── POST /api/project-status/:projectId/health-updates ────────────────────────

const HealthUpdateSchema = z.object({
  generalStatus:      z.enum(["planned", "in_progress", "on_hold", "completed", "cancelled"]),
  budgetStatus:       z.string().optional(),
  riskLevel:          z.enum(["low", "medium", "high"]),
  clientSatisfaction: z.enum(["happy", "neutral", "critical"]).optional(),
  comment:            z.string().optional(),
});

router.post("/project-status/:projectId/health-updates", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [exists] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!exists) { res.status(404).json({ error: "Project not found" }); return; }

  const parsed = HealthUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { generalStatus, budgetStatus, riskLevel, clientSatisfaction, comment } = parsed.data;

  const entry = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(projectHealthUpdatesTable)
      .values({
        projectId,
        generalStatus,
        budgetStatus: budgetStatus ?? null,
        riskLevel,
        clientSatisfaction: clientSatisfaction ?? null,
        comment: comment ?? null,
      })
      .returning();

    await tx
      .update(projectsTable)
      .set({ generalStatus, riskLevel, clientSatisfaction: clientSatisfaction ?? null })
      .where(eq(projectsTable.id, projectId));

    return inserted;
  });

  res.status(201).json(entry);
});

// ── PATCH /api/project-status/:projectId/next-steps ──────────────────────────

const NextStepItemSchema = z.object({
  id:   z.string(),
  text: z.string().min(1),
  done: z.boolean(),
});

const NextStepsSchema = z.object({
  nextSteps: z.array(NextStepItemSchema),
});

router.patch("/project-status/:projectId/next-steps", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [exists] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!exists) { res.status(404).json({ error: "Project not found" }); return; }

  const parsed = NextStepsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  await db
    .update(projectsTable)
    .set({ nextSteps: parsed.data.nextSteps })
    .where(eq(projectsTable.id, projectId));

  res.json({ ok: true });
});

export default router;
