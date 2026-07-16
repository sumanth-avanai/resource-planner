import { useState, useEffect } from "react";
import { format, parseISO } from "date-fns";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Plus, Pencil, Trash2, Info } from "lucide-react";
import { useListEmployees } from "@workspace/api-client-react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface AssignedEmployee { employeeId: number; employeeName: string | null }
interface ProjectRole {
  id: number;
  projectId: number;
  name: string;
  dayRate: number;
  budgetedDays: number | null;
  budgetedHours: number | null;
  assignedEmployees: AssignedEmployee[];
}
interface BudgetRole extends ProjectRole {
  bookedHours: number;
  bookedDays: number;
  plannedHours: number;
  plannedDays: number;
  budgetValue: number | null;
  bookedValue: number;
  utilization: number | null;
  invoicedDays: number;
  reservedDays: number;
  /** Undelivered plan before today — warning flag, never consumption. */
  stalePlanDays?: number;
  unplannedDays: number | null;
  freeDays: number | null;
  remainingBudgetDays: number | null;
  loggedNotInvoicedDays: number;
}
interface BudgetResponse {
  roles: BudgetRole[];
  totals: {
    budgetedDays: number;
    budgetedHours: number;
    budgetValue: number;
    bookedHours: number;
    bookedValue: number;
    invoicedDays: number;
    reservedDays: number;
    stalePlanDays?: number;
    unplannedDays: number;
    freeDays: number;
    remainingBudgetDays: number;
    loggedNotInvoicedDays: number;
  };
}

