import { useState, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  useListEmployees,
  useListHolidayCalendars,
  getListHolidayCalendarsQueryKey,
  getListEmployeesQueryKey,
} from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

interface Vacation {
  id: number;
  employeeId: number;
  startDate: string;
  endDate: string;
  vacationType: string;
  note: string | null;
  createdAt: string;
}

type VacationType = "vacation" | "sick" | "unpaid_leave" | "other";

const TYPE_LABELS: Record<VacationType, string> = {
  vacation: "Vacation",
  sick: "Sick Leave",
  unpaid_leave: "Unpaid Leave",
  other: "Other",
};

const TYPE_COLORS: Record<VacationType, string> = {
  vacation: "bg-blue-100 text-blue-800",
  sick: "bg-amber-100 text-amber-800",
  unpaid_leave: "bg-red-100 text-red-800",
  other: "bg-gray-100 text-gray-700",
};

async function fetchVacations(employeeId: number): Promise<Vacation[]> {
  const res = await fetch(`/api/vacations?employeeId=${employeeId}`);
  if (!res.ok) throw new Error("Failed to load vacations");
  return res.json();
}

async function createVacation(data: Omit<Vacation, "id" | "createdAt">): Promise<Vacation> {
  const res = await fetch("/api/vacations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function updateVacation(id: number, data: Partial<Omit<Vacation, "id" | "employeeId" | "createdAt">>): Promise<Vacation> {
  const res = await fetch(`/api/vacations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function deleteVacation(id: number): Promise<void> {
  const res = await fetch(`/api/vacations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete");
}

const emptyForm = {
  startDate: "",
  endDate: "",
  vacationType: "vacation" as VacationType,
  note: "",
};

export default function EmployeeDetail() {
  const params = useParams<{ id: string }>();
  const employeeId = parseInt(params.id, 10);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: employees = [], isLoading: empLoading } = useListEmployees(
    { includeInactive: true },
    { query: { queryKey: getListEmployeesQueryKey({ includeInactive: true }) } }
  );
  const { data: calendars } = useListHolidayCalendars({
    query: { queryKey: getListHolidayCalendarsQueryKey() },
  });

  const employee = employees.find((e) => e.id === employeeId);

  const vacationsKey = ["vacations", employeeId];
  const { data: vacations = [], isLoading: vacsLoading } = useQuery<Vacation[]>({
    queryKey: vacationsKey,
    queryFn: () => fetchVacations(employeeId),
    enabled: !!employeeId && !isNaN(employeeId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["vacations"] });

  const createMut = useMutation({
    mutationFn: (data: Omit<Vacation, "id" | "createdAt">) => createVacation(data),
    onSuccess: () => { invalidate(); close(); toast({ title: "Absence entry created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateVacation>[1] }) => updateVacation(id, data),
    onSuccess: () => { invalidate(); close(); toast({ title: "Absence entry updated" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: deleteVacation,
    onSuccess: () => { invalidate(); toast({ title: "Absence entry deleted" }); },
  });

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setIsDialogOpen(true);
  }

  function openEdit(v: Vacation) {
    setEditingId(v.id);
    setForm({
      startDate: v.startDate,
      endDate: v.endDate,
      vacationType: v.vacationType as VacationType,
      note: v.note ?? "",
    });
    setIsDialogOpen(true);
  }

  function close() { setIsDialogOpen(false); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.startDate || !form.endDate) {
      toast({ title: "Please fill all required fields", variant: "destructive" });
      return;
    }
    const payload = {
      employeeId,
      startDate: form.startDate,
      endDate: form.endDate,
      vacationType: form.vacationType,
      note: form.note || null,
    };
    if (editingId !== null) {
      updateMut.mutate({ id: editingId, data: payload });
    } else {
      createMut.mutate(payload);
    }
  }

  function fmtDate(d: string) {
    try { return format(parseISO(d), "dd MMM yyyy"); } catch { return d; }
  }

  function dayCount(start: string, end: string): number {
    try {
      const s = parseISO(start);
      const e = parseISO(end);
      return Math.round((e.getTime() - s.getTime()) / 86400000) + 1;
    } catch { return 0; }
  }

  const calendarName = useMemo(() => {
    if (!employee || !employee.holidayCalendarCode) return "—";
    return calendars?.find((c) => c.code === employee.holidayCalendarCode)?.name ?? employee.holidayCalendarCode;
  }, [employee, calendars]);

  if (!empLoading && !employee) {
    return (
      <AdminLayout>
        <div className="max-w-4xl mx-auto space-y-4">
          <Button variant="ghost" onClick={() => navigate("/employees")} className="gap-2">
            <ArrowLeft className="h-4 w-4" /> Back to Employees
          </Button>
          <p className="text-muted-foreground">Employee not found.</p>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/employees")} className="gap-2">
            <ArrowLeft className="h-4 w-4" /> Employees
          </Button>
        </div>

        {empLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{employee?.name}</h1>
              {employee && !employee.active && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border">Inactive</span>
              )}
            </div>
            <p className="text-muted-foreground text-sm mt-1">{employee?.email || "No email on file"}</p>
          </div>
        )}

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="vacations">Vacations</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-6">
            {empLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 rounded-lg" />
                ))}
              </div>
            ) : employee ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {[
                  { label: "Weekly Capacity", value: `${employee.weeklyCapacityHours}h / week` },
                  { label: "Holiday Calendar", value: calendarName },
                  { label: "Contract Start", value: employee.contractStartDate || "—" },
                  { label: "Contract End", value: employee.contractEndDate || "—" },
                  { label: "Utilization Target", value: (employee as any).utilizationTarget != null ? `${(employee as any).utilizationTarget}%` : "—" },
                  { label: "Status", value: employee.active ? "Active" : "Inactive" },
                ].map((item) => (
                  <div key={item.label} className="bg-card border border-border rounded-lg p-4">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{item.label}</div>
                    <div className="font-medium text-sm">{item.value}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="vacations" className="mt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Absence Entries</h2>
                <Button onClick={openCreate} size="sm">
                  <Plus className="h-4 w-4 mr-2" /> Add Absence
                </Button>
              </div>

              <div className="border rounded-md bg-card overflow-hidden">
                <Table>
                  <TableHeader className="bg-muted/30">
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Start</TableHead>
                      <TableHead>End</TableHead>
                      <TableHead className="text-right">Days</TableHead>
                      <TableHead>Note</TableHead>
                      <TableHead className="w-[90px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vacsLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}>
                          {Array.from({ length: 6 }).map((_, j) => (
                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : vacations.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                          No absence entries recorded.
                        </TableCell>
                      </TableRow>
                    ) : (
                      vacations.map((v) => (
                        <TableRow key={v.id}>
                          <TableCell>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[v.vacationType as VacationType] ?? "bg-gray-100 text-gray-700"}`}>
                              {TYPE_LABELS[v.vacationType as VacationType] ?? v.vacationType}
                            </span>
                          </TableCell>
                          <TableCell>{fmtDate(v.startDate)}</TableCell>
                          <TableCell>{fmtDate(v.endDate)}</TableCell>
                          <TableCell className="text-right tabular-nums">{dayCount(v.startDate, v.endDate)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm truncate max-w-[200px]">{v.note ?? "—"}</TableCell>
                          <TableCell>
                            <div className="flex gap-1 justify-end">
                              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(v)}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive"
                                onClick={() => { if (confirm("Delete this absence entry?")) deleteMut.mutate(v.id); }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId !== null ? "Edit Absence Entry" : "Add Absence Entry"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Type <span className="text-destructive">*</span></Label>
              <Select
                value={form.vacationType}
                onValueChange={(v) => setForm((f) => ({ ...f, vacationType: v as VacationType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(TYPE_LABELS) as [VacationType, string][]).map(([k, label]) => (
                    <SelectItem key={k} value={k}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start Date <span className="text-destructive">*</span></Label>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>End Date <span className="text-destructive">*</span></Label>
                <Input
                  type="date"
                  value={form.endDate}
                  min={form.startDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Note</Label>
              <Textarea
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="Optional note..."
                className="resize-none h-20"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                {(createMut.isPending || updateMut.isPending) ? "Saving..." : editingId !== null ? "Save Changes" : "Add Entry"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
