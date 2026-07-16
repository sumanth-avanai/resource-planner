import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { format, addDays, getISODay } from "date-fns";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, CheckCircle2, Loader2, Plus, ChevronRight, ChevronDown, AlertCircle, MessageSquare, TrendingUp, Clock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface PortalRole {
  roleId: number;
  roleName: string;
}

interface PortalProject {
  projectId: number;
  projectName: string;
  clientName: string | null;
  roles: PortalRole[];
}

interface PrefilledRow {
  projectId: number;
  projectName: string;
  clientName: string | null;
  roleId: number | null;
  roleName: string | null;
  plannedHours: number | null;
  entries: Record<string, number>;
  notes: Record<string, string | null>;
  isLegacy: boolean;
}

interface VacationEntry {
  id: number;
  startDate: string;
  endDate: string;
  vacationType: string;
  note: string | null;
}

interface HolidayEntry {
  id: number;
  calendarId: number;
  date: string;
  name: string;
}

interface PortalTimesheetResponse {
  week: { start: string; end: string };
  availableProjects: PortalProject[];
  prefilled: PrefilledRow[];
  vacations: VacationEntry[];
  holidays: HolidayEntry[];
}

interface RowDef {
  rowKey: string;
  projectId: number;
  roleId: number | null;
  projectName: string;
  clientName: string | null;
  roleName: string | null;
  plannedHours: number | null;
  isLegacy: boolean;
}

function makeRowKey(projectId: number, roleId: number | null): string {
  return `${projectId}::${roleId ?? "null"}`;
}

