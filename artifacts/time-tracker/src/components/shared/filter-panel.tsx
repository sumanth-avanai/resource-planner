/**
 * FilterPanel — multi-select filter: searchable, groupable checklist with an
 * active-count badge (Resource Planner pattern from the decisions log).
 * Unchecking an item HIDES matching rows/segments (not dims).
 *
 * Mechanically distinct from the single-select EntityPicker — never swap them.
 */
import * as React from "react";
import { ChevronDown, ListFilter } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { SearchInput } from "./search-input";

export interface FilterItem {
  id: number | string;
  label: string;
  /** Group header the item is listed under (e.g. client name). */
  group?: string;
  /** Optional color dot (e.g. project color). */
  color?: string;
}

export interface FilterPanelProps {
  /** Trigger label, e.g. "Projects" or "Clients". */
  label: string;
  items: FilterItem[];
  /** Currently selected ids. Empty set is treated as "none selected". */
  selected: Set<number | string>;
  onSelectedChange: (next: Set<number | string>) => void;
  searchPlaceholder?: string;
  className?: string;
  /** Width of the popover panel. */
  panelClassName?: string;
}

export function FilterPanel({
  label,
  items,
  selected,
  onSelectedChange,
  searchPlaceholder = "Search…",
  className,
  panelClassName,
}: FilterPanelProps) {
  const [search, setSearch] = React.useState("");
  const q = search.trim().toLowerCase();
  const visible = q
    ? items.filter((i) => i.label.toLowerCase().includes(q) || i.group?.toLowerCase().includes(q))
    : items;

  const groups = React.useMemo(() => {
    const map = new Map<string, FilterItem[]>();
    for (const item of visible) {
      const g = item.group ?? "";
      const arr = map.get(g) ?? [];
      arr.push(item);
      map.set(g, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const activeCount = selected.size;
  const allSelected = activeCount === items.length && items.length > 0;

  const toggle = (id: number | string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };
  const setAll = (on: boolean) => onSelectedChange(on ? new Set(items.map((i) => i.id)) : new Set());

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border border-border-soft bg-card px-3 py-2 text-[13px] text-foreground hover:border-brand/50",
            className,
          )}
        >
          <ListFilter aria-hidden className="size-3.5 text-muted-foreground" />
          {label}
          <span
            className={cn(
              "rounded-full px-2 py-px text-[11px] font-semibold leading-4",
              activeCount > 0 && !allSelected ? "bg-brand text-white" : "bg-bg-soft text-muted-foreground",
            )}
          >
            {allSelected ? "All" : activeCount}
          </span>
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("w-[280px] rounded-xl border-border-soft p-3", panelClassName)}>
        <SearchInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} className="mb-2 py-1.5" />
        <div className="mb-2 flex gap-3 px-1 text-xs">
          <button type="button" className="text-brand hover:underline" onClick={() => setAll(true)}>
            Select all
          </button>
          <button type="button" className="text-muted-foreground hover:underline" onClick={() => setAll(false)}>
            Clear
          </button>
        </div>
        <div className="max-h-[280px] overflow-y-auto pr-1">
          {groups.length === 0 && <p className="px-1 py-3 text-center text-[13px] text-muted-foreground">No matches</p>}
          {groups.map(([group, groupItems]) => (
            <div key={group || "__ungrouped"}>
              {group && (
                <p className="m-0 px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
                  {group}
                </p>
              )}
              {groupItems.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px] hover:bg-bg-soft"
                >
                  <Checkbox checked={selected.has(item.id)} onCheckedChange={() => toggle(item.id)} />
                  {item.color && (
                    <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: item.color }} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