interface AllocationEntry {
  employeeId: number;
  employeeName: string;
  allocatedDays: number;
  period: { start: string; end: string } | null;
  bookedDays: number;
  percentage: number;
}
interface AllocationRole {
  roleId: number;
  roleName: string;
  dayRate: number;
  budgetedDays: number | null;
  plannedDays: number;
  bookedDays: number;
  invoicedDays: number;
  reservedDays: number;
  stalePlanDays?: number;
  unplannedDays: number | null;
  freeDays: number | null;
  remainingBudgetDays: number | null;
  budgetValue: number | null;
  bookedValue: number;
  allocations: AllocationEntry[];
}
interface AllocationsResponse {
  projectId: number;
  roles: AllocationRole[];
  totals: {
    budgetedDays: number;
    plannedDays: number;
    bookedDays: number;
    invoicedDays: number;
    reservedDays: number;
    unplannedDays: number;
    freeDays: number;
    remainingBudgetDays: number;
    budgetValue: number;
    bookedValue: number;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

const fmtDays = (d: number) => `${d % 1 === 0 ? d : d.toFixed(1)}d`;

function UtilBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-muted-foreground text-xs">—</span>;
  const pctVal = pct * 100;
  const color =
    pctVal > 100 ? "text-destructive" : pctVal >= 80 ? "text-yellow-600" : "text-green-600";
  return <span className={`text-xs font-medium ${color}`}>{pctVal.toFixed(0)}%</span>;
}

function UtilBar({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const pctClamped = Math.min(pct * 100, 100);
  const isOver = pct > 1;
  const isWarn = pct >= 0.8;
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <Progress
        value={pctClamped}
        className={`h-2 flex-1 ${isOver ? "[&>div]:bg-destructive" : isWarn ? "[&>div]:bg-yellow-500" : "[&>div]:bg-green-500"}`}
      />
      <UtilBadge pct={pct} />
    </div>
  );
}

// ── Role Form ──────────────────────────────────────────────────────────────────
interface RoleFormState {
  name: string;
  dayRate: string;
  budgetedDays: string;
  assignedEmployeeIds: number[];
}

function RoleModal({
  open,
  title,
  initial,
  employees,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  title: string;
  initial: RoleFormState;
  employees: { id: number; name: string }[];
  onClose: () => void;
  onSave: (data: RoleFormState) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<RoleFormState>(initial);

  useEffect(() => {
    if (open) setForm(initial);
  }, [open]);

  const dayRate = parseFloat(form.dayRate) || 0;
  const budgDays = parseFloat(form.budgetedDays) || 0;
  const budgHours = budgDays * 8;
  const budgValue = budgDays * dayRate;

  function toggleEmployee(id: number) {
    setForm((f) => ({
      ...f,
      assignedEmployeeIds: f.assignedEmployeeIds.includes(id)
        ? f.assignedEmployeeIds.filter((e) => e !== id)
        : [...f.assignedEmployeeIds, id],
    }));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label>Role Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Tech Lead"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Day Rate (€)</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={form.dayRate}
              onChange={(e) => setForm((f) => ({ ...f, dayRate: e.target.value }))}
              placeholder="1356.60"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Budgeted Days <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              type="number"
              step="0.5"
              min="0"
              value={form.budgetedDays}
              onChange={(e) => setForm((f) => ({ ...f, budgetedDays: e.target.value }))}
              placeholder="50"
            />
            {budgDays > 0 && (
              <p className="text-xs text-muted-foreground">
                = {budgHours}h &nbsp;|&nbsp; {fmt(budgValue)} total
              </p>
            )}
          </div>
          {employees.length > 0 && (
            <div className="space-y-1.5">
              <Label>Assign Employees <span className="text-muted-foreground">(optional)</span></Label>
              <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                {employees.map((emp) => (
                  <label
                    key={emp.id}
                    className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={form.assignedEmployeeIds.includes(emp.id)}
                      onCheckedChange={() => toggleEmployee(emp.id)}
                    />
                    <span className="text-sm">{emp.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => onSave(form)}
            disabled={saving || !form.name.trim() || !form.dayRate}
          >
            {saving ? "Saving…" : "Save Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Sheet ─────────────────────────────────────────────────────────────────
interface Props {
  project: { id: number; name: string } | null;
  open: boolean;
  onClose: () => void;
}

export function ProjectRolesSheet({ project, open, onClose }: Props) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editRole, setEditRole] = useState<ProjectRole | null>(null);

  const rolesKey = ["project-roles", project?.id];
  const budgetKey = ["project-budget", project?.id];
  const allocKey = ["project-allocations", project?.id];

  const { data: roles = [], isLoading: rolesLoading } = useQuery<ProjectRole[]>({
    queryKey: rolesKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${project!.id}/roles`);
      if (!res.ok) throw new Error("Failed to fetch roles");
      return res.json();
    },
    enabled: open && project != null,
  });

  const { data: budget, isLoading: budgetLoading } = useQuery<BudgetResponse>({
    queryKey: budgetKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${project!.id}/budget`);
      if (!res.ok) throw new Error("Failed to fetch budget");
      return res.json();
    },
    enabled: open && project != null,
  });

  const { data: allocations, isLoading: allocLoading } = useQuery<AllocationsResponse>({
    queryKey: allocKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${project!.id}/allocations`);
      if (!res.ok) throw new Error("Failed to fetch allocations");
      return res.json();
    },
    enabled: open && project != null,
  });

  const { data: employees = [] } = useListEmployees({ includeInactive: false });
  const activeEmployees = (employees as { id: number; name: string }[]).map((e) => ({
    id: e.id,
    name: e.name,
  }));

  function invalidate() {
    qc.invalidateQueries({ queryKey: rolesKey });
    qc.invalidateQueries({ queryKey: budgetKey });
    qc.invalidateQueries({ queryKey: allocKey });
  }

  const createRole = useMutation({
    mutationFn: async (data: RoleFormState) => {
      const res = await fetch(`/api/projects/${project!.id}/roles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name.trim(),
          dayRate: parseFloat(data.dayRate),
          budgetedDays: data.budgetedDays ? parseFloat(data.budgetedDays) : null,
          budgetedHours: data.budgetedDays ? parseFloat(data.budgetedDays) * 8 : null,
          assignedEmployeeIds: data.assignedEmployeeIds,
        }),
      });
      if (!res.ok) throw new Error("Failed to create role");
      return res.json();
    },
    onSuccess: () => { invalidate(); setAddOpen(false); },
  });

  const updateRole = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: RoleFormState }) => {
      const res = await fetch(`/api/project-roles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.name.trim(),
          dayRate: parseFloat(data.dayRate),
          budgetedDays: data.budgetedDays ? parseFloat(data.budgetedDays) : null,
          budgetedHours: data.budgetedDays ? parseFloat(data.budgetedDays) * 8 : null,
          assignedEmployeeIds: data.assignedEmployeeIds,
        }),
      });
      if (!res.ok) throw new Error("Failed to update role");
      return res.json();
    },
    onSuccess: () => { invalidate(); setEditRole(null); },
  });

  const deleteRole = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/project-roles/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete role");
    },
    onSuccess: () => invalidate(),
  });

  // Totals for roles tab footer
  const totalBudgetDays = roles.reduce((s, r) => s + (r.budgetedDays ?? 0), 0);
  const totalBudgetValue = roles.reduce((s, r) => s + (r.budgetedDays ?? 0) * r.dayRate, 0);

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto flex flex-col">
          <SheetHeader className="pb-2 border-b">
            <SheetTitle className="text-lg">{project?.name ?? ""}</SheetTitle>
          </SheetHeader>

          <Tabs defaultValue="roles" className="flex-1 flex flex-col pt-4">
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="roles">Roles</TabsTrigger>
              <TabsTrigger value="budget">Budget</TabsTrigger>
              <TabsTrigger value="allocations">Allocations</TabsTrigger>
            </TabsList>

            {/* ── ROLES TAB ─────────────────────────────────────────────────── */}
            <TabsContent value="roles" className="flex-1 flex flex-col space-y-4">
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4 mr-1.5" /> Add Role
                </Button>
              </div>

              {rolesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : roles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">
                  No roles defined yet. Add a role to get started.
                </p>
              ) : (
                <>
                  <div className="border rounded-md overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Role</TableHead>
                          <TableHead className="text-right">Day Rate</TableHead>
                          <TableHead className="text-right">Budget</TableHead>
                          <TableHead>Assigned</TableHead>
                          <TableHead className="w-[80px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {roles.map((role) => (
                          <TableRow key={role.id}>
                            <TableCell className="font-medium">{role.name}</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {fmt(role.dayRate)}
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {role.budgetedDays != null
                                ? `${fmtDays(role.budgetedDays)} (${role.budgetedDays * 8}h)`
                                : "—"}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {role.assignedEmployees.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">—</span>
                                ) : (
                                  role.assignedEmployees.map((a) => (
                                    <Badge key={a.employeeId} variant="secondary" className="text-xs font-normal">
                                      {a.employeeName ?? `#${a.employeeId}`}
                                    </Badge>
                                  ))
                                )}
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => setEditRole(role)}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive hover:text-destructive"
                                  onClick={() => {
                                    if (confirm(`Delete role "${role.name}"?`)) {
                                      deleteRole.mutate(role.id);
                                    }
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {totalBudgetDays > 0 && (
                    <div className="text-sm text-muted-foreground text-right">
                      Total: {fmtDays(totalBudgetDays)} &nbsp;|&nbsp; {fmt(totalBudgetValue)}
                    </div>
                  )}
                </>
              )}
            </TabsContent>

            {/* ── BUDGET TAB ────────────────────────────────────────────────── */}
            <TabsContent value="budget" className="flex-1 space-y-4">
              {budgetLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : !budget || budget.roles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">
                  No roles defined. Add roles to track budget.
                </p>
              ) : (
                <>
                  <div className="border rounded-md overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Role</TableHead>
                          <TableHead className="text-right">
                            <span className="inline-flex items-center gap-1">Budget
                              <Info className="h-3 w-3 text-muted-foreground/60" aria-label="Budget info" role="img">
                                <title>Days budgeted for this role (× day rate = value). Identity: Budget = Logged + Re-plannable + Unplanned.</title>
                              </Info></span>
                          </TableHead>
                          <TableHead className="text-right">
                            <span className="inline-flex items-center gap-1">Invoiced
                              <Info className="h-3 w-3 text-muted-foreground/60" aria-label="Invoiced info" role="img">
                                <title>Delivered work already billed. A billing overlay — it never changes how much you can book.</title>
                              </Info></span>
                          </TableHead>
                          <TableHead className="text-right">
                            <span className="inline-flex items-center gap-1">Re-plannable
                              <Info className="h-3 w-3 text-muted-foreground/60" aria-label="Re-plannable info" role="img">
                                <title>Booked future work not yet delivered (from today onwards). Committed but movable. Past undelivered plan is flagged as stale instead.</title>
                              </Info></span>
                          </TableHead>
                          <TableHead className="text-right">
                            <span className="inline-flex items-center gap-1">Unplanned
                              <Info className="h-3 w-3 text-muted-foreground/60" aria-label="Unplanned info" role="img">
                                <title>Budget − Logged − Re-plannable. THE number to book against. Negative = over-committed.</title>
                              </Info></span>
                          </TableHead>
                          <TableHead className="text-right">
                            <span className="inline-flex items-center gap-1">Free (not logged)
                              <Info className="h-3 w-3 text-muted-foreground/60" aria-label="Free info" role="img">
                                <title>Budget − Logged. Work left to deliver, ignoring future bookings — a burn indicator, not booking capacity.</title>
                              </Info></span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {budget.roles.map((role) => (
                          <TableRow key={role.id}>
                            <TableCell className="font-medium">{role.name}</TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {role.budgetedDays != null ? fmtDays(role.budgetedDays) : "—"}
                              {role.budgetValue != null && (
                                <div className="text-xs text-muted-foreground/70">{fmt(role.budgetValue)}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <span className="text-foreground">{fmtDays(role.invoicedDays)}</span>
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              <span className="text-blue-600 dark:text-blue-400">{fmtDays(role.reservedDays)}</span>
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {role.unplannedDays != null ? (
                                <span className={role.unplannedDays < 0 ? "text-destructive font-medium" : "text-muted-foreground"}>
                                  {fmtDays(role.unplannedDays)}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {role.freeDays != null ? (
                                <span className={role.freeDays < 0 ? "text-destructive font-medium" : "text-green-700 dark:text-green-400"}>
                                  {fmtDays(role.freeDays)}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Stacked-bar identity visualisation per role.
                      Four segments: Invoiced + Logged (not invoiced) + Re-plannable
                      + Unplanned. When consumption + commitments exceed the budget,
                      the bar fills completely, a red overflow segment shows the
                      overrun, and a tick marks where the budget ends — so an
                      over-committed role can never look like open capacity. */}
                  <div className="space-y-3">
                    {budget.roles.filter((r) => r.budgetedDays != null && r.budgetedDays > 0).map((role) => {
                      const b = role.budgetedDays!;
                      const invoiced = Math.max(0, role.invoicedDays);
                      const delivered = Math.max(0, role.loggedNotInvoicedDays); // logged, not yet invoiced
                      const committed = Math.max(0, role.reservedDays);
                      const used = invoiced + delivered + committed;
                      const over = Math.max(0, Math.round((used - b) * 10) / 10);
                      const unplanned = Math.max(0, role.unplannedDays ?? 0);
                      const scale = Math.max(b, used); // over-budget bars extend past the budget tick
                      const pct = (v: number) => (v / scale) * 100;
                      return (
                        <div key={role.id} className="space-y-1">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{role.name}</span>
                            {over > 0 ? (
                              <span className="font-medium text-destructive">over by {fmtDays(over)} · {fmtDays(b)} budget</span>
                            ) : (
                              <span>{fmtDays(b)} budget</span>
                            )}
                          </div>
                          <div className="relative flex h-3 rounded-full overflow-hidden bg-muted">
                            {invoiced > 0 && (
                              <div
                                title={`Invoiced: ${fmtDays(invoiced)}`}
                                style={{ width: `${pct(invoiced)}%` }}
                                className="bg-green-500 dark:bg-green-600"
                              />
                            )}
                            {delivered > 0 && (
                              <div
                                title={`Logged, not invoiced: ${fmtDays(delivered)}`}
                                style={{ width: `${pct(delivered)}%` }}
                                className="bg-amber-400 dark:bg-amber-500"
                              />
                            )}
                            {committed > 0 && (
                              <div
                                title={`Re-plannable: ${fmtDays(committed)}`}
                                style={{ width: `${pct(committed)}%` }}
                                className="bg-blue-400 dark:bg-blue-500"
                              />
                            )}
                            {over > 0 ? (
                              <>
                                <div
                                  title={`Over budget: ${fmtDays(over)}`}
                                  style={{ width: `${pct(over)}%` }}
                                  className="bg-red-500 dark:bg-red-600"
                                />
                                {/* budget boundary tick */}
                                <div
                                  aria-hidden
                                  className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-foreground/70"
                                  style={{ left: `${pct(b)}%` }}
                                  title={`Budget: ${fmtDays(b)}`}
                                />
                              </>
                            ) : (
                              unplanned > 0 && (
                                <div
                                  title={`Unplanned: ${fmtDays(unplanned)}`}
                                  style={{ width: `${pct(unplanned)}%` }}
                                  className="bg-muted-foreground/20"
                                />
                              )
                            )}
                          </div>
                          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                            <span><span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1" />Invoiced {fmtDays(invoiced)}</span>
                            <span><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1" />Logged (not invoiced) {fmtDays(delivered)}</span>
                            <span><span className="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1" />Re-plannable {fmtDays(committed)}</span>
                            {over > 0 ? (
                              <span className="font-medium text-destructive"><span className="inline-block w-2 h-2 rounded-full bg-red-500 mr-1" />Over by {fmtDays(over)}</span>
                            ) : (
                              role.unplannedDays != null && <span>Unplanned {fmtDays(role.unplannedDays)}</span>
                            )}
                            {(role.stalePlanDays ?? 0) > 0.05 && (
                              <span className="font-medium text-amber-700 dark:text-amber-400" title="Booked days before today that were never delivered. Not counted against the budget — release or re-plan them.">
                                ⚠ Stale plan {fmtDays(role.stalePlanDays!)}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Totals summary card */}
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3">
                    <div className="font-semibold text-foreground">Project Total</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <div className="text-xs text-muted-foreground">Budget</div>
                        <div className="font-medium">{fmtDays(budget.totals.budgetedDays)}</div>
                        <div className="text-xs text-muted-foreground">{fmt(budget.totals.budgetValue)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Invoiced</div>
                        <div className="font-medium text-green-700 dark:text-green-400">{fmtDays(budget.totals.invoicedDays)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Re-plannable</div>
                        <div className="font-medium text-blue-600 dark:text-blue-400">{fmtDays(budget.totals.reservedDays)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Unplanned</div>
                        <div className={`font-medium ${budget.totals.unplannedDays < 0 ? "text-destructive" : ""}`}>{fmtDays(budget.totals.unplannedDays)}</div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 border-t pt-2">
                      <div>
                        <div className="text-xs text-muted-foreground">Logged total</div>
                        <div className="font-medium">{fmtDays(budget.totals.bookedHours / 8)}</div>
                        <div className="text-xs text-muted-foreground">{fmt(budget.totals.bookedValue)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Free (not logged)</div>
                        <div className="font-medium text-green-600 dark:text-green-400">{fmtDays(budget.totals.freeDays)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Remaining budget</div>
                        <div className="font-medium">{fmtDays(budget.totals.remainingBudgetDays)}</div>
                      </div>
                      {(budget.totals.stalePlanDays ?? 0) > 0.05 && (
                        <div title="Booked days before today that were never delivered. Not counted against the budget — release or re-plan them.">
                          <div className="text-xs text-amber-700 dark:text-amber-400">⚠ Stale plan</div>
                          <div className="font-medium text-amber-700 dark:text-amber-400">{fmtDays(budget.totals.stalePlanDays!)}</div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </TabsContent>

            {/* ── ALLOCATIONS TAB ───────────────────────────────────────────── */}
            <TabsContent value="allocations" className="flex-1 space-y-4">
              {allocLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-20 w-full" />
                  ))}
                </div>
              ) : !allocations || allocations.roles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">
                  No roles defined. Add roles to track allocations.
                </p>
              ) : (
                <>
                  <div className="space-y-5">
                    {allocations.roles.map((role) => {
                      return (
                        <div key={role.roleId} className="border rounded-md overflow-hidden">
                          {/* Role header summary — four canonical buckets */}
                          <div className="bg-muted/40 px-4 py-2.5 border-b">
                            <div className="font-semibold text-sm text-foreground">{role.roleName}</div>
                            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                              <span>Budget: <span className="text-foreground">{role.budgetedDays != null ? fmtDays(role.budgetedDays) : "—"}</span></span>
                              <span>Invoiced: <span className="text-green-700 dark:text-green-400 font-medium">{fmtDays(role.invoicedDays)}</span></span>
                              <span>Re-plannable: <span className="text-blue-600 dark:text-blue-400 font-medium">{fmtDays(role.reservedDays)}</span></span>
                              {role.unplannedDays != null && (
                                <span>Unplanned: <span className={`font-medium ${role.unplannedDays < 0 ? "text-destructive" : "text-foreground"}`}>{fmtDays(role.unplannedDays)}</span></span>
                              )}
                              {(role.stalePlanDays ?? 0) > 0.05 && (
                                <span title="Booked days before today that were never delivered — release or re-plan.">Stale: <span className="font-medium text-amber-700 dark:text-amber-400">{fmtDays(role.stalePlanDays!)}</span></span>
                              )}
                            </div>
                          </div>

                          {role.allocations.length === 0 ? (
                            <p className="text-xs text-muted-foreground px-4 py-3">(No allocations yet)</p>
                          ) : (
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Employee</TableHead>
                                  <TableHead className="text-right">Planned</TableHead>
                                  <TableHead>Period</TableHead>
                                  <TableHead className="text-right">Logged</TableHead>
                                  <TableHead className="min-w-[120px]">Logged vs planned</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {role.allocations.map((a) => {
                                  const pct = a.allocatedDays > 0 ? a.bookedDays / a.allocatedDays : 0;
                                  const pctClamped = Math.min(pct * 100, 100);
                                  const isOver = pct > 1;
                                  const isWarn = pct >= 0.8;
                                  return (
                                    <TableRow key={a.employeeId}>
                                      <TableCell className="font-medium text-sm">{a.employeeName}</TableCell>
                                      <TableCell className="text-right text-sm">{fmtDays(a.allocatedDays)}</TableCell>
                                      <TableCell className="text-sm text-muted-foreground">
                                        {a.period
                                          ? `${format(parseISO(a.period.start), "MMM d")} – ${format(parseISO(a.period.end), "MMM d, yyyy")}`
                                          : "—"}
                                      </TableCell>
                                      <TableCell className="text-right text-sm">{fmtDays(a.bookedDays)}</TableCell>
                                      <TableCell>
                                        <div className="flex items-center gap-2 min-w-[100px]">
                                          <Progress
                                            value={pctClamped}
                                            className={`h-2 flex-1 ${isOver ? "[&>div]:bg-destructive" : isWarn ? "[&>div]:bg-yellow-500" : "[&>div]:bg-green-500"}`}
                                          />
                                          <span className={`text-xs font-medium ${isOver ? "text-destructive" : isWarn ? "text-yellow-600" : "text-green-600"}`}>
                                            {a.percentage}%
                                          </span>
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Totals footer */}
                  <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-3">
                    <div className="font-semibold text-foreground">Project Total</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div>
                        <div className="text-xs text-muted-foreground">Budget</div>
                        <div className="font-medium">{fmtDays(allocations.totals.budgetedDays)}</div>
                        <div className="text-xs text-muted-foreground">{fmt(allocations.totals.budgetValue)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Invoiced</div>
                        <div className="font-medium text-green-700 dark:text-green-400">{fmtDays(allocations.totals.invoicedDays)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Re-plannable</div>
                        <div className="font-medium text-blue-600 dark:text-blue-400">{fmtDays(allocations.totals.reservedDays)}</div>
                      </div>
                      <div>
                        <div className="text-xs text-muted-foreground">Unplanned</div>
                        <div className={`font-medium ${allocations.totals.unplannedDays < 0 ? "text-destructive" : ""}`}>{fmtDays(allocations.totals.unplannedDays)}</div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </TabsContent>
          </Tabs>
        </SheetContent>
      </Sheet>

      {/* Add Role Modal */}
      <RoleModal
        open={addOpen}
        title="Add Role"
        initial={{ name: "", dayRate: "", budgetedDays: "", assignedEmployeeIds: [] }}
        employees={activeEmployees}
        onClose={() => setAddOpen(false)}
        onSave={(data) => createRole.mutate(data)}
        saving={createRole.isPending}
      />

      {/* Edit Role Modal */}
      <RoleModal
        open={editRole != null}
        title="Edit Role"
        initial={
          editRole
            ? {
                name: editRole.name,
                dayRate: String(editRole.dayRate),
                budgetedDays: editRole.budgetedDays != null ? String(editRole.budgetedDays) : "",
                assignedEmployeeIds: editRole.assignedEmployees.map((a) => a.employeeId),
              }
            : { name: "", dayRate: "", budgetedDays: "", assignedEmployeeIds: [] }
        }
        employees={activeEmployees}
        onClose={() => setEditRole(null)}
        onSave={(data) => updateRole.mutate({ id: editRole!.id, data })}
        saving={updateRole.isPending}
      />
    </>
  );
}
