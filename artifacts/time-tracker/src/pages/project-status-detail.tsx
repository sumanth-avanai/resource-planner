import { useState, useRef, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetProjectStatusDetail, getGetProjectStatusDetailQueryKey } from "@workspace/api-client-react";
import type { ProjectHealthUpdate } from "@workspace/api-client-react";
import { AdminLayout } from "@/components/layout/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Plus,
  ExternalLink,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
  CheckSquare,
  Square,
  Trash2,
  CalendarDays,
  Shield,
  ShieldAlert,
  Smile,
  Meh,
  Frown,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNowStrict, isPast } from "date-fns";
// ─── Types ────────────────────────────────────────────────────────────────────

interface NextStep {
  id: string;
  text: string;
  done: boolean;
}

// ─── Label / option maps ──────────────────────────────────────────────────────

const GENERAL_STATUS_OPTIONS = [
  { value: "planned",     label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "on_hold",     label: "On Hold" },
  { value: "completed",   label: "Completed" },
  { value: "cancelled",   label: "Cancelled" },
];

const RISK_LEVEL_OPTIONS = [
  { value: "low",    label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high",   label: "High" },
];

const CLIENT_SATISFACTION_OPTIONS = [
  { value: "happy",    label: "Happy" },
  { value: "neutral",  label: "Neutral" },
  { value: "critical", label: "Critical" },
];

const GENERAL_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  GENERAL_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);
const RISK_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  RISK_LEVEL_OPTIONS.map((o) => [o.value, o.label]),
);
const CLIENT_SATISFACTION_LABELS: Record<string, string> = Object.fromEntries(
  CLIENT_SATISFACTION_OPTIONS.map((o) => [o.value, o.label]),
);

// ─── Badge helpers ────────────────────────────────────────────────────────────

