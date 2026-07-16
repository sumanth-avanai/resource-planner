/**
 * AbsenceCell — icon + neutral gray background, never color overlays or
 * stripe patterns (decisions log, "Absences").
 * Icons: holiday = star, vacation = sun, sick = thermometer, unpaid/other = X.
 */
import * as React from "react";
import { Star, Sun, Thermometer, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SharedTooltip } from "./tooltip";

export type AbsenceType = "holiday" | "vacation" | "sick" | "unpaid_leave" | "other";

const config: Record<AbsenceType, { icon: LucideIcon; label: string }> = {
  holiday: { icon: Star, label: "Public holiday" },
  vacation: { icon: Sun, label: "Vacation" },
  sick: { icon: Thermometer, label: "Sick" },
  unpaid_leave: { icon: X, label: "Unpaid leave" },
  other: { icon: X, label: "Absence" },
};

export function absenceTypeLabel(type: string): string {
  return config[(type as AbsenceType) in config ? (type as AbsenceType) : "other"].label;
}

export interface AbsenceCellProps extends React.HTMLAttributes<HTMLDivElement> {
  type: AbsenceType | string;
  /** Extra tooltip detail, e.g. the holiday name or vacation note. */
  detail?: string | null;
  /** Show the text label next to the icon (chip form). Default false = icon-only cell. */
  showLabel?: boolean;
}

export function AbsenceCell({ type, detail, showLabel = false, className, ...props }: AbsenceCellProps) {
  const c = config[(type as AbsenceType) in config ? (type as AbsenceType) : "other"];
  const Icon = c.icon;
  const tooltip = detail ? `${c.label} — ${detail}` : c.label;
  return (
    <SharedTooltip content={tooltip}>
      <div
        className={cn(
          "flex h-full w-full items-center justify-center gap-1.5 rounded-md bg-status-neutral-bg text-status-neutral-text",
          showLabel && "px-3 py-2",
          className,
        )}
        {...props}
      >
        <Icon aria-label={c.label} className="size-3.5 shrink-0" />
        {showLabel && <span className="text-[13px] leading-none">{c.label}</span>}
      </div>
    </SharedTooltip>
  );
}
