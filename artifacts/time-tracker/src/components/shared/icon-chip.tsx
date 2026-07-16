/**
 * IconChip — compact circular icon chip for Risk / Satisfaction etc.
 * Per Project Status detail decision: colored circular chip, exact label
 * available via tooltip (wrap with <SharedTooltip>).
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import type { StatusTone } from "./status-pill";

const toneClasses: Record<StatusTone, string> = {
  success: "bg-status-success-bg text-status-success-text",
  warning: "bg-status-warning-bg text-status-warning-text",
  danger: "bg-status-danger-bg text-status-danger-text",
  neutral: "bg-status-neutral-bg text-status-neutral-text",
};

export interface IconChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  /** Accessible label describing the chip (e.g. "Low risk"). */
  label: string;
  size?: "sm" | "md";
}

export function IconChip({ tone, label, size = "md", className, children, ...props }: IconChipProps) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full [&_svg]:shrink-0",
        size === "md" ? "h-[26px] w-[26px] [&_svg]:size-[14px]" : "h-5 w-5 [&_svg]:size-3",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
