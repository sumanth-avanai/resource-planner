import { useState, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetProjectStatusDetail, getGetProjectStatusDetailQueryKey } from "@workspace/api-client-react";
import type { FutureBooking, ProjectHealthUpdate } from "@workspace/api-client-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Activity,
  Plus,
  ExternalLink,
  Clock,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckSquare,
  Square,
  Trash2,
  CalendarDays,
  DollarSign,
  Shield,
  ShieldAlert,
  Smile,
  Meh,
  Frown,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNowStrict, isPast } from "date-fns";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface NextStep {
  id: string;
  text: string;
  done: boolean;
}

interface ProjectDetail {
  id: number;
  name: string;
  color: string | null;
  clientId: number;
  clientName: string | null;
  pmName: string | null;
  startDate: string | null;
  endDate: string | null;
  generalStatus: string | null;
  riskLevel: string | null;
  clientSatisfaction: string | null;
  nextSteps: NextStep[] | null;
  budgetTotal: number | null;
  loggedTotal: number | null;
  invoicedTotal: number | null;
  trendDirection: "up" | "down" | "stable" | null;
  nextUpdateDue: string | null;
  updateOverdue: boolean;
  lastCommentAt: string | null;
  budgetAlert: boolean;
}

interface HealthUpdate {
  id: number;
  projectId: number;
  generalStatus: string;
  budgetStatus: string | null;
  riskLevel: string;
  clientSatisfaction: string | null;
  comment: string | null;
  createdAt: string;
}

interface MonthlyDataPoint {
  month: string;
  loggedRevenue: number;
  invoicedRevenue: number;
}

interface FutureProjection {
  month: string;
  plannedRevenue: number;
}

// ─── Client-side projection from raw bookings ─────────────────────────────────

function computeFutureProjections(bookings: FutureBooking[], today: Date): FutureProjection[] {
  const monthMap = new Map<string, number>();
  const todayTime = today.getTime();
  for (const b of bookings) {
    if (!b.dayRate) continue;
    const startMs = Math.max(new Date(b.startDate + "T00:00:00Z").getTime(), todayTime);
    const endDate = new Date(b.endDate + "T00:00:00Z");
    for (let ms = startMs; ms <= endDate.getTime(); ms += 86_400_000) {
      const d = new Date(ms);
      const dow = d.getUTCDay(); // 0=Sun … 6=Sat
      if (dow === 0 || dow === 6) continue;
      const month = d.toISOString().slice(0, 7);
      const weekdayHours = b.weekdayHours as Record<string, number> | null;
      const dailyHours = weekdayHours?.[String(dow)] ?? b.hoursPerDay;
      const dailyRev = (dailyHours / 8) * b.dayRate;
      monthMap.set(month, (monthMap.get(month) ?? 0) + dailyRev);
    }
  }
  return Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, plannedRevenue]) => ({ month, plannedRevenue: Math.round(plannedRevenue * 100) / 100 }));
}

// ─── Label / option maps ──────────────────────────────────────────────────────

const GENERAL_STATUS_OPTIONS = [
  { value: "planned",     label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "on_hold",     label: "On Hold" },
  { value: "completed",   label: "Completed" },
  { value: "cancelled",   label: "Cancelled" },
];

const BUDGET_STATUS_LABELS: Record<string, string> = {
  on_track:    "On Track",
  at_risk:     "At Risk",
  over_budget: "Over Budget",
  completed:   "Completed",
};

const RISK_LEVEL_OPTIONS = [
  { value: "low",    label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high",   label: "High" },
];

const CLIENT_SATISFACTION_OPTIONS = [
  { value: "happy",    label: "Happy" },
  { value: "neutral",  label: "Neutral" },
  { value: "critical", label: "Critical" },
];

const GENERAL_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  GENERAL_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);
const RISK_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  RISK_LEVEL_OPTIONS.map((o) => [o.value, o.label]),
);
const CLIENT_SATISFACTION_LABELS: Record<string, string> = Object.fromEntries(
  CLIENT_SATISFACTION_OPTIONS.map((o) => [o.value, o.label]),
);

// ─── Badge helpers ────────────────────────────────────────────────────────────

