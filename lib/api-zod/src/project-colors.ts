export const PROJECT_COLORS: readonly string[] = [
  "#6366f1","#f59e0b","#10b981","#3b82f6","#ec4899",
  "#8b5cf6","#f97316","#14b8a6","#ef4444","#84cc16",
  "#06b6d4","#a855f7","#d946ef","#0ea5e9","#22c55e",
  "#fb923c","#e11d48","#7c3aed","#2563eb","#059669",
];

export function resolveProjectColor(projectId: number, stored: string | null | undefined): string {
  return stored ?? PROJECT_COLORS[projectId % PROJECT_COLORS.length];
}
