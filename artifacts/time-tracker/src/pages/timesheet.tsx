import { useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { 
  useListEmployees, 
  getListEmployeesQueryKey,
} from "@workspace/api-client-react";
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { TimesheetGrid } from "@/components/timesheet/timesheet-grid";
import { ResourceBookingsPanel } from "@/components/timesheet/resource-bookings-panel";
import { AdminTimesheetView } from "@/components/timesheet/admin-timesheet-view";
import { startOfWeek, addWeeks, subWeeks } from "date-fns";
import { useAppAuth } from "@/hooks/use-app-auth";

export default function Timesheet() {
  const auth = useAppAuth();
  const isAdmin = auth === "authenticated";

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));

  const { data: employees, isLoading } = useListEmployees(
    { includeInactive: false },
    { query: { queryKey: getListEmployeesQueryKey({ includeInactive: false }) } }
  );

  const selectedEmployee = employees?.find(e => e.id === selectedEmployeeId);

  if (isAdmin) {
    return (
      <AdminLayout>
        <div className="space-y-6 max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Timesheets</h1>
          <AdminTimesheetView />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Timesheet Entry</h1>
          
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <Label htmlFor="employee-select" className="whitespace-nowrap">Employee:</Label>
            <Select 
              value={selectedEmployeeId?.toString() || ""} 
              onValueChange={(val) => setSelectedEmployeeId(parseInt(val))}
              disabled={isLoading}
            >
              <SelectTrigger className="w-full sm:w-[250px]">
                <SelectValue placeholder="Select an employee" />
              </SelectTrigger>
              <SelectContent>
                {employees?.map((emp) => (
                  <SelectItem key={emp.id} value={emp.id.toString()}>
                    {emp.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectedEmployeeId && selectedEmployee && (
          <ResourceBookingsPanel
            employeeId={selectedEmployeeId}
            weekStart={currentWeekStart}
          />
        )}

        {selectedEmployeeId && selectedEmployee ? (
          <TimesheetGrid
            employeeId={selectedEmployeeId}
            weekStartDate={currentWeekStart}
            capacityHours={selectedEmployee.weeklyCapacityHours}
            workingDaysMask={selectedEmployee.workingDaysMask}
            contractStartDate={selectedEmployee.contractStartDate ?? null}
            contractEndDate={selectedEmployee.contractEndDate ?? null}
            holidayCalendarCode={selectedEmployee.holidayCalendarCode ?? null}
            onNextWeek={() => setCurrentWeekStart(prev => addWeeks(prev, 1))}
            onPreviousWeek={() => setCurrentWeekStart(prev => subWeeks(prev, 1))}
          />
        ) : (
          <div className="h-64 flex items-center justify-center border rounded-md bg-card/50 border-dashed text-muted-foreground">
            Select an employee to view or edit their timesheet
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
