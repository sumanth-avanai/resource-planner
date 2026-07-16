/**
 * Pivot / flexible report endpoint – v2
 *
 * GET /api/reports/pivot
 *   startDate       YYYY-MM-DD  (required)
 *   endDate         YYYY-MM-DD  (required)
 *   rowDimension    employees | projects | clients | roles
 *   colDimension    none | week | month | quarter
 *   metrics         comma-separated or repeated query param:
 *                     booked | billable_booked | planned | available | budgeted |
 *                     remaining_unbooked | remaining_unplanned |
 *                     utilization_pct | plan_completion_pct
 *                   Legacy single param: metric=billable_hours|total_hours|... (mapped automatically)
 *   employeeIds     comma-separated IDs  (optional)
 *   projectIds      comma-separated IDs  (optional)
 *   clientIds       comma-separated IDs  (optional)
 *
 * Response: DrillResponse
 *   { type:"drill", rowDimension, colDimension, metrics, columns, columnLabels, rows, totals }
 *   rows[].data     = { [colKey]: { [metricKey]: number } }
 *   rows[].children = same shape, full eager tree
 */

import { Router, type IRouter } from "express";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  projectsTable,
  clientsTable,
  employeesTable,
  resourceBookingsTable,
  projectRolesTable,
} from "@workspace/db";
import { calculateAvailableHours, wasEmployeeActiveDuring } from "../lib/utilization";
import { fetchEmpAvailabilityMap } from "../lib/employee-availability";
import { dateToBucket, assignBookingToBuckets } from "../lib/pivot-buckets";

const router: IRouter = Router();

// ─── Types ────────────────────────────────────────────────────────────────────

interface DrillRow {
  id: string;
  name: string;
  type: "employee" | "project" | "client" | "role";
  expandable: boolean;
  data: Record<string, Record<string, number>>;
  children: DrillRow[];
}

interface DrillResponse {
  type: "drill";
  rowDimension: string;
  colDimension: string;
  metrics: string[];
  columns: string[];
  columnLabels: string[];
  rows: DrillRow[];
  totals: Record<string, Record<string, number>>;
}

// ─── Param helpers ────────────────────────────────────────────────────────────

