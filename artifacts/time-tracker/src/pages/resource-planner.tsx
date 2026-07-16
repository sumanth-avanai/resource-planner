import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  differenceInDays,
  format,
  getDaysInMonth,
  getISODay,
  getQuarter,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
} from "date-fns";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Plus,
  AlertTriangle,
  X,
  ArrowUpDown,
  Check,
  ChevronDown,
  Clock,
  Undo2,
  Info,
  Sun,
  Star,
  Thermometer,
  Ban,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useListEmployees,
  getListEmployeesQueryKey,
  useListProjects,
  getListProjectsQueryKey,
  useListHolidayCalendars,
  getListHolidayCalendarsQueryKey,
  useListHolidays,
  getListHolidaysQueryKey,
} from "@workspace/api-client-react";
import { resolveProjectColor, PROJECT_COLORS } from "@workspace/api-zod";
import { FilterPanel } from "@/components/shared";
import { PlannerRowCells, PLANNER_ROW_HEIGHT } from "./resource-planner-timeline";

// ── Types ──────────────────────────────────────────────────────────────────────
interface ProjectRole {
  id: number;
  name: string;
  dayRate: number;
  budgetedDays: number | null;
  assignedEmployees: { employeeId: number; employeeName: string | null }[];
}

interface ResourceBookingFull {
  id: number;
  employeeId: number;
  projectId: number;
  projectRoleId: number | null;
  projectRoleName: string | null;
  dayRate: number | null;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  weekdayHours: Record<string, number> | null;
  notes: string | null;
  status: string | null;
  pastReleasedAt: string | null;
  employeeName: string;
  weeklyCapacityHours: number;
  projectName: string;
  clientName: string | null;
  projectColor: string;
}
type ZoomLevel = "week" | "month" | "quarter" | "year";
type SortMode = "alpha-asc" | "alpha-desc" | "alloc-desc" | "alloc-asc";

/** Pixels per calendar day at each zoom level. */
const DAY_WIDTH: Record<ZoomLevel, number> = {
  week: 60,    // 7 days  × 60 = 420 px
  month: 14,   // ~30 days × 14 ≈ 420 px
  quarter: 5,  // ~91 days ×  5 ≈ 455 px
  year: 2.5,   // 365 days × 2.5 ≈ 912 px
};

/** Weekend columns are this fraction of the weekday column width. */
const WEEKEND_WIDTH_RATIO = 0.4;

/** Return the pixel width of a single calendar day at the given base width. */
function varDayWidth(d: Date, baseWidth: number): number {
  const dow = d.getDay();
  return (dow === 0 || dow === 6) ? Math.max(2, baseWidth * WEEKEND_WIDTH_RATIO) : baseWidth;
}

/** Compute the total pixel span of `count` days starting at `startDate`. */
function computePixelSpanOfDays(startDate: Date, count: number, baseWidth: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += varDayWidth(addDays(startDate, i), baseWidth);
  return total;
}

/** Snap a date to the start of the appropriate calendar unit. */
function snapToZoom(date: Date, z: ZoomLevel): Date {
  switch (z) {
    case "week":    return startOfWeek(date, { weekStartsOn: 1 });
    case "month":   return startOfMonth(date);
    case "quarter": return startOfQuarter(date);
    case "year":    return startOfYear(date);
  }
}
const EMPLOYEE_COL = 200;
const ROW_HEIGHT = 40;
const SIDE_BUFFER_DAYS = 30;

interface SegmentBase {
  bookingId: number;
  startOffset: number; // days from windowStart, 0-indexed inclusive
  endOffset: number;   // days from windowStart, inclusive
  roleName: string | null;
  color: string;
  projectName: string;
  clientName: string | null;
  dayRate: number | null;
  bookingStartDate: string;
  bookingEndDate: string;
  notes: string | null;
  status: string | null;
  pastReleasedAt: string | null;
  projectRoleId: number | null;
  projectId: number;
  dailyHours: number[]; // one entry per day in [startOffset, endOffset]
}
type Segment = SegmentBase & { lane: number };

/** Hours this booking contributes to a given calendar day (0 if outside range,
 *  off the employee's working-day mask in flat mode, or on a holiday/vacation). */
function getHoursForDayBooking(
  booking: ResourceBookingFull,
  day: Date,
  empMask: number[],
  holidayDateSet: Set<string>,
  vacationDateSet: Set<string>,
): number {
  const dayStr = format(day, "yyyy-MM-dd");
  if (dayStr < booking.startDate || dayStr > booking.endDate) return 0;
  if (holidayDateSet.has(dayStr) || vacationDateSet.has(dayStr)) return 0;
  if (booking.weekdayHours != null) {
    // weekdayHours keys are "1"=Mon … "5"=Fri, matching getDay() for Mon–Fri
    return booking.weekdayHours[String(day.getDay())] ?? 0;
  }
  // Flat mode: apply only on the employee's working-mask days
  const isoIdx = getISODay(day) - 1; // 0=Mon … 6=Sun
  if (!empMask[isoIdx]) return 0;
  return booking.hoursPerDay;
}

/** Daily capacity in hours for one working day. */
function getDailyCapacity(weeklyCapacityHours: number, mask: number[]): number {
  const activeDays = mask.reduce((s, v) => s + v, 0);
  return activeDays > 0 ? weeklyCapacityHours / activeDays : 0;
}

/** Build one unbroken segment per booking, clipped to the visible window. */
function buildBookingSegments(
  booking: ResourceBookingFull,
  windowStartDate: Date,
  numDays: number,
  color: string,
  empMask: number[],
  holidayDateSet: Set<string>,
  vacationDateSet: Set<string>,
): SegmentBase[] {
  const base: Omit<SegmentBase, "startOffset" | "endOffset" | "dailyHours"> = {
    bookingId: booking.id,
    roleName: booking.projectRoleName,
    color,
    projectName: booking.projectName,
    clientName: booking.clientName,
    dayRate: booking.dayRate,
    bookingStartDate: booking.startDate,
    bookingEndDate: booking.endDate,
    notes: booking.notes,
    status: booking.status ?? null,
    pastReleasedAt: booking.pastReleasedAt,
    projectRoleId: booking.projectRoleId,
    projectId: booking.projectId,
  };

  // Clip booking span to visible window — produce ONE unbroken segment so the
  // period ribbon is always continuous. 0h days (weekends, holidays, vacations)
  // are included in dailyHours as 0 so the hours lane can render them correctly.
  const bookStart = parseISO(booking.startDate);
  const bookEnd = parseISO(booking.endDate);
  const winEnd = addDays(windowStartDate, numDays - 1);

  if (bookEnd < windowStartDate || bookStart > winEnd) return [];

  const clipStart = bookStart < windowStartDate ? windowStartDate : bookStart;
  const clipEnd = bookEnd > winEnd ? winEnd : bookEnd;

  const startOffset = differenceInDays(clipStart, windowStartDate);
  const endOffset = differenceInDays(clipEnd, windowStartDate);

  const dailyHours: number[] = [];
  for (let i = startOffset; i <= endOffset; i++) {
    const day = addDays(windowStartDate, i);
    dailyHours.push(
      getHoursForDayBooking(booking, day, empMask, holidayDateSet, vacationDateSet),
    );
  }

  return [{ ...base, startOffset, endOffset, dailyHours }];
}

/** Assign lanes to segments using greedy interval scheduling. */
function assignSegmentLanes(segments: SegmentBase[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.startOffset - b.startOffset);
  const laneEnds: number[] = [];
  return sorted.map((seg) => {
    let lane = laneEnds.findIndex((end) => seg.startOffset > end);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = seg.endOffset;
    return { ...seg, lane };
  });
}

// ── API hooks ──────────────────────────────────────────────────────────────────
function useResourceBookings() {
  return useQuery<ResourceBookingFull[]>({
    queryKey: ["resource-bookings"],
    queryFn: async () => {
      const res = await fetch("/api/resource-bookings", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load resource bookings");
      return res.json();
    },
  });
}

function useCreateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: object) => {
      const res = await fetch("/api/resource-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create booking");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}

function useUpdateBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: object }) => {
      const res = await fetch(`/api/resource-bookings/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update booking");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}

function useDeleteBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/resource-bookings/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete booking");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}

function useReleasePastBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/resource-bookings/${id}/release-past`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to release past plan");
      return res.json() as Promise<ResourceBookingFull>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}

function useUnreleaseBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/resource-bookings/${id}/unrelease`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to undo release");
      return res.json() as Promise<ResourceBookingFull>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["resource-bookings"] });
      qc.invalidateQueries({ queryKey: ["project-budget"] });
      qc.invalidateQueries({ queryKey: ["role-budget-status"] });
    },
  });
}


function useCreateVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: object) => {
      const res = await fetch("/api/vacations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create vacation");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vacations-all"] }),
  });
}

function useUpdateVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: number; data: object }) => {
      const res = await fetch(`/api/vacations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update vacation");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vacations-all"] }),
  });
}

function useDeleteVacation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/vacations/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete vacation");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vacations-all"] }),
  });
}

// ── Date utils ─────────────────────────────────────────────────────────────────
function getMondayOfWeek(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

function getBarBounds(
  startDateStr: string,
  endDateStr: string,
  windowStart: Date,
  numDays: number,
  dayLefts: number[],
): { left: number; width: number } | null {
  const start = parseISO(startDateStr);
  const end = addDays(parseISO(endDateStr), 1); // exclusive
  const windowEnd = addDays(windowStart, numDays);

  const visibleStart = start < windowStart ? windowStart : start;
  const visibleEnd = end > windowEnd ? windowEnd : end;
  if (visibleStart >= visibleEnd) return null;

  const startOff = differenceInDays(visibleStart, windowStart);
  const endOff = differenceInDays(visibleEnd, windowStart); // exclusive
  const l = dayLefts[startOff] ?? 0;
  const r = dayLefts[endOff] ?? dayLefts[dayLefts.length - 1] ?? 0;
  return {
    left: l,
    width: Math.max(r - l, 6),
  };
}

function getMonthGroups(days: Date[]): { label: string; dayCount: number }[] {
  const groups: { label: string; dayCount: number }[] = [];
  for (const day of days) {
    const label = format(day, "MMM yyyy");
    if (!groups.length || groups[groups.length - 1].label !== label) {
      groups.push({ label, dayCount: 1 });
    } else {
      groups[groups.length - 1].dayCount++;
    }
  }
  return groups;
}

// Count working days (per employee mask) between two ISO date strings, inclusive
function countMaskDaysBetween(
  start: string,
  end: string,
  mask: number[],
): number {
  if (!start || !end || end < start) return 0;
  let count = 0;
  const s = parseISO(start);
  const e = parseISO(end);
  for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
    if (mask[getISODay(d) - 1]) count++;
  }
  return count;
}

// ── Working-day utilities ──────────────────────────────────────────────────────
type VacationRange = { startDate: string; endDate: string };

interface VacationEntry {
  id: number;
  employeeId: number;
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

function useAllVacations() {
  return useQuery<VacationEntry[]>({
    queryKey: ["vacations-all"],
    queryFn: async () => {
      const r = await fetch("/api/vacations", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to fetch vacations");
      return r.json();
    },
  });
}

function countBookableDays(
  start: Date,
  end: Date,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): {
  workingDays: number;
  holidayCount: number;
  vacationCount: number;
  bookableDays: number;
} {
  let workingDays = 0,
    holidayCount = 0,
    vacationCount = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const ds = format(d, "yyyy-MM-dd");
    if (!mask[getISODay(d) - 1]) continue;
    workingDays++;
    if (holidayDates.has(ds)) {
      holidayCount++;
      continue;
    }
    if (vacations.some((v) => v.startDate <= ds && ds <= v.endDate))
      vacationCount++;
  }
  return {
    workingDays,
    holidayCount,
    vacationCount,
    bookableDays: workingDays - holidayCount - vacationCount,
  };
}

// Find the next working day at or after `d` (respects mask + holidays + absences)
function findNextWorkingDay(
  d: Date,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): Date {
  let cur = new Date(d);
  for (let i = 0; i < 365; i++) {
    const ds = format(cur, "yyyy-MM-dd");
    const dow = getISODay(cur) - 1; // 0=Mon … 6=Sun
    if (
      mask[dow] &&
      !holidayDates.has(ds) &&
      !vacations.some((v) => v.startDate <= ds && ds <= v.endDate)
    ) {
      return cur;
    }
    cur = addDays(cur, 1);
  }
  return cur;
}

// Calculate the end date for N working days starting from (and including) start
function calcEndFromNWorkingDays(
  start: Date,
  nDays: number,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): Date {
  let counted = 0;
  let cur = new Date(start);
  for (let i = 0; i < 730; i++) {
    const ds = format(cur, "yyyy-MM-dd");
    const dow = getISODay(cur) - 1;
    if (
      mask[dow] &&
      !holidayDates.has(ds) &&
      !vacations.some((v) => v.startDate <= ds && ds <= v.endDate)
    ) {
      counted++;
      if (counted >= nDays) return cur;
    }
    cur = addDays(cur, 1);
  }
  return cur;
}

// Calculate end date for Budget mode: walk working days until target reached or cap hit
function calcBudgetEnd(
  start: Date,
  targetDays: number,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
  capDate: string | null,
): { endDate: Date; reachedDays: number; skippedHolidays: number } {
  let accumulated = 0;
  let skippedHolidays = 0;
  let cur = new Date(start);
  let lastWorkingDay: Date = new Date(start);
  const capD = capDate ? parseISO(capDate) : null;
  for (let i = 0; i < 730; i++) {
    // Clamp at cap: do not advance past it
    if (capD && cur > capD) break;
    const ds = format(cur, "yyyy-MM-dd");
    const dow = getISODay(cur) - 1;
    if (mask[dow]) {
      if (holidayDates.has(ds)) {
        skippedHolidays++;
        lastWorkingDay = new Date(cur);
      } else if (!vacations.some((v) => v.startDate <= ds && ds <= v.endDate)) {
        accumulated++;
        lastWorkingDay = new Date(cur);
        if (accumulated >= targetDays) break;
      }
    }
    cur = addDays(cur, 1);
  }
  // When cap is hit before target, return capD (not cur which overshoots by 1).
  // When target is reached, cur already points to the day that hit the target.
  const endDate = capD && accumulated < targetDays ? capD : cur;
  return { endDate, reachedDays: accumulated, skippedHolidays };
}

// ── Weekday-hours helpers ─────────────────────────────────────────────────────
const DAY_LABELS: Record<string, string> = {
  "1": "Mo",
  "2": "Di",
  "3": "Mi",
  "4": "Do",
  "5": "Fr",
};

const WEEKDAY_PRESETS = [
  { label: "Mo–Fr 8h", hours: { "1": 8, "2": 8, "3": 8, "4": 8, "5": 8 } },
  { label: "Mo–Do 8h", hours: { "1": 8, "2": 8, "3": 8, "4": 8, "5": 0 } },
  { label: "Mo–Fr 4h", hours: { "1": 4, "2": 4, "3": 4, "4": 4, "5": 4 } },
] as const;

function matchesPreset(
  wh: Record<string, number>,
  preset: Record<string, number>,
): boolean {
  return ["1", "2", "3", "4", "5"].every(
    (k) => (wh[k] ?? 0) === (preset[k as keyof typeof preset] ?? 0),
  );
}

function formatWeekdayHours(wh: Record<string, number>): string {
  const slots = ["1", "2", "3", "4", "5"].map((k) => ({
    label: DAY_LABELS[k],
    h: wh[k] ?? 0,
  }));
  const groups: { start: string; end: string; h: number }[] = [];
  let cur: { start: string; end: string; h: number } | null = null;
  for (const { label, h } of slots) {
    if (cur == null || cur.h !== h) {
      if (cur) groups.push(cur);
      cur = { start: label, end: label, h };
    } else {
      cur.end = label;
    }
  }
  if (cur) groups.push(cur);
  return groups
    .map(
      (g) =>
        `${g.start === g.end ? g.start : `${g.start}–${g.end}`} ${g.h % 1 === 0 ? g.h : g.h.toFixed(1)}h`,
    )
    .join(", ");
}

/** Client-side mirror of the backend calcBookingHours helper. */
function calcBookingHoursClient(
  startStr: string,
  endStr: string,
  hoursPerDay: number,
  weekdayHours: Record<string, number> | null,
  mask: number[],
  holidayDates: Set<string>,
  vacations: VacationRange[],
): { totalHours: number; budgetDays: number } {
  if (!startStr || !endStr || endStr < startStr)
    return { totalHours: 0, budgetDays: 0 };
  const start = parseISO(startStr);
  const end = parseISO(endStr);
  let total = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const ds = format(d, "yyyy-MM-dd");
    const isoIdx = getISODay(d) - 1; // 0=Mon…6=Sun
    if (!mask[isoIdx]) continue;
    if (holidayDates.has(ds)) continue;
    if (vacations.some((v) => v.startDate <= ds && ds <= v.endDate)) continue;
    if (weekdayHours != null) {
      total += weekdayHours[String(d.getDay())] ?? 0; // getDay(): 0=Sun,1=Mon…5=Fri
    } else {
      total += hoursPerDay;
    }
  }
  return { totalHours: total, budgetDays: Math.round((total / 8) * 100) / 100 };
}

