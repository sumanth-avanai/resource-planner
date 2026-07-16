import { useQuery } from "@tanstack/react-query";
import { format, addDays } from "date-fns";
import { CalendarCheck, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";

interface ResourceBooking {
  id: number;
  employeeId: number;
  projectId: number;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  notes: string | null;
  projectName: string;
  projectColor: string;
  clientName: string | null;
}

interface ResourceBookingsPanelProps {
  employeeId: number;
  weekStart: Date;
}

export function ResourceBookingsPanel({ employeeId, weekStart }: ResourceBookingsPanelProps) {
  const weekEnd = addDays(weekStart, 6);
  const startDateStr = format(weekStart, "yyyy-MM-dd");
  const endDateStr = format(weekEnd, "yyyy-MM-dd");

  const { data: bookings, isLoading, isError } = useQuery<ResourceBooking[]>({
    queryKey: ["resource-bookings", employeeId, startDateStr, endDateStr],
    queryFn: async () => {
      const params = new URLSearchParams({
        employeeId: String(employeeId),
        startDate: startDateStr,
        endDate: endDateStr,
      });
      const res = await fetch(`/api/resource-bookings?${params}`);
      if (!res.ok) throw new Error("Failed to fetch resource bookings");
      return res.json() as Promise<ResourceBooking[]>;
    },
    enabled: !!employeeId,
  });

  return (
    <div className="rounded-lg border bg-card/50 px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <CalendarCheck className="h-4 w-4 text-muted-foreground" />
          Planned Bookings This Week
        </div>
        <Link
          href="/resource-planner"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Resource Planner
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {isLoading ? (
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-7 w-40 rounded-full" />
          <Skeleton className="h-7 w-32 rounded-full" />
          <Skeleton className="h-7 w-48 rounded-full" />
        </div>
      ) : isError ? (
        <p className="text-xs text-destructive">
          Could not load bookings. Please refresh and try again.
        </p>
      ) : !bookings || bookings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No planned bookings for this week.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {bookings.map((booking) => (
            <BookingChip key={booking.id} booking={booking} />
          ))}
        </div>
      )}
    </div>
  );
}

function BookingChip({ booking }: { booking: ResourceBooking }) {
  const label = booking.clientName
    ? `${booking.projectName} (${booking.clientName})`
    : booking.projectName;

  const dateRange =
    booking.startDate === booking.endDate
      ? format(new Date(booking.startDate + "T00:00:00"), "MMM d")
      : `${format(new Date(booking.startDate + "T00:00:00"), "MMM d")} – ${format(new Date(booking.endDate + "T00:00:00"), "MMM d")}`;

  const hpdLabel = booking.hoursPerDay % 1 === 0
    ? `${booking.hoursPerDay} h/day`
    : `${booking.hoursPerDay.toFixed(1)} h/day`;

  const tooltipLines = [
    label,
    hpdLabel,
    dateRange,
    ...(booking.notes ? [booking.notes] : []),
  ].join("\n");

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium bg-background"
      title={tooltipLines}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: booking.projectColor }}
      />
      <span className="truncate max-w-[18ch]">{booking.projectName}</span>
      <span className="text-muted-foreground shrink-0">
        {booking.hoursPerDay % 1 === 0 ? booking.hoursPerDay : booking.hoursPerDay.toFixed(1)}h/d
      </span>
    </div>
  );
}
