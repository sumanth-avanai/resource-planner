import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useDirtyGuard } from "@/contexts/dirty-guard";
import { format, addDays, getISODay, subWeeks } from "date-fns";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useListProjects,
  getListProjectsQueryKey,
  useListTimeEntries,
  getListTimeEntriesQueryKey,
  useBulkUpsertTimeEntries,
  useListHolidayCalendars,
  getListHolidayCalendarsQueryKey,
  useListHolidays,
  getListHolidaysQueryKey,
  listTimeEntries,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, CheckCircle2, Loader2, Copy, CalendarRange, Plus, ChevronRight } from "lucide-react";
import { VacationEntry } from "@/lib/bookable-dates";
import { RecurringBookingDialog } from "./recurring-booking-dialog";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ProjectRole {
  id: number;
  name: string;
  dayRate: number;
  budgetedDays: number | null;
  assignedEmployees: { employeeId: number; employeeName: string | null }[];
}

// A single editable row = one project × one role (or null role for legacy / no-role projects)
interface RowDef {
  rowKey: string;       // "${projectId}::${roleId|null}"
  projectId: number;
  projectRoleId: number | null;
}

function makeRowKey(projectId: number, roleId: number | null): string {
  return `${projectId}::${roleId ?? "null"}`;
}

interface TimesheetGridProps {
  employeeId: number;
  weekStartDate: Date;
  capacityHours: number;
  workingDaysMask?: number[];
  contractStartDate?: string | null;
  contractEndDate?: string | null;
  holidayCalendarCode?: string | null;
  onPreviousWeek?: () => void;
  onNextWeek?: () => void;
}

const ALL_DAYS_MASK = [1, 1, 1, 1, 1, 1, 1];

