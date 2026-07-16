/**
 * DataTable — shared table spec from the component library:
 * - sortable column headers (chevron on hover/active)
 * - optional collapsible group headers (name + count + attention indicator)
 * - attention rows get a severity-colored left accent border (severity, never
 *   project color) and sort to the top by default
 * - empty-state rows use an explicit label, never a bare dash
 */
import * as React from "react";
import { ChevronDown, ChevronRight, ChevronsUpDown, ArrowUp, ArrowDown, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export type RowAccent = "danger" | "warning" | null | undefined;

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  sortable?: boolean;
  /** Value used for sorting; required when sortable. */
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "right" | "center";
  headerClassName?: string;
  cellClassName?: string;
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  /** Severity accent for a row (left border). */
  rowAccent?: (row: T) => RowAccent;
  /** Attention rows sort before others (default true when rowAccent given). */
  attentionFirst?: boolean;
  /** Group rows under collapsible headers. Return null/undefined for ungrouped rows (appended plain at the bottom, per the grouping decision). */
  groupBy?: (row: T) => string | null | undefined;
  /** Persist collapsed groups under this localStorage key. */
  collapseStorageKey?: string;
  onRowClick?: (row: T) => void;
  /** Shown when rows is empty. */
  emptyLabel?: string;
  className?: string;
  initialSort?: { columnId: string; direction: "asc" | "desc" };
}

function useCollapsedGroups(storageKey?: string) {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => {
    if (!storageKey) return new Set();
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
    return new Set();
  });
  const toggle = (group: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  };
  return { collapsed, toggle };
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowAccent,
  attentionFirst = true,
  groupBy,
  collapseStorageKey,
  onRowClick,
  emptyLabel = "No data for the current selection",
  className,
  initialSort,
}: DataTableProps<T>) {
  const [sort, setSort] = React.useState<{ columnId: string; direction: "asc" | "desc" } | null>(initialSort ?? null);
  const { collapsed, toggle } = useCollapsedGroups(collapseStorageKey);

  const sorted = React.useMemo(() => {
    let out = rows.slice();
    if (sort) {
      const col = columns.find((c) => c.id === sort.columnId);
      if (col?.sortValue) {
        const dir = sort.direction === "asc" ? 1 : -1;
        out.sort((a, b) => {
          const va = col.sortValue!(a);
          const vb = col.sortValue!(b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))) * dir;
        });
      }
    }
    if (rowAccent && attentionFirst) {
      const rank = (r: T) => (rowAccent(r) === "danger" ? 0 : rowAccent(r) === "warning" ? 1 : 2);
      out = out
        .map((r, i) => [r, i] as const)
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
        .map(([r]) => r);
    }
    return out;
  }, [rows, sort, columns, rowAccent, attentionFirst]);

  const grouped = React.useMemo(() => {
    if (!groupBy) return null;
    const map = new Map<string, T[]>();
    const ungrouped: T[] = [];
    for (const row of sorted) {
      const g = groupBy(row);
      if (g == null || g === "") {
        ungrouped.push(row);
        continue;
      }
      const arr = map.get(g) ?? [];
      arr.push(row);
      map.set(g, arr);
    }
    return { groups: [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])), ungrouped };
  }, [sorted, groupBy]);

  const onHeaderClick = (col: DataTableColumn<T>) => {
    if (!col.sortable) return;
    setSort((prev) =>
      prev?.columnId === col.id
        ? prev.direction === "asc"
          ? { columnId: col.id, direction: "desc" }
          : null
        : { columnId: col.id, direction: "asc" },
    );
  };

  const alignClass = (a?: "left" | "right" | "center") =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  const renderRow = (row: T) => {
    const accent = rowAccent?.(row);
    return (
      <tr
        key={rowKey(row)}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        className={cn(
          "border-b border-border-soft/60 last:border-b-0",
          onRowClick && "cursor-pointer",
          accent === "danger" && "shadow-[inset_4px_0_0_0_var(--color-status-danger)]",
          accent === "warning" && "shadow-[inset_4px_0_0_0_var(--color-status-warning)]",
        )}
      >
        {columns.map((col) => (
          <td key={col.id} className={cn("px-3 py-2.5 text-[13px]", alignClass(col.align), col.cellClassName)}>
            {col.cell(row)}
          </td>
        ))}
      </tr>
    );
  };

  const renderGroupHeader = (group: string, groupRows: T[]) => {
    const isCollapsed = collapsed.has(group);
    const hasAttention = rowAccent ? groupRows.some((r) => rowAccent(r)) : false;
    return (
      <tr key={`__group-${group}`} className="border-b border-border-soft/60">
        <td colSpan={columns.length} className="bg-bg-soft px-3 py-2">
          <button
            type="button"
            onClick={() => toggle(group)}
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold text-navy"
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {group}
            <span className="font-normal text-muted-foreground">
              ({groupRows.length} {groupRows.length === 1 ? "project" : "projects"})
            </span>
            {hasAttention && <AlertTriangle aria-label="Contains items needing attention" className="size-3.5 text-status-warning" />}
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border-soft bg-card", className)}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border-soft">
            {columns.map((col) => (
              <th
                key={col.id}
                onClick={() => onHeaderClick(col)}
                aria-sort={sort?.columnId === col.id ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                className={cn(
                  "group px-3 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground",
                  alignClass(col.align),
                  col.sortable && "cursor-pointer select-none hover:text-navy",
                  col.headerClassName,
                )}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {col.sortable &&
                    (sort?.columnId === col.id ? (
                      sort.direction === "asc" ? (
                        <ArrowUp className="size-3 text-brand" />
                      ) : (
                        <ArrowDown className="size-3 text-brand" />
                      )
                    ) : (
                      <ChevronsUpDown className="size-3 opacity-0 group-hover:opacity-60" />
                    ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                {emptyLabel}
              </td>
            </tr>
          )}
          {grouped ? (
            <>
              {grouped.groups.map(([group, groupRows]) => (
                <React.Fragment key={group}>
                  {renderGroupHeader(group, groupRows)}
                  {!collapsed.has(group) && groupRows.map(renderRow)}
                </React.Fragment>
              ))}
              {grouped.ungrouped.map(renderRow)}
            </>
          ) : (
            sorted.map(renderRow)
          )}
        </tbody>
      </table>
    </div>
  );
}
