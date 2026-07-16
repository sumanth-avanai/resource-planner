import { useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  useListEmployees,
  getListEmployeesQueryKey,
  useCreateEmployee,
  useUpdateEmployee,
  useDeleteEmployee,
  useListHolidayCalendars,
  getListHolidayCalendarsQueryKey,
  useResetEmployeePin,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Input }  from "@/components/ui/input";
import { Label }  from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Plus, MoreHorizontal, Pencil, Trash2, Link as LinkIcon, RefreshCw, CalendarOff,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Skeleton }  from "@/components/ui/skeleton";
import { useToast }  from "@/hooks/use-toast";
import { useLocation } from "wouter";

export default function Employees() {
  const queryClient = useQueryClient();
  const { toast }   = useToast();
  const [, navigate] = useLocation();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen,   setIsEditOpen]   = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<any>(null);

  const { data: employees, isLoading: employeesLoading } = useListEmployees(
    { includeInactive: true },
    { query: { queryKey: getListEmployeesQueryKey({ includeInactive: true }) } }
  );

  const { data: calendars } = useListHolidayCalendars({
    query: { queryKey: getListHolidayCalendarsQueryKey() },
  });

  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee();
  const deleteEmployee = useDeleteEmployee();
  const resetPin       = useResetEmployeePin();

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: getListEmployeesQueryKey({ includeInactive: true }) });

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    createEmployee.mutate(
      {
        data: {
          name:                fd.get("name") as string,
          email:               (fd.get("email") as string) || null,
          weeklyCapacityHours: Number(fd.get("weeklyCapacityHours")),
          holidayCalendarCode: (fd.get("holidayCalendarCode") as string || "") === "none" ? null : ((fd.get("holidayCalendarCode") as string) || null),
          contractStartDate:   (fd.get("contractStartDate") as string) || null,
          contractEndDate:     (fd.get("contractEndDate") as string) || null,
          utilizationTarget:   fd.get("utilizationTarget") ? Number(fd.get("utilizationTarget")) : null,
          active:              fd.get("active") === "on",
          workingDaysMask:     [1, 1, 1, 1, 1, 0, 0],
          pin:                 fd.get("pin") as string,
        } as any,
      },
      {
        onSuccess: () => { invalidateList(); setIsCreateOpen(false); toast({ title: "Employee created" }); },
      }
    );
  };

  const handleEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedEmployee) return;
    const fd = new FormData(e.currentTarget);

    updateEmployee.mutate(
      {
        id: selectedEmployee.id,
        data: {
          name:                fd.get("name") as string,
          email:               (fd.get("email") as string) || null,
          weeklyCapacityHours: Number(fd.get("weeklyCapacityHours")),
          holidayCalendarCode: (fd.get("holidayCalendarCode") as string || "") === "none" ? null : ((fd.get("holidayCalendarCode") as string) || null),
          contractStartDate:   (fd.get("contractStartDate") as string) || null,
          contractEndDate:     (fd.get("contractEndDate") as string) || null,
          utilizationTarget:   fd.get("utilizationTarget") ? Number(fd.get("utilizationTarget")) : null,
          active:              fd.get("active") === "on",
        } as any,
      },
      {
        onSuccess: () => { invalidateList(); setIsEditOpen(false); toast({ title: "Employee updated" }); },
      }
    );
  };

  const handleToggleActive = (id: number, currentActive: boolean) => {
    updateEmployee.mutate(
      { id, data: { active: !currentActive } },
      { onSuccess: invalidateList }
    );
  };

  const handleDelete = (id: number) => {
    if (confirm("Delete this employee? This action cannot be undone.")) {
      deleteEmployee.mutate({ id }, { onSuccess: invalidateList });
    }
  };

  const handleResetPin = (id: number) => {
    const pin = prompt("Enter a new 4-digit PIN:");
    if (pin && /^\d{4}$/.test(pin)) {
      resetPin.mutate({ id, data: { pin } }, { onSuccess: () => toast({ title: "PIN reset successfully" }) });
    } else if (pin) {
      toast({ title: "Invalid PIN", description: "Must be 4 digits", variant: "destructive" });
    }
  };

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/u/${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Personal link copied" });
  };

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Employees</h1>

          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Employee</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>Add New Employee</DialogTitle></DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="name">Name <span className="text-destructive">*</span></Label>
                    <Input id="name" name="name" required placeholder="Jane Doe" />
                  </div>
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" name="email" type="email" placeholder="jane@example.com" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="weeklyCapacityHours">Weekly Capacity (hrs)</Label>
                    <Input id="weeklyCapacityHours" name="weeklyCapacityHours" type="number" required defaultValue="40" min="0" max="60" step="0.5" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="holidayCalendarCode">Holiday Calendar</Label>
                    <Select name="holidayCalendarCode">
                      <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {calendars?.map((c) => (
                          <SelectItem key={c.id} value={c.code}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contractStartDate">Contract Start <span className="text-destructive">*</span></Label>
                    <Input id="contractStartDate" name="contractStartDate" type="date" required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contractEndDate">Contract End <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input id="contractEndDate" name="contractEndDate" type="date" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="utilizationTarget">Util Target % <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input id="utilizationTarget" name="utilizationTarget" type="number" min="0" max="100" placeholder="e.g. 80" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pin">Initial PIN (4 digits) <span className="text-destructive">*</span></Label>
                    <Input id="pin" name="pin" required pattern="\d{4}" placeholder="1234" maxLength={4} />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <Switch id="active" name="active" defaultChecked />
                    <Label htmlFor="active">Active</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createEmployee.isPending}>
                    {createEmployee.isPending ? "Creating..." : "Create Employee"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Employee table */}
        <div className="border rounded-md bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Capacity</TableHead>
                <TableHead>Contract Start</TableHead>
                <TableHead>Contract End</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {employeesLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : employees?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                    No employees found.
                  </TableCell>
                </TableRow>
              ) : (
                employees?.map((emp) => (
                  <TableRow key={emp.id} className={!emp.active ? "opacity-60" : ""}>
                    <TableCell className="font-semibold">{emp.name}</TableCell>
                    <TableCell className="text-muted-foreground">{emp.email || "—"}</TableCell>
                    <TableCell>{emp.weeklyCapacityHours}h/wk</TableCell>
                    <TableCell className="text-sm">{(emp as any).contractStartDate || <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-sm">{(emp as any).contractEndDate   || <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>
                      <Switch
                        checked={emp.active}
                        onCheckedChange={() => handleToggleActive(emp.id, emp.active)}
                        disabled={updateEmployee.isPending}
                      />
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-8 w-8 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => copyLink(emp.personalAccessToken)}>
                            <LinkIcon className="mr-2 h-4 w-4" /> Copy Personal Link
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleResetPin(emp.id)}>
                            <RefreshCw className="mr-2 h-4 w-4" /> Reset PIN
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => navigate(`/employees/${emp.id}`)}>
                            <CalendarOff className="mr-2 h-4 w-4" /> Manage Absences
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => { setSelectedEmployee(emp); setIsEditOpen(true); }}>
                            <Pencil className="mr-2 h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(emp.id)}>
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Edit dialog */}
        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Edit Employee</DialogTitle></DialogHeader>
            {selectedEmployee && (
              <form onSubmit={handleEdit} className="space-y-4 pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="edit-name">Name <span className="text-destructive">*</span></Label>
                    <Input id="edit-name" name="name" required defaultValue={selectedEmployee.name} />
                  </div>
                  <div className="space-y-2 col-span-2">
                    <Label htmlFor="edit-email">Email</Label>
                    <Input id="edit-email" name="email" type="email" defaultValue={selectedEmployee.email || ""} />
                  </div>
                  <div className="space-y-2">
                    <Label>Weekly Capacity (hrs)</Label>
                    <Input name="weeklyCapacityHours" type="number" required defaultValue={selectedEmployee.weeklyCapacityHours} min="0" max="60" step="0.5" />
                  </div>
                  <div className="space-y-2">
                    <Label>Holiday Calendar</Label>
                    <Select name="holidayCalendarCode" defaultValue={selectedEmployee.holidayCalendarCode || "none"}>
                      <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {calendars?.map((c) => (
                          <SelectItem key={c.id} value={c.code}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Contract Start <span className="text-destructive">*</span></Label>
                    <Input name="contractStartDate" type="date" required defaultValue={(selectedEmployee as any).contractStartDate || ""} />
                  </div>
                  <div className="space-y-2">
                    <Label>Contract End <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input name="contractEndDate" type="date" defaultValue={(selectedEmployee as any).contractEndDate || ""} />
                  </div>
                  <div className="space-y-2">
                    <Label>Util Target % <span className="text-muted-foreground text-xs">(optional)</span></Label>
                    <Input name="utilizationTarget" type="number" min="0" max="100" placeholder="e.g. 80" defaultValue={(selectedEmployee as any).utilizationTarget ?? ""} />
                  </div>
                  <div className="flex items-center gap-2 col-span-2 pt-1">
                    <Switch id="edit-active" name="active" defaultChecked={selectedEmployee.active} />
                    <Label htmlFor="edit-active">Active</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={updateEmployee.isPending}>
                    {updateEmployee.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
