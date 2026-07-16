import { useGetDashboardSummary, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";
import { Clock, Briefcase, Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AdminLayout } from "@/components/layout/admin-layout";

export default function Dashboard() {
  const { data: summary, isLoading } = useGetDashboardSummary({
    query: { queryKey: getGetDashboardSummaryQueryKey() }
  });

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="space-y-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-96" />
        </div>
      </AdminLayout>
    );
  }

  if (!summary) return null;

  const totalAvailableHours = summary.employeeSummaries.reduce(
    (sum, e) => sum + e.availableHours,
    0
  );
  const totalUtilization = totalAvailableHours > 0
    ? (summary.billableBookedHours / totalAvailableHours) * 100
    : 0;

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {format(new Date(summary.weekStartDate), "MMM d")} - {format(new Date(summary.weekEndDate), "MMM d, yyyy")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Hours</CardTitle>
              <Clock className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.totalBookedHours.toFixed(1)}</div>
              <p className="text-xs text-muted-foreground mt-1">Booked this week</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Billable Hours</CardTitle>
              <Briefcase className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{summary.billableBookedHours.toFixed(1)}</div>
              <p className="text-xs text-muted-foreground mt-1">Invoiced this week</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Utilization</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalUtilization.toFixed(1)}%</div>
              <p className="text-xs text-muted-foreground mt-1">Billable / Available</p>
            </CardContent>
          </Card>
        </div>

        <h2 className="text-xl font-bold tracking-tight mt-8 mb-4">Team Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {summary.employeeSummaries.map((emp) => (
            <Card key={emp.employeeId} className="overflow-hidden">
              <CardContent className="p-0">
                <div className="p-4 border-b border-border bg-muted/30">
                  <div className="font-semibold">{emp.employeeName}</div>
                  <div className="text-xs text-muted-foreground">Capacity: {emp.availableHours}h</div>
                </div>
                <div className="p-4 grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Booked</div>
                    <div className="font-medium">{emp.bookedHours.toFixed(1)}h</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground mb-1">Billable</div>
                    <div className="font-medium">{emp.billableHours.toFixed(1)}h</div>
                  </div>
                  <div className="col-span-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-muted-foreground">Utilization</span>
                      <span className="font-medium">{emp.utilization.toFixed(0)}%</span>
                    </div>
                    <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-primary" 
                        style={{ width: `${Math.min(100, emp.utilization)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {summary.employeeSummaries.length === 0 && (
            <div className="col-span-full py-12 text-center text-muted-foreground border rounded-lg border-dashed">
              No team data available for this week.
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}
