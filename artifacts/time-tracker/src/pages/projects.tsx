import { useState, useMemo, useEffect, useRef } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { 
  useListProjects, 
  getListProjectsQueryKey,
  useCreateProject,
  useUpdateProject,
  useDeleteProject,
  useListClients,
  getListClientsQueryKey,
  useCreateClient,
  useUpdateClient,
  useListEmployees,
  getListEmployeesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger,
  DialogFooter
} from "@/components/ui/dialog";
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
import { Plus, MoreHorizontal, Pencil, Trash2, Layers, ChevronDown, ChevronRight, List, LayoutList, Search } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { ProjectRolesSheet } from "@/components/projects/project-roles-sheet";
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

const DEFAULT_COLOR = "#6366f1";

const PRESET_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#3b82f6", "#ec4899",
  "#8b5cf6", "#f97316", "#14b8a6", "#ef4444", "#84cc16",
  "#06b6d4", "#a855f7", "#d946ef", "#0ea5e9", "#22c55e",
  "#fb923c", "#e11d48", "#7c3aed", "#2563eb", "#059669",
];

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className="w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            style={{
              backgroundColor: c,
              borderColor: value === c ? "white" : "transparent",
              boxShadow: value === c ? `0 0 0 2px ${c}` : "none",
            }}
            title={c}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div
          className="w-8 h-8 rounded-md border border-border flex-shrink-0"
          style={{ backgroundColor: value }}
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0"
          title="Custom color"
        />
        <Input
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v);
          }}
          className="font-mono text-sm w-28"
          maxLength={7}
          placeholder="#000000"
        />
      </div>
    </div>
  );
}

function readLocalStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

type Project = {
  id: number;
  clientId: number | null;
  clientName: string | null;
  name: string;
  code: string | null;
  active: boolean;
  isBillable: boolean;
  budgetHours: number | null;
  color: string | null;
  pmName: string | null;
  roleCount?: number | null;
  budgetDays?: number | null;
  bookedDays?: number | null;
  [key: string]: unknown;
};

type ClientGroup = {
  key: string;
  clientId: number | null;
  clientName: string | null;
  projects: Project[];
};

