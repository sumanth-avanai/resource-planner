/**
 * PeriodPicker — preset dropdown, NOT prev/next arrows (Billing decision).
 * Presets: All time, This year, Last quarter, This month, Last month,
 * Custom range (reveals start/end date inputs; disabled otherwise).
 */
import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type PeriodPreset = "all_time" | "this_year" | "last_quarter" | "this_month" | "last_month" | "custom";

export interface PeriodValue {
  preset: PeriodPreset;
  /** Resolved range; null dates mean unbounded (All time). */
  startDate: string | null;
  endDate: string | null;
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function resolvePeriod(preset: PeriodPreset, custom?: { start: string | null; end: string | null }): PeriodValue {
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (preset) {
    case "all_time":
      return { preset, startDate: null, endDate: null };
    case "this_year":
      return { preset, startDate: `${y}-01-01`, endDate: `${y}-12-31` };
    case "last_quarter": {
      const q = Math.floor(m / 3); // current quarter 0..3
      const lastQ = (q + 3) % 4;
      const qy = q === 0 ? y - 1 : y;
      const startMonth = lastQ * 3;
      const start = new Date(Date.UTC(qy, startMonth, 1));
      const end = new Date(Date.UTC(qy, startMonth + 3, 0));
      return { preset, startDate: fmt(start), endDate: fmt(end) };
    }
    case "this_month":
      return { preset, startDate: fmt(new Date(Date.UTC(y, m, 1))), endDate: fmt(new Date(Date.UTC(y, m + 1, 0))) };
    case "last_month":
      return { preset, startDate: fmt(new Date(Date.UTC(y, m - 1, 1))), endDate: fmt(new Date(Date.UTC(y, m, 0))) };
    case "custom":
      return { preset, startDate: custom?.start ?? null, endDate: custom?.end ?? null };
  }
}

const presetLabels: Record<PeriodPreset, string> = {
  all_time: "All time",
  this_year: "This year",
  last_quarter: "Last quarter",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

export interface PeriodPickerProps {
  value: PeriodValue;
  onValueChange: (value: PeriodValue) => void;
  className?: string;
}

export function PeriodPicker({ value, onValueChange, className }: PeriodPickerProps) {
  const isCustom = value.preset === "custom";
  return (
    <div className={cn("flex flex-wrap items-center gap-2.5", className)}>
      <Select
        value={value.preset}
        onValueChange={(preset) =>
          onValueChange(resolvePeriod(preset as PeriodPreset, { start: value.startDate, end: value.endDate }))
        }
      >
        <SelectTrigger className="h-9 w-[150px] rounded-lg border-border-soft text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(presetLabels) as PeriodPreset[]).map((p) => (
            <SelectItem key={p} value={p} className="text-[13px]">
              {presetLabels[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        type="date"
        aria-label="Start date"
        disabled={!isCustom}
        value={isCustom ? (value.startDate ?? "") : ""}
        onChange={(e) => onValueChange({ preset: "custom", startDate: e.target.value || null, endDate: value.endDate })}
        className="rounded-lg border border-border-soft bg-card px-2.5 py-1.5 text-[13px] disabled:opacity-50"
      />
      <span className="text-[13px] text-muted-foreground">to</span>
      <input
        type="date"
        aria-label="End date"
        disabled={!isCustom}
        value={isCustom ? (value.endDate ?? "") : ""}
        onChange={(e) => onValueChange({ preset: "custom", startDate: value.startDate, endDate: e.target.value || null })}
        className="rounded-lg border border-border-soft bg-card px-2.5 py-1.5 text-[13px] disabled:opacity-50"
      />
    </div>
  );
}
