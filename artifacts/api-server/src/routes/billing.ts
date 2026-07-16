/**
 * GET  /api/billing?startDate=&endDate=
 *   Returns logged vs invoiced vs invest revenue for ALL projects, grouped by
 *   client → project → role → employee.
 *
 * GET  /api/projects/:id/billing?startDate=&endDate=
 *   Returns logged vs invoiced vs invest revenue per role and employee.
 *
 * GET  /api/projects/:id/billing/lifetime
 *   Returns period-independent lifetime summary + monthly cumulative chart data.
 *
 * GET  /api/projects/:id/invoices
 *   Returns invoice history from the invoices table.
 *
 * POST /api/projects/:id/invoices
 *   Creates an invoice record and marks matching time entries as invoiced.
 *
 * POST /api/time-entries/mark-invoiced  (legacy — marks all unbilled for project)
 * POST /api/time-entries/update-billing-status  (new — per-item selection)
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, isNull, sql, desc, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  clientsTable,
  projectsTable,
  projectRolesTable,
  timeEntriesTable,
  employeesTable,
  invoicesTable,
  invoiceItemsTable,
} from "@workspace/db";

const router: IRouter = Router();

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v: unknown): string | null {
  return typeof v === "string" && dateRe.test(v) ? v : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── GET /billing  (all projects) ────────────────────────────────────────────

router.get("/billing", async (req, res): Promise<void> => {
  const startDate = parseDate(req.query.startDate);
  const endDate   = parseDate(req.query.endDate);

  // Fetch all clients
  const clients = await db
    .select({ id: clientsTable.id, name: clientsTable.name })
    .from(clientsTable)
    .orderBy(clientsTable.name);

  // Fetch all projects with their clientId
  const projects = await db
    .select({ id: projectsTable.id, name: projectsTable.name, clientId: projectsTable.clientId })
    .from(projectsTable)
    .orderBy(projectsTable.name);

  // Fetch all roles across all projects
  const roles = await db
    .select({
      id: projectRolesTable.id,
      name: projectRolesTable.name,
      dayRate: projectRolesTable.dayRate,
      budgetedDays: projectRolesTable.budgetedDays,
      projectId: projectRolesTable.projectId,
    })
    .from(projectRolesTable)
    .orderBy(projectRolesTable.id);

  if (roles.length === 0) {
    const clientsOut = clients.map((c) => ({
      id: c.id, name: c.name,
      totals: { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
      projects: [],
    }));
    res.json({
      totals: { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
      clients: clientsOut.filter((c) => {
        const cProjects = projects.filter((p) => p.clientId === c.id);
        return cProjects.length > 0;
      }),
    });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Build date conditions
  const entryConditions: ReturnType<typeof eq>[] = [
    sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
  ];
  if (startDate) entryConditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   entryConditions.push(lte(timeEntriesTable.entryDate, endDate));

  // Aggregate hours per (projectId, roleId, employeeId)
  const entryRows = await db
    .select({
      projectId:    timeEntriesTable.projectId,
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId:    timeEntriesTable.employeeId,
      employeeName:  employeesTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      invoicedHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invoiced' THEN ${timeEntriesTable.hours}
        WHEN ${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
      investHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invest' THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(and(...entryConditions))
    .groupBy(
      timeEntriesTable.projectId,
      timeEntriesTable.projectRoleId,
      timeEntriesTable.employeeId,
      employeesTable.name,
    );

  type EmpAgg = {
    employeeId: number;
    employeeName: string;
    totalHours: number;
    invoicedHours: number;
    investHours: number;
  };
  // Map: roleId → EmpAgg[]
  const byRole = new Map<number, EmpAgg[]>();
  for (const row of entryRows) {
    if (row.projectRoleId == null) continue;
    if (!byRole.has(row.projectRoleId)) byRole.set(row.projectRoleId, []);
    byRole.get(row.projectRoleId)!.push({
      employeeId:    row.employeeId,
      employeeName:  row.employeeName ?? `#${row.employeeId}`,
      totalHours:    Number(row.totalHours),
      invoicedHours: Number(row.invoicedHours),
      investHours:   Number(row.investHours),
    });
  }

  // Build project lookup by id
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // Build roles per project
  const rolesByProject = new Map<number, typeof roles>();
  for (const role of roles) {
    if (!rolesByProject.has(role.projectId)) rolesByProject.set(role.projectId, []);
    rolesByProject.get(role.projectId)!.push(role);
  }

  let grandBudget   = 0;
  let grandLogged   = 0;
  let grandInvoiced = 0;
  let grandInvest   = 0;

  // Build client → project → role → employee tree
  const clientsOut = clients
    .map((client) => {
      const clientProjects = projects.filter((p) => p.clientId === client.id);
      if (clientProjects.length === 0) return null;

      let clientBudget   = 0;
      let clientLogged   = 0;
      let clientInvoiced = 0;
      let clientInvest   = 0;

      const projectsOut = clientProjects.map((project) => {
        const projectRoles = rolesByProject.get(project.id) ?? [];

        let projBudget   = 0;
        let projLogged   = 0;
        let projInvoiced = 0;
        let projInvest   = 0;

        const rolesOut = projectRoles.map((role) => {
          const empRows = byRole.get(role.id) ?? [];
          const dayRate = role.dayRate;

          const employees = empRows
            .map((e) => {
              const loggedHours   = e.totalHours;
              const invoicedHours = e.invoicedHours;
              const investHours   = e.investHours;
              const loggedDays    = round2(loggedHours / 8);
              const revenue       = round2((loggedHours / 8) * dayRate);
              const invoiced      = round2((invoicedHours / 8) * dayRate);
              const invest        = round2((investHours / 8) * dayRate);
              const unbilled      = round2(revenue - invoiced - invest);
              const billingStatus =
                invoicedHours > 0 && investHours === 0 ? "invoiced" as const :
                investHours > 0 && invoicedHours === 0 ? "invest" as const :
                null;
              return { id: e.employeeId, name: e.employeeName, hours: loggedHours, days: loggedDays, revenue, invoiced, invest, unbilled, billingStatus };
            })
            .sort((a, b) => b.revenue - a.revenue);

          const roleLoggedHours   = empRows.reduce((s, e) => s + e.totalHours,    0);
          const roleInvoicedHours = empRows.reduce((s, e) => s + e.invoicedHours, 0);
          const roleInvestHours   = empRows.reduce((s, e) => s + e.investHours,   0);
          const roleLoggedDays    = round2(roleLoggedHours / 8);
          const loggedRaw         = (roleLoggedHours / 8) * dayRate;
          const invoicedRaw       = (roleInvoicedHours / 8) * dayRate;
          const investRaw         = (roleInvestHours / 8) * dayRate;
          const logged            = round2(loggedRaw);
          const invoiced          = round2(invoicedRaw);
          const invest            = round2(investRaw);
          const unbilled          = round2(logged - invoiced - invest);
          const budget            = role.budgetedDays != null ? round2(role.budgetedDays * dayRate) : null;
          const remaining         = budget != null ? round2(budget - logged) : null;

          if (budget != null) projBudget += budget;
          projLogged   += loggedRaw;
          projInvoiced += invoicedRaw;
          projInvest   += investRaw;

          return {
            id: role.id, name: role.name,
            dayrate: dayRate,
            budgetedDays: role.budgetedDays,
            budget, loggedDays: roleLoggedDays, loggedHours: round2(roleLoggedHours),
            logged, invoiced, invest, unbilled, remaining,
            employees,
          };
        });

        const projUnbilled  = round2(projLogged - projInvoiced - projInvest);
        const projRemaining = round2(projBudget - projLogged);

        clientBudget   += projBudget;
        clientLogged   += projLogged;
        clientInvoiced += projInvoiced;
        clientInvest   += projInvest;

        return {
          id: project.id, name: project.name,
          totals: {
            budget:   round2(projBudget),
            logged:   round2(projLogged),
            invoiced: round2(projInvoiced),
            invest:   round2(projInvest),
            unbilled: projUnbilled,
            remaining: projRemaining,
          },
          roles: rolesOut,
        };
      });

      const clientUnbilled  = round2(clientLogged - clientInvoiced - clientInvest);
      const clientRemaining = round2(clientBudget - clientLogged);

      grandBudget   += clientBudget;
      grandLogged   += clientLogged;
      grandInvoiced += clientInvoiced;
      grandInvest   += clientInvest;

      return {
        id: client.id, name: client.name,
        totals: {
          budget:    round2(clientBudget),
          logged:    round2(clientLogged),
          invoiced:  round2(clientInvoiced),
          invest:    round2(clientInvest),
          unbilled:  clientUnbilled,
          remaining: clientRemaining,
        },
        projects: projectsOut,
      };
    })
    .filter(Boolean);

  const grandUnbilled  = round2(grandLogged - grandInvoiced - grandInvest);
  const grandRemaining = round2(grandBudget - grandLogged);

  res.json({
    totals: {
      budget:    round2(grandBudget),
      logged:    round2(grandLogged),
      invoiced:  round2(grandInvoiced),
      invest:    round2(grandInvest),
      unbilled:  grandUnbilled,
      remaining: grandRemaining,
    },
    clients: clientsOut,
  });
});

// ── GET /projects/:projectId/billing ────────────────────────────────────────

router.get("/projects/:projectId/billing", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const startDate = parseDate(req.query.startDate);
  const endDate   = parseDate(req.query.endDate);

  // Fetch the project
  const [project] = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  // Fetch all roles for the project
  const roles = await db
    .select({
      id: projectRolesTable.id,
      name: projectRolesTable.name,
      dayRate: projectRolesTable.dayRate,
      budgetedDays: projectRolesTable.budgetedDays,
    })
    .from(projectRolesTable)
    .where(eq(projectRolesTable.projectId, projectId))
    .orderBy(projectRolesTable.id);

  if (roles.length === 0) {
    res.json({
      project,
      totals: { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
      roles: [],
    });
    return;
  }

  const roleIds = roles.map((r) => r.id);

  // Build date conditions
  const entryConditions = [
    eq(timeEntriesTable.projectId, projectId),
    sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
  ];
  if (startDate) entryConditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   entryConditions.push(lte(timeEntriesTable.entryDate, endDate));

  // Aggregate hours per (roleId, employeeId)
  // invoicedHours: billing_status='invoiced' OR (billing_status IS NULL AND invoiced_at IS NOT NULL) for legacy entries
  // investHours:   billing_status='invest'
  const entryRows = await db
    .select({
      projectRoleId: timeEntriesTable.projectRoleId,
      employeeId:    timeEntriesTable.employeeId,
      employeeName:  employeesTable.name,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      invoicedHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invoiced' THEN ${timeEntriesTable.hours}
        WHEN ${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
      investHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invest' THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
    })
    .from(timeEntriesTable)
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(and(...entryConditions))
    .groupBy(
      timeEntriesTable.projectRoleId,
      timeEntriesTable.employeeId,
      employeesTable.name,
    );

  type EmpRow = {
    employeeId: number;
    employeeName: string;
    totalHours: number;
    invoicedHours: number;
    investHours: number;
  };
  const byRole = new Map<number, EmpRow[]>();
  for (const row of entryRows) {
    if (row.projectRoleId == null) continue;
    if (!byRole.has(row.projectRoleId)) byRole.set(row.projectRoleId, []);
    byRole.get(row.projectRoleId)!.push({
      employeeId:    row.employeeId,
      employeeName:  row.employeeName ?? `#${row.employeeId}`,
      totalHours:    Number(row.totalHours),
      invoicedHours: Number(row.invoicedHours),
      investHours:   Number(row.investHours),
    });
  }

  let totalBudget   = 0;
  let totalLogged   = 0;
  let totalInvoiced = 0;
  let totalInvest   = 0;

  const rolesOut = roles.map((role) => {
    const empRows = byRole.get(role.id) ?? [];
    const dayRate = role.dayRate;

    const employees = empRows
      .map((e) => {
        const loggedHours    = e.totalHours;
        const invoicedHours  = e.invoicedHours;
        const investHours    = e.investHours;
        const logged         = round2((loggedHours / 8) * dayRate);
        const invoiced       = round2((invoicedHours / 8) * dayRate);
        const invest         = round2((investHours / 8) * dayRate);
        const unbilled       = round2(logged - invoiced - invest);
        // Dominant billing status for badge
        const billingStatus =
          invoicedHours > 0 && investHours === 0 ? "invoiced" as const :
          investHours > 0 && invoicedHours === 0 ? "invest" as const :
          null;
        return { id: e.employeeId, name: e.employeeName, loggedHours, logged, invoicedHours, invoiced, investHours, invest, unbilled, billingStatus };
      })
      .sort((a, b) => b.logged - a.logged);

    const roleLoggedHours   = employees.reduce((s, e) => s + e.loggedHours,   0);
    const roleInvoicedHours = employees.reduce((s, e) => s + e.invoicedHours, 0);
    const roleInvestHours   = employees.reduce((s, e) => s + e.investHours,   0);
    const loggedRaw         = (roleLoggedHours / 8) * dayRate;
    const invoicedRaw       = (roleInvoicedHours / 8) * dayRate;
    const investRaw         = (roleInvestHours / 8) * dayRate;
    const logged            = round2(loggedRaw);
    const invoiced          = round2(invoicedRaw);
    const invest            = round2(investRaw);
    const unbilled          = round2(logged - invoiced - invest);
    const budget            = role.budgetedDays != null ? round2(role.budgetedDays * dayRate) : null;
    const remaining         = budget != null ? round2(budget - logged) : null;

    if (budget != null) totalBudget += budget;
    totalLogged   += loggedRaw;
    totalInvoiced += invoicedRaw;
    totalInvest   += investRaw;

    return {
      id:            role.id,
      name:          role.name,
      dayrate:       dayRate,
      budgetedDays:  role.budgetedDays,
      budget,
      loggedHours:   round2(roleLoggedHours),
      logged,
      invoicedHours: round2(roleInvoicedHours),
      invoiced,
      investHours:   round2(roleInvestHours),
      invest,
      unbilled,
      remaining,
      employees,
    };
  });

  const totalUnbilled  = round2(totalLogged - totalInvoiced - totalInvest);
  const totalRemaining = round2(totalBudget - totalLogged);

  res.json({
    project,
    totals: {
      budget:    round2(totalBudget),
      logged:    round2(totalLogged),
      invoiced:  round2(totalInvoiced),
      invest:    round2(totalInvest),
      unbilled:  totalUnbilled,
      remaining: totalRemaining,
    },
    roles: rolesOut,
  });
});

// ── GET /projects/:projectId/billing/history ─────────────────────────────────

router.get("/projects/:projectId/billing/history", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  // Fetch all invoiced entries for this project that have a role
  const rows = await db
    .select({
      invoiceReference:  timeEntriesTable.invoiceReference,
      invoicedAt:        timeEntriesTable.invoicedAt,
      hours:             timeEntriesTable.hours,
      projectRoleId:     timeEntriesTable.projectRoleId,
      projectRoleName:   projectRolesTable.name,
      dayRate:           projectRolesTable.dayRate,
      employeeId:        timeEntriesTable.employeeId,
      employeeName:      employeesTable.name,
    })
    .from(timeEntriesTable)
    .leftJoin(projectRolesTable, eq(timeEntriesTable.projectRoleId, projectRolesTable.id))
    .leftJoin(employeesTable, eq(timeEntriesTable.employeeId, employeesTable.id))
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`(
          ${timeEntriesTable.billingStatus} = 'invoiced'
          OR (${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL)
        )`,
      ),
    )
    .orderBy(timeEntriesTable.invoicedAt);

  // Group by invoice reference. For entries without a reference each distinct
  // invoicedAt timestamp is its own audit event (preserves granularity).
  type HistoryGroup = {
    reference: string | null;
    invoicedAt: Date;
    totalAmount: number;
    roles: { id: number; name: string }[];
    employees: { id: number; name: string }[];
  };

  const groups = new Map<string, HistoryGroup>();

  for (const row of rows) {
    const invoicedAt = row.invoicedAt ?? new Date(0);
    const key = row.invoiceReference
      ? `ref:${row.invoiceReference}`
      : `ts:${invoicedAt.toISOString()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        reference:   row.invoiceReference ?? null,
        invoicedAt,
        totalAmount: 0,
        roles:       [],
        employees:   [],
      });
    }

    const g = groups.get(key)!;

    // Update invoicedAt to the latest timestamp within the group
    if (row.invoicedAt && row.invoicedAt > g.invoicedAt) g.invoicedAt = row.invoicedAt;

    // Accumulate amount unrounded; round2() is applied at output time
    if (row.dayRate != null) {
      g.totalAmount += (Number(row.hours) / 8) * row.dayRate;
    }

    // Track unique roles
    if (row.projectRoleId != null && !g.roles.find((r) => r.id === row.projectRoleId)) {
      g.roles.push({ id: row.projectRoleId, name: row.projectRoleName ?? `Role #${row.projectRoleId}` });
    }

    // Track unique employees
    if (row.employeeId != null && !g.employees.find((e) => e.id === row.employeeId)) {
      g.employees.push({ id: row.employeeId, name: row.employeeName ?? `#${row.employeeId}` });
    }
  }

  // Sort by invoicedAt descending (most recent first)
  const history = Array.from(groups.values())
    .sort((a, b) => b.invoicedAt.getTime() - a.invoicedAt.getTime())
    .map((g) => ({
      reference:     g.reference,
      invoicedAt:    g.invoicedAt.toISOString(),
      totalAmount:   round2(g.totalAmount),
      roleCount:     g.roles.length,
      employeeCount: g.employees.length,
      roles:         g.roles,
      employees:     g.employees,
    }));

  res.json({ project, history });
});

// ── GET /projects/:projectId/billing/lifetime ────────────────────────────────

router.get("/projects/:projectId/billing/lifetime", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db
    .select({ id: projectsTable.id, name: projectsTable.name, startDate: projectsTable.startDate })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const roles = await db
    .select({ id: projectRolesTable.id, dayRate: projectRolesTable.dayRate, budgetedDays: projectRolesTable.budgetedDays })
    .from(projectRolesTable)
    .where(eq(projectRolesTable.projectId, projectId));

  const budget = roles.reduce((s, r) => s + (r.budgetedDays != null ? r.budgetedDays * r.dayRate : 0), 0);

  if (roles.length === 0) {
    res.json({
      project: { id: project.id, name: project.name },
      budget: 0, totalLogged: 0, totalInvoiced: 0, remaining: 0,
      monthlyData: [],
    });
    return;
  }

  const roleIds = roles.map((r) => r.id);
  const roleRateMap = new Map(roles.map((r) => [r.id, r.dayRate]));

  // Fetch all time entries for this project with roles, grouped by month
  const monthRows = await db
    .select({
      month: sql<string>`TO_CHAR(${timeEntriesTable.entryDate}, 'YYYY-MM')`,
      projectRoleId: timeEntriesTable.projectRoleId,
      totalHours: sql<number>`COALESCE(SUM(${timeEntriesTable.hours}), 0)`,
      invoicedHours: sql<number>`COALESCE(SUM(CASE
        WHEN ${timeEntriesTable.billingStatus} = 'invoiced' THEN ${timeEntriesTable.hours}
        WHEN ${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL THEN ${timeEntriesTable.hours}
        ELSE 0
      END), 0)`,
    })
    .from(timeEntriesTable)
    .where(
      and(
        eq(timeEntriesTable.projectId, projectId),
        sql`${timeEntriesTable.projectRoleId} = ANY(ARRAY[${sql.join(roleIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
      ),
    )
    .groupBy(
      sql`TO_CHAR(${timeEntriesTable.entryDate}, 'YYYY-MM')`,
      timeEntriesTable.projectRoleId,
    )
    .orderBy(sql`TO_CHAR(${timeEntriesTable.entryDate}, 'YYYY-MM')`);

  // Aggregate by month (multiple roles per month)
  const byMonth = new Map<string, { logged: number; invoiced: number }>();
  let totalLoggedRaw   = 0;
  let totalInvoicedRaw = 0;

  for (const row of monthRows) {
    const rate = row.projectRoleId != null ? (roleRateMap.get(row.projectRoleId) ?? 0) : 0;
    const loggedRev   = (Number(row.totalHours)   / 8) * rate;
    const invoicedRev = (Number(row.invoicedHours) / 8) * rate;
    const m = row.month;
    if (!byMonth.has(m)) byMonth.set(m, { logged: 0, invoiced: 0 });
    const entry = byMonth.get(m)!;
    entry.logged   += loggedRev;
    entry.invoiced += invoicedRev;
    totalLoggedRaw   += loggedRev;
    totalInvoicedRaw += invoicedRev;
  }

  // Determine baseline month: project startDate (if set) or earliest entry month
  const sortedEntryMonths = Array.from(byMonth.keys()).sort();
  const currentMonth = new Date().toISOString().slice(0, 7);

  let baselineMonth: string;
  if (project.startDate) {
    // project.startDate is a date string "YYYY-MM-DD"
    baselineMonth = String(project.startDate).slice(0, 7);
  } else if (sortedEntryMonths.length > 0) {
    baselineMonth = sortedEntryMonths[0];
  } else {
    baselineMonth = currentMonth;
  }

  // Build continuous month range from baseline to current month (carry-forward zeros)
  const allMonths: string[] = [];
  let cursor = baselineMonth;
  while (cursor <= currentMonth) {
    allMonths.push(cursor);
    const [y, m] = cursor.split("-").map(Number);
    const next = new Date(y, m, 1); // m is 1-indexed here; Date(y, m) = first day of next month
    cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  }

  let cumulLogged   = 0;
  let cumulInvoiced = 0;

  const monthlyData = allMonths.map((m) => {
    const entry = byMonth.get(m);
    if (entry) {
      cumulLogged   += entry.logged;
      cumulInvoiced += entry.invoiced;
    }
    return {
      month:              m,
      loggedCumulative:   round2(cumulLogged),
      invoicedCumulative: round2(cumulInvoiced),
    };
  });

  const totalLogged   = round2(totalLoggedRaw);
  const totalInvoiced = round2(totalInvoicedRaw);
  const remaining     = round2(budget - totalLoggedRaw);

  res.json({
    project: { id: project.id, name: project.name },
    budget:        round2(budget),
    totalLogged,
    totalInvoiced,
    remaining,
    monthlyData,
  });
});

// ── GET /projects/:projectId/invoices ─────────────────────────────────────────

router.get("/projects/:projectId/invoices", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const [project] = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  const invoiceRows = await db
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.projectId, projectId))
    .orderBy(desc(invoicesTable.createdAt));

  if (invoiceRows.length === 0) {
    res.json({ project, invoices: [] });
    return;
  }

  const invoiceIds = invoiceRows.map((r) => r.id);

  const itemRows = await db
    .select({
      invoiceId:    invoiceItemsTable.invoiceId,
      roleId:       invoiceItemsTable.roleId,
      roleName:     projectRolesTable.name,
      employeeId:   invoiceItemsTable.employeeId,
      employeeName: employeesTable.name,
    })
    .from(invoiceItemsTable)
    .leftJoin(projectRolesTable, eq(invoiceItemsTable.roleId, projectRolesTable.id))
    .leftJoin(employeesTable, eq(invoiceItemsTable.employeeId, employeesTable.id))
    .where(sql`${invoiceItemsTable.invoiceId} = ANY(ARRAY[${sql.join(invoiceIds.map((id) => sql`${id}`), sql`, `)}]::int[])`);

  const itemsByInvoice = new Map<number, typeof itemRows>();
  for (const item of itemRows) {
    if (!itemsByInvoice.has(item.invoiceId)) itemsByInvoice.set(item.invoiceId, []);
    itemsByInvoice.get(item.invoiceId)!.push(item);
  }

  const invoices = invoiceRows.map((inv) => {
    const items = itemsByInvoice.get(inv.id) ?? [];
    const roles     = [...new Map(items.filter((i) => i.roleId != null).map((i) => [i.roleId, { id: i.roleId!, name: i.roleName ?? `Role #${i.roleId}` }])).values()];
    const employees = [...new Map(items.filter((i) => i.employeeId != null).map((i) => [i.employeeId, { id: i.employeeId!, name: i.employeeName ?? `#${i.employeeId}` }])).values()];
    return {
      id:          inv.id,
      createdAt:   inv.createdAt.toISOString(),
      periodStart: inv.periodStart,
      periodEnd:   inv.periodEnd,
      totalAmount: inv.totalAmount,
      reference:   inv.reference,
      roleCount:   roles.length,
      employeeCount: employees.length,
      roles,
      employees,
    };
  });

  res.json({ project, invoices });
});

// ── POST /projects/:projectId/invoices ────────────────────────────────────────

function isCalendarDate(s: string): boolean {
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const CreateInvoiceSchema = z.object({
  items: z.array(z.object({
    roleId:     z.number().int().positive(),
    employeeId: z.number().int().positive(),
  })).min(1, "At least one item must be selected"),
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD")
    .refine(isCalendarDate, { message: "periodStart is not a valid calendar date" }),
  periodEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD")
    .refine(isCalendarDate, { message: "periodEnd is not a valid calendar date" }),
  reference: z.string().max(100).optional(),
}).refine((d) => d.periodStart <= d.periodEnd, {
  message: "periodStart must be ≤ periodEnd",
  path: ["periodStart"],
});

router.post("/projects/:projectId/invoices", async (req, res): Promise<void> => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).json({ error: "Invalid projectId" }); return; }

  const parsed = CreateInvoiceSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { items, periodStart, periodEnd, reference } = parsed.data;

  // Validate: every submitted roleId must belong to this project
  const uniqueRoleIds = [...new Set(items.map((i) => i.roleId))];
  const roleRows = await db
    .select({ id: projectRolesTable.id, projectId: projectRolesTable.projectId })
    .from(projectRolesTable)
    .where(inArray(projectRolesTable.id, uniqueRoleIds));

  const invalidRole = roleRows.find((r) => r.projectId !== projectId);
  if (invalidRole || roleRows.length !== uniqueRoleIds.length) {
    res.status(403).json({ error: "One or more roles do not belong to this project" });
    return;
  }

  // Compute total amount from time entries matching selected items in the period
  let totalAmount = 0;
  let updatedCount = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const item of items) {
      const conditions = [
        eq(timeEntriesTable.projectId, projectId),
        eq(timeEntriesTable.projectRoleId, item.roleId),
        eq(timeEntriesTable.employeeId, item.employeeId),
        gte(timeEntriesTable.entryDate, periodStart),
        lte(timeEntriesTable.entryDate, periodEnd),
      ];

      // Fetch role rate
      const [role] = await tx
        .select({ dayRate: projectRolesTable.dayRate })
        .from(projectRolesTable)
        .where(eq(projectRolesTable.id, item.roleId));

      const dayRate = role?.dayRate ?? 0;

      // Fetch unbilled hours for this item to compute amount.
      // Exclusion order matters: check each "already-settled" status first so
      // legacy entries (billing_status IS NULL but invoiced_at IS NOT NULL) are
      // correctly excluded before the catch-all ELSE branch.
      const [agg] = await tx
        .select({
          unbilledHours: sql<number>`COALESCE(SUM(CASE
            WHEN ${timeEntriesTable.billingStatus} = 'invoiced'                                               THEN 0
            WHEN ${timeEntriesTable.billingStatus} = 'invest'                                                 THEN 0
            WHEN ${timeEntriesTable.billingStatus} IS NULL AND ${timeEntriesTable.invoicedAt} IS NOT NULL     THEN 0
            ELSE ${timeEntriesTable.hours}
          END), 0)`,
        })
        .from(timeEntriesTable)
        .where(and(...conditions));

      totalAmount += (Number(agg?.unbilledHours ?? 0) / 8) * dayRate;

      // Mark entries as invoiced
      const updated = await tx
        .update(timeEntriesTable)
        .set({
          billingStatus:    "invoiced",
          invoicedAt:       now,
          invoiceReference: reference ?? null,
        })
        .where(and(...conditions))
        .returning({ id: timeEntriesTable.id });

      updatedCount += updated.length;
    }

    // Insert invoice record
    const [invoice] = await tx
      .insert(invoicesTable)
      .values({
        projectId,
        periodStart,
        periodEnd,
        totalAmount: round2(totalAmount),
        reference: reference ?? null,
      })
      .returning({ id: invoicesTable.id });

    // Insert invoice items
    if (invoice && items.length > 0) {
      await tx
        .insert(invoiceItemsTable)
        .values(items.map((item) => ({
          invoiceId:  invoice.id,
          roleId:     item.roleId,
          employeeId: item.employeeId,
        })));
    }

    res.json({ invoiceId: invoice?.id, updatedCount, totalAmount: round2(totalAmount) });
  });
});

// ── POST /time-entries/mark-invoiced (legacy) ────────────────────────────────

const MarkInvoicedSchema = z.object({
  projectId:        z.number().int().positive(),
  startDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  invoiceReference: z.string().max(100).optional(),
});

router.post("/time-entries/mark-invoiced", async (req, res): Promise<void> => {
  const parsed = MarkInvoicedSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { projectId, startDate, endDate, invoiceReference } = parsed.data;

  const conditions = [
    eq(timeEntriesTable.projectId, projectId),
    isNull(timeEntriesTable.invoicedAt),
    // Exclude invest entries — legacy endpoint must not overwrite explicit invest status
    sql`(${timeEntriesTable.billingStatus} IS NULL OR ${timeEntriesTable.billingStatus} != 'invest')`,
  ];
  if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
  if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

  const updated = await db
    .update(timeEntriesTable)
    .set({
      billingStatus:    "invoiced",
      invoicedAt:       new Date(),
      invoiceReference: invoiceReference ?? null,
    })
    .where(and(...conditions))
    .returning({ id: timeEntriesTable.id });

  res.json({ updatedCount: updated.length });
});

// ── POST /time-entries/update-billing-status ─────────────────────────────────

const UpdateBillingStatusSchema = z.object({
  projectId:        z.number().int().positive(),
  items:            z.array(z.object({
    roleId:     z.number().int().positive(),
    employeeId: z.number().int().positive().optional(),
  })).min(1),
  startDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status:           z.enum(["invoiced", "invest"]).nullable(),
  invoiceReference: z.string().max(100).optional(),
});

router.post("/time-entries/update-billing-status", async (req, res): Promise<void> => {
  const parsed = UpdateBillingStatusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { projectId, items, startDate, endDate, status, invoiceReference } = parsed.data;

  let updatedCount = 0;

  for (const item of items) {
    const conditions = [
      eq(timeEntriesTable.projectId, projectId),
      eq(timeEntriesTable.projectRoleId, item.roleId),
    ];
    if (item.employeeId != null) conditions.push(eq(timeEntriesTable.employeeId, item.employeeId));
    if (startDate) conditions.push(gte(timeEntriesTable.entryDate, startDate));
    if (endDate)   conditions.push(lte(timeEntriesTable.entryDate, endDate));

    let updated: { id: number }[];
    if (status === "invoiced") {
      updated = await db
        .update(timeEntriesTable)
        .set({
          billingStatus:    "invoiced",
          invoicedAt:       new Date(),
          invoiceReference: invoiceReference ?? null,
        })
        .where(and(...conditions))
        .returning({ id: timeEntriesTable.id });
    } else {
      updated = await db
        .update(timeEntriesTable)
        .set({ billingStatus: status })
        .where(and(...conditions))
        .returning({ id: timeEntriesTable.id });
    }
    updatedCount += updated.length;
  }

  res.json({ updatedCount });
});

export default router;
