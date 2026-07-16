/**
 * EmptyState — explicit label, never a bare dash.
 * Two flavors:
 *  - <EmptyState>       block-level dashed panel ("No comment yet")
 *  - <EmptyValue>       inline label for table cells ("Not assessed")
 * Decisions log: rows/entities with no data stay visible with a subtle label.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Optional icon rendered above the label. */
  icon?: React.ReactNode;
  label: string;
  /** Secondary line, e.g. a hint about how to add data. */
  hint?: string;
  /** Optional action (e.g. a Button). */
  action?: React.ReactNode;
}

export function EmptyState({ icon, label, hint, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-soft px-5 py-7 text-center",
        className,
      )}
      {...props}
    >
      {icon && <div className="text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <p className="m-0 text-[13px] text-muted-foreground">{label}</p>
      {hint && <p className="m-0 text-xs text-muted-foreground/80">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Inline empty-value label for table cells — use instead of "—". */
export function EmptyValue({ label, className }: { label: string; className?: string }) {
  return <span className={cn("text-[13px] text-muted-foreground", className)}>{label}</span>;
}
