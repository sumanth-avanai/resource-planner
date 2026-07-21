/**
 * TeamTimesheetView — PM-grouped roster for the Timesheet panel.
 *
 * Renders each Project Manager once in a single tall (rowSpan) cell, with that
 * PM's team members listed in rows beside it — "PM in a column within one large
 * cell, employees next to him in rows" — for readability. PM→team membership is
 * derived (many-to-many) and delivered as `pmNames` on each employee by the API.
 * Per employee it shows weekly capacity (in days) and hours logged this week.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useListEmployees, getListEmployeesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import { startOfWeek, endOfWeek, addWeeks, subWeeks, format } from "date-fns";
import { cn } from "@/lib/utils";

const HOURS_PER_DAY = 8;
const UNASSIGNED = "Unassigned";

type EmployeeRow = { id: number; name: string; weeklyCapacityHours: number; pmNames?: string[] };
interface WeekEntry { employeeId: number; hours: number }

const fmtNum = (n: number) => (n % 1 === 0 ? String(n) : n.toFixed(1));

export function TeamTimesheetView() {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
  const from = format(weekStart, "yyyy-MM-dd");
  const to = format(weekEnd, "yyyy-MM-dd");

  const { data: employees = [] } = useListEmployees(
    { includeInactive: false },
    { query: { queryKey: getListEmployeesQueryKey({ includeInactive: false }) } },
  );

  const { data: entries = [] } = useQuery<WeekEntry[]>({
    queryKey: ["team-timesheet-week", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/time-entries?startDate=${from}&endDate=${to}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const hoursByEmp = useMemo(() => {
    const m = new Map<number, number>();
    for (const e of entries) m.set(e.employeeId, (m.get(e.employeeId) ?? 0) + (e.hours ?? 0));
    return m;
  }, [entries]);

  const groups = useMemo(() => {
    const list = employees as unknown as EmployeeRow[];
    const byPm = new Map<string, EmployeeRow[]>();
    for (const e of list) {
      const pms = e.pmNames && e.pmNames.length ? e.pmNames : [UNASSIGNED];
      for (const pm of pms) {
        if (!byPm.has(pm)) byPm.set(pm, []);
        byPm.get(pm)!.push(e);
      }
    }
    return Array.from(byPm.keys())
      .sort((a, b) => (a === UNASSIGNED ? 1 : b === UNASSIGNED ? -1 : a.localeCompare(b)))
      .map((pm) => ({ pm, members: byPm.get(pm)!.slice().sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [employees]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
          <span className="text-sm font-medium text-foreground">Team overview — grouped by PM</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => subWeeks(w, 1))} aria-label="Previous week">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[150px] text-center">
            {format(weekStart, "dd MMM")} – {format(weekEnd, "dd MMM yyyy")}
          </span>
          <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addWeeks(w, 1))} aria-label="Next week">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}>
            This week
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium w-[190px]">PM / Team</th>
              <th className="px-3 py-2 font-medium">Employee</th>
              <th className="px-3 py-2 font-medium text-right w-[120px]">Capacity</th>
              <th className="px-3 py-2 font-medium text-right w-[130px]">Logged (wk)</th>
              <th className="px-3 py-2 font-medium w-[180px]">Utilization</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">No employees.</td></tr>
            )}
            {groups.map((g) =>
              g.members.map((emp, idx) => {
                const logged = hoursByEmp.get(emp.id) ?? 0;
                const cap = emp.weeklyCapacityHours || 0;
                const pct = cap > 0 ? Math.min(100, Math.round((logged / cap) * 100)) : 0;
                const capDays = cap / HOURS_PER_DAY;
                return (
                  <tr key={`${g.pm}-${emp.id}`} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                    {idx === 0 && (
                      <td
                        rowSpan={g.members.length}
                        className="px-3 py-2 align-middle border-r border-border bg-muted/20"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className={cn("font-semibold", g.pm === UNASSIGNED ? "text-muted-foreground" : "text-foreground")}>
                            {g.pm}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {g.members.length} {g.members.length === 1 ? "person" : "people"}
                          </span>
                        </div>
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <Link href={`/employees/${emp.id}`} className="text-foreground hover:text-brand hover:underline">
                        {emp.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{fmtNum(capDays)} d/wk</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(logged)} h</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn("h-full rounded-full", pct >= 90 ? "bg-status-danger" : pct >= 70 ? "bg-status-warning" : "bg-brand")}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground w-9 text-right tabular-nums">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              }),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
