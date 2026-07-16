import { useState, useMemo } from "react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useListHolidays,
  getListHolidaysQueryKey,
  useBulkUpsertTimeEntries,
} from "@workspace/api-client-react";
import { VacationEntry, computeBookableDatesInRange } from "@/lib/bookable-dates";
import { AlertCircle, CalendarCheck, Loader2 } from "lucide-react";

interface Project {
  id: number;
  name: string;
  clientName?: string;
}

interface RecurringBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: number;
  projects: Project[];
  workingDaysMask: number[];
  contractStartDate: string | null;
  contractEndDate: string | null;
  calendarId: number | null;
  vacations: VacationEntry[];
  onSuccess: () => void;
}

const WEEKDAYS = [
  { isoDay: 1, label: "Mon" },
  { isoDay: 2, label: "Tue" },
  { isoDay: 3, label: "Wed" },
  { isoDay: 4, label: "Thu" },
  { isoDay: 5, label: "Fri" },
  { isoDay: 6, label: "Sat" },
  { isoDay: 7, label: "Sun" },
];

type Step = "form" | "conflict";

const todayStr = format(new Date(), "yyyy-MM-dd");

export function RecurringBookingDialog({
  open,
  onOpenChange,
  employeeId,
  projects,
  workingDaysMask,
  contractStartDate,
  contractEndDate,
  calendarId,
  vacations,
  onSuccess,
}: RecurringBookingDialogProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [startDate, setStartDate] = useState(todayStr);
  const [endDate, setEndDate] = useState(todayStr);
  const [selectedIsoDays, setSelectedIsoDays] = useState<Set<number>>(
    new Set([1, 2, 3, 4, 5])
  );
  const [hoursPerDay, setHoursPerDay] = useState("8");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [conflictCount, setConflictCount] = useState(0);
  const [pendingDates, setPendingDates] = useState<string[]>([]);
  const [detectedConflictDates, setDetectedConflictDates] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Fetch all holidays for this calendar (no year filter — covers any range)
  const { data: allHolidays } = useListHolidays(
    calendarId ?? 0,
    undefined,
    {
      query: {
        queryKey: getListHolidaysQueryKey(calendarId ?? 0),
        enabled: !!calendarId,
      },
    }
  );

  const bulkUpsert = useBulkUpsertTimeEntries();

  const toggleDay = (isoDay: number) => {
    setSelectedIsoDays((prev) => {
      const next = new Set(prev);
      if (next.has(isoDay)) next.delete(isoDay);
      else next.add(isoDay);
      return next;
    });
  };

  const bookabilityParams = useMemo(
    () => ({
      workingDaysMask,
      contractStartDate,
      contractEndDate,
      holidays: allHolidays ?? [],
      vacations,
    }),
    [workingDaysMask, contractStartDate, contractEndDate, allHolidays, vacations]
  );

  const bookableDates = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate || selectedIsoDays.size === 0) return [];
    return computeBookableDatesInRange(startDate, endDate, selectedIsoDays, bookabilityParams);
  }, [startDate, endDate, selectedIsoDays, bookabilityParams]);

  const hours = parseFloat(hoursPerDay);
  const isHoursValid = !isNaN(hours) && hours >= 0 && hours <= 24;
  const isFormValid =
    selectedProjectId !== "" &&
    startDate !== "" &&
    endDate !== "" &&
    endDate >= startDate &&
    selectedIsoDays.size > 0 &&
    isHoursValid;

  const handleClose = () => {
    if (isSubmitting) return;
    onOpenChange(false);
    setTimeout(resetForm, 300);
  };

  const resetForm = () => {
    setSelectedProjectId("");
    setStartDate(todayStr);
    setEndDate(todayStr);
    setSelectedIsoDays(new Set([1, 2, 3, 4, 5]));
    setHoursPerDay("8");
    setNote("");
    setStep("form");
    setConflictCount(0);
    setPendingDates([]);
    setDetectedConflictDates(new Set());
    setIsSubmitting(false);
    setSubmitError("");
  };

  const handlePreviewAndBook = async () => {
    if (!isFormValid || bookableDates.length === 0) return;
    setSubmitError("");

    const projectId = parseInt(selectedProjectId, 10);

    // Fetch existing entries for this employee + project in the range to detect conflicts
    try {
      const res = await fetch(
        `/api/time-entries?employeeId=${employeeId}&projectId=${projectId}&startDate=${startDate}&endDate=${endDate}`
      );
      if (!res.ok) throw new Error("Failed to check existing entries");
      const existing: Array<{ projectId: number; entryDate: string }> = await res.json();

      const existingSet = new Set(existing.map((e) => e.entryDate));
      const conflicts = bookableDates.filter((d) => existingSet.has(d));

      if (conflicts.length > 0) {
        setConflictCount(conflicts.length);
        setDetectedConflictDates(new Set(conflicts));
        setPendingDates(bookableDates);
        setStep("conflict");
      } else {
        await submitEntries(bookableDates);
      }
    } catch {
      setSubmitError("Could not check for existing entries. Please try again.");
    }
  };

  const submitEntries = async (dates: string[]) => {
    setIsSubmitting(true);
    setSubmitError("");

    const projectId = parseInt(selectedProjectId, 10);
    const hrs = parseFloat(hoursPerDay);
    const noteVal = note.trim() || null;

    const entries = dates.map((d) => ({
      employeeId,
      projectId,
      entryDate: d,
      hours: hrs,
      note: noteVal,
    }));

    bulkUpsert.mutate(
      { data: { entries } },
      {
        onSuccess: () => {
          setIsSubmitting(false);
          onOpenChange(false);
          onSuccess();
          setTimeout(resetForm, 300);
        },
        onError: () => {
          setIsSubmitting(false);
          setSubmitError("Failed to save entries. Please try again.");
        },
      }
    );
  };

  const handleSkipConflicts = async () => {
    // Use the conflict set captured during detection — avoids a second fetch
    // whose failure could silently overwrite existing entries.
    const datesToBook = pendingDates.filter((d) => !detectedConflictDates.has(d));
    if (datesToBook.length === 0) {
      setSubmitError("No new days to book after skipping existing entries.");
      return;
    }
    await submitEntries(datesToBook);
  };

  const handleOverwrite = async () => {
    await submitEntries(pendingDates);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        {step === "form" ? (
          <>
            <DialogHeader>
              <DialogTitle>Repeat Booking</DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Project */}
              <div className="space-y-1.5">
                <Label>Project</Label>
                <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id.toString()}>
                        {p.name}
                        {p.clientName ? ` (${p.clientName})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Date range */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Start date</Label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>End date</Label>
                  <Input
                    type="date"
                    value={endDate}
                    min={startDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
              {endDate && startDate && endDate < startDate && (
                <p className="text-xs text-destructive -mt-2">End date must be on or after start date.</p>
              )}

              {/* Weekday selector */}
              <div className="space-y-1.5">
                <Label>Days of week</Label>
                <div className="flex gap-2 flex-wrap">
                  {WEEKDAYS.map(({ isoDay, label }) => (
                    <button
                      key={isoDay}
                      type="button"
                      onClick={() => toggleDay(isoDay)}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                        selectedIsoDays.has(isoDay)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background text-muted-foreground border-border hover:border-input"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {selectedIsoDays.size === 0 && (
                  <p className="text-xs text-destructive">Select at least one day.</p>
                )}
              </div>

              {/* Hours per day */}
              <div className="space-y-1.5">
                <Label>Hours per day</Label>
                <Input
                  type="number"
                  min="0"
                  max="24"
                  step="0.5"
                  value={hoursPerDay}
                  onChange={(e) => setHoursPerDay(e.target.value)}
                  className="w-32"
                />
                {hoursPerDay !== "" && !isHoursValid && (
                  <p className="text-xs text-destructive">Enter a value between 0 and 24.</p>
                )}
              </div>

              {/* Note */}
              <div className="space-y-1.5">
                <Label>Note <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Sprint 14"
                  maxLength={255}
                />
              </div>

              {/* Preview */}
              {isFormValid && (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 border border-border px-3 py-2 text-sm">
                  <CalendarCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                  {bookableDates.length === 0 ? (
                    <span className="text-muted-foreground">
                      No bookable days found in this range.
                    </span>
                  ) : (
                    <span>
                      <span className="font-semibold text-foreground">{bookableDates.length}</span>
                      {" "}bookable day{bookableDates.length !== 1 ? "s" : ""} ·{" "}
                      <span className="font-semibold text-foreground">
                        {(bookableDates.length * parseFloat(hoursPerDay)).toFixed(1)}
                      </span>
                      {" "}hrs total
                    </span>
                  )}
                </div>
              )}

              {submitError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {submitError}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                onClick={handlePreviewAndBook}
                disabled={!isFormValid || bookableDates.length === 0 || isSubmitting}
              >
                {isSubmitting ? (
                  <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Booking…</>
                ) : (
                  "Book"
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Existing entries found</DialogTitle>
            </DialogHeader>

            <div className="py-2 space-y-3">
              <p className="text-sm text-muted-foreground">
                <span className="font-semibold text-foreground">{conflictCount}</span> of the selected
                days already {conflictCount === 1 ? "has" : "have"} a time entry for this project.
                Choose how to handle them:
              </p>
              <div className="space-y-2">
                <div className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">Skip existing entries</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Only book the {pendingDates.length - conflictCount} days that don't already have entries.
                  </p>
                </div>
                <div className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium">Overwrite existing entries</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Replace all existing entries with {hoursPerDay} hrs on all {pendingDates.length} days.
                  </p>
                </div>
              </div>
              {submitError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {submitError}
                </p>
              )}
            </div>

            <DialogFooter className="flex-row justify-between sm:justify-between gap-2">
              <Button
                variant="outline"
                onClick={() => setStep("form")}
                disabled={isSubmitting}
              >
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleSkipConflicts}
                  disabled={isSubmitting || pendingDates.length - conflictCount === 0}
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Skip existing"}
                </Button>
                <Button
                  onClick={handleOverwrite}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Overwrite"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
