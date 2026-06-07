import { Badge } from "@/components/ui/badge";

export type TaskStatus = "running" | "completed" | "failed" | "pending" | "stopped";

interface StatusBadgeProps {
  status: TaskStatus | string;
  className?: string;
}

const STATUS_VARIANTS: Record<string, { className: string; label: string }> = {
  running: { className: 'bg-primary/15 text-primary border-primary/30', label: 'Running' },
  completed: { className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30', label: 'Completed' },
  failed: { className: 'bg-destructive/15 text-destructive border-destructive/30', label: 'Failed' },
  pending: { className: 'bg-muted text-muted-foreground border-border', label: 'Pending' },
  stopped: { className: 'bg-amber-500/15 text-amber-500 border-amber-500/30', label: 'Stopped' },
};

/**
 * Display a styled badge for task status with consistent colors across the app.
 * @param status - The task status (running, completed, failed, pending, stopped)
 * @param className - Optional additional CSS classes
 */
export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const variant = STATUS_VARIANTS[status] || STATUS_VARIANTS.pending;
  return (
    <Badge className={`${variant.className} border ${className}`}>
      {variant.label}
    </Badge>
  );
}
