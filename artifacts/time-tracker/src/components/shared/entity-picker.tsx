/**
 * EntityPicker — single-select "jump the whole page to one entity" control
 * (formalized from the Billing project picker).
 * Breadcrumb trigger ("Client › Project"), popover with search and entries
 * grouped alphabetically by group name. NOT a multi-select filter.
 */
import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { SearchInput } from "./search-input";

export interface EntityPickerItem {
  id: number | string;
  label: string;
  /** Breadcrumb prefix + grouping header, e.g. the client name. */
  group?: string;
}

export interface EntityPickerProps {
  items: EntityPickerItem[];
  value: number | string | null;
  onValueChange: (id: number | string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
}

export function EntityPicker({
  items,
  value,
  onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  className,
}: EntityPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const current = items.find((i) => i.id === value) ?? null;

  const q = search.trim().toLowerCase();
  const visible = q
    ? items.filter((i) => i.label.toLowerCase().includes(q) || i.group?.toLowerCase().includes(q))
    : items;
  const groups = React.useMemo(() => {
    const map = new Map<string, EntityPickerItem[]>();
    for (const item of visible) {
      const g = item.group ?? "";
      const arr = map.get(g) ?? [];
      arr.push(item);
      map.set(g, arr);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([g, arr]) => [g, arr.sort((a, b) => a.label.localeCompare(b.label))] as const);
  }, [visible]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "inline-flex min-w-[220px] items-center justify-between gap-2 rounded-lg border border-border-soft bg-card px-3 py-2 text-[13px] hover:border-brand/50",
            className,
          )}
        >
          {current ? (
            <span className="min-w-0 truncate">
              {current.group && <span className="text-muted-foreground">{current.group} › </span>}
              <span className="font-semibold text-navy">{current.label}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] rounded-xl border-border-soft p-3">
        <SearchInput value={search} onValueChange={setSearch} placeholder={searchPlaceholder} className="mb-2 py-1.5" autoFocus />
        <div className="max-h-[300px] overflow-y-auto pr-1">
          {groups.length === 0 && <p className="px-1 py-3 text-center text-[13px] text-muted-foreground">No matches</p>}
          {groups.map(([group, groupItems]) => (
            <div key={group || "__ungrouped"}>
              {group && (
                <p className="m-0 px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.03em] text-muted-foreground">
                  {group}
                </p>
              )}
              {groupItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onValueChange(item.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] hover:bg-bg-soft",
                    item.id === value && "font-medium text-navy",
                  )}
                >
                  <Check aria-hidden className={cn("size-3.5 shrink-0 text-brand", item.id !== value && "invisible")} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
