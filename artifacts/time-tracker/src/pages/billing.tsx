import { useState, useMemo, useEffect, useCallback, useRef, Component, type ReactNode } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  format,
  startOfMonth, endOfMonth,
  startOfQuarter, endOfQuarter,
  subMonths, subQuarters,
} from "date-fns";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { useListProjects, useListClients } from "@workspace/api-client-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Download, ChevronDown, ChevronRight, ChevronLeft, Receipt, X, History, ChevronsUpDown, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type BillingPreset = "this_month" | "last_month" | "this_quarter" | "last_quarter" | "all_time" | "custom";
type FilterMode    = "all" | "unbilled" | "invoiced" | "invest";
type BillingStatusVal = "invoiced" | "invest" | null;

const PRESET_LABELS: Record<BillingPreset, string> = {
  this_month:   "This Month",
  last_month:   "Last Month",
  this_quarter: "This Quarter",
  last_quarter: "Last Quarter",
  all_time:     "All Time",
  custom:       "Custom range…",
};

interface BillingEmployee {
  id: number;
  name: string;
  loggedHours: number;
  logged: number;
  invoicedHours: number;
  invoiced: number;
  investHours: number;
  invest: number;
  unbilled: number;
  billingStatus: BillingStatusVal;
}

interface BillingRole {
  id: number;
  name: string;
  dayrate: number;
  budgetedDays: number | null;
  budget: number | null;
  loggedHours: number;
  logged: number;
  invoicedHours: number;
  invoiced: number;
  investHours: number;
  invest: number;
  unbilled: number;
  remaining: number | null;
  employees: BillingEmployee[];
}

interface BillingTotals {
  budget: number;
  logged: number;
  invoiced: number;
  invest: number;
  unbilled: number;
  remaining: number;
}

interface BillingResponse {
  project: { id: number; name: string };
  totals: BillingTotals;
  roles: BillingRole[];
}

// All-projects types
interface AllBillingEmployee {
  id: number;
  name: string;
  hours: number;
  days: number;
  revenue: number;
  invoiced: number;
  invest: number;
  unbilled: number;
  billingStatus: BillingStatusVal;
}

interface AllBillingRole {
  id: number;
  name: string;
  dayrate: number;
  budgetedDays: number | null;
  budget: number | null;
  loggedDays: number;
  loggedHours: number;
  logged: number;
  invoiced: number;
  invest: number;
  unbilled: number;
  remaining: number | null;
  employees: AllBillingEmployee[];
}

interface AllBillingProject {
  id: number;
  name: string;
  totals: BillingTotals;
  roles: AllBillingRole[];
}

interface AllBillingClient {
  id: number;
  name: string;
  totals: BillingTotals;
  projects: AllBillingProject[];
}

interface AllBillingResponse {
  totals: BillingTotals;
  clients: AllBillingClient[];
}

interface HistoryEntry {
  reference: string | null;
  invoicedAt: string;
  totalAmount: number;
  roleCount: number;
  employeeCount: number;
  roles: { id: number; name: string }[];
  employees: { id: number; name: string }[];
}

interface HistoryResponse {
  project: { id: number; name: string };
  history: HistoryEntry[];
}

interface MonthlyPoint {
  month: string;
  loggedCumulative: number;
  invoicedCumulative: number;
}

interface LifetimeResponse {
  project: { id: number; name: string };
  budget: number;
  totalLogged: number;
  totalInvoiced: number;
  remaining: number;
  monthlyData: MonthlyPoint[];
}

interface InvoiceRecord {
  id: number;
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  totalAmount: number;
  reference: string | null;
  roleCount: number;
  employeeCount: number;
  roles: { id: number; name: string }[];
  employees: { id: number; name: string }[];
}

interface InvoicesResponse {
  project: { id: number; name: string };
  invoices: InvoiceRecord[];
}

// ─── Chart error boundary ─────────────────────────────────────────────────────

class ChartErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

// ─── Selection helpers ────────────────────────────────────────────────────────

function empKey(roleId: number, employeeId: number): string {
  return `r${roleId}-e${employeeId}`;
}

function parseSelection(sel: Set<string>): { roleId: number; employeeId: number }[] {
  return Array.from(sel).map((key) => {
    const m = key.match(/^r(\d+)-e(\d+)$/);
    if (!m) throw new Error(`Invalid key: ${key}`);
    return { roleId: Number(m[1]), employeeId: Number(m[2]) };
  });
}

// ─── Period helpers ───────────────────────────────────────────────────────────

function computePeriod(
  preset: BillingPreset,
  customStart: string,
  customEnd: string,
): { startDate: string | null; endDate: string | null } {
  const today = new Date();
  switch (preset) {
    case "this_month":
      return { startDate: format(startOfMonth(today), "yyyy-MM-dd"), endDate: format(endOfMonth(today), "yyyy-MM-dd") };
    case "last_month": {
      const d = subMonths(today, 1);
      return { startDate: format(startOfMonth(d), "yyyy-MM-dd"), endDate: format(endOfMonth(d), "yyyy-MM-dd") };
    }
    case "this_quarter":
      return { startDate: format(startOfQuarter(today), "yyyy-MM-dd"), endDate: format(endOfQuarter(today), "yyyy-MM-dd") };
    case "last_quarter": {
      const d = subQuarters(today, 1);
      return { startDate: format(startOfQuarter(d), "yyyy-MM-dd"), endDate: format(endOfQuarter(d), "yyyy-MM-dd") };
    }
    case "all_time": return { startDate: null, endDate: null };
    case "custom":   return { startDate: customStart || null, endDate: customEnd || null };
  }
}

