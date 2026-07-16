/**
 * Resource Planner — day-cell timeline renderer (Step 3 of the redesign).
 *
 * Implements the corrected spec from avatrack-resource-planner-mockup.html and
 * the component library "Resource Planner timeline" section:
 *  - FIXED row height (64px) per employee — never content-driven
 *  - a day with 0 booked hours breaks the segment; consecutive >0h days merge
 *    into one rounded run
 *  - proportional fill (booked ÷ daily capacity) as background layer, role name
 *    overlaid and always readable, "Xh free" when partial, "-Xh" when overbooked
 *  - max 2 concurrent lanes per day; 3rd+ booking → "+N" badge with full
 *    breakdown on hover, row height unchanged
 *  - absences render inline as day cells (neutral gray + icon), same height and
 *    position as booking cells
 *  - employees with no bookings keep full row height with an "Available" label
 *  - bars show ONLY the role name — client/project live in the tooltip
 */
import * as React from "react";
import { addDays, format, getISODay, parseISO } from "date-fns";
import { Clock } from "lucide-react";
import { SharedTooltip, AbsenceCell } from "@/components/shared";

/* ── geometry (all rows identical) ─────────────────────────────────────────── */
export const PLANNER_ROW_HEIGHT = 64;
const CELL_PAD_Y = 10; // solo bar: top 10 / bottom 10 → 44px tall
const SOLO_H = PLANNER_ROW_HEIGHT - CELL_PAD_Y * 2; // 44
const STACK_PAD_Y = 6;
const LANE_GAP = 2;
const LANE_H = (PLANNER_ROW_HEIGHT - STACK_PAD_Y * 2 - LANE_GAP) / 2; // 25
const RUN_INSET_X = 2;

/* ── structural types (match the page's Segment shape) ─────────────────────── */
export interface TimelineSegment {
  bookingId: number;
  startOffset: number;
  endOffset: number;
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
  dailyHours: number[];
}

export interface TimelineVacationBase {
  startDate: string;
  endDate: string;
  vacationType: string;
  note?: string | null;
}

interface DayContribution {
  seg: TimelineSegment;
  hours: number;
}

interface BarRun {
  seg: TimelineSegment;
  startIdx: number;
  endIdx: number; // inclusive
  lanePos: 0 | 1;
  solo: boolean;
  /** Per day of the run; null = weekend bridge day (rendered solid). */
  hours: Array<number | null>;
}

const fmtH = (n: number) => n.toFixed(1).replace(/\.0$/, "");

export interface PlannerRowCellsProps<TVac extends TimelineVacationBase> {
  numDays: number;
  windowStart: Date;
  dayLefts: number[];
  dayWidths: number[];
  baseDayWidth: number;
  /** Segments already filtered by the project filter panel. */
  segments: TimelineSegment[];
  dailyCap: number;
  empMask: number[];
  empName: string;
  holidayNameByDate: Map<string, string>;
  vacationByDate: Map<string, TVac>;
  todayStr: string;
  /** Coarse-zoom continuity (month/quarter/year): booking bars bridge
   *  weekends, and multi-day absences merge into one continuous block
   *  spanning weekends inside their range. Week zoom keeps true day cells. */
  bridgeGaps?: boolean;
  draggingBookingId?: number | null;
  onBarMouseDown: (e: React.MouseEvent, bookingId: number) => void;
  onBarResizeMouseDown: (e: React.MouseEvent, bookingId: number, edge: "resize-start" | "resize-end") => void;
  onAbsenceClick: (vacation: TVac) => void;
  onCloseOut?: (bookingId: number) => void;
  getRoleBudget?: (roleId: number) => {
    plannedDays: number;
    budgetedDays: number | null;
    loggedDays?: number;
    reservedDays?: number;
    stalePlanDays?: number;
  } | undefined;
}