function BudgetProgress({ bookedDays, budgetDays }: { bookedDays?: number | null; budgetDays?: number | null }) {
  if (budgetDays == null || budgetDays === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const booked = bookedDays ?? 0;
  const pct = Math.min(100, Math.round((booked / budgetDays) * 100));
  const isOver = booked > budgetDays;
  return (
    <div className="flex flex-col gap-1 min-w-[90px]">
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {Math.round(booked * 10) / 10}d&nbsp;/&nbsp;{Math.round(budgetDays * 10) / 10}d
      </span>
      <Progress
        value={pct}
        className={`h-1.5 ${isOver ? "[&>div]:bg-destructive" : ""}`}
      />
    </div>
  );
}

function ProjectActionsMenu({
  project,
  onManageRoles,
  onEdit,
  onDelete,
  updatePending,
}: {
  project: Project;
  onManageRoles: () => void;
  onEdit: () => void;
  onDelete: () => void;
  updatePending: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onManageRoles}>
          <Layers className="mr-2 h-4 w-4" />
          Manage Roles
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function Projects() {
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [createColor, setCreateColor] = useState(DEFAULT_COLOR);
  const [editColor, setEditColor] = useState(DEFAULT_COLOR);
  const [rolesProject, setRolesProject] = useState<{ id: number; name: string } | null>(null);
  const [createPmName, setCreatePmName] = useState<string>("");
  const [editPmName, setEditPmName] = useState<string>("");

  const [view, setView] = useState<"grouped" | "flat">(() =>
    readLocalStorage("projects-view", "grouped" as "grouped" | "flat")
  );
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readLocalStorage("projects-collapsed", {} as Record<string, boolean>)
  );

  const preSearchCollapsedRef = useRef<Record<string, boolean> | null>(null);

  const [editClientOpen, setEditClientOpen] = useState(false);
  const [editingClient, setEditingClient] = useState<{ id: number; name: string } | null>(null);
  const [editClientName, setEditClientName] = useState("");

  const [isCreateClientOpen, setIsCreateClientOpen] = useState(false);

  const { data: projects, isLoading: projectsLoading } = useListProjects(
    { includeInactive: true },
    { query: { queryKey: getListProjectsQueryKey({ includeInactive: true }) } }
  );

  const { data: clients, isLoading: clientsLoading } = useListClients(
    { includeInactive: true },
    { query: { queryKey: getListClientsQueryKey({ includeInactive: true }) } }
  );

  const { data: employees } = useListEmployees(
    {},
    { query: { queryKey: getListEmployeesQueryKey({}) } }
  );

  const employeeNames = useMemo(() => {
    return (employees ?? []).map((e) => (e as { name: string }).name).filter(Boolean).sort() as string[];
  }, [employees]);

  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const createClient = useCreateClient();
  const updateClient = useUpdateClient();

  const filtered = useMemo<Project[]>(() => {
    const all = (projects as Project[] | undefined) ?? [];
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.clientName && p.clientName.toLowerCase().includes(q))
    );
  }, [projects, search]);

  const groups = useMemo<ClientGroup[]>(() => {
    const map = new Map<string, ClientGroup>();
    // Only seed empty client groups when not actively searching
    if (!search.trim()) {
      for (const c of (clients ?? [])) {
        const key = String(c.id);
        map.set(key, { key, clientId: c.id, clientName: c.name, projects: [] });
      }
    }
    for (const p of filtered) {
      const key = p.clientId != null ? String(p.clientId) : "__unassigned__";
      if (!map.has(key)) {
        map.set(key, { key, clientId: p.clientId ?? null, clientName: p.clientName ?? null, projects: [] });
      }
      map.get(key)!.projects.push(p);
    }
    return [...map.values()].sort((a, b) => {
      if (a.key === "__unassigned__") return 1;
      if (b.key === "__unassigned__") return -1;
      return (a.clientName ?? "").localeCompare(b.clientName ?? "");
    });
  }, [filtered, clients, search]);

  useEffect(() => {
    if (search.trim()) {
      setCollapsed((current) => {
        if (preSearchCollapsedRef.current === null) {
          preSearchCollapsedRef.current = current;
        }
        return {};
      });
    } else {
      if (preSearchCollapsedRef.current !== null) {
        const restore = preSearchCollapsedRef.current;
        preSearchCollapsedRef.current = null;
        setCollapsed(restore);
      }
    }
  }, [search]);

  function toggleGroup(key: string) {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    localStorage.setItem("projects-collapsed", JSON.stringify(next));
  }

  function setViewPersist(v: "grouped" | "flat") {
    setView(v);
    localStorage.setItem("projects-view", JSON.stringify(v));
  }

  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const budgetHours = formData.get("budgetHours") as string;

    createProject.mutate(
      {
        data: {
          name: formData.get("name") as string,
          clientId: Number(formData.get("clientId")),
          code: (formData.get("code") as string) || null,
          isBillable: formData.get("isBillable") === "on",
          active: formData.get("active") === "on",
          budgetHours: budgetHours ? Number(budgetHours) : null,
          color: createColor,
          pmName: createPmName && createPmName !== "__none__" ? createPmName : null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          setIsCreateOpen(false);
          setCreateColor(DEFAULT_COLOR);
          setCreatePmName("");
        },
      }
    );
  };

  const handleEdit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedProject) return;
    const formData = new FormData(e.currentTarget);
    const budgetHours = formData.get("budgetHours") as string;

    updateProject.mutate(
      {
        id: selectedProject.id,
        data: {
          name: formData.get("name") as string,
          clientId: Number(formData.get("clientId")),
          code: (formData.get("code") as string) || null,
          isBillable: formData.get("isBillable") === "on",
          active: formData.get("active") === "on",
          budgetHours: budgetHours ? Number(budgetHours) : null,
          color: editColor,
          pmName: editPmName && editPmName !== "__none__" ? editPmName : null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          setIsEditOpen(false);
        },
      }
    );
  };

  const handleToggleActive = (id: number, currentActive: boolean) => {
    updateProject.mutate(
      { id, data: { active: !currentActive } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
        },
      }
    );
  };

  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to archive this project?")) {
      deleteProject.mutate(
        { id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          },
        }
      );
    }
  };

  const handleEditClientSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingClient || !editClientName.trim()) return;
    updateClient.mutate(
      { id: editingClient.id, data: { name: editClientName.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey({ includeInactive: true }) });
          setEditClientOpen(false);
        },
      }
    );
  };

  const handleCreateClient = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createClient.mutate(
      {
        data: {
          name: formData.get("name") as string,
          notes: (formData.get("notes") as string) || undefined,
          active: formData.get("active") === "on",
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey({ includeInactive: true }) });
          queryClient.invalidateQueries({ queryKey: getListClientsQueryKey({ includeInactive: true }) });
          setIsCreateClientOpen(false);
        },
      }
    );
  };

  function openEditProject(p: Project) {
    setSelectedProject(p);
    setEditColor(p.color ?? DEFAULT_COLOR);
    setEditPmName(p.pmName ?? "");
    setIsEditOpen(true);
  }

  function openEditClient(clientId: number, clientName: string) {
    setEditingClient({ id: clientId, name: clientName });
    setEditClientName(clientName);
    setEditClientOpen(true);
  }

  const projectRow = (project: Project) => (
    <TableRow key={project.id} className={!project.active ? "opacity-60" : ""}>
      <TableCell>
        <div
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: project.color ?? DEFAULT_COLOR }}
          title={project.color ?? DEFAULT_COLOR}
        />
      </TableCell>
      <TableCell className="font-semibold">{project.name}</TableCell>
      <TableCell className="text-muted-foreground font-mono text-xs">
        {project.code || "—"}
      </TableCell>
      <TableCell>
        {project.active ? (
          <Badge variant="default" className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 font-normal border-0">
            Active
          </Badge>
        ) : (
          <Badge variant="secondary" className="font-normal">
            Inactive
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {project.pmName || "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {project.roleCount != null ? (
          <span>{project.roleCount} {project.roleCount === 1 ? "role" : "roles"}</span>
        ) : (
          <span>—</span>
        )}
      </TableCell>
      <TableCell>
        <BudgetProgress bookedDays={project.bookedDays} budgetDays={project.budgetDays} />
      </TableCell>
      <TableCell>
        <ProjectActionsMenu
          project={project}
          onManageRoles={() => setRolesProject({ id: project.id, name: project.name })}
          onEdit={() => openEditProject(project)}
          onDelete={() => handleDelete(project.id)}
          updatePending={updateProject.isPending}
        />
      </TableCell>
    </TableRow>
  );

  const flatTableHeaders = (
    <TableHeader>
      <TableRow>
        <TableHead className="w-[32px]"></TableHead>
        <TableHead>Client</TableHead>
        <TableHead>Name</TableHead>
        <TableHead>Code</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>PM</TableHead>
        <TableHead>Roles</TableHead>
        <TableHead>Budget</TableHead>
        <TableHead className="w-[50px]"></TableHead>
      </TableRow>
    </TableHeader>
  );

  const groupedTableHeaders = (
    <TableHeader>
      <TableRow>
        <TableHead className="w-[32px]"></TableHead>
        <TableHead>Name</TableHead>
        <TableHead>Code</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>PM</TableHead>
        <TableHead>Roles</TableHead>
        <TableHead>Budget</TableHead>
        <TableHead className="w-[50px]"></TableHead>
      </TableRow>
    </TableHeader>
  );

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Projects</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setIsCreateClientOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> Add Client
            </Button>
            <Dialog
              open={isCreateOpen}
              onOpenChange={(open) => {
                setIsCreateOpen(open);
                if (open) setCreateColor(DEFAULT_COLOR);
              }}
            >
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" /> Add Project
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Project</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreate} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="clientId">Client</Label>
                  <Select name="clientId" required disabled={clientsLoading}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients?.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Project Name</Label>
                  <Input id="name" name="name" required placeholder="Website Redesign" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Project Code (Optional)</Label>
                  <Input id="code" name="code" placeholder="WR-2024" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="budgetHours">Budget Hours (Optional)</Label>
                  <Input id="budgetHours" name="budgetHours" type="number" step="0.5" placeholder="100" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pmName">PM (Optional)</Label>
                  <Select value={createPmName} onValueChange={setCreatePmName}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select PM…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— None —</SelectItem>
                      {employeeNames.map((name) => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Project Color</Label>
                  <ColorPicker value={createColor} onChange={setCreateColor} />
                </div>
                <div className="flex items-center space-x-6">
                  <div className="flex items-center space-x-2">
                    <Switch id="isBillable" name="isBillable" defaultChecked />
                    <Label htmlFor="isBillable">Billable</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch id="active" name="active" defaultChecked />
                    <Label htmlFor="active">Active</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createProject.isPending}>
                    {createProject.isPending ? "Creating..." : "Create Project"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* Toolbar: search + view toggle */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search projects or clients…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex items-center border rounded-md overflow-hidden">
            <Button
              variant="ghost"
              size="sm"
              className={`rounded-none px-3 ${view === "grouped" ? "bg-muted" : ""}`}
              onClick={() => setViewPersist("grouped")}
              title="Grouped by client"
            >
              <LayoutList className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`rounded-none px-3 border-l ${view === "flat" ? "bg-muted" : ""}`}
              onClick={() => setViewPersist("flat")}
              title="Flat list"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Grouped view */}
        {view === "grouped" && (
          <div className="space-y-3">
            {projectsLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="border rounded-md bg-card overflow-hidden">
                  <div className="px-4 py-3 bg-muted/40 flex items-center gap-2">
                    <Skeleton className="h-4 w-4" />
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-5 w-6 rounded-full" />
                  </div>
                </div>
              ))
            ) : groups.length === 0 ? (
              <div className="border rounded-md bg-card px-4 py-10 text-center text-muted-foreground">
                No projects found.
              </div>
            ) : (
              groups.map((group) => {
                const isCollapsed = !!collapsed[group.key];
                return (
                  <div key={group.key} className="border rounded-md bg-card overflow-hidden">
                    {/* Group header */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.key)}
                      className="w-full flex items-center gap-2 px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="font-semibold text-sm">
                        {group.clientName ?? "Unassigned"}
                      </span>
                      <Badge variant="secondary" className="text-xs font-normal px-1.5 py-0">
                        {group.projects.length}
                      </Badge>
                      {/* Edit client button */}
                      {group.clientId != null && (
                        <div
                          className="ml-auto"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-muted-foreground hover:text-foreground"
                            onClick={() => openEditClient(group.clientId!, group.clientName!)}
                          >
                            <Pencil className="h-3 w-3 mr-1" />
                            Edit Client
                          </Button>
                        </div>
                      )}
                    </button>
                    {/* Projects table */}
                    {!isCollapsed && (
                      <Table>
                        {groupedTableHeaders}
                        <TableBody>
                          {group.projects.map((project) => projectRow(project))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Flat view */}
        {view === "flat" && (
          <div className="border rounded-md bg-card">
            <Table>
              {flatTableHeaders}
              <TableBody>
                {projectsLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-4 w-4 rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-[150px]" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-[200px]" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-[80px]" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-[60px] rounded-full" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-[80px]" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-[60px]" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-[90px]" /></TableCell>
                      <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                    </TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                      No projects found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((project) => (
                    <TableRow key={project.id} className={!project.active ? "opacity-60" : ""}>
                      <TableCell>
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: project.color ?? DEFAULT_COLOR }}
                        />
                      </TableCell>
                      <TableCell className="font-medium text-muted-foreground">
                        {project.clientName || "—"}
                      </TableCell>
                      <TableCell className="font-semibold">{project.name}</TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {project.code || "—"}
                      </TableCell>
                      <TableCell>
                        {project.active ? (
                          <Badge variant="default" className="bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 font-normal border-0">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="font-normal">
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {project.pmName || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {project.roleCount != null ? (
                          <span>{project.roleCount} {project.roleCount === 1 ? "role" : "roles"}</span>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        <BudgetProgress bookedDays={project.bookedDays} budgetDays={project.budgetDays} />
                      </TableCell>
                      <TableCell>
                        <ProjectActionsMenu
                          project={project}
                          onManageRoles={() => setRolesProject({ id: project.id, name: project.name })}
                          onEdit={() => openEditProject(project)}
                          onDelete={() => handleDelete(project.id)}
                          updatePending={updateProject.isPending}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Roles sheet */}
        <ProjectRolesSheet
          project={rolesProject}
          open={rolesProject != null}
          onClose={() => setRolesProject(null)}
        />

        {/* Edit Project dialog */}
        <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Project</DialogTitle>
            </DialogHeader>
            {selectedProject && (
              <form onSubmit={handleEdit} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-clientId">Client</Label>
                  <Select name="clientId" defaultValue={selectedProject.clientId?.toString()}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a client" />
                    </SelectTrigger>
                    <SelectContent>
                      {clients?.map((c) => (
                        <SelectItem key={c.id} value={c.id.toString()}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-name">Project Name</Label>
                  <Input id="edit-name" name="name" required defaultValue={selectedProject.name} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-code">Project Code</Label>
                  <Input id="edit-code" name="code" defaultValue={selectedProject.code || ""} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-budgetHours">Budget Hours</Label>
                  <Input
                    id="edit-budgetHours"
                    name="budgetHours"
                    type="number"
                    step="0.5"
                    defaultValue={selectedProject.budgetHours ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-pmName">PM</Label>
                  <Select value={editPmName} onValueChange={setEditPmName}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select PM…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— None —</SelectItem>
                      {/* If current value doesn't match any employee, show it as an option */}
                      {editPmName && !employeeNames.includes(editPmName) && editPmName !== "__none__" && (
                        <SelectItem value={editPmName}>Current: {editPmName}</SelectItem>
                      )}
                      {employeeNames.map((name) => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Project Color</Label>
                  <ColorPicker value={editColor} onChange={setEditColor} />
                </div>
                <div className="flex items-center space-x-6">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="edit-isBillable"
                      name="isBillable"
                      defaultChecked={selectedProject.isBillable}
                    />
                    <Label htmlFor="edit-isBillable">Billable</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="edit-active"
                      name="active"
                      defaultChecked={selectedProject.active}
                    />
                    <Label htmlFor="edit-active">Active</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsEditOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={updateProject.isPending}>
                    {updateProject.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>

        {/* Add Client dialog */}
        <Dialog open={isCreateClientOpen} onOpenChange={setIsCreateClientOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Client</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreateClient} className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="client-name">Name</Label>
                <Input id="client-name" name="name" required placeholder="Acme Corp" autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="client-notes">Notes</Label>
                <Textarea id="client-notes" name="notes" placeholder="Billing details, contacts, etc." />
              </div>
              <div className="flex items-center space-x-2">
                <Switch id="client-active" name="active" defaultChecked />
                <Label htmlFor="client-active">Active</Label>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setIsCreateClientOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createClient.isPending}>
                  {createClient.isPending ? "Creating..." : "Create Client"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit Client inline dialog */}
        <Dialog open={editClientOpen} onOpenChange={setEditClientOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Client</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleEditClientSave} className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="edit-client-name">Client Name</Label>
                <Input
                  id="edit-client-name"
                  value={editClientName}
                  onChange={(e) => setEditClientName(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditClientOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={updateClient.isPending}>
                  {updateClient.isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </AdminLayout>
  );
}