function parseDateParam(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function parseIds(raw: unknown): number[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
  return ids.length > 0 ? ids : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Legacy metric alias normalisation
// billable_utilization_percent → billable_utilization_pct (billable_booked / available × 100)
// overall_utilization_percent  → utilization_pct          (booked / available × 100)
const LEGACY_METRIC_MAP: Record<string, string> = {
  billable_hours:               "billable_booked",
  total_hours:                  "booked",
  billable_utilization_percent: "billable_utilization_pct",
  overall_utilization_percent:  "utilization_pct",
  booked_hours:                 "planned",
  budget_hours:                 "budgeted",
  remaining_hours:              "remaining_unbooked",
  // budget_used_pct is kept as its own canonical key (booked / budgeted × 100)
};

function normalizeMetric(m: string): string {
  return LEGACY_METRIC_MAP[m] ?? m;
}

// ─── Column dimension helpers ─────────────────────────────────────────────────

function getISOWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const w1mon = new Date(Date.UTC(year, 0, 4 - dow + 1));
  return new Date(Date.UTC(
    w1mon.getUTCFullYear(), w1mon.getUTCMonth(),
    w1mon.getUTCDate() + (week - 1) * 7
  ));
}

function getColumnsInRange(startDate: string, endDate: string, colDim: string): string[] {
  if (colDim === "none") return [];
  const seen = new Set<string>();
  const order: string[] = [];
  const d = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (d <= end) {
    const b = dateToBucket(d.toISOString().slice(0, 10), colDim);
    if (!seen.has(b)) { seen.add(b); order.push(b); }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return order;
}

function getBucketBounds(
  key: string, colDim: string, rangeStart: string, rangeEnd: string
): { start: string; end: string } {
  if (key === "Total" || colDim === "none") return { start: rangeStart, end: rangeEnd };
  if (colDim === "month") {
    const [y, m] = key.split("-").map(Number);
    const first = `${key}-01`;
    const last = `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    return {
      start: first > rangeStart ? first : rangeStart,
      end:   last  < rangeEnd   ? last  : rangeEnd,
    };
  }
  if (colDim === "quarter") {
    const y  = parseInt(key.slice(0, 4));
    const q  = parseInt(key.slice(6));
    const sm = (q - 1) * 3 + 1;
    const em = q * 3;
    const qStart = `${y}-${String(sm).padStart(2, "0")}-01`;
    const qEnd   = `${y}-${String(em).padStart(2, "0")}-${String(new Date(Date.UTC(y, em, 0)).getUTCDate()).padStart(2, "0")}`;
    return {
      start: qStart > rangeStart ? qStart : rangeStart,
      end:   qEnd   < rangeEnd   ? qEnd   : rangeEnd,
    };
  }
  if (colDim === "week") {
    const y   = parseInt(key.slice(0, 4));
    const w   = parseInt(key.slice(6));
    const mon = getISOWeekMonday(y, w);
    const sun = new Date(Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate() + 6));
    const wStart = mon.toISOString().slice(0, 10);
    const wEnd   = sun.toISOString().slice(0, 10);
    return {
      start: wStart > rangeStart ? wStart : rangeStart,
      end:   wEnd   < rangeEnd   ? wEnd   : rangeEnd,
    };
  }
  return { start: rangeStart, end: rangeEnd };
}

function getBucketLabel(key: string, colDim: string): string {
  if (key === "Total") return "Total";
  if (colDim === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  if (colDim === "quarter") {
    const [y, q] = key.split("-");
    return `${q} ${y}`;
  }
  if (colDim === "week") {
    const [y, w] = key.split("-");
    return `${w.replace(/^W0*/, "W")} ${y}`;
  }
  return key;
}

// ─── Metric computation ───────────────────────────────────────────────────────

function computeMetrics(
  metricKeys: string[],
  agg: { booked: number; billable: number; planned: number; available: number; budgeted: number | null },
): Record<string, number> {
  const r: Record<string, number> = {};
  for (const k of metricKeys) {
    let v: number;
    switch (k) {
      case "booked":              v = round2(agg.booked);   break;
      case "billable_booked":     v = round2(agg.billable); break;
      case "planned":             v = round2(agg.planned);  break;
      case "available":           v = round2(agg.available); break;
      case "budgeted":            v = round2(agg.budgeted ?? 0); break;
      case "remaining_unbooked":  v = agg.budgeted != null ? round2(agg.budgeted - agg.booked)            : 0; break;
      case "remaining_unplanned": v = agg.budgeted != null ? round2(agg.budgeted - agg.planned)           : 0; break;
      case "utilization_pct":          v = agg.available > 0    ? round2((agg.booked   / agg.available) * 100) : 0; break;
      case "billable_utilization_pct": v = agg.available > 0    ? round2((agg.billable / agg.available) * 100) : 0; break;
      case "plan_completion_pct":      v = agg.planned   > 0    ? round2((agg.booked   / agg.planned)   * 100) : 0; break;
      case "budget_used_pct":     v = (agg.budgeted != null && agg.budgeted > 0) ? round2((agg.booked / agg.budgeted) * 100) : 0; break;
      default:                    v = round2(agg.booked);   break;
    }
    r[k] = v;
  }
  return r;
}

// ─── Main route ───────────────────────────────────────────────────────────────

router.get("/reports/pivot", async (req, res): Promise<void> => {
  const startDate = parseDateParam(req.query.startDate);
  const endDate   = parseDateParam(req.query.endDate);
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startDate and endDate (YYYY-MM-DD) are required" });
    return;
  }

  const rowDimension = String(req.query.rowDimension ?? "employees");
  const colDimension = String(req.query.colDimension ?? "none");

  // Parse metrics — new array param or legacy single metric.
  // Handles both ?metrics=a,b and ?metrics=a&metrics=b and mixed ?metrics=a,b&metrics=c
  let rawMetrics: string[] = [];
  const qm = req.query.metrics;
  if (qm) {
    rawMetrics = (Array.isArray(qm) ? qm.flatMap((s) => String(s).split(",")) : String(qm).split(","))
      .map((s) => s.trim()).filter(Boolean);
  } else if (req.query.metric) {
    rawMetrics = [String(req.query.metric)];
  }
  if (rawMetrics.length === 0) rawMetrics = ["booked"];
  const metrics = [...new Set(rawMetrics.map(normalizeMetric))];

  const filterEmpIds  = parseIds(req.query.employeeIds);
  const filterProjIds = parseIds(req.query.projectIds);
  const filterCliIds  = parseIds(req.query.clientIds);

  // ── 1. Projects ────────────────────────────────────────────────────────────
  const projConds: any[] = [];
  if (filterProjIds) projConds.push(inArray(projectsTable.id, filterProjIds));
  if (filterCliIds)  projConds.push(inArray(projectsTable.clientId, filterCliIds));

  const allProjects = await db
    .select({
      id:          projectsTable.id,
      name:        projectsTable.name,
      clientId:    projectsTable.clientId,
      clientName:  clientsTable.name,
      isBillable:  projectsTable.isBillable,
      budgetHours: projectsTable.budgetHours,
    })
    .from(projectsTable)
    .leftJoin(clientsTable, eq(projectsTable.clientId, clientsTable.id))
    .where(projConds.length > 0 ? and(...projConds) : undefined);

  const projectById    = new Map(allProjects.map((p) => [p.id, p]));
  const inScopeProjIds = allProjects.map((p) => p.id);

  // ── 2. Employees ──────────────────────────────────────────────────────────
  const empConds: any[] = [eq(employeesTable.active, true)];
  if (filterEmpIds) empConds.push(inArray(employeesTable.id, filterEmpIds));
  const allEmployees  = (await db.select().from(employeesTable).where(and(...empConds)))
    // Exclude employees whose contract has no overlap with the requested period.
    // wasEmployeeActiveDuring() returns true when both contract dates are null (no restriction).
    .filter((e) => wasEmployeeActiveDuring(e.contractStartDate, e.contractEndDate, startDate, endDate));
  const employeeById  = new Map(allEmployees.map((e) => [e.id, e]));
  const inScopeEmpIds = allEmployees.map((e) => e.id);

  // ── 3. Project roles ──────────────────────────────────────────────────────
  let allRoles: (typeof projectRolesTable.$inferSelect)[] = [];
  if (inScopeProjIds.length > 0) {
    allRoles = await db
      .select()
      .from(projectRolesTable)
      .where(inArray(projectRolesTable.projectId, inScopeProjIds));
  }
  const roleById       = new Map(allRoles.map((r) => [r.id, r]));
  const rolesByProject = new Map<number, (typeof allRoles)>();
  for (const r of allRoles) {
    if (!rolesByProject.has(r.projectId)) rolesByProject.set(r.projectId, []);
    rolesByProject.get(r.projectId)!.push(r);
  }

  // ── 4. Time entries ───────────────────────────────────────────────────────
  const entryConds: any[] = [
    gte(timeEntriesTable.entryDate, startDate),
    lte(timeEntriesTable.entryDate, endDate),
  ];
  if (filterEmpIds  && filterEmpIds.length  > 0)
    entryConds.push(inArray(timeEntriesTable.employeeId, filterEmpIds));
  if (inScopeProjIds.length > 0)
    entryConds.push(inArray(timeEntriesTable.projectId, inScopeProjIds));
  const rawEntries = await db.select().from(timeEntriesTable).where(and(...entryConds));

  // ── 6. Resource bookings ──────────────────────────────────────────────────
  const bookingConds: any[] = [
    lte(resourceBookingsTable.startDate, endDate),
    gte(resourceBookingsTable.endDate,   startDate),
  ];
  if (filterEmpIds  && filterEmpIds.length  > 0)
    bookingConds.push(inArray(resourceBookingsTable.employeeId, filterEmpIds));
  if (inScopeProjIds.length > 0)
    bookingConds.push(inArray(resourceBookingsTable.projectId, inScopeProjIds));
  const rawBookings = await db.select().from(resourceBookingsTable).where(and(...bookingConds));

  // ── 7. Employee availability ──────────────────────────────────────────────
  const availMap = await fetchEmpAvailabilityMap(allEmployees, startDate, endDate);

  // ── 8. Column keys ────────────────────────────────────────────────────────
  const timeColKeys  = getColumnsInRange(startDate, endDate, colDimension);
  const allColKeys   = colDimension === "none" ? ["Total"] : [...timeColKeys, "Total"];
  const columnLabels = allColKeys.map((k) => getBucketLabel(k, colDimension));

  // ── 9. Nested aggregation maps ────────────────────────────────────────────
  // entryAgg[empId][projId][roleStr][bucket] = {booked, billable}
  type EA = { booked: number; billable: number };
  const entryAgg = new Map<number, Map<number, Map<string, Map<string, EA>>>>();

  for (const e of rawEntries) {
    const isBillable = projectById.get(e.projectId)?.isBillable ?? false;
    const roleStr    = e.projectRoleId != null ? String(e.projectRoleId) : "null";
    const timeBucket = dateToBucket(e.entryDate, colDimension);
    const buckets    = timeBucket === "Total" ? ["Total"] : [timeBucket, "Total"];

    for (const bucket of buckets) {
      if (!entryAgg.has(e.employeeId)) entryAgg.set(e.employeeId, new Map());
      const em = entryAgg.get(e.employeeId)!;
      if (!em.has(e.projectId)) em.set(e.projectId, new Map());
      const pm = em.get(e.projectId)!;
      if (!pm.has(roleStr)) pm.set(roleStr, new Map());
      const rm  = pm.get(roleStr)!;
      const cur = rm.get(bucket) ?? { booked: 0, billable: 0 };
      cur.booked += e.hours;
      if (isBillable) cur.billable += e.hours;
      rm.set(bucket, cur);
    }
  }

  // plannedAgg[empId][projId][roleStr][bucket] = hours
  const plannedAgg = new Map<number, Map<number, Map<string, Map<string, number>>>>();

  for (const b of rawBookings) {
    const roleStr      = b.projectRoleId != null ? String(b.projectRoleId) : "null";
    const empAvail      = availMap.get(b.employeeId);
    const holidaySet    = empAvail ? new Set(empAvail.holidayDates) : new Set<string>();
    const vacationSet   = empAvail ? empAvail.vacationDateSet : new Set<string>();
    const compDaySet    = empAvail ? empAvail.compDayDateSet  : new Set<string>();
    const bucketHrs     = assignBookingToBuckets(b, startDate, endDate, colDimension, holidaySet, vacationSet, compDaySet);

    for (const [timeBucket, hours] of Object.entries(bucketHrs)) {
      const buckets = timeBucket === "Total" ? ["Total"] : [timeBucket, "Total"];
      for (const bucket of buckets) {
        if (!plannedAgg.has(b.employeeId)) plannedAgg.set(b.employeeId, new Map());
        const em = plannedAgg.get(b.employeeId)!;
        if (!em.has(b.projectId)) em.set(b.projectId, new Map());
        const pm = em.get(b.projectId)!;
        if (!pm.has(roleStr)) pm.set(roleStr, new Map());
        const rm = pm.get(roleStr)!;
        rm.set(bucket, (rm.get(bucket) ?? 0) + hours);
      }
    }
  }

  // ── 10. Employee availability per bucket ──────────────────────────────────
  // Any metric whose computation divides by `available` requires this precomputation.
  const AVAIL_DEPENDENT_METRICS = new Set(["available", "utilization_pct", "billable_utilization_pct"]);
  const empAvailBucket = new Map<string, number>(); // `${empId}::${bucket}`
  const needsAvail = metrics.some((m) => AVAIL_DEPENDENT_METRICS.has(m));
  if (needsAvail) {
    for (const emp of allEmployees) {
      const { holidayDates, vacationDateSet } = availMap.get(emp.id)!;
      for (const bucket of allColKeys) {
        const { start, end } = getBucketBounds(bucket, colDimension, startDate, endDate);
        const avail = calculateAvailableHours(
          start, end,
          emp.workingDaysMask, emp.weeklyCapacityHours,
          holidayDates, vacationDateSet,
          emp.contractStartDate, emp.contractEndDate,
        );
        empAvailBucket.set(`${emp.id}::${bucket}`, avail);
      }
    }
  }

  // ── 11. Aggregation helpers ───────────────────────────────────────────────

  // Employee: sum all projects and roles
  function empEntrySum(empId: number, bucket: string): EA {
    const r = { booked: 0, billable: 0 };
    const em = entryAgg.get(empId);
    if (!em) return r;
    for (const pm of em.values())
      for (const rm of pm.values()) {
        const a = rm.get(bucket);
        if (a) { r.booked += a.booked; r.billable += a.billable; }
      }
    return r;
  }

  // Employee within a specific project: all roles
  function empProjEntrySum(empId: number, projId: number, bucket: string): EA {
    const r = { booked: 0, billable: 0 };
    const pm = entryAgg.get(empId)?.get(projId);
    if (!pm) return r;
    for (const rm of pm.values()) {
      const a = rm.get(bucket);
      if (a) { r.booked += a.booked; r.billable += a.billable; }
    }
    return r;
  }

  // Employee within project+role
  function empProjRoleEntrySum(empId: number, projId: number, roleStr: string, bucket: string): EA {
    return entryAgg.get(empId)?.get(projId)?.get(roleStr)?.get(bucket) ?? { booked: 0, billable: 0 };
  }

  // Project: all employees, all roles
  function projEntrySum(projId: number, bucket: string): EA {
    const r = { booked: 0, billable: 0 };
    for (const em of entryAgg.values()) {
      const pm = em.get(projId);
      if (!pm) continue;
      for (const rm of pm.values()) {
        const a = rm.get(bucket);
        if (a) { r.booked += a.booked; r.billable += a.billable; }
      }
    }
    return r;
  }

  // Project+role: all employees
  function projRoleEntrySum(projId: number, roleStr: string, bucket: string): EA {
    const r = { booked: 0, billable: 0 };
    for (const em of entryAgg.values()) {
      const a = em.get(projId)?.get(roleStr)?.get(bucket);
      if (a) { r.booked += a.booked; r.billable += a.billable; }
    }
    return r;
  }

  function empPlannedSum(empId: number, bucket: string): number {
    let t = 0;
    const em = plannedAgg.get(empId);
    if (!em) return t;
    for (const pm of em.values()) for (const rm of pm.values()) t += rm.get(bucket) ?? 0;
    return t;
  }

  function empProjPlannedSum(empId: number, projId: number, bucket: string): number {
    let t = 0;
    const pm = plannedAgg.get(empId)?.get(projId);
    if (!pm) return t;
    for (const rm of pm.values()) t += rm.get(bucket) ?? 0;
    return t;
  }

  function empProjRolePlannedSum(empId: number, projId: number, roleStr: string, bucket: string): number {
    return plannedAgg.get(empId)?.get(projId)?.get(roleStr)?.get(bucket) ?? 0;
  }

  function projPlannedSum(projId: number, bucket: string): number {
    let t = 0;
    for (const em of plannedAgg.values()) {
      const pm = em.get(projId);
      if (!pm) continue;
      for (const rm of pm.values()) t += rm.get(bucket) ?? 0;
    }
    return t;
  }

  function projRolePlannedSum(projId: number, roleStr: string, bucket: string): number {
    let t = 0;
    for (const em of plannedAgg.values()) t += em.get(projId)?.get(roleStr)?.get(bucket) ?? 0;
    return t;
  }

  function empAvail(empId: number, bucket: string): number {
    return empAvailBucket.get(`${empId}::${bucket}`) ?? 0;
  }

  function empSetAvail(empIds: number[], bucket: string): number {
    return empIds.reduce((s, id) => s + empAvail(id, bucket), 0);
  }

  function getBudgeted(roleIds: number[]): number | null {
    if (roleIds.length === 0) return null;
    let total = 0;
    let hasAny = false;
    for (const rid of roleIds) {
      const bh = roleById.get(rid)?.budgetedHours;
      if (bh != null) { total += bh; hasAny = true; }
    }
    return hasAny ? total : null;
  }

  function mkMetrics(
    ea: EA, planned: number, available: number, budgeted: number | null
  ): Record<string, number> {
    return computeMetrics(metrics, {
      booked: ea.booked, billable: ea.billable, planned, available, budgeted,
    });
  }

  // ── 12. Per-entity all-bucket data builders ────────────────────────────────

  function empAllBuckets(empId: number, roleIds: number[]): Record<string, Record<string, number>> {
    const budgeted = getBudgeted(roleIds);
    const data: Record<string, Record<string, number>> = {};
    for (const bucket of allColKeys) {
      const ea    = empEntrySum(empId, bucket);
      const plan  = empPlannedSum(empId, bucket);
      const avail = empAvail(empId, bucket);
      data[bucket] = mkMetrics(ea, plan, avail, budgeted);
    }
    return data;
  }

  function empProjAllBuckets(
    empId: number, projId: number, roleIds: number[]
  ): Record<string, Record<string, number>> {
    const budgeted = getBudgeted(roleIds);
    const data: Record<string, Record<string, number>> = {};
    for (const bucket of allColKeys) {
      const ea    = empProjEntrySum(empId, projId, bucket);
      const plan  = empProjPlannedSum(empId, projId, bucket);
      const avail = empAvail(empId, bucket);
      data[bucket] = mkMetrics(ea, plan, avail, budgeted);
    }
    return data;
  }

  function empProjRoleAllBuckets(
    empId: number, projId: number, roleStr: string, roleIds: number[]
  ): Record<string, Record<string, number>> {
    const budgeted = getBudgeted(roleIds);
    const data: Record<string, Record<string, number>> = {};
    for (const bucket of allColKeys) {
      const ea    = empProjRoleEntrySum(empId, projId, roleStr, bucket);
      const plan  = empProjRolePlannedSum(empId, projId, roleStr, bucket);
      const avail = empAvail(empId, bucket);
      data[bucket] = mkMetrics(ea, plan, avail, budgeted);
    }
    return data;
  }

  function projAllBuckets(
    projId: number, empIds: number[], roleIds: number[]
  ): Record<string, Record<string, number>> {
    const budgeted = getBudgeted(roleIds);
    const data: Record<string, Record<string, number>> = {};
    for (const bucket of allColKeys) {
      const ea    = projEntrySum(projId, bucket);
      const plan  = projPlannedSum(projId, bucket);
      const avail = empSetAvail(empIds, bucket);
      data[bucket] = mkMetrics(ea, plan, avail, budgeted);
    }
    return data;
  }

  function projRoleAllBuckets(
    projId: number, roleStr: string, empIds: number[], roleIds: number[]
  ): Record<string, Record<string, number>> {
    const budgeted = getBudgeted(roleIds);
    const data: Record<string, Record<string, number>> = {};
    for (const bucket of allColKeys) {
      const ea    = projRoleEntrySum(projId, roleStr, bucket);
      const plan  = projRolePlannedSum(projId, roleStr, bucket);
      const avail = empSetAvail(empIds, bucket);
      data[bucket] = mkMetrics(ea, plan, avail, budgeted);
    }
    return data;
  }

  // ── 13. Active-entity finders ─────────────────────────────────────────────

  function activeProjectIdsForEmp(empId: number): number[] {
    const ids = new Set<number>();
    for (const pid of (entryAgg.get(empId)?.keys()  ?? [])) ids.add(pid);
    for (const pid of (plannedAgg.get(empId)?.keys() ?? [])) ids.add(pid);
    return [...ids].filter((id) => projectById.has(id));
  }

  function activeRoleStrsForEmpProj(empId: number, projId: number): string[] {
    const strs = new Set<string>();
    for (const rk of (entryAgg.get(empId)?.get(projId)?.keys()  ?? [])) strs.add(rk);
    for (const rk of (plannedAgg.get(empId)?.get(projId)?.keys() ?? [])) strs.add(rk);
    return [...strs];
  }

  function activeEmpIdsForProjRole(projId: number, roleStr: string): number[] {
    const ids = new Set<number>();
    for (const [eid, em] of entryAgg)  { if (em.get(projId)?.has(roleStr)) ids.add(eid); }
    for (const [eid, em] of plannedAgg) { if (em.get(projId)?.has(roleStr)) ids.add(eid); }
    return [...ids].filter((id) => employeeById.has(id));
  }

  function activeEmpIdsForProj(projId: number): number[] {
    const ids = new Set<number>();
    for (const [eid, em] of entryAgg)  { if (em.has(projId)) ids.add(eid); }
    for (const [eid, em] of plannedAgg) { if (em.has(projId)) ids.add(eid); }
    return [...ids].filter((id) => employeeById.has(id));
  }

  function allRoleStrsForProj(projId: number): string[] {
    return [...(rolesByProject.get(projId) ?? []).map((r) => String(r.id)), "null"];
  }

  // ── 14. Build tree by rowDimension ────────────────────────────────────────

  const rows: DrillRow[] = [];

  if (rowDimension === "employees") {
    // Employee → Projects → Roles
    for (const emp of allEmployees) {
      const activeProjIds = activeProjectIdsForEmp(emp.id);
      // Budget only for roles this employee has actual activity on, not all roles in active projects
      const empRoleStrs = activeProjIds.flatMap((pid) => activeRoleStrsForEmpProj(emp.id, pid));
      const empRoleIds  = empRoleStrs.filter((s) => s !== "null").map(Number).filter((id) => roleById.has(id));

      const projChildren: DrillRow[] = activeProjIds.map((pid) => {
        const proj        = projectById.get(pid)!;
        const activeRoles = activeRoleStrsForEmpProj(emp.id, pid);
        const projRoleIds = activeRoles
          .filter((s) => s !== "null").map(Number).filter((id) => roleById.has(id));

        const roleChildren: DrillRow[] = activeRoles.map((rk) => {
          const rId  = rk === "null" ? null : parseInt(rk, 10);
          const rIds = rId != null && roleById.has(rId) ? [rId] : [];
          return {
            id:         `emp-${emp.id}-proj-${pid}-role-${rk}`,
            name:       rId != null ? (roleById.get(rId)?.name ?? `Role ${rId}`) : "No role",
            type:       "role" as const,
            expandable: false,
            data:       empProjRoleAllBuckets(emp.id, pid, rk, rIds),
            children:   [],
          };
        });

        return {
          id:         `emp-${emp.id}-proj-${pid}`,
          name:       `${proj.name}${proj.clientName ? ` (${proj.clientName})` : ""}`,
          type:       "project" as const,
          expandable: roleChildren.length > 0,
          data:       empProjAllBuckets(emp.id, pid, projRoleIds),
          children:   roleChildren,
        };
      });

      rows.push({
        id:         `emp-${emp.id}`,
        name:       emp.name,
        type:       "employee",
        expandable: projChildren.length > 0,
        data:       empAllBuckets(emp.id, empRoleIds),
        children:   projChildren,
      });
    }

  } else if (rowDimension === "projects") {
    // Project → Roles → Employees
    for (const proj of allProjects) {
      const projRoles    = rolesByProject.get(proj.id) ?? [];
      const projRoleStrs = allRoleStrsForProj(proj.id);
      const empIds       = activeEmpIdsForProj(proj.id);

      const roleChildren: DrillRow[] = projRoleStrs
        .map((rk) => {
          const rId     = rk === "null" ? null : parseInt(rk, 10);
          const rIds    = rId != null && roleById.has(rId) ? [rId] : [];
          const rEmpIds = activeEmpIdsForProjRole(proj.id, rk);
          if (rEmpIds.length === 0) return null;

          const empChildren: DrillRow[] = rEmpIds.map((eid) => ({
            id:         `proj-${proj.id}-role-${rk}-emp-${eid}`,
            name:       employeeById.get(eid)!.name,
            type:       "employee" as const,
            expandable: false,
            data:       empProjRoleAllBuckets(eid, proj.id, rk, rIds),
            children:   [],
          }));

          return {
            id:         `proj-${proj.id}-role-${rk}`,
            name:       rId != null ? (roleById.get(rId)?.name ?? `Role ${rId}`) : "No role",
            type:       "role" as const,
            expandable: empChildren.length > 0,
            data:       projRoleAllBuckets(proj.id, rk, rEmpIds, rIds),
            children:   empChildren,
          };
        })
        .filter((r) => r !== null) as DrillRow[];

      const projRoleIds = projRoles.map((r) => r.id);
      rows.push({
        id:         `proj-${proj.id}`,
        name:       `${proj.name}${proj.clientName ? ` (${proj.clientName})` : ""}`,
        type:       "project",
        expandable: roleChildren.length > 0,
        data:       projAllBuckets(proj.id, empIds, projRoleIds),
        children:   roleChildren,
      });
    }

  } else if (rowDimension === "clients") {
    // Client → Projects → Roles → Employees
    const uniqueClients = new Map<number, { id: number; name: string; projects: typeof allProjects }>();
    for (const proj of allProjects) {
      if (!proj.clientId) continue;
      if (!uniqueClients.has(proj.clientId))
        uniqueClients.set(proj.clientId, { id: proj.clientId, name: proj.clientName ?? "—", projects: [] });
      uniqueClients.get(proj.clientId)!.projects.push(proj);
    }

    for (const client of uniqueClients.values()) {
      const clientProjIds = client.projects.map((p) => p.id);
      const clientEmpIds  = [...new Set(clientProjIds.flatMap((pid) => activeEmpIdsForProj(pid)))];

      const clientRoleIds = clientProjIds.flatMap(
        (pid) => (rolesByProject.get(pid) ?? []).map((r) => r.id)
      );
      const clientBudgeted = getBudgeted(clientRoleIds);

      const clientData: Record<string, Record<string, number>> = {};
      for (const bucket of allColKeys) {
        let booked = 0, billable = 0, planned = 0;
        for (const pid of clientProjIds) {
          const ea  = projEntrySum(pid, bucket);
          booked   += ea.booked;
          billable += ea.billable;
          planned  += projPlannedSum(pid, bucket);
        }
        const avail = empSetAvail(clientEmpIds, bucket);
        clientData[bucket] = mkMetrics({ booked, billable }, planned, avail, clientBudgeted);
      }

      const projChildren: DrillRow[] = client.projects
        .map((proj) => {
          const projRoles    = rolesByProject.get(proj.id) ?? [];
          const projRoleStrs = allRoleStrsForProj(proj.id);
          const projEmpIds   = activeEmpIdsForProj(proj.id);

          const roleChildren: DrillRow[] = projRoleStrs
            .map((rk) => {
              const rId     = rk === "null" ? null : parseInt(rk, 10);
              const rIds    = rId != null && roleById.has(rId) ? [rId] : [];
              const rEmpIds = activeEmpIdsForProjRole(proj.id, rk);
              if (rEmpIds.length === 0) return null;

              const empChildren: DrillRow[] = rEmpIds.map((eid) => ({
                id:         `cl-${client.id}-proj-${proj.id}-role-${rk}-emp-${eid}`,
                name:       employeeById.get(eid)!.name,
                type:       "employee" as const,
                expandable: false,
                data:       empProjRoleAllBuckets(eid, proj.id, rk, rIds),
                children:   [],
              }));

              return {
                id:         `cl-${client.id}-proj-${proj.id}-role-${rk}`,
                name:       rId != null ? (roleById.get(rId)?.name ?? `Role ${rId}`) : "No role",
                type:       "role" as const,
                expandable: empChildren.length > 0,
                data:       projRoleAllBuckets(proj.id, rk, rEmpIds, rIds),
                children:   empChildren,
              };
            })
            .filter((r) => r !== null) as DrillRow[];

          const projRoleIds = projRoles.map((r) => r.id);
          return {
            id:         `cl-${client.id}-proj-${proj.id}`,
            name:       proj.name,
            type:       "project" as const,
            expandable: roleChildren.length > 0,
            data:       projAllBuckets(proj.id, projEmpIds, projRoleIds),
            children:   roleChildren,
          };
        })
        .filter((r) => r !== null) as DrillRow[];

      rows.push({
        id:         `client-${client.id}`,
        name:       client.name,
        type:       "client",
        expandable: projChildren.length > 0,
        data:       clientData,
        children:   projChildren,
      });
    }

  } else if (rowDimension === "roles") {
    // Role → Employees
    for (const role of allRoles) {
      const roleStr = String(role.id);
      const empIds  = activeEmpIdsForProjRole(role.projectId, roleStr);

      const proj     = projectById.get(role.projectId);
      const budgeted = getBudgeted([role.id]);

      const roleData: Record<string, Record<string, number>> = {};
      for (const bucket of allColKeys) {
        const ea    = projRoleEntrySum(role.projectId, roleStr, bucket);
        const plan  = projRolePlannedSum(role.projectId, roleStr, bucket);
        const avail = empSetAvail(empIds, bucket);
        roleData[bucket] = mkMetrics(ea, plan, avail, budgeted);
      }

      const empChildren: DrillRow[] = empIds.map((eid) => ({
        id:         `role-${role.id}-emp-${eid}`,
        name:       employeeById.get(eid)!.name,
        type:       "employee" as const,
        expandable: false,
        data:       empProjRoleAllBuckets(eid, role.projectId, roleStr, [role.id]),
        children:   [],
      }));

      rows.push({
        id:         `role-${role.id}`,
        name:       proj ? `${role.name} (${proj.name})` : role.name,
        type:       "role",
        expandable: empChildren.length > 0,
        data:       roleData,
        children:   empChildren,
      });
    }
  }

  // ── 15. Totals — aggregate from top-level rows ────────────────────────────
  // Additive metrics sum cleanly; percentage metrics (utilization_pct etc.) sum to
  // "combined" values which the frontend can choose to display or hide.
  const totals: Record<string, Record<string, number>> = {};
  for (const bucket of allColKeys) {
    const bucketTotals: Record<string, number> = {};
    for (const metricKey of metrics) {
      bucketTotals[metricKey] = rows.reduce(
        (sum, row) => sum + (row.data[bucket]?.[metricKey] ?? 0),
        0
      );
    }
    totals[bucket] = bucketTotals;
  }

  const response: DrillResponse = {
    type:         "drill",
    rowDimension,
    colDimension,
    metrics,
    columns:      allColKeys,
    columnLabels,
    rows,
    totals,
  };

  res.json(response);
});

export default router;