function generalStatusCls(s: string | null) {
  switch (s) {
    case "planned":     return "bg-blue-500/15 text-blue-400 border-blue-500/25";
    case "in_progress": return "bg-green-500/15 text-green-400 border-green-500/25";
    case "on_hold":     return "bg-yellow-500/15 text-yellow-400 border-yellow-500/25";
    case "completed":
    case "cancelled":   return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    default:            return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function budgetStatusCls(s: string | null) {
  switch (s) {
    case "on_track":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "at_risk":     return "bg-yellow-500/15 text-yellow-400 border-yellow-500/25";
    case "over_budget": return "bg-red-500/15 text-red-400 border-red-500/25";
    case "completed":   return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    default:            return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function riskLevelCls(s: string | null) {
  switch (s) {
    case "low":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "medium": return "bg-orange-500/15 text-orange-400 border-orange-500/25";
    case "high":   return "bg-red-500/15 text-red-400 border-red-500/25";
    default:       return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function clientSatisfactionCls(s: string | null) {
  switch (s) {
    case "happy":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "neutral":  return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    case "critical": return "bg-red-500/15 text-red-400 border-red-500/25";
    default:         return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function StatusBadge({
  value,
  labels,
  cls,
  size = "sm",
}: {
  value: string | null;
  labels: Record<string, string>;
  cls: (v: string | null) => string;
  size?: "sm" | "lg";
}) {
  if (!value) return <span className="text-muted-foreground/40 text-xs">—</span>;
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border font-medium",
      size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs",
      cls(value),
    )}>
      {labels[value] ?? value}
    </span>
  );
}

// ─── Trend arrow ──────────────────────────────────────────────────────────────

function TrendArrow({ direction }: { direction: "up" | "down" | "stable" | null }) {
  if (!direction) return null;
  if (direction === "up")
    return <TrendingUp className="h-4 w-4 text-red-400 shrink-0" strokeWidth={2} />;
  if (direction === "down")
    return <TrendingDown className="h-4 w-4 text-green-400 shrink-0" strokeWidth={2} />;
  return <Minus className="h-4 w-4 text-muted-foreground/60 shrink-0" strokeWidth={2} />;
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

const PALETTE = [
  "#8B5CF6","#06B6D4","#10B981","#F59E0B",
  "#EF4444","#3B82F6","#EC4899","#F97316",
];
function resolveColor(color: string | null | undefined, id: number): string {
  return color ?? PALETTE[id % PALETTE.length];
}

function fmtEur(n: number): string {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `€${Math.round(n / 1_000)}k`;
  return `€${Math.round(n)}`;
}

// ─── KPI cards ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  accent?: "red" | "amber" | "green";
}) {
  const valueCls =
    accent === "red" ? "text-red-400" :
    accent === "amber" ? "text-amber-400" :
    accent === "green" ? "text-green-400" : "text-foreground";
  return (
    <div className="rounded-xl border border-white/8 bg-white/2 p-4 flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground/50 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
        <p className={cn("text-lg font-semibold truncate", valueCls)}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground/60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Budget breakdown ─────────────────────────────────────────────────────────

function BudgetBreakdown({
  budgetTotal,
  loggedTotal,
  invoicedTotal,
  budgetAlert,
}: {
  budgetTotal: number | null;
  loggedTotal: number | null;
  invoicedTotal: number | null;
  budgetAlert: boolean;
}) {
  if (!budgetTotal || budgetTotal <= 0) {
    return (
      <p className="text-sm text-muted-foreground/60 py-4 text-center">
        No budget configured — add budgeted days to project roles to enable tracking.
      </p>
    );
  }

  const logged   = loggedTotal   ?? 0;
  const invoiced = invoicedTotal ?? 0;
  const invest   = 0; // invest hours contribute to logged but not invoiced
  const unbilled = Math.max(0, logged - invoiced);
  const remaining = Math.max(0, budgetTotal - logged);

  const pctLogged   = Math.min(100, (logged   / budgetTotal) * 100);
  const pctInvoiced = Math.min(pctLogged, (invoiced / budgetTotal) * 100);

  const pctColor = pctLogged >= 100 ? "text-red-400" : pctLogged >= 90 ? "text-amber-400" : "text-green-400";

  return (
    <div className="space-y-4">
      {/* Segmented bar */}
      <div className="relative">
        <div className="h-3 bg-white/6 rounded-full overflow-hidden flex">
          {/* Invoiced portion (bright) */}
          <div
            className="h-full bg-violet-500 transition-all"
            style={{ width: `${pctInvoiced}%` }}
          />
          {/* Logged-but-not-invoiced (muted) */}
          <div
            className="h-full bg-violet-500/30 transition-all"
            style={{ width: `${Math.max(0, pctLogged - pctInvoiced)}%` }}
          />
          {/* Remaining is transparent */}
        </div>
        {/* 90% alert marker */}
        <div
          className="absolute top-0 bottom-0 w-px bg-white/30"
          style={{ left: "90%" }}
          title="90% budget threshold"
        />
      </div>

      {/* Alert */}
      {budgetAlert && (
        <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Budget is at or above 90% consumed
        </div>
      )}

      {/* 3-column grid */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Invoiced",         value: invoiced,  pct: (invoiced  / budgetTotal) * 100, color: "text-violet-400" },
          { label: "Logged (unbilled)", value: unbilled,  pct: (unbilled  / budgetTotal) * 100, color: unbilled > 0 ? "text-amber-400" : "text-muted-foreground" },
          { label: "Remaining",         value: remaining, pct: (remaining / budgetTotal) * 100, color: "text-muted-foreground" },
        ].map(({ label, value, pct, color }) => (
          <div key={label} className="rounded-lg bg-white/3 border border-white/6 p-3">
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className={cn("text-base font-semibold tabular-nums", color)}>{fmtEur(value)}</p>
            <p className="text-xs text-muted-foreground/50">{Math.round(pct)}%</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Burn-up chart ────────────────────────────────────────────────────────────

interface ChartPoint {
  month: string;
  logged?: number;
  invoiced?: number;
  planned?: number;
  isFuture?: boolean;
}

function BurnUpChart({
  monthlyData,
  futureProjections,
  budgetTotal,
}: {
  monthlyData: MonthlyDataPoint[];
  futureProjections: FutureProjection[];
  budgetTotal: number | null;
}) {
  if (monthlyData.length === 0 && futureProjections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground/60 py-8 text-center">
        No time entries yet — chart will populate once hours are logged with rates.
      </p>
    );
  }

  // Build cumulative series
  const todayMonthStr = new Date().toISOString().slice(0, 7);

  // Compute cumulative logged + invoiced from historical data
  let cumLogged = 0;
  let cumInvoiced = 0;
  const histPoints: ChartPoint[] = monthlyData.map((d) => {
    cumLogged   += d.loggedRevenue;
    cumInvoiced += d.invoicedRevenue;
    return {
      month:   d.month,
      logged:  Math.round(cumLogged),
      invoiced: Math.round(cumInvoiced),
      isFuture: false,
    };
  });

  // Future projections — cumulative from current logged level
  let cumPlanned = cumLogged;
  const futurePoints: ChartPoint[] = futureProjections.map((d) => {
    cumPlanned += d.plannedRevenue;
    return {
      month:   d.month,
      planned: Math.round(cumPlanned),
      isFuture: true,
    };
  });

  // Merge: if last historical month === first future month, merge the point
  let allPoints: ChartPoint[] = [...histPoints];
  if (futurePoints.length > 0) {
    // Add a bridge point at today
    const lastHist = histPoints[histPoints.length - 1];
    if (lastHist) {
      allPoints.push({ month: todayMonthStr, logged: lastHist.logged, invoiced: lastHist.invoiced, planned: lastHist.logged, isFuture: false });
    }
    allPoints = allPoints.concat(futurePoints);
  }

  const months = allPoints.map((p) => p.month);
  const todayIdx = months.indexOf(todayMonthStr);

  const fmt = (v: number | undefined) => v !== undefined ? fmtEur(v) : "";

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={allPoints} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="glInvoiced" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#8B5CF6" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="glLogged" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#06B6D4" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#06B6D4" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="glPlanned" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#64748B" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#64748B" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="month"
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => fmtEur(v as number)}
          width={52}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: 12,
            color: "hsl(var(--foreground))",
          }}
          formatter={(value, name) => [fmt(value as number), name]}
          labelStyle={{ color: "hsl(var(--muted-foreground))", marginBottom: 4 }}
        />
        {/* Today reference line */}
        {todayIdx >= 0 && (
          <ReferenceLine
            x={todayMonthStr}
            stroke="hsl(var(--muted-foreground))"
            strokeDasharray="4 2"
            strokeOpacity={0.4}
            label={{ value: "Today", position: "top", fill: "hsl(var(--muted-foreground))", fontSize: 9 }}
          />
        )}
        {/* Budget ceiling reference */}
        {budgetTotal && budgetTotal > 0 && (
          <ReferenceLine
            y={budgetTotal}
            stroke="#EF4444"
            strokeDasharray="4 2"
            strokeOpacity={0.5}
            label={{ value: "Budget", position: "right", fill: "#EF4444", fontSize: 9 }}
          />
        )}
        {futurePoints.length > 0 && (
          <Area
            type="monotone"
            dataKey="planned"
            name="Planned"
            stroke="#64748B"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            fill="url(#glPlanned)"
            dot={false}
            connectNulls
          />
        )}
        <Area
          type="monotone"
          dataKey="logged"
          name="Logged"
          stroke="#06B6D4"
          strokeWidth={1.5}
          fill="url(#glLogged)"
          dot={false}
          connectNulls
        />
        <Area
          type="monotone"
          dataKey="invoiced"
          name="Invoiced"
          stroke="#8B5CF6"
          strokeWidth={1.5}
          fill="url(#glInvoiced)"
          dot={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Next steps checklist ─────────────────────────────────────────────────────

function NextStepsChecklist({
  projectId,
  initialSteps,
  onSaved,
}: {
  projectId: number;
  initialSteps: NextStep[] | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [steps, setSteps] = useState<NextStep[]>(initialSteps ?? []);
  const [newText, setNewText] = useState("");
  const [dirty, setDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const saveMutation = useMutation({
    mutationFn: async (nextSteps: NextStep[]) => {
      const res = await fetch(`/api/project-status/${projectId}/next-steps`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ nextSteps }),
      });
      if (!res.ok) throw new Error("Failed to save");
    },
    onSuccess: () => {
      setDirty(false);
      onSaved();
      toast({ title: "Next steps saved" });
    },
    onError: () => toast({ title: "Failed to save next steps", variant: "destructive" }),
  });

  function mutateSteps(next: NextStep[]) {
    setSteps(next);
    setDirty(true);
  }

  function toggleDone(id: string) {
    mutateSteps(steps.map((s) => s.id === id ? { ...s, done: !s.done } : s));
  }

  function removeStep(id: string) {
    mutateSteps(steps.filter((s) => s.id !== id));
  }

  function addStep() {
    const text = newText.trim();
    if (!text) return;
    mutateSteps([...steps, { id: crypto.randomUUID(), text, done: false }]);
    setNewText("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); addStep(); }
  }

  const done  = steps.filter((s) =>  s.done).length;
  const total = steps.length;

  return (
    <div>
      {total > 0 && (
        <p className="text-xs text-muted-foreground mb-3">
          {done}/{total} done
        </p>
      )}

      <div className="space-y-1 mb-3">
        {steps.map((step) => (
          <div
            key={step.id}
            className={cn(
              "group flex items-center gap-2 rounded-lg px-3 py-2 transition-colors",
              step.done ? "bg-white/2" : "bg-white/3 hover:bg-white/5",
            )}
          >
            <button
              type="button"
              onClick={() => toggleDone(step.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              {step.done
                ? <CheckSquare className="h-4 w-4 text-violet-400" />
                : <Square className="h-4 w-4" />
              }
            </button>
            <span className={cn("flex-1 text-sm", step.done && "line-through text-muted-foreground/50")}>
              {step.text}
            </span>
            <button
              type="button"
              onClick={() => removeStep(step.id)}
              className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {steps.length === 0 && (
          <p className="text-sm text-muted-foreground/60 py-2 pl-1">
            No next steps yet — add one below.
          </p>
        )}
      </div>

      {/* Add row */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          placeholder="Add a next step…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 h-8 text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={addStep}
          disabled={!newText.trim()}
          className="h-8 px-3"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {dirty && (
        <div className="flex justify-end mt-3">
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(steps)}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── History entry ────────────────────────────────────────────────────────────

function RiskChip({ riskLevel }: { riskLevel: string }) {
  const cls =
    riskLevel === "high"   ? "bg-red-500/20 text-red-400 ring-red-500/30" :
    riskLevel === "medium" ? "bg-orange-500/20 text-orange-400 ring-orange-500/30" :
                             "bg-green-500/20 text-green-400 ring-green-500/30";
  const Icon = riskLevel === "high" ? ShieldAlert : Shield;
  return (
    <span className={cn("inline-flex items-center justify-center h-6 w-6 rounded-full ring-1 shrink-0", cls)}
      title={`Risk: ${RISK_LEVEL_LABELS[riskLevel] ?? riskLevel}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function SatisfactionChip({ satisfaction }: { satisfaction: string }) {
  const cls =
    satisfaction === "happy"    ? "bg-green-500/20 text-green-400 ring-green-500/30" :
    satisfaction === "critical" ? "bg-red-500/20 text-red-400 ring-red-500/30" :
                                  "bg-gray-500/20 text-gray-400 ring-gray-500/30";
  const Icon =
    satisfaction === "happy"    ? Smile :
    satisfaction === "critical" ? Frown  : Meh;
  return (
    <span className={cn("inline-flex items-center justify-center h-6 w-6 rounded-full ring-1 shrink-0", cls)}
      title={`Satisfaction: ${CLIENT_SATISFACTION_LABELS[satisfaction] ?? satisfaction}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function HistoryEntry({ entry, isFirst }: { entry: ProjectHealthUpdate; isFirst: boolean }) {
  return (
    <div className="flex gap-3">
      {/* Timeline spine */}
      <div className="flex flex-col items-center pt-1 shrink-0">
        <div className={cn(
          "h-2.5 w-2.5 rounded-full shrink-0 ring-2 ring-background",
          isFirst ? "bg-violet-400" : "bg-white/20",
        )} />
        <div className="w-px flex-1 bg-white/8 mt-1" />
      </div>

      {/* Two-column content */}
      <div className="pb-6 min-w-0 flex-1 grid grid-cols-[110px_1fr] gap-4">
        {/* Left col: date + status plain text + icon chips */}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground/60 mb-1.5 whitespace-nowrap">
            {format(new Date(entry.createdAt), "dd MMM yyyy")}
          </p>
          <p className="text-sm font-medium mb-2 truncate">
            {GENERAL_STATUS_LABELS[entry.generalStatus] ?? entry.generalStatus}
          </p>
          <div className="flex items-center gap-1.5">
            <RiskChip riskLevel={entry.riskLevel} />
            {entry.clientSatisfaction && (
              <SatisfactionChip satisfaction={entry.clientSatisfaction} />
            )}
          </div>
        </div>

        {/* Right col: comment */}
        <div className="pt-5 min-w-0">
          {entry.comment ? (
            <p className="text-sm text-foreground/80 whitespace-pre-wrap">
              {entry.comment}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/40 italic">No comment</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add Update Dialog ────────────────────────────────────────────────────────

interface AddUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  defaults: { generalStatus: string; riskLevel: string; clientSatisfaction: string };
  onSuccess: () => void;
}

function AddUpdateDialog({ open, onClose, projectId, defaults, onSuccess }: AddUpdateDialogProps) {
  const { toast } = useToast();
  const [generalStatus,      setGeneralStatus]      = useState(defaults.generalStatus);
  const [riskLevel,          setRiskLevel]          = useState(defaults.riskLevel);
  const [clientSatisfaction, setClientSatisfaction] = useState(defaults.clientSatisfaction);
  const [comment,            setComment]            = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/project-status/${projectId}/health-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          generalStatus,
          riskLevel,
          clientSatisfaction: clientSatisfaction && clientSatisfaction !== "__none__" ? clientSatisfaction : undefined,
          comment: comment || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status update saved" });
      setComment("");
      onSuccess();
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  function handleOpenChange(v: boolean) { if (!v) onClose(); }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Status Update</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">General Status</Label>
            <Select value={generalStatus} onValueChange={setGeneralStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GENERAL_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Risk Level</Label>
            <Select value={riskLevel} onValueChange={setRiskLevel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RISK_LEVEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Client Satisfaction <span className="text-muted-foreground/50">(optional)</span></Label>
            <Select value={clientSatisfaction} onValueChange={setClientSatisfaction}>
              <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not set</SelectItem>
                {CLIENT_SATISFACTION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Comment <span className="text-muted-foreground/50">(optional)</span></Label>
            <Textarea
              rows={3}
              placeholder="Any notes about the current status…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectStatusDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const projectId = Number(id);

  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, isError } = useGetProjectStatusDetail(projectId, {
    query: { queryKey: getGetProjectStatusDetailQueryKey(projectId), enabled: !isNaN(projectId) },
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetProjectStatusDetailQueryKey(projectId) });
    queryClient.invalidateQueries({ queryKey: ["project-status"] });
  }

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading…</div>
      </AdminLayout>
    );
  }

  if (isError || !data) {
    return (
      <AdminLayout>
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <p className="text-muted-foreground text-sm">Project not found.</p>
          <Button variant="outline" size="sm" onClick={() => navigate("/project-status")}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to overview
          </Button>
        </div>
      </AdminLayout>
    );
  }

  const { project, history, monthlyData, futureBookings } = data;
  const futureProjections = computeFutureProjections(futureBookings ?? [], new Date());
  const latestEntry = history[0] ?? null;
  const dot = resolveColor(project.color, project.id);

  const dialogDefaults = {
    generalStatus:      project.generalStatus      ?? "in_progress",
    riskLevel:          project.riskLevel          ?? "low",
    clientSatisfaction: project.clientSatisfaction ?? "__none__",
  };

  // KPI: Runtime
  const runtimeLabel = (() => {
    if (!project.startDate) return "Not set";
    const start = format(new Date(project.startDate), "MMM yyyy");
    if (!project.endDate) return `${start} – ongoing`;
    return `${start} – ${format(new Date(project.endDate), "MMM yyyy")}`;
  })();

  // KPI: Next update due
  const nextDueDate = project.nextUpdateDue ? new Date(project.nextUpdateDue) : null;
  const msUntilDue = nextDueDate ? nextDueDate.getTime() - Date.now() : null;
  const nearDue = msUntilDue !== null && msUntilDue > 0 && msUntilDue <= 3 * 24 * 60 * 60 * 1000;
  const nextDueLabel = nextDueDate
    ? (isPast(nextDueDate) ? `${format(nextDueDate, "dd MMM")} (overdue)` : format(nextDueDate, "dd MMM yyyy"))
    : "No updates yet";
  const nextDueSub = nextDueDate
    ? (project.updateOverdue ? "Overdue" : nearDue ? "Due soon" : formatDistanceToNowStrict(nextDueDate, { addSuffix: true }))
    : undefined;

  // KPI: Last comment
  const lastCommentLabel = project.lastCommentAt
    ? format(new Date(project.lastCommentAt), "dd MMM yyyy")
    : "No comments yet";
  const lastCommentSub = project.lastCommentAt
    ? formatDistanceToNowStrict(new Date(project.lastCommentAt), { addSuffix: true })
    : undefined;

  return (
    <AdminLayout>
      {/* Back */}
      <button
        onClick={() => navigate("/project-status")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-5"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        Project Status
      </button>

      {/* Project header */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span
              className="h-3.5 w-3.5 rounded-full ring-1 ring-white/10 shrink-0"
              style={{ background: dot }}
            />
            <h1 className="text-xl font-semibold">{project.name}</h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap pl-6">
            {project.clientName && <span>{project.clientName}</span>}
            {project.clientName && project.pmName && <span className="text-white/15">·</span>}
            {project.pmName && <span>PM: {project.pmName}</span>}
            {project.startDate && (
              <>
                <span className="text-white/15">·</span>
                <span>
                  {format(new Date(project.startDate), "MMM yyyy")}
                  {project.endDate && ` – ${format(new Date(project.endDate), "MMM yyyy")}`}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/billing?project=${project.id}`)}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            Open in Billing
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/reports`)}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            Open in Reports
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Add Update
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <KpiCard
          label="Runtime"
          value={runtimeLabel}
          icon={<CalendarDays className="h-4 w-4" />}
        />
        <KpiCard
          label="Next update due"
          value={nextDueLabel}
          sub={nextDueSub}
          icon={<Clock className="h-4 w-4" />}
          accent={(project.updateOverdue || nearDue) ? "amber" : undefined}
        />
        <KpiCard
          label="Last comment"
          value={lastCommentLabel}
          sub={lastCommentSub}
          icon={<MessageSquare className="h-4 w-4" />}
        />
      </div>

      {/* Current health card */}
      <div className="rounded-xl border border-white/8 bg-white/2 p-5 mb-4">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">Current Health</h2>

        {project.generalStatus || project.riskLevel ? (
          <>
            {/* Status row */}
            <div className="flex flex-wrap gap-4 mb-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">General</span>
                <StatusBadge value={project.generalStatus ?? null} labels={GENERAL_STATUS_LABELS} cls={generalStatusCls} size="lg" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Risk</span>
                <div className="flex items-center gap-1.5">
                  <StatusBadge value={project.riskLevel ?? null} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} size="lg" />
                  <TrendArrow direction={project.trendDirection as "up" | "down" | "stable" | null ?? null} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Satisfaction</span>
                <StatusBadge value={project.clientSatisfaction ?? null} labels={CLIENT_SATISFACTION_LABELS} cls={clientSatisfactionCls} size="lg" />
              </div>
            </div>

            {/* Last comment */}
            {latestEntry?.comment && (
              <p className="text-sm text-foreground/70 whitespace-pre-wrap bg-white/3 rounded-lg px-3 py-2.5 mt-2">
                {latestEntry.comment}
              </p>
            )}

            {latestEntry && (
              <p className="text-xs text-muted-foreground/50 mt-3">
                Last updated {format(new Date(latestEntry.createdAt), "dd MMM yyyy, HH:mm")}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
            <p className="text-sm text-muted-foreground">No status set yet.</p>
            <p className="text-xs text-muted-foreground/60">Click "Add Update" to record the first health check.</p>
          </div>
        )}
      </div>

      {/* Two-column layout: Budget + Next Steps */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* Budget breakdown */}
        <div className="rounded-xl border border-white/8 bg-white/2 p-5">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">Budget Breakdown</h2>
          <BudgetBreakdown
            budgetTotal={project.budgetTotal ?? null}
            loggedTotal={project.loggedTotal ?? null}
            invoicedTotal={project.invoicedTotal ?? null}
            budgetAlert={project.budgetAlert ?? false}
          />
        </div>

        {/* Next steps */}
        <div className="rounded-xl border border-white/8 bg-white/2 p-5">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">Next Steps</h2>
          <NextStepsChecklist
            projectId={projectId}
            initialSteps={project.nextSteps as NextStep[] | null ?? null}
            onSaved={invalidate}
          />
        </div>
      </div>

      {/* Burn-up chart */}
      {(monthlyData.length > 0 || futureProjections.length > 0) && (
        <div className="rounded-xl border border-white/8 bg-white/2 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Revenue Over Time</h2>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-4 rounded-sm bg-violet-500/70" />
                Invoiced
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-4 rounded-sm bg-cyan-500/50" />
                Logged
              </span>
              {futureProjections.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded-sm bg-slate-500/50 border-t border-dashed border-slate-400" />
                  Planned
                </span>
              )}
            </div>
          </div>
          <BurnUpChart
            monthlyData={monthlyData}
            futureProjections={futureProjections}
            budgetTotal={project.budgetTotal ?? null}
          />
        </div>
      )}

      {/* History */}
      <div className="rounded-xl border border-white/8 bg-white/2 p-5">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-5">Update History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No updates recorded yet.</p>
        ) : (
          <div>
            {history.map((entry, i) => (
              <HistoryEntry key={entry.id} entry={entry} isFirst={i === 0} />
            ))}
          </div>
        )}
      </div>

      {/* Add Update Dialog */}
      {dialogOpen && (
        <AddUpdateDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          projectId={projectId}
          defaults={dialogDefaults}
          onSuccess={invalidate}
        />
      )}
    </AdminLayout>
  );
}
