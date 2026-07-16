import { useEffect, useState, Component, type ReactNode } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Projects from "@/pages/projects";
import Employees from "@/pages/employees";
import EmployeeDetail from "@/pages/employee-detail";
import Settings from "@/pages/settings";
import Reports from "@/pages/reports";
import Timesheet from "@/pages/timesheet";
import EmployeePortal from "@/pages/employee-portal";
import Login from "@/pages/login";
import ResourcePlanner from "@/pages/resource-planner";
import Billing from "@/pages/billing";
import ProjectStatus from "@/pages/project-status";
import ProjectStatusDetail from "@/pages/project-status-detail";
import { useAppAuth } from "@/hooks/use-app-auth";
import { DirtyGuardProvider } from "@/contexts/dirty-guard";

// React 19 concurrent rendering: use microtasks instead of setTimeout(0) so
// simultaneous query completions are batched by React's automatic batching
// rather than firing as separate interleaved useSyncExternalStore
// notifications (which causes "Invalid hook call" in React 19).
notifyManager.setScheduler(queueMicrotask);

class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background p-8">
          <div className="max-w-md w-full space-y-3 text-center">
            <p className="text-sm font-medium text-destructive">Something went wrong</p>
            <p className="text-xs text-muted-foreground font-mono">{this.state.error.message}</p>
            <button
              className="text-xs underline text-muted-foreground hover:text-foreground"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();
  const auth = useAppAuth();

  useEffect(() => {
    if (auth === "unauthenticated") {
      navigate("/login");
    }
  }, [auth, navigate]);

  if (auth === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  if (auth === "unauthenticated") return null;

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />

      {/* Redirects for old/removed routes */}
      <Route path="/"><Redirect to="/home" /></Route>
      <Route path="/dashboard"><Redirect to="/home" /></Route>
      <Route path="/clients"><Redirect to="/projects" /></Route>
      <Route path="/holidays"><Redirect to="/settings" /></Route>

      {/* Main routes */}
      <Route path="/home"><AuthGuard><Home /></AuthGuard></Route>
      <Route path="/timesheet"><AuthGuard><Timesheet /></AuthGuard></Route>
      <Route path="/resource-planner"><AuthGuard><ResourcePlanner /></AuthGuard></Route>
      <Route path="/projects"><AuthGuard><Projects /></AuthGuard></Route>
      <Route path="/employees/:id"><AuthGuard><EmployeeDetail /></AuthGuard></Route>
      <Route path="/employees"><AuthGuard><Employees /></AuthGuard></Route>
      <Route path="/reports"><AuthGuard><Reports /></AuthGuard></Route>
      <Route path="/billing"><AuthGuard><Billing /></AuthGuard></Route>
      <Route path="/project-status/:id"><AuthGuard><ProjectStatusDetail /></AuthGuard></Route>
      <Route path="/project-status"><AuthGuard><ProjectStatus /></AuthGuard></Route>
      <Route path="/settings"><AuthGuard><Settings /></AuthGuard></Route>
      <Route path="/vacations"><Redirect to="/employees" /></Route>

      <Route path="/u/:token"><EmployeePortal /></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DirtyGuardProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <RouteErrorBoundary>
              <Router />
            </RouteErrorBoundary>
          </WouterRouter>
          <Toaster />
        </DirtyGuardProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