export function PlannerRowCells<TVac extends TimelineVacationBase>({
  numDays,
  windowStart,
  dayLefts,
  dayWidths,
  baseDayWidth,
  segments,
  dailyCap,
  empMask,
  empName,
  holidayNameByDate,
  vacationByDate,
  todayStr,
  bridgeGaps = false,
  draggingBookingId,
  onBarMouseDown,
  onBarResizeMouseDown,
  onAbsenceClick,
  onCloseOut,
  getRoleBudget,
}: PlannerRowCellsProps<TVac>) {
  /* Per-day contributions → lane layout → merged runs */
  const { cells, runs, hasAnyHours } = React.useMemo(() => {
    const cells: Array<{ list: DayContribution[]; overflow: DayContribution[] }> = Array.from(
      { length: numDays },
      () => ({ list: [], overflow: [] }),
    );
    for (const seg of segments) {
      for (let i = 0; i < seg.dailyHours.length; i++) {
        const h = seg.dailyHours[i];
        if (h <= 0) continue;
        const idx = seg.startOffset + i;
        if (idx < 0 || idx >= numDays) continue;
        cells[idx].list.push({ seg, hours: h });
      }
    }
    let hasAnyHours = false;
    for (const cell of cells) {
      if (cell.list.length === 0) continue;
      hasAnyHours = true;
      cell.list.sort(
        (a, b) =>
          a.seg.bookingStartDate.localeCompare(b.seg.bookingStartDate) || a.seg.bookingId - b.seg.bookingId,
      );
      if (cell.list.length > 2) {
        cell.overflow = cell.list.slice(2);
        cell.list = cell.list.slice(0, 2);
      }
    }
    // Merge consecutive days with the same occupant in the same lane position
    // and the same solo/stacked mode into one rounded run. With bridgeGaps,
    // weekends and absence days (vacation/sick/holiday) inside the SAME
    // booking keep the run open — committed only if the booking actually
    // continues afterwards. Weekend bridges render solid (null); absence
    // bridges render as a lightened band (-1).
    const runs: BarRun[] = [];
    type OpenRun = BarRun & { pending: Array<null | -1> };
    const open: Array<OpenRun | null> = [null, null];
    for (let d = 0; d <= numDays; d++) {
      const list = d < numDays ? cells[d].list : [];
      const solo = list.length === 1;
      const isWeekend = d < numDays && getISODay(addDays(windowStart, d)) > 5;
      for (const lanePos of [0, 1] as const) {
        const contrib = list[lanePos];
        const cur = open[lanePos];
        if (
          cur &&
          contrib &&
          cur.seg.bookingId === contrib.seg.bookingId &&
          cur.solo === solo &&
          cur.endIdx + cur.pending.length === d - 1
        ) {
          for (const bridgeVal of cur.pending) cur.hours.push(bridgeVal);
          cur.endIdx = d;
          cur.hours.push(contrib.hours);
          cur.pending = [];
        } else if (cur && !contrib && bridgeGaps && isWeekend && cur.endIdx + cur.pending.length === d - 1) {
          cur.pending.push(null); // tentative weekend bridge
        } else {
          if (cur) {
            cur.pending = []; // uncommitted bridge days are dropped
            runs.push(cur);
          }
          open[lanePos] =
            contrib != null
              ? { seg: contrib.seg, startIdx: d, endIdx: d, lanePos, solo, hours: [contrib.hours], pending: [] }
              : null;
        }
      }
    }
    return { cells, runs, hasAnyHours };
  }, [segments, numDays, bridgeGaps, windowStart]);

  const rightEdge = (idx: number) => dayLefts[idx + 1] ?? (dayLefts[idx] ?? 0) + (dayWidths[idx] ?? baseDayWidth);

  /* ── absence cells — consecutive days of one vacation merge into a single
     continuous block (spanning weekends inside the range when bridgeGaps).
     Holidays stay single-day cells; vacations take priority over holidays. ── */
  interface AbsenceRun {
    startIdx: number;
    endIdx: number;
    vac: TVac | null;
    holidayName: string | null;
  }
  const absenceRuns: AbsenceRun[] = [];
  {
    let openRun: AbsenceRun | null = null;
    for (let d = 0; d < numDays; d++) {
      const day = addDays(windowStart, d);
      const dayStr = format(day, "yyyy-MM-dd");
      const working = !!empMask[getISODay(day) - 1];
      const vac = vacationByDate.get(dayStr);
      const holidayName = working ? holidayNameByDate.get(dayStr) : undefined;

      if (vac && openRun && openRun.vac === vac) {
        if (working || bridgeGaps) {
          openRun.endIdx = d; // same vacation continues (weekends merge at coarse zoom)
          continue;
        }
        absenceRuns.push(openRun); // week view: weekend splits the block
        openRun = null;
        continue;
      }
      if (vac && working) {
        if (openRun) absenceRuns.push(openRun);
        openRun = { startIdx: d, endIdx: d, vac, holidayName: null };
        continue;
      }
      if (openRun) {
        absenceRuns.push(openRun);
        openRun = null;
      }
      if (holidayName) absenceRuns.push({ startIdx: d, endIdx: d, vac: null, holidayName });
    }
    if (openRun) absenceRuns.push(openRun);
  }

  const absenceCells = absenceRuns.map((run) => {
    const left = (dayLefts[run.startIdx] ?? 0) + 1;
    const width = Math.max(rightEdge(run.endIdx) - 1 - left, 2);
    const firstDay = addDays(windowStart, run.startIdx);
    const type = run.holidayName ? "holiday" : (run.vac!.vacationType as string);
    const detail = run.holidayName
      ? `${run.holidayName} · ${format(firstDay, "MMM d, yyyy")}`
      : `${format(parseISO(run.vac!.startDate), "MMM d")} – ${format(parseISO(run.vac!.endDate), "MMM d, yyyy")}${
          run.vac!.note ? ` · ${run.vac!.note}` : ""
        } · Click to edit`;
    return (
      <div
        key={`abs-${run.startIdx}`}
        role={run.vac ? "button" : undefined}
        aria-label={run.vac ? `Edit absence for ${empName}` : (run.holidayName ?? undefined)}
        className="absolute overflow-hidden"
        style={{
          top: CELL_PAD_Y,
          height: SOLO_H,
          left,
          width,
          zIndex: 3,
          cursor: run.vac ? "pointer" : "default",
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (run.vac) onAbsenceClick(run.vac);
        }}
      >
        <AbsenceCell type={type} detail={detail} showLabel={width >= 110} className="rounded-md" />
      </div>
    );
  });

  /* ── booking bar runs ─────────────────────────────────────────────────────── */
  const runNodes = runs.map((run) => {
    const { seg } = run;
    const isDragging = draggingBookingId === seg.bookingId;
    const runLeft = (dayLefts[run.startIdx] ?? 0) + RUN_INSET_X;
    const runWidth = Math.max(rightEdge(run.endIdx) - RUN_INSET_X - runLeft, 2);
    const top = run.solo ? CELL_PAD_Y : STACK_PAD_Y + run.lanePos * (LANE_H + LANE_GAP);
    const height = run.solo ? SOLO_H : LANE_H;
    const tentative = seg.status === "tentative";
    const released = !!seg.pastReleasedAt;
    const label = seg.roleName ?? seg.projectName;
    const realHours = run.hours.filter((h): h is number => h != null && h >= 0);
    const uniformH = realHours.every((h) => h === realHours[0]) ? realHours[0] : null;
    const isBookingStart = run.startIdx === seg.startOffset;
    const isBookingEnd = run.endIdx === seg.endOffset;
    const showCloseOut =
      !!onCloseOut && !isDragging && !released && run.solo && seg.bookingStartDate < todayStr && runWidth > 56;

    /* per-day proportional fill overlays (background layer) */
    const overlays: React.ReactNode[] = [];
    let anyPartial = false;
    let anyOver = false;
    if (dailyCap > 0) {
      for (let d = run.startIdx; d <= run.endIdx; d++) {
        const h = run.hours[d - run.startIdx];
        if (h == null) continue; // weekend bridge day — render solid
        const cellLeft = (dayLefts[d] ?? 0) - runLeft;
        const cellW = rightEdge(d) - (dayLefts[d] ?? 0);
        const pct = h / dailyCap;
        if (pct < 1) {
          anyPartial = true;
          // free portion — lightened right part of the day cell
          overlays.push(
            <div
              key={`f-${d}`}
              className="pointer-events-none absolute"
              style={{
                top: 0,
                bottom: 0,
                left: cellLeft + cellW * pct,
                width: cellW * (1 - pct),
                background: "rgba(255,255,255,0.45)",
                // per-day divider only at wider zooms — turns into visual
                // noise below ~24px/day
                borderLeft: cellW >= 24 && cellW * pct > 3 ? "1px dashed rgba(255,255,255,0.8)" : undefined,
              }}
            />,
          );
        } else if (pct > 1) {
          anyOver = true;
          // overbooked day — red strip along the bottom of that day
          overlays.push(
            <div
              key={`o-${d}`}
              className="pointer-events-none absolute"
              style={{ bottom: 0, height: 3, left: cellLeft, width: cellW, background: "#C0392B" }}
            />,
          );
        }
      }
    }

    /* one status chip per run, right-aligned (mockup style) — never per day */
    const lastH = realHours[realHours.length - 1] ?? 0;
    let chip: { text: string; bg: string } | null = null;
    if (dailyCap > 0 && run.solo) {
      if (anyOver) {
        const worst = Math.max(...realHours) - dailyCap;
        chip = { text: `-${fmtH(worst)}h`, bg: "#C0392B" };
      } else if (anyPartial && runWidth >= 90) {
        chip = { text: `${fmtH(dailyCap - lastH)}h free`, bg: "rgba(0,0,0,0.22)" };
      }
    }
    const showChip = chip != null && runWidth >= 40;

    const budget = seg.projectRoleId != null ? getRoleBudget?.(seg.projectRoleId) : undefined;
    const tooltip = (
      <div className="space-y-0.5">
        <div className="font-semibold">{seg.roleName ?? "No role"}</div>
        <div className="text-white/80">
          {seg.projectName}
          {seg.clientName ? ` · ${seg.clientName}` : ""}
        </div>
        <div className="text-white/80">
          {format(parseISO(seg.bookingStartDate), "MMM d")} – {format(parseISO(seg.bookingEndDate), "MMM d, yyyy")}
        </div>
        <div className="text-white/80">
          {uniformH != null ? `${fmtH(uniformH)}h/day` : "varies per day"}
          {seg.dayRate ? ` · €${seg.dayRate.toLocaleString("de-DE")}/day` : ""}
        </div>
        {tentative && <div className="font-medium text-white/90">Tentative</div>}
        {released && (
          <div className="flex items-center gap-1 text-white/90">
            <Clock className="size-3" /> Past plan released
          </div>
        )}
        {seg.notes && <div className="italic text-white/70">{seg.notes}</div>}
        {budget && budget.budgetedDays != null && (() => {
          // consumption per the identity: Logged + Re-plannable (stale excluded)
          const used = (budget.loggedDays ?? 0) + (budget.reservedDays ?? 0);
          const over = used > budget.budgetedDays!;
          return (
            <>
              <div className={over ? "font-semibold text-red-300" : "text-emerald-300"}>
                {over ? "⚠ Over budget: " : "Budget: "}
                {used.toFixed(1)} / {budget.budgetedDays}d used
              </div>
              {(budget.stalePlanDays ?? 0) > 0.05 && (
                <div className="text-amber-300">
                  ⚠ {(budget.stalePlanDays ?? 0).toFixed(1)}d stale plan — release or re-plan
                </div>
              )}
            </>
          );
        })()}
      </div>
    );

    const bar = (
      <div
        className="group/run absolute overflow-hidden select-none"
        style={{
          top,
          height,
          left: runLeft,
          width: runWidth,
          borderRadius: run.solo ? 6 : 4,
          background: tentative ? `${seg.color}99` : seg.color,
          border: tentative ? "1.5px dashed rgba(255,255,255,0.85)" : undefined,
          opacity: isDragging ? 0.35 : released ? 0.55 : 1,
          cursor: isDragging ? "grabbing" : "grab",
          zIndex: isDragging ? 5 : 4,
        }}
        onMouseDown={(e) => onBarMouseDown(e, seg.bookingId)}
        onClick={(e) => e.stopPropagation()}
      >
        {overlays}
        {runWidth > 24 && (
          <span
            className="pointer-events-none absolute inset-y-0 flex items-center truncate font-medium text-white"
            style={{
              left: run.solo ? 8 : 5,
              right: showChip ? (chip!.text.length > 4 ? 52 : 30) : 4,
              fontSize: run.solo ? 12 : 9.5,
              textShadow: "0 1px 2px rgba(0,0,0,0.25)",
            }}
          >
            {label}
            {!run.solo && uniformH != null && runWidth > 56 ? ` · ${fmtH(uniformH)}h` : ""}
          </span>
        )}
        {showChip && (
          <span
            className="pointer-events-none absolute rounded-[3px] px-1 text-[10px] font-medium leading-[14px] text-white"
            style={{ right: 4, top: "50%", transform: "translateY(-50%)", background: chip!.bg }}
          >
            {chip!.text}
          </span>
        )}
        {showCloseOut && (
          <button
            type="button"
            aria-label="Close out past days"
            className="absolute right-1 top-1 z-10 hidden rounded bg-black/25 p-0.5 text-white hover:bg-black/40 group-hover/run:block"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onCloseOut?.(seg.bookingId);
            }}
          >
            <Clock className="size-3" />
          </button>
        )}
        {isBookingStart && runWidth > 20 && (
          <div
            className="absolute left-0 top-0 h-full"
            style={{ width: 6, cursor: "ew-resize", zIndex: 6 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              onBarResizeMouseDown(e, seg.bookingId, "resize-start");
            }}
          />
        )}
        {isBookingEnd && runWidth > 20 && (
          <div
            className="absolute right-0 top-0 h-full"
            style={{ width: 6, cursor: "ew-resize", zIndex: 6 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              onBarResizeMouseDown(e, seg.bookingId, "resize-end");
            }}
          />
        )}
      </div>
    );

    const key = `run-${seg.bookingId}-${run.startIdx}-${run.lanePos}`;
    if (isDragging) return <React.Fragment key={key}>{bar}</React.Fragment>;
    return (
      <SharedTooltip key={key} content={tooltip}>
        {bar}
      </SharedTooltip>
    );
  });

  /* ── "+N" overflow badges (3rd+ concurrent booking, row height unchanged) ── */
  const overflowBadges: React.ReactNode[] = [];
  for (let d = 0; d < numDays; d++) {
    const overflow = cells[d].overflow;
    if (!overflow.length) continue;
    const width = dayWidths[d] ?? baseDayWidth;
    overflowBadges.push(
      <SharedTooltip
        key={`ovf-${d}`}
        content={
          <div className="space-y-0.5">
            <div className="font-semibold">{format(addDays(windowStart, d), "EEE, MMM d")}</div>
            {[...cells[d].list, ...overflow].map((c, i) => (
              <div key={i} className="text-white/85">
                {c.seg.roleName ?? c.seg.projectName} · {fmtH(c.hours)}h — {c.seg.projectName}
              </div>
            ))}
          </div>
        }
      >
        <div
          className="absolute flex items-center justify-center rounded-full font-semibold text-white"
          style={{
            top: 3,
            left: (dayLefts[d] ?? 0) + width - (width >= 26 ? 22 : 16),
            minWidth: width >= 26 ? 19 : 14,
            height: width >= 26 ? 13 : 11,
            padding: "0 4px",
            fontSize: 9,
            background: "#002F47",
            zIndex: 7,
            cursor: "default",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          +{overflow.length}
        </div>
      </SharedTooltip>,
    );
  }

  return (
    <>
      {absenceCells}
      {runNodes}
      {overflowBadges}
      {!hasAnyHours && (
        <div className="pointer-events-none absolute inset-0 flex items-center px-4">
          <span className="select-none text-[13px] text-muted-foreground/60">Available</span>
        </div>
      )}
    </>
  );
}