function generalStatusCls(s: string | null) {
  switch (s) {
    case "planned":     return "bg-blue-500/15 text-blue-400 border-blue-500/25";
    case "in_progress": return "bg-green-500/15 text-green-400 border-green-500/25";
    case "on_hold":     return "bg-yellow-500/15 text-yellow-400 border-yellow-500/25";
    case "completed":
    case "cancelled":   return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    default:            return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function riskLevelCls(s: string | null) {
  switch (s) {
    case "low":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "medium": return "bg-orange-500/15 text-orange-400 border-orange-500/25";
    case "high":   return "bg-red-500/15 text-red-400 border-red-500/25";
    default:       return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function clientSatisfactionCls(s: string | null) {
  switch (s) {
    case "happy":    return "bg-green-500/15 text-green-400 border-green-500/25";
    case "neutral":  return "bg-gray-500/15 text-gray-400 border-gray-500/25";
    case "critical": return "bg-red-500/15 text-red-400 border-red-500/25";
    default:         return "bg-white/5 text-muted-foreground border-white/10";
  }
}

function StatusBadge({
  value,
  labels,
  cls,
  size = "sm",
}: {
  value: string | null;
  labels: Record<string, string>;
  cls: (v: string | null) => string;
  size?: "sm" | "lg";
}) {
  if (!value) return <span className="text-muted-foreground/40 text-xs">—</span>;
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border font-medium",
      size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs",
      cls(value),
    )}>
      {labels[value] ?? value}
    </span>
  );
}

// ─── Trend arrow ──────────────────────────────────────────────────────────────

function TrendArrow({ direction }: { direction: "up" | "down" | "stable" | null }) {
  if (!direction) return null;
  if (direction === "up")
    return <TrendingUp className="h-4 w-4 text-red-400 shrink-0" strokeWidth={2} />;
  if (direction === "down")
    return <TrendingDown className="h-4 w-4 text-green-400 shrink-0" strokeWidth={2} />;
  return <Minus className="h-4 w-4 text-muted-foreground/60 shrink-0" strokeWidth={2} />;
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

const PALETTE = [
  "#8B5CF6","#06B6D4","#10B981","#F59E0B",
  "#EF4444","#3B82F6","#EC4899","#F97316",
];
function resolveColor(color: string | null | undefined, id: number): string {
  return color ?? PALETTE[id % PALETTE.length];
}

// ─── KPI cards ────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  accent?: "red" | "amber" | "green";
}) {
  const valueCls =
    accent === "red" ? "text-red-400" :
    accent === "amber" ? "text-amber-400" :
    accent === "green" ? "text-green-400" : "text-foreground";
  return (
    <div className="rounded-xl border border-white/8 bg-white/2 p-4 flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground/50 shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
        <p className={cn("text-lg font-semibold truncate", valueCls)}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground/60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Next steps checklist ─────────────────────────────────────────────────────

function NextStepsChecklist({
  projectId,
  initialSteps,
  onSaved,
}: {
  projectId: number;
  initialSteps: NextStep[] | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [steps, setSteps] = useState<NextStep[]>(initialSteps ?? []);
  const [newText, setNewText] = useState("");
  const [dirty, setDirty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const saveMutation = useMutation({
    mutationFn: async (nextSteps: NextStep[]) => {
      const res = await fetch(`/api/project-status/${projectId}/next-steps`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ nextSteps }),
      });
      if (!res.ok) throw new Error("Failed to save");
    },
    onSuccess: () => {
      setDirty(false);
      onSaved();
      toast({ title: "Next steps saved" });
    },
    onError: () => toast({ title: "Failed to save next steps", variant: "destructive" }),
  });

  function mutateSteps(next: NextStep[]) {
    setSteps(next);
    setDirty(true);
  }

  function toggleDone(id: string) {
    mutateSteps(steps.map((s) => s.id === id ? { ...s, done: !s.done } : s));
  }

  function removeStep(id: string) {
    mutateSteps(steps.filter((s) => s.id !== id));
  }

  function addStep() {
    const text = newText.trim();
    if (!text) return;
    mutateSteps([...steps, { id: crypto.randomUUID(), text, done: false }]);
    setNewText("");
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); addStep(); }
  }

  const done  = steps.filter((s) =>  s.done).length;
  const total = steps.length;

  return (
    <div>
      {total > 0 && (
        <p className="text-xs text-muted-foreground mb-3">
          {done}/{total} done
        </p>
      )}

      <div className="space-y-1 mb-3">
        {steps.map((step) => (
          <div
            key={step.id}
            className={cn(
              "group flex items-center gap-2 rounded-lg px-3 py-2 transition-colors",
              step.done ? "bg-white/2" : "bg-white/3 hover:bg-white/5",
            )}
          >
            <button
              type="button"
              onClick={() => toggleDone(step.id)}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              {step.done
                ? <CheckSquare className="h-4 w-4 text-violet-400" />
                : <Square className="h-4 w-4" />
              }
            </button>
            <span className={cn("flex-1 text-sm", step.done && "line-through text-muted-foreground/50")}>
              {step.text}
            </span>
            <button
              type="button"
              onClick={() => removeStep(step.id)}
              className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {steps.length === 0 && (
          <p className="text-sm text-muted-foreground/60 py-2 pl-1">
            No next steps yet — add one below.
          </p>
        )}
      </div>

      {/* Add row */}
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          placeholder="Add a next step…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 h-8 text-sm"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={addStep}
          disabled={!newText.trim()}
          className="h-8 px-3"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {dirty && (
        <div className="flex justify-end mt-3">
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(steps)}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── History entry ────────────────────────────────────────────────────────────

function RiskChip({ riskLevel }: { riskLevel: string }) {
  const cls =
    riskLevel === "high"   ? "bg-red-500/20 text-red-400 ring-red-500/30" :
    riskLevel === "medium" ? "bg-orange-500/20 text-orange-400 ring-orange-500/30" :
                             "bg-green-500/20 text-green-400 ring-green-500/30";
  const Icon = riskLevel === "high" ? ShieldAlert : Shield;
  return (
    <span className={cn("inline-flex items-center justify-center h-6 w-6 rounded-full ring-1 shrink-0", cls)}
      title={`Risk: ${RISK_LEVEL_LABELS[riskLevel] ?? riskLevel}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function SatisfactionChip({ satisfaction }: { satisfaction: string }) {
  const cls =
    satisfaction === "happy"    ? "bg-green-500/20 text-green-400 ring-green-500/30" :
    satisfaction === "critical" ? "bg-red-500/20 text-red-400 ring-red-500/30" :
                                  "bg-gray-500/20 text-gray-400 ring-gray-500/30";
  const Icon =
    satisfaction === "happy"    ? Smile :
    satisfaction === "critical" ? Frown  : Meh;
  return (
    <span className={cn("inline-flex items-center justify-center h-6 w-6 rounded-full ring-1 shrink-0", cls)}
      title={`Satisfaction: ${CLIENT_SATISFACTION_LABELS[satisfaction] ?? satisfaction}`}
    >
      <Icon className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function HistoryEntry({ entry, isFirst }: { entry: ProjectHealthUpdate; isFirst: boolean }) {
  return (
    <div className="flex gap-3">
      {/* Timeline spine */}
      <div className="flex flex-col items-center pt-1 shrink-0">
        <div className={cn(
          "h-2.5 w-2.5 rounded-full shrink-0 ring-2 ring-background",
          isFirst ? "bg-violet-400" : "bg-white/20",
        )} />
        <div className="w-px flex-1 bg-white/8 mt-1" />
      </div>

      {/* Two-column content */}
      <div className="pb-6 min-w-0 flex-1 grid grid-cols-[110px_1fr] gap-4">
        {/* Left col: date + status plain text + icon chips */}
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground/60 mb-1.5 whitespace-nowrap">
            {format(new Date(entry.createdAt), "dd MMM yyyy")}
          </p>
          <p className="text-sm font-medium mb-2 truncate">
            {GENERAL_STATUS_LABELS[entry.generalStatus] ?? entry.generalStatus}
          </p>
          <div className="flex items-center gap-1.5">
            <RiskChip riskLevel={entry.riskLevel} />
            {entry.clientSatisfaction && (
              <SatisfactionChip satisfaction={entry.clientSatisfaction} />
            )}
          </div>
        </div>

        {/* Right col: comment */}
        <div className="pt-5 min-w-0">
          {entry.comment ? (
            <p className="text-sm text-foreground/80 whitespace-pre-wrap">
              {entry.comment}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/40 italic">No comment</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add Update Dialog ────────────────────────────────────────────────────────

interface AddUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  defaults: { generalStatus: string; riskLevel: string; clientSatisfaction: string };
  onSuccess: () => void;
}

function AddUpdateDialog({ open, onClose, projectId, defaults, onSuccess }: AddUpdateDialogProps) {
  const { toast } = useToast();
  const [generalStatus,      setGeneralStatus]      = useState(defaults.generalStatus);
  const [riskLevel,          setRiskLevel]          = useState(defaults.riskLevel);
  const [clientSatisfaction, setClientSatisfaction] = useState(defaults.clientSatisfaction);
  const [comment,            setComment]            = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/project-status/${projectId}/health-updates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          generalStatus,
          riskLevel,
          clientSatisfaction: clientSatisfaction && clientSatisfaction !== "__none__" ? clientSatisfaction : undefined,
          comment: comment || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status update saved" });
      setComment("");
      onSuccess();
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  function handleOpenChange(v: boolean) { if (!v) onClose(); }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Status Update</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">General Status</Label>
            <Select value={generalStatus} onValueChange={setGeneralStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GENERAL_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Risk Level</Label>
            <Select value={riskLevel} onValueChange={setRiskLevel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RISK_LEVEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Client Satisfaction <span className="text-muted-foreground/50">(optional)</span></Label>
            <Select value={clientSatisfaction} onValueChange={setClientSatisfaction}>
              <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Not set</SelectItem>
                {CLIENT_SATISFACTION_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Comment <span className="text-muted-foreground/50">(optional)</span></Label>
            <Textarea
              rows={3}
              placeholder="Any notes about the current status…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ProjectStatusDetail() {
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const projectId = Number(id);

  const [dialogOpen, setDialogOpen] = useState(false);

  const { data, isLoading, isError } = useGetProjectStatusDetail(projectId, {
    query: { queryKey: getGetProjectStatusDetailQueryKey(projectId), enabled: !isNaN(projectId) },
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getGetProjectStatusDetailQueryKey(projectId) });
    queryClient.invalidateQueries({ queryKey: ["project-status"] });
  }

  if (isLoading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading…</div>
      </AdminLayout>
    );
  }

  if (isError || !data) {
    return (
      <AdminLayout>
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <p className="text-muted-foreground text-sm">Project not found.</p>
          <Button variant="outline" size="sm" onClick={() => navigate("/project-status")}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to overview
          </Button>
        </div>
      </AdminLayout>
    );
  }

  const { project, history } = data;
  const latestEntry = history[0] ?? null;
  const dot = resolveColor(project.color, project.id);

  const dialogDefaults = {
    generalStatus:      project.generalStatus      ?? "in_progress",
    riskLevel:          project.riskLevel          ?? "low",
    clientSatisfaction: project.clientSatisfaction ?? "__none__",
  };

  // KPI: Runtime
  const runtimeLabel = (() => {
    if (!project.startDate) return "Not set";
    const start = format(new Date(project.startDate), "MMM yyyy");
    if (!project.endDate) return `${start} – ongoing`;
    return `${start} – ${format(new Date(project.endDate), "MMM yyyy")}`;
  })();

  // KPI: Next update due
  const nextDueDate = project.nextUpdateDue ? new Date(project.nextUpdateDue) : null;
  const msUntilDue = nextDueDate ? nextDueDate.getTime() - Date.now() : null;
  const nearDue = msUntilDue !== null && msUntilDue > 0 && msUntilDue <= 3 * 24 * 60 * 60 * 1000;
  const nextDueLabel = nextDueDate
    ? (isPast(nextDueDate) ? `${format(nextDueDate, "dd MMM")} (overdue)` : format(nextDueDate, "dd MMM yyyy"))
    : "No updates yet";
  const nextDueSub = nextDueDate
    ? (project.updateOverdue ? "Overdue" : nearDue ? "Due soon" : formatDistanceToNowStrict(nextDueDate, { addSuffix: true }))
    : undefined;

  // KPI: Last comment
  const lastCommentLabel = project.lastCommentAt
    ? format(new Date(project.lastCommentAt), "dd MMM yyyy")
    : "No comments yet";
  const lastCommentSub = project.lastCommentAt
    ? formatDistanceToNowStrict(new Date(project.lastCommentAt), { addSuffix: true })
    : undefined;

  return (
    <AdminLayout>
      {/* Back */}
      <button
        onClick={() => navigate("/project-status")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-5"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        Project Status
      </button>

      {/* Project header */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span
              className="h-3.5 w-3.5 rounded-full ring-1 ring-white/10 shrink-0"
              style={{ background: dot }}
            />
            <h1 className="text-xl font-semibold">{project.name}</h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap pl-6">
            {project.clientName && <span>{project.clientName}</span>}
            {project.clientName && project.pmName && <span className="text-white/15">·</span>}
            {project.pmName && <span>PM: {project.pmName}</span>}
            {project.startDate && (
              <>
                <span className="text-white/15">·</span>
                <span>
                  {format(new Date(project.startDate), "MMM yyyy")}
                  {project.endDate && ` – ${format(new Date(project.endDate), "MMM yyyy")}`}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/reports`)}
          >
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
            Open in Reports
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Add Update
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <KpiCard
          label="Runtime"
          value={runtimeLabel}
          icon={<CalendarDays className="h-4 w-4" />}
        />
        <KpiCard
          label="Next update due"
          value={nextDueLabel}
          sub={nextDueSub}
          icon={<Clock className="h-4 w-4" />}
          accent={(project.updateOverdue || nearDue) ? "amber" : undefined}
        />
        <KpiCard
          label="Last comment"
          value={lastCommentLabel}
          sub={lastCommentSub}
          icon={<MessageSquare className="h-4 w-4" />}
        />
      </div>

      {/* Current health card */}
      <div className="rounded-xl border border-white/8 bg-white/2 p-5 mb-4">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">Current Health</h2>

        {project.generalStatus || project.riskLevel ? (
          <>
            {/* Status row */}
            <div className="flex flex-wrap gap-4 mb-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">General</span>
                <StatusBadge value={project.generalStatus ?? null} labels={GENERAL_STATUS_LABELS} cls={generalStatusCls} size="lg" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Risk</span>
                <div className="flex items-center gap-1.5">
                  <StatusBadge value={project.riskLevel ?? null} labels={RISK_LEVEL_LABELS} cls={riskLevelCls} size="lg" />
                  <TrendArrow direction={project.trendDirection as "up" | "down" | "stable" | null ?? null} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Satisfaction</span>
                <StatusBadge value={project.clientSatisfaction ?? null} labels={CLIENT_SATISFACTION_LABELS} cls={clientSatisfactionCls} size="lg" />
              </div>
            </div>

            {/* Last comment */}
            {latestEntry?.comment && (
              <p className="text-sm text-foreground/70 whitespace-pre-wrap bg-white/3 rounded-lg px-3 py-2.5 mt-2">
                {latestEntry.comment}
              </p>
            )}

            {latestEntry && (
              <p className="text-xs text-muted-foreground/50 mt-3">
                Last updated {format(new Date(latestEntry.createdAt), "dd MMM yyyy, HH:mm")}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
            <p className="text-sm text-muted-foreground">No status set yet.</p>
            <p className="text-xs text-muted-foreground/60">Click "Add Update" to record the first health check.</p>
          </div>
        )}
      </div>

      {/* Next Steps */}
      <div className="rounded-xl border border-white/8 bg-white/2 p-5 mb-4">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-4">Next Steps</h2>
        <NextStepsChecklist
          projectId={projectId}
          initialSteps={project.nextSteps as NextStep[] | null ?? null}
          onSaved={invalidate}
        />
      </div>

      {/* History */}
      <div className="rounded-xl border border-white/8 bg-white/2 p-5">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-5">Update History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No updates recorded yet.</p>
        ) : (
          <div>
            {history.map((entry, i) => (
              <HistoryEntry key={entry.id} entry={entry} isFirst={i === 0} />
            ))}
          </div>
        )}
      </div>

      {/* Add Update Dialog */}
      {dialogOpen && (
        <AddUpdateDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          projectId={projectId}
          defaults={dialogDefaults}
          onSuccess={invalidate}
        />
      )}
    </AdminLayout>
  );
}
