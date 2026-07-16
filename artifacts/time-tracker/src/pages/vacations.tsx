import { useState, useMemo } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { useListEmployees } from "@workspace/api-client-react";
import { useSearch } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button }   from "@/components/ui/button";
import { Input }    from "@/components/ui/input";
import { Label }    from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Badge }   from "@/components/ui/badge";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

// ─── Types ──────────────────────────────────────────────────────────────────

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
  vacation:     "Vacation",
  sick:         "Sick Leave",
  unpaid_leave: "Unpaid Leave",
  other:        "Other",
};

const TYPE_COLORS: Record<VacationType, string> = {
  vacation:     "bg-blue-100 text-blue-800",
  sick:         "bg-amber-100 text-amber-800",
  unpaid_leave: "bg-red-100 text-red-800",
  other:        "bg-gray-100 text-gray-700",
};

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchVacations(employeeId?: number): Promise<Vacation[]> {
  const url = employeeId ? `/api/vacations?employeeId=${employeeId}` : "/api/vacations";
  const res = await fetch(url);
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

// ─── Default form state ───────────────────────────────────────────────────────

const emptyForm = {
  employeeId:   0,
  startDate:    "",
  endDate:      "",
  vacationType: "vacation" as VacationType,
  note:         "",
};

// ─── Main component ──────────────────────────────────────────────────────────

export default function Vacations() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const search = useSearch();

  const initialEmpId = useMemo(() => {
    const params = new URLSearchParams(search);
    const v = params.get("employee");
    return v ? parseInt(v, 10) : undefined;
  }, []);

  const [filterEmpId, setFilterEmpId] = useState<number | undefined>(initialEmpId);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: employees = [] } = useListEmployees();

  const vacationsKey = ["vacations", filterEmpId];
  const { data: vacations = [], isLoading } = useQuery<Vacation[]>({
    queryKey: vacationsKey,
    queryFn: () => fetchVacations(filterEmpId),
  });

  const empMap = useMemo(
    () => new Map(employees.map((e) => [e.id, e.name])),
    [employees]
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ["vacations"] });

  const createMut = useMutation({
    mutationFn: createVacation,
    onSuccess: () => { invalidate(); close(); toast({ title: "Absence entry created" }); },
    onError:   (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateVacation>[1] }) => updateVacation(id, data),
    onSuccess: () => { invalidate(); close(); toast({ title: "Absence entry updated" }); },
    onError:   (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: deleteVacation,
    onSuccess: () => { invalidate(); toast({ title: "Absence entry deleted" }); },
  });

  function openCreate() {
    setEditingId(null);
    setForm({ ...emptyForm, employeeId: filterEmpId ?? 0 });
    setIsDialogOpen(true);
  }

  function openEdit(v: Vacation) {
    setEditingId(v.id);
    setForm({
      employeeId:   v.employeeId,
      startDate:    v.startDate,
      endDate:      v.endDate,
      vacationType: v.vacationType as VacationType,
      note:         v.note ?? "",
    });
    setIsDialogOpen(true);
  }

  function close() { setIsDialogOpen(false); }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.employeeId || !form.startDate || !form.endDate) {
      toast({ title: "Please fill all required fields", variant: "destructive" });
      return;
    }
    const payload = {
      employeeId:   form.employeeId,
      startDate:    form.startDate,
      endDate:      form.endDate,
      vacationType: form.vacationType,
      note:         form.note || null,
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

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Vacation / Absence</h1>
          <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> Add Absence</Button>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-3">
          <Label className="text-sm shrink-0">Filter by employee:</Label>
          <Select
            value={filterEmpId ? String(filterEmpId) : "all"}
            onValueChange={(v) => setFilterEmpId(v === "all" ? undefined : parseInt(v, 10))}
          >
            <SelectTrigger className="w-[220px]">
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

        {/* Table */}
        <div className="border rounded-md bg-card overflow-hidden">
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead className="text-right">Days</TableHead>
                <TableHead>Note</TableHead>
                <TableHead className="w-[90px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : vacations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    No absence entries found.
                  </TableCell>
                </TableRow>
              ) : (
                vacations.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">{empMap.get(v.employeeId) ?? `#${v.employeeId}`}</TableCell>
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

      {/* Create / Edit dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId !== null ? "Edit Absence Entry" : "Add Absence Entry"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Employee <span className="text-destructive">*</span></Label>
              <Select
                value={form.employeeId ? String(form.employeeId) : ""}
                onValueChange={(v) => setForm((f) => ({ ...f, employeeId: parseInt(v, 10) }))}
                required
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

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
