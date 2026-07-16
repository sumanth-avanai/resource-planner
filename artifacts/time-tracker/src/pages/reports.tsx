import { useState, useMemo, Fragment } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  format,
  startOfWeek, endOfWeek,
  startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter,
  startOfYear, endOfYear,
  subWeeks, subMonths, subQuarters, subYears,
  differenceInCalendarDays,
  parseISO,
} from "date-fns";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListEmployees,
  useListProjects,
  useListClients,
} from "@workspace/api-client-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Download, X, Save, Trash2, ChevronDown, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// ─── Fixed-hours basis ────────────────────────────────────────────────────────

const FIXED_HOURS: Record<string, number> = {
  week:    40,
  month:   173.33,
  quarter: 520,
  year:    2080,
};

type Preset =
  | "this_week"  | "last_week"
  | "this_month" | "last_month"
  | "this_quarter" | "last_quarter"
  | "this_year"  | "last_year"
  | "custom";

const PRESET_LABELS: Record<Preset, string> = {
  this_week:    "This Week",
  last_week:    "Last Week",
  this_month:   "This Month",
  last_month:   "Last Month",
  this_quarter: "This Quarter",
  last_quarter: "Last Quarter",
  this_year:    "This Year",
  last_year:    "Last Year",
  custom:       "Custom Range",
};

const PRESET_PERIOD_TYPE: Record<Preset, keyof typeof FIXED_HOURS | "custom"> = {
  this_week:    "week",
  last_week:    "week",
  this_month:   "month",
  last_month:   "month",
  this_quarter: "quarter",
  last_quarter: "quarter",
  this_year:    "year",
  last_year:    "year",
  custom:       "custom",
};

function toIso(d: Date) {
  return format(d, "yyyy-MM-dd");
}

function presetsFor(preset: Preset): { startDate: string; endDate: string } {
  const now = new Date();
  switch (preset) {
    case "this_week":    return { startDate: toIso(startOfWeek(now, { weekStartsOn: 1 })), endDate: toIso(endOfWeek(now, { weekStartsOn: 1 })) };
    case "last_week":    return { startDate: toIso(startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })), endDate: toIso(endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 })) };
    case "this_month":   return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
    case "last_month":   return { startDate: toIso(startOfMonth(subMonths(now, 1))), endDate: toIso(endOfMonth(subMonths(now, 1))) };
    case "this_quarter": return { startDate: toIso(startOfQuarter(now)), endDate: toIso(endOfQuarter(now)) };
    case "last_quarter": return { startDate: toIso(startOfQuarter(subQuarters(now, 1))), endDate: toIso(endOfQuarter(subQuarters(now, 1))) };
    case "this_year":    return { startDate: toIso(startOfYear(now)), endDate: toIso(endOfYear(now)) };
    case "last_year":    return { startDate: toIso(startOfYear(subYears(now, 1))), endDate: toIso(endOfYear(subYears(now, 1))) };
    default:             return { startDate: toIso(startOfMonth(now)), endDate: toIso(endOfMonth(now)) };
  }
}

