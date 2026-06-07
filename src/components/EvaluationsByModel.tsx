import React, { useMemo, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatModelTypeShort,
  formatMetricPct,
} from "@/lib/evaluationTableDisplay";
import { cn } from "@/lib/utils";

/**
 * Group-by-model view for evaluations.
 * Each card represents a unique (training_task_name, architecture) and lists
 * every dataset it has been evaluated on, plus quick stats.
 */

export interface ByModelTask {
  id: number;
  name: string;
  status: string;
  created_at?: string;
  task_metadata?: any;
}

interface Props {
  tasks: ByModelTask[];
  onOpenTask: (taskId: number) => void;
  onNewEvaluation?: () => void;
}

interface DatasetEntry {
  taskId: number;
  status: string;
  datasetName: string;
  collectionName?: string;
  f1: number | null;
  precision: number | null;
  recall: number | null;
  predictions: number | null;
  hasGt: boolean;
  createdAt?: string;
}

interface ModelGroup {
  key: string;
  label: string;
  arch: string;
  entries: DatasetEntry[];
  avgF1: number | null;
  evaluatedDatasets: number;
  runningCount: number;
  failedCount: number;
}

function metricColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 0.85) return "text-emerald-400";
  if (v >= 0.6) return "text-amber-400";
  return "text-red-400";
}

function statusDotColor(status: string): string {
  switch (status) {
    case "completed": return "bg-emerald-500";
    case "running":
    case "pending": return "bg-blue-500 animate-pulse";
    case "failed": return "bg-red-500";
    case "stopped":
    case "cancelled": return "bg-amber-500";
    default: return "bg-gray-500";
  }
}

export function EvaluationsByModel({ tasks, onOpenTask }: Props) {
  const groups = useMemo<ModelGroup[]>(() => {
    const map = new Map<string, ModelGroup>();
    for (const t of tasks) {
      const m = t.task_metadata || {};
      if (m.is_multi_dataset) continue; // children are listed individually
      const arch = formatModelTypeShort(m.model_type) || m.model_config?.model || "model";
      const label = (m.training_task_name || "").trim() || arch;
      const key = `${label}::${arch}`;
      const r = m.results || {};
      const entry: DatasetEntry = {
        taskId: t.id,
        status: t.status,
        datasetName: (m.dataset_name || "").trim() || "—",
        collectionName: m.collection_name,
        f1: r.has_ground_truth === true && typeof r.f1_score === "number" ? r.f1_score : null,
        precision: r.has_ground_truth === true && typeof r.precision === "number" ? r.precision : null,
        recall: r.has_ground_truth === true && typeof r.recall === "number" ? r.recall : null,
        predictions: typeof r.predictions_count === "number" ? r.predictions_count : null,
        hasGt: r.has_ground_truth === true,
        createdAt: t.created_at,
      };
      const g = map.get(key);
      if (!g) {
        map.set(key, {
          key, label, arch,
          entries: [entry],
          avgF1: null,
          evaluatedDatasets: 0,
          runningCount: 0,
          failedCount: 0,
        });
      } else {
        g.entries.push(entry);
      }
    }
    // Compute aggregates
    for (const g of map.values()) {
      const f1s = g.entries.map(e => e.f1).filter((v): v is number => typeof v === "number");
      g.avgF1 = f1s.length ? f1s.reduce((s, v) => s + v, 0) / f1s.length : null;
      g.evaluatedDatasets = new Set(g.entries.filter(e => e.status === "completed").map(e => e.datasetName)).size;
      g.runningCount = g.entries.filter(e => e.status === "running" || e.status === "pending").length;
      g.failedCount = g.entries.filter(e => e.status === "failed").length;
      g.entries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }
    return Array.from(map.values()).sort((a, b) => {
      const ad = a.avgF1 ?? -1, bd = b.avgF1 ?? -1;
      if (ad !== bd) return bd - ad;
      return a.label.localeCompare(b.label);
    });
  }, [tasks]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  if (groups.length === 0) {
    return (
      <div className="text-center py-16 border border-dashed border-border rounded-lg">
        <p className="text-muted-foreground">No evaluations yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        return (
          <div key={g.key} className="rounded-lg border border-border bg-card overflow-hidden">
            <button
              onClick={() => toggle(g.key)}
              className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center justify-center w-9 h-9 rounded-md bg-primary/10 text-primary shrink-0">
                <Cpu className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold truncate">{g.label}</h3>
                  <Badge variant="outline" className="text-xs">{g.arch}</Badge>
                  <Badge variant="secondary" className="text-xs">
                    {g.evaluatedDatasets} dataset{g.evaluatedDatasets === 1 ? "" : "s"}
                  </Badge>
                  {g.runningCount > 0 && (
                    <Badge className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/30">
                      {g.runningCount} running
                    </Badge>
                  )}
                  {g.failedCount > 0 && (
                    <Badge className="text-xs bg-red-500/15 text-red-400 border border-red-500/30">
                      {g.failedCount} failed
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-6 shrink-0">
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg F1</div>
                  <div className={cn("text-xl font-semibold tabular-nums", metricColor(g.avgF1))}>
                    {g.avgF1 == null ? "—" : formatMetricPct(g.avgF1)}
                  </div>
                </div>
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")} />
              </div>
            </button>

            {!isCollapsed && (
              <div className="border-t border-border bg-muted/10">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2 font-medium">Dataset</th>
                      <th className="text-right px-3 py-2 font-medium">Precision</th>
                      <th className="text-right px-3 py-2 font-medium">Recall</th>
                      <th className="text-right px-3 py-2 font-medium">F1</th>
                      <th className="text-right px-3 py-2 font-medium">Predictions</th>
                      <th className="text-right px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.entries.map((e) => (
                      <tr
                        key={e.taskId}
                        onClick={() => onOpenTask(e.taskId)}
                        className="border-t border-border/60 hover:bg-muted/30 cursor-pointer"
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium truncate">{e.datasetName}</div>
                          {e.collectionName && (
                            <div className="text-xs text-muted-foreground">{e.collectionName}</div>
                          )}
                        </td>
                        <td className={cn("text-right px-3 py-2.5 tabular-nums", metricColor(e.precision))}>
                          {e.precision == null ? "—" : formatMetricPct(e.precision)}
                        </td>
                        <td className={cn("text-right px-3 py-2.5 tabular-nums", metricColor(e.recall))}>
                          {e.recall == null ? "—" : formatMetricPct(e.recall)}
                        </td>
                        <td className={cn("text-right px-3 py-2.5 tabular-nums font-semibold", metricColor(e.f1))}>
                          {e.f1 == null ? "—" : formatMetricPct(e.f1)}
                        </td>
                        <td className="text-right px-3 py-2.5 tabular-nums text-muted-foreground">
                          {e.predictions == null ? "—" : e.predictions.toLocaleString()}
                        </td>
                        <td className="text-right px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className={cn("inline-block w-2 h-2 rounded-full", statusDotColor(e.status))} />
                            <span className="capitalize text-muted-foreground">{e.status}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
