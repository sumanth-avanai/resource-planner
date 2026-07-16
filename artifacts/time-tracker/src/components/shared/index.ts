/**
 * AvaTrack shared component library (Step 2 of the redesign).
 * Source of truth: avatrack-component-library.html + avatrack-decisions-log.md.
 *
 * 16 components. Nothing here changes existing pages until they import from
 * "@/components/shared".
 */
export { Button, sharedButtonVariants, type SharedButtonProps } from "./button";
export { StatusPill, type StatusPillProps, type StatusTone } from "./status-pill";
export { IconChip, type IconChipProps } from "./icon-chip";
export { BudgetBar, budgetTone, type BudgetBarProps } from "./budget-bar";
export { KpiCard, KpiStrip, type KpiCardProps } from "./kpi-card";
export { DataTable, type DataTableColumn, type DataTableProps, type RowAccent } from "./data-table";
export { FilterPanel, type FilterItem, type FilterPanelProps } from "./filter-panel";
export { EntityPicker, type EntityPickerItem, type EntityPickerProps } from "./entity-picker";
export { PeriodPicker, resolvePeriod, type PeriodPreset, type PeriodValue, type PeriodPickerProps } from "./period-picker";
export {
  ColumnVisibilityMenu,
  useColumnVisibility,
  type ColumnDef,
  type ColumnVisibilityMenuProps,
} from "./column-visibility-menu";
export { ConfirmModal, type ConfirmModalProps } from "./confirm-modal";
export { SearchInput, type SearchInputProps } from "./search-input";
export { SharedTooltip, type SharedTooltipProps } from "./tooltip";
export { EmptyState, EmptyValue, type EmptyStateProps } from "./empty-state";
export { AbsenceCell, absenceTypeLabel, type AbsenceCellProps, type AbsenceType } from "./absence-cell";
export { TimelineEntry, type TimelineEntryProps } from "./timeline-entry";