// ── Add-project dialog (filtered to assignments) ──────────────────────────────
function AddPortalRowDialog({
  open,
  onClose,
  availableProjects,
  existingRows,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  availableProjects: PortalProject[];
  existingRows: RowDef[];
  onAdd: (row: Omit<RowDef, "entries">) => void;
}) {
  const [step, setStep] = useState<"project" | "role">("project");
  const [selectedProject, setSelectedProject] = useState<PortalProject | null>(null);

  useEffect(() => {
    if (!open) {
      setStep("project");
      setSelectedProject(null);
    }
  }, [open]);

  const existingProjectIds = new Set(existingRows.map((r) => r.projectId));

  // Projects that still have at least one un-added role
  const addableProjects = availableProjects.filter((p) => {
    if (p.roles.length === 0) {
      return !existingProjectIds.has(p.projectId);
    }
    const existingRoleIds = new Set(
      existingRows.filter((r) => r.projectId === p.projectId).map((r) => r.roleId)
    );
    return p.roles.some((r) => !existingRoleIds.has(r.roleId));
  });

  function handleSelectProject(project: PortalProject) {
    if (project.roles.length === 0) {
      const rk = makeRowKey(project.projectId, null);
      onAdd({
        rowKey: rk,
        projectId: project.projectId,
        roleId: null,
        projectName: project.projectName,
        clientName: project.clientName,
        roleName: null,
        plannedHours: null,
        isLegacy: false,
      });
      onClose();
      return;
    }
    setSelectedProject(project);
    setStep("role");
  }

  function handleSelectRole(role: PortalRole) {
    if (!selectedProject) return;
    const rk = makeRowKey(selectedProject.projectId, role.roleId);
    onAdd({
      rowKey: rk,
      projectId: selectedProject.projectId,
      roleId: role.roleId,
      projectName: selectedProject.projectName,
      clientName: selectedProject.clientName,
      roleName: role.roleName,
      plannedHours: null,
      isLegacy: false,
    });
    onClose();
  }

  const existingRoleIds = selectedProject
    ? new Set(existingRows.filter((r) => r.projectId === selectedProject.projectId).map((r) => r.roleId))
    : new Set<number | null>();

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{step === "project" ? "Add Project" : "Select Role"}</DialogTitle>
        </DialogHeader>

        {step === "project" && (
          <div className="space-y-2 py-2">
            {addableProjects.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                All your assigned projects are already on the timesheet.
              </p>
            ) : (
              addableProjects.map((p) => (
                <button
                  key={p.projectId}
                  type="button"
                  onClick={() => handleSelectProject(p)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors text-sm flex items-center justify-between gap-2"
                >
                  <div>
                    <div className="font-medium">{p.projectName}</div>
                    {p.clientName && <div className="text-xs text-muted-foreground">{p.clientName}</div>}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              ))
            )}
          </div>
        )}

        {step === "role" && selectedProject && (
          <div className="space-y-2 py-2">
            <p className="text-xs text-muted-foreground px-1">{selectedProject.projectName}</p>
            {selectedProject.roles
              .filter((r) => !existingRoleIds.has(r.roleId))
              .map((r) => (
                <button
                  key={r.roleId}
                  type="button"
                  onClick={() => handleSelectRole(r)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors text-sm flex items-center justify-between gap-2"
                >
                  <span className="font-medium">{r.roleName}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
interface PortalTimesheetGridProps {
  employeeId: number;
  employeeToken: string;
  weekStartDate: Date;
  capacityHours: number;
  workingDaysMask?: number[];
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  onPreviousWeek?: () => void;
  onNextWeek?: () => void;
}

const ALL_DAYS_MASK = [1, 1, 1, 1, 1, 1, 1];

const BASE_URL = import.meta.env.BASE_URL ?? "/";

function apiUrl(path: string): string {
  const base = BASE_URL.endsWith("/") ? BASE_URL.slice(0, -1) : BASE_URL;
  return `${base}${path}`;
}

export function PortalTimesheetGrid({
  employeeId,
  employeeToken,
  weekStartDate,
  capacityHours,
  workingDaysMask = ALL_DAYS_MASK,
  contractStartDate = null,
  contractEndDate = null,
  onPreviousWeek,
  onNextWeek,
}: PortalTimesheetGridProps) {
  const queryClient = useQueryClient();

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [addRowOpen, setAddRowOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<number>>(new Set());

  const weekDays = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => addDays(weekStartDate, i)),
    [weekStartDate]
  );

  const startDateStr = format(weekDays[0], "yyyy-MM-dd");
  const endDateStr = format(weekDays[6], "yyyy-MM-dd");

  const timesheetQueryKey = ["portal-timesheet", employeeId, startDateStr];

  const { data: tsData, isLoading } = useQuery<PortalTimesheetResponse>({
    queryKey: timesheetQueryKey,
    queryFn: async () => {
      const res = await fetch(apiUrl(`/api/employee-timesheet/${employeeId}/week/${startDateStr}?token=${encodeURIComponent(employeeToken)}`));
      if (!res.ok) throw new Error("Failed to load timesheet");
      return res.json();
    },
    enabled: !!employeeId && !!employeeToken,
  });

  // ── Grid state: rows + cell data ──────────────────────────────────────────
  const [rows, setRows] = useState<RowDef[]>([]);
  const [gridData, setGridData] = useState<Record<string, Record<string, string>>>({});
  const [noteData, setNoteData] = useState<Record<string, Record<string, string>>>({});

  const rowsRef = useRef<RowDef[]>([]);
  const gridDataRef = useRef<Record<string, Record<string, string>>>({});
  const noteDataRef = useRef<Record<string, Record<string, string>>>({});
  rowsRef.current = rows;
  gridDataRef.current = gridData;
  noteDataRef.current = noteData;

  const initializedForWeek = useRef<string | null>(null);

  // Reset when week changes
  useEffect(() => {
    setIsDirty(false);
    setSaveStatus("idle");
    setSaveError(null);
    setRows([]);
    setGridData({});
    setNoteData({});
    initializedForWeek.current = null;
  }, [startDateStr]);

  // Populate from API response
  useEffect(() => {
    if (!tsData || initializedForWeek.current === startDateStr) return;
    initializedForWeek.current = startDateStr;

    const newRows: RowDef[] = tsData.prefilled.map((p) => ({
      rowKey: makeRowKey(p.projectId, p.roleId),
      projectId: p.projectId,
      roleId: p.roleId,
      projectName: p.projectName,
      clientName: p.clientName,
      roleName: p.roleName,
      plannedHours: p.plannedHours,
      isLegacy: p.isLegacy,
    }));

    const newGrid: Record<string, Record<string, string>> = {};
    const newNotes: Record<string, Record<string, string>> = {};
    for (const p of tsData.prefilled) {
      const rk = makeRowKey(p.projectId, p.roleId);
      newGrid[rk] = {};
      newNotes[rk] = {};
      for (const [date, hours] of Object.entries(p.entries)) {
        newGrid[rk][date] = hours.toString();
      }
      for (const [date, note] of Object.entries(p.notes ?? {})) {
        if (note) newNotes[rk][date] = note;
      }
    }

    setRows(newRows);
    setGridData(newGrid);
    setNoteData(newNotes);
    setIsDirty(false);
    setSaveStatus("idle");
  }, [tsData, startDateStr]);

  // ── Holiday / vacation blocking ───────────────────────────────────────────
  // Vacation and holiday data are bundled directly into the timesheet response
  // so no extra API calls are needed (those endpoints require admin auth).
  const disabledDateReasons = useMemo(() => {
    const reasons = new Map<string, string>();
    const vacations = tsData?.vacations ?? [];
    const holidays = tsData?.holidays ?? [];
    for (const day of weekDays) {
      const dateStr = format(day, "yyyy-MM-dd");
      const isoDayIndex = getISODay(day) - 1;
      if (!workingDaysMask[isoDayIndex]) { reasons.set(dateStr, "Non-working day"); continue; }
      if (contractStartDate && dateStr < contractStartDate) { reasons.set(dateStr, "Outside contract period"); continue; }
      if (contractEndDate && dateStr > contractEndDate) { reasons.set(dateStr, "Outside contract period"); continue; }
      const matchedHoliday = holidays.find((h) => h.date === dateStr);
      if (matchedHoliday) { reasons.set(dateStr, `Public holiday: ${matchedHoliday.name}`); continue; }
      if (vacations.some((v) => v.startDate <= dateStr && dateStr <= v.endDate)) { reasons.set(dateStr, "Vacation / absence"); continue; }
    }
    return reasons;
  }, [weekDays, workingDaysMask, contractStartDate, contractEndDate, tsData?.vacations, tsData?.holidays]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!isDirty || saveStatus === "saving") return;
    setSaveStatus("saving");
    setSaveError(null);

    const entriesToSave: {
      projectId: number;
      projectRoleId?: number | null;
      entryDate: string;
      hours: number;
      note?: string | null;
    }[] = [];

    for (const row of rowsRef.current) {
      const rowDates = gridDataRef.current[row.rowKey] ?? {};
      const rowNotes = noteDataRef.current[row.rowKey] ?? {};
      for (const dateStr of Object.keys(rowDates)) {
        if (disabledDateReasons.has(dateStr)) continue;
        const hours = parseFloat(rowDates[dateStr]);
        entriesToSave.push({
          projectId: row.projectId,
          projectRoleId: row.roleId,
          entryDate: dateStr,
          hours: isNaN(hours) ? 0 : hours,
          note: rowNotes[dateStr] ?? null,
        });
      }
      // Make sure each week day is present (zero out cleared cells that had entries before)
      for (const day of weekDays) {
        const dateStr = format(day, "yyyy-MM-dd");
        if (disabledDateReasons.has(dateStr)) continue;
        if (!rowDates[dateStr]) {
          entriesToSave.push({
            projectId: row.projectId,
            projectRoleId: row.roleId,
            entryDate: dateStr,
            hours: 0,
            note: rowNotes[dateStr] ?? null,
          });
        }
      }
    }

    // Deduplicate: keep last for each projectId+roleId+date
    const seen = new Map<string, typeof entriesToSave[0]>();
    for (const e of entriesToSave) {
      seen.set(`${e.projectId}::${e.projectRoleId ?? "null"}::${e.entryDate}`, e);
    }
    const dedupedEntries = Array.from(seen.values());

    try {
      const res = await fetch(apiUrl(`/api/employee-timesheet/${employeeId}/week/${startDateStr}?token=${encodeURIComponent(employeeToken)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: dedupedEntries }),
      });

      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        setSaveError(body.error ?? "You are not assigned to one of the selected project roles.");
        setSaveStatus("error");
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSaveError(body.error ?? "Failed to save timesheet.");
        setSaveStatus("error");
        return;
      }

      setSaveStatus("saved");
      setIsDirty(false);
      initializedForWeek.current = null;
      queryClient.invalidateQueries({ queryKey: timesheetQueryKey });
      setTimeout(() => setSaveStatus("idle"), 2500);
    } catch {
      setSaveError("Network error. Please try again.");
      setSaveStatus("error");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, saveStatus, employeeId, employeeToken, startDateStr, weekDays, disabledDateReasons, queryClient]);

  // Ctrl+S
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  // Warn on close if dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // ── Cell handlers ─────────────────────────────────────────────────────────
  const handleCellChange = (rowKey: string, date: string, value: string) => {
    if (disabledDateReasons.has(date)) return;
    if (value !== "" && !/^\d*\.?\d*$/.test(value)) return;
    setGridData((prev) => ({
      ...prev,
      [rowKey]: { ...(prev[rowKey] ?? {}), [date]: value },
    }));
    setIsDirty(true);
    if (saveStatus === "saved" || saveStatus === "error") setSaveStatus("idle");
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const move = (r: number, c: number) => {
      const el = document.querySelector(`input[data-prow="${r}"][data-pcol="${c}"]`) as HTMLInputElement | null;
      if (el) { e.preventDefault(); el.focus(); }
    };
    if (e.key === "Enter" || e.key === "ArrowDown") move(rowIndex + 1, colIndex);
    else if (e.key === "ArrowUp") move(rowIndex - 1, colIndex);
    else if (e.key === "ArrowRight") move(rowIndex, colIndex + 1);
    else if (e.key === "ArrowLeft") move(rowIndex, colIndex - 1);
  };

  const handleAddRow = (row: Omit<RowDef, "entries">) => {
    setRows((prev) => {
      if (prev.find((r) => r.rowKey === row.rowKey)) return prev;
      return [...prev, row as RowDef];
    });
    setIsDirty(true);
  };

  const handleNoteChange = (rowKey: string, date: string, value: string) => {
    setNoteData((prev) => ({
      ...prev,
      [rowKey]: { ...(prev[rowKey] ?? {}), [date]: value },
    }));
    setIsDirty(true);
    if (saveStatus === "saved" || saveStatus === "error") setSaveStatus("idle");
  };

  const handleRoleChange = (oldRowKey: string, newRoleId: number, newRoleName: string) => {
    const projectId = rows.find((r) => r.rowKey === oldRowKey)?.projectId ?? 0;
    const newRowKey = makeRowKey(projectId, newRoleId);

    setRows((prev) => {
      const idx = prev.findIndex((r) => r.rowKey === oldRowKey);
      if (idx === -1) return prev;
      const row = prev[idx];
      if (prev.find((r) => r.rowKey === newRowKey)) return prev; // already exists
      const updated = [...prev];
      updated[idx] = { ...row, rowKey: newRowKey, roleId: newRoleId, roleName: newRoleName, isLegacy: false };
      return updated;
    });
    setGridData((prev) => {
      if (!prev[oldRowKey]) return prev;
      const next = { ...prev, [newRowKey]: { ...(prev[oldRowKey] ?? {}) } };
      delete next[oldRowKey];
      return next;
    });
    setNoteData((prev) => {
      if (!prev[oldRowKey]) return prev;
      const next = { ...prev, [newRowKey]: { ...(prev[oldRowKey] ?? {}) } };
      delete next[oldRowKey];
      return next;
    });
    setIsDirty(true);
    if (saveStatus === "saved" || saveStatus === "error") setSaveStatus("idle");
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const projectGroups = useMemo(() => {
    const map = new Map<number, { projectId: number; projectName: string; clientName: string | null; rows: RowDef[] }>();
    for (const row of rows) {
      if (!map.has(row.projectId)) {
        map.set(row.projectId, {
          projectId: row.projectId,
          projectName: row.projectName,
          clientName: row.clientName,
          rows: [],
        });
      }
      map.get(row.projectId)!.rows.push(row);
    }
    return Array.from(map.values());
  }, [rows]);

  const colTotals = weekDays.map((day) => {
    const dateStr = format(day, "yyyy-MM-dd");
    if (disabledDateReasons.has(dateStr)) return 0;
    return rows.reduce((sum, row) => {
      const v = parseFloat(gridData[row.rowKey]?.[dateStr] || "0");
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
  });

  const grandTotal = colTotals.reduce((a, b) => a + b, 0);
  const isOverCapacity = grandTotal > capacityHours;

  // ── Skeleton loader ───────────────────────────────────────────────────────
  if (isLoading && rows.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        </div>
        <div className="border rounded-md bg-card overflow-hidden">
          <div className="bg-muted/50 p-3 grid grid-cols-10 gap-2">
            <Skeleton className="h-4 col-span-2" />
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-4" />)}
          </div>
          {Array.from({ length: 3 }).map((_, ri) => (
            <div key={ri} className="p-3 grid grid-cols-10 gap-2 border-t border-border/50">
              <div className="col-span-2 space-y-1">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2 w-1/2" />
              </div>
              {Array.from({ length: 8 }).map((_, ci) => <Skeleton key={ci} className="h-8 rounded-sm" />)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  const availableProjects = tsData?.availableProjects ?? [];

  const rowGlobalIndex = (rows: RowDef[], rowKey: string) => rows.findIndex((r) => r.rowKey === rowKey);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <Button variant="outline" size="sm" onClick={onPreviousWeek}>
            &larr; Prev Week
          </Button>
          <div className="font-medium text-sm">
            {format(weekDays[0], "MMM d")} – {format(weekDays[6], "MMM d, yyyy")}
          </div>
          <Button variant="outline" size="sm" onClick={onNextWeek}>
            Next Week &rarr;
          </Button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className={`px-3 py-1.5 rounded-md text-sm font-medium border ${isOverCapacity ? "bg-destructive/10 text-destructive border-destructive/20" : "bg-muted/50 border-border"}`}>
            {grandTotal.toFixed(1)} / {capacityHours} hrs
          </div>
          <Button
            onClick={handleSave}
            disabled={!isDirty || saveStatus === "saving"}
            size="sm"
            variant={isDirty ? "default" : "outline"}
            className="min-w-[90px]"
          >
            {saveStatus === "saving" ? (
              <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Saving…</>
            ) : saveStatus === "saved" ? (
              <><CheckCircle2 className="h-4 w-4 mr-1.5" /> Saved</>
            ) : (
              <><Save className="h-4 w-4 mr-1.5" /> Save</>
            )}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {saveStatus === "error" && saveError && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {isDirty && saveStatus !== "error" && (
        <p className="text-xs text-muted-foreground px-1">
          You have unsaved changes — click <strong>Save</strong> or press <kbd className="px-1 py-0.5 rounded border text-xs">Ctrl+S</kbd>
        </p>
      )}

      {/* ── Weekly Summary Card ── */}
      {rows.length > 0 && (() => {
        const capacityPct = capacityHours > 0 ? Math.min(grandTotal / capacityHours, 1) : 0;
        const overCapacity = grandTotal > capacityHours;

        // Per-project summaries
        const projectSummaries = projectGroups.map((group) => {
          const roleSummaries = group.rows.map((row) => {
            const logged = weekDays.reduce((sum, day) => {
              const dateStr = format(day, "yyyy-MM-dd");
              if (disabledDateReasons.has(dateStr)) return sum;
              const v = parseFloat(gridData[row.rowKey]?.[dateStr] || "0");
              return sum + (isNaN(v) ? 0 : v);
            }, 0);
            return { rowKey: row.rowKey, roleName: row.roleName, plannedHours: row.plannedHours, logged };
          });
          const totalLogged = roleSummaries.reduce((s, r) => s + r.logged, 0);
          const totalPlanned = roleSummaries.reduce((s, r) => s + (r.plannedHours ?? 0), 0);
          return { ...group, roleSummaries, totalLogged, totalPlanned };
        });

        return (
          <div className="rounded-md border bg-card p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Weekly Summary</span>
              <span className="text-xs text-muted-foreground ml-auto">
                {format(weekDays[0], "MMM d")} – {format(weekDays[6], "MMM d")}
              </span>
            </div>

            {/* Capacity bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Total logged
                </span>
                <span className={`font-semibold tabular-nums ${overCapacity ? "text-destructive" : "text-foreground"}`}>
                  {grandTotal.toFixed(1)} / {capacityHours} hrs
                  {overCapacity && <span className="ml-1 text-destructive font-normal">(over by {(grandTotal - capacityHours).toFixed(1)}h)</span>}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${overCapacity ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${capacityPct * 100}%` }}
                />
              </div>
            </div>

            {/* Per-project breakdown */}
            <div className="space-y-2">
              {projectSummaries.map((ps) => {
                const projPct = capacityHours > 0 ? Math.min(ps.totalLogged / capacityHours, 1) : 0;
                return (
                  <div key={ps.projectId} className="space-y-1">
                    {/* Project row */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-medium truncate">{ps.projectName}</span>
                        {ps.clientName && (
                          <span className="text-[10px] text-muted-foreground shrink-0">· {ps.clientName}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {ps.totalPlanned > 0 && (
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            plan {ps.totalPlanned}h
                          </span>
                        )}
                        <span className="text-xs font-semibold tabular-nums">
                          {ps.totalLogged > 0 ? ps.totalLogged.toFixed(1) : "0.0"} hrs
                        </span>
                      </div>
                    </div>
                    {/* Thin project bar */}
                    <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary/50 transition-all duration-300"
                        style={{ width: `${projPct * 100}%` }}
                      />
                    </div>
                    {/* Role breakdown (only when multiple roles or planned data exists) */}
                    {ps.roleSummaries.length > 1 || ps.roleSummaries.some((r) => r.plannedHours) ? (
                      <div className="pl-3 space-y-0.5">
                        {ps.roleSummaries.map((rs) => (
                          <div key={rs.rowKey} className="flex items-center justify-between text-[10px] text-muted-foreground">
                            <span className="truncate">{rs.roleName ?? "Unspecified"}</span>
                            <span className="tabular-nums ml-2 shrink-0">
                              {rs.logged > 0 ? rs.logged.toFixed(1) : "0.0"}h
                              {rs.plannedHours != null && rs.plannedHours > 0 && (
                                <span className="ml-1">/ {rs.plannedHours}h planned</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Empty state */}
      {rows.length === 0 && availableProjects.length === 0 && (
        <div className="border rounded-md bg-card p-10 text-center text-muted-foreground space-y-2">
          <p className="font-medium">No projects assigned. Contact your manager.</p>
        </div>
      )}

      {/* Grid */}
      {(rows.length > 0 || availableProjects.length > 0) && (
        <div className="border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-[240px]">Project / Role</TableHead>
                {weekDays.map((day) => {
                  const dateStr = format(day, "yyyy-MM-dd");
                  const isDisabled = disabledDateReasons.has(dateStr);
                  return (
                    <TableHead key={day.toISOString()} className={`text-center w-[80px]${isDisabled ? " opacity-50" : ""}`}>
                      <div className="flex flex-col items-center">
                        <span className="font-medium text-foreground">{format(day, "EEE")}</span>
                        <span className="text-xs text-muted-foreground">{format(day, "MMM d")}</span>
                      </div>
                    </TableHead>
                  );
                })}
                <TableHead className="text-center w-[70px] text-xs">Planned</TableHead>
                <TableHead className="text-right w-[80px]">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projectGroups.map((group) => {
                const isCollapsed = collapsedProjects.has(group.projectId);
                const groupTotal = weekDays.reduce((sum, day) => {
                  const dateStr = format(day, "yyyy-MM-dd");
                  if (disabledDateReasons.has(dateStr)) return sum;
                  return sum + group.rows.reduce((s, row) => {
                    const v = parseFloat(gridData[row.rowKey]?.[dateStr] || "0");
                    return s + (isNaN(v) ? 0 : v);
                  }, 0);
                }, 0);
                const groupPlanned = group.rows.reduce((s, r) => s + (r.plannedHours ?? 0), 0);

                return [
                  // Project header row
                  <TableRow
                    key={`group-${group.projectId}`}
                    className="bg-muted/30 cursor-pointer hover:bg-muted/50 select-none"
                    onClick={() => setCollapsedProjects((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.projectId)) next.delete(group.projectId);
                      else next.add(group.projectId);
                      return next;
                    })}
                  >
                    <TableCell className="font-semibold text-sm py-2">
                      <div className="flex items-center gap-1.5">
                        {isCollapsed
                          ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span>{group.projectName}</span>
                        {group.clientName && (
                          <span className="text-xs text-muted-foreground font-normal">· {group.clientName}</span>
                        )}
                      </div>
                    </TableCell>
                    {weekDays.map((day) => {
                      const dateStr = format(day, "yyyy-MM-dd");
                      const isDisabled = disabledDateReasons.has(dateStr);
                      const dayTotal = isDisabled ? 0 : group.rows.reduce((s, row) => {
                        const v = parseFloat(gridData[row.rowKey]?.[dateStr] || "0");
                        return s + (isNaN(v) ? 0 : v);
                      }, 0);
                      return (
                        <TableCell key={dateStr} className={`text-center text-xs text-muted-foreground${isDisabled ? " bg-muted/50" : ""}`}>
                          {isDisabled ? "—" : isCollapsed && dayTotal > 0 ? dayTotal.toFixed(1) : ""}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-center text-xs text-muted-foreground">
                      {groupPlanned > 0 ? `${groupPlanned}h` : ""}
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium text-muted-foreground">
                      {isCollapsed && groupTotal > 0 ? groupTotal.toFixed(1) : ""}
                    </TableCell>
                  </TableRow>,

                  // Role rows (hidden when collapsed)
                  ...(!isCollapsed ? group.rows.map((row) => {
                    const globalIdx = rowGlobalIndex(rows, row.rowKey);
                    const rowTotal = weekDays.reduce((sum, day) => {
                      const dateStr = format(day, "yyyy-MM-dd");
                      if (disabledDateReasons.has(dateStr)) return sum;
                      const v = parseFloat(gridData[row.rowKey]?.[dateStr] || "0");
                      return sum + (isNaN(v) ? 0 : v);
                    }, 0);

                    // Roles available for this project
                    const projectAvailable = tsData?.availableProjects.find(
                      (p) => p.projectId === group.projectId
                    );
                    const assignedRoles: { roleId: number; roleName: string }[] =
                      projectAvailable?.roles ?? [];

                    // For legacy rows: show "Unspecified" + assigned roles;
                    // for assigned rows: show only assigned roles.
                    const selectValue =
                      row.roleId !== null ? String(row.roleId) : "null";

                    return (
                      <TableRow key={row.rowKey} className="hover:bg-muted/10">
                        <TableCell className="py-1.5">
                          <div className="pl-5 flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">└</span>
                            <Select
                              value={selectValue}
                              onValueChange={(val) => {
                                if (val === "null" || val === selectValue) return;
                                const newRoleId = parseInt(val, 10);
                                const found = assignedRoles.find((r) => r.roleId === newRoleId);
                                if (!found) return;
                                handleRoleChange(row.rowKey, newRoleId, found.roleName);
                              }}
                            >
                              <SelectTrigger className="h-7 text-xs border-transparent hover:border-input w-auto min-w-[120px] max-w-[200px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {row.isLegacy && (
                                  <SelectItem value="null" className="text-xs italic text-muted-foreground">
                                    Unspecified
                                  </SelectItem>
                                )}
                                {assignedRoles.map((r) => (
                                  <SelectItem key={r.roleId} value={String(r.roleId)} className="text-xs">
                                    {r.roleName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            {row.isLegacy && (
                              <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 font-normal text-muted-foreground">
                                legacy
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        {weekDays.map((day, colIndex) => {
                          const dateStr = format(day, "yyyy-MM-dd");
                          const isDisabled = disabledDateReasons.has(dateStr);

                          if (isDisabled) {
                            return (
                              <TableCell key={dateStr} className="p-1 bg-muted/50" title={disabledDateReasons.get(dateStr) ?? "Not bookable"}>
                                <div className="h-9 w-full flex items-center justify-center text-muted-foreground/40 text-sm select-none">—</div>
                              </TableCell>
                            );
                          }

                          const cellNote = noteData[row.rowKey]?.[dateStr] ?? "";
                          const hasNote = cellNote.trim().length > 0;

                          return (
                            <TableCell key={dateStr} className="p-1">
                              <div className="relative group/cell">
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  className="h-9 w-full text-center border-transparent hover:border-input focus:border-ring rounded-sm bg-transparent pr-5"
                                  value={gridData[row.rowKey]?.[dateStr] ?? ""}
                                  onChange={(e) => handleCellChange(row.rowKey, dateStr, e.target.value)}
                                  onKeyDown={(e) => handleKeyDown(e, globalIdx, colIndex)}
                                  data-prow={globalIdx}
                                  data-pcol={colIndex}
                                  placeholder="-"
                                />
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      className={`absolute top-0.5 right-0.5 p-0.5 rounded transition-opacity ${
                                        hasNote
                                          ? "opacity-100 text-primary"
                                          : "opacity-0 group-hover/cell:opacity-60 text-muted-foreground hover:!opacity-100 hover:text-foreground"
                                      }`}
                                      title={hasNote ? cellNote : "Add note"}
                                    >
                                      <MessageSquare className="h-3 w-3" />
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-64 p-3" side="top" align="center">
                                    <div className="space-y-2">
                                      <p className="text-xs font-medium text-muted-foreground">
                                        Note for {format(day, "EEE, MMM d")}
                                      </p>
                                      <Textarea
                                        className="text-xs resize-none"
                                        rows={3}
                                        placeholder="What did you work on?"
                                        value={cellNote}
                                        onChange={(e) => handleNoteChange(row.rowKey, dateStr, e.target.value)}
                                        maxLength={1000}
                                      />
                                      {cellNote.length > 0 && (
                                        <p className="text-[10px] text-muted-foreground text-right">{cellNote.length}/1000</p>
                                      )}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </div>
                            </TableCell>
                          );
                        })}
                        <TableCell className="text-center text-xs text-muted-foreground bg-muted/10">
                          {row.plannedHours != null && row.plannedHours > 0
                            ? `${row.plannedHours}h`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium text-sm bg-muted/20">
                          {rowTotal > 0 ? rowTotal.toFixed(1) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  }) : []),
                ];
              })}

              {/* Footer row */}
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableCell className="p-2">
                  {availableProjects.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-full border-dashed bg-transparent text-muted-foreground hover:text-foreground"
                      onClick={() => setAddRowOpen(true)}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" /> Add project
                    </Button>
                  )}
                </TableCell>
                {weekDays.map((day, i) => {
                  const dateStr = format(day, "yyyy-MM-dd");
                  const isDisabled = disabledDateReasons.has(dateStr);
                  const total = colTotals[i];
                  return (
                    <TableCell key={i} className={`text-center font-medium text-muted-foreground${isDisabled ? " bg-muted/50" : ""}`}>
                      {isDisabled ? "—" : total > 0 ? total.toFixed(1) : "-"}
                    </TableCell>
                  );
                })}
                <TableCell />
                <TableCell className="text-right font-bold text-primary">
                  {grandTotal > 0 ? grandTotal.toFixed(1) : "0.0"}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      <AddPortalRowDialog
        open={addRowOpen}
        onClose={() => setAddRowOpen(false)}
        availableProjects={availableProjects}
        existingRows={rows}
        onAdd={handleAddRow}
      />
    </div>
  );
}
