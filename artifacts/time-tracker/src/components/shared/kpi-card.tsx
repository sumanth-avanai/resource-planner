/**
 * KpiCard + KpiStrip — scan-first summary strip above tables/detail views.
 * Per the Project Status decision, generalized in the component library.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface KpiCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  /** Optional tone for the value (danger for "Needs attention", etc.). */
  tone?: "default" | "success" | "warning" | "danger" | "brand";
  hint?: string;
}

const valueTone: Record<NonNullable<KpiCardProps["tone"]>, string> = {
  default: "text-navy",
  success: "text-status-success-text",
  warning: "text-status-warning-text",
  danger: "text-status-danger-text",
  brand: "text-brand",
};

export function KpiCard({ label, value, tone = "default", hint, className, ...props }: KpiCardProps) {
  return (
    <div
      className={cn("rounded-xl border border-border-soft bg-card px-4 py-3", className)}
      {...props}
    >
      <p className="m-0 text-[11px] font-medium uppercase tracking-[0.03em] text-muted-foreground">{label}</p>
      <p className={cn("m-0 mt-1 text-lg font-semibold leading-tight", valueTone[tone])}>{value}</p>
      {hint && <p className="m-0 mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function KpiStrip({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]", className)}
      {...props}
    >
      {children}
    </div>
  );
}
