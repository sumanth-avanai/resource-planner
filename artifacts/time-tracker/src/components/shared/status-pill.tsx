/**
 * StatusPill — icon-chip status pill (dot + label).
 * Used for health, invoice status, absence type… per the component library.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

const toneClasses: Record<StatusTone, { pill: string; dot: string }> = {
  success: { pill: "bg-status-success-bg text-status-success-text", dot: "bg-status-success" },
  warning: { pill: "bg-status-warning-bg text-status-warning-text", dot: "bg-status-warning" },
  danger: { pill: "bg-status-danger-bg text-status-danger-text", dot: "bg-status-danger" },
  neutral: { pill: "bg-status-neutral-bg text-status-neutral-text", dot: "bg-status-neutral" },
};

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Hide the leading dot (e.g. when an icon child is provided instead). */
  hideDot?: boolean;
}

export function StatusPill({ tone, hideDot, className, children, ...props }: StatusPillProps) {
  const t = toneClasses[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium leading-none",
        t.pill,
        className,
      )}
      {...props}
    >
      {!hideDot && <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", t.dot)} />}
      {children}
    </span>
  );
}
