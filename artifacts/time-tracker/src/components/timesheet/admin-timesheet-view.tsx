import { useState, useMemo, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTimeEntries,
  getListTimeEntriesQueryKey,
  useListEmployees,
  getListEmployeesQueryKey,
  useListProjects,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import type { ListTimeEntriesParams } from "@workspace/api-client-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
  subMonths,
  addMonths,
  parseISO,
} from "date-fns";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Pencil, Trash2, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

type DatePreset = "this_month" | "last_month" | "this_year" | "all_time" | "custom";
type BulkActionType = "change_project" | "change_role";

interface ProjectRole {
  id: number;
  name: string;
  dayRate: number;
}

interface EditState {
  id: number;
  projectId: string;
  projectRoleId: string;
  hours: string;
  entryDate: string;
  note: string;
}

interface DeleteState {
  id: number;
  label: string;
}

function isFullCalendarMonth(from: string, to: string) {
  try {
    const fromDate = parseISO(from);
    return (
      from === format(startOfMonth(fromDate), "yyyy-MM-dd") &&
      to === format(endOfMonth(fromDate), "yyyy-MM-dd")
    );
  } catch {
    return false;
  }
}

export function AdminTimesheetView() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const today = new Date();

  // ── Date range ──────────────────────────────────────────────────────────────
  const [datePreset, setDatePreset] = useState<DatePreset>("this_month");
  const [customFrom, setCustomFrom] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [customTo, setCustomTo] = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  // ── Filters ──────────────────────────────────────────────────────────────────
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [noRoleOnly, setNoRoleOnly] = useState(false);
  const [page, setPage] = useState(0);

  // ── Selection ────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ── Single-row edit / delete ──────────────────────────────────────────────
  const [editState, setEditState] = useState<EditState | null>(null);
  const [editRoleLoading, setEditRoleLoading] = useState(false);
  const [editRoles, setEditRoles] = useState<ProjectRole[]>([]);
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState<number | null>(null);

  // ── Bulk edit state ──────────────────────────────────────────────────────────
  const [bulkAction, setBulkAction] = useState<BulkActionType | null>(null);
  const [bulkProjectId, setBulkProjectId] = useState<string>("");
  const [bulkRoleId, setBulkRoleId] = useState<string>("__none__");
  const [bulkRoleLoading, setBulkRoleLoading] = useState(false);
  const [bulkRoles, setBulkRoles] = useState<ProjectRole[]>([]);
  const [bulkConfirming, setBulkConfirming] = useState(false);

  // ── Header checkbox ref for indeterminate state ──────────────────────────────
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  // ── Effective date range ─────────────────────────────────────────────────────
  const effectiveDates = useMemo((): { startDate?: string; endDate?: string } => {
    const now = new Date();
    switch (datePreset) {
      case "this_month":
        return {
          startDate: format(startOfMonth(now), "yyyy-MM-dd"),
          endDate: format(endOfMonth(now), "yyyy-MM-dd"),
        };
      case "last_month": {
        const lm = subMonths(now, 1);
        return {
          startDate: format(startOfMonth(lm), "yyyy-MM-dd"),
          endDate: format(endOfMonth(lm), "yyyy-MM-dd"),
        };
      }
      case "this_year":
        return {
          startDate: format(startOfYear(now), "yyyy-MM-dd"),
          endDate: format(endOfYear(now), "yyyy-MM-dd"),
        };
      case "all_time":
        return {};
      case "custom":
        return { startDate: customFrom, endDate: customTo };
    }
  }, [datePreset, customFrom, customTo]);

  // Whether prev/next month navigation should be shown (month presets only)
  const showMonthNav = datePreset === "this_month" || datePreset === "last_month";

  // The reference month used for prev/next navigation
  const navMonthDate = useMemo(() => {
    if (datePreset === "this_month") return new Date();
    if (datePreset === "last_month") return subMonths(new Date(), 1);
    if (datePreset === "custom" && customFrom) {
      try { return parseISO(customFrom); } catch { return new Date(); }
    }
    return new Date();
  }, [datePreset, customFrom]);

  function navigateMonth(dir: 1 | -1) {
    const newMonth = dir === -1 ? subMonths(navMonthDate, 1) : addMonths(navMonthDate, 1);
    setDatePreset("custom");
    setCustomFrom(format(startOfMonth(newMonth), "yyyy-MM-dd"));
    setCustomTo(format(endOfMonth(newMonth), "yyyy-MM-dd"));
    resetPage();
  }

  function handlePresetChange(value: string) {
    setDatePreset(value as DatePreset);
    resetPage();
  }

  function resetPage() {
    setPage(0);
    setSelectedIds(new Set());
  }

  // ── API queries ──────────────────────────────────────────────────────────────
  const empParams = { includeInactive: false };
  const { data: employees = [] } = useListEmployees(empParams, {
    query: { queryKey: getListEmployeesQueryKey(empParams) },
  });

  const projParams = { includeInactive: false };
  const { data: projects = [] } = useListProjects(projParams, {
    query: { queryKey: getListProjectsQueryKey(projParams) },
  });

  const teParams: ListTimeEntriesParams = {
    ...effectiveDates,
    ...(employeeFilter !== "all" ? { employeeId: Number(employeeFilter) } : {}),
    ...(projectFilter !== "all" ? { projectId: Number(projectFilter) } : {}),
  };
  const { data: entries = [], isLoading } = useListTimeEntries(teParams, {
    query: { queryKey: getListTimeEntriesQueryKey(teParams) },
  });

  // ── Derived data ─────────────────────────────────────────────────────────────
  const clients = useMemo(() => {
    const seen = new Map<number, string>();
    projects.forEach((p) => {
      if (!seen.has(p.clientId)) seen.set(p.clientId, p.clientName ?? `Client ${p.clientId}`);
    });
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projects]);

  const filteredProjects = useMemo(() => {
    if (clientFilter === "all") return projects;
    return projects.filter((p) => String(p.clientId) === clientFilter);
  }, [projects, clientFilter]);

  const filtered = useMemo(() => {
    let list = [...entries].sort((a, b) => {
      const da = typeof a.entryDate === "string" ? a.entryDate : String(a.entryDate).slice(0, 10);
      const db2 = typeof b.entryDate === "string" ? b.entryDate : String(b.entryDate).slice(0, 10);
      return db2.localeCompare(da);
    });
    if (noRoleOnly) list = list.filter((e) => !e.roleName);
    return list;
  }, [entries, noRoleOnly]);

  const totalHours = useMemo(() => filtered.reduce((s, e) => s + e.hours, 0), [filtered]);
  const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const allPageSelected = pageItems.length > 0 && pageItems.every((e) => selectedIds.has(e.id));
  const somePageSelected = !allPageSelected && pageItems.some((e) => selectedIds.has(e.id));

  // Sync indeterminate state on the header checkbox
  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = somePageSelected;
    }
  }, [somePageSelected]);

  // ── Selection helpers ────────────────────────────────────────────────────────
  function toggleRow(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllPage() {
    if (allPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageItems.forEach((e) => next.delete(e.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageItems.forEach((e) => next.add(e.id));
        return next;
      });
    }
  }

  // ── Single-row edit/delete mutations ────────────────────────────────────────
  async function patchEntry(id: number, body: Record<string, unknown>) {
    const res = await fetch(`/api/time-entries/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error ?? "Update failed");
    }
    return res.json();
  }

  async function deleteEntry(id: number) {
    const res = await fetch(`/api/time-entries/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) throw new Error("Delete failed");
  }

  async function openEdit(entry: (typeof entries)[0]) {
    const date =
      typeof entry.entryDate === "string"
        ? entry.entryDate
        : String(entry.entryDate).slice(0, 10);
    setEditState({
      id: entry.id,
      projectId: String(entry.projectId),
      projectRoleId: entry.projectRoleId != null ? String(entry.projectRoleId) : "__none__",
      hours: String(entry.hours),
      entryDate: date,
      note: entry.note ?? "",
    });
    setEditRoles([]);
    setEditRoleLoading(true);
    try {
      const res = await fetch(`/api/projects/${entry.projectId}/roles`, { credentials: "include" });
      if (res.ok) setEditRoles(await res.json());
    } finally {
      setEditRoleLoading(false);
    }
  }

  async function onEditProjectChange(projectId: string) {
    if (!editState) return;
    setEditState({ ...editState, projectId, projectRoleId: "__none__" });
    setEditRoles([]);
    setEditRoleLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/roles`, { credentials: "include" });
      if (res.ok) setEditRoles(await res.json());
    } finally {
      setEditRoleLoading(false);
    }
  }

  async function handleSave() {
    if (!editState || isSaving) return;
    const hours = parseFloat(editState.hours);
    if (isNaN(hours) || hours <= 0 || hours > 24) {
      toast({ title: "Hours must be between 0 and 24", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      await patchEntry(editState.id, {
        projectId: Number(editState.projectId),
        projectRoleId:
          editState.projectRoleId && editState.projectRoleId !== "__none__"
            ? Number(editState.projectRoleId)
            : null,
        hours,
        entryDate: editState.entryDate,
        note: editState.note || null,
      });
      qc.invalidateQueries({ queryKey: getListTimeEntriesQueryKey(teParams) });
      setEditState(null);
      toast({ title: "Entry updated" });
    } catch (err) {
      toast({
        title: "Update failed",
        description: (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (isDeleting === id) return;
    setIsDeleting(id);
    try {
      await deleteEntry(id);
      qc.invalidateQueries({ queryKey: getListTimeEntriesQueryKey(teParams) });
      setDeleteState(null);
      setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      toast({ title: "Entry deleted" });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    } finally {
      setIsDeleting(null);
    }
  }

  // ── Bulk edit ────────────────────────────────────────────────────────────────
  async function onBulkProjectChange(projectId: string) {
    setBulkProjectId(projectId);
    setBulkRoleId("__none__");
    setBulkRoles([]);
    if (bulkAction === "change_role" && projectId) {
      setBulkRoleLoading(true);
      try {
        const res = await fetch(`/api/projects/${projectId}/roles`, { credentials: "include" });
        if (res.ok) setBulkRoles(await res.json());
      } finally {
        setBulkRoleLoading(false);
      }
    }
  }

  function resetBulk() {
    setBulkAction(null);
    setBulkProjectId("");
    setBulkRoleId("__none__");
    setBulkRoles([]);
    setBulkConfirming(false);
  }

  async function handleBulkApply() {
    if (!bulkConfirming) {
      setBulkConfirming(true);
      return;
    }
    const ids = Array.from(selectedIds);
    const failedIds: number[] = [];

    // Sequential to avoid hammering the server and to get reliable ordered errors
    for (const id of ids) {
      try {
        const body: Record<string, unknown> = {};
        if (bulkAction === "change_project") {
          body.projectId = Number(bulkProjectId);
          body.projectRoleId = null;
        } else {
          if (bulkProjectId) body.projectId = Number(bulkProjectId);
          body.projectRoleId =
            bulkRoleId && bulkRoleId !== "__none__" ? Number(bulkRoleId) : null;
        }
        const res = await fetch(`/api/time-entries/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) failedIds.push(id);
      } catch {
        failedIds.push(id);
      }
    }

    qc.invalidateQueries({ queryKey: getListTimeEntriesQueryKey(teParams) });
    resetBulk();

    if (failedIds.length === 0) {
      setSelectedIds(new Set());
      toast({ title: `Updated ${ids.length} ${ids.length === 1 ? "entry" : "entries"}` });
    } else {
      // Keep failed entries selected so the user can retry or inspect them
      setSelectedIds(new Set(failedIds));
      const failedEntries = filtered
        .filter((e) => failedIds.includes(e.id))
        .map((e) => `${formatDate(e.entryDate)} – ${e.employeeName ?? "?"}`)
        .join(", ");
      toast({
        title: `${failedIds.length} of ${ids.length} updates failed`,
        description: failedEntries || undefined,
        variant: "destructive",
      });
    }
  }

  const bulkApplyDisabled =
    !bulkAction ||
    (bulkAction === "change_project" && !bulkProjectId) ||
    (bulkAction === "change_role" && !bulkProjectId);

  // ── Utilities ────────────────────────────────────────────────────────────────
  function formatDate(d: Date | string) {
    const s = typeof d === "string" ? d : d.toISOString().slice(0, 10);
    const [y, m, day] = s.split("-");
    return `${day}.${m}.${y}`;
  }

  const COLS = 6; // checkbox + date + employee + project/role + hours + actions

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-3 flex-wrap">

        {/* Date range */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Period</Label>
          <div className="flex items-center gap-1">
            {showMonthNav && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => navigateMonth(-1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            <Select value={datePreset} onValueChange={handlePresetChange}>
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="this_month">This month</SelectItem>
                <SelectItem value="last_month">Last month</SelectItem>
                <SelectItem value="this_year">This year</SelectItem>
                <SelectItem value="all_time">All time</SelectItem>
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
            {showMonthNav && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => navigateMonth(1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
          {datePreset === "custom" && (
            <div className="flex items-center gap-1.5 mt-1">
              <Input
                type="date"
                value={customFrom}
                className="h-8 w-[140px] text-sm"
                onChange={(e) => { setCustomFrom(e.target.value); resetPage(); }}
              />
              <span className="text-muted-foreground text-sm">—</span>
              <Input
                type="date"
                value={customTo}
                className="h-8 w-[140px] text-sm"
                onChange={(e) => { setCustomTo(e.target.value); resetPage(); }}
              />
            </div>
          )}
        </div>

        {/* Employee */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Employee</Label>
          <Select
            value={employeeFilter}
            onValueChange={(v) => { setEmployeeFilter(v); resetPage(); }}
          >
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue placeholder="All employees" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {employees.map((e) => (
                <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Client */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Client</Label>
          <Select
            value={clientFilter}
            onValueChange={(v) => {
              setClientFilter(v);
              setProjectFilter("all");
              resetPage();
            }}
          >
            <SelectTrigger className="h-8 w-[160px]">
              <SelectValue placeholder="All clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Project (filtered by client) */}
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Project</Label>
          <Select
            value={projectFilter}
            onValueChange={(v) => { setProjectFilter(v); resetPage(); }}
          >
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {filteredProjects.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* No role only */}
        <label className="flex items-center gap-2 cursor-pointer h-8 select-none text-sm text-muted-foreground hover:text-foreground transition-colors">
          <input
            type="checkbox"
            className="accent-violet-500 h-4 w-4"
            checked={noRoleOnly}
            onChange={(e) => { setNoRoleOnly(e.target.checked); resetPage(); }}
          />
          No role only
        </label>
      </div>

      {/* ── Bulk action bar ─────────────────────────────────────────────────── */}
      {selectedIds.size >= 2 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/5 px-4 py-2.5">
          <span className="text-sm font-medium text-foreground shrink-0">
            {selectedIds.size} {selectedIds.size === 1 ? "entry" : "entries"} selected
          </span>

          <div className="flex items-center gap-2 flex-wrap flex-1">
            {/* Action type selector */}
            <Select
              value={bulkAction ?? ""}
              onValueChange={(v) => {
                setBulkAction(v as BulkActionType);
                setBulkProjectId("");
                setBulkRoleId("__none__");
                setBulkRoles([]);
                setBulkConfirming(false);
              }}
            >
              <SelectTrigger className="h-8 w-[160px]">
                <SelectValue placeholder="Choose action…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="change_project">Change Project</SelectItem>
                <SelectItem value="change_role">Change Role</SelectItem>
              </SelectContent>
            </Select>

            {/* Project selector (shown for both actions) */}
            {bulkAction && (
              <Select value={bulkProjectId} onValueChange={onBulkProjectChange}>
                <SelectTrigger className="h-8 w-[180px]">
                  <SelectValue placeholder="Select project…" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Role selector (only for change_role, after project selected) */}
            {bulkAction === "change_role" && bulkProjectId && (
              <Select
                value={bulkRoleId}
                onValueChange={(v) => { setBulkRoleId(v); setBulkConfirming(false); }}
                disabled={bulkRoleLoading}
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue placeholder={bulkRoleLoading ? "Loading…" : "Select role…"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— No role —</SelectItem>
                  {bulkRoles.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {bulkConfirming ? (
              <>
                <span className="text-sm text-muted-foreground">
                  Update {selectedIds.size} {selectedIds.size === 1 ? "entry" : "entries"}?
                </span>
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs bg-violet-600 hover:bg-violet-700"
                  onClick={handleBulkApply}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-3 text-xs"
                  onClick={() => setBulkConfirming(false)}
                >
                  Back
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                className="h-7 px-3 text-xs bg-violet-600 hover:bg-violet-700"
                disabled={bulkApplyDisabled}
                onClick={handleBulkApply}
              >
                Apply
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-3 text-xs text-muted-foreground"
              onClick={() => {
                setSelectedIds(new Set());
                resetBulk();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2.5 w-8">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  className="accent-violet-500 h-4 w-4 cursor-pointer"
                  checked={allPageSelected}
                  onChange={toggleAllPage}
                  aria-label="Select all on page"
                />
              </th>
              <th className="text-left px-3 py-2.5 font-medium text-muted-foreground w-[110px]">Date</th>
              <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Employee</th>
              <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Project / Role</th>
              <th className="text-right px-3 py-2.5 font-medium text-muted-foreground w-[80px]">Hours</th>
              <th className="px-3 py-2.5 w-[80px]"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={COLS} className="text-center py-12 text-muted-foreground">Loading…</td>
              </tr>
            ) : pageItems.length === 0 ? (
              <tr>
                <td colSpan={COLS} className="text-center py-12 text-muted-foreground">No entries found</td>
              </tr>
            ) : (
              pageItems.map((entry) => {
                const noRole = !entry.roleName;
                const isDeletingThis = deleteState?.id === entry.id;
                const isSelected = selectedIds.has(entry.id);
                return (
                  <tr
                    key={entry.id}
                    className={cn(
                      "border-b border-border/50 last:border-0",
                      isSelected
                        ? "bg-violet-500/10"
                        : noRole
                          ? "bg-amber-500/5 hover:bg-amber-500/10"
                          : "hover:bg-muted/20",
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="accent-violet-500 h-4 w-4 cursor-pointer"
                        checked={isSelected}
                        onChange={() => toggleRow(entry.id)}
                        aria-label="Select entry"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground tabular-nums">
                      {formatDate(entry.entryDate)}
                    </td>
                    <td className="px-3 py-2">{entry.employeeName ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span>{entry.projectName ?? "—"}</span>
                      {noRole ? (
                        <Badge variant="outline" className="ml-2 text-[10px] border-amber-500/50 text-amber-500 gap-1 py-0">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          No role
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground"> / {entry.roleName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{entry.hours}h</td>
                    <td className="px-3 py-2">
                      {isDeletingThis ? (
                        <div className="flex items-center gap-1 justify-end">
                          <span className="text-xs text-muted-foreground mr-1">Delete?</span>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 px-2 text-xs"
                            onClick={() => handleDelete(entry.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => setDeleteState(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 justify-end">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(entry)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              setDeleteState({
                                id: entry.id,
                                label: `${entry.employeeName} – ${entry.projectName} (${formatDate(entry.entryDate)})`,
                              })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30">
                <td />
                <td colSpan={3} className="px-3 py-2 text-xs text-muted-foreground">
                  {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
                  {selectedIds.size > 0 && (
                    <span className="ml-2 text-violet-500">· {selectedIds.size} selected</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums">
                  {totalHours % 1 === 0 ? totalHours : totalHours.toFixed(1)}h
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ── Pagination ──────────────────────────────────────────────────────── */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {page + 1} of {pageCount}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => { setPage((p) => p - 1); setSelectedIds(new Set()); }}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pageCount - 1} onClick={() => { setPage((p) => p + 1); setSelectedIds(new Set()); }}>
              Next
            </Button>
          </div>
        </div>
      )}

      {/* ── Single-row edit dialog ──────────────────────────────────────────── */}
      <Dialog open={!!editState} onOpenChange={(open) => { if (!open) setEditState(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Time Entry</DialogTitle>
          </DialogHeader>
          {editState && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Project</Label>
                <Select value={editState.projectId} onValueChange={onEditProjectChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select
                  value={editState.projectRoleId}
                  onValueChange={(v) => setEditState({ ...editState, projectRoleId: v })}
                  disabled={editRoleLoading || editRoles.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={editRoleLoading ? "Loading roles…" : "No role"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— No role —</SelectItem>
                    {editRoles.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    value={editState.entryDate}
                    onChange={(e) => setEditState({ ...editState, entryDate: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Hours</Label>
                  <Input
                    type="number"
                    min={0.5}
                    max={24}
                    step={0.5}
                    value={editState.hours}
                    onChange={(e) => setEditState({ ...editState, hours: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Note <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input
                  value={editState.note}
                  onChange={(e) => setEditState({ ...editState, note: e.target.value })}
                  placeholder="Add a note…"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditState(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
