import { useState } from "react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { 
  useListHolidayCalendars, 
  getListHolidayCalendarsQueryKey,
  useCreateHolidayCalendar,
  useListHolidays,
  getListHolidaysQueryKey,
  useCreateHoliday,
  useDeleteHoliday
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
import { Plus, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function Holidays() {
  const queryClient = useQueryClient();
  const [selectedCalendarId, setSelectedCalendarId] = useState<number | null>(null);
  const [isCreateCalOpen, setIsCreateCalOpen] = useState(false);
  const [isCreateHolOpen, setIsCreateHolOpen] = useState(false);

  const { data: calendars, isLoading: calsLoading } = useListHolidayCalendars({
    query: { queryKey: getListHolidayCalendarsQueryKey() }
  });

  const activeCalendar = calendars?.find(c => c.id === selectedCalendarId) || calendars?.[0];

  const { data: holidays, isLoading: holsLoading } = useListHolidays(
    activeCalendar?.id || 0,
    {},
    { 
      query: { 
        queryKey: getListHolidaysQueryKey(activeCalendar?.id || 0, {}),
        enabled: !!activeCalendar?.id 
      } 
    }
  );

  const createCalendar = useCreateHolidayCalendar();
  const createHoliday = useCreateHoliday();
  const deleteHoliday = useDeleteHoliday();

  const handleCreateCalendar = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createCalendar.mutate(
      {
        data: {
          name: formData.get("name") as string,
          code: formData.get("code") as string,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListHolidayCalendarsQueryKey() });
          setIsCreateCalOpen(false);
        }
      }
    );
  };

  const handleCreateHoliday = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!activeCalendar) return;
    
    const formData = new FormData(e.currentTarget);
    createHoliday.mutate(
      {
        id: activeCalendar.id,
        data: {
          name: formData.get("name") as string,
          date: formData.get("date") as string,
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListHolidaysQueryKey(activeCalendar.id, {}) });
          setIsCreateHolOpen(false);
        }
      }
    );
  };

  const handleDeleteHoliday = (holidayId: number) => {
    if (!activeCalendar) return;
    
    if (confirm("Remove this holiday?")) {
      deleteHoliday.mutate(
        { id: holidayId },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListHolidaysQueryKey(activeCalendar.id, {}) });
          }
        }
      );
    }
  };

  useEffect(() => {
    if (calendars?.length && !selectedCalendarId) {
      setSelectedCalendarId(calendars[0].id);
    }
  }, [calendars, selectedCalendarId]);

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Holidays</h1>
          <Dialog open={isCreateCalOpen} onOpenChange={setIsCreateCalOpen}>
            <DialogTrigger asChild>
              <Button variant="outline"><Plus className="h-4 w-4 mr-2" /> New Calendar</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Holiday Calendar</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleCreateCalendar} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Calendar Name</Label>
                  <Input id="name" name="name" required placeholder="US Holidays" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Code (Unique)</Label>
                  <Input id="code" name="code" required placeholder="US_2024" />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateCalOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={createCalendar.isPending}>
                    {createCalendar.isPending ? "Creating..." : "Create Calendar"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="md:col-span-1 space-y-4">
            <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">Calendars</h3>
            {calsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {calendars?.map((cal) => (
                  <button
                    key={cal.id}
                    onClick={() => setSelectedCalendarId(cal.id)}
                    className={`text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      (selectedCalendarId === cal.id || (!selectedCalendarId && calendars[0].id === cal.id))
                        ? "bg-primary text-primary-foreground font-medium"
                        : "hover:bg-muted"
                    }`}
                  >
                    <div className="truncate">{cal.name}</div>
                    <div className={`text-xs opacity-70 truncate`}>{cal.code}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="md:col-span-3">
            {activeCalendar ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between bg-card p-4 rounded-md border border-border shadow-sm">
                  <div>
                    <h2 className="text-lg font-semibold">{activeCalendar.name}</h2>
                    <p className="text-sm text-muted-foreground">Manage holidays for this calendar</p>
                  </div>
                  <Dialog open={isCreateHolOpen} onOpenChange={setIsCreateHolOpen}>
                    <DialogTrigger asChild>
                      <Button><Plus className="h-4 w-4 mr-2" /> Add Holiday</Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add Holiday</DialogTitle>
                      </DialogHeader>
                      <form onSubmit={handleCreateHoliday} className="space-y-4 pt-4">
                        <div className="space-y-2">
                          <Label htmlFor="hol-name">Holiday Name</Label>
                          <Input id="hol-name" name="name" required placeholder="New Year's Day" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="hol-date">Date</Label>
                          <Input id="hol-date" name="date" type="date" required />
                        </div>
                        <DialogFooter>
                          <Button type="button" variant="outline" onClick={() => setIsCreateHolOpen(false)}>Cancel</Button>
                          <Button type="submit" disabled={createHoliday.isPending}>
                            {createHoliday.isPending ? "Adding..." : "Add Holiday"}
                          </Button>
                        </DialogFooter>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>

                <div className="border rounded-md bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="w-[80px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {holsLoading ? (
                        Array.from({ length: 3 }).map((_, i) => (
                          <TableRow key={i}>
                            <TableCell><Skeleton className="h-4 w-[100px]" /></TableCell>
                            <TableCell><Skeleton className="h-4 w-[200px]" /></TableCell>
                            <TableCell><Skeleton className="h-8 w-8" /></TableCell>
                          </TableRow>
                        ))
                      ) : holidays?.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center py-10 text-muted-foreground">
                            No holidays configured for this calendar.
                          </TableCell>
                        </TableRow>
                      ) : (
                        holidays?.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()).map((holiday) => (
                          <TableRow key={holiday.id}>
                            <TableCell className="font-medium whitespace-nowrap">
                              {format(new Date(holiday.date), "MMM d, yyyy")}
                            </TableCell>
                            <TableCell className="w-full">{holiday.name}</TableCell>
                            <TableCell>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDeleteHoliday(holiday.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : (
              <div className="h-64 flex items-center justify-center border rounded-md bg-card border-dashed text-muted-foreground">
                Select or create a calendar
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}

import { useEffect } from "react";