function getTargetHours(preset: Preset, startDate: string, endDate: string): number {
  const pt = PRESET_PERIOD_TYPE[preset];
  if (pt !== "custom") return FIXED_HOURS[pt];
  const calDays = differenceInCalendarDays(parseISO(endDate), parseISO(startDate)) + 1;
  return calDays * (260 / 365) * 8;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

interface MetricDef {
  key: string;
  label: string;
  short: string;
}

const ALL_METRICS: MetricDef[] = [
  { key: "target",          label: "Target",        short: "TARGET" },
  { key: "planned",         label: "Planned",       short: "PLANNED" },
  { key: "allocation_pct",  label: "Allocation %",  short: "ALLOC %" },
  { key: "logged",          label: "Logged",        short: "LOGGED" },
  { key: "utilization_pct", label: "Utilization %", short: "UTIL %" },
];

const DEFAULT_METRICS = ["target", "planned", "allocation_pct", "logged", "utilization_pct"];

const VALID_PRESETS = new Set<string>(Object.keys(PRESET_LABELS));

const PCT_METRICS = new Set(["allocation_pct", "utilization_pct"]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface DrillRow {
  id: string;
  name: string;
  type: string;
  data: Record<string, Record<string, number>>;
}

interface DrillResponse {
  rows: DrillRow[];
}

interface EmployeeRow {
  id: string;
  name: string;
  target: number;
  planned: number;
  logged: number;
  allocationPct: number | null;
  utilizationPct: number | null;
  utilizationTarget: number | null;
}

interface ReportConfig {
  preset: Preset;
  startDate: string;
  endDate: string;
  metrics: string[];
  filterEmployees: number[];
  filterProjects: number[];
  filterClients: number[];
  metric?: string;
}

interface SavedReportRow {
  id: string;
  name: string;
  config: string;
  createdAt: string;
  updatedAt: string;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchSavedReports(): Promise<SavedReportRow[]> {
  const res = await fetch("/api/saved-reports");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiCreateSavedReport(name: string, config: ReportConfig): Promise<SavedReportRow> {
  const res = await fetch("/api/saved-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config: JSON.stringify(config) }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiDeleteSavedReport(id: string): Promise<void> {
  const res = await fetch(`/api/saved-reports/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(await res.text());
}

async function fetchPivot(params: URLSearchParams): Promise<DrillResponse> {
  const res = await fetch(`/api/reports/pivot?${params.toString()}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtHours(h: number): string {
  return `${h.toFixed(1)}h`;
}

function fmtPct(p: number): string {
  return p === 0 ? "0%" : `${p.toFixed(1)}%`;
}

function fmtMetric(key: string, value: number | null): string {
  if (value === null) return "—";
  if (PCT_METRICS.has(key)) return fmtPct(value);
  return fmtHours(value);
}

// ─── Color coding ─────────────────────────────────────────────────────────────
// Ratio-based three-tier: actual/target ≥0.75 → green, ≥0.50 → orange, <0.50 → red
// Returns "" when there is no target to compare against.

function pctRatioClass(actual: number | null, target: number | null): string {
  if (actual === null || target === null || target === 0) return "";
  const ratio = actual / target;
  if (ratio >= 0.75) return "text-emerald-600 font-semibold";
  if (ratio >= 0.50) return "text-orange-500 font-semibold";
  return "text-red-500 font-semibold";
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCSV(
  rows: EmployeeRow[],
  totals: EmployeeRow,
  activeMetrics: MetricDef[],
  startDate: string,
  endDate: string,
) {
  const headers = ["Name", ...activeMetrics.map((m) => m.label)];
  const lines: string[] = [headers.join(",")];

  const fmtRow = (row: EmployeeRow) => {
    const cells: string[] = [`"${row.name}"`];
    for (const m of activeMetrics) {
      cells.push(fmtMetric(m.key, getCellValue(row, m.key)));
    }
    return cells.join(",");
  };

  rows.forEach((r) => lines.push(fmtRow(r)));
  lines.push(fmtRow({ ...totals, name: "TOTAL" }));

  const csv  = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `report_${startDate}_${endDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Filter chips component ───────────────────────────────────────────────────

interface FilterOption { id: number; label: string }

interface FilterChipGroupProps {
  label: string;
  chipLabel: string;
  selected: number[];
  options: FilterOption[];
  onChange: (ids: number[]) => void;
}

function FilterChipGroup({ label, chipLabel, selected, options, onChange }: FilterChipGroupProps) {
  const [open, setOpen] = useState(false);
  const selectedOpts = options.filter((o) => selected.includes(o.id));
  const available    = options.filter((o) => !selected.includes(o.id));

  return (
    <>
      {selected.length === 0 ? (
        <Badge variant="secondary" className="gap-1 h-7 text-xs cursor-default font-normal text-muted-foreground">
          {chipLabel}
        </Badge>
      ) : (
        selectedOpts.map((opt) => (
          <Badge key={opt.id} variant="secondary" className="gap-1 h-7 text-xs">
            <span className="text-xs text-muted-foreground mr-0.5">{label}:</span>
            {opt.label}
            <button
              onClick={() => onChange(selected.filter((id) => id !== opt.id))}
              className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))
      )}
      {available.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1 h-7 px-2 text-xs text-muted-foreground border border-dashed rounded-md hover:text-foreground hover:border-foreground/40 transition-colors">
              <Plus className="h-3 w-3" />
              {label}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-1" align="start">
            <div className="py-1 px-2 text-xs font-medium text-muted-foreground">{label}</div>
            {available.map((opt) => (
              <button
                key={opt.id}
                className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-muted transition-colors"
                onClick={() => { onChange([...selected, opt.id]); setOpen(false); }}
              >
                {opt.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

// ─── Metric chips component ────────────────────────────────────────────────────

interface MetricChipsProps {
  active: string[];
  onChange: (keys: string[]) => void;
}

function MetricChips({ active, onChange }: MetricChipsProps) {
  const [open, setOpen] = useState(false);
  const available = ALL_METRICS.filter((m) => !active.includes(m.key));
  const activeMetrics = ALL_METRICS.filter((m) => active.includes(m.key));

  return (
    <>
      {activeMetrics.map((m) => (
        <Badge key={m.key} variant="outline" className="gap-1 h-7 text-xs">
          {m.label}
          <button
            onClick={() => onChange(active.filter((k) => k !== m.key))}
            className="ml-0.5 rounded-sm opacity-60 hover:opacity-100"
            disabled={active.length <= 1}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {available.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1 h-7 px-2 text-xs text-muted-foreground border border-dashed rounded-md hover:text-foreground hover:border-foreground/40 transition-colors">
              <Plus className="h-3 w-3" />
              Add metric
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="start">
            <div className="py-1 px-2 text-xs font-medium text-muted-foreground">Metrics</div>
            {available.map((m) => (
              <button
                key={m.key}
                className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-muted transition-colors"
                onClick={() => { onChange([...active, m.key]); setOpen(false); }}
              >
                {m.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

// ─── Cell value helper (standalone so exportCSV can also use it) ──────────────

function getCellValue(row: EmployeeRow, key: string): number | null {
  switch (key) {
    case "target":           return row.target > 0 ? row.target : null;
    case "planned":          return row.planned > 0 ? row.planned : null;
    case "logged":           return row.logged  > 0 ? row.logged  : null;
    case "allocation_pct":   return row.allocationPct;
    case "utilization_pct":  return row.utilizationPct;
    case "util_target_pct":  return (row.utilizationTarget !== null && row.utilizationTarget > 0)
      ? row.utilizationTarget : null;
    default: return null;
  }
}

function sortRows(
  rows: EmployeeRow[],
  col: string | null,
  dir: "asc" | "desc" | null,
): EmployeeRow[] {
  // Reset / no sort: default to UTIL% descending, then alpha by name
  if (!col || !dir) {
    return [...rows].sort((a, b) => {
      const av = a.utilizationPct ?? -1;
      const bv = b.utilizationPct ?? -1;
      if (av !== bv) return bv - av;
      return a.name.localeCompare(b.name);
    });
  }
  // Name column: alphabetical
  if (col === "name") {
    return [...rows].sort((a, b) =>
      dir === "asc"
        ? a.name.localeCompare(b.name)
        : b.name.localeCompare(a.name),
    );
  }
  // Numeric columns: nulls always sink to the bottom
  return [...rows].sort((a, b) => {
    const av = getCellValue(a, col);
    const bv = getCellValue(b, col);
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  });
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}

function KpiCard({ label, value, sub, valueClass }: KpiCardProps) {
  return (
    <div className="flex-1 min-w-[180px] border rounded-xl bg-card px-6 py-5 shadow-sm space-y-1">
      <p className="text-sm text-muted-foreground font-medium">{label}</p>
      <p className={`text-3xl font-bold tracking-tight ${valueClass ?? ""}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Reports() {
  const [preset, setPreset]         = useState<Preset>("this_month");
  const [startDate, setStartDate]   = useState(() => presetsFor("this_month").startDate);
  const [endDate, setEndDate]       = useState(() => presetsFor("this_month").endDate);
  const [activeMetrics, setActiveMetrics] = useState<string[]>(DEFAULT_METRICS);
  const [filterEmployees, setFilterEmployees] = useState<number[]>([]);
  const [filterProjects, setFilterProjects]   = useState<number[]>([]);
  const [filterClients, setFilterClients]     = useState<number[]>([]);

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName]             = useState("");
  const [saveError, setSaveError]           = useState("");
  const queryClient = useQueryClient();

  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);

  const { data: employees } = useListEmployees();
  const { data: projects }  = useListProjects({ includeInactive: false });
  const { data: clients }   = useListClients();

  const employeeOptions = useMemo(() => (Array.isArray(employees) ? employees : []).map((e) => ({ id: e.id, label: e.name })), [employees]);
  const projectOptions  = useMemo(() => (Array.isArray(projects) ? projects : []).map((p) => ({ id: p.id, label: p.clientName ? `${p.name} (${p.clientName})` : p.name })), [projects]);
  const clientOptions   = useMemo(() => (Array.isArray(clients) ? clients : []).map((c) => ({ id: c.id, label: c.name })), [clients]);

  const queryParams = useMemo(() => {
    const p = new URLSearchParams({
      startDate,
      endDate,
      rowDimension: "employees",
      colDimension: "none",
    });
    p.append("metrics", "planned");
    p.append("metrics", "booked");
    if (filterEmployees.length) p.set("employeeIds", filterEmployees.join(","));
    if (filterProjects.length)  p.set("projectIds",  filterProjects.join(","));
    if (filterClients.length)   p.set("clientIds",   filterClients.join(","));
    return p;
  }, [startDate, endDate, filterEmployees, filterProjects, filterClients]);

  const { data: pivotData, isLoading, error } = useQuery<DrillResponse>({
    queryKey: ["reports-pivot-v2", queryParams.toString()],
    queryFn: () => fetchPivot(queryParams),
  });

  const { data: savedReports = [] } = useQuery<SavedReportRow[]>({
    queryKey: ["saved-reports"],
    queryFn: fetchSavedReports,
  });

  const createReport = useMutation({
    mutationFn: ({ name, config }: { name: string; config: ReportConfig }) =>
      apiCreateSavedReport(name, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["saved-reports"] });
      setSaveDialogOpen(false); setSaveName(""); setSaveError("");
    },
  });

  const deleteReport = useMutation({
    mutationFn: (id: string) => apiDeleteSavedReport(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["saved-reports"] }),
  });

  const handleLoadReport = (row: SavedReportRow) => {
    try {
      const cfg: ReportConfig = JSON.parse(row.config);
      const rawPreset = cfg.preset ?? "this_month";
      const p: Preset = VALID_PRESETS.has(rawPreset) ? (rawPreset as Preset) : "this_month";
      const ms = cfg.metrics ?? (cfg.metric ? [cfg.metric] : DEFAULT_METRICS);
      const validMs = ms.filter((k) => ALL_METRICS.some((m) => m.key === k));
      setPreset(p);
      if (p !== "custom") {
        const dates = presetsFor(p);
        setStartDate(dates.startDate);
        setEndDate(dates.endDate);
      } else {
        setStartDate(cfg.startDate ?? presetsFor("this_month").startDate);
        setEndDate(cfg.endDate ?? presetsFor("this_month").endDate);
      }
      setActiveMetrics(validMs.length > 0 ? validMs : DEFAULT_METRICS);
      setFilterEmployees(cfg.filterEmployees ?? []);
      setFilterProjects(cfg.filterProjects ?? []);
      setFilterClients(cfg.filterClients ?? []);
    } catch { /* ignore malformed */ }
  };

  const handlePreset = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") {
      const { startDate: s, endDate: e } = presetsFor(p);
      setStartDate(s);
      setEndDate(e);
    }
  };

  const baseTarget = useMemo(
    () => getTargetHours(preset, startDate, endDate),
    [preset, startDate, endDate],
  );

  const employeeCapacityMap = useMemo<Map<number, number>>(() => {
    const m = new Map<number, number>();
    for (const e of employees ?? []) m.set(e.id, e.weeklyCapacityHours ?? 40);
    return m;
  }, [employees]);

  const employeeUtilTargetMap = useMemo<Map<number, number | null>>(() => {
    const m = new Map<number, number | null>();
    for (const e of employees ?? []) m.set(e.id, (e as any).utilizationTarget ?? null);
    return m;
  }, [employees]);

  const employeeRows = useMemo<EmployeeRow[]>(() => {
    if (!pivotData?.rows) return [];
    return pivotData.rows.map((row) => {
      const planned          = row.data?.["Total"]?.["planned"] ?? 0;
      const logged           = row.data?.["Total"]?.["booked"]  ?? 0;
      const empId            = parseInt(row.id.replace(/^emp-/, ""), 10);
      const capacity         = employeeCapacityMap.get(empId) ?? 40;
      const target           = Math.round(baseTarget * (capacity / 40) * 100) / 100;
      const utilizationTarget = employeeUtilTargetMap.get(empId) ?? null;
      return {
        id:             row.id,
        name:           row.name,
        target,
        planned,
        logged,
        allocationPct:    target > 0 ? Math.round((planned / target) * 1000) / 10 : null,
        utilizationPct:   target > 0 ? Math.round((logged  / target) * 1000) / 10 : null,
        utilizationTarget,
      };
    });
  }, [pivotData, baseTarget, employeeCapacityMap, employeeUtilTargetMap]);

  const teamTotals = useMemo<EmployeeRow>(() => {
    // Denominator: available hours of employees with utilizationTarget > 0 only.
    // Numerator: logged/planned hours of all employees (target=0 employees who
    // logged 0h contribute 0 to the sum, so no explicit exclusion needed).
    const denomTarget  = employeeRows
      .filter((r) => r.utilizationTarget !== null && r.utilizationTarget > 0)
      .reduce((s, r) => s + r.target, 0);
    const totalPlanned = employeeRows.reduce((s, r) => s + r.planned, 0);
    const totalLogged  = employeeRows.reduce((s, r) => s + r.logged,  0);
    return {
      id:               "total",
      name:             "TOTAL",
      target:           denomTarget,
      planned:          totalPlanned,
      logged:           totalLogged,
      allocationPct:    denomTarget > 0 ? Math.round((totalPlanned / denomTarget) * 1000) / 10 : null,
      utilizationPct:   denomTarget > 0 ? Math.round((totalLogged  / denomTarget) * 1000) / 10 : null,
      utilizationTarget: null,
    };
  }, [employeeRows]);

  // Weighted average utilization target across employees with utilizationTarget > 0.
  // Employees with target = 0 or null are excluded so they don't dilute the team goal %.
  const teamUtilTarget = useMemo<number | null>(() => {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const row of employeeRows) {
      if (row.utilizationTarget !== null && row.utilizationTarget > 0) {
        weightedSum += row.utilizationTarget * row.target;
        totalWeight += row.target;
      }
    }
    return totalWeight > 0 ? weightedSum / totalWeight : null;
  }, [employeeRows]);

  const metricsVisible = useMemo(
    () => ALL_METRICS.filter((m) => activeMetrics.includes(m.key)),
    [activeMetrics],
  );

  const periodLabel = preset !== "custom"
    ? PRESET_LABELS[preset]
    : `${startDate} → ${endDate}`;

  const kpiAllocPct  = teamTotals.allocationPct;
  const kpiUtilPct   = teamTotals.utilizationPct;
  const kpiTargetHrs = teamTotals.target;

  const hasData = employeeRows.length > 0;

  const trackedRows = useMemo(
    () => sortRows(
      employeeRows.filter((r) => r.utilizationTarget !== null && r.utilizationTarget > 0),
      sortCol, sortDir,
    ),
    [employeeRows, sortCol, sortDir],
  );

  const untrackedRows = useMemo(
    () => sortRows(
      employeeRows.filter((r) => r.utilizationTarget === null || r.utilizationTarget === 0),
      sortCol, sortDir,
    ),
    [employeeRows, sortCol, sortDir],
  );

  function handleSortClick(col: string) {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  }

  return (
    <AdminLayout>
      <div className="space-y-5 max-w-[1300px] mx-auto">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex-1">
            Team Overview
          </h1>

          {/* Period selector */}
          <Select value={preset} onValueChange={(v) => handlePreset(v as Preset)}>
            <SelectTrigger className="w-[170px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PRESET_LABELS) as Preset[])
                .filter((p) => p !== "custom")
                .map((p) => (
                  <SelectItem key={p} value={p}>{PRESET_LABELS[p]}</SelectItem>
                ))}
              <SelectItem value="custom">Custom Range…</SelectItem>
            </SelectContent>
          </Select>

          {/* Custom date pickers — only when custom */}
          {preset === "custom" && (
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-9 w-[145px]"
              />
              <span className="text-muted-foreground text-sm">→</span>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-9 w-[145px]"
              />
            </div>
          )}

          {/* Saved reports dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-9">
                <Save className="h-4 w-4" />
                Saved
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {savedReports.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                  No saved reports yet
                </div>
              ) : (
                savedReports.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-1 group mx-1 my-0.5 rounded-sm hover:bg-accent"
                  >
                    <button
                      className="flex-1 text-left truncate text-sm px-2 py-1.5"
                      onClick={() => handleLoadReport(r)}
                    >
                      {r.name}
                    </button>
                    <button
                      className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all p-1 rounded"
                      onClick={() => deleteReport.mutate(r.id)}
                      disabled={deleteReport.isPending}
                      title="Delete saved report"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
              {savedReports.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={() => { setSaveName(""); setSaveError(""); setSaveDialogOpen(true); }}
                className="gap-2"
              >
                <Save className="h-3.5 w-3.5" />
                Save current view…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Export */}
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            disabled={!hasData}
            onClick={() => exportCSV(employeeRows, teamTotals, metricsVisible, startDate, endDate)}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </div>

        {/* ── KPI Cards ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-4">
          <KpiCard
            label="Allocation"
            value={kpiAllocPct !== null && hasData ? fmtPct(kpiAllocPct) : "—"}
            sub={teamUtilTarget !== null ? `Planned ÷ Target · Team goal: ${Math.round(teamUtilTarget)}%` : "Planned ÷ Target"}
            valueClass={
              kpiAllocPct === null || !hasData
                ? "text-muted-foreground"
                : pctRatioClass(kpiAllocPct, teamUtilTarget) || "text-foreground"
            }
          />
          <KpiCard
            label="Utilization"
            value={kpiUtilPct !== null && hasData ? fmtPct(kpiUtilPct) : "—"}
            sub={teamUtilTarget !== null ? `Logged ÷ Target · Team goal: ${Math.round(teamUtilTarget)}%` : "Logged ÷ Target"}
            valueClass={
              kpiUtilPct === null || !hasData
                ? "text-muted-foreground"
                : pctRatioClass(kpiUtilPct, teamUtilTarget) || "text-foreground"
            }
          />
          <KpiCard
            label="Target"
            value={hasData ? fmtHours(kpiTargetHrs) : "—"}
            sub={`${fmtHours(baseTarget)} base × ${employeeRows.length} employee${employeeRows.length !== 1 ? "s" : ""}`}
            valueClass="text-foreground"
          />
        </div>

        {/* ── Filter + Metric chips toolbar ──────────────────────────────── */}
        <div className="space-y-2 border rounded-lg px-4 py-3 bg-card shadow-sm">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground w-14 shrink-0">Filters:</span>
            <FilterChipGroup
              label="Employee"
              chipLabel="All employees"
              selected={filterEmployees}
              options={employeeOptions}
              onChange={setFilterEmployees}
            />
            <FilterChipGroup
              label="Project"
              chipLabel="All projects"
              selected={filterProjects}
              options={projectOptions}
              onChange={setFilterProjects}
            />
            <FilterChipGroup
              label="Client"
              chipLabel="All clients"
              selected={filterClients}
              options={clientOptions}
              onChange={setFilterClients}
            />
          </div>

          {/* Metrics */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground w-14 shrink-0">Metrics:</span>
            <MetricChips active={activeMetrics} onChange={setActiveMetrics} />
          </div>
        </div>

        {/* ── Loading / error states ──────────────────────────────────────── */}
        {isLoading && (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}
        {error && (
          <div className="border border-destructive/30 bg-destructive/10 text-destructive rounded-md p-4 text-sm">
            Failed to load report data. Please try again.
          </div>
        )}

        {/* ── Data table ─────────────────────────────────────────────────── */}
        {!isLoading && !error && (
          <div className="border rounded-md bg-card overflow-x-auto shadow-sm">
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead
                    className="min-w-[200px] font-semibold text-xs uppercase tracking-wide cursor-pointer select-none hover:text-foreground"
                    onClick={() => handleSortClick("name")}
                  >
                    Name
                    {sortCol === "name" && (
                      <span className="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </TableHead>
                  {metricsVisible.map((m) => (
                    <Fragment key={m.key}>
                      <TableHead
                        className="text-right text-xs uppercase tracking-wide font-semibold whitespace-nowrap px-4 cursor-pointer select-none hover:text-foreground"
                        onClick={() => handleSortClick(m.key)}
                      >
                        {m.short}
                        {sortCol === m.key && (
                          <span className="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>
                        )}
                      </TableHead>
                      {m.key === "utilization_pct" && (
                        <TableHead
                          className="text-right text-xs uppercase tracking-wide font-semibold whitespace-nowrap px-4 text-muted-foreground cursor-pointer select-none hover:text-foreground"
                          onClick={() => handleSortClick("util_target_pct")}
                        >
                          TARGET
                          {sortCol === "util_target_pct" && (
                            <span className="ml-1 opacity-60">{sortDir === "asc" ? "↑" : "↓"}</span>
                          )}
                        </TableHead>
                      )}
                    </Fragment>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {employeeRows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={1 + metricsVisible.length + (metricsVisible.some((m) => m.key === "utilization_pct") ? 1 : 0)}
                      className="text-center py-12 text-muted-foreground text-sm"
                    >
                      No data for {periodLabel}.
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {/* ── Tracked rows (utilizationTarget > 0) ──────────────── */}
                    {trackedRows.map((row) => (
                      <TableRow key={row.id} className="hover:bg-muted/20">
                        <TableCell className="font-medium py-3">{row.name}</TableCell>
                        {metricsVisible.map((m) => {
                          const val = getCellValue(row, m.key);
                          const isTargetPct = (m.key === "utilization_pct" || m.key === "allocation_pct")
                            && row.utilizationTarget !== null && row.utilizationTarget > 0 && val !== null;
                          const colorClass = isTargetPct
                            ? pctRatioClass(val, row.utilizationTarget)
                            : "";
                          return (
                            <Fragment key={m.key}>
                              <TableCell className={`text-right tabular-nums whitespace-nowrap px-4 py-3 ${colorClass}`}>
                                {fmtMetric(m.key, val)}
                              </TableCell>
                              {m.key === "utilization_pct" && (
                                <TableCell className="text-right tabular-nums whitespace-nowrap px-4 py-3 text-muted-foreground text-sm">
                                  {row.utilizationTarget !== null && row.utilizationTarget > 0
                                    ? `${row.utilizationTarget}%`
                                    : "—"}
                                </TableCell>
                              )}
                            </Fragment>
                          );
                        })}
                      </TableRow>
                    ))}

                    {/* ── Untracked section (utilizationTarget = 0 | null) ──── */}
                    {untrackedRows.length > 0 && (() => {
                      const colSpan = 1 + metricsVisible.length
                        + (metricsVisible.some((m) => m.key === "utilization_pct") ? 1 : 0);
                      return (
                        <>
                          <TableRow className="border-t border-border/60">
                            <TableCell
                              colSpan={colSpan}
                              className="py-1.5 px-4 text-xs font-semibold text-muted-foreground/60 uppercase tracking-widest bg-muted/20"
                            >
                              NO UTILIZATION TARGET
                            </TableCell>
                          </TableRow>
                          {untrackedRows.map((row) => (
                            <TableRow key={row.id} className="hover:bg-muted/20 text-muted-foreground">
                              <TableCell className="font-medium py-3">{row.name}</TableCell>
                              {metricsVisible.map((m) => {
                                // ALLOC% and UTIL% always show — for untracked employees
                                const val = (m.key === "allocation_pct" || m.key === "utilization_pct")
                                  ? null
                                  : getCellValue(row, m.key);
                                return (
                                  <Fragment key={m.key}>
                                    <TableCell className="text-right tabular-nums whitespace-nowrap px-4 py-3">
                                      {fmtMetric(m.key, val)}
                                    </TableCell>
                                    {m.key === "utilization_pct" && (
                                      <TableCell className="text-right tabular-nums whitespace-nowrap px-4 py-3 text-sm">
                                        —
                                      </TableCell>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </TableRow>
                          ))}
                        </>
                      );
                    })()}

                    {/* ── Totals row ──────────────────────────────────────────── */}
                    <TableRow className="border-t-2 border-border bg-muted/30 font-semibold">
                      <TableCell className="py-3 text-sm">Total</TableCell>
                      {metricsVisible.map((m) => {
                        const val = getCellValue(teamTotals, m.key);
                        const isTargetPct = (m.key === "utilization_pct" || m.key === "allocation_pct") && teamUtilTarget !== null && val !== null;
                        const colorClass = isTargetPct
                          ? pctRatioClass(val, teamUtilTarget)
                          : "";
                        return (
                          <Fragment key={m.key}>
                            <TableCell className={`text-right tabular-nums whitespace-nowrap px-4 py-3 text-sm ${colorClass}`}>
                              {fmtMetric(m.key, val)}
                            </TableCell>
                            {m.key === "utilization_pct" && (
                              <TableCell className="text-right tabular-nums whitespace-nowrap px-4 py-3 text-muted-foreground text-sm">
                                {teamUtilTarget !== null ? `${Math.round(teamUtilTarget)}%` : "—"}
                              </TableCell>
                            )}
                          </Fragment>
                        );
                      })}
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Fixed-hours note */}
        <p className="text-xs text-muted-foreground">
          Target hours are fixed: 40h/week · 173.33h/month · 520h/quarter · 2,080h/year.
          Holidays and vacations are not deducted.
        </p>
      </div>

      {/* ── Save dialog ────────────────────────────────────────────────────── */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Save Report</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="save-report-name">Name</Label>
              <Input
                id="save-report-name"
                placeholder="e.g. Q2 Team Allocation"
                value={saveName}
                onChange={(e) => { setSaveName(e.target.value); setSaveError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const trimmed = saveName.trim();
                    if (!trimmed) { setSaveError("Please enter a name."); return; }
                    createReport.mutate({ name: trimmed, config: buildConfig() });
                  }
                }}
                autoFocus
              />
              {saveError && <p className="text-xs text-destructive">{saveError}</p>}
            </div>
            <p className="text-xs text-muted-foreground">
              Saves the current period, metrics, and filters.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={createReport.isPending}
              onClick={() => {
                const trimmed = saveName.trim();
                if (!trimmed) { setSaveError("Please enter a name."); return; }
                createReport.mutate({ name: trimmed, config: buildConfig() });
              }}
            >
              {createReport.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );

  function buildConfig(): ReportConfig {
    return {
      preset,
      startDate,
      endDate,
      metrics: activeMetrics,
      filterEmployees,
      filterProjects,
      filterClients,
    };
  }
}
