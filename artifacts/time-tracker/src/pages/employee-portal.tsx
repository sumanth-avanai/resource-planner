import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { 
  useGetEmployeeByToken, 
  getGetEmployeeByTokenQueryKey,
  useVerifyEmployeePin
} from "@workspace/api-client-react";
import { PortalTimesheetGrid } from "@/components/timesheet/portal-timesheet-grid";
import { startOfWeek, addWeeks, subWeeks } from "date-fns";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Clock } from "lucide-react";

export default function EmployeePortal() {
  const { token } = useParams<{ token: string }>();
  const [pin, setPin] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState("");
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));

  useEffect(() => {
    const authStatus = sessionStorage.getItem(`zeit_auth_${token}`);
    if (authStatus === "true") {
      setIsAuthenticated(true);
    }
  }, [token]);

  const { data: _employeeRaw, isLoading, isError } = useGetEmployeeByToken(
    token || "",
    { query: { queryKey: getGetEmployeeByTokenQueryKey(token || ""), enabled: !!token } }
  );
  const employee = _employeeRaw as typeof _employeeRaw & {
    personalAccessToken?: string;
    weeklyCapacityHours?: number;
    workingDaysMask?: number[];
    contractStartDate?: string | null;
    contractEndDate?: string | null;
  } | undefined;

  const verifyPin = useVerifyEmployeePin();

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    
    if (!token || !pin) return;

    verifyPin.mutate(
      { data: { token, pin } },
      {
        onSuccess: () => {
          sessionStorage.setItem(`zeit_auth_${token}`, "true");
          setIsAuthenticated(true);
        },
        onError: () => {
          setError("Invalid PIN. Please try again.");
          setPin("");
        }
      }
    );
  };

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-background">Loading...</div>;
  }

  if (isError || !employee) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Invalid Link</CardTitle>
            <CardDescription>This personal link is invalid or has expired.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
        <div className="mb-8 flex items-center gap-2">
          <div className="p-2 rounded-md" style={{ background: "var(--gradient-brand)" }}>
            <Clock className="h-5 w-5 text-white" />
          </div>
          <span className="text-xl font-bold tracking-tight gradient-text">AvaTrack</span>
        </div>
        
        <Card className="w-full max-w-sm shadow-md">
          <CardHeader className="space-y-1.5 text-center pb-4">
            <CardTitle className="text-lg">Welcome back, {employee.name}</CardTitle>
            <CardDescription className="text-xs">Enter your 4-digit PIN to access your timesheet.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleVerify} className="space-y-4">
              <div className="space-y-2 flex flex-col items-center">
                <Label htmlFor="pin" className="sr-only">PIN</Label>
                <Input
                  id="pin"
                  type="password"
                  pattern="\d{4}"
                  maxLength={4}
                  required
                  autoFocus
                  className="text-center text-2xl tracking-widest h-12 w-40 font-mono"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  placeholder="••••"
                />
              </div>
              {error && <p className="text-xs text-destructive text-center font-medium">{error}</p>}
              <Button type="submit" className="w-full h-9 text-sm" disabled={verifyPin.isPending || pin.length !== 4}>
                {verifyPin.isPending ? "Verifying..." : "Unlock Timesheet"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="bg-card border-b border-border py-3 px-6 shadow-xs">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md" style={{ background: "var(--gradient-brand)" }}>
              <Clock className="h-4 w-4 text-white" />
            </div>
            <span className="text-base font-bold tracking-tight gradient-text">AvaTrack</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs font-medium text-muted-foreground">{employee.name}</span>
            <Button variant="ghost" size="sm" onClick={() => {
              sessionStorage.removeItem(`zeit_auth_${token}`);
              setIsAuthenticated(false);
            }}>
              Lock
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 p-5 overflow-y-auto">
        <div className="max-w-7xl mx-auto space-y-5">
          <div>
            <h1 className="font-semibold text-foreground">Your Timesheet</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Log your hours for the week.</p>
          </div>

          <PortalTimesheetGrid
            employeeId={employee.id}
            employeeToken={employee.personalAccessToken || token || ""}
            weekStartDate={currentWeekStart}
            capacityHours={employee.weeklyCapacityHours || 40}
            workingDaysMask={employee.workingDaysMask}
            contractStartDate={employee.contractStartDate}
            contractEndDate={employee.contractEndDate}
            onNextWeek={() => setCurrentWeekStart(prev => addWeeks(prev, 1))}
            onPreviousWeek={() => setCurrentWeekStart(prev => subWeeks(prev, 1))}
          />
        </div>
      </main>
    </div>
  );
}
