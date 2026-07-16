/**
 * TimelineEntry — history / chronological log entry (Project Status pattern,
 * generalized; also for invoice history).
 * Fixed-width left column: date + status icon chips (stacked).
 * Right column: comment text or an explicit "No comment" empty-state label.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface TimelineEntryProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Display date, e.g. "Jul 3, 2026". */
  date: string;
  /** Status chips / pills stacked under the date (IconChip, StatusPill…). */
  chips?: React.ReactNode;
  /** Main content; when empty, `emptyLabel` is shown instead. */
  children?: React.ReactNode;
  emptyLabel?: string;
  /** Plain-text status label shown next to the date (context, not severity). */
  statusLabel?: string;
  isLast?: boolean;
}

export function TimelineEntry({
  date,
  chips,
  children,
  emptyLabel = "No comment",
  statusLabel,
  isLast = false,
  className,
  ...props
}: TimelineEntryProps) {
  const hasContent = children != null && children !== "";
  return (
    <div
      className={cn(
        "grid grid-cols-[140px_1fr] gap-4 py-3",
        !isLast && "border-b border-border-soft",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{date}</span>
        {statusLabel && <span className="text-[13px] font-medium text-navy">{statusLabel}</span>}
        {chips && <div className="flex items-center gap-1.5">{chips}</div>}
      </div>
      <div className={cn("min-w-0 text-[13px] leading-relaxed", hasContent ? "text-foreground" : "text-muted-foreground")}>
        {hasContent ? children : emptyLabel}
      </div>
    </div>
  );
}
