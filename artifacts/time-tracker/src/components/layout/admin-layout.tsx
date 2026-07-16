import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Home,
  Clock,
  Users,
  FolderKanban,
  BarChart3,
  CalendarRange,
  Settings,
  LogOut,
  Receipt,
  Activity,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSetUnauthenticated } from "@/hooks/use-app-auth";
import { useDirtyGuard } from "@/contexts/dirty-guard";

const LS_KEY = "sidebar_open";

const navItems = [
  { title: "Home",             href: "/home",             icon: Home },
  { title: "Timesheet",        href: "/timesheet",        icon: Clock },
  { title: "Resource Planner", href: "/resource-planner", icon: CalendarRange },
  { title: "Projects",         href: "/projects",         icon: FolderKanban },
  { title: "Employees",        href: "/employees",        icon: Users },
  { title: "Reports",          href: "/reports",          icon: BarChart3 },
  { title: "Billing",          href: "/billing",          icon: Receipt },
  { title: "Project Status",   href: "/project-status",   icon: Activity },
];

function readStorage(): boolean {
  try {
    const v = localStorage.getItem(LS_KEY);
    return v === null ? true : v === "true";
  } catch {
    return true;
  }
}

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { guardNavigate } = useDirtyGuard();
  const { toast } = useToast();
  const setUnauthenticated = useSetUnauthenticated();

  const [open, setOpenState] = useState<boolean>(readStorage);

  const setOpen = useCallback((value: boolean | ((v: boolean) => boolean)) => {
    setOpenState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      try { localStorage.setItem(LS_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  async function handleLogout() {
    try {
      await fetch("/api/auth/app/logout", { method: "POST", credentials: "include" });
    } catch {
      // ignore
    }
    setUnauthenticated();
    navigate("/login");
    toast({ title: "Signed out" });
  }

  function isActive(href: string) {
    if (href === "/home")      return location === "/home" || location === "/" || location === "/dashboard";
    if (href === "/employees") return location.startsWith("/employees");
    if (href === "/projects")       return location.startsWith("/projects") || location.startsWith("/clients");
    if (href === "/project-status") return location.startsWith("/project-status");
    return location.startsWith(href);
  }

  return (
    <SidebarProvider
      open={open}
      onOpenChange={setOpen}
      style={{ "--sidebar-width": "192px", "--sidebar-width-icon": "52px" } as React.CSSProperties}
    >
      <div className="min-h-screen flex w-full bg-background">
        <Sidebar collapsible="icon" className="border-r border-border/50">
          <SidebarHeader className="h-14 flex items-center justify-between px-3 border-b border-white/5">
            <span className="font-bold text-base tracking-tight gradient-text group-data-[state=collapsed]:hidden select-none">
              AvaTrack
            </span>
            <SidebarTrigger className="ml-auto group-data-[state=collapsed]:mx-auto text-white/40 hover:text-white/70" />
          </SidebarHeader>

          <SidebarContent>
            <SidebarMenu className="p-2 gap-0.5">
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    tooltip={item.title}
                    isActive={isActive(item.href)}
                    onClick={(e) => {
                      e.preventDefault();
                      guardNavigate(() => navigate(item.href));
                    }}
                  >
                    <item.icon strokeWidth={1.5} className="h-4 w-4 shrink-0" />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>

          <SidebarFooter className="p-2 border-t border-white/5">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Settings"
                  isActive={location.startsWith("/settings")}
                  onClick={() => guardNavigate(() => navigate("/settings"))}
                >
                  <Settings strokeWidth={1.5} className="h-4 w-4 shrink-0" />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Sign out"
                  onClick={handleLogout}
                >
                  <LogOut strokeWidth={1.5} className="h-4 w-4 shrink-0" />
                  <span>Sign out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col h-screen overflow-hidden">
          <div className="flex-1 overflow-y-auto p-5">
            {children}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
