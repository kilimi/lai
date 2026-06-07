import React from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import {
  formatEvaluationModelDisplay,
  formatMetricPct,
  getEvaluationRowMetrics,
} from "@/lib/evaluationTableDisplay";

function metricColor(v: number | undefined | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 0.85) return "text-green-400";
  if (v >= 0.6) return "text-amber-400";
  return "text-red-400";
}

export function EvaluationComparePanel({
  tasks,
  onClose,
  onClear,
}: {
  tasks: any[];
  onClose: () => void;
  onClear: () => void;
}) {
  if (tasks.length === 0) return null;

  // For each task compute metrics
  const rows = tasks.map((t) => {
    const m = t.task_metadata || {};
    const isMulti = !!m.is_multi_dataset;
    const aggregateStatus =
      isMulti && m.aggregate_results ? "completed" : t.status;
    const metrics = getEvaluationRowMetrics(m, {
      isMultiDataset: isMulti,
      aggregateStatus,
    });
    return {
      task: t,
      label: formatEvaluationModelDisplay(m),
      metrics,
      images:
        m.results?.images_processed ??
        (isMulti ? null : null),
    };
  });

  // Identify best per metric
  const bestOf = (key: "precision" | "recall" | "f1") => {
    let best = -Infinity;
    rows.forEach((r) => {
      const v = r.metrics?.[key];
      if (typeof v === "number" && v > best) best = v;
    });
    return best;
  };
  const bests = {
    precision: bestOf("precision"),
    recall: bestOf("recall"),
    f1: bestOf("f1"),
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto max-w-screen-2xl px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold">
              Compare evaluations
            </h3>
            <span className="text-xs text-muted-foreground">
              {tasks.length} selected · best value highlighted
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium py-2 pr-4">Evaluation</th>
                <th className="text-right font-medium py-2 px-4">Precision</th>
                <th className="text-right font-medium py-2 px-4">Recall</th>
                <th className="text-right font-medium py-2 px-4">F1</th>
                <th className="text-left font-medium py-2 pl-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ task, label, metrics }) => {
                const cell = (key: "precision" | "recall" | "f1") => {
                  const v = metrics?.[key];
                  const isBest = typeof v === "number" && v === bests[key] && tasks.length > 1;
                  return (
                    <td
                      className={`text-right py-2 px-4 tabular-nums ${metricColor(v)} ${
                        isBest ? "font-semibold" : ""
                      }`}
                    >
                      {v == null ? "—" : formatMetricPct(v)}
                      {isBest && (
                        <span className="ml-1 text-[10px] uppercase tracking-wider text-green-400">
                          best
                        </span>
                      )}
                    </td>
                  );
                };
                return (
                  <tr key={task.id}>
                    <td className="py-2 pr-4">
                      <div className="font-medium">{task.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {label} · #{task.id}
                      </div>
                    </td>
                    {cell("precision")}
                    {cell("recall")}
                    {cell("f1")}
                    <td className="text-left py-2 pl-4 text-xs text-muted-foreground capitalize">
                      {task.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