function getPeriodLabel(preset: BillingPreset, customStart: string, customEnd: string): string {
  const today = new Date();
  switch (preset) {
    case "this_month":   return format(today, "MMMM yyyy");
    case "last_month":   return format(subMonths(today, 1), "MMMM yyyy");
    case "this_quarter": return `Q${Math.ceil((today.getMonth() + 1) / 3)} ${today.getFullYear()}`;
    case "last_quarter": {
      const d = subQuarters(today, 1);
      return `Q${Math.ceil((d.getMonth() + 1) / 3)} ${d.getFullYear()}`;
    }
    case "all_time": return "All Time";
    case "custom":   return customStart && customEnd ? `${customStart} – ${customEnd}` : "Custom";
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function eur(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);
}

function eurDayRate(n: number): string {
  const formatted =
    n % 1 === 0
      ? n.toLocaleString("de-DE")
      : n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} €/d`;
}

function fmtDays(n: number): string {
  return n.toFixed(2);
}

function fmtHours(n: number): string {
  return n.toFixed(2);
}

// ─── Merge helpers ────────────────────────────────────────────────────────────

function mergeTotals(responses: BillingResponse[]): BillingTotals {
  return responses.reduce(
    (acc, r) => ({
      budget:    acc.budget    + r.totals.budget,
      logged:    acc.logged    + r.totals.logged,
      invoiced:  acc.invoiced  + r.totals.invoiced,
      invest:    acc.invest    + r.totals.invest,
      unbilled:  acc.unbilled  + r.totals.unbilled,
      remaining: acc.remaining + r.totals.remaining,
    }),
    { budget: 0, logged: 0, invoiced: 0, invest: 0, unbilled: 0, remaining: 0 },
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ label, value, accent, subLabel }: { label: string; value: string; accent?: string; subLabel?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/3 px-5 py-4 flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={cn("text-2xl font-bold tabular-nums", accent ?? "text-foreground")}>{value}</span>
      {subLabel && <span className="text-xs text-muted-foreground">{subLabel}</span>}
    </div>
  );
}

function StatusBadge({ status }: { status: BillingStatusVal }) {
  if (!status) return <span className="text-muted-foreground/50 text-sm">—</span>;
  if (status === "invoiced") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400 shrink-0" />
        Invoiced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-400">
      <span className="h-1.5 w-1.5 rounded-full bg-purple-400 shrink-0" />
      Invest
    </span>
  );
}

// ─── All Projects Table ───────────────────────────────────────────────────────

function AllProjectsTable({ allData }: { allData: AllBillingResponse }) {
  const filteredClients = allData.clients
    .map((client) => ({
      ...client,
      projects: client.projects
        .map((project) => ({
          ...project,
          roles: project.roles
            .map((role) => ({
              ...role,
              employees: role.employees.filter((emp) => emp.hours > 0),
            }))
            .filter((role) => role.loggedHours > 0),
        }))
        .filter((project) => project.roles.length > 0),
    }))
    .filter((client) => client.projects.length > 0);

  const [expandedClients,  setExpandedClients]  = useState<Set<number>>(() => new Set(filteredClients.map((c) => c.id)));
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(() =>
    new Set(filteredClients.flatMap((c) => c.projects.filter((p) => p.totals.unbilled > 0).map((p) => p.id))),
  );
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(() =>
    new Set(filteredClients.flatMap((c) => c.projects.flatMap((p) => p.roles.filter((r) => r.unbilled > 0).map((r) => r.id)))),
  );

  const toggleClient  = (id: number) => setExpandedClients((p)  => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleProject = (id: number) => setExpandedProjects((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleRole    = (id: number) => setExpandedRoles((p)    => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  function unbilledColour(unbilled: number): string {
    return unbilled > 0 ? "text-yellow-400" : "text-green-400";
  }

  const hasAnyData = filteredClients.some((c) => c.projects.some((p) => p.roles.length > 0));

  if (!hasAnyData) {
    return (
      <div className="text-sm text-muted-foreground py-12 text-center">
        No roles or time entries found for this period.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/8 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-white/8 hover:bg-transparent">
            <TableHead className="w-full">Client / Project / Role / Employee</TableHead>
            <TableHead className="text-right whitespace-nowrap">Day Rate</TableHead>
            <TableHead className="text-right whitespace-nowrap">Days</TableHead>
            <TableHead className="text-right whitespace-nowrap">Hours</TableHead>
            <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
            <TableHead className="text-right whitespace-nowrap">Logged</TableHead>
            <TableHead className="text-right whitespace-nowrap">Unbilled</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredClients.map((client) => {
            if (client.projects.length === 0) return null;
            const clientExpanded = expandedClients.has(client.id);

            return [
              <TableRow
                key={`client-${client.id}`}
                className="border-white/8 cursor-pointer hover:bg-white/3 font-semibold bg-white/2"
                onClick={() => toggleClient(client.id)}
              >
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    {clientExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    }
                    <span className="text-sm">{client.name}</span>
                  </div>
                </TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                  {fmtDays(client.totals.logged > 0 ? client.projects.flatMap((p) => p.roles).reduce((s, r) => s + r.loggedDays, 0) : 0)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                  {fmtHours(client.projects.flatMap((p) => p.roles).reduce((s, r) => s + r.loggedHours, 0))}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {client.totals.budget > 0 ? eur(client.totals.budget) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">{eur(client.totals.logged)}</TableCell>
                <TableCell className={cn("text-right tabular-nums text-sm", unbilledColour(client.totals.unbilled))}>
                  {eur(client.totals.unbilled)}
                </TableCell>
              </TableRow>,

              ...(!clientExpanded ? [] : client.projects.map((project) => {
                const projectExpanded = expandedProjects.has(project.id);
                const projectDays  = project.roles.reduce((s, r) => s + r.loggedDays,  0);
                const projectHours = project.roles.reduce((s, r) => s + r.loggedHours, 0);

                return [
                  <TableRow
                    key={`project-${project.id}`}
                    className="border-white/8 cursor-pointer hover:bg-white/3 font-medium"
                    onClick={() => toggleProject(project.id)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5 ml-5">
                        {projectExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        }
                        <span className="text-sm">{project.name}</span>
                      </div>
                    </TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{fmtDays(projectDays)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{fmtHours(projectHours)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {project.totals.budget > 0 ? eur(project.totals.budget) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{eur(project.totals.logged)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums text-sm", unbilledColour(project.totals.unbilled))}>
                      {eur(project.totals.unbilled)}
                    </TableCell>
                  </TableRow>,

                  ...(!projectExpanded ? [] : project.roles.map((role) => {
                    const roleExpanded = expandedRoles.has(role.id);

                    return [
                      <TableRow
                        key={`role-${role.id}`}
                        className="border-white/8 cursor-pointer hover:bg-white/2 text-sm"
                        onClick={() => toggleRole(role.id)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-1.5 ml-10">
                            {roleExpanded
                              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            }
                            <span className="text-foreground/80">{role.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground text-xs">{eurDayRate(role.dayrate)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtDays(role.loggedDays)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtHours(role.loggedHours)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {role.budget != null ? eur(role.budget) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{eur(role.logged)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", unbilledColour(role.unbilled))}>
                          {eur(role.unbilled)}
                        </TableCell>
                      </TableRow>,

                      ...(!roleExpanded ? [] : role.employees.map((emp) => (
                        <TableRow
                          key={`emp-${role.id}-${emp.id}`}
                          className="border-white/8 hover:bg-white/2 text-sm text-muted-foreground"
                        >
                          <TableCell>
                            <span className="ml-[72px] text-foreground/60">{emp.name}</span>
                          </TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular-nums">{fmtDays(emp.days)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtHours(emp.hours)}</TableCell>
                          <TableCell />
                          <TableCell className="text-right tabular-nums">{eur(emp.revenue)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", unbilledColour(emp.unbilled))}>
                            {eur(emp.unbilled)}
                          </TableCell>
                        </TableRow>
                      ))),
                    ];
                  })),
                ];
              })),
            ];
          })}

          {/* Totals row */}
          <TableRow className="border-white/8 border-t-2 border-t-white/15 font-semibold bg-white/2 hover:bg-white/2">
            <TableCell>Total</TableCell>
            <TableCell />
            <TableCell className="text-right tabular-nums">
              {fmtDays(filteredClients.flatMap((c) => c.projects.flatMap((p) => p.roles)).reduce((s, r) => s + r.loggedDays, 0))}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {fmtHours(filteredClients.flatMap((c) => c.projects.flatMap((p) => p.roles)).reduce((s, r) => s + r.loggedHours, 0))}
            </TableCell>
            <TableCell className="text-right tabular-nums">{eur(allData.totals.budget)}</TableCell>
            <TableCell className="text-right tabular-nums">{eur(allData.totals.logged)}</TableCell>
            <TableCell className={cn("text-right tabular-nums", allData.totals.unbilled > 0 ? "text-yellow-400" : "text-green-400")}>
              {eur(allData.totals.unbilled)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Multi-project table (per-project sections) ───────────────────────────────

function MultiProjectTable({ responses }: { responses: BillingResponse[] }) {
  const activeResponses = responses.filter((r) => r.roles.some((ro) => ro.loggedHours > 0));

  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(
    () => new Set(activeResponses.map((r) => r.project.id)),
  );
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(
    () => new Set(
      activeResponses.flatMap((r) =>
        r.roles.filter((ro) => ro.unbilled > 0).map((ro) => `${r.project.id}-${ro.id}`),
      ),
    ),
  );

  const toggleProject = (id: number) =>
    setExpandedProjects((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleRole = (key: string) =>
    setExpandedRoles((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });

  function unbilledColour(unbilled: number): string {
    return unbilled > 0 ? "text-yellow-400" : "text-green-400";
  }
  function remainingColour(remaining: number | null, budget: number | null): string {
    if (remaining == null || budget == null || budget === 0) return "text-foreground";
    const pct = remaining / budget;
    if (pct > 0.2)  return "text-green-400";
    if (pct > 0.05) return "text-yellow-400";
    return "text-red-400";
  }

  if (activeResponses.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-12 text-center">
        No roles or time entries found for this period.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/8 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-white/8 hover:bg-transparent">
            <TableHead className="w-full">Project / Role / Employee</TableHead>
            <TableHead className="text-right whitespace-nowrap">Day Rate</TableHead>
            <TableHead className="text-right whitespace-nowrap">Days</TableHead>
            <TableHead className="text-right whitespace-nowrap">Hours</TableHead>
            <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
            <TableHead className="text-right whitespace-nowrap">Logged</TableHead>
            <TableHead className="text-right whitespace-nowrap">Unbilled</TableHead>
            <TableHead className="text-right whitespace-nowrap">Remaining</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {responses.map((resp) => {
            const activeRoles = resp.roles.filter((r) => r.loggedHours > 0);
            const projectExpanded = expandedProjects.has(resp.project.id);
            const projectDays  = activeRoles.reduce((s, r) => s + r.loggedHours / 8, 0);
            const projectHours = activeRoles.reduce((s, r) => s + r.loggedHours,     0);

            return [
              // Project row
              <TableRow
                key={`proj-${resp.project.id}`}
                className="border-white/8 cursor-pointer hover:bg-white/3 font-semibold bg-white/2"
                onClick={() => toggleProject(resp.project.id)}
              >
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    {projectExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    }
                    <span className="text-sm">{resp.project.name}</span>
                  </div>
                </TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{fmtDays(projectDays)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm text-muted-foreground">{fmtHours(projectHours)}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">
                  {resp.totals.budget > 0 ? eur(resp.totals.budget) : <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums text-sm">{eur(resp.totals.logged)}</TableCell>
                <TableCell className={cn("text-right tabular-nums text-sm", unbilledColour(resp.totals.unbilled))}>
                  {eur(resp.totals.unbilled)}
                </TableCell>
                <TableCell className={cn("text-right tabular-nums text-sm", remainingColour(resp.totals.remaining, resp.totals.budget))}>
                  {resp.totals.remaining != null ? eur(resp.totals.remaining) : <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>,

              ...(!projectExpanded ? [] : activeRoles.map((role) => {
                const roleKey = `${resp.project.id}-${role.id}`;
                const roleExpanded = expandedRoles.has(roleKey);
                const activeEmps = role.employees.filter((e) => e.loggedHours > 0);

                return [
                  <TableRow
                    key={`role-${roleKey}`}
                    className="border-white/8 cursor-pointer hover:bg-white/2 text-sm font-medium"
                    onClick={() => toggleRole(roleKey)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5 ml-5">
                        {roleExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        }
                        <span className="text-foreground/80">{role.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground text-xs">{eurDayRate(role.dayrate)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtDays(role.loggedHours / 8)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtHours(role.loggedHours)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {role.budget != null ? eur(role.budget) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{eur(role.logged)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", unbilledColour(role.unbilled))}>
                      {eur(role.unbilled)}
                    </TableCell>
                    <TableCell className={cn("text-right tabular-nums", remainingColour(role.remaining, role.budget))}>
                      {role.remaining != null ? eur(role.remaining) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>,

                  ...(!roleExpanded ? [] : activeEmps.map((emp) => (
                    <TableRow
                      key={`emp-${roleKey}-${emp.id}`}
                      className="border-white/8 hover:bg-white/2 text-sm text-muted-foreground"
                    >
                      <TableCell>
                        <span className="ml-[56px] text-foreground/60">{emp.name}</span>
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-right tabular-nums">{fmtDays(emp.loggedHours / 8)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtHours(emp.loggedHours)}</TableCell>
                      <TableCell />
                      <TableCell className="text-right tabular-nums">{eur(emp.logged)}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", unbilledColour(emp.unbilled))}>
                        {eur(emp.unbilled)}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))),
                ];
              })),
            ];
          })}

          {/* Totals row */}
          {(() => {
            const merged = mergeTotals(responses);
            const totalDays  = responses.flatMap((r) => r.roles).reduce((s, ro) => s + ro.loggedHours / 8, 0);
            const totalHours = responses.flatMap((r) => r.roles).reduce((s, ro) => s + ro.loggedHours,     0);
            return (
              <TableRow className="border-white/8 border-t-2 border-t-white/15 font-semibold bg-white/2 hover:bg-white/2">
                <TableCell>Total</TableCell>
                <TableCell />
                <TableCell className="text-right tabular-nums text-muted-foreground text-sm">{fmtDays(totalDays)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground text-sm">{fmtHours(totalHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{eur(merged.budget)}</TableCell>
                <TableCell className="text-right tabular-nums">{eur(merged.logged)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", merged.unbilled > 0 ? "text-yellow-400" : "text-green-400")}>
                  {eur(merged.unbilled)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{eur(merged.remaining)}</TableCell>
              </TableRow>
            );
          })()}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Project multi-select dropdown ───────────────────────────────────────────

interface ProjectPickerProps {
  projects: Array<{ id: number; name: string; clientId?: number }>;
  clients: Array<{ id: number; name: string }>;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

function ProjectPicker({ projects, clients, selectedId, onSelect }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  const clientMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of clients) map.set(c.id, c.name);
    return map;
  }, [clients]);

  const groupedProjects = useMemo(() => {
    const q = search.toLowerCase();
    const filtered = !q
      ? projects
      : projects.filter(
          (p) =>
            (p.name ?? "").toLowerCase().includes(q) ||
            (p.clientId != null && (clientMap.get(p.clientId) ?? "").toLowerCase().includes(q)),
        );

    const groups = new Map<string, { clientName: string; projects: typeof filtered }>();
    for (const p of filtered) {
      const clientName = p.clientId != null ? (clientMap.get(p.clientId) ?? "Unknown") : "No client";
      if (!groups.has(clientName)) groups.set(clientName, { clientName, projects: [] });
      groups.get(clientName)!.projects.push(p);
    }

    return Array.from(groups.values())
      .sort((a, b) => a.clientName.localeCompare(b.clientName))
      .map((g) => ({ ...g, projects: [...g.projects].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")) }));
  }, [projects, clientMap, search]);

  const selected    = selectedId != null ? projects.find((p) => p.id === selectedId) : null;
  const clientName  = selected?.clientId != null ? (clientMap.get(selected.clientId) ?? "") : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-80 justify-between font-normal text-left">
          <span className="truncate">
            {selected ? (
              <>
                {clientName && <span className="text-muted-foreground">{clientName} › </span>}
                {selected.name}
              </>
            ) : (
              <span className="text-muted-foreground">Select a project…</span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-2 border-b border-white/8">
          <Input
            ref={inputRef}
            placeholder="Search clients or projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="max-h-72 overflow-y-auto">
          {groupedProjects.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No projects found.</p>
          )}
          {groupedProjects.map((group) => (
            <div key={group.clientName}>
              <p className="px-3 pt-2.5 pb-0.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {group.clientName}
              </p>
              {group.projects.map((p) => (
                <button
                  key={p.id}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 pl-5 py-2 text-sm hover:bg-white/5 text-left",
                    selectedId === p.id && "text-violet-400",
                  )}
                  onClick={() => { onSelect(p.id); setSearch(""); setOpen(false); }}
                >
                  <Check className={cn("h-3.5 w-3.5 shrink-0", selectedId === p.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {selectedId != null && (
          <div className="border-t border-white/8 p-2">
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => { onSelect(null); setOpen(false); }}
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Billing() {
  const today = new Date();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Project picker state ─────────────────────────────────────────────────────
  const [pickedProjectId, setPickedProjectId] = useState<number | null>(null);
  // Multi-select state kept for backward compat with URL param & multi-project queries
  const [projectSels,   setProjectSels]   = useState<Set<number>>(new Set());
  const [isAllProjects, setIsAllProjects] = useState(false);

  // Global period — used for multi/all-projects views only
  const [preset, setPreset]           = useState<BillingPreset>("this_month");
  const [customStart, setCustomStart] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [customEnd,   setCustomEnd]   = useState(format(endOfMonth(today), "yyyy-MM-dd"));
  const [filter, setFilter]           = useState<FilterMode>("all");

  // Section 2 period — month navigation
  const [singleNavYear,  setSingleNavYear]  = useState(today.getFullYear());
  const [singleNavMonth, setSingleNavMonth] = useState(today.getMonth() + 1); // 1-indexed
  const [singleIsCustom, setSingleIsCustom] = useState(false);
  const [singleCustomStart, setSingleCustomStart] = useState(format(startOfMonth(today), "yyyy-MM-dd"));
  const [singleCustomEnd,   setSingleCustomEnd]   = useState(format(endOfMonth(today), "yyyy-MM-dd"));

  // Derived selection flags
  const projectSelsArray  = useMemo(() => Array.from(projectSels), [projectSels]);
  const singleProjectId   = pickedProjectId ?? (!isAllProjects && projectSels.size === 1 ? projectSelsArray[0] : null);
  const isMultiProject    = pickedProjectId == null && !isAllProjects && projectSels.size > 1;
  const hasSelection      = pickedProjectId != null || isAllProjects || projectSels.size > 0;

  // ── Table state ──────────────────────────────────────────────────────────────
  const [expandedRoles, setExpandedRoles] = useState<Set<number>>(new Set());
  const [initialised,   setInitialised]   = useState(false);

  // ── Selection state (for mark-as-invoiced, single project only) ──────────────
  const [selection, setSelection] = useState<Set<string>>(new Set());

  // ── Modal state ──────────────────────────────────────────────────────────────
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceRef, setInvoiceRef]             = useState("");

  // ── History panel state ───────────────────────────────────────────────────────
  const [historyOpen,     setHistoryOpen]     = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());

  // Global period — multi/all-projects views
  const { startDate, endDate } = useMemo(
    () => computePeriod(preset, customStart, customEnd),
    [preset, customStart, customEnd],
  );

  // Section 2 period — single-project view (month nav)
  const singleNavFirstDay = new Date(singleNavYear, singleNavMonth - 1, 1);
  const { startDate: singleStartDate, endDate: singleEndDate } = useMemo((): { startDate: string | null; endDate: string | null } => {
    if (singleIsCustom) return { startDate: singleCustomStart || null, endDate: singleCustomEnd || null };
    return {
      startDate: format(singleNavFirstDay, "yyyy-MM-dd"),
      endDate:   format(endOfMonth(singleNavFirstDay), "yyyy-MM-dd"),
    };
  }, [singleIsCustom, singleNavYear, singleNavMonth, singleCustomStart, singleCustomEnd]);
  const singlePeriodLabel = singleIsCustom
    ? (singleCustomStart && singleCustomEnd ? `${singleCustomStart} – ${singleCustomEnd}` : "Custom")
    : format(singleNavFirstDay, "MMMM yyyy");

  // ── Data ─────────────────────────────────────────────────────────────────────
  const { data: projects }       = useListProjects();
  const { data: clients }        = useListClients();

  // Projects list — passed to ProjectPicker
  const allProjects = useMemo(
    () => (projects ?? []) as Array<{ id: number; name: string; clientId?: number }>,
    [projects],
  );

  // Single-project period billing query (Section 2) — uses singleStartDate/singleEndDate
  const billingQuery = useQuery<BillingResponse>({
    queryKey: ["billing", singleProjectId, singleStartDate, singleEndDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (singleStartDate) params.set("startDate", singleStartDate);
      if (singleEndDate)   params.set("endDate", singleEndDate);
      const res = await fetch(`/api/projects/${singleProjectId}/billing?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load billing data");
      return res.json();
    },
    enabled: singleProjectId != null,
  });

  // Single-project lifetime query (Section 1) — no period dependency
  const lifetimeQuery = useQuery<LifetimeResponse>({
    queryKey: ["billing-lifetime", singleProjectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${singleProjectId}/billing/lifetime`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load lifetime billing data");
      return res.json();
    },
    enabled: singleProjectId != null,
  });

  // Multi-project billing queries (parallel)
  const multiQueries = useQueries({
    queries: isMultiProject
      ? projectSelsArray.map((id) => ({
          queryKey: ["billing", id, startDate, endDate] as const,
          queryFn: async (): Promise<BillingResponse> => {
            const params = new URLSearchParams();
            if (startDate) params.set("startDate", startDate);
            if (endDate)   params.set("endDate", endDate);
            const res = await fetch(`/api/projects/${id}/billing?${params}`, { credentials: "include" });
            if (!res.ok) throw new Error("Failed to load billing data");
            return res.json();
          },
        }))
      : [],
  });

  const multiLoading = multiQueries.some((q) => q.isLoading);
  const multiError   = multiQueries.some((q) => q.isError);
  const multiData    = isMultiProject && !multiLoading && !multiError
    ? (multiQueries.map((q) => q.data).filter(Boolean) as BillingResponse[])
    : null;

  // All-projects billing query
  const allBillingQuery = useQuery<AllBillingResponse>({
    queryKey: ["billing-all", startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate)   params.set("endDate", endDate);
      const res = await fetch(`/api/billing?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load billing data");
      return res.json();
    },
    enabled: isAllProjects,
  });

  const singleData   = billingQuery.data;
  const allData      = allBillingQuery.data;
  const lifetimeData = lifetimeQuery.data;

  // Invoice history — reads from new invoices table
  const invoicesQuery = useQuery<InvoicesResponse>({
    queryKey: ["project-invoices", singleProjectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${singleProjectId}/invoices`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invoice history");
      return res.json();
    },
    enabled: singleProjectId != null,
  });

  // ── Pre-select project from ?project= query param ─────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pid = params.get("project");
    if (pid && !isNaN(Number(pid))) {
      setPickedProjectId(Number(pid));
    }
  }, []);

  // ── Auto-expand roles and pre-select unbilled employees (single project) ─────
  useEffect(() => {
    if (singleData && !initialised) {
      setExpandedRoles(new Set(singleData.roles.filter((r) => r.unbilled > 0).map((r) => r.id)));
      const preSelected = new Set<string>();
      for (const role of singleData.roles) {
        for (const emp of role.employees) {
          if (emp.unbilled > 0) preSelected.add(empKey(role.id, emp.id));
        }
      }
      setSelection(preSelected);
      setInitialised(true);
    }
  }, [singleData, initialised]);

  // ── Clear selection + reset on project/single-period change ──────────────────
  useEffect(() => {
    setInitialised(false);
    setSelection(new Set());
  }, [pickedProjectId, singleStartDate, singleEndDate]);

  // ── Project picker handler ────────────────────────────────────────────────────

  const handlePickProject = useCallback((id: number | null) => {
    setPickedProjectId(id);
  }, []);

  // ── Month nav handlers ────────────────────────────────────────────────────────

  const handlePrevMonth = useCallback(() => {
    setSingleIsCustom(false);
    setSingleNavMonth((m) => {
      if (m === 1) { setSingleNavYear((y) => y - 1); return 12; }
      return m - 1;
    });
  }, []);

  const handleNextMonth = useCallback(() => {
    setSingleIsCustom(false);
    setSingleNavMonth((m) => {
      if (m === 12) { setSingleNavYear((y) => y + 1); return 1; }
      return m + 1;
    });
  }, []);

  const handleJumpLastMonth = useCallback(() => {
    const d = subMonths(today, 1);
    setSingleNavYear(d.getFullYear());
    setSingleNavMonth(d.getMonth() + 1);
    setSingleIsCustom(false);
  }, []);

  const handleCustomRange = useCallback(() => {
    setSingleIsCustom(true);
  }, []);

  // ── Mutations ─────────────────────────────────────────────────────────────────

  // Create invoice — calls POST /projects/:id/invoices (marks entries + writes invoice record)
  const createInvoiceMutation = useMutation({
    mutationFn: async ({ reference }: { reference?: string }) => {
      const items = parseSelection(selection);
      const body = {
        items,
        periodStart: singleStartDate ?? format(startOfMonth(today), "yyyy-MM-dd"),
        periodEnd:   singleEndDate   ?? format(endOfMonth(today),   "yyyy-MM-dd"),
        reference:   reference || undefined,
      };
      const res = await fetch(`/api/projects/${singleProjectId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to create invoice");
      return res.json() as Promise<{ invoiceId: number; updatedCount: number; totalAmount: number }>;
    },
    onSuccess: ({ updatedCount }) => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
      queryClient.invalidateQueries({ queryKey: ["billing-lifetime"] });
      queryClient.invalidateQueries({ queryKey: ["project-invoices"] });
      setSelection(new Set());
      setShowInvoiceModal(false);
      setInvoiceRef("");
      toast({ title: `Invoice created — ${updatedCount} entr${updatedCount === 1 ? "y" : "ies"} marked as invoiced` });
    },
    onError: () => toast({ title: "Failed to create invoice", variant: "destructive" }),
  });

  // Mark as invest — keeps using the existing update-billing-status endpoint
  const markInvestMutation = useMutation({
    mutationFn: async () => {
      const items = parseSelection(selection);
      const body: Record<string, unknown> = { projectId: singleProjectId, items, status: "invest" };
      if (singleStartDate) body.startDate = singleStartDate;
      if (singleEndDate)   body.endDate   = singleEndDate;
      const res = await fetch("/api/time-entries/update-billing-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to update billing status");
      return res.json() as Promise<{ updatedCount: number }>;
    },
    onSuccess: ({ updatedCount }) => {
      queryClient.invalidateQueries({ queryKey: ["billing"] });
      queryClient.invalidateQueries({ queryKey: ["billing-lifetime"] });
      setSelection(new Set());
      toast({ title: `${updatedCount} entr${updatedCount === 1 ? "y" : "ies"} marked as invest` });
    },
    onError: () => toast({ title: "Failed to update billing status", variant: "destructive" }),
  });

  // ── Chart helpers (Section 1 cumulative chart) ───────────────────────────────

  const chartYMax = useMemo(() => {
    if (!lifetimeData?.monthlyData?.length) return 10_000;
    const rawMax = Math.max(
      lifetimeData.budget ?? 0,
      ...lifetimeData.monthlyData.map((d) => d.loggedCumulative),
      ...lifetimeData.monthlyData.map((d) => d.invoicedCumulative),
      0,
    );
    const step = rawMax <= 5_000 ? 1_000
      : rawMax <= 50_000 ? 10_000
      : rawMax <= 200_000 ? 25_000
      : rawMax <= 500_000 ? 50_000
      : 100_000;
    return Math.ceil(rawMax / step) * step || step;
  }, [lifetimeData]);

  // ── Filtered roles ────────────────────────────────────────────────────────────

  const filteredRoles = useMemo<BillingRole[]>(() => {
    if (!singleData) return [];
    return singleData.roles.filter((r) => {
      if (filter === "unbilled") return r.unbilled > 0;
      if (filter === "invoiced") return r.invoiced > 0;
      if (filter === "invest")   return r.invest > 0;
      return true;
    });
  }, [singleData, filter]);

  // ── Selection helpers ─────────────────────────────────────────────────────────

  const allVisibleKeys = useMemo(
    () => filteredRoles.flatMap((r) => r.employees.map((e) => empKey(r.id, e.id))),
    [filteredRoles],
  );

  const isRoleSelected = useCallback((role: BillingRole) =>
    role.employees.length > 0 && role.employees.every((e) => selection.has(empKey(role.id, e.id))),
  [selection]);

  const isRoleIndeterminate = useCallback((role: BillingRole) => {
    const count = role.employees.filter((e) => selection.has(empKey(role.id, e.id))).length;
    return count > 0 && count < role.employees.length;
  }, [selection]);

  const handleRoleCheck = useCallback((role: BillingRole, checked: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev);
      for (const emp of role.employees) {
        const key = empKey(role.id, emp.id);
        if (checked) next.add(key); else next.delete(key);
      }
      return next;
    });
  }, []);

  const handleEmpCheck = useCallback((roleId: number, empId: number, checked: boolean) => {
    const key = empKey(roleId, empId);
    setSelection((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const allSelected  = allVisibleKeys.length > 0 && allVisibleKeys.every((k) => selection.has(k));
  const someSelected = allVisibleKeys.some((k) => selection.has(k));

  const handleSelectAll = useCallback((checked: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (checked) { allVisibleKeys.forEach((k) => next.add(k)); }
      else         { allVisibleKeys.forEach((k) => next.delete(k)); }
      return next;
    });
  }, [allVisibleKeys]);

  // ── Selected amount + itemized line items (for invoice modal) ────────────────

  const selectedAmount = useMemo(() => {
    if (!singleData) return 0;
    let total = 0;
    for (const role of singleData.roles) {
      for (const emp of role.employees) {
        if (selection.has(empKey(role.id, emp.id))) total += emp.unbilled;
      }
    }
    return Math.round(total * 100) / 100;
  }, [singleData, selection]);

  const selectedLineItems = useMemo(() => {
    if (!singleData) return [];
    const items: { roleName: string; empName: string; hours: number; unbilled: number }[] = [];
    for (const role of singleData.roles) {
      for (const emp of role.employees) {
        if (selection.has(empKey(role.id, emp.id))) {
          items.push({ roleName: role.name, empName: emp.name, hours: emp.loggedHours, unbilled: emp.unbilled });
        }
      }
    }
    return items;
  }, [singleData, selection]);

  // ── Active totals — multi/all-projects views only (single project uses lifetimeData for Section 1) ──
  const activeTotals = useMemo((): BillingTotals | null => {
    if (isAllProjects)               return allData?.totals ?? null;
    if (isMultiProject && multiData) return mergeTotals(multiData);
    return null;
  }, [isAllProjects, allData, isMultiProject, multiData]);

  // ── CSV export ────────────────────────────────────────────────────────────────

  function csvCell(value: string | number): string {
    if (typeof value === "number") return value.toFixed(2);
    return value.includes(",") ? `"${value}"` : value;
  }

  function exportCSV() {
    const periodStr = startDate ?? "all";
    const header = "Client,Project,Role,Employee,Dayrate,Days,Hours,Revenue";

    if (isAllProjects && allData) {
      const rows: string[] = [header];
      for (const client of allData.clients) {
        for (const project of client.projects) {
          for (const role of project.roles) {
            for (const emp of role.employees) {
              if (emp.hours === 0) continue;
              rows.push([
                csvCell(client.name),
                csvCell(project.name),
                csvCell(role.name),
                csvCell(emp.name),
                role.dayrate.toFixed(2),
                emp.days.toFixed(2),
                emp.hours.toFixed(2),
                emp.revenue.toFixed(2),
              ].join(","));
            }
          }
        }
      }
      const blob = new Blob([rows.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `billing-all-${periodStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    const exportResponses: BillingResponse[] = singleData
      ? [singleData]
      : (multiData ?? []);

    if (exportResponses.length > 0) {
      const rows: string[] = [header];
      for (const resp of exportResponses) {
        for (const role of resp.roles) {
          for (const emp of role.employees) {
            if (emp.loggedHours === 0) continue;
            rows.push([
              csvCell(resp.project.name),
              csvCell(resp.project.name),
              csvCell(role.name),
              csvCell(emp.name),
              role.dayrate.toFixed(2),
              (emp.loggedHours / 8).toFixed(2),
              emp.loggedHours.toFixed(2),
              emp.logged.toFixed(2),
            ].join(","));
          }
        }
      }
      const fileLabel = exportResponses.length === 1
        ? exportResponses[0].project.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()
        : "multi";
      const blob = new Blob([rows.join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `billing-${fileLabel}-${periodStr}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  // ── Colours ───────────────────────────────────────────────────────────────────

  function remainingColour(remaining: number | null, budget: number | null): string {
    if (remaining == null || budget == null || budget === 0) return "text-foreground";
    const pct = remaining / budget;
    if (pct > 0.2)  return "text-green-400";
    if (pct > 0.05) return "text-yellow-400";
    return "text-red-400";
  }

  function unbilledColour(unbilled: number): string {
    return unbilled > 0 ? "text-yellow-400" : "text-green-400";
  }

  const totalsRemainingColour = activeTotals
    ? remainingColour(activeTotals.remaining, activeTotals.budget)
    : "text-foreground";

  const periodLabel = getPeriodLabel(preset, customStart, customEnd);

  const canExport = (isAllProjects && !!allData) || (!!singleData) || (isMultiProject && !!multiData && multiData.length > 0);

  // ── Loading / error state ─────────────────────────────────────────────────────

  const isLoading = (isAllProjects && allBillingQuery.isLoading)
    || (singleProjectId != null && billingQuery.isLoading)
    || (isMultiProject && multiLoading);

  const isError = (isAllProjects && allBillingQuery.isError)
    || (singleProjectId != null && billingQuery.isError)
    || (isMultiProject && multiError);

  return (
    <AdminLayout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
          <h1 className="text-xl font-semibold">Billing</h1>
        </div>
        <Button variant="outline" size="sm" disabled={!canExport} onClick={exportCSV} className="gap-2">
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Selectors toolbar */}
      <div className="flex flex-wrap gap-3 mb-6">
        <ProjectPicker
          projects={allProjects}
          clients={clients ?? []}
          selectedId={pickedProjectId}
          onSelect={handlePickProject}
        />
      </div>

      {/* No project selected */}
      {!hasSelection && (
        <div className="flex flex-col items-center justify-center py-32 text-muted-foreground gap-2">
          <Receipt className="h-10 w-10 opacity-30" strokeWidth={1} />
          <p className="text-sm">Select a project to view billing</p>
        </div>
      )}

      {/* Loading */}
      {hasSelection && isLoading && (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading…</div>
      )}

      {/* Error */}
      {hasSelection && isError && (
        <div className="text-sm text-destructive py-12 text-center">Failed to load billing data.</div>
      )}

      {/* Multi / All-projects KPI Cards */}
      {activeTotals && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          <KpiCard label="Budget"   value={eur(activeTotals.budget)} />
          <KpiCard
            label="Logged"
            value={eur(activeTotals.logged)}
            subLabel={activeTotals.invest > 0 ? `(${eur(activeTotals.invest)} inv)` : undefined}
          />
          <KpiCard label="Invoiced" value={eur(activeTotals.invoiced)} />
          <KpiCard
            label="Unbilled"
            value={eur(activeTotals.unbilled)}
            accent={unbilledColour(activeTotals.unbilled)}
          />
          <KpiCard
            label="Remaining"
            value={eur(activeTotals.remaining)}
            accent={totalsRemainingColour}
          />
        </div>
      )}

      {/* All Projects table */}
      {isAllProjects && allData && (
        <AllProjectsTable allData={allData} />
      )}

      {/* Multi-project table */}
      {isMultiProject && multiData && multiData.length > 0 && (
        <MultiProjectTable responses={multiData} />
      )}

      {/* ── Single project: Section 1 (Lifetime overview) + Section 2 (Period billing) ── */}
      {singleProjectId != null && (
        <>
          {/* Section 1 — Lifetime KPIs + cumulative chart */}
          {lifetimeData ? (
            <div className="mb-8">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">Project overview — all time</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                <KpiCard label="Budget"         value={eur(lifetimeData.budget)} />
                <KpiCard label="Total Logged"   value={eur(lifetimeData.totalLogged)} />
                <KpiCard
                  label="Total Invoiced"
                  value={eur(lifetimeData.totalInvoiced)}
                  accent="text-green-400"
                />
                <KpiCard
                  label="Remaining"
                  value={eur(lifetimeData.remaining)}
                  accent={remainingColour(lifetimeData.remaining, lifetimeData.budget)}
                />
              </div>

              {lifetimeData.monthlyData.length > 1 && (
                <div className="rounded-xl border border-white/8 bg-white/2 p-4">
                  {/* Custom legend — kept outside Recharts to avoid React 19 dispatcher issues */}
                  <div className="flex items-center gap-4 mb-3 justify-end">
                    {lifetimeData.budget > 0 && (
                      <span className="flex items-center gap-1.5 text-xs" style={{ color: "rgba(255,255,255,0.5)" }}>
                        <span className="inline-block w-5 h-0 border-t border-dashed" style={{ borderColor: "rgba(255,255,255,0.4)" }} />
                        Budget
                      </span>
                    )}
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "rgba(255,255,255,0.6)" }}>
                      <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ background: "#06B6D4" }} />
                      Logged
                    </span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: "rgba(255,255,255,0.6)" }}>
                      <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ background: "#4ade80" }} />
                      Invoiced
                    </span>
                  </div>
                  <ChartErrorBoundary>
                    <div style={{ height: 220 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={lifetimeData.monthlyData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                          <XAxis
                            dataKey="month"
                            tickFormatter={(v: string) => {
                              const [y, m] = v.split("-").map(Number);
                              return new Date(y, m - 1).toLocaleString("en-US", { month: "short" });
                            }}
                            tick={{ fontSize: 11, fill: "rgba(255,255,255,0.4)" }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis
                            domain={[0, chartYMax]}
                            tickFormatter={(v: number) =>
                              v === 0 ? "€0" : `€${Math.round(v / 1000)}k`
                            }
                            tick={{ fontSize: 11, fill: "rgba(255,255,255,0.4)" }}
                            tickLine={false}
                            axisLine={false}
                            width={52}
                          />
                          <RechartsTooltip
                            contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, fontSize: 12 }}
                            formatter={(value: number, name: string) => [eur(value), name]}
                          />
                          {lifetimeData.budget > 0 && (
                            <ReferenceLine
                              y={lifetimeData.budget}
                              stroke="rgba(255,255,255,0.3)"
                              strokeDasharray="6 3"
                            />
                          )}
                          <Area
                            type="monotone"
                            dataKey="loggedCumulative"
                            name="Logged"
                            stroke="#06B6D4"
                            fill="rgba(6,182,212,0.15)"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                          <Area
                            type="monotone"
                            dataKey="invoicedCumulative"
                            name="Invoiced"
                            stroke="#4ade80"
                            fill="rgba(74,222,128,0.12)"
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </ChartErrorBoundary>
                </div>
              )}
            </div>
          ) : lifetimeQuery.isLoading ? (
            <div className="text-sm text-muted-foreground py-6 text-center">Loading overview…</div>
          ) : null}

          {/* Section 2 — Period-scoped billing table */}
          <div>
            <div className="flex flex-wrap items-end gap-3 mb-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide self-center mr-1">Ready to invoice</p>

              {/* Section 2 period — month nav */}
              {!singleIsCustom ? (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handlePrevMonth}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm font-medium tabular-nums w-28 text-center">
                    {format(singleNavFirstDay, "MMMM yyyy")}
                  </span>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleNextMonth}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <ChevronDown className="h-4 w-4 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={handleJumpLastMonth}>Last month</DropdownMenuItem>
                      <DropdownMenuItem onClick={handleCustomRange}>Custom range…</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Input type="date" className="w-36 h-8 text-sm" value={singleCustomStart} onChange={(e) => setSingleCustomStart(e.target.value)} />
                  <span className="text-muted-foreground text-sm">–</span>
                  <Input type="date" className="w-36 h-8 text-sm" value={singleCustomEnd} onChange={(e) => setSingleCustomEnd(e.target.value)} />
                  <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => setSingleIsCustom(false)}>
                    <X className="h-3 w-3 mr-1" />
                    Month view
                  </Button>
                </div>
              )}

              {billingQuery.isLoading && (
                <span className="text-xs text-muted-foreground">Loading…</span>
              )}

              {/* Filter + Actions */}
              <div className="flex items-center gap-2 ml-auto">
                <Select value={filter} onValueChange={(v) => setFilter(v as FilterMode)}>
                  <SelectTrigger className="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="unbilled">Unbilled only</SelectItem>
                    <SelectItem value="invoiced">Invoiced only</SelectItem>
                    <SelectItem value="invest">Invest only</SelectItem>
                  </SelectContent>
                </Select>

                {selection.size > 0 && (
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {selection.size} selected
                    {selectedAmount > 0 && (
                      <span className="text-yellow-400 ml-1">({eur(selectedAmount)})</span>
                    )}
                  </span>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="h-8 gap-1" disabled={selection.size === 0}>
                      Mark as <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => markInvestMutation.mutate()}
                      disabled={markInvestMutation.isPending}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-purple-400 mr-2 shrink-0" />
                      Invest
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                {selection.size > 0 && (
                  <Button size="sm" variant="ghost" className="h-8 gap-1 text-muted-foreground" onClick={() => setSelection(new Set())}>
                    <X className="h-3.5 w-3.5" />
                    Clear
                  </Button>
                )}
              </div>
            </div>

            {singleData && (
              singleData.roles.length === 0 ? (
                <div className="text-sm text-muted-foreground py-12 text-center">
                  No roles defined for this project.
                </div>
              ) : (
                <div className="rounded-xl border border-white/8 overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/8 hover:bg-transparent">
                        <TableHead className="w-8 pr-0">
                          <Checkbox
                            checked={someSelected && !allSelected ? "indeterminate" : allSelected}
                            onCheckedChange={(c) => handleSelectAll(!!c)}
                            aria-label="Select all"
                          />
                        </TableHead>
                        <TableHead className="w-full">Role / Employee</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Day Rate</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Days</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Hours</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Logged</TableHead>
                        <TableHead className="whitespace-nowrap">Status</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Unbilled</TableHead>
                        <TableHead className="text-right whitespace-nowrap">Remaining</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRoles.map((role) => {
                        const expanded    = expandedRoles.has(role.id);
                        const roleChecked = isRoleSelected(role);
                        const roleIndet   = isRoleIndeterminate(role);

                        const toggleExpand = () =>
                          setExpandedRoles((prev) => {
                            const next = new Set(prev);
                            if (next.has(role.id)) next.delete(role.id); else next.add(role.id);
                            return next;
                          });

                        return [
                          <TableRow
                            key={`role-${role.id}`}
                            className="border-white/8 cursor-pointer hover:bg-white/3 font-medium"
                            onClick={toggleExpand}
                          >
                            <TableCell className="pr-0" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={roleIndet ? "indeterminate" : roleChecked}
                                onCheckedChange={(c) => handleRoleCheck(role, !!c)}
                                aria-label={`Select role ${role.name}`}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {expanded
                                  ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                }
                                <span>{role.name}</span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                              {eurDayRate(role.dayrate)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                              {fmtDays(role.loggedHours / 8)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                              {fmtHours(role.loggedHours)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {role.budget != null ? eur(role.budget) : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{eur(role.logged)}</TableCell>
                            <TableCell />
                            <TableCell className={cn("text-right tabular-nums", unbilledColour(role.unbilled))}>
                              {eur(role.unbilled)}
                            </TableCell>
                            <TableCell className={cn("text-right tabular-nums", remainingColour(role.remaining, role.budget))}>
                              {role.remaining != null ? eur(role.remaining) : <span className="text-muted-foreground">—</span>}
                            </TableCell>
                          </TableRow>,

                          ...(!expanded ? [] : role.employees.map((emp) => {
                            const empChecked = selection.has(empKey(role.id, emp.id));
                            const empDays    = emp.loggedHours / 8;
                            return (
                              <TableRow
                                key={`emp-${role.id}-${emp.id}`}
                                className="border-white/8 hover:bg-white/2 text-sm text-muted-foreground"
                              >
                                <TableCell className="pr-0">
                                  <Checkbox
                                    checked={empChecked}
                                    onCheckedChange={(c) => handleEmpCheck(role.id, emp.id, !!c)}
                                    aria-label={`Select ${emp.name}`}
                                  />
                                </TableCell>
                                <TableCell>
                                  <span className="ml-6 text-foreground/70">{emp.name}</span>
                                </TableCell>
                                <TableCell />
                                <TableCell className="text-right tabular-nums">{fmtDays(empDays)}</TableCell>
                                <TableCell className="text-right tabular-nums">{fmtHours(emp.loggedHours)}</TableCell>
                                <TableCell />
                                <TableCell className="text-right tabular-nums">{eur(emp.logged)}</TableCell>
                                <TableCell>
                                  {emp.billingStatus === "invest" ? (
                                    <StatusBadge status="invest" />
                                  ) : emp.unbilled > 0 ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
                                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                                      Open
                                    </span>
                                  ) : emp.loggedHours > 0 ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
                                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                                      Invoiced
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground/50 text-sm">—</span>
                                  )}
                                </TableCell>
                                <TableCell className={cn("text-right tabular-nums", unbilledColour(emp.unbilled))}>
                                  {eur(emp.unbilled)}
                                </TableCell>
                                <TableCell />
                              </TableRow>
                            );
                          })),
                        ];
                      })}

                      {/* Totals row */}
                      <TableRow className="border-white/8 border-t-2 border-t-white/15 font-semibold bg-white/2 hover:bg-white/2">
                        <TableCell />
                        <TableCell>Total</TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                          {fmtDays(singleData.totals.logged > 0 ? singleData.roles.reduce((s, r) => s + r.loggedHours, 0) / 8 : 0)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground text-sm">
                          {fmtHours(singleData.roles.reduce((s, r) => s + r.loggedHours, 0))}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{eur(singleData.totals.budget)}</TableCell>
                        <TableCell className="text-right tabular-nums">{eur(singleData.totals.logged)}</TableCell>
                        <TableCell />
                        <TableCell className={cn("text-right tabular-nums", unbilledColour(singleData.totals.unbilled))}>
                          {eur(singleData.totals.unbilled)}
                        </TableCell>
                        <TableCell className={cn("text-right tabular-nums", remainingColour(singleData.totals.remaining, singleData.totals.budget))}>
                          {eur(singleData.totals.remaining)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              )
            )}

            {/* Generate invoice — primary action below table */}
            {singleData && singleData.roles.length > 0 && (
              <div className="mt-4 flex items-center gap-3">
                <Button
                  disabled={selection.size === 0 || selectedAmount === 0}
                  onClick={() => setShowInvoiceModal(true)}
                  className="gap-2"
                >
                  Generate invoice
                  {selectedAmount > 0 && (
                    <span className="opacity-80">— {eur(selectedAmount)}</span>
                  )}
                </Button>
                {selection.size > 0 && selectedAmount === 0 && (
                  <span className="text-xs text-muted-foreground">No unbilled amount in selection</span>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Invoice history panel — single project only */}
      {singleProjectId != null && (
        <div className="mt-8">
          <button
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left group"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            {historyOpen
              ? <ChevronDown className="h-4 w-4 shrink-0" />
              : <ChevronRight className="h-4 w-4 shrink-0" />
            }
            <History className="h-4 w-4 shrink-0" />
            <span>Invoice history</span>
            {invoicesQuery.data && invoicesQuery.data.invoices.length > 0 && (
              <span className="ml-1 rounded-full bg-white/8 px-1.5 py-0.5 text-xs tabular-nums">
                {invoicesQuery.data.invoices.length}
              </span>
            )}
          </button>

          {historyOpen && (
            <div className="mt-3 rounded-xl border border-white/8 overflow-hidden">
              {invoicesQuery.isLoading && (
                <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              )}
              {invoicesQuery.isError && (
                <p className="py-8 text-center text-sm text-destructive">Failed to load invoice history.</p>
              )}
              {invoicesQuery.data && invoicesQuery.data.invoices.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">No invoices recorded for this project yet.</p>
              )}
              {invoicesQuery.data && invoicesQuery.data.invoices.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/8 hover:bg-transparent">
                      <TableHead className="w-6 pr-0" />
                      <TableHead>Reference</TableHead>
                      <TableHead className="whitespace-nowrap">Period</TableHead>
                      <TableHead className="whitespace-nowrap">Created</TableHead>
                      <TableHead>Roles</TableHead>
                      <TableHead>Employees</TableHead>
                      <TableHead className="text-right whitespace-nowrap">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoicesQuery.data.invoices.map((entry) => {
                      const key = String(entry.id);
                      const expanded = expandedHistory.has(key);
                      const toggleRow = () =>
                        setExpandedHistory((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        });
                      const dateLabel = new Date(entry.createdAt).toLocaleDateString("de-DE", {
                        day: "2-digit", month: "short", year: "numeric",
                      });
                      const periodStr = [entry.periodStart, entry.periodEnd]
                        .map((d) => new Date(d).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" }))
                        .join(" – ");

                      return [
                        <TableRow
                          key={`hist-${key}`}
                          className="border-white/8 cursor-pointer hover:bg-white/3"
                          onClick={toggleRow}
                        >
                          <TableCell className="pr-0 pl-3">
                            {expanded
                              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            }
                          </TableCell>
                          <TableCell>
                            {entry.reference
                              ? <span className="font-mono text-sm text-foreground">{entry.reference}</span>
                              : <span className="text-muted-foreground text-sm italic">No reference</span>
                            }
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{periodStr}</TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{dateLabel}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{entry.roleCount} role{entry.roleCount !== 1 ? "s" : ""}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{entry.employeeCount} employee{entry.employeeCount !== 1 ? "s" : ""}</TableCell>
                          <TableCell className="text-right tabular-nums font-medium text-green-400">{eur(entry.totalAmount)}</TableCell>
                        </TableRow>,

                        ...(!expanded ? [] : [
                          <TableRow key={`hist-detail-${key}`} className="border-white/8 hover:bg-transparent">
                            <TableCell />
                            <TableCell colSpan={6} className="pb-3 pt-1">
                              <div className="flex gap-8 text-sm">
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wide">Roles</p>
                                  <ul className="space-y-0.5">
                                    {entry.roles.map((r) => (
                                      <li key={r.id} className="text-foreground/80">{r.name}</li>
                                    ))}
                                  </ul>
                                </div>
                                <div>
                                  <p className="text-xs text-muted-foreground mb-1.5 font-medium uppercase tracking-wide">Employees</p>
                                  <ul className="space-y-0.5">
                                    {entry.employees.map((e) => (
                                      <li key={e.id} className="text-foreground/80">{e.name}</li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>,
                        ]),
                      ];
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      )}

      {/* Generate invoice modal */}
      <Dialog open={showInvoiceModal} onOpenChange={setShowInvoiceModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Generate invoice</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Project</span>
              <span className="font-medium">{singleData?.project.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Period</span>
              <span className="font-medium">{singlePeriodLabel}</span>
            </div>

            {/* Itemized line items */}
            {selectedLineItems.length > 0 && (
              <div className="rounded-lg border border-white/10 overflow-hidden mt-1">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/3">
                      <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">Role</th>
                      <th className="text-left py-1.5 px-3 font-medium text-muted-foreground">Employee</th>
                      <th className="text-right py-1.5 px-3 font-medium text-muted-foreground">Hours</th>
                      <th className="text-right py-1.5 px-3 font-medium text-muted-foreground">Unbilled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedLineItems.map((item, i) => (
                      <tr key={i} className="border-t border-white/6">
                        <td className="py-1.5 px-3 text-muted-foreground">{item.roleName}</td>
                        <td className="py-1.5 px-3">{item.empName}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums text-muted-foreground">{fmtHours(item.hours)}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums font-medium text-yellow-400">{eur(item.unbilled)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-white/15 bg-white/2">
                      <td colSpan={3} className="py-1.5 px-3 font-semibold">Total unbilled</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-semibold text-yellow-400">{eur(selectedAmount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invoice-ref">Invoice reference (optional)</Label>
            <Input
              id="invoice-ref"
              placeholder={`INV-${format(today, "yyyy-MM")}`}
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowInvoiceModal(false); setInvoiceRef(""); }}>
              Cancel
            </Button>
            <Button
              onClick={() => createInvoiceMutation.mutate({ reference: invoiceRef || undefined })}
              disabled={createInvoiceMutation.isPending}
            >
              {createInvoiceMutation.isPending ? "Creating…" : "Generate invoice"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
