import { format, getISODay } from "date-fns";

export interface VacationEntry {
  id: number;
  employeeId: number;
  startDate: string;
  endDate: string;
  vacationType: string;
  note: string | null;
}

export interface BookabilityParams {
  workingDaysMask: number[];
  contractStartDate: string | null;
  contractEndDate: string | null;
  holidays: Array<{ date: Date | string }>;
  vacations: VacationEntry[];
}

export function isDateBookable(dateStr: string, params: BookabilityParams): boolean {
  const { workingDaysMask, contractStartDate, contractEndDate, holidays, vacations } = params;

  const day = new Date(dateStr + "T00:00:00");
  const isoDayIndex = getISODay(day) - 1; // 0=Mon … 6=Sun

  if (!workingDaysMask[isoDayIndex]) return false;
  if (contractStartDate && dateStr < contractStartDate) return false;
  if (contractEndDate && dateStr > contractEndDate) return false;
  if (holidays.some((h) => String(h.date).slice(0, 10) === dateStr)) return false;
  if (vacations.some((v) => v.startDate <= dateStr && dateStr <= v.endDate)) return false;

  return true;
}

export function computeBookableDatesInRange(
  startDate: string,
  endDate: string,
  selectedIsoDays: Set<number>,
  params: BookabilityParams,
): string[] {
  const dates: string[] = [];
  const current = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");

  while (current <= end) {
    const dateStr = format(current, "yyyy-MM-dd");
    const isoDay = getISODay(current);
    if (selectedIsoDays.has(isoDay) && isDateBookable(dateStr, params)) {
      dates.push(dateStr);
    }
    current.setDate(current.getDate() + 1);
  }

  return dates;
}
