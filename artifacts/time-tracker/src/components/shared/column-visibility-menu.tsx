/**
 * ColumnVisibilityMenu — show/hide table columns, persisted per browser via
 * localStorage (decisions log: "Preferences without user accounts").
 * Identity column(s) stay locked.
 */
import * as React from "react";
import { Columns3 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface ColumnDef {
  id: string;
  label: string;
  /** Locked columns are always visible and shown disabled. */
  locked?: boolean;
  /** Hidden by default when no stored preference exists. */
  defaultHidden?: boolean;
}

/** Reads + persists visible-column ids in localStorage under the given key. */
export function useColumnVisibility(storageKey: string, columns: ColumnDef[]) {
  const defaults = React.useMemo(
    () => new Set(columns.filter((c) => c.locked || !c.defaultHidden).map((c) => c.id)),
    [columns],
  );
  const [visible, setVisible] = React.useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const stored = new Set<string>(JSON.parse(raw) as string[]);
        for (const c of columns) if (c.locked) stored.add(c.id);
        return stored;
      }
    } catch {
      /* ignore */
    }
    return defaults;
  });
  const update = React.useCallback(
    (next: Set<string>) => {
      setVisible(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );
  const isVisible = React.useCallback((id: string) => visible.has(id), [visible]);
  return { visible, isVisible, setVisible: update };
}

export interface ColumnVisibilityMenuProps {
  columns: ColumnDef[];
  visible: Set<string>;
  onVisibleChange: (next: Set<string>) => void;
  className?: string;
}

export function ColumnVisibilityMenu({ columns, visible, onVisibleChange, className }: ColumnVisibilityMenuProps) {
  const toggle = (id: string) => {
    const next = new Set(visible);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onVisibleChange(next);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Choose visible columns"
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border border-border-soft bg-card px-3 py-2 text-[13px] text-foreground hover:border-brand/50",
            className,
          )}
        >
          <Columns3 aria-hidden className="size-3.5 text-muted-foreground" />
          Columns
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[220px] rounded-xl border-border-soft p-2">
        {columns.map((c) => (
          <label
            key={c.id}
            className={cn(
              "flex items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px]",
              c.locked ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer hover:bg-bg-soft",
            )}
          >
            <Checkbox checked={c.locked || visible.has(c.id)} disabled={c.locked} onCheckedChange={() => toggle(c.id)} />
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            {c.locked && <span className="text-[11px]">(locked)</span>}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}