// ── Add-project-with-role dialog ──────────────────────────────────────────────
function AddRowDialog({
  open,
  onClose,
  projects,
  existingRows,
  employeeId,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  projects: { id: number; name: string; clientName?: string | null }[];
  existingRows: RowDef[];
  employeeId: number;
  onAdd: (row: RowDef) => void;
}) {
  const [step, setStep] = useState<"project" | "role">("project");
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [roles, setRoles] = useState<ProjectRole[] | null>(null);
  const [loadingRoles, setLoadingRoles] = useState(false);

  useEffect(() => {
    if (!open) { setStep("project"); setSelectedProjectId(null); setRoles(null); }
  }, [open]);

  async function handleSelectProject(id: number) {
    setSelectedProjectId(id);
    setLoadingRoles(true);
    try {
      const res = await fetch(`/api/projects/${id}/roles`);
      const data: ProjectRole[] = res.ok ? await res.json() : [];
      setRoles(data);
      if (data.length === 0) {
        // No roles → add row directly (backward compat)
        const rowKey = makeRowKey(id, null);
        if (!existingRows.find((r) => r.rowKey === rowKey)) {
          onAdd({ rowKey, projectId: id, projectRoleId: null });
        }
        onClose();
      } else {
        setStep("role");
      }
    } finally {
      setLoadingRoles(false);
    }
  }

  function handleSelectRole(roleId: number | null) {
    if (selectedProjectId == null) return;
    const rowKey = makeRowKey(selectedProjectId, roleId);
    if (!existingRows.find((r) => r.rowKey === rowKey)) {
      onAdd({ rowKey, projectId: selectedProjectId, projectRoleId: roleId });
    }
    onClose();
  }

  // Pre-select a role if the employee is assigned to exactly one
  function preSelectedRoleId(): number | null | undefined {
    if (!roles || selectedProjectId == null) return undefined;
    const assigned = roles.filter((r) =>
      r.assignedEmployees.some((a) => a.employeeId === employeeId)
    );
    return assigned.length === 1 ? assigned[0].id : undefined;
  }

  const existingProjectIds = new Set(existingRows.map((r) => r.projectId));
  // For role step, filter out already-added role rows for this project
  const existingRoleIds = new Set(
    existingRows.filter((r) => r.projectId === selectedProjectId).map((r) => r.projectRoleId)
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {step === "project" ? "Add Project" : "Select Role"}
          </DialogTitle>
        </DialogHeader>

        {step === "project" && (
          <div className="space-y-2 py-2">
            {loadingRoles ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              projects
                .filter((p) => !existingProjectIds.has(p.id) || existingRows.some((r) => r.projectId === p.id && r.projectRoleId != null))
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectProject(p.id)}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors text-sm flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-medium">{p.name}</div>
                      {p.clientName && <div className="text-xs text-muted-foreground">{p.clientName}</div>}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                ))
            )}
          </div>
        )}

        {step === "role" && roles && (
          <div className="space-y-2 py-2">
            <p className="text-xs text-muted-foreground px-1">
              {projects.find((p) => p.id === selectedProjectId)?.name}
            </p>
            {roles
              .filter((r) => !existingRoleIds.has(r.id))
              .map((r) => {
                const isAssigned = r.assignedEmployees.some((a) => a.employeeId === employeeId);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => handleSelectRole(r.id)}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-muted transition-colors text-sm flex items-center justify-between gap-2"
                  >
                    <div>
                      <div className="font-medium">
                        {r.name}
                        {isAssigned && (
                          <span className="ml-2 text-xs text-primary bg-primary/10 rounded px-1.5 py-0.5">assigned</span>
                        )}
                      </div>
                      {r.budgetedDays && (
                        <div className="text-xs text-muted-foreground">{r.budgetedDays}d budget</div>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => handleSelectRole(null)}
            >
              Book without role
            </Button>
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
export function TimesheetGrid({
  employeeId,
  weekStartDate,
  capacityHours,
  workingDaysMask = ALL_DAYS_MASK,
  contractStartDate = null,
  contractEndDate = null,
  holidayCalendarCode = null,
  onPreviousWeek,
  onNextWeek,
}: TimesheetGridProps) {
  const queryClient = useQueryClient();
  const dirtyGuard = useDirtyGuard();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [isDirty, setIsDirty] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "loading" | "done" | "empty">("idle");
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [addRowOpen, setAddRowOpen] = useState(false);

  // Snapshot of the previous week's grid — shown while new data is loading
  const previousDisplayRef = useRef<{
    activeRows: RowDef[];
    gridData: Record<string, Record<string, string>>;
  } | null>(null);

  // Always-fresh refs so effects can read latest state without stale closures
  const activeRowsRef = useRef<RowDef[]>([]);
  const gridDataRef = useRef<Record<string, Record<string, string>>>({});

  const weekDays = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => addDays(weekStartDate, i)),
    [weekStartDate]
  );

  const startDateStr = format(weekDays[0], "yyyy-MM-dd");
  const endDateStr = format(weekDays[6], "yyyy-MM-dd");

  const { data: projects } = useListProjects(
    { includeInactive: false },
    { query: { queryKey: getListProjectsQueryKey({ includeInactive: false }) } }
  );

  const { data: timeEntries, isLoading: entriesLoading } = useListTimeEntries(
    { employeeId, startDate: startDateStr, endDate: endDateStr },
    {
      query: {
        queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }),
        enabled: !!employeeId,
      },
    }
  );

  // Fetch roles for all active projects (batch)
  const activeProjectIds = useMemo(
    () => [...new Set(activeRowsRef.current.map((r) => r.projectId))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRowsRef.current]
  );

  const { data: rolesData } = useQuery<Record<number, ProjectRole[]>>({
    queryKey: ["project-roles-bulk", activeProjectIds.sort().join(",")],
    queryFn: async () => {
      const result: Record<number, ProjectRole[]> = {};
      await Promise.all(
        activeProjectIds.map(async (pid) => {
          const res = await fetch(`/api/projects/${pid}/roles`);
          result[pid] = res.ok ? await res.json() : [];
        })
      );
      return result;
    },
    enabled: activeProjectIds.length > 0,
  });

  const rolesByProject: Record<number, ProjectRole[]> = rolesData ?? {};

  // Holiday calendars — resolve code → numeric calendar ID
  const { data: holidayCalendars } = useListHolidayCalendars({
    query: {
      queryKey: getListHolidayCalendarsQueryKey(),
      enabled: !!holidayCalendarCode,
    },
  });

  const calendarId = useMemo(() => {
    if (!holidayCalendarCode || !holidayCalendars) return null;
    return holidayCalendars.find((c) => c.code === holidayCalendarCode)?.id ?? null;
  }, [holidayCalendarCode, holidayCalendars]);

  const weekYear = weekDays[0].getFullYear();
  const { data: holidays } = useListHolidays(
    calendarId ?? 0,
    { year: weekYear },
    {
      query: {
        queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: weekYear }),
        enabled: !!calendarId,
      },
    }
  );

  const { data: vacations } = useQuery<VacationEntry[]>({
    queryKey: ["vacations", employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/vacations?employeeId=${employeeId}`);
      if (!res.ok) throw new Error("Failed to fetch vacations");
      return res.json() as Promise<VacationEntry[]>;
    },
    enabled: !!employeeId,
  });

  const disabledDateReasons = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const day of weekDays) {
      const dateStr = format(day, "yyyy-MM-dd");
      const isoDayIndex = getISODay(day) - 1;
      if (!workingDaysMask[isoDayIndex]) { reasons.set(dateStr, "Non-working day"); continue; }
      if (contractStartDate && dateStr < contractStartDate) { reasons.set(dateStr, "Outside contract period"); continue; }
      if (contractEndDate && dateStr > contractEndDate) { reasons.set(dateStr, "Outside contract period"); continue; }
      const matchedHoliday = holidays?.find((h) => String(h.date).slice(0, 10) === dateStr);
      if (matchedHoliday) { reasons.set(dateStr, `Public holiday: ${matchedHoliday.name}`); continue; }
      if (vacations?.some((v) => v.startDate <= dateStr && dateStr <= v.endDate)) { reasons.set(dateStr, "Vacation / absence"); continue; }
    }
    return reasons;
  }, [weekDays, workingDaysMask, contractStartDate, contractEndDate, holidays, vacations]);

  const bulkUpsert = useBulkUpsertTimeEntries();

  const [gridData, setGridData] = useState<Record<string, Record<string, string>>>({});
  const [activeRows, setActiveRows] = useState<RowDef[]>([]);

  activeRowsRef.current = activeRows;
  gridDataRef.current = gridData;

  const initializedForParams = useRef<string | null>(null);
  const currentParamsKey = `${employeeId}-${startDateStr}-${endDateStr}`;

  useEffect(() => {
    if (activeRowsRef.current.length > 0) {
      previousDisplayRef.current = {
        activeRows: activeRowsRef.current,
        gridData: gridDataRef.current,
      };
    } else {
      previousDisplayRef.current = null;
    }
    setIsDirty(false);
    setSaveStatus("idle");
    setActiveRows([]);
    setGridData({});
    initializedForParams.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentParamsKey]);

  useEffect(() => {
    if (timeEntries && projects && initializedForParams.current !== currentParamsKey) {
      initializedForParams.current = currentParamsKey;

      const newGrid: Record<string, Record<string, string>> = {};
      const rowsMap = new Map<string, RowDef>();

      (timeEntries as Array<{ projectId: number; projectRoleId?: number | null; entryDate: string; hours: number }>)
        .forEach((entry) => {
          const roleId = entry.projectRoleId ?? null;
          const rk = makeRowKey(entry.projectId, roleId);
          if (!newGrid[rk]) newGrid[rk] = {};
          newGrid[rk][entry.entryDate] = entry.hours.toString();
          if (!rowsMap.has(rk)) rowsMap.set(rk, { rowKey: rk, projectId: entry.projectId, projectRoleId: roleId });
        });

      setGridData(newGrid);
      setActiveRows(Array.from(rowsMap.values()));
      setIsDirty(false);
      setSaveStatus("idle");
    }
  }, [timeEntries, projects, currentParamsKey]);

  const handleSave = useCallback(() => {
    if (!isDirty || saveStatus === "saving") return;

    const existingKeys = new Set(
      ((timeEntries ?? []) as Array<{ projectId: number; projectRoleId?: number | null; entryDate: string }>)
        .map((e) => `${e.projectId}::${e.projectRoleId ?? "null"}::${e.entryDate}`)
    );

    const entriesToSave: {
      employeeId: number;
      projectId: number;
      projectRoleId?: number | null;
      entryDate: string;
      hours: number;
    }[] = [];

    for (const row of activeRowsRef.current) {
      const rowDates = gridDataRef.current[row.rowKey];

      const rowTotal = weekDays.reduce((sum, day) => {
        const dateStr = format(day, "yyyy-MM-dd");
        if (disabledDateReasons.has(dateStr)) return sum;
        const v = parseFloat(rowDates?.[dateStr] ?? "0");
        return sum + (isNaN(v) ? 0 : v);
      }, 0);

      const hasExistingEntries = weekDays.some((day) => {
        const dateStr = format(day, "yyyy-MM-dd");
        return existingKeys.has(`${row.projectId}::${row.projectRoleId ?? "null"}::${dateStr}`);
      });

      if (rowTotal === 0 && !hasExistingEntries) continue;

      for (const date in rowDates) {
        if (disabledDateReasons.has(date)) continue;
        const rawHours = parseFloat(rowDates[date]);
        const hours = isNaN(rawHours) ? 0 : rawHours;
        const key = `${row.projectId}::${row.projectRoleId ?? "null"}::${date}`;
        if (hours > 0 || existingKeys.has(key)) {
          entriesToSave.push({
            employeeId,
            projectId: row.projectId,
            projectRoleId: row.projectRoleId,
            entryDate: date,
            hours,
          });
        }
      }
    }

    setSaveStatus("saving");

    bulkUpsert.mutate(
      { data: { entries: entriesToSave as Parameters<typeof bulkUpsert.mutate>[0]["data"]["entries"] } },
      {
        onSuccess: () => {
          setSaveStatus("saved");
          setIsDirty(false);
          dirtyGuard.reportDirty(false);
          initializedForParams.current = null;
          queryClient.invalidateQueries({
            queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }),
          });
          setTimeout(() => setSaveStatus("idle"), 2500);
          const pendingNav = dirtyGuard.consumePendingNavAfterSave();
          if (pendingNav) pendingNav();
        },
        onError: () => setSaveStatus("idle"),
      }
    );
  }, [isDirty, saveStatus, timeEntries, employeeId, bulkUpsert, queryClient, startDateStr, endDateStr, disabledDateReasons, dirtyGuard, weekDays]);

  // Ctrl+S shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSave]);

  useEffect(() => { dirtyGuard.reportDirty(isDirty); }, [isDirty, dirtyGuard]);
  useEffect(() => { dirtyGuard.registerSave(handleSave); }, [handleSave, dirtyGuard]);
  useEffect(() => {
    dirtyGuard.registerClearDirty(() => { setIsDirty(false); setSaveStatus("idle"); });
    return () => dirtyGuard.unregister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const handleCopyLastWeek = useCallback(async () => {
    if (copyStatus === "loading") return;
    setCopyStatus("loading");

    const prevWeekStart = subWeeks(weekStartDate, 1);
    const prevStartDate = format(prevWeekStart, "yyyy-MM-dd");
    const prevEndDate = format(addDays(prevWeekStart, 6), "yyyy-MM-dd");

    try {
      const rawEntries = await queryClient.fetchQuery({
        queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: prevStartDate, endDate: prevEndDate }),
        queryFn: () => listTimeEntries({ employeeId, startDate: prevStartDate, endDate: prevEndDate }),
        staleTime: 60_000,
      });

      const entries = rawEntries as Array<{ projectId: number; projectRoleId?: number | null }>;
      const prevRows: RowDef[] = [];
      const seen = new Set<string>();
      for (const e of entries) {
        const roleId = e.projectRoleId ?? null;
        const rk = makeRowKey(e.projectId, roleId);
        if (!seen.has(rk)) { seen.add(rk); prevRows.push({ rowKey: rk, projectId: e.projectId, projectRoleId: roleId }); }
      }

      if (prevRows.length === 0) {
        setCopyStatus("empty");
        setTimeout(() => setCopyStatus("idle"), 3000);
        return;
      }

      setActiveRows((prev) => {
        const existing = new Set(prev.map((r) => r.rowKey));
        const toAdd = prevRows.filter((r) => !existing.has(r.rowKey));
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
      const alreadyActive = new Set(activeRows.map((r) => r.rowKey));
      const newRows = prevRows.filter((r) => !alreadyActive.has(r.rowKey));
      if (newRows.length > 0) setIsDirty(true);
      setCopyStatus("done");
      setTimeout(() => setCopyStatus("idle"), 2500);
    } catch {
      setCopyStatus("idle");
    }
  }, [copyStatus, weekStartDate, employeeId, queryClient, activeRows]);

  const handleCellChange = (rowKey: string, date: string, value: string) => {
    if (disabledDateReasons.has(date)) return;
    if (value !== "" && !/^\d*\.?\d*$/.test(value)) return;
    setGridData((prev) => ({
      ...prev,
      [rowKey]: { ...(prev[rowKey] ?? {}), [date]: value },
    }));
    setIsDirty(true);
    if (saveStatus === "saved") setSaveStatus("idle");
  };

  const handleAddRow = (row: RowDef) => {
    setActiveRows((prev) => [...prev, row]);
    setIsDirty(true);
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const move = (r: number, c: number) => {
      const el = document.querySelector(`input[data-row="${r}"][data-col="${c}"]`) as HTMLInputElement | null;
      if (el) { e.preventDefault(); el.focus(); }
    };
    if (e.key === "Enter" || e.key === "ArrowDown") move(rowIndex + 1, colIndex);
    else if (e.key === "ArrowUp") move(rowIndex - 1, colIndex);
    else if (e.key === "ArrowRight") move(rowIndex, colIndex + 1);
    else if (e.key === "ArrowLeft") move(rowIndex, colIndex - 1);
  };

  const isWeekLoading = entriesLoading && !initializedForParams.current;
  const displayRows = isWeekLoading && previousDisplayRef.current
    ? previousDisplayRef.current.activeRows
    : activeRows;
  const displayGridData = isWeekLoading && previousDisplayRef.current
    ? previousDisplayRef.current.gridData
    : gridData;

  const colTotals = weekDays.map((day) => {
    const dateStr = format(day, "yyyy-MM-dd");
    if (disabledDateReasons.has(dateStr)) return 0;
    return displayRows.reduce((sum, row) => {
      const v = parseFloat(displayGridData[row.rowKey]?.[dateStr] || "0");
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
  });

  const rowTotals = displayRows.map((row) =>
    weekDays.reduce((sum, day) => {
      const dateStr = format(day, "yyyy-MM-dd");
      if (disabledDateReasons.has(dateStr)) return sum;
      const v = parseFloat(displayGridData[row.rowKey]?.[dateStr] || "0");
      return sum + (isNaN(v) ? 0 : v);
    }, 0)
  );

  const grandTotal = colTotals.reduce((a, b) => a + b, 0);
  const isOverCapacity = grandTotal > capacityHours;

  if (isWeekLoading && !previousDisplayRef.current) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm flex-wrap gap-3">
          <div className="flex items-center gap-4">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-28 rounded-md" />
            <Skeleton className="h-8 w-28 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        </div>
        <div className="border rounded-md bg-card overflow-hidden">
          <div className="bg-muted/50 p-3 grid grid-cols-9 gap-2">
            <Skeleton className="h-4 col-span-2" />
            {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-4" />)}
          </div>
          {Array.from({ length: 3 }).map((_, ri) => (
            <div key={ri} className="p-3 grid grid-cols-9 gap-2 border-t border-border/50">
              <div className="col-span-2 space-y-1">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2 w-1/2" />
              </div>
              {Array.from({ length: 7 }).map((_, ci) => <Skeleton key={ci} className="h-8 rounded-sm" />)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const projectsForDialog = (projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    clientName: p.clientName ?? undefined,
  }));

  return (
    <div className={`space-y-4 transition-opacity duration-150 ${isWeekLoading && previousDisplayRef.current ? "opacity-50 pointer-events-none select-none" : ""}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <Button variant="outline" onClick={() => onPreviousWeek && dirtyGuard.guardNavigate(onPreviousWeek)} size="sm">
            &larr; Prev Week
          </Button>
          <div className="font-medium text-sm">
            {format(weekDays[0], "MMM d")} – {format(weekDays[6], "MMM d, yyyy")}
          </div>
          <Button variant="outline" onClick={() => onNextWeek && dirtyGuard.guardNavigate(onNextWeek)} size="sm">
            Next Week &rarr;
          </Button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLastWeek}
            disabled={copyStatus === "loading"}
            title="Add last week's projects to this grid"
          >
            {copyStatus === "loading" ? (
              <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Copying…</>
            ) : copyStatus === "done" ? (
              <><CheckCircle2 className="h-4 w-4 mr-1.5 text-green-500" /> Copied</>
            ) : copyStatus === "empty" ? (
              <><Copy className="h-4 w-4 mr-1.5" /> No last-week entries</>
            ) : (
              <><Copy className="h-4 w-4 mr-1.5" /> Copy last week</>
            )}
          </Button>

          <Button variant="outline" size="sm" onClick={() => setRecurringOpen(true)} title="Book the same hours across a date range">
            <CalendarRange className="h-4 w-4 mr-1.5" /> Repeat booking
          </Button>

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

      {isDirty && (
        <p className="text-xs text-muted-foreground px-1">
          You have unsaved changes — click <strong>Save</strong> or press <kbd className="px-1 py-0.5 rounded border text-xs">Ctrl+S</kbd>
        </p>
      )}

      {/* Grid */}
      <div className="border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-[250px]">Project / Role</TableHead>
              {weekDays.map((day) => {
                const dateStr = format(day, "yyyy-MM-dd");
                const isDisabled = disabledDateReasons.has(dateStr);
                return (
                  <TableHead key={day.toISOString()} className={`text-center w-[100px]${isDisabled ? " opacity-50" : ""}`}>
                    <div className="flex flex-col items-center">
                      <span className="font-medium text-foreground">{format(day, "EEE")}</span>
                      <span className="text-xs text-muted-foreground">{format(day, "MMM d")}</span>
                    </div>
                  </TableHead>
                );
              })}
              <TableHead className="text-right w-[100px]">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.map((row, rowIndex) => {
              const project = projects?.find((p) => p.id === row.projectId);
              const roles = rolesByProject[row.projectId];
              const role = row.projectRoleId != null
                ? roles?.find((r) => r.id === row.projectRoleId)
                : null;

              return (
                <TableRow key={row.rowKey}>
                  <TableCell className="font-medium">
                    <div className="flex items-start gap-2">
                      <span
                        className="mt-0.5 shrink-0 w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: (project as { color?: string | null })?.color ?? "#6366f1" }}
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="truncate">{project?.name || `Project ${row.projectId}`}</span>
                        {role ? (
                          <span className="text-xs text-primary font-medium truncate">└── {role.name}</span>
                        ) : row.projectRoleId == null && roles && roles.length > 0 ? (
                          <span className="text-xs text-muted-foreground truncate">└── No role</span>
                        ) : (
                          <span className="text-xs text-muted-foreground truncate">{project?.clientName}</span>
                        )}
                      </div>
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

                    return (
                      <TableCell key={dateStr} className="p-1">
                        <Input
                          type="text"
                          inputMode="decimal"
                          className="h-9 w-full text-center border-transparent hover:border-input focus:border-ring rounded-sm bg-transparent"
                          value={displayGridData[row.rowKey]?.[dateStr] ?? ""}
                          onChange={(e) => handleCellChange(row.rowKey, dateStr, e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex)}
                          data-row={rowIndex}
                          data-col={colIndex}
                          placeholder="-"
                        />
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-medium bg-muted/20">
                    {rowTotals[rowIndex].toFixed(1)}
                  </TableCell>
                </TableRow>
              );
            })}

            {/* Add-project row / column totals */}
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="p-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-full border-dashed bg-transparent text-muted-foreground hover:text-foreground"
                  onClick={() => setAddRowOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add project
                </Button>
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
              <TableCell className="text-right font-bold text-primary">
                {grandTotal > 0 ? grandTotal.toFixed(1) : "0.0"}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Add project/role dialog */}
      <AddRowDialog
        open={addRowOpen}
        onClose={() => setAddRowOpen(false)}
        projects={projectsForDialog}
        existingRows={activeRows}
        employeeId={employeeId}
        onAdd={handleAddRow}
      />

      {/* Recurring booking dialog */}
      <RecurringBookingDialog
        open={recurringOpen}
        onOpenChange={setRecurringOpen}
        employeeId={employeeId}
        projects={projectsForDialog}
        workingDaysMask={workingDaysMask}
        contractStartDate={contractStartDate}
        contractEndDate={contractEndDate}
        calendarId={calendarId}
        vacations={vacations ?? []}
        onSuccess={() => {
          initializedForParams.current = null;
          queryClient.invalidateQueries({
            queryKey: getListTimeEntriesQueryKey({ employeeId, startDate: startDateStr, endDate: endDateStr }),
          });
        }}
      />
    </div>
  );
}
