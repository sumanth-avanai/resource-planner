/**
 * BudgetBar — budget indicator (Logged / Remaining), day-based.
 * Rules from the decisions log ("Budget indicators"):
 * - threshold-colored: green < 70%, amber 70–90%, red ≥ 90%
 * - absolute amount always alongside percentage, never percentage alone
 * - values are expressed in days
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface BudgetBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Total budget in days. */
  total: number;
  /** Logged (consumed) days — brand segment. */
  logged: number;
  /** Format used for the label; defaults to compact days. */
  formatValue?: (n: number) => string;
  /** Show "x / y · z%" label above the bar (default true). */
  showLabel?: boolean;
  /** Show the Logged/Remaining legend below the bar. */
  showLegend?: boolean;
}

const defaultFormat = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}d`;

export function budgetTone(pct: number): "success" | "warning" | "danger" {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warning";
  return "success";
}

export function BudgetBar({
  total,
  logged,
  formatValue = defaultFormat,
  showLabel = true,
  showLegend = false,
  className,
  ...props
}: BudgetBarProps) {
  const consumed = logged;
  const pct = total > 0 ? (consumed / total) * 100 : 0;
  const tone = budgetTone(pct);
  const consumedPct = total > 0 ? Math.min(100, (consumed / total) * 100) : 0;
  const barColor = tone === "danger" ? "bg-status-danger" : tone === "warning" ? "bg-status-warning" : "bg-brand";

  return (
    <div className={cn("min-w-0", className)} {...props}>
      {showLabel && (
        <p className="mb-1 text-sm font-medium text-navy">
          {formatValue(consumed)} / {formatValue(total)} ·{" "}
          <span
            className={cn(
              tone === "danger" && "text-status-danger-text",
              tone === "warning" && "text-status-warning-text",
              tone === "success" && "text-status-success-text",
            )}
          >
            {Math.round(pct)}%
          </span>
        </p>
      )}
      <div className="flex h-2.5 overflow-hidden rounded-[5px] bg-bg-soft" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={barColor} style={{ width: `${consumedPct}%` }} />
      </div>
      {showLegend && (
        <div className="mt-1.5 flex gap-3.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className={cn("inline-block h-2 w-2 rounded-[2px]", barColor)} /> Logged
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-[2px] border border-border-soft bg-bg-soft" /> Remaining
          </span>
        </div>
      )}
    </div>
  );
}