// ── Booking Modal ──────────────────────────────────────────────────────────────
interface ModalState {
  mode: "create";
  /** Pre-filled employee (from row "+" button). Null = toolbar button (empty assignees). */
  employeeId?: number | null;
  employeeName?: string | null;
  capacity?: number;
  workingDaysMask?: number[];
  holidayCalendarCode?: string | null;
}
interface EditModalState {
  mode: "edit";
  booking: ResourceBookingFull;
  capacity: number;
  workingDaysMask: number[];
  holidayCalendarCode: string | null;
  openInConfirmRelease?: boolean;
}

type AnyModalState = ModalState | EditModalState;

interface BookingModalProps {
  state: AnyModalState;
  projects: Array<{
    id: number;
    name: string;
    clientName: string | null;
    active: boolean;
  }>;
  allBookings: ResourceBookingFull[];
  employees: Array<{ id: number; name: string; weeklyCapacityHours: number }>;
  onClose: () => void;
  onBookingUpdated?: (booking: ResourceBookingFull) => void;
  initialConfirmRelease?: boolean;
}

function BookingModal({
  state,
  projects,
  allBookings,
  employees,
  onClose,
  onBookingUpdated,
  initialConfirmRelease,
}: BookingModalProps) {
  const { toast } = useToast();
  const createMut = useCreateBooking();
  const updateMut = useUpdateBooking();
  const deleteMut = useDeleteBooking();
  const releaseMut = useReleasePastBooking();
  const unreleaseMut = useUnreleaseBooking();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(initialConfirmRelease ?? false);
  const [showBudgetInfo, setShowBudgetInfo] = useState(false);

  const isEdit = state.mode === "edit";
  const defaultProject = isEdit ? String(state.booking.projectId) : "";
  const defaultStart = isEdit ? state.booking.startDate : "";
  const defaultEnd = isEdit ? state.booking.endDate : "";

  const [projectId, setProjectId] = useState(defaultProject);
  const [roleId, setRoleId] = useState<string>(
    isEdit && state.booking.projectRoleId
      ? String(state.booking.projectRoleId)
      : "",
  );
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [hoursPerDay, setHoursPerDay] = useState<number>(
    isEdit ? state.booking.hoursPerDay : 8,
  );
  const [hoursPerDayInput, setHoursPerDayInput] = useState<string>(
    isEdit ? String(state.booking.hoursPerDay) : "8",
  );
  const [notes, setNotes] = useState(isEdit ? (state.booking.notes ?? "") : "");

  // Weekday mode state — new bookings default to weekday-only mode
  const [weekdayMode, setWeekdayMode] = useState(
    isEdit ? state.booking.weekdayHours != null : true,
  );
  const [weekdayHours, setWeekdayHours] = useState<Record<string, number>>(
    isEdit && state.booking.weekdayHours != null
      ? state.booking.weekdayHours
      : { "1": 8, "2": 8, "3": 8, "4": 8, "5": 8 },
  );

  // Status toggle (Tentative / Confirmed)
  const [bookingStatus, setBookingStatus] = useState<"tentative" | "confirmed">(
    isEdit ? ((state as EditModalState).booking.status === "tentative" ? "tentative" : "confirmed") : "confirmed",
  );

  // Notes expansion (collapsed by default when empty)
  const [notesExpanded, setNotesExpanded] = useState(
    isEdit ? !!(state as EditModalState).booking.notes : false,
  );

  // Assignees (create only) — initialized from prefilled employee if any
  type AssigneeEntry = { id: number; name: string; capacity: number; workingDaysMask: number[]; holidayCalendarCode: string | null };
  const prefilledEmpId = !isEdit ? (state as ModalState).employeeId ?? null : null;
  const prefilledEmpName = !isEdit ? (state as ModalState).employeeName ?? null : null;
  const prefilledCapacity = !isEdit ? (state as ModalState).capacity ?? 40 : 40;
  const prefilledMask = !isEdit ? (state as ModalState).workingDaysMask ?? [1,1,1,1,1,0,0] : [1,1,1,1,1,0,0];
  const prefilledCalCode = !isEdit ? (state as ModalState).holidayCalendarCode ?? null : null;
  const [assignees, setAssignees] = useState<AssigneeEntry[]>(
    !isEdit && prefilledEmpId != null
      ? [{ id: prefilledEmpId, name: prefilledEmpName ?? "Unknown", capacity: prefilledCapacity, workingDaysMask: prefilledMask, holidayCalendarCode: prefilledCalCode }]
      : [],
  );
  const [assigneesOpen, setAssigneesOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");

  // Project combobox state
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");

  // Schedule mode (create only)
  type ScheduleMode = "zeitraum" | "dauer" | "budget";
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("zeitraum");

  // Dauer mode
  const [durationValue, setDurationValue] = useState<number>(5);
  const [durationUnit, setDurationUnit] = useState<"tage" | "wo" | "mo">("tage");

  // Budget mode
  const [budgetTarget, setBudgetTarget] = useState<number>(10);
  const [budgetUnit, setBudgetUnit] = useState<"tage" | "stunden">("tage");
  const [budgetCapDate, setBudgetCapDate] = useState("");

  // Weekly pattern picker — used in Dauer Wo/Mo and Budget modes
  // Keys: "1"=Mon … "7"=Sun; only "1"–"5" are stored in weekdayHours
  const [patternDays, setPatternDays] = useState<Set<string>>(
    new Set(["1", "2", "3", "4", "5"]),
  );
  const [patternHoursPerDay, setPatternHoursPerDay] = useState<number>(8);

  // Edit modal — slot list expanded
  const [showSlotList, setShowSlotList] = useState(false);

  // Fetch roles for the selected project
  const { data: projectRoles, isLoading: rolesLoading } = useQuery<
    ProjectRole[]
  >({
    queryKey: ["project-roles", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/roles`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch roles");
      return res.json();
    },
    enabled: !!projectId,
  });

  // Clear role when project changes (unless editing and same project)
  const prevProjectId = useRef(projectId);
  if (prevProjectId.current !== projectId) {
    prevProjectId.current = projectId;
    setRoleId("");
  }

  // For create mode with multiple assignees, use first assignee as the "primary" for role/availability checks
  const employeeId: number | undefined = isEdit
    ? state.booking.employeeId
    : (assignees[0]?.id ?? undefined);

  // Partition roles into assigned (for this employee) vs. the rest
  const assignedRoles = useMemo(
    () =>
      (projectRoles ?? []).filter((r) =>
        r.assignedEmployees.some((a) => a.employeeId === employeeId),
      ),
    [projectRoles, employeeId],
  );
  const unassignedRoles = useMemo(
    () =>
      (projectRoles ?? []).filter(
        (r) => !r.assignedEmployees.some((a) => a.employeeId === employeeId),
      ),
    [projectRoles, employeeId],
  );

  // Auto-select when the employee has exactly one assigned role and none is chosen yet
  useEffect(() => {
    if (assignedRoles.length === 1 && !roleId) {
      setRoleId(String(assignedRoles[0].id));
    }
  }, [assignedRoles, roleId]);
  // For create mode, use first assignee's data; fall back to defaults if no assignee yet
  const primaryAssignee = !isEdit ? assignees[0] : null;
  const capacity: number = isEdit
    ? (state as EditModalState).capacity
    : (primaryAssignee?.capacity ?? 40);
  const workingDaysMask: number[] = isEdit
    ? (state as EditModalState).workingDaysMask
    : (primaryAssignee?.workingDaysMask ?? [1,1,1,1,1,0,0]);
  const holidayCalendarCode: string | null = isEdit
    ? (state as EditModalState).holidayCalendarCode
    : (primaryAssignee?.holidayCalendarCode ?? null);

  // ── Holiday calendar resolution ─────────────────────────────────────────────
  const { data: holidayCalendars } = useListHolidayCalendars({
    query: {
      queryKey: getListHolidayCalendarsQueryKey(),
      enabled: !!holidayCalendarCode,
    },
  });
  const calendarId = useMemo(() => {
    if (!holidayCalendarCode || !holidayCalendars) return null;
    return (
      (holidayCalendars as any[]).find((c) => c.code === holidayCalendarCode)
        ?.id ?? null
    );
  }, [holidayCalendarCode, holidayCalendars]);

  // ── Holidays (covers both years when booking spans year boundary) ────────────
  const startYear = startDate
    ? parseInt(startDate.slice(0, 4))
    : new Date().getFullYear();
  // In totalDays mode endDate may be empty; always also fetch startYear+1 to cover year boundaries
  const endYear = endDate ? parseInt(endDate.slice(0, 4)) : startYear + 1;

  const { data: holidaysStartYear } = useListHolidays(
    calendarId ?? 0,
    { year: startYear },
    {
      query: {
        queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: startYear }),
        enabled: !!calendarId,
      },
    },
  );
  const { data: holidaysEndYear } = useListHolidays(
    calendarId ?? 0,
    { year: endYear },
    {
      query: {
        queryKey: getListHolidaysQueryKey(calendarId ?? 0, { year: endYear }),
        enabled: !!calendarId && endYear !== startYear,
      },
    },
  );
  const holidays = useMemo(
    () => [
      ...((holidaysStartYear as any[]) ?? []),
      ...(endYear !== startYear ? ((holidaysEndYear as any[]) ?? []) : []),
    ],
    [holidaysStartYear, holidaysEndYear, endYear, startYear],
  );

  const holidayDates = useMemo(
    () => new Set(holidays.map((h: any) => String(h.date).slice(0, 10))),
    [holidays],
  );

  // ── Vacations ───────────────────────────────────────────────────────────────
  const { data: vacations = [] } = useQuery<VacationRange[]>({
    queryKey: ["vacations", employeeId],
    queryFn: async () => {
      const r = await fetch(`/api/vacations?employeeId=${employeeId}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to fetch vacations");
      return r.json();
    },
    enabled: !!employeeId,
  });

  // ── Zeitraum: per-date hours grid (New booking only) ──────────────────────
  // Shows a concrete calendar-date grid for the selected range. Holidays and
  // approved absences are auto-set to 0h (gray, non-editable with icon).
  // All other working days start at hoursPerDay and are freely editable.
  const [perDateHours, setPerDateHours] = useState<Record<string, number>>({});

  interface ZeitraumDateEntry {
    ds: string;
    label: string;
    effectiveHours: number;
    isBlocked: boolean;
    isHoliday: boolean;
    holidayName: string | undefined;
    isAbsence: boolean;
  }
  const zeitraumPerDateGrid = useMemo((): ZeitraumDateEntry[] => {
    if (isEdit || scheduleMode !== "zeitraum" || !startDate || !endDate || endDate < startDate) return [];
    const result: ZeitraumDateEntry[] = [];
    const s = parseISO(startDate);
    const e = parseISO(endDate);
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
      const ds = format(d, "yyyy-MM-dd");
      const dow = getISODay(d);
      if (!workingDaysMask[dow - 1]) continue;
      const isHoliday = holidayDates.has(ds);
      const hEntry = isHoliday ? (holidays as any[]).find((h) => String(h.date).slice(0, 10) === ds) : undefined;
      const isAbsence = !isHoliday && (vacations as VacationRange[]).some((v) => v.startDate <= ds && ds <= v.endDate);
      const isBlocked = isHoliday || isAbsence;
      result.push({
        ds,
        label: format(d, "EEE d MMM"),
        effectiveHours: isBlocked ? 0 : (perDateHours[ds] !== undefined ? perDateHours[ds] : hoursPerDay),
        isBlocked,
        isHoliday,
        holidayName: hEntry?.name,
        isAbsence,
      });
    }
    return result;
  }, [isEdit, scheduleMode, startDate, endDate, workingDaysMask, holidayDates, holidays, vacations, perDateHours, hoursPerDay]);

  // Derive a blocked-dates summary for the info note
  const zeitraumBlockedDates = useMemo(
    () => zeitraumPerDateGrid.filter((e) => e.isBlocked),
    [zeitraumPerDateGrid],
  );

  // ── Role budget status (for live budget validation) ─────────────────────────
  interface RoleBudgetBooking {
    employeeId: number;
    employeeName: string;
    days: number;
    loggedDays: number;
    invoicedDays: number;
  }
  interface RoleBudgetStatus {
    budgetedDays: number | null;
    plannedDays: number;
    loggedDays: number;
    invoicedDays: number;
    reservedDays: number;
    stalePlanDays: number;
    unplannedDays: number | null;
    freeDays: number | null;
    remainingBudgetDays: number | null;
    loggedNotInvoicedDays: number;
    employeeLoggedDays: number | null;
    employeeInvoicedDays: number | null;
    bookings: RoleBudgetBooking[];
  }
  // Role budget is fetched LIVE — the slot being edited is NOT excluded, so
  // these figures match the Budget / Allocations tabs exactly. The marginal
  // effect of unsaved edits is shown separately as a "projected" line below.
  const { data: roleBudgetStatus } = useQuery<RoleBudgetStatus>({
    queryKey: ["role-budget-status", roleId, employeeId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (employeeId != null) params.set("employeeId", String(employeeId));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const r = await fetch(`/api/project-roles/${roleId}/budget-status${qs}`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to fetch role budget");
      return r.json();
    },
    enabled: !!roleId,
  });

  // ── Booking summary ─────────────────────────────────────────────────────────
  const bookingSummary = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return null;
    const counts = countBookableDays(
      parseISO(startDate),
      parseISO(endDate),
      workingDaysMask,
      holidayDates,
      vacations,
    );
    return counts;
  }, [startDate, endDate, workingDaysMask, holidayDates, vacations]);

  // Precise hours/budget calculation (weekday-mode aware)
  const calcResult = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return null;
    return calcBookingHoursClient(
      startDate,
      endDate,
      hoursPerDay,
      weekdayMode ? weekdayHours : null,
      workingDaysMask,
      holidayDates,
      vacations,
    );
  }, [
    startDate,
    endDate,
    hoursPerDay,
    weekdayMode,
    weekdayHours,
    workingDaysMask,
    holidayDates,
    vacations,
  ]);

  // How many bookable days this booking consumes
  const thisBookingDays = bookingSummary ? bookingSummary.bookableDays : null;
  // Total hours
  const totalHours =
    calcResult && calcResult.totalHours > 0 ? calcResult.totalHours : null;

  // Past undelivered days (for release button): fetched server-side so that
  // logged hours are subtracted per booking, not role-wide. Also enabled for
  // ALREADY-RELEASED bookings — the endpoint applies the release-date cutoff,
  // so days missed AFTER a release surface here again and can be re-released
  // (a fresh release stamps a new cutoff date).
  const editBookingId = isEdit ? (state as EditModalState).booking.id : null;
  const editBookingReleased = isEdit ? !!(state as EditModalState).booking.pastReleasedAt : false;
  const { data: pastUndeliveredData } = useQuery<{ pastUndeliveredDays: number }>({
    queryKey: ["booking-past-undelivered", editBookingId],
    queryFn: async () => {
      const res = await fetch(`/api/resource-bookings/${editBookingId}/past-undelivered`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch past undelivered days");
      return res.json();
    },
    enabled: isEdit && !!editBookingId,
    staleTime: 30_000,
  });
  const pastPlanDays = pastUndeliveredData?.pastUndeliveredDays ?? 0;

  // Per-slot past-undelivered (stale) days — powers the "⚠ Xd stale" chips in
  // the slots list and the "Release all" action in the role-budget popover.
  const staleSlotIds = useMemo(
    () =>
      roleId
        ? allBookings
            .filter((b) => b.employeeId === employeeId && String(b.projectRoleId) === roleId)
            .map((b) => b.id)
        : [],
    [allBookings, employeeId, roleId],
  );
  const slotStaleQueries = useQueries({
    queries: staleSlotIds.map((id) => ({
      queryKey: ["booking-past-undelivered", id],
      queryFn: async () => {
        const res = await fetch(`/api/resource-bookings/${id}/past-undelivered`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to fetch past undelivered days");
        return res.json() as Promise<{ pastUndeliveredDays: number }>;
      },
      staleTime: 30_000,
    })),
  });
  const slotStaleMap = useMemo(() => {
    const m = new Map<number, number>();
    staleSlotIds.forEach((id, i) => m.set(id, slotStaleQueries[i]?.data?.pastUndeliveredDays ?? 0));
    return m;
  }, [staleSlotIds, slotStaleQueries]);

  // "Release all stale on this role": releases every booking on the role that
  // still carries undelivered past plan — executed per slot underneath, so the
  // audit trail and per-slot Undo stay intact. Two-step confirm in the UI.
  const releaseAllQc = useQueryClient();
  const [confirmReleaseAll, setConfirmReleaseAll] = useState(false);
  const [releasingAll, setReleasingAll] = useState(false);
  const releaseAllStaleOnRole = async () => {
    setReleasingAll(true);
    try {
      const roleBookings = allBookings.filter((b) => String(b.projectRoleId) === roleId);
      let releasedCount = 0;
      let releasedDays = 0;
      for (const b of roleBookings) {
        const res = await fetch(`/api/resource-bookings/${b.id}/past-undelivered`, {
          credentials: "include",
        });
        if (!res.ok) continue;
        const { pastUndeliveredDays } = (await res.json()) as { pastUndeliveredDays: number };
        if (pastUndeliveredDays > 0.05) {
          await releaseMut.mutateAsync(b.id);
          releasedCount++;
          releasedDays += pastUndeliveredDays;
        }
      }
      toast({
        title:
          releasedCount > 0
            ? `Released ${Math.round(releasedDays * 10) / 10}d stale plan across ${releasedCount} slot${releasedCount === 1 ? "" : "s"}`
            : "No stale plan to release",
      });
      releaseAllQc.invalidateQueries({ queryKey: ["booking-past-undelivered"] });
      releaseAllQc.invalidateQueries({ queryKey: ["role-budget-status"] });
    } catch {
      toast({ title: "Failed to release stale plan", variant: "destructive" });
    } finally {
      setReleasingAll(false);
      setConfirmReleaseAll(false);
    }
  };

  // Days this slot actually books against the role budget — RELEASE-AWARE and
  // computed inline (not via a memo) so it always tracks the latest edits and
  // matches the projected delta below. A released booking only books its
  // future (today-onward) portion, since its past undelivered plan is freed.
  const slotTodayStr = new Date().toISOString().slice(0, 10);
  // Tentative bookings do not count against budget in the live preview.
  const booksAgainstBudget = (() => {
    if (bookingStatus === "tentative") return 0;
    if (!startDate || !endDate || endDate < startDate) return null;
    const wh = weekdayMode ? weekdayHours : null;
    const calc = (from: string) =>
      calcBookingHoursClient(
        from, endDate, hoursPerDay, wh,
        workingDaysMask, holidayDates, vacations,
      ).budgetDays;
    if (!editBookingReleased) return calc(startDate);
    // Release-date cutoff: a released booking books its days from the release
    // date onwards (not from "today") — matching the backend reconciliation.
    const relCut = ((state as EditModalState).booking.pastReleasedAt ?? slotTodayStr).slice(0, 10);
    if (endDate < relCut) return 0;
    return calc(startDate >= relCut ? startDate : relCut);
  })();

  // Weekday-mode derived values
  // Only count days the employee actually works — hours entered on a
  // non-working weekday are ignored by the (mask-based) budget math.
  const weeklyTotal = weekdayMode
    ? (["1", "2", "3", "4", "5"] as const).reduce(
        (s, k) => s + (workingDaysMask[Number(k) - 1] ? (weekdayHours[k] ?? 0) : 0),
        0,
      )
    : null;
  const allWeekdayZero = weekdayMode && weeklyTotal === 0;

  // ── Derived end-date sync for pattern-picker schedule modes ──────────────
  // Compute end date from user inputs for each Dauer / Budget sub-mode and
  // sync to state via useEffect (not during render) to avoid React warnings.
  useEffect(() => {
    if (isEdit || scheduleMode !== "dauer" || durationUnit !== "tage" || !startDate) return;
    const rawStart = parseISO(startDate);
    const effectiveStart = findNextWorkingDay(rawStart, workingDaysMask, holidayDates, vacations as VacationRange[]);
    const effectiveStartStr = format(effectiveStart, "yyyy-MM-dd");
    const calcEnd = calcEndFromNWorkingDays(effectiveStart, durationValue, workingDaysMask, holidayDates, vacations as VacationRange[]);
    // Persist the shifted start date — if start falls on weekend/holiday the
    // effectiveStart is the next working day and the booking must be created
    // with that date, not the raw picker value.
    if (effectiveStartStr !== startDate) setStartDate(effectiveStartStr);
    setEndDate(format(calcEnd, "yyyy-MM-dd"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleMode, durationUnit, durationValue, startDate, workingDaysMask.join(","), holidayDates.size, JSON.stringify(vacations)]);

  useEffect(() => {
    if (isEdit || scheduleMode !== "dauer" || (durationUnit !== "wo" && durationUnit !== "mo") || !startDate) return;
    const calcEnd = durationUnit === "wo"
      ? addDays(addWeeks(parseISO(startDate), durationValue), -1)
      : addDays(addMonths(parseISO(startDate), durationValue), -1);
    setEndDate(format(calcEnd, "yyyy-MM-dd"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleMode, durationUnit, durationValue, startDate]);

  useEffect(() => {
    if (isEdit || scheduleMode !== "budget" || !startDate) return;
    const effectiveMask = workingDaysMask.map((v, i) =>
      v && patternDays.has(String(i + 1)) ? 1 : 0,
    );
    const targetDays = budgetUnit === "tage"
      ? budgetTarget
      : budgetTarget / (patternHoursPerDay > 0 ? patternHoursPerDay : 8);
    const { endDate: calcEnd } = calcBudgetEnd(
      parseISO(startDate),
      targetDays,
      effectiveMask,
      holidayDates,
      vacations as VacationRange[],
      budgetCapDate || null,
    );
    setEndDate(format(calcEnd, "yyyy-MM-dd"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleMode, budgetTarget, budgetUnit, startDate, Array.from(patternDays).join(","), patternHoursPerDay, workingDaysMask.join(","), holidayDates.size, JSON.stringify(vacations), budgetCapDate]);

  const isOverbooked = useMemo(() => {
    if (!startDate || !endDate) return false;
    if (!weekdayMode && hoursPerDay <= 0) return false;
    const excludeId = isEdit ? state.booking.id : undefined;
    const empBookings = allBookings.filter(
      (b) => b.employeeId === employeeId && b.id !== excludeId,
    );
    const s = parseISO(startDate);
    const e = parseISO(endDate);

    // Daily capacity derived from the employee's actual working days
    const activeDaysPerWeek = workingDaysMask.reduce(
      (sum, v) => sum + (v ? 1 : 0),
      0,
    );
    if (activeDaysPerWeek === 0) return false;
    const dailyCapacity = capacity / activeDaysPerWeek;

    const nw = Math.ceil((differenceInDays(e, s) + 1) / 7) + 1;
    for (let i = 0; i < nw; i++) {
      const ws = addWeeks(getMondayOfWeek(s), i);
      const weSunday = addDays(ws, 6);

      const newOverlapStart = s > ws ? s : ws;
      const newOverlapEnd = e < weSunday ? e : weSunday;
      if (newOverlapStart > newOverlapEnd) continue;

      // Hours this new booking adds in this week (mask-aware)
      let thisHours = 0;
      for (
        let d = new Date(newOverlapStart);
        d <= newOverlapEnd;
        d = addDays(d, 1)
      ) {
        if (!workingDaysMask[getISODay(d) - 1]) continue;
        if (weekdayMode) {
          thisHours += weekdayHours[String(d.getDay())] ?? 0;
        } else {
          thisHours += hoursPerDay;
        }
      }
      if (thisHours === 0) continue;

      // Hours already used by this employee's other bookings in this week (mask-aware)
      const used = empBookings.reduce((sum, b) => {
        const bs = parseISO(b.startDate);
        const be = parseISO(b.endDate);
        const bOverlapStart = bs > ws ? bs : ws;
        const bOverlapEnd = be < weSunday ? be : weSunday;
        if (bOverlapStart > bOverlapEnd) return sum;
        let bHours = 0;
        for (
          let d = new Date(bOverlapStart);
          d <= bOverlapEnd;
          d = addDays(d, 1)
        ) {
          if (!workingDaysMask[getISODay(d) - 1]) continue;
          if (b.weekdayHours != null) {
            bHours += b.weekdayHours[String(d.getDay())] ?? 0;
          } else {
            bHours += b.hoursPerDay;
          }
        }
        return sum + bHours;
      }, 0);

      // Capacity for the overlap = working days in overlap × daily capacity
      const workingDaysThisOverlap = countMaskDaysBetween(
        format(newOverlapStart, "yyyy-MM-dd"),
        format(newOverlapEnd, "yyyy-MM-dd"),
        workingDaysMask,
      );
      if (used + thisHours > workingDaysThisOverlap * dailyCapacity)
        return true;
    }
    return false;
  }, [
    startDate,
    endDate,
    hoursPerDay,
    weekdayMode,
    weekdayHours,
    allBookings,
    employeeId,
    capacity,
    workingDaysMask,
    isEdit,
    state,
  ]);
  // A role must be selected if the project has roles
  const rolesAvailable = projectRoles !== undefined;
  const hasRoles = rolesAvailable && projectRoles.length > 0;
  const roleRequired = !!projectId && hasRoles;

  // For create mode: need at least one assignee when not in dauer/budget derived mode
  // Modes that use the weekly pattern picker (4e) instead of the flat hours/weekday template
  const usesPatternPicker =
    !isEdit &&
    (scheduleMode === "budget" ||
      (scheduleMode === "dauer" && durationUnit !== "tage"));
  const datesValid = startDate && endDate && startDate <= endDate;
  const hoursValid = usesPatternPicker
    ? patternHoursPerDay > 0 &&
      Array.from(patternDays).some(
        (k) => parseInt(k) >= 1 && parseInt(k) <= 5 && !!workingDaysMask[Number(k) - 1],
      )
    : weekdayMode
    ? !allWeekdayZero
    : hoursPerDay > 0;
  const canSubmit =
    projectId &&
    (!roleRequired || roleId) &&
    datesValid &&
    hoursValid &&
    (!isEdit ? assignees.length > 0 : true) &&
    !createMut.isPending &&
    !updateMut.isPending;

  async function handleSubmit() {
    if (!canSubmit) return;
    // Build the hours payload
    let hoursPayload: { hoursPerDay?: number; weekdayHours: Record<string, number> | null };
    if (usesPatternPicker) {
      // Pattern picker (Dauer Wo/Mo + Budget): expand selected days at patternHoursPerDay
      hoursPayload = {
        weekdayHours: Object.fromEntries(
          (["1", "2", "3", "4", "5"] as const).map((k) => [
            k,
            patternDays.has(k) && workingDaysMask[Number(k) - 1]
              ? patternHoursPerDay
              : 0,
          ]),
        ) as Record<string, number>,
      };
    } else if (!isEdit && scheduleMode === "zeitraum" && zeitraumPerDateGrid.length > 0) {
      // Zeitraum new booking: derive weekdayHours from the per-date grid by
      // averaging non-blocked dates per ISO weekday (Mon–Fri).
      const buckets: Record<string, { sum: number; count: number }> = {};
      for (const entry of zeitraumPerDateGrid) {
        if (entry.isBlocked) continue;
        const dow = String(getISODay(parseISO(entry.ds)));
        if (!buckets[dow]) buckets[dow] = { sum: 0, count: 0 };
        buckets[dow].sum += entry.effectiveHours;
        buckets[dow].count++;
      }
      hoursPayload = {
        weekdayHours: Object.fromEntries(
          (["1", "2", "3", "4", "5"] as const).map((k) => [
            k,
            buckets[k] && buckets[k].count > 0 ? buckets[k].sum / buckets[k].count : 0,
          ]),
        ) as Record<string, number>,
      };
    } else if (weekdayMode) {
      hoursPayload = {
        weekdayHours: Object.fromEntries(
          (["1", "2", "3", "4", "5"] as const)
            .filter((k) => workingDaysMask[Number(k) - 1])
            .map((k) => [k, weekdayHours[k] ?? 0]),
        ) as Record<string, number>,
      };
    } else {
      hoursPayload = { hoursPerDay, weekdayHours: null };
    }
    const basePayload = {
      projectId: parseInt(projectId, 10),
      projectRoleId: roleId ? parseInt(roleId, 10) : null,
      startDate,
      endDate,
      ...hoursPayload,
      notes: notes.trim() || null,
      status: bookingStatus,
    };
    try {
      if (isEdit) {
        await updateMut.mutateAsync({ id: state.booking.id, data: { ...basePayload, employeeId: state.booking.employeeId } });
        toast({ title: "Booking updated" });
        onClose();
      } else {
        // Create one booking per assignee
        let succeeded = 0;
        for (const a of assignees) {
          try {
            await createMut.mutateAsync({ ...basePayload, employeeId: a.id });
            succeeded++;
          } catch {
            // continue with remaining assignees
          }
        }
        if (succeeded === assignees.length) {
          toast({ title: assignees.length === 1 ? "Booking created" : `${succeeded} bookings created` });
        } else {
          toast({ title: `${succeeded} of ${assignees.length} bookings created`, variant: "destructive" });
        }
        onClose();
      }
    } catch {
      toast({ title: "Failed to save booking", variant: "destructive" });
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    try {
      await deleteMut.mutateAsync(state.booking.id);
      toast({ title: "Booking deleted" });
      onClose();
    } catch {
      toast({ title: "Failed to delete booking", variant: "destructive" });
    }
  }

  const empName = isEdit
    ? state.booking.employeeName
    : assignees.length === 1
      ? assignees[0].name
      : assignees.length > 1
        ? `${assignees[0].name} +${assignees.length - 1}`
        : null;

  return (
    <>
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit booking${empName ? ` — ${empName}` : ""}` : "New booking"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">

          {/* ── People & project section ─────────────────────────────────────── */}
          {!isEdit && (
            <p className="text-xs text-muted-foreground font-medium -mb-2">People &amp; project</p>
          )}

          {/* Assignees (New only) */}
          {!isEdit && (
            <div className="space-y-1.5">
              <Label>Assignees</Label>
              <div className="flex flex-wrap items-center gap-1.5 min-h-9 px-2 py-1.5 rounded-md border border-input bg-background">
                {assignees.map((a) => (
                  <span key={a.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold uppercase">
                      {a.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                    </span>
                    {a.name}
                    <button
                      type="button"
                      onClick={() => setAssignees((prev) => prev.filter((x) => x.id !== a.id))}
                      className="ml-0.5 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <Popover open={assigneesOpen} onOpenChange={setAssigneesOpen}>
                  <PopoverTrigger asChild>
                    <button type="button" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                      <Plus className="h-3 w-3" /> Add person
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-0" align="start">
                    <div className="p-2 border-b">
                      <Input
                        placeholder="Search people…"
                        value={assigneeSearch}
                        onChange={(e) => setAssigneeSearch(e.target.value)}
                        className="h-7 text-xs"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto py-1">
                      {(() => {
                        const remaining = employees
                          .filter((e) => !assignees.some((a) => a.id === e.id))
                          .filter((e) => !assigneeSearch || (e.name ?? "").toLowerCase().includes(assigneeSearch.toLowerCase()));
                        if (remaining.length === 0) {
                          return <p className="px-3 py-2 text-xs text-muted-foreground">No more employees</p>;
                        }
                        return remaining.map((e) => (
                          <button
                            key={e.id}
                            type="button"
                            onClick={() => {
                              const empData = (employees as any[]).find((x) => x.id === e.id);
                              setAssignees((prev) => [
                                ...prev,
                                {
                                  id: e.id,
                                  name: e.name ?? "Unknown",
                                  capacity: empData?.weeklyCapacityHours ?? 40,
                                  workingDaysMask: Array.isArray(empData?.workingDaysMask)
                                    ? empData.workingDaysMask
                                    : [1, 1, 1, 1, 1, 0, 0],
                                  holidayCalendarCode: empData?.holidayCalendarCode ?? null,
                                },
                              ]);
                              setAssigneesOpen(false);
                              setAssigneeSearch("");
                            }}
                            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                          >
                            {e.name}
                          </button>
                        ));
                      })()}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              {assignees.length === 0 && (
                <p className="text-xs text-muted-foreground">Add at least one person to create a booking.</p>
              )}
            </div>
          )}

          {/* Project — searchable combobox */}
          <div className="space-y-1.5">
            <Label>Project</Label>
            <Popover open={projectOpen} onOpenChange={setProjectOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal h-10 text-sm"
                >
                  {projectId
                    ? (() => {
                        const p = projects.find((x) => String(x.id) === projectId);
                        return p ? (
                          <span className="truncate">{p.name}{p.clientName ? ` (${p.clientName})` : ""}</span>
                        ) : "Select project…";
                      })()
                    : <span className="text-muted-foreground">Select project…</span>}
                  <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[440px] p-0" align="start">
                <div className="p-2 border-b">
                  <Input
                    placeholder="Search projects…"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    className="h-8"
                    autoFocus
                  />
                </div>
                <div className="max-h-64 overflow-y-auto py-1">
                  {(() => {
                    const search = projectSearch.toLowerCase();
                    const filtered = projects
                      .filter((p) => p.active)
                      .filter(
                        (p) =>
                          !search ||
                          p.name.toLowerCase().includes(search) ||
                          (p.clientName ?? "").toLowerCase().includes(search),
                      );
                    if (filtered.length === 0) {
                      return <p className="px-3 py-2 text-sm text-muted-foreground">No projects found</p>;
                    }
                    const clientGroups = new Map<string, typeof filtered>();
                    for (const p of filtered) {
                      const key = p.clientName ?? "(No client)";
                      if (!clientGroups.has(key)) clientGroups.set(key, []);
                      clientGroups.get(key)!.push(p);
                    }
                    return Array.from(clientGroups.entries()).map(([clientName, projs]) => (
                      <div key={clientName}>
                        <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{clientName}</div>
                        {projs.map((p) => {
                          // Highlight matched substrings in medium weight (500)
                          const highlightText = (text: string, q: string) => {
                            if (!q) return <span>{text}</span>;
                            const idx = text.toLowerCase().indexOf(q);
                            if (idx === -1) return <span>{text}</span>;
                            return (
                              <>
                                {text.slice(0, idx)}
                                <span className="font-medium text-foreground">
                                  {text.slice(idx, idx + q.length)}
                                </span>
                                {text.slice(idx + q.length)}
                              </>
                            );
                          };
                          return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setProjectId(String(p.id));
                              setProjectOpen(false);
                              setProjectSearch("");
                            }}
                            className={`w-full text-left px-4 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground flex items-center justify-between ${
                              String(p.id) === projectId ? "bg-accent/50" : ""
                            }`}
                          >
                            <span className="truncate">{highlightText(p.name, projectSearch.toLowerCase())}</span>
                            {String(p.id) === projectId && <Check className="h-3.5 w-3.5 shrink-0 text-primary ml-2" />}
                          </button>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {/* Role — shown once a project is selected */}
          {projectId && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label>Role</Label>
                {!isEdit && roleId && roleBudgetStatus?.budgetedDays != null && roleBudgetStatus.budgetedDays > 0 && (() => {
                  const { budgetedDays, unplannedDays } = roleBudgetStatus;
                  const left = unplannedDays ?? 0;
                  // consumedPct = fraction of budget already planned/logged
                  const consumedPct = ((budgetedDays - left) / budgetedDays) * 100;
                  const tint =
                    consumedPct < 80
                      ? "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700"
                      : consumedPct <= 100
                      ? "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-700"
                      : "bg-destructive/10 text-destructive border-destructive/30";
                  return (
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tint}`}>
                      {Math.round(left * 10) / 10}d left
                    </span>
                  );
                })()}
              </div>
              {rolesLoading ? (
                <div className="h-10 rounded-md border bg-muted/50 animate-pulse" />
              ) : !hasRoles ? (
                <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                  No roles defined for this project
                </div>
              ) : (
                <Select value={roleId} onValueChange={setRoleId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {assignedRoles.length > 0 ? (
                      <>
                        <SelectGroup>
                          <SelectLabel className="text-xs text-muted-foreground px-2 py-1">
                            Assigned
                          </SelectLabel>
                          {assignedRoles.map((r) => {
                            const label =
                              r.name +
                              (r.dayRate > 0
                                ? ` — €${r.dayRate.toLocaleString("de-DE")}/day`
                                : "");
                            return (
                              <SelectItem key={r.id} value={String(r.id)}>
                                <span
                                  className="truncate block max-w-[380px]"
                                  title={label + " (assigned)"}
                                >
                                  {label}{" "}
                                  <span className="text-muted-foreground text-xs">
                                    (assigned)
                                  </span>
                                </span>
                              </SelectItem>
                            );
                          })}
                        </SelectGroup>
                        {unassignedRoles.length > 0 && (
                          <>
                            <SelectSeparator />
                            <SelectGroup>
                              <SelectLabel className="text-xs text-muted-foreground px-2 py-1">
                                Other roles
                              </SelectLabel>
                              {unassignedRoles.map((r) => {
                                const label =
                                  r.name +
                                  (r.dayRate > 0
                                    ? ` — €${r.dayRate.toLocaleString("de-DE")}/day`
                                    : "");
                                return (
                                  <SelectItem key={r.id} value={String(r.id)}>
                                    <span
                                      className="truncate block max-w-[380px]"
                                      title={label}
                                    >
                                      {label}
                                    </span>
                                  </SelectItem>
                                );
                              })}
                            </SelectGroup>
                          </>
                        )}
                      </>
                    ) : (
                      projectRoles!.map((r) => {
                        const label =
                          r.name +
                          (r.dayRate > 0
                            ? ` — €${r.dayRate.toLocaleString("de-DE")}/day`
                            : "");
                        return (
                          <SelectItem key={r.id} value={String(r.id)}>
                            <span
                              className="truncate block max-w-[380px]"
                              title={label}
                            >
                              {label}
                            </span>
                          </SelectItem>
                        );
                      })
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Status toggle — both New and Edit */}
          <div className="space-y-1.5">
            <Label>Status</Label>
            <div className="flex rounded-md border border-input overflow-hidden w-fit h-9">
              {(["confirmed", "tentative"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setBookingStatus(s)}
                  className={`px-4 text-sm font-medium transition-colors ${
                    bookingStatus === s
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s === "tentative" ? "Tentative" : "Confirmed"}
                </button>
              ))}
            </div>
            {bookingStatus === "tentative" && (
              <p className="text-xs text-muted-foreground">Tentative bookings are not counted against role budget.</p>
            )}
          </div>

          {/* ── Schedule section ─────────────────────────────────────────────── */}
          {!isEdit && (
            <>
              <div className="border-t border-border/50 -mx-1" />
              <p className="text-xs text-muted-foreground font-medium -mb-2">Schedule</p>

              {/* Schedule mode switcher (New only) */}
              <div className="space-y-1.5">
                <div className="flex rounded-md border border-input overflow-hidden w-full h-9">
                  {(["zeitraum", "dauer", "budget"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setScheduleMode(m)}
                      className={`flex-1 text-sm font-medium transition-colors ${
                        scheduleMode === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "zeitraum" ? "Date range" : m === "dauer" ? "Duration" : "Budget"}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Date range — shown in Edit mode always, in New mode only for Zeitraum */}
          {(isEdit || scheduleMode === "zeitraum") && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Start date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>End date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          )}

          {/* Dauer mode (New only) */}
          {!isEdit && scheduleMode === "dauer" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start date</Label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Duration</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      className="flex-1"
                      value={durationValue}
                      onChange={(e) => setDurationValue(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                    <div className="flex rounded-md border border-input overflow-hidden h-10">
                      {(["tage", "wo", "mo"] as const).map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setDurationUnit(u)}
                          className={`px-2.5 text-xs font-medium transition-colors ${
                            durationUnit === u
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {u === "tage" ? "Days" : u === "wo" ? "Wks" : "Mo"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Dauer "Tage" — working-day engine with auto-shift banner */}
              {durationUnit === "tage" && startDate && (() => {
                const rawStart = parseISO(startDate);
                const effectiveStart = findNextWorkingDay(rawStart, workingDaysMask, holidayDates, vacations as VacationRange[]);
                const calcEnd = calcEndFromNWorkingDays(effectiveStart, durationValue, workingDaysMask, holidayDates, vacations as VacationRange[]);
                const calcEndStr = format(calcEnd, "yyyy-MM-dd");
                const effectiveStartStr = format(effectiveStart, "yyyy-MM-dd");
                const wasShifted = effectiveStartStr !== startDate;
                return (
                  <div className="space-y-1.5">
                    {wasShifted && (
                      <div className="flex items-start gap-1.5 text-xs text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 rounded px-2 py-1.5">
                        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>
                          Booked on {format(rawStart, "d MMM yyyy")} shifted to{" "}
                          <span className="font-medium">{format(effectiveStart, "d MMM yyyy")}</span> — start date fell on a weekend/holiday, moved to the next working day automatically.
                        </span>
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
                      Calculated end date: <span className="font-medium text-foreground">{format(calcEnd, "d MMM yyyy")}</span>
                      {wasShifted && <span className="ml-1">(from {format(effectiveStart, "d MMM")})</span>}
                    </div>
                  </div>
                );
              })()}

              {/* Dauer "Wo"/"Mo" — weekly pattern picker + calendar-day end */}
              {(durationUnit === "wo" || durationUnit === "mo") && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Weekly pattern</Label>
                    <div className="flex gap-1 flex-wrap">
                      {(["1","2","3","4","5","6","7"] as const).map((k) => {
                        const labels: Record<string,string> = { "1":"Mo","2":"Tu","3":"We","4":"Th","5":"Fr","6":"Sa","7":"Su" };
                        const inMask = workingDaysMask[Number(k) - 1];
                        const selected = patternDays.has(k);
                        return (
                          <button
                            key={k}
                            type="button"
                            disabled={!inMask}
                            onClick={() =>
                              setPatternDays((prev) => {
                                const next = new Set(prev);
                                if (next.has(k)) next.delete(k); else next.add(k);
                                return next;
                              })
                            }
                            className={`w-9 h-8 rounded-md border text-xs font-medium transition-colors ${
                              !inMask
                                ? "opacity-30 cursor-not-allowed border-border text-muted-foreground"
                                : selected
                                ? "bg-primary text-primary-foreground border-primary"
                                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                            }`}
                          >
                            {labels[k]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground shrink-0">Hours/day</Label>
                      <Input
                        type="number"
                        min={0.5}
                        max={24}
                        step={0.5}
                        className="w-20 h-8 text-center text-sm"
                        value={patternHoursPerDay}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!isNaN(v) && v > 0) setPatternHoursPerDay(v);
                        }}
                      />
                    </div>
                  </div>
                  {startDate && (() => {
                    // Use proper calendar arithmetic: addWeeks / addMonths avoids
                    // the drift that comes from multiplying by fixed day counts.
                    const calcEnd = durationUnit === "wo"
                      ? addDays(addWeeks(parseISO(startDate), durationValue), -1)
                      : addDays(addMonths(parseISO(startDate), durationValue), -1);
                    const calcEndStr = format(calcEnd, "yyyy-MM-dd");
                    return (
                      <div className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
                        Calculated end date: <span className="font-medium text-foreground">{format(calcEnd, "d MMM yyyy")}</span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Budget mode (New only) */}
          {!isEdit && scheduleMode === "budget" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start date</Label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Target</Label>
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      className="flex-1"
                      value={budgetTarget}
                      onChange={(e) => setBudgetTarget(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                    <div className="flex rounded-md border border-input overflow-hidden h-10">
                      {(["tage", "stunden"] as const).map((u) => (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setBudgetUnit(u)}
                          className={`px-2.5 text-xs font-medium transition-colors ${
                            budgetUnit === u
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {u === "tage" ? "Days" : "Hours"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Weekly pattern picker */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Weekly pattern</Label>
                <div className="flex gap-1 flex-wrap">
                  {(["1","2","3","4","5","6","7"] as const).map((k) => {
                    const labels: Record<string,string> = { "1":"Mo","2":"Tu","3":"We","4":"Th","5":"Fr","6":"Sa","7":"Su" };
                    const inMask = workingDaysMask[Number(k) - 1];
                    const selected = patternDays.has(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        disabled={!inMask}
                        onClick={() =>
                          setPatternDays((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k); else next.add(k);
                            return next;
                          })
                        }
                        className={`w-9 h-8 rounded-md border text-xs font-medium transition-colors ${
                          !inMask
                            ? "opacity-30 cursor-not-allowed border-border text-muted-foreground"
                            : selected
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        }`}
                      >
                        {labels[k]}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground shrink-0">Hours/day</Label>
                  <Input
                    type="number"
                    min={0.5}
                    max={24}
                    step={0.5}
                    className="w-20 h-8 text-center text-sm"
                    value={patternHoursPerDay}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v) && v > 0) setPatternHoursPerDay(v);
                    }}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Cap date (optional — latest end)</Label>
                <Input
                  type="date"
                  value={budgetCapDate}
                  onChange={(e) => setBudgetCapDate(e.target.value)}
                />
              </div>

              {/* Budget mode: proper working-day engine (pattern-aware) */}
              {startDate && (() => {
                // Combine workingDaysMask with selected patternDays so only chosen
                // pattern days count toward the target (keys "1"=Mon … "7"=Sun,
                // mask index 0=Mon … 6=Sun, so key = String(i+1)).
                const effectiveMask = workingDaysMask.map((v, i) =>
                  v && patternDays.has(String(i + 1)) ? 1 : 0,
                );
                // Convert hours → days using patternHoursPerDay, not a hardcoded 8
                const targetDays =
                  budgetUnit === "tage"
                    ? budgetTarget
                    : budgetTarget / (patternHoursPerDay > 0 ? patternHoursPerDay : 8);
                const { endDate: calcEnd, reachedDays, skippedHolidays } = calcBudgetEnd(
                  parseISO(startDate),
                  targetDays,
                  effectiveMask,
                  holidayDates,
                  vacations as VacationRange[],
                  budgetCapDate || null,
                );
                const finalEnd = format(calcEnd, "yyyy-MM-dd");
                const capHit = !!(budgetCapDate && reachedDays < targetDays);
                return (
                  <div className="space-y-1.5">
                    <div className="text-xs bg-muted/50 rounded px-2 py-1.5 text-muted-foreground space-y-0.5">
                      <div>
                        Calculated end date:{" "}
                        <span className="font-medium text-foreground">{format(calcEnd, "d MMM yyyy")}</span>
                      </div>
                      <div>
                        Bookable days to target:{" "}
                        <span className="font-medium text-foreground">{reachedDays}d</span>
                        {skippedHolidays > 0 && (
                          <span className="ml-1">({skippedHolidays} holiday{skippedHolidays > 1 ? "s" : ""} skipped)</span>
                        )}
                      </div>
                    </div>
                    {capHit && (
                      <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>
                          Only {reachedDays} of {targetDays} day{targetDays !== 1 ? "s" : ""} reachable by{" "}
                          {format(parseISO(budgetCapDate), "d MMM yyyy")}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Hours per day / weekday mode — hidden for pattern-picker modes (Dauer Wo/Mo, Budget) */}
          {!usesPatternPicker && <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Hours per day</Label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors">
                <Checkbox
                  checked={weekdayMode}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setWeekdayHours({
                        "1": hoursPerDay,
                        "2": hoursPerDay,
                        "3": hoursPerDay,
                        "4": hoursPerDay,
                        "5": hoursPerDay,
                      });
                      setWeekdayMode(true);
                    } else {
                      // Exact average — no fallback; if 0, canSubmit stays false until user sets a value
                      const avg =
                        Object.values(weekdayHours).reduce((s, h) => s + h, 0) /
                        5;
                      setHoursPerDay(avg);
                      setHoursPerDayInput(String(avg));
                      setWeekdayMode(false);
                    }
                  }}
                />
                Set per weekday
              </label>
            </div>

            {!weekdayMode ? (
              <div className="flex gap-2">
                {[2, 4, 6, 8].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setHoursPerDay(preset);
                      setHoursPerDayInput(String(preset));
                    }}
                    className={`flex-1 py-1.5 rounded-md border text-sm font-medium transition-colors ${
                      hoursPerDay === preset
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                    }`}
                  >
                    {preset}h
                  </button>
                ))}
                <Input
                  type="number"
                  min={0.5}
                  max={24}
                  step={0.5}
                  className="w-20 text-center"
                  value={hoursPerDayInput}
                  onChange={(e) => {
                    setHoursPerDayInput(e.target.value);
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v) && v > 0) setHoursPerDay(v);
                  }}
                />
              </div>
            ) : (
              <div className="space-y-2">
                {/* Preset buttons */}
                <div className="flex gap-1.5 flex-wrap">
                  {WEEKDAY_PRESETS.map((p) => {
                    const active = matchesPreset(
                      weekdayHours,
                      p.hours as Record<string, number>,
                    );
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => setWeekdayHours({ ...p.hours })}
                        className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  {!WEEKDAY_PRESETS.some((p) =>
                    matchesPreset(
                      weekdayHours,
                      p.hours as Record<string, number>,
                    ),
                  ) && (
                    <span className="px-2.5 py-1 rounded-md border border-primary bg-primary/10 text-primary text-xs font-medium">
                      Custom
                    </span>
                  )}
                </div>

                {/* Per-weekday inputs */}
                <div className="grid grid-cols-5 gap-1.5">
                  {(["1", "2", "3", "4", "5"] as const).map((key) => {
                    const isWorkingDay = !!workingDaysMask[Number(key) - 1];
                    return (
                      <div key={key} className="space-y-0.5">
                        <Label
                          className={`text-xs text-center block ${isWorkingDay ? "text-muted-foreground" : "text-muted-foreground/40"}`}
                        >
                          {DAY_LABELS[key]}
                        </Label>
                        <Input
                          type="number"
                          min={0}
                          max={24}
                          step={0.5}
                          disabled={!isWorkingDay}
                          title={
                            isWorkingDay
                              ? undefined
                              : "Not a working day for this employee — hours here are not counted."
                          }
                          className={`text-center px-1 ${!isWorkingDay ? "opacity-40 cursor-not-allowed" : ""}`}
                          value={isWorkingDay ? (weekdayHours[key] ?? 0) : 0}
                          onChange={(e) => {
                            if (!isWorkingDay) return;
                            const v = parseFloat(e.target.value);
                            setWeekdayHours((prev) => ({
                              ...prev,
                              [key]: isNaN(v) ? 0 : Math.max(0, Math.min(24, v)),
                            }));
                          }}
                        />
                      </div>
                    );
                  })}
                </div>

                {/* All-zero warning */}
                {allWeekdayZero && (
                  <div className="flex items-center gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    All days are set to 0h — booking has no hours.
                  </div>
                )}

                {/* Zeitraum per-date grid — New booking only.
                    Each working day in the range is shown. Holidays and approved
                    absences are locked at 0h (gray + icon). Other days start at
                    hoursPerDay and are individually editable.
                    On save, a per-weekday average is derived from the non-blocked
                    entries and stored as weekdayHours. */}
                {!isEdit && scheduleMode === "zeitraum" && zeitraumPerDateGrid.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="max-h-44 overflow-y-auto border rounded-md divide-y divide-border/50">
                      {zeitraumPerDateGrid.map(({ ds, label, effectiveHours, isBlocked, isHoliday, holidayName }) => (
                        <div
                          key={ds}
                          className={`flex items-center gap-2 px-2.5 py-1 text-xs ${isBlocked ? "bg-muted/40" : ""}`}
                        >
                          <span className={`w-24 shrink-0 ${isBlocked ? "text-muted-foreground" : "text-foreground"}`}>
                            {label}
                          </span>
                          {isBlocked ? (
                            <span className="flex items-center gap-1 text-muted-foreground italic">
                              <Ban className="h-3 w-3 shrink-0" />
                              0h — {isHoliday ? (holidayName ?? "public holiday") : "absence"}
                            </span>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min={0}
                                max={24}
                                step={0.5}
                                className="w-16 h-6 text-center text-xs px-1"
                                value={effectiveHours}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value);
                                  setPerDateHours((prev) => ({
                                    ...prev,
                                    [ds]: isNaN(v) ? 0 : Math.max(0, Math.min(24, v)),
                                  }));
                                }}
                              />
                              <span className="text-muted-foreground">h</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {zeitraumBlockedDates.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {zeitraumBlockedDates.length} day{zeitraumBlockedDates.length > 1 ? "s" : ""} auto-set to 0h (holidays / absences).
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>}

          {/* Notes — collapsible */}
          {notesExpanded ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Note</Label>
                {!notes && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setNotesExpanded(false)}
                  >
                    Remove
                  </button>
                )}
              </div>
              <Textarea
                rows={2}
                placeholder="Internal notes…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                autoFocus
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNotesExpanded(true)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              Add note
            </button>
          )}

          {/* Booking summary — New mode only */}
          {!isEdit && bookingSummary && (
            <div className="rounded-md bg-muted/50 border border-border px-3 py-2 text-sm space-y-1">
              <div className="font-medium text-foreground mb-1 flex items-center gap-1.5">
                <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
                This slot
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>Working days in period</span>
                <span className="font-medium text-foreground">
                  {bookingSummary.workingDays}d
                </span>
              </div>
              {bookingSummary.holidayCount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Public holidays</span>
                  <span>−{bookingSummary.holidayCount}d</span>
                </div>
              )}
              {bookingSummary.vacationCount > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Vacations / absences</span>
                  <span>−{bookingSummary.vacationCount}d</span>
                </div>
              )}
              <div className="border-t border-border/60 pt-1 flex justify-between font-medium">
                <span>Bookable days</span>
                <span className="text-foreground">
                  {bookingSummary.bookableDays}d
                </span>
              </div>
              {booksAgainstBudget != null && (
                <div className="flex justify-between text-muted-foreground">
                  <span>
                    Books against role budget
                    {editBookingReleased ? (
                      <span className="text-xs text-muted-foreground/70"> (future only)</span>
                    ) : null}
                  </span>
                  <span className="font-medium text-blue-600 dark:text-blue-400">
                    +{Math.round(booksAgainstBudget * 10) / 10}d
                  </span>
                </div>
              )}
              {totalHours != null && totalHours > 0 && (
                <div className="border-t border-border/60 pt-1 font-medium text-foreground text-xs">
                  {weekdayMode && weeklyTotal != null ? (
                    <>
                      {formatWeekdayHours(weekdayHours)} (
                      {weeklyTotal % 1 === 0
                        ? weeklyTotal
                        : weeklyTotal.toFixed(1)}
                      h/week) →{" "}
                      {totalHours % 1 === 0
                        ? totalHours
                        : totalHours.toFixed(1)}
                      h total
                    </>
                  ) : (
                    <>
                      {bookingSummary.bookableDays}d ×{" "}
                      {hoursPerDay % 1 === 0
                        ? hoursPerDay
                        : hoursPerDay.toFixed(1)}
                      h ={" "}
                      {totalHours % 1 === 0
                        ? totalHours
                        : totalHours.toFixed(1)}
                      h total
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Compact role-budget bar (7a / 7b / 7c) ── */}
          {roleId && roleBudgetStatus && (() => {
            const {
              budgetedDays,
              loggedDays,
              invoicedDays,
              reservedDays,
              stalePlanDays,
              unplannedDays,
              freeDays,
              bookings: roleBookings,
            } = roleBudgetStatus;
            const r1 = (n: number) => Math.round(n * 10) / 10;
            const selectedRole = projectRoles?.find((r) => String(r.id) === roleId);
            const empName = isEdit
              ? (employees.find((e) => e.id === employeeId)?.name ?? "Employee")
              : (state as ModalState).employeeName;

            if (budgetedDays == null) {
              return (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground flex items-start gap-2">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>No budget defined for this role — slots aren't checked against a budget. Set a budgeted-days figure on the role to enable tracking.</span>
                </div>
              );
            }

            const todayStr = new Date().toISOString().slice(0, 10);
            const released = isEdit ? !!(state as EditModalState).booking.pastReleasedAt : false;
            const unplanned = unplannedDays ?? 0;
            const statusColor = (val: number) =>
              val > 10 ? "text-green-700 dark:text-green-400"
              : val >= 0 ? "text-yellow-700 dark:text-yellow-400"
              : "text-destructive";

            const effDays = (s: string, e: string, hpd: number, wh: Record<string, number> | null): number => {
              if (!s || !e || e < s) return 0;
              if (!released) return calcBookingHoursClient(s, e, hpd, wh, workingDaysMask, holidayDates, vacations).budgetDays;
              if (e < todayStr) return 0;
              return calcBookingHoursClient(s >= todayStr ? s : todayStr, e, hpd, wh, workingDaysMask, holidayDates, vacations).budgetDays;
            };
            const savedSlotDays = isEdit ? effDays(
              (state as EditModalState).booking.startDate,
              (state as EditModalState).booking.endDate,
              (state as EditModalState).booking.hoursPerDay,
              (state as EditModalState).booking.weekdayHours,
            ) : 0;
            const editedSlotDays = booksAgainstBudget ?? 0;
            const slotDelta = r1(editedSlotDays - savedSlotDays);
            const unplannedProjected = r1(unplanned - slotDelta);
            const showProjected = isEdit && Math.abs(slotDelta) >= 0.05;

            // pastPlanDays comes from the server-fetched /past-undelivered endpoint
            // (defined at component level as `pastPlanDays`). The local calculation
            // was removed because it used planned days instead of undelivered days,
            // producing wrong release amounts when some of the past plan had been logged.

            const mySlots = allBookings
              .filter((b) => b.employeeId === employeeId && String(b.projectRoleId) === roleId)
              .sort((a, b) => a.startDate.localeCompare(b.startDate));
            const currentId = isEdit ? (state as EditModalState).booking.id : null;

            // Bar geometry — consumption per the identity: Logged + Re-plannable
            const overshoot = Math.max(0, -unplanned);
            const barTotal = (budgetedDays ?? 0) + overshoot;
            const budgetedNum = budgetedDays ?? 0;
            const loggedPct = barTotal > 0 ? Math.min((loggedDays / barTotal) * 100, 100) : 0;
            const resPct = barTotal > 0 ? Math.min((reservedDays / barTotal) * 100, 100 - loggedPct) : 0;
            const budgetLinePct = barTotal > 0 ? (budgetedNum / barTotal) * 100 : 100;
            const pastMarkerPct = barTotal > 0 && pastPlanDays > 0
              ? Math.min(((loggedDays + reservedDays) / barTotal) * 100, budgetLinePct)
              : 0;

            return (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm space-y-2">
                {/* 7a Header */}
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span>Role budget{selectedRole ? ` — ${selectedRole.name}` : ""}</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Budget details"
                        className="inline-flex items-center justify-center rounded hover:bg-muted/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring p-0.5"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent side="bottom" align="start" className="w-72">
                      <div className="space-y-2">
                        <div className="font-semibold text-sm">Role budget{selectedRole ? ` — ${selectedRole.name}` : ""}</div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                          <div className="flex justify-between"><span className="text-muted-foreground">Budgeted</span><span className="font-medium">{budgetedNum}d</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Logged</span><span>{r1(loggedDays)}d</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Invoiced</span><span>{r1(invoicedDays)}d</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Re-plannable</span><span className="text-blue-600 dark:text-blue-400 font-medium">{r1(reservedDays)}d</span></div>
                          <div className={`flex justify-between ${statusColor(unplanned)}`}><span>Unplanned</span><span className="font-medium">{r1(unplanned)}d</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">Free</span><span>{freeDays != null ? r1(freeDays) + "d" : "—"}</span></div>
                          {(stalePlanDays ?? 0) > 0.05 && (
                            <div className="col-span-2 flex items-center justify-between text-amber-700 dark:text-amber-400">
                              <span>Stale plan</span>
                              <span className="flex items-center gap-2">
                                <span className="font-medium">{r1(stalePlanDays)}d</span>
                                {confirmReleaseAll ? (
                                  <>
                                    <button
                                      type="button"
                                      className="text-[11px] font-medium underline disabled:opacity-50"
                                      disabled={releasingAll}
                                      onClick={releaseAllStaleOnRole}
                                    >
                                      {releasingAll ? "Releasing…" : "Confirm release all"}
                                    </button>
                                    <button
                                      type="button"
                                      className="text-[11px] underline text-muted-foreground"
                                      disabled={releasingAll}
                                      onClick={() => setConfirmReleaseAll(false)}
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="text-[11px] underline"
                                    title="Write off all undelivered past plan on this role. Executed per slot — each release is recorded on its booking and reversible there."
                                    onClick={() => setConfirmReleaseAll(true)}
                                  >
                                    Release all
                                  </button>
                                )}
                              </span>
                            </div>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Budget = Logged + Re-plannable + Unplanned. Stale past plan is flagged separately and never counts as consumption. Figures are live and match the Budget tab.
                        </p>
                        {showProjected && (
                          <div className={`rounded-md border px-2 py-1.5 text-xs ${unplannedProjected < 0 ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-background/60"}`}>
                            <div className="flex justify-between font-medium text-foreground">
                              <span>{slotDelta >= 0 ? "Your edits add" : "Your edits free"}</span>
                              <span>{slotDelta >= 0 ? "+" : "−"}{r1(Math.abs(slotDelta))}d</span>
                            </div>
                            <div className={`flex justify-between ${statusColor(unplannedProjected)}`}>
                              <span>Unplanned after saving</span>
                              <span className="font-medium">{unplannedProjected}d</span>
                            </div>
                          </div>
                        )}
                        {roleBookings.length > 0 && (
                          <div className="border-t border-border/40 pt-1.5 space-y-0.5">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">All employees on this role</div>
                            {roleBookings.map((rb) => (
                              <div key={rb.employeeId} className="flex justify-between text-xs text-muted-foreground/80">
                                <span className="truncate max-w-[140px]">{rb.employeeName}</span>
                                <span className="shrink-0 ml-2">{r1(rb.days)}d planned · {r1(rb.loggedDays)}d logged</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* 7b Budget bar */}
                <div className="space-y-1">
                  <div className="relative h-3 rounded bg-muted overflow-visible">
                    {loggedPct > 0 && (
                      <div className="absolute left-0 top-0 h-full rounded-l bg-violet-600 dark:bg-violet-500" style={{ width: `${loggedPct}%` }} />
                    )}
                    {resPct > 0 && (
                      <div className="absolute top-0 h-full bg-violet-200 dark:bg-violet-800 border-r border-violet-400 dark:border-violet-600" style={{ left: `${loggedPct}%`, width: `${resPct}%` }} />
                    )}
                    {overshoot > 0 && (
                      <>
                        <div className="absolute top-0 h-full border-l-2 border-dashed border-destructive/70 z-10" style={{ left: `${budgetLinePct}%` }} />
                        <div className="absolute top-0 h-full bg-destructive/30 rounded-r" style={{ left: `${budgetLinePct}%`, width: `${(overshoot / barTotal) * 100}%` }} />
                      </>
                    )}
                    {pastPlanDays > 0 && barTotal > 0 && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="absolute top-1/2 -translate-y-1/2 z-20 -translate-x-1/2 inline-flex items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/60 border border-amber-400 dark:border-amber-600 w-4 h-4 hover:bg-amber-200"
                            style={{ left: `${pastMarkerPct}%` }}
                            aria-label="Past undelivered plan"
                          >
                            <Clock className="h-2.5 w-2.5 text-amber-700 dark:text-amber-400" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent side="top" className="w-72">
                          <div className="space-y-2">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {r1(pastPlanDays)}d planned before today was never logged — this is stale plan. It no longer counts against the budget, but it hides slipped work. Releasing writes it off as of today; days missed after the release are flagged again.
                            </p>
                            {confirmRelease ? (
                              <div className="flex gap-2 flex-wrap">
                                <Button size="sm" className="h-7" disabled={releaseMut.isPending}
                                  onClick={async () => {
                                    try {
                                      const updated = await releaseMut.mutateAsync((state as EditModalState).booking.id);
                                      toast({ title: "Past plan released" });
                                      if (onBookingUpdated) { setConfirmRelease(false); onBookingUpdated(updated); } else { onClose(); }
                                    } catch { toast({ title: "Failed to release past plan", variant: "destructive" }); }
                                  }}
                                >
                                  {releaseMut.isPending ? "Releasing…" : `Release ${r1(pastPlanDays)}d`}
                                </Button>
                                <Button variant="ghost" size="sm" className="h-7" onClick={() => setConfirmRelease(false)}>Cancel</Button>
                              </div>
                            ) : (
                              <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setConfirmRelease(true)}>
                                <Clock className="h-3.5 w-3.5" />
                                Release {r1(pastPlanDays)}d past plan
                              </Button>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>0d</span>
                    <span>{budgetedNum}d budgeted</span>
                    {overshoot > 0 && <span className="text-destructive">{r1(loggedDays + reservedDays)}d total</span>}
                  </div>
                </div>

                {/* 7c Footer */}
                <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
                  <span>
                    {r1(editedSlotDays)}d bookable this slot
                    {showProjected && (
                      <span className={slotDelta >= 0 ? "" : "text-green-600 dark:text-green-400"}>
                        {" "}→ {slotDelta >= 0 ? "+" : ""}{r1(slotDelta)}d vs saved
                      </span>
                    )}
                  </span>
                  {mySlots.length > 1 && (
                    <>
                      <span>·</span>
                      <button
                        type="button"
                        className="text-primary underline underline-offset-2 hover:text-primary/80"
                        onClick={() => setShowSlotList((v) => !v)}
                      >
                        {mySlots.length} slots on this role · {showSlotList ? "hide" : "view all"}
                      </button>
                    </>
                  )}
                  {/* Undo release — only when booking is already released */}
                  {isEdit && released && (
                    <>
                      <span>·</span>
                      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                        <Clock className="h-3 w-3" /> Past plan released
                      </span>
                      <button
                        type="button"
                        disabled={unreleaseMut.isPending}
                        className="text-primary underline underline-offset-2 hover:text-primary/80 disabled:opacity-50"
                        onClick={async () => {
                          try {
                            const updated = await unreleaseMut.mutateAsync((state as EditModalState).booking.id);
                            toast({ title: "Release undone — past plan restored" });
                            if (onBookingUpdated) onBookingUpdated(updated); else onClose();
                          } catch {
                            toast({ title: "Failed to undo release", variant: "destructive" });
                          }
                        }}
                      >
                        {unreleaseMut.isPending ? "Undoing…" : "Undo release"}
                      </button>
                    </>
                  )}
                </div>

                {/* Slot list (expanded on demand) */}
                {showSlotList && mySlots.length > 0 && (
                  <div className="border-t border-border/40 pt-1.5 space-y-1">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{empName}'s slots on this role</div>
                    {mySlots.map((b) => {
                      const bd = calcBookingHoursClient(b.startDate, b.endDate, b.hoursPerDay, b.weekdayHours, workingDaysMask, holidayDates, vacations).budgetDays;
                      const isCur = currentId != null && b.id === currentId;
                      const rel = !!b.pastReleasedAt;
                      return (
                        <div key={b.id} className={`flex items-center justify-between rounded px-1.5 py-1 text-xs ${isCur ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}>
                          <span className="flex items-center gap-1.5 truncate">
                            {isCur && <span className="text-primary font-semibold">●</span>}
                            <span className="truncate">{format(parseISO(b.startDate), "d MMM")} – {format(parseISO(b.endDate), "d MMM yy")}</span>
                            {rel && <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground border border-border rounded px-1"><Clock className="h-2.5 w-2.5" /> released</span>}
                            {(slotStaleMap.get(b.id) ?? 0) > 0.05 && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700 rounded px-1"
                                title="Undelivered past plan on this slot — open it to release, or use “Release all” in the budget details."
                              >
                                ⚠ {r1(slotStaleMap.get(b.id) ?? 0)}d stale
                              </span>
                            )}
                            {isCur && <span className="text-[10px] text-primary">this slot</span>}
                          </span>
                          <span className="shrink-0 ml-2 text-muted-foreground">{r1(bd)}d</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Overbooking warning */}
          {isOverbooked && (
            <div className="flex items-start gap-2 rounded-md bg-yellow-50 border border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>This booking will cause overbooking in some weeks.</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between pt-2">
          {isEdit && !confirmDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              Delete booking
            </Button>
          )}
          {isEdit && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Are you sure?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          )}
          {!confirmDelete && (
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {createMut.isPending || updateMut.isPending
                  ? "Saving…"
                  : isEdit
                    ? "Save changes"
                    : assignees.length > 1
                      ? `Create ${assignees.length} bookings`
                      : "Create booking"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Budget definitions info Dialog — sibling portal, does not submit the booking */}
    <Dialog open={showBudgetInfo} onOpenChange={setShowBudgetInfo}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Resource planning — how these numbers work</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto max-h-[70vh] space-y-4 text-sm pr-1">
          <p className="text-muted-foreground text-xs">
            8 hours = 1 day. Every figure is an 8 h-day equivalent (days = hours ÷ 8).
          </p>

          <div className="space-y-1.5">
            <div className="font-semibold text-foreground">Master identity</div>
            <pre className="rounded bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap leading-relaxed">
              {`Budget = Logged + Re-plannable + Unplanned`}
            </pre>
          </div>

          <div className="space-y-1.5">
            <div className="font-semibold text-foreground">Equations</div>
            <pre className="rounded bg-muted px-3 py-2 text-xs font-mono whitespace-pre-wrap leading-relaxed">
              {`Re-plannable = Σ max(Planned − Logged, 0)   (today onwards, per day ÷ 8)
Stale plan   = Σ max(Planned − Logged, 0)   (before today — flag, not consumption)
Unplanned    = Budget − Logged − Re-plannable
Free         = Budget − Logged        (operational: real work left)
Remaining    = Budget − Invoiced      (finance: budget not yet billed)`}
            </pre>
          </div>

          <div className="space-y-1.5">
            <div className="font-semibold text-foreground">Definitions</div>
            <table className="w-full text-xs border-collapse">
              <tbody>
                {[
                  ["Budget", "Days budgeted for the role."],
                  ["Planned", "Days booked across all slots (Σ planned hours ÷ 8)."],
                  ["Logged", "Hours recorded in timesheets ÷ 8."],
                  ["Invoiced", "Logged days already billed. A billing overlay — never moves capacity."],
                  ["Re-plannable", "Future planned work not yet delivered; movable."],
                  ["Stale plan", "Booked days before today that were never delivered. A warning to release or re-plan — not consumption."],
                  ["Unplanned", "Budget − Logged − Re-plannable: what you can still book. Negative = over-committed."],
                  ["Free", "Real work left before the budget is burnt."],
                  ["Remaining", "Budget not yet locked/billed (finance view)."],
                ].map(([term, desc]) => (
                  <tr key={term} className="border-b border-border/40 last:border-0">
                    <td className="py-1.5 pr-3 font-medium text-foreground whitespace-nowrap align-top w-[130px]">{term}</td>
                    <td className="py-1.5 text-muted-foreground align-top">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5">
            <div className="font-semibold text-foreground">Rules</div>
            <ul className="space-y-1.5 text-muted-foreground list-disc list-inside text-xs leading-relaxed">
              <li>Only working days (per employee mask, excluding holidays and absences) count toward planned hours.</li>
              <li>If logged hours exceed planned for a day, the over-logging floors at zero — it does not create negative re-plannable capacity.</li>
              <li>Each resource booking is one slot; re-plannable is the sum across all slots for the role.</li>
              <li>Past undelivered plan becomes stale: it stops counting against the budget automatically and stays flagged until released or re-planned. Releasing freezes the write-off at the release date — days missed afterwards are flagged again.</li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

// ── Vacation Dialog ────────────────────────────────────────────────────────────
type VacationType = "vacation" | "sick" | "unpaid_leave" | "other";

const VACATION_TYPE_LABELS: Record<VacationType, string> = {
  vacation: "Vacation",
  sick: "Sick leave",
  unpaid_leave: "Unpaid leave",
  other: "Other absence",
};

interface VacationDialogCreateState {
  mode: "create";
  employeeId: number;
  employeeName: string;
  defaultStartDate?: string;
  defaultEndDate?: string;
}

interface VacationDialogEditState {
  mode: "edit";
  vacation: VacationEntry;
  employeeName: string;
}

type VacationDialogState = VacationDialogCreateState | VacationDialogEditState;

interface VacationDialogProps {
  state: VacationDialogState;
  onClose: () => void;
}

function VacationDialog({ state, onClose }: VacationDialogProps) {
  const { toast } = useToast();
  const createMut = useCreateVacation();
  const updateMut = useUpdateVacation();
  const deleteMut = useDeleteVacation();

  const isEdit = state.mode === "edit";
  const vacation = isEdit ? state.vacation : null;

  const [startDate, setStartDate] = useState(
    isEdit
      ? vacation!.startDate
      : ((state as VacationDialogCreateState).defaultStartDate ??
          format(new Date(), "yyyy-MM-dd")),
  );
  const [endDate, setEndDate] = useState(
    isEdit
      ? vacation!.endDate
      : ((state as VacationDialogCreateState).defaultEndDate ??
          format(new Date(), "yyyy-MM-dd")),
  );
  const [vacationType, setVacationType] = useState<VacationType>(
    isEdit ? (vacation!.vacationType as VacationType) : "vacation",
  );
  const [note, setNote] = useState(isEdit ? (vacation!.note ?? "") : "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const employeeId = isEdit
    ? vacation!.employeeId
    : (state as VacationDialogCreateState).employeeId;
  const employeeName = state.employeeName;

  const canSubmit = startDate && endDate && endDate >= startDate;

  async function handleSubmit() {
    const payload = {
      employeeId,
      startDate,
      endDate,
      vacationType,
      note: note.trim() || null,
    };
    try {
      if (isEdit) {
        await updateMut.mutateAsync({ id: vacation!.id, data: payload });
        toast({ title: "Absence updated" });
      } else {
        await createMut.mutateAsync(payload);
        toast({ title: "Absence created" });
      }
      onClose();
    } catch {
      toast({ title: "Error saving absence", variant: "destructive" });
    }
  }

  async function handleDelete() {
    try {
      await deleteMut.mutateAsync(vacation!.id);
      toast({ title: "Absence deleted" });
      onClose();
    } catch {
      toast({ title: "Error deleting absence", variant: "destructive" });
    }
  }

  const isSaving = createMut.isPending || updateMut.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit absence" : "Add absence"} — {employeeName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={vacationType}
              onValueChange={(v) => setVacationType(v as VacationType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.entries(VACATION_TYPE_LABELS) as [
                    VacationType,
                    string,
                  ][]
                ).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vac-start">Start date</Label>
              <Input
                id="vac-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (e.target.value > endDate) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vac-end">End date</Label>
              <Input
                id="vac-end"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vac-note">
              Note{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Textarea
              id="vac-note"
              rows={2}
              placeholder="Optional note…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between pt-2">
          {isEdit && !confirmDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
          {isEdit && confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Are you sure?
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
              >
                {deleteMut.isPending ? "Deleting…" : "Yes, delete"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          )}
          {!confirmDelete && (
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit || isSaving}>
                {isSaving ? "Saving…" : isEdit ? "Save changes" : "Add absence"}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function ResourcePlannerPage() {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [focusDate, setFocusDate] = useState(() => startOfMonth(today));
  const [windowStart, setWindowStart] = useState(() => addDays(startOfMonth(today), -SIDE_BUFFER_DAYS));
  const [zoom, setZoom] = useState<ZoomLevel>("month");
  const [modal, setModal] = useState<AnyModalState | null>(null);
  const [vacationModal, setVacationModal] =
    useState<VacationDialogState | null>(null);

  // Project shelf: set of selected project IDs for highlight (empty = no highlight)
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<number>>(
    new Set(),
  );
  const [sortMode, setSortMode] = useState<SortMode>("alpha-asc");
  // Scroll tracking for sticky-like segment labels
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);

  const dragStateRef = useRef<{
    bookingId: number;
    mode: "move" | "resize-start" | "resize-end";
    originX: number;
    originalStartDate: string;
    originalEndDate: string;
    dayWidth: number;
  } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomLevel>("month");
  const focusDateRef = useRef<Date>(startOfMonth(today));
  const pendingScrollRef = useRef<number | null>(null);
  const rebaseScrollRef = useRef<number | null>(null);
  // Guards against the async scroll event fired by a programmatic scrollLeft assignment
  // triggering a second rebase immediately after the first one settles.
  const rebaseGuardRef = useRef(false);
  const windowStartRef = useRef<Date>(windowStart);
  const [gridAvailableWidth, setGridAvailableWidth] = useState(800);
  const [isPanning, setIsPanning] = useState(false);
  const panDragRef = useRef<{
    active: boolean;
    startX: number;
    startWindowStart: Date;
    lastDayOffset: number;
  }>({ active: false, startX: 0, startWindowStart: new Date(), lastDayOffset: 0 });
  const dayWidthRef = useRef<number>(0);
  const [dragGhost, setDragGhost] = useState<{
    bookingId: number;
    startDate: string;
    endDate: string;
  } | null>(null);

  const dayWidth = DAY_WIDTH[zoom];
  const periodDays = useMemo(() => {
    switch (zoom) {
      case "week":    return 7;
      case "month":   return getDaysInMonth(focusDate);
      case "quarter": return differenceInDays(
        addMonths(startOfQuarter(focusDate), 3),
        startOfQuarter(focusDate),
      );
      case "year":    return differenceInDays(
        startOfYear(addYears(focusDate, 1)),
        startOfYear(focusDate),
      );
    }
  }, [zoom, focusDate]);

  const numDays = useMemo(() => {
    const viewportDays = Math.ceil(gridAvailableWidth / dayWidth);
    return Math.max(periodDays, viewportDays) + 2 * SIDE_BUFFER_DAYS;
  }, [periodDays, gridAvailableWidth, dayWidth]);

  const days = useMemo(
    () => Array.from({ length: numDays }, (_, i) => addDays(windowStart, i)),
    [windowStart, numDays],
  );
  const monthGroups = useMemo(() => getMonthGroups(days), [days]);

  // Per-day widths: weekends are narrower than weekdays
  const { dayWidths, dayLefts, contentWidth } = useMemo(() => {
    const widths: number[] = [];
    const lefts: number[] = [0];
    for (let i = 0; i < numDays; i++) {
      const w = varDayWidth(addDays(windowStart, i), dayWidth);
      widths.push(w);
      lefts.push(lefts[i] + w);
    }
    return { dayWidths: widths, dayLefts: lefts, contentWidth: lefts[numDays] ?? 0 };
  }, [numDays, windowStart, dayWidth]);

  // Pixel width of each month group (accounts for variable day widths)
  const monthGroupWidths = useMemo(() => {
    let offset = 0;
    return monthGroups.map((m) => {
      const w = (dayLefts[offset + m.dayCount] ?? dayLefts[dayLefts.length - 1] ?? 0)
              - (dayLefts[offset] ?? 0);
      offset += m.dayCount;
      return w;
    });
  }, [monthGroups, dayLefts]);

  // Map pixel offset → day index (for click handlers)
  const pixelToDay = useCallback((px: number): number => {
    let day = 0;
    for (let d = 0; d < numDays - 1; d++) {
      if ((dayLefts[d + 1] ?? Infinity) <= px) day = d + 1;
      else break;
    }
    return Math.max(0, Math.min(day, numDays - 1));
  }, [dayLefts, numDays]);

  const windowEnd = addDays(windowStart, numDays);

  // Today marker
  const todayInRange = today >= windowStart && today < windowEnd;
  const todayOffset = todayInRange
    ? (dayLefts[differenceInDays(today, windowStart)] ?? null)
    : null;

  // Data
  const { data: employees = [] } = useListEmployees(
    { includeInactive: false },
    {
      query: { queryKey: getListEmployeesQueryKey({ includeInactive: false }) },
    },
  );
  const { data: projects = [] } = useListProjects(
    { includeInactive: false },
    {
      query: { queryKey: getListProjectsQueryKey({ includeInactive: false }) },
    },
  );
  // All projects (including inactive) used only for the one-time color backfill
  const { data: allProjectsForPatch = [] } = useListProjects(
    { includeInactive: true },
    {
      query: { queryKey: getListProjectsQueryKey({ includeInactive: true }) },
    },
  );
  const { data: bookings = [], isLoading: bookingsLoading } =
    useResourceBookings();
  const { data: allVacations = [] } = useAllVacations();
  const { data: holidayCalendars = [] } = useListHolidayCalendars({
    query: { queryKey: getListHolidayCalendarsQueryKey() },
  });

  const bookingsByEmployee = useMemo(() => {
    const map: Record<number, ResourceBookingFull[]> = {};
    for (const b of bookings) {
      (map[b.employeeId] ??= []).push(b);
    }
    return map;
  }, [bookings]);

  // ── Project budgets for booking bar tooltips ─────────────────────────────────
  const projectIdsWithRoles = useMemo(() => {
    const ids = new Set<number>();
    for (const b of bookings as ResourceBookingFull[]) {
      if (b.projectRoleId) ids.add(b.projectId);
    }
    return Array.from(ids);
  }, [bookings]);

  const plannerBudgetQueries = useQueries({
    queries: projectIdsWithRoles.map((pid) => ({
      queryKey: ["project-budget", String(pid)],
      queryFn: async () => {
        const r = await fetch(`/api/projects/${pid}/budget`, {
          credentials: "include",
        });
        if (!r.ok) return null;
        return r.json() as Promise<{
          roles: Array<{
            id: number;
            plannedDays: number;
            budgetedDays: number | null;
            bookedDays: number; // logged/delivered days
            reservedDays: number;
            stalePlanDays?: number;
          }>;
        }>;
      },
    })),
  });

  // Map from roleId → budget figures for the timeline bar tooltip
  const roleBudgetMap = useMemo(() => {
    const map = new Map<
      number,
      {
        plannedDays: number;
        budgetedDays: number | null;
        loggedDays: number;
        reservedDays: number;
        stalePlanDays: number;
      }
    >();
    projectIdsWithRoles.forEach((pid, i) => {
      const data = plannerBudgetQueries[i]?.data;
      if (data?.roles) {
        for (const role of data.roles) {
          map.set(role.id, {
            plannedDays: role.plannedDays,
            budgetedDays: role.budgetedDays,
            loggedDays: role.bookedDays ?? 0,
            reservedDays: role.reservedDays ?? 0,
            stalePlanDays: role.stalePlanDays ?? 0,
          });
        }
      }
    });
    return map;
  }, [projectIdsWithRoles, plannerBudgetQueries]);

  function openCreateModal(emp?: (typeof employees)[number] | null) {
    if (!emp) {
      setModal({ mode: "create" });
      return;
    }
    const e = emp as any;
    setModal({
      mode: "create",
      employeeId: e.id,
      employeeName: e.name,
      capacity: e.weeklyCapacityHours ?? 40,
      workingDaysMask: Array.isArray(e.workingDaysMask)
        ? e.workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0],
      holidayCalendarCode: e.holidayCalendarCode ?? null,
    });
  }

  function openEditModal(b: ResourceBookingFull) {
    const emp = (employees as any[]).find((e) => e.id === b.employeeId);
    setModal({
      mode: "edit",
      booking: b,
      capacity: b.weeklyCapacityHours,
      workingDaysMask: Array.isArray(emp?.workingDaysMask)
        ? emp.workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0],
      holidayCalendarCode: emp?.holidayCalendarCode ?? null,
    });
  }

  function openCloseOutModal(b: ResourceBookingFull) {
    const emp = (employees as any[]).find((e) => e.id === b.employeeId);
    setModal({
      mode: "edit",
      booking: b,
      capacity: b.weeklyCapacityHours,
      workingDaysMask: Array.isArray(emp?.workingDaysMask)
        ? emp.workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0],
      holidayCalendarCode: emp?.holidayCalendarCode ?? null,
      openInConfirmRelease: true,
    });
  }

  function handleBookingUpdated(updatedBooking: ResourceBookingFull) {
    setModal((prev) => {
      if (!prev || prev.mode !== "edit") return prev;
      return { ...prev, booking: updatedBooking, openInConfirmRelease: false };
    });
  }

  const updateBookingMut = useUpdateBooking();
  const { toast } = useToast();

  function startBookingDrag(
    e: React.MouseEvent,
    booking: ResourceBookingFull,
    mode: "move" | "resize-start" | "resize-end",
    dayWidth: number,
  ) {
    e.stopPropagation();
    e.preventDefault();

    dragStateRef.current = {
      bookingId: booking.id,
      mode,
      originX: e.clientX,
      originalStartDate: booking.startDate,
      originalEndDate: booking.endDate,
      dayWidth,
    };

    function computeNewDates(
      ds: NonNullable<typeof dragStateRef.current>,
      deltaDays: number,
    ) {
      // Planner window boundaries (inclusive end = last visible day)
      const winStart = windowStart;
      const winEnd = addDays(windowStart, numDays - 1);

      let newStart = ds.originalStartDate;
      let newEnd = ds.originalEndDate;

      if (ds.mode === "move") {
        let rawStart = addDays(parseISO(ds.originalStartDate), deltaDays);
        let rawEnd = addDays(parseISO(ds.originalEndDate), deltaDays);
        // Soft-clamp to planner window, preserving booking duration
        if (rawStart < winStart) {
          const shift = differenceInDays(winStart, rawStart);
          rawStart = winStart;
          rawEnd = addDays(rawEnd, shift);
        }
        if (rawEnd > winEnd) {
          const shift = differenceInDays(rawEnd, winEnd);
          rawEnd = winEnd;
          rawStart = addDays(rawStart, -shift);
        }
        newStart = format(rawStart, "yyyy-MM-dd");
        newEnd = format(rawEnd, "yyyy-MM-dd");
      } else if (ds.mode === "resize-start") {
        // Minimum 1 day: start can equal end (inclusive dates, startDate === endDate is valid)
        let rawStart = addDays(parseISO(ds.originalStartDate), deltaDays);
        if (rawStart < winStart) rawStart = winStart;
        if (rawStart > parseISO(ds.originalEndDate))
          rawStart = parseISO(ds.originalEndDate);
        newStart = format(rawStart, "yyyy-MM-dd");
      } else {
        // Minimum 1 day: end can equal start (inclusive dates, startDate === endDate is valid)
        let rawEnd = addDays(parseISO(ds.originalEndDate), deltaDays);
        if (rawEnd > winEnd) rawEnd = winEnd;
        if (rawEnd < parseISO(ds.originalStartDate))
          rawEnd = parseISO(ds.originalStartDate);
        newEnd = format(rawEnd, "yyyy-MM-dd");
      }

      return { newStart, newEnd };
    }

    function onMouseMove(ev: MouseEvent) {
      const ds = dragStateRef.current;
      if (!ds) return;
      const delta = Math.round((ev.clientX - ds.originX) / ds.dayWidth);
      const { newStart, newEnd } = computeNewDates(ds, delta);
      setDragGhost({
        bookingId: ds.bookingId,
        startDate: newStart,
        endDate: newEnd,
      });
    }

    function onMouseUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      const ds = dragStateRef.current;
      dragStateRef.current = null;
      if (!ds) {
        setDragGhost(null);
        return;
      }
      const delta = Math.round((ev.clientX - ds.originX) / ds.dayWidth);
      if (delta === 0) {
        // Plain click — clear ghost and open edit modal
        setDragGhost(null);
        openEditModal(booking);
        return;
      }
      const { newStart, newEnd } = computeNewDates(ds, delta);
      // Keep ghost alive (optimistic UI) until mutation settles
      updateBookingMut.mutate(
        {
          id: ds.bookingId,
          data: {
            employeeId: booking.employeeId,
            projectId: booking.projectId,
            projectRoleId: booking.projectRoleId,
            startDate: newStart,
            endDate: newEnd,
            hoursPerDay: booking.hoursPerDay,
            weekdayHours: booking.weekdayHours,
            notes: booking.notes,
          },
        },
        {
          onSuccess: () => {
            // Query invalidation will load fresh server data; clear ghost now
            setDragGhost(null);
          },
          onError: () => {
            // Revert to server position
            setDragGhost(null);
            toast({ title: "Failed to move booking", variant: "destructive" });
          },
        },
      );
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function openCreateVacationModal(
    emp: any,
    defaultStartDate?: string,
    defaultEndDate?: string,
  ) {
    setVacationModal({
      mode: "create",
      employeeId: emp.id,
      employeeName: emp.name,
      defaultStartDate,
      defaultEndDate,
    });
  }

  function openEditVacationModal(v: VacationEntry, empName: string) {
    setVacationModal({
      mode: "edit",
      vacation: v,
      employeeName: empName,
    });
  }

  const todayStr = format(today, "yyyy-MM-dd");

  const allActiveEmployees = useMemo(
    () => (Array.isArray(employees) ? employees : []).filter((e) => (e as any).active !== false),
    [employees],
  );

  // ── Project shelf — flat list of projects derived from bookings ─────────────
  const shelfProjects = useMemo(() => {
    const projectMap = new Map<
      number,
      { id: number; name: string; clientName: string; color: string }
    >();
    for (const b of bookings as ResourceBookingFull[]) {
      if (!projectMap.has(b.projectId)) {
        projectMap.set(b.projectId, {
          id: b.projectId,
          name: b.projectName,
          clientName: b.clientName ?? "No Client",
          color: resolveProjectColor(b.projectId, b.projectColor),
        });
      }
    }
    const ordered = [...projectMap.values()].sort((a, b) => {
      if (a.clientName !== b.clientName)
        return a.clientName.localeCompare(b.clientName);
      return a.name.localeCompare(b.name);
    });
    if (selectedProjectIds.size === 0) return ordered;
    // Stable sort: selected tiles float to the front
    return [
      ...ordered.filter((p) => selectedProjectIds.has(p.id)),
      ...ordered.filter((p) => !selectedProjectIds.has(p.id)),
    ];
  }, [bookings, selectedProjectIds]);

  // Filter panel: newly appearing projects are auto-selected (initial load
  // selects everything) so nothing is hidden unexpectedly.
  const knownShelfIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const fresh = shelfProjects.filter((p) => !knownShelfIdsRef.current.has(p.id));
    if (fresh.length === 0) return;
    for (const p of fresh) knownShelfIdsRef.current.add(p.id);
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      for (const p of fresh) next.add(p.id);
      return next;
    });
  }, [shelfProjects]);

  // ── Filtered + sorted employees ─────────────────────────────────────────────
  const activeEmployees = useMemo(() => {
    return [...allActiveEmployees].sort((a: any, b: any) => {
      if (sortMode === "alpha-asc") return a.name.localeCompare(b.name);
      if (sortMode === "alpha-desc") return b.name.localeCompare(a.name);
      const aTotal = (bookings as ResourceBookingFull[])
        .filter((bk) => bk.employeeId === a.id)
        .reduce((s, bk) => s + bk.hoursPerDay, 0);
      const bTotal = (bookings as ResourceBookingFull[])
        .filter((bk) => bk.employeeId === b.id)
        .reduce((s, bk) => s + bk.hoursPerDay, 0);
      return sortMode === "alloc-desc" ? bTotal - aTotal : aTotal - bTotal;
    });
  }, [allActiveEmployees, bookings, sortMode]);

  // ── Vacation markers ──────────────────────────────────────────────────────
  const vacationsByEmployee = useMemo(() => {
    const map: Record<number, VacationEntry[]> = {};
    for (const v of allVacations) {
      (map[v.employeeId] ??= []).push(v);
    }
    return map;
  }, [allVacations]);

  // ── Holiday markers ───────────────────────────────────────────────────────
  const calendarIdByCode = useMemo(() => {
    const map: Record<string, number> = {};
    for (const cal of holidayCalendars as any[]) {
      map[cal.code] = cal.id;
    }
    return map;
  }, [holidayCalendars]);

  const visibleYears = useMemo(() => {
    const years = new Set<number>();
    years.add(windowStart.getFullYear());
    years.add(windowEnd.getFullYear());
    return [...years];
  }, [windowStart, windowEnd]);

  const uniqueCalendarQueries = useMemo(() => {
    const seen = new Set<string>();
    const queries: Array<{ calendarId: number; year: number; code: string }> =
      [];
    for (const emp of activeEmployees) {
      const code: string | null = (emp as any).holidayCalendarCode ?? null;
      if (!code) continue;
      const calendarId = calendarIdByCode[code];
      if (!calendarId) continue;
      for (const year of visibleYears) {
        const key = `${calendarId}-${year}`;
        if (!seen.has(key)) {
          seen.add(key);
          queries.push({ calendarId, year, code });
        }
      }
    }
    return queries;
  }, [activeEmployees, calendarIdByCode, visibleYears]);

  const holidayQueryResults = useQueries({
    queries: uniqueCalendarQueries.map(({ calendarId, year }) => ({
      queryKey: ["planner-holidays", calendarId, year],
      queryFn: async (): Promise<HolidayEntry[]> => {
        const r = await fetch(
          `/api/holiday-calendars/${calendarId}/holidays?year=${year}`,
          { credentials: "include" },
        );
        if (!r.ok) throw new Error("Failed to fetch holidays");
        return r.json();
      },
      enabled: true,
    })),
  });

  const holidaysByCalendarId = useMemo(() => {
    const map: Record<number, HolidayEntry[]> = {};
    holidayQueryResults.forEach((result, idx) => {
      if (!result.data) return;
      const { calendarId } = uniqueCalendarQueries[idx];
      (map[calendarId] ??= []).push(...result.data);
    });
    return map;
  }, [holidayQueryResults, uniqueCalendarQueries]);

  const holidaysByEmployee = useMemo(() => {
    const map: Record<number, HolidayEntry[]> = {};
    for (const emp of activeEmployees) {
      const code: string | null = (emp as any).holidayCalendarCode ?? null;
      if (!code) continue;
      const calendarId = calendarIdByCode[code];
      if (!calendarId) continue;
      const holidays = holidaysByCalendarId[calendarId] ?? [];
      const windowStartStr = format(windowStart, "yyyy-MM-dd");
      const windowEndStr = format(windowEnd, "yyyy-MM-dd");
      map[(emp as any).id] = holidays.filter(
        (h) => h.date >= windowStartStr && h.date < windowEndStr,
      );
    }
    return map;
  }, [
    activeEmployees,
    calendarIdByCode,
    holidaysByCalendarId,
    windowStart,
    windowEnd,
  ]);

  // ── Additive project color patch (fire-and-forget on first load) ─────────
  const qc = useQueryClient();
  const colorPatchedRef = useRef(false);
  useEffect(() => {
    const patchList = Array.isArray(allProjectsForPatch) ? allProjectsForPatch : [];
    if (colorPatchedRef.current || !patchList.length)
      return;
    const colorless = patchList.filter(
      (p: any) => !p.color,
    );
    if (!colorless.length) {
      colorPatchedRef.current = true;
      return;
    }
    colorPatchedRef.current = true;
    Promise.all(
      colorless.map((p: any) => {
        const color = PROJECT_COLORS[p.id % PROJECT_COLORS.length];
        return fetch(`/api/projects/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ color }),
        });
      }),
    ).then(() => {
      qc.invalidateQueries({
        queryKey: getListProjectsQueryKey({ includeInactive: false }),
      });
      qc.invalidateQueries({
        queryKey: getListProjectsQueryKey({ includeInactive: true }),
      });
    });
  }, [allProjectsForPatch, qc]);

  // ── Per-employee holiday date sets ────────────────────────────────────────
  const holidayDateSetByEmployee = useMemo(() => {
    const result: Record<number, Set<string>> = {};
    for (const emp of activeEmployees) {
      const id = (emp as any).id;
      result[id] = new Set((holidaysByEmployee[id] ?? []).map((h) => h.date));
    }
    return result;
  }, [activeEmployees, holidaysByEmployee]);

  // ── Per-employee vacation day maps (date → VacationEntry) ────────────────
  const vacationDayMapByEmployee = useMemo(() => {
    const wsStr = format(windowStart, "yyyy-MM-dd");
    const weStr = format(addDays(windowEnd, -1), "yyyy-MM-dd");
    const result: Record<number, Map<string, VacationEntry>> = {};
    for (const emp of activeEmployees) {
      const id = (emp as any).id;
      const dayMap = new Map<string, VacationEntry>();
      for (const v of vacationsByEmployee[id] ?? []) {
        const start = v.startDate < wsStr ? wsStr : v.startDate;
        const end = v.endDate > weStr ? weStr : v.endDate;
        if (start > end) continue;
        let d = parseISO(start);
        const eDate = parseISO(end);
        while (d <= eDate) {
          dayMap.set(format(d, "yyyy-MM-dd"), v);
          d = addDays(d, 1);
        }
      }
      result[id] = dayMap;
    }
    return result;
  }, [activeEmployees, vacationsByEmployee, windowStart, windowEnd]);

  // ── Booking segments (day-level, precomputed per employee) ────────────────
  const segmentsByEmployee = useMemo(() => {
    const result: Record<number, Segment[]> = {};
    for (const emp of activeEmployees) {
      const id = (emp as any).id;
      const empMask: number[] = Array.isArray((emp as any).workingDaysMask)
        ? (emp as any).workingDaysMask
        : [1, 1, 1, 1, 1, 0, 0];
      const holidayDateSet =
        holidayDateSetByEmployee[id] ?? new Set<string>();
      const vacationDayMap =
        vacationDayMapByEmployee[id] ?? new Map<string, VacationEntry>();
      const vacationDateSet = new Set(vacationDayMap.keys());
      const empBookings = bookingsByEmployee[id] ?? [];
      const allSegs: SegmentBase[] = [];
      for (const b of empBookings) {
        const color = resolveProjectColor(b.projectId, b.projectColor);
        allSegs.push(
          ...buildBookingSegments(
            b,
            windowStart,
            numDays,
            color,
            empMask,
            holidayDateSet,
            vacationDateSet,
          ),
        );
      }
      result[id] = assignSegmentLanes(allSegs);
    }
    return result;
  }, [
    activeEmployees,
    bookingsByEmployee,
    windowStart,
    numDays,
    holidayDateSetByEmployee,
    vacationDayMapByEmployee,
  ]);

  // All employees stay visible at fixed row height (empty rows show an
  // "Available" label); the project filter hides segments, not people.
  const visibleEmployees = activeEmployees;

  // Segments visible under the current project filter (unchecked → hidden).
  const filteredSegmentsByEmployee = useMemo(() => {
    const result: Record<number, Segment[]> = {};
    for (const [empIdStr, segs] of Object.entries(segmentsByEmployee)) {
      result[Number(empIdStr)] = segs.filter((seg) => selectedProjectIds.has(seg.projectId));
    }
    return result;
  }, [segmentsByEmployee, selectedProjectIds]);

  // Window label
  const windowLabel = useMemo(() => {
    switch (zoom) {
      case "week":
        return `${format(focusDate, "MMM d")} – ${format(addDays(focusDate, 6), "MMM d, yyyy")}`;
      case "month":
        return format(focusDate, "MMMM yyyy");
      case "quarter":
        return `Q${getQuarter(focusDate)} ${format(focusDate, "yyyy")}`;
      case "year":
        return format(focusDate, "yyyy");
    }
  }, [zoom, focusDate]);

  // Keep refs in sync for the wheel/pan handlers (close over stale state)
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { dayWidthRef.current = dayWidth; }, [dayWidth]);
  useEffect(() => { windowStartRef.current = windowStart; }, [windowStart]);
  useEffect(() => { focusDateRef.current = focusDate; }, [focusDate]);

  // Apply a pending scroll position on the next paint (set by navigateTo / zoom change / rebase)
  useLayoutEffect(() => {
    if (gridRef.current) {
      if (pendingScrollRef.current !== null) {
        gridRef.current.scrollLeft = pendingScrollRef.current;
        pendingScrollRef.current = null;
      } else if (rebaseScrollRef.current !== null) {
        gridRef.current.scrollLeft = rebaseScrollRef.current;
        rebaseScrollRef.current = null;
        // Block the async scroll event that the browser fires after a programmatic
        // scrollLeft assignment — otherwise it can immediately re-trigger a rebase.
        rebaseGuardRef.current = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          rebaseGuardRef.current = false;
        }));
      }
    }
  });

  // On mount: position grid so the focused period's start is at the left edge
  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.scrollLeft = SIDE_BUFFER_DAYS * DAY_WIDTH["month"];
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track grid width so numDays always fills the viewport
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setGridAvailableWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setGridAvailableWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Jump to a new focus period and reset scroll so the period start is at the left edge
  function navigateTo(newFocus: Date, newDw: number = dayWidth) {
    setFocusDate(newFocus);
    setWindowStart(addDays(newFocus, -SIDE_BUFFER_DAYS));
    pendingScrollRef.current = SIDE_BUFFER_DAYS * newDw;
  }

  // Zoom change helper: snaps focus date to the right boundary for the new zoom level
  const handleZoomChange = (newZoom: ZoomLevel) => {
    const newFocus = snapToZoom(focusDateRef.current, newZoom);
    const newDw = DAY_WIDTH[newZoom];
    setZoom(newZoom);
    setFocusDate(newFocus);
    setWindowStart(addDays(newFocus, -SIDE_BUFFER_DAYS));
    pendingScrollRef.current = SIDE_BUFFER_DAYS * newDw;
  };

  // Scroll-to-zoom on the planner grid
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ZOOM_ORDER: ZoomLevel[] = ["week", "month", "quarter", "year"];
    const handler = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // ignore horizontal scroll
      e.preventDefault();
      const curr = zoomRef.current;
      const idx = ZOOM_ORDER.indexOf(curr);
      const newIdx = Math.max(0, Math.min(ZOOM_ORDER.length - 1, e.deltaY > 0 ? idx + 1 : idx - 1));
      const newZoom = ZOOM_ORDER[newIdx];
      if (newZoom === curr) return;
      const newFocus = snapToZoom(focusDateRef.current, newZoom);
      const newDw = DAY_WIDTH[newZoom];
      setZoom(newZoom);
      setFocusDate(newFocus);
      setWindowStart(addDays(newFocus, -SIDE_BUFFER_DAYS));
      pendingScrollRef.current = SIDE_BUFFER_DAYS * newDw;
    };
    el.addEventListener("wheel", handler, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handler, { capture: true });
  }, []);

  // Timeline pan-drag: drag the date header left/right to slide the window
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panDragRef.current.active) return;
      const deltaX = panDragRef.current.startX - e.clientX;
      const dayOffset = Math.round(deltaX / dayWidthRef.current);
      if (dayOffset === panDragRef.current.lastDayOffset) return;
      panDragRef.current.lastDayOffset = dayOffset;
      setWindowStart(addDays(panDragRef.current.startWindowStart, dayOffset));
    };
    const onUp = () => {
      if (!panDragRef.current.active) return;
      panDragRef.current.active = false;
      setIsPanning(false);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <AdminLayout>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card shrink-0 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <CalendarRange className="h-5 w-5 text-primary" />
            <h1 className="text-xl font-bold tracking-tight">
              Resource Planner
            </h1>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => openCreateModal()}
            >
              <Plus className="h-3.5 w-3.5" />
              New booking
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const newFocus = (() => {
                  switch (zoom) {
                    case "week":    return addWeeks(focusDate, -1);
                    case "month":   return addMonths(focusDate, -1);
                    case "quarter": return addMonths(focusDate, -3);
                    case "year":    return addYears(focusDate, -1);
                  }
                })();
                navigateTo(newFocus);
              }}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <span className="text-sm font-medium w-40 text-center">
              {windowLabel}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const newFocus = (() => {
                  switch (zoom) {
                    case "week":    return addWeeks(focusDate, 1);
                    case "month":   return addMonths(focusDate, 1);
                    case "quarter": return addMonths(focusDate, 3);
                    case "year":    return addYears(focusDate, 1);
                  }
                })();
                navigateTo(newFocus);
              }}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigateTo(snapToZoom(today, zoom))}
            >
              Today
            </Button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">

            {/* Sort */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  {sortMode === "alpha-asc"
                    ? "A–Z"
                    : sortMode === "alpha-desc"
                      ? "Z–A"
                      : sortMode === "alloc-desc"
                        ? "Most allocated"
                        : "Least allocated"}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[160px]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Sort employees
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {(
                  [
                    { value: "alpha-asc", label: "A–Z" },
                    { value: "alpha-desc", label: "Z–A" },
                    { value: "alloc-desc", label: "Most allocated" },
                    { value: "alloc-asc", label: "Least allocated" },
                  ] as { value: SortMode; label: string }[]
                ).map(({ value, label }) => (
                  <DropdownMenuItem
                    key={value}
                    onSelect={() => setSortMode(value)}
                    className="gap-2 cursor-pointer"
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center`}
                    >
                      {sortMode === value && <Check className="h-3 w-3" />}
                    </span>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

          </div>

          {/* Zoom toggle */}
          <div className="flex items-center gap-1 border border-border rounded-md p-0.5">
            {(["week", "month", "quarter", "year"] as ZoomLevel[]).map((z) => (
              <button
                key={z}
                onClick={() => handleZoomChange(z)}
                className={`px-3 py-1 text-xs rounded font-medium capitalize transition-colors ${
                  zoom === z
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {z === "week" ? "Week" : z === "month" ? "Month" : z === "quarter" ? "Quarter" : "Year"}
              </button>
            ))}
          </div>
        </div>

        {/* ── Project filter — searchable, client-grouped, active-count badge ── */}
        {shelfProjects.length > 0 && (
          <div className="px-4 py-2.5 border-b border-border bg-card flex items-center">
            <FilterPanel
              label="Projects"
              items={shelfProjects.map((p) => ({
                id: p.id,
                label: p.name,
                group: p.clientName,
                color: p.color,
              }))}
              selected={selectedProjectIds as unknown as Set<number | string>}
              onSelectedChange={(next) =>
                setSelectedProjectIds(new Set([...next].map(Number)))
              }
              searchPlaceholder="Search projects…"
            />
          </div>
        )}

        {/* Planner grid */}
        <div
          ref={gridRef}
          className={`flex-1 overflow-auto relative${isPanning ? " cursor-grabbing select-none" : ""}`}
          onScroll={(e) => {
            const el = e.currentTarget;
            const sl = el.scrollLeft;
            setTimelineScrollLeft(sl);

            // Edge-rebase: when the user pans near the left or right wall,
            // silently shift windowStart and compensate the scroll position so
            // the visible content stays in place — giving effectively infinite scroll.
            if (pendingScrollRef.current !== null || rebaseScrollRef.current !== null || rebaseGuardRef.current) return;
            const dw = dayWidthRef.current;
            const threshold = SIDE_BUFFER_DAYS * dw * 0.5;
            const ws = windowStartRef.current;
            if (sl < threshold) {
              const newWS = addDays(ws, -SIDE_BUFFER_DAYS);
              const shiftPx = computePixelSpanOfDays(newWS, SIDE_BUFFER_DAYS, dw);
              setWindowStart(() => newWS);
              rebaseScrollRef.current = sl + shiftPx;
            } else {
              const maxSl = el.scrollWidth - el.clientWidth;
              if (sl > maxSl - threshold) {
                const shiftPx = computePixelSpanOfDays(ws, SIDE_BUFFER_DAYS, dw);
                setWindowStart((prev) => addDays(prev, SIDE_BUFFER_DAYS));
                rebaseScrollRef.current = sl - shiftPx;
              }
            }
          }}
        >
          {bookingsLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-50 text-sm text-muted-foreground">
              Loading bookings…
            </div>
          )}

          <div style={{ minWidth: EMPLOYEE_COL + contentWidth }}>
            {/* ── Sticky header ── */}
            <div className="sticky top-0 z-20 flex bg-card border-b border-border">
              {/* People header cell */}
              <div
                className="sticky left-0 z-30 bg-card border-r border-border flex items-end px-4 pb-2 shrink-0"
                style={{ width: EMPLOYEE_COL, minHeight: 56 }}
              >
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  People
                </span>
              </div>

              {/* Time labels — drag left/right to pan the timeline */}
              <div
                style={{ width: contentWidth }}
                className="cursor-grab"
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  panDragRef.current = {
                    active: true,
                    startX: e.clientX,
                    startWindowStart: windowStart,
                    lastDayOffset: 0,
                  };
                  setIsPanning(true);
                }}
              >
                {/* Top row: period / month groups */}
                <div className="flex border-b border-border/50 bg-muted/30">
                  {zoom === "year" ? (
                    <div
                      className="shrink-0 px-2 py-1 text-xs font-semibold text-muted-foreground border-r border-border/50"
                      style={{ width: contentWidth }}
                    >
                      {format(focusDate, "yyyy")}
                    </div>
                  ) : (
                    monthGroups.map((m, i) => (
                      <div
                        key={i}
                        className="shrink-0 px-2 py-1 text-xs font-semibold text-muted-foreground border-r border-border/50 last:border-r-0"
                        style={{ width: monthGroupWidths[i] }}
                      >
                        {m.label}
                      </div>
                    ))
                  )}
                </div>
                {/* Bottom row: day / week ticks */}
                <div className="flex relative">
                  {zoom === "week" && days.map((d, i) => {
                    const isWe = d.getDay() === 0 || d.getDay() === 6;
                    return (
                      <div
                        key={i}
                        className="shrink-0 border-r border-border/40 last:border-r-0 flex flex-col items-center justify-center py-1"
                        style={{ width: dayWidths[i], opacity: isWe ? 0.45 : 1 }}
                      >
                        <span className="text-[11px] font-medium text-muted-foreground/70">
                          {format(d, "EEE")}
                        </span>
                        <span className="text-xs font-semibold text-foreground/80">
                          {format(d, "d")}
                        </span>
                      </div>
                    );
                  })}
                  {zoom === "month" && days.map((d, i) => (
                    <div
                      key={i}
                      className="shrink-0 border-r border-border/30 last:border-r-0 flex items-center justify-center"
                      style={{ width: dayWidths[i], height: 24 }}
                    >
                      <span
                        className={`text-[11px] leading-none ${
                          d.getDay() === 0 || d.getDay() === 6
                            ? "text-muted-foreground/30"
                            : "text-foreground/60"
                        }`}
                      >
                        {format(d, "d")}
                      </span>
                    </div>
                  ))}
                  {zoom === "quarter" &&
                    Array.from({ length: Math.ceil(numDays / 7) }, (_, wi) => {
                      const dayIdx = wi * 7;
                      const d = days[dayIdx];
                      if (!d) return null;
                      const endIdx = Math.min(dayIdx + 7, numDays);
                      const chunkWidth = (dayLefts[endIdx] ?? dayLefts[dayLefts.length - 1] ?? 0)
                                       - (dayLefts[dayIdx] ?? 0);
                      return (
                        <div
                          key={wi}
                          className="shrink-0 border-r border-border/30 last:border-r-0 flex items-center px-1"
                          style={{ width: chunkWidth, height: 24 }}
                        >
                          <span className="text-[11px] text-foreground/60">
                            {format(d, "d")}
                          </span>
                        </div>
                      );
                    })}
                  {zoom === "year" && monthGroups.map((m, i) => (
                    <div
                      key={i}
                      className="shrink-0 border-r border-border/30 last:border-r-0 flex items-center px-1"
                      style={{ width: monthGroupWidths[i], height: 24 }}
                    >
                      <span className="text-[11px] text-foreground/60 truncate">
                        {m.label.split(" ")[0]}
                      </span>
                    </div>
                  ))}
                  {/* Today header marker */}
                  {todayOffset !== null && (
                    <div
                      className="absolute top-0 bottom-0 w-px bg-red-500 z-10 pointer-events-none"
                      style={{ left: todayOffset }}
                    />
                  )}
                </div>
              </div>
            </div>

            {/* ── Employee rows ── */}
            {visibleEmployees.length === 0 && (
              <div className="py-12 text-center text-muted-foreground text-sm">
                No active employees found.
              </div>
            )}

            {visibleEmployees.map((emp: any) => {
              const empId: number = emp.id;
              const empBookings = bookingsByEmployee[empId] ?? [];
              const cap: number = emp.weeklyCapacityHours ?? 40;
              const empMask: number[] = Array.isArray(emp.workingDaysMask)
                ? emp.workingDaysMask
                : [1, 1, 1, 1, 1, 0, 0];
              const dailyCap = getDailyCapacity(cap, empMask);

              const holidayDateSet =
                holidayDateSetByEmployee[empId] ?? new Set<string>();
              const vacationDayMap =
                vacationDayMapByEmployee[empId] ??
                new Map<string, VacationEntry>();

              const baseSegments = filteredSegmentsByEmployee[empId] ?? [];
              const rowHeight = PLANNER_ROW_HEIGHT; // fixed for every row
              const holidayNameByDate = new Map(
                (holidaysByEmployee[empId] ?? []).map((h) => [h.date, h.name] as const),
              );

              return (
                <div
                  key={empId}
                  className="flex border-b border-border group"
                  style={{ minHeight: rowHeight }}
                >
                  {/* Employee info — sticky left */}
                  <div
                    className="sticky left-0 z-10 bg-card border-r border-border shrink-0 flex items-center gap-1 px-3"
                    style={{ width: EMPLOYEE_COL, height: rowHeight }}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-sm font-medium truncate flex-1 min-w-0 cursor-default">
                          {emp.name}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-xs">
                        {cap}h/week · {dailyCap.toFixed(1)}h/day
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 rounded p-0.5 hover:bg-muted"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        side="bottom"
                        className="min-w-[120px]"
                      >
                        <DropdownMenuItem onSelect={() => openCreateModal(emp)}>
                          Booking
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => openCreateVacationModal(emp)}
                        >
                          Absence
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Timeline area */}
                  <div
                    className="relative flex-1"
                    style={{ width: contentWidth, minHeight: rowHeight }}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const offsetX = e.clientX - rect.left;
                      const clampedOffset = pixelToDay(offsetX);
                      const clickedDate = format(
                        addDays(windowStart, clampedOffset),
                        "yyyy-MM-dd",
                      );
                      openCreateVacationModal(emp, clickedDate, clickedDate);
                    }}
                  >
                    {/* Month group grid background */}
                    <div className="flex h-full absolute inset-0">
                      {monthGroups.map((m, i) => (
                        <div
                          key={i}
                          className="shrink-0 border-r border-border/30 last:border-r-0"
                          style={{ width: monthGroupWidths[i], height: "100%" }}
                        />
                      ))}
                    </div>

                    {/* Day-cell timeline: fixed 64px rows, proportional
                        fill, max 2 overlap lanes + "+N" badge, inline absences,
                        "Available" empty rows (see resource-planner-timeline.tsx) */}
                    <PlannerRowCells
                      numDays={numDays}
                      windowStart={windowStart}
                      dayLefts={dayLefts}
                      dayWidths={dayWidths}
                      baseDayWidth={dayWidth}
                      segments={baseSegments}
                      dailyCap={dailyCap}
                      empMask={empMask}
                      empName={emp.name}
                      holidayNameByDate={holidayNameByDate}
                      vacationByDate={vacationDayMap}
                      todayStr={todayStr}
                      bridgeGaps={zoom !== "week"}
                      draggingBookingId={dragGhost?.bookingId ?? null}
                      onBarMouseDown={(e, bookingId) => {
                        const booking = empBookings.find((b) => b.id === bookingId);
                        if (booking) startBookingDrag(e, booking, "move", dayWidth);
                      }}
                      onBarResizeMouseDown={(e, bookingId, edge) => {
                        const booking = empBookings.find((b) => b.id === bookingId);
                        if (booking) startBookingDrag(e, booking, edge, dayWidth);
                      }}
                      onAbsenceClick={(v) => openEditVacationModal(v, emp.name)}
                      onCloseOut={(bookingId) => {
                        const booking = empBookings.find((b) => b.id === bookingId);
                        if (booking) openCloseOutModal(booking);
                      }}
                      getRoleBudget={(roleId) => roleBudgetMap.get(roleId)}
                    />

                    {/* Ghost bar for active drag */}
                    {dragGhost &&
                      empBookings.some(
                        (b) => b.id === dragGhost.bookingId,
                      ) &&
                      (() => {
                        const bounds = getBarBounds(
                          dragGhost.startDate,
                          dragGhost.endDate,
                          windowStart,
                          numDays,
                          dayLefts,
                        );
                        if (!bounds) return null;
                        const dragged = empBookings.find(
                          (b) => b.id === dragGhost.bookingId,
                        )!;
                        const color = resolveProjectColor(
                          dragged.projectId,
                          dragged.projectColor,
                        );
                        return (
                          <div
                            className="absolute pointer-events-none rounded-sm flex items-center px-2"
                            style={{
                              top: 10,
                              height: 44,
                              left: bounds.left,
                              width: bounds.width,
                              backgroundColor: color + "CC",
                              opacity: 0.85,
                              zIndex: 6,
                              userSelect: "none",
                            }}
                          >
                            {bounds.width > 48 && (
                              <span className="text-white text-[11px] font-semibold truncate">
                                {format(
                                  parseISO(dragGhost.startDate),
                                  "MMM d",
                                )}{" "}
                                –{" "}
                                {format(parseISO(dragGhost.endDate), "MMM d")}
                              </span>
                            )}
                          </div>
                        );
                      })()}

                    {/* Today line in row */}
                    {todayOffset !== null && (
                      <div
                        className="absolute top-0 bottom-0 w-px bg-red-500/60 pointer-events-none z-10"
                        style={{ left: todayOffset }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Booking modal */}
        {modal && (
          <BookingModal
            key={
              modal.mode === "edit"
                ? `edit-${(modal as EditModalState).booking.id}`
                : "create"
            }
            state={modal}
            projects={projects as any[]}
            allBookings={bookings}
            employees={activeEmployees}
            onClose={() => setModal(null)}
            onBookingUpdated={handleBookingUpdated}
            initialConfirmRelease={
              modal.mode === "edit"
                ? (modal as EditModalState).openInConfirmRelease
                : false
            }
          />
        )}

        {/* Vacation dialog */}
        {vacationModal && (
          <VacationDialog
            state={vacationModal}
            onClose={() => setVacationModal(null)}
          />
        )}
      </div>
    </AdminLayout>
  );
}
