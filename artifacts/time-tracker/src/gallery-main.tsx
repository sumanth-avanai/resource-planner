/**
 * Dev-only gallery of the 16 shared components (Step 2 acceptance check).
 * Open http://localhost:5173/gallery.html while running `pnpm dev:mock`.
 * Not referenced by the app or the production build.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Shield, Smile, MessageSquareDashed } from "lucide-react";
import "./index.css";
import {
  AbsenceCell,
  BudgetBar,
  Button,
  ColumnVisibilityMenu,
  ConfirmModal,
  DataTable,
  EmptyState,
  EmptyValue,
  EntityPicker,
  FilterPanel,
  IconChip,
  KpiCard,
  KpiStrip,
  PeriodPicker,
  resolvePeriod,
  SearchInput,
  SharedTooltip,
  StatusPill,
  TimelineEntry,
  useColumnVisibility,
  type DataTableColumn,
  type PeriodValue,
} from "@/components/shared";

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border-soft bg-card px-7 py-6">
      <h2 className="m-0 text-[15px] font-semibold text-navy">{title}</h2>
      {note && <p className="mb-4 mt-1 text-[13px] text-muted-foreground">{note}</p>}
      <div className={note ? "" : "mt-4"}>{children}</div>
    </section>
  );
}

interface DemoRow {
  id: number;
  project: string;
  client: string;
  health: string;
  budgetPct: number | null;
  accent: "danger" | "warning" | null;
}

const demoRows: DemoRow[] = [
  { id: 1, project: "Website relaunch", client: "Client GmbH", health: "At risk", budgetPct: 82, accent: "warning" },
  { id: 2, project: "App redesign", client: "Client GmbH", health: "On track", budgetPct: 34, accent: null },
  { id: 3, project: "Platform migration", client: "Nordwind AG", health: "Delayed", budgetPct: 93, accent: "danger" },
  { id: 4, project: "Internal tooling", client: "", health: "On track", budgetPct: null, accent: null },
];

const demoColumns: Array<DataTableColumn<DemoRow>> = [
  { id: "project", header: "Project", sortable: true, sortValue: (r) => r.project, cell: (r) => <span className="font-medium text-navy">{r.project}</span> },
  {
    id: "health",
    header: "Health",
    cell: (r) => (
      <StatusPill tone={r.health === "On track" ? "success" : r.health === "At risk" ? "warning" : "danger"}>{r.health}</StatusPill>
    ),
  },
  {
    id: "budget",
    header: "Budget",
    sortable: true,
    align: "right",
    sortValue: (r) => r.budgetPct,
    cell: (r) => (r.budgetPct == null ? <EmptyValue label="No hours logged yet" /> : `${r.budgetPct}%`),
  },
];

function Gallery() {
  const [filterSel, setFilterSel] = React.useState<Set<number | string>>(new Set([1, 2, 3]));
  const [entity, setEntity] = React.useState<number | string | null>(2);
  const [period, setPeriod] = React.useState<PeriodValue>(resolvePeriod("this_month"));
  const [search, setSearch] = React.useState("");
  const [modalOpen, setModalOpen] = React.useState(false);
  const galleryCols = [
    { id: "project", label: "Project", locked: true },
    { id: "budget", label: "Budget" },
    { id: "pm", label: "PM", defaultHidden: true },
  ];
  const { visible, setVisible } = useColumnVisibility("gallery-columns", galleryCols);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-bg-soft px-6 py-10">
        <div className="mx-auto flex max-w-[960px] flex-col gap-5">
          <header>
            <h1 className="m-0 text-[22px] font-semibold text-navy">AvaTrack — shared component library</h1>
            <p className="m-0 mt-1 text-[13px] text-muted-foreground">
              Step 2 acceptance gallery · all 16 components, avanai CI tokens · dev-only page
            </p>
          </header>

          <Section title="1 · Button" note="One primary action per view; danger only for destructive actions.">
            <div className="flex flex-wrap gap-2.5">
              <Button>Create project</Button>
              <Button variant="secondary">Export report</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="danger">Remove entry</Button>
              <Button size="sm">Small</Button>
              <Button disabled>Disabled</Button>
            </div>
          </Section>

          <Section title="2 · StatusPill" note="Icon-chip pills for status everywhere.">
            <div className="flex flex-wrap gap-2">
              <StatusPill tone="success">On track</StatusPill>
              <StatusPill tone="warning">At risk</StatusPill>
              <StatusPill tone="danger">Delayed</StatusPill>
              <StatusPill tone="neutral">Tentative</StatusPill>
            </div>
          </Section>

          <Section title="3 · IconChip" note="Compact circular chips for Risk / Satisfaction; exact label via tooltip.">
            <div className="flex gap-2">
              <SharedTooltip content="Low risk — reassessed 3 days ago">
                <IconChip tone="success" label="Low risk"><Shield /></IconChip>
              </SharedTooltip>
              <SharedTooltip content="Client satisfaction: happy">
                <IconChip tone="success" label="Happy client"><Smile /></IconChip>
              </SharedTooltip>
              <SharedTooltip content="High risk">
                <IconChip tone="danger" label="High risk"><Shield /></IconChip>
              </SharedTooltip>
            </div>
          </Section>

          <Section title="4 · BudgetBar" note="Threshold-colored (green <70, amber 70–90, red ≥90). Absolute amount always beside percentage.">
            <div className="grid gap-5 sm:grid-cols-3">
              <BudgetBar total={198000} invoiced={69300} logged={21700} showLegend />
              <BudgetBar total={100000} invoiced={52000} logged={26000} showLegend />
              <BudgetBar total={80000} invoiced={60000} logged={14500} showLegend />
            </div>
          </Section>

          <Section title="5 · KpiCard / KpiStrip" note="Scan-first summary strip above tables.">
            <KpiStrip>
              <KpiCard label="Active projects" value={24} />
              <KpiCard label="Needs attention" value={3} tone="danger" />
              <KpiCard label="Update overdue" value={2} tone="warning" />
              <KpiCard label="Total booked" value="612h" tone="brand" hint="this week" />
            </KpiStrip>
          </Section>

          <Section title="6 · DataTable" note="Sortable headers, severity accent rows sort to top, explicit empty labels.">
            <DataTable columns={demoColumns} rows={demoRows} rowKey={(r) => r.id} rowAccent={(r) => r.accent} />
            <div className="mt-4">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Grouped by client</p>
              <DataTable
                columns={demoColumns}
                rows={demoRows}
                rowKey={(r) => `g-${r.id}`}
                rowAccent={(r) => r.accent}
                groupBy={(r) => r.client || null}
              />
            </div>
          </Section>

          <Section title="7 · FilterPanel (multi-select)" note="Searchable, client-grouped checklist with active-count badge. Unchecking hides rows.">
            <FilterPanel
              label="Projects"
              items={[
                { id: 1, label: "Website Relaunch", group: "Client GmbH", color: "#3B6FE0" },
                { id: 2, label: "Design System", group: "Client GmbH", color: "#E5484D" },
                { id: 3, label: "Platform Migration", group: "Nordwind AG", color: "#A24FD6" },
                { id: 4, label: "Data Warehouse", group: "Nordwind AG", color: "#E8A33D" },
              ]}
              selected={filterSel}
              onSelectedChange={setFilterSel}
              searchPlaceholder="Search projects…"
            />
          </Section>

          <Section title="8 · EntityPicker (single-select)" note="Jumps the page to one entity — breadcrumb trigger, never a checkbox list.">
            <EntityPicker
              items={[
                { id: 1, label: "Website Relaunch", group: "Client GmbH" },
                { id: 2, label: "Design System", group: "Client GmbH" },
                { id: 3, label: "Platform Migration", group: "Nordwind AG" },
              ]}
              value={entity}
              onValueChange={setEntity}
              searchPlaceholder="Search projects…"
            />
          </Section>

          <Section title="9 · PeriodPicker" note="Preset dropdown, not prev/next arrows. Custom range reveals the date inputs.">
            <PeriodPicker value={period} onValueChange={setPeriod} />
          </Section>

          <Section title="10 · ColumnVisibilityMenu" note="Persisted via localStorage; identity column locked.">
            <ColumnVisibilityMenu columns={galleryCols} visible={visible} onVisibleChange={setVisible} />
          </Section>

          <Section title="11 · ConfirmModal" note="Title + one-line description, primary action right-aligned.">
            <Button variant="secondary" onClick={() => setModalOpen(true)}>Open “Generate invoice” modal</Button>
            <ConfirmModal
              open={modalOpen}
              onOpenChange={setModalOpen}
              title="Generate invoice"
              description="Period: June 2026 · 3 positions · €12,400 total"
              confirmLabel="Generate invoice"
              onConfirm={() => {}}
            >
              <input
                type="text"
                placeholder="Invoice reference (optional)"
                className="w-full rounded-md border border-border-soft px-2.5 py-2 text-[13px]"
              />
            </ConfirmModal>
          </Section>

          <Section title="12 · SearchInput">
            <SearchInput value={search} onValueChange={setSearch} placeholder="Search projects…" className="max-w-[260px]" />
          </Section>

          <Section title="13 · SharedTooltip" note="Navy tooltip for exact labels and dense identifiers.">
            <SharedTooltip content="Client GmbH · €960/day · Mar 2 – Oct 30">
              <span className="cursor-default text-[13px] font-medium text-brand underline decoration-dotted">
                Hover for details
              </span>
            </SharedTooltip>
          </Section>

          <Section title="14 · EmptyState / EmptyValue" note="Explicit label, never a bare dash.">
            <EmptyState icon={<MessageSquareDashed />} label="No comment yet" hint="Updates appear here once a health check is posted." />
            <p className="mb-0 mt-3 text-[13px]">
              Inline cell variant: <EmptyValue label="Not assessed" />
            </p>
          </Section>

          <Section title="15 · AbsenceCell" note="Icon + neutral gray, never stripes: star / sun / thermometer / X.">
            <div className="flex h-9 gap-2 [&>div]:w-auto [&>div]:px-3">
              <AbsenceCell type="holiday" showLabel />
              <AbsenceCell type="vacation" showLabel detail="Summer break" />
              <AbsenceCell type="sick" showLabel />
              <AbsenceCell type="unpaid_leave" showLabel />
            </div>
          </Section>

          <Section title="16 · TimelineEntry" note="Fixed-width left column (date + chips), right column comment or explicit empty label.">
            <TimelineEntry
              date="Jul 3, 2026"
              statusLabel="In progress"
              chips={
                <>
                  <IconChip size="sm" tone="success" label="Low risk"><Shield /></IconChip>
                  <IconChip size="sm" tone="success" label="Happy"><Smile /></IconChip>
                </>
              }
            >
              Client confirmed scope for phase 2. Team velocity stable.
            </TimelineEntry>
            <TimelineEntry
              date="Jun 20, 2026"
              statusLabel="In progress"
              chips={<IconChip size="sm" tone="warning" label="Medium risk"><Shield /></IconChip>}
              isLast
            />
          </Section>
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Gallery />);
