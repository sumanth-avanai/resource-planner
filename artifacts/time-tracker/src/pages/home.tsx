import { useState } from "react";
import { useLocation } from "wouter";
import { AdminLayout } from "@/components/layout/admin-layout";
import {
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useCreateEmployee,
  useCreateClient,
  useCreateProject,
  useListClients,
  getListEmployeesQueryKey,
  getListClientsQueryKey,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Clock, FolderKanban, Users, BarChart3, CalendarRange, Plus, Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useDirtyGuard } from "@/contexts/dirty-guard";

export default function Home() {
  const [, navigate] = useLocation();
  const { guardNavigate } = useDirtyGuard();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [showNewProject, setShowNewProject]   = useState(false);
  const [showNewEmployee, setShowNewEmployee] = useState(false);
  const [showNewClient, setShowNewClient]     = useState(false);

  const { data: summary, isLoading } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() },
  });

  const { data: clientsData } = useListClients(
    { includeInactive: false },
    { query: { queryKey: getListClientsQueryKey({ includeInactive: false }) } }
  );
  const clients = Array.isArray(clientsData) ? clientsData : [];

  const createEmployee = useCreateEmployee();
  const createClient   = useCreateClient();
  const createProject  = useCreateProject();

  const today = new Date();

  const stats = [
    { label: "Active Employees",        value: summary?.employeeSummaries?.length ?? 0,                                          icon: Users,        color: "text-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-950/30" },
    { label: "Hours Logged This Week",  value: summary?.totalBookedHours   != null ? `${summary.totalBookedHours}h`   : "—",    icon: Clock,        color: "text-violet-500",  bg: "bg-violet-50 dark:bg-violet-950/30" },
    { label: "Billable This Week",      value: summary?.billableBookedHours != null ? `${summary.billableBookedHours}h` : "—",  icon: BarChart3,    color: "text-amber-500",   bg: "bg-amber-50 dark:bg-amber-950/30" },
    { label: "Week",                    value: (summary?.weekStartDate && summary?.weekEndDate) ? format(new Date(summary.weekStartDate), "MMM d") + " – " + format(new Date(summary.weekEndDate), "MMM d") : "—", icon: FolderKanban, color: "text-blue-500", bg: "bg-blue-50 dark:bg-blue-950/30" },
  ];

  function handleCreateEmployee(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createEmployee.mutate(
      {
        data: {
          name:                fd.get("name") as string,
          email:               (fd.get("email") as string) || null,
          weeklyCapacityHours: Number(fd.get("weeklyCapacityHours") || 40),
          contractStartDate:   (fd.get("contractStartDate") as string) || null,
          contractEndDate:     null,
          active:              true,
          workingDaysMask:     [1, 1, 1, 1, 1, 0, 0],
          pin:                 fd.get("pin") as string,
        } as Parameters<typeof createEmployee.mutate>[0]["data"],
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListEmployeesQueryKey({ includeInactive: true }) });
          setShowNewEmployee(false);
          toast({ title: "Employee created" });
        },
        onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
      }
    );
  }

  function handleCreateClient(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createClient.mutate(
      { data: { name: fd.get("name") as string, notes: (fd.get("notes") as string) || null, active: true } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListClientsQueryKey({ includeInactive: true }) });
          setShowNewClient(false);
          toast({ title: "Client created" });
        },
        onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
      }
    );
  }

  function handleCreateProject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const clientId = fd.get("clientId") as string;
    createProject.mutate(
      {
        data: {
          name:       fd.get("name") as string,
          clientId:   (clientId && clientId !== "none") ? parseInt(clientId, 10) : null,
          status:     "active",
          budgetType: "fixed",
        } as Parameters<typeof createProject.mutate>[0]["data"],
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: false }) });
          setShowNewProject(false);
          toast({ title: "Project created" });
          guardNavigate(() => navigate("/projects"));
        },
        onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
      }
    );
  }

  const actions = [
    {
      label: "Book Time",
      description: "Log hours on the timesheet",
      icon: Clock,
      onClick: () => guardNavigate(() => navigate("/timesheet")),
    },
    {
      label: "Plan Resources",
      description: "View and manage team allocations",
      icon: CalendarRange,
      onClick: () => guardNavigate(() => navigate("/resource-planner")),
    },
    {
      label: "New Project",
      description: "Create a new project",
      icon: FolderKanban,
      onClick: () => setShowNewProject(true),
    },
    {
      label: "Create Report",
      description: "View time and budget reports",
      icon: BarChart3,
      onClick: () => guardNavigate(() => navigate("/reports")),
    },
    {
      label: "New Employee",
      description: "Add a team member",
      icon: Users,
      onClick: () => setShowNewEmployee(true),
    },
    {
      label: "New Client",
      description: "Add a new client",
      icon: Briefcase,
      onClick: () => setShowNewClient(true),
    },
  ];

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-5xl mx-auto">
        {/* Header with date */}
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Home</h1>
          <p className="text-muted-foreground text-xs mt-0.5">
            {format(today, "EEEE, MMMM d, yyyy")}
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stats.map((s) => (
            <div key={s.label} className="bg-card border border-border rounded-md p-3 space-y-1.5">
              <div className={`inline-flex items-center justify-center h-7 w-7 rounded-md ${s.bg}`}>
                <s.icon className={`h-3.5 w-3.5 ${s.color}`} />
              </div>
              {isLoading ? (
                <Skeleton className="h-6 w-14" />
              ) : (
                <div className="text-xl font-bold tabular-nums">{s.value}</div>
              )}
              <div className="text-xs text-muted-foreground leading-tight">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Quick Actions */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Quick Actions</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {actions.map((action) => (
              <button
                key={action.label}
                onClick={action.onClick}
                className="flex items-center gap-3 bg-card border border-border rounded-md p-3 text-left hover:border-primary/50 hover:shadow-sm transition-all group"
              >
                <div className="flex-shrink-0 h-8 w-8 rounded-md bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                  <action.icon className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-foreground">{action.label}</div>
                  <div className="text-xs text-muted-foreground truncate">{action.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* New Project Dialog */}
      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Project</DialogTitle></DialogHeader>
          <form onSubmit={handleCreateProject} className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="proj-name">Project Name <span className="text-destructive">*</span></Label>
              <Input id="proj-name" name="name" required placeholder="Website Redesign" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="proj-client">Client</Label>
              <Select name="clientId">
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {clients.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewProject(false)}>Cancel</Button>
              <Button type="submit" disabled={createProject.isPending}>
                {createProject.isPending ? "Creating..." : "Create Project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* New Employee Dialog */}
      <Dialog open={showNewEmployee} onOpenChange={setShowNewEmployee}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Employee</DialogTitle></DialogHeader>
          <form onSubmit={handleCreateEmployee} className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="emp-name">Name <span className="text-destructive">*</span></Label>
              <Input id="emp-name" name="name" required placeholder="Jane Doe" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emp-email">Email</Label>
              <Input id="emp-email" name="email" type="email" placeholder="jane@example.com" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="emp-capacity">Weekly Capacity (hrs)</Label>
                <Input id="emp-capacity" name="weeklyCapacityHours" type="number" defaultValue="40" min="1" max="60" step="0.5" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="emp-pin">PIN (4 digits) <span className="text-destructive">*</span></Label>
                <Input id="emp-pin" name="pin" required pattern="\d{4}" placeholder="1234" maxLength={4} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="emp-start">Contract Start <span className="text-destructive">*</span></Label>
              <Input id="emp-start" name="contractStartDate" type="date" required />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewEmployee(false)}>Cancel</Button>
              <Button type="submit" disabled={createEmployee.isPending}>
                {createEmployee.isPending ? "Creating..." : "Create Employee"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* New Client Dialog */}
      <Dialog open={showNewClient} onOpenChange={setShowNewClient}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Client</DialogTitle></DialogHeader>
          <form onSubmit={handleCreateClient} className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="client-name">Client Name <span className="text-destructive">*</span></Label>
              <Input id="client-name" name="name" required placeholder="Acme Corp" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-notes">Notes</Label>
              <Input id="client-notes" name="notes" placeholder="Billing details, contacts…" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowNewClient(false)}>Cancel</Button>
              <Button type="submit" disabled={createClient.isPending}>
                {createClient.isPending ? "Creating..." : "Create Client"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AdminLayout>
  );
}
